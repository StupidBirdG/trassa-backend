const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, waitForServer } = require('./helpers');

before(async () => { await waitForServer(); });

async function makeCargo(shipperToken, overrides = {}) {
  const body = {
    from_city: 'CiCityA', to_city: 'CiCityB', weight_tons: 5,
    cargo_type: 'General', pickup_date: '2026-08-01', price: 100000,
    ...overrides,
  };
  return api('/api/cargos', { method: 'POST', headers: { Authorization: 'Bearer ' + shipperToken }, body });
}

describe('cargos: validation', () => {
  test('POST /api/cargos with empty body -> 400 with missing_fields array', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'validation-shipper' });
    const r = await api('/api/cargos', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: {} });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.data.missing_fields));
    assert.ok(r.data.missing_fields.includes('from_city'));
  });

  test('only a shipper can create a cargo, not a carrier', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'validation-carrier' });
    const r = await makeCargo(token);
    assert.equal(r.status, 403);
  });

  test('a valid cargo is created successfully', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'valid-cargo' });
    const r = await makeCargo(token);
    assert.equal(r.status, 201);
    assert.ok(r.data.id);
    assert.equal(r.data.status, 'open');
  });
});

describe('cargos: views tracking ("who viewed my cargo")', () => {
  test('a carrier viewing a cargo is logged, visible only to the owner', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'views-shipper' });
    const carrier = await registerUser({ role: 'carrier', prefix: 'views-carrier' });
    const cargo = (await makeCargo(shipper.token)).data;

    const view = await api('/api/cargos/' + cargo.id, { headers: { Authorization: 'Bearer ' + carrier.token } });
    assert.equal(view.status, 200);

    const viewersAsOwner = await api('/api/cargos/' + cargo.id + '/viewers', { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(viewersAsOwner.status, 200);
    assert.equal(viewersAsOwner.data.unique_viewers, 1);

    const viewersAsNonOwner = await api('/api/cargos/' + cargo.id + '/viewers', { headers: { Authorization: 'Bearer ' + carrier.token } });
    assert.equal(viewersAsNonOwner.status, 403);
  });
});

describe('cargos: freemium bid limit (3/month for carriers without a subscription)', () => {
  test('carrier without subscription gets exactly 3 free bids, then blocked', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'freemium-shipper' });
    const carrier = await registerUser({ role: 'carrier', prefix: 'freemium-carrier', skip_trial: true });

    const status0 = await api('/api/auth/subscription/status', { headers: { Authorization: 'Bearer ' + carrier.token } });
    assert.equal(status0.data.free_bids_remaining, 3);

    for (let i = 0; i < 3; i++) {
      const cargo = (await makeCargo(shipper.token, { price: 90000 + i })).data;
      const bid = await api('/api/cargos/' + cargo.id + '/bids', {
        method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
        body: { truck_type: 'Tent 5t', price: 85000 },
      });
      assert.equal(bid.status, 201, 'bid #' + (i + 1) + ' should succeed');
      assert.equal(bid.data.free_bids_remaining, 2 - i);
    }

    const fourthCargo = (await makeCargo(shipper.token, { price: 95000 })).data;
    const blocked = await api('/api/cargos/' + fourthCargo.id + '/bids', {
      method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
      body: { truck_type: 'Tent 5t', price: 85000 },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.data.code, 'free_limit_reached');
  });

  test('a carrier with an active subscription is unaffected by the free limit', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'unlimited-shipper' });
    const carrier = await registerUser({ role: 'carrier', prefix: 'unlimited-carrier' }); // default trial = active sub
    const cargo = (await makeCargo(shipper.token)).data;
    const bid = await api('/api/cargos/' + cargo.id + '/bids', {
      method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
      body: { truck_type: 'Tent 5t', price: 85000 },
    });
    assert.equal(bid.status, 201);
    assert.equal(bid.data.free_bids_used, undefined, 'subscribed carriers should not carry free_bids_* fields');
  });
});

describe('cargos: GPS location', () => {
  test('carrier can share real coordinates after their bid is accepted, shipper can read them', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'gps-shipper' });
    const carrier = await registerUser({ role: 'carrier', prefix: 'gps-carrier' });
    const cargo = (await makeCargo(shipper.token)).data;

    const bid = (await api('/api/cargos/' + cargo.id + '/bids', {
      method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
      body: { truck_type: 'Tent 20t', price: 95000 },
    })).data;

    const accept = await api('/api/cargos/' + cargo.id + '/accept/' + bid.id, { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(accept.status, 200);

    const setLoc = await api('/api/cargos/' + cargo.id + '/location', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + carrier.token },
      body: { lat: 43.238949, lng: 76.889709 },
    });
    assert.equal(setLoc.status, 200);

    const getLoc = await api('/api/cargos/' + cargo.id + '/location', { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(getLoc.status, 200);
    assert.equal(getLoc.data.available, true);
    assert.ok(Math.abs(getLoc.data.lat - 43.238949) < 0.001);
  });

  test('invalid coordinates are rejected', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'gpsbad-shipper' });
    const carrier = await registerUser({ role: 'carrier', prefix: 'gpsbad-carrier' });
    const cargo = (await makeCargo(shipper.token)).data;
    const bid = (await api('/api/cargos/' + cargo.id + '/bids', {
      method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
      body: { truck_type: 'Tent 20t', price: 95000 },
    })).data;
    await api('/api/cargos/' + cargo.id + '/accept/' + bid.id, { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });

    const bad = await api('/api/cargos/' + cargo.id + '/location', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + carrier.token },
      body: { lat: 999, lng: 76.88 },
    });
    assert.equal(bad.status, 400);
  });
});
