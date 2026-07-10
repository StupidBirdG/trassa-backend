const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, waitForServer } = require('./helpers');

before(async () => { await waitForServer(); });

async function makeCargo(shipperToken, overrides = {}) {
  const body = {
    from_city: 'AbuseCityA', to_city: 'AbuseCityB', weight_tons: 5,
    cargo_type: 'General', pickup_date: '2026-08-01', price: 100000,
    ...overrides,
  };
  return api('/api/cargos', { method: 'POST', headers: { Authorization: 'Bearer ' + shipperToken }, body });
}

describe('anti-abuse: daily limits for fresh accounts', () => {
  test('a fresh shipper account is blocked after 5 cargo posts in a day, with 429 + code', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'abuse-shipper1' });
    for (let i = 0; i < 5; i++) {
      const r = await makeCargo(shipper.token, { price: 90000 + i });
      assert.equal(r.status, 201, 'cargo #' + (i + 1) + ' should succeed');
    }
    const sixth = await makeCargo(shipper.token, { price: 99999 });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.data.code, 'new_account_daily_limit');
  });

  test('a fresh carrier account is blocked after 10 bids in a day, with 429 + code', async () => {
    const { pool } = require('./helpers');
    // This test needs 11 cargos to generate 11 bid attempts — backdate the SHIPPER's
    // account so its own 5-cargo/day limit doesn't interfere; the carrier's bid limit
    // is what's under test here, not the shipper's cargo limit.
    const shipper = await registerUser({ role: 'shipper', prefix: 'abuse-shipper2' });
    await pool.query("UPDATE users SET created_at = now() - interval '30 days' WHERE id=$1", [shipper.user.id]);
    const carrier = await registerUser({ role: 'carrier', prefix: 'abuse-carrier1' }); // default trial -> active sub, so freemium limit doesn't interfere

    for (let i = 0; i < 10; i++) {
      const cargo = (await makeCargo(shipper.token, { price: 80000 + i })).data;
      const bid = await api('/api/cargos/' + cargo.id + '/bids', {
        method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
        body: { truck_type: 'Тент 5т', price: 75000 },
      });
      assert.equal(bid.status, 201, 'bid #' + (i + 1) + ' should succeed');
    }

    const eleventhCargo = (await makeCargo(shipper.token, { price: 89999 })).data;
    const blocked = await api('/api/cargos/' + eleventhCargo.id + '/bids', {
      method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
      body: { truck_type: 'Тент 5т', price: 75000 },
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.code, 'new_account_daily_limit');
  });

  test('the limit does not apply to an account older than the new-account window', async () => {
    const { pool } = require('./helpers');
    const shipper = await registerUser({ role: 'shipper', prefix: 'abuse-old-shipper' });
    // Backdate created_at past the 7-day new-account window, simulating an established account.
    await pool.query("UPDATE users SET created_at = now() - interval '30 days' WHERE id=$1", [shipper.user.id]);

    for (let i = 0; i < 6; i++) {
      const r = await makeCargo(shipper.token, { price: 70000 + i });
      assert.equal(r.status, 201, 'cargo #' + (i + 1) + ' should succeed for an established account (limit is for new accounts only)');
    }
  });
});
