const { Pool } = require("pg");
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : new Pool({ host: process.env.DB_HOST || "localhost", port: Number(process.env.DB_PORT) || 5432, database: process.env.DB_NAME || "trassa_db", user: process.env.DB_USER || "postgres", password: process.env.DB_PASSWORD || "" });

// Мониторинг (2026-07-09): падение БД — самое критичное, что может случиться (весь сайт
// встаёт), и большинство роутов сами ловят ошибку в try/catch и отвечают 500 напрямую, не
// долетая до глобального Express error handler в index.js. Алертим отсюда напрямую —
// require лениво, чтобы избежать циклической зависимости (telegram.js ничего из pool.js
// не импортирует, так что цикла на самом деле нет, но так безопаснее при рефакторинге).
let lastPoolErrorAlertAt = 0;
pool.on("error", (err) => {
  console.error("DB pool error:", err.message);
  const now = Date.now();
  if (now - lastPoolErrorAlertAt < 60000) return;
  lastPoolErrorAlertAt = now;
  try {
    const { notifyAdmin } = require("../services/telegram");
    notifyAdmin("🔴 TRASSA: ошибка пула БД — сайт может быть недоступен\n" + err.message).catch(() => {});
  } catch (e) { /* сервис телеграма недоступен — не роняем процесс из-за алерта */ }
});

module.exports = pool;
