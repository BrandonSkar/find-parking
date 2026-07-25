// End-to-end check of the data pipeline outside the browser.
// Run:  node scripts/smoke.mjs
//
// Exercises the real network sources, so it doubles as a "are the free feeds
// still up?" check. Not a unit test suite — it verifies the pipeline produces
// sane, ranked, explainable results.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Minimal localStorage so storage.js works under Node.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// The browser fetches ./data/*.json over HTTP; Node's fetch refuses file: URLs.
// Shim it so the precomputed tables load the same way the real app loads them.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.startsWith("file:")) {
    const body = readFileSync(fileURLToPath(url), "utf8");
    return Promise.resolve(new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  }
  return realFetch(input, init);
};

const { findParking, distanceMeters } = await import("../sources.js");
const { rankSpots, evaluateHours, demandAt, checkLegality } = await import("../engine.js");

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------- opening_hours

console.log("\nopening_hours evaluator");
{
  const mondayNoon = new Date("2026-07-20T12:00:00");
  const sundayNoon = new Date("2026-07-19T12:00:00");
  const mondayNight = new Date("2026-07-20T23:30:00");

  check("24/7 is always open", evaluateHours("24/7", mondayNoon)?.open === true);
  check("Mo-Fr 08:00-18:00 open Monday noon",
    evaluateHours("Mo-Fr 08:00-18:00", mondayNoon)?.open === true);
  check("Mo-Fr 08:00-18:00 closed Sunday",
    evaluateHours("Mo-Fr 08:00-18:00", sundayNoon)?.open === false);
  check("Mo-Fr 08:00-18:00 closed Monday 23:30",
    evaluateHours("Mo-Fr 08:00-18:00", mondayNight)?.open === false);
  check("overnight 22:00-06:00 open at 23:30",
    evaluateHours("Mo-Su 22:00-06:00", mondayNight)?.open === true);
  check("'Su off' closes Sunday",
    evaluateHours("Mo-Sa 08:00-20:00; Su off", sundayNoon)?.open === false);
  check("unparseable returns unknown (null), never a false 'no'",
    evaluateHours("Mar-Oct Mo-Fr sunset-sunrise", mondayNoon) === null);

  // Legality must never claim "fine to park" on a private lot.
  const priv = checkLegality({ access: "private", kind: "lot" }, mondayNoon);
  check("private access blocks parking", priv.ok === false);
}

// ------------------------------------------------------------ demand curve

console.log("\ndemand curve");
{
  const wedMorning = demandAt(new Date("2026-07-22T09:00:00"));
  const wed3am = demandAt(new Date("2026-07-22T03:00:00"));
  check("weekday 9am busier than 3am", wedMorning > wed3am, `${wedMorning.toFixed(2)} vs ${wed3am.toFixed(2)}`);
  check("demand stays within 0..1", wedMorning <= 1 && wed3am >= 0);
}

// --------------------------------------------------------------- live data

const PLACES = [
  { name: "Downtown Los Angeles (live sensors expected)", lat: 34.0487, lon: -118.2518 },
  { name: "Downtown Seattle", lat: 47.6079, lon: -122.3352 },
];

for (const place of PLACES) {
  console.log(`\n${place.name}`);
  const center = { lat: place.lat, lon: place.lon };
  const t0 = Date.now();

  const { spots, reports } = await findParking({ center, radiusM: 800, keys: {} });
  console.log(`  fetched in ${Date.now() - t0} ms`);
  for (const r of reports) {
    console.log(`    ${r.ok ? "ok  " : "ERR "} ${r.label}: ${r.ok ? r.count + " spots" : r.error}`);
  }

  check("found at least one spot", spots.length > 0, `${spots.length} total`);

  const ranked = rankSpots(spots, center, new Date(), {
    maxWalkM: 800,
    freeOnly: false,
    mustBeLegal: true,
  });
  check("ranking produced results", ranked.length > 0, `${ranked.length} ranked`);
  check("all results within walk limit", ranked.every((r) => r.dist <= 800));
  check("scores are in 0..100", ranked.every((r) => r.avail.score >= 0 && r.avail.score <= 100));
  check("every result explains itself", ranked.every((r) => r.avail.reasons.length > 0));
  check("sorted best-first", ranked.every((r, i) => i === 0 || ranked[i - 1].rank >= r.rank));

  const live = ranked.filter((r) => r.avail.confidence === "measured");
  if (live.length) {
    check("live spots report real counts",
      live.every((r) => r.spot.live.free <= r.spot.live.total),
      `${live.length} live`);
  }

  console.log("  top 5:");
  for (const r of ranked.slice(0, 5)) {
    const s = r.spot;
    console.log(
      `    ${String(r.avail.score).padStart(3)}%  ${r.avail.confidence.padEnd(9)} ` +
        `${String(Math.round(r.dist)).padStart(4)}m  ${(s.name || s.kind).slice(0, 34).padEnd(34)} ` +
        `${s.live ? `[${s.live.free}/${s.live.total} open]` : ""}`
    );
    console.log(`           ↳ ${r.avail.reasons[0]}`);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED\n` : "\nAll checks passed\n");
process.exit(failures ? 1 : 0);
