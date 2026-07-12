const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const { grantReferralReward } = require('../services/referral');
const { addToBlocklist, removeFromBlocklist } = require('../services/banEvasion');

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
    // Чёрный список телефона/email/BIN — чтобы забаненный не мог просто
    // зарегистрироваться заново с теми же данными. При разбане список чистится.
    if (banned === true) await addToBlocklist(req.params.id);
    else await removeFromBlocklist(req.params.id);
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

// ─── Верификация документами ("документы вместо честного слова", 2026-07-10) ─
// Ручное подтверждение верификации выше остаётся (например для доверенных
// партнёров без документов) — этот блок добавляет доказательный путь: админ
// реально смотрит на загруженное фото документа перед тем как поставить галочку.

router.get('/verification-queue', async (req, res) => {
  try {
    const { status } = req.query;
    const st = ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
    const { rows } = await pool.query(`
      SELECT vd.id, vd.doc_type, vd.status, vd.mime_type, vd.rejection_reason, vd.created_at, vd.reviewed_at,
             u.id AS user_id, u.name AS user_name, u.company_name, u.role, u.email, u.phone
      FROM verification_documents vd JOIN users u ON u.id = vd.user_id
      WHERE vd.status=$1
      ORDER BY vd.created_at ASC
      LIMIT 100
    `, [st]);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Отдаёт сам файл (для просмотра в админке — <img src> или открыть PDF).
router.get('/verification/:id/file', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT file_data, mime_type FROM verification_documents WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Документ не найден' });
    res.setHeader('Content-Type', rows[0].mime_type);
    res.send(rows[0].file_data);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/verification/:id/approve', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM verification_documents WHERE id=$1 AND status='pending'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Документ не найден или уже обработан' });
    const doc = rows[0];
    await pool.query("UPDATE verification_documents SET status='approved', reviewed_by=$1, reviewed_at=now() WHERE id=$2", [req.user.id, doc.id]);
    await pool.query('UPDATE users SET verified=TRUE WHERE id=$1', [doc.user_id]);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/verification/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    const { rows } = await pool.query(
      "UPDATE verification_documents SET status='rejected', reviewed_by=$1, reviewed_at=now(), rejection_reason=$2 WHERE id=$3 AND status='pending' RETURNING id",
      [req.user.id, reason || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Документ не найден или уже обработан' });
    res.json({ ok: true });
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

// ─── Платежи (ручной Kaspi-перевод, пока нет ИП для агрегатора) ────────────

router.get('/payments', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    const conds = [];
    if (status === 'pending' || status === 'paid' || status === 'failed') { params.push(status); conds.push('p.status = $' + params.length); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await pool.query(`
      SELECT p.id, p.order_id, p.tier, p.amount, p.status, p.provider, p.created_at, p.paid_at, p.user_marked_paid_at,
             u.id AS user_id, u.name AS user_name, u.email AS user_email, u.phone AS user_phone
      FROM payments p JOIN users u ON u.id = p.user_id
      ${where}
      ORDER BY p.user_marked_paid_at DESC NULLS LAST, p.created_at DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// Подтверждает ручной Kaspi-перевод: помечает платёж оплаченным и продлевает/активирует
// подписку — та же логика продления, что и в автоматическом paybox-callback'е.
router.post('/payments/:id/confirm', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM payments WHERE id=$1 AND status='pending'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Платёж не найден или уже обработан' });
    const payment = rows[0];

    await pool.query("UPDATE payments SET status='paid', paid_at=now(), confirmed_by=$1 WHERE id=$2", [req.user.id, payment.id]);
    const { rows: userRows } = await pool.query('SELECT subscription_until, subscription_tier FROM users WHERE id=$1', [payment.user_id]);
    const cur = userRows[0] && userRows[0].subscription_until;
    const stillActive = cur && new Date(cur) > new Date();
    const sameTier = stillActive && userRows[0].subscription_tier === payment.tier;
    const base = sameTier ? 'subscription_until' : 'now()';
    await pool.query('UPDATE users SET subscription_until = ' + base + " + interval '30 days', subscription_tier=$2 WHERE id=$1", [payment.user_id, payment.tier]);

    await grantReferralReward(pool, payment.user_id);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/payments/:id/reject', async (req, res) => {
  try {
    const { rows } = await pool.query("UPDATE payments SET status='failed' WHERE id=$1 AND status='pending' RETURNING id", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Платёж не найден или уже обработан' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ─── Споры (non-monetary защита от мошенничества, пока нет эскроу) ─────────

router.get('/disputes', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    const conds = [];
    if (status === 'open' || status === 'resolved') { params.push(status); conds.push('d.status = $' + params.length); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await pool.query(`
      SELECT d.*, c.from_city, c.to_city,
             cu.name AS complainant_name, cu.email AS complainant_email,
             ru.name AS respondent_name, ru.email AS respondent_email, ru.banned AS respondent_banned
      FROM disputes d
      JOIN cargos c ON c.id = d.cargo_id
      JOIN users cu ON cu.id = d.complainant_id
      JOIN users ru ON ru.id = d.respondent_id
      ${where}
      ORDER BY d.status ASC, d.created_at DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/disputes/:id/resolve', async (req, res) => {
  try {
    const { resolution } = req.body;
    const { rows } = await pool.query(
      "UPDATE disputes SET status='resolved', resolution=$1, resolved_by=$2, resolved_at=now() WHERE id=$3 AND status='open' RETURNING id",
      [resolution || null, req.user.id, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Спор не найден или уже закрыт' });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ─── Агенты (обзвонщики) ────────────────────────────────────────────────────
// Каждый нанятый агент получает свою ссылку trassakz.com/?agent=CODE — видно
// в реальном времени, сколько регистраций/грузов/подписок реально пришло
// именно через него. Отдельно от referral_code (та система про награду
// существующим пользователям платформы, не про сдельную оплату сотрудникам).

router.get('/agents', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        a.id, a.name, a.code, a.active, a.created_at,
        COUNT(u.id) FILTER (WHERE u.role='shipper')::int AS shippers_registered,
        COUNT(u.id) FILTER (WHERE u.role='carrier')::int AS carriers_registered,
        COUNT(DISTINCT c.id)::int AS cargos_posted,
        COUNT(u.id) FILTER (WHERE u.role='carrier' AND u.subscription_until > now())::int AS carriers_subscribed
      FROM agents a
      LEFT JOIN users u ON u.agent_code = a.code
      LEFT JOIN cargos c ON c.owner_id = u.id
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `);
    res.json(rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/agents', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите имя агента' });
    let code;
    for (let i = 0; i < 5; i++) {
      code = require('crypto').randomBytes(4).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
      try {
        const { rows } = await pool.query('INSERT INTO agents (name, code) VALUES ($1,$2) RETURNING *', [name.trim(), code]);
        return res.status(201).json({ ...rows[0], link: 'https://trassakz.com/?agent=' + code });
      } catch (e) {
        if (e.code === '23505') continue; // коллизия кода, ретраим
        throw e;
      }
    }
    res.status(500).json({ error: 'Не удалось сгенерировать уникальный код, попробуйте ещё раз' });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

router.post('/agents/:id/toggle', async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE agents SET active = NOT active WHERE id=$1 RETURNING *', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Агент не найден' });
    res.json(rows[0]);
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
