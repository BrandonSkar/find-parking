// Precomputes Seattle's historical parking occupancy into a static file.
// Run:  node scripts/build-seattle-data.mjs
//
// Why bake it instead of querying live:
// the source dataset is a fixed 2021 study of ~40M rows. Filtering it by hour
// at request time takes minutes through Socrata, which is unusable in an app.
// The data never changes, so we aggregate it ONCE into a blockface x hour
// occupancy table (~200 KB) that ships with the site and loads instantly —
// and keeps working offline, which matters for a PWA.
//
// Why it's split into two phases:
// the obvious query — group by blockfacename, location, hour in one shot —
// never returns. Socrata will happily plan it, but grouping on the `location`
// Point across 40M rows pushes it past any timeout we're willing to wait for
// (measured: fine at $limit=5, dead at $limit=100). Dropping `location` from
// the GROUP BY and slicing by hour brings each query down to ~2 minutes, and
// the coordinates come from a handful of cheap point-in-time reads instead.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ENDPOINT = "https://data.seattle.gov/resource/jb6y-98nr.json";
const PAGE = 50000;
const MIN_READINGS = 50; // a handful of readings isn't a useful prior
const MIN_HOURS = 4; // a blockface needs some shape to be worth shipping

const params = (o) =>
  Object.entries(o)
    .map(([k, v]) => `$${k}=${encodeURIComponent(v)}`)
    .join("&");

// node:https rather than fetch(): undici caps the wait for response headers at
// 300s, and the hourly aggregations legitimately run longer than that.
function getJSON(url, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { Accept: "application/json" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("bad JSON: " + body.slice(0, 200)));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

async function withRetry(label, fn, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw new Error(`${label} failed after ${attempts} tries: ${e.message}`);
      const wait = 15 * i;
      console.log(`    ${label}: ${e.message} — retrying in ${wait}s (${i}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
}

// ---------------------------------------------------------------- phase 1
// Coordinates. Readings land on exact hours, so an equality filter on
// occupancydatetime is an indexed lookup that returns ~one row per blockface
// in well under a second. A few timestamps spread across the year and the week
// cover blockfaces that happen to be idle at any single instant.
const STAMPS = [
  "2021-03-09T11:00:00.000",
  "2021-06-15T09:00:00.000",
  "2021-06-15T13:00:00.000",
  "2021-06-15T17:00:00.000",
  "2021-08-21T12:00:00.000",
  "2021-09-14T15:00:00.000",
  "2021-10-08T08:00:00.000",
  "2021-11-16T10:00:00.000",
  "2021-11-20T14:00:00.000",
  "2021-12-07T16:00:00.000",
];

console.log("Phase 1/2 — blockface coordinates");
const t0 = Date.now();
const coords = new Map();

for (const ts of STAMPS) {
  const rows = await withRetry(`stamp ${ts.slice(0, 10)}`, () =>
    getJSON(
      ENDPOINT +
        "?" +
        params({
          select: "blockfacename,location",
          where: `occupancydatetime = '${ts}'`,
          limit: PAGE,
        }),
      60 * 1000
    )
  );
  for (const r of rows) {
    const c = r.location?.coordinates;
    if (!c || coords.has(r.blockfacename)) continue;
    coords.set(r.blockfacename, {
      lat: +(+c[1]).toFixed(5),
      lon: +(+c[0]).toFixed(5),
    });
  }
}
console.log(`  ${coords.size} blockfaces located in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------------------------------------------------------------- phase 2
// Occupancy, one hour per query. Each takes ~2 minutes; the whole loop is
// roughly 45 minutes. That is the price of not shipping a live dependency.
console.log("\nPhase 2/2 — hourly occupancy (24 queries, ~2 min each)");

const blocks = new Map();
let groups = 0;
let thin = 0;
let unlocated = 0;

for (let hr = 0; hr < 24; hr++) {
  const t = Date.now();
  const rows = await withRetry(`hour ${hr}`, () =>
    getJSON(
      ENDPOINT +
        "?" +
        params({
          select:
            "blockfacename,avg(paidoccupancy) as occ," +
            "avg(parkingspacecount) as spaces,count(*) as n",
          where: `date_extract_hh(occupancydatetime) = ${hr}`,
          group: "blockfacename",
          limit: PAGE,
        })
    )
  );

  let kept = 0;
  for (const r of rows) {
    const spaces = parseFloat(r.spaces);
    const occ = parseFloat(r.occ);
    if (!Number.isFinite(spaces) || spaces <= 0) continue;
    if (!Number.isFinite(occ)) continue;
    if (parseInt(r.n, 10) < MIN_READINGS) {
      thin++;
      continue;
    }
    const where = coords.get(r.blockfacename);
    if (!where) {
      unlocated++;
      continue;
    }

    let b = blocks.get(r.blockfacename);
    if (!b) {
      b = { n: r.blockfacename, lat: where.lat, lon: where.lon, sp: 0, h: {} };
      blocks.set(r.blockfacename, b);
    }
    // Capacity is the largest hourly average we see — some hours only sample
    // part of the blockface and would understate it.
    b.sp = Math.max(b.sp, Math.round(spaces));
    // Store FREE ratio, clamped: the raw data sometimes logs more paid sessions
    // than marked spaces (overlapping sessions, double parking).
    b.h[hr] = +Math.max(0, Math.min(1, 1 - occ / spaces)).toFixed(2);
    kept++;
    groups++;
  }

  console.log(
    `  hour ${String(hr).padStart(2)}  ${String(rows.length).padStart(4)} groups  ` +
      `${String(kept).padStart(4)} kept  ${((Date.now() - t) / 1000).toFixed(0)}s`
  );
}

if (thin) console.log(`\n  skipped ${thin} groups with thin samples (<${MIN_READINGS} readings)`);
if (unlocated) console.log(`  skipped ${unlocated} groups with no known coordinates`);

// ---------------------------------------------------------------- output
const out = {
  city: "Seattle, WA",
  source: "City of Seattle open data — 2021 Paid Parking Occupancy (jb6y-98nr)",
  note: "h maps hour-of-day (0-23) to the average share of spaces FREE.",
  generated: new Date().toISOString().slice(0, 10),
  blocks: [...blocks.values()].filter((b) => Object.keys(b.h).length >= MIN_HOURS),
};

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, "seattle-occupancy.json");
const json = JSON.stringify(out);
writeFileSync(file, json);

console.log(`\nWrote ${file}`);
console.log(
  `  ${out.blocks.length} blockfaces · ${groups} blockface-hours · ` +
    `${(json.length / 1024).toFixed(0)} KB · ${((Date.now() - t0) / 60000).toFixed(1)} min`
);
