const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const push = require('../services/push');

// Публичный ключ нужен фронтенду для pushManager.subscribe() — не секрет, это половина
// ключевой пары, предназначенная для передачи клиенту по протоколу Web Push (RFC 8292).
router.get('/vapid-public-key', (req, res) => {
if (!push.isConfigured()) return res.status(503).json({ error: 'Push-уведомления временно недоступны', code: 'push_not_configured' });
res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.post('/subscribe', authMiddleware, async (req, res) => {
try {
const { endpoint, keys } = req.body || {};
if (!endpoint || !keys || !keys.p256dh || !keys.auth) return res.status(400).json({ error: 'Некорректная push-подписка' });
await pool.query(
`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, p256dh=$3, auth=$4`,
[req.user.id, endpoint, keys.p256dh, keys.auth]
);
res.json({ ok: true });
} catch (err) {
console.error('Push subscribe error:', err.message);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

router.post('/unsubscribe', authMiddleware, async (req, res) => {
try {
const { endpoint } = req.body || {};
if (!endpoint) return res.status(400).json({ error: 'Укажите endpoint' });
await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [endpoint, req.user.id]);
res.json({ ok: true });
} catch (err) {
console.error('Push unsubscribe error:', err.message);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

module.exports = router;
