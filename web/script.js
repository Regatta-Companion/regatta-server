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
      <a href="admin.html" class="${title === 'admin' ? 'active' : ''}" style="${isAdmin ? '' : 'display:none'}">Beheer</a>
    </div>
    <div class="user-menu">
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

/* ── Helpers ───────────────────────────────────────────────── */
