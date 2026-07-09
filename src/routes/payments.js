const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const paybox = require('../services/paybox');
const { SUBSCRIPTION_TIERS } = require('./auth');
const { notifyAdmin } = require('../services/telegram');

// Создаёт заказ на оплату подписки и возвращает ссылку на платёжную страницу PayBox
// (там пользователь увидит Kaspi QR среди способов оплаты). Реальная активация тарифа
// происходит только по подтверждённому callback (/paybox/callback), не здесь — иначе
// можно было бы "активировать" подписку без реальной оплаты.
router.post('/paybox/create', authMiddleware, async (req, res) => {
try {
if (req.user.role !== 'carrier') return res.status(403).json({ error: 'Оплата подписки доступна только перевозчикам' });
const { tier } = req.body;
const chosenTier = tier && SUBSCRIPTION_TIERS[tier] ? tier : 'basic';
if (!paybox.isConfigured()) return res.status(503).json({ error: 'Оплата картой/Kaspi временно недоступна', code: 'payments_not_configured' });

const orderId = 'TRASSA-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
const amount = SUBSCRIPTION_TIERS[chosenTier].price;

await pool.query(
"INSERT INTO payments (user_id, order_id, tier, amount, status) VALUES ($1,$2,$3,$4,'pending')",
[req.user.id, orderId, chosenTier, amount]
);

const paymentUrl = paybox.buildPaymentUrl({
orderId,
amount,
description: 'Подписка Трасса — тариф ' + SUBSCRIPTION_TIERS[chosenTier].label,
});

res.json({ ok: true, order_id: orderId, payment_url: paymentUrl });
} catch (err) {
console.error(err);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

// Server-to-server уведомление от PayBox после (не)успешной оплаты. Без JWT-авторизации
// — вместо неё проверка подписи pg_sig защищает от поддельных запросов.
router.post('/paybox/callback', async (req, res) => {
const xml = (status, description) =>
'<?xml version="1.0" encoding="utf-8"?><response><pg_status>' + status + '</pg_status>' +
(description ? '<pg_description>' + description + '</pg_description>' : '') + '</response>';
try {
const body = req.body || {};
// ⚠️ Имя скрипта для подписи ЭТОГО конкретного callback'а точно не подтверждено
// документацией (см. комментарий в services/paybox.js) — 'result' наиболее вероятный
// вариант по семейству протокола PayBox, но стоит сверить при реальном подключении.
const valid = paybox.verifyCallbackSignature('result', body);
if (!valid) {
console.error('PayBox callback: invalid signature', body);
return res.status(400).type('application/xml').send(xml('error', 'Invalid signature'));
}

const { pg_order_id, pg_result, pg_payment_id } = body;
const { rows } = await pool.query('SELECT * FROM payments WHERE order_id=$1', [pg_order_id]);
if (!rows.length) return res.status(400).type('application/xml').send(xml('error', 'Order not found'));
const payment = rows[0];

if (pg_result === '1') {
if (payment.status !== 'paid') {
await pool.query("UPDATE payments SET status='paid', provider_payment_id=$1, paid_at=now() WHERE id=$2", [pg_payment_id || null, payment.id]);
const { rows: userRows } = await pool.query('SELECT subscription_until, subscription_tier FROM users WHERE id=$1', [payment.user_id]);
const cur = userRows[0] && userRows[0].subscription_until;
const stillActive = cur && new Date(cur) > new Date();
const sameTier = stillActive && userRows[0].subscription_tier === payment.tier;
const base = sameTier ? 'subscription_until' : 'now()';
await pool.query('UPDATE users SET subscription_until = ' + base + " + interval '30 days', subscription_tier=$2 WHERE id=$1", [payment.user_id, payment.tier]);
}
} else if (payment.status === 'pending') {
await pool.query("UPDATE payments SET status='failed' WHERE id=$1", [payment.id]);
}

res.type('application/xml').send(xml('ok'));
} catch (err) {
console.error(err);
res.status(500).type('application/xml').send(xml('error', 'Server error'));
}
});

// ─── Ручной перевод на Kaspi Gold ────────────────────────────────────────────
// Пока у владельца Трассы нет ИП/самозанятости, реальные агрегаторы (PayBox и т.п.)
// недоступны — KYC у них требует юр. статус. Временное решение: пользователь переводит
// деньги напрямую на личный Kaspi Gold, указывая order_id как код перевода, а админ
// подтверждает оплату вручную в админ-панели (см. src/routes/admin.js).

router.post('/manual/create', authMiddleware, async (req, res) => {
try {
if (req.user.role !== 'carrier') return res.status(403).json({ error: 'Оплата подписки доступна только перевозчикам' });
const { tier } = req.body;
const chosenTier = tier && SUBSCRIPTION_TIERS[tier] ? tier : 'basic';
const kaspiPhone = process.env.KASPI_PHONE;
if (!kaspiPhone) return res.status(503).json({ error: 'Оплата временно недоступна', code: 'payments_not_configured' });

const orderId = 'TRASSA-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
const amount = SUBSCRIPTION_TIERS[chosenTier].price;

await pool.query(
"INSERT INTO payments (user_id, order_id, tier, amount, status, provider) VALUES ($1,$2,$3,$4,'pending','manual_kaspi')",
[req.user.id, orderId, chosenTier, amount]
);

res.json({
ok: true,
order_id: orderId,
amount,
kaspi_phone: kaspiPhone,
kaspi_name: process.env.KASPI_RECIPIENT_NAME || '',
comment: orderId,
});
} catch (err) {
console.error(err);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

// Пользователь жмёт "Я оплатил" после перевода — это НЕ активирует подписку само по
// себе, а только помечает заказ как требующий проверки админом (чтобы он не потерялся
// в списке "pending", если пользователь просто закрыл вкладку не переведя деньги).
router.post('/manual/:orderId/mark-paid', authMiddleware, async (req, res) => {
try {
const { rows } = await pool.query(
"UPDATE payments SET user_marked_paid_at=now() WHERE order_id=$1 AND user_id=$2 AND provider='manual_kaspi' AND status='pending' RETURNING id, tier, amount",
[req.params.orderId, req.user.id]
);
if (!rows.length) return res.status(404).json({ error: 'Платёж не найден' });
notifyAdmin('💰 Новый Kaspi-перевод на проверку\nЗаказ: ' + req.params.orderId + '\nТариф: ' + rows[0].tier + ' · ' + Number(rows[0].amount).toLocaleString('ru-RU') + ' ₸\nПодтвердить в админ-панели → вкладка «Платежи».').catch(() => {});
res.json({ ok: true });
} catch (err) {
console.error(err);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

// Статус конкретного заказа (работает для обоих провайдеров: paybox и manual_kaspi) —
// фронтенд опрашивает его, чтобы показать "оплата обрабатывается" / "подписка активирована".
async function orderStatusHandler(req, res) {
try {
const { rows } = await pool.query('SELECT status, tier, amount, provider, created_at, paid_at, user_marked_paid_at FROM payments WHERE order_id=$1 AND user_id=$2', [req.params.orderId, req.user.id]);
if (!rows.length) return res.status(404).json({ error: 'Платёж не найден' });
res.json(rows[0]);
} catch (err) {
console.error(err);
res.status(500).json({ error: 'Ошибка сервера' });
}
}
router.get('/status/:orderId', authMiddleware, orderStatusHandler);
router.get('/paybox/:orderId', authMiddleware, orderStatusHandler); // старый путь, оставлен для обратной совместимости

module.exports = router;
