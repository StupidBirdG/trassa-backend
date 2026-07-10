const pool = require('../db/pool');

// Суточные лимиты для СВЕЖИХ аккаунтов (2026-07-10) — отдельная защита от freemium-лимита
// откликов (тот про монетизацию, месячный, для всех без подписки). Этот — против бота,
// который может залить биржу сотнями фейковых грузов/откликов в первые же минуты после
// регистрации. Действует только первые NEW_ACCOUNT_DAYS дней жизни аккаунта — легитимный
// новичок успевает нормально попробовать платформу, а массовая заливка режется сразу.
const NEW_ACCOUNT_DAYS = 7;
const MAX_NEW_CARGOS_PER_DAY = 5;
const MAX_NEW_BIDS_PER_DAY = 10;

function isNewAccount(createdAt) {
  if (!createdAt) return false;
  const ageMs = Date.now() - new Date(createdAt).getTime();
  return ageMs < NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;
}

// Возвращает { allowed: true } или { allowed: false, error, code } — вызывающий код
// сам решает, как ответить (единый формат ошибки для cargos.js).
async function checkDailyCargoLimit(userId, userCreatedAt) {
  if (!isNewAccount(userCreatedAt)) return { allowed: true };
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS cnt FROM cargos WHERE owner_id=$1 AND created_at >= now() - interval '1 day'",
    [userId]
  );
  if (rows[0].cnt >= MAX_NEW_CARGOS_PER_DAY) {
    return {
      allowed: false,
      error: 'Новые аккаунты могут разместить не более ' + MAX_NEW_CARGOS_PER_DAY + ' грузов в сутки. Лимит снимается через ' + NEW_ACCOUNT_DAYS + ' дней после регистрации.',
      code: 'new_account_daily_limit',
    };
  }
  return { allowed: true };
}

async function checkDailyBidLimit(userId, userCreatedAt) {
  if (!isNewAccount(userCreatedAt)) return { allowed: true };
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS cnt FROM bids WHERE carrier_id=$1 AND created_at >= now() - interval '1 day'",
    [userId]
  );
  if (rows[0].cnt >= MAX_NEW_BIDS_PER_DAY) {
    return {
      allowed: false,
      error: 'Новые аккаунты могут откликнуться не более ' + MAX_NEW_BIDS_PER_DAY + ' раз в сутки. Лимит снимается через ' + NEW_ACCOUNT_DAYS + ' дней после регистрации.',
      code: 'new_account_daily_limit',
    };
  }
  return { allowed: true };
}

module.exports = { isNewAccount, checkDailyCargoLimit, checkDailyBidLimit, NEW_ACCOUNT_DAYS, MAX_NEW_CARGOS_PER_DAY, MAX_NEW_BIDS_PER_DAY };
