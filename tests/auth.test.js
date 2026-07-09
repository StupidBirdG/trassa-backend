const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, registerUser, uniqueEmail, waitForServer } = require('./helpers');

before(async () => { await waitForServer(); });

describe('auth: registration consent', () => {
  test('register-email without agreed_terms -> 400 terms_not_accepted', async () => {
    const r = await api('/api/auth/register-email', {
      method: 'POST',
      body: { email: uniqueEmail('noterms'), password: 'Test123456!', name: 'No Terms', role: 'shipper' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.code, 'terms_not_accepted');
  });

  test('register-email with agreed_terms:true -> 201 and terms recorded', async () => {
    const { user } = await registerUser({ role: 'shipper', prefix: 'withterms' });
    assert.ok(user.terms_accepted_at);
    assert.ok(user.terms_version);
  });
});

describe('auth: carrier trial vs skip_trial', () => {
  test('default carrier registration grants a subscription_until (~7 days)', async () => {
    const { user } = await registerUser({ role: 'carrier', prefix: 'trialcarrier' });
    assert.ok(user.subscription_until, 'expected a trial subscription_until date');
  });

  test('skip_trial:true carrier registration has no subscription', async () => {
    const { user } = await registerUser({ role: 'carrier', prefix: 'notrial', skip_trial: true });
    assert.equal(user.subscription_until, null);
  });

  test('shipper never gets a subscription regardless of skip_trial', async () => {
    const { user } = await registerUser({ role: 'shipper', prefix: 'shipnosub' });
    assert.equal(user.subscription_until, null);
  });
});

describe('auth: duplicate email + login', () => {
  test('registering the same email twice is rejected', async () => {
    const email = uniqueEmail('dup');
    const body = { email, password: 'Test123456!', name: 'Dup', role: 'shipper', agreed_terms: true };
    const first = await api('/api/auth/register-email', { method: 'POST', body });
    assert.equal(first.status, 201);
    const second = await api('/api/auth/register-email', { method: 'POST', body });
    assert.equal(second.status, 400);
  });

  test('login-email works with correct password, rejects wrong password', async () => {
    const email = uniqueEmail('login');
    await api('/api/auth/register-email', { method: 'POST', body: { email, password: 'Test123456!', name: 'Login Test', role: 'shipper', agreed_terms: true } });

    const ok = await api('/api/auth/login-email', { method: 'POST', body: { email, password: 'Test123456!' } });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.token);

    const bad = await api('/api/auth/login-email', { method: 'POST', body: { email, password: 'WrongPassword1' } });
    assert.equal(bad.status, 400);
  });
});

describe('auth: /me and token handling', () => {
  test('GET /auth/me with valid token returns user including is_admin/banned fields', async () => {
    const { token } = await registerUser({ role: 'shipper', prefix: 'meuser' });
    const r = await api('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(r.status, 200);
    assert.equal(r.data.is_admin, false);
    assert.equal(r.data.banned, false);
    assert.equal('password_hash' in r.data, false, 'password_hash must never be exposed');
  });

  test('GET /auth/me without a token -> 401', async () => {
    const r = await api('/api/auth/me');
    assert.equal(r.status, 401);
  });

  test('GET /auth/me with a garbage token -> 401', async () => {
    const r = await api('/api/auth/me', { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.equal(r.status, 401);
  });
});
