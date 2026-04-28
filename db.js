// db.js — SQLite database initialisation (uses Node.js built-in node:sqlite)
'use strict';

const { DatabaseSync } = require('node:sqlite');

function initDb(dbPath) {
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename            TEXT    NOT NULL,
      name                TEXT    NOT NULL,
      recorded_at         TEXT    NOT NULL,
      duration_seconds    REAL,
      distance_meters     REAL,
      max_speed_knots     REAL,
      avg_speed_knots     REAL,
      wind_direction_deg  REAL,
      point_count         INTEGER,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS series (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      description TEXT,
      season      TEXT,
      created_by  INTEGER NOT NULL REFERENCES users(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS races (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id   INTEGER REFERENCES series(id) ON DELETE SET NULL,
      name        TEXT    NOT NULL,
      description TEXT,
      race_date   TEXT,
      created_by  INTEGER NOT NULL REFERENCES users(id),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS classes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      race_id    INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      code       TEXT    NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS race_tracks (
      race_id   INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
      track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class_id  INTEGER REFERENCES classes(id) ON DELETE SET NULL,
      linked_at TEXT    NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (race_id, track_id)
    );
  `);

  // Series-level classes (one code per class, valid for all races in the series)
  db.exec(`
    CREATE TABLE IF NOT EXISTS series_classes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id  INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      code       TEXT    NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Migrations
  try { db.exec(`ALTER TABLE tracks ADD COLUMN original_filename TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE race_tracks ADD COLUMN series_class_id INTEGER REFERENCES series_classes(id) ON DELETE SET NULL`); } catch (_) {}

  return db;
}

module.exports = { initDb };
