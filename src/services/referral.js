const crypto = require('crypto');
const { notifyByUserId } = require('./telegram');

// Реферальная программа (2026-07-10): дешёвый канал роста, пока нет бюджета на
// рекламу и ИП для нормального маркетинга. Код короткий и человекочитаемый —
// его удобно продиктовать по телефону/в WhatsApp.
function generateCode() {
  return crypto.randomBytes(6).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 7).toUpperCase();
}

// Лениво генерирует и сохраняет код при первом запросе — не нужно бэкфиллить
// всех существующих пользователей отдельной миграцией.
async function getOrCreateReferralCode(pool, userId) {
  const { rows } = await pool.query('SELECT referral_code FROM users WHERE id=$1', [userId]);
  if (rows[0] && rows[0].referral_code) return rows[0].referral_code;
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    try {
      await pool.query('UPDATE users SET referral_code=$1 WHERE id=$2', [code, userId]);
      return code;
    } catch (e) {
      if (e.code === '23505') continue; // коллизия кода — почти невозможна, но на всякий случай ретраим
      throw e;
    }
  }
  throw new Error('Could not generate a unique referral code after 5 attempts');
}

async function resolveReferrer(pool, refCode) {
  if (!refCode) return null;
  const { rows } = await pool.query('SELECT id FROM users WHERE referral_code=$1', [String(refCode).trim().toUpperCase()]);
  return rows.length ? rows[0].id : null;
}

// Начисляет награду пригласившему за РЕАЛЬНОЕ использование приглашённым, а не
// просто регистрацию (защита от накрутки фейковыми аккаунтами):
// - перевозчик: первая подтверждённая оплата подписки (Kaspi вручную или PayBox)
// - грузовладелец: первый размещённый груз (у шипперов подписки нет, это их
//   единственный содержательный сигнал вовлечённости)
// Идемпотентно — флаг referral_reward_given на СТОРОНЕ ПРИГЛАШЁННОГО гарантирует
// однократное начисление, безопасно вызывать при каждом квалифицирующем событии.
async function grantReferralReward(pool, referredUserId) {
  try {
    const { rows } = await pool.query(
      'SELECT referred_by, referral_reward_given FROM users WHERE id=$1',
      [referredUserId]
    );
    if (!rows.length || !rows[0].referred_by || rows[0].referral_reward_given) return;
    const referrerId = rows[0].referred_by;

    await pool.query('UPDATE users SET referral_reward_given=TRUE WHERE id=$1', [referredUserId]);

    const { rows: referrerRows } = await pool.query('SELECT role, subscription_until FROM users WHERE id=$1', [referrerId]);
    if (!referrerRows.length) return;
    const referrer = referrerRows[0];

    // Награда сейчас — только продление подписки, поэтому имеет смысл только
    // для перевозчиков. Приглашение засчитано (флаг выше уже выставлен), но
    // если пригласивший — грузовладелец, поощрять пока нечем.
    if (referrer.role === 'carrier') {
      const cur = referrer.subscription_until;
      const stillActive = cur && new Date(cur) > new Date();
      const base = stillActive ? 'subscription_until' : 'now()';
      await pool.query('UPDATE users SET subscription_until = ' + base + " + interval '7 days' WHERE id=$1", [referrerId]);
      notifyByUserId(pool, referrerId, '🎉 По вашей реферальной ссылке присоединился новый пользователь Trassa! Начислено +7 дней подписки.').catch(() => {});
    }
  } catch (e) {
    console.error('grantReferralReward error:', e.message);
  }
}

module.exports = { generateCode, getOrCreateReferralCode, resolveReferrer, grantReferralReward };
