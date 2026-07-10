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
