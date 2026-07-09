const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, promoteAdmin, waitForServer, pool } = require('./helpers');
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
    const r = await api('/api/payments/status/nonexistent-order', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 404);
  });
});

// Ручной Kaspi-перевод — временное решение, пока у владельца нет ИП/самозанятости для
// подключения реального агрегатора. Тестовое окружение (CI) не задаёт KASPI_PHONE,
// поэтому по умолчанию проверяем именно ветку "недоступно"; полный флоу с реальным
// номером сверяется вручную.
describe('payments: manual Kaspi transfer', () => {
  test('returns 503 payments_not_configured when KASPI_PHONE is absent', async () => {
    if (process.env.KASPI_PHONE) return;
    const { token } = await registerUser({ role: 'carrier', prefix: 'kaspinoconf' });
    const r = await api('/api/payments/manual/create', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { tier: 'basic' } });
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'payments_not_configured');
  });

  test('shipper cannot create a manual payment', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'kaspishipper' });
    const r = await api('/api/payments/manual/create', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { tier: 'basic' } });
    assert.equal(r.status, 403);
  });

  test('mark-paid on an unknown order -> 404', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'kaspimark' });
    const r = await api('/api/payments/manual/nonexistent-order/mark-paid', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 404);
  });

  // KASPI_PHONE lives in the SERVER process's env, not the test process's — setting
  // process.env here wouldn't reach it. So /manual/create's success path (and the real
  // kaspi_phone/kaspi_name it returns) is verified manually against production/.env,
  // same as PayBox credentials. Here we test the parts that don't depend on that env
  // var: seed a pending payment directly in the DB (as if /manual/create had run) and
  // drive it through mark-paid -> admin list -> admin confirm -> subscription activation.
  test('mark-paid -> admin sees it pending -> admin confirm activates subscription', async () => {
    const { token, user } = await registerUser({ role: 'carrier', prefix: 'kaspifull' });
    const admin = await registerUser({ role: 'shipper', prefix: 'kaspiadmin' });
    await promoteAdmin(admin.user.id);

    const orderId = 'TRASSA-TEST-' + Date.now();
    await pool.query(
      "INSERT INTO payments (user_id, order_id, tier, amount, status, provider) VALUES ($1,$2,'pro',15000,'pending','manual_kaspi')",
      [user.id, orderId]
    );

    const markPaid = await api('/api/payments/manual/' + orderId + '/mark-paid', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
    assert.equal(markPaid.status, 200);

    const list = await api('/api/admin/payments?status=pending', { headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(list.status, 200);
    const entry = list.data.find((p) => p.order_id === orderId);
    assert.ok(entry, 'pending payment should be visible to admin');
    assert.ok(entry.user_marked_paid_at);

    const confirm = await api('/api/admin/payments/' + entry.id + '/confirm', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(confirm.status, 200);

    const status = await api('/api/payments/status/' + orderId, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(status.data.status, 'paid');

    const subStatus = await api('/api/auth/subscription/status', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(subStatus.data.tier, 'pro');
    assert.equal(subStatus.data.active, true);
  });

  test('admin confirming an already-processed payment -> 404', async () => {
    const { user } = await registerUser({ role: 'carrier', prefix: 'kaspidouble' });
    const admin = await registerUser({ role: 'shipper', prefix: 'kaspiadmin2' });
    await promoteAdmin(admin.user.id);
    const orderId = 'TRASSA-TEST-' + Date.now();
    const { rows } = await pool.query(
      "INSERT INTO payments (user_id, order_id, tier, amount, status, provider) VALUES ($1,$2,'basic',9000,'paid','manual_kaspi') RETURNING id",
      [user.id, orderId]
    );
    const r = await api('/api/admin/payments/' + rows[0].id + '/confirm', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(r.status, 404);
  });
});
