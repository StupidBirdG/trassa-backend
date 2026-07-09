const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, waitForServer } = require('./helpers');

before(async () => { await waitForServer(); });

describe('subscription: tiers catalog', () => {
  test('status returns exactly 3 tiers with correct prices', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'tiercatalog' });
    const r = await api('/api/auth/subscription/status', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 200);
    assert.equal(Object.keys(r.data.tiers).length, 3);
    assert.equal(r.data.tiers.basic.price, 9000);
    assert.equal(r.data.tiers.pro.price, 15000);
    assert.equal(r.data.tiers.business.price, 25000);
  });

  test('activating pro tier updates status', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'tierpro' });
    const activate = await api('/api/auth/subscription/activate', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { tier: 'pro' } });
    assert.equal(activate.status, 200);
    assert.equal(activate.data.tier, 'pro');
    assert.equal(activate.data.price, 15000);

    const status = await api('/api/auth/subscription/status', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(status.data.tier, 'pro');
  });

  test('activating an unknown tier -> 400', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'tierbad' });
    const r = await api('/api/auth/subscription/activate', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { tier: 'ultra' } });
    assert.equal(r.status, 400);
  });
});
