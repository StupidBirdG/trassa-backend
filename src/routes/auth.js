const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const bcrypt = require("bcryptjs");
const { sendSms, createSmsCode, verifySmsCode, checkSmsCode } = require("../services/sms");
const { sendTelegramCode, processUpdates, getChatIdByPhone } = require("../services/telegram");
const { authMiddleware, signToken } = require("../middleware/auth");

function normalizePhone(raw) {
let d = raw.replace(/\D/g, "");
if (d.startsWith("8")) d = "7" + d.slice(1);
if (!d.startsWith("7")) d = "7" + d;
return "+" + d;
}

function normalizeEmail(raw) {
return raw.trim().toLowerCase();
}

function sanitizeUser(user) {
if (!user) return user;
const { password_hash, ...rest } = user;
return rest;
}

const BOT_LINK = "https://t.me/Abon9_bot";
const SUB_PRICE = 9000;

router.post("/send-code", async (req, res) => {
const { phone } = req.body;
if (!phone) return res.status(400).json({ error: "Укажите номер" });
const normalized = normalizePhone(phone);
const code = await createSmsCode(pool, normalized);
await processUpdates(pool);
const chatId = await getChatIdByPhone(pool, normalized);
if (chatId) {
const r = await sendTelegramCode(chatId, code);
if (r.ok) return res.json({ ok: true, phone: normalized, channel: "telegram" });
}
console.log("CODE for " + normalized + ": " + code);
res.json({ ok: true, phone: normalized, channel: "need_telegram", botLink: BOT_LINK });
});

router.post("/verify", async (req, res) => {
const { phone, code } = req.body;
if (!phone || !code) return res.status(400).json({ error: "Укажите телефон и код" });
const normalized = normalizePhone(phone);
const preCheck = await checkSmsCode(pool, normalized, code);
if (!preCheck) return res.status(400).json({ error: "Неверный или истёкший код" });
const { rows } = await pool.query("SELECT * FROM users WHERE phone=$1", [normalized]);
if (rows.length === 0) return res.json({ ok: true, needsRegistration: true, phone: normalized });
const valid = await verifySmsCode(pool, normalized, code);
if (!valid) return res.status(400).json({ error: "Неверный или истёкший код" });
await pool.query("UPDATE users SET phone_verified=TRUE WHERE phone=$1", [normalized]);
return res.json({ ok: true, token: signToken(rows[0]), user: sanitizeUser(rows[0]) });
});

router.post("/register", async (req, res) => {
try {
const { phone, code, name, role, company_name } = req.body;
if (!phone || !code || !name || !role) return res.status(400).json({ error: "Заполните все поля" });
if (!["shipper", "carrier"].includes(role)) return res.status(400).json({ error: "Неверная роль" });
const normalized = normalizePhone(phone);
const valid = await verifySmsCode(pool, normalized, code);
if (!valid) return res.status(400).json({ error: "Неверный или истёкший код" });
const co = company_name ? company_name.trim() : null;
const exists = await pool.query("SELECT id FROM users WHERE phone=$1", [normalized]);
if (exists.rows.length > 0) {
if (role === "carrier") {
await pool.query("UPDATE users SET phone_verified=TRUE, role=$2, name=$3, company_name=$4, subscription_until = COALESCE(subscription_until, now() + interval '7 days') WHERE phone=$1", [normalized, role, name.trim(), co]);
} else {
await pool.query("UPDATE users SET phone_verified=TRUE, role=$2, name=$3, company_name=$4 WHERE phone=$1", [normalized, role, name.trim(), co]);
}
const { rows } = await pool.query("SELECT * FROM users WHERE phone=$1", [normalized]);
return res.status(200).json({ ok: true, token: signToken(rows[0]), user: sanitizeUser(rows[0]) });
}
let newUser;
if (role === "carrier") {
const { rows } = await pool.query("INSERT INTO users (phone,phone_verified,role,name,company_name,subscription_until) VALUES ($1,TRUE,$2,$3,$4,now() + interval '7 days') RETURNING *", [normalized, role, name.trim(), co]);
newUser = rows[0];
} else {
const { rows } = await pool.query("INSERT INTO users (phone,phone_verified,role,name,company_name) VALUES ($1,TRUE,$2,$3,$4) RETURNING *", [normalized, role, name.trim(), co]);
newUser = rows[0];
}
res.status(201).json({ ok: true, token: signToken(newUser), user: sanitizeUser(newUser) });
} catch(err) {
console.error("Register error:", err.message);
res.status(500).json({ error: "Ошибка сервера: " + err.message });
}
});

router.post("/register-email", async (req, res) => {
try {
const { email, password, name, role, company_name } = req.body;
if (!email || !password || !name || !role) return res.status(400).json({ error: "Заполните все поля" });
if (!["shipper", "carrier"].includes(role)) return res.status(400).json({ error: "Неверная роль" });
if (password.length < 6) return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
const normalized = normalizeEmail(email);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return res.status(400).json({ error: "Неверный формат email" });
const exists = await pool.query("SELECT id FROM users WHERE email=$1", [normalized]);
if (exists.rows.length > 0) return res.status(400).json({ error: "Этот email уже зарегистрирован" });
const co = company_name ? company_name.trim() : null;
const hash = await bcrypt.hash(password, 10);
let newUser;
if (role === "carrier") {
const { rows } = await pool.query("INSERT INTO users (email,password_hash,role,name,company_name,subscription_until) VALUES ($1,$2,$3,$4,$5,now() + interval '7 days') RETURNING *", [normalized, hash, role, name.trim(), co]);
newUser = rows[0];
} else {
const { rows } = await pool.query("INSERT INTO users (email,password_hash,role,name,company_name) VALUES ($1,$2,$3,$4,$5) RETURNING *", [normalized, hash, role, name.trim(), co]);
newUser = rows[0];
}
res.status(201).json({ ok: true, token: signToken(newUser), user: sanitizeUser(newUser) });
} catch(err) {
console.error("Register-email error:", err.message);
res.status(500).json({ error: "Ошибка сервера: " + err.message });
}
});

router.post("/set-email", authMiddleware, async (req, res) => {
try {
const { email, password } = req.body;
if (!email || !password) return res.status(400).json({ error: "Укажите email и пароль" });
if (password.length < 6) return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
const normalized = normalizeEmail(email);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return res.status(400).json({ error: "Неверный формат email" });
const taken = await pool.query("SELECT id FROM users WHERE email=$1 AND id<>$2", [normalized, req.user.id]);
if (taken.rows.length > 0) return res.status(400).json({ error: "Этот email уже занят" });
const hash = await bcrypt.hash(password, 10);
const { rows } = await pool.query("UPDATE users SET email=$1, password_hash=$2 WHERE id=$3 RETURNING *", [normalized, hash, req.user.id]);
res.json({ ok: true, user: sanitizeUser(rows[0]) });
} catch(err) {
console.error("Set-email error:", err.message);
res.status(500).json({ error: "Ошибка сервера: " + err.message });
}
});

router.post("/login-email", async (req, res) => {
try {
const { email, password } = req.body;
if (!email || !password) return res.status(400).json({ error: "Укажите email и пароль" });
const normalized = normalizeEmail(email);
const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [normalized]);
if (!rows.length || !rows[0].password_hash) return res.status(400).json({ error: "Неверный email или пароль" });
const match = await bcrypt.compare(password, rows[0].password_hash);
if (!match) return res.status(400).json({ error: "Неверный email или пароль" });
res.json({ ok: true, token: signToken(rows[0]), user: sanitizeUser(rows[0]) });
} catch(err) {
console.error("Login-email error:", err.message);
res.status(500).json({ error: "Ошибка сервера: " + err.message });
}
});

router.post("/reset-password", async (req, res) => {
try {
const { phone, code, password } = req.body;
if (!phone || !code || !password) return res.status(400).json({ error: "Заполните все поля" });
if (password.length < 6) return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
const normalized = normalizePhone(phone);
const valid = await verifySmsCode(pool, normalized, code);
if (!valid) return res.status(400).json({ error: "Неверный или истёкший код" });
const { rows } = await pool.query("SELECT * FROM users WHERE phone=$1", [normalized]);
if (!rows.length) return res.status(404).json({ error: "Пользователь не найден" });
if (!rows[0].email) return res.status(400).json({ error: "У этого аккаунта нет привязанного email" });
const hash = await bcrypt.hash(password, 10);
const { rows: upd } = await pool.query("UPDATE users SET password_hash=$1 WHERE phone=$2 RETURNING *", [hash, normalized]);
res.json({ ok: true, token: signToken(upd[0]), user: sanitizeUser(upd[0]) });
} catch(err) {
console.error("Reset-password error:", err.message);
res.status(500).json({ error: "Ошибка сервера: " + err.message });
}
});

router.get("/me", authMiddleware, async (req, res) => {
const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
if (!rows.length) return res.status(404).json({ error: "Не найден" });
res.json(sanitizeUser(rows[0]));
});

router.get("/subscription/status", authMiddleware, async (req, res) => {
const { rows } = await pool.query("SELECT subscription_until, role FROM users WHERE id=$1", [req.user.id]);
if (!rows.length) return res.status(404).json({ error: "Не найден" });
const until = rows[0].subscription_until;
const active = until && new Date(until) > new Date();
res.json({ active: !!active, subscription_until: until, role: rows[0].role, price: SUB_PRICE });
});

router.post("/subscription/activate", authMiddleware, async (req, res) => {
const { rows } = await pool.query("SELECT subscription_until FROM users WHERE id=$1", [req.user.id]);
if (!rows.length) return res.status(404).json({ error: "Не найден" });
const cur = rows[0].subscription_until;
const stillActive = cur && new Date(cur) > new Date();
const base = stillActive ? "subscription_until" : "now()";
const { rows: upd } = await pool.query("UPDATE users SET subscription_until = " + base + " + interval '30 days' WHERE id=$1 RETURNING subscription_until", [req.user.id]);
res.json({ ok: true, subscription_until: upd[0].subscription_until, price: SUB_PRICE });
});

router.put("/profile", authMiddleware, async (req, res) => {
const { name, company_name, truck_type, truck_number } = req.body;
const updates = [];
const vals = [];
let i = 1;
if (name !== undefined) { updates.push("name=$"+i); i++; vals.push(name.trim()); }
if (company_name !== undefined) { updates.push("company_name=$"+i); i++; vals.push(company_name ? company_name.trim() : null); }
if (truck_type !== undefined) { updates.push("truck_type=$"+i); i++; vals.push(truck_type || null); }
if (truck_number !== undefined) { updates.push("truck_number=$"+i); i++; vals.push(truck_number ? truck_number.trim().toUpperCase() : null); }
if (!updates.length) return res.status(400).json({ error: "Нечего обновлять" });
vals.push(req.user.id);
const { rows } = await pool.query("UPDATE users SET "+updates.join(", ")+" WHERE id=$"+i+" RETURNING *", vals);
res.json(sanitizeUser(rows[0]));
});

router.delete("/account", authMiddleware, async (req, res) => {
try {
const uid = req.user.id;
await pool.query("DELETE FROM messages WHERE sender_id=$1", [uid]);
await pool.query("DELETE FROM reviews WHERE reviewer_id=$1 OR reviewee_id=$1", [uid]);
await pool.query("DELETE FROM user_ratings WHERE user_id=$1", [uid]);
await pool.query("DELETE FROM bids WHERE carrier_id=$1", [uid]);
await pool.query("DELETE FROM cargos WHERE owner_id=$1", [uid]);
await pool.query("DELETE FROM users WHERE id=$1", [uid]);
res.json({ ok: true });
} catch(err) {
console.error("Delete account error:", err.message);
res.status(500).json({ error: "Ошибка сервера: " + err.message });
}
});

router.get("/dev/last-code", async (req, res) => {
const { rows } = await pool.query("SELECT code,phone FROM sms_codes WHERE used=FALSE AND expires_at>now() ORDER BY created_at DESC LIMIT 1");
res.json(rows[0] || { code: null });
});

router.post("/set-phone", authMiddleware, async (req, res) => {
try {
const { phone, code } = req.body;
if (!phone || !code) return res.status(400).json({ error: "Заполните все поля" });
const normalized = normalizePhone(phone);
const valid = await verifySmsCode(pool, normalized, code);
if (!valid) return res.status(400).json({ error: "Неверный или истёкший код" });
const taken = await pool.query("SELECT id FROM users WHERE phone=$1 AND id<>$2", [normalized, req.user.id]);
if (taken.rows.length > 0) return res.status(400).json({ error: "Этот телефон уже используется другим аккаунтом" });
const { rows } = await pool.query("UPDATE users SET phone=$1, phone_verified=TRUE WHERE id=$2 RETURNING *", [normalized, req.user.id]);
res.json({ ok: true, user: sanitizeUser(rows[0]) });
} catch(err) {
console.error("Set-phone error:", err.message);
res.status(500).json({ error: "Ошибка сервера: " + err.message });
}
});

module.exports = router;
