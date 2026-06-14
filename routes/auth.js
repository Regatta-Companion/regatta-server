// routes/auth.js — Authentication routes (register + login)
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { SECRET } = require('../middleware/auth');

/**
 * Returns an Express router with auth routes mounted on it.
 * @param {import('better-sqlite3').Database} db
 */
function createAuthRouter(db) {
  const router = express.Router();

  // ── POST /api/auth/register ───────────────────────────────────────────────
  router.post('/register', async (req, res) => {
    const { email, password, boat_type, boat_name, team_name } = req.body || {};

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Ongeldig e-mailadres.' });
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Wachtwoord moet minimaal 6 tekens bevatten.' });
    }

    const normalised = email.trim().toLowerCase();

    // Check if user already exists
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalised);
    if (existing) {
      return res.status(409).json({ error: 'Er bestaat al een account met dit e-mailadres.' });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      const result = db
        .prepare('INSERT INTO users (email, password_hash, boat_type, boat_name, team_name) VALUES (?, ?, ?, ?, ?)')
        .run(normalised, passwordHash, boat_type || null, boat_name || null, team_name || null);

      const token = jwt.sign(
        { sub: result.lastInsertRowid, email: normalised },
        SECRET,
        { expiresIn: '90d' }
      );

      return res.status(201).json({ token, email: normalised });
    } catch (err) {
      console.error('Register error:', err);
      return res.status(500).json({ error: 'Interne serverfout bij registratie.' });
    }
  });

  // ── GET /api/auth/me ──────────────────────────────────────────────────────
  router.get('/me', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Niet ingelogd.' });
    }
    const { SECRET } = require('../middleware/auth');
    const jwt = require('jsonwebtoken');
    try {
      const payload = jwt.verify(authHeader.slice(7), SECRET);
      const user = db.prepare('SELECT id, email, is_admin, is_super_admin, boat_type, boat_name, team_name, race_code FROM users WHERE id = ?').get(payload.sub);
      if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden.' });
      return res.json({
        id: user.id, email: user.email, isAdmin: !!user.is_admin, isSuperAdmin: !!user.is_super_admin,
        boatType: user.boat_type, boatName: user.boat_name, teamName: user.team_name, raceCode: user.race_code,
      });
    } catch {
      return res.status(401).json({ error: 'Token ongeldig.' });
    }
  });

  // ── PUT /api/auth/profile ──────────────────────────────────────────────────
  // Only updates fields that are present in the body (null = clear, missing = don't touch)
  router.put('/profile', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Niet ingelogd.' });
    }
    const { SECRET } = require('../middleware/auth');
    const jwt = require('jsonwebtoken');
    let payload;
    try {
      payload = jwt.verify(authHeader.slice(7), SECRET);
    } catch {
      return res.status(401).json({ error: 'Token ongeldig.' });
    }

    const body = req.body || {};
    const allowed = ['boat_type', 'boat_name', 'team_name', 'race_code'];
    const sets = [];
    const vals = [];

    for (const field of allowed) {
      if (field in body) {
        sets.push(`${field} = ?`);
        vals.push(body[field] ?? null);
      }
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'Geen velden om te updaten.' });
    }

    vals.push(payload.sub);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    return res.json({ ok: true });
  });

  // ── POST /api/auth/login ──────────────────────────────────────────────────
  router.post('/login', async (req, res) => {
    const { email, password } = req.body || {};

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'E-mailadres is verplicht.' });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Wachtwoord is verplicht.' });
    }

    const normalised = email.trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalised);

    if (!user) {
      return res.status(401).json({ error: 'Onbekend e-mailadres of onjuist wachtwoord.' });
    }

    try {
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Onbekend e-mailadres of onjuist wachtwoord.' });
      }

      const token = jwt.sign(
        { sub: user.id, email: user.email },
        SECRET,
        { expiresIn: '90d' }
      );

      return res.json({ token, email: user.email });
    } catch (err) {
      console.error('Login error:', err);
      return res.status(500).json({ error: 'Interne serverfout bij inloggen.' });
    }
  });

  return router;
}

module.exports = createAuthRouter;
