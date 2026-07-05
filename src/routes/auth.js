const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const bcrypt = require("bcryptjs");
const { sendSms, createSmsCode, verifySmsCode } = require("../services/sms");
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
if (!phone) return res.status(400).json({ error: "Ukazhite nomer" });
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
if (!phone || !code) return res.status(400).json({ error: "Ukazhite phone i code" });
const normalized = normalizePhone(phone);
const valid = await verifySmsCode(pool, normalized, code);
if (!valid) return res.status(400).json({ error: "Neverniy ili istekshiy kod" });
const { rows } = await pool.query("SELECT * FROM users WHERE phone=$1", [normalized]);
if (rows.length === 0) return res.json({ ok: true, needsRegistration: true, phone: normalized });
await pool.query("UPDATE users SET phone_verified=TRUE WHERE phone=$1", [normalized]);
return res.json({ ok: true, token: signToken(rows[0]), user: sanitizeUser(rows[0]) });
});

router.post("/register", async (req, res) => {
try {
const { phone, code, name, role, company_name } = req.body;
if (!phone || !code || !name || !role) return res.status(400).json({ error: "Zapolnite vse polya" });
if (!["shipper", "carrier"].includes(role)) return res.status(400).json({ error: "Nevernaya rol" });
const normalized = normalizePhone(phone);
const valid = await verifySmsCode(pool, normalized, code);
if (!valid) return res.status(400).json({ error: "Neverniy ili istekshiy kod" });
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
res.status(500).json({ error: "Server error: " + err.message });
}
});

router.post("/set-email", authMiddleware, async (req, res) => {
try {
const { email, password } = req.body;
if (!email || !password) return res.status(400).json({ error: "Ukazhite email i parol" });
if (password.length < 6) return res.status(400).json({ error: "Parol dolzhen byt ne koroche 6 simvolov" });
const normalized = normalizeEmail(email);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return res.status(400).json({ error: "Nevernyi format email" });
const taken = await pool.query("SELECT id FROM users WHERE email=$1 AND id<>$2", [normalized, req.user.id]);
if (taken.rows.length > 0) return res.status(400).json({ error: "Etot email uzhe zanyat" });
const hash = await bcrypt.hash(password, 10);
const { rows } = await pool.query("UPDATE users SET email=$1, password_hash=$2 WHERE id=$3 RETURNING *", [normalized, hash, req.user.id]);
res.json({ ok: true, user: sanitizeUser(rows[0]) });
} catch(err) {
console.error("Set-email error:", err.message);
res.status(500).json({ error: "Server error: " + err.message });
}
});

router.post("/login-email", async (req, res) => {
try {
const { email, password } = req.body;
if (!email || !password) return res.status(400).json({ error: "Ukazhite email i parol" });
const normalized = normalizeEmail(email);
const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [normalized]);
if (!rows.length || !rows[0].password_hash) return res.status(400).json({ error: "Neverniy email ili parol" });
const match = await bcrypt.compare(password, rows[0].password_hash);
if (!match) return res.status(400).json({ error: "Neverniy email ili parol" });
res.json({ ok: true, token: signToken(rows[0]), user: sanitizeUser(rows[0]) });
} catch(err) {
console.error("Login-email error:", err.message);
res.status(500).json({ error: "Server error: " + err.message });
}
});

router.get("/me", authMiddleware, async (req, res) => {
const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
if (!rows.length) return res.status(404).json({ error: "Ne nayden" });
res.json(sanitizeUser(rows[0]));
});

router.get("/subscription/status", authMiddleware, async (req, res) => {
const { rows } = await pool.query("SELECT subscription_until, role FROM users WHERE id=$1", [req.user.id]);
if (!rows.length) return res.status(404).json({ error: "Ne nayden" });
const until = rows[0].subscription_until;
const active = until && new Date(until) > new Date();
res.json({ active: !!active, subscription_until: until, role: rows[0].role, price: SUB_PRICE });
});

router.post("/subscription/activate", authMiddleware, async (req, res) => {
const { rows } = await pool.query("SELECT subscription_until FROM users WHERE id=$1", [req.user.id]);
if (!rows.length) return res.status(404).json({ error: "Ne nayden" });
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
if (!updates.length) return res.status(400).json({ error: "Nechego obnovlyat" });
vals.push(req.user.id);
const { rows } = await pool.query("UPDATE users SET "+updates.join(", ")+" WHERE id=$"+i+" RETURNING *", vals);
res.json(sanitizeUser(rows[0]));
});

router.delete("/account", authMiddleware, async (req, res) => {
await pool.query("DELETE FROM users WHERE id=$1", [req.user.id]);
res.json({ ok: true });
});

router.get("/dev/last-code", async (req, res) => {
const { rows } = await pool.query("SELECT code,phone FROM sms_codes WHERE used=FALSE AND expires_at>now() ORDER BY created_at DESC LIMIT 1");
res.json(rows[0] || { code: null });
});

module.exports = router;
