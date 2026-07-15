const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');
const { notifyByUserId } = require('../services/telegram');
const { detectContactSharing } = require('../services/contactGuard');
router.use(authMiddleware);
async function checkAccess(cargoId, userId) {
  const { rows } = await pool.query(
    "SELECT c.owner_id, b.carrier_id FROM cargos c LEFT JOIN bids b ON b.id = c.accepted_bid_id WHERE c.id = $1 AND c.status IN ('in_transit','delivered')",
    [cargoId]);
  if (!rows.length) return false;
  return rows[0].owner_id === userId || rows[0].carrier_id === userId;
}
router.get('/:cargoId', async (req, res) => {
  try {
    if (!(await checkAccess(req.params.cargoId, req.user.id))) return res.status(403).json({ error: 'No access' });
    const { rows } = await pool.query("SELECT m.id, m.text, m.created_at, m.sender_id, m.flagged_contact, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.cargo_id = $1 ORDER BY m.created_at ASC", [req.params.cargoId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/:cargoId', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Empty' });
    if (!(await checkAccess(req.params.cargoId, req.user.id))) return res.status(403).json({ error: 'No access' });
    const { flagged, reasons } = detectContactSharing(text.trim());
    const { rows } = await pool.query('INSERT INTO messages (cargo_id, sender_id, text, flagged_contact) VALUES ($1,$2,$3,$4) RETURNING *', [req.params.cargoId, req.user.id, text.trim(), flagged]);
    const { rows: c } = await pool.query("SELECT c.owner_id, b.carrier_id, c.from_city, c.to_city FROM cargos c LEFT JOIN bids b ON b.id = c.accepted_bid_id WHERE c.id = $1", [req.params.cargoId]);
    if (c.length) { const other = req.user.id === c[0].owner_id ? c[0].carrier_id : c[0].owner_id; notifyByUserId(pool, other, '💬 ' + c[0].from_city + '->' + c[0].to_city + ': ' + text.trim().slice(0,80)).catch(()=>{}); }
    res.status(201).json({ ...rows[0], flagged_contact: flagged, flag_reasons: flagged ? reasons : undefined });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
module.exports = router;
