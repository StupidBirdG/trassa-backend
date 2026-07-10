require("dotenv").config();
const express = require("express");
const rateLimit = require("express-rate-limit");
const authRoutes = require("./routes/auth");
const cargoRoutes = require("./routes/cargos");
const reviewRoutes = require("./routes/reviews");
const messageRoutes = require("./routes/messages");
const publicRoutes = require("./routes/public");
const aiRoutes = require("./routes/ai");
const adminRoutes = require("./routes/admin");
const paymentRoutes = require("./routes/payments");
const disputeRoutes = require("./routes/disputes");
const pushRoutes = require("./routes/push");
const statsRoutes = require("./routes/stats");
const verificationRoutes = require("./routes/verification");
const { notifyAdmin } = require("./services/telegram");
const pool = require("./db/pool");

// Мониторинг (2026-07-09): раньше единственный способ узнать об упавшем запросе/процессе
// был зайти самому и проверить логи Railway. Троттлинг — чтобы шквал одинаковых ошибок
// (например БД временно недоступна) не завалил Telegram сотнями сообщений подряд.
const lastAlertAt = new Map();
function alertAdminThrottled(key, text) {
const now = Date.now();
const prev = lastAlertAt.get(key) || 0;
if (now - prev < 60000) return; // не чаще раза в минуту на один и тот же тип ошибки
lastAlertAt.set(key, now);
notifyAdmin(text).catch(() => {});
}
process.on("unhandledRejection", (reason) => {
console.error("Unhandled rejection:", reason);
alertAdminThrottled("unhandledRejection", "⚠️ TRASSA: unhandled rejection\n" + String(reason && reason.stack || reason).slice(0, 500));
});
process.on("uncaughtException", (err) => {
console.error("Uncaught exception:", err);
alertAdminThrottled("uncaughtException", "🔴 TRASSA: uncaught exception (process may restart)\n" + String(err && err.stack || err).slice(0, 500));
});
const app = express();
const PORT = process.env.PORT || 3001;

async function runMigrations() {
try {
// FIX (found 2026-07-09 setting up CI against a genuinely fresh database): unlike
// every other retrofitted column here, subscription_until was never created by ANY
// migration script — it must have been manually ALTERed into production once, long
// before this repo's migration history. Same category of gap as the reviews/
// user_ratings tables found earlier. Used everywhere (auth.js, cargos.js, ai.js).
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_until TIMESTAMPTZ");

// FIX (48-hour review window bug, found 2026-07-08 while building AI carrier matching,
// fixed 2026-07-09): reviews.js reads bid.updated_at to compute the 48h window, but
// bids never had an updated_at column — new Date(undefined) is Invalid Date, so the
// "Date.now() - accepted < 48h" check was always NaN-comparison-false, silently never
// blocking. Reviews could technically be left on any deal, no matter how old.
await pool.query("ALTER TABLE bids ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()");

// Kaspi Pay через PayBox.money (2026-07-09): подписка сейчас активируется без реальной
// оплаты. payments — таблица заказов на оплату для аудита и обработки callback'а.
await pool.query(`CREATE TABLE IF NOT EXISTS payments (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
order_id VARCHAR(100) UNIQUE NOT NULL,
tier VARCHAR(20) NOT NULL,
amount NUMERIC(12,2) NOT NULL,
status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
provider_payment_id VARCHAR(100),
created_at TIMESTAMPTZ DEFAULT now(),
paid_at TIMESTAMPTZ
)`);
await pool.query("CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at)");
await pool.query("CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id)");

// Ручной перевод на Kaspi Gold (2026-07-09): у владельца пока нет ИП/самозанятости,
// поэтому реальные агрегаторы (PayBox и т.п.) недоступны — KYC требует юр. статус.
// До регистрации ИП подписки подтверждаются вручную админом после Kaspi-перевода.
await pool.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider VARCHAR(20) NOT NULL DEFAULT 'paybox'");
await pool.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES users(id)");
await pool.query("ALTER TABLE payments ADD COLUMN IF NOT EXISTS user_marked_paid_at TIMESTAMPTZ");

// Споры (2026-07-09): нет ИП => нет юридической возможности держать деньги в эскроу для
// сделок между грузовладельцем и перевозчиком (это уже не своя выручка, а чужие деньги —
// требует лицензии/банковского эскроу). До регистрации ИП защита от мошенничества —
// non-monetary: жалобы видны админу, админ разбирается и может забанить нарушителя.
await pool.query(`CREATE TABLE IF NOT EXISTS disputes (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
bid_id UUID NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
cargo_id UUID NOT NULL REFERENCES cargos(id) ON DELETE CASCADE,
complainant_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
respondent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
reason VARCHAR(50) NOT NULL,
description TEXT,
status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
resolution TEXT,
resolved_by UUID REFERENCES users(id),
created_at TIMESTAMPTZ DEFAULT now(),
resolved_at TIMESTAMPTZ
)`);
await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_disputes_bid_complainant ON disputes(bid_id, complainant_id)");
await pool.query("CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, created_at)");
await pool.query("CREATE INDEX IF NOT EXISTS idx_disputes_respondent ON disputes(respondent_id)");

await pool.query("ALTER TABLE cargos ADD COLUMN IF NOT EXISTS price_on_request BOOLEAN DEFAULT FALSE");
await pool.query("ALTER TABLE cargos ALTER COLUMN price DROP NOT NULL");
await pool.query("ALTER TABLE cargos ADD COLUMN IF NOT EXISTS volume_m3 NUMERIC");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS truck_type VARCHAR(50)");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS truck_number VARCHAR(20)");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR");
await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL");
await pool.query("ALTER TABLE users ALTER COLUMN phone DROP NOT NULL");
await pool.query(`CREATE TABLE IF NOT EXISTS messages (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
cargo_id UUID NOT NULL REFERENCES cargos(id) ON DELETE CASCADE,
sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
text TEXT NOT NULL,
created_at TIMESTAMPTZ DEFAULT now()
)`);
await pool.query("CREATE INDEX IF NOT EXISTS idx_messages_cargo ON messages(cargo_id, created_at)");

// Competitor-analysis quick wins (2026-07-08): BIN verification, real GPS location, cargo view tracking
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bin VARCHAR(12)");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS bin_verified BOOLEAN DEFAULT FALSE");
await pool.query("ALTER TABLE cargos ADD COLUMN IF NOT EXISTS current_lat NUMERIC(9,6)");
await pool.query("ALTER TABLE cargos ADD COLUMN IF NOT EXISTS current_lng NUMERIC(9,6)");
await pool.query("ALTER TABLE cargos ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ");
await pool.query(`CREATE TABLE IF NOT EXISTS cargo_views (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
cargo_id UUID NOT NULL REFERENCES cargos(id) ON DELETE CASCADE,
viewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
viewed_at TIMESTAMPTZ DEFAULT now()
)`);
await pool.query("CREATE INDEX IF NOT EXISTS idx_cargo_views_cargo ON cargo_views(cargo_id, viewed_at)");
await pool.query("CREATE INDEX IF NOT EXISTS idx_cargo_views_viewer ON cargo_views(cargo_id, viewer_id)");

// FIX (found 2026-07-08 while building AI carrier matching): reviews.js references
// tables `reviews` and `user_ratings`, but no migration anywhere in this repo ever
// created them (42P01 undefined_table). Adding them now — this was a pre-existing
// gap, not something introduced by this PR.
await pool.query(`CREATE TABLE IF NOT EXISTS reviews (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
order_id UUID NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
reviewee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
reviewer_role VARCHAR(20) NOT NULL CHECK (reviewer_role IN ('shipper','carrier')),
rating_overall INT NOT NULL CHECK (rating_overall BETWEEN 1 AND 5),
rating_punctuality INT CHECK (rating_punctuality BETWEEN 1 AND 5),
rating_cargo INT CHECK (rating_cargo BETWEEN 1 AND 5),
rating_communication INT CHECK (rating_communication BETWEEN 1 AND 5),
comment TEXT,
created_at TIMESTAMPTZ DEFAULT now(),
UNIQUE (order_id, reviewer_id)
)`);
await pool.query("CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id, created_at)");

// FIX (2026-07-10, found via a real admin-panel delete failure — "Ошибка сервера" on
// DELETE /api/admin/cargos/:id): CREATE TABLE IF NOT EXISTS is a no-op on an existing
// table, so the ON DELETE CASCADE clauses above never actually applied to production —
// the table was first created before those clauses existed in this file, and no ALTER
// ever followed up. Checked pg_constraint directly: ALL THREE foreign keys on reviews
// (order_id, reviewer_id, reviewee_id) were NO ACTION (confdeltype='a') on prod, not
// just order_id. So deleting a cargo with an accepted bid that had a review on it
// cascaded from cargos -> bids but then hit "still referenced from table reviews" and
// rolled back the whole DELETE. Recreate all three constraints with the correct
// CASCADE, idempotently (only if not already 'c' cascade) so this doesn't run
// DROP/ADD on every single boot.
await pool.query(`DO $$
BEGIN
IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_order_id_fkey' AND confdeltype <> 'c') THEN
ALTER TABLE reviews DROP CONSTRAINT reviews_order_id_fkey;
ALTER TABLE reviews ADD CONSTRAINT reviews_order_id_fkey FOREIGN KEY (order_id) REFERENCES bids(id) ON DELETE CASCADE;
END IF;
IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_reviewer_id_fkey' AND confdeltype <> 'c') THEN
ALTER TABLE reviews DROP CONSTRAINT reviews_reviewer_id_fkey;
ALTER TABLE reviews ADD CONSTRAINT reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE CASCADE;
END IF;
IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reviews_reviewee_id_fkey' AND confdeltype <> 'c') THEN
ALTER TABLE reviews DROP CONSTRAINT reviews_reviewee_id_fkey;
ALTER TABLE reviews ADD CONSTRAINT reviews_reviewee_id_fkey FOREIGN KEY (reviewee_id) REFERENCES users(id) ON DELETE CASCADE;
END IF;
END $$;`);
await pool.query(`CREATE TABLE IF NOT EXISTS user_ratings (
user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
avg_overall NUMERIC(3,2),
avg_punctuality NUMERIC(3,2),
avg_cargo NUMERIC(3,2),
avg_communication NUMERIC(3,2),
total_reviews INT DEFAULT 0,
updated_at TIMESTAMPTZ DEFAULT now()
)`);

// Multi-tier subscriptions (2026-07-08, по запросу пользователя после реализации freemium):
// basic/pro/business вместо единого flat-тарифа. Тариф хранится отдельно от даты окончания,
// чтобы renewal сохранял выбранный уровень, если явно не указан другой.
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_tier VARCHAR(20) DEFAULT 'basic'");

// Юридический пробел (2026-07-08): не было ни фактического согласия на условия
// использования/обработку персональных данных, ни страниц с текстом этих условий —
// только надпись под формой без ссылки. Фиксируем факт и время согласия.
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version VARCHAR(20)");

// Админ-панель (2026-07-09): раньше модерация делалась вручную через прямые SQL-запросы.
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN DEFAULT FALSE");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_reason TEXT");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ");

// Реферальная программа (2026-07-10): дешёвый канал роста без бюджета на рекламу.
// referral_code генерируется лениво при первом запросе (см. services/referral.js),
// поэтому бэкфилл существующих пользователей не нужен.
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(12) UNIQUE");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id)");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_reward_given BOOLEAN DEFAULT FALSE");
await pool.query("CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)");
await pool.query("CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)");

// Web Push (2026-07-10): уведомление о новом грузе без Telegram — используя уже готовую
// PWA (manifest.json/sw.js). endpoint уникален на подписку браузера/устройства; один
// пользователь может иметь несколько (телефон + компьютер).
await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
endpoint TEXT UNIQUE NOT NULL,
p256dh TEXT NOT NULL,
auth TEXT NOT NULL,
created_at TIMESTAMPTZ DEFAULT now()
)`);
await pool.query("CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)");

// Защита от обхода бана (2026-07-10): забаненного телефона/email/BIN достаточно,
// чтобы заблокировать повторную регистрацию с теми же данными — раньше такой
// проверки не было вообще. См. services/banEvasion.js.
await pool.query(`CREATE TABLE IF NOT EXISTS banned_identifiers (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
type VARCHAR(10) NOT NULL CHECK (type IN ('phone','email','bin')),
value TEXT NOT NULL,
source_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
created_at TIMESTAMPTZ DEFAULT now(),
UNIQUE (type, value)
)`);
await pool.query("CREATE INDEX IF NOT EXISTS idx_banned_identifiers_lookup ON banned_identifiers(type, value)");

// Верификация документами вместо "честного слова" (2026-07-10): раньше "verified"
// был флагом, который админ ставил без единого доказательства. Теперь пользователь
// загружает фото документа, админ реально смотрит на него перед подтверждением.
// Файл — BYTEA прямо в Postgres: на Railway файловая система эфемерна (пропадает
// при передеплое), а объём тут маленький (несколько фото на модерацию за раз),
// так что заводить отдельное объектное хранилище (S3 и т.п.) избыточно.
await pool.query(`CREATE TABLE IF NOT EXISTS verification_documents (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
doc_type VARCHAR(20) NOT NULL CHECK (doc_type IN ('id_card','drivers_license','vehicle_passport','company_cert')),
file_data BYTEA NOT NULL,
mime_type VARCHAR(50) NOT NULL,
status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
reviewed_by UUID REFERENCES users(id),
reviewed_at TIMESTAMPTZ,
rejection_reason TEXT,
created_at TIMESTAMPTZ DEFAULT now()
)`);
await pool.query("CREATE INDEX IF NOT EXISTS idx_verification_docs_user ON verification_documents(user_id, created_at)");
await pool.query("CREATE INDEX IF NOT EXISTS idx_verification_docs_status ON verification_documents(status, created_at)");

console.log("Migrations OK");
} catch (e) {
console.error("Migration error:", e.message);
}
}
runMigrations();

app.use((req, res, next) => {
res.header("Access-Control-Allow-Origin", "*");
res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
if (req.method === "OPTIONS") return res.sendStatus(200);
next();
});

// Лимит поднят с дефолтных 100kb — фото документов на верификацию (права,
// техпаспорт) в base64 внутри JSON легко превышают это (см. routes/verification.js).
app.use(express.json({ limit: "10mb" }));
// PayBox шлёт callback как form-urlencoded, не JSON — нужен отдельный парсер.
app.use(express.urlencoded({ extended: true }));
app.use("/api/auth/send-code", rateLimit({ windowMs: 60000, max: 20 }));
// SECURITY FIX (2026-07-09, same review as the /dev/* removal above): these endpoints
// check a 6-digit OTP (1,000,000 combinations, valid 30 minutes — see services/sms.js)
// or a password, with NO attempt limiting at all. Without a rate limit, an automated
// script could brute-force an OTP well within its validity window, or brute-force a
// login password — reset-password is the worst case, since a guessed OTP there lets an
// attacker set a NEW password on someone else's phone-linked account outright.
const authBruteForceLimit = rateLimit({ windowMs: 15 * 60000, max: 15, standardHeaders: true, legacyHeaders: false });
app.use("/api/auth/verify", authBruteForceLimit);
app.use("/api/auth/register", authBruteForceLimit);
app.use("/api/auth/reset-password", authBruteForceLimit);
app.use("/api/auth/login-email", authBruteForceLimit);
app.use("/api/auth/set-phone", authBruteForceLimit);
app.use("/api/auth", authRoutes);
app.use("/api/cargos", cargoRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/disputes", disputeRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/stats", statsRoutes);
app.use("/api/verification", verificationRoutes);

app.get("/health", (_, res) => res.json({ ok: true }));

// SECURITY FIX (2026-07-09, found during a security review): the /dev/* endpoints below
// used to live here completely unauthenticated in production. /dev/last-code returned
// the most recent unused SMS OTP for ANY phone — a live account-takeover primitive
// (attacker polls it during someone else's login/registration and steals their code).
// /dev/set-subscription granted unlimited free subscription to any phone account — a
// direct bypass of the entire payment system. /dev/set-verified and
// /dev/subscription-status/:id leaked trust/PII data with no auth. No test in this repo
// referenced any of them (grep confirmed), so they're removed outright rather than
// gated behind NODE_ENV — a misconfigured env var must not be able to re-expose this.

app.use((_, res) => res.status(404).json({ error: "Not found" }));
app.use((err, req, res, _next) => {
console.error("Express error handler:", err);
alertAdminThrottled(
"express:" + req.method + " " + req.path,
"🔴 TRASSA: 500 on " + req.method + " " + req.path + "\n" + String(err && err.stack || err).slice(0, 500)
);
res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => console.log("TRASSA on port " + PORT));
