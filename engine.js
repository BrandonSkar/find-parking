// engine.js — turns raw spots into an answer to "can I park here right now?"
//
// Three separate questions, deliberately kept apart:
//
//   1. legality  — am I ALLOWED to park here at this moment?
//   2. avail     — is a space likely to be FREE?
//   3. confidence— how much do we actually know vs. guess?
//
// Conflating these is what makes most parking apps feel like liars. A garage
// with 40 free spaces that closes in 10 minutes is not a good spot, and a
// street with plenty of room during a street-sweeping window is a tow.

import { distanceMeters } from "./sources.js";
import { getReports } from "./storage.js";

// Crowd reports stop counting after this long.
const REPORT_TTL_MIN = 90;

// =============================================================================
// opening_hours — compact evaluator for the subset OSM actually uses on parking
// Handles: "24/7", "Mo-Fr 08:00-18:00", "Mo,We 09:00-17:00; Sa 10:00-14:00",
//          "Mo-Sa 08:00-20:00; Su off", overnight ranges like "22:00-06:00".
// Anything it can't parse returns null = "unknown", never a false confident no.
// =============================================================================

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function evaluateHours(spec, now = new Date()) {
  if (!spec) return null;
  const s = spec.trim();
  if (/^24\/7$/i.test(s) || /^24 hours$/i.test(s)) return { open: true };

  // Unsupported syntax (month rules, week numbers, PH, sunset) -> unknown.
  if (/PH|SH|easter|sunset|sunrise|week \d|\bJan|\bFeb|\bMar|\bApr|\bMay|\bJun|\bJul|\bAug|\bSep|\bOct|\bNov|\bDec/i.test(s))
    return null;

  const dow = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  let matchedRule = false;
  let open = false;
  let closesAt = null;

  for (const rawRule of s.split(";")) {
    const rule = rawRule.trim();
    if (!rule) continue;

    const m = rule.match(/^([A-Za-z,\-]+)?\s*(.*)$/);
    if (!m) continue;
    const dayPart = (m[1] || "").trim();
    const timePart = (m[2] || "").trim();

    if (dayPart && !dayMatches(dayPart, dow)) continue;
    if (!dayPart && !timePart) continue;

    matchedRule = true;

    if (/^off|closed$/i.test(timePart)) {
      open = false;
      continue;
    }
    if (!timePart || /^open$/i.test(timePart)) {
      open = true;
      continue;
    }

    for (const span of timePart.split(",")) {
      const t = span.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      if (!t) continue;
      const start = +t[1] * 60 + +t[2];
      let end = +t[3] * 60 + +t[4];
      const overnight = end <= start;
      if (overnight) end += 1440;
      const cur = minutes < start && overnight ? minutes + 1440 : minutes;
      if (cur >= start && cur < end) {
        open = true;
        closesAt = (end % 1440);
      }
    }
  }

  if (!matchedRule) {
    // Days listed but today isn't one of them = closed today.
    if (/^[A-Za-z,\-\s]+\d{1,2}:\d{2}/.test(s)) return { open: false };
    return null;
  }
  return { open, closesAt };
}

function dayMatches(dayPart, dow) {
  for (const token of dayPart.split(",")) {
    const t = token.trim();
    if (!t) continue;
    const range = t.match(/^([A-Za-z]{2})\s*-\s*([A-Za-z]{2})$/);
    if (range) {
      const a = DAYS.indexOf(cap(range[1]));
      const b = DAYS.indexOf(cap(range[2]));
      if (a < 0 || b < 0) continue;
      if (a <= b ? dow >= a && dow <= b : dow >= a || dow <= b) return true;
    } else {
      if (DAYS.indexOf(cap(t)) === dow) return true;
    }
  }
  return false;
}

const cap = (x) => x[0].toUpperCase() + x.slice(1, 2).toLowerCase();

// =============================================================================
// Legality — may I park here right now?
// =============================================================================

export function checkLegality(spot, now = new Date()) {
  const blockers = [];
  const warnings = [];

  if (spot.access === "private") blockers.push("Private parking");
  if (spot.access === "customers") warnings.push("Customers only");
  if (spot.access === "permit" || spot.tags?.["parking:condition"] === "residents")
    blockers.push("Permit holders only");

  const hrs = evaluateHours(spot.hours, now);
  if (hrs && hrs.open === false) blockers.push("Closed right now");
  if (hrs && hrs.open && hrs.closesAt != null) {
    const minsLeft =
      (hrs.closesAt - (now.getHours() * 60 + now.getMinutes()) + 1440) % 1440;
    if (minsLeft <= 60)
      warnings.push(`Closes in ${minsLeft} min (${fmtMin(hrs.closesAt)})`);
  }

  if (spot.maxStay && spot.maxStay <= 30)
    warnings.push(`${spot.maxStay} min max stay`);

  return {
    ok: blockers.length === 0,
    unknown: hrs === null && !spot.hours ? false : hrs === null,
    blockers,
    warnings,
  };
}

const fmtMin = (m) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// =============================================================================
// Demand curve — how contested is parking at this hour?
// Returns 0 (dead quiet) .. 1 (peak fight for spaces).
// Derived from the shape of published municipal occupancy studies: a weekday
// commuter double-peak, and a flatter, later weekend curve.
// =============================================================================

const WEEKDAY = [
  //0    1    2    3    4    5    6    7    8    9   10   11
  0.10, 0.07, 0.05, 0.05, 0.08, 0.18, 0.38, 0.62, 0.82, 0.85, 0.80, 0.82,
  //12  13   14   15   16   17   18   19   20   21   22   23
  0.88, 0.85, 0.80, 0.82, 0.88, 0.92, 0.80, 0.65, 0.52, 0.42, 0.30, 0.18,
];
const WEEKEND = [
  0.22, 0.15, 0.10, 0.07, 0.06, 0.07, 0.10, 0.15, 0.25, 0.38, 0.52, 0.65,
  0.75, 0.80, 0.82, 0.82, 0.80, 0.78, 0.80, 0.82, 0.78, 0.68, 0.52, 0.35,
];

export function demandAt(now = new Date()) {
  const d = now.getDay();
  const curve = d === 0 || d === 6 ? WEEKEND : WEEKDAY;
  const h = now.getHours();
  const next = curve[(h + 1) % 24];
  // Interpolate so the number moves smoothly through the hour.
  return curve[h] + (next - curve[h]) * (now.getMinutes() / 60);
}

// =============================================================================
// Availability score: 0-100 chance you find a space, + how sure we are.
// =============================================================================

const BASE_BY_KIND = { garage: 78, lot: 70, meter: 44, street: 40 };

export function scoreSpot(spot, now = new Date()) {
  const reasons = [];
  const report = latestReport(spot.id, now);

  // ---- Tier 1: MEASURED. A sensor or live inventory told us. Trust it —
  // unless a human reported from the spot AFTER the reading was taken, in which
  // case the person on the ground is the better evidence.
  const liveAt = spot.live ? new Date(spot.live.at) : null;
  const reportBeatsLive = report && liveAt && report.at > liveAt;

  if (spot.live && spot.live.total > 0 && !reportBeatsLive) {
    const ratio = spot.live.free / spot.live.total;
    const ageMin = (now - liveAt) / 60000;
    // Confidence decays as the reading gets stale; the score drifts toward the
    // prediction rather than pretending a 2-hour-old count is still true.
    const trust = ageMin < 5 ? 1 : ageMin < 20 ? 0.85 : ageMin < 60 ? 0.6 : 0.3;
    const measured = Math.round(clamp(ratio * 118, 0, 100));
    const predicted = predictScore(spot, now).score;
    const score = Math.round(measured * trust + predicted * (1 - trust));

    reasons.push(
      `${spot.live.free} of ${spot.live.total} spaces open` +
        (ageMin < 2 ? " (live)" : ` (${Math.round(ageMin)} min ago)`)
    );
    return {
      score: clamp(score, 0, 100),
      confidence: trust >= 0.6 ? "measured" : "predicted",
      reasons,
      free: spot.live.free,
      total: spot.live.total,
    };
  }

  // ---- Tier 2: REPORTED. Someone standing there told us recently.
  if (report) {
    const ageMin = (now - report.at) / 60000;
    const decay = 1 - ageMin / REPORT_TTL_MIN; // 1 -> 0 over the TTL
    const reported = report.state === "open" ? 88 : report.state === "some" ? 55 : 12;
    const pred = predictScore(spot, now);
    const score = Math.round(reported * decay + pred.score * (1 - decay));

    reasons.push(
      `Reported ${labelState(report.state)} ${ageMin < 1 ? "just now" : Math.round(ageMin) + " min ago"}`
    );
    if (reportBeatsLive) {
      reasons.push(
        `Newer than the sensor reading (${spot.live.free}/${spot.live.total} open)`
      );
    }
    reasons.push(...pred.reasons);
    return {
      score: clamp(score, 0, 100),
      confidence: "reported",
      reasons,
      ...(spot.live ? { free: spot.live.free, total: spot.live.total } : {}),
    };
  }

  // ---- Tier 3: PREDICTED.
  return predictScore(spot, now);
}

function predictScore(spot, now) {
  const reasons = [];
  let score = BASE_BY_KIND[spot.kind] ?? 55;

  // Observed historical occupancy for this hour beats any generic curve.
  const hist = spot.tags?._histFreeRatio;
  if (typeof hist === "number") {
    score = Math.round(hist * 110);
    reasons.push(
      `Historically ~${Math.round(hist * 100)}% open at this hour`
    );
  } else {
    const demand = demandAt(now);
    // Street parking is far more demand-sensitive than a big garage.
    const sensitivity = spot.kind === "garage" ? 22 : spot.kind === "lot" ? 30 : 48;
    score -= demand * sensitivity;
    reasons.push(
      demand > 0.75
        ? "Peak hours — high competition"
        : demand > 0.45
        ? "Moderate demand right now"
        : "Off-peak — demand is low"
    );
  }

  // Bigger facilities almost always have something free.
  if (spot.capacity) {
    const bonus = clamp(Math.log10(spot.capacity) * 7, 0, 16);
    score += bonus;
    if (spot.capacity >= 100) reasons.push(`Large facility (${spot.capacity} spaces)`);
  }

  // Price rations demand: paid parking is emptier than free parking nearby.
  if (spot.fee === true) {
    score += 8;
    reasons.push("Paid — usually easier to find a space");
  } else if (spot.fee === false) {
    score -= 10;
    reasons.push("Free — fills up fast");
  }

  if (spot.access === "customers") score -= 8;
  if (spot.covered) score += 3;

  // Google's own difficulty rating, when we have it.
  const gd = spot.tags?.parkingAvailability || spot.tags?._difficulty;
  if (gd === "DIFFICULT") { score -= 22; reasons.push("Google: parking is often difficult here"); }
  if (gd === "PLENTY") { score += 12; reasons.push("Google: parking is usually plentiful"); }

  return { score: clamp(Math.round(score), 3, 97), confidence: "predicted", reasons };
}

function latestReport(spotId, now) {
  const all = getReports()[spotId];
  if (!all || !all.length) return null;
  const fresh = all
    .map((r) => ({ ...r, at: new Date(r.at) }))
    .filter((r) => (now - r.at) / 60000 < REPORT_TTL_MIN)
    .sort((a, b) => b.at - a.at);
  return fresh[0] || null;
}

const labelState = (s) =>
  s === "open" ? "plenty of space" : s === "some" ? "a few spaces" : "full";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// =============================================================================
// Ranking — the score alone isn't the right sort order. A 95% spot a 15 minute
// walk away loses to a 70% spot across the street.
// =============================================================================

export function rankSpots(spots, center, now = new Date(), opts = {}) {
  const { maxWalkM = 1200, freeOnly = false, mustBeLegal = true } = opts;

  return spots
    .map((spot) => {
      const dist = distanceMeters(center, spot);
      const legality = checkLegality(spot, now);
      const avail = scoreSpot(spot, now);
      const walkMin = Math.round(dist / 80); // ~4.8 km/h

      // Walking cost grows faster than linear — people hate long walks a lot.
      const walkPenalty = Math.pow(dist / maxWalkM, 1.35) * 55;
      let rank = avail.score - walkPenalty;
      if (!legality.ok) rank -= 60;
      if (legality.warnings.length) rank -= 6;

      return { spot, dist, walkMin, legality, avail, rank };
    })
    .filter((r) => {
      if (r.dist > maxWalkM) return false;
      if (freeOnly && r.spot.fee === true) return false;
      if (mustBeLegal && !r.legality.ok) return false;
      return true;
    })
    .sort((a, b) => b.rank - a.rank);
}
