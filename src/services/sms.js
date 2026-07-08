const axios = require("axios");

// Отправка SMS через Infobip — сменили с Vonage 2026-07-08: два платных теста через
// Vonage (буквенный sender "Trassa" и числовой) были приняты и списаны, но НЕ дошли
// до казахстанского номера — типичная проблема фильтрации незарегистрированных
// международных маршрутов в KZ. Infobip заявляет более сильное присутствие в СНГ/ЦА.
// https://www.infobip.com/docs/sms/api#send-sms-messages
async function sendSms(phone, message) {
const clean = phone.replace(/\D/g, "");
if (!process.env.INFOBIP_API_KEY || !process.env.INFOBIP_BASE_URL) {
console.error("Infobip credentials not set (INFOBIP_API_KEY / INFOBIP_BASE_URL)");
return { ok: false, error: "no_credentials" };
}
try {
const baseUrl = process.env.INFOBIP_BASE_URL.replace(/\/$/, "");
const { data } = await axios.post(
baseUrl + "/sms/2/text/advanced",
{
messages: [
{
destinations: [{ to: clean }],
from: process.env.INFOBIP_FROM || undefined, // без sender id — Infobip подставит дефолтный/числовой shared route
text: message,
}
]
},
{
headers: {
Authorization: "App " + process.env.INFOBIP_API_KEY,
"Content-Type": "application/json",
Accept: "application/json",
}
}
);
console.log("Infobip response:", JSON.stringify(data));
const msg = data && data.messages && data.messages[0];
const status = msg && msg.status;
// Infobip: groupId 1 = PENDING (принято к отправке), 3 = DELIVERED, 2/4/5 = разные виды ошибок
if (!status || (status.groupId !== 1 && status.groupId !== 3)) {
return { ok: false, error: (status && status.description) || "unknown_error", code: status && status.groupName };
}
return { ok: true, id: msg.messageId, status: status.groupName };
} catch (e) {
console.error("Infobip error:", e.response ? JSON.stringify(e.response.data) : e.message);
return { ok: false, error: e.response ? JSON.stringify(e.response.data) : e.message };
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
