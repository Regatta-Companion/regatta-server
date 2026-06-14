// routes/tracks.js — Track management routes
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const { authMiddleware } = require('../middleware/auth');
const { smoothPoints } = require('../lib/smooth');

// ── Haversine distance (metres) between two lat/lon pairs ─────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Parse GPX XML and extract track statistics ─────────────────────────────
function parseGpx(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: true,
    isArray: (name) => ['trk', 'trkseg', 'trkpt'].includes(name),
  });

  const doc = parser.parse(xmlString);
  const gpx = doc.gpx || doc.GPX;
  if (!gpx) throw new Error('Geen geldig GPX-bestand.');

  // Track name
  const trks = gpx.trk || [];
  const trackName = (trks[0] && trks[0].name) ? String(trks[0].name) : 'Onbekende race';

  // Collect all trkpts
  const points = [];
  for (const trk of trks) {
    const segs = trk.trkseg || [];
    for (const seg of segs) {
      const pts = seg.trkpt || [];
      for (const pt of pts) {
        const lat = parseFloat(pt['@_lat']);
        const lon = parseFloat(pt['@_lon']);
        const timeStr = pt.time;
        if (!isNaN(lat) && !isNaN(lon)) {
          points.push({ lat, lon, time: timeStr ? new Date(timeStr) : null });
        }
      }
    }
  }

  if (points.length === 0) {
    return {
      name: trackName,
      recordedAt: new Date().toISOString(),
      durationSeconds: null,
      distanceMeters: null,
      maxSpeedKnots: null,
      avgSpeedKnots: null,
      pointCount: 0,
    };
  }

  // Compute statistics
  let totalDistanceM = 0;
  let maxSpeedMs = 0;
  const speedSamples = [];

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dist = haversine(prev.lat, prev.lon, curr.lat, curr.lon);
    totalDistanceM += dist;

    if (prev.time && curr.time && curr.time > prev.time) {
      const dtSec = (curr.time - prev.time) / 1000;
      if (dtSec > 0 && dtSec < 60) {
        // Ignore gaps > 60 s (GPS pause / app background)
        const speedMs = dist / dtSec;
        speedSamples.push(speedMs);
        if (speedMs > maxSpeedMs) maxSpeedMs = speedMs;
      }
    }
  }

  const firstTime = points[0].time;
  const lastTime = points[points.length - 1].time;
  const durationSeconds =
    firstTime && lastTime && lastTime > firstTime
      ? (lastTime - firstTime) / 1000
      : null;

  const avgSpeedMs =
    speedSamples.length > 0
      ? speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length
      : null;

  const MS_TO_KNOTS = 1.94384;

  return {
    name: trackName,
    recordedAt: firstTime ? firstTime.toISOString() : new Date().toISOString(),
    durationSeconds,
    distanceMeters: totalDistanceM,
    maxSpeedKnots: maxSpeedMs * MS_TO_KNOTS,
    avgSpeedKnots: avgSpeedMs !== null ? avgSpeedMs * MS_TO_KNOTS : null,
    pointCount: points.length,
  };
}

// ── Router factory ─────────────────────────────────────────────────────────
/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} tracksDir  Root directory where GPX files are stored
 */
function createTracksRouter(db, tracksDir) {
  const router = express.Router();

  // All routes require authentication
  router.use(authMiddleware);

  // Multer: store uploads in a temp location, then move to per-user dir
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const userDir = path.join(tracksDir, String(req.userId));
        fs.mkdirSync(userDir, { recursive: true });
        cb(null, userDir);
      },
      filename: (req, file, cb) => {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        cb(null, `track_${ts}.gpx`);
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB max
    fileFilter: (req, file, cb) => {
      if (
        file.mimetype === 'application/gpx+xml' ||
        file.mimetype === 'text/xml' ||
        file.mimetype === 'application/xml' ||
        file.originalname.endsWith('.gpx')
      ) {
        cb(null, true);
      } else {
        cb(new Error('Alleen GPX-bestanden zijn toegestaan.'));
      }
    },
  });

  // ── POST / — upload a GPX file (multipart or JSON) ──────────────────────
  // JSON body (Garmin WiFi): { "gpx": "<xml>", "filename": "track.gpx" }
  // Multipart (web/android): form field "gpx"
  router.post('/', (req, res, next) => {
    // Check if this is a JSON upload (Garmin WiFi direct)
    var ct = req.get('Content-Type') || '';
    if (ct.indexOf('application/json') !== -1) {
      // JSON path — bypass multer, write GPX from req.body.gpx
      if (!req.body || !req.body.gpx) {
        return res.status(400).json({ error: 'Geen GPX-data in JSON body (veld "gpx").' });
      }

      var gpxContent = req.body.gpx;
      var filename = path.basename(req.body.filename || 'track_garmin.gpx');
      var userDir = path.join(tracksDir, String(req.userId));
      fs.mkdirSync(userDir, { recursive: true });
      var filePath = path.join(userDir, filename);

      try {
        fs.writeFileSync(filePath, gpxContent, 'utf8');
      } catch (e) {
        return res.status(500).json({ error: 'Kon GPX niet opslaan: ' + e.message });
      }

      // Attach file-like object for shared processing below
      req._jsonGpx = true;
      req._gpxPath = filePath;
      req._gpxFilename = filename;
      next();
      return;
    }
    // Multipart path — use multer
    upload.single('gpx')(req, res, next);
  }, async (req, res) => {
    var filePath, originalFilename, isJsonGpx;

    if (req._jsonGpx) {
      filePath = req._gpxPath;
      originalFilename = req._gpxFilename;
      isJsonGpx = true;
    } else {
      if (!req.file) {
        return res.status(400).json({ error: 'Geen GPX-bestand ontvangen.' });
      }
      filePath = req.file.path;
      originalFilename = req.file.originalname || req.file.filename;
      isJsonGpx = false;
    }

    // Duplicate check by original filename
    var existing = db
      .prepare('SELECT id FROM tracks WHERE user_id = ? AND original_filename = ?')
      .get(req.userId, originalFilename);

    if (existing) {
      try { fs.unlinkSync(filePath); } catch (_) {}
      return res.status(409).json({ error: 'Track staat al op de server.', id: existing.id });
    }

    try {
      var xmlContent = fs.readFileSync(filePath, 'utf8');
      var stats = parseGpx(xmlContent);

      const windDeg =
        req.body.wind_direction_deg !== undefined &&
        req.body.wind_direction_deg !== ''
          ? parseFloat(req.body.wind_direction_deg)
          : null;

      const result = db
        .prepare(
          `INSERT INTO tracks
            (user_id, filename, original_filename, name, recorded_at, duration_seconds,
             distance_meters, max_speed_knots, avg_speed_knots,
             wind_direction_deg, point_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          req.userId,
          path.basename(filePath),
          originalFilename,
          stats.name,
          stats.recordedAt,
          stats.durationSeconds,
          stats.distanceMeters,
          stats.maxSpeedKnots,
          stats.avgSpeedKnots,
          windDeg,
          stats.pointCount
        );

      const trackId = result.lastInsertRowid;

      // ── Auto-link via user's race_code ──────────────────────────────────────
      try {
        const user = db.prepare('SELECT race_code FROM users WHERE id = ?').get(req.userId);
        if (user && user.race_code) {
          const upperCode = user.race_code.toUpperCase();
          // Zoek klasse met deze code (reeks of wedstrijd)
          const seriesCls = db.prepare(
            'SELECT id, series_id FROM series_classes WHERE code = ?'
          ).get(upperCode);

          if (seriesCls) {
            // Reeksklasse: zoek wedstrijd met dichtstbijzijnde datum
            const races = db.prepare(
              'SELECT id, race_date FROM races WHERE series_id = ? ORDER BY race_date ASC'
            ).all(seriesCls.series_id);

            if (races.length && stats.recordedAt) {
              const trackTime = new Date(stats.recordedAt).getTime();
              let bestRace = races[0];
              let bestDiff = Infinity;
              for (const r of races) {
                if (!r.race_date) continue;
                const diff = Math.abs(new Date(r.race_date).getTime() - trackTime);
                if (diff < bestDiff) { bestDiff = diff; bestRace = r; }
              }
              // Alleen koppelen als datum binnen 1 dag verschil
              if (bestDiff < 86400000) {
                db.prepare(
                  'INSERT OR IGNORE INTO race_tracks (race_id, track_id, user_id, series_class_id) VALUES (?, ?, ?, ?)'
                ).run(bestRace.id, trackId, req.userId, seriesCls.id);
                console.log(`Auto-linked track ${trackId} to race ${bestRace.id} via code ${upperCode}`);
              }
            }
          } else {
            // Wedstrijdklasse: zoek race direct
            const raceCls = db.prepare(
              'SELECT c.id, c.race_id FROM classes c WHERE c.code = ?'
            ).get(upperCode);
            if (raceCls && stats.recordedAt) {
              const race = db.prepare('SELECT id, race_date FROM races WHERE id = ?').get(raceCls.race_id);
              if (race && race.race_date) {
                const diff = Math.abs(new Date(race.race_date).getTime() - new Date(stats.recordedAt).getTime());
                if (diff < 86400000) {
                  db.prepare(
                    'INSERT OR IGNORE INTO race_tracks (race_id, track_id, user_id, class_id) VALUES (?, ?, ?, ?)'
                  ).run(race.id, trackId, req.userId, raceCls.id);
                  console.log(`Auto-linked track ${trackId} to race ${race.id} via code ${upperCode}`);
                }
              }
            }
          }
        }
      } catch (linkErr) {
        console.error('Auto-link error (non-fatal):', linkErr);
      }

      return res.status(201).json({ id: trackId });
    } catch (err) {
      console.error('Upload error:', err);
      try { fs.unlinkSync(filePath); } catch (_) {}
      return res.status(422).json({ error: `Kon GPX niet verwerken: ${err.message}` });
    }
  });

  // ── GET / — list user tracks ───────────────────────────────────────────
  router.get('/', (req, res) => {
    const tracks = db
      .prepare(
        `SELECT id, filename, original_filename, name, recorded_at, duration_seconds,
                distance_meters, max_speed_knots, avg_speed_knots, wind_direction_deg,
                point_count, created_at
         FROM tracks
         WHERE user_id = ?
         ORDER BY recorded_at DESC`
      )
      .all(req.userId);

    return res.json(tracks);
  });

  // ── GET /:id — single track metadata ──────────────────────────────────
  router.get('/:id', (req, res) => {
    const track = db
      .prepare('SELECT * FROM tracks WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);

    if (!track) {
      return res.status(404).json({ error: 'Track niet gevonden.' });
    }
    return res.json(track);
  });

  // ── GET /:id/gpx — stream GPX file ────────────────────────────────────
  router.get('/:id/gpx', (req, res) => {
    const track = db
      .prepare('SELECT * FROM tracks WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);

    if (!track) {
      return res.status(404).json({ error: 'Track niet gevonden.' });
    }

    const filePath = path.join(tracksDir, String(req.userId), track.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'GPX-bestand niet gevonden op schijf.' });
    }

    res.setHeader('Content-Type', 'application/gpx+xml');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${track.filename}"`
    );
    fs.createReadStream(filePath).pipe(res);
  });

  // ── GET /:id/points — parsed GPX punten (coördinaten + snelheid) ────────
  router.get('/:id/points', (req, res) => {
    const track = db
      .prepare('SELECT * FROM tracks WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);

    if (!track) {
      return res.status(404).json({ error: 'Track niet gevonden.' });
    }

    const filePath = path.join(tracksDir, String(req.userId), track.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'GPX-bestand niet gevonden op schijf.' });
    }

    try {
      const xml = fs.readFileSync(filePath, 'utf8');
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '',
        textNodeName: '_text',
        isArray: (name) => name === 'trkpt' || name === 'trkseg' || name === 'trk',
      });
      const gpx = parser.parse(xml);
      const trk = gpx.gpx?.trk;
      if (!trk) return res.status(422).json({ error: 'Geen track data in GPX.' });

      const segments = Array.isArray(trk) ? trk.flatMap(t => t.trkseg || []) : (trk.trkseg || []);
      const rawPoints = [];
      for (const seg of segments) {
        if (seg.trkpt) rawPoints.push(...seg.trkpt);
      }

      if (rawPoints.length < 2) return res.status(422).json({ error: 'Te weinig punten in GPX.' });

      const points = [];
      let maxSpd = 0;

      for (let j = 0; j < rawPoints.length; j++) {
        const pt = rawPoints[j];
        const lat = parseFloat(pt.lat);
        const lon = parseFloat(pt.lon);
        const time = pt.time?._text || pt.time || null;
        const ele = pt.ele?._text != null ? parseFloat(pt.ele._text) : (pt.ele != null ? parseFloat(pt.ele) : null);

        const entry = { lat, lon };
        if (time) entry.time = time;
        if (ele != null) entry.ele = ele;

        // Speed to previous point
        if (j > 0 && time && points[j - 1].time) {
          const dist = haversine(points[j - 1].lat, points[j - 1].lon, lat, lon);
          const dt = (new Date(time) - new Date(points[j - 1].time)) / 1000;
          if (dt > 0) {
            const speedKn = (dist / 1852) / (dt / 3600);
            entry.speed_kn = Math.round(speedKn * 10) / 10;
            if (speedKn > maxSpd) maxSpd = speedKn;
          }
        }

        points.push(entry);
      }

      // Smooth GPS data: filtert ruis uit snelheid en positie
      const smoothed = smoothPoints(points);

      return res.json({
        id: track.id,
        name: track.name,
        filename: track.filename,
        recorded_at: track.recorded_at,
        points: smoothed,
        point_count: points.length,
        max_speed_kn: Math.round(maxSpd * 10) / 10,
      });
    } catch (e) {
      console.error('Track points parse error:', e);
      return res.status(500).json({ error: `Fout bij parsen: ${e.message}` });
    }
  });

  // ── DELETE /:id — delete track ─────────────────────────────────────────
  router.delete('/:id', (req, res) => {
    const track = db
      .prepare('SELECT * FROM tracks WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.userId);

    if (!track) {
      return res.status(404).json({ error: 'Track niet gevonden.' });
    }

    // Delete file from disk
    const filePath = path.join(tracksDir, String(req.userId), track.filename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.warn('Could not delete GPX file:', err.message);
    }

    db.prepare('DELETE FROM tracks WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);

    return res.json({ ok: true });
  });

  return router;
}

module.exports = createTracksRouter;
