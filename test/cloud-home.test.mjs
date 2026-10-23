import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLOUD_HOME_ENDPOINTS, createCloudHomeTicketClient } from '../lib/cloud-home.mjs';

const config = { ...CLOUD_HOME_ENDPOINTS, clientId: 'test-app', clientSecret: 'test-secret', enterpriseId: 'test-eid' };
const reply = data => new Response(JSON.stringify({ success: true, data }), { status: 200 });

test('官方请求格式、应用令牌缓存与一次性 ticket', async () => {
  const calls = [];
  const client = createCloudHomeTicketClient(config, async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url === config.tokenUrl) { assert.deepEqual(body, { appId: 'test-app', secret: 'test-secret', timestamp: 1000, scope: 'app' }); return reply({ accessToken: 'test-token', expireIn: 6400 }); }
    assert.equal(new URL(url).searchParams.get('accessToken'), 'test-token');
    assert.equal(body.appid, 'test-app');
    assert.equal(body.disposable, true);
    return reply({ appid: 'test-app', eid: 'test-eid', openid: 'member-a', userid: 'global-a', username: 'Example', deviceId: '13800138000' });
  }, () => 1000);
  const identity = await client.verify('ticket-a');
  assert.equal(identity.subject, 'member-a');
  assert.equal(identity.phone, undefined, 'deviceId 不能当手机号');
  await assert.rejects(client.verify('ticket-a'), /ticket_replayed/);
  await client.verify('ticket-b');
  assert.equal(calls.filter(call => call.url === config.tokenUrl).length, 1);
});

test('跨企业、跨应用以及失败响应不能建立身份', async () => {
  for (const profile of [{ appid: 'other-app', eid: 'test-eid', openid: 'x' }, { appid: 'test-app', eid: 'other-eid', openid: 'x' }, { appid: 'test-app', eid: 'test-eid' }]) {
    const client = createCloudHomeTicketClient(config, async url => url === config.tokenUrl ? reply({ accessToken: 't', expireIn: 6400 }) : reply(profile));
    await assert.rejects(client.verify('ticket'));
  }
  const rejected = createCloudHomeTicketClient(config, async () => new Response(JSON.stringify({ success: false, data: { accessToken: 'untrusted' } })));
  await assert.rejects(rejected.verify('ticket'), /remote_rejected/);
});

for (const loginMode of ['ticket', 'qr']) test(`隔离服务 ${loginMode}：登录确认、防重放、员工预绑定、管理权限和配置隔离`, { timeout: 30000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'team-mcp-auth-test-'));
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const fixture = `globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).includes('/getAccessToken')) return new Response(JSON.stringify({success:true,data:{accessToken:'fixture-token',expireIn:6400}}));
    const name = body.ticket.includes('employee') ? 'employee-openid' : 'admin-openid';
    return new Response(JSON.stringify({success:true,data:{appid:'test-app',eid:body.ticket.includes('wrong-tenant')?'wrong-eid':'test-eid',openid:name,username:'Fixture Member',userid:'fixture-global'}}));
  }; await import(${JSON.stringify(pathToFileURL(path.join(root, 'server.mjs')).href)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, env: { ...process.env, MCP_MANAGER_PORT: String(port), MCP_MANAGER_DATA_DIR: temporary, CLOUD_HOME_LOGIN_MODE: loginMode, CLOUD_HOME_ENTERPRISE_ID: 'test-eid', CLOUD_HOME_CLIENT_ID: 'test-app', CLOUD_HOME_CLIENT_SECRET: 'test-secret', CLOUD_HOME_TOKEN_URL: CLOUD_HOME_ENDPOINTS.tokenUrl, CLOUD_HOME_USERINFO_URL: CLOUD_HOME_ENDPOINTS.userInfoUrl, CLOUD_HOME_REDIRECT_URI: `${origin}/auth/cloud-home/entry`, MCP_MANAGER_BOOTSTRAP_ADMIN_OPENID: 'admin-openid', MCP_MANAGER_BOOTSTRAP_ADMIN_ACCOUNT: 'fixture-admin', MCP_MANAGER_BOOTSTRAP_ADMIN_NAME: 'Fixture Admin', MCP_MANAGER_BOOTSTRAP_ADMIN_PHONE: '13800138000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => { child.stdout.on('data', chunk => { if (String(chunk).includes('http://')) resolve(); }); child.once('exit', code => reject(new Error(`Fixture failed ${code}: ${stderr}`))); });
  const api = (route, options = {}) => fetch(origin + route, { redirect: 'manual', ...options });
  assert.equal((await api('/api/state')).status, 401);
  assert.equal((await api('/auth/cloud-home/entry')).status, 400);
  async function beginResponse(ticket) {
    let query = new URLSearchParams({ ticket });
    let cookie = '';
    if (loginMode === 'qr') {
      const started = await api('/auth/login');
      assert.equal(started.status, 302);
      const target = new URL(started.headers.get('location'));
      assert.equal(target.origin, 'https://www.yunzhijia.com');
      assert.equal(target.pathname, '/opencloud/openthird/qrconnet');
      assert.equal(target.searchParams.get('appid'), 'test-app');
      assert.equal(target.searchParams.get('redirect_uri'), `${origin}/auth/cloud-home/entry`);
      query.set('state', target.searchParams.get('state'));
      cookie = started.headers.get('set-cookie').split(';')[0];
    }
    return api(`/auth/cloud-home/entry?${query}`, { headers: { cookie } });
  }
  if (loginMode === 'qr') assert.equal((await api('/auth/cloud-home/entry?ticket=forged&state=wrong')).status, 400);
  async function begin(ticket) {
    const response = await beginResponse(ticket);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/auth/cloud-home/confirm');
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function confirm(cookie, requestOrigin = origin) {
    const nonce = cookie.slice(cookie.indexOf('=') + 1);
    return api('/auth/cloud-home/confirm', { method: 'POST', headers: { cookie, origin: requestOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ nonce }) });
  }
  const pending = await begin('valid-admin');
  assert.equal((await api('/api/state', { headers: { cookie: pending } })).status, 401, '确认前不能进入后台');
  const forged = await api('/auth/cloud-home/confirm', { method: 'POST', headers: { cookie: pending, origin: 'https://untrusted.invalid' }, body: 'nonce=wrong' });
  assert.equal(forged.status, 403);
  const loggedIn = await confirm(pending, 'null');
  assert.equal(loggedIn.status, 303);
  const adminCookie = loggedIn.headers.getSetCookie().find(value => value.startsWith('mcp_session=')).split(';')[0];
  assert.equal((await confirm(pending)).status, 401, '确认只能消费一次');
  assert.equal((await beginResponse('valid-admin')).status, 401, 'ticket 只能消费一次');
  assert.equal((await beginResponse('wrong-tenant')).status, 401);
  assert.equal((await api('/api/state', { headers: { cookie: adminCookie } })).status, 200);
  const adminWrite = body => ({ method: 'POST', headers: { cookie: adminCookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const created = await api('/api/users', adminWrite({ name: 'Fixture Employee', account: 'fixture-employee', phone: '13900139000', groupId: 'staff' }));
  assert.equal(created.status, 201);
  const state = await (await api('/api/state', { headers: { cookie: adminCookie } })).json();
  const employee = state.users.find(user => user.account === 'fixture-employee');
  assert.equal((await confirm(await begin('unbound-employee'))).status, 403, '未绑定员工不能按姓名或设备编号登录');
  const binding = await api(`/api/users/${employee.id}/cloud-home-identity`, { ...adminWrite({ enterpriseId: 'test-eid', openId: 'employee-openid' }), method: 'PATCH' });
  assert.equal(binding.status, 200);
  const employeeLogin = await confirm(await begin('bound-employee'));
  assert.equal(employeeLogin.status, 303);
  const employeeCookie = employeeLogin.headers.getSetCookie().find(value => value.startsWith('mcp_session=')).split(';')[0];
  assert.equal((await api('/api/settings/login', { headers: { cookie: employeeCookie } })).status, 403);
  const settings = await (await api('/api/settings/login', { headers: { cookie: adminCookie } })).json();
  assert.equal(Object.hasOwn(settings.settings, 'clientSecret'), false);
  const future = await (await api('/api/settings/login?provider=wecom', { headers: { cookie: adminCookie } })).json();
  const draft = { ...future.settings, clientId: 'isolated-future-app', clientSecret: 'isolated-future-secret', enabled: false };
  assert.equal((await api('/api/settings/login?provider=wecom', { ...adminWrite(draft), method: 'PUT' })).status, 200);
  const cloudAfter = await (await api('/api/settings/login', { headers: { cookie: adminCookie } })).json();
  assert.equal(cloudAfter.settings.clientId, 'test-app', '保存其他平台不能覆盖云之家');
  const logs = await fs.readFile(path.join(temporary, 'logs', 'backend.jsonl'), 'utf8');
  for (const secret of ['valid-admin', 'fixture-token', 'test-secret', 'isolated-future-secret']) assert.equal(logs.includes(secret), false);
});
