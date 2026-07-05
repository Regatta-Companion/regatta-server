// server.js — Regatta Screen API server
'use strict';

const path = require('path');
const fs = require('fs');

// ── Load .env vóór alle andere imports zodat JWT_SECRET beschikbaar is ───────
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const m = line.match(/^([^#=]+)=(.*)$/);
      if (m && !(m[1].trim() in process.env)) {
        process.env[m[1].trim()] = m[2].trim();
      }
    });
}

const express = require('express');
const cors = require('cors');

const { initDb } = require('./db');
const createAuthRouter = require('./routes/auth');
const createTracksRouter = require('./routes/tracks');
const createRacesRouter = require('./routes/races');
const createSeriesRouter = require('./routes/series');
const createClassesRouter = require('./routes/classes');
const createAdminRouter = require('./routes/admin');
const createGarminRouter = require('./routes/garmin');

// ── Directory setup ────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const TRACKS_DIR = path.join(DATA_DIR, 'tracks');
const DB_PATH = path.join(DATA_DIR, 'regatta.db');
const WEB_DIR = path.join(__dirname, 'web');

fs.mkdirSync(TRACKS_DIR, { recursive: true });

// ── Database ───────────────────────────────────────────────────────────────
const db = initDb(DB_PATH);

// ── Express app ───────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: true,
  credentials: true,
}));

// 50 MB: GPX-uploads via JSON (Garmin WiFi) — gelijk aan de multer-limiet
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static web frontend ────────────────────────────────────────────────────
app.use(express.static(WEB_DIR));

// Attach db to every request so middleware can access it
app.use((req, res, next) => { req.db = db; next(); });

// ── API routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', createAuthRouter(db));
app.use('/api/tracks', createTracksRouter(db, TRACKS_DIR));
app.use('/api/races', createRacesRouter(db, TRACKS_DIR));
app.use('/api/series', createSeriesRouter(db));
app.use('/api', createClassesRouter(db));
app.use('/api/admin', createAdminRouter(db));
app.use('/api/garmin', createGarminRouter(db));

// ── Fallback: serve index.html for SPA-like navigation ────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('Not found');
  }
});

// ── Start server ───────────────────────────────────────────────────────────
const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, HOST, () => {
  console.log(`Regatta Server running at http://${HOST}:${PORT}`);
});
