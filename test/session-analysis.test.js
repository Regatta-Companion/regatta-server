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
