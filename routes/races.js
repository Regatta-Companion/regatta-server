// routes/races.js — Race management routes
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware, adminMiddleware, seriesAccessMiddleware, raceAccessMiddleware } = require('../middleware/auth');

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
  router.get('/', (req, res) => {
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
    ).all(req.userId, req.userId);
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
  router.delete('/:id', adminMiddleware, raceAccessMiddleware, (req, res) => {
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

  return router;
}

module.exports = createRacesRouter;
