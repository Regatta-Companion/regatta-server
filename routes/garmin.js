// routes/garmin.js — Garmin Connect integratie
'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { SECRET: JWT_SECRET } = require('../middleware/auth');

const ALGORITHM = 'aes-256-gcm';

function encrypt(text, secret) {
  const key = crypto.scryptSync(secret, 'garmin-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decrypt(encrypted, secret) {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Ongeldig encrypted formaat');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const key = crypto.scryptSync(secret, 'garmin-salt', 32);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(parts[2], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function createGarminRouter(db) {
  const router = express.Router();
  router.use(authMiddleware);

  const SECRET = JWT_SECRET || 'change-me-garmin-secret';

  // ── GET /status — check of Garmin gekoppeld is ─────────────────────────────
  router.get('/status', (req, res) => {
    const link = db.prepare(
      'SELECT last_sync_at, sync_result, sync_stderr, created_at FROM garmin_links WHERE user_id = ?'
    ).get(req.userId);

    return res.json({
      linked: !!link,
      last_sync_at: link?.last_sync_at || null,
      sync_result: link?.sync_result || null,
      sync_stderr: link?.sync_stderr || null,
      created_at: link?.created_at || null,
    });
  });

  // ── POST /connect — Garmin Connect koppelen ─────────────────────────────────
  router.post('/connect', (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email en wachtwoord zijn verplicht.' });
    }

    const encryptedEmail = encrypt(email, SECRET);
    const encryptedPassword = encrypt(password, SECRET);

    // Upsert
    db.prepare(
      `INSERT INTO garmin_links (user_id, encrypted_email, encrypted_password)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         encrypted_email = excluded.encrypted_email,
         encrypted_password = excluded.encrypted_password`
    ).run(req.userId, encryptedEmail, encryptedPassword);

    return res.json({ ok: true });
  });

  // ── DELETE /connect — Garmin ontkoppelen ───────────────────────────────────
  router.delete('/connect', (req, res) => {
    db.prepare('DELETE FROM garmin_links WHERE user_id = ?').run(req.userId);
    return res.json({ ok: true });
  });

  // ── POST /sync — handmatige sync triggeren ─────────────────────────────────
  router.post('/sync', (req, res) => {
    const link = db.prepare(
      'SELECT encrypted_email, encrypted_password FROM garmin_links WHERE user_id = ?'
    ).get(req.userId);

    if (!link) {
      return res.status(400).json({ error: 'Garmin Connect is nog niet gekoppeld.' });
    }

    let email, password;
    try {
      email = decrypt(link.encrypted_email, SECRET);
      password = decrypt(link.encrypted_password, SECRET);
    } catch (_) {
      return res.status(500).json({ error: 'Kon Garmin-credentials niet ontsleutelen. Koppel opnieuw.' });
    }

    // Build the API base URL for the script
    const apiBase = `${req.protocol}://${req.get('host')}/api`;

    // Generate a temporary token that only works for track upload
    const jwt = require('jsonwebtoken');
    const uploadToken = jwt.sign(
      { userId: req.userId, email: req.userEmail },
      JWT_SECRET,
      { expiresIn: '30m' }
    );

    const scriptPath = path.join(__dirname, '..', 'garmin_sync.py');

    // Determine python path — prefer venv, fallback to system python3
    const pythonPath = (() => {
      const fs = require('fs');
      const candidates = [
        path.join(__dirname, '..', '.venv', 'bin', 'python3'),
        path.join(__dirname, '..', '.venv', 'bin', 'python'),
      ];
      for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch (_) {}
      }
      return 'python3';
    })();

    // Run sync in background
    const child = spawn(pythonPath, [
      scriptPath,
      apiBase,
      uploadToken,
      String(req.userId),
      email,
      password,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1000, // 5 min
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        // Capture last 3 meaningful lines as result summary
        const lines = stdout.split('\n').filter(l => l.trim());
        const summary = lines.slice(-3).join(' | ');
        db.prepare(
          `UPDATE garmin_links SET last_sync_at = datetime('now'), sync_result = ?, sync_stderr = '' WHERE user_id = ?`
        ).run(summary || 'Sync OK (geen output)', req.userId);
        console.log(`[garmin] Sync OK voor user ${req.userId}: ${summary}`);
      } else {
        const errMsg = stderr.slice(-500) || `exit code ${code}`;
        db.prepare(
          `UPDATE garmin_links SET last_sync_at = datetime('now'), sync_result = 'Mislukt', sync_stderr = ? WHERE user_id = ?`
        ).run(errMsg, req.userId);
        console.error(`[garmin] Sync FAILED voor user ${req.userId} (exit ${code}): ${errMsg}`);
      }
    });

    child.on('error', (err) => {
      console.error(`[garmin] Sync spawn error: ${err.message}`);
    });

    // Respond immediately — sync runs in background
    return res.json({
      ok: true,
      message: 'Sync gestart. De tracks verschijnen zodra de sync klaar is.',
    });
  });

  // ── GET /sync/log — laatste sync output ophalen ────────────────────────────
  router.get('/sync/log', (req, res) => {
    const link = db.prepare(
      'SELECT last_sync_at FROM garmin_links WHERE user_id = ?'
    ).get(req.userId);

    return res.json({
      last_sync_at: link?.last_sync_at || null,
    });
  });

  return router;
}

module.exports = createGarminRouter;
