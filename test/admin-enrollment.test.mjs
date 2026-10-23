import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminEnrollment } from '../lib/admin-enrollment.mjs';

test('本机扫码初始化：来源限制、身份核验、明确确认及一次性关闭', async () => {
  let config = { enabled: false, loginMode: 'qr', clientId: 'app', clientSecret: 'secret', enterpriseId: 'team', bootstrapAdminAccount: 'admin', bootstrapAdminPhone: '+8613800000000', bootstrapAdminOpenId: '', tokenUrl: 'https://example.test/token', userInfoUrl: 'https://example.test/user' };
  let writes = 0;
  const handler = createAdminEnrollment({ readConfig: async () => structuredClone(config), writeConfig: async c => { config = c; writes++; }, issues: () => [], enabled: () => false, json: (r, status, body) => Object.assign(r, { status, body }), card: (r, status) => { r.status = status; }, audit: () => {} });
  async function call(action, cookie, overrides = {}) {
    const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', cookie }, ...overrides };
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
    await handler(req, res, new URL(action.startsWith('/') ? action : `/api/settings/login/enrollment?action=${action}`, 'http://127.0.0.1:4173'));
    return res;
  }
  assert.equal((await call('start', '', { headers: { host: '127.0.0.1:4173', origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call('start', '', { headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'x-forwarded-for': 'remote' } })).status, 403);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/qrconnet')) return new Response('<img class="qrcode lightBorder" src="https://www.yunzhijia.com/qr.png">');
    if (String(url).endsWith('/qr.png')) return new Response(new Uint8Array([137, 80, 78, ...new Array(1200).fill(0)]));
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true, data: String(url).includes('/token') ? { accessToken: 'token', expireIn: 6400 } : { appid: 'app', eid: 'team', openid: 'person', username: '管理员' } }));
  };
  try {
    const start = await call('start');
    assert.equal(start.status, 200);
    const cookie = start.headers['set-cookie'].split(';')[0];
    const state = new URL(start.body.url).searchParams.get('state');
    assert.equal((await call('confirm', cookie)).status, 400);
    assert.equal((await call(`/auth/cloud-home/entry?state=${state}&ticket=abc`, '', { method: 'GET' })).status, 403);
    const callback = `/auth/cloud-home/entry?state=${state}&ticket=abc`;
    assert.equal((await call(callback, cookie, { method: 'GET' })).status, 200);
    assert.equal(writes, 0);
    assert.equal((await call('status', cookie)).body.identity.subject, 'person');
    assert.equal((await call(callback, cookie, { method: 'GET' })).status, 403);
    assert.equal((await call('confirm', cookie)).status, 200);
    assert.equal(config.bootstrapAdminOpenId, 'person');
    assert.equal(config.enabled, false);
    assert.equal(writes, 1);
    assert.equal((await call('confirm', cookie)).status, 409);
    assert.equal((await call('start')).status, 409);
  } finally { globalThis.fetch = originalFetch; }
});
