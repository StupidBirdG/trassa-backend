const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

router.use(authMiddleware, adminMiddleware);

// ─── Пользователи ──────────────────────────────────────────────────────────

router.get('/users', async (req, res) => {
  try {
    const { search, role, banned } = req.query;
    const params = [];
    const conds = [];
    if (search) {
      params.push('%' + search.trim() + '%');
      conds.push('(name ILIKE $' + params.length + ' OR email ILIKE $' + params.length + ' OR phone ILIKE $' + params.length + ' OR company_name ILIKE $' + params.length + ')');
    }
    if (role === 'carrier' || role === 'shipper') { params.push(role); conds.push('role = $' + params.length); }
    if (banned === 'true') conds.push('banned = TRUE');
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await pool.query(`
      SELECT id, name, email, phone, role, company_name, verified, bin_verified, banned, banned_reason,
             is_admin, rating, completed_deliveries, subscription_until, subscription_tier, created_at
      FROM users ${where}
      ORDER BY created_at DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.put('/users/:id/ban', async (req, res) => {
  try {
    const { banned, reason } = req.body;
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Нельзя заблокировать самого себя' });
    const { rows } = await pool.query(
      'UPDATE users SET banned=$1, banned_reason=$2, banned_at=CASE WHEN $1 THEN now() ELSE NULL END WHERE id=$3 RETURNING id, name, banned, banned_reason',
      [banned === true, banned === true ? (reason || null) : null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.put('/users/:id/verify', async (req, res) => {
  try {
    const { verified } = req.body;
    const { rows } = await pool.query('UPDATE users SET verified=$1 WHERE id=$2 RETURNING id, name, verified', [verified === true, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ─── Грузы ──────────────────────────────────────────────────────────────────

router.get('/cargos', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    const conds = [];
    if (status) { params.push(status); conds.push('c.status = $' + params.length); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await pool.query(`
      SELECT c.id, c.from_city, c.to_city, c.status, c.price, c.price_on_request, c.created_at,
             u.name AS owner_name, u.email AS owner_email, u.id AS owner_id
      FROM cargos c JOIN users u ON u.id = c.owner_id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.delete('/cargos/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM cargos WHERE id=$1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Груз не найден' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ─── Статистика ─────────────────────────────────────────────────────────────

router.get('/stats', async (req, res) => {
  try {
    const [users, cargos, subs, banned] = await Promise.all([
      pool.query("SELECT role, COUNT(*)::int AS cnt FROM users GROUP BY role"),
      pool.query("SELECT status, COUNT(*)::int AS cnt FROM cargos GROUP BY status"),
      pool.query("SELECT subscription_tier, COUNT(*)::int AS cnt FROM users WHERE subscription_until > now() GROUP BY subscription_tier"),
      pool.query("SELECT COUNT(*)::int AS cnt FROM users WHERE banned = TRUE"),
    ]);
    res.json({
      users_by_role: users.rows,
      cargos_by_status: cargos.rows,
      active_subscriptions_by_tier: subs.rows,
      banned_users: banned.rows[0].cnt,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

module.exports = router;
