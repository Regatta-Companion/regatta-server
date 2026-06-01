// routes/series.js — Competition series management
'use strict';

const express = require('express');
const { authMiddleware, adminMiddleware, seriesAccessMiddleware } = require('../middleware/auth');

function createSeriesRouter(db) {
  const router = express.Router();

  router.use((req, res, next) => { req.db = db; next(); });
  router.use(authMiddleware);

  // ── POST / — admin maakt een reeks aan ───────────────────────────────────
  router.post('/', adminMiddleware, (req, res) => {
    const { name, description, season } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Naam is verplicht.' });
    }
    const result = db.prepare(
      'INSERT INTO series (name, description, season, created_by) VALUES (?, ?, ?, ?)'
    ).run(name.trim(), description || null, season || null, req.userId);
    return res.status(201).json({ id: result.lastInsertRowid });
  });

  // ── GET / — lijst van alle reeksen met wedstrijdtelling ──────────────────
  // Admins (non-super) zien alleen eigen + toegewezen reeksen.
  // Super admins en zeilers zien alle reeksen.
  router.get('/', (req, res) => {
    const user = req.db.prepare('SELECT is_admin, is_super_admin FROM users WHERE id = ?').get(req.userId);
    const isAdminUser = user && user.is_admin;
    const isSuper = user && user.is_super_admin;

    let rows;
    if (isAdminUser && !isSuper) {
      // Admin: only own series + granted
      rows = req.db.prepare(`
        SELECT s.id, s.name, s.description, s.season, s.created_at,
               u.email AS created_by_email,
               COUNT(r.id) AS race_count
        FROM series s
        JOIN users u ON u.id = s.created_by
        LEFT JOIN races r ON r.series_id = s.id
        WHERE s.created_by = ? OR s.id IN (SELECT series_id FROM series_admins WHERE user_id = ?)
        GROUP BY s.id
        ORDER BY s.created_at DESC
      `).all(req.userId, req.userId);
    } else {
      // Super admin or regular user: see all
      rows = req.db.prepare(`
        SELECT s.id, s.name, s.description, s.season, s.created_at,
               u.email AS created_by_email,
               COUNT(r.id) AS race_count
        FROM series s
        JOIN users u ON u.id = s.created_by
        LEFT JOIN races r ON r.series_id = s.id
        GROUP BY s.id
        ORDER BY s.created_at DESC
      `).all();
    }

    return res.json(rows);
  });

  // ── GET /:id — reeks detail met alle wedstrijden ─────────────────────────
  router.get('/:id', (req, res) => {
    const series = db.prepare(`
      SELECT s.*, u.email AS created_by_email
      FROM series s JOIN users u ON u.id = s.created_by
      WHERE s.id = ?
    `).get(req.params.id);
    if (!series) return res.status(404).json({ error: 'Reeks niet gevonden.' });

    const races = db.prepare(`
      SELECT r.id, r.name, r.race_date, r.description,
             COUNT(rt.track_id) AS participant_count
      FROM races r
      LEFT JOIN race_tracks rt ON rt.race_id = r.id
      WHERE r.series_id = ?
      GROUP BY r.id
      ORDER BY r.race_date ASC
    `).all(req.params.id);

    return res.json({ ...series, races });
  });

  // ── DELETE /:id — admin verwijdert een reeks (wedstrijden blijven) ────────
  router.delete('/:id', adminMiddleware, seriesAccessMiddleware(), (req, res) => {
    const s = db.prepare('SELECT id FROM series WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Reeks niet gevonden.' });
    // Wedstrijden krijgen series_id = NULL (ON DELETE SET NULL)
    db.prepare('DELETE FROM series WHERE id = ?').run(req.params.id);
    return res.json({ ok: true });
  });

  // ── POST /:id/races — admin voegt wedstrijd toe aan reeks ─────────────────
  router.post('/:id/races', adminMiddleware, seriesAccessMiddleware(), (req, res) => {
    const s = db.prepare('SELECT id FROM series WHERE id = ?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Reeks niet gevonden.' });

    const { name, race_date, description } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Naam is verplicht.' });
    }
    const result = db.prepare(
      'INSERT INTO races (series_id, name, race_date, description, created_by) VALUES (?, ?, ?, ?, ?)'
    ).run(req.params.id, name.trim(), race_date || null, description || null, req.userId);

    return res.status(201).json({ id: result.lastInsertRowid });
  });

  return router;
}

module.exports = createSeriesRouter;
