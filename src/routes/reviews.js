const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// ─── Вспомогательная функция пересчёта рейтинга ───────────────────────────────
async function recalcRating(userId) {
  await pool.query(`
    INSERT INTO user_ratings (user_id, avg_overall, avg_punctuality, avg_cargo, avg_communication, total_reviews, updated_at)
    SELECT
      reviewee_id,
      ROUND(AVG(rating_overall)::numeric, 2),
      ROUND(AVG(rating_punctuality)::numeric, 2),
      ROUND(AVG(rating_cargo)::numeric, 2),
      ROUND(AVG(rating_communication)::numeric, 2),
      COUNT(*),
      NOW()
    FROM reviews
    WHERE reviewee_id = $1
    GROUP BY reviewee_id
    ON CONFLICT (user_id) DO UPDATE SET
      avg_overall = EXCLUDED.avg_overall,
      avg_punctuality = EXCLUDED.avg_punctuality,
      avg_cargo = EXCLUDED.avg_cargo,
      avg_communication = EXCLUDED.avg_communication,
      total_reviews = EXCLUDED.total_reviews,
      updated_at = NOW()
  `, [userId]);
}

// ─── POST /api/reviews — оставить отзыв ───────────────────────────────────────
router.post('/', async (req, res) => {
  const { order_id, rating_overall, rating_punctuality, rating_cargo, rating_communication, comment } = req.body;

  if (!order_id || !rating_overall) {
    return res.status(400).json({ error: 'order_id и rating_overall обязательны' });
  }
  if (rating_overall < 1 || rating_overall > 5) {
    return res.status(400).json({ error: 'Оценка должна быть от 1 до 5' });
  }

  try {
    // 1. Найти заявку и проверить участие пользователя
    const { rows: bidRows } = await pool.query(
      `SELECT b.*, c.owner_id AS shipper_id
       FROM bids b
       JOIN cargos c ON c.id = b.cargo_id
       WHERE b.id = $1 AND b.status = 'accepted'`,
      [order_id]
    );

    if (!bidRows.length) {
      return res.status(404).json({ error: 'Заявка не найдена или не принята' });
    }

    const bid = bidRows[0];
    const isShipper = bid.shipper_id === req.user.id;
    const isCarrier = bid.carrier_id === req.user.id;

    if (!isShipper && !isCarrier) {
      return res.status(403).json({ error: 'Вы не участник этой сделки' });
    }

    // 2. Проверить окно 48 часов после принятия заявки
    const accepted = new Date(bid.updated_at);
    if (Date.now() - accepted > 48 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Окно для отзыва истекло (48 часов)' });
    }

    const reviewer_role = isShipper ? 'shipper' : 'carrier';
    const reviewee_id = isShipper ? bid.carrier_id : bid.shipper_id;

    // 3. Сохранить отзыв (UNIQUE гарантирует один отзыв с каждой стороны)
    const { rows } = await pool.query(
      `INSERT INTO reviews
         (order_id, reviewer_id, reviewee_id, reviewer_role,
          rating_overall, rating_punctuality, rating_cargo, rating_communication, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [order_id, req.user.id, reviewee_id, reviewer_role,
       rating_overall, rating_punctuality || null, rating_cargo || null,
       rating_communication || null, comment || null]
    );

    // 4. Пересчитать агрегированный рейтинг получателя
    await recalcRating(reviewee_id);

    res.status(201).json({ success: true, review: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Вы уже оставили отзыв по этой сделке' });
    }
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/reviews/user/:id — отзывы пользователя + его рейтинг ───────────
router.get('/user/:id', async (req, res) => {
  const { id } = req.params;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  const offset = (page - 1) * limit;

  try {
    const [ratingResult, reviewsResult, countResult] = await Promise.all([
      pool.query('SELECT * FROM user_ratings WHERE user_id = $1', [id]),
      pool.query(
        `SELECT r.*, u.name AS reviewer_name
         FROM reviews r
         JOIN users u ON u.id = r.reviewer_id
         WHERE r.reviewee_id = $1
         ORDER BY r.created_at DESC
         LIMIT $2 OFFSET $3`,
        [id, limit, offset]
      ),
      pool.query('SELECT COUNT(*) FROM reviews WHERE reviewee_id = $1', [id]),
    ]);

    res.json({
      rating: ratingResult.rows[0] || null,
      reviews: reviewsResult.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ─── GET /api/reviews/order/:id — можно ли оставить отзыв по заявке ──────────
router.get('/order/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { rows: bidRows } = await pool.query(
      `SELECT b.*, c.owner_id AS shipper_id
       FROM bids b
       JOIN cargos c ON c.id = b.cargo_id
       WHERE b.id = $1 AND b.status = 'accepted'`,
      [id]
    );

    if (!bidRows.length) {
      return res.status(404).json({ error: 'Заявка не найдена' });
    }

    const bid = bidRows[0];
    const isParticipant = bid.shipper_id === req.user.id || bid.carrier_id === req.user.id;
    if (!isParticipant) {
      return res.status(403).json({ error: 'Нет доступа' });
    }

    // Уже оставил ли отзыв текущий пользователь
    const { rows: existing } = await pool.query(
      'SELECT id FROM reviews WHERE order_id = $1 AND reviewer_id = $2',
      [id, req.user.id]
    );

    const accepted = new Date(bid.updated_at);
    const windowOpen = Date.now() - accepted < 48 * 60 * 60 * 1000;

    res.json({
      can_review: existing.length === 0 && windowOpen,
      already_reviewed: existing.length > 0,
      window_open: windowOpen,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
