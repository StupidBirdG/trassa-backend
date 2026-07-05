const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

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
