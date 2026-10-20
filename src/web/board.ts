import './shared/board.css';
import './shared/read.css';
import './shared/board-page.css';
import { get, send, SaveError, esc, label, applyCompany, setupTheme, setupDateZone, appearance, account, loginUrl, type Dashboard, type List, type ListProject, type Detail, type SaveRequest, type SaveResult } from './shared/api';
import { PersonalPreference, PersonalDrafts } from './shared/personal-state';
import { ProjectNotifications, editorBadges, type EditingPresence } from './shared/notifications';
import { attachStatusMentions } from './shared/status-mentions';
import { statusHtml } from './shared/status-text';

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
type StatusEdit={id:string;value:string;base:string;version:string;pending?:SaveRequest;committed?:SaveResult;busy?:boolean;cancelling?:boolean;stale?:boolean;message?:string};
const statusEdits=new Map<string,StatusEdit>(),statusDrafts=new Map<string,PersonalDrafts>(),editors=new Map<string,EditingPresence['users']>();
let activeStatus:string|undefined,notifications:ProjectNotifications|undefined,frozen=false,composingStatus=false,renderStatusPending=false;
let mentionPeople:{name:string}[]|undefined,mentionLoading:Promise<void>|undefined;
const statusCache=()=>`geekdash_page:${account!.id}:board-status`;
const currentProject=(id:string)=>currentData?.items.find(project=>project.id===id);
const canEditStatus=(project:ListProject|undefined)=>!frozen && !!project?.managers.some(person=>person.id===account?.id && !!person.enabled);
function preserveStatus(){if(!account)return;try{sessionStorage.setItem(statusCache(),JSON.stringify([...statusEdits.values()].map(edit=>({...edit,busy:false,cancelling:false}))));}catch{feedback('状态输入未能保留到本机，请保持页面打开或先复制。');}}
function updateEditing(){notifications?.setEditing(!!activeStatus && canEditStatus(currentProject(activeStatus)) && !statusEdits.get(activeStatus)?.stale,activeStatus);}
function drafts(id:string){
  let store=statusDrafts.get(id);if(store)return store;
  store=new PersonalDrafts(id,()=>({version:currentProject(id)?.version ?? null,editable:canEditStatus(currentProject(id)) && !statusEdits.get(id)?.stale}),row=>{
    const current=currentProject(id),edit=statusEdits.get(id),value=row.payload.values?.statusDesc;
    if(row.formKind!=='status' || typeof value!=='string' || !current || !canEditStatus(current) || row.baseVersion!==current.version || edit?.pending || edit?.busy || edit && edit.value!==edit.base)return false;
    const next={id,value,base:current.statusDesc,version:current.version};statusEdits.set(id,next);activeStatus=id;captureStatus(next);preserveStatus();renderProjects();return true;
  },{button:false,kinds:['status']});statusDrafts.set(id,store);return store;
}
function captureStatus(edit:StatusEdit){if(!frozen && edit.value!==edit.base && !edit.pending && !edit.stale)drafts(edit.id).capture('status',undefined,edit.version,{values:{statusDesc:edit.value},submission:{scope:'status',changes:{statusDesc:edit.value}}});}
function clearEditors(){editors.clear();document.querySelectorAll('[data-project-editors]').forEach(node=>node.replaceChildren());}
async function loadMentionPeople(){
  if(mentionLoading)return mentionLoading;
  mentionLoading=(async()=>{try{const data=await get<{engineers:{name:string;enabled:number}[]}>('/api/project-options',undefined,false);mentionPeople=data.engineers.filter(person=>!!person.enabled);const input=document.activeElement;if(input instanceof HTMLTextAreaElement && input.matches('[data-status-input]'))input.dispatchEvent(new Event('input',{bubbles:true})); }catch{mentionPeople=[];}finally{mentionLoading=undefined;}})();
  return mentionLoading;
}
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
  return `<article class="card ${project.priority === 'high' ? 'pri-border-high' : ''}" data-project-id="${project.id}">
    <div class="card-top"><span class="board-signal signal-${esc(project.signal)}">${esc(label(project.signal))}</span><span>${esc(label(project.priority))}优先级 · ${esc(label(project.status))}</span></div>
    <h3 class="card-name"><a href="project-detail.html?id=${project.id}">${esc(project.name)}</a></h3>${project.summary ? `<div class="card-desc">${esc(project.summary)}</div>` : ''}<p class="board-card-meta">${esc([project.customer || '未选择客户', project.productLine].filter(Boolean).join(' · '))}</p>${materials ? `<p class="board-card-materials">${esc(materials)}</p>` : ''}
    <div class="board-card-dates"><div><span>预计结案</span><strong>${esc(project.dueDate || '计划未定')}</strong></div><div><span>项目阶段</span><strong>${esc(stageName)}</strong></div></div>
    <div class="board-card-progress"><div class="stage-bar-track"><div class="stage-bar-fill" style="width:${Number(project.progress)}%"></div></div><span>${project.progress}%</span></div>
    <div class="board-card-people">${people}</div>
    <div class="board-card-status"><div class="board-status-heading"><span>最新状态说明</span><span data-project-editors="${project.id}">${editorBadges(editors.get(project.id) ?? [])}</span></div>${statusContent(project)}</div>
    <div class="board-card-footer"><span class="${project.checkedToday ? 'checked-today' : ''}" title="${esc(project.checkStatus.label + (project.checkStatus.updatedAfterCheck ? ' · 检查后有更新' : ''))}">${project.checkedToday ? '✓ 今日已检查' : '○ 今日未检查'}</span><a href="project-detail.html?id=${project.id}">查看详情 ↗</a></div></article>`;
}
function statusContent(project:ListProject){
  const edit=statusEdits.get(project.id),editable=canEditStatus(project),stale=!!edit && (edit.stale || edit.version!==project.version || !editable);
  const notice=frozen?(edit?.committed?'状态已保存，无需重新保存。请重新登录后读取结果，输入保留供复制。':'账号状态已改变，输入和原保存请求保留，请重新登录。'):edit?.committed?edit.message ?? '状态已保存，正在读取正式内容。':stale?'项目已被他人更新，请重新进入项目。未保存文字保留供复制。':edit?.message ?? '';
  if(edit && activeStatus===project.id)return `<textarea data-status-input="${project.id}" aria-label="${esc(project.name)}最新状态说明" rows="5" ${frozen || stale || edit.cancelling?'readonly':''}>${esc(edit.value)}</textarea><p class="board-status-feedback" role="status">${esc(notice)}</p><div class="board-status-actions">${edit.committed?`<button data-status-action="query" ${edit.busy || frozen?'disabled':''}>读取已保存结果</button>`:edit.pending?`<button data-status-action="query" ${edit.busy || frozen?'disabled':''}>核对原保存结果</button><button data-status-action="retry" ${edit.busy || frozen?'disabled':''}>重试原保存</button>`:`<button data-status-action="save" ${edit.busy || frozen || stale?'disabled':''}>保存状态</button><button data-status-action="cancel" ${edit.busy || frozen?'disabled':''}>取消修改</button><button data-status-action="drafts" ${edit.busy || frozen?'disabled':''}>个人草稿</button>`}${stale || frozen?`<button data-status-action="copy">复制输入</button><a href="project-detail.html?id=${project.id}">重新进入项目</a>`:''}</div>`;
  return `<div class="board-status-lines">${project.statusDesc?statusHtml(project):'<p>暂无最新状态说明</p>'}</div>${editable || edit?`<button data-status-action="edit" ${frozen?'disabled':''}>${edit?'继续编辑':'更新状态'}</button>`:''}`;
}
function renderProjects() {
  if (!currentData) return;
  if(composingStatus){renderStatusPending=true;return;}renderStatusPending=false;
  const input=document.activeElement instanceof HTMLTextAreaElement && document.activeElement.matches('[data-status-input]')?document.activeElement:undefined,focus=input?{id:input.dataset.statusInput,start:input.selectionStart,end:input.selectionEnd,scrollTop:input.scrollTop}:undefined;
  const progress = query.get('layout') === 'progress';
  element('card-grid').classList.toggle('progress-layout', progress);
  element('card-grid').innerHTML = currentData.items.map(card).join('');
  document.querySelectorAll<HTMLTextAreaElement>('[data-status-input]').forEach(input=>attachStatusMentions(input,()=>mentionPeople ?? []));
  if(focus){const input=document.querySelector<HTMLTextAreaElement>(`[data-status-input="${focus.id}"]`);if(input){input.focus({preventScroll:true});input.setSelectionRange(focus.start,focus.end);input.scrollTop=focus.scrollTop;}}
  element('cards-view').hidden = progress; element('dashboard-view').hidden = !progress;
  for (const [id, active] of [['layout-cards', !progress], ['layout-toggle', progress]] as const) { element(id).classList.toggle('active', active); element(id).setAttribute('aria-pressed', String(active)); }
  updateEditing();
}
async function saveStatus(edit:StatusEdit,queryResult=false){
  if(edit.busy || frozen)return;
  const project=currentProject(edit.id);
  if(!edit.pending && (!canEditStatus(project) || edit.stale || project?.version!==edit.version)){edit.stale=true;renderProjects();return;}
  if(!edit.pending && edit.value===edit.base){await cancelStatus(edit);return;}
  edit.busy=true;edit.message=queryResult?'正在核对原保存结果…':'正在保存…';renderProjects();
  try{
    if(!edit.pending){
      const original:SaveRequest={expectedVersion:edit.version,idempotencyKey:crypto.randomUUID(),scope:'status',changes:{statusDesc:edit.value}};
      captureStatus(edit);const ref=await drafts(edit.id).prepare('status');if(ref && edit.value===original.changes.statusDesc)original.draft=ref;
      edit.pending=original;preserveStatus();
    }
    const original=edit.pending;
    if(!edit.committed){
      let response:{outcome:string;result?:SaveResult};
      try{response=await send(`/api/projects/${edit.id}${queryResult?'/save-results/query':''}`,queryResult?'POST':'PATCH',original,!queryResult);}
      catch(error){
        if(!queryResult && error instanceof SaveError && error.outcome==='not_committed' && !['OPERATION_KEY_REUSED','AUTH_REQUIRED','AUTH_CONTEXT_CHANGED','PASSWORD_CHANGE_REQUIRED','CSRF_INVALID'].includes(error.code)){
          edit.pending=undefined;if(['PROJECT_VERSION_CONFLICT','PROJECT_READ_ONLY'].includes(error.code)){edit.stale=true;void load(false);}
        }
        throw error;
      }
      if(response.outcome!=='committed' || !response.result){edit.message='尚未查到原保存结果，输入与原请求保留，可再次核对或重试原保存。';return;}
      edit.committed=response.result;preserveStatus();
    }
    const result=edit.committed;
    const fresh=await get<Detail>('/api/projects/'+edit.id,undefined,false);
    if(frozen)return;
    edit.base=String(original.changes.statusDesc ?? '');edit.version=result.savedVersion;edit.pending=undefined;edit.committed=undefined;
    edit.stale=fresh.project.version!==result.savedVersion || !fresh.capabilities.editOrdinary;
    await drafts(edit.id).advance(result,{kind:'status'});
    const displayed=currentProject(edit.id);if(displayed)Object.assign(displayed,fresh.project);
    if(edit.value===edit.base){statusEdits.delete(edit.id);if(activeStatus===edit.id)activeStatus=undefined;}
    else edit.message='上次提交已保存，后来输入仍待保存。';
    preserveStatus();renderProjects();
    if(await load(false))feedback('状态已保存。');
  }catch(error){
    edit.message=edit.committed?'状态已保存，正式内容暂未读回，无需重新保存；输入和原结果已保留。':error instanceof SaveError?error.fields?.statusDesc ?? error.message:(error as Error).message;
    if(error instanceof SaveError && ['AUTH_REQUIRED','AUTH_CONTEXT_CHANGED','PASSWORD_CHANGE_REQUIRED','CSRF_INVALID'].includes(error.code))document.dispatchEvent(new Event('geekdash-identity-changed'));
  }finally{edit.busy=false;if(statusEdits.has(edit.id))captureStatus(edit);preserveStatus();renderProjects();}
}
async function cancelStatus(edit:StatusEdit){
  if(edit.pending || edit.busy || frozen)return;
  edit.busy=true;edit.cancelling=true;renderProjects();
  try{await drafts(edit.id).discard('status');statusEdits.delete(edit.id);if(activeStatus===edit.id)activeStatus=undefined;}
  catch(error){edit.message=(error as Error).message;}
  finally{edit.busy=false;edit.cancelling=false;preserveStatus();renderProjects();}
}
element('card-grid').addEventListener('input',event=>{
  const input=event.target as HTMLTextAreaElement,id=input.dataset.statusInput,edit=id?statusEdits.get(id):undefined;
  if(!edit)return;
  edit.value=input.value;captureStatus(edit);preserveStatus();updateEditing();
});
element('card-grid').addEventListener('compositionstart',event=>{if((event.target as HTMLElement).matches('[data-status-input]'))composingStatus=true;});
element('card-grid').addEventListener('compositionend',()=>{composingStatus=false;if(renderStatusPending)queueMicrotask(renderProjects);});
element('card-grid').addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-status-action]'),id=button?.closest<HTMLElement>('[data-project-id]')?.dataset.projectId;
  if(!button || !id || button.disabled)return;
  let edit=statusEdits.get(id);
  if(button.dataset.statusAction==='edit'){
    const project=currentProject(id);if(!project || frozen || !edit && !canEditStatus(project))return;
    if(!edit){edit={id,value:project.statusDesc,base:project.statusDesc,version:project.version};statusEdits.set(id,edit);}
    activeStatus=id;preserveStatus();renderProjects();document.querySelector<HTMLTextAreaElement>(`[data-status-input="${id}"]`)?.focus({preventScroll:true});
    if(!mentionPeople)void loadMentionPeople();
    if(!edit.pending && edit.value===edit.base)void drafts(id).offer();
  }else if(edit){
    if(button.dataset.statusAction==='cancel')void cancelStatus(edit);
    else if(button.dataset.statusAction==='drafts')void drafts(id).open();
    else if(button.dataset.statusAction==='copy'){
      const input=document.querySelector<HTMLTextAreaElement>(`[data-status-input="${id}"]`);input?.focus();input?.select();
      void navigator.clipboard?.writeText(edit.value).then(()=>feedback('输入已复制。')).catch(()=>feedback('请复制当前已选中的输入。'));
    }else void saveStatus(edit,button.dataset.statusAction==='query');
  }
});
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
    if(frozen)return false;
    currentData = data; pagination = data.pagination;applyCompany(data.company);
    for(const project of data.items){const edit=statusEdits.get(project.id);if(edit && !edit.pending && (edit.version!==project.version || !canEditStatus(project)))edit.stale=true;}
    query.set('page', String(pagination.page));
    history.replaceState(null, '', location.pathname + '?' + query);
    filters(data.options, data.optionLabels);
    hasResult = true;
    businessDate = data.businessDate;
    const stats = [['total', '当前项目'], ['high', '高优先级'], ['yellow', '黄灯'], ['red', '红灯'], ['todayUnchecked', '今日未检查']];
    const stat=([key,title]:string[])=>`<button class="stat quick-stat" data-quick="${key}" data-title="${title}"><span class="stat-label">${title}</span><b>${data.stats[key]}</b></button>`;
    element('extra-stats').innerHTML = [['green','绿灯'],['overdue','已超期'],['due','今日到期'],['unset','计划未定'],['checkUpdated','检查后更新']].map(stat).join('');
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
    return true;
  } catch (error) {
    if (current !== generation) return;
    message.classList.add('error');
    message.textContent = (error as Error).message + (hasResult ? ' 当前显示保留的旧结果，尚未刷新。' : '');
    element('today-check-count').textContent = '当前范围读取失败，请刷新后进入检查';
    element('card-grid').setAttribute('aria-busy', 'false');
    return false;
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
  if ((event.target as HTMLElement).closest('a')?.closest('[data-project-id],#check-entry')) {
    try { if(account)sessionStorage.setItem('geekdash_board_return:'+account.id, JSON.stringify({ url: location.href, scrollY: scrollY })); } catch { /* 无浏览器存储时可正常跳转。 */ }
  }
});
window.addEventListener('focus', () => { if (hasResult) void load(); });
window.addEventListener('scroll',()=>{if(!hasResult || scrollTimer)return;scrollTimer=setTimeout(()=>{scrollTimer=undefined;remember();},2000);},{passive:true});
window.addEventListener('pagehide',()=>{remember();void preference?.flush();});
window.addEventListener('beforeunload',event=>{if([...statusEdits.values()].some(edit=>edit.pending || edit.value!==edit.base)){event.preventDefault();event.returnValue='';}});
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;generation++;controller?.abort();notifications?.setEditing(false);clearEditors();renderProjects();feedback('账号状态已改变，状态输入保留供复制，请重新登录。');});
document.addEventListener('geekdash-preference-status',event=>{feedback((event as CustomEvent<string>).detail);});
setInterval(() => { if (hasResult && document.visibilityState === 'visible' && businessDate !== new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())) void load(false); }, 60000);
void import('./shared/api').then(async ({ requireIdentity }) => {
  await requireIdentity();preference=new PersonalPreference('board',feedback);const saved=await preference.load();
  try{const cached=JSON.parse(sessionStorage.getItem(statusCache()) ?? '[]');if(Array.isArray(cached))for(const edit of cached)if(typeof edit.id==='string' && /^[1-9][0-9]*$/.test(edit.id) && typeof edit.value==='string' && typeof edit.base==='string' && typeof edit.version==='string' && (!edit.pending || edit.pending.scope==='status'))statusEdits.set(edit.id,{...edit,busy:false});}catch{}
  if(!explicitQuery){if(typeof saved.view==='string')query.set('view',saved.view);if(typeof saved.page==='number')query.set('page',String(saved.page));for(const [key,value] of Object.entries(saved.filters ?? {}))if(allowed.has(key) && typeof value==='string')query.set(key,value);restoredScroll=typeof saved.scrollY==='number'?saved.scrollY:undefined;}
  if(!query.has('layout') && appearance?.current().layout==='progress')query.set('layout','progress');
  filterRows.hidden=saved.filtersOpen!==true;filterToggle();search.value=query.get('search') ?? '';await load();
  notifications=new ProjectNotifications((event,own)=>{
    const edit=statusEdits.get(event.projectId);if(edit && !own && BigInt(event.version)>BigInt(edit.version)){edit.stale=true;preserveStatus();renderProjects();}
    void load(false);
  },()=>{clearEditors();void load(false);},text=>{if(text){clearEditors();feedback(text);}},undefined,undefined,()=>{mentionPeople=undefined;if(activeStatus)void loadMentionPeople();void load(false);},event=>{
    editors.set(event.projectId,event.users);const target=document.querySelector<HTMLElement>(`[data-project-editors="${event.projectId}"]`);if(target)target.innerHTML=editorBadges(event.users);
  });
  for(const edit of statusEdits.values())if(edit.pending)void saveStatus(edit,true);
}).catch(error => {
  element('message').textContent = (error as Error).message;
  if (!document.getElementById('identity-login')) { const link = document.createElement('a'); link.href = loginUrl(); link.textContent = '登录 GeekDash'; element('message').append(' ', link); }
});
