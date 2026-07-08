// routes/classes.js — Class management + join-by-code
'use strict';

const express = require('express');
const { authMiddleware, adminMiddleware, seriesAccessMiddleware } = require('../middleware/auth');

// Leesbare tekens: geen 0/O, 1/I/L verwarring
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(db) {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    const inClasses = db.prepare('SELECT id FROM classes WHERE code = ?').get(code);
    const inSeries  = db.prepare('SELECT id FROM series_classes WHERE code = ?').get(code);
    if (!inClasses && !inSeries) return code;
  }
  throw new Error('Kon geen unieke code genereren.');
}

function createClassesRouter(db) {
  const router = express.Router();
  router.use((req, res, next) => { req.db = db; next(); });
  router.use(authMiddleware);

  // ── POST /api/races/:raceId/classes — admin maakt klasse aan per wedstrijd ─
  router.post('/races/:raceId/classes', adminMiddleware, (req, res) => {
    const race = db.prepare('SELECT id FROM races WHERE id = ?').get(req.params.raceId);
    if (!race) return res.status(404).json({ error: 'Wedstrijd niet gevonden.' });

    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Naam is verplicht.' });

    const code = generateCode(db);
    const result = db.prepare(
      'INSERT INTO classes (race_id, name, code, created_by) VALUES (?, ?, ?, ?)'
    ).run(req.params.raceId, name.trim(), code, req.userId);

    return res.status(201).json({ id: result.lastInsertRowid, code });
  });

  // ── GET /api/races/:raceId/classes — klassen van een wedstrijd ────────────
  router.get('/races/:raceId/classes', (req, res) => {
    const classes = db.prepare(`
      SELECT c.id, c.name, c.code,
             COUNT(rt.track_id) AS participant_count
      FROM classes c
      LEFT JOIN race_tracks rt ON rt.class_id = c.id
      WHERE c.race_id = ?
      GROUP BY c.id
      ORDER BY c.name ASC
    `).all(req.params.raceId);
    return res.json(classes);
  });

  // ── DELETE /api/classes/:id — admin verwijdert race-klasse ───────────────
  router.delete('/classes/:id', adminMiddleware, (req, res) => {
    const cls = db.prepare('SELECT c.id, c.race_id, r.series_id, r.created_by FROM classes c JOIN races r ON r.id = c.race_id WHERE c.id = ?').get(req.params.id);
    if (!cls) return res.status(404).json({ error: 'Klasse niet gevonden.' });

    // Check race access
    const user = db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(req.userId);
    const isSuper = user && user.is_super_admin;

    if (!isSuper) {
      if (cls.series_id) {
        // Race in series: check series access
        const access = db.prepare(`
          SELECT 1 FROM series WHERE id = ? AND created_by = ?
          UNION
          SELECT 1 FROM series_admins WHERE series_id = ? AND user_id = ?
        `).get(cls.series_id, req.userId, cls.series_id, req.userId);
        if (!access) return res.status(403).json({ error: 'Geen toegang tot deze wedstrijd.' });
      } else {
        // Standalone race: creator only
        if (cls.created_by !== req.userId) return res.status(403).json({ error: 'Geen toegang tot deze wedstrijd.' });
      }
    }

    db.prepare('DELETE FROM classes WHERE id = ?').run(req.params.id);
    return res.json({ ok: true });
  });

  // ── POST /api/series/:seriesId/classes — admin maakt reeksklasse aan ─────
  router.post('/series/:seriesId/classes', adminMiddleware, seriesAccessMiddleware('seriesId'), (req, res) => {
    const series = db.prepare('SELECT id FROM series WHERE id = ?').get(req.params.seriesId);
    if (!series) return res.status(404).json({ error: 'Reeks niet gevonden.' });

    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Naam is verplicht.' });

    const code = generateCode(db);
    const result = db.prepare(
      'INSERT INTO series_classes (series_id, name, code, created_by) VALUES (?, ?, ?, ?)'
    ).run(req.params.seriesId, name.trim(), code, req.userId);

    return res.status(201).json({ id: result.lastInsertRowid, code });
  });

  // ── GET /api/series/:seriesId/classes — reeksklassen met deelnemerstelling ─
  router.get('/series/:seriesId/classes', (req, res) => {
    const classes = db.prepare(`
      SELECT sc.id, sc.name, sc.code,
             COUNT(DISTINCT rt.track_id) AS participant_count
      FROM series_classes sc
      LEFT JOIN race_tracks rt ON rt.series_class_id = sc.id
      WHERE sc.series_id = ?
      GROUP BY sc.id
      ORDER BY sc.name ASC
    `).all(req.params.seriesId);
    return res.json(classes);
  });

  // ── DELETE /api/series-classes/:id — admin verwijdert reeksklasse ─────────
  router.delete('/series-classes/:id', adminMiddleware, (req, res) => {
    const cls = db.prepare('SELECT id, series_id FROM series_classes WHERE id = ?').get(req.params.id);
    if (!cls) return res.status(404).json({ error: 'Reeksklasse niet gevonden.' });

    // Check series access (same logic as seriesAccessMiddleware)
    const user = db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(req.userId);
    const isSuper = user && user.is_super_admin;

    if (!isSuper) {
      const access = db.prepare(`
        SELECT 1 FROM series WHERE id = ? AND created_by = ?
        UNION
        SELECT 1 FROM series_admins WHERE series_id = ? AND user_id = ?
      `).get(cls.series_id, req.userId, cls.series_id, req.userId);
      if (!access) return res.status(403).json({ error: 'Geen toegang tot deze reeks.' });
    }

    db.prepare('DELETE FROM series_classes WHERE id = ?').run(req.params.id);
    return res.json({ ok: true });
  });

  // ── GET /api/series/:seriesId/classes/:classId/tracks — resultaten per reeksklasse
  router.get('/series/:seriesId/classes/:classId/tracks', (req, res) => {
    const cls = db.prepare(
      'SELECT id FROM series_classes WHERE id = ? AND series_id = ?'
    ).get(req.params.classId, req.params.seriesId);
    if (!cls) return res.status(404).json({ error: 'Reeksklasse niet gevonden.' });

    const tracks = db.prepare(`
      SELECT t.id, t.name, t.recorded_at, t.duration_seconds, t.distance_meters,
             t.max_speed_knots, t.avg_speed_knots, t.point_count,
             r.id AS race_id, r.name AS race_name, r.race_date,
             u.email AS user_email, rt.linked_at
      FROM race_tracks rt
      JOIN tracks t ON t.id = rt.track_id
      JOIN races r  ON r.id = rt.race_id
      JOIN users u  ON u.id = rt.user_id
      WHERE rt.series_class_id = ?
      ORDER BY r.race_date ASC, t.avg_speed_knots DESC
    `).all(req.params.classId);

    return res.json(tracks);
  });

  // ── GET /api/join/:code — code opzoeken (race of reeks) ──────────────────
  router.get('/join/:code', (req, res) => {
    const code = req.params.code.toUpperCase();

    // Check reeksklasse eerst
    const seriesRow = db.prepare(`
      SELECT sc.id AS class_id, sc.name AS class_name, sc.code,
             s.id AS series_id, s.name AS series_name, s.season,
             null AS race_id, null AS race_name, null AS race_date,
             'series' AS code_type
      FROM series_classes sc
      JOIN series s ON s.id = sc.series_id
      WHERE sc.code = ?
    `).get(code);
    if (seriesRow) return res.json(seriesRow);

    // Check wedstrijdklasse
    const raceRow = db.prepare(`
      SELECT c.id AS class_id, c.name AS class_name, c.code,
             r.id AS race_id, r.name AS race_name, r.race_date,
             s.name AS series_name,
             'race' AS code_type
      FROM classes c
      JOIN races r ON r.id = c.race_id
      LEFT JOIN series s ON s.id = r.series_id
      WHERE c.code = ?
    `).get(code);
    if (raceRow) return res.json(raceRow);

    return res.status(404).json({ error: 'Onbekende code.' });
  });

  // ── POST /api/join — track koppelen via code ──────────────────────────────
  router.post('/join', (req, res) => {
    const { code, track_id } = req.body || {};
    if (!code || !track_id) return res.status(400).json({ error: 'code en track_id zijn verplicht.' });

    const upperCode = code.toUpperCase();

    // Track moet van deze gebruiker zijn
    const track = db.prepare(
      'SELECT id, recorded_at FROM tracks WHERE id = ? AND user_id = ?'
    ).get(track_id, req.userId);
    if (!track) return res.status(404).json({ error: 'Track niet gevonden.' });

    // ── Reeksklasse? ──────────────────────────────────────────────────────────
    const seriesCls = db.prepare(
      'SELECT id, series_id FROM series_classes WHERE code = ?'
    ).get(upperCode);

    if (seriesCls) {
      // Zoek de wedstrijd in de reeks die het dichtst bij de opnamedatum ligt
      const races = db.prepare(
        'SELECT id, race_date FROM races WHERE series_id = ? ORDER BY race_date ASC'
      ).all(seriesCls.series_id);

      if (!races.length) {
        return res.status(400).json({ error: 'Geen wedstrijden in deze reeks.' });
      }

      const trackTime = track.recorded_at ? new Date(track.recorded_at).getTime() : null;
      let bestRace = races[0];
      if (trackTime) {
        let bestDiff = Infinity;
        for (const r of races) {
          if (!r.race_date) continue;
          const diff = Math.abs(new Date(r.race_date).getTime() - trackTime);
          if (diff < bestDiff) { bestDiff = diff; bestRace = r; }
        }
      }

      const existing = db.prepare(
        'SELECT 1 FROM race_tracks WHERE race_id = ? AND track_id = ?'
      ).get(bestRace.id, track_id);

      // Geef terug aan welke wedstrijd de track is gekoppeld,
      // zodat de gebruiker de automatische race-keuze kan controleren.
      const raceInfo = db.prepare(
        'SELECT id, name, race_date FROM races WHERE id = ?'
      ).get(bestRace.id);

      if (existing) {
        db.prepare(
          'UPDATE race_tracks SET series_class_id = ?, class_id = NULL WHERE race_id = ? AND track_id = ?'
        ).run(seriesCls.id, bestRace.id, track_id);
        return res.json({ ok: true, updated: true, race_id: raceInfo.id, race_name: raceInfo.name, race_date: raceInfo.race_date });
      }

      db.prepare(
        'INSERT INTO race_tracks (race_id, track_id, user_id, series_class_id) VALUES (?, ?, ?, ?)'
      ).run(bestRace.id, track_id, req.userId, seriesCls.id);
      return res.status(201).json({ ok: true, race_id: raceInfo.id, race_name: raceInfo.name, race_date: raceInfo.race_date });
    }

    // ── Wedstrijdklasse ───────────────────────────────────────────────────────
    const cls = db.prepare(
      'SELECT id AS class_id, race_id FROM classes WHERE code = ?'
    ).get(upperCode);
    if (!cls) return res.status(404).json({ error: 'Onbekende code.' });

    const existing = db.prepare(
      'SELECT 1 FROM race_tracks WHERE race_id = ? AND track_id = ?'
    ).get(cls.race_id, track_id);

    const raceInfo = db.prepare(
      'SELECT id, name, race_date FROM races WHERE id = ?'
    ).get(cls.race_id);

    if (existing) {
      db.prepare(
        'UPDATE race_tracks SET class_id = ?, series_class_id = NULL WHERE race_id = ? AND track_id = ?'
      ).run(cls.class_id, cls.race_id, track_id);
      return res.json({ ok: true, updated: true, race_id: raceInfo.id, race_name: raceInfo.name, race_date: raceInfo.race_date });
    }

    db.prepare(
      'INSERT INTO race_tracks (race_id, track_id, user_id, class_id) VALUES (?, ?, ?, ?)'
    ).run(cls.race_id, track_id, req.userId, cls.class_id);
    return res.status(201).json({ ok: true, race_id: raceInfo.id, race_name: raceInfo.name, race_date: raceInfo.race_date });
  });

  // ── GET /api/races/:raceId/classes/:classId/tracks — resultaten per wedstrijdklasse
  router.get('/races/:raceId/classes/:classId/tracks', (req, res) => {
    const cls = db.prepare(
      'SELECT id FROM classes WHERE id = ? AND race_id = ?'
    ).get(req.params.classId, req.params.raceId);
    if (!cls) return res.status(404).json({ error: 'Klasse niet gevonden.' });

    const tracks = db.prepare(`
      SELECT t.id, t.name, t.recorded_at, t.duration_seconds, t.distance_meters,
             t.max_speed_knots, t.avg_speed_knots, t.wind_direction_deg, t.point_count,
             u.email AS user_email, rt.linked_at
      FROM race_tracks rt
      JOIN tracks t ON t.id = rt.track_id
      JOIN users u ON u.id = rt.user_id
      WHERE rt.race_id = ? AND rt.class_id = ?
      ORDER BY t.avg_speed_knots DESC
    `).all(req.params.raceId, req.params.classId);

    return res.json(tracks);
  });

  return router;
}

module.exports = createClassesRouter;
