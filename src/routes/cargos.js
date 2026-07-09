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

// Freemium-этап (2026-07-08, по решению пользователя после сравнения тарифных моделей):
// перевозчик без активной подписки получает FREE_BIDS_PER_MONTH бесплатных откликов в
// текущем календарном месяце вместо полного paywall. Подписка (9000 ₸) остаётся безлимитной.
const FREE_BIDS_PER_MONTH = 3;
async function countBidsThisMonth(carrierId) {
const { rows } = await pool.query(
"SELECT COUNT(*)::int AS cnt FROM bids WHERE carrier_id=$1 AND created_at >= date_trunc('month', now())",
[carrierId]
);
return rows[0].cnt;
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
const missingFields = [];
if (!from_city) missingFields.push('from_city');
if (!to_city) missingFields.push('to_city');
if (!weight_tons) missingFields.push('weight_tons');
if (!cargo_type) missingFields.push('cargo_type');
if (!pickup_date) missingFields.push('pickup_date');
if (missingFields.length) return res.status(400).json({ error: 'Не заполнены обязательные поля: ' + missingFields.join(', ') + '. Обязательны: from_city, to_city, weight_tons (число, тонны), cargo_type (строка), pickup_date (YYYY-MM-DD). Необязательны: price, volume_m3, comment.', missing_fields: missingFields });
if (isNaN(Number(weight_tons)) || Number(weight_tons) <= 0) return res.status(400).json({ error: 'weight_tons должен быть положительным числом' });
if (isNaN(Date.parse(pickup_date))) return res.status(400).json({ error: 'pickup_date должен быть в формате YYYY-MM-DD' });
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

// Просмотр одного груза. Логируем просмотр от перевозчиков — питает "Кто смотрел мой груз".
router.get('/:id', async (req, res) => {
try {
const { rows } = await pool.query(`
SELECT c.*, u.name AS owner_name, u.phone AS owner_phone, u.company_name AS owner_company, u.verified AS owner_verified
FROM cargos c JOIN users u ON u.id = c.owner_id WHERE c.id=$1
`, [req.params.id]);
if (!rows.length) return res.status(404).json({ error: 'Груз не найден' });
const cargo = rows[0];
if (req.user.role !== 'shipper' || cargo.owner_id !== req.user.id) {
if (req.user.role === 'carrier') {
await pool.query('INSERT INTO cargo_views (cargo_id, viewer_id) VALUES ($1,$2)', [req.params.id, req.user.id]).catch(() => {});
}
}
const hideContacts = req.user.role === 'carrier' && cargo.owner_id !== req.user.id && !(await carrierHasSub(req.user.id));
if (hideContacts) { cargo.owner_phone = null; cargo.contacts_locked = true; }
res.json(cargo);
} catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// "Кто смотрел мой груз" — доступно только владельцу груза.
router.get('/:id/viewers', async (req, res) => {
try {
const { rows: cargo } = await pool.query('SELECT owner_id FROM cargos WHERE id=$1', [req.params.id]);
if (!cargo.length) return res.status(404).json({ error: 'Груз не найден' });
if (cargo[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });
const { rows } = await pool.query(`
SELECT u.id, u.name, u.company_name, u.verified, u.rating, MAX(v.viewed_at) AS last_viewed_at, COUNT(*)::int AS view_count
FROM cargo_views v JOIN users u ON u.id = v.viewer_id
WHERE v.cargo_id=$1
GROUP BY u.id, u.name, u.company_name, u.verified, u.rating
ORDER BY last_viewed_at DESC
`, [req.params.id]);
res.json({ total_views: rows.reduce((s, r) => s + r.view_count, 0), unique_viewers: rows.length, viewers: rows });
} catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
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
const hasSub = await carrierHasSub(req.user.id);
let freeBidsUsed = 0;
if (!hasSub) {
freeBidsUsed = await countBidsThisMonth(req.user.id);
if (freeBidsUsed >= FREE_BIDS_PER_MONTH) {
return res.status(403).json({
error: 'Бесплатные отклики закончились (' + FREE_BIDS_PER_MONTH + '/мес). Оформите подписку для безлимитных откликов.',
code: 'free_limit_reached',
free_bids_used: freeBidsUsed,
free_bids_limit: FREE_BIDS_PER_MONTH
});
}
}
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
const responseBody = { ...rows[0] };
if (!hasSub) {
responseBody.free_bids_used = freeBidsUsed + 1;
responseBody.free_bids_remaining = Math.max(0, FREE_BIDS_PER_MONTH - (freeBidsUsed + 1));
}
res.status(201).json(responseBody);
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
await pool.query("UPDATE bids SET status='rejected', updated_at=now() WHERE cargo_id=$1 AND id!=$2", [req.params.id, req.params.bidId]);
// updated_at здесь — момент принятия ставки, от него reviews.js отсчитывает 48-часовое
// окно для отзыва (см. FIX в src/index.js runMigrations).
await pool.query("UPDATE bids SET status='accepted', updated_at=now() WHERE id=$1", [req.params.bidId]);
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

// Реальные координаты от водителя (навигация браузера/приложения), а не выдуманный прогресс.
// Заменяет "фейковый GPS" — конкурентный пробел, найденный при анализе рынка.
router.put('/:id/location', async (req, res) => {
try {
const { lat, lng } = req.body;
if (lat === undefined || lng === undefined) return res.status(400).json({ error: 'Укажите lat и lng' });
if (isNaN(Number(lat)) || isNaN(Number(lng)) || Math.abs(Number(lat)) > 90 || Math.abs(Number(lng)) > 180) {
return res.status(400).json({ error: 'Некорректные координаты' });
}
const { rows } = await pool.query("SELECT c.id FROM cargos c JOIN bids b ON b.id=c.accepted_bid_id WHERE c.id=$1 AND b.carrier_id=$2 AND c.status='in_transit'", [req.params.id, req.user.id]);
if (!rows.length) return res.status(403).json({ error: 'Нет доступа' });
await pool.query('UPDATE cargos SET current_lat=$1, current_lng=$2, location_updated_at=now() WHERE id=$3', [lat, lng, req.params.id]);
res.json({ ok: true });
} catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Текущее местоположение груза — для отображения на карте у грузовладельца.
router.get('/:id/location', async (req, res) => {
try {
const { rows } = await pool.query('SELECT current_lat, current_lng, location_updated_at FROM cargos WHERE id=$1', [req.params.id]);
if (!rows.length) return res.status(404).json({ error: 'Груз не найден' });
if (!rows[0].current_lat) return res.json({ available: false });
res.json({ available: true, lat: rows[0].current_lat, lng: rows[0].current_lng, updated_at: rows[0].location_updated_at });
} catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.get('/:id/events', async (req, res) => {
try {
const { rows } = await pool.query('SELECT label, created_at FROM tracking_events WHERE cargo_id=$1 ORDER BY created_at ASC', [req.params.id]);
res.json(rows);
} catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

module.exports = router;
