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
// Time windows — "when does this rule bite, and how long have I got?"
//
// evaluateHours above answers "is it open"; a restriction needs more than that.
// Parking at 07:30 on a street swept 08:00-10:00 is legal *right now* and still
// a tow, so what matters is how many minutes until the window opens.
// =============================================================================

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

// "Mo-Fr 07:00-09:00,16:00-18:00" -> [{days,start,end}, …]. A rule with no
// times ("Sa,Su") covers the whole day. Minutes from midnight; `end` may run
// past 1440 for a window that crosses midnight.
function parseSpans(spec) {
  const spans = [];
  for (const rule of String(spec).split(";")) {
    const r = rule.trim();
    if (!r) continue;

    const times = [...r.matchAll(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g)];
    const dayPart = r
      .slice(0, times.length ? times[0].index : r.length)
      .trim()
      .replace(/,$/, "");

    const days = dayPart ? ALL_DAYS.filter((d) => dayMatches(dayPart, d)) : ALL_DAYS;
    if (!days.length) continue;

    if (!times.length) {
      spans.push({ days, start: 0, end: 1440 });
      continue;
    }
    for (const t of times) {
      const start = +t[1] * 60 + +t[2];
      let end = +t[3] * 60 + +t[4];
      if (end <= start) end += 1440; // crosses midnight
      spans.push({ days, start, end });
    }
  }
  return spans.length ? spans : null;
}

/**
 * Where are we relative to this window right now?
 * @returns {{active:boolean, endsInMin:number|null, startsInMin:number|null}|null}
 *          null when the spec can't be parsed — never a confident "you're fine".
 */
export function windowStatus(spec, now = new Date()) {
  const spans = parseSpans(spec);
  if (!spans) return null;

  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dow = now.getDay();

  let endsInMin = null;
  let startsInMin = Infinity;

  // Start at -1: a window that opened yesterday evening can still be running.
  for (let off = -1; off <= 7; off++) {
    const day = (((dow + off) % 7) + 7) % 7;
    for (const s of spans) {
      if (!s.days.includes(day)) continue;
      const start = off * 1440 + s.start;
      const end = off * 1440 + s.end;
      if (nowMin >= start && nowMin < end) {
        endsInMin = Math.min(endsInMin ?? Infinity, end - nowMin);
      } else if (start > nowMin) {
        startsInMin = Math.min(startsInMin, start - nowMin);
      }
    }
  }

  return {
    active: endsInMin != null,
    endsInMin: endsInMin == null ? null : Math.round(endsInMin),
    startsInMin: Number.isFinite(startsInMin) ? Math.round(startsInMin) : null,
  };
}

// A schedule that repeats on given weekdays, optionally only in certain weeks
// of the month — how municipal street sweeping is almost always published, and
// something opening_hours syntax can't express, so it gets its own walk forward
// through the calendar.
export function nextSweep(sched, now = new Date()) {
  const { days, fromHour, toHour, weeks } = sched;
  if (!days?.length || fromHour == null) return null;

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const nowMin = (now - startOfToday) / 60000;
  const to = toHour > fromHour ? toHour : fromHour + 1; // guard bad rows

  for (let off = 0; off <= 35; off++) {
    const d = new Date(startOfToday);
    d.setDate(d.getDate() + off);
    if (!days.includes(d.getDay())) continue;
    // Which occurrence of this weekday in the month — the 1st Tuesday, the 3rd.
    const nth = Math.ceil(d.getDate() / 7);
    if (weeks?.length && !weeks.includes(nth)) continue;

    const start = off * 1440 + fromHour * 60;
    const end = off * 1440 + to * 60;
    if (nowMin >= end) continue;
    return nowMin >= start
      ? { active: true, endsInMin: Math.round(end - nowMin), startsInMin: 0 }
      : { active: false, endsInMin: null, startsInMin: Math.round(start - nowMin) };
  }
  return null;
}

const DAY_NAME = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NTH = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th" };

function dayList(days) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return "Every day";
  const contiguous = d.every((v, i) => i === 0 || v === d[i - 1] + 1);
  if (contiguous && d.length > 2) return `${DAY_NAME[d[0]]}–${DAY_NAME[d[d.length - 1]]}`;
  return d.map((x) => DAY_NAME[x]).join(", ");
}

export function describeSweep(sched) {
  const hh = (h) => `${String(h % 24).padStart(2, "0")}:00`;
  const when = `${dayList(sched.days)} ${hh(sched.fromHour)}–${hh(sched.toHour)}`;
  const everyWeek = !sched.weeks?.length || sched.weeks.length >= 5;
  return everyWeek
    ? when
    : `${when}, ${sched.weeks.map((w) => NTH[w] || w).join("/")} of the month`;
}

// "in 25 min" / "in 3 hr 10 min" / "tomorrow 08:00"
function inWords(mins) {
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return `in ${h} hr${m ? ` ${m} min` : ""}`;
  return `in ${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? "" : "s"}`;
}

// How much warning is worth giving. Beyond a couple of hours a sweeping window
// is not a reason to avoid a space — you'll have moved the car by then.
const RESTRICTION_HORIZON_MIN = 150;

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

  // Timed kerb rules — sweeping windows, rush-hour tow-away lanes, permit
  // hours. These are the ones that actually get you towed, so a window that is
  // running now blocks the spot outright, and one about to open warns.
  for (const r of spot.restrictions || []) {
    const s = statusOf(r, now);
    if (!s) continue;

    const until =
      s.endsInMin != null
        ? ` until ${fmtMin((now.getHours() * 60 + now.getMinutes() + s.endsInMin) % 1440)}`
        : "";

    // Fail towards blocking: a rule has to say explicitly that it merely
    // conditions parking (a max stay, paid hours) to be downgraded to a
    // warning. An unrecognised restriction that's in force is treated as one
    // that stops you parking, because that error is a walk and the other is
    // a tow.
    if (s.active && r.blocks !== false) {
      blockers.push(`${r.label} now —${until || " in progress"}`);
    } else if (s.active) {
      // In force, but it doesn't make parking illegal — a max stay or a
      // paid-hours window is a condition on parking, not a prohibition.
      warnings.push(`${r.label}${until}`);
    } else if (s.startsInMin != null && s.startsInMin <= RESTRICTION_HORIZON_MIN) {
      warnings.push(`${r.label} ${inWords(s.startsInMin)}`);
    }
  }

  // Kerb rules are barely in OSM — in a downtown Portland sample, 2 of 130 kerb
  // ways carried any restriction tag and none carried a conditional one. Where
  // a city publishes its sweeping schedule we now know the answer, but with no
  // source covering the block, silence is not the same as "you're fine", so it
  // never shows a clean "you can park here".
  // Pushed last so a specific warning still wins the one-line slot in the list.
  if (spot.geometry && !spot.restrictionsChecked)
    warnings.push("Kerb rules aren't mapped — check posted signs");

  return {
    ok: blockers.length === 0,
    unknown: hrs === null && !spot.hours ? false : hrs === null,
    blockers,
    warnings,
  };
}

// A restriction carries either an opening_hours-style spec (OSM conditionals)
// or an Nth-weekday schedule (municipal sweeping feeds).
function statusOf(r, now) {
  if (r.schedule) return nextSweep(r.schedule, now);
  if (r.spec) return windowStatus(r.spec, now);
  return null;
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

// A block of kerb is a different question from a facility. We know roughly how
// many spaces are on it, so the useful number isn't "how empty is this street"
// but "will AT LEAST ONE of those n spaces be free" — which is much higher, and
// grows with the length of the block. That's why cruising a long street works.
//
// Spaces on one block don't free up independently (the whole street is busy at
// the same times), so the effective count is damped to sqrt(n) and capped:
// a 150-space boulevard is not 150 independent coin flips.
function blockAvailability(capacity, demand) {
  const occupancy = clamp(0.35 + demand * 0.6, 0, 0.97);
  const effective = clamp(Math.sqrt(capacity), 1, 6);
  return 1 - Math.pow(occupancy, effective);
}

function predictScore(spot, now) {
  const reasons = [];
  let score = BASE_BY_KIND[spot.kind] ?? 55;

  // Observed historical occupancy for this hour beats any generic curve.
  const hist = spot.tags?._histFreeRatio;
  const isBlock = !!spot.geometry && !!spot.capacity && typeof hist !== "number";

  if (typeof hist === "number") {
    score = Math.round(hist * 110);
    reasons.push(
      `Historically ~${Math.round(hist * 100)}% open at this hour`
    );
  } else if (isBlock) {
    // A kerb of known length — score the block, not the average space.
    const demand = demandAt(now);
    score = Math.round(blockAvailability(spot.capacity, demand) * 92);
    reasons.push(
      `~${spot.capacity} spaces along this block` +
        (demand > 0.75
          ? ", but it's peak hours"
          : demand > 0.45
          ? ", moderate demand right now"
          : ", and demand is low")
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

  // Bigger facilities almost always have something free. Skipped for kerbs,
  // where the block model above has already priced capacity in.
  if (spot.capacity && !isBlock) {
    score += clamp(Math.log10(spot.capacity) * 7, 0, 16);
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
