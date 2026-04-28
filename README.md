# Regatta Server

Node.js/Express API server voor de Regatta Screen app. Gebruikt SQLite als database en PM2 als procesmanager.

## Vereisten

- Node.js 22 of nieuwer (gebruikt de ingebouwde `node:sqlite`)
- PM2 (`npm install -g pm2`)
- Git

---

## Installatie op Debian / Ubuntu

```bash
# 1. Node.js 22 installeren via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 2. PM2 globaal installeren
sudo npm install -g pm2

# 3. Repository klonen
sudo git clone https://github.com/FutureCow/regatta-server.git /opt/regatta-server
cd /opt/regatta-server

# 4. Dependencies installeren
npm install --omit=dev

# 5. Data-map aanmaken
mkdir -p data/tracks

# 6. JWT secret aanmaken
echo "JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))")" > .env

# 7. Server starten via PM2
pm2 start server.js --name regatta-server --env production
pm2 save
pm2 startup   # voer het getoonde commando uit om autostart in te stellen
```

### Nginx reverse proxy (optioneel)

```nginx
server {
    listen 80;
    server_name regatta.jouwdomein.nl;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo apt-get install -y nginx
sudo nano /etc/nginx/sites-available/regatta
sudo ln -s /etc/nginx/sites-available/regatta /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Installatie op Alpine Linux

```bash
# 1. Node.js en git installeren
apk add --no-cache nodejs npm git

# 2. PM2 globaal installeren
npm install -g pm2

# Alpine zet npm global binaries in /usr/local/bin — zorg dat dit in PATH staat
export PATH="/usr/local/bin:$PATH"
# Voeg dit ook permanent toe:
echo 'export PATH="/usr/local/bin:$PATH"' >> /etc/profile.d/npm-global.sh

# 3. Repository klonen
git clone https://github.com/FutureCow/regatta-server.git /opt/regatta-server
cd /opt/regatta-server

# 4. Dependencies installeren
npm install --omit=dev

# 5. Data-map aanmaken
mkdir -p data/tracks

# 6. JWT secret aanmaken (busybox-compatibel)
echo "JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))")" > .env

# 7. Server starten via PM2
pm2 start server.js --name regatta-server
pm2 save

# 8. PM2 autostart via OpenRC
pm2 startup openrc -u root --hp /root
# voer het getoonde commando uit
```

### Nginx reverse proxy op Alpine (optioneel)

```bash
apk add --no-cache nginx
```

Zelfde nginx-configuratie als bij Debian — sla op in `/etc/nginx/http.d/regatta.conf`.

```bash
nginx -t && rc-service nginx restart
rc-update add nginx default
```

---

## Admin instellen

Na de eerste registratie in de app een gebruiker admin maken:

```bash
cd /opt/regatta-server
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('data/regatta.db');
db.prepare(\"UPDATE users SET is_admin = 1 WHERE email = ?\")\
  .run('jouw@email.nl');
console.log('Klaar:', db.prepare('SELECT email, is_admin FROM users WHERE email = ?').get('jouw@email.nl'));
"
```

---

## Updaten

Gebruik het meegeleverde `update.sh` script:

```bash
cd /opt/regatta-server
bash update.sh
```

---

## Omgevingsvariabelen

| Variabele    | Standaard                              | Omschrijving            |
|--------------|----------------------------------------|-------------------------|
| `JWT_SECRET` | `regatta-screen-secret-change-...`     | Geheim voor JWT tokens  |
| `PORT`       | `3000`                                 | Luisterpoort            |
| `HOST`       | `127.0.0.1`                            | Luisteradres            |

Sla deze op in een `.env` bestand in de projectmap. PM2 laadt `.env` automatisch.

---

## API overzicht

| Methode | Pad                                  | Auth      | Omschrijving                        |
|---------|--------------------------------------|-----------|-------------------------------------|
| POST    | `/api/auth/register`                 | —         | Nieuw account aanmaken              |
| POST    | `/api/auth/login`                    | —         | Inloggen, geeft JWT terug           |
| GET     | `/api/tracks`                        | JWT       | Eigen tracks ophalen                |
| POST    | `/api/tracks`                        | JWT       | GPX uploaden                        |
| DELETE  | `/api/tracks/:id`                    | JWT       | Track verwijderen                   |
| GET     | `/api/tracks/:id/gpx`                | JWT       | GPX-bestand downloaden              |
| GET     | `/api/races`                         | JWT       | Alle wedstrijden ophalen            |
| POST    | `/api/races`                         | JWT+admin | Wedstrijd aanmaken                  |
| DELETE  | `/api/races/:id`                     | JWT+admin | Wedstrijd verwijderen               |
| POST    | `/api/races/:id/tracks`              | JWT       | Eigen track koppelen aan wedstrijd  |
| DELETE  | `/api/races/:id/tracks/:trackId`     | JWT       | Track ontkoppelen                   |
| GET     | `/api/races/:id/tracks`              | JWT       | Alle tracks in een wedstrijd        |
| GET     | `/api/races/:id/tracks/:trackId/gpx` | JWT       | GPX van deelnemer downloaden        |
