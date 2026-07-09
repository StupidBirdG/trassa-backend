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
const pool = require("./db/pool");
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

app.use(express.json());
app.use("/api/auth/send-code", rateLimit({ windowMs: 60000, max: 20 }));
app.use("/api/auth", authRoutes);
app.use("/api/cargos", cargoRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/admin", adminRoutes);

app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/dev/last-code", async (req, res) => {
try {
const { rows } = await pool.query("SELECT code,phone FROM sms_codes WHERE used=FALSE AND expires_at>now() ORDER BY created_at DESC LIMIT 1");
res.json(rows[0] || { code: null });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/dev/set-verified", async (req, res) => {
try {
const { phone, verified } = req.body;
if (!phone) return res.status(400).json({ error: "Ukazhite phone" });
const { rows } = await pool.query("UPDATE users SET verified=$2 WHERE phone=$1 RETURNING id, name, phone, verified", [phone, verified !== false]);
if (!rows.length) return res.status(404).json({ error: "Polzovatel ne nayden" });
res.json(rows[0]);
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/dev/set-subscription", async (req, res) => {
try {
const { phone, days } = req.body;
if (!phone) return res.status(400).json({ error: "Ukazhite phone" });
let query, params;
if (days === null || days === undefined) {
query = "UPDATE users SET subscription_until = NULL WHERE phone=$1 RETURNING id, name, phone, subscription_until";
params = [phone];
} else {
query = "UPDATE users SET subscription_until = now() + ($2 || ' days')::interval WHERE phone=$1 RETURNING id, name, phone, subscription_until";
params = [phone, days];
}
const { rows } = await pool.query(query, params);
if (!rows.length) return res.status(404).json({ error: "Polzovatel ne nayden" });
res.json(rows[0]);
} catch (e) { res.status(500).json({ error: e.message }); }
});

// Dev helper: lookup subscription state by user id (email OR phone accounts),
// without requiring a JWT — mirrors /api/auth/subscription/status for testing.
app.get("/dev/subscription-status/:id", async (req, res) => {
try {
const { rows } = await pool.query("SELECT id, name, email, phone, role, subscription_until FROM users WHERE id=$1", [req.params.id]);
if (!rows.length) return res.status(404).json({ error: "Polzovatel ne nayden" });
const until = rows[0].subscription_until;
const active = until && new Date(until) > new Date();
res.json({ ...rows[0], active: !!active });
} catch (e) { res.status(500).json({ error: e.message }); }
});

// Dev helper: register a carrier via email/password with NO trial granted
// (equivalent to register-email + skip_trial:true, exposed for quick testing).
app.post("/dev/register-carrier-without-trial", async (req, res) => {
try {
const bcrypt = require("bcryptjs");
const { signToken } = require("./middleware/auth");
const { email, password, name, company_name } = req.body;
if (!email || !password || !name) return res.status(400).json({ error: "Ukazhite email, password, name" });
const normalized = email.trim().toLowerCase();
const exists = await pool.query("SELECT id FROM users WHERE email=$1", [normalized]);
if (exists.rows.length > 0) return res.status(400).json({ error: "Etot email uzhe zaregistrirovan" });
const hash = await bcrypt.hash(password, 10);
const { rows: inserted } = await pool.query("INSERT INTO users (email,password_hash,role,name,company_name) VALUES ($1,$2,'carrier',$3,$4) RETURNING *", [normalized, hash, name.trim(), company_name ? company_name.trim() : null]);
const { password_hash, ...user } = inserted[0];
res.status(201).json({ ok: true, token: signToken(inserted[0]), user });
} catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((_, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => res.status(500).json({ error: "Server error" }));

app.listen(PORT, () => console.log("TRASSA on port " + PORT));
