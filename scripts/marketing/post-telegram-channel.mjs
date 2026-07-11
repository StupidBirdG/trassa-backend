// Ежедневный маркетинговый пост в Telegram-канал Trassa.
// Запускается через GitHub Actions (.github/workflows/marketing-telegram-post.yml) —
// не через облачную CCR-роутину claude.ai/code/routines, у той оказался закрыт
// исходящий сетевой доступ к api.telegram.org (проверено 2026-07-11).
//
// Текст — детерминированные шаблоны (templates.mjs), не вызов LLM: ключ
// ANTHROPIC_API_KEY, привязанный к прод-аккаунту, не имеет баланса на прямые
// Messages-запросы (см. PRODUCTION-STATE.md п.49) — решили не тратить на это
// бюджет и оставить бесплатную, всегда рабочую ротацию готовых вариантов.
import { pickTopic } from './facts-angles.mjs';
import { buildChannelPost } from './templates.mjs';
import { sendTelegramMessage } from './telegram.mjs';

const { fact, angle, idx, angleIndex } = pickTopic(0);
const text = buildChannelPost(fact, angleIndex);

console.log(`[idx=${idx}] fact="${fact}" angle="${angle}"\n---\n${text}\n---`);

const result = await sendTelegramMessage({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHANNEL_ID,
  text,
});
console.log('Опубликовано, message_id =', result.result.message_id);
