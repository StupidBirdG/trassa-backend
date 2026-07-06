const axios = require("axios");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE = "https://api.telegram.org/bot" + TOKEN;

function normalizePhone(raw) {
let d = String(raw || "").replace(/\D/g, "");
if (d.startsWith("8")) d = "7" + d.slice(1);
if (!d.startsWith("7")) d = "7" + d;
return "+" + d;
}

async function sendTelegramCode(chatId, code) {
try {
const r = await axios.post(BASE + "/sendMessage", { chat_id: chatId, text: "TRASSA. Vash kod vhoda: " + code + ". Deystvuet 30 minut." });
return r.data.ok ? { ok: true } : { ok: false, error: r.data.description };
} catch (e) { return { ok: false, error: e.message }; }
}

async function sendStartButton(chatId) {
try {
await axios.post(BASE + "/sendMessage", { chat_id: chatId, text: "Dobro pozhalovat v TRASSA! Nazhmite knopku nizhe, chtoby privyazat nomer telefona.", reply_markup: { keyboard: [[{ text: "Otpravit moy nomer", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } });
return { ok: true };
} catch (e) { return { ok: false, error: e.message }; }
}

async function sendLinkedConfirm(chatId) {
try {
await axios.post(BASE + "/sendMessage", { chat_id: chatId, text: "Nomer privyazan! Vernites na sayt i nazhmite Poluchit kod escho raz.", reply_markup: { remove_keyboard: true } });
return { ok: true };
} catch (e) { return { ok: false, error: e.message }; }
}

// Generic notification sender used by cargo events
async function sendNotification(chatId, text) {
try {
const r = await axios.post(BASE + "/sendMessage", { chat_id: chatId, text: text, parse_mode: "HTML" });
return r.data.ok ? { ok: true } : { ok: false, error: r.data.description };
} catch (e) { return { ok: false, error: e.message }; }
}

// Look up a user by id and send them a notification. Never throws.
async function notifyByUserId(pool, userId, text) {
try {
const r = await pool.query("SELECT telegram_chat_id FROM users WHERE id=$1", [userId]);
const chatId = r.rows[0] && r.rows[0].telegram_chat_id;
if (!chatId) return { ok: false, error: "no chat_id" };
return await sendNotification(chatId, text);
} catch (e) { return { ok: false, error: e.message }; }
}

async function saveChatId(pool, phone, chatId) {
try {
await pool.query("INSERT INTO users (phone, telegram_chat_id, role, phone_verified, name) VALUES ($1, $2, 'shipper', false, 'Telegram') ON CONFLICT (phone) DO UPDATE SET telegram_chat_id = $2", [phone, String(chatId)]);
return { ok: true };
} catch (e) { return { ok: false, error: e.message }; }
}

async function getChatIdByPhone(pool, phone) {
try {
const r = await pool.query("SELECT telegram_chat_id FROM users WHERE phone=$1", [phone]);
return r.rows[0] && r.rows[0].telegram_chat_id ? r.rows[0].telegram_chat_id : null;
} catch (e) { return null; }
}

async function processUpdates(pool) {
try {
const res = await axios.get(BASE + "/getUpdates", { params: { limit: 100, timeout: 0 } });
const updates = res.data.result || [];
let maxId = 0;
for (const u of updates) {
maxId = Math.max(maxId, u.update_id);
const msg = u.message;
if (!msg) continue;
const chatId = msg.chat && msg.chat.id;
if (!chatId) continue;
if (msg.contact && msg.contact.phone_number) {
const phone = normalizePhone(msg.contact.phone_number);
await saveChatId(pool, phone, chatId);
await sendLinkedConfirm(chatId);
} else if (msg.text && msg.text.indexOf("/start") === 0) {
await sendStartButton(chatId);
}
}
if (maxId > 0) { await axios.get(BASE + "/getUpdates", { params: { offset: maxId + 1, limit: 1, timeout: 0 } }); }
return { ok: true, processed: updates.length };
} catch (e) { return { ok: false, error: e.message }; }
}

// Уведомить всех перевозчиков с активной подпиской и Telegram о новом грузе
async function notifyAllCarriers(pool, cargo) {
try {
const { rows } = await pool.query(
"SELECT telegram_chat_id FROM users WHERE role='carrier' AND subscription_until > now() AND telegram_chat_id IS NOT NULL"
);
const text = '🚛 Новый груз на ТРАССА!\n' +
'📍 ' + cargo.from_city + ' → ' + cargo.to_city + '\n' +
'⚖️ ' + cargo.weight_tons + ' т · ' + cargo.cargo_type + '\n' +
(cargo.price ? '💰 ' + Number(cargo.price).toLocaleString('ru-RU') + ' ₸\n' : '💬 Цена по запросу\n') +
'\nОткликнитесь на сайте: https://trassa-frontend-zti8.vercel.app';
for (const row of rows) {
sendNotification(row.telegram_chat_id, text).catch(() => {});
}
return { ok: true, sent: rows.length };
} catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { sendTelegramCode, notifyAllCarriers, sendStartButton, sendNotification, notifyByUserId, processUpdates, saveChatId, getChatIdByPhone, normalizePhone };
