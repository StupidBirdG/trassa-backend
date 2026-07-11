// Отправка сообщения в Telegram через Bot API. Используем встроенный https и
// JSON-тело (не querystring/curl), чтобы избежать известной в этом проекте
// проблемы с битой кириллицей при отправке через POSIX-shell curl -d.
import https from 'node:https';

export function sendTelegramMessage({ token, chatId, text }) {
  const body = JSON.stringify({ chat_id: chatId, text });
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
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
            return reject(new Error(`Telegram API вернул не-JSON: ${data.slice(0, 300)}`));
          }
          if (!parsed.ok) return reject(new Error(`Telegram API error: ${JSON.stringify(parsed)}`));
          resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
