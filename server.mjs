import http from 'node:http';
import { serviceVisible, toolAllowed } from './lib/gateway-policy.mjs';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { CLOUD_HOME_ENDPOINTS, createCloudHomeTicketClient } from './lib/cloud-home.mjs';
import { createAdminEnrollment } from './lib/admin-enrollment.mjs';
import { createSessionCache } from './lib/session-cache.mjs';
import { createServiceVault } from './lib/service-vault.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const packaged = Boolean(process.pkg);
const userDataRoot = process.platform === 'win32'
  ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
const appDataDirName = process.platform === 'win32' ? 'TeamMcpManager' : 'team-mcp-manager';
const dataDir = process.env.MCP_MANAGER_DATA_DIR ? path.resolve(process.env.MCP_MANAGER_DATA_DIR) : packaged
  ? path.join(userDataRoot, appDataDirName, 'data')
  : path.join(root, 'data');
const dataFile = path.join(dataDir, 'manager.json');
const runtimeLogFile = path.join(dataDir, 'logs', 'backend.jsonl');
const host = '127.0.0.1';
const port = Number(process.env.MCP_MANAGER_PORT || 4173);
const runtimeLogs = [];
const browserSessions = new Map();
const pendingLogins = new Map();
let sessionSigningKey;
let sessionCache;
let serviceVault;
const loginCacheSeconds = 7 * 24 * 60 * 60;

async function loadEnvFile(file) {
  let content;
  try { content = await fs.readFile(file, 'utf8'); } catch { return; }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
await loadEnvFile(path.join(dataDir, 'auth.env'));
await loadEnvFile(path.join(root, '.env'));

const cloudHome = {
  loginMode: process.env.CLOUD_HOME_LOGIN_MODE || 'qr',
  enterpriseId: process.env.CLOUD_HOME_ENTERPRISE_ID || '',
  bootstrapAdminOpenId: process.env.MCP_MANAGER_BOOTSTRAP_ADMIN_OPENID || '',
  authorizationUrl: process.env.CLOUD_HOME_AUTHORIZATION_URL || '',
  tokenUrl: process.env.CLOUD_HOME_TOKEN_URL || CLOUD_HOME_ENDPOINTS.tokenUrl,
  userInfoUrl: process.env.CLOUD_HOME_USERINFO_URL || CLOUD_HOME_ENDPOINTS.userInfoUrl,
  clientId: process.env.CLOUD_HOME_CLIENT_ID || '',
  clientSecret: process.env.CLOUD_HOME_CLIENT_SECRET || '',
  redirectUri: process.env.CLOUD_HOME_REDIRECT_URI || '',
  scopes: process.env.CLOUD_HOME_SCOPES || '',
  tokenAuthMethod: process.env.CLOUD_HOME_TOKEN_AUTH_METHOD || 'client_secret_post',
  subjectPath: process.env.CLOUD_HOME_SUBJECT_PATH || 'userId',
  phonePath: process.env.CLOUD_HOME_PHONE_PATH || 'mobile',
  accountPath: process.env.CLOUD_HOME_ACCOUNT_PATH || 'account',
  namePath: process.env.CLOUD_HOME_NAME_PATH || 'name',
  bootstrapAdminAccount: process.env.MCP_MANAGER_BOOTSTRAP_ADMIN_ACCOUNT || '',
  bootstrapAdminPhone: normalizePhone(process.env.MCP_MANAGER_BOOTSTRAP_ADMIN_PHONE || ''),
  bootstrapAdminName: process.env.MCP_MANAGER_BOOTSTRAP_ADMIN_NAME || ''
};
const authSettingsFile = path.join(dataDir, 'auth-settings.json');
const authSettingKeys = Object.keys(cloudHome);
let startupAuthSettings = null;
try {
  startupAuthSettings = JSON.parse(await fs.readFile(authSettingsFile, 'utf8'));
  // Existing installations retain their explicit legacy OAuth configuration.
  if (!startupAuthSettings.loginMode) startupAuthSettings.loginMode = 'oauth-code';
  for (const key of authSettingKeys) if (typeof startupAuthSettings[key] === 'string') cloudHome[key] = startupAuthSettings[key];
  startupAuthSettings = { ...cloudHome, ...startupAuthSettings };
} catch (error) { if (error.code !== 'ENOENT') throw new Error('集成登录配置文件无法读取，请检查服务器配置'); }
function isHttpsEndpoint(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; } catch { return false; }
}
function isSafeRedirectUri(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) && !parsed.username && !parsed.password;
  } catch { return false; }
}
function authConfigurationIssues(config) {
  const issues = [];
  const ticketMode = ['ticket', 'qr'].includes(config.loginMode);
  if (!['qr', 'ticket', 'oauth-code'].includes(config.loginMode)) issues.push('请选择正确的接入方式');
  for (const [key, label] of [...(ticketMode ? [] : [['authorizationUrl', '授权地址']]), ['tokenUrl', '令牌地址'], ['userInfoUrl', '用户信息地址']]) if (!isHttpsEndpoint(config[key])) issues.push(`${label}需为不含账号密码的 HTTPS 地址`);
  if (!isSafeRedirectUri(config.redirectUri)) issues.push('回调地址需使用 HTTPS，本机可用 localhost HTTP');
  for (const [key, label] of [['clientId', '应用标识'], ['clientSecret', '应用密钥'], ['bootstrapAdminAccount', '首位管理员账号'], ['bootstrapAdminName', '首位管理员姓名']]) if (!config[key]?.trim()) issues.push(`请填写${label}`);
  if (!/^\+[1-9]\d{7,14}$/.test(normalizePhone(config.bootstrapAdminPhone))) issues.push('请填写有效的首位管理员手机号');
  if (ticketMode) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(config.enterpriseId || '')) issues.push('请填写企业团队 ID（eid）');
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(config.bootstrapAdminOpenId || '')) issues.push('请填写首位管理员在该企业的 openid');
    if (isSafeRedirectUri(config.redirectUri) && new URL(config.redirectUri).pathname !== '/auth/cloud-home/entry') issues.push('云之家身份回调地址的路径需为 /auth/cloud-home/entry');
      if (isSafeRedirectUri(config.redirectUri) && ['yunzhijia.com', 'www.yunzhijia.com'].includes(new URL(config.redirectUri).hostname)) issues.push('回调地址必须是 MCP 管理器自己的访问地址，不能填写云之家域名');
    return issues;
  }
  if (!['client_secret_post', 'client_secret_basic'].includes(config.tokenAuthMethod)) issues.push('请选择支持的令牌认证方式');
  for (const key of ['subjectPath', 'phonePath', 'accountPath', 'namePath']) if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(config[key] || '')) issues.push('用户信息字段路径只能包含字母、数字、下划线和点');
  return issues;
}
const cloudHomeLoginEnabled = (startupAuthSettings === null || startupAuthSettings.enabled === true) && authConfigurationIssues(cloudHome).length === 0;
const cloudHomeAuthRequired = cloudHomeLoginEnabled || startupAuthSettings?.enabled === true;
const ticketClient = createCloudHomeTicketClient(cloudHome);
const pendingTicketConfirmations = new Map();
const enrollAdmin = createAdminEnrollment({
  readConfig: async () => {
    try { return { ...cloudHome, ...JSON.parse(await fs.readFile(authSettingsFile, 'utf8')) }; }
    catch (error) { if (error.code === 'ENOENT') return { ...cloudHome, enabled: false }; throw error; }
  },
  writeConfig: async config => {
    const temporary = `${authSettingsFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600 }); await fs.rename(temporary, authSettingsFile); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  },
  issues: authConfigurationIssues, enabled: () => cloudHomeAuthRequired,
  json, card: sendAuthCard,
  audit: () => logBackend('info', '本机确认首位管理员云之家身份')
});

function normalizePhone(value) {
  const compact = String(value || '').trim().replace(/[\s()-]/g, '');
  if (!compact) return '';
  if (/^1\d{10}$/.test(compact)) return `+86${compact}`;
  if (/^86\d{11}$/.test(compact)) return `+${compact}`;
  return compact.startsWith('+') ? compact : `+${compact}`;
}
function fieldAt(object, fieldPath) {
  return fieldPath.split('.').reduce((value, key) => value == null ? undefined : value[key], object);
}
function logBackend(level, event, details = {}) {
  const entry = { id: randomUUID(), time: new Date().toISOString(), level, event, ...details };
  runtimeLogs.unshift(entry);
  if (runtimeLogs.length > 2000) runtimeLogs.length = 2000;
  void fs.mkdir(path.dirname(runtimeLogFile), { recursive: true })
    .then(async () => {
      try { if ((await fs.stat(runtimeLogFile)).size > 10 * 1024 * 1024) await fs.rename(runtimeLogFile, `${runtimeLogFile}.1`); } catch { /* file not created yet */ }
      await fs.appendFile(runtimeLogFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    })
    .catch(() => {});
}
async function initializeBackendLogs() {
  await fs.mkdir(path.dirname(runtimeLogFile), { recursive: true });
  try {
    const lines = (await fs.readFile(runtimeLogFile, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-2000);
    for (const line of lines.reverse()) { try { runtimeLogs.push(JSON.parse(line)); } catch { /* skip damaged log entry */ } }
  } catch { /* first run */ }
}

function signedValue(value) {
  const signature = createHmac('sha256', sessionSigningKey).update(value).digest('base64url');
  return `${value}.${signature}`;
}
function verifySignedValue(value) {
  const [id, signature, extra] = String(value || '').split('.');
  if (!id || !signature || extra || !sessionSigningKey) return null;
  const expected = createHmac('sha256', sessionSigningKey).update(id).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64url'); } catch { return null; }
  return expected.length === supplied.length && timingSafeEqual(expected, supplied) ? id : null;
}
function cookieValue(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  for (const part of cookies) { const splitAt = part.indexOf('='); if (splitAt > 0 && part.slice(0, splitAt).trim() === name) return decodeURIComponent(part.slice(splitAt + 1).trim()); }
  return '';
}
function currentSession(req) {
  const id = verifySignedValue(cookieValue(req, 'mcp_session'));
  const session = id ? browserSessions.get(id) : null;
  if (!session || session.expiresAt <= Date.now()) { if (id) browserSessions.delete(id); return null; }
  return session;
}
function sessionIdentityStamp(user) {
  return createHash('sha256').update(JSON.stringify([user.id, user.account, user.phone, user.cloudHomeSubject || '', user.cloudHomeEnterpriseId || ''])).digest('hex');
}
function sessionUserView(user) {
  return { id: user.id, name: user.name, account: user.account, phone: user.phone, groupId: user.groupId };
}
function reconcileSession(session, state) {
  if (!session) return false;
  const user = state.users.find(item => item.id === session.user.id);
  if (!user || session.identityStamp !== sessionIdentityStamp(user) || !state.groups.some(group => group.id === user.groupId)) return false;
  session.user = sessionUserView(user);
  return true;
}
async function persistBrowserSessions() {
  if (!sessionCache) return;
  const records = [...browserSessions].filter(([, session]) => session.expiresAt > Date.now()).map(([id, session]) => ({ id, userId: session.user.id, identityStamp: session.identityStamp, expiresAt: session.expiresAt }));
  await sessionCache.save(records);
}
async function restoreBrowserSessions() {
  sessionCache = createSessionCache(path.join(dataDir, 'browser-sessions.enc'), sessionSigningKey);
  try {
    const state = await loadState();
    for (const record of await sessionCache.load()) {
      const user = state.users.find(item => item.id === record.userId);
      if (user && record.identityStamp === sessionIdentityStamp(user) && state.groups.some(group => group.id === user.groupId)) browserSessions.set(record.id, { user: sessionUserView(user), identityStamp: record.identityStamp, expiresAt: record.expiresAt });
    }
  } catch { logBackend('warn', '登录缓存无法恢复，请重新登录'); }
}
function sessionCookie(value, maxAge) {
  const secure = cloudHome.redirectUri.startsWith('https://') ? '; Secure' : '';
  return `mcp_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function stateCookie(value, maxAge) {
  const secure = cloudHome.redirectUri.startsWith('https://') ? '; Secure' : '';
  return `mcp_oauth_state=${encodeURIComponent(value)}; Path=/auth/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function initializeSessionSigningKey() {
  const keyPath = path.join(dataDir, 'session-signing.key');
  await fs.mkdir(dataDir, { recursive: true });
  try { sessionSigningKey = await fs.readFile(keyPath); }
  catch {
    sessionSigningKey = randomBytes(48);
    try { await fs.writeFile(keyPath, sessionSigningKey, { mode: 0o600, flag: 'wx' }); }
    catch { sessionSigningKey = await fs.readFile(keyPath); }
  }
}

const seed = {
  services: [
    { id: 'sqlserver', name: 'SQL Server 示例', category: '数据库', endpoint: '待填写服务地址', transport: 'Streamable HTTP', status: 'draft', description: '数据库服务示例；员工身份与资源授权需按实际环境配置。', tools: [{ name: 'query_readonly', label: '只读查询', risk: '只读' }, { name: 'execute_write', label: '受控写入', risk: '写入' }, { name: 'delete_records', label: '受控删除', risk: '高风险' }] },
    { id: 'business-app', name: '业务系统示例', category: '业务系统', endpoint: '未登记', transport: 'Streamable HTTP', status: 'draft', description: '计划接入企业业务系统及受控操作。', tools: [] },
    { id: 'files', name: '文件服务器', category: '文件与存储', endpoint: '未登记', transport: 'Streamable HTTP', status: 'draft', description: '计划按共享目录和操作类型授权。', tools: [] },
    { id: 'vmware', name: '虚拟机管理', category: '基础设施', endpoint: '未登记', transport: 'Streamable HTTP', status: 'draft', description: '计划按虚拟机和操作类型授权。', tools: [] }
  ],
  groups: [
    { id: 'admins', name: '平台管理员', members: 1 },
    { id: 'data', name: '数据组', members: 4 },
    { id: 'ops', name: '运维组', members: 3 },
    { id: 'staff', name: '普通员工', members: 8 }
  ],
  users: [
    { id: 'u-admin', name: '平台管理员', account: 'admin@example.invalid', phone: '', groupId: 'admins', source: '本地演示' },
    { id: 'u-data', name: '数据用户示例', account: 'data@example.invalid', phone: '', groupId: 'data', source: '本地演示' },
    { id: 'u-ops', name: '运维用户示例', account: 'ops@example.invalid', phone: '', groupId: 'ops', source: '本地演示' }
  ],
  grants: [
    { groupId: 'data', serviceId: 'sqlserver', toolName: 'query_readonly', mode: 'allow' },
    { groupId: 'data', serviceId: 'sqlserver', toolName: 'execute_write', mode: 'approval' },
    { groupId: 'data', serviceId: 'sqlserver', toolName: 'delete_records', mode: 'deny' },
    { groupId: 'ops', serviceId: 'sqlserver', toolName: 'query_readonly', mode: 'allow' },
    { groupId: 'ops', serviceId: 'sqlserver', toolName: 'execute_write', mode: 'approval' },
    { groupId: 'ops', serviceId: 'sqlserver', toolName: 'delete_records', mode: 'approval' }
  ],
  pageGrants: [
    ...['overview', 'services', 'publications', 'skills', 'permissions', 'users', 'audit', 'logs', 'login-settings'].map(pageId => ({ groupId: 'admins', pageId, mode: 'allow' })),
    ...['overview', 'services', 'skills'].map(pageId => ({ groupId: 'data', pageId, mode: 'allow' })),
    ...['overview', 'services', 'skills'].map(pageId => ({ groupId: 'ops', pageId, mode: 'allow' })),
    ...['overview', 'services'].map(pageId => ({ groupId: 'staff', pageId, mode: 'allow' }))
  ],
  submissions: [],
  skills: [],
  skillSubmissions: [],
  userGrants: [],
  accessRequests: [],
  audit: [
    { id: 'a1', time: new Date().toISOString(), actor: '系统', action: '初始化演示数据', target: '管理器', result: '成功' },
    { id: 'a2', time: new Date(Date.now() - 3600_000).toISOString(), actor: '管理员', action: '查看权限策略', target: '数据服务', result: '成功' }
  ]
};

async function loadState() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    return {
      ...structuredClone(seed), ...stored,
      users: Array.isArray(stored.users) ? stored.users.map(user => ({ phone: '', ...user })) : structuredClone(seed.users),
      pageGrants: Array.isArray(stored.pageGrants)
        ? [...stored.pageGrants, ...seed.pageGrants.filter(initial => !stored.pageGrants.some(current => current.groupId === initial.groupId && current.pageId === initial.pageId))]
        : structuredClone(seed.pageGrants),
      submissions: Array.isArray(stored.submissions) ? stored.submissions : [],
      skills: Array.isArray(stored.skills) ? stored.skills : [],
      skillSubmissions: Array.isArray(stored.skillSubmissions) ? stored.skillSubmissions : [],
      userGrants: Array.isArray(stored.userGrants) ? stored.userGrants : [],
      accessRequests: Array.isArray(stored.accessRequests) ? stored.accessRequests : []
    };
  }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveState(seed);
    return structuredClone(seed);
  }
}
async function saveState(state) {
  await fs.mkdir(dataDir, { recursive: true });
  const temp = `${dataFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(temp, dataFile);
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求内容超过允许大小');
    chunks.push(chunk);
  }
  return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
async function readLimited(response, maxBytes = 1024 * 1024) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('MCP 响应超过 1 MB 限制');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
const modernProtocol = '2026-07-28';
const legacyProtocols = ['2025-11-25', '2025-06-18', '2025-03-26'];
const clientInfo = { name: 'team-mcp-manager', version: '1.0.0' };
function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': modernProtocol,
    'io.modelcontextprotocol/clientInfo': clientInfo,
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}
async function mcpRequest(endpoint, message, { sessionId, protocolVersion, modern = false, authHeaders = {} } = {}) {
  const headers = {
    ...authHeaders,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (modern) {
    headers['mcp-protocol-version'] = protocolVersion;
    headers['mcp-method'] = message.method;
  }
  const response = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify(message),
    redirect: 'error', signal: AbortSignal.timeout(15_000)
  });
  if (response.status === 401 || response.status === 403) throw new Error('服务要求身份验证；凭据与员工身份接入尚未完成');
  if (response.status === 202) return { sessionId: response.headers.get('mcp-session-id') || sessionId, result: null };
  const text = await readLimited(response);
  let payload;
  const contentType = response.headers.get('content-type') || '';
  if (text && contentType.includes('text/event-stream')) {
    const messages = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).filter(Boolean);
    payload = messages.map(line => { try { return JSON.parse(line); } catch { return null; } }).find(item => item?.id === message.id);
  } else if (text) {
    try { payload = JSON.parse(text); } catch {
      if (!response.ok) {
        const error = new Error(`MCP 服务返回 HTTP ${response.status}`);
        error.httpStatus = response.status;
        throw error;
      }
      throw new Error('MCP 服务返回了无效响应');
    }
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `MCP 服务返回 HTTP ${response.status}`);
    error.httpStatus = response.status;
    error.rpcError = payload?.error;
    throw error;
  }
  if (message.id !== undefined && !payload) throw new Error('MCP 服务未返回对应请求的结果');
  if (payload?.error) {
    const error = new Error(payload.error.message || 'MCP 请求失败');
    error.rpcError = payload.error;
    throw error;
  }
  return { sessionId: response.headers.get('mcp-session-id') || sessionId, result: payload?.result ?? null };
}
async function listMcpTools(endpoint, { modern, sessionId, authHeaders } = {}) {
  const tools = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const params = { ...(cursor ? { cursor } : {}), ...(modern ? { _meta: modernMeta() } : {}) };
    const response = await mcpRequest(endpoint, { jsonrpc: '2.0', id: page + 2, method: 'tools/list', params }, { sessionId, protocolVersion: modern ? modernProtocol : undefined, modern, authHeaders });
    if (!Array.isArray(response.result?.tools)) throw new Error('MCP 服务未提供有效的工具清单');
    tools.push(...response.result.tools);
    cursor = response.result.nextCursor;
    if (!cursor) return tools;
    if (typeof cursor !== 'string' || seenCursors.has(cursor)) throw new Error('MCP 服务返回了无效的工具分页游标');
    seenCursors.add(cursor);
  }
  throw new Error('MCP 工具清单超过 100 页，已停止同步');
}
function canUseSkill(state, user, skill, version, administrator = false) {
  return administrator || (version.targetGroupIds || []).includes(user?.groupId) || state.userGrants.some(grant => grant.resourceType === 'skill' && grant.userId === user?.id && grant.skillId === skill.id && grant.version === version.version && grant.mode === 'allow');
}
function serviceAuthHeaders(service, credentials) {
  const mode = service.authMode || 'none';
  if (mode === 'none') return {};
  if (credentials.endpoint !== service.endpoint) throw new Error('请重新绑定当前服务地址的凭据');
  if (mode === 'bearer' && credentials.token) return { authorization: `Bearer ${credentials.token}` };
  if (mode === 'basic' && credentials.username && credentials.password) return { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` };
  throw new Error('请先绑定个人凭据');
}
async function discoverMcpTools(service, authHeaders = {}) {
  let endpoint;
  try { endpoint = new URL(service.endpoint); }
  catch { throw new Error('请先填写有效的 HTTP 或 HTTPS MCP 地址'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('服务地址仅支持不含账号密码的 HTTP 或 HTTPS URL');
  }
  let tools;
  let modernError;
  try {
    const discovered = await mcpRequest(endpoint, {
      jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta() }
    }, { protocolVersion: modernProtocol, modern: true, authHeaders });
    const versions = discovered.result?.supportedVersions;
    if (!Array.isArray(versions) || !versions.includes(modernProtocol)) throw new Error('MCP 服务没有声明支持当前协议版本');
    if (!discovered.result?.capabilities?.tools) return [];
    tools = await listMcpTools(endpoint, { modern: true, authHeaders });
  } catch (error) {
    if (Number.isInteger(error.rpcError?.code) && error.rpcError.code <= -32000 && error.rpcError.code >= -32099) {
      throw new Error(error.rpcError.code === -32022 ? 'MCP 服务要求的协议版本当前不受支持' : `MCP 协议请求被服务拒绝：${error.message}`);
    }
    const legacyCandidate = [400, 404, 405].includes(error.httpStatus) || error.rpcError?.code === -32601;
    if (!legacyCandidate) throw error;
    modernError = error;
    try {
      const init = await mcpRequest(endpoint, {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo }
      }, { authHeaders });
      if (!init.result) throw new Error('旧版 MCP 初始化未返回服务信息');
      if (!init.result.capabilities?.tools) return [];
      await mcpRequest(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, { sessionId: init.sessionId, authHeaders });
      tools = await listMcpTools(endpoint, { sessionId: init.sessionId, authHeaders });
    } catch (legacyError) {
      throw new Error(`新旧 MCP 协议均未能连接：${legacyError.message || modernError.message}`);
    }
  }
  const uniqueTools = new Map();
  for (const tool of tools.filter(tool => typeof tool.name === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(tool.name))) uniqueTools.set(tool.name, tool);
  return [...uniqueTools.values()].map(tool => ({
    name: tool.name,
    label: typeof tool.title === 'string' ? tool.title.slice(0, 120) : (typeof tool.description === 'string' ? tool.description.slice(0, 120) : tool.name),
    risk: tool.annotations?.readOnlyHint === true ? '只读' : tool.annotations?.destructiveHint === true ? '高风险' : '写入'
  }));
}
const publicationToolDefinitions = [
  {
    name: 'list_mcp_reviewers',
    title: '列出可选审核人',
    description: '返回已登记的平台管理员账号，供申请人指定审核人。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} }
  },
  {
    name: 'submit_mcp_publication',
    title: '提交 MCP 上架审核',
    description: '提交已部署 MCP 服务的上架申请。申请必须指定平台管理员审核；审核通过后仅登记到服务目录，不会执行安装命令或直接开放工具调用。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'MCP 服务名称' },
        category: { type: 'string', enum: ['数据库', '业务系统', '文件与存储', '基础设施', '开发工具', '其他'] },
        endpoint: { type: 'string', minLength: 1, maxLength: 500, description: '服务已部署后的 Streamable HTTP 地址' },
        description: { type: 'string', maxLength: 300, description: '用途、数据范围和风险说明' },
        requesterAccount: { type: 'string', minLength: 1, maxLength: 120, description: '申请人公司账号；当前为自报字段，待云之家身份验证接入' },
        reviewerAccount: { type: 'string', minLength: 1, maxLength: 120, description: '负责审核的平台管理员账号' }
      },
      required: ['name', 'category', 'endpoint', 'description', 'requesterAccount', 'reviewerAccount']
    }
  },
  {
    name: 'get_mcp_publication_status',
    title: '查询 MCP 上架申请状态',
    description: '按申请编号查询审核状态、审核意见和登记结果。',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { submissionId: { type: 'string', minLength: 1, maxLength: 80, description: '申请编号' } },
      required: ['submissionId']
    }
  }
];
const serviceCategories = new Set(['数据库', '业务系统', '文件与存储', '基础设施', '开发工具', '其他']);
function validatePublicationInput(input, state) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const category = input.category;
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const requesterAccount = typeof input.requesterAccount === 'string' ? input.requesterAccount.trim() : '';
  const reviewerAccount = typeof input.reviewerAccount === 'string' ? input.reviewerAccount.trim() : '';
  if (!name || name.length > 80 || !serviceCategories.has(category) || description.length > 300 || !requesterAccount || requesterAccount.length > 120) {
    throw new Error('申请信息无效；请检查名称、类别、说明和申请人账号');
  }
  let endpoint;
  try { endpoint = new URL(String(input.endpoint || '').trim()); }
  catch { throw new Error('请填写有效的 MCP HTTP 或 HTTPS 地址'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('服务地址仅支持不含账号密码的 HTTP 或 HTTPS URL');
  const reviewer = state.users.find(user => user.account.toLowerCase() === reviewerAccount.toLowerCase());
  if (!reviewer || reviewer.groupId !== 'admins') throw new Error('审核人必须是已登记的平台管理员');
  if (state.services.some(service => service.endpoint === endpoint.href) || state.submissions.some(item => item.endpoint === endpoint.href && item.status === 'pending')) {
    throw new Error('该服务地址已登记或已有待审核申请');
  }
  return { name, category, endpoint: endpoint.href, description, requesterAccount, reviewerAccount: reviewer.account };
}
async function handleMcp(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { return json(res, 403, { error: '来源地址无效' }); }
    if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) || Number(parsed.port || 80) !== port) return json(res, 403, { error: '禁止此来源访问 MCP 管理接口' });
  }
  const message = await readBody(req);
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return json(res, 400, { error: 'MCP JSON-RPC 请求格式无效' });
  const hasId = Object.hasOwn(message, 'id');
  if (hasId && typeof message.id !== 'string' && !Number.isInteger(message.id)) return json(res, 400, { error: 'MCP JSON-RPC 请求编号无效' });
  if (!hasId && message.method !== 'notifications/initialized') return json(res, 400, { error: 'MCP 请求缺少编号' });
  const params = message.params || {};
  const requestMeta = params._meta || {};
  const requestedVersion = requestMeta['io.modelcontextprotocol/protocolVersion'];
  const protocolHeader = req.headers['mcp-protocol-version'];
  if (requestedVersion && requestedVersion !== modernProtocol) {
    return json(res, 400, { jsonrpc: '2.0', id: message.id, error: { code: -32022, message: '不支持的 MCP 协议版本', data: { supported: [modernProtocol], requested: requestedVersion || protocolHeader } } });
  }
  if (protocolHeader && protocolHeader !== modernProtocol && !legacyProtocols.includes(protocolHeader)) {
    return json(res, 400, { jsonrpc: '2.0', id: message.id, error: { code: -32022, message: '不支持的 MCP 协议版本', data: { supported: [modernProtocol, ...legacyProtocols], requested: protocolHeader } } });
  }
  const modern = requestedVersion === modernProtocol || protocolHeader === modernProtocol;
  if (modern) {
    if (requestedVersion !== modernProtocol || protocolHeader !== modernProtocol || req.headers['mcp-method'] !== message.method) {
      return json(res, 400, { jsonrpc: '2.0', id: message.id, error: { code: -32020, message: 'MCP 请求头与请求内容不匹配' } });
    }
    if (message.method === 'tools/call' && req.headers['mcp-name'] !== params.name) {
      return json(res, 400, { jsonrpc: '2.0', id: message.id, error: { code: -32020, message: 'Mcp-Name 请求头与工具名称不匹配' } });
    }
  }
  const respond = (result, status = 200) => {
    const body = { jsonrpc: '2.0', id: message.id, result };
    if (modern) body._meta = { 'io.modelcontextprotocol/serverInfo': { name: 'team-mcp-manager', version: '1.0.0' } };
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const rpcError = (code, text) => json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  if (message.method === 'server/discover' && modern) return respond({ supportedVersions: [modernProtocol], capabilities: { tools: { listChanged: false } }, instructions: '使用 submit_mcp_publication 提交服务上架申请；所有申请须经指定的平台管理员审核。' });
  if (message.method === 'initialize' && !modern) {
    const requestedLegacy = params.protocolVersion;
    const negotiatedVersion = legacyProtocols.includes(requestedLegacy) ? requestedLegacy : legacyProtocols[0];
    return respond({ protocolVersion: negotiatedVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'team-mcp-manager', version: '1.0.0' } });
  }
  if (message.method === 'notifications/initialized' && !modern) { res.writeHead(202); return res.end(); }
  if (message.method === 'tools/list') return respond({ tools: publicationToolDefinitions });
  if (message.method !== 'tools/call') return rpcError(-32601, '不支持的 MCP 方法');
  if (typeof params.name !== 'string' || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) return rpcError(-32602, '工具名称或参数无效');
  const input = params.arguments;
  const state = await loadState();
  if (params.name === 'list_mcp_reviewers') {
    const reviewers = state.users.filter(user => user.groupId === 'admins').map(user => ({ name: user.name, account: user.account }));
    return respond({ content: [{ type: 'text', text: JSON.stringify(reviewers) }] });
  }
  if (params.name === 'submit_mcp_publication') {
    try {
      const values = validatePublicationInput(input, state);
      const submission = { id: randomUUID(), ...values, status: 'pending', submittedAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null, reviewComment: '', serviceId: null };
      state.submissions.unshift(submission);
      audit(state, `AI 工具（自报 ${values.requesterAccount}）`, '提交 MCP 上架审核', `${values.name} → ${values.reviewerAccount}`, '待审核');
      await saveState(state);
      return respond({ content: [{ type: 'text', text: JSON.stringify({ submissionId: submission.id, status: submission.status, reviewerAccount: submission.reviewerAccount, message: '申请已提交；审核通过前不会登记为可用服务。' }) }] });
    } catch (error) { return respond({ content: [{ type: 'text', text: error.message }], isError: true }); }
  }
  if (params.name === 'get_mcp_publication_status') {
    const submission = state.submissions.find(item => item.id === input.submissionId);
    if (!submission) return respond({ content: [{ type: 'text', text: '未找到该申请编号。' }], isError: true });
    return respond({ content: [{ type: 'text', text: JSON.stringify({ submissionId: submission.id, name: submission.name, status: submission.status, reviewerAccount: submission.reviewerAccount, reviewedAt: submission.reviewedAt, reviewComment: submission.reviewComment, serviceId: submission.serviceId }) }] });
  }
  return rpcError(-32602, '不支持的工具名称');
}
function audit(state, actor, action, target, result = '成功') {
  state.audit.unshift({ id: randomUUID(), time: new Date().toISOString(), actor, action, target, result });
  state.audit = state.audit.slice(0, 200);
}
const skillRiskExtensions = new Set(['.js', '.ts', '.py', '.sh', '.html', '.svg']);
const skillBlockedExtensions = new Set(['.exe', '.dll', '.so', '.dylib', '.msi', '.com', '.scr', '.bat', '.cmd', '.ps1']);
const skillAllowedExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.csv', '.js', '.ts', '.py', '.sh', '.css', '.html', '.toml', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);
const skillTextExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.csv', '.js', '.ts', '.py', '.sh', '.css', '.html', '.toml', '.svg']);
const maxSkillArchiveBytes = 8 * 1024 * 1024;

function inspectSkillZip(bytes) {
  const min = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 > bytes.length) throw new Error('ZIP 文件结构无效');
  const disk = bytes.readUInt16LE(eocd + 4), centralDisk = bytes.readUInt16LE(eocd + 6);
  const diskEntries = bytes.readUInt16LE(eocd + 8), entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12), centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (disk || centralDisk || diskEntries !== entryCount || entryCount < 1 || entryCount > 150 || eocd + 22 + commentLength !== bytes.length) throw new Error('不支持分卷、ZIP64 或超出文件数量限制的压缩包');
  if (centralOffset + centralSize > eocd) throw new Error('ZIP 文件目录损坏');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const names = new Set();
  const entries = [];
  let cursor = centralOffset, totalUncompressed = 0;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20), uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const externalAttributes = bytes.readUInt32LE(cursor + 38), localOffset = bytes.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (recordEnd > eocd || localOffset >= centralOffset) throw new Error('ZIP 中央目录记录长度无效');
    if (flags & 1) throw new Error('加密 ZIP 不支持；请上传未加密的 Skill 包');
    if (![0, 8].includes(method)) throw new Error('ZIP 中包含不支持的压缩方式');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) throw new Error('暂不支持 ZIP64 文件');
    if (uncompressedSize > 5 * 1024 * 1024) throw new Error('单个文件超过 5 MB 限制');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > 20 * 1024 * 1024) throw new Error('解压后总大小超过 20 MB 限制');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if (!(flags & 0x800) && nameBytes.some(value => value > 0x7f)) throw new Error('ZIP 文件名必须使用 UTF-8 编码');
    const name = decoder.decode(nameBytes);
    if (!name || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error('ZIP 中包含不安全的绝对路径或反斜杠路径');
    const parts = name.split('/');
    const pathParts = name.endsWith('/') ? parts.slice(0, -1) : parts;
    if (!pathParts.length || name.length > 240 || pathParts.length > 8 || pathParts.some(part => !part || part === '.' || part === '..')) throw new Error('ZIP 中包含过长或不安全的路径');
    if (names.has(name)) throw new Error(`ZIP 中存在重复文件路径：${name}`);
    names.add(name);
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if ((madeBy >>> 8) === 3 && (unixMode & 0xf000) === 0xa000) throw new Error('ZIP 中不允许包含符号链接');
    const directory = name.endsWith('/');
    const extension = path.extname(name).toLowerCase();
    if (!directory && (!skillAllowedExtensions.has(extension) || skillBlockedExtensions.has(extension))) throw new Error(`不支持文件类型：${name}`);
    entries.push({ name, directory, uncompressedSize, extension });
    cursor = recordEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('ZIP 中央目录大小不匹配');
  return entries;
}

function inspectSkillPackage(archive) {
  const entries = inspectSkillZip(archive);
  let unzipped;
  try { unzipped = unzipSync(new Uint8Array(archive)); }
  catch { throw new Error('Skill ZIP 无法解压'); }
  const regular = entries.filter(entry => !entry.directory);
  const actualNames = Object.keys(unzipped).filter(name => !name.endsWith('/'));
  if (actualNames.length !== regular.length) throw new Error('ZIP 实际文件清单与中央目录不一致');
  const manifestEntry = regular.find(entry => entry.name === 'SKILL.md' || entry.name.endsWith('/SKILL.md'));
  if (!manifestEntry) throw new Error('Skill 包根目录或唯一顶层目录中必须包含 SKILL.md');
  const prefix = manifestEntry.name === 'SKILL.md' ? '' : manifestEntry.name.slice(0, -'SKILL.md'.length);
  if (prefix && prefix.split('/').filter(Boolean).length !== 1) throw new Error('SKILL.md 只能放在根目录或一个顶层目录内');
  const files = [];
  const warnings = [];
  let manifestContent = '';
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{24,}\b/,
    /\b(?:client_secret|api[_-]?key|access[_-]?token|password|passwd)\s*[:=]\s*["'][^"'\s]{8,}["']/i
  ];
  for (const entry of regular) {
    if (prefix && !entry.name.startsWith(prefix)) throw new Error('ZIP 只能包含 SKILL.md 所在顶层目录中的文件');
    const relativePath = prefix ? entry.name.slice(prefix.length) : entry.name;
    const content = unzipped[entry.name];
    if (!(content instanceof Uint8Array) || content.length !== entry.uncompressedSize) throw new Error(`文件长度与 ZIP 声明不一致：${relativePath}`);
    const fileHash = createHash('sha256').update(content).digest('hex');
    let textContent = null;
    if (skillTextExtensions.has(entry.extension)) {
      try { textContent = new TextDecoder('utf-8', { fatal: true }).decode(content); }
      catch { throw new Error(`文本文件不是有效 UTF-8：${relativePath}`); }
      if (secretPatterns.some(pattern => pattern.test(textContent))) throw new Error(`疑似包含凭据或密钥：${relativePath}；请清除后重新上传`);
    }
    if (skillRiskExtensions.has(entry.extension)) warnings.push({ file: relativePath, reason: '包含脚本或主动内容，需审核人重点检查；管理器不会运行它' });
    if (relativePath === 'SKILL.md') manifestContent = textContent || '';
    files.push({ path: relativePath, size: content.length, sha256: fileHash, risk: skillRiskExtensions.has(entry.extension) ? 'review' : 'normal' });
  }
  const match = manifestContent.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!match) throw new Error('SKILL.md 顶部必须包含 YAML frontmatter');
  const name = match[1].match(/^name:\s*([a-z0-9][a-z0-9-]{0,63})\s*$/m)?.[1];
  const description = match[1].match(/^description:\s*(?:"([^"]*)"|'([^']*)'|(.+))\s*$/m);
  const manifestDescription = description?.[1] ?? description?.[2] ?? description?.[3]?.trim();
  if (!name || !manifestDescription || manifestDescription.length > 1024) throw new Error('SKILL.md 的 name 和 description 必填；name 使用小写字母、数字和连字符');
  return { name, manifestDescription, manifestContent: manifestContent.slice(0, 24_000), files, warnings };
}

function validateSkillSubmission(body, state) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const version = typeof body.version === 'string' ? body.version.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const requesterAccount = typeof body.requesterAccount === 'string' ? body.requesterAccount.trim() : '';
  const reviewerAccount = typeof body.reviewerAccount === 'string' ? body.reviewerAccount.trim() : '';
  const targetGroupIds = Array.isArray(body.targetGroupIds) ? [...new Set(body.targetGroupIds)] : [];
  const groupsExist = targetGroupIds.length > 0 && targetGroupIds.every(id => state.groups.some(group => group.id === id));
  const reviewer = state.users.find(user => user.account.toLowerCase() === reviewerAccount.toLowerCase());
  if (!name || name.length > 80 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !description || description.length > 1000 || !requesterAccount || requesterAccount.length > 120 || !groupsExist) {
    throw new Error('请填写有效的 Skill 名称、版本、说明、申请人，并至少选择一个适用用户组');
  }
  if (!reviewer || reviewer.groupId !== 'admins') throw new Error('审核人必须是已登记的平台管理员');
  return { name, version, description, requesterAccount, reviewerAccount: reviewer.account, targetGroupIds };
}

async function saveSkillArchive(storageKey, archive) {
  const target = path.resolve(dataDir, storageKey);
  const skillRoot = path.resolve(dataDir, 'skills');
  if (!target.startsWith(`${skillRoot}${path.sep}`)) throw new Error('Skill 存储路径无效');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, archive, { flag: 'wx', mode: 0o600 });
}

async function sendSkillArchive(res, storageKey, filename) {
  const target = path.resolve(dataDir, storageKey);
  const skillRoot = path.resolve(dataDir, 'skills');
  if (!target.startsWith(`${skillRoot}${path.sep}`)) return json(res, 400, { error: 'Skill 存储路径无效' });
  const archive = await fs.readFile(target);
  res.writeHead(200, {
    'content-type': 'application/zip', 'content-length': archive.length,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
  });
  res.end(archive);
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function ticketConfirmationCookie(value, maxAge) {
  return `mcp_ticket_confirm=${encodeURIComponent(value)}; Path=/auth/cloud-home/confirm; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cloudHome.redirectUri.startsWith('https:') ? '; Secure' : ''}`;
}
function qrStateCookie(value, maxAge) {
  return `mcp_qr_state=${encodeURIComponent(value)}; Path=/auth/cloud-home/entry; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cloudHome.redirectUri.startsWith('https:') ? '; Secure' : ''}`;
}
function sendAuthCard(res, status, title, content, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...extraHeaders });
  res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · MCP 管理器</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/skills.css"><section class="auth-gate"><div class="auth-card"><div class="brand-mark">M</div><h1>${escapeHtml(title)}</h1>${content}</div></section></html>`);
}
async function handleCloudHomeTicket(req, res, url) {
  if (!cloudHomeLoginEnabled || !['qr', 'ticket'].includes(cloudHome.loginMode)) return sendLoginError(res, 503, '云之家扫码或轻应用登录尚未启用，请管理员在后台完成配置。');
  for (const [key, item] of pendingTicketConfirmations) if (item.expiresAt <= Date.now()) pendingTicketConfirmations.delete(key);
  if (url.pathname === '/auth/cloud-home/entry' && req.method === 'GET') {
    const ticket = url.searchParams.get('ticket');
    if (!ticket) return sendAuthCard(res, 400, '请先完成云之家登录', cloudHome.loginMode === 'qr' ? '<p>请返回管理器登录页，点击「云之家扫码登录」，使用云之家 App 扫码确认。</p><a class="button secondary" href="/auth/login">前往扫码</a>' : '<p>请从云之家工作台打开 MCP 管理器轻应用。</p><a class="button secondary" href="/">返回登录页</a>');
    if (cloudHome.loginMode === 'qr') {
      const state = url.searchParams.get('state') || '';
      const pending = pendingLogins.get(state);
      if (!state || state !== cookieValue(req, 'mcp_qr_state') || !pending || pending.mode !== 'qr' || pending.expiresAt <= Date.now()) return sendLoginError(res, 400, '扫码登录状态已过期或不属于当前浏览器，请返回登录页重新扫码。');
      pendingLogins.delete(state);
    }
    try {
      if (pendingTicketConfirmations.size >= 1000) throw new Error('cloud_home_busy');
      const identity = await ticketClient.verify(ticket);
      const nonce = randomBytes(32).toString('base64url');
      pendingTicketConfirmations.set(nonce, { identity, expiresAt: Date.now() + 5 * 60_000 });
      res.writeHead(303, { location: '/auth/cloud-home/confirm', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': [ticketConfirmationCookie(nonce, 300), qrStateCookie('', 0)] });
      return res.end();
    } catch (error) {
      logBackend('warn', '云之家 ticket 验证失败', { errorCode: /^[a-zA-Z0-9_]+$/.test(error.message) ? error.message : 'cloud_home_network_error' });
      return sendLoginError(res, 401, '云之家身份验证失败或凭证已使用，请重新发起云之家登录；管理员可在后台日志查看错误代码。');
    }
  }
  if (url.pathname !== '/auth/cloud-home/confirm' || !['GET', 'POST'].includes(req.method)) return json(res, 405, { error: '不支持的请求方式' });
  const nonce = cookieValue(req, 'mcp_ticket_confirm');
  const pending = pendingTicketConfirmations.get(nonce);
  if (!pending || pending.expiresAt <= Date.now()) return sendLoginError(res, 401, '登录确认已过期，请返回管理器重新发起云之家登录。');
  if (req.method === 'GET') return sendAuthCard(res, 200, '确认使用云之家登录', `<p>已验证企业成员：<strong>${escapeHtml(pending.identity.name || pending.identity.account)}</strong>。确认后将使用管理员预先绑定的管理器账号登录。</p><form method="post" action="/auth/cloud-home/confirm"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><button class="button primary" type="submit">确认登录</button></form><p>如果不是本人，请关闭页面并切换云之家账号。</p>`);
  // Embedded browsers may submit a same-page HTML form with the opaque Origin "null".
  // The HttpOnly SameSite=Lax nonce cookie plus its matching one-time form value below
  // still bind the confirmation to the browser that received the verified ticket.
  if (req.headers.origin && req.headers.origin !== 'null') {
    const configured = new URL(cloudHome.redirectUri);
    const allowedOrigins = new Set([configured.origin]);
    if (['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname)) {
      for (const localHost of ['localhost', '127.0.0.1', '[::1]']) allowedOrigins.add(`${configured.protocol}//${localHost}${configured.port ? `:${configured.port}` : ''}`);
    }
    if (!allowedOrigins.has(req.headers.origin)) {
      let requestOrigin = 'invalid';
      try { requestOrigin = new URL(req.headers.origin).origin; } catch {}
      logBackend('warn', '云之家登录确认来源校验失败', { requestOrigin, expectedOrigin: configured.origin });
      return sendLoginError(res, 403, '登录确认页面与管理器地址不一致。请从管理器原地址重新扫码；本机预览请统一使用 127.0.0.1:4173。');
    }
  }
  let formBody = '';
  for await (const chunk of req) { formBody += chunk.toString(); if (formBody.length > 1024) return sendLoginError(res, 400, '登录确认格式无效。'); }
  if (new URLSearchParams(formBody).get('nonce') !== nonce) return sendLoginError(res, 403, '登录确认校验失败。');
  pendingTicketConfirmations.delete(nonce);
  const { identity } = pending;
  const appState = await loadState();
  let user = appState.users.find(item => item.cloudHomeEnterpriseId === identity.enterpriseId && item.cloudHomeSubject === identity.subject);
  if (!user && identity.subject === cloudHome.bootstrapAdminOpenId) {
    const existing = appState.users.find(item => item.account.toLowerCase() === cloudHome.bootstrapAdminAccount.toLowerCase());
    if (existing && (existing.groupId !== 'admins' || normalizePhone(existing.phone) !== normalizePhone(cloudHome.bootstrapAdminPhone) || existing.cloudHomeSubject)) return sendLoginError(res, 403, '首位管理员账号已存在且信息不一致，请核对账号、手机号和已有身份绑定。');
    user = existing || { id: randomUUID(), name: cloudHome.bootstrapAdminName, account: cloudHome.bootstrapAdminAccount, phone: normalizePhone(cloudHome.bootstrapAdminPhone), groupId: 'admins' };
    if (!existing) { appState.users.push(user); const group = appState.groups.find(item => item.id === 'admins'); if (group) group.members = (group.members || 0) + 1; }
    Object.assign(user, { cloudHomeEnterpriseId: identity.enterpriseId, cloudHomeSubject: identity.subject, cloudHomeAccount: identity.account, source: '云之家' });
    audit(appState, user.account, '初始化云之家管理员身份绑定', '核对企业 eid 与管理员 openid；手机号由管理员预登记');
    await saveState(appState);
  }
  if (!user || !/^\+[1-9]\d{7,14}$/.test(normalizePhone(user.phone))) return sendLoginError(res, 403, '员工身份尚未绑定或手机号未登记。请管理员在“用户与用户组”中登记手机号，并绑定企业 eid 与员工 openid；系统不会按姓名或设备编号自动关联账号。');
  if (user.cloudHomeAccount !== identity.account || user.source !== '云之家') {
    user.cloudHomeAccount = identity.account;
    user.source = '云之家';
    audit(appState, user.account, '验证云之家企业成员绑定', '服务端校验 appid、eid 与 openid；未将设备编号或姓名用作手机号');
    await saveState(appState);
  }
  const id = randomBytes(32).toString('base64url');
  const sessionUser = { id: user.id, name: user.name, account: user.account, phone: user.phone, groupId: user.groupId };
  browserSessions.set(id, { user: sessionUser, identityStamp: sessionIdentityStamp(user), expiresAt: Date.now() + loginCacheSeconds * 1000 });
  try { await persistBrowserSessions(); } catch (error) { browserSessions.delete(id); throw error; }
  logBackend('info', '云之家 ticket 登录成功', { account: user.account, groupId: user.groupId });
  res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': [sessionCookie(signedValue(id), loginCacheSeconds), ticketConfirmationCookie('', 0)] });
  return res.end();
}
function sendLoginError(res, status, message) {
  const html = `<!doctype html><meta charset="utf-8"><title>登录失败</title><main style="font:16px sans-serif;max-width:560px;margin:12vh auto;padding:24px"><h2>云之家登录未完成</h2><p>${message}</p><a href="/">返回管理器</a></main>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': stateCookie('', 0) });
  res.end(html);
}
async function handleAuth(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/auth/status') {
    let session = currentSession(req);
    const state = cloudHomeLoginEnabled ? await loadState() : null;
    if (session && state && !reconcileSession(session, state)) session = null;
    const pages = session && state ? state.pageGrants.filter(item => item.groupId === session.user.groupId && item.mode === 'allow').map(item => item.pageId) : [];
    return json(res, 200, { enabled: cloudHomeAuthRequired, configured: cloudHomeLoginEnabled, loginMode: cloudHome.loginMode, authenticated: Boolean(session), user: session?.user || null, pages, provider: '云之家' });
  }
  if (req.method === 'GET' && url.pathname === '/auth/login') {
    if (!cloudHomeLoginEnabled) return sendLoginError(res, 503, '管理员尚未完成云之家配置。请在后台“集成登录”选择标准轻应用 ticket 方式，填写企业应用与管理员身份信息。');
    if (cloudHome.loginMode === 'qr') {
      for (const [key, item] of pendingLogins) if (item.expiresAt <= Date.now()) pendingLogins.delete(key);
      if (pendingLogins.size >= 1000) return sendLoginError(res, 429, '登录请求较多，请稍后重试。');
      const state = BigInt(`0x${randomBytes(24).toString('hex')}`).toString();
      pendingLogins.set(state, { mode: 'qr', expiresAt: Date.now() + 5 * 60_000 });
      const target = new URL('https://www.yunzhijia.com/opencloud/openthird/qrconnet');
      target.searchParams.set('appid', cloudHome.clientId);
      target.searchParams.set('redirect_uri', cloudHome.redirectUri);
      target.searchParams.set('state', state);
      res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': qrStateCookie(state, 300) });
      return res.end();
    }
    if (cloudHome.loginMode === 'ticket') return sendAuthCard(res, 200, '从云之家工作台登录', '<p>请登录公司云之家，在工作台打开「MCP 管理器」轻应用。云之家会向管理器传递一次性 ticket，验证后确认登录。</p><p>如需浏览器扫码入口，请管理员在集成登录中选择「网站扫码登录」。</p><a class="button secondary" href="/">返回</a>');
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    pendingLogins.set(state, { verifier, expiresAt: Date.now() + 5 * 60 * 1000 });
    const authorization = new URL(cloudHome.authorizationUrl);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('client_id', cloudHome.clientId);
    authorization.searchParams.set('redirect_uri', cloudHome.redirectUri);
    if (cloudHome.scopes) authorization.searchParams.set('scope', cloudHome.scopes);
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('code_challenge', challenge);
    authorization.searchParams.set('code_challenge_method', 'S256');
    res.writeHead(302, { location: authorization.toString(), 'cache-control': 'no-store', 'set-cookie': stateCookie(state, 300) });
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/auth/callback') {
    if (!cloudHomeLoginEnabled || cloudHome.loginMode !== 'oauth-code') return sendLoginError(res, 403, '当前未启用通用 OAuth 授权码登录。');
    const state = url.searchParams.get('state') || '';
    const pending = pendingLogins.get(state);
    pendingLogins.delete(state);
    if (url.searchParams.has('error')) {
      logBackend('warn', '云之家拒绝登录授权');
      return sendLoginError(res, 401, '云之家未完成本次授权。');
    }
    if (!state || state !== cookieValue(req, 'mcp_oauth_state') || !pending || pending.expiresAt < Date.now() || !url.searchParams.get('code')) {
      logBackend('warn', '云之家登录回调校验失败');
      return sendLoginError(res, 400, '登录状态已过期或校验失败，请重新登录。');
    }
    try {
      const tokenBody = new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: cloudHome.redirectUri, code_verifier: pending.verifier });
      const tokenHeaders = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
      if (cloudHome.tokenAuthMethod === 'client_secret_basic') {
        tokenHeaders.authorization = `Basic ${Buffer.from(`${cloudHome.clientId}:${cloudHome.clientSecret}`).toString('base64')}`;
      } else {
        tokenBody.set('client_id', cloudHome.clientId);
        tokenBody.set('client_secret', cloudHome.clientSecret);
      }
      const tokenResponse = await fetch(cloudHome.tokenUrl, { method: 'POST', headers: tokenHeaders, body: tokenBody, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!tokenResponse.ok) throw new Error(`token_http_${tokenResponse.status}`);
      const token = await tokenResponse.json();
      const accessToken = token.access_token || token.data?.access_token;
      if (typeof accessToken !== 'string' || !accessToken) throw new Error('token_missing_access_token');
      const profileResponse = await fetch(cloudHome.userInfoUrl, { headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!profileResponse.ok) throw new Error(`profile_http_${profileResponse.status}`);
      const responseProfile = await profileResponse.json();
      const profile = responseProfile.data && typeof responseProfile.data === 'object' ? responseProfile.data : responseProfile;
      const subject = String(fieldAt(profile, cloudHome.subjectPath) || '').trim();
      const phone = normalizePhone(fieldAt(profile, cloudHome.phonePath));
      const accountClaim = String(fieldAt(profile, cloudHome.accountPath) || '').trim();
      const nameClaim = String(fieldAt(profile, cloudHome.namePath) || '').trim();
      if (!subject || !accountClaim || !/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('profile_missing_subject_or_phone');
      const appState = await loadState();
      const linkedUser = appState.users.find(user => user.cloudHomeSubject === subject);
      let user = linkedUser || appState.users.find(item => normalizePhone(item.phone) === phone);
      if (!user && accountClaim.toLowerCase() === cloudHome.bootstrapAdminAccount.toLowerCase() && phone === cloudHome.bootstrapAdminPhone && !appState.users.some(item => item.account.toLowerCase() === cloudHome.bootstrapAdminAccount.toLowerCase())) {
        const adminGroup = appState.groups.find(group => group.id === 'admins');
        if (adminGroup) {
          user = { id: randomUUID(), name: cloudHome.bootstrapAdminName.slice(0, 80), account: cloudHome.bootstrapAdminAccount, phone, groupId: adminGroup.id, source: '云之家', cloudHomeSubject: subject, cloudHomeAccount: accountClaim };
          appState.users.push(user);
          adminGroup.members = (adminGroup.members || 0) + 1;
          audit(appState, user.account, '初始化平台管理员账号', '首次云之家登录创建并绑定手机号');
          await saveState(appState);
        }
      }
      if (!user) throw new Error('phone_not_prebound');
      if (normalizePhone(user.phone) !== phone || (user.cloudHomeSubject && user.cloudHomeSubject !== subject) || (user.cloudHomeAccount && accountClaim && user.cloudHomeAccount.toLowerCase() !== accountClaim.toLowerCase())) throw new Error('phone_or_subject_mismatch');
      if (!user.cloudHomeSubject) {
        user.cloudHomeSubject = subject;
        user.source = '云之家';
        if (nameClaim) user.name = nameClaim.slice(0, 80);
        if (accountClaim) user.cloudHomeAccount = accountClaim.slice(0, 120);
        audit(appState, user.account, '绑定云之家身份', '首次登录匹配手机号并绑定外部员工标识');
        await saveState(appState);
      }
      const id = randomBytes(32).toString('base64url');
      const sessionUser = { id: user.id, name: user.name, account: user.account, phone: user.phone, groupId: user.groupId };
      browserSessions.set(id, { user: sessionUser, identityStamp: sessionIdentityStamp(user), expiresAt: Date.now() + loginCacheSeconds * 1000 });
      try { await persistBrowserSessions(); } catch (error) { browserSessions.delete(id); throw error; }
      logBackend('info', '云之家员工登录成功', { account: user.account, groupId: user.groupId });
      res.writeHead(302, { location: '/', 'cache-control': 'no-store', 'set-cookie': [sessionCookie(signedValue(id), loginCacheSeconds), stateCookie('', 0)] });
      return res.end();
    } catch (error) {
      const message = error.message === 'phone_not_prebound'
        ? '该手机号尚未由管理员绑定到管理器账号，请联系管理员。'
        : error.message === 'phone_or_subject_mismatch'
          ? '云之家身份与预先绑定的手机号不匹配，请联系管理员核对账号。'
          : error.message === 'profile_missing_subject_or_phone'
            ? '云之家未返回已配置的员工标识、账号或手机号字段，请管理员检查授权范围和字段映射。'
            : '云之家登录服务暂时无法完成验证，请管理员检查服务地址、应用配置和后台日志。';
      logBackend('error', '云之家登录验证失败', { errorCode: error.message.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) });
      return sendLoginError(res, 401, message);
    }
  }
  if (req.method === 'GET' && url.pathname === '/auth/logout') {
    const session = currentSession(req);
    const id = verifySignedValue(cookieValue(req, 'mcp_session'));
    if (id) browserSessions.delete(id);
    await persistBrowserSessions();
    if (session) logBackend('info', '员工退出登录', { account: session.user.account });
    res.writeHead(302, { location: '/', 'cache-control': 'no-store', 'set-cookie': sessionCookie('', 0) });
    return res.end();
  }
  return false;
}

async function handleEmployeeGateway(req, res, url) {
  const match = url.pathname.match(/^\/gateway\/([^/]+)\/mcp$/);
  if (!match) return json(res, 404, { error: '网关地址无效' });
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
  // Never accept browser cookies or anonymous development identities on the MCP transport.
  const raw = /^Bearer (mcp_[A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
  const tokens = (await serviceVault.get('gateway-tokens')).items || [];
  const token = raw && tokens.find(t => t.hash === createHash('sha256').update(raw).digest('hex') && !t.revoked && t.expiresAt > Date.now());
  const state = await loadState();
  const user = token && state.users.find(u => u.id === token.userId && sessionIdentityStamp(u) === token.identityStamp && state.groups.some(g => g.id === u.groupId));
  if (!user) return json(res, 401, { error: '请使用有效的员工 MCP 访问令牌' });
  const service = state.services.find(s => s.id === decodeURIComponent(match[1]));
  if (!service || token.serviceId !== service.id || service.status !== 'active' || service.marketplaceStatus !== 'published' || !serviceVisible(state, user, service)) return json(res, 403, { error: '当前员工无权连接此服务，或服务已停用' });
  const message = await readBody(req);
  const respond = result => json(res, 200, { jsonrpc: '2.0', id: message.id, result });
  const reject = (code, text) => json(res, 200, { jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } });
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || Array.isArray(message)) return reject(-32600, '请求格式无效');
  if (message.method === 'initialize') {
    const version = message.params?.protocolVersion;
    if (!legacyProtocols.includes(version)) return reject(-32602, '不支持该协议版本');
    return respond({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'company-mcp-gateway', version: '1.0.0' } });
  }
  if (message.method === 'server/discover') return respond({ supportedVersions: [modernProtocol], capabilities: { tools: { listChanged: false } } });
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') { res.writeHead(202); return res.end(); }
  if (message.method === 'ping') return respond({});
  if (message.id === undefined || !['string', 'number'].includes(typeof message.id)) return reject(-32600, '工具请求必须提供请求编号');
  if (!['tools/list', 'tools/call'].includes(message.method)) return reject(-32601, '网关仅开放工具清单与工具调用');
  const name = message.params?.name;
  if (message.method === 'tools/call' && !toolAllowed(state, user, service, name)) {
    logBackend('warn', 'MCP 网关拒绝未授权调用', { account: user.account, serviceId: service.id });
    return reject(-32003, '没有此工具的调用权限');
  }
  try {
    const credentials = await serviceVault.get(`${service.id}:${user.id}`);
    const authHeaders = serviceAuthHeaders(service, credentials);
    let options = { authHeaders, modern: true, protocolVersion: modernProtocol };
    try { await mcpRequest(service.endpoint, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modernMeta() } }, options); }
    catch (error) {
      if (![400, 404, 405].includes(error.httpStatus) && error.rpcError?.code !== -32601) throw error;
      const init = await mcpRequest(service.endpoint, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo } }, { authHeaders });
      options = { authHeaders, sessionId: init.sessionId };
      await mcpRequest(service.endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, options);
    }
    if (message.method === 'tools/list') {
      const tools = await listMcpTools(service.endpoint, options);
      return respond({ tools: tools.filter(t => toolAllowed(state, user, service, t.name)) });
    }
    // Recheck persisted grants after downstream negotiation, before any side effect.
    const latest = await loadState();
    const freshUser = latest.users.find(u => u.id === user.id);
    const freshService = latest.services.find(s => s.id === service.id);
    const latestTokens = (await serviceVault.get('gateway-tokens')).items || [];
    if (!freshUser || !freshService || freshService.endpoint !== service.endpoint || sessionIdentityStamp(freshUser) !== token.identityStamp || !latestTokens.some(t => t.id === token.id && !t.revoked && t.expiresAt > Date.now()) || !toolAllowed(latest, freshUser, freshService, name)) return reject(-32003, '权限已变更，请重新授权');
    const reply = await mcpRequest(service.endpoint, { jsonrpc: '2.0', id: message.id, method: 'tools/call', params: { name, arguments: message.params?.arguments || {}, ...(options.modern ? { _meta: modernMeta() } : {}) } }, options);
    logBackend(reply.result?.isError ? 'warn' : 'info', 'MCP 网关工具调用', { account: user.account, serviceId: service.id, tool: name, outcome: reply.result?.isError ? '工具失败' : '成功' });
    return respond(reply.result);
  } catch {
    logBackend('warn', 'MCP 网关下游请求失败', { account: user.account, serviceId: service.id });
    return reject(-32002, '下游连接或个人凭据验证失败，请检查我的连接凭据；写入操作请先确认结果再决定是否重试');
  }
}

async function api(req, res, url) {
  const session = cloudHomeLoginEnabled ? currentSession(req) : null;
  if (cloudHomeAuthRequired && !cloudHomeLoginEnabled) return json(res, 503, { error: '已要求企业登录，但配置不完整。请服务器管理员修复配置后重启；不会退回匿名管理模式。' });
  if (cloudHomeAuthRequired && !session) return json(res, 401, { error: '请先使用云之家登录' });
  const appState = await loadState();
  if (session && !reconcileSession(session, appState)) return json(res, 401, { error: '账号或身份绑定已变更，请重新登录' });
  const principal = session?.user || null;
  const isAdministrator = !cloudHomeLoginEnabled || principal?.groupId === 'admins';
  if (['/api/settings/login', '/api/settings/login/check'].includes(url.pathname)) {
    if (!isAdministrator) return json(res, 403, { error: '只有平台管理员可以配置集成登录' });
    const provider = url.searchParams.get('provider') || 'cloud-home';
    if (!['cloud-home', 'wecom', 'dingtalk', 'feishu', 'qq', 'wechat'].includes(provider)) return json(res, 400, { error: '不支持的登录平台' });
    const implemented = provider === 'cloud-home';
    const settingsFile = implemented ? authSettingsFile : path.join(dataDir, `auth-provider-${provider}.json`);
    let saved = implemented ? startupAuthSettings || { ...cloudHome, enabled: cloudHomeLoginEnabled } : { ...Object.fromEntries(authSettingKeys.map(key => [key, ''])), tokenAuthMethod: 'client_secret_post', subjectPath: 'sub', phonePath: 'phone_number', accountPath: 'preferred_username', namePath: 'name', enabled: false };
    try { saved = { ...saved, ...JSON.parse(await fs.readFile(settingsFile, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (url.pathname.endsWith('/check')) {
      if (req.method !== 'POST') return json(res, 405, { error: '请使用 POST 请求' });
      if (req.headers.origin && req.headers.origin !== `http://${host}:${port}` && req.headers.origin !== `https://${req.headers.host}`) return json(res, 403, { error: '请从管理器配置页面操作' });
      if (!implemented || !['qr', 'ticket'].includes(saved.loginMode)) return json(res, 400, { error: '此检查只适用于云之家扫码或轻应用 ticket 接入' });
      if (!saved.clientId || !saved.clientSecret || !isHttpsEndpoint(saved.tokenUrl)) return json(res, 400, { error: '请先保存 AppID、AppSecret 和有效的令牌接口地址' });
      try {
        await createCloudHomeTicketClient(saved).checkCredentials();
        logBackend('info', '云之家应用凭据检查通过', { account: principal?.account || '本地管理员' });
        return json(res, 200, { message: 'AppID / AppSecret 可获取应用令牌。此检查未验证 ticket、企业归属、员工绑定或手机号，请继续从云之家工作台联调真实登录。' });
      } catch {
        logBackend('warn', '云之家应用凭据检查未通过', { account: principal?.account || '本地管理员' });
        return json(res, 400, { error: '应用凭据检查未通过，请核对 AppID、AppSecret、网络及云之家接口权限。未保存任何令牌到日志。' });
      }
    }
    if (req.method === 'GET') {
      const { clientSecret, ...safe } = saved;
      return json(res, 200, { provider, implemented, settings: safe, secretConfigured: Boolean(clientSecret), active: implemented && cloudHomeLoginEnabled, issues: implemented ? authConfigurationIssues(saved) : [], restartRequired: implemented && JSON.stringify(saved) !== JSON.stringify(startupAuthSettings || { ...cloudHome, enabled: cloudHomeLoginEnabled }) });
    }
    if (req.method !== 'PUT') return json(res, 405, { error: '不支持的请求方式' });
    if (req.headers.origin && req.headers.origin !== `http://${host}:${port}` && req.headers.origin !== `https://${req.headers.host}`) return json(res, 403, { error: '请从管理器配置页面提交' });
    const body = await readBody(req);
    if (!implemented && body.enabled) return json(res, 400, { error: '该平台尚在规划中，可保存配置草稿，暂不能启用登录' });
    const candidate = { enabled: body.enabled === true };
    for (const key of authSettingKeys) {
      if (key === 'clientSecret' && !body[key]) candidate[key] = saved[key] || '';
      else if (typeof body[key] !== 'string' || body[key].length > 2048 || /[\r\n\u0000]/.test(body[key])) return json(res, 400, { error: '配置字段格式无效' });
      else candidate[key] = body[key].trim();
    }
    candidate.bootstrapAdminPhone = normalizePhone(candidate.bootstrapAdminPhone);
    const issues = implemented ? authConfigurationIssues(candidate) : [];
    if (candidate.enabled && issues.length) return json(res, 400, { error: issues.join('；') });
    await fs.mkdir(dataDir, { recursive: true });
    const temporary = `${settingsFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(candidate, null, 2), { mode: 0o600 }); await fs.rename(temporary, settingsFile); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    logBackend('info', '保存集成登录配置', { account: principal?.account || '本地管理员', provider, enabled: candidate.enabled });
    return json(res, 200, { message: implemented ? '配置已保存，下次启动生效' : '平台配置草稿已保存，登录适配尚在规划中', restartRequired: implemented, issues });
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    if (cloudHomeLoginEnabled && principal?.groupId !== 'admins') return json(res, 403, { error: '只有平台管理员可以查看后台日志' });
    if (cloudHomeLoginEnabled && !appState.pageGrants.some(grant => grant.groupId === principal.groupId && grant.pageId === 'logs' && grant.mode === 'allow')) return json(res, 403, { error: '当前用户组无权查看后台日志' });
    const requestedLevel = url.searchParams.get('level') || 'all';
    const query = (url.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 200));
    const filtered = runtimeLogs.filter(entry => (requestedLevel === 'all' || entry.level === requestedLevel) && (!query || `${entry.event} ${entry.route || ''} ${entry.account || ''} ${entry.errorCode || ''}`.toLowerCase().includes(query)));
    return json(res, 200, { entries: filtered.slice(0, limit), total: filtered.length });
  }
  if (cloudHomeLoginEnabled && url.pathname !== '/api/state') {
    const page = url.pathname === '/api/logs' ? 'logs'
      : url.pathname.startsWith('/api/services') || url.pathname === '/api/grants' || url.pathname === '/api/page-grants' ? 'services'
      : url.pathname.startsWith('/api/submissions') ? 'publications'
        : url.pathname.startsWith('/api/skills') && !/^\/api\/skills\/[^/]+\/versions\/[^/]+\/download$/.test(url.pathname) ? 'skills'
          : url.pathname === '/api/users' ? 'users'
            : null;
    if (page && !appState.pageGrants.some(grant => grant.groupId === principal.groupId && grant.pageId === page && grant.mode === 'allow')) return json(res, 403, { error: '当前用户组无权访问此管理功能' });
    const adminOnly = req.method !== 'GET' && (url.pathname.startsWith('/api/services') || ['/api/grants', '/api/page-grants'].includes(url.pathname) || url.pathname.startsWith('/api/users'))
      || /\/review$/.test(url.pathname);
    if (adminOnly && !isAdministrator) return json(res, 403, { error: '只有平台管理员可以执行此管理操作' });
  }
  const state = appState;
  if (url.pathname === '/api/my/gateway-tokens') {
    if (!principal) return json(res, 403, { error: '请先启用企业登录并以员工身份登录，不能为匿名预览签发令牌' });
    const record = await serviceVault.get('gateway-tokens');
    const items = record.items || [];
    if (req.method === 'GET') return json(res, 200, { tokens: items.filter(t => t.userId === principal.id).map(({ hash, identityStamp, ...t }) => t) });
    const body = await readBody(req);
    if (req.method === 'DELETE') {
      const item = items.find(t => t.id === body.id && t.userId === principal.id);
      if (!item) return json(res, 404, { error: '令牌不存在' });
      await serviceVault.update('gateway-tokens', current => ({ items: (current.items || []).map(t => t.id === item.id && t.userId === principal.id ? { ...t, revoked: true } : t) }));
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST') {
      const service = state.services.find(s => s.id === body.serviceId);
      if (!service || service.status !== 'active' || service.marketplaceStatus !== 'published' || !serviceVisible(state, principal, service)) return json(res, 403, { error: '请选择已启用且有权查看的服务' });
      if (items.filter(t => t.userId === principal.id && !t.revoked && t.expiresAt > Date.now()).length >= 20) return json(res, 400, { error: '最多保留20个有效令牌，请先撤销旧令牌' });
      const token = `mcp_${randomBytes(32).toString('base64url')}`;
      const item = { id: randomUUID(), userId: principal.id, serviceId: service.id, label: String(body.label || service.name).slice(0, 80), identityStamp: sessionIdentityStamp(state.users.find(u => u.id === principal.id)), hash: createHash('sha256').update(token).digest('hex'), createdAt: Date.now(), expiresAt: Date.now() + 30 * 86400000, revoked: false };
      await serviceVault.update('gateway-tokens', current => ({ items: [...(current.items || []), item] }));
      return json(res, 201, { token, id: item.id, path: `/gateway/${encodeURIComponent(service.id)}/mcp`, expiresAt: item.expiresAt });
    }
    return json(res, 405, { error: '方法不支持' });
  }

  if (req.method === 'POST' && url.pathname === '/api/my/mcp-submissions') {
    const body = await readBody(req);
    const user = principal || state.users.find(item => item.groupId === 'admins');
    let values;
    try { values = validatePublicationInput({ ...body, requesterAccount: user.account }, state); }
    catch (error) { return json(res, 400, { error: error.message }); }
    const submission = { id: randomUUID(), ...values, requesterId: user.id, status: 'pending', submittedAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null, reviewComment: '', serviceId: null };
    state.submissions.unshift(submission);
    audit(state, user.account, '员工提交 MCP 上架申请', values.name, '待审核');
    await saveState(state); return json(res, 201, { id: submission.id, status: 'pending' });
  }
  if (req.method === 'POST' && url.pathname === '/api/my/skill-access') {
    const user = principal || state.users.find(item => item.groupId === 'admins');
    const body = await readBody(req);
    const skill = state.skills.find(item => item.id === body.skillId);
    const version = skill?.versions?.find(item => item.version === body.version);
    if (!version) return json(res, 404, { error: 'Skill 版本不存在' });
    if (canUseSkill(state, user, skill, version, isAdministrator)) return json(res, 409, { error: '你已有该版本的使用权限' });
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    if (reason.length < 5) return json(res, 400, { error: '申请原因至少填写 5 个字' });
    if (state.accessRequests.some(item => item.resourceType === 'skill' && item.userId === user.id && item.skillId === skill.id && item.version === version.version && item.status === 'pending')) return json(res, 409, { error: '该版本已有待审核申请' });
    const item = { id: randomUUID(), resourceType: 'skill', userId: user.id, userName: user.name, userAccount: user.account, groupId: user.groupId, skillId: skill.id, version: version.version, serviceName: skill.name, toolName: `Skill ${version.version}`, reason, status: 'pending', submittedAt: new Date().toISOString() };
    state.accessRequests.unshift(item); audit(state, user.account, '申请 Skill 使用权限', `${skill.name} ${version.version}`, '待审批');
    await saveState(state); return json(res, 201, { id: item.id });
  }
  const personalCredentialMatch = url.pathname.match(/^\/api\/my\/service-credentials\/([^/]+)(\/check)?$/);
  if (personalCredentialMatch) {
    const service = state.services.find(item => item.id === decodeURIComponent(personalCredentialMatch[1]) && item.marketplaceStatus === 'published');
    if (!service) return json(res, 404, { error: '服务未发布或不存在' });
    const userId = principal?.id || 'local-admin';
    const canView = isAdministrator || service.marketplaceVisibility !== 'restricted' || service.marketplaceGroupIds?.includes(principal?.groupId) || state.userGrants.some(item => item.userId === userId && item.serviceId === service.id && item.toolName === '*');
    if (!canView) return json(res, 403, { error: '请先申请该受限服务的访问权限' });
    const key = `${service.id}:${userId}`;
    const saved = await serviceVault.get(key);
    const mode = service.authMode || 'none';
    if (req.method === 'GET' && !personalCredentialMatch[2]) return json(res, 200, { name: service.name, authMode: mode, username: saved.username || '', passwordConfigured: Boolean(saved.password), tokenConfigured: Boolean(saved.token), needsRebind: Boolean((saved.password || saved.token) && saved.endpoint !== service.endpoint), connection: saved.connection || null });
    if (req.method === 'PUT' && !personalCredentialMatch[2]) {
      const body = await readBody(req);
      const next = body.clearCredentials === true ? {} : { ...saved };
      next.username = String(body.username || '').trim().slice(0, 200);
      if (body.password) { if (typeof body.password !== 'string' || body.password.length > 4096) return json(res, 400, { error: '密码长度无效' }); next.password = body.password; }
      if (body.token) { if (typeof body.token !== 'string' || body.token.length > 8192 || /[\r\n]/.test(body.token)) return json(res, 400, { error: 'Token 格式无效' }); next.token = body.token; }
      if (saved.endpoint && saved.endpoint !== service.endpoint && body.clearCredentials !== true) return json(res, 409, { error: '服务地址已变更，请清除旧凭据并重新填写' });
      next.endpoint = service.endpoint; next.authMode = mode; next.connection = null;
      await serviceVault.update(key, { username: '', password: '', token: '', ...next });
      audit(state, principal?.account || '本地管理员', '更新个人 MCP 凭据', service.name);
      await saveState(state); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && personalCredentialMatch[2]) {
      if (service.status !== 'active') return json(res, 409, { error: '服务尚未启用，请联系管理员' });
      try {
        const headers = serviceAuthHeaders(service, saved);
        const tools = await discoverMcpTools(service, headers);
        const connection = { state: 'connected', checkedAt: new Date().toISOString() };
        await serviceVault.update(key, { connection, authMode: mode, endpoint: service.endpoint });
        return json(res, 200, { connection, toolCount: tools.length });
      } catch {
        const connection = { state: 'failed', checkedAt: new Date().toISOString() };
        await serviceVault.update(key, { connection, authMode: mode, endpoint: service.endpoint });
        return json(res, 502, { error: '连接未通过，请检查个人凭据或联系管理员检查服务', connection });
      }
    }
    return json(res, 405, { error: '请求方式不支持' });
  }
  const serviceConfigMatch = url.pathname.match(/^\/api\/service-config\/([^/]+)$/);
  if (serviceConfigMatch && ['GET', 'PUT'].includes(req.method)) {
    if (!isAdministrator) return json(res, 403, { error: '只有平台管理员可以配置服务' });
    const service = state.services.find(item => item.id === decodeURIComponent(serviceConfigMatch[1]));
    if (!service) return json(res, 404, { error: '服务不存在' });
    const credentialKey = `${service.id}:${principal?.id || 'local-admin'}`;
    const credentials = await serviceVault.get(credentialKey);
    if (req.method === 'GET') return json(res, 200, { name: service.name, endpoint: service.endpoint, description: service.description, authMode: service.authMode || 'none', username: credentials.username || '', passwordConfigured: Boolean(credentials.password), tokenConfigured: Boolean(credentials.token), parameters: (await serviceVault.get(`parameters:${service.id}`)).parameters || {} });
    const body = await readBody(req);
    let endpoint;
    try { endpoint = new URL(body.endpoint); } catch { return json(res, 400, { error: '请填写有效的 MCP 服务地址' }); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash || endpoint.search) return json(res, 400, { error: '服务地址需为 HTTP/HTTPS 地址，认证信息请填入凭据栏，不支持查询参数' });
    if (!['none', 'basic', 'bearer'].includes(body.authMode)) return json(res, 400, { error: '认证方式无效' });
    if (!body.name?.trim() || body.name.length > 80) return json(res, 400, { error: '请填写 1 至 80 个字的服务名称' });
    if (!body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters)) return json(res, 400, { error: '服务参数需为 JSON 对象' });
    const next = { ...credentials };
    next.endpoint = endpoint.href;
    next.authMode = body.authMode; next.connection = null;
    next.username = String(body.username || '').trim().slice(0, 200);
    if (body.clearCredentials === true) { next.password = ''; next.token = ''; }
    if (typeof body.password === 'string' && body.password) next.password = body.password.slice(0, 4096);
    if (typeof body.token === 'string' && body.token) next.token = body.token.slice(0, 8192);
    if (/[\r\n]/.test(next.token || '')) return json(res, 400, { error: 'Token 不能包含换行' });
    const changedEndpoint = service.endpoint !== endpoint.href;
    if (changedEndpoint && body.clearCredentials !== true && (credentials.password || credentials.token)) return json(res, 400, { error: '更换服务地址时，请选择清除旧凭据，再填写新凭据' });
    await serviceVault.update(credentialKey, next);
    await serviceVault.update(`parameters:${service.id}`, { parameters: body.parameters });
    if (changedEndpoint || (service.authMode || 'none') !== body.authMode) service.connection = null;
    service.name = body.name.trim(); service.endpoint = endpoint.href; service.description = String(body.description || '').trim().slice(0, 500); service.authMode = body.authMode;
    service.connection = null;
    if (changedEndpoint) { service.tools = []; service.toolSyncAt = null; service.status = 'draft'; service.marketplaceStatus = 'unpublished'; state.grants = state.grants.filter(item => item.serviceId !== service.id); state.userGrants = state.userGrants.filter(item => item.serviceId !== service.id); }
    audit(state, principal?.account || '本地管理员', '保存 MCP 服务配置', `${service.name}；个人凭据独立保存`);
    await saveState(state);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!principal) return json(res, 200, state);
    const visible = structuredClone(state);
    const allowed = new Set(state.pageGrants.filter(grant => grant.groupId === principal.groupId && grant.mode === 'allow').map(grant => grant.pageId));
    if (!allowed.has('overview') && !allowed.has('services') && !allowed.has('permissions')) visible.services = [];
    if (!allowed.has('permissions')) { visible.grants = []; visible.pageGrants = []; }
    if (!allowed.has('users')) {
      visible.users = (allowed.has('publications') || allowed.has('skills'))
        ? state.users.filter(user => user.groupId === 'admins').map(({ id, name, account, groupId, source }) => ({ id, name, account, groupId, source }))
        : [];
    }
    if (!allowed.has('users') && !allowed.has('permissions') && !allowed.has('overview') && !allowed.has('skills')) visible.groups = [];
    if (!allowed.has('audit') && !allowed.has('overview')) visible.audit = [];
    if (!allowed.has('publications')) visible.submissions = [];
    if (!allowed.has('skills')) { visible.skills = []; visible.skillSubmissions = []; }
    if (!isAdministrator) {
      visible.skills = visible.skills.map(skill => ({ ...skill, versions: skill.versions.filter(version => canUseSkill(state, principal, skill, version)), latestVersion: skill.latestVersion })).filter(skill => skill.versions.some(version => version.version === skill.latestVersion));
      visible.skillSubmissions = visible.skillSubmissions.filter(item => item.requesterAccount === principal.account);
    }
    if (cloudHomeLoginEnabled && principal.groupId !== 'admins') {
      visible.services = visible.services.filter(service => {
        if (service.marketplaceStatus !== 'published') return false;
        if (service.marketplaceVisibility !== 'restricted') return true;
        return service.marketplaceGroupIds?.includes(principal.groupId)
          || state.userGrants.some(item => item.userId === principal.id && item.serviceId === service.id && item.toolName === '*');
      });
    }
    return json(res, 200, visible);
  }
  if (req.method === 'GET' && url.pathname === '/api/my/access') {
    const user = principal || state.users.find(item => item.groupId === 'admins') || { id: 'local-demo-admin', name: '本地管理员', account: 'admin@example.invalid', groupId: 'admins' };
    const isAdmin = !cloudHomeLoginEnabled || user.groupId === 'admins';
    const requests = state.accessRequests.filter(item => item.userId === user.id);
    const services = state.services.filter(service => service.marketplaceStatus === 'published').map(service => {
      const visibilityGrant = state.userGrants.find(item => item.userId === user.id && item.serviceId === service.id && item.toolName === '*');
      const groupTools = (service.tools || []).map(tool => {
        const personal = state.userGrants.find(item => item.userId === user.id && item.serviceId === service.id && item.toolName === tool.name);
        const group = state.grants.find(item => item.groupId === user.groupId && item.serviceId === service.id && item.toolName === tool.name);
        const mode = [personal?.mode, group?.mode].includes('deny') ? 'deny' : personal?.mode || group?.mode || 'deny';
        return { name: tool.name, label: tool.label || tool.name, risk: tool.risk || '未分类', mode, source: personal ? '个人授权' : group ? '用户组策略' : '默认拒绝', request: requests.find(item => item.serviceId === service.id && item.toolName === tool.name && item.status === 'pending')?.id || null };
      });
      const visible = service.marketplaceVisibility !== 'restricted' || isAdmin || Boolean(visibilityGrant) || service.marketplaceGroupIds?.includes(user.groupId);
      const pending = requests.find(item => item.serviceId === service.id && item.toolName === '*' && item.status === 'pending');
      return {
        id: service.id, name: visible ? service.name : '受限 MCP', category: visible ? service.category : '需管理员批准', description: visible ? service.description || '' : '',
        transport: service.transport || 'Streamable HTTP', visibility: service.marketplaceVisibility || 'all',
        visible, accessRequest: pending?.id || null,
        tools: visible ? groupTools : [],
        authMode: visible ? service.authMode || 'none' : undefined,
        status: visible ? service.status : undefined,
        endpoint: visible ? service.endpoint : undefined
      };
    });
    for (const item of services) if (item.visible) {
      const credentials = await serviceVault.get(`${item.id}:${principal?.id || 'local-admin'}`);
      item.credentialState = item.authMode === 'none' ? '无需认证' : credentials.endpoint !== item.endpoint ? '待绑定' : (item.authMode === 'basic' ? credentials.username && credentials.password : credentials.token) ? '已绑定' : '待绑定';
      item.personalConnection = credentials.endpoint === item.endpoint && credentials.authMode === item.authMode ? credentials.connection || null : null;
    }
    const skills = state.skills.flatMap(skill => {
      const version = skill.versions?.find(item => item.version === skill.latestVersion);
      if (!version) return [];
      const allowed = canUseSkill(state, user, skill, version, isAdmin);
      return [{ id: skill.id, version: version.version, name: allowed ? skill.name : '受限 Skill', description: allowed ? skill.description : '获批后可查看详情并下载此版本', allowed, pending: requests.some(item => item.resourceType === 'skill' && item.skillId === skill.id && item.version === version.version && item.status === 'pending') }];
    });
    const submissions = [...state.submissions.filter(item => item.requesterId ? item.requesterId === user.id : item.requesterAccount === user.account).map(item => ({ type: 'MCP', ...item })), ...state.skillSubmissions.filter(item => item.requesterId ? item.requesterId === user.id : item.requesterAccount === user.account).map(item => ({ type: 'Skill', ...item }))].map(item => ({ id: item.id, type: item.type, name: item.name, version: item.version, status: item.status, submittedAt: item.submittedAt, reviewerAccount: item.reviewerAccount, reviewComment: item.reviewComment || '', reviewedAt: item.reviewedAt })).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    const submissionOptions = { reviewers: state.users.filter(item => item.groupId === 'admins').map(item => ({ name: item.name, account: item.account })), groups: state.groups.map(item => ({ id: item.id, name: item.name })) };
    return json(res, 200, { user: { id: user.id, name: user.name, account: user.account, groupId: user.groupId }, services, skills, requests, submissions, submissionOptions, isAdmin });
  }
  if (req.method === 'POST' && url.pathname === '/api/access-requests') {
    const body = await readBody(req);
    const user = principal || state.users.find(item => item.groupId === 'admins') || { id: 'local-demo-admin', name: '本地管理员', account: 'admin@example.invalid', groupId: 'admins' };
    const service = state.services.find(item => item.id === body.serviceId && item.marketplaceStatus === 'published');
    if (!service) return json(res, 404, { error: '该 MCP 尚未发布到市场' });
    const toolName = body.toolName === '*' ? '*' : String(body.toolName || '');
    const userHasServiceView = service.marketplaceVisibility !== 'restricted' || user.groupId === 'admins' || state.userGrants.some(item => item.userId === user.id && item.serviceId === service.id && item.toolName === '*') || service.marketplaceGroupIds?.includes(user.groupId);
    if (toolName === '*' && userHasServiceView) return json(res, 409, { error: '你已经可以查看此 MCP，无需重复申请' });
    if (toolName !== '*' && !userHasServiceView) return json(res, 403, { error: '请先申请查看该受限 MCP' });
    if (toolName !== '*' && !service.tools?.some(tool => tool.name === toolName)) return json(res, 400, { error: '申请的工具不存在' });
    if (toolName !== '*' && (state.userGrants.some(item => item.userId === user.id && item.serviceId === service.id && item.toolName === toolName && item.mode === 'allow') || state.grants.some(item => item.groupId === user.groupId && item.serviceId === service.id && item.toolName === toolName && item.mode === 'allow'))) return json(res, 409, { error: '你已经有此工具的调用权限' });
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';
    if (reason.length < 5) return json(res, 400, { error: '请填写至少 5 个字的申请原因' });
    const duplicate = state.accessRequests.find(item => item.userId === user.id && item.serviceId === service.id && item.toolName === toolName && item.status === 'pending');
    if (duplicate) return json(res, 409, { error: '已有待审核申请，请等待管理员处理' });
    const requestItem = { id: randomUUID(), userId: user.id, userName: user.name, userAccount: user.account, groupId: user.groupId, serviceId: service.id, serviceName: service.name, toolName, reason, status: 'pending', submittedAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null, reviewComment: '' };
    state.accessRequests.unshift(requestItem);
    audit(state, user.account, '申请 MCP 市场访问权限', `${service.name} / ${toolName === '*' ? '查看受限服务' : toolName}`, '待审批');
    await saveState(state);
    return json(res, 201, { id: requestItem.id, status: requestItem.status });
  }
  if (req.method === 'GET' && url.pathname === '/api/access-requests') {
    if (!isAdministrator) return json(res, 403, { error: '只有平台管理员可以查看员工权限申请' });
    return json(res, 200, state.accessRequests);
  }
  const accessReviewMatch = url.pathname.match(/^\/api\/access-requests\/([^/]+)\/review$/);
  if (req.method === 'POST' && accessReviewMatch) {
    if (!isAdministrator) return json(res, 403, { error: '只有平台管理员可以审批权限申请' });
    const item = state.accessRequests.find(entry => entry.id === decodeURIComponent(accessReviewMatch[1]));
    if (!item) return json(res, 404, { error: '未找到权限申请' });
    if (item.status !== 'pending') return json(res, 409, { error: '该申请已处理' });
    const body = await readBody(req);
    if (!['approved', 'rejected'].includes(body.decision)) return json(res, 400, { error: '审核结论无效' });
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
    if (body.decision === 'rejected' && comment.length < 2) return json(res, 400, { error: '驳回时请填写原因' });
    item.status = body.decision; item.reviewedAt = new Date().toISOString(); item.reviewedBy = principal?.account || '本地管理员'; item.reviewComment = comment;
    if (body.decision === 'approved') {
      const grant = item.resourceType === 'skill' ? { resourceType: 'skill', userId: item.userId, skillId: item.skillId, version: item.version, mode: 'allow' } : { userId: item.userId, serviceId: item.serviceId, toolName: item.toolName, mode: 'allow' };
      const index = state.userGrants.findIndex(entry => item.resourceType === 'skill' ? entry.resourceType === 'skill' && entry.userId === grant.userId && entry.skillId === grant.skillId && entry.version === grant.version : entry.userId === grant.userId && entry.serviceId === grant.serviceId && entry.toolName === grant.toolName);
      if (index >= 0) state.userGrants[index] = grant; else state.userGrants.push(grant);
    }
    audit(state, item.reviewedBy, body.decision === 'approved' ? '批准资源权限申请' : '驳回资源权限申请', `${item.userAccount} / ${item.serviceName} / ${item.toolName === '*' ? '查看受限服务' : item.toolName}`, item.status);
    await saveState(state);
    return json(res, 200, item);
  }
  const marketConfigMatch = url.pathname.match(/^\/api\/marketplace\/([^/]+)$/);
  if (req.method === 'PATCH' && marketConfigMatch) {
    if (!isAdministrator) return json(res, 403, { error: '只有平台管理员可以发布 MCP 到市场' });
    const service = state.services.find(item => item.id === decodeURIComponent(marketConfigMatch[1]));
    if (!service) return json(res, 404, { error: '未找到 MCP 服务' });
    const body = await readBody(req);
    if (body.marketplaceStatus === 'published' && !['all', 'restricted'].includes(body.marketplaceVisibility)) return json(res, 400, { error: '请选择全员可见或受限可见' });
    if (body.marketplaceStatus === 'published' && service.status !== 'active') return json(res, 400, { error: '请先启用 MCP 服务，再发布到市场' });
    if (!['published', 'unpublished'].includes(body.marketplaceStatus)) return json(res, 400, { error: '发布状态无效' });
    service.marketplaceStatus = body.marketplaceStatus;
    service.marketplaceVisibility = body.marketplaceVisibility || service.marketplaceVisibility || 'all';
    service.marketplaceGroupIds = Array.isArray(body.marketplaceGroupIds) ? body.marketplaceGroupIds.filter(id => state.groups.some(group => group.id === id)) : [];
    service.marketplacePublishedAt = body.marketplaceStatus === 'published' ? (service.marketplacePublishedAt || new Date().toISOString()) : null;
    service.marketplacePublishedBy = body.marketplaceStatus === 'published' ? (principal?.account || '本地管理员') : null;
    audit(state, service.marketplaceStatus === 'published' ? service.marketplacePublishedBy : (principal?.account || '本地管理员'), service.marketplaceStatus === 'published' ? '发布 MCP 到市场' : '撤下 MCP 市场发布', `${service.name} / ${service.marketplaceVisibility === 'all' ? '全员可见' : '受限可见'}`);
    await saveState(state);
    return json(res, 200, { id: service.id, marketplaceStatus: service.marketplaceStatus, marketplaceVisibility: service.marketplaceVisibility });
  }
  const marketDownloadMatch = url.pathname.match(/^\/api\/marketplace\/([^/]+)\/download$/);
  if (req.method === 'GET' && marketDownloadMatch) {
    const service = state.services.find(item => item.id === decodeURIComponent(marketDownloadMatch[1]) && item.marketplaceStatus === 'published');
    if (!service) return json(res, 404, { error: '未找到已发布的 MCP' });
    const user = principal || state.users.find(item => item.groupId === 'admins') || { id: 'local-demo-admin', groupId: 'admins', account: 'admin@example.invalid' };
    const isAdmin = !cloudHomeLoginEnabled || user.groupId === 'admins';
    const allowed = service.marketplaceVisibility !== 'restricted' || isAdmin || state.userGrants.some(item => item.userId === user.id && item.serviceId === service.id && item.toolName === '*') || service.marketplaceGroupIds?.includes(user.groupId);
    if (!allowed) return json(res, 403, { error: '尚未获得此 MCP 的查看与下载权限' });
    const profile = { name: service.name, category: service.category, description: service.description || '', serverHosted: true, endpoint: `/gateway/${encodeURIComponent(service.id)}/mcp`, transport: service.transport || 'Streamable HTTP', tools: (service.tools || []).map(tool => ({ name: tool.name, label: tool.label || tool.name, risk: tool.risk || '未分类' })), note: '这是服务器托管 MCP 的连接说明文件，不包含账号、密码、密钥或员工授权凭据。请使用管理器的域名加此网关路径，并配置本人的 Bearer 令牌。' };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${service.name}-连接说明.json`)}`, 'cache-control': 'no-store' });
    return res.end(JSON.stringify(profile, null, 2));
  }
  const pendingArchiveMatch = url.pathname.match(/^\/api\/skills\/submissions\/([^/]+)\/archive$/);
  if (req.method === 'GET' && pendingArchiveMatch) {
    if (!isAdministrator) return json(res, 403, { error: '仅管理员可以下载待审包' });
    const submission = state.skillSubmissions.find(item => item.id === decodeURIComponent(pendingArchiveMatch[1]));
    if (!submission) return json(res, 404, { error: '未找到 Skill 申请' });
    const storageKey = submission.storageKey || `skills/submissions/${submission.id}.zip`;
    try { return await sendSkillArchive(res, storageKey, `${submission.slug}-${submission.version}-review.zip`); }
    catch { return json(res, 404, { error: '待审核文件已不存在' }); }
  }
  const approvedArchiveMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/versions\/([^/]+)\/download$/);
  if (req.method === 'GET' && approvedArchiveMatch) {
    const skill = state.skills.find(item => item.id === decodeURIComponent(approvedArchiveMatch[1]));
    const versionText = decodeURIComponent(approvedArchiveMatch[2]);
    const version = skill?.versions?.find(item => item.version === versionText);
    if (!version) return json(res, 404, { error: '未找到已发布的 Skill 版本' });
    if (!canUseSkill(state, principal, skill, version, isAdministrator)) return json(res, 403, { error: '请先申请该 Skill 版本的使用权限' });
    try { return await sendSkillArchive(res, version.storageKey, `${skill.slug}-${version.version}.zip`); }
    catch { return json(res, 404, { error: '已发布的 Skill 文件不存在' }); }
  }
  if (req.method === 'POST' && ['/api/skills/submissions', '/api/my/skill-submissions'].includes(url.pathname)) {
    const body = await readBody(req, 12 * 1024 * 1024);
    if (principal) body.requesterAccount = principal.account;
    let values;
    try { values = validateSkillSubmission(body, state); }
    catch (error) { return json(res, 400, { error: error.message }); }
    if (typeof body.archiveBase64 !== 'string' || body.archiveBase64.length > 11_200_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.archiveBase64)) {
      return json(res, 400, { error: '请选择不超过 8 MB 的有效 ZIP 文件' });
    }
    const archive = Buffer.from(body.archiveBase64, 'base64');
    if (!archive.length || archive.length > maxSkillArchiveBytes || archive.toString('base64') !== body.archiveBase64) return json(res, 400, { error: '请选择不超过 8 MB 的有效 ZIP 文件' });
    let inspected;
    try { inspected = inspectSkillPackage(archive); }
    catch (error) { return json(res, 400, { error: error.message }); }
    if (inspected.name !== body.skillSlug) return json(res, 400, { error: `SKILL.md 中的 name 是「${inspected.name}」，请填写相同的 Skill 标识再提交` });
    const existingSkill = state.skills.find(skill => skill.slug === inspected.name);
    const alreadyExists = [...(existingSkill?.versions || []).map(item => item.version), ...state.skillSubmissions.filter(item => item.slug === inspected.name && item.status === 'pending').map(item => item.version)];
    if (alreadyExists.includes(values.version)) return json(res, 409, { error: '该 Skill 的此版本已存在或正在审核' });
    const id = randomUUID();
    const storageKey = `skills/submissions/${id}.zip`;
    const submission = {
      id, ...values, requesterId: principal?.id || null, slug: inspected.name,
      manifestDescription: inspected.manifestDescription,
      manifestContent: inspected.manifestContent,
      files: inspected.files, warnings: inspected.warnings,
      archiveSha256: createHash('sha256').update(archive).digest('hex'),
      status: 'pending', submittedAt: new Date().toISOString(),
      reviewedAt: null, reviewedBy: null, reviewComment: '', storageKey
    };
    await saveSkillArchive(storageKey, archive);
    state.skillSubmissions.unshift(submission);
    audit(state, principal?.account || `演示申请人（自报 ${values.requesterAccount}）`, '提交 Skill 发布审核', `${values.name} ${values.version} → ${values.reviewerAccount}`, '待审核');
    await saveState(state);
    return json(res, 201, { id, status: submission.status, slug: submission.slug, version: submission.version, files: submission.files.length, warnings: submission.warnings });
  }
  const skillReviewMatch = url.pathname.match(/^\/api\/skills\/submissions\/([^/]+)\/review$/);
  if (req.method === 'POST' && skillReviewMatch) {
    const submission = state.skillSubmissions.find(item => item.id === decodeURIComponent(skillReviewMatch[1]));
    if (!submission) return json(res, 404, { error: '未找到 Skill 审核申请' });
    if (submission.status !== 'pending') return json(res, 409, { error: '该申请已处理，不能重复审核' });
    const body = await readBody(req);
    const reviewerAccount = principal?.account || (typeof body.reviewerAccount === 'string' ? body.reviewerAccount.trim() : '');
    const reviewer = state.users.find(user => user.account.toLowerCase() === reviewerAccount.toLowerCase());
    if (!reviewer || reviewer.groupId !== 'admins' || reviewer.account.toLowerCase() !== submission.reviewerAccount.toLowerCase()) return json(res, 403, { error: '只有指定的平台管理员审核人可以处理此申请' });
    if (!['approved', 'rejected'].includes(body.decision)) return json(res, 400, { error: '审核结论无效' });
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
    if (body.decision === 'rejected' && !comment) return json(res, 400, { error: '驳回申请时请填写原因' });
    if (body.decision === 'approved') {
      const existing = state.skills.find(skill => skill.slug === submission.slug);
      const versionParts = submission.version.split('-')[0].split('.').map(Number);
      const currentParts = (existing?.latestVersion || '0.0.0').split('-')[0].split('.').map(Number);
      const isGreater = versionParts.some((value, index) => value !== currentParts[index] && versionParts.slice(0, index).every((part, partIndex) => part === currentParts[partIndex]) && value > currentParts[index]);
      if (existing && !isGreater) return json(res, 409, { error: `新版本必须高于当前版本 ${existing.latestVersion}` });
      const skillId = existing?.id || randomUUID();
      const storageKey = `skills/versions/${skillId}/${submission.version}.zip`;
      const archivePath = path.resolve(dataDir, storageKey);
      await fs.mkdir(path.dirname(archivePath), { recursive: true });
      try { await fs.rename(path.resolve(dataDir, submission.storageKey), archivePath); }
      catch { return json(res, 500, { error: '发布文件移动失败；申请仍保持待审核' }); }
      const version = {
        version: submission.version, storageKey,
        archiveSha256: submission.archiveSha256,
        files: submission.files, warnings: submission.warnings,
        manifestContent: submission.manifestContent,
        targetGroupIds: submission.targetGroupIds,
        changelog: submission.description,
        releasedAt: new Date().toISOString(), approvedBy: reviewer.account
      };
      if (existing) {
        existing.name = submission.name;
        existing.description = submission.description;
        existing.latestVersion = submission.version;
        existing.versions.unshift(version);
        existing.targetGroupIds = submission.targetGroupIds;
      } else {
        state.skills.unshift({ id: skillId, slug: submission.slug, name: submission.name, description: submission.description, latestVersion: submission.version, targetGroupIds: submission.targetGroupIds, versions: [version] });
      }
      submission.publishedStorageKey = storageKey;
    }
    submission.status = body.decision;
    submission.reviewedAt = new Date().toISOString();
    submission.reviewedBy = reviewer.account;
    submission.reviewComment = comment;
    audit(state, reviewer.account, body.decision === 'approved' ? '审核通过 Skill 版本' : '驳回 Skill 版本', `${submission.slug} ${submission.version}${body.decision === 'approved' ? '；进入已发布目录' : ''}`);
    await saveState(state);
    return json(res, 200, { id: submission.id, status: submission.status, reviewedAt: submission.reviewedAt, reviewedBy: submission.reviewedBy, reviewComment: submission.reviewComment });
  }
  if (req.method === 'POST' && url.pathname === '/api/services') {
    const body = await readBody(req);
    if (!body.name?.trim() || !body.endpoint?.trim()) return json(res, 400, { error: '名称和服务地址必填' });
    const service = { id: randomUUID(), name: body.name.trim(), category: body.category || '其他', endpoint: body.endpoint.trim(), transport: body.transport || 'Streamable HTTP', status: 'draft', description: body.description?.trim() || '', tools: [] };
    state.services.unshift(service);
    audit(state, principal?.account || '本地管理员', '登记 MCP 服务', service.name);
    await saveState(state);
    return json(res, 201, service);
  }
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/services/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const service = state.services.find(x => x.id === id);
    if (!service) return json(res, 404, { error: '未找到服务' });
    const body = await readBody(req);
    if (body.status && ['draft', 'active', 'paused'].includes(body.status)) service.status = body.status;
    if (body.tools && Array.isArray(body.tools)) service.tools = body.tools;
    audit(state, '本地管理员', '更新 MCP 配置', service.name);
    await saveState(state);
    return json(res, 200, service);
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/services/') && url.pathname.endsWith('/discover')) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2));
    const service = state.services.find(x => x.id === id);
    if (!service) return json(res, 404, { error: '未找到服务' });
    try {
      const credentials = await serviceVault.get(`${service.id}:${principal?.id || 'local-admin'}`);
      const authHeaders = serviceAuthHeaders(service, credentials);
      const tools = await discoverMcpTools(service, authHeaders);
      const names = new Set(tools.map(tool => tool.name));
      const oldGrantCount = state.grants.length;
      state.grants = state.grants.filter(grant => grant.serviceId !== service.id || names.has(grant.toolName));
      service.tools = tools;
      service.toolSyncAt = new Date().toISOString();
      service.connection = { state: 'connected', checkedAt: service.toolSyncAt };
      audit(state, '本地管理员', '同步 MCP 工具清单', `${service.name}（${tools.length} 个工具，清除 ${oldGrantCount - state.grants.length} 条失效授权）`);
      await saveState(state);
      return json(res, 200, { tools, syncedAt: service.toolSyncAt });
    } catch (error) {
      audit(state, '本地管理员', '同步 MCP 工具清单', service.name, '失败');
      service.connection = { state: 'failed', checkedAt: new Date().toISOString() };
      await saveState(state);
      return json(res, 502, { error: error.name === 'TimeoutError' ? '连接 MCP 服务超时（15 秒）' : error.message || '无法连接 MCP 服务' });
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/submissions/') && url.pathname.endsWith('/review')) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2));
    const submission = state.submissions.find(item => item.id === id);
    if (!submission) return json(res, 404, { error: '未找到上架申请' });
    if (submission.status !== 'pending') return json(res, 409, { error: '该申请已经审核，不能重复处理' });
    const body = await readBody(req);
    const reviewerAccount = principal?.account || (typeof body.reviewerAccount === 'string' ? body.reviewerAccount.trim() : '');
    const reviewer = state.users.find(user => user.account.toLowerCase() === reviewerAccount.toLowerCase());
    if (!reviewer || reviewer.groupId !== 'admins' || reviewer.account.toLowerCase() !== submission.reviewerAccount.toLowerCase()) {
      return json(res, 403, { error: '只有指定的平台管理员审核人可以处理此申请' });
    }
    if (!['approved', 'rejected'].includes(body.decision)) return json(res, 400, { error: '审核结论无效' });
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 500) : '';
    if (body.decision === 'rejected' && !comment) return json(res, 400, { error: '驳回申请时请填写审核意见' });
    if (body.decision === 'approved') {
      if (state.services.some(service => service.endpoint === submission.endpoint)) return json(res, 409, { error: '该服务地址已经登记，请先处理现有服务' });
      const service = {
        id: randomUUID(), name: submission.name, category: submission.category,
        endpoint: submission.endpoint, transport: 'Streamable HTTP', status: 'draft',
        description: submission.description, tools: [], publicationSubmissionId: submission.id
      };
      state.services.unshift(service);
      submission.serviceId = service.id;
    }
    submission.status = body.decision;
    submission.reviewedAt = new Date().toISOString();
    submission.reviewedBy = reviewer.account;
    submission.reviewComment = comment;
    audit(state, reviewer.account, body.decision === 'approved' ? '审核通过 MCP 上架申请' : '驳回 MCP 上架申请', `${submission.name}（申请人：${submission.requesterAccount}）${body.decision === 'approved' ? '；已登记为草稿' : ''}`);
    await saveState(state);
    return json(res, 200, submission);
  }
  if (req.method === 'POST' && url.pathname === '/api/grants') {
    const body = await readBody(req);
    if (!['allow', 'approval', 'deny'].includes(body.mode)) return json(res, 400, { error: '权限状态无效' });
    const group = state.groups.find(x => x.id === body.groupId);
    const service = state.services.find(x => x.id === body.serviceId);
    if (!group || !service || !service.tools.some(t => t.name === body.toolName)) return json(res, 400, { error: '用户组、服务或工具不存在' });
    const grant = { groupId: body.groupId, serviceId: body.serviceId, toolName: body.toolName, mode: body.mode };
    const index = state.grants.findIndex(x => x.groupId === grant.groupId && x.serviceId === grant.serviceId && x.toolName === grant.toolName);
    if (index >= 0) state.grants[index] = grant; else state.grants.push(grant);
    audit(state, principal?.account || '本地管理员', '调整工具权限', `${group.name} / ${service.name} / ${body.toolName}`);
    await saveState(state);
    return json(res, 200, grant);
  }
  if (req.method === 'POST' && url.pathname === '/api/page-grants') {
    const body = await readBody(req);
    const allowedPages = ['overview', 'services', 'publications', 'skills', 'permissions', 'users', 'audit', 'logs', 'login-settings'];
    if (!state.groups.some(group => group.id === body.groupId) || !allowedPages.includes(body.pageId) || !['allow', 'deny'].includes(body.mode)) {
      return json(res, 400, { error: '用户组、页面或权限状态无效' });
    }
    const grant = { groupId: body.groupId, pageId: body.pageId, mode: body.mode };
    const index = state.pageGrants.findIndex(item => item.groupId === grant.groupId && item.pageId === grant.pageId);
    if (index >= 0) state.pageGrants[index] = grant; else state.pageGrants.push(grant);
    const group = state.groups.find(item => item.id === grant.groupId);
    const pageName = ({ overview: '总览', services: 'MCP 服务', publications: '发布审批', skills: 'Skill 管理', permissions: '权限策略', users: '用户与用户组', audit: '操作审计' })[grant.pageId];
    audit(state, principal?.account || '本地管理员', '调整页面访问权限', `${group.name} / ${pageName} / ${grant.mode === 'allow' ? '允许查看' : '禁止查看'}`);
    await saveState(state);
    return json(res, 200, grant);
  }
  const groupMatch = url.pathname.match(/^\/api\/groups(?:\/([^/]+))?$/);
  if (groupMatch && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!isAdministrator) return json(res, 403, { error: '只有平台管理员可以管理用户组' });
    const body = await readBody(req);
    const group = groupMatch[1] ? state.groups.find(item => item.id === decodeURIComponent(groupMatch[1])) : null;
    if (req.method !== 'POST' && !group) return json(res, 404, { error: '用户组不存在' });
    if (req.method === 'DELETE') {
      if (group.id === 'admins') return json(res, 400, { error: '平台管理员组不能删除' });
      const members = state.users.filter(user => user.groupId === group.id);
      const target = state.groups.find(item => item.id === body.targetGroupId && item.id !== group.id && item.id !== 'admins');
      if (members.length && !target) return json(res, 400, { error: '请选择一个普通用户组接收现有成员' });
      members.forEach(user => { user.groupId = target.id; });
      for (const [sessionId, session] of browserSessions) if (members.some(user => user.id === session.user.id)) browserSessions.delete(sessionId);
      await persistBrowserSessions();
      state.groups = state.groups.filter(item => item.id !== group.id);
      state.grants = state.grants.filter(item => item.groupId !== group.id);
      state.pageGrants = state.pageGrants.filter(item => item.groupId !== group.id);
      for (const service of state.services) if (service.marketplaceGroupIds) service.marketplaceGroupIds = service.marketplaceGroupIds.filter(id => id !== group.id);
      for (const item of [...state.skills, ...state.skillSubmissions, ...state.skills.flatMap(skill => skill.versions || [])]) if (item.targetGroupIds) item.targetGroupIds = item.targetGroupIds.filter(id => id !== group.id);
      state.groups.forEach(item => { item.members = state.users.filter(user => user.groupId === item.id).length; });
      audit(state, principal?.account || '本地管理员', '删除用户组', `${group.name}；迁移 ${members.length} 名成员${target ? `至 ${target.name}` : ''}`);
    } else {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 40) return json(res, 400, { error: '用户组名称需为 1 至 40 个字' });
      if (state.groups.some(item => item.id !== group?.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return json(res, 409, { error: '用户组名称已存在' });
      if (req.method === 'POST') {
        if (groupMatch[1]) return json(res, 400, { error: '新增用户组地址无效' });
        state.groups.push({ id: randomUUID(), name, members: 0 });
      } else group.name = name;
      audit(state, principal?.account || '本地管理员', req.method === 'POST' ? '新增用户组' : '编辑用户组', name);
    }
    await saveState(state);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/users') {
    const body = await readBody(req);
    const group = state.groups.find(x => x.id === body.groupId);
    if (!body.name?.trim() || !body.account?.trim() || !group) return json(res, 400, { error: '请填写姓名、账号并选择用户组' });
    if (state.users.some(x => x.account.toLowerCase() === body.account.trim().toLowerCase())) return json(res, 409, { error: '该账号已存在' });
    const phone = normalizePhone(body.phone);
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return json(res, 400, { error: '请填写有效手机号；手机号用于绑定云之家员工身份' });
    if (state.users.some(user => normalizePhone(user.phone) === phone)) return json(res, 409, { error: '该手机号已绑定其他账号' });
    const user = { id: randomUUID(), name: body.name.trim(), account: body.account.trim(), phone, groupId: group.id, source: cloudHomeLoginEnabled ? '待绑定云之家' : '本地演示' };
    state.users.push(user);
    group.members += 1;
    audit(state, '本地管理员', '添加用户', user.account);
    await saveState(state);
    return json(res, 201, user);
  }
  const userIdentityMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/cloud-home-identity$/);
  if (req.method === 'PATCH' && userIdentityMatch) {
    const user = state.users.find(item => item.id === userIdentityMatch[1]);
    if (!user) return json(res, 404, { error: '员工账号不存在' });
    if (!/^\+[1-9]\d{7,14}$/.test(normalizePhone(user.phone))) return json(res, 400, { error: '请先登记员工手机号，再由管理员核验云之家身份' });
    const body = await readBody(req);
    const enterpriseId = String(body.enterpriseId || '').trim();
    const openId = String(body.openId || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(enterpriseId) || !/^[a-zA-Z0-9_-]{1,120}$/.test(openId)) return json(res, 400, { error: '请填写有效的企业 eid 和员工 openid' });
    if (cloudHome.enterpriseId && cloudHome.enterpriseId !== enterpriseId) return json(res, 400, { error: '企业 eid 必须与集成登录配置一致' });
    if (user.cloudHomeSubject && (user.cloudHomeSubject !== openId || user.cloudHomeEnterpriseId !== enterpriseId)) return json(res, 409, { error: '员工已有其他身份绑定，需经过核验后换绑，当前不可直接覆盖' });
    if (state.users.some(item => item.id !== user.id && item.cloudHomeEnterpriseId === enterpriseId && item.cloudHomeSubject === openId)) return json(res, 409, { error: '该企业成员身份已绑定其他账号' });
    Object.assign(user, { cloudHomeEnterpriseId: enterpriseId, cloudHomeSubject: openId, source: '云之家（管理员预绑定）' });
    audit(state, principal?.account || '本地管理员', '预绑定云之家企业成员', `${user.account}；管理员核验手机号与企业成员标识`);
    await saveState(state);
    return json(res, 200, { ok: true });
  }
  const userPhoneMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/phone$/);
  if (req.method === 'PATCH' && userPhoneMatch) {
    const user = state.users.find(item => item.id === decodeURIComponent(userPhoneMatch[1]));
    if (!user) return json(res, 404, { error: '未找到员工账号' });
    if (user.cloudHomeSubject) return json(res, 409, { error: '此账号已绑定云之家身份；手机号变更需先完成身份核验流程' });
    const body = await readBody(req);
    const phone = normalizePhone(body.phone);
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return json(res, 400, { error: '请填写有效手机号' });
    if (state.users.some(item => item.id !== user.id && normalizePhone(item.phone) === phone)) return json(res, 409, { error: '该手机号已绑定其他账号' });
    const previous = user.phone;
    user.phone = phone;
    user.source = cloudHomeLoginEnabled ? '待绑定云之家' : '本地演示';
    audit(state, principal?.account || '本地管理员', '登记员工绑定手机号', `${user.account}（${previous || '未登记'} → ${phone}）`);
    await saveState(state);
    return json(res, 200, user);
  }
  return json(res, 404, { error: '接口不存在' });
}
async function staticFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const target = path.resolve(publicDir, `.${pathname}`);
  if (!target.startsWith(`${publicDir}${path.sep}`) && target !== publicDir) return json(res, 403, { error: '禁止访问' });
  try {
    const body = await fs.readFile(target);
    const ext = path.extname(target);
    const type = ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' })[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(body);
  } catch { json(res, 404, { error: '未找到文件' }); }
}
const server = http.createServer(async (req, res) => {
  const requestStartedAt = Date.now();
  let requestPath = '/';
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    requestPath = url.pathname;
    res.once('finish', () => {
      if (requestPath === '/api/logs') return;
      const relevant = requestPath.startsWith('/api/') || requestPath.startsWith('/auth/') || requestPath === '/mcp' || res.statusCode >= 400;
      if (!relevant) return;
      const route = requestPath.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id');
      const session = currentSession(req);
      logBackend(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', `${req.method} ${route}`, {
        status: res.statusCode,
        durationMs: Math.max(0, Date.now() - requestStartedAt),
        ...(session?.user?.account ? { account: session.user.account } : {})
      });
    });
    if (await enrollAdmin(req, res, url)) return;
    if (url.pathname === '/auth/cloud-home/entry' || url.pathname === '/auth/cloud-home/confirm') return await handleCloudHomeTicket(req, res, url);
    if (req.method === 'GET' && (url.pathname === '/api/auth/status' || ['/auth/login', '/auth/callback', '/auth/logout'].includes(url.pathname))) {
      await handleAuth(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/gateway/')) return await handleEmployeeGateway(req, res, url);
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      if (cloudHomeAuthRequired) {
        logBackend('warn', 'MCP AI 客户端请求被拒绝：OAuth 授权服务尚未接入');
        return json(res, 401, { error: '管理器已启用云之家登录；MCP 客户端 OAuth 授权尚未接入，请勿关闭身份验证以绕过此限制' });
      }
      await handleMcp(req, res);
    }
    else if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await staticFile(req, res, url);
  } catch (error) {
    logBackend('error', '请求处理异常', { route: requestPath.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id'), errorCode: error?.name || 'Error' });
    json(res, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? 'JSON 格式无效' : '请求处理失败' });
  }
});
await initializeBackendLogs();
await initializeSessionSigningKey();
serviceVault = createServiceVault(path.join(dataDir, 'service-vault.enc'), sessionSigningKey);
await restoreBrowserSessions();
logBackend('info', '后台服务启动', { host, port, login: cloudHomeLoginEnabled ? 'cloud_home_configured' : 'demo_mode' });
server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`MCP 管理器本机原型已启动：${url}`);
  if (packaged && !process.env.MCP_MANAGER_NO_OPEN) {
    const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', `start "" "${url}"`] : [url];
    execFile(command, args, { windowsHide: true }, error => {
      if (error) console.log(`请在浏览器打开 ${url}`);
    });
  }
});
