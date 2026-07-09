const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, waitForServer, pool } = require('./helpers');

before(async () => { await waitForServer(); });

async function makeAcceptedDeal(prefix) {
  const shipper = await registerUser({ role: 'shipper', prefix: prefix + '-shipper' });
  const carrier = await registerUser({ role: 'carrier', prefix: prefix + '-carrier' });
  const cargo = (await api('/api/cargos', {
    method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token },
    body: { from_city: 'RevA', to_city: 'RevB', weight_tons: 5, cargo_type: 'General', pickup_date: '2026-08-01', price: 100000 },
  })).data;
  const bid = (await api('/api/cargos/' + cargo.id + '/bids', {
    method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
    body: { truck_type: 'Tent 5t', price: 95000 },
  })).data;
  await api('/api/cargos/' + cargo.id + '/accept/' + bid.id, { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });
  return { shipper, carrier, cargo, bid };
}

describe('reviews: 48-hour window (fixed 2026-07-09, was previously always-open due to missing bids.updated_at)', () => {
  test('bids.updated_at is set to a real, recent timestamp when a bid is accepted', async () => {
    const { bid } = await makeAcceptedDeal('window-fresh');
    const { rows } = await pool.query('SELECT updated_at FROM bids WHERE id=$1', [bid.id]);
    assert.ok(rows[0].updated_at, 'updated_at must not be null');
    const ageMs = Date.now() - new Date(rows[0].updated_at).getTime();
    assert.ok(ageMs >= 0 && ageMs < 60000, 'updated_at should be within the last minute, got age_ms=' + ageMs);
  });

  test('within the window: can_review is true, and a review can be submitted', async () => {
    const { shipper, bid } = await makeAcceptedDeal('window-open');
    const status = await api('/api/reviews/order/' + bid.id, { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(status.status, 200);
    assert.equal(status.data.window_open, true);
    assert.equal(status.data.can_review, true);

    const submit = await api('/api/reviews', {
      method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token },
      body: { order_id: bid.id, rating_overall: 5, comment: 'ci test review' },
    });
    assert.equal(submit.status, 201);
  });

  test('after the 48h window has passed, can_review is false and submitting is rejected', async () => {
    const { shipper, bid } = await makeAcceptedDeal('window-expired');

    // Simulate 49 hours having passed since acceptance — directly, since we can't
    // wait 49 real hours in a test. This is exactly the scenario the original bug
    // failed to catch (NaN comparison silently always allowed submission).
    await pool.query("UPDATE bids SET updated_at = now() - interval '49 hours' WHERE id=$1", [bid.id]);

    const status = await api('/api/reviews/order/' + bid.id, { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(status.data.window_open, false);
    assert.equal(status.data.can_review, false);

    const submit = await api('/api/reviews', {
      method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token },
      body: { order_id: bid.id, rating_overall: 5, comment: 'should be rejected' },
    });
    assert.equal(submit.status, 400, 'submitting a review outside the 48h window must be rejected');
  });
});
