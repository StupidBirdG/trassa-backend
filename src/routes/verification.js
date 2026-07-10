const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

const DOC_TYPES = ['id_card', 'drivers_license', 'vehicle_passport', 'company_cert'];
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
// base64 раздувает размер примерно на треть — 8MB base64 ≈ 6MB реального файла,
// с запасом под лимит express.json({limit:'10mb'}) в index.js.
const MAX_BASE64_LEN = 8 * 1024 * 1024;

// Загрузить документ на верификацию — фото/скан прав, техпаспорта машины,
// удостоверения личности или регистрации компании. Файл передаётся как base64
// в JSON (не multipart) — не тянем multer ради одного эндпоинта.
router.post('/upload', async (req, res) => {
try {
const { doc_type, file_base64, mime_type } = req.body || {};
if (!DOC_TYPES.includes(doc_type)) return res.status(400).json({ error: 'Некорректный тип документа. Доступны: ' + DOC_TYPES.join(', ') });
if (!ALLOWED_MIME.includes(mime_type)) return res.status(400).json({ error: 'Недопустимый формат файла. Разрешены: JPEG, PNG, WEBP, PDF' });
if (!file_base64 || typeof file_base64 !== 'string') return res.status(400).json({ error: 'Файл не передан' });
if (file_base64.length > MAX_BASE64_LEN) return res.status(400).json({ error: 'Файл слишком большой (максимум ~6 МБ)' });

let buffer;
try { buffer = Buffer.from(file_base64, 'base64'); } catch (e) { return res.status(400).json({ error: 'Некорректная кодировка файла' }); }
if (!buffer.length) return res.status(400).json({ error: 'Пустой файл' });

const { rows } = await pool.query(
'INSERT INTO verification_documents (user_id, doc_type, file_data, mime_type) VALUES ($1,$2,$3,$4) RETURNING id, doc_type, status, created_at',
[req.user.id, doc_type, buffer, mime_type]
);
res.status(201).json(rows[0]);
} catch (err) {
console.error('Verification upload error:', err.message);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

// Список своих загруженных документов и их статус (без самого файла — только метаданные).
router.get('/mine', async (req, res) => {
try {
const { rows } = await pool.query(
'SELECT id, doc_type, status, rejection_reason, created_at, reviewed_at FROM verification_documents WHERE user_id=$1 ORDER BY created_at DESC',
[req.user.id]
);
res.json(rows);
} catch (err) {
console.error('Verification list error:', err.message);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

module.exports = router;
