const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// Личный дашборд статистики (2026-07-10) — раньше у пользователя не было никакого
// сводного представления о своей активности на бирже, только лента грузов.
// Разная статистика для перевозчика (выручка, отклики) и грузовладельца (траты, грузы) —
// у них принципиально разные метрики успеха.
router.get('/me', async (req, res) => {
try {
const userId = req.user.id;
const { rows: userRows } = await pool.query(
'SELECT role, completed_deliveries, created_at, subscription_until, subscription_tier FROM users WHERE id=$1',
[userId]
);
if (!userRows.length) return res.status(404).json({ error: 'Не найден' });
const me = userRows[0];
// Расширенная аналитика (график по месяцам) — перк тарифов Pro/Business, а не
// всех платящих одинаково (2026-07-10, см. распределение фич по тарифам).
// Итоговые цифры (total_earnings и т.п.) остаются доступны всем — гейтится
// только помесячная разбивка.
const hasProAccess = me.subscription_until && new Date(me.subscription_until) > new Date() && ['pro', 'business'].includes(me.subscription_tier);

const { rows: ratingRows } = await pool.query(
'SELECT avg_overall, avg_punctuality, avg_cargo, avg_communication, total_reviews FROM user_ratings WHERE user_id=$1',
[userId]
);
const rating = ratingRows[0] || null;

if (me.role === 'carrier') {
const { rows: bidStats } = await pool.query(
`SELECT
COUNT(*)::int AS bids_sent,
COUNT(*) FILTER (WHERE status='accepted')::int AS bids_accepted
FROM bids WHERE carrier_id=$1`,
[userId]
);
const { rows: earningsRows } = await pool.query(
`SELECT COALESCE(SUM(b.price), 0)::numeric AS total_earnings
FROM bids b JOIN cargos c ON c.id = b.cargo_id
WHERE b.carrier_id=$1 AND b.status='accepted' AND c.status='delivered'`,
[userId]
);
let monthly = [];
if (hasProAccess) {
const { rows } = await pool.query(
`SELECT to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS month, SUM(b.price)::numeric AS total
FROM bids b JOIN cargos c ON c.id = b.cargo_id
WHERE b.carrier_id=$1 AND b.status='accepted' AND c.status='delivered'
AND c.created_at >= date_trunc('month', now()) - interval '5 months'
GROUP BY 1 ORDER BY 1`,
[userId]
);
monthly = rows;
}
const bids = bidStats[0];
res.json({
role: 'carrier',
completed_deliveries: me.completed_deliveries || 0,
rating,
bids_sent: bids.bids_sent,
bids_accepted: bids.bids_accepted,
acceptance_rate: bids.bids_sent ? Math.round((bids.bids_accepted / bids.bids_sent) * 100) : 0,
total_earnings: Number(earningsRows[0].total_earnings),
monthly_earnings: monthly.map(m => ({ month: m.month, total: Number(m.total) })),
monthly_earnings_locked: !hasProAccess,
});
} else {
const { rows: cargoStats } = await pool.query(
`SELECT
COUNT(*)::int AS cargos_posted,
COUNT(*) FILTER (WHERE status='delivered')::int AS cargos_delivered,
COUNT(*) FILTER (WHERE status='open')::int AS cargos_open,
COUNT(*) FILTER (WHERE status='in_transit')::int AS cargos_in_transit
FROM cargos WHERE owner_id=$1`,
[userId]
);
const { rows: spentRows } = await pool.query(
`SELECT COALESCE(SUM(b.price), 0)::numeric AS total_spent
FROM cargos c JOIN bids b ON b.id = c.accepted_bid_id
WHERE c.owner_id=$1 AND c.status='delivered'`,
[userId]
);
const { rows: monthly } = await pool.query(
`SELECT to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS month, SUM(b.price)::numeric AS total
FROM cargos c JOIN bids b ON b.id = c.accepted_bid_id
WHERE c.owner_id=$1 AND c.status='delivered'
AND c.created_at >= date_trunc('month', now()) - interval '5 months'
GROUP BY 1 ORDER BY 1`,
[userId]
);
const cargoS = cargoStats[0];
res.json({
role: 'shipper',
cargos_posted: cargoS.cargos_posted,
cargos_delivered: cargoS.cargos_delivered,
cargos_open: cargoS.cargos_open,
cargos_in_transit: cargoS.cargos_in_transit,
rating,
total_spent: Number(spentRows[0].total_spent),
monthly_spending: monthly.map(m => ({ month: m.month, total: Number(m.total) })),
});
}
} catch (err) {
console.error('Stats error:', err.message);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

module.exports = router;
