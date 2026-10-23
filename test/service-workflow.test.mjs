import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSessionCache } from '../lib/session-cache.mjs';
import { zipSync, strToU8 } from 'fflate';

test('personal credentials are isolated and connection checks do not grant tools', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-mcp-workflow-'));
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401); res.end('{}'); return; }
    const message = JSON.parse(Buffer.concat(chunks));
    const result = message.method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } : { tools: [{ name: 'fixture_query', description: 'Fixture tool', annotations: { readOnlyHint: true } }] };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const endpoint = `http://127.0.0.1:${mock.address().port}/mcp`;
  const portProbe = http.createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const users = ['admin', 'alice', 'bob'].map(id => ({ id, account: id, name: id, phone: '', groupId: id === 'admin' ? 'admins' : 'staff' }));
  const state = { services: [{ id: 'public', name: 'Fixture', endpoint, status: 'active', authMode: 'bearer', marketplaceStatus: 'published', marketplaceVisibility: 'all', tools: [] }, { id: 'restricted', name: 'Hidden fixture', endpoint, status: 'active', marketplaceStatus: 'published', marketplaceVisibility: 'restricted', tools: [] }], users, groups: [{ id: 'admins', name: 'Admins' }, { id: 'staff', name: 'Staff' }], pageGrants: [{ groupId: 'admins', pageId: 'services', mode: 'allow' }], grants: [], userGrants: [], accessRequests: [], audit: [] };
  const signingKey = randomBytes(48), records = [], cookies = {};
  const skillFile = 'skills/fixture.zip';
  await fs.mkdir(path.join(dir, 'skills'));
  await fs.writeFile(path.join(dir, skillFile), Buffer.from('fixture archive'));
  state.skills = [{ id: 'skill-one', slug: 'fixture-skill', name: 'Restricted fixture', latestVersion: '1.0.0', targetGroupIds: ['admins'], versions: [{ version: '1.0.0', targetGroupIds: ['admins'], storageKey: skillFile }, { version: '2.0.0', targetGroupIds: ['admins'], storageKey: skillFile }] }];
  for (const user of users) {
    const id = randomBytes(32).toString('base64url');
    records.push({ id, userId: user.id, identityStamp: createHash('sha256').update(JSON.stringify([user.id, user.account, user.phone, '', ''])).digest('hex'), expiresAt: Date.now() + 600000 });
    cookies[user.id] = `mcp_session=${id}.${createHmac('sha256', signingKey).update(id).digest('base64url')}`;
  }
  await fs.writeFile(path.join(dir, 'manager.json'), JSON.stringify(state));
  await fs.writeFile(path.join(dir, 'session-signing.key'), signingKey);
  await createSessionCache(path.join(dir, 'browser-sessions.enc'), signingKey).save(records);
  await fs.writeFile(path.join(dir, 'auth-settings.json'), JSON.stringify({ enabled: true, loginMode: 'qr', clientId: 'fixture', clientSecret: 'fixture', redirectUri: `http://127.0.0.1:${port}/auth/cloud-home/entry`, enterpriseId: 'fixture', bootstrapAdminOpenId: 'fixture', bootstrapAdminAccount: 'admin', bootstrapAdminName: 'Admin', bootstrapAdminPhone: '+8613800000000', tokenUrl: 'https://example.invalid/token', userInfoUrl: 'https://example.invalid/user' }));
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, MCP_MANAGER_PORT: String(port), MCP_MANAGER_DATA_DIR: dir }, stdio: 'ignore', windowsHide: true });
  async function call(route, user, method = 'GET', body) {
    return fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { cookie: cookies[user] || '', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) { try { await call('/api/auth/status'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); } }
    assert.ok(ready, 'fixture server starts');
    assert.equal((await call('/api/my/service-credentials/public')).status, 401);
    assert.equal((await call('/api/service-config/public', 'alice')).status, 403);
    assert.equal((await call('/api/my/service-credentials/restricted', 'alice')).status, 403);
    assert.equal((await call('/api/my/service-credentials/public', 'alice', 'PUT', { token: 'fixture-token' })).status, 200);
    const own = await (await call('/api/my/service-credentials/public', 'alice')).json();
    assert.equal(own.tokenConfigured, true); assert.equal(own.token, undefined);
    assert.equal((await (await call('/api/my/service-credentials/public', 'bob')).json()).tokenConfigured, false);
    assert.equal((await call('/api/my/service-credentials/public/check', 'alice', 'POST')).status, 200);
    assert.equal((await call('/api/my/service-credentials/public/check', 'bob', 'POST')).status, 502);
    const market = await (await call('/api/my/access', 'alice')).json();
    assert.equal(market.services.find(item => item.id === 'public').personalConnection.state, 'connected');
    assert.equal((await (await call('/api/my/access', 'bob')).json()).services.find(item => item.id === 'public').personalConnection.state, 'failed');
    const stored = JSON.parse(await fs.readFile(path.join(dir, 'manager.json')));
    assert.equal(stored.userGrants.length, 0); assert.equal(JSON.stringify(stored).includes('fixture-token'), false);
    await call('/api/my/service-credentials/public', 'admin', 'PUT', { token: 'fixture-token' });
    assert.equal((await call('/api/services/public/discover', 'admin', 'POST')).status, 200);
    assert.equal((await (await call('/api/state', 'admin')).json()).services.find(item => item.id === 'public').connection.state, 'connected');
    await call('/api/my/service-credentials/public', 'alice', 'PUT', { clearCredentials: true });
    assert.equal((await (await call('/api/my/service-credentials/public', 'alice')).json()).tokenConfigured, false);
    const download = '/api/skills/skill-one/versions/1.0.0/download';
    assert.equal((await call(download, 'alice')).status, 403);
    assert.equal((await call('/api/skills/submissions/any/archive', 'alice')).status, 403);
    const application = { skillId: 'skill-one', version: '1.0.0', reason: 'Need this Skill for fixture work' };
    const requested = await call('/api/my/skill-access', 'alice', 'POST', application);
    assert.equal(requested.status, 201);
    const requestId = (await requested.json()).id;
    assert.equal((await call('/api/my/skill-access', 'alice', 'POST', application)).status, 409);
    assert.equal((await call(`/api/access-requests/${requestId}/review`, 'bob', 'POST', { decision: 'approved' })).status, 403);
    assert.equal((await call(`/api/access-requests/${requestId}/review`, 'admin', 'POST', { decision: 'approved' })).status, 200);
    assert.equal((await call(download, 'alice')).status, 200);
    assert.equal((await call(download, 'bob')).status, 403);
    assert.equal((await call('/api/skills/skill-one/versions/2.0.0/download', 'alice')).status, 403);
    const mcpSubmission = await call('/api/my/mcp-submissions', 'alice', 'POST', { name: 'Employee fixture MCP', category: '其他', endpoint: 'https://example.invalid/employee-mcp', description: 'Employee resource fixture', requesterAccount: 'bob', reviewerAccount: 'admin' });
    assert.equal(mcpSubmission.status, 201);
    const mcpId = (await mcpSubmission.json()).id;
    assert.equal((await call('/api/my/mcp-submissions', 'alice', 'POST', { name: 'Duplicate', category: '其他', endpoint: 'https://example.invalid/employee-mcp', reviewerAccount: 'admin' })).status, 400);
    const archive = zipSync({ 'SKILL.md': strToU8('---\nname: employee-fixture\ndescription: Employee fixture skill\n---\n# Fixture\nUse this for fixture work.\n') });
    const skillSubmission = await call('/api/my/skill-submissions', 'alice', 'POST', { name: 'Employee fixture Skill', skillSlug: 'employee-fixture', version: '1.0.0', description: 'Employee test upload', requesterAccount: 'bob', reviewerAccount: 'admin', targetGroupIds: ['staff'], archiveBase64: Buffer.from(archive).toString('base64') });
    assert.equal(skillSubmission.status, 201);
    const ownSubmissions = (await (await call('/api/my/access', 'alice')).json()).submissions;
    assert.equal(ownSubmissions.length, 2);
    assert.equal(ownSubmissions.some(item => item.manifestContent), false);
    assert.equal((await (await call('/api/my/access', 'bob')).json()).submissions.length, 0);
    const submissionState = JSON.parse(await fs.readFile(path.join(dir, 'manager.json')));
    assert.equal(submissionState.submissions.find(item => item.id === mcpId).requesterAccount, 'alice');
    assert.equal(submissionState.skillSubmissions[0].requesterAccount, 'alice');
    assert.equal(submissionState.services.some(item => item.endpoint === 'https://example.invalid/employee-mcp'), false);
    assert.equal((await call(`/api/submissions/${mcpId}/review`, 'bob', 'POST', { decision: 'approved' })).status, 403);
    assert.equal((await call(`/api/submissions/${mcpId}/review`, 'admin', 'POST', { decision: 'approved' })).status, 200);
  } finally {
    child.kill(); await once(child, 'exit');
    await new Promise(resolve => mock.close(resolve));
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(dir).startsWith('team-mcp-workflow-'));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
