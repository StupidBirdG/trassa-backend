const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const bcrypt = require("bcryptjs");
const { sendSms, createSmsCode, verifySmsCode, checkSmsCode } = require("../services/sms");
const { sendTelegramCode, processUpdates, getChatIdByPhone } = require("../services/telegram");
const { sendWhatsApp } = require("../services/whatsapp");
const { authMiddleware, signToken } = require("../middleware/auth");
const { getOrCreateReferralCode, resolveReferrer } = require("../services/referral");

function normalizePhone(raw) {
let d = raw.replace(/\D/g, "");
if (d.startsWith("8")) d = "7" + d.slice(1);
if (!d.startsWith("7")) d = "7" + d;
return "+" + d;
}

function normalizeEmail(raw) {
return raw.trim().toLowerCase();
}

// Проверка контрольной суммы БИН РК (12 цифр, алгоритм КГД).
// ВАЖНО: это только проверка формата/чек-суммы, а НЕ подтверждение существования
// компании в госреестре — для этого нужен доступ к API eGov/КГД (требует договора).
function validateBinChecksum(bin) {
if (!/^\d{12}$/.test(bin)) return false;
const digits = bin.split('').map(Number);
const w1 = [1,2,3,4,5,6,7,8,9,10,11];
let sum = 0;
for (let i = 0; i < 11; i++) sum += digits[i] * w1[i];
let check = sum % 11;
if (check === 10) {
const w2 = [3,4,5,6,7,8,9,10,11,1,2];
sum = 0;
for (let i = 0; i < 11; i++) sum += digits[i] * w2[i];
check = sum % 11;
if (check === 10) return false;
}
return check === digits[11];
}

function sanitizeUser(user) {
if (!user) return user;
const { password_hash, ...rest } = user;
return rest;
}

const BOT_LINK = "https://t.me/Abon9_bot";
const SUB_PRICE = 9000; // сохранён для обратной совместимости — это цена тарифа basic

// Многоуровневая подписка (2026-07-08): 3 тарифа вместо единого flat 9000 ₸.
// Все тарифы дают безлимитные отклики и GPS — разница в приоритете видимости.
const TERMS_VERSION = "2026-07-09";

const SUBSCRIPTION_TIERS = {
basic: { price: 9000, label: "Базовый", score_bonus: 0, features: ["Безлимитные отклики на грузы", "Контакты грузовладельцев", "Telegram-уведомления", "GPS-трекинг доставки", "Акт о перевозке (PDF)"] },
pro: { price: 15000, label: "Про", score_bonus: 15, features: ["Всё из Базового", "Приоритет в AI-подборе перевозчиков", "Бейдж «PRO» в каталоге компаний", "Выше в результатах поиска", "Push-уведомления о новых грузах", "Расширенная статистика (график по месяцам)"] },
business: { price: 25000, label: "Бизнес", score_bonus: 30, features: ["Всё из Про", "Максимальный приоритет в AI-подборе", "Бейдж «BUSINESS» в каталоге", "Приоритетная поддержка"] },
};

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
// Fallback-цепочка: Telegram (бесплатно) → WhatsApp (пока номер не одобрен Meta —
// см. services/whatsapp.js) → SMS через Infobip (подтверждённо рабочий канал).
const waResult = await sendWhatsApp(normalized, "Код подтверждения Трасса: " + code);
if (waResult.ok) return res.json({ ok: true, phone: normalized, channel: "whatsapp" });
const smsResult = await sendSms(normalized, "Код подтверждения Трасса: " + code);
if (smsResult.ok) return res.json({ ok: true, phone: normalized, channel: "sms" });
console.error("WhatsApp+SMS fallback failed:", waResult.error, smsResult.error);
console.log("CODE for " + normalized + ": " + code);
res.json({ ok: true, phone: normalized, channel: "need_telegram", botLink: BOT_LINK, whatsapp_error: waResult.error, sms_error: smsResult.error });
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
const { phone, code, name, role, company_name, agreed_terms, ref } = req.body;
if (!phone || !code || !name || !role) return res.status(400).json({ error: "Заполните все поля" });
if (!["shipper", "carrier"].includes(role)) return res.status(400).json({ error: "Неверная роль" });
if (agreed_terms !== true) return res.status(400).json({ error: "Необходимо согласиться с условиями использования и политикой конфиденциальности", code: "terms_not_accepted" });
const normalized = normalizePhone(phone);
const valid = await verifySmsCode(pool, normalized, code);
if (!valid) return res.status(400).json({ error: "Неверный или истёкший код" });
const co = company_name ? company_name.trim() : null;
const referrerId = ref ? await resolveReferrer(pool, ref) : null;
const trialDays = referrerId ? 14 : 7; // реферальный бонус: 14 дней пробного вместо 7
const exists = await pool.query("SELECT id FROM users WHERE phone=$1", [normalized]);
if (exists.rows.length > 0) {
if (role === "carrier") {
await pool.query("UPDATE users SET phone_verified=TRUE, role=$2, name=$3, company_name=$4, subscription_until = COALESCE(subscription_until, now() + ($6 || ' days')::interval), terms_accepted_at=now(), terms_version=$5, referred_by = COALESCE(referred_by, $7) WHERE phone=$1", [normalized, role, name.trim(), co, TERMS_VERSION, trialDays, referrerId]);
} else {
await pool.query("UPDATE users SET phone_verified=TRUE, role=$2, name=$3, company_name=$4, terms_accepted_at=now(), terms_version=$5, referred_by = COALESCE(referred_by, $6) WHERE phone=$1", [normalized, role, name.trim(), co, TERMS_VERSION, referrerId]);
}
const { rows } = await pool.query("SELECT * FROM users WHERE phone=$1", [normalized]);
return res.status(200).json({ ok: true, token: signToken(rows[0]), user: sanitizeUser(rows[0]) });
}
let newUser;
if (role === "carrier") {
const { rows } = await pool.query("INSERT INTO users (phone,phone_verified,role,name,company_name,subscription_until,terms_accepted_at,terms_version,referred_by) VALUES ($1,TRUE,$2,$3,$4,now() + ($5 || ' days')::interval,now(),$6,$7) RETURNING *", [normalized, role, name.trim(), co, trialDays, TERMS_VERSION, referrerId]);
newUser = rows[0];
} else {
const { rows } = await pool.query("INSERT INTO users (phone,phone_verified,role,name,company_name,terms_accepted_at,terms_version,referred_by) VALUES ($1,TRUE,$2,$3,$4,now(),$5,$6) RETURNING *", [normalized, role, name.trim(), co, TERMS_VERSION, referrerId]);
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
const { email, password, name, role, company_name, skip_trial, agreed_terms, ref } = req.body;
if (!email || !password || !name || !role) return res.status(400).json({ error: "Заполните все поля" });
if (!["shipper", "carrier"].includes(role)) return res.status(400).json({ error: "Неверная роль" });
if (password.length < 6) return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
if (agreed_terms !== true) return res.status(400).json({ error: "Необходимо согласиться с условиями использования и политикой конфиденциальности", code: "terms_not_accepted" });
const normalized = normalizeEmail(email);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return res.status(400).json({ error: "Неверный формат email" });
const exists = await pool.query("SELECT id FROM users WHERE email=$1", [normalized]);
if (exists.rows.length > 0) return res.status(400).json({ error: "Этот email уже зарегистрирован" });
const co = company_name ? company_name.trim() : null;
const hash = await bcrypt.hash(password, 10);
const referrerId = ref ? await resolveReferrer(pool, ref) : null;
const trialDays = referrerId ? 14 : 7; // реферальный бонус: 14 дней пробного вместо 7
let newUser;
if (role === "carrier" && skip_trial !== true) {
const { rows } = await pool.query("INSERT INTO users (email,password_hash,role,name,company_name,subscription_until,terms_accepted_at,terms_version,referred_by) VALUES ($1,$2,$3,$4,$5,now() + ($6 || ' days')::interval,now(),$7,$8) RETURNING *", [normalized, hash, role, name.trim(), co, trialDays, TERMS_VERSION, referrerId]);
newUser = rows[0];
} else {
const { rows } = await pool.query("INSERT INTO users (email,password_hash,role,name,company_name,terms_accepted_at,terms_version,referred_by) VALUES ($1,$2,$3,$4,$5,now(),$6,$7) RETURNING *", [normalized, hash, role, name.trim(), co, TERMS_VERSION, referrerId]);
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

router.get("/referral", authMiddleware, async (req, res) => {
try {
const code = await getOrCreateReferralCode(pool, req.user.id);
const { rows } = await pool.query(
"SELECT COUNT(*)::int AS invited, COUNT(*) FILTER (WHERE referral_reward_given)::int AS rewarded FROM users WHERE referred_by=$1",
[req.user.id]
);
res.json({ code, invited: rows[0].invited, rewarded: rows[0].rewarded });
} catch (err) {
console.error("Referral error:", err.message);
res.status(500).json({ error: "Ошибка сервера" });
}
});

router.get("/me", authMiddleware, async (req, res) => {
const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
if (!rows.length) return res.status(404).json({ error: "Не найден" });
res.json(sanitizeUser(rows[0]));
});

router.get("/subscription/status", authMiddleware, async (req, res) => {
const { rows } = await pool.query("SELECT subscription_until, subscription_tier, role FROM users WHERE id=$1", [req.user.id]);
if (!rows.length) return res.status(404).json({ error: "Не найден" });
const until = rows[0].subscription_until;
const active = until && new Date(until) > new Date();
const tier = rows[0].subscription_tier || "basic";
const body = {
active: !!active,
subscription_until: until,
role: rows[0].role,
tier,
price: (SUBSCRIPTION_TIERS[tier] || SUBSCRIPTION_TIERS.basic).price,
tiers: SUBSCRIPTION_TIERS
};
// Freemium-этап: перевозчикам без подписки показываем остаток бесплатных откликов за месяц
if (rows[0].role === "carrier" && !active) {
const FREE_BIDS_PER_MONTH = 3;
const { rows: bidRows } = await pool.query(
"SELECT COUNT(*)::int AS cnt FROM bids WHERE carrier_id=$1 AND created_at >= date_trunc('month', now())",
[req.user.id]
);
body.free_bids_used = bidRows[0].cnt;
body.free_bids_limit = FREE_BIDS_PER_MONTH;
body.free_bids_remaining = Math.max(0, FREE_BIDS_PER_MONTH - bidRows[0].cnt);
}
res.json(body);
});

router.post("/subscription/activate", authMiddleware, async (req, res) => {
const { tier } = req.body;
const { rows } = await pool.query("SELECT subscription_until, subscription_tier FROM users WHERE id=$1", [req.user.id]);
if (!rows.length) return res.status(404).json({ error: "Не найден" });
const chosenTier = tier && SUBSCRIPTION_TIERS[tier] ? tier : (rows[0].subscription_tier || "basic");
if (tier && !SUBSCRIPTION_TIERS[tier]) return res.status(400).json({ error: "Неизвестный тариф. Доступны: " + Object.keys(SUBSCRIPTION_TIERS).join(", ") });
const cur = rows[0].subscription_until;
const stillActive = cur && new Date(cur) > new Date();
// Смена тарифа на более высокий/низкий начинает отсчёт заново, продление того же тарифа — от текущей даты окончания
const sameTier = stillActive && rows[0].subscription_tier === chosenTier;
const base = sameTier ? "subscription_until" : "now()";
const { rows: upd } = await pool.query(
"UPDATE users SET subscription_until = " + base + " + interval '30 days', subscription_tier = $2 WHERE id=$1 RETURNING subscription_until, subscription_tier",
[req.user.id, chosenTier]
);
res.json({ ok: true, subscription_until: upd[0].subscription_until, tier: upd[0].subscription_tier, price: SUBSCRIPTION_TIERS[chosenTier].price });
});

router.put("/profile", authMiddleware, async (req, res) => {
const { name, company_name, truck_type, truck_number, bin } = req.body;
const updates = [];
const vals = [];
let i = 1;
if (name !== undefined) { updates.push("name=$"+i); i++; vals.push(name.trim()); }
if (company_name !== undefined) { updates.push("company_name=$"+i); i++; vals.push(company_name ? company_name.trim() : null); }
if (truck_type !== undefined) { updates.push("truck_type=$"+i); i++; vals.push(truck_type || null); }
if (truck_number !== undefined) { updates.push("truck_number=$"+i); i++; vals.push(truck_number ? truck_number.trim().toUpperCase() : null); }
if (bin !== undefined) {
if (bin === null || bin === "") {
updates.push("bin=$"+i); i++; vals.push(null);
updates.push("bin_verified=$"+i); i++; vals.push(false);
} else {
const trimmedBin = String(bin).trim();
const isValid = validateBinChecksum(trimmedBin);
if (!isValid) return res.status(400).json({ error: "Некорректный БИН (не проходит проверку контрольной суммы)" });
updates.push("bin=$"+i); i++; vals.push(trimmedBin);
updates.push("bin_verified=$"+i); i++; vals.push(true);
}
}
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

// SECURITY FIX (2026-07-09): this endpoint returned the most recent unused SMS OTP for
// ANY phone with no authentication — a live account-takeover primitive. Removed outright
// (not gated behind NODE_ENV — a misconfigured env var must not be able to re-expose it).
// See also the matching /dev/* cleanup in src/index.js from the same security review.

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
module.exports.SUBSCRIPTION_TIERS = SUBSCRIPTION_TIERS;
