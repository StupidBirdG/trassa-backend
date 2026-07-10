const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, waitForServer } = require('./helpers');

before(async () => { await waitForServer(); });

describe('stats: /api/stats/me shape by role', () => {
  test('carrier with no activity gets zeroed-out stats, not an error', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'statsemptycarrier', skip_trial: true });
    const r = await api('/api/stats/me', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 200);
    assert.equal(r.data.role, 'carrier');
    assert.equal(r.data.bids_sent, 0);
    assert.equal(r.data.bids_accepted, 0);
    assert.equal(r.data.acceptance_rate, 0);
    assert.equal(r.data.total_earnings, 0);
    assert.ok(Array.isArray(r.data.monthly_earnings));
  });

  test('shipper with no activity gets zeroed-out stats, not an error', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'statsemptyshipper' });
    const r = await api('/api/stats/me', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 200);
    assert.equal(r.data.role, 'shipper');
    assert.equal(r.data.cargos_posted, 0);
    assert.equal(r.data.cargos_delivered, 0);
    assert.equal(r.data.total_spent, 0);
  });

  test('unauthenticated request -> 401', async () => {
    const r = await api('/api/stats/me');
    assert.equal(r.status, 401);
  });
});

describe('stats: real numbers after a full delivered cargo', () => {
  test('carrier earnings and acceptance rate reflect an actually delivered cargo', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'statsflow-shipper' });
    const carrier = await registerUser({ role: 'carrier', prefix: 'statsflow-carrier', skip_trial: true });

    const cargoRes = await api('/api/cargos', {
      method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token },
      body: { from_city: 'StatsA', to_city: 'StatsB', weight_tons: 5, cargo_type: 'General', pickup_date: '2026-08-01', price: 100000 },
    });
    const cargo = cargoRes.data;
    const bidRes = await api('/api/cargos/' + cargo.id + '/bids', {
      method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
      body: { truck_type: 'Тент 20т', price: 90000 },
    });
    const bid = bidRes.data;
    await api('/api/cargos/' + cargo.id + '/accept/' + bid.id, { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });
    await api('/api/cargos/' + cargo.id + '/deliver', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });

    const carrierStats = await api('/api/stats/me', { headers: { Authorization: 'Bearer ' + carrier.token } });
    assert.equal(carrierStats.data.bids_sent, 1);
    assert.equal(carrierStats.data.bids_accepted, 1);
    assert.equal(carrierStats.data.acceptance_rate, 100);
    assert.equal(carrierStats.data.total_earnings, 90000);
    assert.equal(carrierStats.data.completed_deliveries, 1);

    const shipperStats = await api('/api/stats/me', { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(shipperStats.data.cargos_posted, 1);
    assert.equal(shipperStats.data.cargos_delivered, 1);
    assert.equal(shipperStats.data.total_spent, 90000);

    const thisMonth = new Date().toISOString().slice(0, 7);
    const carrierMonthEntry = carrierStats.data.monthly_earnings.find(m => m.month === thisMonth);
    assert.ok(carrierMonthEntry, 'this month should appear in monthly_earnings');
    assert.equal(carrierMonthEntry.total, 90000);
  });

  test('a rejected bid does not count toward earnings or acceptance', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'statsrej-shipper' });
    const carrierA = await registerUser({ role: 'carrier', prefix: 'statsrej-a', skip_trial: true });
    const carrierB = await registerUser({ role: 'carrier', prefix: 'statsrej-b', skip_trial: true });

    const cargoRes = await api('/api/cargos', {
      method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token },
      body: { from_city: 'StatsC', to_city: 'StatsD', weight_tons: 5, cargo_type: 'General', pickup_date: '2026-08-01', price: 100000 },
    });
    const cargo = cargoRes.data;
    const bidA = (await api('/api/cargos/' + cargo.id + '/bids', { method: 'POST', headers: { Authorization: 'Bearer ' + carrierA.token }, body: { truck_type: 'Тент 20т', price: 80000 } })).data;
    await api('/api/cargos/' + cargo.id + '/bids', { method: 'POST', headers: { Authorization: 'Bearer ' + carrierB.token }, body: { truck_type: 'Тент 5т', price: 70000 } });
    // Accept carrierA's bid -> carrierB's bid gets auto-rejected by the accept endpoint
    await api('/api/cargos/' + cargo.id + '/accept/' + bidA.id, { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });

    const bStats = await api('/api/stats/me', { headers: { Authorization: 'Bearer ' + carrierB.token } });
    assert.equal(bStats.data.bids_sent, 1);
    assert.equal(bStats.data.bids_accepted, 0);
    assert.equal(bStats.data.total_earnings, 0);
  });
});
