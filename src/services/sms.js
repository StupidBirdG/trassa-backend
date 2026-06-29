const axios = require("axios");

// Отправка SMS через SMSC.kz
// https://smsc.kz/api/http/
async function sendSms(phone, message) {
  const clean = phone.replace(/\D/g, "");
  if (!process.env.SMSC_LOGIN || !process.env.SMSC_PASSWORD) {
    console.error("SMSC credentials not set");
    return { ok: false, error: "no_credentials" };
  }
  try {
    const { data } = await axios.get("https://smsc.kz/sys/send.php", {
      params: {
        login: process.env.SMSC_LOGIN,
        psw: process.env.SMSC_PASSWORD,
        phones: clean,
        mes: message,
        fmt: 3,          // ответ в формате JSON
        charset: "utf-8"
      }
    });
    console.log("SMSC response:", JSON.stringify(data));
    // При успехе SMSC возвращает { id, cnt }, при ошибке { error, error_code }
    if (data && data.error) {
      return { ok: false, error: data.error, code: data.error_code };
    }
    return { ok: true, id: data && data.id };
  } catch (e) {
    console.error("SMSC error:", e.message);
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

async function verifySmsCode(pool, phone, code) {
  const { rows } = await pool.query("SELECT id FROM sms_codes WHERE phone = $1 AND code = $2 AND used = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1", [phone, code]);
  if (rows.length === 0) return false;
  await pool.query("UPDATE sms_codes SET used = TRUE WHERE id = $1", [rows[0].id]);
  return true;
}

module.exports = { sendSms, createSmsCode, verifySmsCode };
