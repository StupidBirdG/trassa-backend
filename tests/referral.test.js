const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, promoteAdmin, waitForServer, pool } = require('./helpers');

before(async () => { await waitForServer(); });

describe('referral: code and stats', () => {
  test('GET /api/auth/referral lazily generates a code, invited/rewarded start at 0', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'refcode' });
    const r = await api('/api/auth/referral', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 200);
    assert.ok(r.data.code && r.data.code.length > 0);
    assert.equal(r.data.invited, 0);
    assert.equal(r.data.rewarded, 0);
  });

  test('the same code is returned on repeated calls (not regenerated)', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'refstable' });
    const r1 = await api('/api/auth/referral', { headers: { Authorization: 'Bearer ' + token } });
    const r2 = await api('/api/auth/referral', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r1.data.code, r2.data.code);
  });
});

describe('referral: registration bonus (14-day trial instead of 7)', () => {
  test('carrier registering with a valid ref code gets a 14-day trial', async () => {
    const referrer = await registerUser({ role: 'carrier', prefix: 'refowner1' });
    const refCode = (await api('/api/auth/referral', { headers: { Authorization: 'Bearer ' + referrer.token } })).data.code;

    const invited = await registerUser({ role: 'carrier', prefix: 'refinvited1', ref: refCode });
    const until = new Date(invited.user.subscription_until);
    const daysLeft = (until - new Date()) / 86400000;
    assert.ok(daysLeft > 13 && daysLeft <= 14.1, 'expected ~14 days, got ' + daysLeft);
  });

  test('carrier registering WITHOUT a ref code gets the normal 7-day trial', async () => {
    const { user } = await registerUser({ role: 'carrier', prefix: 'refnone1' });
    const until = new Date(user.subscription_until);
    const daysLeft = (until - new Date()) / 86400000;
    assert.ok(daysLeft > 6 && daysLeft <= 7.1, 'expected ~7 days, got ' + daysLeft);
  });

  test('an unknown/garbage ref code is silently ignored (falls back to normal 7-day trial)', async () => {
    const { user } = await registerUser({ role: 'carrier', prefix: 'refbad1', ref: 'NOSUCHCODE123' });
    const until = new Date(user.subscription_until);
    const daysLeft = (until - new Date()) / 86400000;
    assert.ok(daysLeft > 6 && daysLeft <= 7.1, 'expected ~7 days (ref ignored), got ' + daysLeft);
  });
});

describe('referral: reward on qualifying event', () => {
  test('referrer gets +7 days when their referred SHIPPER posts their first cargo', async () => {
    const referrer = await registerUser({ role: 'carrier', prefix: 'refowner2', skip_trial: true });
    const refCode = (await api('/api/auth/referral', { headers: { Authorization: 'Bearer ' + referrer.token } })).data.code;
    const invitedShipper = await registerUser({ role: 'shipper', prefix: 'refinvited2', ref: refCode });

    // referrer starts with no subscription (skip_trial), so before the reward
    // they should show inactive.
    const before_ = await api('/api/auth/subscription/status', { headers: { Authorization: 'Bearer ' + referrer.token } });
    assert.equal(before_.data.active, false);

    const cargoRes = await api('/api/cargos', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + invitedShipper.token },
      body: { from_city: 'Алматы', to_city: 'Астана', weight_tons: 5, cargo_type: 'general', pickup_date: '2026-08-01', price: 100000 },
    });
    assert.equal(cargoRes.status, 201);

    const after = await api('/api/auth/subscription/status', { headers: { Authorization: 'Bearer ' + referrer.token } });
    assert.equal(after.data.active, true);
    const daysLeft = (new Date(after.data.subscription_until) - new Date()) / 86400000;
    assert.ok(daysLeft > 6 && daysLeft <= 7.1, 'expected ~7 day reward, got ' + daysLeft);

    const stats = await api('/api/auth/referral', { headers: { Authorization: 'Bearer ' + referrer.token } });
    assert.equal(stats.data.invited, 1);
    assert.equal(stats.data.rewarded, 1);
  });

  test('reward is NOT re-granted on a second cargo from the same referred shipper', async () => {
    const referrer = await registerUser({ role: 'carrier', prefix: 'refowner3', skip_trial: true });
    const refCode = (await api('/api/auth/referral', { headers: { Authorization: 'Bearer ' + referrer.token } })).data.code;
    const invitedShipper = await registerUser({ role: 'shipper', prefix: 'refinvited3', ref: refCode });

    const cargoBody = { from_city: 'Алматы', to_city: 'Шымкент', weight_tons: 3, cargo_type: 'general', pickup_date: '2026-08-01', price: 50000 };
    await api('/api/cargos', { method: 'POST', headers: { Authorization: 'Bearer ' + invitedShipper.token }, body: cargoBody });
    const afterFirst = await api('/api/auth/subscription/status', { headers: { Authorization: 'Bearer ' + referrer.token } });
    const untilAfterFirst = afterFirst.data.subscription_until;

    await api('/api/cargos', { method: 'POST', headers: { Authorization: 'Bearer ' + invitedShipper.token }, body: cargoBody });
    const afterSecond = await api('/api/auth/subscription/status', { headers: { Authorization: 'Bearer ' + referrer.token } });
    assert.equal(afterSecond.data.subscription_until, untilAfterFirst, 'second cargo must not grant a second reward');
  });

  test('referrer gets +7 days when their referred CARRIER gets a manual Kaspi payment confirmed by admin', async () => {
    const referrer = await registerUser({ role: 'carrier', prefix: 'refowner4', skip_trial: true });
    const refCode = (await api('/api/auth/referral', { headers: { Authorization: 'Bearer ' + referrer.token } })).data.code;
    const invitedCarrier = await registerUser({ role: 'carrier', prefix: 'refinvited4', ref: refCode, skip_trial: true });
    const admin = await registerUser({ role: 'shipper', prefix: 'refadmin4' });
    await promoteAdmin(admin.user.id);

    const orderId = 'TRASSA-REFTEST-' + Date.now();
    const { rows } = await pool.query(
      "INSERT INTO payments (user_id, order_id, tier, amount, status, provider) VALUES ($1,$2,'basic',9000,'pending','manual_kaspi') RETURNING id",
      [invitedCarrier.user.id, orderId]
    );

    const confirm = await api('/api/admin/payments/' + rows[0].id + '/confirm', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(confirm.status, 200);

    const after = await api('/api/auth/subscription/status', { headers: { Authorization: 'Bearer ' + referrer.token } });
    assert.equal(after.data.active, true);
    const daysLeft = (new Date(after.data.subscription_until) - new Date()) / 86400000;
    assert.ok(daysLeft > 6 && daysLeft <= 7.1, 'expected ~7 day reward, got ' + daysLeft);
  });

  test('no reward when the user was never referred (no referred_by)', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'reflonewolf' });
    const cargoRes = await api('/api/cargos', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: { from_city: 'Алматы', to_city: 'Караганда', weight_tons: 2, cargo_type: 'general', pickup_date: '2026-08-01', price: 30000 },
    });
    assert.equal(cargoRes.status, 201); // just confirms it doesn't error out with no referrer
  });
});
