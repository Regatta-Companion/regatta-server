'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SA = require('../web/session-analysis.js');
const { makeTrack } = require('./helpers.js');

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

test('gapSeries: disjuncte vensters spannen de unie; zonder tijden geeft null', () => {
  // A vaart 18:00–18:01, B pas 19:00–19:01 — geen overlap, maar wel een
  // geldige unie: het venster loopt van 18:00 tot 19:01.
  const a = { id: 1, points: [{ lat: 52, lon: 5, time: '2026-07-01T18:00:00Z' }, { lat: 52, lon: 5, time: '2026-07-01T18:01:00Z' }], progress_m: [0, 10] };
  const b = { id: 2, points: [{ lat: 52, lon: 5, time: '2026-07-01T19:00:00Z' }, { lat: 52, lon: 5, time: '2026-07-01T19:01:00Z' }], progress_m: [0, 20] };
  const gs = SA.gapSeries([a, b], 5);
  assert.ok(gs !== null);
  assert.strictEqual(gs.start_ts, new Date('2026-07-01T18:00:00Z').getTime());
  assert.strictEqual(gs.times[gs.times.length - 1], new Date('2026-07-01T19:01:00Z').getTime());

  const boatA = gs.boats.find(bo => bo.id === 1);
  const boatB = gs.boats.find(bo => bo.id === 2);
  // A ligt buiten haar eigen venster vanaf 18:01 → geklemd op haar laatste voortgang (10)
  assert.strictEqual(boatA.progress_m[boatA.progress_m.length - 1], 10);
  // B ligt vóór haar eigen venster (nog geen tijd verstreken) → geklemd op haar eerste voortgang (0)
  assert.strictEqual(boatB.progress_m[0], 0);

  const noTime = { id: 3, points: [{ lat: 52, lon: 5 }, { lat: 52, lon: 5 }], progress_m: [0, 10] };
  assert.strictEqual(SA.gapSeries([a, noTime], 5), null);
});

test('gapSeries: uitvaller bevriest de vloot niet — venster loopt door tot de langste track', () => {
  const course = SA.courseFromMarks(MARKS);
  const ptsA = makeTrack([{ heading_deg: 0, seconds: 800, speed_kn: 5 }]);
  // Boot B: identieke koers, maar de tracker valt uit na de eerste 300 s
  const ptsB = makeTrack([{ heading_deg: 0, seconds: 800, speed_kn: 5 }]).slice(0, 300);
  const progA = SA.computeProgress(ptsA, course).progress_m;
  const progB = SA.computeProgress(ptsB, course).progress_m;

  const gs = SA.gapSeries([
    { id: 1, points: ptsA, progress_m: progA },
    { id: 2, points: ptsB, progress_m: progB },
  ], 5);

  assert.ok(gs);
  // Venster spant de unie: ~800 s / 5 s-stappen ≈ 161 samples
  assert.ok(Math.abs(gs.times.length - (800 / 5 + 1)) <= 1,
    `verwacht ~${800 / 5 + 1} samples, kreeg ${gs.times.length}`);

  const boatB = gs.boats.find(b => b.id === 2);
  // B's gat blijft toenemen ná 300 s (haar progressie is geklemd, A vaart door)
  const idxAt300 = Math.round(300 / 5);
  const gapAt300 = boatB.gap_m[idxAt300];
  const gapAtEnd = boatB.gap_m[boatB.gap_m.length - 1];
  assert.ok(gapAtEnd > gapAt300, `verwacht gat groter dan bij 300s (${gapAt300}), kreeg ${gapAtEnd}`);

  // A blijft leider (index 0) gedurende de hele reeks
  assert.ok(gs.leader_idx.every(i => i === 0));
});
