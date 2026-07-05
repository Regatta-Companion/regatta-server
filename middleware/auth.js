// middleware/auth.js — JWT authentication middleware
'use strict';

const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('FATAL: JWT_SECRET ontbreekt. Maak een .env aan met JWT_SECRET=<random hex> (zie README).');
  process.exit(1);
}

/**
 * Express middleware that validates a Bearer JWT in the Authorization header.
 * On success, sets req.userId and req.userEmail.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet ingelogd — token ontbreekt.' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.sub || payload.userId;
    req.userEmail = payload.email;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token ongeldig of verlopen.' });
  }
}

/**
 * Must be used after authMiddleware. Rejects non-admin users.
 * Looks up is_admin from the database via req.db (set in server.js).
 */
function adminMiddleware(req, res, next) {
  const user = req.db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.userId);
  if (!user || !user.is_admin) {
    return res.status(403).json({ error: 'Geen beheerdersrechten.' });
  }
  next();
}

/**
 * Must be used after authMiddleware. Rejects non-super-admin users.
 * Looks up is_super_admin from the database via req.db (set in server.js).
 */
function superAdminMiddleware(req, res, next) {
  const user = req.db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(req.userId);
  if (!user || !user.is_super_admin) {
    return res.status(403).json({ error: 'Alleen de super beheerder heeft toegang.' });
  }
  next();
}

/**
 * Must be used after authMiddleware + adminMiddleware.
 * Checks that the admin has access to the series: creator, granted admin, or super admin.
 * @param {string} [paramName='id'] — the req.params key containing the series ID
 */
function seriesAccessMiddleware(paramName) {
  const key = paramName || 'id';
  return (req, res, next) => {
    const seriesId = parseInt(req.params[key], 10);
    if (isNaN(seriesId)) return res.status(400).json({ error: 'Ongeldige reeks-ID.' });

    // Super admin always has access
    const user = req.db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(req.userId);
    if (user && user.is_super_admin) return next();

    // Check creator or granted admin
    const access = req.db.prepare(`
      SELECT 1 FROM series WHERE id = ? AND created_by = ?
      UNION
      SELECT 1 FROM series_admins WHERE series_id = ? AND user_id = ?
    `).get(seriesId, req.userId, seriesId, req.userId);

    if (!access) {
      return res.status(403).json({ error: 'Geen toegang tot deze reeks.' });
    }
    next();
  };
}

/**
 * Must be used after authMiddleware + adminMiddleware.
 * Checks that the admin has access to the race: creator (standalone), series access, or super admin.
 * @param {string} [paramName='id'] — the req.params key containing the race ID
 */
function raceAccessMiddleware(paramName) {
  const key = paramName || 'id';
  return (req, res, next) => {
    const raceId = parseInt(req.params[key], 10);
    if (isNaN(raceId)) return res.status(400).json({ error: 'Ongeldige wedstrijd-ID.' });

    // Super admin always has access
    const user = req.db.prepare('SELECT is_super_admin FROM users WHERE id = ?').get(req.userId);
    if (user && user.is_super_admin) return next();

    const race = req.db.prepare('SELECT id, created_by, series_id FROM races WHERE id = ?').get(raceId);
    if (!race) return res.status(404).json({ error: 'Wedstrijd niet gevonden.' });

    // Standalone race: creator only
    if (!race.series_id) {
      if (race.created_by !== req.userId) {
        return res.status(403).json({ error: 'Geen toegang tot deze wedstrijd.' });
      }
      return next();
    }

    // Series race: check series access
    const access = req.db.prepare(`
      SELECT 1 FROM series WHERE id = ? AND created_by = ?
      UNION
      SELECT 1 FROM series_admins WHERE series_id = ? AND user_id = ?
    `).get(race.series_id, req.userId, race.series_id, req.userId);

    if (!access) {
      return res.status(403).json({ error: 'Geen toegang tot deze wedstrijd.' });
    }
    next();
  };
}

module.exports = { authMiddleware, adminMiddleware, superAdminMiddleware, seriesAccessMiddleware, raceAccessMiddleware, SECRET };
