// storage.js — everything persisted on-device.
//
// GitHub Pages is static hosting, so there is no server to hold crowd reports.
// Reports are local-first: they sharpen YOUR results immediately, and if you
// ever add a sync endpoint they upload without touching any other file.

const K_REPORTS = "fp.reports.v1";
const K_SETTINGS = "fp.settings.v1";
const K_PARKED = "fp.parked.v1";

const read = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode / quota — the app still works, just forgets */
  }
};

// ----------------------------------------------------------------- settings

const DEFAULT_SETTINGS = {
  maxWalkM: 800,
  freeOnly: false,
  mustBeLegal: true,
  keys: {}, // googleKey, spotheroKey, inrixToken
  syncUrl: "", // optional POST endpoint for crowd reports
  installDismissed: false, // hid the install banner; Settings can bring it back
};

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read(K_SETTINGS, {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write(K_SETTINGS, next);
  return next;
}

// ------------------------------------------------------------ crowd reports

/** @returns {Record<spotId, {state:'open'|'some'|'full', at:string}[]>} */
export function getReports() {
  const all = read(K_REPORTS, {});
  // Drop anything older than a day so storage can't grow forever.
  const cutoff = Date.now() - 24 * 3600 * 1000;
  let changed = false;
  for (const id of Object.keys(all)) {
    const kept = all[id].filter((r) => new Date(r.at).getTime() > cutoff);
    if (kept.length !== all[id].length) changed = true;
    if (kept.length) all[id] = kept;
    else delete all[id];
  }
  if (changed) write(K_REPORTS, all);
  return all;
}

export function addReport(spotId, state, spotMeta = {}) {
  const all = getReports();
  const entry = { state, at: new Date().toISOString() };
  all[spotId] = [entry, ...(all[spotId] || [])].slice(0, 10);
  write(K_REPORTS, all);

  // Best-effort share with a sync endpoint if one is configured.
  const { syncUrl } = getSettings();
  if (syncUrl) {
    fetch(syncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spotId, state, at: entry.at, ...spotMeta }),
      keepalive: true,
    }).catch(() => {});
  }
  return entry;
}

// -------------------------------------------------- "where did I park?" pin

export function getParked() {
  return read(K_PARKED, null);
}

export function setParked(loc) {
  if (!loc) {
    try {
      localStorage.removeItem(K_PARKED);
    } catch {}
    return null;
  }
  const rec = { ...loc, at: new Date().toISOString() };
  write(K_PARKED, rec);
  return rec;
}
