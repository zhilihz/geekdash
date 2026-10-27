import './shared/read.css';
import './shared/detail.css';
import './shared/project-checks.css';
import { inspectionContent } from './shared/inspection';
import { auditHistory } from './shared/history';
import { PersonalPreference } from './shared/personal-state';
import { ProjectNotifications } from './shared/notifications';
import type { AuditPage, CheckPage } from './shared/api';
import { esc, get, label, checkTime, requireIdentity, SaveError, send, setupTheme, type CheckCommand, type List, type ListProject } from './shared/api';

type Command = Extract<CheckCommand, { action: 'saveCheck' }>;
type Pending = { projectId: string; projectName: string; command: Command };
const element = (id: string) => document.getElementById(id)!;
const dimensions: Record<string, string> = { customer: '客户', productLine: '产品线', odmFactory: 'ODM 工厂', app: 'APP', group: '分组', status: '状态', priority: '优先级', signal: '信号灯', stage: '当前阶段', progress: '进度', chip: '芯片', tags: '标签', owner: '业务人员' };
const scopeKeys = ['view', 'search', ...Object.keys(dimensions)];
const query = new URLSearchParams();
const originalQuery = new URLSearchParams(location.search);
for (const key of [...scopeKeys, 'checkCycle', 'page']) if (originalQuery.get(key)) query.set(key, originalQuery.get(key)!);
if (!query.has('view')) query.set('view', 'all');
if (!query.has('checkCycle')) query.set('checkCycle', 'unchecked');
let list: List | undefined;
let notificationPending=false;
let loading = false, busy = false, fresh = false, authFrozen = false, recoveryBroken = false, storageFailed = false;
let ownerId = '', noticeTimer: ReturnType<typeof setTimeout> | undefined;
let preference:PersonalPreference|undefined,restoredScroll:number|undefined,scrollTimer:ReturnType<typeof setTimeout>|undefined;
function remember(){preference?.update({view:query.get('view'),page:Number(query.get('page') ?? 1),filters:Object.fromEntries([...query].filter(([key])=>!['view','page'].includes(key))),scrollY:window.scrollY});}
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
        || !command || command.action !== 'saveCheck' || !/^[1-9][0-9]{0,19}$/.test(command.expectedVersion) || command.ruleVersion !== undefined && !/^[1-9][0-9]{0,19}$/.test(command.ruleVersion)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(command.idempotencyKey)
        || command.previewWeek !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(command.previewWeek) || command.conclusion !== 'checked' || command.note !== '') throw new Error('invalid recovery');
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
    button.disabled = frozen || !fresh || !project?.inspection || !project?.capabilities.canCheck || project.checkedToday || pending.has(project.id);
  });
  document.querySelectorAll<HTMLAnchorElement>('[data-correct-project]').forEach(link => link.setAttribute('aria-disabled', String(busy || loading)));
  document.querySelectorAll<HTMLButtonElement>('[data-confirm-check],[data-retry-check]').forEach(button => button.disabled = frozen);
  document.querySelectorAll<HTMLButtonElement>('[data-check-today]').forEach(button => {
    button.disabled = frozen || !ownerId;
    button.classList.toggle('active', button.dataset.checkToday === query.get('checkCycle'));
    button.setAttribute('aria-pressed', String(button.dataset.checkToday === query.get('checkCycle')));
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
  const detail = new URLSearchParams({ id: project.id, returnTo: pageUrl() });
  const updatedAt = new Date(project.updatedAt);
  const updated = Number.isNaN(updatedAt.getTime()) ? '未记录' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(updatedAt);
  return `<article class="check-card" data-project-id="${esc(project.id)}" data-project-version="${esc(project.version)}">
    <div class="check-card-content"><div class="check-card-heading"><h2>${esc(project.name)}</h2></div>
    <p class="check-card-subtitle">${esc(label(project.status))} · ${esc(label(project.stage))} · ${esc(project.progress)}% · ${esc(label(project.priority))}优先级 · ${esc(label(project.signal))}</p>
    ${project.tags.length ? `<div class="check-tags">${project.tags.map(tag => `<span class="read-tag">${esc(tag.name)}</span>`).join('')}</div>` : ''}
    ${project.checkPolicy?.overdue?'<p class="field-error">本期检查已逾期</p>':''}${project.inspection ? inspectionContent(project.inspection) : '<p role="alert">完整项目内容尚未读到，请重新读取后检查。</p>'}
    <details class="inspection-section" data-inspection="历史" data-check-history="${esc(project.id)}"><summary>检查与更新历史</summary><div class="inspection-history">展开后读取记录</div></details>
    <div class="check-card-foot"><span>${project.checkedToday ? '今日已检查' : '今日未检查'} · 最近检查：${esc(checkTime(project.checkStatus))}${project.checkStatus.latest?.actorName ? ' · ' + esc(project.checkStatus.latest.actorName) : ''}<br>项目更新于 ${esc(updated)}</span><span class="${project.capabilities.canCheck ? 'check-status-label' : 'check-warning'}">${project.capabilities.canCheck ? esc(project.checkStatus.label) + (project.checkStatus.updatedAfterCheck ? ' · 检查后有更新' : '') : '仅项目负责人可以通过检查'}</span></div></div>
    <div class="check-card-actions"><button class="head-btn check-pass" data-check-project="${esc(project.id)}" disabled>${project.checkedToday ? '今日已检查' : '通过检查'}</button><a class="head-btn" data-correct-project="${esc(project.id)}" href="/project-detail.html?${esc(detail)}">进入修正</a></div>
  </article>`;
}
function openSections() {
  return [...document.querySelectorAll<HTMLDetailsElement>('[data-inspection][open]')].map(section => ({ projectId: section.closest<HTMLElement>('[data-project-id]')!.dataset.projectId, name: section.dataset.inspection }));
}
function restoreSections(saved: unknown) {
  if (!Array.isArray(saved)) return;
  document.querySelectorAll<HTMLDetailsElement>('[data-inspection]').forEach(section => {
    const projectId = section.closest<HTMLElement>('[data-project-id]')!.dataset.projectId;
    section.open = saved.some(item => item?.projectId === projectId && item?.name === section.dataset.inspection);
  });
}
function render() {
  if (!list) return;
  const opened = openSections();
  const policy=list.checkPolicy;
  element('check-rule').textContent=policy?.frequency==='manual'?'不定期检查，只记录事实':policy?`${policy.frequency==='weekly'?'每周一次':'每天一次'} · 本期截止 ${policy.deadline}（全天）`:list.businessDate;
  document.querySelectorAll<HTMLElement>('[data-check-today]').forEach(button=>{button.textContent=button.dataset.checkToday==='checked'?(policy?.frequency==='manual'?'有检查记录':'本期已检查'):(policy?.frequency==='manual'?'尚无检查记录':'本期未检查');});
  element('check-list').innerHTML = list.items.length ? list.items.map(card).join('') : `<p class="checks-empty">${query.get('checkCycle') === 'checked' ? '当前范围本期还没有检查记录' : '当前范围本期没有待检查项目'}</p>`;
  element('page-info').textContent = `第 ${list.pagination.page} / ${list.pagination.pageCount} 页 · 共 ${list.pagination.total} 个项目`;
  document.querySelectorAll<HTMLButtonElement>('[data-check-project]').forEach(button => button.onclick = () => {
    const project = list?.items.find(item => item.id === button.dataset.checkProject);
    if (busy || loading || !fresh || authFrozen || recoveryBroken || !project?.inspection || !project?.capabilities.canCheck || project.checkedToday || pending.has(project.id)) return;
    const item: Pending = { projectId: project.id, projectName: project.name, command: { action: 'saveCheck', expectedVersion: project.version, idempotencyKey: crypto.randomUUID(), conclusion: 'checked', note: '' } };
    pending.set(project.id, item); persist(item); renderRecovery(); void execute(project.id, false);
  });
  document.querySelectorAll<HTMLAnchorElement>('[data-correct-project]').forEach(link => link.onclick = event => {
    if (busy || loading) { event.preventDefault(); return; }
    try { sessionStorage.setItem('geekdash_checks_return:'+ownerId, JSON.stringify({ url: location.href, scrollY, projectId: link.dataset.correctProject, opened: openSections() })); } catch { /* 返回位置不可用不阻止进入修正。 */ }
  });
  document.querySelectorAll<HTMLDetailsElement>('[data-check-history]').forEach(section => section.ontoggle = () => { if (section.open && !section.dataset.loaded) void loadHistory(section); });
  restoreSections(opened);
  controls();
}
async function loadHistory(section: HTMLDetailsElement, checkCursor?: string | null, auditCursor?: string | null) {
  const id = section.dataset.checkHistory!, output = section.querySelector<HTMLElement>('.inspection-history')!;
  if (section.dataset.loading) return;
  section.dataset.loading = 'true';
  try {
    const [checks, audit] = await Promise.all([checkCursor !== null ? get<CheckPage>('/api/projects/' + id + '/checks' + (checkCursor ? '?before=' + checkCursor : '')) : undefined, auditCursor !== null ? get<AuditPage>('/api/projects/' + id + '/audit' + (auditCursor ? '?before=' + auditCursor : '')) : undefined]);
    if (!section.isConnected) return;
    if (!section.dataset.loaded) output.innerHTML = '<div class="inspection-check-records"></div><div class="inspection-audits"></div>';
    if (checks) output.querySelector('.inspection-check-records')!.insertAdjacentHTML('beforeend', checks.items.map(item => `<p>${esc(item.actorName)} · ${esc(new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(new Date(item.checkedAt)))} · ${item.conclusion === 'checked' ? '已核对' : '需跟进'}<br>${esc(item.note)}</p>`).join('') || (!section.dataset.loaded ? '<p>暂无检查记录</p>' : ''));
    if (audit) output.querySelector('.inspection-audits')!.insertAdjacentHTML('beforeend', auditHistory(audit.items) || (!section.dataset.loaded ? '<p>暂无更新记录</p>' : ''));
    output.querySelector('.inspection-history-more')?.remove();
    if (checks?.nextCursor || audit?.nextCursor) { const more = document.createElement('button'); more.className = 'back-btn inspection-history-more'; more.textContent = '读取更早记录'; more.onclick = () => { void loadHistory(section,checks?.nextCursor ?? null,audit?.nextCursor ?? null); }; output.append(more); }
    section.dataset.loaded = 'true';
  } catch (error) { if (section.isConnected) { const retry = document.createElement('button'); retry.className = 'back-btn'; retry.textContent = '历史读取失败，重试'; retry.onclick = () => { retry.remove(); void loadHistory(section,checkCursor,auditCursor); }; output.append(retry); } freezeIdentity(error); }
  finally { delete section.dataset.loading; }
}
function freezeIdentity(error: unknown) {
  if (error instanceof SaveError && authCodes.includes(error.code)) { authFrozen = true; element('login').hidden = false; }
}
async function load() {
  if (loading || authFrozen) return false;
  loading = true; fresh = false; controls(); element('check-loading').textContent = '正在读取项目…';
  try {
    const next = await get<List>('/api/projects?' + query + '&details=checks');
    if (authFrozen) return false;
    list = next; fresh = true;
    renderScope();
    query.set('page', String(next.pagination.page)); history.replaceState(null, '', pageUrl());
    element('check-loading').textContent = ''; render();
    if(restoredScroll!==undefined){scrollTo(0,restoredScroll);restoredScroll=undefined;}
    try {
      const position = JSON.parse(sessionStorage.getItem('geekdash_checks_return:'+ownerId) ?? 'null');
      if (position?.url === location.href && Number.isFinite(position.scrollY)) {
        restoreSections(position.opened); scrollTo(0, position.scrollY); sessionStorage.removeItem('geekdash_checks_return:'+ownerId);
        if (position.projectId && !next.items.some(item => item.id === position.projectId)) note('返回的项目已不在当前列表，可能已检查、修改后不符合筛选或移至其他页。当前范围已重新读取。');
      }
    } catch { /* 无返回位置时从当前视口继续。 */ }
    return true;
  } catch (error) {
    freezeIdentity(error); element('check-loading').textContent = '项目读取失败，请重新读取。';
    note((error as Error).message, true); return false;
  } finally { loading = false; controls();if(notificationPending && !busy && !authFrozen){notificationPending=false;void load();} }
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
  else if(notificationPending && !authFrozen){notificationPending=false;await load();}
}

setupTheme();
const views: Record<string, string> = { active: '进行中', proposal: '提案 / 暂缓', closed: '已结案', maintenance: '量产维护', all: '全部项目' };
function renderScope() { element('check-scope').textContent = [views[query.get('view')!] ?? query.get('view'), ...scopeKeys.filter(name => name !== 'view' && query.has(name)).map(name => `${name === 'search' ? '搜索' : dimensions[name]}：${list?.optionLabels?.[name]?.[query.get(name)!] ?? label(query.get(name))}`)].join(' · '); }
renderScope();
function restoreBack(){const boardQuery = new URLSearchParams();
for (const name of scopeKeys) if (query.has(name)) boardQuery.set(name, query.get(name)!);
(element('back') as HTMLAnchorElement).href = '/?' + boardQuery;
try {
  const saved = JSON.parse(sessionStorage.getItem('geekdash_board_return:'+ownerId) ?? 'null');
  if (typeof saved?.url === 'string') {
    const url = new URL(saved.url);
    if (url.origin === location.origin && ['/', '/GeekDash.html'].includes(url.pathname) && scopeKeys.every(name => (url.searchParams.get(name) ?? (name === 'view' ? 'active' : '')) === (query.get(name) ?? ''))) (element('back') as HTMLAnchorElement).href = url.href;
  }
} catch { /* 无原首页位置时仍保留筛选范围。 */ }}
element('notice-close').onclick = closeNotice;
element('check-reload').onclick = () => { if (!busy) void load(); };
for (const [id, offset] of [['previous', -1], ['next', 1]] as const) element(id).onclick = () => {
  if (busy || loading || !fresh || !list) return;
  query.set('page', String(list.pagination.page + offset)); remember();void load();
};
document.querySelectorAll<HTMLButtonElement>('[data-check-today]').forEach(button => button.onclick = () => {
  if (busy || loading || authFrozen) return;
  query.set('checkCycle', button.dataset.checkToday!); query.set('page', '1'); remember();void load();
});
document.addEventListener('geekdash-identity-changed', () => { authFrozen = true; element('login').hidden = false; note('账号已变化，检查已暂停。请重新登录原账号后确认尚未完成的检查。', true); controls(); });
function refreshBusinessDay() {
  if (!list || busy || loading || pending.size || authFrozen || recoveryBroken) return;
  if (list.businessDate !== new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())) void load();
}
const refresh=()=>{if(busy || loading)notificationPending=true;else if(!authFrozen && ownerId)void load();};
window.addEventListener('focus',()=>{if(list)refresh();});
setInterval(() => { if (document.visibilityState === 'visible') refreshBusinessDay(); }, 60000);
window.addEventListener('beforeunload', event => { if (busy || pending.size && storageFailed) event.preventDefault(); });
window.addEventListener('scroll',()=>{if(!fresh || scrollTimer)return;scrollTimer=setTimeout(()=>{scrollTimer=undefined;remember();},2000);},{passive:true});
window.addEventListener('pagehide',()=>{remember();void preference?.flush();});
document.addEventListener('geekdash-preference-status',event=>note((event as CustomEvent<string>).detail,true));
void requireIdentity().then(async identity => {
  ownerId = identity.id;preference=new PersonalPreference('checks',text=>note(text,true));const saved=await preference.load();
  if(!originalQuery.size){if(typeof saved.view==='string')query.set('view',saved.view);if(typeof saved.page==='number')query.set('page',String(saved.page));for(const [key,value] of Object.entries(saved.filters ?? {}))if([...scopeKeys,'checkCycle'].includes(key) && typeof value==='string')query.set(key,value);restoredScroll=typeof saved.scrollY==='number'?saved.scrollY:undefined;}
  restoreBack();recover(); renderRecovery(); await load();
  new ProjectNotifications(refresh,refresh,text=>{if(text)element('message').textContent=text;},undefined,undefined,refresh);
  for (const id of pending.keys()) { if (authFrozen || recoveryBroken) break; await execute(id, true); }
}).catch(error => { freezeIdentity(error); element('login').hidden = false; element('check-loading').textContent = '请登录后继续检查项目。'; note((error as Error).message, true); controls(); });
