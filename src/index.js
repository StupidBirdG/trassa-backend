require("dotenv").config();
const express = require("express");
const rateLimit = require("express-rate-limit");
const authRoutes = require("./routes/auth");
const cargoRoutes = require("./routes/cargos");
const reviewRoutes = require("./routes/reviews");
const messageRoutes = require("./routes/messages");
const publicRoutes = require("./routes/public");
const aiRoutes = require("./routes/ai");
const pool = require("./db/pool");
const app = express();
const PORT = process.env.PORT || 3001;

async function runMigrations() {
try {
await pool.query("ALTER TABLE cargos ADD COLUMN IF NOT EXISTS price_on_request BOOLEAN DEFAULT FALSE");
await pool.query("ALTER TABLE cargos ALTER COLUMN price DROP NOT NULL");
await pool.query("ALTER TABLE cargos ADD COLUMN IF NOT EXISTS volume_m3 NUMERIC");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS truck_type VARCHAR(50)");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS truck_number VARCHAR(20)");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT FALSE");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR");
await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR");
await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL");
await pool.query(`CREATE TABLE IF NOT EXISTS messages (
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
cargo_id UUID NOT NULL REFERENCES cargos(id) ON DELETE CASCADE,
sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
text TEXT NOT NULL,
created_at TIMESTAMPTZ DEFAULT now()
)`);
await pool.query("CREATE INDEX IF NOT EXISTS idx_messages_cargo ON messages(cargo_id, created_at)");
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

app.use((_, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => res.status(500).json({ error: "Server error" }));

app.listen(PORT, () => console.log("TRASSA on port " + PORT));
