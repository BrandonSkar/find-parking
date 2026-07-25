// app.js — UI wiring: map, search, list, detail, crowd reporting, PWA install.

import { findParking, geocode, distanceMeters, SOURCES } from "./sources.js";
import { rankSpots, demandAt } from "./engine.js";
import {
  getSettings,
  saveSettings,
  addReport,
  getParked,
  setParked,
} from "./storage.js";

const $ = (id) => document.getElementById(id);

const state = {
  center: null,
  results: [],
  reports: [],
  settings: getSettings(),
  markers: new Map(),
  busy: false,
};

// ------------------------------------------------------------------- map

const map = L.map("map", { zoomControl: false, attributionControl: true }).setView(
  [39.5, -98.35],
  4
);

// Match the basemap to the UI theme, and follow the system if it changes.
const TILES = {
  light: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
  dark: "https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png",
};
const TILE_ATTR =
  '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let tileLayer = null;

function applyTheme() {
  const url = darkQuery.matches ? TILES.dark : TILES.light;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = L.tileLayer(url, { maxZoom: 20, attribution: TILE_ATTR }).addTo(map);
  tileLayer.bringToBack();
}
applyTheme();
darkQuery.addEventListener("change", applyTheme);

L.control.zoom({ position: "topright" }).addTo(map);

const layer = L.layerGroup().addTo(map);
let meMarker = null;
let parkedMarker = null;

// ------------------------------------------------------------- presentation

function scoreColor(score, confidence) {
  const hue = Math.round((score / 100) * 125); // 0 red -> 125 green
  const sat = confidence === "measured" ? 78 : confidence === "reported" ? 62 : 45;
  const light = confidence === "predicted" ? 46 : 42;
  return `hsl(${hue} ${sat}% ${light}%)`;
}

const CONF_LABEL = {
  measured: { txt: "Live", cls: "measured", tip: "From a live sensor or real inventory" },
  reported: { txt: "Reported", cls: "reported", tip: "From a recent crowd report" },
  predicted: { txt: "Estimate", cls: "predicted", tip: "Predicted — no live data here" },
};

const KIND_ICON = { garage: "🏢", lot: "🅿️", street: "🛣️", meter: "🕒" };

function money(rate) {
  if (!rate) return null;
  const f = (n) => `$${n.toFixed(2)}`;
  return rate.min === rate.max ? `${f(rate.min)}/hr` : `${f(rate.min)}–${f(rate.max)}/hr`;
}

function spotName(spot) {
  if (spot.name) return spot.name;
  const k = { garage: "Parking garage", lot: "Parking lot", street: "Street parking", meter: "Metered parking" };
  return k[spot.kind] || "Parking";
}

// ------------------------------------------------------------------- search

async function runSearch(center, label) {
  if (state.busy) return;
  state.busy = true;
  state.center = center;
  showStatus("Searching for parking…", true);

  try {
    const { spots, reports } = await findParking({
      center,
      radiusM: Math.max(state.settings.maxWalkM, 400),
      keys: state.settings.keys,
    });
    state.reports = reports;

    const ranked = rankSpots(spots, center, new Date(), {
      maxWalkM: state.settings.maxWalkM,
      freeOnly: state.settings.freeOnly,
      mustBeLegal: state.settings.mustBeLegal,
    });
    state.results = ranked;

    renderList();
    renderMarkers();
    renderSourceNote();

    $("sheetTitle").textContent = label || "Parking near you";
    const live = ranked.filter((r) => r.avail.confidence === "measured").length;
    $("sheetSub").textContent = ranked.length
      ? `${ranked.length} option${ranked.length === 1 ? "" : "s"}` +
        (live ? ` · ${live} with live data` : " · all estimated") +
        ` · ${Math.round(demandAt() * 100)}% demand right now`
      : "Nothing found here — try a wider walk distance.";

    hideStatus();
    if (!ranked.length) showStatus("No parking found in range.", false, 3000);
  } catch (e) {
    console.error(e);
    showStatus(`Search failed: ${e.message}`, false, 5000);
  } finally {
    state.busy = false;
  }
}

// -------------------------------------------------------------------- list

function renderList() {
  const ul = $("list");
  ul.innerHTML = "";

  for (const r of state.results.slice(0, 60)) {
    const { spot, avail, legality, walkMin, dist } = r;
    const conf = CONF_LABEL[avail.confidence];

    const li = document.createElement("li");
    li.className = "row";
    li.tabIndex = 0;

    const bar = document.createElement("div");
    bar.className = "score";
    bar.style.background = scoreColor(avail.score, avail.confidence);
    bar.innerHTML = `<b>${avail.score}</b><i>%</i>`;

    const mid = document.createElement("div");
    mid.className = "mid";
    const price = money(spot.rate);
    mid.innerHTML = `
      <div class="row-title">${KIND_ICON[spot.kind] || "🅿️"} ${escapeHtml(spotName(spot))}</div>
      <div class="row-meta">
        <span>🚶 ${walkMin} min · ${dist < 1000 ? Math.round(dist) + " m" : (dist / 1000).toFixed(1) + " km"}</span>
        ${price ? `<span>💵 ${price}</span>` : spot.fee === false ? `<span>💵 Free</span>` : ""}
        ${spot.live ? `<span>🅿️ ${spot.live.free}/${spot.live.total} open</span>` : ""}
      </div>
      ${legality.warnings.length ? `<div class="warn">⚠︎ ${escapeHtml(legality.warnings[0])}</div>` : ""}
    `;

    const tag = document.createElement("span");
    tag.className = `conf ${conf.cls}`;
    tag.textContent = conf.txt;
    tag.title = conf.tip;

    li.append(bar, mid, tag);
    li.addEventListener("click", () => openDetail(r));
    li.addEventListener("keydown", (e) => e.key === "Enter" && openDetail(r));
    ul.appendChild(li);
  }
}

// ----------------------------------------------------------------- markers

function renderMarkers() {
  layer.clearLayers();
  state.markers.clear();

  for (const r of state.results.slice(0, 60)) {
    const { spot, avail } = r;
    const color = scoreColor(avail.score, avail.confidence);
    const dashed = avail.confidence === "predicted";

    const marker = L.circleMarker([spot.lat, spot.lon], {
      radius: 11,
      color: dashed ? color : "#fff",
      weight: dashed ? 2 : 2.5,
      dashArray: dashed ? "3 3" : null,
      fillColor: color,
      fillOpacity: 0.92,
    }).addTo(layer);

    marker.bindTooltip(
      `${spotName(spot)} — ${avail.score}%`,
      { direction: "top", offset: [0, -8] }
    );
    marker.on("click", () => openDetail(r));
    state.markers.set(spot.id, marker);
  }

  if (state.center) {
    if (meMarker) map.removeLayer(meMarker);
    meMarker = L.circleMarker([state.center.lat, state.center.lon], {
      radius: 7,
      color: "#fff",
      weight: 3,
      fillColor: "#2f7bff",
      fillOpacity: 1,
    }).addTo(map);
    frameResults();
  }
  drawParked();
}

// The bottom sheet (or the side panel on wide screens) covers a big chunk of the
// map, so fitting to the raw viewport would hide the best results underneath it.
// Pad the fit by whatever the chrome is actually covering right now.
function frameResults() {
  const pts = state.results.slice(0, 15).map((r) => [r.spot.lat, r.spot.lon]);
  pts.push([state.center.lat, state.center.lon]);

  const wide = window.innerWidth >= 860;
  const sheetCover = wide
    ? 0
    : Math.max(0, window.innerHeight - $("sheet").getBoundingClientRect().top);

  map.fitBounds(L.latLngBounds(pts), {
    paddingTopLeft: [18, 80], // search bar
    paddingBottomRight: wide ? [440, 24] : [18, sheetCover + 16],
    maxZoom: 17,
    animate: false,
  });
}

function drawParked() {
  const p = getParked();
  if (parkedMarker) {
    map.removeLayer(parkedMarker);
    parkedMarker = null;
  }
  if (!p) return;
  parkedMarker = L.marker([p.lat, p.lon], {
    icon: L.divIcon({ className: "parked-pin", html: "🚗", iconSize: [30, 30] }),
  })
    .addTo(map)
    .bindPopup(
      `<b>Your car</b><br>Parked ${timeAgo(new Date(p.at))}<br>` +
        `<a href="#" id="clearParked">Clear</a>`
    );
  parkedMarker.on("popupopen", () => {
    const el = document.getElementById("clearParked");
    if (el)
      el.onclick = (e) => {
        e.preventDefault();
        setParked(null);
        drawParked();
      };
  });
}

// ------------------------------------------------------------------ detail

function openDetail(r) {
  const { spot, avail, legality, walkMin, dist } = r;
  const conf = CONF_LABEL[avail.confidence];
  const price = money(spot.rate);

  $("detailBody").innerHTML = `
    <div class="detail-inner">
      <div class="detail-head">
        <div class="score big" style="background:${scoreColor(avail.score, avail.confidence)}">
          <b>${avail.score}</b><i>%</i>
        </div>
        <div>
          <h2>${KIND_ICON[spot.kind] || "🅿️"} ${escapeHtml(spotName(spot))}</h2>
          <p class="sub">
            <span class="conf ${conf.cls}">${conf.txt}</span>
            · 🚶 ${walkMin} min (${dist < 1000 ? Math.round(dist) + " m" : (dist / 1000).toFixed(1) + " km"})
          </p>
        </div>
      </div>

      ${
        legality.blockers.length
          ? `<div class="banner bad">🚫 ${legality.blockers.map(escapeHtml).join(" · ")}</div>`
          : legality.warnings.length
          ? `<div class="banner warn-b">⚠︎ ${legality.warnings.map(escapeHtml).join(" · ")}</div>`
          : `<div class="banner good">✅ You can park here right now</div>`
      }

      <h3>Why this score</h3>
      <ul class="reasons">
        ${avail.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}
      </ul>

      <div class="facts">
        ${fact("Type", { garage: "Garage", lot: "Surface lot", street: "On-street", meter: "Metered street" }[spot.kind])}
        ${fact("Price", price || (spot.fee === false ? "Free" : spot.fee ? "Paid" : null))}
        ${fact("Capacity", spot.capacity ? `${spot.capacity} spaces` : null)}
        ${fact("Max stay", spot.maxStay ? `${spot.maxStay >= 60 ? spot.maxStay / 60 + " hr" : spot.maxStay + " min"}` : null)}
        ${fact("Hours", spot.hours)}
        ${fact("Access", spot.access)}
        ${fact("Data from", sourceLabels(spot))}
      </div>

      <h3>Is it actually open right now?</h3>
      <p class="hint">Your report improves the estimate here for the next 90 minutes.</p>
      <div class="report-btns">
        <button data-report="open">😀 Plenty</button>
        <button data-report="some">😐 A few</button>
        <button data-report="full">😖 Full</button>
      </div>

      <div class="detail-actions">
        <a class="primary-btn" target="_blank" rel="noopener"
           href="https://www.google.com/maps/dir/?api=1&destination=${spot.lat},${spot.lon}&travelmode=driving">
          🧭 Navigate
        </a>
        <button id="parkHere" class="primary-btn ghost-btn">🚗 I parked here</button>
      </div>
    </div>
  `;

  $("detailBody")
    .querySelectorAll("[data-report]")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        addReport(spot.id, btn.dataset.report, {
          lat: spot.lat,
          lon: spot.lon,
          name: spotName(spot),
        });
        closeDetail();
        // Re-rank so the report takes effect immediately.
        state.results = rankSpots(
          state.results.map((x) => x.spot),
          state.center,
          new Date(),
          {
            maxWalkM: state.settings.maxWalkM,
            freeOnly: state.settings.freeOnly,
            mustBeLegal: state.settings.mustBeLegal,
          }
        );
        renderList();
        renderMarkers();
        showStatus("Thanks — report saved", false, 1800);
      })
    );

  $("parkHere").addEventListener("click", () => {
    setParked({ lat: spot.lat, lon: spot.lon, name: spotName(spot) });
    drawParked();
    closeDetail();
    showStatus("Saved where you parked 🚗", false, 2000);
  });

  $("detail").classList.remove("hidden");
  map.panTo([spot.lat, spot.lon]);
}

const fact = (k, v) =>
  v ? `<div class="fact"><span>${k}</span><b>${escapeHtml(String(v))}</b></div>` : "";

// Show the human name of each contributing source, not its internal id.
function sourceLabels(spot) {
  const ids = [...new Set(spot.mergedFrom || [spot.source])];
  return ids
    .map((id) => SOURCES.find((s) => s.id === id)?.label || id)
    .join(" + ");
}

const closeDetail = () => $("detail").classList.add("hidden");

// ------------------------------------------------------------ source note

function renderSourceNote() {
  const ok = state.reports.filter((r) => r.ok);
  const bad = state.reports.filter((r) => !r.ok);
  const parts = ok.map((r) => `${r.label}: ${r.count}`);
  $("sourceNote").innerHTML =
    `<b>Sources:</b> ${parts.join(" · ") || "none"}` +
    (bad.length ? `<br><span class="err">Unavailable: ${bad.map((b) => b.label).join(", ")}</span>` : "");
}

// --------------------------------------------------------------- geolocate

function locate() {
  if (!navigator.geolocation) {
    showStatus("Geolocation isn't available — search an address instead.", false, 4000);
    return;
  }
  showStatus("Getting your location…", true);
  navigator.geolocation.getCurrentPosition(
    (pos) =>
      runSearch(
        { lat: pos.coords.latitude, lon: pos.coords.longitude },
        "Parking near you"
      ),
    (err) => {
      const msg =
        err.code === 1
          ? "Location permission denied — search an address instead."
          : "Couldn't get your location.";
      showStatus(msg, false, 4000);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
  );
}

// ------------------------------------------------------------------ status

let statusTimer = null;
function showStatus(msg, spinning = false, autoHide = 0) {
  clearTimeout(statusTimer);
  const el = $("status");
  el.innerHTML = (spinning ? '<span class="spin"></span>' : "") + escapeHtml(msg);
  el.classList.remove("hidden");
  if (autoHide) statusTimer = setTimeout(hideStatus, autoHide);
}
const hideStatus = () => $("status").classList.add("hidden");

// ----------------------------------------------------------------- wiring

$("locateBtn").addEventListener("click", locate);

$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("searchInput").value.trim();
  if (!q) return;
  showStatus("Looking up that place…", true);
  try {
    const hits = await geocode(q);
    if (!hits.length) return showStatus("No match for that address.", false, 3000);
    if (hits.length === 1) {
      $("geoResults").classList.add("hidden");
      return runSearch({ lat: hits[0].lat, lon: hits[0].lon }, hits[0].label.split(",")[0]);
    }
    const box = $("geoResults");
    box.innerHTML = "";
    hits.forEach((h) => {
      const b = document.createElement("button");
      b.textContent = h.label;
      b.onclick = () => {
        box.classList.add("hidden");
        $("searchInput").blur();
        runSearch({ lat: h.lat, lon: h.lon }, h.label.split(",")[0]);
      };
      box.appendChild(b);
    });
    box.classList.remove("hidden");
    hideStatus();
  } catch (err) {
    showStatus("Address lookup failed.", false, 3000);
  }
});

$("refreshBtn").addEventListener("click", () => {
  if (state.center) runSearch(state.center, $("sheetTitle").textContent);
  else locate();
});

document.querySelectorAll(".chip[data-filter]").forEach((chip) => {
  chip.addEventListener("click", () => {
    const f = chip.dataset.filter;
    if (f === "walk") {
      const steps = [400, 800, 1200, 2000];
      const i = steps.indexOf(state.settings.maxWalkM);
      state.settings = saveSettings({ maxWalkM: steps[(i + 1) % steps.length] });
      updateWalkLabel();
    } else if (f === "free") {
      state.settings = saveSettings({ freeOnly: !state.settings.freeOnly });
      chip.classList.toggle("active", state.settings.freeOnly);
    } else if (f === "legal") {
      state.settings = saveSettings({ mustBeLegal: !state.settings.mustBeLegal });
      chip.classList.toggle("active", state.settings.mustBeLegal);
    }
    if (state.center) runSearch(state.center, $("sheetTitle").textContent);
  });
});

function updateWalkLabel() {
  const m = state.settings.maxWalkM;
  $("walkLabel").textContent = m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}

$("detailClose").addEventListener("click", closeDetail);
$("detail").addEventListener("click", (e) => {
  if (e.target.id === "detail") closeDetail();
});

// -------- settings panel

$("settingsBtn").addEventListener("click", () => {
  const s = state.settings;
  $("walkRange").value = s.maxWalkM;
  $("walkOut").textContent = `${s.maxWalkM} m`;
  $("googleKey").value = s.keys.googleKey || "";
  $("spotheroKey").value = s.keys.spotheroKey || "";
  $("inrixToken").value = s.keys.inrixToken || "";
  $("syncUrl").value = s.syncUrl || "";

  $("srcList").innerHTML = SOURCES.map((src) => {
    const on = !src.needsKey || !!s.keys[src.keyName];
    return `<li class="${on ? "on" : "off"}">
      <b>${escapeHtml(src.label)}</b>
      <span class="conf ${src.tier}">${src.tier === "measured" ? "Live" : "Estimate"}</span>
      <em>${on ? "active" : "needs a key"}</em>
    </li>`;
  }).join("");

  $("settings").classList.remove("hidden");
});

$("walkRange").addEventListener("input", (e) => {
  $("walkOut").textContent = `${e.target.value} m`;
});

$("saveSettings").addEventListener("click", () => {
  state.settings = saveSettings({
    maxWalkM: +$("walkRange").value,
    syncUrl: $("syncUrl").value.trim(),
    keys: {
      googleKey: $("googleKey").value.trim(),
      spotheroKey: $("spotheroKey").value.trim(),
      inrixToken: $("inrixToken").value.trim(),
    },
  });
  updateWalkLabel();
  $("settings").classList.add("hidden");
  if (state.center) runSearch(state.center, $("sheetTitle").textContent);
});

$("settingsClose").addEventListener("click", () => $("settings").classList.add("hidden"));

// -------- bottom sheet drag

const sheet = $("sheet");
let dragStart = null;
$("sheetGrip").addEventListener("pointerdown", (e) => {
  dragStart = { y: e.clientY, collapsed: sheet.classList.contains("collapsed") };
  $("sheetGrip").setPointerCapture(e.pointerId);
});
$("sheetGrip").addEventListener("pointerup", (e) => {
  if (!dragStart) return;
  const dy = e.clientY - dragStart.y;
  if (Math.abs(dy) < 6) sheet.classList.toggle("collapsed");
  else sheet.classList.toggle("collapsed", dy > 0);
  dragStart = null;
  // The visible map area just changed — re-fit so results stay in view.
  if (state.center && state.results.length) setTimeout(frameResults, 300);
});

// -------- PWA

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("./sw.js").catch(() => {})
  );
}

let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("installBtn").classList.remove("hidden");
});
$("installBtn").addEventListener("click", async () => {
  $("installBtn").classList.add("hidden");
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  deferredPrompt = null;
});

// -------- helpers

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function timeAgo(d) {
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} hr ago` : `${Math.round(h / 24)} d ago`;
}

// -------- boot

updateWalkLabel();
document.querySelector('[data-filter="free"]').classList.toggle("active", state.settings.freeOnly);
document.querySelector('[data-filter="legal"]').classList.toggle("active", state.settings.mustBeLegal);
drawParked();

// Jump straight to the user's location on open — that's the whole point.
locate();
