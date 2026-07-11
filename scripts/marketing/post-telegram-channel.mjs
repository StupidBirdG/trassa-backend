// Ежедневный маркетинговый пост в Telegram-канал Trassa.
// Запускается через GitHub Actions (.github/workflows/marketing-telegram-post.yml) —
// не через облачную CCR-роутину claude.ai/code/routines, у той оказался закрыт
// исходящий сетевой доступ к api.telegram.org (проверено 2026-07-11), поэтому
// реальная доставка перенесена сюда, на раннеры GitHub с открытым интернетом.
import { pickTopic, FORBIDDEN } from './facts-angles.mjs';
import { askClaude } from './claude.mjs';
import { sendTelegramMessage } from './telegram.mjs';

const { fact, angle, idx } = pickTopic(0);

const system = `Ты — маркетинговый копирайтер Trassa (биржа грузоперевозок в Казахстане,
trassa-frontend-zti8.vercel.app). Пиши честно: только про реально работающие на проде
фичи, без вранья и без хайпа про AI ради AI. Тон дружелюбный, упор на деньги/время
пользователя. Никогда не упоминай: ${FORBIDDEN.join('; ')}.`;

const user = `Напиши короткий пост для Telegram-канала (3-6 предложений, до ~700 символов).
Факт продукта, который нужно раскрыть: "${fact}".
Маркетинговый угол/боль, через который подать этот факт: "${angle}".
1-2 уместных эмодзи, не больше. В конце — ссылка trassa-frontend-zti8.vercel.app.
Ответь только текстом поста, без преамбул и без кавычек вокруг него.`;

const text = await askClaude({ system, user });
console.log(`[idx=${idx}] fact="${fact}" angle="${angle}"\n---\n${text}\n---`);

const result = await sendTelegramMessage({
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHANNEL_ID,
  text,
});
console.log('Опубликовано, message_id =', result.result.message_id);
