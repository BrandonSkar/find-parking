// Service worker — installable + offline shell.
//
// NETWORK-FIRST for the app shell so a fresh GitHub Pages deploy shows up right
// away. Parking data APIs are never cached: a cached availability number is
// worse than no number at all, so those always go straight to the network.

const CACHE = "find-parking-v1";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./sources.js",
  "./engine.js",
  "./storage.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
];

// Anything matching these is live data — always network, never cached.
const NEVER_CACHE = [
  "overpass",
  "data.lacity.org",
  "data.seattle.gov",
  "nominatim.openstreetmap.org",
  "googleapis.com",
  "spothero.com",
  "inrix.com",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = req.url;
  if (NEVER_CACHE.some((h) => url.includes(h))) return; // straight to network

  // Map tiles: cache-first, they're immutable and expensive to refetch.
  if (url.includes("basemaps.cartocdn.com")) {
    e.respondWith(
      caches.open(CACHE + "-tiles").then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // App shell: network-first, fall back to cache when offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && new URL(url).origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
