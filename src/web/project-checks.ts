import './shared/read.css';
import './shared/detail.css';
import './shared/project-checks.css';
import { esc, get, label, requireIdentity, SaveError, send, setupTheme, type CheckCommand, type CheckRuleContext, type List, type ListProject } from './shared/api';

type Command = Extract<CheckCommand, { action: 'saveCheck' }>;
type Pending = { projectId: string; projectName: string; command: Command };
const element = (id: string) => document.getElementById(id)!;
const dimensions: Record<string, string> = { customer: '客户', productLine: '产品线', odmFactory: 'ODM 工厂', app: 'APP', group: '分组', status: '状态', priority: '优先级', signal: '信号灯', deadline: '计划结果', stage: '当前阶段', progress: '进度', chip: '芯片', tags: '标签', owner: '业务人员' };
const scopeKeys = ['view', 'search', ...Object.keys(dimensions)];
const query = new URLSearchParams();
const originalQuery = new URLSearchParams(location.search);
for (const key of [...scopeKeys, 'checkToday', 'page']) if (originalQuery.get(key)) query.set(key, originalQuery.get(key)!);
if (!query.has('view')) query.set('view', 'active');
if (!query.has('checkToday')) query.set('checkToday', 'unchecked');
let list: List | undefined, rule: CheckRuleContext | undefined;
let loading = false, busy = false, fresh = false, authFrozen = false, recoveryBroken = false, storageFailed = false;
let ownerId = '', noticeTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<string, Pending>();
const key = (id: string) => `geekdash_check:${ownerId}:${id}`;
const authCodes = ['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'];
const pageUrl = () => '/project-checks.html?' + query.toString();

function closeNotice() {
  clearTimeout(noticeTimer);
  const popup = element('project-notice');
  popup.hidePopover?.();
  popup.hidden = true;
}
function note(message: string, error = false) {
  clearTimeout(noticeTimer);
  element('message').textContent = message;
  element('notice-title').textContent = error ? '需要处理' : '已完成';
  element('notice-icon').textContent = error ? '!' : '✓';
  const popup = element('project-notice');
  popup.classList.toggle('error', error); popup.hidden = false;
  popup.showPopover?.();
  if (!error) noticeTimer = setTimeout(closeNotice, 5000);
}
function persist(item: Pending, remove = false) {
  try { if (remove) sessionStorage.removeItem(key(item.projectId)); else sessionStorage.setItem(key(item.projectId), JSON.stringify(item)); }
  catch { storageFailed = true; }
}
function recover() {
  try {
    const prefix = `geekdash_check:${ownerId}:`;
    for (let index = 0; index < sessionStorage.length; index++) {
      const savedKey = sessionStorage.key(index);
      if (!savedKey?.startsWith(prefix)) continue;
      const saved = JSON.parse(sessionStorage.getItem(savedKey)!);
      const command = saved?.command;
      if (!saved || !/^[1-9][0-9]{0,19}$/.test(saved.projectId) || savedKey !== key(saved.projectId) || typeof saved.projectName !== 'string'
        || !command || command.action !== 'saveCheck' || !/^[1-9][0-9]{0,19}$/.test(command.expectedVersion) || !/^[1-9][0-9]{0,19}$/.test(command.ruleVersion)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(command.idempotencyKey)
        || !/^\d{4}-\d{2}-\d{2}$/.test(command.previewWeek) || command.conclusion !== 'checked' || command.note !== '') throw new Error('invalid recovery');
      pending.set(saved.projectId, saved);
    }
  } catch { recoveryBroken = true; note('本标签页的检查恢复信息无法读取。请保留本页并核对原检查记录，暂不能再次提交检查。', true); }
}
function controls() {
  const frozen = busy || loading || authFrozen || recoveryBroken;
  element('check-list').setAttribute('aria-busy', String(busy || loading));
  (element('check-reload') as HTMLButtonElement).disabled = frozen || !ownerId;
  document.querySelectorAll<HTMLButtonElement>('[data-check-project]').forEach(button => {
    const project = list?.items.find(item => item.id === button.dataset.checkProject);
    button.disabled = frozen || !fresh || !rule?.rule || !project?.capabilities.canCheck || project.checkedToday || pending.has(project.id);
  });
  document.querySelectorAll<HTMLAnchorElement>('[data-correct-project]').forEach(link => link.setAttribute('aria-disabled', String(busy || loading)));
  document.querySelectorAll<HTMLButtonElement>('[data-confirm-check],[data-retry-check]').forEach(button => button.disabled = frozen);
  document.querySelectorAll<HTMLButtonElement>('[data-check-today]').forEach(button => {
    button.disabled = frozen || !ownerId;
    button.classList.toggle('active', button.dataset.checkToday === query.get('checkToday'));
    button.setAttribute('aria-pressed', String(button.dataset.checkToday === query.get('checkToday')));
  });
  (element('previous') as HTMLButtonElement).disabled = frozen || !fresh || !list || list.pagination.page <= 1;
  (element('next') as HTMLButtonElement).disabled = frozen || !fresh || !list || list.pagination.page >= list.pagination.pageCount;
}
function renderRecovery() {
  const section = element('check-recovery'); section.hidden = pending.size === 0;
  section.innerHTML = [...pending.values()].map(item => `<article><h2>${esc(item.projectName)} · 检查结果待确认</h2><p>${storageFailed ? '本机恢复存储不可用，请保留本页直到结果确认。' : '已保留原检查操作；确认或重试不会重复新增同一次检查。'}</p><button class="head-btn" data-confirm-check="${esc(item.projectId)}">确认原结果</button><button class="head-btn" data-retry-check="${esc(item.projectId)}">重试原检查</button></article>`).join('');
  section.querySelectorAll<HTMLButtonElement>('[data-confirm-check]').forEach(button => button.onclick = () => { void execute(button.dataset.confirmCheck!, true); });
  section.querySelectorAll<HTMLButtonElement>('[data-retry-check]').forEach(button => button.onclick = () => { void execute(button.dataset.retryCheck!, false); });
  controls();
}
function card(project: ListProject) {
  const people = (role: string) => project.people.filter(person => person.role === role).map(person => person.name).join('、') || '未指定';
  const detail = new URLSearchParams({ id: project.id, returnTo: pageUrl() });
  const updatedAt = new Date(project.updatedAt);
  const updated = Number.isNaN(updatedAt.getTime()) ? '未记录' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(updatedAt);
  return `<article class="check-card" data-project-id="${esc(project.id)}" data-project-version="${esc(project.version)}">
    <div class="check-card-heading"><div><h2>${esc(project.name)}</h2><p class="check-card-subtitle">${esc(project.customer || '客户未指定')} · ${esc(project.productLine || '产品线未指定')} · ${esc(project.chips.map(chip => chip.name).join(' / ') || '芯片未指定')}</p></div><div class="check-card-actions"><button class="head-btn check-pass" data-check-project="${esc(project.id)}" disabled>${project.checkedToday ? '今日已检查' : '通过检查'}</button><a class="head-btn" data-correct-project="${esc(project.id)}" href="/project-detail.html?${esc(detail)}">进入修正</a></div></div>
    <dl class="check-card-facts"><div><dt>提案日期</dt><dd>${esc(project.proposalDate || '未记录')}</dd></div><div><dt>计划结案</dt><dd>${esc(project.dueDate || '计划未定')} · ${esc(project.deadline.label)}</dd></div><div><dt>项目状态</dt><dd>${esc(label(project.status))} · ${esc(label(project.stage))} · ${esc(project.progress)}%</dd></div><div><dt>优先级</dt><dd>${esc(label(project.priority))} · ${esc(label(project.signal))}</dd></div></dl>
    <dl class="check-card-facts"><div><dt>项目经理</dt><dd>${esc(people('pm'))}</dd></div><div><dt>硬件负责人</dt><dd>${esc(people('hardware_owner'))}</dd></div><div><dt>软件负责人</dt><dd>${esc(people('software_owner'))}</dd></div></dl>
    <div class="check-latest"><h3>最新状态说明</h3><p>${esc(project.statusDesc || '暂无状态说明')}</p></div>
    <div class="check-card-foot"><span>更新于 ${esc(updated)}</span><span class="${project.capabilities.canCheck ? 'check-status-label' : 'check-warning'}">${project.capabilities.canCheck ? esc(project.checkStatus.label) : '仅项目负责人可以通过检查'}</span></div>
  </article>`;
}
function render() {
  if (!list) return;
  element('check-rule').textContent = `${list.businessDate} · ${rule?.rule ? '每周' + ['一', '二', '三', '四', '五', '六', '日'][rule.rule.deadlineWeekday - 1] + '全天为检查截止' : '检查规则尚未设置'}`;
  element('check-list').innerHTML = list.items.length ? list.items.map(card).join('') : `<p class="checks-empty">${query.get('checkToday') === 'checked' ? '当前范围今天还没有检查记录' : '当前范围今天没有待检查项目'}</p>`;
  element('page-info').textContent = `第 ${list.pagination.page} / ${list.pagination.pageCount} 页 · 共 ${list.pagination.total} 个项目`;
  document.querySelectorAll<HTMLButtonElement>('[data-check-project]').forEach(button => button.onclick = () => {
    const project = list?.items.find(item => item.id === button.dataset.checkProject);
    if (busy || loading || !fresh || authFrozen || recoveryBroken || !project?.capabilities.canCheck || project.checkedToday || !rule?.rule || pending.has(project.id)) return;
    const item: Pending = { projectId: project.id, projectName: project.name, command: { action: 'saveCheck', expectedVersion: project.version, idempotencyKey: crypto.randomUUID(), ruleVersion: rule.rule.version, previewWeek: rule.weekStart, conclusion: 'checked', note: '' } };
    pending.set(project.id, item); persist(item); renderRecovery(); void execute(project.id, false);
  });
  document.querySelectorAll<HTMLAnchorElement>('[data-correct-project]').forEach(link => link.onclick = event => {
    if (busy || loading) { event.preventDefault(); return; }
    try { sessionStorage.setItem('geekdash_checks_return', JSON.stringify({ url: location.href, scrollY })); } catch { /* 返回位置不可用不阻止进入修正。 */ }
  });
  controls();
}
function freezeIdentity(error: unknown) {
  if (error instanceof SaveError && authCodes.includes(error.code)) { authFrozen = true; element('login').hidden = false; }
}
async function load() {
  if (loading || authFrozen) return false;
  loading = true; fresh = false; controls(); element('check-loading').textContent = '正在读取项目…';
  try {
    const [next, currentRule] = await Promise.all([get<List>('/api/projects?' + query), get<CheckRuleContext>('/api/settings/check-rule')]);
    if (authFrozen) return false;
    list = next; rule = currentRule; fresh = true;
    query.set('page', String(next.pagination.page)); history.replaceState(null, '', pageUrl());
    element('check-loading').textContent = ''; render();
    try {
      const position = JSON.parse(sessionStorage.getItem('geekdash_checks_return') ?? 'null');
      if (position?.url === location.href && Number.isFinite(position.scrollY)) { scrollTo(0, position.scrollY); sessionStorage.removeItem('geekdash_checks_return'); }
    } catch { /* 无返回位置时从当前视口继续。 */ }
    return true;
  } catch (error) {
    freezeIdentity(error); element('check-loading').textContent = '项目读取失败，请重新读取。';
    note((error as Error).message, true); return false;
  } finally { loading = false; controls(); }
}
async function execute(id: string, confirm: boolean) {
  const item = pending.get(id);
  if (!item || busy || loading || authFrozen || recoveryBroken) return;
  busy = true; controls();
  let committed = false;
  try {
    const response = await send<{ outcome: string; result?: { projectId: string; operationId: string; savedVersion: string } }>(`/api/projects/${id}/${confirm ? 'action-results/query' : 'actions'}`, 'POST', item.command, !confirm);
    if (response.outcome === 'committed' && response.result) {
      if (response.result.projectId !== id || response.result.operationId !== item.command.idempotencyKey) throw new SaveError('RESPONSE_UNKNOWN', 'unknown');
      committed = true; pending.delete(id); persist(item, true);
    } else note('暂未查到原检查结果。请确认原结果或重试原检查，不要重复提交新检查。', true);
  } catch (error) {
    const failure = error instanceof SaveError ? error : new SaveError('TRANSPORT_UNKNOWN', 'unknown');
    freezeIdentity(failure);
    // 这些业务拒绝发生在原回执查找之后；查询失败、失去身份或数据库故障不能证明原检查未提交。
    const rejected = !confirm && failure.outcome === 'not_committed' && ['PROJECT_VERSION_CONFLICT', 'PROJECT_READ_ONLY', 'CHECK_PREVIEW_CHANGED', 'CHECK_RULE_REQUIRED', 'PROJECT_VERSION_EXHAUSTED'].includes(failure.code);
    if (rejected) { pending.delete(id); persist(item, true); fresh = false; }
    note(failure.message + (rejected ? ' 请刷新列表，重新核对后再操作。' : !authFrozen ? ' 原检查结果仍待确认，请使用原操作恢复。' : ''), true);
  } finally { busy = false; renderRecovery(); }
  if (committed) {
    const refreshed = await load();
    note(refreshed ? `“${item.projectName}”已通过检查。` : `“${item.projectName}”的检查已保存，但列表读取失败。请刷新列表，无需再次检查。`, !refreshed);
  }
}

setupTheme();
const views: Record<string, string> = { active: '进行中', proposal: '提案 / 暂缓', closed: '已结案', maintenance: '量产维护', all: '全部项目' };
element('check-scope').textContent = [views[query.get('view')!] ?? query.get('view'), ...scopeKeys.filter(name => name !== 'view' && query.has(name)).map(name => `${name === 'search' ? '搜索' : dimensions[name]}：${label(query.get(name))}`)].join(' · ');
const boardQuery = new URLSearchParams();
for (const name of scopeKeys) if (query.has(name)) boardQuery.set(name, query.get(name)!);
(element('back') as HTMLAnchorElement).href = '/?' + boardQuery;
try {
  const saved = JSON.parse(sessionStorage.getItem('geekdash_board_return') ?? 'null');
  if (typeof saved?.url === 'string') {
    const url = new URL(saved.url);
    if (url.origin === location.origin && ['/', '/GeekDash.html'].includes(url.pathname) && scopeKeys.every(name => (url.searchParams.get(name) ?? (name === 'view' ? 'active' : '')) === (query.get(name) ?? ''))) (element('back') as HTMLAnchorElement).href = url.href;
  }
} catch { /* 无原首页位置时仍保留筛选范围。 */ }
element('notice-close').onclick = closeNotice;
element('check-reload').onclick = () => { if (!busy) void load(); };
for (const [id, offset] of [['previous', -1], ['next', 1]] as const) element(id).onclick = () => {
  if (busy || loading || !fresh || !list) return;
  query.set('page', String(list.pagination.page + offset)); void load();
};
document.querySelectorAll<HTMLButtonElement>('[data-check-today]').forEach(button => button.onclick = () => {
  if (busy || loading || authFrozen) return;
  query.set('checkToday', button.dataset.checkToday!); query.set('page', '1'); void load();
});
document.addEventListener('geekdash-identity-changed', () => { authFrozen = true; element('login').hidden = false; note('账号已变化，检查已暂停。请重新登录原账号后确认尚未完成的检查。', true); controls(); });
function refreshBusinessDay() {
  if (!list || busy || loading || pending.size || authFrozen || recoveryBroken) return;
  if (list.businessDate !== new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())) void load();
}
window.addEventListener('focus', refreshBusinessDay);
setInterval(() => { if (document.visibilityState === 'visible') refreshBusinessDay(); }, 60000);
window.addEventListener('beforeunload', event => { if (busy || pending.size && storageFailed) event.preventDefault(); });
void requireIdentity().then(async identity => {
  ownerId = identity.id; recover(); renderRecovery(); await load();
  for (const id of pending.keys()) { if (authFrozen || recoveryBroken) break; await execute(id, true); }
}).catch(error => { freezeIdentity(error); element('login').hidden = false; element('check-loading').textContent = '请登录后继续检查项目。'; note((error as Error).message, true); controls(); });
