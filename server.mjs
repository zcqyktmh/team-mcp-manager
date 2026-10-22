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
  submissions: [],
  audit: [
    { id: 'a1', time: new Date().toISOString(), actor: '系统', action: '初始化演示数据', target: '管理器', result: '成功' },
    { id: 'a2', time: new Date(Date.now() - 3600_000).toISOString(), actor: '管理员', action: '查看权限策略', target: '数据服务', result: '成功' }
  ]
};

async function loadState() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const stored = JSON.parse(await fs.readFile(dataFile, 'utf8'));
    return { ...structuredClone(seed), ...stored, submissions: Array.isArray(stored.submissions) ? stored.submissions : [] };
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
const legacyProtocols = ['2025-11-25', '2025-06-18', '2025-03-26'];
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
    if (modern) body._meta = { 'io.modelcontextprotocol/serverInfo': { name: 'team-mcp-manager', version: '0.1.0' } };
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const rpcError = (code, text) => json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code, message: text } });
  if (message.method === 'server/discover' && modern) return respond({ supportedVersions: [modernProtocol], capabilities: { tools: { listChanged: false } }, instructions: '使用 submit_mcp_publication 提交服务上架申请；所有申请须经指定的平台管理员审核。' });
  if (message.method === 'initialize' && !modern) {
    const requestedLegacy = params.protocolVersion;
    const negotiatedVersion = legacyProtocols.includes(requestedLegacy) ? requestedLegacy : legacyProtocols[0];
    return respond({ protocolVersion: negotiatedVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'team-mcp-manager', version: '0.1.0' } });
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
  if (req.method === 'POST' && url.pathname.startsWith('/api/submissions/') && url.pathname.endsWith('/review')) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2));
    const submission = state.submissions.find(item => item.id === id);
    if (!submission) return json(res, 404, { error: '未找到上架申请' });
    if (submission.status !== 'pending') return json(res, 409, { error: '该申请已经审核，不能重复处理' });
    const body = await readBody(req);
    const reviewerAccount = typeof body.reviewerAccount === 'string' ? body.reviewerAccount.trim() : '';
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
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
      await handleMcp(req, res);
    }
    else if (url.pathname.startsWith('/api/')) await api(req, res, url);
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

