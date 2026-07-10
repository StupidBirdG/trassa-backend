const webpush = require('web-push');

// Web Push (2026-07-10): уведомление о новом грузе перевозчику, не открывая приложение —
// раньше единственный канал был Telegram (только у тех, кто привязал бота). Работает через
// уже готовую PWA-инфраструктуру (manifest.json/sw.js), без сторонних SDK/платных сервисов.
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:admin@trassa.example',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

// Уведомляет перевозчиков с активной подпиской тарифа Pro/Business и рабочей
// push-подпиской о новом грузе (2026-07-10: push — реальный платный перк, а не
// доступный всем платящим одинаково — см. распределение фич по тарифам).
// Мёртвые подписки (410 Gone / 404 — пользователь отписался или удалил приложение) удаляем
// сразу, чтобы не пытаться слать в них на каждый новый груз.
async function notifyCarriersOfNewCargo(pool, cargo) {
  if (!isConfigured()) return { ok: false, error: 'not_configured' };
  try {
    const { rows } = await pool.query(
      `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
       FROM push_subscriptions ps
       JOIN users u ON u.id = ps.user_id
       WHERE u.role = 'carrier' AND u.subscription_until > now() AND u.subscription_tier IN ('pro','business')`
    );
    const payload = JSON.stringify({
      title: '🚛 Новый груз на Trassa',
      body: cargo.from_city + ' → ' + cargo.to_city + ' · ' + cargo.weight_tons + ' т · ' + cargo.cargo_type,
      url: '/',
    });

    let sent = 0;
    for (const sub of rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        sent++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [sub.id]).catch(() => {});
        } else {
          console.error('Push send error:', e.message);
        }
      }
    }
    return { ok: true, sent, total: rows.length };
  } catch (e) {
    console.error('notifyCarriersOfNewCargo error:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { isConfigured, notifyCarriersOfNewCargo };
