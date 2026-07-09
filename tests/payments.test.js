const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, waitForServer } = require('./helpers');
const paybox = require('../src/services/paybox');

before(async () => { await waitForServer(); });

// Чистые функции подписи — не требуют реальных PayBox-кредов, только проверяют
// корректность самого алгоритма (сортировка ключей, склейка, MD5).
describe('paybox: signature', () => {
  test('signParams is deterministic and order-independent on input key order', () => {
    const a = paybox.signParams('payment.php', { pg_b: '2', pg_a: '1' }, 'secret');
    const b = paybox.signParams('payment.php', { pg_a: '1', pg_b: '2' }, 'secret');
    assert.equal(a, b);
  });

  test('signParams changes if any value changes', () => {
    const a = paybox.signParams('payment.php', { pg_amount: '100' }, 'secret');
    const b = paybox.signParams('payment.php', { pg_amount: '200' }, 'secret');
    assert.notEqual(a, b);
  });

  test('verifyCallbackSignature accepts a correctly signed body and rejects a tampered one', () => {
    const savedMerchant = process.env.PAYBOX_MERCHANT_ID;
    const savedSecret = process.env.PAYBOX_SECRET_KEY;
    process.env.PAYBOX_MERCHANT_ID = 'test-merchant';
    process.env.PAYBOX_SECRET_KEY = 'test-secret';
    try {
      const body = { pg_order_id: 'TRASSA-1', pg_result: '1', pg_payment_id: '555' };
      const sig = paybox.signParams('result', body, 'test-secret');
      assert.equal(paybox.verifyCallbackSignature('result', { ...body, pg_sig: sig }), true);
      assert.equal(paybox.verifyCallbackSignature('result', { ...body, pg_result: '0', pg_sig: sig }), false);
      assert.equal(paybox.verifyCallbackSignature('result', { ...body }), false); // no pg_sig at all
    } finally {
      process.env.PAYBOX_MERCHANT_ID = savedMerchant;
      process.env.PAYBOX_SECRET_KEY = savedSecret;
    }
  });

  test('isConfigured is false without env vars', () => {
    const savedMerchant = process.env.PAYBOX_MERCHANT_ID;
    const savedSecret = process.env.PAYBOX_SECRET_KEY;
    delete process.env.PAYBOX_MERCHANT_ID;
    delete process.env.PAYBOX_SECRET_KEY;
    try {
      assert.equal(paybox.isConfigured(), false);
    } finally {
      if (savedMerchant !== undefined) process.env.PAYBOX_MERCHANT_ID = savedMerchant;
      if (savedSecret !== undefined) process.env.PAYBOX_SECRET_KEY = savedSecret;
    }
  });
});

// Роут в тестовой/CI-среде без реальных PAYBOX_MERCHANT_ID/PAYBOX_SECRET_KEY —
// должен вежливо отвечать 503, а не падать/500.
describe('payments: /api/payments/paybox/create without configured provider', () => {
  test('returns 503 payments_not_configured when PayBox env vars are absent', async () => {
    if (paybox.isConfigured()) return; // если когда-нибудь тест окружение будет с кредами — не ломаем прогон
    const { token } = await registerUser({ role: 'carrier', prefix: 'paynoconf' });
    const r = await api('/api/payments/paybox/create', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { tier: 'basic' } });
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'payments_not_configured');
  });

  test('shipper cannot create a subscription payment', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'payshipper' });
    const r = await api('/api/payments/paybox/create', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { tier: 'basic' } });
    assert.equal(r.status, 403);
  });

  test('unknown order id -> 404 on status lookup', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'paystatus' });
    const r = await api('/api/payments/paybox/nonexistent-order', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 404);
  });
});
