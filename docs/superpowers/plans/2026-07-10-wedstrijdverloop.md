# Live wedstrijdverloop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Live wedstrijdverloop op de vergelijk-pagina: ranglijst met achterstanden in meters langs het parcours, gap-grafiek, boeirondingen als tussentijden en live snelheid + VMG — voor de hele klasse tegelijk.

**Architecture:** Parcours-motor als pure functies in `web/session-analysis.js` (getest met `node:test`); één serverwijziging (compare-data limiet 4→20 met uitdunning via nieuw `lib/decimate.js`); `web/race-compare.html` krijgt een gedeelde tijdklok (bestaande sync-bug), ranglijstpaneel, gap-grafiek en rondingentabel. Boeien komen uit het bestaande `GET /api/races/:id/marks`.

**Tech Stack:** Vanilla JS, Leaflet 1.9.4, `node:test` (Node ≥ 22), bestaand `script.js`/`style.css`.

**Spec:** `docs/superpowers/specs/2026-07-10-wedstrijdverloop-design.md`

## Global Constraints

- Node ≥ 22; testrunner `npm test` = `node --test test/**/*.test.js` (glob — de directory-vorm is kapot op deze machine).
- Geen nieuwe npm-dependencies; geen databasewijzigingen.
- UI-teksten Nederlands; Nederlandse commentaren; `'use strict'` in modules.
- Exacte drempels uit de spec: rondingsdetectie **60 m**; uitdunning bij **> 6** tracks tot **max 2.000** punten (eerste en laatste punt blijven); compare-data limiet **1–20** track-ids; gap-bemonstering **5 s**; max **20** boten geselecteerd.
- `session-analysis.js` is UMD; nieuwe functies worden geëxporteerd in het bestaande return-object.
- Working directory voor alle commando's: `regatta-server/` (repo-root). Committen per taak, messages Nederlands met `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Server — compare-data naar 20 tracks met uitdunning

**Files:**
- Create: `lib/decimate.js`
- Create: `test/decimate.test.js`
- Modify: `routes/races.js` (compare-data handler, regel ~195-300)

**Interfaces:**
- Produces: `decimatePoints(points, maxPoints) → points` (zelfde array-elementen, uitgedund; eerste en laatste element altijd behouden; geen kopie van punt-objecten nodig). Wordt door `routes/races.js` gebruikt; geen andere consumenten.
- `POST /api/races/:id/compare-data` accepteert daarna 1–20 track-ids; bij > 6 ids wordt elke `points`-array uitgedund tot ≤ 2.000 punten. Responsvorm blijft verder identiek.

- [ ] **Step 1: Schrijf de falende tests**

Maak `test/decimate.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { decimatePoints } = require('../lib/decimate.js');

function makePoints(n) {
  return Array.from({ length: n }, (_, i) => ({ i }));
}

test('decimatePoints: korte array blijft ongewijzigd', () => {
  const pts = makePoints(500);
  const out = decimatePoints(pts, 2000);
  assert.strictEqual(out.length, 500);
  assert.strictEqual(out[0], pts[0]);
  assert.strictEqual(out[out.length - 1], pts[499]);
});

test('decimatePoints: lange array wordt uitgedund tot maximaal maxPoints', () => {
  const pts = makePoints(7200);
  const out = decimatePoints(pts, 2000);
  assert.ok(out.length <= 2000, `verwacht <= 2000, kreeg ${out.length}`);
  assert.ok(out.length >= 1800, `verwacht bijna 2000, kreeg ${out.length}`);
});

test('decimatePoints: eerste en laatste punt blijven behouden', () => {
  const pts = makePoints(10000);
  const out = decimatePoints(pts, 2000);
  assert.strictEqual(out[0], pts[0]);
  assert.strictEqual(out[out.length - 1], pts[9999]);
});

test('decimatePoints: volgorde blijft behouden', () => {
  const pts = makePoints(5000);
  const out = decimatePoints(pts, 1000);
  for (let k = 1; k < out.length; k++) {
    assert.ok(out[k].i > out[k - 1].i);
  }
});
```

- [ ] **Step 2: Run en zie falen**

Run: `npm test`
Expected: FAIL — `Cannot find module '../lib/decimate.js'` (bestaande 21 tests blijven groen)

- [ ] **Step 3: Implementeer de module**

Maak `lib/decimate.js`:

```js
// lib/decimate.js — puntenreeks uitdunnen met behoud van eerste en laatste punt
'use strict';

function decimatePoints(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const out = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let k = 0; k < maxPoints; k++) {
    out.push(points[Math.round(k * step)]);
  }
  // Afronding kan duplicaten geven; laatste punt is gegarandeerd door k = maxPoints-1
  return out.filter((p, i) => i === 0 || p !== out[i - 1]);
}

module.exports = { decimatePoints };
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS (25 tests)

- [ ] **Step 5: Wire in routes/races.js**

Bovenaan `routes/races.js` bij de requires toevoegen:

```js
const { decimatePoints } = require('../lib/decimate');
```

In de compare-data handler de limietcheck aanpassen. Huidige code:

```js
    if (!Array.isArray(track_ids) || track_ids.length === 0 || track_ids.length > 4) {
      return res.status(400).json({ error: 'track_ids moet een array zijn van 1–4 track IDs.' });
    }
```

wordt:

```js
    if (!Array.isArray(track_ids) || track_ids.length === 0 || track_ids.length > 20) {
      return res.status(400).json({ error: 'track_ids moet een array zijn van 1–20 track IDs.' });
    }
```

En vlak vóór `results.push({` (na `const smoothed = smoothPoints(points);`):

```js
        // Bij veel boten de payload beperken: uitdunnen is veilig voor de
        // rondingsdetectie (60 m-drempel, punt elke ~3-4 s)
        const finalPoints = track_ids.length > 6 ? decimatePoints(smoothed, 2000) : smoothed;
```

en in het gepushte object `points: smoothed,` vervangen door `points: finalPoints,`.

- [ ] **Step 6: Syntaxcheck + tests + limietcheck + commit**

Run: `node --check routes/races.js && npm test`
Expected: 25 tests PASS

API-limietcheck (validatie draait vóór de track-lookup, dus geen testdata nodig): start de server kort (`JWT_SECRET=test PORT=3199 node server.js`, achtergrond), registreer een gebruiker voor een token en:

```bash
curl -s -w " [%{http_code}]" -X POST http://127.0.0.1:3199/api/races/1/compare-data \
  -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d "{\"track_ids\": [$(seq -s, 1 21)]}"
```

Expected: `{"error":"track_ids moet een array zijn van 1–20 track IDs."} [400]`. Stop de server en verwijder `data/` daarna.

```bash
git add lib/decimate.js test/decimate.test.js routes/races.js
git commit -m "feat: compare-data tot 20 tracks met payload-uitdunning

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Parcours en VMG (courseFromMarks + computeVMG)

**Files:**
- Modify: `web/session-analysis.js`
- Create: `test/course-engine.test.js`

**Interfaces:**
- Consumes: bestaande `haversineM`, `bearing`, `angleDiff`, `toRad` uit de module.
- Produces (exact, gebruikt door Task 3/4/5):
  - `courseFromMarks(marks) → { marks, legs, cum_distance_m, total_distance_m } | null`
    - input `marks`: array `{ lat, lon, name?, sort_order? }` (vorm van `GET /api/races/:id/marks`); gesorteerd op `sort_order` (ontbrekend = 0), ongeldige lat/lon overgeslagen; < 2 geldige boeien → `null`.
    - `legs`: `[{ fromIdx, toIdx, distance_m }]`; `cum_distance_m[i]` = parcoursafstand t/m boei i (`cum_distance_m[0] === 0`); `total_distance_m` = som van alle rakken.
  - `computeVMG(speedKn, headingDeg, lat, lon, targetLat, targetLon) → number|null`
    - `speedKn × cos(hoek tussen koers en peiling naar doel)`; negatief bij wegvaren; `null` als speedKn of headingDeg null is.

- [ ] **Step 1: Schrijf de falende tests**

Maak `test/course-engine.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SA = require('../web/session-analysis.js');

// Drie boeien op een noord-zuid-lijn: elk ~1112 m uit elkaar (0.01 graad lat)
const MARKS = [
  { lat: 52.00, lon: 5.0, name: 'Start', sort_order: 0 },
  { lat: 52.01, lon: 5.0, name: 'Boei 1', sort_order: 1 },
  { lat: 52.02, lon: 5.0, name: 'Finish', sort_order: 2 },
];

test('courseFromMarks: bouwt rakken en cumulatieve afstanden', () => {
  const course = SA.courseFromMarks(MARKS);
  assert.ok(course);
  assert.strictEqual(course.marks.length, 3);
  assert.strictEqual(course.legs.length, 2);
  assert.strictEqual(course.cum_distance_m[0], 0);
  assert.ok(Math.abs(course.cum_distance_m[1] - 1112) < 15);
  assert.ok(Math.abs(course.total_distance_m - 2224) < 30);
});

test('courseFromMarks: sorteert op sort_order', () => {
  const shuffled = [MARKS[2], MARKS[0], MARKS[1]];
  const course = SA.courseFromMarks(shuffled);
  assert.strictEqual(course.marks[0].name, 'Start');
  assert.strictEqual(course.marks[2].name, 'Finish');
});

test('courseFromMarks: minder dan 2 geldige boeien geeft null', () => {
  assert.strictEqual(SA.courseFromMarks([MARKS[0]]), null);
  assert.strictEqual(SA.courseFromMarks([]), null);
  assert.strictEqual(SA.courseFromMarks([MARKS[0], { lat: NaN, lon: 5.0 }]), null);
});

test('computeVMG: recht op de boei af is volle snelheid, ervan af negatief', () => {
  // Doel pal noord van de boot; koers 0 = ernaartoe, koers 180 = ervan af
  const toward = SA.computeVMG(6, 0, 52.00, 5.0, 52.01, 5.0);
  const away = SA.computeVMG(6, 180, 52.00, 5.0, 52.01, 5.0);
  assert.ok(Math.abs(toward - 6) < 0.05, `verwacht ~6, kreeg ${toward}`);
  assert.ok(Math.abs(away + 6) < 0.05, `verwacht ~-6, kreeg ${away}`);
});

test('computeVMG: dwars op de boei is ~0; null-input geeft null', () => {
  const cross = SA.computeVMG(6, 90, 52.00, 5.0, 52.01, 5.0);
  assert.ok(Math.abs(cross) < 0.1, `verwacht ~0, kreeg ${cross}`);
  assert.strictEqual(SA.computeVMG(null, 0, 52, 5, 52.01, 5), null);
  assert.strictEqual(SA.computeVMG(6, null, 52, 5, 52.01, 5), null);
});
```

Run: `npm test`
Expected: FAIL — `SA.courseFromMarks is not a function` (25 bestaande tests groen)

- [ ] **Step 2: Implementeer beide functies**

In `web/session-analysis.js`, vóór de `return`-regel toevoegen (en beide namen aan het return-object toevoegen):

```js
  // ── Parcours-motor ─────────────────────────────────────────────────────

  // Bouw een parcours uit race-boeien (vorm van GET /api/races/:id/marks).
  // Minder dan 2 geldige boeien → null (geen parcours).
  function courseFromMarks(rawMarks) {
    const marks = (rawMarks || [])
      .filter(m => m && typeof m.lat === 'number' && typeof m.lon === 'number' &&
                   isFinite(m.lat) && isFinite(m.lon))
      .slice()
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    if (marks.length < 2) return null;

    const legs = [];
    const cum = [0];
    for (let i = 1; i < marks.length; i++) {
      const d = haversineM(marks[i - 1].lat, marks[i - 1].lon, marks[i].lat, marks[i].lon);
      legs.push({ fromIdx: i - 1, toIdx: i, distance_m: d });
      cum.push(cum[i - 1] + d);
    }
    return { marks, legs, cum_distance_m: cum, total_distance_m: cum[cum.length - 1] };
  }

  // Velocity made good richting een doel: snelheid × cos(koers − peiling).
  // Negatief wanneer de boot van het doel af vaart.
  function computeVMG(speedKn, headingDeg, lat, lon, targetLat, targetLon) {
    if (speedKn == null || headingDeg == null) return null;
    const brg = bearing(lat, lon, targetLat, targetLon);
    return speedKn * Math.cos(toRad(angleDiff(brg, headingDeg)));
  }
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS (30 tests)

- [ ] **Step 4: Commit**

```bash
git add web/session-analysis.js test/course-engine.test.js
git commit -m "feat: parcours uit boeien en VMG-berekening

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Voortgang en boeirondingen (computeProgress)

**Files:**
- Modify: `web/session-analysis.js`
- Modify: `test/course-engine.test.js`

**Interfaces:**
- Consumes: `courseFromMarks`-output (Task 2), `haversineM`, `makeTrack` uit `test/helpers.js`.
- Produces: `computeProgress(points, course) → { progress_m: number[], roundings: [{ markIdx, pointIdx, time: ISO|null }] }`
  - Ronding: binnen **60 m** van de eerstvolgende boei, alleen in parcoursvolgorde; een al geronde boei telt niet opnieuw.
  - `progress_m[i]` = parcoursafstand: `cum_distance_m[volgende boei] − afstand tot volgende boei`, monotoon niet-dalend geklemd; na de laatste boei constant `total_distance_m`. Vóór de eerste boei kan de waarde negatief zijn (afstand tot de startboei).

- [ ] **Step 1: Schrijf de falende tests**

Toevoegen aan `test/course-engine.test.js` (bovenaan naast de bestaande requires: `const { makeTrack } = require('./helpers.js');`):

```js
test('computeProgress: rondt drie boeien in volgorde en eindigt op totale afstand', () => {
  const course = SA.courseFromMarks(MARKS);
  // Recht noordwaarts vanaf de start, ~2.6 m/s (5 kn) → ~860 s over 2224 m
  const points = makeTrack([{ heading_deg: 0, seconds: 900, speed_kn: 5 }]);
  const { progress_m, roundings } = SA.computeProgress(points, course);

  assert.strictEqual(roundings.length, 3);
  assert.deepStrictEqual(roundings.map(r => r.markIdx), [0, 1, 2]);
  assert.ok(roundings.every(r => r.time));
  // Voortgang is monotoon niet-dalend
  for (let i = 1; i < progress_m.length; i++) {
    assert.ok(progress_m[i] >= progress_m[i - 1]);
  }
  // Na de finish blijft de voortgang op de totale parcoursafstand
  assert.ok(Math.abs(progress_m[progress_m.length - 1] - course.total_distance_m) < 1);
});

test('computeProgress: een boei die later opnieuw gepasseerd wordt telt niet dubbel', () => {
  const course = SA.courseFromMarks([MARKS[0], MARKS[1]]);
  // Heen (langs beide boeien), terug (weer langs boei 0), weer heen
  const points = makeTrack([
    { heading_deg: 0, seconds: 500, speed_kn: 5 },
    { heading_deg: 180, seconds: 500, speed_kn: 5 },
    { heading_deg: 0, seconds: 200, speed_kn: 5 },
  ]);
  const { roundings } = SA.computeProgress(points, course);
  assert.strictEqual(roundings.length, 2); // alleen boei 0 en boei 1, één keer
  assert.deepStrictEqual(roundings.map(r => r.markIdx), [0, 1]);
});

test('computeProgress: voortgang vóór de startboei is negatief en klimt', () => {
  const course = SA.courseFromMarks(MARKS);
  // Start 500 m zuid van de startboei, vaar ernaartoe
  const far = makeTrack([{ heading_deg: 0, seconds: 60, speed_kn: 5 }]);
  const offset = far.map(p => ({ ...p, lat: p.lat - 0.0045 })); // ~500 m zuidelijker
  const { progress_m } = SA.computeProgress(offset, course);
  assert.ok(progress_m[0] < -300, `verwacht < -300, kreeg ${progress_m[0]}`);
  assert.ok(progress_m[progress_m.length - 1] > progress_m[0]);
});
```

Run: `npm test`
Expected: FAIL — `SA.computeProgress is not a function`

- [ ] **Step 2: Implementeer computeProgress**

In `web/session-analysis.js` (exporteren in het return-object):

```js
  // Voortgang in meters langs het parcours + boeirondingen.
  // Ronding = binnen ROUNDING_RADIUS_M van de eerstvolgende boei (alleen in
  // parcoursvolgorde). Voortgang is monotoon niet-dalend geklemd.
  var ROUNDING_RADIUS_M = 60;

  function computeProgress(points, course) {
    const progress = [];
    const roundings = [];
    let next = 0;
    let clamped = null;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      // Meerdere boeien in één stap kunnen ronden (dicht bij elkaar / GPS-gat)
      while (next < course.marks.length &&
             haversineM(p.lat, p.lon, course.marks[next].lat, course.marks[next].lon) <= ROUNDING_RADIUS_M) {
        roundings.push({ markIdx: next, pointIdx: i, time: p.time || null });
        next++;
      }

      let raw;
      if (next >= course.marks.length) {
        raw = course.total_distance_m;
      } else {
        raw = course.cum_distance_m[next] -
              haversineM(p.lat, p.lon, course.marks[next].lat, course.marks[next].lon);
      }
      clamped = clamped == null ? raw : Math.max(clamped, raw);
      progress.push(clamped);
    }
    return { progress_m: progress, roundings };
  }
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS (33 tests)

- [ ] **Step 4: Commit**

```bash
git add web/session-analysis.js test/course-engine.test.js
git commit -m "feat: parcoursvoortgang en boeironding-detectie

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Gap-tijdreeks (gapSeries)

**Files:**
- Modify: `web/session-analysis.js`
- Modify: `test/course-engine.test.js`

**Interfaces:**
- Consumes: `computeProgress`-output per boot.
- Produces: `gapSeries(boats, stepS) → { start_ts, step_s, times, boats, leader_idx } | null`
  - input `boats`: `[{ id, points, progress_m }]` (points met ISO `time`; `progress_m` even lang als `points`).
  - Gedeelde tijdas over de **overlappende** periode: van `max(starttijden)` t/m `min(eindtijden)`, bemonsterd elke `stepS` seconden. Geen overlap of < 2 boten met tijden → `null`.
  - output: `times` = epoch-ms per sample; per boot `{ id, progress_m: number[], gap_m: number[] }` (lineair geïnterpoleerde voortgang per sample; `gap_m` = leidervoortgang − eigen voortgang, leider = 0); `leader_idx[s]` = index in `boats` van de leider per sample.

- [ ] **Step 1: Schrijf de falende tests**

Toevoegen aan `test/course-engine.test.js`:

```js
test('gapSeries: achterligger heeft constant gat, leider is altijd boot A', () => {
  const course = SA.courseFromMarks(MARKS);
  const ptsA = makeTrack([{ heading_deg: 0, seconds: 800, speed_kn: 5 }]);
  // Boot B: zelfde route, maar de eerste 60 s stilliggend op de startpositie
  const ptsB = makeTrack([
    { heading_deg: 0, seconds: 60, speed_kn: 0 },
    { heading_deg: 0, seconds: 740, speed_kn: 5 },
  ]);
  const progA = SA.computeProgress(ptsA, course).progress_m;
  const progB = SA.computeProgress(ptsB, course).progress_m;

  const gs = SA.gapSeries([
    { id: 1, points: ptsA, progress_m: progA },
    { id: 2, points: ptsB, progress_m: progB },
  ], 5);

  assert.ok(gs);
  assert.strictEqual(gs.step_s, 5);
  assert.strictEqual(gs.boats.length, 2);
  assert.strictEqual(gs.times.length, gs.leader_idx.length);

  // Halverwege: A leidt, B's achterstand ≈ 60 s × 2.57 m/s ≈ 154 m
  const mid = Math.floor(gs.times.length / 2);
  assert.strictEqual(gs.leader_idx[mid], 0);
  assert.strictEqual(gs.boats[0].gap_m[mid], 0);
  assert.ok(Math.abs(gs.boats[1].gap_m[mid] - 154) < 40,
    `verwacht ~154 m, kreeg ${gs.boats[1].gap_m[mid]}`);
});

test('gapSeries: zonder overlap of zonder tijden geeft null', () => {
  const a = { id: 1, points: [{ lat: 52, lon: 5, time: '2026-07-01T18:00:00Z' }, { lat: 52, lon: 5, time: '2026-07-01T18:01:00Z' }], progress_m: [0, 10] };
  const b = { id: 2, points: [{ lat: 52, lon: 5, time: '2026-07-01T19:00:00Z' }, { lat: 52, lon: 5, time: '2026-07-01T19:01:00Z' }], progress_m: [0, 10] };
  assert.strictEqual(SA.gapSeries([a, b], 5), null);
  const noTime = { id: 3, points: [{ lat: 52, lon: 5 }, { lat: 52, lon: 5 }], progress_m: [0, 10] };
  assert.strictEqual(SA.gapSeries([a, noTime], 5), null);
});
```

Run: `npm test`
Expected: FAIL — `SA.gapSeries is not a function`

- [ ] **Step 2: Implementeer gapSeries**

In `web/session-analysis.js` (exporteren):

```js
  // Lineair geïnterpoleerde voortgang van één boot op een absoluut tijdstip (ms)
  function progressAt(points, progress, ts) {
    if (ts <= new Date(points[0].time).getTime()) return progress[0];
    const lastTs = new Date(points[points.length - 1].time).getTime();
    if (ts >= lastTs) return progress[progress.length - 1];
    for (let i = 0; i < points.length - 1; i++) {
      const t0 = new Date(points[i].time).getTime();
      const t1 = new Date(points[i + 1].time).getTime();
      if (ts >= t0 && ts <= t1) {
        const f = t1 > t0 ? (ts - t0) / (t1 - t0) : 0;
        return progress[i] + (progress[i + 1] - progress[i]) * f;
      }
    }
    return progress[progress.length - 1];
  }

  // Gedeelde gap-tijdreeks over de overlappende periode van alle boten.
  function gapSeries(boats, stepS) {
    const valid = (boats || []).filter(b =>
      b.points && b.points.length >= 2 && b.points[0].time &&
      b.progress_m && b.progress_m.length === b.points.length);
    if (valid.length < 2 || valid.length !== (boats || []).length) return null;

    const starts = valid.map(b => new Date(b.points[0].time).getTime());
    const ends = valid.map(b => new Date(b.points[b.points.length - 1].time).getTime());
    const t0 = Math.max.apply(null, starts);
    const t1 = Math.min.apply(null, ends);
    if (t1 <= t0) return null;

    const times = [];
    for (let ts = t0; ts <= t1; ts += stepS * 1000) times.push(ts);

    const out = valid.map(b => ({ id: b.id, progress_m: [], gap_m: [] }));
    const leaderIdx = [];

    for (const ts of times) {
      let best = -Infinity, bestI = 0;
      const vals = valid.map((b, i) => {
        const v = progressAt(b.points, b.progress_m, ts);
        if (v > best) { best = v; bestI = i; }
        return v;
      });
      leaderIdx.push(bestI);
      vals.forEach((v, i) => {
        out[i].progress_m.push(Math.round(v));
        out[i].gap_m.push(Math.round(best - v));
      });
    }
    return { start_ts: t0, step_s: stepS, times, boats: out, leader_idx: leaderIdx };
  }
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS (35 tests)

- [ ] **Step 4: Commit**

```bash
git add web/session-analysis.js test/course-engine.test.js
git commit -m "feat: gap-tijdreeks over gedeelde tijdas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Vergelijk-pagina — gedeelde klok, hele klasse, boeien op kaart, live ranglijst

**Files:**
- Modify: `web/race-compare.html`

**Interfaces:**
- Consumes: `SessionAnalysis.courseFromMarks/computeProgress/computeVMG/gapSeries` (Task 2–4); `GET /api/races/:id/marks`; verhoogde compare-data-limiet (Task 1).
- Produces (gebruikt door Task 6): globale state `raceStartTs` (epoch ms van de vroegste track), `course` (courseFromMarks-resultaat of null), `marks` (ruwe boeienlijst), `gapData` (gapSeries-resultaat of null), per compare-data-item `cd._progress` (computeProgress-resultaat of null); functie `renderLeaderboard()` (live), container `#leaderboard-section` in de renderCompare-HTML; functie `sampleIdxAt(currentTime)`.

- [ ] **Step 1: Module laden en state toevoegen**

In `web/race-compare.html` na `<script src="script.js"></script>`:

```html
  <script src="session-analysis.js"></script>
```

Bij de state-declaraties (na `let currentClass = null;`):

```js
    let raceStartTs = null;   // gedeelde klok: epoch ms van de vroegste track
    let marks = [];           // ruwe boeien van GET /races/:id/marks
    let course = null;        // courseFromMarks-resultaat of null
    let gapData = null;       // gapSeries-resultaat of null
    let markLayers = [];      // Leaflet-lagen van boeien + parcourslijn
```

- [ ] **Step 2: Hele klasse standaard geselecteerd (max 20)**

In `applyClassFilter()` de regel `selectedBoatIdx = [0, Math.min(1, tracks.length - 1)];` vervangen door:

```js
      // Standaard de hele klasse (tot 20 boten)
      selectedBoatIdx = tracks.slice(0, 20).map((_, i) => i);
```

En de drempel `if (tracks.length < 2) return false;` blijft staan.

In `toggleBoat(idx)`: `if (selectedBoatIdx.length >= 4) return;` wordt `if (selectedBoatIdx.length >= 20) return;`.

- [ ] **Step 3: Boeien laden in loadCompare**

In `loadCompare()`, direct na het ophalen van `raceTracks`:

```js
        marks = await apiGet('/races/' + raceId + '/marks') || [];
        course = SessionAnalysis.courseFromMarks(marks);
```

- [ ] **Step 4: Gedeelde klok + voortgang in fetchCompareData**

De bestaande timeline-berekening in `fetchCompareData()` wordt uitgebreid. Na de bestaande `totalDuration`-berekening (de `minT`/`maxT`-lus blijft), toevoegen:

```js
      raceStartTs = isFinite(minT) ? minT : null;

      // Parcoursvoortgang + gap-tijdreeks (alleen met parcours en tijden)
      gapData = null;
      if (course) {
        for (const cd of compareData) {
          cd._progress = (cd.points.length >= 2 && cd.points[0].time)
            ? SessionAnalysis.computeProgress(cd.points, course) : null;
        }
        // Boten zonder tijden doen niet mee aan de gap-reeks
        const boats = compareData
          .filter(cd => cd._progress)
          .map(cd => ({ id: cd.id, points: cd.points, progress_m: cd._progress.progress_m }));
        if (boats.length >= 2) gapData = SessionAnalysis.gapSeries(boats, 5);
      }
```

**Gedeelde-klok-fix** (bestaande sync-bug: elke boot speelde af vanaf zijn éígen eerste punt):

In `interpolatePosition(cd, relTime)` de regel `const startTs = new Date(cd.points[0].time).getTime();` vervangen door:

```js
      const startTs = raceStartTs != null ? raceStartTs : new Date(cd.points[0].time).getTime();
```

en de twee randgevallen aanpassen: `if (relTime <= 0)` wordt

```js
      const firstTs = new Date(cd.points[0].time).getTime();
      const lastTs = new Date(cd.points[cd.points.length - 1].time).getTime();
      if (targetTs <= firstTs) {
        return { lat: cd.points[0].lat, lng: cd.points[0].lon, heading: cd.points[0]._hdg || null, spd: cd.points[0].speed_kn || 0 };
      }
      if (targetTs >= lastTs) {
        const last = cd.points[cd.points.length - 1];
        return { lat: last.lat, lng: last.lon, heading: last._hdg || null, spd: last.speed_kn || 0 };
      }
```

(verplaats daartoe `const targetTs = startTs + relTime * 1000;` naar bóven deze checks en verwijder de oude `trackDuration`-variabele en de oude twee if-blokken).

In `updateTrails()` de regel `const startTs = new Date(cd.points[0].time).getTime();` vervangen door:

```js
        const startTs = raceStartTs != null ? raceStartTs : new Date(cd.points[0].time).getTime();
```

In `drawCompareChart()` de regel `const startTs = new Date(cd.points[0].time).getTime();` (in de series-lus) idem vervangen.

Tot slot de pre-existente fullscreen-bug meenemen (leest `pos.speed`, maar interpolatePosition levert `pos.spd`): in `updateFsTime` beide voorkomens van `pos.speed` vervangen door `pos.spd`.

- [ ] **Step 5: Boeien en parcourslijn op de kaart**

Nieuwe functie (bij de MAP-sectie) + aanroep. In `drawAllTracks()`, direct na `clearAllLayers();` toevoegen: `drawCourseMarks();`. In `clearAllLayers()` toevoegen:

```js
      markLayers.forEach(l => { try { map.removeLayer(l); } catch (_) {} });
      markLayers = [];
```

En de functie zelf:

```js
    function drawCourseMarks() {
      if (!map || !course) return;
      // Gestippelde parcourslijn
      const line = L.polyline(course.marks.map(m => [m.lat, m.lon]), {
        color: '#64748b', weight: 1.5, opacity: 0.6, dashArray: '6 6',
      }).addTo(map);
      markLayers.push(line);
      // Genummerde boeien
      course.marks.forEach((m, i) => {
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:18px;height:18px;border-radius:50%;background:#f59e0b;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</div>`,
          iconSize: [18, 18], iconAnchor: [9, 9],
        });
        const mk = L.marker([m.lat, m.lon], { icon, zIndexOffset: -100 }).addTo(map);
        mk.bindTooltip(escHtml(m.name || 'Boei ' + (i + 1)));
        markLayers.push(mk);
      });
    }
```

- [ ] **Step 6: Live ranglijst**

In de `renderCompare()`-template, tussen `</div>` van de map-section en `<div class="compare-grid"...`:

```html
        <div class="chart-section" id="leaderboard-section"></div>
```

Nieuwe functies (na `updateLegend`):

```js
    // Sample-index in gapData voor een playback-tijdstip
    function sampleIdxAt(relTime) {
      if (!gapData || raceStartTs == null) return -1;
      const ts = raceStartTs + relTime * 1000;
      const idx = Math.round((ts - gapData.start_ts) / (gapData.step_s * 1000));
      return Math.max(0, Math.min(gapData.times.length - 1, idx));
    }

    // Volgende boei van een boot op een absoluut tijdstip (uit de rondingen)
    function nextMarkIdxAt(cd, ts) {
      if (!cd._progress || !course) return null;
      let n = 0;
      for (const r of cd._progress.roundings) {
        if (r.time && new Date(r.time).getTime() <= ts) n = r.markIdx + 1;
      }
      return n < course.marks.length ? n : null;
    }

    function renderLeaderboard() {
      const sec = document.getElementById('leaderboard-section');
      if (!sec) return;

      if (!course) {
        sec.innerHTML = `<div class="chart-header"><h4>Wedstrijdverloop</h4></div>
          <p style="font-size:13px;color:var(--muted);padding:8px 0">Geen parcours ingetekend — vraag de wedstrijdleiding boeien toe te voegen via het beheerpaneel.</p>`;
        return;
      }
      if (!gapData) {
        sec.innerHTML = `<div class="chart-header"><h4>Wedstrijdverloop</h4></div>
          <p style="font-size:13px;color:var(--muted);padding:8px 0">Te weinig boten met tijdstempels voor een ranglijst.</p>`;
        return;
      }

      const s = sampleIdxAt(currentTime);
      const ts = raceStartTs + currentTime * 1000;

      // Rijen opbouwen: per gapData-boot de bijbehorende track + livewaarden
      const rows = gapData.boats.map((gb, i) => {
        const cd = compareData.find(d => d.id === gb.id);
        const trackIdx = tracks.findIndex(t => t.id === gb.id);
        const pos = cd ? interpolatePosition(cd, currentTime) : null;
        const nm = cd ? nextMarkIdxAt(cd, ts) : null;
        let vmg = null;
        if (pos && nm != null) {
          vmg = SessionAnalysis.computeVMG(pos.spd, pos.heading, pos.lat, pos.lng,
            course.marks[nm].lat, course.marks[nm].lon);
        }
        return {
          id: gb.id, trackIdx,
          name: tracks[trackIdx]?.boat_name || tracks[trackIdx]?.name || 'Boot',
          color: BOAT_COLORS[trackIdx % BOAT_COLORS.length],
          gap: gb.gap_m[s], progress: gb.progress_m[s],
          spd: pos ? pos.spd : null, vmg,
        };
      }).sort((a, b) => a.gap - b.gap);

      sec.innerHTML = `
        <div class="chart-header"><h4>Live ranglijst</h4></div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)">
            <th style="text-align:left;padding:4px 8px">#</th>
            <th style="text-align:left;padding:4px 8px">Boot</th>
            <th style="text-align:right;padding:4px 8px">Achterstand</th>
            <th style="text-align:right;padding:4px 8px">Snelheid</th>
            <th style="text-align:right;padding:4px 8px">VMG</th>
          </tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr style="border-top:1px solid var(--border);cursor:pointer" onclick="focusBoat(${r.trackIdx})">
                <td style="padding:6px 8px;font-family:var(--font-mono);font-weight:700">${i + 1}</td>
                <td style="padding:6px 8px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${r.color};margin-right:6px"></span>${escHtml(r.name)}</td>
                <td style="padding:6px 8px;text-align:right;font-family:var(--font-mono)">${i === 0 ? 'leider' : '+' + r.gap + ' m'}</td>
                <td style="padding:6px 8px;text-align:right;font-family:var(--font-mono)">${r.spd != null ? r.spd.toFixed(1) + ' kn' : '—'}</td>
                <td style="padding:6px 8px;text-align:right;font-family:var(--font-mono)">${r.vmg != null ? r.vmg.toFixed(1) + ' kn' : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }

    // Boot uitlichten vanaf een ranglijst-rij
    function focusBoat(trackIdx) {
      const cd = compareData.find(d => d.id === tracks[trackIdx]?.id);
      if (!cd || !map) return;
      const pos = interpolatePosition(cd, currentTime);
      if (pos) map.panTo([pos.lat, pos.lng]);
      const mi = selectedBoatIdx.indexOf(trackIdx);
      if (mi >= 0 && boatMarkers[mi]) boatMarkers[mi].openTooltip();
    }
```

Aanroepen toevoegen: in `renderCompare()` na `drawCompareChart();` → `renderLeaderboard();`. In `animLoop()` en `seekTimeline()` na `drawCompareChart();` → `renderLeaderboard();`.

- [ ] **Step 7: Browserverificatie**

Lokale server (`JWT_SECRET=test PORT=3199 node server.js`), admin-gebruiker, race met `race_date`, **3 boeien** via `POST /api/races/1/marks` (noord-zuid-lijn zoals in de tests), en **3 synthetische boten** (makeTrack: recht noordwaarts, met 0/60/120 s stilligtijd vooraf) geüpload en aan de race gekoppeld. Open `race-compare.html?race=1` en controleer:
- Alle 3 boten standaard geselecteerd; boeien 1-2-3 en stippellijn op de kaart.
- Ranglijst toont 3 rijen; tijdens playback blijft boot zonder wachttijd leider; gaps groeien niet (constant tempo-verschil ≈ vast gat).
- VMG ≈ snelheid (recht op de boei af); klik op rij pant de kaart.
- Race zonder boeien (tweede race): melding "Geen parcours ingetekend…", rest werkt.
- `npm test` blijft 35/35. Cleanup: server stoppen, `rm -rf data`.

- [ ] **Step 8: Commit**

```bash
git add web/race-compare.html
git commit -m "feat: hele klasse, gedeelde klok, boeien op kaart en live ranglijst

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Gap-grafiek, rondingentabel en randgevallen

**Files:**
- Modify: `web/race-compare.html`

**Interfaces:**
- Consumes: `gapData`, `course`, `raceStartTs`, `compareData[]._progress`, `sampleIdxAt`, `seekTimeline` (Task 5), `drawCompareChart`-patroon (dpr-scaling).
- Produces: `drawGapChart()` en `renderRoundingsTable()`, aangeroepen vanuit `renderCompare`/`animLoop`/`seekTimeline`.

- [ ] **Step 1: Secties in de renderCompare-template**

Na de bestaande chart-section (`<canvas id="compare-chart"></canvas>` + sluitende div) toevoegen:

```html
        <div class="chart-section" id="gap-section" style="display:none">
          <div class="chart-header"><h4>Achterstand op de leider (meters)</h4></div>
          <canvas id="gap-chart"></canvas>
        </div>
        <div class="chart-section" id="roundings-section" style="display:none">
          <div class="chart-header"><h4>Boeirondingen</h4></div>
          <div id="roundings-table" style="overflow-x:auto"></div>
        </div>
```

- [ ] **Step 2: Gap-grafiek**

Nieuwe functie na `drawCompareChart()` (zelfde canvas-patroon: dpr-scaling, grid, cursor):

```js
    function drawGapChart() {
      const section = document.getElementById('gap-section');
      const canvas = document.getElementById('gap-chart');
      if (!canvas || !section) return;
      if (!gapData) { section.style.display = 'none'; return; }
      section.style.display = '';

      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.parentElement.getBoundingClientRect();
      const w = rect.width - 40, h = 220;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.scale(dpr, dpr);

      const padding = { top: 16, bottom: 28, left: 52, right: 16 };
      const chartW = w - padding.left - padding.right;
      const chartH = h - padding.top - padding.bottom;

      let maxGap = 50;
      for (const b of gapData.boats) for (const g of b.gap_m) if (g > maxGap) maxGap = g;
      const niceMax = Math.ceil(maxGap / 50) * 50;

      // 0 (leider) bovenaan; achterstand groeit omlaag
      const xT = ts => padding.left + ((ts - raceStartTs) / 1000 / totalDuration) * chartW;
      const yG = g => padding.top + (g / niceMax) * chartH;

      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(71,85,105,0.2)'; ctx.lineWidth = 1;
      ctx.fillStyle = 'rgba(71,85,105,0.5)';
      ctx.font = '10px "JetBrains Mono", monospace'; ctx.textAlign = 'right';
      const ySteps = 4;
      for (let k = 0; k <= ySteps; k++) {
        const g = (k / ySteps) * niceMax;
        const y = yG(g);
        ctx.beginPath(); ctx.moveTo(padding.left, y); ctx.lineTo(w - padding.right, y); ctx.stroke();
        ctx.fillText(Math.round(g) + ' m', padding.left - 6, y + 3);
      }

      // Rondingstreepjes: eerste ronder per boei (verticale stippellijn + nummer)
      if (course) {
        ctx.textAlign = 'center';
        course.marks.forEach((m, mi) => {
          let firstTs = null;
          for (const cd of compareData) {
            const r = cd._progress?.roundings.find(r => r.markIdx === mi && r.time);
            if (r) {
              const ts = new Date(r.time).getTime();
              if (firstTs == null || ts < firstTs) firstTs = ts;
            }
          }
          if (firstTs != null) {
            const x = xT(firstTs);
            ctx.beginPath(); ctx.setLineDash([3, 4]);
            ctx.moveTo(x, padding.top); ctx.lineTo(x, padding.top + chartH);
            ctx.strokeStyle = 'rgba(245,158,11,0.7)'; ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(245,158,11,0.9)';
            ctx.fillText(String(mi + 1), x, padding.top - 4);
            ctx.fillStyle = 'rgba(71,85,105,0.5)';
          }
        });
      }

      // Gap-lijnen per boot
      gapData.boats.forEach(gb => {
        const trackIdx = tracks.findIndex(t => t.id === gb.id);
        ctx.beginPath();
        gapData.times.forEach((ts, si) => {
          const x = xT(ts), y = yG(gb.gap_m[si]);
          si === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.strokeStyle = BOAT_COLORS[trackIdx % BOAT_COLORS.length];
        ctx.lineWidth = 2; ctx.stroke();
      });

      // Cursor
      const cx = padding.left + (currentTime / totalDuration) * chartW;
      ctx.beginPath(); ctx.setLineDash([4, 4]);
      ctx.moveTo(cx, padding.top); ctx.lineTo(cx, padding.top + chartH);
      ctx.strokeStyle = 'rgba(71,85,105,0.6)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.setLineDash([]);
    }
```

Klik-om-te-springen: één listener na de bestaande `window.addEventListener('resize', ...)`-registratie:

```js
    document.addEventListener('click', (e) => {
      if (e.target.id !== 'gap-chart') return;
      const rect = e.target.getBoundingClientRect();
      const frac = (e.clientX - rect.left - 52) / (rect.width - 52 - 16);
      seekTimeline(Math.max(0, Math.min(1, frac)) * 1000);
    });
```

- [ ] **Step 3: Rondingentabel**

```js
    function renderRoundingsTable() {
      const section = document.getElementById('roundings-section');
      const holder = document.getElementById('roundings-table');
      if (!section || !holder) return;
      if (!course || !gapData) { section.style.display = 'none'; return; }

      // Per boei: boten in rondingsvolgorde met kloktijd en gap-bij-ronding
      const rows = course.marks.map((m, mi) => {
        const passes = [];
        for (const cd of compareData) {
          const r = cd._progress?.roundings.find(r => r.markIdx === mi && r.time);
          const trackIdx = tracks.findIndex(t => t.id === cd.id);
          if (r) passes.push({ cd, trackIdx, ts: new Date(r.time).getTime() });
        }
        passes.sort((a, b) => a.ts - b.ts);
        return { m, mi, passes };
      }).filter(r => r.passes.length > 0);

      if (!rows.length) { section.style.display = 'none'; return; }
      section.style.display = '';

      holder.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap">
          <tbody>
            ${rows.map(({ m, mi, passes }) => `
              <tr style="border-top:1px solid var(--border)">
                <td style="padding:6px 8px;font-weight:600">${mi + 1}. ${escHtml(m.name || 'Boei ' + (mi + 1))}</td>
                ${passes.map((p, pi) => {
                  const relS = (p.ts - raceStartTs) / 1000;
                  const gapAtRounding = pi === 0 ? 'eerste'
                    : '+' + Math.round((p.ts - passes[0].ts) / 1000) + ' s';
                  const name = tracks[p.trackIdx]?.boat_name || tracks[p.trackIdx]?.name || 'Boot';
                  const color = BOAT_COLORS[p.trackIdx % BOAT_COLORS.length];
                  return `<td style="padding:6px 8px;cursor:pointer" onclick="seekTimeline(${Math.round((relS / totalDuration) * 1000)})">
                    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:4px"></span>
                    ${escHtml(name)} <span style="color:var(--muted);font-family:var(--font-mono)">${fmtDuration(relS)} · ${gapAtRounding}</span>
                  </td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
```

Let op: de rondingentabel toont het verschil t.o.v. de eerste ronder in **seconden** (kloktijdverschil bij het passeren) — dat is bij een ronding informatiever dan meters en volgt direct uit de rondingstijden.

- [ ] **Step 4: Aanroepen + randgevallen**

- In `renderCompare()` na `renderLeaderboard();` toevoegen: `drawGapChart(); renderRoundingsTable();`
- In `animLoop()` en `seekTimeline()` na `renderLeaderboard();` toevoegen: `drawGapChart();` (de tabel hoeft niet per frame; alleen in renderCompare).
- In de resize-listener (`window.addEventListener('resize', ...)`) na `drawCompareChart();` toevoegen: `drawGapChart();`
- **Boot zonder tijdstempels**: in `renderCompare()` in de chip-template een waarschuwing tonen. Vervang de chip-inhoud door:

```js
              <div class="track-chip ${selected ? 'selected' : ''}" data-idx="${i}" onclick="toggleBoat(${i})">
                <span class="chip-dot" style="background:${BOAT_COLORS[i % BOAT_COLORS.length]}"></span>
                ${escHtml(t.name || t.filename || 'Boot ' + (i+1))}${(() => {
                  const cd = compareData.find(d => d.id === t.id);
                  return cd && (!cd.points.length || !cd.points[0].time) ? ' ⚠' : '';
                })()}
              </div>
```

- **Meer dan 20 boten**: in `renderCompare()` boven de track-selector, na de classSwitcher-variabele:

```js
      const capNote = tracks.length > 20
        ? `<p style="font-size:12px;color:var(--muted);margin-bottom:8px">Deze klasse heeft ${tracks.length} boten; de eerste 20 zijn geselecteerd.</p>` : '';
```

en `${capNote}` direct na `${classSwitcher}` in de template.

- [ ] **Step 5: Browserverificatie**

Zelfde opzet als Task 5 (3 boeien, 3 boten met 0/60/120 s vertraging), plus:
- Gap-grafiek zichtbaar met 3 lijnen; leider vlak op 0; verticale oranje streepjes met boeinummers 1-2-3.
- Klik in de gap-grafiek springt de playback (cursorlijn en boten volgen).
- Rondingentabel: 3 rijen; per rij de snelste boot eerst met "eerste", daarna "+~60 s" en "+~120 s"; klik op een cel springt naar dat moment.
- Vierde boot met GPX zonder `<time>` uploaden en koppelen → chip toont ⚠, ranglijst en grafiek blijven werken met de overige drie.
- `npm test` blijft 35/35. Cleanup: server stoppen, `rm -rf data`.

- [ ] **Step 6: Commit**

```bash
git add web/race-compare.html
git commit -m "feat: gap-grafiek en rondingentabel op de vergelijk-pagina

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
