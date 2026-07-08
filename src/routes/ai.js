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
