const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { notifyByUserId, notifyAllCarriers } = require('../services/telegram');

router.use(authMiddleware);

async function carrierHasSub(userId) {
const { rows } = await pool.query('SELECT subscription_until FROM users WHERE id=$1', [userId]);
const until = rows[0] && rows[0].subscription_until;
return until && new Date(until) > new Date();
}

router.get('/', async (req, res) => {
try {
const { from, to } = req.query;
const user = req.user;
const params = [user.id];
let roleCondition;

if (user.role === 'shipper') {
roleCondition = 'c.owner_id = $1';
} else {
roleCondition = "(c.status = 'open' OR b_my.carrier_id = $1)";
}

const extraConds = [];
if (from) { params.push(from); extraConds.push('c.from_city = $' + params.length); }
if (to) { params.push(to); extraConds.push('c.to_city = $' + params.length); }

const where = 'WHERE ' + [roleCondition, ...extraConds].join(' AND ');

const { rows } = await pool.query(`
SELECT c.*,
u.name AS owner_name, u.phone AS owner_phone, u.company_name AS owner_company, u.verified AS owner_verified,
(SELECT label FROM tracking_events WHERE cargo_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_event,
(SELECT created_at FROM tracking_events WHERE cargo_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_ping
FROM cargos c
JOIN users u ON u.id = c.owner_id
LEFT JOIN bids b_my ON b_my.cargo_id = c.id AND b_my.carrier_id = $1
${where}
ORDER BY c.created_at DESC
`, params);

let bids = [];
if (rows.length) {
const { rows: bidRows } = await pool.query(`
SELECT b.*, u.name AS carrier_name, u.phone AS carrier_phone, u.company_name, u.verified AS carrier_verified
FROM bids b JOIN users u ON u.id = b.carrier_id
WHERE b.cargo_id = ANY($1) ORDER BY b.created_at ASC
`, [rows.map(r => r.id)]);
bids = bidRows;
}

const hideContacts = user.role === 'carrier' && !(await carrierHasSub(user.id));

res.json(rows.map(cargo => {
const item = { ...cargo, bids: bids.filter(b => b.cargo_id === cargo.id) };
if (hideContacts) { item.owner_phone = null; item.contacts_locked = true; }
return item;
}));
} catch (err) {
console.error(err);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

router.post('/', async (req, res) => {
if (req.user.role !== 'shipper') return res.status(403).json({ error: 'Только грузовладелец может публиковать грузы' });
const { from_city, to_city, weight_tons, cargo_type, pickup_date, price, comment, volume_m3 } = req.body;
if (!from_city || !to_city || !weight_tons || !cargo_type || !pickup_date)
return res.status(400).json({ error: 'Заполните все обязательные поля' });
const priceOnRequest = !price;
const vol = volume_m3 ? Number(volume_m3) : null;
try {
const { rows } = await pool.query(
'INSERT INTO cargos (owner_id, from_city, to_city, weight_tons, cargo_type, pickup_date, price, price_on_request, comment, volume_m3) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
[req.user.id, from_city, to_city, weight_tons, cargo_type, pickup_date, price || null, priceOnRequest, comment || null, vol]
);
await pool.query('INSERT INTO tracking_events (cargo_id, label) VALUES ($1,$2)', [rows[0].id, 'Груз опубликован на бирже']);
notifyAllCarriers(pool, rows[0]).catch(() => {});
res.status(201).json({ ...rows[0], bids: [] });
} catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка создания груза' }); }
});

router.delete('/:id', async (req, res) => {
try {
const { rows } = await pool.query('SELECT * FROM cargos WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
if (!rows.length) return res.status(404).json({ error: 'Груз не найден' });
if (rows[0].status !== 'open') return res.status(400).json({ error: 'Нельзя отменить' });
await pool.query("UPDATE cargos SET status='cancelled' WHERE id=$1", [req.params.id]);
res.json({ ok: true });
} catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/:id/bids', async (req, res) => {
if (req.user.role !== 'carrier') return res.status(403).json({ error: 'Только перевозчик может откликаться' });
if (!(await carrierHasSub(req.user.id))) return res.status(403).json({ error: 'Нужна подписка', code: 'subscription_required' });
const { truck_type, price } = req.body;
if (!truck_type || !price) return res.status(400).json({ error: 'Укажите truck_type и price' });
try {
const { rows: cargo } = await pool.query('SELECT * FROM cargos WHERE id=$1', [req.params.id]);
if (!cargo.length) return res.status(404).json({ error: 'Груз не найден' });
if (cargo[0].status !== 'open') return res.status(400).json({ error: 'Груз не принимает ставки' });
const { rows: ex } = await pool.query('SELECT id FROM bids WHERE cargo_id=$1 AND carrier_id=$2', [req.params.id, req.user.id]);
if (ex.length) return res.status(409).json({ error: 'Вы уже откликнулись' });
const { rows } = await pool.query('INSERT INTO bids (cargo_id, carrier_id, truck_type, price) VALUES ($1,$2,$3,$4) RETURNING *', [req.params.id, req.user.id, truck_type, price]);
const c = cargo[0];
notifyByUserId(pool, c.owner_id, '🚚 Новый отклик на груз ' + c.from_city + ' → ' + c.to_city + '\nЦена: ' + Number(price).toLocaleString('ru-RU') + ' ₸ (' + truck_type + ')').catch(() => {});
res.status(201).json(rows[0]);
} catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/:id/accept/:bidId', async (req, res) => {
try {
const { rows: cargo } = await pool.query('SELECT * FROM cargos WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
if (!cargo.length) return res.status(404).json({ error: 'Груз не найден' });
if (cargo[0].status !== 'open') return res.status(400).json({ error: 'Груз не в статусе open' });
const { rows: bid } = await pool.query('SELECT b.*, u.name FROM bids b JOIN users u ON u.id=b.carrier_id WHERE b.id=$1 AND b.cargo_id=$2', [req.params.bidId, req.params.id]);
if (!bid.length) return res.status(404).json({ error: 'Ставка не найдена' });
await pool.query("UPDATE cargos SET status='in_transit', accepted_bid_id=$1, progress=2 WHERE id=$2", [req.params.bidId, req.params.id]);
await pool.query("UPDATE bids SET status='rejected' WHERE cargo_id=$1 AND id!=$2", [req.params.id, req.params.bidId]);
await pool.query("UPDATE bids SET status='accepted' WHERE id=$1", [req.params.bidId]);
await pool.query('INSERT INTO tracking_events (cargo_id, label) VALUES ($1,$2),($1,$3)', [req.params.id, 'Предложение принято', 'Перевозчик выехал из ' + cargo[0].from_city]);
notifyByUserId(pool, bid[0].carrier_id, '✅ Ваше предложение принято! Груз ' + cargo[0].from_city + ' → ' + cargo[0].to_city).catch(() => {});
res.json({ ok: true });
} catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/:id/deliver', async (req, res) => {
try {
const { rows } = await pool.query('SELECT * FROM cargos WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id]);
if (!rows.length) return res.status(404).json({ error: 'Груз не найден' });
if (rows[0].status !== 'in_transit') return res.status(400).json({ error: 'Груз не в пути' });
await pool.query("UPDATE cargos SET status='delivered', progress=100 WHERE id=$1", [req.params.id]);
await pool.query('INSERT INTO tracking_events (cargo_id, label) VALUES ($1,$2)', [req.params.id, 'Доставлено в ' + rows[0].to_city]);
if (rows[0].accepted_bid_id) {
await pool.query('UPDATE users SET completed_deliveries=completed_deliveries+1 WHERE id=(SELECT carrier_id FROM bids WHERE id=$1)', [rows[0].accepted_bid_id]);
}
res.json({ ok: true });
} catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/:id/ping', async (req, res) => {
try {
const { rows } = await pool.query("SELECT c.*, b.carrier_id FROM cargos c JOIN bids b ON b.id=c.accepted_bid_id WHERE c.id=$1 AND b.carrier_id=$2 AND c.status='in_transit'", [req.params.id, req.user.id]);
if (!rows.length) return res.status(403).json({ error: 'Нет доступа' });
const newProgress = Math.min(94, (rows[0].progress || 0) + Number(req.body.progress_delta || 5));
await pool.query('UPDATE cargos SET progress=$1 WHERE id=$2', [newProgress, req.params.id]);
await pool.query('INSERT INTO tracking_events (cargo_id, label) VALUES ($1,$2)', [req.params.id, 'GPS: местоположение обновлено']);
res.json({ ok: true, progress: newProgress });
} catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.get('/:id/events', async (req, res) => {
try {
const { rows } = await pool.query('SELECT label, created_at FROM tracking_events WHERE cargo_id=$1 ORDER BY created_at ASC', [req.params.id]);
res.json(rows);
} catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

module.exports = router;
