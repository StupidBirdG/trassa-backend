const crypto = require('crypto');

// Kaspi Pay через PayBox.money — казахстанский платёжный агрегатор, поддерживающий
// Kaspi QR как один из способов оплаты на своей платёжной странице, наравне с картами.
// https://paybox.ru/documentation/merchant-api/priemplatezhei (тот же протокол,
// что использует paybox.money — семейство "классический PayBox" с MD5-подписью).
//
// АЛГОРИТМ ПОДПИСИ ЗАПРОСА (задокументирован, высокая уверенность):
// 1. Взять все pg_-параметры запроса, отсортировать по имени ключа по алфавиту
// 2. В начало списка значений добавить имя скрипта (например "payment.php")
// 3. В конец добавить secret_key мерчанта
// 4. Склеить через ";"
// 5. MD5 в нижнем регистре (hex)
//
// ⚠️ ПОДПИСЬ ОТВЕТА НА CALLBACK: точная формула (какое имя скрипта используется при
// подписи XML-ответа на pg_result_url) НЕ подтверждена официальной документацией на
// момент написания — источники расходятся. Отвечаем БЕЗ подписи (простой <pg_status>ok
// </pg_status>), что задокументировано как допустимый упрощённый ответ. Если PayBox
// в реальном личном кабинете покажет ошибки подтверждения — свериться с актуальной
// документацией в личном кабинете мерчанта (там она конкретна для аккаунта).

const BASE_URL = 'https://api.paybox.money';

function signParams(scriptName, params, secretKey) {
const sortedKeys = Object.keys(params).sort();
const values = [scriptName, ...sortedKeys.map((k) => String(params[k]))];
values.push(secretKey);
return crypto.createHash('md5').update(values.join(';')).digest('hex');
}

function isConfigured() {
return !!(process.env.PAYBOX_MERCHANT_ID && process.env.PAYBOX_SECRET_KEY);
}

// Строит URL платёжной страницы PayBox — пользователь переходит по нему и видит
// среди способов оплаты Kaspi QR.
function buildPaymentUrl({ orderId, amount, description }) {
if (!isConfigured()) throw new Error('PayBox не настроен (PAYBOX_MERCHANT_ID / PAYBOX_SECRET_KEY)');
const params = {
pg_merchant_id: process.env.PAYBOX_MERCHANT_ID,
pg_order_id: orderId,
pg_amount: amount,
pg_description: description,
pg_currency: 'KZT',
pg_salt: crypto.randomBytes(8).toString('hex'),
};
const sig = signParams('payment.php', params, process.env.PAYBOX_SECRET_KEY);
const qs = new URLSearchParams({ ...params, pg_sig: sig }).toString();
return BASE_URL + '/payment.php?' + qs;
}

// Проверяет подпись входящего callback'а от PayBox (result_url). Возвращает true/false —
// вызывающий код обязан игнорировать любой callback с неверной подписью (защита от
// поддельных уведомлений об оплате).
function verifyCallbackSignature(scriptName, body) {
if (!isConfigured()) return false;
const { pg_sig, ...rest } = body;
if (!pg_sig) return false;
const expected = signParams(scriptName, rest, process.env.PAYBOX_SECRET_KEY);
return expected === pg_sig;
}

module.exports = { isConfigured, buildPaymentUrl, verifyCallbackSignature, signParams };
