# Sessie-analyse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Een analysepagina voor losse zeilsessies (en per boot vanuit een wedstrijd): kaart met playback en rakken gekleurd per punt van zeil, geschatte windrichting met handmatige correctie, manoeuvre-detectie en een avondrapport.

**Architecture:** Alle rekenwerk zit in één DOM-vrij module `web/session-analysis.js` (UMD: werkt in browser én onder `node:test`). De nieuwe pagina `web/sessie.html` haalt punten uit bestaande endpoints (`GET /api/tracks/:id/points` voor eigen tracks, `POST /api/races/:id/compare-data` voor race-context) en rendert de analyse client-side. Geen server- of databasewijzigingen.

**Tech Stack:** Vanilla JS, Leaflet 1.9.4 (unpkg, zoals race.html), `node:test` (Node ≥ 22), bestaande `style.css`/`script.js`.

**Spec:** `docs/superpowers/specs/2026-07-08-sessie-analyse-design.md`

## Global Constraints

- Node ≥ 22 (README-vereiste); testrunner is ingebouwde `node --test`.
- Geen nieuwe npm-dependencies.
- UI-teksten in het Nederlands; codestijl zoals bestaande bestanden (Nederlandse commentaren, `'use strict'` in modules).
- Windrichting-conventie: graden waar de wind **vandaan** komt (kompas, 0 = noord).
- TWA-categorieën exact: `< 60°` = `aan-de-wind`, `60–120°` = `halve-wind`, `120–160°` = `ruime-wind`, `≥ 160°` = `voor-de-wind`.
- Kleuren per categorie: aan-de-wind `#1d4ed8`, halve-wind `#059669`, ruime-wind `#d97706`, voor-de-wind `#dc2626`, onbekend `#64748b`.
- Werkdirectory voor alle commando's: `regatta-server/` (de repo-root).
- Elke taak eindigt met een commit; commit-messages Nederlands met `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Analysemodule-skelet — geometriehelpers en koersberekening

**Files:**
- Create: `web/session-analysis.js`
- Create: `test/session-analysis.test.js`
- Modify: `package.json` (test-script)

**Interfaces:**
- Produces (gebruikt door alle latere taken): UMD-module `SessionAnalysis` met
  `toRad(deg)`, `toDeg(rad)`, `bearing(lat1,lon1,lat2,lon2) → 0..360`,
  `angleDiff(a,b) → (-180,180]` (b−a, kortste weg), `circularMean(angles[, weights]) → 0..360|null`,
  `haversineM(lat1,lon1,lat2,lon2) → meters`,
  `computeHeadings(points, windowSize=5) → points` (kopieën met extra veld `heading_deg: number|null`).
- Puntvorm overal in dit plan: `{ lat, lon, time?: ISO-string, speed_kn?: number }`.

- [ ] **Step 1: Schrijf de falende tests**

Maak `test/session-analysis.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SA = require('../web/session-analysis.js');

test('bearing: van west naar oost is 90 graden', () => {
  const b = SA.bearing(52.0, 5.0, 52.0, 5.01);
  assert.ok(Math.abs(b - 90) < 1, `verwacht ~90, kreeg ${b}`);
});

test('angleDiff: kortste weg over de noordgrens', () => {
  assert.strictEqual(SA.angleDiff(350, 10), 20);
  assert.strictEqual(SA.angleDiff(10, 350), -20);
  assert.strictEqual(SA.angleDiff(0, 180), 180);
});

test('circularMean: gemiddelde van 350 en 10 is 0', () => {
  const m = SA.circularMean([350, 10]);
  assert.ok(m < 1 || m > 359, `verwacht ~0, kreeg ${m}`);
});

test('computeHeadings: rechte lijn oost geeft ~90 graden', () => {
  const points = [];
  for (let i = 0; i < 10; i++) {
    points.push({ lat: 52.0, lon: 5.0 + i * 0.0001, speed_kn: 5 });
  }
  const withH = SA.computeHeadings(points);
  assert.strictEqual(withH.length, 10);
  for (const p of withH.slice(1)) {
    assert.ok(Math.abs(SA.angleDiff(90, p.heading_deg)) < 2, `verwacht ~90, kreeg ${p.heading_deg}`);
  }
});

test('computeHeadings: stilliggend punt erft vorige koers', () => {
  const points = [
    { lat: 52.0, lon: 5.0 }, { lat: 52.0, lon: 5.0001 },
    { lat: 52.0, lon: 5.0001 }, // zelfde plek
    { lat: 52.0, lon: 5.0002 },
  ];
  const withH = SA.computeHeadings(points, 1); // window 1 = geen smoothing
  assert.ok(withH[2].heading_deg != null);
});
```

- [ ] **Step 2: Voeg test-script toe en zie de test falen**

In `package.json` de scripts-regel vervangen:

```json
  "scripts": { "start": "node server.js", "test": "node --test test/" },
```

Run: `npm test`
Expected: FAIL — `Cannot find module '../web/session-analysis.js'`

- [ ] **Step 3: Schrijf de module**

Maak `web/session-analysis.js`:

```js
// session-analysis.js — DOM-vrije analyse van een zeiltrack.
// Draait in de browser (window.SessionAnalysis) én onder node:test (module.exports).
(function (global, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.SessionAnalysis = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toRad(d) { return d * Math.PI / 180; }
  function toDeg(r) { return r * 180 / Math.PI; }

  // Kompaskoers (0–360) van punt 1 naar punt 2
  function bearing(lat1, lon1, lat2, lon2) {
    const f1 = toRad(lat1), f2 = toRad(lat2), dl = toRad(lon2 - lon1);
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // Kleinste hoekverschil b − a, in (−180, 180]
  function angleDiff(a, b) {
    let d = (b - a) % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return d;
  }

  // Circulair (gewogen) gemiddelde van koersen; null bij lege input
  function circularMean(angles, weights) {
    let x = 0, y = 0;
    for (let i = 0; i < angles.length; i++) {
      const w = weights ? weights[i] : 1;
      x += w * Math.cos(toRad(angles[i]));
      y += w * Math.sin(toRad(angles[i]));
    }
    if (x === 0 && y === 0) return null;
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Koers per punt, circulair gladgestreken over windowSize punten.
  // Punten zonder verplaatsing erven de vorige ruwe koers.
  function computeHeadings(points, windowSize) {
    const win = windowSize || 5;
    const raw = new Array(points.length).fill(null);
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1], q = points[i];
      if (p.lat === q.lat && p.lon === q.lon) { raw[i] = raw[i - 1]; continue; }
      raw[i] = bearing(p.lat, p.lon, q.lat, q.lon);
    }
    raw[0] = raw.length > 1 ? raw[1] : null;
    const half = Math.floor(win / 2);
    return points.map((pt, i) => {
      const angles = [];
      for (let j = Math.max(0, i - half); j <= Math.min(points.length - 1, i + half); j++) {
        if (raw[j] != null) angles.push(raw[j]);
      }
      const heading = angles.length ? circularMean(angles) : null;
      return Object.assign({}, pt, { heading_deg: heading });
    });
  }

  return { toRad, toDeg, bearing, angleDiff, circularMean, haversineM, computeHeadings };
});
```

- [ ] **Step 4: Run de tests**

Run: `npm test`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add web/session-analysis.js test/session-analysis.test.js package.json
git commit -m "feat: analysemodule met geometriehelpers en koersberekening

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Windschatting uit het zeilpatroon

**Files:**
- Modify: `web/session-analysis.js`
- Create: `test/helpers.js`
- Modify: `test/session-analysis.test.js`

**Interfaces:**
- Consumes: `computeHeadings`, `angleDiff`, `circularMean` uit Task 1.
- Produces: `estimateWind(points) → { direction_deg: number|null, confidence: 'high'|'low'|'none' }`
  (punten moeten al `heading_deg` hebben). Testhelper `makeTrack(segments)` in `test/helpers.js`:
  `segments = [{ heading_deg, seconds, speed_kn }]` → puntenlijst (1 punt/seconde, start 52.0/5.0, tijd vanaf 2026-07-01T18:00:00Z).

- [ ] **Step 1: Schrijf de testhelper**

Maak `test/helpers.js`:

```js
'use strict';
// Genereert een synthetische track: 1 punt per seconde langs opgegeven koersen.
function makeTrack(segments) {
  const points = [];
  let lat = 52.0, lon = 5.0;
  let t = new Date('2026-07-01T18:00:00Z').getTime();
  const toRad = d => d * Math.PI / 180;
  for (const seg of segments) {
    for (let s = 0; s < seg.seconds; s++) {
      points.push({ lat, lon, time: new Date(t).toISOString(), speed_kn: seg.speed_kn });
      const distM = seg.speed_kn * 0.51444; // knopen → m/s, 1 s per punt
      lat += (distM * Math.cos(toRad(seg.heading_deg))) / 111320;
      lon += (distM * Math.sin(toRad(seg.heading_deg))) / (111320 * Math.cos(toRad(lat)));
      t += 1000;
    }
  }
  return points;
}
module.exports = { makeTrack };
```

- [ ] **Step 2: Schrijf de falende tests**

Voeg toe aan `test/session-analysis.test.js` (bovenaan naast de bestaande require: `const { makeTrack } = require('./helpers.js');`):

```js
test('estimateWind: kruisrakken 315/45 geven wind ~0 met hoge betrouwbaarheid', () => {
  const segs = [];
  for (let i = 0; i < 6; i++) {
    segs.push({ heading_deg: 315, seconds: 120, speed_kn: 5 });
    segs.push({ heading_deg: 45, seconds: 120, speed_kn: 5 });
  }
  const points = SA.computeHeadings(makeTrack(segs));
  const wind = SA.estimateWind(points);
  assert.ok(wind.direction_deg != null);
  assert.ok(Math.abs(SA.angleDiff(0, wind.direction_deg)) <= 10,
    `verwacht wind ~0, kreeg ${wind.direction_deg}`);
  assert.strictEqual(wind.confidence, 'high');
});

test('estimateWind: alleen een recht stuk geeft geen windrichting', () => {
  const points = SA.computeHeadings(makeTrack([{ heading_deg: 90, seconds: 600, speed_kn: 5 }]));
  const wind = SA.estimateWind(points);
  assert.strictEqual(wind.direction_deg, null);
  assert.strictEqual(wind.confidence, 'none');
});

test('estimateWind: dobberen (< 2 kn) telt niet mee', () => {
  const points = SA.computeHeadings(makeTrack([
    { heading_deg: 315, seconds: 300, speed_kn: 1 },
    { heading_deg: 45, seconds: 300, speed_kn: 1 },
  ]));
  const wind = SA.estimateWind(points);
  assert.strictEqual(wind.confidence, 'none');
});
```

Run: `npm test`
Expected: FAIL — `SA.estimateWind is not a function`

- [ ] **Step 3: Implementeer estimateWind**

Voeg toe in `web/session-analysis.js` (vóór de `return`-regel; neem `estimateWind` op in het geretourneerde object):

```js
  // Schat de windrichting (waar hij vandaan komt) uit kruisrakken:
  // twee dominante koerspieken 70–110° uit elkaar; wind = bissectrice.
  function estimateWind(points) {
    const bins = new Array(36).fill(0);
    let totalW = 0;
    for (let i = 1; i < points.length; i++) {
      const pt = points[i];
      if (pt.heading_deg == null || (pt.speed_kn || 0) <= 2) continue;
      let w = 1;
      if (pt.time && points[i - 1].time) {
        const dt = (new Date(pt.time) - new Date(points[i - 1].time)) / 1000;
        if (dt <= 0 || dt > 60) continue; // GPS-gat
        w = dt;
      }
      bins[Math.floor(pt.heading_deg / 10) % 36] += w;
      totalW += w;
    }
    if (totalW === 0) return { direction_deg: null, confidence: 'none' };

    // Lokale pieken in het histogram, zwaarste eerst
    const peaks = [];
    for (let b = 0; b < 36; b++) {
      const w = bins[b];
      if (w > 0 && w >= bins[(b + 35) % 36] && w >= bins[(b + 1) % 36]) {
        peaks.push({ deg: b * 10 + 5, w });
      }
    }
    peaks.sort((a, b) => b.w - a.w);

    // Zwaarste piekenpaar dat 70–110° uit elkaar ligt (bakboord/stuurboord aan de wind)
    let best = null;
    const top = Math.min(peaks.length, 6);
    for (let i = 0; i < top; i++) {
      for (let j = i + 1; j < top; j++) {
        const sep = Math.abs(angleDiff(peaks[i].deg, peaks[j].deg));
        if (sep >= 70 && sep <= 110) {
          const w = peaks[i].w + peaks[j].w;
          if (!best || w > best.w) best = { a: peaks[i].deg, b: peaks[j].deg, w };
        }
      }
    }
    if (!best) return { direction_deg: null, confidence: 'none' };

    // Bissectrice aan de scherpe kant = richting waar de wind vandaan komt
    const wind = circularMean([best.a, best.b]);
    const confidence = best.w / totalW >= 0.25 ? 'high' : 'low';
    return { direction_deg: Math.round(wind), confidence };
  }
```

- [ ] **Step 4: Run de tests**

Run: `npm test`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add web/session-analysis.js test/helpers.js test/session-analysis.test.js
git commit -m "feat: windschatting uit kruisrakken

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Rakken-segmentatie en punt-van-zeil-classificatie

**Files:**
- Modify: `web/session-analysis.js`
- Modify: `test/session-analysis.test.js`

**Interfaces:**
- Consumes: `angleDiff`, `circularMean`, `haversineM` (Task 1), `makeTrack` (Task 2).
- Produces:
  - `twaCategory(twaDeg) → 'aan-de-wind'|'halve-wind'|'ruime-wind'|'voor-de-wind'`
  - `segmentLegs(points, windDeg|null) → legs[]`, met per leg:
    `{ startIdx, endIdx, avg_heading_deg, twa_deg: number|null, category: string|null,
       tack: 'bakboord'|'stuurboord'|null, distance_m, duration_s: number|null,
       avg_speed_kn: number|null, max_speed_kn: number|null }`.
    Bij `windDeg == null` zijn `twa_deg`, `category` en `tack` null.
    Tack-conventie: `angleDiff(windDeg, avg_heading_deg) >= 0` → `'bakboord'`, anders `'stuurboord'`.

- [ ] **Step 1: Schrijf de falende tests**

Voeg toe aan `test/session-analysis.test.js`:

```js
test('twaCategory: grenzen kloppen', () => {
  assert.strictEqual(SA.twaCategory(30), 'aan-de-wind');
  assert.strictEqual(SA.twaCategory(59.9), 'aan-de-wind');
  assert.strictEqual(SA.twaCategory(60), 'halve-wind');
  assert.strictEqual(SA.twaCategory(119.9), 'halve-wind');
  assert.strictEqual(SA.twaCategory(120), 'ruime-wind');
  assert.strictEqual(SA.twaCategory(160), 'voor-de-wind');
  assert.strictEqual(SA.twaCategory(180), 'voor-de-wind');
});

test('segmentLegs: drie duidelijke rakken worden drie legs', () => {
  const points = SA.computeHeadings(makeTrack([
    { heading_deg: 45, seconds: 120, speed_kn: 5 },
    { heading_deg: 135, seconds: 120, speed_kn: 6 },
    { heading_deg: 45, seconds: 120, speed_kn: 5 },
  ]));
  const legs = SA.segmentLegs(points, 0); // wind uit het noorden
  assert.strictEqual(legs.length, 3);
  assert.strictEqual(legs[0].category, 'aan-de-wind');
  assert.strictEqual(legs[1].category, 'ruime-wind');
  assert.strictEqual(legs[2].category, 'aan-de-wind');
  assert.strictEqual(legs[0].tack, 'bakboord');   // koers 45, wind 0 → diff +45
  assert.ok(legs[1].avg_speed_kn > 5.5 && legs[1].avg_speed_kn < 6.5);
  assert.ok(legs[0].duration_s > 100 && legs[0].duration_s < 140);
});

test('segmentLegs: zonder wind geen categorie, wel rakken', () => {
  const points = SA.computeHeadings(makeTrack([
    { heading_deg: 45, seconds: 120, speed_kn: 5 },
    { heading_deg: 135, seconds: 120, speed_kn: 5 },
  ]));
  const legs = SA.segmentLegs(points, null);
  assert.strictEqual(legs.length, 2);
  assert.strictEqual(legs[0].category, null);
  assert.strictEqual(legs[0].tack, null);
});

test('segmentLegs: korte uitschieter wordt samengevoegd', () => {
  const points = SA.computeHeadings(makeTrack([
    { heading_deg: 45, seconds: 300, speed_kn: 5 },
    { heading_deg: 135, seconds: 8, speed_kn: 5 }, // < 30 s: geen eigen rak
    { heading_deg: 45, seconds: 300, speed_kn: 5 },
  ]));
  const legs = SA.segmentLegs(points, 0);
  assert.strictEqual(legs.length, 1);
});
```

Run: `npm test`
Expected: FAIL — `SA.twaCategory is not a function`

- [ ] **Step 2: Implementeer twaCategory en segmentLegs**

Voeg toe in `web/session-analysis.js` (en exporteer beide):

```js
  // Punt van zeil op basis van true wind angle (0–180)
  function twaCategory(twa) {
    if (twa < 60) return 'aan-de-wind';
    if (twa < 120) return 'halve-wind';
    if (twa < 160) return 'ruime-wind';
    return 'voor-de-wind';
  }

  function makeLeg(points, startIdx, endIdx, windDeg) {
    const headings = [];
    let dist = 0, maxSpd = null, spdSum = 0, spdN = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      if (points[i].heading_deg != null) headings.push(points[i].heading_deg);
      if (i > startIdx) dist += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      const s = points[i].speed_kn;
      if (s != null) { spdSum += s; spdN++; if (maxSpd == null || s > maxSpd) maxSpd = s; }
    }
    const avgHeading = circularMean(headings);
    const t0 = points[startIdx].time, t1 = points[endIdx].time;
    const duration = t0 && t1 ? (new Date(t1) - new Date(t0)) / 1000 : null;
    let twa = null, category = null, tack = null;
    if (windDeg != null && avgHeading != null) {
      const d = angleDiff(windDeg, avgHeading);
      twa = Math.abs(d);
      category = twaCategory(twa);
      tack = d >= 0 ? 'bakboord' : 'stuurboord';
    }
    return {
      startIdx, endIdx,
      avg_heading_deg: avgHeading != null ? Math.round(avgHeading) : null,
      twa_deg: twa != null ? Math.round(twa) : null,
      category, tack,
      distance_m: Math.round(dist),
      duration_s: duration != null ? Math.round(duration) : null,
      avg_speed_kn: spdN ? Math.round((spdSum / spdN) * 10) / 10 : null,
      max_speed_kn: maxSpd,
    };
  }

  // Knip de track in rakken: nieuw rak zodra de koers ≥ 3 punten achtereen
  // meer dan 40° van het lopende rakgemiddelde afwijkt.
  // Rakken korter dan 30 s (of zonder tijd: < 10 punten) gaan op in hun buurman.
  function segmentLegs(points, windDeg) {
    if (points.length < 2) return [];
    const boundaries = [0];
    let mean = null, deviated = 0;
    const SUSTAIN = 3;
    for (let i = 0; i < points.length; i++) {
      const h = points[i].heading_deg;
      if (h == null) continue;
      if (mean == null) { mean = h; continue; }
      if (Math.abs(angleDiff(mean, h)) > 40) {
        deviated++;
        if (deviated >= SUSTAIN) {
          boundaries.push(i - SUSTAIN + 1);
          mean = h;
          deviated = 0;
        }
      } else {
        deviated = 0;
        mean = (mean + angleDiff(mean, h) * 0.1 + 360) % 360; // langzaam meebewegend gemiddelde
      }
    }

    // Bouw legs uit de grenzen
    let legs = [];
    for (let b = 0; b < boundaries.length; b++) {
      const start = boundaries[b];
      const end = b + 1 < boundaries.length ? boundaries[b + 1] - 1 : points.length - 1;
      if (end > start) legs.push(makeLeg(points, start, end, windDeg));
    }

    // Korte rakken samenvoegen met de buurman waarvan de koers het dichtst ligt
    const tooShort = (leg) => leg.duration_s != null
      ? leg.duration_s < 30
      : (leg.endIdx - leg.startIdx) < 10;
    let merged = true;
    while (merged && legs.length > 1) {
      merged = false;
      for (let i = 0; i < legs.length; i++) {
        if (!tooShort(legs[i])) continue;
        const prev = i > 0 ? legs[i - 1] : null;
        const next = i < legs.length - 1 ? legs[i + 1] : null;
        const dPrev = prev ? Math.abs(angleDiff(prev.avg_heading_deg, legs[i].avg_heading_deg)) : Infinity;
        const dNext = next ? Math.abs(angleDiff(next.avg_heading_deg, legs[i].avg_heading_deg)) : Infinity;
        if (dPrev <= dNext && prev) {
          legs.splice(i - 1, 2, makeLeg(points, prev.startIdx, legs[i].endIdx, windDeg));
        } else if (next) {
          legs.splice(i, 2, makeLeg(points, legs[i].startIdx, next.endIdx, windDeg));
        } else break;
        merged = true;
        break;
      }
    }

    // Naburige rakken met (vrijwel) dezelfde koers samenvoegen (< 30° verschil)
    merged = true;
    while (merged && legs.length > 1) {
      merged = false;
      for (let i = 1; i < legs.length; i++) {
        if (Math.abs(angleDiff(legs[i - 1].avg_heading_deg, legs[i].avg_heading_deg)) < 30) {
          legs.splice(i - 1, 2, makeLeg(points, legs[i - 1].startIdx, legs[i].endIdx, windDeg));
          merged = true;
          break;
        }
      }
    }
    return legs;
  }
```

- [ ] **Step 3: Run de tests**

Run: `npm test`
Expected: PASS (12 tests)

- [ ] **Step 4: Commit**

```bash
git add web/session-analysis.js test/session-analysis.test.js
git commit -m "feat: rakken-segmentatie met punt-van-zeil-classificatie

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Manoeuvre-detectie (overstag/gijp)

**Files:**
- Modify: `web/session-analysis.js`
- Modify: `test/session-analysis.test.js`

**Interfaces:**
- Consumes: `segmentLegs`-output (Task 3), `angleDiff` (Task 1).
- Produces: `detectManeuvers(points, legs, windDeg) → maneuvers[]`, per manoeuvre:
  `{ idx, type: 'overstag'|'gijp', time: ISO|null, lat, lon,
     speed_loss_kn: number|null, recovery_s: number|null }`.
  `idx` = `startIdx` van het rak ná de bocht. Bochten die de wind niet kruisen
  (bv. ronde om een eiland) leveren géén manoeuvre op.

- [ ] **Step 1: Schrijf de falende tests**

Voeg toe aan `test/session-analysis.test.js`:

```js
test('detectManeuvers: kruisrakken geven overstagslagen', () => {
  const segs = [];
  for (let i = 0; i < 4; i++) {
    segs.push({ heading_deg: 315, seconds: 120, speed_kn: 5 });
    segs.push({ heading_deg: 45, seconds: 120, speed_kn: 5 });
  }
  const points = SA.computeHeadings(makeTrack(segs));
  const legs = SA.segmentLegs(points, 0);
  const mans = SA.detectManeuvers(points, legs, 0);
  assert.strictEqual(mans.length, 7); // 8 rakken → 7 wissels
  assert.ok(mans.every(m => m.type === 'overstag'));
});

test('detectManeuvers: ruime zigzag geeft gijpen', () => {
  const points = SA.computeHeadings(makeTrack([
    { heading_deg: 135, seconds: 120, speed_kn: 5 },
    { heading_deg: 225, seconds: 120, speed_kn: 5 },
    { heading_deg: 135, seconds: 120, speed_kn: 5 },
  ]));
  const legs = SA.segmentLegs(points, 0);
  const mans = SA.detectManeuvers(points, legs, 0);
  assert.strictEqual(mans.length, 2);
  assert.ok(mans.every(m => m.type === 'gijp'));
});

test('detectManeuvers: zonder wind geen manoeuvres', () => {
  const points = SA.computeHeadings(makeTrack([
    { heading_deg: 315, seconds: 120, speed_kn: 5 },
    { heading_deg: 45, seconds: 120, speed_kn: 5 },
  ]));
  const legs = SA.segmentLegs(points, null);
  assert.deepStrictEqual(SA.detectManeuvers(points, legs, null), []);
});
```

Run: `npm test`
Expected: FAIL — `SA.detectManeuvers is not a function`

- [ ] **Step 2: Implementeer detectManeuvers**

Voeg toe in `web/session-analysis.js` (en exporteer):

```js
  // Ligt target op de korte boog van from naar to?
  function arcContains(from, to, target) {
    const span = angleDiff(from, to);
    const t = angleDiff(from, target);
    return span >= 0 ? (t >= 0 && t <= span) : (t <= 0 && t >= span);
  }

  // Gemiddelde snelheid in de secondes [fromS, toS] rond index idx (negatief = ervoor)
  function avgSpeedAround(points, idx, fromS, toS) {
    if (!points[idx].time) return null;
    const t0 = new Date(points[idx].time).getTime();
    let sum = 0, n = 0;
    for (const pt of points) {
      if (!pt.time || pt.speed_kn == null) continue;
      const dt = (new Date(pt.time).getTime() - t0) / 1000;
      if (dt >= fromS && dt <= toS) { sum += pt.speed_kn; n++; }
    }
    return n ? sum / n : null;
  }

  // Manoeuvres op rakgrenzen: koerswissel ≥ 60° die de windrichting kruist
  // (overstag) of de wind+180 (gijp).
  function detectManeuvers(points, legs, windDeg) {
    if (windDeg == null) return [];
    const out = [];
    for (let k = 1; k < legs.length; k++) {
      const a = legs[k - 1], b = legs[k];
      if (a.avg_heading_deg == null || b.avg_heading_deg == null) continue;
      if (Math.abs(angleDiff(a.avg_heading_deg, b.avg_heading_deg)) < 60) continue;
      let type = null;
      if (arcContains(a.avg_heading_deg, b.avg_heading_deg, windDeg)) type = 'overstag';
      else if (arcContains(a.avg_heading_deg, b.avg_heading_deg, (windDeg + 180) % 360)) type = 'gijp';
      if (!type) continue;

      const idx = b.startIdx;
      const before = avgSpeedAround(points, idx, -30, -5); // snelheid vóór de bocht
      // minimum snelheid binnen ±15 s van de bocht
      let minSpd = null;
      if (points[idx].time) {
        const t0 = new Date(points[idx].time).getTime();
        for (const pt of points) {
          if (!pt.time || pt.speed_kn == null) continue;
          const dt = Math.abs((new Date(pt.time).getTime() - t0) / 1000);
          if (dt <= 15 && (minSpd == null || pt.speed_kn < minSpd)) minSpd = pt.speed_kn;
        }
      }
      const loss = before != null && minSpd != null ? Math.max(0, before - minSpd) : null;

      // hersteltijd: eerste moment ná de bocht dat de snelheid ≥ 90% van 'before' is
      let recovery = null;
      if (before != null && points[idx].time) {
        const t0 = new Date(points[idx].time).getTime();
        for (let i = idx; i < points.length; i++) {
          const pt = points[i];
          if (!pt.time || pt.speed_kn == null) continue;
          const dt = (new Date(pt.time).getTime() - t0) / 1000;
          if (dt > 120) break;
          if (pt.speed_kn >= before * 0.9) { recovery = Math.round(dt); break; }
        }
      }

      out.push({
        idx, type,
        time: points[idx].time || null,
        lat: points[idx].lat, lon: points[idx].lon,
        speed_loss_kn: loss != null ? Math.round(loss * 10) / 10 : null,
        recovery_s: recovery,
      });
    }
    return out;
  }
```

- [ ] **Step 3: Run de tests**

Run: `npm test`
Expected: PASS (15 tests)

- [ ] **Step 4: Commit**

```bash
git add web/session-analysis.js test/session-analysis.test.js
git commit -m "feat: overstag/gijp-detectie met snelheidsverlies en hersteltijd

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Rapport en orchestrator

**Files:**
- Modify: `web/session-analysis.js`
- Modify: `test/session-analysis.test.js`

**Interfaces:**
- Consumes: alles uit Task 1–4.
- Produces:
  - `buildReport(points, legs, maneuvers) → report`:
    ```
    { best_10s: { start_idx, end_idx, avg_speed_kn } | null,
      longest_leg_idx: number|null,          // index in legs, op afstand
      beat_angle_deg: number|null,           // hoek bakboord- vs stuurboord-kruiskoers
      maneuvers: { tacks, gybes, avg_loss_kn: number|null },
      twa_distribution: { [category]: { time_s, distance_m } } }  // alleen categorieën die voorkomen
    ```
  - `analyzeSession(rawPoints, opts?) → { points, wind: { estimated, used_deg }, legs, maneuvers, report }`
    met `opts = { windOverrideDeg?: number|null, headingWindow?: number }`.
    `points` zijn de punten mét `heading_deg`; `wind.estimated` is de `estimateWind`-uitkomst;
    `wind.used_deg` is de override als die is meegegeven, anders de schatting (of null).

- [ ] **Step 1: Schrijf de falende tests**

Voeg toe aan `test/session-analysis.test.js`:

```js
test('buildReport: beste 10 s zit in het snelle stuk', () => {
  const points = SA.computeHeadings(makeTrack([
    { heading_deg: 45, seconds: 120, speed_kn: 4 },
    { heading_deg: 45, seconds: 30, speed_kn: 8 },  // sprint
    { heading_deg: 45, seconds: 120, speed_kn: 4 },
  ]));
  const legs = SA.segmentLegs(points, 0);
  const report = SA.buildReport(points, legs, []);
  assert.ok(report.best_10s);
  assert.ok(report.best_10s.avg_speed_kn > 7, `verwacht > 7, kreeg ${report.best_10s.avg_speed_kn}`);
  assert.ok(report.best_10s.start_idx >= 115 && report.best_10s.start_idx <= 155);
});

test('buildReport: opkruishoek uit bakboord- en stuurboordrakken', () => {
  const segs = [];
  for (let i = 0; i < 3; i++) {
    segs.push({ heading_deg: 315, seconds: 120, speed_kn: 5 });
    segs.push({ heading_deg: 45, seconds: 120, speed_kn: 5 });
  }
  const points = SA.computeHeadings(makeTrack(segs));
  const legs = SA.segmentLegs(points, 0);
  const mans = SA.detectManeuvers(points, legs, 0);
  const report = SA.buildReport(points, legs, mans);
  assert.ok(Math.abs(report.beat_angle_deg - 90) <= 10, `verwacht ~90, kreeg ${report.beat_angle_deg}`);
  assert.strictEqual(report.maneuvers.tacks, 5);
  assert.strictEqual(report.maneuvers.gybes, 0);
  assert.ok(report.twa_distribution['aan-de-wind'].time_s > 600);
});

test('analyzeSession: override wint van de schatting', () => {
  const segs = [];
  for (let i = 0; i < 4; i++) {
    segs.push({ heading_deg: 315, seconds: 120, speed_kn: 5 });
    segs.push({ heading_deg: 45, seconds: 120, speed_kn: 5 });
  }
  const result = SA.analyzeSession(makeTrack(segs), { windOverrideDeg: 90 });
  assert.strictEqual(result.wind.used_deg, 90);
  assert.ok(Math.abs(SA.angleDiff(0, result.wind.estimated.direction_deg)) <= 10);
  // met wind uit 90 hebben de rakken op koers 45 een twa van 45 → aan de wind
  const leg45 = result.legs.find(l => Math.abs(SA.angleDiff(45, l.avg_heading_deg)) < 15);
  assert.strictEqual(leg45.category, 'aan-de-wind');
});

test('analyzeSession: zonder bruikbare wind geen manoeuvres, wel rakken', () => {
  const result = SA.analyzeSession(makeTrack([{ heading_deg: 90, seconds: 600, speed_kn: 5 }]));
  assert.strictEqual(result.wind.used_deg, null);
  assert.deepStrictEqual(result.maneuvers, []);
  assert.ok(result.legs.length >= 1);
  assert.strictEqual(result.report.beat_angle_deg, null);
});
```

Run: `npm test`
Expected: FAIL — `SA.buildReport is not a function`

- [ ] **Step 2: Implementeer buildReport en analyzeSession**

Voeg toe in `web/session-analysis.js` (en exporteer beide):

```js
  function buildReport(points, legs, maneuvers) {
    // Beste 10 seconden: rollend venster op tijd
    let best = null;
    for (let i = 0; i < points.length; i++) {
      if (!points[i].time) continue;
      const t0 = new Date(points[i].time).getTime();
      let sum = 0, n = 0, j = i;
      while (j < points.length && points[j].time &&
             (new Date(points[j].time).getTime() - t0) / 1000 <= 10) {
        if (points[j].speed_kn != null) { sum += points[j].speed_kn; n++; }
        j++;
      }
      if (n >= 3) {
        const avg = sum / n;
        if (!best || avg > best.avg_speed_kn) {
          best = { start_idx: i, end_idx: j - 1, avg_speed_kn: Math.round(avg * 10) / 10 };
        }
      }
    }

    // Langste rak op afstand
    let longestIdx = null;
    for (let i = 0; i < legs.length; i++) {
      if (longestIdx == null || legs[i].distance_m > legs[longestIdx].distance_m) longestIdx = i;
    }

    // Opkruishoek: circulair gemiddelde koers per boeg van de aan-de-windse rakken
    const upP = legs.filter(l => l.category === 'aan-de-wind' && l.tack === 'bakboord');
    const upS = legs.filter(l => l.category === 'aan-de-wind' && l.tack === 'stuurboord');
    let beatAngle = null;
    if (upP.length && upS.length) {
      const hP = circularMean(upP.map(l => l.avg_heading_deg), upP.map(l => l.distance_m));
      const hS = circularMean(upS.map(l => l.avg_heading_deg), upS.map(l => l.distance_m));
      beatAngle = Math.round(Math.abs(angleDiff(hP, hS)));
    }

    const tacks = maneuvers.filter(m => m.type === 'overstag').length;
    const gybes = maneuvers.filter(m => m.type === 'gijp').length;
    const losses = maneuvers.map(m => m.speed_loss_kn).filter(v => v != null);
    const avgLoss = losses.length
      ? Math.round((losses.reduce((a, b) => a + b, 0) / losses.length) * 10) / 10 : null;

    const dist = {};
    for (const leg of legs) {
      if (!leg.category) continue;
      if (!dist[leg.category]) dist[leg.category] = { time_s: 0, distance_m: 0 };
      dist[leg.category].time_s += leg.duration_s || 0;
      dist[leg.category].distance_m += leg.distance_m || 0;
    }

    return {
      best_10s: best,
      longest_leg_idx: longestIdx,
      beat_angle_deg: beatAngle,
      maneuvers: { tacks, gybes, avg_loss_kn: avgLoss },
      twa_distribution: dist,
    };
  }

  // Orchestrator: hele analyse in één aanroep.
  function analyzeSession(rawPoints, opts) {
    const o = opts || {};
    const points = computeHeadings(rawPoints, o.headingWindow || 5);
    const estimated = estimateWind(points);
    const usedDeg = o.windOverrideDeg != null ? o.windOverrideDeg : estimated.direction_deg;
    const legs = segmentLegs(points, usedDeg);
    const maneuvers = detectManeuvers(points, legs, usedDeg);
    const report = buildReport(points, legs, maneuvers);
    return { points, wind: { estimated, used_deg: usedDeg }, legs, maneuvers, report };
  }
```

- [ ] **Step 3: Run de tests**

Run: `npm test`
Expected: PASS (19 tests)

- [ ] **Step 4: Commit**

```bash
git add web/session-analysis.js test/session-analysis.test.js
git commit -m "feat: sessierapport en analyse-orchestrator

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: sessie.html — skelet, datalading, kaart met gekleurde rakken en windpaneel

**Files:**
- Create: `web/sessie.html`

**Interfaces:**
- Consumes: `SessionAnalysis.analyzeSession` (Task 5); endpoints
  `GET /api/tracks/:id/points` → `{ id, name, recorded_at, points, point_count, max_speed_kn }` en
  `POST /api/races/:raceId/compare-data` body `{ track_ids: [id] }` → `[{ id, label, points, ... }]`;
  helpers uit `script.js`: `requireAuth()`, `checkAdmin()`, `renderHeader()`, `apiGet`, `apiPost`, `getToken`, `escHtml`, `fmtDate`, `fmtDuration`, `API`.
- Produces (gebruikt door Task 7 en 8): globale state `session` (analyzeSession-resultaat),
  `trackMeta` (`{ name, recorded_at }`), `map` (Leaflet), functies `renderAll()` en
  `setWindOverride(deg|null)`; containers `#session-header`, `#map`, `#wind-panel`,
  `#playback-section`, `#report-section`; localStorage-sleutel `windOverride:<trackId>`.

- [ ] **Step 1: Maak de pagina**

Maak `web/sessie.html`:

```html
<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Regatta Screen — Sessie</title>
  <link rel="stylesheet" href="style.css" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    .session-page { max-width: 1100px; margin: 0 auto; padding: 20px 24px 80px; width: 100%; }
    .session-page h2 { font-family: var(--font-display); font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 14px 0 20px; }
    .stat-cell { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; }
    .stat-cell .val { font-family: var(--font-mono); font-size: 20px; font-weight: 700; }
    .stat-cell .lbl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    #map { height: 420px; border-radius: var(--radius-md); border: 1px solid var(--border); }
    .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--muted); }
    .legend .sw { display: inline-block; width: 14px; height: 4px; border-radius: 2px; vertical-align: middle; margin-right: 4px; }
    .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 16px 18px; margin-top: 16px; }
    .panel h4 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 10px; }
    .wind-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .wind-arrow { font-size: 26px; display: inline-block; transition: transform 0.2s; }
    .wind-row input[type=range] { flex: 1; min-width: 160px; }
    .muted { color: var(--muted); font-size: 13px; }
    .loading-state, .error-state { text-align: center; padding: 60px 20px; color: var(--muted); }
  </style>
</head>
<body>
  <header class="app-header"></header>

  <div class="session-page">
    <div id="session-content">
      <div class="loading-state"><p>Sessie laden…</p></div>
    </div>
  </div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script src="script.js"></script>
  <script src="session-analysis.js"></script>
  <script>
    requireAuth();
    checkAdmin().then(() => renderHeader(''));

    const params = new URLSearchParams(window.location.search);
    const trackId = params.get('track');
    const raceId = params.get('race');

    const CAT_COLORS = {
      'aan-de-wind': '#1d4ed8', 'halve-wind': '#059669',
      'ruime-wind': '#d97706', 'voor-de-wind': '#dc2626', null: '#64748b',
    };
    const CAT_LABELS = {
      'aan-de-wind': 'Aan de wind', 'halve-wind': 'Halve wind',
      'ruime-wind': 'Ruime wind', 'voor-de-wind': 'Voor de wind', null: 'Onbekend',
    };

    let session = null;      // analyzeSession-resultaat
    let trackMeta = null;    // { name, recorded_at }
    let rawPoints = null;
    let map = null;
    let legLayers = [];

    function windKey() { return 'windOverride:' + trackId; }

    async function loadSession() {
      const container = document.getElementById('session-content');
      if (!trackId) {
        container.innerHTML = '<div class="error-state"><p>Geen track opgegeven. <a href="dashboard.html">Ga terug</a>.</p></div>';
        return;
      }
      try {
        if (raceId) {
          const results = await apiPost('/races/' + raceId + '/compare-data', { track_ids: [parseInt(trackId, 10)] });
          if (!Array.isArray(results) || !results.length) throw new Error('Track niet gevonden in deze wedstrijd.');
          rawPoints = results[0].points;
          trackMeta = { name: results[0].label, recorded_at: results[0].start_time };
        } else {
          const data = await apiGet('/tracks/' + trackId + '/points');
          if (!data || data.error) throw new Error(data?.error || 'Track niet gevonden.');
          rawPoints = data.points;
          trackMeta = { name: data.name, recorded_at: data.recorded_at };
        }

        const savedWind = localStorage.getItem(windKey());
        const override = savedWind != null && savedWind !== '' ? parseInt(savedWind, 10) : null;
        session = SessionAnalysis.analyzeSession(rawPoints, { windOverrideDeg: override });
        renderAll();
      } catch (e) {
        container.innerHTML = '<div class="error-state"><p>Kon sessie niet laden: <code>' +
          escHtml(e.message || 'onbekende fout') + '</code>. <a href="dashboard.html">Ga terug</a>.</p></div>';
      }
    }

    // Windcorrectie: null = terug naar schatting; herrekent en hertekent alles
    function setWindOverride(deg) {
      if (deg == null) localStorage.removeItem(windKey());
      else localStorage.setItem(windKey(), String(deg));
      session = SessionAnalysis.analyzeSession(rawPoints, { windOverrideDeg: deg });
      renderAll();
    }

    function hasTimes() {
      return session.points.length > 1 && !!session.points[0].time && !!session.points[1].time;
    }

    function totalStats() {
      const pts = session.points;
      let dist = 0;
      for (let i = 1; i < pts.length; i++) {
        dist += SessionAnalysis.haversineM(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
      }
      const speeds = pts.map(p => p.speed_kn).filter(s => s != null);
      const dur = hasTimes()
        ? (new Date(pts[pts.length-1].time) - new Date(pts[0].time)) / 1000 : null;
      return {
        distance_m: dist,
        duration_s: dur,
        max_kn: speeds.length ? Math.max(...speeds) : null,
        avg_kn: speeds.length ? speeds.reduce((a,b) => a+b, 0) / speeds.length : null,
      };
    }

    function renderAll() {
      const container = document.getElementById('session-content');
      const s = totalStats();
      const kn = v => v != null ? v.toFixed(1) + ' kn' : '—';
      const dist = s.distance_m >= 1000 ? (s.distance_m/1000).toFixed(1) + ' km' : Math.round(s.distance_m) + ' m';

      container.innerHTML = `
        <div class="breadcrumb">
          <a href="dashboard.html">Mijn data</a><span>·</span>
          <span>${escHtml(trackMeta.name || 'Sessie')}</span>
        </div>
        <div id="session-header">
          <h2>${escHtml(trackMeta.name || 'Sessie')}</h2>
          <p class="muted">${fmtDate(trackMeta.recorded_at)}</p>
          <div class="stat-grid">
            <div class="stat-cell"><div class="val">${kn(s.max_kn)}</div><div class="lbl">Max</div></div>
            <div class="stat-cell"><div class="val">${kn(s.avg_kn)}</div><div class="lbl">Gemiddeld</div></div>
            <div class="stat-cell"><div class="val">${dist}</div><div class="lbl">Afstand</div></div>
            <div class="stat-cell"><div class="val">${s.duration_s != null ? fmtDuration(s.duration_s) : '—'}</div><div class="lbl">Duur</div></div>
          </div>
        </div>
        <div id="map"></div>
        <div class="legend">${
          Object.keys(CAT_COLORS)
            .filter(c => session.legs.some(l => String(l.category) === c))
            .map(c => `<span><span class="sw" style="background:${CAT_COLORS[c]}"></span>${CAT_LABELS[c]}</span>`)
            .join('')
        }</div>
        <div class="panel" id="wind-panel"></div>
        <div id="playback-section"></div>
        <div id="report-section"></div>
      `;
      renderMap();
      renderWindPanel();
      if (typeof renderPlayback === 'function') renderPlayback();   // Task 7
      if (typeof renderReport === 'function') renderReport();       // Task 8
    }

    function renderMap() {
      map = L.map('map');
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19,
      }).addTo(map);

      legLayers = [];
      const allCoords = [];
      for (const leg of session.legs) {
        const coords = [];
        for (let i = leg.startIdx; i <= leg.endIdx; i++) {
          coords.push([session.points[i].lat, session.points[i].lon]);
        }
        allCoords.push(...coords);
        const line = L.polyline(coords, {
          color: CAT_COLORS[String(leg.category)], weight: 4, opacity: 0.9,
        }).addTo(map);
        line.bindTooltip(
          `${CAT_LABELS[String(leg.category)]} · ${(leg.distance_m/1000).toFixed(2)} km · ` +
          `${leg.avg_speed_kn != null ? leg.avg_speed_kn.toFixed(1) + ' kn gem.' : ''}`
        );
        legLayers.push(line);
      }
      if (allCoords.length) map.fitBounds(L.latLngBounds(allCoords).pad(0.1));

      // Manoeuvre-markers
      for (const m of session.maneuvers) {
        const icon = L.divIcon({
          className: '',
          html: `<div style="font-size:16px;line-height:16px">${m.type === 'overstag' ? '⤴' : '⤵'}</div>`,
          iconSize: [16, 16],
        });
        const mk = L.marker([m.lat, m.lon], { icon }).addTo(map);
        mk.bindTooltip(
          `${m.type === 'overstag' ? 'Overstag' : 'Gijp'}` +
          (m.speed_loss_kn != null ? ` · −${m.speed_loss_kn.toFixed(1)} kn` : '') +
          (m.recovery_s != null ? ` · hersteld in ${m.recovery_s}s` : '')
        );
        mk.on('click', () => { if (typeof seekToIdx === 'function') seekToIdx(m.idx); }); // Task 7
      }
    }

    function renderWindPanel() {
      const panel = document.getElementById('wind-panel');
      const est = session.wind.estimated;
      const used = session.wind.used_deg;
      const isOverride = localStorage.getItem(windKey()) != null;

      const confLabel = { high: 'hoge betrouwbaarheid', low: 'lage betrouwbaarheid', none: '' }[est.confidence];
      let statusHtml;
      if (est.direction_deg != null) {
        statusHtml = `Geschat: <strong>${est.direction_deg}°</strong> <span class="muted">(${confLabel})</span>`;
      } else {
        statusHtml = `<span class="muted">Windrichting onbekend — geen kruispatroon gevonden. Stel handmatig in.</span>`;
      }

      panel.innerHTML = `
        <h4>Windrichting</h4>
        <div class="wind-row">
          <span class="wind-arrow" style="transform: rotate(${(used != null ? used : 0) + 180}deg)">↑</span>
          <span id="wind-value" style="font-family:var(--font-mono);font-weight:700;min-width:48px">${used != null ? used + '°' : '—'}</span>
          <input type="range" id="wind-slider" min="0" max="359" step="1" value="${used != null ? used : 0}" />
          <button class="btn btn-secondary btn-sm" id="wind-reset" ${!isOverride ? 'disabled' : ''}>Gebruik schatting</button>
        </div>
        <p class="muted" style="margin-top:8px">${statusHtml}${isOverride ? ' · handmatig aangepast' : ''}</p>
      `;

      const slider = document.getElementById('wind-slider');
      slider.addEventListener('change', () => setWindOverride(parseInt(slider.value, 10)));
      slider.addEventListener('input', () => {
        document.getElementById('wind-value').textContent = slider.value + '°';
      });
      document.getElementById('wind-reset').addEventListener('click', () => setWindOverride(null));
    }

    loadSession();
  </script>
</body>
</html>
```

- [ ] **Step 2: Controleer in de browser**

Start lokaal: `JWT_SECRET=test PORT=3199 node server.js` (achtergrond). Maak via de API een gebruiker en een testtrack met echt GPX-bestand — genereer die met de testhelper:

```bash
node -e "
const { makeTrack } = require('./test/helpers.js');
const segs = [];
for (let i = 0; i < 5; i++) {
  segs.push({ heading_deg: 315, seconds: 180, speed_kn: 5 });
  segs.push({ heading_deg: 45, seconds: 180, speed_kn: 5 });
}
segs.push({ heading_deg: 180, seconds: 300, speed_kn: 6.5 });
const pts = makeTrack(segs);
const trkpts = pts.map(p => '<trkpt lat=\"' + p.lat + '\" lon=\"' + p.lon + '\"><time>' + p.time + '</time></trkpt>').join('');
const gpx = '<?xml version=\"1.0\"?><gpx version=\"1.1\"><trk><name>Avondje IJsselmeer</name><trkseg>' + trkpts + '</trkseg></trk></gpx>';
require('fs').writeFileSync('/tmp/avondje.gpx', gpx);
console.log('GPX klaar:', pts.length, 'punten');
"
```

Upload via `POST /api/tracks` (multipart, veld `gpx`), open `http://127.0.0.1:3199/sessie.html?track=1` in de browser (ingelogd) en controleer:
- Kaart toont de zigzag met blauwe kruisrakken en een rood/oranje stuk zuidwaarts.
- Windpaneel toont een schatting van ~0° met hoge betrouwbaarheid.
- Schuif verzetten naar 90° → rakken herkleuren direct; "Gebruik schatting" herstelt.
- Herladen → de handmatige 90° blijft staan (localStorage).

- [ ] **Step 3: Commit**

```bash
git add web/sessie.html
git commit -m "feat: sessiepagina met rakkenkaart en windcorrectie

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Playback en snelheidsgrafiek

**Files:**
- Modify: `web/sessie.html`

**Interfaces:**
- Consumes: `session`, `map`, `#playback-section` uit Task 6.
- Produces: `renderPlayback()` (aangeroepen vanuit `renderAll`), `seekToIdx(pointIdx)`
  (gebruikt door manoeuvre-markers uit Task 6 en rapportkaartjes uit Task 8).

- [ ] **Step 1: Voeg playback en grafiek toe**

Voeg in `web/sessie.html` vóór `loadSession();` toe:

```js
    // ── Playback ──────────────────────────────────────────────────────────
    let playing = false, playT = 0, playSpeedX = 4, animId = null, lastTs = null;
    let boatMarker = null, trailLine = null;

    function sessionTimes() {
      const t0 = new Date(session.points[0].time).getTime();
      const t1 = new Date(session.points[session.points.length - 1].time).getTime();
      return { t0, dur: (t1 - t0) / 1000 };
    }

    function idxAtTime(sec) {
      const { t0 } = sessionTimes();
      const target = t0 + sec * 1000;
      let lo = 0, hi = session.points.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        (new Date(session.points[mid].time).getTime() < target) ? lo = mid + 1 : hi = mid;
      }
      return lo;
    }

    function renderPlayback() {
      const sec = document.getElementById('playback-section');
      if (!hasTimes()) {
        sec.innerHTML = '<div class="panel"><p class="muted">Deze track heeft geen tijdstempels — playback en snelheidsgrafiek zijn niet beschikbaar.</p></div>';
        return;
      }
      playing = false; playT = 0;
      sec.innerHTML = `
        <div class="panel">
          <h4>Playback</h4>
          <div class="wind-row">
            <button class="btn btn-secondary btn-sm" id="pb-play">▶</button>
            <span id="pb-time" style="font-family:var(--font-mono);min-width:52px">00:00</span>
            <input type="range" id="pb-slider" min="0" max="1000" value="0" />
            ${[1,4,10,30].map(x => `<button class="btn btn-secondary btn-sm pb-speed${x===playSpeedX?' active':''}" data-x="${x}">${x}×</button>`).join('')}
          </div>
          <canvas id="speed-chart" width="1000" height="140" style="width:100%;margin-top:12px"></canvas>
        </div>`;

      document.getElementById('pb-play').addEventListener('click', togglePlay);
      document.getElementById('pb-slider').addEventListener('input', (e) => {
        const { dur } = sessionTimes();
        playT = (e.target.value / 1000) * dur;
        updateBoat();
      });
      document.querySelectorAll('.pb-speed').forEach(b => b.addEventListener('click', () => {
        playSpeedX = parseInt(b.dataset.x, 10);
        document.querySelectorAll('.pb-speed').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
      }));
      document.getElementById('speed-chart').addEventListener('click', (e) => {
        const rect = e.target.getBoundingClientRect();
        const { dur } = sessionTimes();
        playT = ((e.clientX - rect.left) / rect.width) * dur;
        updateBoat();
      });
      drawSpeedChart();
      updateBoat();
    }

    function seekToIdx(idx) {
      if (!hasTimes()) return;
      const { t0 } = sessionTimes();
      playT = (new Date(session.points[idx].time).getTime() - t0) / 1000;
      playing = false;
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      const btn = document.getElementById('pb-play');
      if (btn) btn.textContent = '▶';
      updateBoat();
    }

    function togglePlay() {
      playing = !playing;
      document.getElementById('pb-play').textContent = playing ? '⏸' : '▶';
      if (playing) { lastTs = null; animId = requestAnimationFrame(tick); }
      else if (animId) { cancelAnimationFrame(animId); animId = null; }
    }

    function tick(ts) {
      if (!playing) return;
      if (lastTs != null) {
        playT += ((ts - lastTs) / 1000) * playSpeedX;
        const { dur } = sessionTimes();
        if (playT >= dur) { playT = dur; playing = false; document.getElementById('pb-play').textContent = '▶'; }
      }
      lastTs = ts;
      updateBoat();
      if (playing) animId = requestAnimationFrame(tick);
    }

    function updateBoat() {
      const { dur } = sessionTimes();
      const idx = idxAtTime(playT);
      const pt = session.points[idx];

      if (!boatMarker) {
        boatMarker = L.circleMarker([pt.lat, pt.lon], {
          radius: 7, color: '#0f172a', fillColor: '#fff', fillOpacity: 1, weight: 2,
        }).addTo(map);
      } else boatMarker.setLatLng([pt.lat, pt.lon]);

      const trail = session.points.slice(0, idx + 1).map(p => [p.lat, p.lon]);
      if (!trailLine) trailLine = L.polyline(trail, { color: '#0f172a', weight: 2, opacity: 0.6 }).addTo(map);
      else trailLine.setLatLngs(trail);

      const slider = document.getElementById('pb-slider');
      if (slider) slider.value = Math.round((playT / dur) * 1000);
      const disp = document.getElementById('pb-time');
      if (disp) disp.textContent = fmtDuration(Math.round(playT));
      drawSpeedChart(idx);
    }

    function drawSpeedChart(cursorIdx) {
      const canvas = document.getElementById('speed-chart');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const pts = session.points;
      const speeds = pts.map(p => p.speed_kn || 0);
      const maxS = Math.max(...speeds, 1);
      const { t0, dur } = sessionTimes();
      const x = (p) => ((new Date(p.time).getTime() - t0) / 1000 / dur) * W;
      const y = (s) => H - 8 - (s / maxS) * (H - 20);

      ctx.beginPath();
      let started = false;
      for (const p of pts) {
        if (!p.time || p.speed_kn == null) continue;
        started ? ctx.lineTo(x(p), y(p.speed_kn)) : (ctx.moveTo(x(p), y(p.speed_kn)), started = true);
      }
      ctx.strokeStyle = '#1d4ed8'; ctx.lineWidth = 1.5; ctx.stroke();

      // Manoeuvres als stippen
      for (const m of session.maneuvers) {
        const p = pts[m.idx];
        if (!p.time) continue;
        ctx.beginPath();
        ctx.arc(x(p), y(p.speed_kn || 0), 4, 0, Math.PI * 2);
        ctx.fillStyle = m.type === 'overstag' ? '#d97706' : '#dc2626';
        ctx.fill();
      }

      // Cursor
      if (cursorIdx != null && pts[cursorIdx] && pts[cursorIdx].time) {
        ctx.beginPath();
        ctx.moveTo(x(pts[cursorIdx]), 0); ctx.lineTo(x(pts[cursorIdx]), H);
        ctx.strokeStyle = 'rgba(100,116,139,0.6)'; ctx.lineWidth = 1; ctx.stroke();
      }
    }
```

En reset in `renderAll()` de playback-state (voeg direct ná `container.innerHTML = ...` toe, vóór `renderMap()`):

```js
      boatMarker = null; trailLine = null;
      if (animId) { cancelAnimationFrame(animId); animId = null; playing = false; }
```

- [ ] **Step 2: Controleer in de browser**

Zelfde testtrack als Task 6: playback afspelen op 10× — bootje volgt de zigzag; klik op een manoeuvre-marker op de kaart → cursor springt in grafiek en bootje naar dat punt; klik in de grafiek → zelfde effect; windschuif verzetten → playback blijft werken (state gereset).

- [ ] **Step 3: Commit**

```bash
git add web/sessie.html
git commit -m "feat: playback en snelheidsgrafiek op sessiepagina

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Avondrapport en randgevallen

**Files:**
- Modify: `web/sessie.html`

**Interfaces:**
- Consumes: `session.report`, `session.legs`, `seekToIdx` (Task 7), `#report-section` (Task 6).
- Produces: `renderReport()` (aangeroepen vanuit `renderAll`).

- [ ] **Step 1: Voeg het rapport toe**

Voeg in `web/sessie.html` vóór `loadSession();` toe:

```js
    // ── Avondrapport ──────────────────────────────────────────────────────
    function renderReport() {
      const sec = document.getElementById('report-section');
      const r = session.report;
      const legs = session.legs;

      // Randgeval: korte track → geen rapport
      const st = totalStats();
      if (session.points.length < 100 || (st.duration_s != null && st.duration_s < 300)) {
        sec.innerHTML = '<div class="panel"><p class="muted">Track te kort voor een rapport.</p></div>';
        return;
      }

      const cards = [];
      if (r.best_10s) {
        cards.push({ val: r.best_10s.avg_speed_kn.toFixed(1) + ' kn', lbl: 'Beste 10 seconden', idx: r.best_10s.start_idx });
      }
      if (r.longest_leg_idx != null) {
        const leg = legs[r.longest_leg_idx];
        cards.push({ val: (leg.distance_m / 1000).toFixed(2) + ' km', lbl: 'Langste rak', idx: leg.startIdx });
      }
      if (r.beat_angle_deg != null) {
        cards.push({ val: r.beat_angle_deg + '°', lbl: 'Opkruishoek' });
      }
      if (r.maneuvers.tacks + r.maneuvers.gybes > 0) {
        cards.push({
          val: `${r.maneuvers.tacks}× / ${r.maneuvers.gybes}×`,
          lbl: 'Overstag / gijp' + (r.maneuvers.avg_loss_kn != null ? ` · gem. −${r.maneuvers.avg_loss_kn.toFixed(1)} kn` : ''),
        });
      }

      const catOrder = ['aan-de-wind', 'halve-wind', 'ruime-wind', 'voor-de-wind'];
      const totalTime = catOrder.reduce((s, c) => s + (r.twa_distribution[c]?.time_s || 0), 0);
      const distBar = totalTime > 0 ? `
        <h4 style="margin-top:16px">Tijd per punt van zeil</h4>
        <div style="display:flex;height:18px;border-radius:9px;overflow:hidden">
          ${catOrder.filter(c => r.twa_distribution[c]).map(c => {
            const pct = (r.twa_distribution[c].time_s / totalTime) * 100;
            return `<div title="${CAT_LABELS[c]} ${Math.round(pct)}%" style="width:${pct}%;background:${CAT_COLORS[c]}"></div>`;
          }).join('')}
        </div>` : '';

      const legRows = legs.map((l, i) => `
        <tr style="cursor:pointer" onclick="seekToIdx(${l.startIdx})">
          <td>${i + 1}</td>
          <td><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:5px;background:${CAT_COLORS[String(l.category)]}"></span> ${CAT_LABELS[String(l.category)]}</td>
          <td style="text-align:right;font-family:var(--font-mono)">${l.avg_heading_deg != null ? l.avg_heading_deg + '°' : '—'}</td>
          <td style="text-align:right;font-family:var(--font-mono)">${(l.distance_m / 1000).toFixed(2)} km</td>
          <td style="text-align:right;font-family:var(--font-mono)">${l.duration_s != null ? fmtDuration(l.duration_s) : '—'}</td>
          <td style="text-align:right;font-family:var(--font-mono)">${l.avg_speed_kn != null ? l.avg_speed_kn.toFixed(1) : '—'}</td>
          <td style="text-align:right;font-family:var(--font-mono)">${l.max_speed_kn != null ? l.max_speed_kn.toFixed(1) : '—'}</td>
        </tr>`).join('');

      sec.innerHTML = `
        <div class="panel">
          <h4>Avondrapport</h4>
          ${session.wind.used_deg == null ? '<p class="muted" style="margin-bottom:10px">Zonder windrichting zijn opkruishoek, manoeuvres en punten van zeil niet beschikbaar — stel de wind hierboven handmatig in.</p>' : ''}
          <div class="stat-grid">
            ${cards.map(c => `
              <div class="stat-cell" ${c.idx != null ? `style="cursor:pointer" onclick="seekToIdx(${c.idx})"` : ''}>
                <div class="val">${c.val}</div><div class="lbl">${c.lbl}</div>
              </div>`).join('')}
          </div>
          ${distBar}
          <h4 style="margin-top:16px">Rakken</h4>
          <div style="overflow-x:auto">
            <table class="track-table" style="width:100%;font-size:13px;border-collapse:collapse">
              <thead><tr>
                <th style="text-align:left">#</th><th style="text-align:left">Punt van zeil</th>
                <th style="text-align:right">Koers</th><th style="text-align:right">Afstand</th>
                <th style="text-align:right">Duur</th><th style="text-align:right">Gem. kn</th>
                <th style="text-align:right">Max kn</th>
              </tr></thead>
              <tbody>${legRows}</tbody>
            </table>
          </div>
        </div>`;
    }
```

- [ ] **Step 2: Controleer de randgevallen in de browser**

1. Normale testtrack (Task 6): rapport toont beste 10 s (~6.5 kn, het zuidwaartse stuk), langste rak, opkruishoek ~90°, 9× overstag; klik op een rak-rij → playback springt ernaartoe.
2. Upload een GPX **zonder** `<time>`-elementen → pagina toont kaart + afstand, playbacksectie meldt "geen tijdstempels", geen crash.
3. Upload een korte track (< 5 min) → "Track te kort voor een rapport."
4. Upload een track met alleen één koers → windpaneel toont "Windrichting onbekend — stel handmatig in"; na handmatig instellen verschijnen categorieën.

- [ ] **Step 3: Commit**

```bash
git add web/sessie.html
git commit -m "feat: avondrapport met hoogtepunten, rakkentabel en randgevallen

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Integratie — links vanuit dashboard en wedstrijd, oude route opruimen

**Files:**
- Modify: `web/dashboard.html` (functie `openTrack`)
- Modify: `web/race.html` (redirect `?track=`, verwijder `loadSingleTrack`, "Analyse"-knop in bootlijst)

**Interfaces:**
- Consumes: `sessie.html?track=<id>` en `sessie.html?track=<id>&race=<raceId>` (Task 6).
- Produces: geen nieuwe interfaces; race.html doet hierna alleen nog wedstrijdweergave.

- [ ] **Step 1: Dashboard laat losse tracks naar de sessiepagina wijzen**

In `web/dashboard.html`:

```js
    function openTrack(id) {
      window.location.href = 'sessie.html?track=' + id;
    }
```

- [ ] **Step 2: race.html stuurt track-links door en verliest de kale trackweergave**

In `web/race.html`:

1. Direct na het bepalen van `trackId` (regel ~507) een redirect toevoegen:

```js
    // Losse tracks hebben een eigen analysepagina; oude ?id=-links blijven zo werken
    if (trackId) {
      window.location.replace('sessie.html?track=' + encodeURIComponent(trackId));
    }
```

2. In `loadRace()` de tak `if (trackId) { await loadSingleTrack(trackId, container); return; }` verwijderen (de redirect hierboven maakt hem onbereikbaar).
3. De volledige functie `loadSingleTrack` (regel ~1358–1449) verwijderen.

- [ ] **Step 3: "Analyse"-knop per boot in de bootlijst**

In `web/race.html`, in `renderBoatList`, in **beide** boat-item-templates (gegroepeerd én ungrouped) de stats-div uitbreiden met een knop. Vervang in beide templates:

```html
              <div class="boat-stats">
```

door:

```html
              <button class="btn-dl" style="padding:3px 7px;font-size:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--muted);cursor:pointer"
                onclick="event.stopPropagation();window.location.href='sessie.html?track=${t.id}&race=' + encodeURIComponent(raceId)"
                title="Sessie-analyse">📈</button>
              <div class="boat-stats">
```

- [ ] **Step 4: Volledige regressietest in de browser**

Met de lokale server en testdata:
1. Dashboard → klik track → sessie.html opent met analyse.
2. Oude link `race.html?track=1` → redirect naar `sessie.html?track=1`.
3. Wedstrijd openen via `race.html?race=…` → werkt als voorheen; 📈-knop bij een boot → `sessie.html?track=…&race=…` toont de analyse van die boot (ook als de track niet van jou is — via compare-data).
4. `npm test` → alle tests slagen.

- [ ] **Step 5: Commit**

```bash
git add web/dashboard.html web/race.html
git commit -m "feat: sessiepagina gekoppeld aan dashboard en wedstrijdweergave

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
