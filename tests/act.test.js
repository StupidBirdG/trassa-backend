const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { BASE, registerUser, waitForServer } = require('./helpers');

before(async () => { await waitForServer(); });

// Раздача PDF — не JSON, поэтому не используем helpers.api() (парсит JSON тело).
async function rawGet(path, token) {
  const res = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get('content-type'), buf };
}

async function setupDeliveredCargo() {
  const shipper = await registerUser({ role: 'shipper', prefix: 'acttest' });
  const carrier = await registerUser({ role: 'carrier', prefix: 'acttest', skip_trial: true });

  const cargoRes = await fetch(BASE + '/api/cargos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + shipper.token },
    body: JSON.stringify({ from_city: 'Алматы', to_city: 'Астана', weight_tons: 5, cargo_type: 'Стройматериалы', pickup_date: '2026-08-01', price: 150000 }),
  });
  const cargo = await cargoRes.json();

  const bidRes = await fetch(BASE + '/api/cargos/' + cargo.id + '/bids', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + carrier.token },
    body: JSON.stringify({ truck_type: 'Тент 20т', price: 140000 }),
  });
  const bid = await bidRes.json();

  await fetch(BASE + '/api/cargos/' + cargo.id + '/accept/' + bid.id, { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });

  return { shipper, carrier, cargoId: cargo.id };
}

describe('cargo delivery act (PDF)', () => {
  test('act is unavailable before delivery -> 400', async () => {
    const { shipper, cargoId } = await setupDeliveredCargo();
    const r = await rawGet('/api/cargos/' + cargoId + '/act', shipper.token);
    assert.equal(r.status, 400);
  });

  test('after delivery, both shipper and carrier can download a valid PDF act', async () => {
    const { shipper, carrier, cargoId } = await setupDeliveredCargo();
    await fetch(BASE + '/api/cargos/' + cargoId + '/deliver', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });

    const asShipper = await rawGet('/api/cargos/' + cargoId + '/act', shipper.token);
    assert.equal(asShipper.status, 200);
    assert.equal(asShipper.contentType, 'application/pdf');
    assert.equal(asShipper.buf.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(asShipper.buf.length > 500, 'PDF should not be a near-empty stub');

    const asCarrier = await rawGet('/api/cargos/' + cargoId + '/act', carrier.token);
    assert.equal(asCarrier.status, 200);
    assert.equal(asCarrier.buf.subarray(0, 5).toString('ascii'), '%PDF-');
  });

  test('an unrelated user cannot download the act -> 403', async () => {
    const { shipper, cargoId } = await setupDeliveredCargo();
    await fetch(BASE + '/api/cargos/' + cargoId + '/deliver', { method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token } });

    const outsider = await registerUser({ role: 'shipper', prefix: 'actoutsider' });
    const r = await rawGet('/api/cargos/' + cargoId + '/act', outsider.token);
    assert.equal(r.status, 403);
  });

  test('nonexistent cargo -> 404', async () => {
    const { shipper } = await setupDeliveredCargo();
    const r = await rawGet('/api/cargos/00000000-0000-0000-0000-000000000000/act', shipper.token);
    assert.equal(r.status, 404);
  });
});
