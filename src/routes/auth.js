const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { createSmsCode, verifySmsCode } = require("../services/sms");
const { sendTelegramCode, processUpdates, getChatIdByPhone } = require("../services/telegram");
const { authMiddleware, signToken } = require("../middleware/auth");

function normalizePhone(raw) {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("8")) d = "7" + d.slice(1);
  if (!d.startsWith("7")) d = "7" + d;
  return "+" + d;
}

const BOT_LINK = "https://t.me/Abon9_bot";
const TRIAL_DAYS = 7;
const SUB_DAYS = 30;
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
  return res.json({ ok: true, token: signToken(rows[0]), user: rows[0] });
});

router.post("/register", async (req, res) => {
  const { phone, code, name, role, company_name } = req.body;
  if (!phone || !code || !name || !role) return res.status(400).json({ error: "Zapolnite vse polya" });
  if (!["shipper", "carrier"].includes(role)) return res.status(400).json({ error: "Nevernaya rol" });
  const normalized = normalizePhone(phone);
  const valid = await verifySmsCode(pool, normalized, code);
  if (!valid) return res.status(400).json({ error: "Neverniy ili istekshiy kod" });
  // Carriers get a free trial period on registration
  const trialClause = role === "carrier" ? ("now() + interval " + bt + "7 days" + bt) : "NULL";
  const co = company_name ? company_name.trim() : null;
  const exists = await pool.query("SELECT id FROM users WHERE phone=$1", [normalized]);
  if (exists.rows.length > 0) {
    await pool.query(
      "UPDATE users SET phone_verified=TRUE, role=$2, name=$3, company_name=$4, subscription_until = COALESCE(subscription_until, " + trialClause + ") WHERE phone=$1",
      [normalized, role, name.trim(), co]
    );
    const { rows } = await pool.query("SELECT * FROM users WHERE phone=$1", [normalized]);
    return res.status(200).json({ ok: true, token: signToken(rows[0]), user: rows[0] });
  }
  const { rows } = await pool.query(
    "INSERT INTO users (phone,phone_verified,role,name,company_name,subscription_until) VALUES ($1,TRUE,$2,$3,$4," + trialClause + ") RETURNING *",
    [normalized, role, name.trim(), co]
  );
  res.status(201).json({ ok: true, token: signToken(rows[0]), user: rows[0] });
});

router.get("/me", authMiddleware, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "Ne nayden" });
  res.json(rows[0]);
});

// Subscription status for the current user
router.get("/subscription/status", authMiddleware, async (req, res) => {
  const { rows } = await pool.query("SELECT subscription_until, role FROM users WHERE id=$1", [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "Ne nayden" });
  const until = rows[0].subscription_until;
  const active = until && new Date(until) > new Date();
  res.json({ active: !!active, subscription_until: until, role: rows[0].role, price: SUB_PRICE });
});

// Activate subscription (+30 days). Placeholder until a real payment provider is connected.
router.post("/subscription/activate", authMiddleware, async (req, res) => {
  const { rows } = await pool.query("SELECT subscription_until FROM users WHERE id=$1", [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "Ne nayden" });
  const cur = rows[0].subscription_until;
  const stillActive = cur && new Date(cur) > new Date();
  const base = stillActive ? "subscription_until" : "now()";
  const { rows: upd } = await pool.query(
    "UPDATE users SET subscription_until = " + base + " + interval " + bt + "30 days" + bt + " WHERE id=$1 RETURNING subscription_until",
    [req.user.id]
  );
  res.json({ ok: true, subscription_until: upd[0].subscription_until, price: SUB_PRICE });
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
