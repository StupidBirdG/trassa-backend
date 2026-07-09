const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, promoteAdmin, waitForServer } = require('./helpers');

before(async () => { await waitForServer(); });

async function makeAcceptedDeal(prefix) {
  const shipper = await registerUser({ role: 'shipper', prefix: prefix + '-shipper' });
  const carrier = await registerUser({ role: 'carrier', prefix: prefix + '-carrier' });
  const cargo = (await api('/api/cargos', {
    method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token },
    body: { from_city: 'DispA', to_city: 'DispB', weight_tons: 5, cargo_type: 'General', pickup_date: '2026-08-01', price: 100000 },
  })).data;
  const bid = (await api('/api/cargos/' + cargo.id + '/bids', {
    method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token },
    body: { truck_type: 'Tent 5t', price: 95000 },
  })).data;
  await api('/api/cargos/' + cargo.id + '/accept/' + bid.id, { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });
  return { shipper, carrier, cargo, bid };
}

describe('disputes: filing a complaint about a deal', () => {
  test('a participant can file a dispute against the other side', async () => {
    const { shipper, carrier, bid } = await makeAcceptedDeal('file-basic');
    const r = await api('/api/disputes', {
      method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token },
      body: { bid_id: bid.id, reason: 'no_show', description: 'Перевозчик не приехал' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.dispute.complainant_id, shipper.user.id);
    assert.equal(r.data.dispute.respondent_id, carrier.user.id);
    assert.equal(r.data.dispute.status, 'open');
  });

  test('non-participant cannot file a dispute', async () => {
    const { bid } = await makeAcceptedDeal('file-outsider');
    const outsider = await registerUser({ role: 'shipper', prefix: 'disp-outsider' });
    const r = await api('/api/disputes', {
      method: 'POST', headers: { Authorization: 'Bearer ' + outsider.token },
      body: { bid_id: bid.id, reason: 'other' },
    });
    assert.equal(r.status, 403);
  });

  test('missing reason -> 400', async () => {
    const { shipper, bid } = await makeAcceptedDeal('file-missing');
    const r = await api('/api/disputes', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token }, body: { bid_id: bid.id } });
    assert.equal(r.status, 400);
  });

  test('filing twice on the same bid by the same complainant -> 409', async () => {
    const { shipper, bid } = await makeAcceptedDeal('file-dup');
    const first = await api('/api/disputes', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token }, body: { bid_id: bid.id, reason: 'no_show' } });
    assert.equal(first.status, 201);
    const second = await api('/api/disputes', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token }, body: { bid_id: bid.id, reason: 'other' } });
    assert.equal(second.status, 409);
  });

  test('unaccepted bid cannot be disputed', async () => {
    const shipper = await registerUser({ role: 'shipper', prefix: 'disp-pending-s' });
    const carrier = await registerUser({ role: 'carrier', prefix: 'disp-pending-c' });
    const cargo = (await api('/api/cargos', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token }, body: { from_city: 'DispC', to_city: 'DispD', weight_tons: 3, cargo_type: 'General', pickup_date: '2026-08-01', price: 50000 } })).data;
    const bid = (await api('/api/cargos/' + cargo.id + '/bids', { method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token }, body: { truck_type: 'Tent 3t', price: 45000 } })).data;
    const r = await api('/api/disputes', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token }, body: { bid_id: bid.id, reason: 'no_show' } });
    assert.equal(r.status, 404);
  });
});

describe('disputes: /bid/:bidId status + /mine', () => {
  test('/bid/:bidId reflects already_filed', async () => {
    const { shipper, bid } = await makeAcceptedDeal('status-check');
    const before_ = await api('/api/disputes/bid/' + bid.id, { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(before_.data.already_filed, false);

    await api('/api/disputes', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token }, body: { bid_id: bid.id, reason: 'no_show' } });

    const after = await api('/api/disputes/bid/' + bid.id, { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(after.data.already_filed, true);
    assert.equal(after.data.dispute.status, 'open');
  });

  test('/mine lists disputes for both complainant and respondent', async () => {
    const { shipper, carrier, bid } = await makeAcceptedDeal('mine-check');
    await api('/api/disputes', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token }, body: { bid_id: bid.id, reason: 'no_show' } });

    const asComplainant = await api('/api/disputes/mine', { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.ok(asComplainant.data.some(d => d.bid_id === bid.id));

    const asRespondent = await api('/api/disputes/mine', { headers: { Authorization: 'Bearer ' + carrier.token } });
    assert.ok(asRespondent.data.some(d => d.bid_id === bid.id));
  });
});

describe('disputes: admin moderation', () => {
  test('non-admin gets 403 on /admin/disputes', async () => {
    const { shipper } = await makeAcceptedDeal('admin-403');
    const r = await api('/api/admin/disputes', { headers: { Authorization: 'Bearer ' + shipper.token } });
    assert.equal(r.status, 403);
  });

  test('admin can list open disputes and resolve one', async () => {
    const { shipper, bid } = await makeAcceptedDeal('admin-resolve');
    const admin = await registerUser({ role: 'shipper', prefix: 'disp-admin' });
    await promoteAdmin(admin.user.id);

    const created = await api('/api/disputes', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token }, body: { bid_id: bid.id, reason: 'no_show', description: 'test' } });
    const disputeId = created.data.dispute.id;

    const list = await api('/api/admin/disputes?status=open', { headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(list.status, 200);
    assert.ok(list.data.some(d => d.id === disputeId));

    const resolve = await api('/api/admin/disputes/' + disputeId + '/resolve', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token }, body: { resolution: 'Разобрались, перевозчик оштрафован' } });
    assert.equal(resolve.status, 200);

    const resolveAgain = await api('/api/admin/disputes/' + disputeId + '/resolve', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token }, body: { resolution: 'повторно' } });
    assert.equal(resolveAgain.status, 404);
  });
});
