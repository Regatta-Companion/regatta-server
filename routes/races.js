// routes/races.js — Race management routes
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const { authMiddleware, adminMiddleware, seriesAccessMiddleware, raceAccessMiddleware } = require('../middleware/auth');
const { smoothPoints } = require('../lib/smooth');

// ── Haversine afstand in meters ────────────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function createRacesRouter(db, tracksDir) {
  const router = express.Router();

  // Attach db to req so adminMiddleware can use it
  router.use((req, res, next) => { req.db = db; next(); });
  router.use(authMiddleware);

  // ── POST / — admin creates a race ─────────────────────────────────────────
  router.post('/', adminMiddleware, (req, res) => {
    const { name, description, race_date } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Naam is verplicht.' });
    }
    const result = db.prepare(
      `INSERT INTO races (name, description, race_date, created_by)
       VALUES (?, ?, ?, ?)`
    ).run(name.trim(), description || null, race_date || null, req.userId);

    return res.status(201).json({ id: result.lastInsertRowid });
  });

  // ── GET / — list races in user's series + standalone races with user's tracks
  // Admins zien alle races (ongeacht deelname)
  router.get('/', (req, res) => {
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.userId);
    const isAdmin = user && user.is_admin;

    if (isAdmin) {
      const races = db.prepare(
        `SELECT r.id, r.name, r.description, r.race_date, r.series_id, r.created_at,
                s.name AS series_name, s.season AS series_season,
                COUNT(rt2.track_id) AS participant_count,
                0 AS my_track_count
         FROM races r
         LEFT JOIN series s ON s.id = r.series_id
         LEFT JOIN race_tracks rt2 ON rt2.race_id = r.id
         GROUP BY r.id
         ORDER BY s.name ASC, r.race_date ASC`
      ).all();
      return res.json(races);
    }

    const races = db.prepare(
      `SELECT r.id, r.name, r.description, r.race_date, r.series_id, r.created_at,
              s.name AS series_name, s.season AS series_season,
              COUNT(rt2.track_id) AS participant_count,
              COUNT(CASE WHEN rt2.user_id = ? THEN 1 END) AS my_track_count
       FROM races r
       LEFT JOIN series s ON s.id = r.series_id
       LEFT JOIN race_tracks rt2 ON rt2.race_id = r.id
       WHERE (
         -- Races in series where user participates
         r.series_id IN (SELECT DISTINCT r2.series_id FROM race_tracks rt
                         JOIN races r2 ON r2.id = rt.race_id
                         WHERE rt.user_id = ? AND r2.series_id IS NOT NULL)
         OR
         -- Standalone races where user has tracks
         (r.series_id IS NULL AND r.id IN (SELECT race_id FROM race_tracks WHERE user_id = ?))
       )
       GROUP BY r.id
       ORDER BY s.name ASC, r.race_date ASC`
    ).all(req.userId, req.userId, req.userId);
    return res.json(races);
  });

  // ── GET /:id — single race details ────────────────────────────────────────
  router.get('/:id', (req, res) => {
    const race = db.prepare(
      `SELECT r.*, u.email AS created_by_email
       FROM races r JOIN users u ON u.id = r.created_by
       WHERE r.id = ?`
    ).get(req.params.id);
    if (!race) return res.status(404).json({ error: 'Wedstrijd niet gevonden.' });
    return res.json(race);
  });

  // ── DELETE /:id — admin deletes a race ────────────────────────────────────
  router.delete('/:id', adminMiddleware, raceAccessMiddleware(), (req, res) => {
    const race = db.prepare('SELECT id FROM races WHERE id = ?').get(req.params.id);
    if (!race) return res.status(404).json({ error: 'Wedstrijd niet gevonden.' });
    db.prepare('DELETE FROM races WHERE id = ?').run(req.params.id);
    return res.json({ ok: true });
  });

  // ── POST /:id/tracks — admin links a track to a race ───────────────────────
  router.post('/:id/tracks', adminMiddleware, (req, res) => {
    const race = db.prepare('SELECT id FROM races WHERE id = ?').get(req.params.id);
    if (!race) return res.status(404).json({ error: 'Wedstrijd niet gevonden.' });

    const { track_id } = req.body || {};
    if (!track_id) return res.status(400).json({ error: 'track_id is verplicht.' });

    // Verify the track exists (admin can link any user's track)
    const track = db.prepare(
      'SELECT id, user_id FROM tracks WHERE id = ?'
    ).get(track_id);
    if (!track) return res.status(404).json({ error: 'Track niet gevonden.' });

    // Check not already linked
    const existing = db.prepare(
      'SELECT 1 FROM race_tracks WHERE race_id = ? AND track_id = ?'
    ).get(req.params.id, track_id);
    if (existing) return res.status(409).json({ error: 'Track is al gekoppeld aan deze wedstrijd.' });

    db.prepare(
      'INSERT INTO race_tracks (race_id, track_id, user_id) VALUES (?, ?, ?)'
    ).run(req.params.id, track_id, track.user_id);

    return res.status(201).json({ ok: true });
  });

  // ── DELETE /:id/tracks/:trackId — admin unlinks a track ────────────────────
  router.delete('/:id/tracks/:trackId', adminMiddleware, (req, res) => {
    const link = db.prepare(
      'SELECT 1 FROM race_tracks WHERE race_id = ? AND track_id = ?'
    ).get(req.params.id, req.params.trackId);
    if (!link) return res.status(404).json({ error: 'Koppeling niet gevonden.' });

    db.prepare(
      'DELETE FROM race_tracks WHERE race_id = ? AND track_id = ?'
    ).run(req.params.id, req.params.trackId);
    return res.json({ ok: true });
  });

  // ── GET /:id/tracks — all participants' tracks for a race ─────────────────
  router.get('/:id/tracks', (req, res) => {
    const race = db.prepare('SELECT id FROM races WHERE id = ?').get(req.params.id);
    if (!race) return res.status(404).json({ error: 'Wedstrijd niet gevonden.' });

    const tracks = db.prepare(
      `SELECT t.id, t.name, t.recorded_at, t.duration_seconds, t.distance_meters,
              t.max_speed_knots, t.avg_speed_knots, t.wind_direction_deg, t.point_count,
              u.email AS user_email,
              u.boat_type, u.boat_name, u.team_name,
              rt.linked_at,
              sc.name AS series_class_name, sc.code AS series_class_code,
              c.name AS class_name, c.code AS class_code
       FROM race_tracks rt
       JOIN tracks t ON t.id = rt.track_id
       JOIN users u ON u.id = rt.user_id
       LEFT JOIN series_classes sc ON sc.id = rt.series_class_id
       LEFT JOIN classes c ON c.id = rt.class_id
       WHERE rt.race_id = ?
       ORDER BY t.avg_speed_knots DESC`
    ).all(req.params.id);

    return res.json(tracks);
  });

  // ── GET /:id/tracks/:trackId/gpx — GPX of a participant's track (owner only) ─
  router.get('/:id/tracks/:trackId/gpx', (req, res) => {
    // Verify the track is actually in this race
    const link = db.prepare(
      `SELECT t.filename, rt.user_id
       FROM race_tracks rt JOIN tracks t ON t.id = rt.track_id
       WHERE rt.race_id = ? AND rt.track_id = ?`
    ).get(req.params.id, req.params.trackId);
    if (!link) return res.status(404).json({ error: 'Track niet gevonden in deze wedstrijd.' });

    // Only the track owner can download the GPX
    if (link.user_id !== req.userId) {
      return res.status(403).json({ error: 'Alleen de eigenaar kan het GPX-bestand downloaden.' });
    }

    const filePath = path.join(tracksDir, String(link.user_id), link.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'GPX-bestand niet gevonden op schijf.' });
    }

    res.setHeader('Content-Type', 'application/gpx+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${link.filename}"`);
    fs.createReadStream(filePath).pipe(res);
  });

  // ── POST /:id/compare-data — parsed GPX punten voor playback/vergelijking ──
  router.post('/:id/compare-data', (req, res) => {
    const { track_ids } = req.body || {};
    if (!Array.isArray(track_ids) || track_ids.length === 0 || track_ids.length > 4) {
      return res.status(400).json({ error: 'track_ids moet een array zijn van 1–4 track IDs.' });
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      textNodeName: '_text',
      isArray: (name) => name === 'trkpt' || name === 'trkseg' || name === 'trk',
    });

    const results = [];

    for (let i = 0; i < track_ids.length; i++) {
      const trackId = track_ids[i];

      // Verify track is linked to this race
      const link = db.prepare(
        `SELECT t.id, t.filename, t.name, rt.user_id
         FROM race_tracks rt JOIN tracks t ON t.id = rt.track_id
         WHERE rt.race_id = ? AND rt.track_id = ?`
      ).get(req.params.id, trackId);

      if (!link) {
        return res.status(404).json({ error: `Track ${trackId} niet gevonden in deze wedstrijd.` });
      }

      const filePath = path.join(tracksDir, String(link.user_id), link.filename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `GPX-bestand voor track ${trackId} niet gevonden.` });
      }

      try {
        const xml = fs.readFileSync(filePath, 'utf8');
        const gpx = parser.parse(xml);

        // Navigate XML: gpx.trk[0].trkseg[0].trkpt[]
        const trk = gpx.gpx?.trk;
        if (!trk) continue;

        const segments = Array.isArray(trk) ? trk.flatMap(t => t.trkseg || []) : (trk.trkseg || []);
        const rawPoints = [];
        for (const seg of segments) {
          if (seg.trkpt) rawPoints.push(...seg.trkpt);
        }

        if (rawPoints.length < 2) continue;

        const points = [];
        let totalDist = 0;
        let maxSpd = 0;
        let sumSpd = 0;
        let speedCount = 0;

        for (let j = 0; j < rawPoints.length; j++) {
          const pt = rawPoints[j];
          const lat = parseFloat(pt.lat);
          const lon = parseFloat(pt.lon);
          const time = pt.time?._text || pt.time || null;
          const ele = pt.ele?._text != null ? parseFloat(pt.ele._text) : (pt.ele != null ? parseFloat(pt.ele) : null);

          const entry = { lat, lon };
          if (time) entry.time = time;
          if (ele != null) entry.ele = ele;

          // Bereken snelheid naar vorige punt
          if (j > 0 && time && points[j - 1].time) {
            const dist = haversineM(points[j - 1].lat, points[j - 1].lon, lat, lon);
            const dt = (new Date(time) - new Date(points[j - 1].time)) / 1000;
            if (dt > 0) {
              const speedKn = (dist / 1852) / (dt / 3600);
              entry.speed_kn = Math.round(speedKn * 10) / 10;
              totalDist += dist;
              if (speedKn > maxSpd) maxSpd = speedKn;
              sumSpd += speedKn;
              speedCount++;
            }
          }

          points.push(entry);
        }

        // Smooth GPS data: filtert ruis uit snelheid en positie
        const smoothed = smoothPoints(points);

        results.push({
          id: trackId,
          label: link.name || link.filename,
          color_index: i,
          points: smoothed,
          start_time: points[0].time || null,
          end_time: points[points.length - 1].time || null,
          point_count: points.length,
          distance_m: Math.round(totalDist),
          max_speed_kn: Math.round(maxSpd * 10) / 10,
          avg_speed_kn: speedCount > 0 ? Math.round((sumSpd / speedCount) * 10) / 10 : 0,
        });
      } catch (e) {
        return res.status(500).json({ error: `Fout bij parsen van track ${trackId}: ${e.message}` });
      }
    }

    return res.json(results);
  });

  // ── GET /:id/track-coords — all track coordinates for admin marks editor ──
  router.get('/:id/track-coords', adminMiddleware, raceAccessMiddleware(), (req, res) => {
    const trackLinks = db.prepare(
      `SELECT t.id, t.filename, t.name, rt.user_id
       FROM race_tracks rt JOIN tracks t ON t.id = rt.track_id
       WHERE rt.race_id = ?`
    ).all(req.params.id);

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      textNodeName: '_text',
      isArray: (name) => name === 'trkpt' || name === 'trkseg' || name === 'trk',
    });

    const results = [];
    for (const link of trackLinks) {
      const filePath = path.join(tracksDir, String(link.user_id), link.filename);
      if (!fs.existsSync(filePath)) continue;

      try {
        const xml = fs.readFileSync(filePath, 'utf8');
        const gpx = parser.parse(xml);
        const trk = gpx.gpx?.trk;
        if (!trk) continue;

        const segments = Array.isArray(trk) ? trk.flatMap(t => t.trkseg || []) : (trk.trkseg || []);
        const coords = [];
        for (const seg of segments) {
          if (seg.trkpt) {
            for (const pt of seg.trkpt) {
              const lat = parseFloat(pt.lat);
              const lon = parseFloat(pt.lon);
              if (!isNaN(lat) && !isNaN(lon)) coords.push([lat, lon]);
            }
          }
        }

        if (coords.length >= 2) {
          results.push({ id: link.id, name: link.name, coords });
        }
      } catch (_) {}
    }

    return res.json(results);
  });

  // ── GET /:id/marks — list marks for a race ──────────────────────────────
  router.get('/:id/marks', (req, res) => {
    const race = db.prepare('SELECT id FROM races WHERE id = ?').get(req.params.id);
    if (!race) return res.status(404).json({ error: 'Wedstrijd niet gevonden.' });

    const marks = db.prepare(
      'SELECT * FROM race_marks WHERE race_id = ? ORDER BY sort_order ASC, id ASC'
    ).all(req.params.id);
    return res.json(marks);
  });

  // ── POST /:id/marks — add a mark (admin only) ──────────────────────────
  router.post('/:id/marks', adminMiddleware, raceAccessMiddleware(), (req, res) => {
    const { name, type, lat, lon } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Naam is verplicht.' });
    }
    if (lat == null || lon == null) {
      return res.status(400).json({ error: 'Coordinaten zijn verplicht.' });
    }
    const validTypes = ['buoy', 'gate', 'pin', 'start_ship', 'finish_ship'];
    const markType = validTypes.includes(type) ? type : 'buoy';

    // Get next sort_order
    const last = db.prepare(
      'SELECT MAX(sort_order) AS max_order FROM race_marks WHERE race_id = ?'
    ).get(req.params.id);
    const sortOrder = (last?.max_order ?? -1) + 1;

    const result = db.prepare(
      'INSERT INTO race_marks (race_id, name, type, lat, lon, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.params.id, name.trim(), markType, lat, lon, sortOrder);

    return res.status(201).json({ id: result.lastInsertRowid });
  });

  // ── PUT /:id/marks/:markId — update a mark (admin only) ────────────────
  router.put('/:id/marks/:markId', adminMiddleware, raceAccessMiddleware(), (req, res) => {
    const mark = db.prepare(
      'SELECT * FROM race_marks WHERE id = ? AND race_id = ?'
    ).get(req.params.markId, req.params.id);
    if (!mark) return res.status(404).json({ error: 'Mark niet gevonden.' });

    const { name, type, lat, lon, sort_order } = req.body || {};
    const validTypes = ['buoy', 'gate', 'pin', 'start_ship', 'finish_ship'];

    db.prepare(
      `UPDATE race_marks SET
        name = COALESCE(?, name),
        type = COALESCE(?, type),
        lat = COALESCE(?, lat),
        lon = COALESCE(?, lon),
        sort_order = COALESCE(?, sort_order)
      WHERE id = ?`
    ).run(
      name || null,
      (type && validTypes.includes(type)) ? type : null,
      lat != null ? lat : null,
      lon != null ? lon : null,
      sort_order != null ? sort_order : null,
      req.params.markId
    );
    return res.json({ ok: true });
  });

  // ── DELETE /:id/marks/:markId — delete a mark (admin only) ─────────────
  router.delete('/:id/marks/:markId', adminMiddleware, raceAccessMiddleware(), (req, res) => {
    const mark = db.prepare(
      'SELECT * FROM race_marks WHERE id = ? AND race_id = ?'
    ).get(req.params.markId, req.params.id);
    if (!mark) return res.status(404).json({ error: 'Mark niet gevonden.' });

    db.prepare('DELETE FROM race_marks WHERE id = ?').run(req.params.markId);
    return res.json({ ok: true });
  });

  return router;
}

module.exports = createRacesRouter;
