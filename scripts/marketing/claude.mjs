// Тонкая обёртка над Anthropic Messages API (только встроенный https, без SDK —
// меньше зависимостей для CI-раннера GitHub Actions).
import https from 'node:https';

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

export function askClaude({ system, user, maxTokens = 1024 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не задан (нужен GitHub Actions secret)');

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            return reject(new Error(`Anthropic API вернул не-JSON (status ${res.statusCode}): ${data.slice(0, 500)}`));
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Anthropic API ${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
          const text = parsed.content?.map((b) => b.text).join('\n') ?? '';
          resolve(text.trim());
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
