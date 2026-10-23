const state = { data: null, auth: null, logs: [], serviceFilter: 'all', serviceQuery: '', userQuery: '', auditQuery: '', logQuery: '', logLevel: 'all' };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Keep navigation labels available to assistive technology in compact mode.
$$('.sidebar .nav-item').forEach(button => {
  [...button.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()).forEach(node => {
    const label = document.createElement('span'); label.className = 'nav-label'; label.textContent = node.textContent.trim(); node.replaceWith(label);
  });
  const name = $('.nav-label', button)?.textContent || '';
  button.title = name; button.setAttribute('aria-label', name);
});
const sidebarMedia = window.matchMedia('(max-width: 760px)');
let sidebarPreference = null;
try { sidebarPreference = localStorage.getItem('mcp-manager-sidebar'); } catch { /* Storage may be disabled. */ }
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  const button = $('#sidebar-toggle');
  button.textContent = collapsed ? '›' : '‹';
  button.title = collapsed ? '展开侧栏' : '收起侧栏';
  button.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
  button.setAttribute('aria-expanded', String(!collapsed));
}
setSidebarCollapsed(sidebarPreference ? sidebarPreference === 'collapsed' : sidebarMedia.matches);
$('#sidebar-toggle').addEventListener('click', () => {
  const collapsed = !document.body.classList.contains('sidebar-collapsed');
  sidebarPreference = collapsed ? 'collapsed' : 'expanded';
  setSidebarCollapsed(collapsed);
  try { localStorage.setItem('mcp-manager-sidebar', sidebarPreference); } catch { /* Keep the current choice for this page. */ }
});
sidebarMedia.addEventListener('change', () => { if (!sidebarPreference) setSidebarCollapsed(sidebarMedia.matches); });
const icons = { '数据库': '▤', '业务系统': '◈', '文件与存储': '▧', '基础设施': '⌘', '开发工具': '⌘', '其他': '◇' };
const labels = { draft: '草稿', active: '已启用', paused: '已暂停', allow: '允许', approval: '需审批', deny: '拒绝' };
const submissionLabels = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
const skillSubmissionLabels = { pending: '待审核', approved: '已发布', rejected: '已驳回' };
const managedPages = [
  ['overview', '总览', '查看工作空间概况与近期活动'],
  ['services', 'MCP 服务', '查看已登记服务与工具清单'],
  ['publications', '发布审批', '查看并处理 MCP 发布申请'],
  ['skills', 'Skill 管理', '查看、审核和下载 Skill'],
  ['permissions', '权限策略', '查看和调整授权策略'],
  ['users', '用户与用户组', '查看用户及所属用户组'],
  ['audit', '操作审计', '查看管理操作记录'],
  ['logs', '后台日志', '查看服务运行、登录和接口异常日志'],
  ['login-settings', '集成登录', '配置企业身份源，仅平台管理员可操作']
];
const allPages = ['my-access', ...managedPages.map(([id]) => id)];
const fmtTime = value => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}
async function refresh() {
  const auth = await request('/api/auth/status');
  state.auth = auth;
  const app = $('#app-shell'), gate = $('#auth-gate'), boot = $('#boot-screen');
  boot.hidden = true;
  if (auth.loginMode === 'qr') $('#auth-gate-message').textContent = '选择一个平台继续登录。使用云之家 App 扫码验证身份。';
  if (auth.loginMode === 'ticket') $('#auth-gate-message').textContent = '选择云之家后，请从公司云之家工作台打开 MCP 管理器轻应用。';
  if (new URLSearchParams(location.search).get('preview') === 'login') {
    app.hidden = true; gate.hidden = false;
    document.title = '登录预览 · MCP 管理器';
    return;
  }
  if (auth.enabled && !auth.authenticated) { app.hidden = true; gate.hidden = false; return; }
  gate.hidden = true; app.hidden = false;
  if (auth.authenticated && auth.user) {
    $('#profile-name').textContent = auth.user.name;
    $('#profile-account').textContent = `${auth.user.phone} · ${auth.user.groupId}`;
    $('#profile-avatar').textContent = auth.user.name.slice(0, 1);
    $('#top-avatar').textContent = auth.user.name.slice(0, 1);
    $('#environment-label').textContent = '云之家已登录';
    $('#logout-link').hidden = false; $('#profile-menu').hidden = true;
  }
  state.data = await request('/api/state');
  render();
  applyPageAccess();
  if (!state.initialPageApplied) {
    state.initialPageApplied = true;
    const initialPage = new URLSearchParams(location.search).get('page');
    if (allPages.includes(initialPage)) showPage(initialPage);
  }
}
document.querySelectorAll('[data-auth-provider]').forEach(button => button.addEventListener('click', () => {
  if (button.disabled) return;
  if (button.dataset.authProvider === 'cloud-home') {
    const preview = new URLSearchParams(location.search).get('preview') === 'login';
    location.href = preview && !state.auth?.enabled ? '/?page=login-settings' : '/auth/login';
  }
}));
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 2600);
}
function serviceMarkup(service, compact = false) {
  const status = service.status || 'draft';
  const tools = service.tools || [];
  const canManage = !state.auth?.enabled || state.auth.user?.groupId === 'admins';
  if (compact) return `<div class="overview-service"><div class="service-symbol">${esc(icons[service.category] || '◇')}</div><div class="service-meta"><strong>${esc(service.name)}</strong><small>${esc(service.category)} · ${tools.length} 个工具${service.endpoint && service.endpoint !== '未登记' && service.endpoint !== '待配置公司服务器地址' ? ` · ${esc(service.endpoint)}` : ''}</small></div><div class="service-state"><i class="state-dot ${esc(status)}"></i>${esc(labels[status] || status)}</div></div>`;
  return `<article class="service-card"><div class="service-card-top"><div class="service-symbol">${esc(icons[service.category] || '◇')}</div><div class="service-card-heading"><h3>${esc(service.name)}</h3><p>${esc(service.category)} · ${esc(service.transport || 'Streamable HTTP')}</p></div><span class="status-tag ${esc(status)}">${esc(labels[status] || status)}</span></div><p class="service-description">${esc(service.description || '尚未填写服务说明。')}</p><div class="service-details"><div class="detail-line"><span>服务地址</span><span title="${esc(service.endpoint)}">${esc(service.endpoint)}</span></div><div class="detail-line"><span>工具数量</span><span>${tools.length} 个${tools.length ? '已登记' : '待同步'}</span></div>${service.marketplaceStatus === 'published' ? `<div class="detail-line"><span>市场状态</span><span>${service.marketplaceVisibility === 'restricted' ? '受限可见' : '全员可见'}</span></div>` : ''}${service.toolSyncAt ? `<div class="detail-line"><span>上次同步</span><span>${fmtTime(service.toolSyncAt)}</span></div>` : ''}</div><div class="tools-chips">${tools.length ? tools.map(t => `<span class="tool-chip">${esc(t.label || t.name)}</span>`).join('') : '<span class="tool-chip">连接服务以同步工具清单</span>'}</div><div class="service-card-actions">${canManage ? `<button class="small-button" data-service-config="${esc(service.id)}">配置</button>` : ''}<button class="small-button primary-small" data-sync-tools="${esc(service.id)}">连接并同步</button><button class="small-button" data-edit-tools="${esc(service.id)}">工具清单</button>${canManage && service.status === 'active' ? `<button class="small-button" data-market-publish="${esc(service.id)}">${service.marketplaceStatus === 'published' ? '市场设置' : '发布到市场'}</button>` : ''}${status === 'active' ? `<button class="small-button" data-toggle-service="${esc(service.id)}" data-status="paused">暂停</button>` : `<button class="small-button" data-toggle-service="${esc(service.id)}" data-status="active">${status === 'paused' ? '重新启用' : '启用'}</button>`}</div></article>`;
}
function renderOverview() {
  const { services, groups, grants, audit } = state.data;
  $('#stat-services').textContent = services.length;
  $('#stat-tools').textContent = services.reduce((n, s) => n + (s.tools?.length || 0), 0);
  $('#stat-groups').textContent = groups.length;
  $('#stat-approval').textContent = grants.filter(x => x.mode === 'approval').length;
  $('#nav-service-count').textContent = services.length;
  $('#overview-services').innerHTML = services.slice(0, 4).map(s => serviceMarkup(s, true)).join('');
  $('#overview-audit').innerHTML = audit.slice(0, 4).map(a => `<div class="activity-item"><div class="activity-mark">↻</div><div class="activity-copy"><strong>${esc(a.action)}</strong><small>${esc(a.actor)} · ${esc(a.target)}</small></div><span class="activity-time">${fmtTime(a.time)}</span></div>`).join('') || '<div class="permission-empty">暂无操作记录</div>';
}
function connectionLabel(service) {
  try { const endpoint = new URL(service.endpoint); if (!['http:', 'https:'].includes(endpoint.protocol)) return '未配置地址'; } catch { return '未配置地址'; }
  const connection = service.connection;
  if (!connection) return '待验证连接';
  return `${connection.state === 'connected' ? '上次连接正常' : '上次连接失败'}${connection.checkedAt ? `<br><small>${fmtTime(connection.checkedAt)}</small>` : ''}`;
}
function renderServices() {
  const q = state.serviceQuery.toLowerCase();
  const services = state.data.services.filter(s => (state.serviceFilter === 'all' || s.status === state.serviceFilter) && `${s.name} ${s.category} ${s.description}`.toLowerCase().includes(q));
  const admin = !state.auth?.enabled || state.auth.user?.groupId === 'admins';
  $('#service-grid').innerHTML = services.length ? `<div class="registry-table-wrap"><table class="registry-table"><thead><tr><th>服务名称</th><th>工具</th><th>启用状态 / 连接检查</th><th>市场范围</th><th>操作</th></tr></thead><tbody>${services.map(service => `<tr><td><div class="registry-service"><span class="service-symbol">${esc(icons[service.category] || '◇')}</span><div><strong>${esc(service.name)}</strong><small>${esc(service.category)} · ${esc(service.transport || 'Streamable HTTP')}</small><small>${esc(service.description || '')}</small></div></div></td><td><span class="registry-tools">${service.tools?.length || 0} 个</span></td><td><span class="status-tag ${esc(service.status)}">${esc(labels[service.status] || '草稿')}</span><div class="connection-meta">${connectionLabel(service)}</div></td><td>${service.marketplaceStatus === 'published' ? `<span class="group-badge">${service.marketplaceVisibility === 'restricted' ? '受限访问' : '全员可见'}</span>` : '<span class="muted">未发布</span>'}</td><td><div class="registry-actions">${admin ? `<button class="small-button" data-service-config="${esc(service.id)}">配置</button><button class="small-button" data-sync-tools="${esc(service.id)}">同步工具</button><button class="small-button" data-edit-tools="${esc(service.id)}">工具清单</button>${service.status === 'active' ? `<button class="small-button" data-market-publish="${esc(service.id)}">市场设置</button>` : ''}<button class="small-button" data-toggle-service="${esc(service.id)}" data-status="${service.status === 'active' ? 'paused' : 'active'}">${service.status === 'active' ? '暂停' : '启用'}</button>` : '<span class="muted">由管理员维护</span>'}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state">没有匹配的 MCP 服务。添加服务后会显示在这里。</div>';
}
function renderPermissionSelectors() {
  const group = $('#permission-group'), service = $('#permission-service');
  const oldGroup = group.value, oldService = service.value;
  group.innerHTML = state.data.groups.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  service.innerHTML = state.data.services.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  if ([...group.options].some(x => x.value === oldGroup)) group.value = oldGroup;
  if ([...service.options].some(x => x.value === oldService)) service.value = oldService;
  renderPermissions();
  renderPagePermissions();
}
function renderPermissions() {
  const groupId = $('#permission-group').value, serviceId = $('#permission-service').value;
  const group = state.data.groups.find(x => x.id === groupId), service = state.data.services.find(x => x.id === serviceId);
  $('#permission-title').textContent = `${group?.name || ''} · ${service?.name || ''} 工具权限`;
  const tools = service?.tools || [];
  const permissionCounts = { allow: 0, approval: 0, deny: 0 };
  tools.forEach(tool => { const mode = state.data.grants.find(grant => grant.groupId === groupId && grant.serviceId === serviceId && grant.toolName === tool.name)?.mode || 'deny'; permissionCounts[mode] = (permissionCounts[mode] || 0) + 1; });
  $('#permission-summary').innerHTML = [['allow', '✓', '已允许工具'], ['approval', '◷', '需申请审批'], ['deny', '⌑', '未开放工具']].map(([mode, icon, label]) => `<div class="permission-summary-item ${mode}"><span>${icon}</span><div><strong>${permissionCounts[mode]}</strong><small>${label}</small></div></div>`).join('');
  $('#permission-list').innerHTML = tools.length ? tools.map(tool => {
    const grant = state.data.grants.find(x => x.groupId === groupId && x.serviceId === serviceId && x.toolName === tool.name);
    const mode = grant?.mode || 'deny';
    return `<div class="permission-row"><div class="permission-tool"><strong>${esc(tool.label || tool.name)}</strong><small>${esc(tool.name)}</small></div><span class="risk-tag ${tool.risk === '高风险' ? 'high' : tool.risk === '写入' ? 'write' : ''}">${esc(tool.risk || '未分类')}</span><select data-grant-tool="${esc(tool.name)}" aria-label="${esc(tool.label || tool.name)} 权限"><option value="allow" ${mode === 'allow' ? 'selected' : ''}>允许</option><option value="approval" ${mode === 'approval' ? 'selected' : ''}>需审批</option><option value="deny" ${mode === 'deny' ? 'selected' : ''}>拒绝</option></select></div>`;
  }).join('') : '<div class="permission-empty">该服务还没有工具定义。服务端网关接入后可同步真实工具。</div>';
}
function renderPagePermissions() {
  const groupId = $('#permission-group').value;
  const group = state.data.groups.find(item => item.id === groupId);
  $('#page-permission-title').textContent = `${group?.name || ''} · 页面访问权限`;
  $('#page-permission-list').innerHTML = managedPages.map(([pageId, name, description]) => {
    const grant = (state.data.pageGrants || []).find(item => item.groupId === groupId && item.pageId === pageId);
    const mode = grant?.mode || 'deny';
    return `<div class="permission-row page-permission-row"><div class="permission-tool"><strong>${esc(name)}</strong><small>${esc(description)}</small></div><span class="risk-tag ${mode === 'allow' ? 'page-access-allowed' : 'high'}">${mode === 'allow' ? '可查看' : '默认拒绝'}</span><select data-page-grant="${esc(pageId)}" aria-label="${esc(name)} 页面权限"><option value="allow" ${mode === 'allow' ? 'selected' : ''}>允许查看</option><option value="deny" ${mode === 'deny' ? 'selected' : ''}>拒绝访问</option></select></div>`;
  }).join('');
}
function renderUsers() {
  const q = state.userQuery.toLowerCase();
  const canManageGroups = !state.auth?.enabled || state.auth.user?.groupId === 'admins';
  if (state.userGroupFilter && !state.data.groups.some(group => group.id === state.userGroupFilter)) state.userGroupFilter = '';
  $('#group-list').innerHTML = `<button class="group-filter-all ${!state.userGroupFilter ? 'selected' : ''}" data-group-filter="">全部员工 <span>${state.data.users.length}</span></button>` + state.data.groups.map(g => `<article class="user-group-card ${state.userGroupFilter === g.id ? 'selected' : ''}"><button class="user-group-select" data-group-filter="${esc(g.id)}"><span class="group-icon">♙</span><span class="group-name">${esc(g.name)}<small>${state.data.users.filter(user => user.groupId === g.id).length} 名员工</small></span></button>${canManageGroups ? `<div class="user-group-actions"><button class="text-button" data-edit-group="${esc(g.id)}">编辑</button>${g.id !== 'admins' ? `<button class="text-button group-delete" data-delete-group="${esc(g.id)}">删除</button>` : '<small>系统用户组</small>'}</div>` : ''}</article>`).join('') + (canManageGroups ? '<button class="group-add" data-add-group>＋ 新增用户组</button>' : '');
  $('#users-table').innerHTML = state.data.users.filter(u => (!state.userGroupFilter || u.groupId === state.userGroupFilter) && `${u.name} ${u.account}`.toLowerCase().includes(q)).map(u => {
    const group = state.data.groups.find(g => g.id === u.groupId);
    return `<tr><td><div class="user-cell"><span class="mini-avatar">${esc(u.name.slice(0, 1))}</span><strong>${esc(u.name)}</strong></div></td><td>${esc(u.account)}</td><td>${esc(u.phone || '未绑定')}</td><td><span class="group-badge">${esc(group?.name || '未分组')}</span></td><td>${esc(u.source || '本地演示')}</td><td><button class="small-button" data-bind-phone="${esc(u.id)}" ${u.cloudHomeSubject ? 'disabled title="账号已绑定云之家身份，手机号修改需重新核验"' : ''}>${u.cloudHomeSubject ? '已绑定' : u.phone ? '修改手机号' : '登记手机号'}</button> <button class="small-button" data-bind-cloud-home="${esc(u.id)}" ${u.cloudHomeSubject ? 'disabled' : ''}>${u.cloudHomeEnterpriseId ? '企业身份已绑定' : u.cloudHomeSubject ? '已有身份绑定' : '绑定云之家'}</button>${u.cloudHomeEnterpriseId ? `<br><small>eid：${esc(u.cloudHomeEnterpriseId)} · openid：${esc(u.cloudHomeSubject)}</small>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="permission-empty">没有匹配的用户</td></tr>';
}
async function refreshBackendLogs() {
  const params = new URLSearchParams({ level: state.logLevel, q: state.logQuery, limit: '500' });
  try {
    const result = await request(`/api/logs?${params}`);
    state.logs = result.entries;
    $('#backend-log-count').textContent = `匹配 ${result.total} 条；最多保留最近 2,000 条在本机日志文件中`;
    $('#backend-logs-table').innerHTML = state.logs.length ? state.logs.map(entry => `<tr><td>${fmtTime(entry.time)}</td><td><span class="log-level ${esc(entry.level)}">${({ error: '错误', warn: '警告', info: '信息' })[entry.level] || esc(entry.level)}</span></td><td>${esc(entry.event)}</td><td>${esc(entry.route || '—')}</td><td>${entry.status ? esc(entry.status) : '—'}</td><td>${entry.durationMs != null ? `${esc(entry.durationMs)} ms` : '—'}</td><td>${esc(entry.account || '—')}</td></tr>`).join('') : '<tr><td colspan="7" class="permission-empty">暂无符合条件的后台日志</td></tr>';
  } catch (error) { toast(`读取后台日志失败：${error.message}`); }
}
function renderAudit() {
  const q = state.auditQuery.toLowerCase();
  $('#audit-table').innerHTML = state.data.audit.filter(a => `${a.actor} ${a.action} ${a.target} ${a.result}`.toLowerCase().includes(q)).map(a => `<tr><td>${fmtTime(a.time)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td><td><span class="result-badge ${a.result === '失败' ? 'failed' : ''}">${esc(a.result)}</span></td></tr>`).join('') || '<tr><td colspan="5" class="permission-empty">没有匹配的记录</td></tr>';
}
function renderPublications() {
  const reviewers = state.data.users.filter(user => user.groupId === 'admins');
  const select = $('#reviewer-account');
  const selected = select.value;
  select.innerHTML = reviewers.map(user => `<option value="${esc(user.account)}">${esc(user.name)}（${esc(user.account)}）</option>`).join('') || '<option value="">尚无平台管理员</option>';
  if (reviewers.some(user => user.account === selected)) select.value = selected;
  $('#manager-mcp-endpoint').textContent = `${location.origin}/mcp`;
  const rows = [...(state.data.submissions || [])].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  $('#nav-submission-count').textContent = rows.filter(item => item.status === 'pending').length;
  $('#submissions-table').innerHTML = rows.length ? rows.map(item => {
    const isAssignedReviewer = item.reviewerAccount?.toLowerCase() === select.value.toLowerCase();
    const actions = item.status === 'pending' && isAssignedReviewer
      ? `<button class="small-button primary-small" data-review-submission="${esc(item.id)}" data-decision="approved">通过</button><button class="small-button" data-review-submission="${esc(item.id)}" data-decision="rejected">驳回</button>`
      : item.status === 'pending' ? '<span class="muted">等待指定审核人</span>' : (item.serviceId ? '已登记草稿' : '—');
    const review = item.reviewComment ? `<br><small>${esc(item.reviewComment)}</small>` : '';
    return `<tr><td><strong>${esc(item.name)}</strong><br><small>${esc(item.endpoint)}</small></td><td>${esc(item.requesterAccount)}<br><small>AI 工具申报</small></td><td>${esc(item.reviewerAccount)}</td><td>${fmtTime(item.submittedAt)}</td><td><span class="status-tag ${esc(item.status)}">${esc(submissionLabels[item.status] || item.status)}</span>${review}</td><td>${actions}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="permission-empty">还没有 AI 工具提交的 MCP 上架申请。</td></tr>';
}
function renderSkills() {
  const reviewers = state.data.users.filter(user => user.groupId === 'admins');
  const reviewerPicker = $('#skill-reviewer-picker');
  const selectedReviewer = reviewerPicker.value;
  reviewerPicker.innerHTML = reviewers.map(user => `<option value="${esc(user.account)}">${esc(user.name)}（${esc(user.account)}）</option>`).join('') || '<option value="">尚无平台管理员</option>';
  if (reviewers.some(user => user.account === selectedReviewer)) reviewerPicker.value = selectedReviewer;
  const requester = $('#skill-requester-account');
  const selectedRequester = requester.value;
  requester.innerHTML = state.data.users.map(user => `<option value="${esc(user.account)}">${esc(user.name)}（${esc(user.account)}）</option>`).join('');
  if (state.data.users.some(user => user.account === selectedRequester)) requester.value = selectedRequester;
  const uploadReviewer = $('#skill-reviewer-account');
  const selectedUploadReviewer = uploadReviewer.value;
  uploadReviewer.innerHTML = reviewers.map(user => `<option value="${esc(user.account)}">${esc(user.name)}（${esc(user.account)}）</option>`).join('') || '<option value="">尚无平台管理员</option>';
  if (reviewers.some(user => user.account === selectedUploadReviewer)) uploadReviewer.value = selectedUploadReviewer;
  const groups = state.data.groups.filter(group => group.id !== 'admins');
  const checkedGroups = new Set($$('#skill-target-groups input:checked').map(input => input.value));
  $('#skill-target-groups').innerHTML = groups.map((group, index) => `<label class="skill-group-option"><input type="checkbox" name="targetGroupIds" value="${esc(group.id)}" ${checkedGroups.size ? (checkedGroups.has(group.id) ? 'checked' : '') : (index === 0 ? 'checked' : '')}><span>${esc(group.name)}</span></label>`).join('') || '<span class="muted">暂无可用用户组</span>';
  const submissions = [...(state.data.skillSubmissions || [])].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  $('#nav-skill-count').textContent = submissions.filter(item => item.status === 'pending').length;
  $('#skill-review-table').innerHTML = submissions.length ? submissions.map(item => {
    const isAssignedReviewer = item.reviewerAccount?.toLowerCase() === reviewerPicker.value.toLowerCase();
    const actions = item.status === 'pending' && isAssignedReviewer
      ? `<a class="small-button" href="/api/skills/submissions/${encodeURIComponent(item.id)}/archive">下载审核包</a> <button class="small-button primary-small" data-skill-review="${esc(item.id)}" data-decision="approved">通过</button> <button class="small-button" data-skill-review="${esc(item.id)}" data-decision="rejected">驳回</button>`
      : item.status === 'pending' ? '<span class="muted">等待指定审核人</span>' : (item.status === 'approved' ? '已进入目录' : '—');
    const fileList = (item.files || []).map(file => `<li>${esc(file.path)} <small>${(file.size / 1024).toFixed(1)} KB</small>${file.risk === 'review' ? ' <span class="risk-tag high">需重点检查</span>' : ''}</li>`).join('');
    const warnings = (item.warnings || []).map(warning => `<li>${esc(warning.file)}：${esc(warning.reason)}</li>`).join('');
    const scan = `<details class="skill-inspection"><summary>${(item.files || []).length} 个文件 · ${(item.warnings || []).length ? `${item.warnings.length} 条重点提示` : '无脚本提示'}</summary><ul>${fileList}</ul>${warnings ? `<strong>审核提示</strong><ul>${warnings}</ul>` : ''}<strong>SKILL.md 预览</strong><pre>${esc(item.manifestContent || '')}</pre><small>ZIP SHA-256：${esc(item.archiveSha256)}</small></details>`;
    const review = item.reviewComment ? `<br><small>${esc(item.reviewComment)}</small>` : '';
    return `<tr><td><strong>${esc(item.name)}</strong><br><small>${esc(item.slug)} · v${esc(item.version)}</small></td><td>${esc(item.requesterAccount)}<br><small>审核：${esc(item.reviewerAccount)}</small></td><td>${scan}</td><td><span class="status-tag ${esc(item.status)}">${esc(skillSubmissionLabels[item.status] || item.status)}</span>${review}</td><td>${actions}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="permission-empty">还没有 Skill 版本申请。</td></tr>';
  const skills = [...(state.data.skills || [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  $('#skill-catalog').innerHTML = skills.length ? skills.map(skill => {
    const groups = (skill.targetGroupIds || []).map(id => state.data.groups.find(group => group.id === id)?.name).filter(Boolean).join('、');
    const versions = [...(skill.versions || [])].sort((a, b) => new Date(b.releasedAt) - new Date(a.releasedAt));
    const history = versions.map(version => `<a class="small-button" href="/api/skills/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(version.version)}/download">下载 v${esc(version.version)}</a> <small>${fmtTime(version.releasedAt)} · ${esc(version.approvedBy)}</small>`).join('<br>');
    return `<article class="skill-card"><div class="skill-card-heading"><div><h3>${esc(skill.name)}</h3><p>${esc(skill.slug)} · v${esc(skill.latestVersion)}</p></div><a class="button secondary" href="/api/skills/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(skill.latestVersion)}/download">下载当前版本</a></div><p>${esc(skill.description)}</p><small>适用范围：${esc(groups || '未指定')}</small><details><summary>版本历史（${versions.length}）</summary><div class="skill-version-list">${history}</div></details></article>`;
  }).join('') : '<div class="empty-state">暂时没有已发布的 Skill 版本。</div>';
}
function accessStatus(mode) {
  return mode === 'allow' ? ['可用', 'approved'] : mode === 'approval' ? ['可申请', 'pending'] : ['未授权', 'rejected'];
}
async function loadMyAccess() {
  loadGatewayTokens();
  $('#gateway-token-result')?.replaceChildren();
  try {
    const data = await request('/api/my/access');
    state.myAccess = data;
    $('#my-resource-submissions').innerHTML = (data.submissions || []).map(item => `<tr><td><strong>${esc(item.name)}</strong>${item.version ? `<br><small>v${esc(item.version)}</small>` : ''}</td><td>${esc(item.type)}</td><td>${esc(item.reviewerAccount)}</td><td><span class="status-tag ${esc(item.status)}">${item.status === 'pending' ? '待审核' : item.status === 'approved' ? '已通过' : '已驳回'}</span>${item.reviewComment ? `<br><small>${esc(item.reviewComment)}</small>` : ''}</td><td>${fmtTime(item.submittedAt)}</td></tr>`).join('') || '<tr><td colspan="5" class="permission-empty">还没有提交资源，可以提交已部署的 MCP 地址或上传 Skill ZIP。</td></tr>';
    $('#my-access-skills').innerHTML = (data.skills || []).map(skill => `<article class="market-card"><div class="market-card-heading"><div class="market-service-symbol">✦</div><div><h3>${esc(skill.name)}</h3><p>Skill · ${esc(skill.version)}</p></div><span class="status-tag ${skill.allowed ? 'active' : 'paused'}">${skill.allowed ? '可下载' : '需申请'}</span></div><p class="market-description">${esc(skill.description)}</p><div class="market-card-actions">${skill.allowed ? `<a class="button secondary" href="/api/skills/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(skill.version)}/download">下载此版本</a>` : skill.pending ? '<span class="market-request-pending">等待管理员审核</span>' : `<button class="button secondary" data-skill-access="${esc(skill.id)}" data-version="${esc(skill.version)}">申请使用</button>`}</div></article>`).join('') || '<div class="empty-state">暂无已发布的 Skill。</div>';
    $('#my-access-summary').innerHTML = `<div class="access-summary-card"><span>登录员工</span><strong>${esc(data.user.name)}</strong><small>${esc(data.user.account)} · ${esc(data.user.groupId)}</small></div><div class="access-summary-card"><span>已发布 MCP</span><strong>${data.services.filter(item => item.visible).length}</strong><small>包含全员与已获批的受限服务</small></div><div class="access-summary-card"><span>待审核申请</span><strong>${data.requests.filter(item => item.status === 'pending').length}</strong><small>审核通过后权限会显示在此处</small></div>`;
    $('#my-access-services').innerHTML = data.services.length ? data.services.map(service => {
      if (!service.visible) return `<article class="market-card market-locked"><div class="market-card-heading"><div class="market-service-symbol">⌑</div><div><h3>受限 MCP</h3><p>${esc(service.category)} · 由管理员审核开放</p></div><span class="status-tag paused">需申请</span></div><p class="market-description">该项由管理员设置为受限访问。提交申请并经审核通过后，即可查看服务详情。</p><div class="market-card-actions">${service.accessRequest ? '<span class="market-request-pending">申请已提交，等待审核</span>' : `<button class="button secondary" data-access-request="${esc(service.id)}" data-access-tool="*">申请查看</button>`}</div></article>`;
      const tools = service.tools.map(tool => {
        const [status, className] = accessStatus(tool.mode);
        const action = tool.mode === 'allow' ? '' : tool.request ? '<span class="market-request-pending">待审核</span>' : `<button class="small-button" data-access-request="${esc(service.id)}" data-access-tool="${esc(tool.name)}">申请权限</button>`;
        return `<div class="market-tool-row"><div><strong>${esc(tool.label)}</strong><small>${esc(tool.name)} · ${esc(tool.source)}${tool.risk ? ` · ${esc(tool.risk)}` : ''}</small></div><span class="market-tool-status ${className}">${status}</span>${action}</div>`;
      }).join('') || '<div class="permission-empty">管理员尚未登记工具清单。</div>';
      return `<article class="market-card"><div class="market-card-heading"><div class="market-service-symbol">${esc(icons[service.category] || '◇')}</div><div><h3>${esc(service.name)}</h3><p>${esc(service.category)} · ${service.visibility === 'restricted' ? '已获批的受限服务' : '全员开放'}</p></div><span class="status-tag active">已发布</span></div><p class="market-description">${esc(service.description || '暂无服务说明。')}</p><div class="market-tools"><div class="market-tools-title">我的工具权限 <span>${service.tools.filter(tool => tool.mode === 'allow').length}/${service.tools.length} 可用</span></div>${tools}</div><div class="personal-connection-info">${esc(service.credentialState || "待检查")}${service.personalConnection ? ` · ${service.personalConnection.state === "connected" ? "上次个人连接正常" : "上次个人连接失败"} · ${fmtTime(service.personalConnection.checkedAt)}` : " · 尚未检查个人连接"}</div><div class="market-card-actions"><button class="button secondary" data-personal-check="${esc(service.id)}" ${service.status !== "active" ? "disabled" : ""}>检查我的连接</button><button class="button secondary" data-personal-credentials="${esc(service.id)}">我的连接凭据</button><a class="button secondary" href="/api/marketplace/${encodeURIComponent(service.id)}/download">下载连接说明</a></div></article>`;
    }).join('') : '<div class="empty-state">公司市场暂时没有已发布的 MCP。管理员发布后会显示在这里。</div>';
    $('#my-access-requests').innerHTML = data.requests.length ? data.requests.map(item => `<tr><td><strong>${esc(item.serviceName)}</strong><br><small>${item.toolName === '*' ? '申请查看受限服务' : esc(item.toolName)}</small></td><td>${esc(item.reason)}</td><td><span class="status-tag ${esc(item.status)}">${item.status === 'pending' ? '待审核' : item.status === 'approved' ? '已通过' : '已驳回'}</span></td><td>${esc(item.reviewComment || '—')}</td><td>${fmtTime(item.submittedAt)}</td></tr>`).join('') : '<tr><td colspan="5" class="permission-empty">你还没有提交权限申请。</td></tr>';
  } catch (error) { $('#my-access-services').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; }
}
async function loadAccessRequests() {
  try {
    const items = await request('/api/access-requests');
    const pending = items.filter(item => item.status === 'pending');
    $('#access-review-table').innerHTML = pending.length ? pending.map(item => `<tr><td><strong>${esc(item.userName)}</strong><br><small>${esc(item.userAccount)} · ${esc(item.groupId)}</small></td><td><strong>${esc(item.serviceName)}</strong><br><small>${item.toolName === '*' ? '申请查看受限服务' : esc(item.toolName)}</small></td><td>${esc(item.reason)}</td><td>${fmtTime(item.submittedAt)}</td><td><button class="small-button primary-small" data-access-review="${esc(item.id)}" data-decision="approved">批准</button> <button class="small-button" data-access-review="${esc(item.id)}" data-decision="rejected">驳回</button></td></tr>`).join('') : '<tr><td colspan="5" class="permission-empty">当前没有待审批的员工权限申请。</td></tr>';
  } catch (error) { $('#access-review-table').innerHTML = `<tr><td colspan="5" class="permission-empty">${esc(error.message)}</td></tr>`; }
}
function render() { renderOverview(); renderServices(); renderPermissionSelectors(); renderUsers(); renderAudit(); renderPublications(); renderSkills(); $('#access-review-panel').hidden = state.auth?.enabled && state.auth.user?.groupId !== 'admins'; }
function showPage(name) {
  if ($('.page.active')?.id !== `page-${name}`) { closeInputCard(); closeModal(); }
  if (state.auth?.enabled) {
    const allowed = state.auth.pages || [];
    if (name !== 'my-access' && !allowed.length) {
      $$('.page').forEach(page => page.classList.remove('active'));
      $('#no-page-access').hidden = false;
      return;
    }
    if (name !== 'my-access' && !allowed.includes(name)) name = allowed[0] || 'my-access';
    $('#no-page-access').hidden = true;
  }
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  $('#crumb-current').textContent = ({ 'my-access': '我的 MCP', overview: '总览', services: 'MCP 服务', publications: '发布审批', skills: 'Skill 管理', permissions: '权限策略', users: '用户与用户组', audit: '操作审计', logs: '后台日志' })[name] || name;
  if (name === 'my-access') loadMyAccess();
  if (name === 'permissions' && (!state.auth?.enabled || state.auth.user?.groupId === 'admins')) loadAccessRequests();
  if (name === 'logs') refreshBackendLogs();
  if (name === 'login-settings') { $('#crumb-current').textContent = '集成登录'; loadLoginSettings(); }
}
const loginFields = [
  ['loginMode', '接入方式', 'select'], ['enterpriseId', '企业团队 ID（eid）'], ['bootstrapAdminOpenId', '首位管理员的企业成员 openid'],
  ['clientId', '应用标识（Client ID）'], ['clientSecret', '应用密钥（Client Secret）', 'password'],
  ['authorizationUrl', '授权地址（HTTPS）', 'url'], ['tokenUrl', '令牌地址（HTTPS）', 'url'],
  ['userInfoUrl', '用户信息地址（HTTPS）', 'url'], ['redirectUri', '回调地址', 'url'],
  ['scopes', '授权范围（Scope，可留空）'], ['tokenAuthMethod', '令牌认证方式', 'select'],
  ['subjectPath', '稳定员工标识字段'], ['phonePath', '手机号字段'],
  ['accountPath', '外部账号字段'], ['namePath', '姓名字段'],
  ['bootstrapAdminAccount', '首位管理员的外部平台账号'], ['bootstrapAdminName', '首位管理员姓名'],
  ['bootstrapAdminPhone', '首位管理员手机号', 'tel']
];
const loginFieldHints = { clientId: '从企业云之家应用的开发配置中复制应用标识。', clientSecret: '由公司应用管理员提供；已有密钥可留空。', redirectUri: '填写 MCP 管理器自己的访问地址 + /auth/cloud-home/entry。不能填 www.yunzhijia.com；本机预览使用 http://127.0.0.1:4173/auth/cloud-home/entry。', bootstrapAdminAccount: '标准轻应用：管理器内的管理员账号，由企业管理员与 openid、手机号一并核验。', bootstrapAdminPhone: '由企业管理员核验后登记；ticket 身份接口不保证返回手机号。', enterpriseId: '从公司云之家取得企业团队 ID，登录时必须与云之家返回的 eid 完全一致。', bootstrapAdminOpenId: '可通过下方扫码获取并确认绑定，无需手动查询；已有标识也可手动填写。' };
const loginProviderNames = { 'cloud-home': '云之家', wecom: '企业微信', dingtalk: '钉钉', feishu: '飞书', qq: 'QQ', wechat: '微信' };
const loginDrafts = new Map();
$('#settings-login-provider').addEventListener('change', event => {
  const form = $('#login-settings-form');
  if (state.loginProvider && !form.hidden) loginDrafts.set(state.loginProvider, { ...Object.fromEntries(new FormData(form)), enabled: form.elements.enabled.checked });
  loadLoginSettings(event.target.value);
});
async function loadLoginSettings(provider = $('#settings-login-provider').value) {
  const form = $('#login-settings-form');
  const requestId = (state.loginSettingsRequest || 0) + 1;
  state.loginSettingsRequest = requestId;
  state.loginProvider = provider;
  $('#login-settings-title').textContent = `${loginProviderNames[provider]}${provider === 'cloud-home' ? '应用配置' : '接入资料草稿'}`;
  $('#cloud-login-preparation').hidden = provider !== 'cloud-home';
  $('#future-login-preparation').hidden = provider === 'cloud-home';
  form.hidden = true;
  try {
    const data = await request(`/api/settings/login?provider=${encodeURIComponent(provider)}`);
    if (requestId !== state.loginSettingsRequest) return;
    const renderLoginField = ([name, label, type = 'text']) => `<label data-login-field="${name}"><span class="login-field-label">${esc(label)}</span>${type === 'select' ? `<select name="${name}">${name === 'loginMode' ? '<option value="qr">网站扫码登录（推荐）</option><option value="ticket">轻应用工作台免登</option><option value="oauth-code">通用 OAuth 授权码（企业另行提供）</option>' : '<option value="client_secret_post">client_secret_post（表单）</option><option value="client_secret_basic">client_secret_basic（请求头）</option>'}</select>` : `<input type="${type}" name="${name}" maxlength="2048" autocomplete="${type === 'password' ? 'new-password' : 'off'}" value="${esc(type === 'password' ? '' : data.settings[name] || '')}" ${type === 'password' ? `placeholder="${data.secretConfigured ? '已设置，留空保留' : '尚未设置'}"` : ''}>`}${loginFieldHints[name] ? `<small class="field-hint">${esc(loginFieldHints[name])}</small>` : ''}</label>`;
    const basicNames = ['loginMode', 'clientId', 'clientSecret', 'enterpriseId', 'redirectUri'];
    const adminNames = ['bootstrapAdminAccount', 'bootstrapAdminName', 'bootstrapAdminPhone', 'bootstrapAdminOpenId'];
    const advanced = loginFields.filter(([name]) => !basicNames.includes(name) && !adminNames.includes(name));
    $('#login-settings-fields').innerHTML = `<div class="login-config-section"><h3>1. 填写应用资料</h3><div class="card-fields">${basicNames.map(name => renderLoginField(loginFields.find(field => field[0] === name))).join('')}</div></div><details class="login-config-section login-admin-details" open><summary>2. 登记首位管理员</summary><p class="login-help">核验管理员的企业成员标识与手机号。登录身份由企业 eid 和 openid 唯一确定。</p><div class="card-fields">${adminNames.map(name => renderLoginField(loginFields.find(field => field[0] === name))).join('')}</div></details><section class="login-config-section" id="admin-enrollment-card"><h3>扫码获取首位管理员身份</h3><p class="login-help">点击准备扫码会先保存当前资料为未启用草稿。仅支持服务器本机操作；确认绑定后再启用登录。请填写完整的 11 位大陆手机号或带国家区号的号码。</p><button type="button" class="button secondary" id="enrollment-start">1. 准备扫码</button> <a id="enrollment-link" class="button secondary" target="_blank" rel="noopener noreferrer" hidden>打开云之家扫码页 ↗</a> <button type="button" class="button secondary" id="enrollment-status">2. 查看扫码结果</button><p id="enrollment-result" class="login-help" role="status"></p><button type="button" class="button primary" id="enrollment-confirm" hidden>3. 确认绑定此人为管理员</button></section><details class="login-config-section" id="login-advanced-settings"><summary>3. 高级设置 · 标准接口一般无需修改</summary><p class="login-help">标准轻应用已内置官方接口，一般无需更改。通用 OAuth 仅在公司另行提供该协议时使用。</p><div class="card-fields">${advanced.map(renderLoginField).join('')}</div><div id="login-config-issues" class="login-help"></div></details>`;
    form.elements.loginMode.value = data.settings.loginMode || 'qr';
    form.elements.tokenAuthMethod.value = data.settings.tokenAuthMethod || 'client_secret_post';
    form.elements.enabled.checked = Boolean(data.settings.enabled);
    form.elements.enabled.disabled = !data.implemented;
    $('#login-enable-label').textContent = data.implemented ? `下次启动时启用${loginProviderNames[provider]}登录` : '登录适配规划中，暂不能启用';
    $('#save-login-settings').textContent = data.implemented ? '保存配置' : '保存该平台草稿';
    $('#login-settings-status').textContent = data.implemented ? `${data.active ? '当前：云之家登录已启用' : '当前：云之家登录未启用'}${data.restartRequired ? ' · 保存的配置待重启生效' : ''}` : '该平台配置独立保存，实际登录尚未接入';
    $('#login-settings-result').textContent = !data.implemented ? '可保存通用应用资料；专有参数及授权流程将在适配该平台时补齐。' : data.issues.length ? '可以先保存草稿；启用前需完善必填资料和高级设置。' : '资料格式完整，下一步可联调企业登录。';
    $('#login-config-issues').textContent = data.issues.length ? `待完善：${data.issues.join('；')}` : '';
    const draft = loginDrafts.get(provider);
    if (draft) {
      for (const [key, value] of Object.entries(draft)) if (form.elements[key] && key !== 'enabled') form.elements[key].value = value;
      form.elements.enabled.checked = data.implemented && draft.enabled;
      $('#login-settings-result').textContent = '已恢复该平台尚未保存的填写内容，请点击保存。';
    }
    updateLoginModeUI();
    form.hidden = false;
  } catch (error) { $('#login-settings-status').textContent = error.message; }
}
function updateLoginModeUI() {
  const form = $('#login-settings-form');
  const ticket = ['qr', 'ticket'].includes(form.elements.loginMode.value);
  const qr = form.elements.loginMode.value === 'qr';
  const cloud = state.loginProvider === 'cloud-home';
  if (cloud) for (const [name, hint] of Object.entries(loginFieldHints)) {
    const fieldHint = form.querySelector(`[data-login-field="${name}"] .field-hint`);
    if (fieldHint) { fieldHint.hidden = false; fieldHint.textContent = hint; }
  }
  $('#check-cloud-home-credentials').hidden = !cloud || !ticket;
  $('#admin-enrollment-card').hidden = !cloud || !qr || Boolean(form.elements.bootstrapAdminOpenId.value);
  $('#qr-login-preparation').hidden = !cloud || !qr;
  $('#cloud-login-preparation').hidden = !cloud || form.elements.loginMode.value !== 'ticket';
  form.querySelector('[data-login-field="loginMode"]').hidden = !cloud;
  for (const name of ['enterpriseId', 'bootstrapAdminOpenId']) form.querySelector(`[data-login-field="${name}"]`).hidden = !cloud || !ticket;
  for (const name of ['authorizationUrl', 'scopes', 'tokenAuthMethod', 'subjectPath', 'phonePath', 'accountPath', 'namePath']) form.querySelector(`[data-login-field="${name}"]`).hidden = cloud && ticket;
  form.querySelector('[data-login-field="redirectUri"] .login-field-label').textContent = !cloud ? '应用访问 / 回调地址（草稿）' : qr ? '扫码完成后的回调地址' : ticket ? '轻应用访问地址' : 'OAuth 回调地址';
  form.querySelector('[data-login-field="bootstrapAdminAccount"] .login-field-label').textContent = cloud && ticket ? '管理器管理员账号' : '首位管理员的外部平台账号';
  if (!cloud) {
    for (const label of form.querySelectorAll('[data-login-field] .field-hint')) label.hidden = true;
    $('#login-advanced-settings .login-help').textContent = '当前仅保存通用接入资料，各平台专有字段与登录协议将在后续适配。';
    $('.login-admin-details .login-help', form).textContent = '管理员资料按平台独立保存，实际登录尚未开放。';
  } else if (qr) {
    form.querySelector('[data-login-field="redirectUri"] .field-hint').textContent = '公司管理器 HTTPS 域名 + /auth/cloud-home/entry。云之家扫码应用的移动端访问地址另填官方 qrlogin 地址，见上方说明。';
  } else if (!ticket) {
    form.querySelector('[data-login-field="redirectUri"] .field-hint').textContent = '由企业另行提供的 OAuth 授权服务登记回调地址，路径使用 /auth/callback。';
    form.querySelector('[data-login-field="bootstrapAdminAccount"] .field-hint').textContent = '与 OAuth 用户信息接口返回的账号值一致。';
  }
}
$('#check-cloud-home-credentials').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await request('/api/settings/login/check?provider=cloud-home', { method: 'POST', body: '{}' });
    $('#login-settings-result').textContent = result.message;
  } catch (error) { $('#login-settings-result').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#login-settings-form').addEventListener('change', event => {
  if (event.target.name !== 'loginMode') return;
  const form = event.currentTarget;
  if (['qr', 'ticket'].includes(event.target.value)) {
    form.elements.tokenUrl.value = 'https://www.yunzhijia.com/gateway/oauth2/token/getAccessToken';
    form.elements.userInfoUrl.value = 'https://www.yunzhijia.com/gateway/ticket/user/acquirecontext';
    try { const url = new URL(form.elements.redirectUri.value); url.pathname = '/auth/cloud-home/entry'; url.search = ''; url.hash = ''; form.elements.redirectUri.value = url.toString(); } catch {}
  }
  updateLoginModeUI();
});
$('#login-settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  values.enabled = form.elements.enabled.checked;
  const pendingAdmin = state.loginProvider === 'cloud-home' && values.loginMode === 'qr' && !values.bootstrapAdminOpenId.trim();
  if (pendingAdmin) { values.enabled = false; form.elements.enabled.checked = false; }
  const button = $('#save-login-settings');
  const provider = state.loginProvider;
  $('#settings-login-provider').disabled = true;
  button.disabled = true;
  try {
    const result = await request(`/api/settings/login?provider=${encodeURIComponent(provider)}`, { method: 'PUT', body: JSON.stringify(values) });
    loginDrafts.delete(provider);
    form.elements.clientSecret.value = '';
    form.elements.clientSecret.placeholder = values.clientSecret ? '已设置，留空保留' : form.elements.clientSecret.placeholder;
    $('#login-settings-result').textContent = `${result.message}。${result.issues.length ? '启用前请完善必填资料和高级设置。' : result.restartRequired ? '请安排重启后联调登录；当前会话不变。' : '其他平台配置保持独立。'}`;
    if (pendingAdmin) $('#login-settings-result').textContent = '资料已保存为未启用草稿。请先准备扫码并确认管理员身份，再启用登录。';
    toast('集成登录配置已保存');
  } catch (error) { $('#login-settings-result').textContent = error.message; $('#login-advanced-settings').open = true; }
  finally { button.disabled = false; $('#settings-login-provider').disabled = false; }
});
function applyPageAccess() {
  if (!state.auth?.enabled) return;
  const allowed = new Set(state.auth.pages || []);
  $$('.nav-item[data-page]').forEach(button => { button.hidden = button.dataset.page !== 'my-access' && !allowed.has(button.dataset.page); });
  const current = $('.page.active')?.id?.replace('page-', '') || 'overview';
  showPage(current === 'my-access' || allowed.has(current) ? current : (state.auth.pages[0] || 'my-access'));
}
let finishInputCard = null;
let releaseServiceDialog = null;
function mountFormDialog(content, cancel, wide = false) {
  const dialog = document.createElement('dialog');
  dialog.className = `editing-dialog${wide ? ' editing-dialog-wide' : ''}`;
  dialog.setAttribute('aria-label', content.getAttribute('aria-label') || $('h2', content)?.textContent || '编辑信息');
  dialog.append(content); document.body.append(dialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
  document.body.classList.add('form-dialog-open');
  dialog.showModal();
  return () => {
    dialog.close(); dialog.remove();
    if (!document.querySelector('.editing-dialog[open]')) document.body.classList.remove('form-dialog-open');
  };
}
function closeInputCard() { if (finishInputCard) finishInputCard(null); }
function inputCard({ title, description = '', fields, submitLabel = '保存', groups = [], onSubmit = null }) {
  closeInputCard();
  closeModal();
  const card = document.createElement('section');
  card.className = 'panel input-card';
  card.setAttribute('aria-label', title);
  card.innerHTML = `<div class="panel-heading"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div><button type="button" class="icon-button" data-card-cancel aria-label="关闭表单">×</button></div><form class="card-form"><div class="card-fields">${fields.map(field => `<label>${esc(field.label)}${field.type === 'select' ? `<select name="${esc(field.name)}" ${field.required ? 'required' : ''}>${field.options.map(option => `<option value="${esc(option.value)}" ${String(option.value) === String(field.value) ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>` : field.type === 'textarea' ? `<textarea name="${esc(field.name)}" rows="${field.rows || 4}" maxlength="${field.maxlength || 20000}" ${field.required ? 'required' : ''}>${esc(field.value || '')}</textarea>` : `<input name="${esc(field.name)}" type="${esc(field.type || 'text')}" value="${esc(field.value || '')}" maxlength="${field.maxlength || 120}" ${field.required ? 'required' : ''} ${field.type === 'tel' ? 'autocomplete="tel"' : ''}>`}</label>`).join('')}</div><div class="card-actions"><button type="button" class="button secondary" data-card-cancel>取消</button><button type="submit" class="button primary">${esc(submitLabel)}</button></div></form>`;
  const formElement = $('form', card);
  for (const group of groups) {
    const section = document.createElement('fieldset'); section.className = 'config-field-group';
    const legend = document.createElement('legend'); legend.textContent = group.title; section.append(legend);
    for (const name of group.fields) { const field = formElement.elements.namedItem(name); if (field) section.append(field.closest('label')); }
    $('.card-fields', card).append(section);
  }
  const errorText = document.createElement('p'); errorText.className = 'config-form-error'; errorText.setAttribute('role', 'alert');
  const authSelect = formElement.elements.namedItem('authMode');
  if (authSelect) {
    const updateCredentialFields = () => {
      for (const name of ['username', 'password', 'token']) {
        const field = formElement.elements.namedItem(name);
        if (field) field.closest('label').hidden = name === 'token' ? authSelect.value !== 'bearer' : authSelect.value !== 'basic';
      }
    };
    authSelect.addEventListener('change', updateCredentialFields); updateCredentialFields();
  }
  $('.card-actions', card).before(errorText);
  const release = mountFormDialog(card, closeInputCard, groups.length > 0);
  card.querySelector('input,select,textarea')?.focus({ preventScroll: true });
  return new Promise(resolve => {
    const finish = value => { release(); finishInputCard = null; resolve(value); };
    finishInputCard = finish;
    card.querySelectorAll('[data-card-cancel]').forEach(button => button.addEventListener('click', () => finish(null)));
    card.querySelector('form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      for (const field of form.querySelectorAll('[required]')) {
        field.setCustomValidity(field.value.trim() ? '' : '请填写此项');
        field.oninput = () => field.setCustomValidity('');
      }
      if (!form.reportValidity()) return;
      const values = Object.fromEntries(new FormData(form));
      const submit = $('button[type="submit"]', form);
      try {
        submit.disabled = true; errorText.textContent = '';
        if (onSubmit) await onSubmit(values);
        finish(values);
      } catch (error) { errorText.textContent = error.message; }
      finally { submit.disabled = false; }
    });
  });
}
function openModal() {
  closeInputCard();
  closeModal();
  $('#modal-backdrop').hidden = false;
  releaseServiceDialog = mountFormDialog($('#modal-backdrop'), closeModal);
  $('#service-form input[name="name"]').focus({ preventScroll: true });
}
function closeModal() {
  const backdrop = $('#modal-backdrop');
  backdrop.hidden = true; $('#service-form').reset();
  if (releaseServiceDialog) {
    document.body.append(backdrop);
    releaseServiceDialog(); releaseServiceDialog = null;
  }
}
async function editTools(id) {
  const service = state.data.services.find(x => x.id === id);
  if (!service) return;
  closeInputCard(); closeModal();
  const card = document.createElement('section');
  card.className = 'panel input-card tools-editor';
  card.setAttribute('aria-label', `${service.name} 工具清单`);
  card.innerHTML = `<div class="panel-heading"><div><h2>${esc(service.name)} · 工具清单</h2><p>逐项填写工具信息，选择风险等级。工具标识需与 MCP 实际提供的工具一致。</p></div><button type="button" class="icon-button" data-tools-close aria-label="关闭工具清单">×</button></div><form><div class="table-wrap"><table><thead><tr><th>工具标识</th><th>显示名称</th><th>风险等级</th><th>操作</th></tr></thead><tbody></tbody></table></div><div class="tools-editor-toolbar"><button type="button" class="small-button primary-small" data-tools-add>＋ 添加工具</button><small data-tools-count></small></div><p class="tools-editor-error" role="alert"></p><div class="card-actions"><button type="button" class="button secondary" data-tools-close>取消</button><button type="submit" class="button primary">保存工具清单</button></div></form>`;
  const body = $('tbody', card), originals = new WeakMap();
  const count = () => { $('[data-tools-count]', card).textContent = `共 ${body.rows.length} 个工具`; };
  const addRow = (tool = {}) => {
    const row = document.createElement('tr');
    originals.set(row, tool);
    row.innerHTML = `<td><input class="tool-name" aria-label="工具标识" placeholder="例如 query_readonly" required maxlength="80" pattern="[a-zA-Z0-9_.-]{1,80}" title="使用字母、数字、下划线、点或短横线"></td><td><input class="tool-label" aria-label="显示名称" placeholder="例如 只读查询" maxlength="120"></td><td><select class="tool-risk" aria-label="风险等级">${['未分类', '只读', '写入', '高风险'].map(risk => `<option value="${risk}">${risk}</option>`).join('')}</select></td><td><button type="button" class="small-button tools-remove" aria-label="移除此工具">移除</button></td>`;
    $('.tool-name', row).value = tool.name || '';
    $('.tool-label', row).value = tool.label || '';
    $('.tool-risk', row).value = ['只读', '写入', '高风险'].includes(tool.risk) ? tool.risk : '未分类';
    $('.tools-remove', row).addEventListener('click', () => { row.remove(); count(); });
    body.append(row); count(); return row;
  };
  (service.tools || []).forEach(addRow);
  const release = mountFormDialog(card, closeInputCard, true);
  const finish = () => { release(); finishInputCard = null; };
  finishInputCard = finish;
  $$('[data-tools-close]', card).forEach(button => button.addEventListener('click', finish));
  $('[data-tools-add]', card).addEventListener('click', () => $('.tool-name', addRow()).focus());
  card.addEventListener('input', () => { $$('.tool-name', card).forEach(input => input.setCustomValidity('')); $('.tools-editor-error', card).textContent = ''; });
  $('form', card).addEventListener('submit', async event => {
    event.preventDefault();
    const names = new Set();
    for (const row of body.rows) {
      const input = $('.tool-name', row), name = input.value.trim();
      input.value = name;
      input.setCustomValidity(names.has(name) ? '工具标识不能重复' : ''); names.add(name);
    }
    if (!event.currentTarget.reportValidity()) return;
    const tools = [...body.rows].map(row => ({ ...originals.get(row), name: $('.tool-name', row).value.trim(), label: $('.tool-label', row).value.trim() || $('.tool-name', row).value.trim(), risk: $('.tool-risk', row).value }));
    const submit = $('button[type="submit"]', card); submit.disabled = true;
    try { await request(`/api/services/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ tools }) }); finish(); await refresh(); toast('工具清单已保存'); }
    catch (error) { $('.tools-editor-error', card).textContent = error.message; submit.disabled = false; }
  });
  count();
}

document.addEventListener('click', async event => {
  if (event.target.closest('[data-employee-mcp]')) {
    const reviewers = state.myAccess?.submissionOptions?.reviewers || [];
    if (!reviewers.length) return toast('当前没有可用管理员审核人');
    const values = await inputCard({ title: '提交 MCP 上架申请', description: '提交已部署服务的 MCP 地址。审核通过后先登记为草稿，管理员同步工具并确认发布。本入口暂不安装或部署服务。', fields: [{ name: 'name', label: 'MCP 名称', required: true, maxlength: 80 }, { name: 'category', label: '类别', type: 'select', options: Object.keys(icons).map(name => ({ value: name, label: name })) }, { name: 'endpoint', label: '已部署服务的 HTTP / HTTPS 地址', required: true, maxlength: 500 }, { name: 'description', label: '用途说明', type: 'textarea', required: true, maxlength: 300 }, { name: 'reviewerAccount', label: '指定审核管理员', type: 'select', options: reviewers.map(user => ({ value: user.account, label: `${user.name}（${user.account}）` })) }], submitLabel: '提交审核', onSubmit: async values => { await request('/api/my/mcp-submissions', { method: 'POST', body: JSON.stringify(values) }); } });
    if (values) { await loadMyAccess(); toast('MCP 上架申请已提交'); }
    return;
  }
  if (event.target.closest('[data-employee-skill]')) {
    const options = state.myAccess?.submissionOptions;
    if (!options?.reviewers.length || !options.groups.length) return toast('请先由管理员配置用户组与审核人');
    closeInputCard(); closeModal();
    const form = $('#skill-upload-form'), originalParent = form.parentNode, nextSibling = form.nextSibling;
    const card = document.createElement('section'); card.className = 'panel input-card';
    card.innerHTML = '<div class="panel-heading"><div><h2>上传 Skill 版本</h2><p>上传 ZIP 包并指定审核人，申请人使用当前登录身份。</p></div><button type="button" class="icon-button" data-upload-close aria-label="关闭上传">×</button></div>';
    card.append(form);
    const cancelUpload = document.createElement('button'); cancelUpload.type = 'button'; cancelUpload.className = 'button secondary'; cancelUpload.textContent = '取消';
    $('.skill-form-actions', form).prepend(cancelUpload); cancelUpload.addEventListener('click', closeInputCard);
    const user = state.myAccess.user;
    $('#skill-requester-account').innerHTML = `<option value="${esc(user.account)}">${esc(user.name)}</option>`;
    $('#skill-requester-account').disabled = true;
    $('#skill-reviewer-account').innerHTML = options.reviewers.map(item => `<option value="${esc(item.account)}">${esc(item.name)}（${esc(item.account)}）</option>`).join('');
    $('#skill-target-groups').innerHTML = options.groups.map(group => `<label class="skill-group-option"><input type="checkbox" value="${esc(group.id)}">${esc(group.name)}</label>`).join('');
    const release = mountFormDialog(card, closeInputCard, true);
    state.employeeSkillMode = true;
    finishInputCard = () => { cancelUpload.remove(); originalParent.insertBefore(form, nextSibling); form.reset(); $('#skill-requester-account').disabled = false; release(); state.employeeSkillMode = false; finishInputCard = null; };
    $('[data-upload-close]', card).addEventListener('click', closeInputCard);
    return;
  }
  const skillAccess = event.target.closest('[data-skill-access]');
  if (skillAccess) {
    const values = await inputCard({ title: '申请 Skill 使用权限', description: `申请版本 ${skillAccess.dataset.version}。授权只适用于此版本，不会附带 MCP 工具权限。`, fields: [{ name: 'reason', label: '工作用途与申请原因', type: 'textarea', required: true, maxlength: 500 }], submitLabel: '提交申请', onSubmit: async values => { await request('/api/my/skill-access', { method: 'POST', body: JSON.stringify({ skillId: skillAccess.dataset.skillAccess, version: skillAccess.dataset.version, reason: values.reason }) }); } });
    if (values) { await loadMyAccess(); toast('Skill 使用申请已提交'); }
    return;
  }
  const personalButton = event.target.closest('[data-personal-credentials]');
  if (personalButton) {
    const id = personalButton.dataset.personalCredentials;
    try {
      const config = await request(`/api/my/service-credentials/${encodeURIComponent(id)}`);
      const fields = [];
      if (config.authMode === 'basic') fields.push({ name: 'username', label: '我的连接账号', value: config.username, maxlength: 200 }, { name: 'password', label: config.passwordConfigured ? '我的密码（已设置，留空保留）' : '我的连接密码', type: 'password', maxlength: 4096 });
      if (config.authMode === 'bearer') fields.push({ name: 'token', label: config.tokenConfigured ? '我的 Token（已设置，留空保留）' : '我的访问 Token', type: 'password', maxlength: 8192 });
      if (config.authMode !== 'none') fields.push({ name: 'clearCredentials', label: '已有个人凭据', type: 'select', value: config.needsRebind ? 'yes' : 'no', options: [{ value: 'no', label: '保留已有凭据' }, { value: 'yes', label: '清除旧凭据，可同时填写新凭据' }] });
      const values = await inputCard({ title: `${config.name} · 我的连接凭据`, description: config.authMode === 'none' ? '管理员将此服务设为无需认证，可直接点击“检查我的连接”。' : `凭据仅供你的账号使用，加密保存。${config.needsRebind ? '服务地址已变更，请清除旧凭据并重新绑定。' : '保存后可检查个人连接，绑定凭据不会增加工具权限。'}`, fields, submitLabel: config.authMode === 'none' ? '关闭' : '保存个人凭据', onSubmit: config.authMode === 'none' ? null : async values => { await request(`/api/my/service-credentials/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ ...values, clearCredentials: values.clearCredentials === 'yes' }) }); } });
      if (values) { await loadMyAccess(); if (config.authMode !== 'none') toast('个人凭据已保存'); }
    } catch (error) { toast(error.message); }
    return;
  }
  const personalCheck = event.target.closest('[data-personal-check]');
  if (personalCheck) {
    personalCheck.disabled = true; personalCheck.textContent = '检查中…';
    try { const result = await request(`/api/my/service-credentials/${encodeURIComponent(personalCheck.dataset.personalCheck)}/check`, { method: 'POST' }); toast(`个人连接正常，服务提供 ${result.toolCount} 项工具`); }
    catch (error) { toast(error.message); }
    finally { await loadMyAccess(); }
    return;
  }
  const groupFilter = event.target.closest('[data-group-filter]');
  if (groupFilter) { state.userGroupFilter = groupFilter.dataset.groupFilter; renderUsers(); return; }
  const addGroup = event.target.closest('[data-add-group]'), editGroup = event.target.closest('[data-edit-group]'), deleteGroup = event.target.closest('[data-delete-group]');
  if (addGroup || editGroup || deleteGroup) {
    const group = state.data.groups.find(item => item.id === (editGroup?.dataset.editGroup || deleteGroup?.dataset.deleteGroup));
    if (deleteGroup) {
      const members = state.data.users.filter(user => user.groupId === group.id);
      const targets = state.data.groups.filter(item => item.id !== group.id && item.id !== 'admins');
      if (members.length && !targets.length) return toast('请先新增一个普通用户组，用于接收当前成员');
      const values = await inputCard({ title: `删除用户组 · ${group.name}`, description: `将删除本组的页面和工具组授权。${members.length ? `${members.length} 名成员将迁移至所选用户组，并需要重新登录。` : '该组当前没有成员。'}`, fields: members.length ? [{ name: 'targetGroupId', label: '成员迁移至', type: 'select', required: true, options: targets.map(item => ({ value: item.id, label: item.name })) }] : [], submitLabel: '确认删除用户组' });
      if (!values) return;
      try { await request(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'DELETE', body: JSON.stringify(values) }); await refresh(); toast('用户组已删除'); } catch (error) { toast(error.message); }
    } else {
      const values = await inputCard({ title: group ? '编辑用户组' : '新增用户组', description: '新用户组默认没有管理页面与工具授权，可在权限策略中配置。', fields: [{ name: 'name', label: '用户组名称', required: true, maxlength: 40, value: group?.name || '' }] });
      if (!values) return;
      try { await request(group ? `/api/groups/${encodeURIComponent(group.id)}` : '/api/groups', { method: group ? 'PATCH' : 'POST', body: JSON.stringify(values) }); await refresh(); toast('用户组已保存'); } catch (error) { toast(error.message); }
    }
    return;
  }
  const nav = event.target.closest('[data-page]'); if (nav) return showPage(nav.dataset.page);
  const jump = event.target.closest('[data-nav]'); if (jump) return showPage(jump.dataset.nav);
  if (event.target.closest('[data-action="add-service"]')) { $('#modal-title').textContent = '添加 MCP 服务'; $('#service-form').hidden = false; openModal(); }
  if (event.target.closest('.notice-close')) event.target.closest('.notice').remove();
  if (event.target.closest('.modal-close') || event.target.closest('.modal-cancel')) closeModal();
  const toggle = event.target.closest('[data-toggle-service]');
  if (toggle) {
    try { await request(`/api/services/${encodeURIComponent(toggle.dataset.toggleService)}`, { method: 'PATCH', body: JSON.stringify({ status: toggle.dataset.status }) }); await refresh(); toast('服务状态已更新'); }
    catch (e) { toast(e.message); }
  }
  const configButton = event.target.closest('[data-service-config]');
  if (configButton) {
    const id = configButton.dataset.serviceConfig;
    try {
      const config = await request(`/api/service-config/${encodeURIComponent(id)}`);
      const values = await inputCard({ title: `${config.name} · MCP 配置`, description: '认证凭据仅绑定当前登录账号，加密保存。密钥留空保留已有值。修改地址会撤下市场发布并清除旧工具授权，需要重新同步。服务参数仅保存，尚不会自动修改远程 MCP。', fields: [
        { name: 'name', label: '服务名称', value: config.name, required: true, maxlength: 80 },
        { name: 'endpoint', label: 'MCP 连接地址（HTTP / HTTPS）', value: config.endpoint, required: true, maxlength: 500 },
        { name: 'description', label: '服务说明', type: 'textarea', value: config.description, rows: 2, maxlength: 500 },
        { name: 'authMode', label: '连接认证方式', type: 'select', value: config.authMode, options: [{ value: 'none', label: '无需认证' }, { value: 'basic', label: '个人账号密码（Basic）' }, { value: 'bearer', label: '个人访问 Token（Bearer）' }] },
        { name: 'username', label: '我的连接账号（Basic 使用）', value: config.username, maxlength: 200 },
        { name: 'password', label: config.passwordConfigured ? '我的连接密码（已设置，留空保留）' : '我的连接密码（Basic 使用）', type: 'password', maxlength: 4096 },
        { name: 'token', label: config.tokenConfigured ? '我的 Token（已设置，留空保留）' : '我的 Token（Bearer 使用）', type: 'password', maxlength: 8192 },
        { name: 'clearCredentials', label: '已有个人凭据', type: 'select', value: 'no', options: [{ value: 'no', label: '保留已有凭据' }, { value: 'yes', label: '清除旧凭据（本次填写的新值仍会保存）' }] },
        { name: 'databaseHost', label: '数据库主机 / IP（可选）', value: config.parameters?.host || '', maxlength: 255 },
        { name: 'databasePort', label: '数据库端口（可选，SQL Server 通常为 1433）', value: config.parameters?.port || '', maxlength: 5 },
        { name: 'databaseName', label: '数据库名称（可选）', value: config.parameters?.database || '', maxlength: 128 },
        { name: 'parameters', label: '服务参数（JSON 对象，可保存数据库主机、端口、库名等）', type: 'textarea', value: JSON.stringify(config.parameters || {}, null, 2), rows: 4, maxlength: 20000 }
      ], groups: [{ title: '基础信息', fields: ['name', 'endpoint', 'description'] }, { title: '连接认证 · 我的凭据', fields: ['authMode', 'username', 'password', 'token', 'clearCredentials'] }, { title: '数据库参数 · 保存供部署使用', fields: ['databaseHost', 'databasePort', 'databaseName'] }, { title: '高级参数', fields: ['parameters'] }], onSubmit: async values => {
      let parameters;
      try { parameters = JSON.parse(values.parameters); } catch { throw new Error('服务参数 JSON 格式不正确'); }
      if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) (()=>{throw new Error('服务参数必须为 JSON 对象')})();
      if (values.databasePort && (!/^\d+$/.test(values.databasePort) || Number(values.databasePort) < 1 || Number(values.databasePort) > 65535)) (()=>{throw new Error('数据库端口需为 1 至 65535')})();
      if (values.databaseHost.trim()) parameters.host = values.databaseHost.trim(); else delete parameters.host;
      if (values.databasePort.trim()) parameters.port = Number(values.databasePort); else delete parameters.port;
      if (values.databaseName.trim()) parameters.database = values.databaseName.trim(); else delete parameters.database;
      await request(`/api/service-config/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ ...values, clearCredentials: values.clearCredentials === 'yes', parameters }) });
      }, submitLabel: '保存配置' });
      if (!values) return;
      await refresh(); toast('MCP 配置已保存，可点击连接并同步');
    } catch (error) { toast(error.message); }
    return;
  }
  const edit = event.target.closest('[data-edit-tools]'); if (edit) editTools(edit.dataset.editTools);
  const marketPublish = event.target.closest('[data-market-publish]');
  if (marketPublish) {
    const service = state.data.services.find(item => item.id === marketPublish.dataset.marketPublish);
    if (!service) return;
    const currentlyPublished = service.marketplaceStatus === 'published';
    const values = await inputCard({ title: currentlyPublished ? `市场设置 · ${service.name}` : `发布到 MCP 市场 · ${service.name}`, description: '全员可见的服务会出现在所有员工的自助工作台；受限服务只显示申请入口，员工经管理员批准后才能查看详情。下载项为服务器托管 MCP 的连接说明。', fields: [{ name: 'marketplaceStatus', label: '市场状态', type: 'select', value: 'published', options: [{ value: 'published', label: '已发布' }, { value: 'unpublished', label: '从市场撤下' }] }, { name: 'marketplaceVisibility', label: '员工可见范围', type: 'select', value: service.marketplaceVisibility || 'all', options: [{ value: 'all', label: '全员可见' }, { value: 'restricted', label: '受限：申请获批后可见' }] }], submitLabel: currentlyPublished ? '保存市场设置' : '发布到市场' });
    if (!values) return;
    try {
      await request(`/api/marketplace/${encodeURIComponent(service.id)}`, { method: 'PATCH', body: JSON.stringify({ marketplaceStatus: values.marketplaceStatus, marketplaceVisibility: values.marketplaceVisibility }) });
      await refresh(); toast(values.marketplaceStatus === 'published' ? 'MCP 市场设置已保存' : 'MCP 已从员工市场撤下');
    } catch (error) { toast(error.message); }
    return;
  }
  const accessRequestButton = event.target.closest('[data-access-request]');
  if (accessRequestButton) {
    const service = state.myAccess?.services.find(item => item.id === accessRequestButton.dataset.accessRequest);
    const toolName = accessRequestButton.dataset.accessTool;
    const tool = service?.tools?.find(item => item.name === toolName);
    const itemLabel = toolName === '*' ? '查看受限 MCP 服务' : `${service?.name || 'MCP'} / ${tool?.label || toolName}`;
    const values = await inputCard({ title: '申请 MCP 权限', description: `申请内容：${itemLabel}。管理员审核通过后会自动更新你的工作台权限。`, fields: [{ name: 'reason', label: '申请原因与工作用途', type: 'textarea', required: true, maxlength: 500, rows: 4 }], submitLabel: '提交申请' });
    if (!values) return;
    try { await request('/api/access-requests', { method: 'POST', body: JSON.stringify({ serviceId: accessRequestButton.dataset.accessRequest, toolName, reason: values.reason }) }); await loadMyAccess(); toast('申请已提交，等待管理员审核'); }
    catch (error) { toast(error.message); }
    return;
  }
  const accessReviewButton = event.target.closest('[data-access-review]');
  if (accessReviewButton) {
    const decision = accessReviewButton.dataset.decision;
    const values = await inputCard({ title: decision === 'approved' ? '批准员工权限申请' : '驳回员工权限申请', description: decision === 'approved' ? '批准后将立即为申请人增加对应个人访问权限。' : '请填写驳回原因，员工可在自己的工作台查看。', fields: [{ name: 'comment', label: decision === 'approved' ? '审核意见（可选）' : '驳回原因', type: 'textarea', required: decision === 'rejected', maxlength: 500, rows: 3 }], submitLabel: decision === 'approved' ? '批准申请' : '确认驳回' });
    if (!values) return;
    try { await request(`/api/access-requests/${encodeURIComponent(accessReviewButton.dataset.accessReview)}/review`, { method: 'POST', body: JSON.stringify({ decision, comment: values.comment }) }); await loadAccessRequests(); toast(decision === 'approved' ? '已批准访问权限' : '已驳回申请'); }
    catch (error) { toast(error.message); }
    return;
  }
  const sync = event.target.closest('[data-sync-tools]');
  if (sync) {
    const oldLabel = sync.textContent; sync.disabled = true; sync.textContent = '连接中…';
    try {
      const result = await request(`/api/services/${encodeURIComponent(sync.dataset.syncTools)}/discover`, { method: 'POST' });
      await refresh(); toast(`已同步 ${result.tools.length} 个工具；请检查风险分类并配置权限`);
    } catch (e) { sync.disabled = false; sync.textContent = oldLabel; toast(e.message); }
  }
  const bindIdentity = event.target.closest('[data-bind-cloud-home]');
  if (bindIdentity) {
    const user = state.data.users.find(item => item.id === bindIdentity.dataset.bindCloudHome);
    if (!user) return;
    if (!user.phone) return toast('请先登记员工手机号');
    const values = await inputCard({ title: `绑定 ${user.name} 的云之家身份`, description: `请核验该成员对应员工手机号 ${user.phone}。身份字段由企业管理员提供，不会按姓名自动匹配。`, fields: [{ name: 'enterpriseId', label: '企业团队 ID（eid）', required: true }, { name: 'openId', label: '该企业员工的 openid', required: true }], submitLabel: '确认预绑定' });
    if (!values) return;
    try { await request(`/api/users/${encodeURIComponent(user.id)}/cloud-home-identity`, { method: 'PATCH', body: JSON.stringify(values) }); await refresh(); toast('企业成员身份已预绑定'); }
    catch (error) { toast(error.message); }
    return;
  }
  const bindPhone = event.target.closest('[data-bind-phone]');
  if (bindPhone) {
    const user = state.data.users.find(item => item.id === bindPhone.dataset.bindPhone);
    if (!user) return;
    const result = await inputCard({ title: `登记 ${user.name} 的手机号`, description: '登记由企业管理员核验的员工手机号；云之家成员身份需单独预绑定。', fields: [{ name: 'phone', label: '员工手机号', type: 'tel', required: true, value: user.phone || '', maxlength: 24 }] });
    if (!result) return;
    const phone = result.phone;
    try { await request(`/api/users/${encodeURIComponent(user.id)}/phone`, { method: 'PATCH', body: JSON.stringify({ phone }) }); await refresh(); showPage('users'); toast('手机号已登记'); }
    catch (error) { toast(error.message); }
  }
  const review = event.target.closest('[data-review-submission]');
  if (review) {
    const decision = review.dataset.decision;
    const result = await inputCard({ title: decision === 'rejected' ? '驳回 MCP 发布申请' : '通过 MCP 发布申请', description: (state.data.submissions || []).find(item => item.id === review.dataset.reviewSubmission)?.name || '', fields: [{ name: 'comment', label: decision === 'rejected' ? '驳回原因' : '审核意见（可选）', type: 'textarea', required: decision === 'rejected', maxlength: 1000 }], submitLabel: decision === 'rejected' ? '确认驳回' : '确认通过' });
    if (!result) return;
    const comment = result.comment;
    try {
      await request(`/api/submissions/${encodeURIComponent(review.dataset.reviewSubmission)}/review`, {
        method: 'POST', body: JSON.stringify({ decision, reviewerAccount: $('#reviewer-account').value, comment })
      });
      await refresh(); toast(decision === 'approved' ? '审核通过，服务已登记为草稿' : '申请已驳回');
    } catch (e) { toast(e.message); }
  }
  const skillReview = event.target.closest('[data-skill-review]');
  if (skillReview) {
    const decision = skillReview.dataset.decision;
    const result = await inputCard({ title: decision === 'rejected' ? '驳回 Skill 版本' : '发布 Skill 版本', fields: [{ name: 'comment', label: decision === 'rejected' ? '驳回原因' : '审核意见（可选）', type: 'textarea', required: decision === 'rejected', maxlength: 1000 }], submitLabel: decision === 'rejected' ? '确认驳回' : '确认发布' });
    if (!result) return;
    const comment = result.comment;
    try {
      await request(`/api/skills/submissions/${encodeURIComponent(skillReview.dataset.skillReview)}/review`, {
        method: 'POST', body: JSON.stringify({ decision, reviewerAccount: $('#skill-reviewer-picker').value, comment })
      });
      await refresh(); toast(decision === 'approved' ? 'Skill 版本已审核并发布' : 'Skill 申请已驳回');
    } catch (e) { toast(e.message); }
  }
  if (event.target.closest('[data-copy-mcp]')) {
    try { await navigator.clipboard.writeText(`${location.origin}/mcp`); toast('MCP 地址已复制'); }
    catch { toast('复制失败，请手动复制页面显示的地址'); }
  }
  const filter = event.target.closest('[data-service-filter]');
  if (filter) { state.serviceFilter = filter.dataset.serviceFilter; $$('.filter-pill').forEach(x => x.classList.toggle('active', x === filter)); renderServices(); }
});
$('#service-form').addEventListener('submit', async event => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
  try { await request('/api/services', { method: 'POST', body: JSON.stringify(values) }); await refresh(); closeModal(); toast('MCP 服务已登记'); showPage('services'); }
  catch (e) { toast(e.message); }
});
$('#skill-upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const employeeSubmit = Boolean(state.employeeSkillMode);
  if (employeeSubmit) values.requesterAccount = state.myAccess.user.account;
  const file = values.archive;
  const targetGroupIds = $$('#skill-target-groups input:checked').map(input => input.value);
  if (!targetGroupIds.length) return toast('至少选择一个适用用户组');
  if (!(file instanceof File) || !file.size) return toast('请选择 Skill ZIP 文件');
  if (file.size > 8 * 1024 * 1024) return toast('Skill ZIP 不能超过 8 MB');
  let binary = '';
  const bytes = new Uint8Array(await file.arrayBuffer());
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const archiveBase64 = btoa(binary);
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true; submit.textContent = '检查并提交中…';
  try {
    const result = await request(employeeSubmit ? '/api/my/skill-submissions' : '/api/skills/submissions', {
      method: 'POST', body: JSON.stringify({
        name: values.name, skillSlug: values.skillSlug, version: values.version,
        description: values.description, requesterAccount: values.requesterAccount,
        reviewerAccount: values.reviewerAccount, targetGroupIds, archiveBase64
      })
    });
    form.reset();
    if (employeeSubmit && state.employeeSkillMode) closeInputCard();
    await refresh();
    showPage(employeeSubmit ? 'my-access' : 'skills');
    toast(`已提交审核：${result.slug} v${result.version}，${result.files} 个文件`);
  } catch (e) { toast(e.message); }
  finally { submit.disabled = false; submit.textContent = '提交审核'; }
});
$('#permission-group').addEventListener('change', () => { renderPermissions(); renderPagePermissions(); });
$('#permission-service').addEventListener('change', renderPermissions);
$('#permission-list').addEventListener('change', async event => {
  const select = event.target.closest('[data-grant-tool]'); if (!select) return;
  try { await request('/api/grants', { method: 'POST', body: JSON.stringify({ groupId: $('#permission-group').value, serviceId: $('#permission-service').value, toolName: select.dataset.grantTool, mode: select.value }) }); await refresh(); toast('权限策略已保存'); }
  catch (e) { toast(e.message); await refresh(); }
});
$('#page-permission-list').addEventListener('change', async event => {
  const select = event.target.closest('[data-page-grant]'); if (!select) return;
  try {
    await request('/api/page-grants', { method: 'POST', body: JSON.stringify({ groupId: $('#permission-group').value, pageId: select.dataset.pageGrant, mode: select.value }) });
    await refresh(); toast('页面访问权限已保存');
  } catch (e) { toast(e.message); await refresh(); }
});
$('#reviewer-account').addEventListener('change', renderPublications);
$('#skill-reviewer-picker').addEventListener('change', renderSkills);
$('#service-search').addEventListener('input', e => { state.serviceQuery = e.target.value; renderServices(); });
$('#user-search').addEventListener('input', e => { state.userQuery = e.target.value.toLowerCase(); renderUsers(); });
$('#audit-search').addEventListener('input', e => { state.auditQuery = e.target.value.toLowerCase(); renderAudit(); });
$('#log-level').addEventListener('change', e => { state.logLevel = e.target.value; refreshBackendLogs(); });
$('#log-search').addEventListener('input', e => { state.logQuery = e.target.value.trim(); clearTimeout(state.logSearchTimer); state.logSearchTimer = setTimeout(refreshBackendLogs, 250); });
$('#refresh-logs').addEventListener('click', refreshBackendLogs);
$('#refresh-my-access').addEventListener('click', loadMyAccess);
$('#refresh-access-requests').addEventListener('click', loadAccessRequests);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeInputCard(); closeModal(); } });
document.querySelector('[data-action="add-user"]').addEventListener('click', async () => {
  const values = await inputCard({ title: '添加员工账号', description: '登记员工信息并分配用户组；随后绑定云之家企业 eid 与成员 openid。', fields: [
    { name: 'name', label: '员工姓名', required: true, maxlength: 80 },
    { name: 'account', label: '管理器账号', required: true },
    { name: 'phone', label: '员工手机号', type: 'tel', required: true, maxlength: 24 },
    { name: 'groupId', label: '所属用户组', type: 'select', required: true, value: state.data.groups.at(-1)?.id, options: state.data.groups.map(group => ({ value: group.id, label: group.name })) }
  ], submitLabel: '添加员工' });
  if (!values) return;
  try { await request('/api/users', { method: 'POST', body: JSON.stringify(values) }); await refresh(); toast('员工账号已添加'); }
  catch (e) { toast(e.message); }
});

refresh().catch(error => { $('#boot-screen').hidden = false; $('#boot-screen').textContent = `无法连接管理器：${error.message}`; });

// The verified identity stays on the server; confirmation never accepts a browser-supplied openid.
$('#login-settings-form').addEventListener('click', async event => {
  const action = { 'enrollment-start': 'start', 'enrollment-status': 'status', 'enrollment-confirm': 'confirm' }[event.target.id];
  if (!action) return;
  const button = event.target;
  button.disabled = true;
  const output = $('#enrollment-result');
  try {
    if (action === 'start') {
      const form = $('#login-settings-form');
      const values = Object.fromEntries(new FormData(form));
      if (values.loginMode !== 'qr') throw new Error('请选择网站扫码登录。');
      if (!values.bootstrapAdminAccount.trim()) { form.elements.bootstrapAdminAccount.focus(); throw new Error('请填写管理器管理员账号。'); }
      if (!values.bootstrapAdminName.trim()) { form.elements.bootstrapAdminName.focus(); throw new Error('请填写管理员姓名。'); }
      const phone = values.bootstrapAdminPhone.replace(/[\s()-]/g, '');
      if (!/^1\d{10}$/.test(phone) && !/^\+[1-9]\d{7,14}$/.test(phone)) { form.elements.bootstrapAdminPhone.focus(); throw new Error('管理员手机号不完整：大陆手机号需 11 位；国际号码请带 +国家区号。'); }
      // This setup callback is local; retain the configured host for subsequent normal login.
      const redirect = new URL(values.redirectUri || location.origin);
      redirect.pathname = '/auth/cloud-home/entry';
      redirect.search = ''; redirect.hash = '';
      values.redirectUri = redirect.href;
      form.elements.redirectUri.value = values.redirectUri;
      values.enabled = false;
      await request('/api/settings/login?provider=cloud-home', { method: 'PUT', body: JSON.stringify(values) });
      form.elements.enabled.checked = false;
      form.elements.clientSecret.value = '';
      form.elements.clientSecret.placeholder = '已保存，留空保留';
      loginDrafts.delete('cloud-home');
      $('#login-settings-result').textContent = '当前资料已保存为未启用草稿，回调路径已设置为 /auth/cloud-home/entry。确认管理员后再启用。';
    }
    const result = await request(`/api/settings/login/enrollment?action=${action}`, { method: 'POST', body: '{}' });
    if (action === 'start') {
      $('#enrollment-link').href = result.url;
      $('#enrollment-link').hidden = false;
      $('#enrollment-confirm').hidden = true;
      output.textContent = '请打开扫码页，使用管理员本人的云之家 App 扫码，然后回到此页查看结果。有效期 5 分钟。';
    } else if (action === 'status') {
      $('#enrollment-confirm').hidden = !result.identity;
      output.textContent = result.identity
        ? `云之家姓名：${result.identity.name || result.identity.account}；企业：${result.identity.enterpriseId}；成员标识：${result.identity.subject}。将绑定管理器账号：${result.account}，登记手机号：${result.phone}。请核对确为管理员本人。`
        : '尚未收到扫码结果，请完成云之家扫码后再查看。';
    } else {
      loginDrafts.delete('cloud-home');
      await loadLoginSettings('cloud-home');
      $('#login-settings-result').textContent = result.message;
    }
  } catch (error) { output.textContent = error.message; }
  finally { button.disabled = false; }
});

async function loadGatewayTokens() {
  try {
    const data = await request('/api/my/gateway-tokens');
    $('#gateway-tokens').innerHTML = data.tokens.map(t => `<tr><td>${esc(t.label)}</td><td>${fmtTime(t.expiresAt)}</td><td>${t.revoked ? '已撤销' : t.expiresAt <= Date.now() ? '已到期' : '有效'}</td><td>${!t.revoked ? `<button class="button secondary" data-revoke-gateway="${esc(t.id)}">撤销</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4">尚未创建连接令牌</td></tr>';
  } catch { $('#gateway-tokens').innerHTML = '<tr><td colspan="4">请先使用企业账号登录后管理个人令牌。</td></tr>'; }
}
$('#gateway-create').addEventListener('click', async () => {
  const services = (state.myAccess?.services || []).filter(s => s.visible && s.status === 'active');
  if (!services.length) return toast('没有可连接的已启用服务');
  await inputCard({ title: '创建个人 MCP 连接', description: '令牌只显示一次，请保存在 AI 工具的凭据设置中。令牌不会增加工具权限。', fields: [{ name: 'serviceId', label: 'MCP 服务', type: 'select', options: services.map(s => ({ value: s.id, label: s.name })) }, { name: 'label', label: '客户端名称', required: true, value: '我的 AI 工具' }], submitLabel: '创建', onSubmit: async values => {
    const data = await request('/api/my/gateway-tokens', { method: 'POST', body: JSON.stringify(values) });
    const box = $('#gateway-token-result');
    box.innerHTML = `<p>复制后关闭此卡片，令牌不会再次显示。正式使用请将地址换成公司的 HTTPS 域名。</p><label>服务器地址<input readonly value="${esc(location.origin + data.path)}"></label><label>Bearer 令牌<input readonly autocomplete="off" value="${esc(data.token)}"></label><button class="button secondary" id="gateway-hide">已保存，隐藏令牌</button>`;
    $('#gateway-hide').onclick = () => { box.replaceChildren(); };
    await loadGatewayTokens();
  } });
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-revoke-gateway]');
  if (!button) return;
  try { await request('/api/my/gateway-tokens', { method: 'DELETE', body: JSON.stringify({ id: button.dataset.revokeGateway }) }); $('#gateway-token-result').replaceChildren(); await loadGatewayTokens(); toast('令牌已撤销'); } catch (error) { toast(error.message); }
});
