const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, waitForServer, pool } = require('./helpers');

before(async () => { await waitForServer(); });

async function makeCargo(shipperToken, overrides = {}) {
  const body = {
    from_city: 'AiCityA', to_city: 'AiCityB', weight_tons: 5,
    cargo_type: 'General', pickup_date: '2026-08-01', price: 100000,
    ...overrides,
  };
  return api('/api/cargos', { method: 'POST', headers: { Authorization: 'Bearer ' + shipperToken }, body });
}

describe('public: route-price transparency (no auth required)', () => {
  test('route with no data -> available:false', async () => {
    const r = await api('/api/public/route-price?from_city=NoDataRoute&to_city=Nowhere');
    assert.equal(r.status, 200);
    assert.equal(r.data.available, false);
  });

  test('missing params -> 400', async () => {
    const r = await api('/api/public/route-price');
    assert.equal(r.status, 400);
  });

  test('route with cargo history is visible WITHOUT any Authorization header', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'routeprice-shipper' });
    await makeCargo(shipper.token, { from_city: 'RoutePriceA', to_city: 'RoutePriceB', price: 200000 });

    const r = await api('/api/public/route-price?from_city=RoutePriceA&to_city=RoutePriceB');
    assert.equal(r.status, 200);
    assert.equal(r.data.available, true);
    assert.equal(r.data.avg, 200000);
  });
});

describe('public: company catalog', () => {
  test('returns an array without requiring auth', async () => {
    const r = await api('/api/public/companies');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data));
  });
});

describe('ai: suggest-carriers', () => {
  test('owner-only; ranks eligible carriers and excludes those who already bid', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'match-shipper' });
    const carrier1 = await registerUser({ role: 'carrier', prefix: 'match-carrier1' });
    const carrier2 = await registerUser({ role: 'carrier', prefix: 'match-carrier2' });
    const cargo = (await makeCargo(shipper.token, { from_city: 'MatchA', to_city: 'MatchB' })).data;

    // The real endpoint only returns the top 10 by score (correct production behavior) —
    // with many carriers created by other test files sharing this DB, two brand-new,
    // no-history carriers aren't guaranteed a top-10 slot. Boost them directly so the
    // test is deterministic regardless of what else is in the database.
    await pool.query('UPDATE users SET completed_deliveries=999, rating=5.0 WHERE id=ANY($1)', [[carrier1.user.id, carrier2.user.id]]);

    const forbidden = await api('/api/ai/suggest-carriers/' + cargo.id, { headers: { Authorization: 'Bearer ' + carrier1.token } });
    assert.equal(forbidden.status, 403);

    const before = await api('/api/ai/suggest-carriers/' + cargo.id, { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(before.status, 200);
    const idsBefore = before.data.suggestions.map((s) => s.id);
    assert.ok(idsBefore.includes(carrier1.user.id));
    assert.ok(idsBefore.includes(carrier2.user.id));

    await api('/api/cargos/' + cargo.id + '/bids', {
      method: 'POST', headers: { Authorization: 'Bearer ' + carrier1.token },
      body: { truck_type: 'Tent 5t', price: 90000 },
    });

    const after = await api('/api/ai/suggest-carriers/' + cargo.id, { headers: { Authorization: 'Bearer ' + shipper.token } });
    const idsAfter = after.data.suggestions.map((s) => s.id);
    assert.ok(!idsAfter.includes(carrier1.user.id), 'carrier1 already bid, should be excluded');
    assert.ok(idsAfter.includes(carrier2.user.id));
  });

  test('nonexistent cargo -> 404', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'match-404' });
    const r = await api('/api/ai/suggest-carriers/00000000-0000-0000-0000-000000000000', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 404);
  });
});

describe('ai: suggest-price', () => {
  test('insufficient data -> available:false', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'price-nodata' });
    const r = await api('/api/ai/suggest-price?from_city=NoHistoryRouteA&to_city=NoHistoryRouteB', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 200);
    assert.equal(r.data.available, false);
  });

  test('with cargo history, returns a suggested price and range', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'price-shipper' });
    for (let i = 0; i < 3; i++) {
      await makeCargo(shipper.token, { from_city: 'PriceRouteA', to_city: 'PriceRouteB', price: 100000 + i * 10000 });
    }
    const r = await api('/api/ai/suggest-price?from_city=PriceRouteA&to_city=PriceRouteB', { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(r.status, 200);
    assert.equal(r.data.available, true);
    assert.ok(r.data.sample_size >= 3);
    assert.ok(r.data.suggested_price > 0);
  });
});
