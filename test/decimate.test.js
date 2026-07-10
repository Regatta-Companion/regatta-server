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
