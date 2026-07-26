// sources.js — parking data adapters.
//
// Every adapter takes a search area and returns Spot[] in one shared shape.
// Adapters are ranked by how much they actually KNOW:
//
//   measured  — a sensor or live inventory says how many spaces are open now
//   predicted — we know the place exists, availability is inferred
//   unknown   — we know it exists, nothing more
//
// Adapters that need a paid key are registered but stay dormant until a key is
// present in settings, so the app is fully functional with zero keys.

const OVERPASS_HOSTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// overpass-api.de answers 406 unless BOTH Accept and User-Agent are present.
// Browsers set User-Agent themselves and ignore attempts to override it, so
// this header only actually does anything under Node (scripts/smoke.mjs) —
// it is harmless in the browser and required outside it.
const OVERPASS_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
  "User-Agent": "FindParking/1.0 (static PWA; OSM data consumer)",
};

// ---------------------------------------------------------------- shared shape

export function makeSpot(o) {
  return {
    id: o.id,
    source: o.source,
    name: o.name || null,
    lat: o.lat,
    lon: o.lon,
    kind: o.kind || "lot", // garage | lot | street | meter
    // Kerb parking is a LINE, not a point. When we know the shape of the block
    // we keep it so the map can draw the actual stretch of kerb; lat/lon then
    // holds the point on it nearest the searcher, which is where they'd walk to.
    geometry: o.geometry ?? null, // [{lat,lon}, …] along the street
    sides: o.sides ?? null, // ["left"] | ["right"] | ["left","right"]
    capacity: o.capacity ?? null, // total spaces, if known
    fee: o.fee ?? null, // true | false | null(unknown)
    access: o.access ?? null, // yes | private | customers | permit
    maxStay: o.maxStay ?? null, // minutes
    covered: o.covered ?? null,
    rate: o.rate ?? null, // { min, max, currency }
    hours: o.hours ?? null, // OSM opening_hours string
    live: o.live ?? null, // { free, total, at:Date } — MEASURED
    // Timed rules that make an otherwise-free space illegal: sweeping windows,
    // tow-away lanes, permit hours. Separate from availability on purpose.
    restrictions: o.restrictions ?? [],
    // True once a source that actually covers this block has been consulted, so
    // "no restrictions" can be told apart from "nobody looked".
    restrictionsChecked: o.restrictionsChecked ?? false,
    tags: o.tags || {},
  };
}

// --------------------------------------------------------------------- helpers

async function fetchJSON(url, opts = {}, timeoutMs = 25000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How long to give a mirror before bringing the next one in alongside it.
const OVERPASS_HEDGE_MS = 3500;
const OVERPASS_TIMEOUT_MS = 20000;

// Overpass mirrors rate-limit (429) and go down constantly, and a sick one can
// sit there for a minute before it fails. Trying them strictly in turn meant a
// single bad mirror cost 30 s before the second was even attempted, and a bad
// day cost 90 s to find out nothing was available. That's the "why is this
// taking forever".
//
// So hedge: start the first mirror, and bring in the next one either when the
// first has been quiet for OVERPASS_HEDGE_MS or the moment it fails. First
// success wins and the rest are aborted. A healthy first mirror is still a
// single request, so this doesn't casually triple the load on free
// infrastructure that other people depend on.
async function overpass(query) {
  const body = "data=" + encodeURIComponent(query);
  const controllers = [];
  let done = false;

  const attempt = async (host) => {
    if (done) throw new Error(`${host}: skipped`);
    const ctl = new AbortController();
    controllers.push(ctl);
    const timer = setTimeout(() => ctl.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const r = await fetch(host, {
        method: "POST",
        headers: OVERPASS_HEADERS,
        body,
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`${host}: HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };

  // Resolves only when `p` REJECTS. A mirror that succeeded must not open the
  // next gate — that would fire a request we're about to abort anyway.
  const rejected = (p) => p.then(() => new Promise(() => {}), () => {});

  const attempts = [];
  let gate = Promise.resolve(); // the first mirror goes immediately
  for (const host of OVERPASS_HOSTS) {
    const opensNow = gate;
    const a = opensNow.then(() => attempt(host));
    attempts.push(a);
    // The next mirror waits out the hedge measured from THIS one's start — not
    // from t=0, or every gate would open at once — or jumps in early the moment
    // this one fails. No point waiting on a mirror that 429'd instantly.
    gate = Promise.race([opensNow.then(() => sleep(OVERPASS_HEDGE_MS)), rejected(a)]);
  }

  try {
    return await Promise.any(attempts);
  } catch (agg) {
    const why = (agg.errors || []).map((e) => e.message).join("; ");
    throw new Error(`all Overpass mirrors unavailable (${why || "unknown"})`);
  } finally {
    // Whoever won, stop the others talking to the network.
    done = true;
    for (const c of controllers) c.abort();
  }
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// OSM maxstay: "2 h", "30 min", "90"
function parseMaxStay(v) {
  if (!v) return null;
  const s = String(v).toLowerCase().trim();
  if (s === "unlimited" || s === "no") return null;
  const m = s.match(/([\d.]+)\s*(h|hour|hours|min|minute|minutes|day|days)?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] || "h";
  if (unit.startsWith("h")) return n * 60;
  if (unit.startsWith("d")) return n * 60 * 24;
  return n;
}

// "$2.00 - $4.00" / "$1.50"  ->  { min, max, currency }
function parseRateRange(v) {
  if (!v) return null;
  const nums = String(v).match(/[\d.]+/g);
  if (!nums || !nums.length) return null;
  const vals = nums.map(parseFloat).filter(Number.isFinite);
  if (!vals.length) return null;
  return { min: Math.min(...vals), max: Math.max(...vals), currency: "USD" };
}

export function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function pathLengthMeters(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += distanceMeters(pts[i - 1], pts[i]);
  return m;
}

// A block of kerb isn't "at" one place. The distance that matters is to the
// closest end of it, so that's the point we hang the spot on.
function nearestVertexIndex(pts, center) {
  let best = 0;
  let bestD = Infinity;
  pts.forEach((p, i) => {
    const d = distanceMeters(center, p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

// Walk from an in-range point towards an out-of-range one and stop at the edge.
// Bisection rather than algebra because the edge is defined by the same
// great-circle distance used everywhere else, and 12 halvings lands well inside
// a metre at city scale.
function boundaryPoint(inP, outP, center, maxM) {
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 12; k++) {
    const mid = (lo + hi) / 2;
    const p = {
      lat: inP.lat + (outP.lat - inP.lat) * mid,
      lon: inP.lon + (outP.lon - inP.lon) * mid,
    };
    if (distanceMeters(center, p) <= maxM) lo = mid;
    else hi = mid;
  }
  return {
    lat: inP.lat + (outP.lat - inP.lat) * lo,
    lon: inP.lon + (outP.lon - inP.lon) * lo,
  };
}

// OSM ways don't stop at the block — an arterial can run for kilometres. Keep
// only the stretch around the nearest point that's actually within reach, so
// the map doesn't sprout lines shooting off to the horizon and the capacity
// estimate describes the bit you'd really walk to.
// Returns null when no part of the way is in range.
function clipPath(pts, center, maxM) {
  const inside = (p) => distanceMeters(center, p) <= maxM;
  const i = nearestVertexIndex(pts, center);
  if (!inside(pts[i])) return null;

  let a = i;
  let b = i;
  while (a > 0 && inside(pts[a - 1])) a--;
  while (b < pts.length - 1 && inside(pts[b + 1])) b++;

  // Ways are often drawn with vertices only at their ends, so a long road
  // crossing the search area can have just one vertex inside it. Cutting the
  // crossing segment at the boundary keeps that as a line rather than a dot.
  const cut = pts.slice(a, b + 1);
  if (a > 0) cut.unshift(boundaryPoint(pts[a], pts[a - 1], center, maxM));
  if (b < pts.length - 1) cut.push(boundaryPoint(pts[b], pts[b + 1], center, maxM));

  return cut.length >= 2 ? cut : null;
}

function bbox(center, radiusM) {
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180) || 1);
  return {
    south: center.lat - dLat,
    west: center.lon - dLon,
    north: center.lat + dLat,
    east: center.lon + dLon,
  };
}

// ------------------------------------------------------- on-street kerb tags
//
// OSM has two schemas for "can you park along this road", and both are in
// active use, so we read both:
//
//   current:  parking:left=lane        parking:left:orientation=parallel
//             parking:both:fee=yes     parking:right:restriction=no_parking
//   older:    parking:lane:left=parallel   parking:condition:left=ticket
//
// Values that mean "no kerb parking here". `separate` means the parking is
// mapped as its own feature, so counting the road too would double-count it.
const NO_KERB = new Set([
  "no",
  "none",
  "separate",
  "no_parking",
  "no_stopping",
  "no_standing",
  "fire_lane",
]);

// Rough metres of kerb consumed per car, by how the cars sit against it.
const SPACE_LEN_M = { parallel: 5.5, diagonal: 3.5, perpendicular: 2.7 };

// Which side(s) of this way you can actually park on. An explicit left/right
// tag beats a `both`, and the current schema beats the older one.
export function kerbSides(t) {
  const on = { left: null, right: null };
  const set = (side, v) => {
    if (v != null) on[side] = !NO_KERB.has(v);
  };

  for (const prefix of ["parking:lane", "parking"]) {
    const both = t[`${prefix}:both`];
    if (both != null) {
      set("left", both);
      set("right", both);
    }
    set("left", t[`${prefix}:left`]);
    set("right", t[`${prefix}:right`]);
  }

  // An unconditional restriction removes that side. Conditional ones (street
  // sweeping windows and the like) are left alone — those are a legality
  // question, and pretending the kerb doesn't exist is the wrong answer.
  for (const side of ["left", "right"]) {
    for (const key of [`parking:${side}:restriction`, "parking:both:restriction"]) {
      const v = t[key];
      if (v && NO_KERB.has(v) && !t[`${key}:conditional`]) on[side] = false;
    }
  }

  return ["left", "right"].filter((s) => on[s] === true);
}

// Read a per-side tag, preferring the specific side over `both`.
function sideTag(t, sides, suffix) {
  for (const side of [...sides, "both"]) {
    const v = t[`parking:${side}:${suffix}`];
    if (v != null) return v;
  }
  return null;
}

function kerbOrientation(t, side) {
  const candidates = [
    t[`parking:${side}:orientation`],
    t["parking:both:orientation"],
    t[`parking:lane:${side}`], // older schema puts orientation in the value
    t["parking:lane:both"],
  ];
  for (const v of candidates) if (v && SPACE_LEN_M[v]) return v;
  return "parallel";
}

// OSM's conditional syntax: "no_parking @ (Tu 08:00-10:00); no_stopping @ (Sa)".
// Returns the value/condition pairs; the engine decides what the clock says.
function parseConditionalTag(v) {
  const out = [];
  for (const part of String(v || "").split(";")) {
    const m = part.match(/^\s*([^@]+?)\s*@\s*\(?([^)]+?)\)?\s*$/);
    if (m) out.push({ value: m[1].trim(), spec: m[2].trim() });
  }
  return out;
}

const RESTRICTION_LABEL = {
  no_parking: "No parking",
  no_stopping: "No stopping",
  no_standing: "No standing",
  free: "Free parking",
  ticket: "Paid parking",
  residents: "Residents only",
  disc: "Parking disc required",
};

// Timed kerb rules from OSM tags. Conditional restrictions are the real prize —
// "no_parking @ (Tu 08:00-10:00)" IS a street sweeping window — but conditional
// maxstay and fee windows matter too.
function kerbRestrictions(t, sides) {
  const out = [];
  const seen = new Set();

  // `blocks` is the difference between "you may not park here" and "you may,
  // with a condition". A 2 h max stay does NOT make a space illegal, and
  // treating it as a blocker would drop perfectly good spots off the list.
  const add = (label, spec, kind, blocks) => {
    const key = `${label}|${spec}`;
    if (spec && !seen.has(key)) {
      seen.add(key);
      out.push({ kind, label, spec, blocks, source: "osm" });
    }
  };

  // Both kerbs are read regardless of which side has parking: a rule tagged on
  // the left of a way we matched on the right is still a rule on that block,
  // and the sides are not reliably distinguishable anyway.
  for (const side of ["left", "right", "both"]) {
    for (const { value, spec } of parseConditionalTag(t[`parking:${side}:restriction:conditional`])) {
      // Only prohibitions matter here; "free @ (Su)" is not a restriction.
      if (/^no_/.test(value)) add(RESTRICTION_LABEL[value] || "No parking", spec, value, true);
    }
    for (const { value, spec } of parseConditionalTag(t[`parking:${side}:maxstay:conditional`])) {
      add(`${value} max stay`, spec, "maxstay", false);
    }
    for (const { value, spec } of parseConditionalTag(t[`parking:${side}:fee:conditional`])) {
      if (value === "yes") add("Paid parking", spec, "fee", false);
    }
    // Older schema puts the window in a sibling tag rather than inline.
    const cond = t[`parking:condition:${side}`];
    const interval = t[`parking:condition:${side}:time_interval`];
    if (cond && interval && RESTRICTION_LABEL[cond]) {
      add(RESTRICTION_LABEL[cond], interval, cond, cond === "residents");
    }
  }
  return out;
}

// Nobody tags how many cars fit on a block, but the block has a length and
// cars have a size. Discounted for driveways, corners and hydrants, which eat
// a surprising amount of any real street.
function estimateKerbCapacity(t, sides, lengthM) {
  let n = 0;
  for (const side of sides) {
    n += Math.floor((lengthM * 0.8) / SPACE_LEN_M[kerbOrientation(t, side)]);
  }
  return n > 0 ? n : null;
}

// =============================================================================
// 1. OpenStreetMap / Overpass — the base layer. Free, no key, worldwide.
//    Knows WHERE parking is + capacity/fee/access/hours. Not real-time.
// =============================================================================

const osmSource = {
  id: "osm",
  label: "OpenStreetMap",
  tier: "predicted",
  needsKey: false,
  attribution: "© OpenStreetMap contributors (ODbL)",

  async fetch({ center, radiusM }) {
    const b = bbox(center, radiusM);
    const box = `${b.south},${b.west},${b.north},${b.east}`;
    // Two sets, because they want different geometry back. Lots and garages
    // are places, so a centre point is enough. Kerb parking is a stretch of
    // road, so we ask for the full shape (`out geom`) and draw it as a line.
    const q = `[out:json][timeout:25];
nwr["amenity"="parking"](${box})->.lots;
(
  way["parking:both"](${box});
  way["parking:left"](${box});
  way["parking:right"](${box});
  way["parking:lane:both"](${box});
  way["parking:lane:left"](${box});
  way["parking:lane:right"](${box});
)->.streets;
.lots out tags center 300;
.streets out geom 200;`;

    const data = await overpass(q);
    const spots = [];

    for (const el of data.elements || []) {
      const t = el.tags || {};

      // A road with kerb tags, returned with its full shape.
      const geometry = Array.isArray(el.geometry)
        ? el.geometry.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
        : null;
      const isKerb = !t.amenity && geometry && geometry.length >= 2;

      if (isKerb) {
        const sides = kerbSides(t);
        if (!sides.length) continue; // tagged, but explicitly no parking

        const path = clipPath(geometry, center, radiusM);
        if (!path) continue;

        const anchor = path[nearestVertexIndex(path, center)];
        const lengthM = pathLengthMeters(path);
        const capacity = num(t.capacity) ?? estimateKerbCapacity(t, sides, lengthM);
        // Kerb stubs too short to hold a single car are map noise, not parking.
        if (capacity == null) continue;

        const feeTag = sideTag(t, sides, "fee");
        const condition =
          t[`parking:condition:${sides[0]}`] || t["parking:condition:both"];
        const conditionInterval =
          t[`parking:condition:${sides[0]}:time_interval`] ||
          t["parking:condition:both:time_interval"];
        const fee =
          feeTag === "yes" || condition === "ticket"
            ? true
            : feeTag === "no" || condition === "free"
            ? false
            : null;

        spots.push(
          makeSpot({
            id: `osm:${el.type}/${el.id}`,
            source: "osm",
            name: t.name || null,
            lat: anchor.lat,
            lon: anchor.lon,
            kind: "street",
            geometry: path,
            sides,
            capacity,
            fee,
            // "residents" only becomes a flat permit zone when it applies at
            // all times. With a time_interval it's a timed rule instead — and
            // setting both would block the block around the clock, throwing
            // away every hour it's legal to park there.
            access:
              sideTag(t, sides, "access") ||
              (condition === "residents" && !conditionInterval ? "permit" : null),
            maxStay: parseMaxStay(sideTag(t, sides, "maxstay")),
            rate: parseRateRange(sideTag(t, sides, "charge")),
            restrictions: kerbRestrictions(t, sides),
            tags: {
              ...t,
              _kerbLengthM: Math.round(lengthM),
              _capacityEstimated: num(t.capacity) == null,
            },
          })
        );
        continue;
      }

      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;

      let kind = "lot";
      if (t.parking === "underground" || t.parking === "multi-storey")
        kind = "garage";
      else if (t.parking === "street_side" || t.parking === "lane")
        kind = "street";

      spots.push(
        makeSpot({
          id: `osm:${el.type}/${el.id}`,
          source: "osm",
          name: t.name || null,
          lat,
          lon,
          kind,
          capacity: num(t.capacity),
          fee: t.fee === "yes" ? true : t.fee === "no" ? false : null,
          access: t.access || null,
          maxStay: parseMaxStay(t.maxstay),
          covered:
            t.covered === "yes" ||
            t.parking === "underground" ||
            t.parking === "multi-storey" ||
            null,
          hours: t.opening_hours || null,
          rate: parseRateRange(t.charge),
          tags: t,
        })
      );
    }
    return spots;
  },
};

// =============================================================================
// 2. Los Angeles LADOT — REAL-TIME on-street sensor occupancy. Free, no key.
//    This is the rare case of true measured street availability.
//    Occupancy feed is space-level; joined to the meter inventory for coords.
// =============================================================================

const LA_BOUNDS = { south: 33.6, west: -118.7, north: 34.4, east: -118.1 };
const LA_OCCUPANCY = "https://data.lacity.org/resource/e7h6-4a3e.json";
const LA_INVENTORY = "https://data.lacity.org/resource/s49e-q6j2.json";

// LADOT stamps readings as "2026-07-25T19:34:26.000" with NO zone designator.
// Those values are UTC, but `new Date(s)` on a bare timestamp applies the
// VIEWER's local timezone instead — which misdates every reading by the user's
// UTC offset. In Pacific that makes live counts appear ~7 hours in the future,
// so freshness decay and the crowd-report-vs-sensor comparison both break.
// Verified against the live feed: read as UTC, readings come back ~1 min old.
function parseFeedTime(s) {
  if (!s) return null;
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
  const d = new Date(hasZone ? s : s + "Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

let laInventoryCache = null; // spaceId -> meter meta (rarely changes)

async function loadLAInventory() {
  if (laInventoryCache) return laInventoryCache;
  const rows = await fetchJSON(
    `${LA_INVENTORY}?$limit=50000&$select=spaceid,blockface,raterange,timelimit,metertype,latlng`
  );
  const map = new Map();
  for (const r of rows) {
    const lat = num(r.latlng?.latitude);
    const lon = num(r.latlng?.longitude);
    if (lat == null || lon == null) continue;
    map.set(r.spaceid, {
      lat,
      lon,
      blockface: r.blockface,
      rate: parseRateRange(r.raterange),
      maxStay: parseMaxStay(r.timelimit),
    });
  }
  laInventoryCache = map;
  return map;
}

const laSource = {
  id: "la",
  label: "LA LADOT live meters",
  tier: "measured",
  needsKey: false,
  attribution: "City of Los Angeles / LADOT open data",

  covers({ center }) {
    return (
      center.lat >= LA_BOUNDS.south &&
      center.lat <= LA_BOUNDS.north &&
      center.lon >= LA_BOUNDS.west &&
      center.lon <= LA_BOUNDS.east
    );
  },

  async fetch({ center, radiusM }) {
    const inv = await loadLAInventory();
    const occ = await fetchJSON(`${LA_OCCUPANCY}?$limit=50000`);

    // Group live space states into block-level meter groups — a driver cares
    // "is there a spot on this block", not about one specific space.
    const blocks = new Map();
    for (const row of occ) {
      const meta = inv.get(row.spaceid);
      if (!meta) continue;
      if (distanceMeters(center, meta) > radiusM) continue;

      const key = meta.blockface || row.spaceid;
      let b = blocks.get(key);
      if (!b) {
        b = {
          key,
          lat: meta.lat,
          lon: meta.lon,
          free: 0,
          total: 0,
          rate: meta.rate,
          maxStay: meta.maxStay,
          at: null,
        };
        blocks.set(key, b);
      }
      b.total++;
      if (String(row.occupancystate).toUpperCase() === "VACANT") b.free++;
      const ts = parseFeedTime(row.eventtime);
      if (ts && (!b.at || ts > b.at)) b.at = ts;
    }

    return [...blocks.values()].map((b) =>
      makeSpot({
        id: `la:${b.key}`,
        source: "la",
        name: titleCase(b.key),
        lat: b.lat,
        lon: b.lon,
        kind: "meter",
        capacity: b.total,
        fee: true,
        rate: b.rate,
        maxStay: b.maxStay,
        live: { free: b.free, total: b.total, at: b.at || new Date() },
      })
    );
  },
};

// =============================================================================
// 3. Seattle — historical paid-parking occupancy, PRECOMPUTED.
//
//    Not live, but real observed occupancy per blockface per hour, which beats
//    a generic demand curve by a mile. The upstream dataset is a fixed 2021
//    study of ~40M rows and filtering it by hour through Socrata takes 12-290s
//    per request, so scripts/build-seattle-data.mjs aggregates it once into a
//    static table that ships with the site. Loads instantly, works offline.
// =============================================================================

const SEA_BOUNDS = { south: 47.4, west: -122.5, north: 47.8, east: -122.2 };

let seaTable = null; // lazily loaded, then kept for the session

// The table is optional: it's produced by an offline build step, and the app is
// perfectly usable without it (OSM still covers Seattle). If it isn't there we
// record that once and stay quiet, rather than reporting a failure every search.
async function loadSeattleTable() {
  if (seaTable) return seaTable;
  const url = new URL("data/seattle-occupancy.json", import.meta.url).href;
  try {
    seaTable = await fetchJSON(url, {}, 15000);
  } catch {
    seaTable = { blocks: [], missing: true };
    console.info(
      "[find-parking] data/seattle-occupancy.json not present — " +
        "run `node scripts/build-seattle-data.mjs` to enable Seattle history."
    );
  }
  return seaTable;
}

const seattleSource = {
  id: "seattle",
  label: "Seattle occupancy history",
  tier: "predicted",
  needsKey: false,
  attribution: "City of Seattle open data (2021 paid parking study)",

  covers({ center }) {
    return (
      center.lat >= SEA_BOUNDS.south &&
      center.lat <= SEA_BOUNDS.north &&
      center.lon >= SEA_BOUNDS.west &&
      center.lon <= SEA_BOUNDS.east
    );
  },

  async fetch({ center, radiusM }) {
    const table = await loadSeattleTable();
    const hour = new Date().getHours();

    const out = [];
    for (const b of table.blocks) {
      if (distanceMeters(center, b) > radiusM) continue;

      // Fall back to the nearest hour we have a reading for.
      let free = b.h[hour];
      if (free == null) {
        for (let d = 1; d <= 3 && free == null; d++) {
          free = b.h[hour - d] ?? b.h[hour + d];
        }
      }
      if (free == null) continue;

      out.push(
        makeSpot({
          id: `sea:${b.n}`,
          source: "seattle",
          name: titleCase(b.n),
          lat: b.lat,
          lon: b.lon,
          kind: "meter",
          capacity: b.sp,
          fee: true,
          // Historical, not live — the engine weighs this as a strong prior.
          tags: { _histFreeRatio: free, _histHour: hour },
        })
      );
    }
    return out;
  },
};

// Municipal datasets shout their street names in caps; soften for display.
function titleCase(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bBetween\b/g, "between")
    .replace(/\bAnd\b/g, "and");
}

// =============================================================================
// 4. Key-gated commercial providers.
//    These stay dormant until a key is saved in Settings. Each one is a small
//    adapter so swapping providers never touches the UI or the engine.
//
//    NOTE: browser-side keys are visible to anyone using the app. Restrict them
//    (HTTP-referrer allowlist) or proxy them. See README.
// =============================================================================

const googleSource = {
  id: "google",
  label: "Google Places",
  tier: "predicted",
  needsKey: true,
  keyName: "googleKey",
  attribution: "Google",

  // Google gives parking *difficulty* + which parking types a place has —
  // not live counts. Useful as a demand signal layered onto OSM geometry.
  async fetch({ center, radiusM, key }) {
    const body = {
      includedTypes: ["parking"],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: { latitude: center.lat, longitude: center.lon },
          radius: Math.min(radiusM, 50000),
        },
      },
    };
    const data = await fetchJSON("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.location,places.parkingOptions,places.currentOpeningHours.openNow",
      },
      body: JSON.stringify(body),
    });

    return (data.places || []).map((p) => {
      const po = p.parkingOptions || {};
      return makeSpot({
        id: `g:${p.id}`,
        source: "google",
        name: p.displayName?.text || null,
        lat: p.location.latitude,
        lon: p.location.longitude,
        kind: "lot",
        fee: po.paidParkingLot || po.paidStreetParking ? true
          : po.freeParkingLot || po.freeStreetParking ? false
          : null,
        tags: { _openNow: p.currentOpeningHours?.openNow, ...po },
      });
    });
  },
};

// Real bookable inventory — the only fully reliable "yes, a space is yours".
// Requires a partner agreement; adapter is here so wiring one up is a key away.
const spotheroSource = {
  id: "spothero",
  label: "SpotHero (bookable)",
  tier: "measured",
  needsKey: true,
  keyName: "spotheroKey",
  attribution: "SpotHero",
  async fetch({ center, radiusM, key }) {
    const url =
      `https://api.spothero.com/v1/facilities/rates?` +
      `latitude=${center.lat}&longitude=${center.lon}&radius=${radiusM}`;
    const data = await fetchJSON(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return (data.results || []).map((f) =>
      makeSpot({
        id: `sh:${f.facility?.id ?? f.id}`,
        source: "spothero",
        name: f.facility?.title || f.title,
        lat: f.facility?.latitude ?? f.latitude,
        lon: f.facility?.longitude ?? f.longitude,
        kind: "garage",
        fee: true,
        rate: f.rates?.[0]
          ? {
              min: f.rates[0].price / 100,
              max: f.rates[0].price / 100,
              currency: "USD",
            }
          : null,
        live: { free: f.available ?? 1, total: f.spaces ?? 1, at: new Date() },
        tags: { bookable: true, url: f.facility?.url },
      })
    );
  },
};

// INRIX is the broadest true real-time occupancy provider (on- and off-street).
const inrixSource = {
  id: "inrix",
  label: "INRIX occupancy",
  tier: "measured",
  needsKey: true,
  keyName: "inrixToken",
  attribution: "INRIX",
  async fetch({ center, radiusM, key }) {
    const url =
      `https://api.iq.inrix.com/lots/v3?point=${center.lat}%7C${center.lon}` +
      `&radius=${Math.round(radiusM)}`;
    const data = await fetchJSON(url, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return (data.result?.lots || []).map((l) =>
      makeSpot({
        id: `inrix:${l.id}`,
        source: "inrix",
        name: l.name,
        lat: l.point?.lat ?? l.latitude,
        lon: l.point?.lon ?? l.longitude,
        kind: "garage",
        capacity: l.spacesTotal ?? null,
        fee: true,
        live:
          l.availability?.spacesAvailable != null
            ? {
                free: l.availability.spacesAvailable,
                total: l.spacesTotal ?? l.availability.spacesAvailable,
                at: new Date(),
              }
            : null,
      })
    );
  },
};

// =============================================================================
// Restriction overlays.
//
// These are NOT parking sources — they don't tell you where to park, they tell
// you when a place you could park becomes a tow. So they're fetched separately
// and attached to whatever blocks they cover, rather than returning Spot[].
//
// This is the piece that closes the gap the app has been warning about: OSM
// carries almost no sweeping data (2 of 130 kerbs in a Portland sample), but
// cities publish it directly, per blockface, with geometry.
// =============================================================================

const SF_BOUNDS = { south: 37.70, west: -122.52, north: 37.84, east: -122.35 };
const SF_SWEEPING = "https://data.sfgov.org/resource/yhqp-riqs.json";

// The feed abbreviates inconsistently ("Tues", "Thu", "Thurs"), so accept all.
const SF_DAY = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const sfSweepingSource = {
  id: "sfsweep",
  label: "SF street sweeping",
  attribution: "City and County of San Francisco open data",

  covers({ center }) {
    return (
      center.lat >= SF_BOUNDS.south &&
      center.lat <= SF_BOUNDS.north &&
      center.lon >= SF_BOUNDS.west &&
      center.lon <= SF_BOUNDS.east
    );
  },

  // 38k rows city-wide, but the geometry column is indexed, so within_circle
  // does the filtering server-side and comes back in well under a second.
  async fetch({ center, radiusM }) {
    const where = `within_circle(line,${center.lat},${center.lon},${Math.round(radiusM * 1.3)})`;
    const rows = await fetchJSON(
      `${SF_SWEEPING}?$where=${encodeURIComponent(where)}&$limit=2000`,
      {},
      15000
    );

    const out = [];
    for (const r of rows) {
      const dow = SF_DAY[String(r.weekday || "").toLowerCase()];
      const fromHour = num(r.fromhour);
      const toHour = num(r.tohour);
      const coords = r.line?.coordinates;
      if (dow == null || fromHour == null || !Array.isArray(coords)) continue;

      // week1..week5 flag which occurrences in the month this route runs, which
      // is how "2nd and 4th Tuesday" signs are encoded.
      const weeks = [1, 2, 3, 4, 5].filter((w) => r[`week${w}`] === "1");

      out.push({
        kind: "sweeping",
        label: "Street sweeping",
        blocks: true,
        source: "sfsweep",
        schedule: { days: [dow], fromHour, toHour: toHour ?? fromHour + 1, weeks },
        side: r.blockside || null,
        where: [r.corridor, r.limits].filter(Boolean).join(" "),
        // GeoJSON is [lon,lat]; everything else here is {lat,lon}.
        geometry: coords.map(([lon, lat]) => ({ lat, lon })),
      });
    }
    return out;
  },
};

export const RESTRICTION_SOURCES = [sfSweepingSource];

function bearingDeg(a, b) {
  const y =
    (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const x = b.lat - a.lat;
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// Smallest angle between two *undirected* lines, 0..90. Which way each was
// drawn is arbitrary, so a 180° flip is the same street.
function angleBetween(b1, b2) {
  const d = Math.abs(b1 - b2) % 180;
  return d > 90 ? 180 - d : d;
}

const RESTRICTION_MATCH_M = 22;
const RESTRICTION_MATCH_DEG = 25;

// Does this sweeping route run ALONG this block, rather than merely touching it?
//
// Proximity alone is not enough, and getting this wrong is not subtle: every
// cross street comes within a few metres at the intersection, so a plain
// distance test hung 51 rules on one block of O'Farrell St, most of them
// belonging to Stockton St. Requiring the two to be roughly parallel throws the
// cross streets out, because they meet at right angles.
function runsAlong(kerb, sweep, maxM) {
  // A spot with no shape (a meter point) has no bearing to compare — fall back
  // to proximity and accept that it's the looser test.
  if (kerb.length < 2) {
    return sweep.some((q) => distanceMeters(kerb[0], q) <= maxM);
  }

  const sweepBearing = bearingDeg(sweep[0], sweep[sweep.length - 1]);
  for (let i = 0; i < kerb.length - 1; i++) {
    if (angleBetween(bearingDeg(kerb[i], kerb[i + 1]), sweepBearing) > RESTRICTION_MATCH_DEG)
      continue;
    for (const q of sweep) {
      if (distanceMeters(kerb[i], q) <= maxM || distanceMeters(kerb[i + 1], q) <= maxM)
        return true;
    }
  }
  return false;
}

// Adjacent sub-blocks repeat the same schedule, so collapse identical rules —
// a driver needs "swept Friday 2-6am", not the same line nineteen times.
function restrictionKey(r) {
  const s = r.schedule;
  return s
    ? `${r.label}|${(s.days || []).join("")}|${s.fromHour}|${s.toHour}|${(s.weeks || []).join("")}`
    : `${r.label}|${r.spec}`;
}

// Downtown blocks swept at the same hour every day arrive as seven separate
// rows, one per weekday. Fold rules that differ ONLY in weekday into one, so
// the sheet reads "Every day 02:00-06:00" instead of a wall of near-duplicates.
//
// Copies before merging: these records are shared across every block they
// match, so mutating one would corrupt the others.
function mergeByDay(list) {
  const out = [];
  const byShape = new Map();

  for (const r of list) {
    if (!r.schedule) {
      out.push(r);
      continue;
    }
    const s = r.schedule;
    const shape = `${r.label}|${s.fromHour}|${s.toHour}|${(s.weeks || []).join("")}`;
    const hit = byShape.get(shape);
    if (hit) {
      for (const d of s.days) {
        if (!hit.schedule.days.includes(d)) hit.schedule.days.push(d);
      }
      // The merged days can come from different sub-blocks; rather than pick
      // one arbitrarily and imply precision we don't have, drop the location.
      if (hit.where !== r.where) hit.where = null;
      continue;
    }
    const copy = { ...r, schedule: { ...s, days: [...s.days] } };
    byShape.set(shape, copy);
    out.push(copy);
  }

  for (const r of out) r.schedule?.days.sort((a, b) => a - b);
  return out;
}

// Attach each restriction to the blocks it covers. Deliberately side-agnostic:
// the feed's left/right is relative to the city's centreline direction and OSM's
// is relative to the way's, and they do not reliably agree — so a rule found on
// a block is reported for that block. Over-warning about the far kerb is a
// nuisance; under-warning about yours is a tow.
function applyRestrictions(spots, restrictions) {
  for (const spot of spots) {
    if (spot.kind !== "street" && spot.kind !== "meter") continue;
    spot.restrictionsChecked = true;

    const path = spot.geometry || [{ lat: spot.lat, lon: spot.lon }];
    const found = [...spot.restrictions];
    const seen = new Set(found.map(restrictionKey));

    for (const r of restrictions) {
      const key = restrictionKey(r);
      if (seen.has(key)) continue;
      if (runsAlong(path, r.geometry, RESTRICTION_MATCH_M)) {
        seen.add(key);
        found.push(r);
      }
    }
    spot.restrictions = mergeByDay(found);
  }
}

// =============================================================================
// Registry + orchestration
// =============================================================================

export const SOURCES = [
  osmSource,
  laSource,
  seattleSource,
  googleSource,
  spotheroSource,
  inrixSource,
];

/**
 * Query every applicable source in parallel. One source failing never fails
 * the search — parking data is patchy by nature and partial results beat none.
 *
 * @returns {{spots:Spot[], reports:{source,label,ok,count,error}[]}}
 */
export async function findParking({ center, radiusM = 800, keys = {} }) {
  const active = SOURCES.filter((s) => {
    if (s.needsKey && !keys[s.keyName]) return false;
    if (s.covers && !s.covers({ center })) return false;
    return true;
  });

  // Restriction feeds run alongside the parking sources, not after them —
  // they're independent, and serialising would double the wait.
  const activeRestrictions = RESTRICTION_SOURCES.filter(
    (s) => !s.covers || s.covers({ center })
  );

  const settled = await Promise.allSettled([
    ...active.map((s) => s.fetch({ center, radiusM, key: keys[s.keyName] })),
    ...activeRestrictions.map((s) => s.fetch({ center, radiusM })),
  ]);

  const spots = [];
  const restrictions = [];
  const reports = [];
  let restrictionsOk = false;

  settled.forEach((res, i) => {
    const isSpotSource = i < active.length;
    const s = isSpotSource ? active[i] : activeRestrictions[i - active.length];

    if (res.status === "rejected") {
      reports.push({
        source: s.id,
        label: s.label,
        ok: false,
        count: 0,
        error: res.reason?.message || String(res.reason),
      });
      return;
    }

    if (isSpotSource) {
      const near = res.value.filter(
        (sp) => distanceMeters(center, sp) <= radiusM * 1.15
      );
      spots.push(...near);
      reports.push({ source: s.id, label: s.label, ok: true, count: near.length });
    } else {
      restrictions.push(...res.value);
      restrictionsOk = true;
      reports.push({
        source: s.id,
        label: s.label,
        ok: true,
        count: res.value.length,
        restriction: true,
      });
    }
  });

  const merged = dedupe(spots);
  // Only mark blocks as checked when a covering feed actually answered. A feed
  // that failed must not turn "we don't know" into a silent all-clear — but a
  // feed that answered with nothing nearby genuinely means nothing is scheduled.
  if (restrictionsOk) applyRestrictions(merged, restrictions);

  return { spots: merged, reports };
}

// Sources overlap — a garage can appear in OSM, Google and SpotHero at once.
// Collapse anything within ~35 m, keeping the entry that knows the most and
// folding in fields the winner is missing.
function dedupe(spots) {
  const rank = { measured: 3, predicted: 2, unknown: 1 };
  const tierOf = (sp) =>
    sp.live ? 3 : rank[SOURCES.find((s) => s.id === sp.source)?.tier] || 1;

  const out = [];
  for (const sp of spots.sort((a, b) => tierOf(b) - tierOf(a))) {
    // Linear kerb features are whole blocks, not points — two of them 30 m
    // apart are two different blocks, and collapsing them loses a real stretch
    // of street. Only point features get merged by proximity.
    const near = sp.geometry
      ? null
      : out.find(
          (o) => !o.geometry && o.kind === sp.kind && distanceMeters(o, sp) < 35
        );
    if (!near) {
      out.push({ ...sp, mergedFrom: [sp.source] });
      continue;
    }
    near.mergedFrom.push(sp.source);
    for (const f of ["name", "capacity", "fee", "rate", "hours", "maxStay", "access"]) {
      if (near[f] == null && sp[f] != null) near[f] = sp[f];
    }
    near.tags = { ...sp.tags, ...near.tags };
  }
  return out;
}

// Free geocoding for the search box. Nominatim asks for modest use — we only
// call it on explicit submit, never per keystroke.
//
// Searching by name is close to useless without a location: from Portland,
// "Broadway" returns the Bronx and "City Hall" returns London. A soft viewbox
// hint (bounded=0) barely reorders anything — measured, it left the Bronx on
// top — so the local pass genuinely restricts to the box (bounded=1), and only
// if that finds nothing do we repeat the search worldwide.
//
// The result: "Broadway" finds the one a kilometre away, and "Times Square
// New York" still works. Two round trips, but only on the miss.
const GEO_BOX_DEG = 0.35; // ~35 km — city-sized, not neighbourhood-sized

export async function geocode(query, near = null) {
  const run = async (bounded) => {
    const params = new URLSearchParams({
      format: "json",
      limit: "8",
      addressdetails: "1",
      q: query,
    });
    if (bounded !== null) {
      const d = GEO_BOX_DEG;
      params.set(
        "viewbox",
        `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`
      );
      params.set("bounded", bounded);
    }
    return fetchJSON(
      `https://nominatim.openstreetmap.org/search?${params}`,
      { headers: { Accept: "application/json" } },
      12000
    );
  };

  const canBias = near && Number.isFinite(near.lat) && Number.isFinite(near.lon);
  let rows = canBias ? await run("1") : await run(null);
  if (!rows.length && canBias) rows = await run(null);

  return rows.map((r) => ({
    label: r.display_name,
    short: shortLabel(r),
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
  }));
}

// display_name is a full postal address — "Southwest Broadway, Downtown,
// Portland, Multnomah County, Oregon, 97205, United States" — which is
// unreadable in a list of five. Keep the name and enough context to tell two
// candidates apart.
function shortLabel(r) {
  const a = r.address || {};
  const name =
    r.name ||
    a.road ||
    a.pedestrian ||
    a.amenity ||
    a.building ||
    String(r.display_name).split(",")[0];
  const place = a.city || a.town || a.village || a.suburb || a.county;
  const region = a.state || a.country;
  return [name, place, region].filter(Boolean).join(", ");
}
