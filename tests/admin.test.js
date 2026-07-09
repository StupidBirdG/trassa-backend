const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, promoteAdmin, waitForServer } = require('./helpers');

before(async () => { await waitForServer(); });

async function makeAdmin(prefix) {
  const admin = await registerUser({ role: 'shipper', prefix });
  await promoteAdmin(admin.user.id);
  return admin;
}

describe('admin: access control', () => {
  test('non-admin gets 403 on all /admin/* routes', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'notadmin' });
    for (const path of ['/api/admin/users', '/api/admin/cargos', '/api/admin/stats']) {
      const r = await api(path, { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(r.status, 403, path + ' should be 403 for a non-admin');
    }
  });

  test('admin can access /admin/stats and it has the expected shape', async () => {
    const admin = await makeAdmin('adminstats');
    const r = await api('/api/admin/stats', { headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.users_by_role));
    assert.ok(Array.isArray(r.data.cargos_by_status));
    assert.ok(Array.isArray(r.data.active_subscriptions_by_tier));
    assert.equal(typeof r.data.banned_users, 'number');
  });
});

describe('admin: user moderation', () => {
  test('admin can search users, ban (with reason), unban, and verify', async () => {
    const admin = await makeAdmin('adminmod');
    const target = await registerUser({ role: 'shipper', prefix: 'modtarget' });

    const search = await api('/api/admin/users?search=modtarget', { headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(search.status, 200);
    assert.ok(search.data.some((u) => u.id === target.user.id));

    const ban = await api('/api/admin/users/' + target.user.id + '/ban', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + admin.token },
      body: { banned: true, reason: 'ci test ban' },
    });
    assert.equal(ban.status, 200);
    assert.equal(ban.data.banned, true);
    assert.equal(ban.data.banned_reason, 'ci test ban');

    // Banned user's existing (still-valid) JWT is rejected IMMEDIATELY, not just flagged.
    const bannedMe = await api('/api/auth/me', { headers: { Authorization: 'Bearer ' + target.token } });
    assert.equal(bannedMe.status, 403);
    assert.equal(bannedMe.data.code, 'account_banned');

    const unban = await api('/api/admin/users/' + target.user.id + '/ban', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + admin.token },
      body: { banned: false },
    });
    assert.equal(unban.status, 200);
    assert.equal(unban.data.banned, false);

    const unbannedMe = await api('/api/auth/me', { headers: { Authorization: 'Bearer ' + target.token } });
    assert.equal(unbannedMe.status, 200, 'unbanned user token should work again without re-login');

    const verify = await api('/api/admin/users/' + target.user.id + '/verify', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + admin.token },
      body: { verified: true },
    });
    assert.equal(verify.status, 200);
    assert.equal(verify.data.verified, true);
  });

  test('admin cannot ban themselves', async () => {
    const admin = await makeAdmin('adminself');
    const r = await api('/api/admin/users/' + admin.user.id + '/ban', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + admin.token },
      body: { banned: true },
    });
    assert.equal(r.status, 400);
  });
});

describe('admin: cargo moderation', () => {
  test('admin sees all cargos and can force-delete any of them', async () => {
    const admin = await makeAdmin('admincargo');
    const shipper = await registerUser({ role: 'shipper', prefix: 'admincargo-shipper' });
    const cargo = (await api('/api/cargos', {
      method: 'POST', headers: { Authorization: 'Bearer ' + shipper.token },
      body: { from_city: 'AdminModA', to_city: 'AdminModB', weight_tons: 5, cargo_type: 'General', pickup_date: '2026-08-01', price: 100000 },
    })).data;

    const list = await api('/api/admin/cargos', { headers: { Authorization: 'Bearer ' + admin.token } });
    assert.ok(list.data.some((c) => c.id === cargo.id));

    const del = await api('/api/admin/cargos/' + cargo.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + admin.token } });
    assert.equal(del.status, 200);
  });
});
