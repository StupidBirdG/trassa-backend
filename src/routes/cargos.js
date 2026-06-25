const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

// Все эндпоинты грузов требуют авторизации
router.use(authMiddleware);

/**
 * GET /api/cargos
 * Для грузовладельца — свои грузы.
 * Для перевозчика — все открытые + его активные.
 * Фильтры: ?from=Алматы&to=Шымкент&status=open
 */
router.get('/', async (req, res) => {
  try {
    const { from, to, status } = req.query;
    const user = req.user;
    const params = [];
    const conditions = [];

    if (user.role === 'shipper') {
      params.push(user.id);
      conditions.push(`c.owner_id = $${params.length}`);
    } else {
      // Перевозчик видит открытые + свои активные грузы
      params.push(user.id);
      conditions.push(`(c.status = 'open' OR (b_my.carrier_id = $${params.length}))`);
    }

    if (from)   { params.push(from);   conditions.push(`c.from_city = $${params.length}`); }
    if (to)     { params.push(to);     conditions.push(`c.to_city = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`c.status = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT
        c.*,
        u.name        AS owner_name,
        u.phone       AS owner_phone,
        u.company_name AS owner_company,
        -- прогресс трекинга
        c.progress,
        -- последнее событие трекинга
        (SELECT label FROM tracking_events WHERE cargo_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_event,
        (SELECT created_at FROM tracking_events WHERE cargo_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_ping
      FROM cargos c
      JOIN users u ON u.id = c.owner_id
      LEFT JOIN bids b_my ON b_my.cargo_id = c.id AND b_my.carrier_id = $1
      ${where}
      ORDER BY c.created_at DESC
    `, params);

    // Подтягиваем ставки для каждого груза
    const cargoIds = rows.map(r => r.id);
    let bids = [];
    if (cargoIds.length > 0) {
      const { rows: bidRows } = await pool.query(`
        SELECT b.*, u.name AS carrier_name, u.phone AS carrier_phone, u.rating, u.company_name
        FROM bids b
        JOIN users u ON u.id = b.carrier_id
        WHERE b.cargo_id = ANY($1)
        ORDER BY b.created_at ASC
      `, [cargoIds]);
      bids = bidRows;
    }

    const result = rows.map(cargo => ({
      ...cargo,
      bids: bids.filter(b => b.cargo_id === cargo.id),
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * POST /api/cargos — создать груз (только shipper)
 */
router.post('/', async (req, res) => {
  if (req.user.role !== 'shipper') {
    return res.status(403).json({ error: 'Только грузовладелец может публиковать грузы' });
  }

  const { from_city, to_city, weight_tons, cargo_type, pickup_date, price, comment } = req.body;
  if (!from_city || !to_city || !weight_tons || !cargo_type || !pickup_date || !price) {
    return res.status(400).json({ error: 'Заполните все обязательные поля' });
  }

  try {
    const { rows } = await pool.query(`
      INSERT INTO cargos (owner_id, from_city, to_city, weight_tons, cargo_type, pickup_date, price, comment)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [req.user.id, from_city, to_city, weight_tons, cargo_type, pickup_date, price, comment || null]);

    const cargo = rows[0];

    // Первое событие трекинга
    await pool.query(
      `INSERT INTO tracking_events (cargo_id, label) VALUES ($1, $2)`,
      [cargo.id, 'Груз опубликован на бирже']
    );

    res.status(201).json({ ...cargo, bids: [], trackingEvents: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка создания груза' });
  }
});

/**
 * DELETE /api/cargos/:id — отменить груз (только свой, только открытый)
 */
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM cargos WHERE id = $1 AND owner_id = $2`, [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Груз не найден' });
    if (rows[0].status !== 'open') return res.status(400).json({ error: 'Нельзя отменить груз не в статусе open' });

    await pool.query(`UPDATE cargos SET status = 'cancelled' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * POST /api/cargos/:id/bids — сделать ставку (только carrier)
 */
router.post('/:id/bids', async (req, res) => {
  if (req.user.role !== 'carrier') {
    return res.status(403).json({ error: 'Только перевозчик может откликаться' });
  }

  const { truck_type, price } = req.body;
  if (!truck_type || !price) return res.status(400).json({ error: 'Укажите truck_type и price' });

  try {
    const { rows: cargo } = await pool.query(
      `SELECT status FROM cargos WHERE id = $1`, [req.params.id]
    );
    if (!cargo.length) return res.status(404).json({ error: 'Груз не найден' });
    if (cargo[0].status !== 'open') return res.status(400).json({ error: 'Груз уже не принимает ставки' });

    // Нельзя дважды
    const { rows: existing } = await pool.query(
      `SELECT id FROM bids WHERE cargo_id = $1 AND carrier_id = $2`, [req.params.id, req.user.id]
    );
    if (existing.length) return res.status(409).json({ error: 'Вы уже откликнулись на этот груз' });

    const { rows } = await pool.query(`
      INSERT INTO bids (cargo_id, carrier_id, truck_type, price)
      VALUES ($1,$2,$3,$4)
      RETURNING *
    `, [req.params.id, req.user.id, truck_type, price]);

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * POST /api/cargos/:id/accept/:bidId — принять ставку (только owner груза)
 */
router.post('/:id/accept/:bidId', async (req, res) => {
  try {
    const { rows: cargo } = await pool.query(
      `SELECT * FROM cargos WHERE id = $1 AND owner_id = $2`, [req.params.id, req.user.id]
    );
    if (!cargo.length) return res.status(404).json({ error: 'Груз не найден' });
    if (cargo[0].status !== 'open') return res.status(400).json({ error: 'Груз не в статусе open' });

    const { rows: bid } = await pool.query(
      `SELECT b.*, u.name FROM bids b JOIN users u ON u.id = b.carrier_id WHERE b.id = $1 AND b.cargo_id = $2`,
      [req.params.bidId, req.params.id]
    );
    if (!bid.length) return res.status(404).json({ error: 'Ставка не найдена' });

    // Обновляем груз
    await pool.query(`
      UPDATE cargos SET status = 'in_transit', accepted_bid_id = $1, progress = 2
      WHERE id = $2
    `, [req.params.bidId, req.params.id]);

    // Отклоняем остальные ставки
    await pool.query(`
      UPDATE bids SET status = 'rejected'
      WHERE cargo_id = $1 AND id != $2
    `, [req.params.id, req.params.bidId]);

    await pool.query(`UPDATE bids SET status = 'accepted' WHERE id = $1`, [req.params.bidId]);

    // Трекинг-события
    await pool.query(
      `INSERT INTO tracking_events (cargo_id, label) VALUES ($1,$2),($1,$3)`,
      [req.params.id,
       'Предложение принято',
       `Перевозчик выехал из ${cargo[0].from_city} (${bid[0].name})`]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * POST /api/cargos/:id/deliver — отметить доставленным (только owner)
 */
router.post('/:id/deliver', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM cargos WHERE id = $1 AND owner_id = $2`, [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Груз не найден' });
    if (rows[0].status !== 'in_transit') return res.status(400).json({ error: 'Груз не в пути' });

    await pool.query(
      `UPDATE cargos SET status = 'delivered', progress = 100 WHERE id = $1`, [req.params.id]
    );

    await pool.query(
      `INSERT INTO tracking_events (cargo_id, label) VALUES ($1, $2)`,
      [req.params.id, `Доставлено в ${rows[0].to_city}`]
    );

    // Инкремент completed_deliveries перевозчика
    if (rows[0].accepted_bid_id) {
      await pool.query(`
        UPDATE users SET completed_deliveries = completed_deliveries + 1
        WHERE id = (SELECT carrier_id FROM bids WHERE id = $1)
      `, [rows[0].accepted_bid_id]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * POST /api/cargos/:id/ping — обновить GPS-прогресс (только carrier)
 */
router.post('/:id/ping', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, b.carrier_id FROM cargos c
      JOIN bids b ON b.id = c.accepted_bid_id
      WHERE c.id = $1 AND b.carrier_id = $2 AND c.status = 'in_transit'
    `, [req.params.id, req.user.id]);

    if (!rows.length) return res.status(403).json({ error: 'Нет доступа' });

    const { progress_delta = 5 } = req.body;
    const newProgress = Math.min(94, (rows[0].progress || 0) + Number(progress_delta));

    await pool.query(
      `UPDATE cargos SET progress = $1 WHERE id = $2`, [newProgress, req.params.id]
    );

    await pool.query(
      `INSERT INTO tracking_events (cargo_id, label) VALUES ($1, $2)`,
      [req.params.id, 'GPS: местоположение обновлено']
    );

    res.json({ ok: true, progress: newProgress });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/**
 * GET /api/cargos/:id/events — история трекинга
 */
router.get('/:id/events', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT label, created_at FROM tracking_events WHERE cargo_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
