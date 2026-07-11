// Ежедневный черновик поста для Instagram + сценарий Reels/TikTok.
// НЕ публикует ничего сам — у этих площадок нет официального API без долгого
// одобрения, а неофициальный логин/пароль реально рискует баном аккаунта
// (сознательно отклонено, см. PRODUCTION-STATE.md п.49). Просто присылает
// готовый текст владельцу в личку в Telegram, публикация — вручную.
//
// Текст — детерминированные шаблоны (templates.mjs), не вызов LLM (тот же повод,
// что и у post-telegram-channel.mjs — нет баланса на прямые Anthropic API-запросы,
// решили не тратить бюджет ради этого).
import { pickTopic } from './facts-angles.mjs';
import { buildInstagramCaption, buildReelsScript } from './templates.mjs';
import { sendTelegramMessage } from './telegram.mjs';

// Сдвиг +37 — чтобы тема дня не совпадала 1-в-1 с постом в публичном канале
// (тот же пул фактов/углов, другой день цикла).
const { fact, angle, idx, angleIndex, factIndex } = pickTopic(37);

const caption = buildInstagramCaption(fact, angleIndex, factIndex);
const reels = buildReelsScript(fact, angleIndex);

const text = `📸 Контент на сегодня (Instagram/TikTok, выкладываешь сам)

INSTAGRAM:
${caption}

REELS/TIKTOK СЦЕНАРИЙ:
${reels}

— Черновик, не публикуется автоматически.`;

console.log(`[idx=${idx}] fact="${fact}" angle="${angle}"\n---\n${text}\n---`);

const result = await sendTelegramMessage({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_ADMIN_CHAT_ID,
  text,
});
console.log('Доставлено в личку, message_id =', result.result.message_id);
