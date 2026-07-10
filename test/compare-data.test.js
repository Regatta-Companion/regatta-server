'use strict';
// JWT_SECRET moet gezet zijn VOORDAT middleware/auth.js (indirect via de
// routers) wordt gerequired — dat bestand doet process.exit(1) als hij ontbreekt.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { initDb } = require('../db.js');
const createAuthRouter = require('../routes/auth.js');
const createRacesRouter = require('../routes/races.js');
const { makeTrack } = require('./helpers.js');

// Bouwt een minimale, geldige GPX uit synthetische track-punten (lat/lon/time)
function gpxFromPoints(points) {
  const trkpts = points.map(p =>
    `<trkpt lat="${p.lat}" lon="${p.lon}">${p.time ? `<time>${p.time}</time>` : ''}</trkpt>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx><trk><trkseg>\n${trkpts}\n</trkseg></trk></gpx>\n`;
}

// Haversine-afstand in meters — voor tolerantie op de eindpunten na smoothing
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

let tmpDir, tracksDir, db, server, baseUrl, token, userId, raceId;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-compare-'));
  tracksDir = path.join(tmpDir, 'tracks');
  fs.mkdirSync(tracksDir, { recursive: true });

  db = initDb(path.join(tmpDir, 'test.db'));

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/races', createRacesRouter(db, tracksDir));

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Gebruiker registreren voor een geldig JWT
  const regRes = await fetch(baseUrl + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'skipper@example.com', password: 'geheim123' }),
  });
  const reg = await regRes.json();
  token = reg.token;
  userId = db.prepare('SELECT id FROM users WHERE email = ?').get('skipper@example.com').id;

  // Wedstrijd direct in SQLite aanmaken
  const raceResult = db.prepare(
    'INSERT INTO races (name, description, race_date, created_by) VALUES (?, ?, ?, ?)'
  ).run('Testwedstrijd', null, '2026-07-01', userId);
  raceId = raceResult.lastInsertRowid;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Schrijft een track als GPX-bestand + koppelt hem als tracks/race_tracks-record
function createLinkedTrack(filename, points) {
  const userDir = path.join(tracksDir, String(userId));
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, filename), gpxFromPoints(points));

  const result = db.prepare(
    `INSERT INTO tracks (user_id, filename, name, recorded_at, duration_seconds, distance_meters,
       max_speed_knots, avg_speed_knots, wind_direction_deg, point_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, filename, filename, '2026-07-01T18:00:00Z', points.length, 0, 5, 5, null, points.length);
  const trackId = result.lastInsertRowid;

  db.prepare('INSERT INTO race_tracks (race_id, track_id, user_id) VALUES (?, ?, ?)')
    .run(raceId, trackId, userId);
  return trackId;
}

async function postCompareData(trackIds) {
  return fetch(`${baseUrl}/api/races/${raceId}/compare-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ track_ids: trackIds }),
  });
}

test('compare-data: 8 tracks worden gedecimeerd tot maximaal 2000 punten, eindpunten blijven behouden', async () => {
  const trackIds = [];
  const rawByTrack = [];
  for (let i = 0; i < 8; i++) {
    // ~7200 punten (1 Hz, 2 uur) — ver boven de decimatiedrempel van 2000
    const points = makeTrack([{ heading_deg: (i * 15) % 360, seconds: 7200, speed_kn: 5 }]);
    trackIds.push(createLinkedTrack(`track-${i}.gpx`, points));
    rawByTrack.push(points);
  }

  const res = await postCompareData(trackIds);
  assert.strictEqual(res.status, 200);
  const results = await res.json();
  assert.strictEqual(results.length, 8);

  results.forEach((r, i) => {
    assert.ok(r.points.length <= 2000, `track ${i}: verwacht <=2000 punten, kreeg ${r.points.length}`);
    assert.strictEqual(r.point_count, r.points.length, `track ${i}: point_count moet gelijk zijn aan points.length`);

    const raw = rawByTrack[i];
    const firstDist = haversineM(
      r.points[0].lat, r.points[0].lon, raw[0].lat, raw[0].lon);
    const lastDist = haversineM(
      r.points[r.points.length - 1].lat, r.points[r.points.length - 1].lon,
      raw[raw.length - 1].lat, raw[raw.length - 1].lon);
    // GPS-smoothing (window=2) verschuift de randpunten met hooguit ~1 sample;
    // een ruime tolerantie van 50 m dekt dat en vangt echte regressies
    // (bv. verkeerde index, omgedraaide array) nog steeds op.
    assert.ok(firstDist < 50, `track ${i}: eerste punt week ${firstDist.toFixed(1)} m af van de ruwe GPX`);
    assert.ok(lastDist < 50, `track ${i}: laatste punt week ${lastDist.toFixed(1)} m af van de ruwe GPX`);
  });
});

test('compare-data: 3 tracks blijven ongedecimeerd (puntenaantal gelijk aan ruwe GPX)', async () => {
  const trackIds = [];
  const rawByTrack = [];
  for (let i = 0; i < 3; i++) {
    const points = makeTrack([{ heading_deg: 90, seconds: 900, speed_kn: 5 }]);
    trackIds.push(createLinkedTrack(`small-${i}.gpx`, points));
    rawByTrack.push(points);
  }

  const res = await postCompareData(trackIds);
  assert.strictEqual(res.status, 200);
  const results = await res.json();
  assert.strictEqual(results.length, 3);

  results.forEach((r, i) => {
    assert.strictEqual(r.points.length, rawByTrack[i].length,
      `track ${i}: verwacht ${rawByTrack[i].length} punten (geen decimatie bij <=6 tracks), kreeg ${r.points.length}`);
  });
});

test('compare-data: 21 track-ids geeft HTTP 400 met de exacte foutmelding', async () => {
  const trackIds = Array.from({ length: 21 }, (_, i) => i + 1);
  const res = await postCompareData(trackIds);
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'track_ids moet een array zijn van 1–20 track IDs.');
});
