# Find Parking 🅿️

A static, installable PWA that answers one question: **can I park near here right now?**

No build step, no server, no API keys required. Drop it on GitHub Pages and it works.

---

## The honest answer to "is there an API for parking availability?"

Mostly **no** — and understanding why shapes the whole app.

There is no single API that tells you whether a space is free. What exists splits
into four very different things, and most parking apps feel like liars because
they blur them together. This app keeps them separate and labels every result:

| Tier | What it means | Where it actually exists |
|---|---|---|
| **Live** (measured) | A sensor or real inventory says a space is open | Rare. A few instrumented cities, and off-street garages with bookable inventory |
| **Reported** | A human said so recently | Crowdsourced, decays over 90 minutes |
| **Estimate** (predicted) | Modelled from history + demand + facility type | Everywhere else — the honest default |
| **Legality** | Are you *allowed* to park here at this moment? | Separate question, and often the one that gets you towed |

That last row matters. A garage with 40 free spaces that closes in 10 minutes is
not a good spot, and a street with plenty of room during a sweeping window is a
tow, not a win. Availability and legality are computed independently.

### What's wired up

**Free, no key, works out of the box:**

- **OpenStreetMap / Overpass** — the base layer. Worldwide coverage of lots,
  garages and street parking, with capacity / fee / access / opening-hours tags.
  Kerb parking comes back with the full shape of the block so it can be drawn
  as a line (see below). Knows *where* parking is, never whether it's free
  right now.
- **LA LADOT live meter occupancy** — genuinely real-time on-street sensor data,
  space by space, updated continuously. Free and unauthenticated. This is the
  rare case of true measured street availability.
- **Seattle occupancy history** — a real 2021 study of paid on-street occupancy,
  precomputed into a per-blockface, per-hour table (see below).

**Optional, key-gated** (the app is fully functional without them — add a key in
Settings and the source switches itself on):

- **Google Places** — parking *difficulty* (`PLENTY` / `SOMEWHAT_DIFFICULT` /
  `DIFFICULT`) and which parking types a place offers. Not live counts.
- **SpotHero** — real bookable off-street inventory. The only tier that can truly
  promise you a space. Needs a partner agreement.
- **INRIX** — the broadest commercial real-time occupancy, on- and off-street.
  Enterprise pricing.

Adding another provider means writing one adapter in `sources.js` with a `fetch()`
that returns `Spot[]`. Nothing in the UI or scoring engine needs to change.

### Sources that deliberately aren't here

- **Waze / Apple Maps** — no public parking API.
- **Google "popular times"** — only available by scraping, against their ToS.
- **ParkMobile / Passport** — payment rails, not availability, and no open API.

---

## Street parking is a line, not a pin

A garage is a place. A block of kerb is a **stretch**, and putting one pin in
the middle of it tells you nothing about where the parking starts or stops. So
kerb parking is drawn as a coloured line down the side of the street it's
actually on, using the same score colour as everything else.

Getting there takes a few things that aren't obvious:

- **Two queries, not one.** Lots only need a centre point; kerbs need their
  shape. Overpass can't do both in one `out` statement, so the query splits the
  results into two sets and asks for `center` on one and `geom` on the other.
  Measured at 96 KB / 2.0 s for an 800 m search in downtown Portland.
- **Ways don't stop at the block.** An arterial can run for kilometres past the
  search area. The path is clipped to the search radius, cutting the crossing
  segment at the boundary rather than dropping it — otherwise a road with
  vertices only at its far ends collapses to a single point.
- **The line is offset, not centred.** `parking:left` / `right` / `both` say
  which kerb, so each side is drawn ~5 m off the centreline along the segment
  normal. Both-sides streets get two lines. A line down the middle of the road
  would just look like a highlighted road.
- **The pin moves to the near end.** A block's distance is to its *closest*
  point, not its midpoint, so walk times are honest and the dot sits where
  you'd actually arrive.
- **Nobody tags how many cars fit.** Capacity is estimated from block length ÷
  space size, where the size comes from `parking:*:orientation` (parallel 5.5 m,
  diagonal 3.5 m, perpendicular 2.7 m), discounted 20% for driveways and
  corners. Blocks too short for one car are dropped as map noise.

Both tagging schemas are read — the current `parking:left=lane` one and the
older `parking:lane:left=parallel` — because both are in live use.

### What a kerb's score means

A block is a different question from a facility. The useful number isn't "how
empty is this street" but "will **at least one** of these n spaces be free",
which is much higher and grows with the length of the block. That's why
cruising a long street works and cruising a short one doesn't.

Spaces on one block don't free up independently, though — the whole street is
busy at the same times — so the effective count is damped to `√n` and capped at
6. A 150-space boulevard is not 150 independent coin flips.

Paid on-street, weekday:

| Block | 5pm peak | 3am |
|---|---|---|
| 2 spaces | 20% | 77% |
| 14 spaces | 37% | 97% |
| 36 spaces | 50% | 97% |
| 152 spaces | 50% | 97% |

The last two rows being identical is the cap doing its job: past ~36 spaces a
longer block stops helping, because what's really limiting you is that the
whole street is busy at once.

### The honest caveat

`parking:*` coverage is uneven. It's good in Germany and the Netherlands and in
a handful of US downtowns, and absent almost everywhere else. **A street with
no line is not a street with no parking** — it's a street nobody has mapped.

Worse, the rules that actually get you towed are barely mapped at all. In a
downtown Portland sample, 2 of 130 kerb ways carried any restriction tag, and
*none* carried a conditional one — so there is no street-sweeping data to
evaluate even in a well-mapped city. Until that's fixed, a kerb never shows a
clean "you can park here"; it always carries a check-the-signs caveat. Reading
`parking:*:restriction:conditional` and the municipal sweeping datasets (LA and
SF both publish theirs) is the next piece of work.

---

## How the estimate is built

When nothing is measured, `engine.js` scores 0–100 from:

- **Facility type** — garages start higher than street parking.
- **Time-of-day demand curve** — a weekday commuter double-peak and a flatter,
  later weekend curve, interpolated so it moves smoothly through the hour.
- **Historical occupancy** where a city publishes it — this overrides the generic
  curve entirely, because real observations beat a model.
- **Capacity** — big facilities almost always have something free (log-scaled).
  On-street blocks skip this and use the block model above instead, which prices
  capacity in already.
- **Price** — paid parking scores *higher*. Price rations demand; free parking
  next door fills up first. This is counterintuitive and it's the single most
  useful signal in the model.
- **Walking distance** — applied at ranking time with a super-linear penalty,
  because people hate long walks much more than proportionally. A 95% spot 15
  minutes away should lose to a 70% spot across the street.

Every result carries the reasons that produced it, shown in the detail sheet.
If the app can't justify a number, it shouldn't show it.

Measured readings **decay**: a sensor count drifts back toward the prediction as
it ages, rather than pretending a two-hour-old number is still true.

---

## Why Seattle's data is baked into the repo

The upstream dataset is a fixed 2021 study of roughly 40M rows. Filtering it by
hour through Socrata takes **minutes per request** — measured, not guessed.
That's unusable in an app.

The data never changes, so `scripts/build-seattle-data.mjs` aggregates it once
into a blockface × hour occupancy table that ships as a static file. It loads
instantly and works offline, which is exactly what a PWA wants.

```bash
node scripts/build-seattle-data.mjs   # writes data/seattle-occupancy.json
```

The build runs in two phases, and the split is not arbitrary. The obvious
query — group by blockface, location and hour in one shot — **never returns**.
Socrata plans it happily, but grouping on the `location` Point column across
40M rows pushes it past any timeout worth waiting for:

| Query | Result |
|---|---|
| `$limit=5` | 0.7 s |
| `$limit=100` | dead at 180 s |
| group by blockface + hour, one hour at a time | 116 s |
| group by blockface + **location** + hour | dead at 306 s |

The small-limit case returning instantly is a trap — Socrata short-circuits it
rather than computing the real aggregate.

So phase 1 gets coordinates from a handful of exact-timestamp reads (readings
land on whole hours, so equality on `occupancydatetime` is an indexed lookup —
966 blockfaces in under 3 seconds), and phase 2 walks the 24 hours one query at
a time with `location` kept out of the `GROUP BY`.

The committed table is **966 blockfaces × 11,388 blockface-hours in 200 KB**,
built in 34 minutes. Hours 0–7 come back empty because Seattle's paid parking
runs roughly 8am–8pm; that's the data telling the truth, not a gap.

> If `data/seattle-occupancy.json` is absent the Seattle source simply
> contributes nothing and OpenStreetMap still covers the city. Nothing errors,
> and no other city is affected.

The same pattern works for any city that publishes a historical occupancy study.

---

## Running it

It's plain static files — any web server works. It must be served over HTTP
(not opened as `file://`) because it uses ES modules and a service worker.

```bash
npx serve .
# or
python -m http.server 8000
```

Then open `http://localhost:8000`.

**Geolocation requires a secure context.** `localhost` counts as secure; a bare
LAN IP does not, so test on your phone via the deployed HTTPS URL rather than
`http://192.168.x.x`.

### Checking the data pipeline

```bash
node scripts/smoke.mjs
```

Runs the real adapters against live endpoints and asserts the results are sane,
ranked and explainable. It doubles as a "are the free feeds still up?" check.

### Regenerating icons

```bash
node scripts/make-icons.mjs
```

Pure Node, no dependencies — it writes the PNGs via `zlib`.

---

## Deploying to GitHub Pages

```bash
git init
git add -A
git commit -m "Find Parking"
git branch -M main
git remote add origin git@github.com:<you>/find-parking.git
git push -u origin main
```

Then **Settings → Pages → Source: `main` / root**.

Every path in the app is relative (`./app.js`, `./sw.js`), so it works from a
project subpath like `https://<you>.github.io/find-parking/` with no config.

### Add to Home Screen

Once it's on HTTPS, the manifest and service worker make it installable:

- **Android / Chrome** — an "Add to Home Screen" button appears in-app, or use
  the browser menu.
- **iOS / Safari** — Share → Add to Home Screen. (Safari never fires
  `beforeinstallprompt`, so the in-app button won't show; that's expected.)

It launches standalone with no browser chrome and the app shell works offline.
Live parking data obviously still needs a connection — the service worker never
caches availability responses, because a stale availability number is worse than
no number at all.

---

## A warning about API keys

This is a **static site**. Anything you paste into Settings lives in the browser
and is visible to anyone who opens devtools. There is no server to hide it behind.

- **Google keys** — restrict them by HTTP referrer to your Pages domain, and
  restrict them to the Places API only.
- **SpotHero / INRIX tokens** — these are typically account-level secrets and
  should *not* go in a browser. If you take those integrations past a demo, put
  a small proxy in front of them (a Cloudflare Worker or Vercel function) and
  point the adapter at the proxy instead.

Keys are stored in `localStorage` on your device only. Nothing is sent anywhere
except to the provider whose key it is.

## Privacy

Your location is used in the browser to query parking sources and is never sent
anywhere else. Crowd reports and your saved parking spot stay in `localStorage`
unless you configure a sync URL in Settings.

---

## Files

| File | Role |
|---|---|
| `sources.js` | Data adapters + the registry that fans out across them |
| `engine.js` | Legality, demand curve, availability scoring, ranking |
| `storage.js` | Crowd reports, settings, "where did I park" — all local |
| `app.js` | Map, list, detail sheet, PWA wiring |
| `sw.js` | Offline shell; never caches availability data |
| `data/` | Precomputed city occupancy tables |
| `scripts/` | Icon generation, data precompute, smoke test |

## Attribution

Map data © OpenStreetMap contributors (ODbL). Tiles © CARTO. Parking data from
the City of Los Angeles and City of Seattle open data portals.
