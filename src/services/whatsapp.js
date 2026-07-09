const axios = require("axios");

// Отправка кода подтверждения через WhatsApp (Infobip WhatsApp Business API).
// Номер-отправитель ожидает одобрения Meta на момент написания (2026-07-09,
// статус "Pending"/"In review" в портале Infobip) — до одобрения любой вызов
// будет возвращать { ok: false }, и вызывающий код должен провалиться дальше
// на SMS. Как только Meta одобрит номер, это заработает без изменений кода.
// https://www.infobip.com/docs/whatsapp/message-types#text-message
async function sendWhatsApp(phone, message) {
const clean = phone.replace(/\D/g, "");
if (!process.env.INFOBIP_API_KEY || !process.env.INFOBIP_BASE_URL || !process.env.INFOBIP_WHATSAPP_FROM) {
console.error("WhatsApp credentials not set (INFOBIP_API_KEY / INFOBIP_BASE_URL / INFOBIP_WHATSAPP_FROM)");
return { ok: false, error: "no_credentials" };
}
try {
const baseUrl = process.env.INFOBIP_BASE_URL.replace(/\/$/, "");
const { data } = await axios.post(
baseUrl + "/whatsapp/1/message/text",
{
from: process.env.INFOBIP_WHATSAPP_FROM,
to: clean,
content: { text: message }
},
{
headers: {
Authorization: "App " + process.env.INFOBIP_API_KEY,
"Content-Type": "application/json",
Accept: "application/json",
}
}
);
console.log("Infobip WhatsApp response:", JSON.stringify(data));
const status = data && data.status;
// groupId 1 = PENDING (принято), 3 = DELIVERED, остальное (5 = REJECTED и т.п.) — ошибка.
// REJECTED_SOURCE ("Invalid Source address") — типичный ответ, пока номер не одобрен Meta.
if (!status || (status.groupId !== 1 && status.groupId !== 3)) {
return { ok: false, error: (status && status.description) || "unknown_error", code: status && status.name };
}
return { ok: true, id: data.messageId, status: status.groupName };
} catch (e) {
console.error("Infobip WhatsApp error:", e.response ? JSON.stringify(e.response.data) : e.message);
return { ok: false, error: e.response ? JSON.stringify(e.response.data) : e.message };
}
}

module.exports = { sendWhatsApp };
