// Учёт агентов (нанятых обзвонщиков) — см. миграцию `agents` в index.js.
// Отдельно от referral.js: там награда существующим пользователям, здесь —
// просто атрибуция "кто из сотрудников привёл эту регистрацию" для сдельной
// оплаты (см. marketing/2026-07-11-vacancy-obzvon.md).

async function resolveAgentCode(pool, code) {
  if (!code) return null;
  const { rows } = await pool.query(
    'SELECT code FROM agents WHERE code=$1 AND active=TRUE',
    [String(code).trim().toUpperCase()]
  );
  return rows.length ? rows[0].code : null;
}

module.exports = { resolveAgentCode };
