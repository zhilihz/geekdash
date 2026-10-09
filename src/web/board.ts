import './shared/board.css';
import './shared/read.css';
import { get, esc, label, projectTags, setupTheme, type List, type Project } from './shared/api';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const search = element<HTMLInputElement>('search');
const message = element<HTMLParagraphElement>('message');
const filterRows = element<HTMLDivElement>('filter-rows');
const query = new URLSearchParams(location.search);
query.set('view', ['active', 'proposal', 'closed', 'maintenance', 'all'].includes(query.get('view') ?? '') ? query.get('view')! : 'active');
const dimensions = { customer: '客户', productLine: '产品线', odmFactory: 'ODM 工厂', app: 'APP', group: '分组', status: '状态', priority: '优先级', signal: '信号灯', stage: '当前阶段', progress: '进度', chip: '芯片', tags: '标签', owner: '业务人员' };
const allowed = new Set(['view', 'search', 'page', ...Object.keys(dimensions)]);
for (const key of [...query.keys()]) if (!allowed.has(key)) query.delete(key);
let controller: AbortController | undefined;
let generation = 0;
let pagination: List['pagination'] | undefined;
let hasResult = false;
setupTheme();
search.value = query.get('search') ?? '';

function card(project: Project) {
  const people = (role: string) => project.people.filter(person => person.role === role).map(person => person.name).join(' / ') || '—';
  const fields = [['客户', project.customer], ['产品线', project.productLine], ['ODM 工厂', project.odmFactory], ['APP', project.app], ['芯片', project.chips.map(chip => chip.name).join(' · ')], ['负责人', `${people('hardware_owner')}（硬） · ${people('software_owner')}（软）`], ['项目经理', people('pm')], ['周期', `${project.proposalDate ?? '—'} → ${project.dueDate ?? '—'}`]];
  const stageName = project.stage === 'completed' ? '七阶段全部完成' : '当前阶段：' + label(project.stage) + ' · ' + (project.status === 'proposal' && project.stage !== 'S1' ? '需先启动项目' : label(project.stageState));
  return `<a class="card ${project.priority === 'high' ? 'pri-border-high' : ''}" href="project-detail.html?id=${project.id}" data-project-id="${project.id}"><div class="card-top"><div class="tags">${projectTags(project)}${project.manualDelayed && project.status !== 'closed' ? '<span class="delay-tag">⏰ 人工标记延期</span>' : ''}</div><span class="open-hint">查看详情 ↗</span></div><div class="card-name">${esc(project.name)}</div><ul class="card-info">${fields.map(([key, value]) => `<li><span class="k">${key}</span><span class="v">${esc(value || '—')}</span></li>`).join('')}</ul><div class="card-desc"><span class="d-label">市场预期</span>${esc(project.marketExpectation || '—')}</div><div class="card-desc status-desc"><span class="d-label">状态</span>${esc(project.statusDesc || '—')}</div><div class="card-stage"><div class="stage-bar-top"><span class="stage-bar-name">${esc(stageName)}</span><span class="stage-bar-pct">${project.progress}%</span></div><div class="stage-bar-track"><div class="stage-bar-fill" style="width:${Number(project.progress)}%"></div></div></div></a>`;
}
function filters(options: List['options']) {
  options.stage = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'completed', 'unconfigured'];
  options.progress = ['0', '5', '10', '20', '60', '80', '90', '100'];
  filterRows.innerHTML = Object.entries(dimensions).map(([key, title]) => {
    const values = options[key] ?? [];
    const selected = query.get(key) ?? '';
    const choices = selected && !values.includes(selected) ? [selected, ...values] : values;
    return `<div class="filter-row"><span class="filter-label">${title}</span><button class="chip ${selected ? '' : 'active'}" data-filter="${key}" data-value="">全部</button>${choices.map(value => `<button class="chip ${selected === value ? 'active' : ''}" data-filter="${key}" data-value="${esc(value)}">${esc(key === 'progress' ? value + '%' : ['status', 'priority', 'signal', 'stage'].includes(key) ? label(value) : value)}</button>`).join('')}</div>`;
  }).join('');
}
async function load() {
  controller?.abort();
  controller = new AbortController();
  const current = ++generation;
  const previous = element<HTMLButtonElement>('previous');
  const next = element<HTMLButtonElement>('next');
  previous.disabled = next.disabled = true;
  element('card-grid').setAttribute('aria-busy', 'true');
  message.classList.remove('error');
  message.textContent = '正在读取项目…';
  history.replaceState(null, '', location.pathname + '?' + query);
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === query.get('view')));
  try {
    const data = await get<List>('/api/projects?' + query, controller.signal);
    if (current !== generation) return;
    pagination = data.pagination;
    query.set('page', String(pagination.page));
    history.replaceState(null, '', location.pathname + '?' + query);
    filters(data.options);
    hasResult = true;
    const stats = [['total', '项目总数'], ['high', '高优先级'], ['green', '绿灯'], ['yellow', '黄灯'], ['red', '红灯']];
    element('stats-bar').innerHTML = stats.map(([key, title]) => `<div class="stat"><span class="stat-label">${title}</span><b>${data.stats[key]}</b></div>`).join('');
    element('stage-chart').innerHTML = data.stageCounts.map(item => `<span>${esc(label(item.value))} · ${item.count}</span>`).join('');
    element('card-grid').innerHTML = data.items.map(card).join('');
    element('result-count').textContent = `筛选结果 ${pagination.total} 条 · 统计条与筛选结果一致`;
    element('page-info').textContent = `${pagination.page} / ${pagination.pageCount} 页`;
    previous.disabled = pagination.page <= 1;
    next.disabled = pagination.page >= pagination.pageCount;
    message.textContent = pagination.total ? '' : '暂无符合条件的项目。';
    element('card-grid').setAttribute('aria-busy', 'false');
    try {
      const saved = JSON.parse(sessionStorage.getItem('geekdash_board_return') ?? 'null');
      if (saved?.url === location.href) { window.scrollTo(0, saved.scrollY); sessionStorage.removeItem('geekdash_board_return'); }
    } catch { /* 状态恢复不影响正式查询。 */ }
  } catch (error) {
    if (current !== generation) return;
    message.classList.add('error');
    message.textContent = (error as Error).message + (hasResult ? ' 当前显示保留的旧结果，尚未刷新。' : '');
    element('card-grid').setAttribute('aria-busy', 'false');
  }
}
function change(key: string, value: string) { value ? query.set(key, value) : query.delete(key); query.delete('page'); void load(); }
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.onclick = () => {
  for (const key of [...query.keys()]) if (key !== 'view') query.delete(key);
  search.value = '';
  change('view', button.dataset.view!);
});
filterRows.onclick = event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (button) change(button.dataset.filter!, button.dataset.value!);
};
let searchTimer: ReturnType<typeof setTimeout>;
search.oninput = () => { clearTimeout(searchTimer); controller?.abort(); generation++; searchTimer = setTimeout(() => change('search', search.value), 200); };
element('reload').onclick = () => { clearTimeout(searchTimer); search.value ? query.set('search', search.value) : query.delete('search'); void load(); };
element('clear').onclick = () => { clearTimeout(searchTimer); for (const key of [...query.keys()]) if (key !== 'view') query.delete(key); search.value = ''; void load(); };
element('previous').onclick = () => { if (pagination) { query.set('page', String(pagination.page - 1)); void load(); } };
element('next').onclick = () => { if (pagination) { query.set('page', String(pagination.page + 1)); void load(); } };
element('filter-toggle').onclick = () => { filterRows.hidden = !filterRows.hidden; element('filter-toggle').setAttribute('aria-expanded', String(!filterRows.hidden)); };
element('card-grid').onclick = event => {
  if ((event.target as HTMLElement).closest('[data-project-id]')) {
    try { sessionStorage.setItem('geekdash_board_return', JSON.stringify({ url: location.href, scrollY: scrollY })); } catch { /* 无浏览器存储时可正常跳转。 */ }
  }
};
void import('./shared/api').then(async ({ requireIdentity }) => { await requireIdentity(); await load(); }).catch(error => {
  element('message').textContent = (error as Error).message;
  const link = document.createElement('a'); link.href = '/login.html'; link.textContent = '登录 GeekDash'; element('message').append(' ', link);
});
