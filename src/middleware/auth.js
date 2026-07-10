const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Токен недействителен или истёк' });
  }

  // Проверка бана (2026-07-09, вместе с админ-панелью) — без этого забаненный
  // пользователь с ещё не истёкшим токеном (до 30 дней) мог бы продолжать
  // действовать. Один запрос по индексированному PK — дёшево.
  try {
    // created_at добавлен сюда же (2026-07-10, антиабьюз-лимиты для свежих аккаунтов,
    // см. services/antiAbuse.js) — этот запрос и так выполняется на каждый запрос,
    // отдельный поход в БД ради одной колонки был бы лишним.
    const { rows } = await pool.query('SELECT banned, banned_reason, is_admin, created_at FROM users WHERE id=$1', [req.user.id]);
    if (!rows.length) return res.status(401).json({ error: 'Пользователь не найден' });
    if (rows[0].banned) return res.status(403).json({ error: 'Аккаунт заблокирован' + (rows[0].banned_reason ? ': ' + rows[0].banned_reason : ''), code: 'account_banned' });
    req.user.is_admin = rows[0].is_admin;
    req.user.created_at = rows[0].created_at;
    next();
  } catch (e) {
    console.error('authMiddleware ban-check error:', e.message);
    next(); // при сбое БД не блокируем весь сайт из-за проверки бана
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Требуются права администратора' });
  next();
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, phone: user.phone, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

module.exports = { authMiddleware, adminMiddleware, signToken };
