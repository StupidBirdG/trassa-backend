const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, waitForServer, pool } = require('./helpers');
const push = require('../src/services/push');

before(async () => { await waitForServer(); });

describe('push: vapid-public-key without configured VAPID keys', () => {
  test('returns 503 push_not_configured when VAPID env vars are absent', async () => {
    if (push.isConfigured()) return; // если тестовое окружение когда-нибудь будет с ключами — не ломаем прогон
    const r = await api('/api/push/vapid-public-key');
    assert.equal(r.status, 503);
    assert.equal(r.data.code, 'push_not_configured');
  });
});

describe('push: subscribe/unsubscribe', () => {
  test('subscribing with an incomplete payload -> 400', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'pushbad' });
    const r = await api('/api/push/subscribe', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { endpoint: 'https://example.com/ep' } });
    assert.equal(r.status, 400);
  });

  test('subscribing without auth -> 401', async () => {
    const r = await api('/api/push/subscribe', { method: 'POST', body: { endpoint: 'https://example.com/ep', keys: { p256dh: 'x', auth: 'y' } } });
    assert.equal(r.status, 401);
  });

  test('subscribe stores a row, re-subscribing the same endpoint upserts rather than duplicating', async () => {
    const { token, user } = await registerUser({ role: 'carrier', prefix: 'pushok' });
    const endpoint = 'https://fcm.googleapis.com/fcm/send/test-' + Date.now();
    const body = { endpoint, keys: { p256dh: 'p256dh-value', auth: 'auth-value' } };

    const r1 = await api('/api/push/subscribe', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body });
    assert.equal(r1.status, 200);
    const r2 = await api('/api/push/subscribe', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body });
    assert.equal(r2.status, 200);

    const { rows } = await pool.query('SELECT * FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    assert.equal(rows.length, 1, 'upsert should not create a duplicate row');
    assert.equal(rows[0].user_id, user.id);
  });

  test('unsubscribe removes the row, only for the owning user', async () => {
    const { token, user } = await registerUser({ role: 'carrier', prefix: 'pushunsub' });
    const other = await registerUser({ role: 'carrier', prefix: 'pushother' });
    const endpoint = 'https://fcm.googleapis.com/fcm/send/unsub-' + Date.now();
    await api('/api/push/subscribe', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });

    // Другой пользователь не может отписать чужой endpoint (просто не находит строку с своим user_id).
    await api('/api/push/unsubscribe', { method: 'POST', headers: { Authorization: 'Bearer ' + other.token }, body: { endpoint } });
    const stillThere = await pool.query('SELECT id FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    assert.equal(stillThere.rows.length, 1, 'unsubscribe by another user must not delete it');

    const r = await api('/api/push/unsubscribe', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { endpoint } });
    assert.equal(r.status, 200);
    const gone = await pool.query('SELECT id FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
    assert.equal(gone.rows.length, 0);
  });
});

describe('push: notifyCarriersOfNewCargo (service-level, no real push server)', () => {
  test('is a safe no-op when VAPID is not configured', async () => {
    if (push.isConfigured()) return;
    const result = await push.notifyCarriersOfNewCargo(pool, { from_city: 'Алматы', to_city: 'Астана', weight_tons: 5, cargo_type: 'Тест' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not_configured');
  });
});
