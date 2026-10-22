import http from 'node:http';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const packaged = Boolean(process.pkg);
const userDataRoot = process.platform === 'win32'
  ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'));
const appDataDirName = process.platform === 'win32' ? 'TeamMcpManager' : 'team-mcp-manager';
const dataDir = packaged
  ? path.join(userDataRoot, appDataDirName, 'data')
  : path.join(root, 'data');
const dataFile = path.join(dataDir, 'manager.json');
const host = '127.0.0.1';
const port = Number(process.env.MCP_MANAGER_PORT || 4173);

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
    { id: 'u-admin', name: '平台管理员', account: 'admin@example.invalid', groupId: 'admins', source: '本地演示' },
    { id: 'u-data', name: '数据用户示例', account: 'data@example.invalid', groupId: 'data', source: '本地演示' },
    { id: 'u-ops', name: '运维用户示例', account: 'ops@example.invalid', groupId: 'ops', source: '本地演示' }
  ],
  grants: [
    { groupId: 'data', serviceId: 'sqlserver', toolName: 'query_readonly', mode: 'allow' },
    { groupId: 'data', serviceId: 'sqlserver', toolName: 'execute_write', mode: 'approval' },
    { groupId: 'data', serviceId: 'sqlserver', toolName: 'delete_records', mode: 'deny' },
    { groupId: 'ops', serviceId: 'sqlserver', toolName: 'query_readonly', mode: 'allow' },
    { groupId: 'ops', serviceId: 'sqlserver', toolName: 'execute_write', mode: 'approval' },
    { groupId: 'ops', serviceId: 'sqlserver', toolName: 'delete_records', mode: 'approval' }
  ],
  audit: [
    { id: 'a1', time: new Date().toISOString(), actor: '系统', action: '初始化演示数据', target: '管理器', result: '成功' },
    { id: 'a2', time: new Date(Date.now() - 3600_000).toISOString(), actor: '管理员', action: '查看权限策略', target: '数据服务', result: '成功' }
  ]
};

async function loadState() {
  await fs.mkdir(dataDir, { recursive: true });
  try { return JSON.parse(await fs.readFile(dataFile, 'utf8')); }
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
async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('请求内容过大');
  }
  return raw ? JSON.parse(raw) : {};
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
const clientInfo = { name: 'team-mcp-manager', version: '0.1.0' };
function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': modernProtocol,
    'io.modelcontextprotocol/clientInfo': clientInfo,
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}
async function mcpRequest(endpoint, message, { sessionId, protocolVersion, modern = false } = {}) {
  const headers = {
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
async function listMcpTools(endpoint, { modern, sessionId } = {}) {
  const tools = [];
  const seenCursors = new Set();
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const params = { ...(cursor ? { cursor } : {}), ...(modern ? { _meta: modernMeta() } : {}) };
    const response = await mcpRequest(endpoint, { jsonrpc: '2.0', id: page + 2, method: 'tools/list', params }, { sessionId, protocolVersion: modern ? modernProtocol : undefined, modern });
    if (!Array.isArray(response.result?.tools)) throw new Error('MCP 服务未提供有效的工具清单');
    tools.push(...response.result.tools);
    cursor = response.result.nextCursor;
    if (!cursor) return tools;
    if (typeof cursor !== 'string' || seenCursors.has(cursor)) throw new Error('MCP 服务返回了无效的工具分页游标');
    seenCursors.add(cursor);
  }
  throw new Error('MCP 工具清单超过 100 页，已停止同步');
}
async function discoverMcpTools(service) {
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
    }, { protocolVersion: modernProtocol, modern: true });
    const versions = discovered.result?.supportedVersions;
    if (!Array.isArray(versions) || !versions.includes(modernProtocol)) throw new Error('MCP 服务没有声明支持当前协议版本');
    if (!discovered.result?.capabilities?.tools) return [];
    tools = await listMcpTools(endpoint, { modern: true });
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
      });
      if (!init.result) throw new Error('旧版 MCP 初始化未返回服务信息');
      if (!init.result.capabilities?.tools) return [];
      await mcpRequest(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, { sessionId: init.sessionId });
      tools = await listMcpTools(endpoint, { sessionId: init.sessionId });
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
function audit(state, actor, action, target, result = '成功') {
  state.audit.unshift({ id: randomUUID(), time: new Date().toISOString(), actor, action, target, result });
  state.audit = state.audit.slice(0, 200);
}
async function api(req, res, url) {
  const state = await loadState();
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state);
  if (req.method === 'POST' && url.pathname === '/api/services') {
    const body = await readBody(req);
    if (!body.name?.trim() || !body.endpoint?.trim()) return json(res, 400, { error: '名称和服务地址必填' });
    const service = { id: randomUUID(), name: body.name.trim(), category: body.category || '其他', endpoint: body.endpoint.trim(), transport: body.transport || 'Streamable HTTP', status: 'draft', description: body.description?.trim() || '', tools: [] };
    state.services.unshift(service);
    audit(state, '本地管理员', '登记 MCP 服务', service.name);
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
      const tools = await discoverMcpTools(service);
      const names = new Set(tools.map(tool => tool.name));
      const oldGrantCount = state.grants.length;
      state.grants = state.grants.filter(grant => grant.serviceId !== service.id || names.has(grant.toolName));
      service.tools = tools;
      service.toolSyncAt = new Date().toISOString();
      audit(state, '本地管理员', '同步 MCP 工具清单', `${service.name}（${tools.length} 个工具，清除 ${oldGrantCount - state.grants.length} 条失效授权）`);
      await saveState(state);
      return json(res, 200, { tools, syncedAt: service.toolSyncAt });
    } catch (error) {
      audit(state, '本地管理员', '同步 MCP 工具清单', service.name, '失败');
      await saveState(state);
      return json(res, 502, { error: error.name === 'TimeoutError' ? '连接 MCP 服务超时（15 秒）' : error.message || '无法连接 MCP 服务' });
    }
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
    audit(state, '本地管理员', '调整工具权限', `${group.name} / ${service.name} / ${body.toolName}`);
    await saveState(state);
    return json(res, 200, grant);
  }
  if (req.method === 'POST' && url.pathname === '/api/users') {
    const body = await readBody(req);
    const group = state.groups.find(x => x.id === body.groupId);
    if (!body.name?.trim() || !body.account?.trim() || !group) return json(res, 400, { error: '请填写姓名、账号并选择用户组' });
    if (state.users.some(x => x.account.toLowerCase() === body.account.trim().toLowerCase())) return json(res, 409, { error: '该账号已存在' });
    const user = { id: randomUUID(), name: body.name.trim(), account: body.account.trim(), groupId: group.id, source: '本地演示' };
    state.users.push(user);
    group.members += 1;
    audit(state, '本地管理员', '添加用户', user.account);
    await saveState(state);
    return json(res, 201, user);
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
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await staticFile(req, res, url);
  } catch (error) {
    json(res, error instanceof SyntaxError ? 400 : 500, { error: error instanceof SyntaxError ? 'JSON 格式无效' : '请求处理失败' });
  }
});
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

