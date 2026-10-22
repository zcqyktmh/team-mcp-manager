const state = { data: null, serviceFilter: 'all', serviceQuery: '', userQuery: '', auditQuery: '' };
const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icons = { '数据库': '▤', '业务系统': '◈', '文件与存储': '▧', '基础设施': '⌘', '开发工具': '⌘', '其他': '◇' };
const labels = { draft: '草稿', active: '已启用', paused: '已暂停', allow: '允许', approval: '需审批', deny: '拒绝' };
const submissionLabels = { pending: '待审核', approved: '已通过', rejected: '已驳回' };
const fmtTime = value => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}
async function refresh() { state.data = await request('/api/state'); render(); }
function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('visible');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('visible'), 2600);
}
function serviceMarkup(service, compact = false) {
  const status = service.status || 'draft';
  const tools = service.tools || [];
  if (compact) return `<div class="overview-service"><div class="service-symbol">${esc(icons[service.category] || '◇')}</div><div class="service-meta"><strong>${esc(service.name)}</strong><small>${esc(service.category)} · ${tools.length} 个工具${service.endpoint && service.endpoint !== '未登记' && service.endpoint !== '待配置公司服务器地址' ? ` · ${esc(service.endpoint)}` : ''}</small></div><div class="service-state"><i class="state-dot ${esc(status)}"></i>${esc(labels[status] || status)}</div></div>`;
  return `<article class="service-card"><div class="service-card-top"><div class="service-symbol">${esc(icons[service.category] || '◇')}</div><div class="service-card-heading"><h3>${esc(service.name)}</h3><p>${esc(service.category)} · ${esc(service.transport || 'Streamable HTTP')}</p></div><span class="status-tag ${esc(status)}">${esc(labels[status] || status)}</span></div><p class="service-description">${esc(service.description || '尚未填写服务说明。')}</p><div class="service-details"><div class="detail-line"><span>服务地址</span><span title="${esc(service.endpoint)}">${esc(service.endpoint)}</span></div><div class="detail-line"><span>工具数量</span><span>${tools.length} 个${tools.length ? '已登记' : '待同步'}</span></div>${service.toolSyncAt ? `<div class="detail-line"><span>上次同步</span><span>${fmtTime(service.toolSyncAt)}</span></div>` : ''}</div><div class="tools-chips">${tools.length ? tools.map(t => `<span class="tool-chip">${esc(t.label || t.name)}</span>`).join('') : '<span class="tool-chip">连接服务以同步工具清单</span>'}</div><div class="service-card-actions"><button class="small-button primary-small" data-sync-tools="${esc(service.id)}">连接并同步</button><button class="small-button" data-edit-tools="${esc(service.id)}">工具清单</button>${status === 'active' ? `<button class="small-button" data-toggle-service="${esc(service.id)}" data-status="paused">暂停</button>` : `<button class="small-button" data-toggle-service="${esc(service.id)}" data-status="active">${status === 'paused' ? '重新启用' : '启用'}</button>`}</div></article>`;
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
function renderServices() {
  const q = state.serviceQuery.toLowerCase();
  const services = state.data.services.filter(s => (state.serviceFilter === 'all' || s.status === state.serviceFilter) && `${s.name} ${s.category} ${s.description}`.toLowerCase().includes(q));
  $('#service-grid').innerHTML = services.length ? services.map(s => serviceMarkup(s)).join('') : '<div class="empty-state">没有匹配的 MCP 服务。添加服务后会显示在这里。</div>';
}
function renderPermissionSelectors() {
  const group = $('#permission-group'), service = $('#permission-service');
  const oldGroup = group.value, oldService = service.value;
  group.innerHTML = state.data.groups.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  service.innerHTML = state.data.services.map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  if ([...group.options].some(x => x.value === oldGroup)) group.value = oldGroup;
  if ([...service.options].some(x => x.value === oldService)) service.value = oldService;
  renderPermissions();
}
function renderPermissions() {
  const groupId = $('#permission-group').value, serviceId = $('#permission-service').value;
  const group = state.data.groups.find(x => x.id === groupId), service = state.data.services.find(x => x.id === serviceId);
  $('#permission-title').textContent = `${group?.name || ''} · ${service?.name || ''} 工具权限`;
  const tools = service?.tools || [];
  $('#permission-list').innerHTML = tools.length ? tools.map(tool => {
    const grant = state.data.grants.find(x => x.groupId === groupId && x.serviceId === serviceId && x.toolName === tool.name);
    const mode = grant?.mode || 'deny';
    return `<div class="permission-row"><div class="permission-tool"><strong>${esc(tool.label || tool.name)}</strong><small>${esc(tool.name)}</small></div><span class="risk-tag ${tool.risk === '高风险' ? 'high' : tool.risk === '写入' ? 'write' : ''}">${esc(tool.risk || '未分类')}</span><select data-grant-tool="${esc(tool.name)}" aria-label="${esc(tool.label || tool.name)} 权限"><option value="allow" ${mode === 'allow' ? 'selected' : ''}>允许</option><option value="approval" ${mode === 'approval' ? 'selected' : ''}>需审批</option><option value="deny" ${mode === 'deny' ? 'selected' : ''}>拒绝</option></select></div>`;
  }).join('') : '<div class="permission-empty">该服务还没有工具定义。服务端网关接入后可同步真实工具。</div>';
}
function renderUsers() {
  const q = state.userQuery.toLowerCase();
  $('#group-list').innerHTML = state.data.groups.map(g => `<div class="group-item"><div class="group-icon">♙</div><span class="group-name">${esc(g.name)}</span><span class="group-count">${g.members || 0} 人</span></div>`).join('');
  $('#users-table').innerHTML = state.data.users.filter(u => `${u.name} ${u.account}`.toLowerCase().includes(q)).map(u => {
    const group = state.data.groups.find(g => g.id === u.groupId);
    return `<tr><td><div class="user-cell"><span class="mini-avatar">${esc(u.name.slice(0, 1))}</span><strong>${esc(u.name)}</strong></div></td><td>${esc(u.account)}</td><td><span class="group-badge">${esc(group?.name || '未分组')}</span></td><td>${esc(u.source || '本地演示')}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="permission-empty">没有匹配的用户</td></tr>';
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
function render() { renderOverview(); renderServices(); renderPermissionSelectors(); renderUsers(); renderAudit(); renderPublications(); }
function showPage(name) {
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  $('#crumb-current').textContent = ({ overview: '总览', services: 'MCP 服务', publications: '发布审批', permissions: '权限策略', users: '用户与用户组', audit: '操作审计' })[name] || name;
}
function openModal() { $('#modal-backdrop').hidden = false; $('input[name="name"]').focus(); }
function closeModal() { $('#modal-backdrop').hidden = true; $('#service-form').reset(); }
async function editTools(id) {
  const service = state.data.services.find(x => x.id === id);
  const current = (service.tools || []).map(t => `${t.name}|${t.label}|${t.risk}`).join('\n');
  const value = prompt('每行填写一个工具：工具名|显示名称|风险（只读/写入/高风险）\n例如 query_readonly|只读查询|只读', current);
  if (value === null) return;
  const tools = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [name, label, risk] = line.split('|').map(x => x.trim());
    return { name, label: label || name, risk: ['只读', '写入', '高风险'].includes(risk) ? risk : '未分类' };
  }).filter(t => /^[a-zA-Z0-9_.-]{1,80}$/.test(t.name));
  try { await request(`/api/services/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ tools }) }); await refresh(); toast('工具清单已保存'); }
  catch (e) { toast(e.message); }
}

document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-page]'); if (nav) return showPage(nav.dataset.page);
  const jump = event.target.closest('[data-nav]'); if (jump) return showPage(jump.dataset.nav);
  if (event.target.closest('[data-action="add-service"]')) { $('#modal-title').textContent = '添加 MCP 服务'; $('#service-form').hidden = false; openModal(); }
  if (event.target.closest('.notice-close')) event.target.closest('.notice').remove();
  if (event.target.closest('.modal-close') || event.target.closest('.modal-cancel') || event.target === $('#modal-backdrop')) closeModal();
  const toggle = event.target.closest('[data-toggle-service]');
  if (toggle) {
    try { await request(`/api/services/${encodeURIComponent(toggle.dataset.toggleService)}`, { method: 'PATCH', body: JSON.stringify({ status: toggle.dataset.status }) }); await refresh(); toast('服务状态已更新'); }
    catch (e) { toast(e.message); }
  }
  const edit = event.target.closest('[data-edit-tools]'); if (edit) editTools(edit.dataset.editTools);
  const sync = event.target.closest('[data-sync-tools]');
  if (sync) {
    const oldLabel = sync.textContent; sync.disabled = true; sync.textContent = '连接中…';
    try {
      const result = await request(`/api/services/${encodeURIComponent(sync.dataset.syncTools)}/discover`, { method: 'POST' });
      await refresh(); toast(`已同步 ${result.tools.length} 个工具；请检查风险分类并配置权限`);
    } catch (e) { sync.disabled = false; sync.textContent = oldLabel; toast(e.message); }
  }
  const review = event.target.closest('[data-review-submission]');
  if (review) {
    const decision = review.dataset.decision;
    const comment = prompt(decision === 'rejected' ? '请填写驳回原因' : '审核意见（可留空）');
    if (comment === null || (decision === 'rejected' && !comment.trim())) return;
    try {
      await request(`/api/submissions/${encodeURIComponent(review.dataset.reviewSubmission)}/review`, {
        method: 'POST', body: JSON.stringify({ decision, reviewerAccount: $('#reviewer-account').value, comment })
      });
      await refresh(); toast(decision === 'approved' ? '审核通过，服务已登记为草稿' : '申请已驳回');
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
$('#permission-group').addEventListener('change', renderPermissions);
$('#permission-service').addEventListener('change', renderPermissions);
$('#permission-list').addEventListener('change', async event => {
  const select = event.target.closest('[data-grant-tool]'); if (!select) return;
  try { await request('/api/grants', { method: 'POST', body: JSON.stringify({ groupId: $('#permission-group').value, serviceId: $('#permission-service').value, toolName: select.dataset.grantTool, mode: select.value }) }); await refresh(); toast('权限策略已保存'); }
  catch (e) { toast(e.message); await refresh(); }
});
$('#reviewer-account').addEventListener('change', renderPublications);
$('#service-search').addEventListener('input', e => { state.serviceQuery = e.target.value; renderServices(); });
$('#user-search').addEventListener('input', e => { state.userQuery = e.target.value.toLowerCase(); renderUsers(); });
$('#audit-search').addEventListener('input', e => { state.auditQuery = e.target.value.toLowerCase(); renderAudit(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal-backdrop').hidden) closeModal(); });
document.querySelector('[data-action="add-user"]').addEventListener('click', async () => {
  const name = prompt('演示用户姓名'); if (!name?.trim()) return;
  const account = prompt('演示账号（例如 user@example.invalid）'); if (!account?.trim()) return;
  const options = state.data.groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
  const choice = Number(prompt(`选择用户组编号：\n${options}`, String(state.data.groups.length))) - 1;
  const group = state.data.groups[choice]; if (!group) return toast('用户组编号无效');
  try { await request('/api/users', { method: 'POST', body: JSON.stringify({ name, account, groupId: group.id }) }); await refresh(); toast('演示用户已添加'); }
  catch (e) { toast(e.message); }
});

refresh().catch(error => toast(`无法加载管理数据：${error.message}`));

