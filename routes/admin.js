// routes/admin.js — Super admin routes (user management)
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { authMiddleware, superAdminMiddleware } = require('../middleware/auth');

/**
 * Returns an Express router with super-admin user management routes.
 * All routes require authMiddleware + superAdminMiddleware.
 */
function createAdminRouter(db) {
  const router = express.Router();

  // ── All routes require auth + super admin ──────────────────────────────────
  router.use(authMiddleware);
  router.use(superAdminMiddleware);

  // ── GET /api/admin/users ──────────────────────────────────────────────────
  // List all users with role, boat info, and track count.
  router.get('/users', (req, res) => {
    const users = db.prepare(`
      SELECT
        u.id, u.email, u.is_admin, u.is_super_admin,
        u.boat_type, u.boat_name, u.team_name,
        u.created_at,
        COUNT(t.id) AS track_count
      FROM users u
      LEFT JOIN tracks t ON t.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `).all();

    const result = users.map(u => ({
      id: u.id,
      email: u.email,
      role: u.is_super_admin ? 'Super Admin' : u.is_admin ? 'Beheerder' : 'Zeiler',
      boatType: u.boat_type,
      boatName: u.boat_name,
      teamName: u.team_name,
      trackCount: u.track_count,
      createdAt: u.created_at,
    }));

    return res.json(result);
  });

  // ── GET /api/admin/users/:id ──────────────────────────────────────────────
  // Get a single user's details including their tracks.
  router.get('/users/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Ongeldige gebruikers-ID.' });

    const user = db.prepare(`
      SELECT
        u.id, u.email, u.is_admin, u.is_super_admin,
        u.boat_type, u.boat_name, u.team_name,
        u.created_at,
        COUNT(t.id) AS track_count
      FROM users u
      LEFT JOIN tracks t ON t.user_id = u.id
      WHERE u.id = ?
      GROUP BY u.id
    `).get(id);

    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });

    return res.json({
      id: user.id,
      email: user.email,
      role: user.is_super_admin ? 'Super Admin' : user.is_admin ? 'Beheerder' : 'Zeiler',
      isAdmin: !!user.is_admin,
      isSuperAdmin: !!user.is_super_admin,
      boatType: user.boat_type,
      boatName: user.boat_name,
      teamName: user.team_name,
      trackCount: user.track_count,
      createdAt: user.created_at,
    });
  });

  // ── PUT /api/admin/users/:id/role ─────────────────────────────────────────
  // Change a user's role. Body: { role: "zeiler" | "beheerder" | "super_admin" }
  router.put('/users/:id/role', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Ongeldige gebruikers-ID.' });

    const { role } = req.body || {};
    const validRoles = ['zeiler', 'beheerder', 'super_admin'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ error: `Rol moet één van zijn: ${validRoles.join(', ')}.` });
    }

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });

    // Prevent removing your own super admin rights (safety net)
    if (id === req.userId && role !== 'super_admin') {
      return res.status(400).json({ error: 'Je kunt je eigen super admin-rechten niet intrekken.' });
    }

    const isAdmin = role === 'beheerder' || role === 'super_admin' ? 1 : 0;
    const isSuperAdmin = role === 'super_admin' ? 1 : 0;

    db.prepare('UPDATE users SET is_admin = ?, is_super_admin = ? WHERE id = ?')
      .run(isAdmin, isSuperAdmin, id);

    const updated = db.prepare('SELECT id, email, is_admin, is_super_admin FROM users WHERE id = ?').get(id);
    const newRole = updated.is_super_admin ? 'Super Admin' : updated.is_admin ? 'Beheerder' : 'Zeiler';

    return res.json({ id: updated.id, email: updated.email, role: newRole });
  });

  // ── DELETE /api/admin/users/:id ───────────────────────────────────────────
  // Delete a user and all their data (tracks, etc.).
  router.delete('/users/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Ongeldige gebruikers-ID.' });

    if (id === req.userId) {
      return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen via dit endpoint.' });
    }

    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });

    // CASCADE handles tracks, race_tracks via FK
    db.prepare('DELETE FROM users WHERE id = ?').run(id);

    return res.json({ deleted: { id: user.id, email: user.email } });
  });

  // ── POST /api/admin/users ─────────────────────────────────────────────────
  // Create a new user (admin-driven registration). Body: { email, password, role?, boat_type?, boat_name?, team_name? }
  router.post('/users', async (req, res) => {
    const { email, password, role, boat_type, boat_name, team_name } = req.body || {};

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Ongeldig e-mailadres.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Wachtwoord moet minimaal 6 tekens bevatten.' });
    }

    const normalised = email.trim().toLowerCase();

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalised);
    if (existing) {
      return res.status(409).json({ error: 'Er bestaat al een account met dit e-mailadres.' });
    }

    const validRoles = ['zeiler', 'beheerder', 'super_admin'];
    const targetRole = role && validRoles.includes(role) ? role : 'zeiler';
    const isAdmin = targetRole === 'beheerder' || targetRole === 'super_admin' ? 1 : 0;
    const isSuperAdmin = targetRole === 'super_admin' ? 1 : 0;

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const result = db.prepare(`
        INSERT INTO users (email, password_hash, is_admin, is_super_admin, boat_type, boat_name, team_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(normalised, passwordHash, isAdmin, isSuperAdmin,
        boat_type || null, boat_name || null, team_name || null);

      return res.status(201).json({
        id: result.lastInsertRowid,
        email: normalised,
        role: targetRole === 'super_admin' ? 'Super Admin' : targetRole === 'beheerder' ? 'Beheerder' : 'Zeiler',
      });
    } catch (err) {
      console.error('Admin create user error:', err);
      return res.status(500).json({ error: 'Interne serverfout bij aanmaken gebruiker.' });
    }
  });

  // ── GET /api/admin/series/:id/admins — lijst admins met toegang tot reeks ──
  router.get('/series/:id/admins', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Ongeldige reeks-ID.' });

    const series = db.prepare('SELECT id FROM series WHERE id = ?').get(id);
    if (!series) return res.status(404).json({ error: 'Reeks niet gevonden.' });

    const admins = db.prepare(`
      SELECT u.id, u.email, sa.granted_at, u2.email AS granted_by_email
      FROM series_admins sa
      JOIN users u ON u.id = sa.user_id
      JOIN users u2 ON u2.id = sa.granted_by
      WHERE sa.series_id = ?
      ORDER BY sa.granted_at DESC
    `).all(id);

    return res.json(admins);
  });

  // ── POST /api/admin/series/:id/admins — admin toegang geven tot reeks ─────
  router.post('/series/:id/admins', (req, res) => {
    const seriesId = parseInt(req.params.id, 10);
    if (isNaN(seriesId)) return res.status(400).json({ error: 'Ongeldige reeks-ID.' });

    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'user_id is verplicht.' });

    const series = db.prepare('SELECT id, name FROM series WHERE id = ?').get(seriesId);
    if (!series) return res.status(404).json({ error: 'Reeks niet gevonden.' });

    const targetUser = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(user_id);
    if (!targetUser) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
    if (!targetUser.is_admin) return res.status(400).json({ error: 'Alleen beheerders kunnen toegang krijgen tot reeksen.' });

    const existing = db.prepare(
      'SELECT 1 FROM series_admins WHERE series_id = ? AND user_id = ?'
    ).get(seriesId, user_id);
    if (existing) return res.status(409).json({ error: 'Deze beheerder heeft al toegang tot deze reeks.' });

    db.prepare(
      'INSERT INTO series_admins (series_id, user_id, granted_by) VALUES (?, ?, ?)'
    ).run(seriesId, user_id, req.userId);

    return res.status(201).json({ ok: true, series_id: seriesId, user_id });
  });

  // ── DELETE /api/admin/series/:id/admins/:userId — admin toegang intrekken ─
  router.delete('/series/:id/admins/:userId', (req, res) => {
    const seriesId = parseInt(req.params.id, 10);
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(seriesId) || isNaN(userId)) return res.status(400).json({ error: 'Ongeldige ID.' });

    const link = db.prepare(
      'SELECT 1 FROM series_admins WHERE series_id = ? AND user_id = ?'
    ).get(seriesId, userId);
    if (!link) return res.status(404).json({ error: 'Deze beheerder heeft geen toegang tot deze reeks.' });

    db.prepare('DELETE FROM series_admins WHERE series_id = ? AND user_id = ?').run(seriesId, userId);
    return res.json({ ok: true });
  });

  return router;
}

module.exports = createAdminRouter;
