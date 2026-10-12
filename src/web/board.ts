import './shared/board.css';
import './shared/read.css';
import { get, esc, label, projectTags, setupTheme, setupDateZone, type Dashboard, type List, type Project } from './shared/api';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const search = element<HTMLInputElement>('search');
const message = element<HTMLParagraphElement>('message');
const filterRows = element<HTMLDivElement>('filter-rows');
const query = new URLSearchParams(location.search);
query.set('view', ['active', 'proposal', 'closed', 'maintenance', 'all'].includes(query.get('view') ?? '') ? query.get('view')! : 'active');
const dimensions = { customer: '客户', productLine: '产品线', odmFactory: 'ODM 工厂', app: 'APP', group: '分组', status: '状态', priority: '优先级', signal: '信号灯', deadline: '计划结果', stage: '当前阶段', progress: '进度', chip: '芯片', tags: '标签', owner: '业务人员' };
const allowed = new Set(['view', 'search', 'page', 'layout', ...Object.keys(dimensions)]);
for (const key of [...query.keys()]) if (!allowed.has(key)) query.delete(key);
let controller: AbortController | undefined;
let generation = 0;
let pagination: List['pagination'] | undefined;
let hasResult = false;
let businessDate = '';
let currentData: List | undefined;
declare const __GEEKDASH_STAGES__: { id: number; name: string; milestone: string }[];
setupTheme(); setupDateZone();
search.value = query.get('search') ?? '';

function milestone(stage: string) { return __GEEKDASH_STAGES__.find(item => 'S' + item.id === stage)?.milestone ?? (stage === 'completed' ? '七阶段里程碑已全部完成。' : '阶段事实待核对。'); }
function card(project: Project) {
  const fields = [['客户', project.customer], ['产品线', project.productLine], ['ODM 工厂', project.odmFactory], ['APP', project.app], ['芯片', project.chips.map(chip => chip.name).join(' · ')]];
  const stageName = (project.status === 'paused' ? '暂缓保留 · ' : '') + (project.stage === 'completed' ? '七阶段全部完成' : label(project.stage) + ' · ' + (project.status === 'proposal' && project.stage !== 'S1' ? '需先启动项目' : label(project.stageState)));
  return `<a class="card ${project.priority === 'high' ? 'pri-border-high' : ''}" href="project-detail.html?id=${project.id}" data-project-id="${project.id}"><div class="card-top"><div class="tags">${projectTags(project)}</div><span class="open-hint">查看详情 ↗</span></div><div class="card-name">${esc(project.name)}</div>${project.summaryNote ? `<div class="card-desc">${esc(project.summaryNote)}</div>` : ''}<ul class="card-info">${fields.map(([key, value]) => `<li><span class="k">${key}</span><span class="v">${esc(value || '—')}</span></li>`).join('')}</ul><div class="card-desc status-desc">${esc(project.statusDesc || '暂无最新状态说明')}</div><div class="card-stage"><div class="stage-bar-top"><span class="stage-bar-name">${esc(stageName)}</span><span class="stage-bar-pct">${project.progress}%</span></div><div class="stage-bar-track"><div class="stage-bar-fill" style="width:${Number(project.progress)}%"></div></div><div class="stage-bar-milestone">里程碑：${esc(milestone(project.stage))}</div></div></a>`;
}
function renderProjects() {
  if (!currentData) return;
  const progress = query.get('layout') === 'progress';
  element('card-grid').classList.toggle('progress-layout', progress);
  element('card-grid').innerHTML = currentData.items.map(card).join('');
  element('layout-toggle').textContent = progress ? '切换卡片' : '切换驾驶舱';
}
function distribution() {
  if (!currentData?.dashboard) return;
  const key = element<HTMLSelectElement>('distribution').value, slices = currentData.dashboard.distributions[key], total = currentData.pagination.total;
  const colors = ['#58a6ff', '#f0883e', '#39c5cf', '#a371f7', '#3fb950', '#f85149']; let angle = 0;
  const stops = slices.map((slice, i) => { const start = angle; angle += total ? slice.count / total * 360 : 0; return `${colors[i % colors.length]} ${start}deg ${angle}deg`; });
  element('distribution-chart').innerHTML = `<div class="board-donut" style="background:conic-gradient(${stops.join(',') || 'var(--chart-empty) 0deg 360deg'})" aria-hidden="true"><div><b>${total}</b><span>项目</span></div></div><ul class="legend">${slices.map((slice, i) => `<li><span class="dot" style="background:${colors[i % colors.length]}"></span>${slice.value ? `<button class="legend-filter" data-filter="${key}" data-value="${esc(slice.value)}">${esc(['status','priority','signal','stage'].includes(key) ? label(slice.value) : slice.value)}</button>` : '未选择'}<b>${slice.count}</b> · ${total ? (slice.count / total * 100).toFixed(1) : 0}%</li>`).join('') || '<li>暂无匹配项目</li>'}</ul>`;
}
function charts(data: Dashboard) {
  element('focus-count').textContent = `当前范围 ${data.focusTotal} 个非结案项目 · 优先级/进度排序 · 展示前 ${data.focus.length} 个`;
  element('focus-projects').innerHTML = data.focus.map(project => `<a class="pp-item" data-project-id="${project.id}" href="project-detail.html?id=${project.id}"><div class="pp-ring" style="--ring-color:var(--p-${project.priority});--ring-deg:${Number(project.progress) * 3.6}deg"><span class="pp-ring-pct">${project.progress}%</span></div><div class="pp-info"><div class="pp-name">${esc(project.name)}</div><div class="pp-meta">${esc(label(project.stage))} · ${esc(label(project.status))}</div></div></a>`).join('') || '<p class="pp-empty">当前范围没有非结案项目</p>';
  const max = Math.max(1, ...data.team.map(member => member.count));
  element('team-load').innerHTML = data.team.map(member => `<div class="team-row"><span>${esc(member.name)}</span><div><i style="width:${member.count / max * 100}%;background:var(--p-${member.count / max >= .85 ? 'high' : member.count / max >= .6 ? 'mid' : 'low'})"></i></div><b>${member.count}</b></div>`).join('') || '<p class="pp-empty">暂无业务人员资料</p>';
  element('latest-status').innerHTML = data.latest.map(project => `<a data-project-id="${project.id}" href="project-detail.html?id=${project.id}" class="latest-row"><b>${esc(project.name)}</b><span>${esc(project.statusDesc || '暂无状态说明')}</span><small>项目更新：${esc(new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(project.updatedAt)))}</small></a>`).join('') || '<p class="pp-empty">暂无匹配项目</p>';
  distribution();
}

function filters(options: List['options']) {
  options.stage = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'completed', 'unconfigured'];
  options.progress = ['0', '5', '10', '20', '60', '80', '90', '100'];
  options.deadline = ['upcoming', 'due', 'overdue', 'unset', 'closed_on_time', 'closed_late', 'closed_unplanned', 'closed_unknown', 'terminated'];
  filterRows.innerHTML = Object.entries(dimensions).map(([key, title]) => {
    const values = options[key] ?? [];
    const selected = query.get(key) ?? '';
    const choices = selected && !values.includes(selected) ? [selected, ...values] : values;
    return `<div class="filter-row"><span class="filter-label">${title}</span><button class="chip ${selected ? '' : 'active'}" data-filter="${key}" data-value="">全部</button>${choices.map(value => `<button class="chip ${selected === value ? 'active' : ''}" data-filter="${key}" data-value="${esc(value)}">${esc(key === 'progress' ? value + '%' : ['status', 'priority', 'signal', 'stage', 'deadline'].includes(key) ? label(value) : value)}</button>`).join('')}</div>`;
  }).join('');
}
async function load(active = true) {
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
    const requestQuery = new URLSearchParams(query); requestQuery.delete('layout'); requestQuery.set('dashboard', '1');
    const data = await get<List>('/api/projects?' + requestQuery, controller.signal, active);
    if (current !== generation) return;
    if (!data.dashboard) throw new Error('看板统计尚未读取，请刷新。');
    currentData = data; pagination = data.pagination;
    query.set('page', String(pagination.page));
    history.replaceState(null, '', location.pathname + '?' + query);
    filters(data.options);
    hasResult = true;
    businessDate = data.businessDate;
    const stats = [['total', '当前项目'], ['high', '高优先级'], ['yellow', '黄灯'], ['red', '红灯'], ['checkPending', '本周待检查']];
    element('extra-stats').innerHTML = [['green','绿灯'],['overdue','已超期'],['due','今日到期'],['unset','计划未定'],['checkOverdue','检查逾期'],['checkUpdated','检查后更新']].map(([key,title]) => `<div class="stat"><span class="stat-label">${title}</span><b>${data.stats[key]}</b></div>`).join('');
    element('stats-bar').innerHTML = stats.map(([key, title]) => `<div class="stat"><span class="stat-label">${title}</span><b>${data.stats[key]}</b></div>`).join('');
    renderProjects(); charts(data.dashboard);
    element('result-count').textContent = `筛选结果 ${pagination.total} 条 · 统计条与筛选结果一致 · 截至 ${businessDate}`;
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
  for (const key of [...query.keys()]) if (key !== 'view' && key !== 'layout') query.delete(key);
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
element('clear').onclick = () => { clearTimeout(searchTimer); for (const key of [...query.keys()]) if (key !== 'view' && key !== 'layout') query.delete(key); search.value = ''; void load(); };
element('previous').onclick = () => { if (pagination) { query.set('page', String(pagination.page - 1)); void load(); } };
element('next').onclick = () => { if (pagination) { query.set('page', String(pagination.page + 1)); void load(); } };
element('filter-toggle').onclick = () => { filterRows.hidden = !filterRows.hidden; element('filter-toggle').setAttribute('aria-expanded', String(!filterRows.hidden)); };
element('distribution').onchange = distribution;
element('distribution-chart').onclick = event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]'); if (button) change(button.dataset.filter!, button.dataset.value!); };
element('layout-toggle').onclick = () => { query.get('layout') === 'progress' ? query.delete('layout') : query.set('layout', 'progress'); history.replaceState(null, '', location.pathname + '?' + query); renderProjects(); };
document.addEventListener('click', event => {
  if ((event.target as HTMLElement).closest('[data-project-id]')) {
    try { sessionStorage.setItem('geekdash_board_return', JSON.stringify({ url: location.href, scrollY: scrollY })); } catch { /* 无浏览器存储时可正常跳转。 */ }
  }
});
window.addEventListener('focus', () => { if (hasResult) void load(); });
setInterval(() => { if (hasResult && document.visibilityState === 'visible' && businessDate !== new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())) void load(false); }, 60000);
void import('./shared/api').then(async ({ requireIdentity }) => { await requireIdentity();  await load(); }).catch(error => {
  element('message').textContent = (error as Error).message;
  const link = document.createElement('a'); link.href = '/login.html'; link.textContent = '登录 GeekDash'; element('message').append(' ', link);
});
