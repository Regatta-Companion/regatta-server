'use strict';
const test = require('node:test');
const assert = require('node:assert');
const SA = require('../web/session-analysis.js');
const { makeTrack } = require('./helpers.js');

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

test('detectManeuvers: snelheidsverlies en hersteltijd worden gemeten', () => {
  // Dip naar 2 kn direct na de bocht; herstel naar 5 kn na 15 s
  const points = SA.computeHeadings(makeTrack([
    { heading_deg: 315, seconds: 120, speed_kn: 5 },
    { heading_deg: 45, seconds: 15, speed_kn: 2 },
    { heading_deg: 45, seconds: 105, speed_kn: 5 },
  ]));
  const legs = SA.segmentLegs(points, 0);
  const mans = SA.detectManeuvers(points, legs, 0);
  assert.strictEqual(mans.length, 1);
  assert.strictEqual(mans[0].type, 'overstag');
  assert.ok(mans[0].speed_loss_kn >= 2.5 && mans[0].speed_loss_kn <= 3.5,
    `verwacht verlies ~3 kn, kreeg ${mans[0].speed_loss_kn}`);
  assert.ok(mans[0].recovery_s >= 10 && mans[0].recovery_s <= 30,
    `verwacht herstel ~15 s, kreeg ${mans[0].recovery_s}`);
});

test('detectManeuvers: bocht die de wind niet kruist is geen manoeuvre', () => {
  // Wind uit 0; koers 100 → 170 is 70° draai die noch 0 noch 180 kruist
  const points = SA.computeHeadings(makeTrack([
    { heading_deg: 100, seconds: 120, speed_kn: 5 },
    { heading_deg: 170, seconds: 120, speed_kn: 5 },
  ]));
  const legs = SA.segmentLegs(points, 0);
  assert.deepStrictEqual(SA.detectManeuvers(points, legs, 0), []);
});
