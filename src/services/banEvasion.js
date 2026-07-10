const pool = require('../db/pool');

// Защита от обхода бана новым аккаунтом (2026-07-10): раньше забаненный
// пользователь мог просто зарегистрироваться заново с другим email/телефоном —
// никакой проверки не было. Телефон и BIN сложнее наштамповать бесконечно
// (нужна новая SIM или реальная перерегистрация компании), поэтому именно
// они блокируются, а не только email (тот дешёвый, gmail бесконечен, но всё
// равно добавляем для полноты защиты).

async function addToBlocklist(userId) {
  const { rows } = await pool.query('SELECT phone, email, bin FROM users WHERE id=$1', [userId]);
  if (!rows.length) return;
  const u = rows[0];
  const entries = [];
  if (u.phone) entries.push(['phone', u.phone]);
  if (u.email) entries.push(['email', u.email]);
  if (u.bin) entries.push(['bin', u.bin]);
  for (const [type, value] of entries) {
    await pool.query(
      'INSERT INTO banned_identifiers (type, value, source_user_id) VALUES ($1,$2,$3) ON CONFLICT (type, value) DO NOTHING',
      [type, value, userId]
    );
  }
}

// При разбане убираем из чёрного списка — если админ передумал/спор решился
// в пользу пользователя, он не должен быть навечно заблокирован от регистрации.
async function removeFromBlocklist(userId) {
  const { rows } = await pool.query('SELECT phone, email, bin FROM users WHERE id=$1', [userId]);
  if (!rows.length) return;
  const u = rows[0];
  if (u.phone) await pool.query("DELETE FROM banned_identifiers WHERE type='phone' AND value=$1", [u.phone]);
  if (u.email) await pool.query("DELETE FROM banned_identifiers WHERE type='email' AND value=$1", [u.email]);
  if (u.bin) await pool.query("DELETE FROM banned_identifiers WHERE type='bin' AND value=$1", [u.bin]);
}

async function isBlocked(type, value) {
  if (!value) return false;
  const { rows } = await pool.query('SELECT 1 FROM banned_identifiers WHERE type=$1 AND value=$2', [type, value]);
  return rows.length > 0;
}

module.exports = { addToBlocklist, removeFromBlocklist, isBlocked };
