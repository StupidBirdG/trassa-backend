const axios = require("axios");

// Отправка SMS через Vonage (бывший Nexmo) — международный провайдер вместо SMSC.kz.
// https://developer.vonage.com/en/messaging/sms/overview (Classic SMS API, REST/JSON)
// ВАЖНО: до этой правки sendSms() существовал в файле, но нигде не вызывался в реальном
// коде — /auth/send-code полагался только на Telegram-бота. Теперь sendSms реально
// подключён как fallback, когда Telegram не привязан (см. routes/auth.js).
async function sendSms(phone, message) {
const clean = phone.replace(/\D/g, "");
if (!process.env.VONAGE_API_KEY || !process.env.VONAGE_API_SECRET) {
console.error("Vonage credentials not set (VONAGE_API_KEY / VONAGE_API_SECRET)");
return { ok: false, error: "no_credentials" };
}
try {
const { data } = await axios.post("https://rest.nexmo.com/sms/json", null, {
params: {
api_key: process.env.VONAGE_API_KEY,
api_secret: process.env.VONAGE_API_SECRET,
to: clean,
from: process.env.VONAGE_FROM || "Trassa",
text: message,
type: "unicode" // поддержка кириллицы в тексте кода
}
});
console.log("Vonage response:", JSON.stringify(data));
const msg = data && data.messages && data.messages[0];
// Vonage: status "0" = успех, любой другой код = ошибка (см. error-text)
if (!msg || msg.status !== "0") {
return { ok: false, error: (msg && msg["error-text"]) || "unknown_error", code: msg && msg.status };
}
return { ok: true, id: msg["message-id"], remainingBalance: msg["remaining-balance"] };
} catch (e) {
console.error("Vonage error:", e.message);
return { ok: false, error: e.message };
}
}

async function createSmsCode(pool, phone) {
const code = String(Math.floor(100000 + Math.random() * 900000));
const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
await pool.query("INSERT INTO sms_codes (phone, code, expires_at) VALUES ($1, $2, $3)", [phone, code, expiresAt]);
console.log("\n SMS на " + phone + ": " + code + "\n");
return code;
}

// Проверка кода БЕЗ списания (used остаётся FALSE). Используется, когда нужно
// узнать валиден ли код, не расходуя его — например при /verify для нового
// номера, где фактическое списание произойдёт позже в /register.
async function checkSmsCode(pool, phone, code) {
const { rows } = await pool.query("SELECT id FROM sms_codes WHERE phone = $1 AND code = $2 AND used = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1", [phone, code]);
return rows.length > 0;
}

async function verifySmsCode(pool, phone, code) {
const { rows } = await pool.query("SELECT id FROM sms_codes WHERE phone = $1 AND code = $2 AND used = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1", [phone, code]);
if (rows.length === 0) return false;
await pool.query("UPDATE sms_codes SET used = TRUE WHERE id = $1", [rows[0].id]);
return true;
}

module.exports = { sendSms, createSmsCode, verifySmsCode, checkSmsCode };
