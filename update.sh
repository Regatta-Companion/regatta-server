#!/bin/sh
# update.sh — Regatta Server updaten vanuit GitHub
# Werkt op Debian/Ubuntu en Alpine Linux
set -e

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

echo "==> Regatta Server updaten in $INSTALL_DIR"

# ── 1. Nieuwste code ophalen ──────────────────────────────────────────────────
echo "--> git pull..."
git pull origin master --tags

# ── 2. Versie uit git tag schrijven naar package.json ─────────────────────────
GIT_VERSION="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')"
if [ -n "$GIT_VERSION" ]; then
  echo "--> versie instellen op $GIT_VERSION..."
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.version = '$GIT_VERSION';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
fi

# ── 3. Dependencies bijwerken ─────────────────────────────────────────────────
echo "--> npm install..."
npm install --omit=dev

# ── 4. Database migraties uitvoeren ───────────────────────────────────────────
echo "--> database migraties..."
node - <<'JS'
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'data', 'regatta.db'));

db.exec("PRAGMA foreign_keys = OFF");

// Voeg is_admin toe aan users als die kolom nog niet bestaat
const userCols = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);
if (!userCols.includes('is_admin')) {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  console.log('  + users.is_admin toegevoegd');
}

// Races tabel
db.exec(`
  CREATE TABLE IF NOT EXISTS races (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    description TEXT,
    race_date   TEXT,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  )
`);

// Race_tracks koppeltabel
db.exec(`
  CREATE TABLE IF NOT EXISTS race_tracks (
    race_id   INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
    track_id  INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    linked_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (race_id, track_id)
  )
`);

db.exec("PRAGMA foreign_keys = ON");
console.log('  Migraties voltooid.');
JS

# ── 5. PM2 herstarten ─────────────────────────────────────────────────────────
echo "--> PM2 herstarten..."
if pm2 describe regatta-server > /dev/null 2>&1; then
  pm2 restart regatta-server
else
  pm2 start server.js --name regatta-server
  pm2 save
fi

echo ""
echo "✓ Update voltooid."
pm2 show regatta-server | grep -E "status|version|uptime" || true
