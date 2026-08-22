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
const createTracksRouter = require('../routes/tracks.js');

// Minimale geldige GPX met twee punten
function gpx(startIso) {
  const t0 = new Date(startIso).getTime();
  const pt = (i) =>
    `<trkpt lat="52.${1000 + i}" lon="5.${1000 + i}"><time>${new Date(t0 + i * 1000).toISOString()}</time></trkpt>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx><trk><name>Test</name><trkseg>\n${pt(0)}\n${pt(1)}\n</trkseg></trk></gpx>\n`;
}

let tmpDir, tracksDir, db, server, baseUrl, token;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regatta-racestart-'));
  tracksDir = path.join(tmpDir, 'tracks');
  fs.mkdirSync(tracksDir, { recursive: true });

  db = initDb(path.join(tmpDir, 'test.db'));

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/auth', createAuthRouter(db));
  app.use('/api/tracks', createTracksRouter(db, tracksDir));

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const regRes = await fetch(baseUrl + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'skipper@example.com', password: 'geheim123' }),
  });
  token = (await regRes.json()).token;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function uploadJson(body) {
  return fetch(baseUrl + '/api/tracks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
}

test('JSON-upload bewaart race_start_at en geeft het terug', async () => {
  const res = await uploadJson({
    gpx: gpx('2026-07-01T18:00:00Z'),
    filename: 'met-lap.gpx',
    race_start_at: '2026-07-01T18:05:00.000Z',
  });
  assert.strictEqual(res.status, 201, await res.text());

  const row = db.prepare('SELECT race_start_at FROM tracks WHERE original_filename = ?')
    .get('met-lap.gpx');
  assert.strictEqual(row.race_start_at, '2026-07-01T18:05:00.000Z');

  const list = await (await fetch(baseUrl + '/api/tracks', {
    headers: { Authorization: 'Bearer ' + token },
  })).json();
  const track = list.find(t => t.original_filename === 'met-lap.gpx');
  assert.strictEqual(track.race_start_at, '2026-07-01T18:05:00.000Z');
});

test('upload zonder race_start_at blijft werken en levert null', async () => {
  const res = await uploadJson({
    gpx: gpx('2026-07-02T18:00:00Z'),
    filename: 'zonder-lap.gpx',
  });
  assert.strictEqual(res.status, 201, await res.text());

  const row = db.prepare('SELECT race_start_at FROM tracks WHERE original_filename = ?')
    .get('zonder-lap.gpx');
  assert.strictEqual(row.race_start_at, null);
});

test('multipart-upload bewaart race_start_at — dit is het pad van garmin_sync.py', async () => {
  const form = new FormData();
  // Veld vóór het bestand, zodat multer het zeker in req.body heeft staan
  form.append('race_start_at', '2026-07-03T18:07:30.000Z');
  form.append('gpx', new Blob([gpx('2026-07-03T18:00:00Z')], { type: 'application/gpx+xml' }), 'multipart.gpx');

  const res = await fetch(baseUrl + '/api/tracks', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form,
  });
  assert.strictEqual(res.status, 201, await res.text());

  const row = db.prepare('SELECT race_start_at FROM tracks WHERE original_filename = ?')
    .get('multipart.gpx');
  assert.strictEqual(row.race_start_at, '2026-07-03T18:07:30.000Z');
});
