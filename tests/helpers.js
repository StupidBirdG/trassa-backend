const { Pool } = require('pg');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'trassa_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

let seq = 0;
function uniqueEmail(prefix) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}@citest.com`;
}

async function api(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, ok: res.ok, data };
}

// Регистрирует shipper/carrier с agreed_terms:true (иначе 400 после введения консента).
async function registerUser({ role = 'shipper', prefix = role, skip_trial } = {}) {
  const email = uniqueEmail(prefix);
  const body = { email, password: 'Test123456!', name: prefix, role, agreed_terms: true };
  if (skip_trial !== undefined) body.skip_trial = skip_trial;
  const r = await api('/api/auth/register-email', { method: 'POST', body });
  if (!r.ok) throw new Error('registerUser failed: ' + JSON.stringify(r.data));
  return { email, token: r.data.token, user: r.data.user };
}

// Поднимает is_admin=TRUE напрямую в БД — так же, как это делается на реальном проде
// (нет self-serve способа стать админом).
async function promoteAdmin(userId) {
  await pool.query('UPDATE users SET is_admin=TRUE WHERE id=$1', [userId]);
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Server did not become healthy within ' + timeoutMs + 'ms');
}

module.exports = { BASE, pool, api, registerUser, promoteAdmin, uniqueEmail, waitForServer };
