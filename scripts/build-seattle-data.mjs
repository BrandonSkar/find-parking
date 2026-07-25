// Precomputes Seattle's historical parking occupancy into a static file.
// Run:  node scripts/build-seattle-data.mjs
//
// Why bake it instead of querying live:
// the source dataset is a fixed 2021 study of ~40M rows. Filtering it by hour
// at request time takes 12-290s through Socrata, which is unusable in an app.
// The data never changes, so we aggregate it ONCE into a blockface x hour
// occupancy table (~200 KB) that ships with the site and loads instantly —
// and keeps working offline, which matters for a PWA.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "node:https";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const ENDPOINT = "https://data.seattle.gov/resource/jb6y-98nr.json";
const PAGE = 50000;

const params = (o) =>
  Object.entries(o)
    .map(([k, v]) => `$${k}=${encodeURIComponent(v)}`)
    .join("&");

// node:https rather than fetch(): undici caps the wait for response headers at
// 300s and this aggregation legitimately runs longer than that.
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
        } catch (e) {
          reject(new Error("bad JSON: " + body.slice(0, 200)));
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

// One query for everything.
//
// Seattle has 972 distinct blockfaces x ~24 hours = well under the 50k row cap,
// so the whole table comes back in a single page — no pagination, no unstable
// offsets. Grouping the hour inside SELECT is also dramatically cheaper than
// filtering on date_extract_hh() in WHERE, which forces a function evaluation
// across all ~40M rows (measured at 12s for one hour, 290s with a day filter).
function fetchAll() {
  return getJSON(
    ENDPOINT +
      "?" +
      params({
        select:
          "blockfacename,location," +
          "date_extract_hh(occupancydatetime) as hr," +
          "avg(paidoccupancy) as occ,avg(parkingspacecount) as spaces,count(*) as n",
        group: "blockfacename,location,hr",
        limit: PAGE,
      })
  );
}

console.log("Aggregating Seattle occupancy (one grouped query, ~20-60s)…");

const t0 = Date.now();
const rows = await fetchAll();
console.log(`  ${rows.length} blockface-hour groups in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (rows.length >= PAGE) {
  console.warn(`  WARNING: hit the ${PAGE}-row cap — results may be truncated.`);
}

const blocks = new Map();
let total = 0;
let skipped = 0;

for (const r of rows) {
  const c = r.location?.coordinates;
  if (!c) continue;
  const spaces = parseFloat(r.spaces);
  const occ = parseFloat(r.occ);
  const hr = parseInt(r.hr, 10);
  if (!Number.isFinite(spaces) || spaces <= 0) continue;
  if (!Number.isFinite(occ) || !Number.isFinite(hr)) continue;
  // Ignore thin samples — a handful of readings isn't a useful prior.
  if (parseInt(r.n, 10) < 50) {
    skipped++;
    continue;
  }

  const key = r.blockfacename;
  let b = blocks.get(key);
  if (!b) {
    b = {
      n: key,
      lat: +(+c[1]).toFixed(5),
      lon: +(+c[0]).toFixed(5),
      sp: Math.round(spaces),
      h: {},
    };
    blocks.set(key, b);
  }
  // Store FREE ratio, clamped: the raw data sometimes logs more paid sessions
  // than marked spaces (overlapping sessions, double parking).
  b.h[hr] = +Math.max(0, Math.min(1, 1 - occ / spaces)).toFixed(2);
  total++;
}
if (skipped) console.log(`  skipped ${skipped} groups with thin samples (<50 readings)`);

const out = {
  city: "Seattle, WA",
  source: "City of Seattle open data — 2021 Paid Parking Occupancy (jb6y-98nr)",
  note: "h maps hour-of-day (0-23) to the average share of spaces FREE.",
  generated: new Date().toISOString().slice(0, 10),
  blocks: [...blocks.values()].filter((b) => Object.keys(b.h).length >= 4),
};

mkdirSync(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, "seattle-occupancy.json");
writeFileSync(file, JSON.stringify(out));

const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`\nWrote ${file}`);
console.log(`  ${out.blocks.length} blockfaces · ${total} blockface-hours · ${kb} KB`);
