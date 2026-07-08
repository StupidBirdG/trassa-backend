const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// AI-подсказка цены по маршруту — конкурентная фича (никто из ~30 изученных конкурентов
// такого не предлагает). Считается по собственной статистике биржи, без доп. LLM-вызова —
// дёшево и работает сразу, накапливая точность по мере роста истории сделок.
router.get('/suggest-price', async (req, res) => {
try {
const { from_city, to_city, weight_tons } = req.query;
if (!from_city || !to_city) return res.status(400).json({ error: 'Укажите from_city и to_city' });

const { rows: exact } = await pool.query(`
SELECT price, weight_tons FROM cargos
WHERE lower(from_city)=lower($1) AND lower(to_city)=lower($2) AND price IS NOT NULL AND price_on_request = FALSE
ORDER BY created_at DESC LIMIT 50
`, [from_city, to_city]);

let sample = exact;
let scope = 'route';
if (sample.length < 3) {
const { rows: broader } = await pool.query(`
SELECT price, weight_tons FROM cargos
WHERE (lower(from_city)=lower($1) OR lower(to_city)=lower($2)) AND price IS NOT NULL AND price_on_request = FALSE
ORDER BY created_at DESC LIMIT 50
`, [from_city, to_city]);
if (broader.length > sample.length) { sample = broader; scope = 'partial_route'; }
}

if (!sample.length) return res.json({ available: false, message: 'Недостаточно данных по этому маршруту пока' });

const prices = sample.map(r => Number(r.price)).filter(p => p > 0);
const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
const min = Math.min(...prices);
const max = Math.max(...prices);
let perTonAdjusted = avg;
if (weight_tons && Number(weight_tons) > 0) {
const withWeight = sample.filter(r => r.weight_tons);
if (withWeight.length >= 3) {
const avgPerTon = withWeight.reduce((a, r) => a + Number(r.price) / Number(r.weight_tons), 0) / withWeight.length;
perTonAdjusted = Math.round(avgPerTon * Number(weight_tons));
}
}

res.json({
available: true,
scope,
sample_size: prices.length,
suggested_price: Math.round(perTonAdjusted),
range: { min: Math.round(min), max: Math.round(max), avg: Math.round(avg) },
currency: 'KZT'
});
} catch (err) {
console.error(err);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

// AI-подбор лучших перевозчиков под конкретный груз — расширяет тот же принцип, что и
// suggest-price: ранжирование на собственных данных биржи (рейтинг, доставки, опыт именно
// на этом маршруте, верификация), без доп. LLM-вызова. Доступно только владельцу груза;
// исключает перевозчиков, уже откликнувшихся — это подсказка "кого ещё позвать".
router.get('/suggest-carriers/:cargoId', async (req, res) => {
try {
const { rows: cargoRows } = await pool.query('SELECT id, owner_id, from_city, to_city, status FROM cargos WHERE id=$1', [req.params.cargoId]);
if (!cargoRows.length) return res.status(404).json({ error: 'Груз не найден' });
const cargo = cargoRows[0];
if (cargo.owner_id !== req.user.id) return res.status(403).json({ error: 'Нет доступа' });

const { rows: candidates } = await pool.query(`
SELECT u.id, u.name, u.company_name, u.verified, u.bin_verified, u.rating, u.completed_deliveries, u.truck_type,
ur.avg_overall, ur.total_reviews,
(SELECT COUNT(*)::int FROM bids b2 JOIN cargos c2 ON c2.id=b2.cargo_id
WHERE b2.carrier_id=u.id AND b2.status='accepted'
AND lower(c2.from_city)=lower($2) AND lower(c2.to_city)=lower($3)) AS route_deliveries
FROM users u
LEFT JOIN user_ratings ur ON ur.user_id = u.id
WHERE u.role='carrier' AND u.subscription_until > now()
AND u.id NOT IN (SELECT carrier_id FROM bids WHERE cargo_id=$1)
LIMIT 100
`, [req.params.cargoId, cargo.from_city, cargo.to_city]);

const ranked = candidates.map(c => {
const ratingScore = Number(c.avg_overall || c.rating || 5);
const routeBonus = Number(c.route_deliveries || 0);
const score = ratingScore * 20 + Number(c.completed_deliveries || 0) * 2 + routeBonus * 15 + (c.verified ? 10 : 0) + (c.bin_verified ? 5 : 0);
const reasons = [];
if (routeBonus > 0) reasons.push('уже возил(а) этот маршрут ' + routeBonus + ' раз(а)');
if (ratingScore >= 4.5) reasons.push('высокий рейтинг ' + ratingScore.toFixed(1));
if (c.verified) reasons.push('верифицирован');
if (c.completed_deliveries >= 5) reasons.push(c.completed_deliveries + ' доставок выполнено');
return {
id: c.id, name: c.name, company_name: c.company_name, truck_type: c.truck_type,
verified: c.verified, bin_verified: c.bin_verified,
rating: ratingScore, completed_deliveries: c.completed_deliveries, route_deliveries: routeBonus,
score: Math.round(score * 10) / 10,
reasons
};
}).sort((a, b) => b.score - a.score).slice(0, 10);

res.json({ cargo_id: cargo.id, candidates_considered: candidates.length, suggestions: ranked });
} catch (err) {
console.error(err);
res.status(500).json({ error: 'Ошибка сервера' });
}
});

// Голосовая публикация груза: превращаем расшифровку речи в структурированные поля заявки
router.post('/parse-cargo', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Пустой текст' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Голосовой ввод пока не настроен' });

    const prompt = 'Извлеки из текста заявки на грузоперевозку структурированные данные и верни ТОЛЬКО валидный JSON без пояснений и без markdown-разметки, в формате: {"from_city": строка или null, "to_city": строка или null, "weight_tons": число или null, "volume_m3": число или null, "cargo_type": строка или null, "price": число или null, "comment": строка или null}. Текст заявки: "' + text.trim() + '"';

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Anthropic API error:', data);
      return res.status(500).json({ error: (data.error && data.error.message) || 'Ошибка распознавания' });
    }

    const block = (data.content || []).find(b => b.type === 'text');
    const raw = block ? block.text : '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let parsed = {};
    try { parsed = JSON.parse(cleaned); } catch (e) { console.error('Parse error:', e.message, cleaned); }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

module.exports = router;
