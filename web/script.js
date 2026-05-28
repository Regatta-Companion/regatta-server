// Regatta Screen — shared client
const API = 'https://regatta.fhettinga.nl/api';

/* ── Auth helpers ─────────────────────────────────────────── */
function getToken() { return localStorage.getItem('regatta_token'); }
function getEmail() { return localStorage.getItem('regatta_email'); }
function isLoggedIn() { return !!getToken(); }

function setAuth(token, email) {
  localStorage.setItem('regatta_token', token);
  localStorage.setItem('regatta_email', email);
}

function clearAuth() {
  localStorage.removeItem('regatta_token');
  localStorage.removeItem('regatta_email');
}

async function apiGet(path) {
  const token = getToken();
  const res = await fetch(API + path, {
    headers: token ? { 'Authorization': 'Bearer ' + token } : {},
  });
  if (res.status === 401) { clearAuth(); window.location.href = '/'; return null; }
  return res.json();
}

async function apiPost(path, body) {
  const token = getToken();
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Verzoek mislukt (' + res.status + ')');
  return data;
}

/* ── Route guard ──────────────────────────────────────────── */
function requireAuth() {
  if (!isLoggedIn()) window.location.href = '/';
}

/* ── Format helpers ───────────────────────────────────────── */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('nl-NL', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(seconds) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return h + 'u ' + (m % 60) + 'm';
  }
  return m + 'm ' + s + 's';
}

function fmtKnots(ms) {
  if (ms == null) return '—';
  return (ms * 1.94384).toFixed(1);
}

function fmtDeg(deg) {
  if (deg == null) return '—';
  return Math.round(deg) + '°';
}

/* ── Admin check ──────────────────────────────────────────── */
let isAdmin = false;

async function checkAdmin() {
  if (!isLoggedIn()) return;
  try {
    const res = await fetch(API + '/auth/me', {
      headers: { 'Authorization': 'Bearer ' + getToken() },
    });
    if (res.ok) {
      const data = await res.json();
      isAdmin = !!data.isAdmin;
    }
  } catch (_) { /* non-critical */ }
}

/* ── Build header ─────────────────────────────────────────── */
function renderHeader(title) {
  const nav = document.querySelector('.app-header');
  if (!nav) return;
  const email = getEmail();
  const adminLink = isAdmin
    ? `<a href="#" class="admin-gear" onclick="toggleAdminPanel();return false" title="Beheer">
         <svg id="admin-gear-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18">
           <circle cx="10" cy="10" r="3"/><path d="M10 1.5v2M10 16.5v2M18.5 10h-2M3.5 10h-2M15.9 4.1l-1.4 1.4M5.5 14.5l-1.4 1.4M15.9 15.9l-1.4-1.4M5.5 5.5L4.1 4.1"/>
         </svg>
       </a>`
    : '';
  nav.innerHTML = `
    <div class="logo">
      <svg viewBox="0 0 28 28" fill="none" stroke="var(--accent)" stroke-width="2">
        <path d="M14 3L6 18h16L14 3z"/>
        <path d="M14 18v7"/>
        <path d="M10 25h8"/>
      </svg>
      Regatta Screen
    </div>
    <div class="nav">
      <a href="dashboard.html" class="${title === 'dashboard' ? 'active' : ''}">Wedstrijden</a>
      <a href="race.html" class="${title === 'race' ? 'active' : ''}">Race</a>
      <a href="race-compare.html" class="${title === 'compare' ? 'active' : ''}">Vergelijk</a>
    </div>
    <div class="user-menu">
      ${adminLink}
      <span class="email">${email || ''}</span>
      <button class="btn btn-ghost btn-sm" onclick="handleLogout()">Uitloggen</button>
    </div>
  `;
}

function handleLogout() {
  clearAuth();
  window.location.href = '/';
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}

/* ── Admin panel ──────────────────────────────────────────── */
function toggleAdminPanel() {
  const panel = document.getElementById('admin-panel');
  if (!panel) return;
  const isVisible = panel.style.display !== 'none';
  panel.style.display = isVisible ? 'none' : 'block';
  document.getElementById('admin-gear-icon')?.classList.toggle('active', !isVisible);
  if (!isVisible) loadSeriesForAdmin();
}

async function loadSeriesForAdmin() {
  const sel = document.getElementById('race-series');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Geen reeks —</option>';
  try {
    const list = await apiGet('/series');
    if (Array.isArray(list)) {
      list.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name + (s.season ? ' (' + s.season + ')' : '');
        sel.appendChild(opt);
      });
    }
  } catch (_) {}
}

async function createSeries() {
  const name = document.getElementById('series-name')?.value.trim();
  if (!name) return alert('Naam is verplicht.');
  const season = document.getElementById('series-season')?.value.trim() || null;
  const description = document.getElementById('series-desc')?.value.trim() || null;
  try {
    await apiPost('/series', { name, season, description });
    document.getElementById('series-name').value = '';
    document.getElementById('series-season').value = '';
    document.getElementById('series-desc').value = '';
    loadSeriesForAdmin();
    alert('Reeks aangemaakt!');
  } catch (e) {
    alert('Fout: ' + e.message);
  }
}

async function createRace() {
  const name = document.getElementById('admin-race-name')?.value.trim();
  if (!name) return alert('Naam is verplicht.');
  const race_date = document.getElementById('admin-race-date')?.value || null;
  const series_id = document.getElementById('race-series')?.value || null;
  const description = document.getElementById('admin-race-desc')?.value.trim() || null;
  try {
    await apiPost('/races', { name, race_date, series_id: series_id ? parseInt(series_id) : null, description });
    document.getElementById('admin-race-name').value = '';
    document.getElementById('admin-race-date').value = '';
    document.getElementById('admin-race-desc').value = '';
    alert('Wedstrijd aangemaakt! Ververs de pagina om hem te zien.');
  } catch (e) {
    alert('Fout: ' + e.message);
  }
}
