import './shared/board.css';
import './shared/read.css';
import './shared/board-page.css';
import { get, esc, label, applyCompany, setupTheme, setupDateZone, appearance, account, type Dashboard, type List, type ListProject } from './shared/api';
import { PersonalPreference } from './shared/personal-state';
import { ProjectNotifications } from './shared/notifications';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const search = element<HTMLInputElement>('search');
const message = element<HTMLParagraphElement>('message');
const filterRows = element<HTMLDivElement>('filter-rows');
const query = new URLSearchParams(location.search);
const explicitQuery=location.search.length>1;
let preference:PersonalPreference|undefined;
let restoredScroll:number|undefined;
let scrollTimer:ReturnType<typeof setTimeout>|undefined;
query.set('view', ['active', 'proposal', 'closed', 'maintenance', 'all'].includes(query.get('view') ?? '') ? query.get('view')! : 'active');
const dimensions = { customer: '客户', productLine: '产品线', odmFactory: 'ODM 工厂', app: '配套 APP', status: '状态', priority: '优先级', signal: '信号灯', stage: '项目阶段', progress: '进度', chip: '芯片', tags: '项目标签', group: '分组', owner: '负责人', deadline: '计划结果' };
const allowed = new Set(['view', 'search', 'page', 'layout', ...Object.keys(dimensions)]);
for (const key of [...query.keys()]) if (!allowed.has(key)) query.delete(key);
let controller: AbortController | undefined;
let generation = 0;
let pagination: List['pagination'] | undefined;
let hasResult = false;
let businessDate = '';
let currentData: List | undefined;
let readingNotice = '';
function feedback(text: string) { message.textContent = readingNotice + text; }
setupTheme(); setupDateZone();
search.value = query.get('search') ?? '';
filterRows.hidden=true;
filterToggle();

function filterToggle() {
  element('filter-toggle').setAttribute('aria-expanded', String(!filterRows.hidden));
  element('filter-toggle').textContent = filterRows.hidden ? '▸ 展开筛选' : '▾ 收起筛选';
}
function remember(){preference?.update({view:query.get('view'),page:Number(query.get('page') ?? 1),filters:Object.fromEntries([...query].filter(([key])=>key==='search' || Object.hasOwn(dimensions,key))),filtersOpen:!filterRows.hidden,scrollY:window.scrollY});}
function filterValue(key: string, value: string) {
  const deadlineNames: Record<string, string> = { upcoming: '未到期', due: '今日到期', overdue: '已超期', unset: '计划未定', closed_on_time: '按期结案', closed_late: '超期结案', closed_unplanned: '无计划结案', closed_unknown: '结案日期待核对', terminated: '终止结案' };
  return currentData?.optionLabels?.[key]?.[value] ?? (key === 'deadline' ? deadlineNames[value] ?? value : key === 'progress' ? value + '%' : ['status', 'priority', 'signal', 'stage'].includes(key) ? label(value) : value);
}
function selectedFilters() {
  const selected = [['search', '搜索'], ...Object.entries(dimensions)].filter(([key]) => query.get(key)).map(([key, title]) => ({ key, text: `${title}：${filterValue(key, query.get(key)!)}` }));
  element('selected-filters').hidden = !selected.length;
  element('selected-filters').innerHTML = selected.map(item => `<button class="chip active" data-remove-filter="${item.key}" aria-label="取消${esc(item.text)}">${esc(item.text)} <span aria-hidden="true">×</span></button>`).join('');
  return selected.map(item => item.text);
}
function card(project: ListProject) {
  const stageName = (project.status === 'paused' ? '暂缓保留 · ' : '') + (project.stage === 'completed' ? '七阶段全部完成' : label(project.stage) + ' · ' + (project.status === 'proposal' && project.stage !== 'S1' ? '需先启动项目' : label(project.stageState)));
  const people = [['pm', '项目经理'], ['hardware_owner', '硬件'], ['software_owner', '软件']].map(([role, title]) => `<span><em>${title}</em>${esc((role === 'pm' ? project.managers : project.people.filter(person => person.role === role)).map(person => person.name).join('、') || '未分配')}</span>`).join('');
  const materials = [project.chips.map(chip => chip.name).join(' / '), project.odmFactory, project.app].filter(Boolean).join(' · ');
  return `<a class="card ${project.priority === 'high' ? 'pri-border-high' : ''}" href="project-detail.html?id=${project.id}" data-project-id="${project.id}">
    <div class="card-top"><span class="board-signal signal-${esc(project.signal)}">${esc(label(project.signal))}</span><span>${esc(label(project.priority))}优先级 · ${esc(label(project.status))}</span></div>
    <h3 class="card-name">${esc(project.name)}</h3><p class="board-card-meta">${esc([project.customer || '未选择客户', project.productLine].filter(Boolean).join(' · '))}</p>${materials ? `<p class="board-card-materials">${esc(materials)}</p>` : ''}
    <div class="board-card-dates"><div><span>预计结案</span><strong>${esc(project.dueDate || '计划未定')}</strong></div><div><span>项目阶段</span><strong>${esc(stageName)}</strong></div></div>
    <div class="board-card-progress"><div class="stage-bar-track"><div class="stage-bar-fill" style="width:${Number(project.progress)}%"></div></div><span>${project.progress}%</span></div>
    <div class="board-card-people">${people}</div>${project.summaryNote ? `<div class="card-desc">${esc(project.summaryNote)}</div>` : ''}
    <div class="board-card-status"><span>最新状态说明</span><p>${esc(project.statusDesc || '暂无最新状态说明')}</p></div>
    <div class="board-card-footer"><span class="${project.checkedToday ? 'checked-today' : ''}" title="${esc(project.checkStatus.label + (project.checkStatus.updatedAfterCheck ? ' · 检查后有更新' : ''))}">${project.checkedToday ? '✓ 今日已检查' : '○ 今日未检查'}</span><span>查看详情 ↗</span></div></a>`;
}
function renderProjects() {
  if (!currentData) return;
  const progress = query.get('layout') === 'progress';
  element('card-grid').classList.toggle('progress-layout', progress);
  element('card-grid').innerHTML = currentData.items.map(card).join('');
  element('cards-view').hidden = progress; element('dashboard-view').hidden = !progress;
  for (const [id, active] of [['layout-cards', !progress], ['layout-toggle', progress]] as const) { element(id).classList.toggle('active', active); element(id).setAttribute('aria-pressed', String(active)); }
}
function distribution() {
  if (!currentData?.dashboard) return;
  const key = element<HTMLSelectElement>('distribution').value, slices = currentData.dashboard.distributions[key];
  const colors = ['#58a6ff', '#f0883e', '#39c5cf', '#a371f7', '#3fb950', '#f85149'];
  const max = Math.max(1, ...slices.map(slice => slice.count));
  element('distribution-chart').innerHTML = `<ul class="board-distribution">${slices.map((slice, i) => `<li>${slice.value ? `<button class="legend-filter" data-filter="${key}" data-value="${esc(slice.value)}">${esc(['status','priority','signal','stage'].includes(key) ? label(slice.value) : slice.value)}</button>` : '<span>未选择</span>'}<span class="board-distribution-track" aria-hidden="true"><i style="width:${slice.count / max * 100}%;background:${colors[i % colors.length]}"></i></span><b>${slice.count}</b></li>`).join('') || '<li>暂无匹配项目</li>'}</ul>`;
}
function charts(data: Dashboard) {
  element('focus-count').textContent = `当前范围 ${data.focusTotal} 个项目 · 优先级/进度排序 · 展示前 ${data.focus.length} 个`;
  element('focus-projects').innerHTML = data.focus.map(project => `<a class="pp-item" data-project-id="${project.id}" href="project-detail.html?id=${project.id}"><div class="pp-info"><div class="pp-name">${esc(project.name)}</div><div class="pp-meta">${esc(label(project.stage))} · ${esc(label(project.status))}</div></div><div class="board-focus-progress"><div class="stage-bar-track"><div class="stage-bar-fill" style="width:${Number(project.progress)}%"></div></div><span>${project.progress}%</span></div></a>`).join('') || '<p class="pp-empty">当前范围没有匹配项目</p>';
  element('team-load').innerHTML = data.team.length ? `<table class="read-table"><thead><tr><th>成员</th><th>项目经理</th><th>硬件</th><th>软件</th><th>项目总数</th></tr></thead><tbody>${data.team.map(member => `<tr><th scope="row">${esc(member.name)}</th><td>${member.pmCount}</td><td>${member.hardwareCount}</td><td>${member.softwareCount}</td><td>${member.count}</td></tr>`).join('')}</tbody></table>` : '<p class="pp-empty">暂无业务人员资料</p>';
  element('latest-status').innerHTML = data.latest.length ? `<div class="read-table-wrap"><table class="read-table"><thead><tr><th>项目</th><th>最新状态说明</th><th>更新时间</th></tr></thead><tbody>${data.latest.map(project => `<tr><th scope="row"><a data-project-id="${project.id}" href="project-detail.html?id=${project.id}">${esc(project.name)}</a></th><td>${esc(project.statusDesc || '暂无状态说明')}</td><td>${esc(new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(project.updatedAt)))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="pp-empty">暂无匹配项目</p>';
  distribution();
}

function filters(options: List['options'], labels: List['optionLabels']) {
  options.stage = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'completed', 'unconfigured'];
  options.progress = ['0', '5', '10', '20', '60', '80', '90', '100'];
  options.deadline = ['upcoming', 'due', 'overdue', 'unset', 'closed_on_time', 'closed_late', 'closed_unplanned', 'closed_unknown', 'terminated'];
  filterRows.innerHTML = Object.entries(dimensions).map(([key, title]) => {
    const values = options[key] ?? [];
    const selected = query.get(key) ?? '';
    const choices = selected && !values.includes(selected) ? [selected, ...values] : values;
    return `<div class="filter-row" role="group" aria-label="${title}"><span class="filter-label">${title}</span><button class="chip ${selected ? '' : 'active'}" aria-pressed="${!selected}" data-filter="${key}" data-value="">全部</button>${choices.map(value => `<button class="chip ${selected === value ? 'active' : ''}" aria-pressed="${selected === value}" data-filter="${key}" data-value="${esc(value)}">${esc(labels?.[key]?.[value] ?? filterValue(key, value))}</button>`).join('')}</div>`;
  }).join('');
}
async function load(active = true) {
  freezeCheckEntry();
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
    const requestedPage = Number(requestQuery.get('page') ?? 1);
    const data = await get<List>('/api/projects?' + requestQuery, controller.signal, active);
    if (current !== generation) return;
    if (!data.dashboard) throw new Error('看板统计尚未读取，请刷新。');
    currentData = data; pagination = data.pagination;applyCompany(data.company);
    query.set('page', String(pagination.page));
    history.replaceState(null, '', location.pathname + '?' + query);
    filters(data.options, data.optionLabels);
    hasResult = true;
    businessDate = data.businessDate;
    const stats = [['total', '当前项目'], ['high', '高优先级'], ['yellow', '黄灯'], ['red', '红灯'], ['checkPending', '本周待检查']];
    const stat=([key,title]:string[])=>`<button class="stat quick-stat" data-quick="${key}" data-title="${title}"><span class="stat-label">${title}</span><b>${data.stats[key]}</b></button>`;
    element('extra-stats').innerHTML = [['green','绿灯'],['overdue','已超期'],['due','今日到期'],['unset','计划未定'],['checkOverdue','检查逾期'],['checkUpdated','检查后更新']].map(stat).join('');
    element('stats-bar').innerHTML = stats.map(stat).join('');
    renderProjects(); charts(data.dashboard);
    const selected = selectedFilters();
    element('result-count').textContent = `共 ${pagination.total} 个项目 · 截至 ${businessDate}`;
    element('result-count').title = selected.join(' · ') || '未设置筛选';
    element('today-check-count').textContent = `当前范围今天还有 ${data.stats.todayUnchecked} 个项目未检查`;
    const checkQuery = new URLSearchParams(query); checkQuery.delete('layout'); checkQuery.delete('page'); checkQuery.set('checkToday', 'unchecked');
    element<HTMLAnchorElement>('check-entry').href = '/project-checks.html?' + checkQuery;
    element('check-entry').removeAttribute('aria-disabled');
    element('page-info').textContent = `${pagination.page} / ${pagination.pageCount} 页`;
    previous.disabled = pagination.page <= 1;
    next.disabled = pagination.page >= pagination.pageCount;
    readingNotice = pagination.page !== requestedPage ? `原第 ${requestedPage} 页已不可用，已显示第 ${pagination.page} 页。` : '';
    feedback(pagination.total ? '' : '暂无符合条件的项目。');
    element('card-grid').setAttribute('aria-busy', 'false');
    if(restoredScroll!==undefined){window.scrollTo(0,restoredScroll);restoredScroll=undefined;}
    try {
      const returnKey='geekdash_board_return:'+account!.id;
      const saved = JSON.parse(sessionStorage.getItem(returnKey) ?? 'null');
      if (saved?.url === location.href) { window.scrollTo(0, saved.scrollY); sessionStorage.removeItem(returnKey); }
    } catch { /* 状态恢复不影响正式查询。 */ }
  } catch (error) {
    if (current !== generation) return;
    message.classList.add('error');
    message.textContent = (error as Error).message + (hasResult ? ' 当前显示保留的旧结果，尚未刷新。' : '');
    element('today-check-count').textContent = '当前范围读取失败，请刷新后进入检查';
    element('card-grid').setAttribute('aria-busy', 'false');
  }
}
function change(key: string, value: string) { value ? query.set(key, value) : query.delete(key); query.delete('page'); remember();void load(); }
function freezeCheckEntry() { document.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach(button=>button.disabled=true);element('check-entry').removeAttribute('href'); element('check-entry').setAttribute('aria-disabled', 'true'); element('today-check-count').textContent = '正在读取当前范围的检查情况…'; }

document.addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-quick]');
  if(!button || button.disabled || !account)return;
  const ids=currentData?.quickRanges?.[button.dataset.quick!];if(!ids){message.textContent='当前统计范围尚未读取，请刷新后重试。';return;}
  const key=crypto.randomUUID();
  try{sessionStorage.setItem(`geekdash_quick:${account.id}:${key}`,JSON.stringify({ids,title:button.dataset.title,sourceUrl:location.pathname+location.search}));}
  catch{message.textContent='无法保留当前范围，请重试或从项目状态简要选择项目。';return;}
  location.href='/project-status-summary.html?quick='+key;
});
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => button.onclick = () => {
  for (const key of [...query.keys()]) if (key !== 'view' && key !== 'layout') query.delete(key);
  search.value = '';
  change('view', button.dataset.view!);
});
filterRows.onclick = event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]');
  if (button) change(button.dataset.filter!, query.get(button.dataset.filter!) === button.dataset.value ? '' : button.dataset.value!);
};
let searchTimer: ReturnType<typeof setTimeout>;
search.oninput = () => { clearTimeout(searchTimer); controller?.abort(); generation++; freezeCheckEntry(); searchTimer = setTimeout(() => change('search', search.value), 200); };
element('reload').onclick = () => { clearTimeout(searchTimer); search.value ? query.set('search', search.value) : query.delete('search'); remember();void load(); };
element('clear').onclick = () => { clearTimeout(searchTimer); for (const key of [...query.keys()]) if (key !== 'view' && key !== 'layout') query.delete(key); search.value = ''; remember();void load(); };
element('previous').onclick = () => { if (pagination) { query.set('page', String(pagination.page - 1)); remember();void load(); } };
element('next').onclick = () => { if (pagination) { query.set('page', String(pagination.page + 1)); remember();void load(); } };
element('filter-toggle').onclick = () => { filterRows.hidden = !filterRows.hidden; filterToggle();remember(); };
element('selected-filters').onclick = event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-filter]'); if (button) { clearTimeout(searchTimer); if (button.dataset.removeFilter === 'search') search.value = ''; change(button.dataset.removeFilter!, ''); } };
element('distribution').onchange = distribution;
element('distribution-chart').onclick = event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]'); if (button) change(button.dataset.filter!, button.dataset.value!); };
element('layout-toggle').onclick = () => { query.set('layout', 'progress');appearance?.update({layout:'progress'}); history.replaceState(null, '', location.pathname + '?' + query); renderProjects(); };
element('layout-cards').onclick = () => { query.delete('layout');appearance?.update({layout:'cards'}); history.replaceState(null, '', location.pathname + '?' + query); renderProjects(); };
document.addEventListener('click', event => {
  if ((event.target as HTMLElement).closest('[data-project-id],#check-entry')) {
    try { if(account)sessionStorage.setItem('geekdash_board_return:'+account.id, JSON.stringify({ url: location.href, scrollY: scrollY })); } catch { /* 无浏览器存储时可正常跳转。 */ }
  }
});
window.addEventListener('focus', () => { if (hasResult) void load(); });
window.addEventListener('scroll',()=>{if(!hasResult || scrollTimer)return;scrollTimer=setTimeout(()=>{scrollTimer=undefined;remember();},2000);},{passive:true});
window.addEventListener('pagehide',()=>{remember();void preference?.flush();});
document.addEventListener('geekdash-preference-status',event=>{feedback((event as CustomEvent<string>).detail);});
setInterval(() => { if (hasResult && document.visibilityState === 'visible' && businessDate !== new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())) void load(false); }, 60000);
void import('./shared/api').then(async ({ requireIdentity }) => {
  await requireIdentity();preference=new PersonalPreference('board',feedback);const saved=await preference.load();
  if(!explicitQuery){if(typeof saved.view==='string')query.set('view',saved.view);if(typeof saved.page==='number')query.set('page',String(saved.page));for(const [key,value] of Object.entries(saved.filters ?? {}))if(allowed.has(key) && typeof value==='string')query.set(key,value);restoredScroll=typeof saved.scrollY==='number'?saved.scrollY:undefined;}
  if(!query.has('layout') && appearance?.current().layout==='progress')query.set('layout','progress');
  filterRows.hidden=saved.filtersOpen!==true;filterToggle();search.value=query.get('search') ?? '';await load();
  new ProjectNotifications(()=>{void load(false);},()=>{void load(false);},text=>{if(text)feedback(text);},undefined,undefined,()=>{void load(false);});
}).catch(error => {
  element('message').textContent = (error as Error).message;
  const link = document.createElement('a'); link.href = '/login.html'; link.textContent = '登录 GeekDash'; element('message').append(' ', link);
});
