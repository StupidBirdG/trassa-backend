const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// ─── POST /api/disputes — пожаловаться на контрагента по сделке ──────────────
// Без денежного эскроу (нет ИП для реального удержания средств) это единственная
// доступная сейчас защита: жалоба видна админу, у ответчика формируется история
// споров, админ может забанить нарушителя (см. POST /api/admin/users/:id/ban).
router.post('/', async (req, res) => {
  const { bid_id, reason, description } = req.body;

  if (!bid_id || !reason) {
    return res.status(400).json({ error: 'bid_id и reason обязательны' });
  }

  try {
    const { rows: bidRows } = await pool.query(
      `SELECT b.*, c.owner_id AS shipper_id, c.from_city, c.to_city
       FROM bids b
       JOIN cargos c ON c.id = b.cargo_id
       WHERE b.id = $1 AND b.status = 'accepted'`,
      [bid_id]
    );
    if (!bidRows.length) return res.status(404).json({ error: 'Сделка не найдена или ещё не принята' });

    const bid = bidRows[0];
    const isShipper = bid.shipper_id === req.user.id;
    const isCarrier = bid.carrier_id === req.user.id;
    if (!isShipper && !isCarrier) return res.status(403).json({ error: 'Вы не участник этой сделки' });

    const respondentId = isShipper ? bid.carrier_id : bid.shipper_id;

    const { rows } = await pool.query(
      `INSERT INTO disputes (bid_id, cargo_id, complainant_id, respondent_id, reason, description)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [bid_id, bid.cargo_id, req.user.id, respondentId, reason, description || null]
    );

    res.status(201).json({ success: true, dispute: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Вы уже подавали жалобу по этой сделке' });
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/disputes/mine — мои споры (как жалобщик или ответчик) ──────────
router.get('/mine', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, c.from_city, c.to_city,
              cu.name AS complainant_name, ru.name AS respondent_name
       FROM disputes d
       JOIN cargos c ON c.id = d.cargo_id
       JOIN users cu ON cu.id = d.complainant_id
       JOIN users ru ON ru.id = d.respondent_id
       WHERE d.complainant_id = $1 OR d.respondent_id = $1
       ORDER BY d.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/disputes/bid/:bidId — есть ли уже жалоба по этой сделке ────────
router.get('/bid/:bidId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, c.owner_id AS shipper_id FROM bids b JOIN cargos c ON c.id = b.cargo_id WHERE b.id = $1`,
      [req.params.bidId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Сделка не найдена' });
    const bid = rows[0];
    if (bid.shipper_id !== req.user.id && bid.carrier_id !== req.user.id) {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    const { rows: disputeRows } = await pool.query(
      'SELECT id, status, reason, created_at FROM disputes WHERE bid_id = $1 AND complainant_id = $2',
      [req.params.bidId, req.user.id]
    );
    res.json({ already_filed: disputeRows.length > 0, dispute: disputeRows[0] || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
