const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Публичная статистика биржи — без авторизации
router.get('/stats', async (req, res) => {
  try {
    const { rows: cargoRows } = await pool.query("SELECT COUNT(*)::int AS cnt FROM cargos WHERE status='open'");
    const { rows: carrierRows } = await pool.query("SELECT COUNT(*)::int AS cnt FROM users WHERE role='carrier' AND subscription_until > now()");
    const { rows: routeRows } = await pool.query("SELECT COUNT(DISTINCT from_city || '-' || to_city)::int AS cnt FROM cargos");
    res.json({
      openCargos: cargoRows[0].cnt,
      activeCarriers: carrierRows[0].cnt,
      routes: routeRows[0].cnt
    });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Топ популярных маршрутов по количеству активных грузов
router.get('/routes', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT from_city, to_city, COUNT(*)::int AS cnt
      FROM cargos
      WHERE status IN ('open','in_transit')
      GROUP BY from_city, to_city
      ORDER BY cnt DESC
      LIMIT 8
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
