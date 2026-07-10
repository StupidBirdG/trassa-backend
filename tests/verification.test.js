const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, promoteAdmin, waitForServer } = require('./helpers');

before(async () => { await waitForServer(); });

async function makeAdmin(prefix) {
  const admin = await registerUser({ role: 'shipper', prefix });
  await promoteAdmin(admin.user.id);
  return admin;
}

// Крошечный валидный PNG (1x1 px), достаточно для проверки логики без реального фото.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('verification: uploading a document', () => {
  test('unauthenticated upload -> 401', async () => {
    const r = await api('/api/verification/upload', { method: 'POST', body: { doc_type: 'drivers_license', file_base64: TINY_PNG_BASE64, mime_type: 'image/png' } });
    assert.equal(r.status, 401);
  });

  test('unknown doc_type -> 400', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'verifbadtype' });
    const r = await api('/api/verification/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { doc_type: 'passport_of_a_wizard', file_base64: TINY_PNG_BASE64, mime_type: 'image/png' } });
    assert.equal(r.status, 400);
  });

  test('disallowed mime type -> 400', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'verifbadmime' });
    const r = await api('/api/verification/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { doc_type: 'drivers_license', file_base64: TINY_PNG_BASE64, mime_type: 'application/x-msdownload' } });
    assert.equal(r.status, 400);
  });

  test('missing file -> 400', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'verifnofile' });
    const r = await api('/api/verification/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { doc_type: 'drivers_license', mime_type: 'image/png' } });
    assert.equal(r.status, 400);
  });

  test('a valid upload succeeds and appears in /mine as pending', async () => {
    const { token } = await registerUser({ role: 'carrier', prefix: 'verifok' });
    const upload = await api('/api/verification/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: { doc_type: 'drivers_license', file_base64: TINY_PNG_BASE64, mime_type: 'image/png' } });
    assert.equal(upload.status, 201);
    assert.equal(upload.data.status, 'pending');

    const mine = await api('/api/verification/mine', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(mine.status, 200);
    assert.ok(mine.data.some((d) => d.id === upload.data.id && d.status === 'pending'));
  });
});

describe('verification: admin review queue', () => {
  test('non-admin cannot access the verification queue -> 403', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'verifnotadmin' });
    const r = await api('/api/admin/verification-queue', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 403);
  });

  test('approving a document sets it approved AND flips users.verified to true', async () => {
    const admin = await makeAdmin('verifadmin1');
    const carrier = await registerUser({ role: 'carrier', prefix: 'verifapprove' });

    const before_ = await api('/api/auth/me', { headers: { Authorization: 'Bearer ' + carrier.token } });
    assert.equal(before_.data.verified, false);

    const upload = await api('/api/verification/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token }, body: { doc_type: 'vehicle_passport', file_base64: TINY_PNG_BASE64, mime_type: 'image/png' } });

    const queue = await api('/api/admin/verification-queue', { headers: { Authorization: 'Bearer ' + admin.token } });
    assert.ok(queue.data.some((d) => d.id === upload.data.id));

    const approve = await api('/api/admin/verification/' + upload.data.id + '/approve', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(approve.status, 200);

    const after = await api('/api/auth/me', { headers: { Authorization: 'Bearer ' + carrier.token } });
    assert.equal(after.data.verified, true);

    const mine = await api('/api/verification/mine', { headers: { Authorization: 'Bearer ' + carrier.token } });
    const doc = mine.data.find((d) => d.id === upload.data.id);
    assert.equal(doc.status, 'approved');
  });

  test('rejecting a document records the reason and does NOT verify the user', async () => {
    const admin = await makeAdmin('verifadmin2');
    const carrier = await registerUser({ role: 'carrier', prefix: 'verifreject' });
    const upload = await api('/api/verification/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token }, body: { doc_type: 'id_card', file_base64: TINY_PNG_BASE64, mime_type: 'image/png' } });

    const reject = await api('/api/admin/verification/' + upload.data.id + '/reject', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token }, body: { reason: 'Фото размыто' } });
    assert.equal(reject.status, 200);

    const mine = await api('/api/verification/mine', { headers: { Authorization: 'Bearer ' + carrier.token } });
    const doc = mine.data.find((d) => d.id === upload.data.id);
    assert.equal(doc.status, 'rejected');
    assert.equal(doc.rejection_reason, 'Фото размыто');

    const after = await api('/api/auth/me', { headers: { Authorization: 'Bearer ' + carrier.token } });
    assert.equal(after.data.verified, false);
  });

  test('approving the same document twice -> 404 on the second attempt', async () => {
    const admin = await makeAdmin('verifadmin3');
    const carrier = await registerUser({ role: 'carrier', prefix: 'verifdouble' });
    const upload = await api('/api/verification/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token }, body: { doc_type: 'company_cert', file_base64: TINY_PNG_BASE64, mime_type: 'image/png' } });

    const first = await api('/api/admin/verification/' + upload.data.id + '/approve', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(first.status, 200);
    const second = await api('/api/admin/verification/' + upload.data.id + '/approve', { method: 'POST', headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(second.status, 404);
  });

  test('the uploaded file can be fetched back by an admin and matches what was sent', async () => {
    const admin = await makeAdmin('verifadmin4');
    const carrier = await registerUser({ role: 'carrier', prefix: 'verifgetfile' });
    const upload = await api('/api/verification/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + carrier.token }, body: { doc_type: 'id_card', file_base64: TINY_PNG_BASE64, mime_type: 'image/png' } });

    const res = await fetch(require('./helpers').BASE + '/api/admin/verification/' + upload.data.id + '/file', { headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(buf.toString('base64'), TINY_PNG_BASE64);
  });
});
