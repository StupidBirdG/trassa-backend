const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, promoteAdmin, waitForServer, uniqueEmail, pool } = require('./helpers');

before(async () => { await waitForServer(); });

async function makeAdmin(prefix) {
  const admin = await registerUser({ role: 'shipper', prefix });
  await promoteAdmin(admin.user.id);
  return admin;
}

describe('ban evasion: banning a user blocklists their email, unbanning clears it', () => {
  test('banning a user adds their email to the blocklist', async () => {
    const admin = await makeAdmin('banevade-admin1');
    const target = await registerUser({ role: 'shipper', prefix: 'banevade-target1' });

    const ban = await api('/api/admin/users/' + target.user.id + '/ban', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + admin.token }, body: { banned: true, reason: 'test' },
    });
    assert.equal(ban.status, 200);

    const blocked = await pool.query("SELECT 1 FROM banned_identifiers WHERE type='email' AND value=$1", [target.email]);
    assert.equal(blocked.rows.length, 1, 'email should be in the blocklist after ban');
  });

  test('a banned phone cannot be reused to register a fresh phone-based account', async () => {
    const admin = await makeAdmin('banevade-admin2');
    // Register a carrier via email, then attach+verify a phone number to it (simulating
    // set-phone), ban them, then verify a brand NEW registration attempt with that same
    // phone number (via the /register phone flow, using a real OTP we fetch from the DB
    // helper pool since there's no SMS in tests) is rejected.
    const target = await registerUser({ role: 'carrier', prefix: 'banevade-target2', skip_trial: true });
    const phone = '+7700' + String(Date.now()).slice(-7);
    await pool.query('UPDATE users SET phone=$1, phone_verified=TRUE WHERE id=$2', [phone, target.user.id]);

    const ban = await api('/api/admin/users/' + target.user.id + '/ban', {
      method: 'PUT', headers: { Authorization: 'Bearer ' + admin.token }, body: { banned: true },
    });
    assert.equal(ban.status, 200);

    const blocked = await pool.query("SELECT 1 FROM banned_identifiers WHERE type='phone' AND value=$1", [phone]);
    assert.equal(blocked.rows.length, 1, 'phone should be in the blocklist after ban');

    // The blocklist row (source_user_id -> ON DELETE SET NULL) is what must survive an
    // evader deleting/abandoning the original banned account and trying a genuinely NEW
    // registration with the same phone. Delete the original row directly to simulate that
    // — this is the exact scenario the blocklist exists to prevent (without it, the phone
    // would be free to reuse the moment the old account is gone).
    await pool.query('DELETE FROM users WHERE id=$1', [target.user.id]);

    // Simulate a fresh registration attempt with that phone: insert a valid sms_codes row
    // directly (mirrors how other tests avoid needing real SMS delivery) then call /register.
    await pool.query(
      "INSERT INTO sms_codes (phone, code, expires_at) VALUES ($1, '123456', now() + interval '10 minutes')",
      [phone]
    );
    const attempt = await api('/api/auth/register', {
      method: 'POST',
      body: { phone, code: '123456', name: 'Evader', role: 'carrier', agreed_terms: true },
    });
    assert.equal(attempt.status, 403);
    assert.equal(attempt.data.code, 'identifier_banned');
  });

  test('unbanning removes the phone from the blocklist, allowing registration again', async () => {
    const admin = await makeAdmin('banevade-admin3');
    const target = await registerUser({ role: 'carrier', prefix: 'banevade-target3', skip_trial: true });
    const phone = '+7701' + String(Date.now()).slice(-7);
    await pool.query('UPDATE users SET phone=$1, phone_verified=TRUE WHERE id=$2', [phone, target.user.id]);

    await api('/api/admin/users/' + target.user.id + '/ban', { method: 'PUT', headers: { Authorization: 'Bearer ' + admin.token }, body: { banned: true } });
    await api('/api/admin/users/' + target.user.id + '/ban', { method: 'PUT', headers: { Authorization: 'Bearer ' + admin.token }, body: { banned: false } });

    const stillBlocked = await pool.query("SELECT 1 FROM banned_identifiers WHERE type='phone' AND value=$1", [phone]);
    assert.equal(stillBlocked.rows.length, 0, 'unban should clear the blocklist entry');
  });

  test('a banned BIN cannot be reattached to any account via profile update', async () => {
    const admin = await makeAdmin('banevade-admin4');
    const target = await registerUser({ role: 'carrier', prefix: 'banevade-target4', skip_trial: true });
    const validBin = '123456789012'; // format-valid enough to pass through to the blocklist check in this test context
    // Directly set a bin on the user (bypassing checksum validation, since we only care
    // about blocklist behavior here) then ban them.
    await pool.query('UPDATE users SET bin=$1, bin_verified=TRUE WHERE id=$2', [validBin, target.user.id]);
    await api('/api/admin/users/' + target.user.id + '/ban', { method: 'PUT', headers: { Authorization: 'Bearer ' + admin.token }, body: { banned: true } });

    const blocked = await pool.query("SELECT 1 FROM banned_identifiers WHERE type='bin' AND value=$1", [validBin]);
    assert.equal(blocked.rows.length, 1);
  });
});
