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

// Публичный каталог компаний — конкурентная фича (есть у Cargo.kz, Adista).
// Только базовая репутационная информация, без телефона/email — контакты остаются platform-gated.
router.get('/companies', async (req, res) => {
  try {
    const { role, verified_only } = req.query;
    const params = [];
    const conds = ["company_name IS NOT NULL", "company_name <> ''"];
    if (role === 'carrier' || role === 'shipper') { params.push(role); conds.push('role = $' + params.length); }
    if (verified_only === 'true') { conds.push('verified = TRUE'); }
    const { rows } = await pool.query(`
      SELECT id, name, company_name, role, verified, bin_verified, rating, completed_deliveries, truck_type, created_at
      FROM users
      WHERE ${conds.join(' AND ')}
      ORDER BY verified DESC, rating DESC NULLS LAST, completed_deliveries DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Публичная средняя цена по маршруту — без авторизации, в отличие от /api/ai/suggest-price.
// Часть "полноценных торгов": рыночная прозрачность (как у ATI.SU/Traffic.kz), видна
// даже незарегистрированным посетителям сайта — снижает asymmetry цены до входа в биржу.
router.get('/route-price', async (req, res) => {
  try {
    const { from_city, to_city } = req.query;
    if (!from_city || !to_city) return res.status(400).json({ error: 'Укажите from_city и to_city' });
    const { rows } = await pool.query(`
      SELECT price FROM cargos
      WHERE lower(from_city)=lower($1) AND lower(to_city)=lower($2)
        AND price IS NOT NULL AND price_on_request = FALSE
      ORDER BY created_at DESC LIMIT 50
    `, [from_city, to_city]);
    if (!rows.length) return res.json({ available: false });
    const prices = rows.map(r => Number(r.price)).filter(p => p > 0);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    res.json({
      available: true,
      sample_size: prices.length,
      avg: Math.round(avg),
      min: Math.round(Math.min(...prices)),
      max: Math.round(Math.max(...prices)),
      currency: 'KZT'
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
