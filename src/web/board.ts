import { validTaskDraft } from './shared/task-text';
import { taskPanel,putTaskOp,taskCopy,taskText,applyTaskText,confirmTaskDeletes } from './shared/tasks';
import './shared/board.css';
import './shared/read.css';
import './shared/board-page.css';
import { get, send, SaveError, esc, label, checkTime, applyCompany, setupTheme, setupDateZone, appearance, account, loginUrl, type Dashboard, type List, type ListProject, type Detail, type SaveRequest, type SaveResult } from './shared/api';
import { PersonalPreference, PersonalDrafts } from './shared/personal-state';
import { ProjectNotifications, editorBadges, type EditingPresence } from './shared/notifications';
import { attachStatusMentions } from './shared/status-mentions';

declare const __GEEKDASH_STAGES__: { id: number; name: string; milestone: string }[];

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
const dimensions = { customer: '客户', productLine: '产品线', odmFactory: 'ODM 工厂', app: '配套 APP', status: '状态', priority: '优先级', signal: '信号灯', stage: '项目阶段', progress: '进度', chip: '芯片', tags: '项目标签', group: '分组', owner: '项目负责与分工', taskOwner:'任务负责人', deadline: '计划结果' };
const allowed = new Set(['contentFrom','contentTo','view', 'search', 'page', 'layout', ...Object.keys(dimensions)]);
for (const key of [...query.keys()]) if (!allowed.has(key)) query.delete(key);
let controller: AbortController | undefined;
let generation = 0;
let pagination: List['pagination'] | undefined;
let hasResult = false;
let businessDate = '';
let currentData: List | undefined;
let readingNotice = '';
type StatusEdit={taskBulk?:string;ops?:import('./shared/api').TaskOperation[];id:string;value:string;base:string;version:string;pending?:SaveRequest;committed?:SaveResult;busy?:boolean;cancelling?:boolean;stale?:boolean;message?:string};
const changedHere=new Set<string>();
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
    const current=currentProject(id),edit=statusEdits.get(id),value=row.payload.values?.statusDesc,ops=row.payload.values?.taskOps;
    if(row.formKind!=='status' || typeof value!=='string' && !Array.isArray(ops) && !row.payload.editors?.task || !current || !canEditStatus(current) || row.baseVersion!==current.version || edit?.pending || edit?.busy || edit && statusChanged(edit))return false;
    const next:StatusEdit={taskBulk:(row.payload.editors?.task as {text?:string}|undefined)?.text,id,value:typeof value==='string'?value:current.statusDesc,ops:Array.isArray(ops)?ops:[],base:current.statusDesc,version:current.version};statusEdits.set(id,next);activeStatus=id;captureStatus(next);preserveStatus();renderProjects();return true;
  },{button:false,kinds:['status']});statusDrafts.set(id,store);return store;
}
const statusChanged=(edit:StatusEdit)=>edit.value!==edit.base||!!edit.ops?.length||edit.taskBulk!==undefined&&edit.taskBulk!==taskText(taskCopy(currentProject(edit.id)?.tasks??[],edit.ops??[]));
const statusChanges=(edit:StatusEdit)=>edit.ops?.length?{taskOps:edit.ops}:{statusDesc:edit.value};
function captureStatus(edit:StatusEdit){if(!frozen && statusChanged(edit) && !edit.pending && !edit.stale)drafts(edit.id).capture('status',undefined,edit.version,{values:statusChanges(edit),...edit.taskBulk!==undefined?{editors:{task:{text:edit.taskBulk}}}:{},submission:{scope:'status',changes:statusChanges(edit)}});}
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
function remember(){preference?.update({view:query.get('view'),page:Number(query.get('page') ?? 1),filters:Object.fromEntries(['search','contentFrom','contentTo',...Object.keys(dimensions)].filter(key=>query.has(key)).map(key=>[key,['search','contentFrom','contentTo'].includes(key)?query.get(key):query.getAll(key)])),filtersOpen:!filterRows.hidden,distributions:visibleDistributions,scrollY:window.scrollY});}
function filterValue(key: string, value: string) {
  const deadlineNames: Record<string, string> = { upcoming: '未到期', due: '今日到期', overdue: '已超期', unset: '计划未定', closed_on_time: '按期结案', closed_late: '超期结案', closed_unplanned: '无计划结案', closed_unknown: '结案日期待核对', terminated: '终止结案' };
  return currentData?.optionLabels?.[key]?.[value] ?? (key === 'deadline' ? deadlineNames[value] ?? value : key === 'progress' ? value + '%' : ['status', 'priority', 'signal', 'stage'].includes(key) ? label(value) : value);
}
function selectedFilters() {
  const selected = [['search','搜索'],['contentFrom','内容更新起日'],['contentTo','内容更新止日'],...Object.entries(dimensions)].filter(([key]) => query.get(key)).map(([key, title]) => ({ key, text: `${title}：${query.getAll(key).map(value=>filterValue(key,value)).join('、')}` }));
  element('selected-filters').hidden = !selected.length;
  element('selected-filters').innerHTML = selected.map(item => `<button class="chip active" data-remove-filter="${item.key}" aria-label="取消${esc(item.text)}">${esc(item.text)} <span aria-hidden="true">×</span></button>`).join('');
  return selected.map(item => item.text);
}
function card(project: ListProject) {
  const stage = __GEEKDASH_STAGES__.find(item => 'S' + item.id === project.stage);
  const checkedOn = project.checkStatus.latest ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(project.checkStatus.latest.checkedAt)) : null;
  const daysUnchecked = checkedOn ? Math.round((Date.parse(businessDate) - Date.parse(checkedOn)) / 86400000) : null;
  const checkLabel = project.checkedToday ? '✓ 今日已检查' : daysUnchecked !== null && daysUnchecked > 0 ? `○ 已 ${daysUnchecked} 天未检查` : '○ 尚未检查';
  const stageName = (project.status === 'paused' ? '暂缓保留 · ' : '') + (project.stage === 'completed' ? '七阶段全部完成' : label(project.stage) + ' · ' + (project.status === 'proposal' && project.stage !== 'S1' ? '需先启动项目' : label(project.stageState)));
  const facts = [['客户', project.customer], ['产品线', project.productLine], ['ODM 工厂', project.odmFactory], ['APP', project.app], ['芯片', project.chips.map(chip => chip.name).join(' / ')], ['分组', project.projectGroup]].map(([title, value]) => `<div><dt>${title}</dt><dd>${esc(value || '—')}</dd></div>`).join('');
  const risk = project.riskSummary;
  const statusClasses: Record<string, string> = { proposal: 'proposal', ongoing: 'active', paused: 'hold', closed: 'closed' };
  return `<article class="card ${project.priority === 'high' ? 'pri-border-high' : ''}" data-project-id="${project.id}" tabindex="0" aria-label="打开项目：${esc(project.name)}">
    <div class="card-top"><div class="board-card-badges"><span class="signal-tag signal-${esc(project.signal)}"><span class="signal-dot"></span>${esc(label(project.signal))}</span><span class="pri-tag pri-${esc(project.priority)}">${esc(label(project.priority))}优先级</span><span class="st-tag st-${statusClasses[project.status]}">${esc(label(project.status))}</span>${project.maintenanceEnabled ? '<span class="maintenance-badge">量产维护</span>' : ''}${risk?.unresolvedCount ? `<span class="board-risk signal-${risk.highestLevel === 'high' ? 'red' : 'yellow'}">风险 ${risk.unresolvedCount} · ${esc(label(risk.highestLevel))}</span>` : ''}${project.deadline.kind === 'overdue' ? '<span class="board-risk signal-red">已超期</span>' : ''}</div><span class="board-check-state ${project.checkedToday ? 'checked-today' : ''}">${checkLabel}</span></div>
    <div class="board-card-heading"><h3 class="card-name"><a data-project-link href="project-detail.html?id=${project.id}">${esc(project.name)}</a></h3><span data-project-editors="${project.id}">${editorBadges(editors.get(project.id) ?? [])}</span></div>${project.summary ? `<div class="card-desc">${esc(project.summary)}</div>` : ''}
    <section class="board-card-section"><h4>基本资料</h4><dl class="board-card-facts">${facts}</dl>${project.tags.length ? `<div class="board-card-tags">${project.tags.map(tag=>`<span>${esc(tag.name)}</span>`).join('')}</div>` : ''}
    ${project.marketExpectation ? `<p class="board-card-market"><span>市场预期</span>${esc(project.marketExpectation)}</p>` : ''}</section>
    ${project.managers.length>1?`<p class="read-label">协作者：${project.managers.filter(person=>person.id!==account?.id).map(person=>esc(person.name)+(person.enabled?'':'（已停用）')).join('、')}</p>`:''}
    <div class="board-card-stage"><div class="board-stage-heading"><span>当前阶段：${esc(stageName)}</span><strong>${project.progress}%</strong></div><div class="board-card-progress"><div class="stage-bar-track"><div class="stage-bar-fill" style="width:${Number(project.progress)}%"></div></div></div><p class="board-card-milestone">${stage ? '里程碑：' + esc(stage.milestone) : project.stage === 'completed' ? '七阶段里程碑已全部完成。' : '阶段待确认'}</p></div>
    <div class="board-card-status"><div class="board-status-heading"><span>最新状态说明</span></div>${statusContent(project)}</div>
    <div class="board-card-footer"><div class="board-check-time">最近检查：${project.checkStatus.latest ? `<time datetime="${esc(project.checkStatus.latest.checkedAt)}">${esc(checkTime(project.checkStatus))}</time>${project.checkStatus.latest.actorName ? ' · ' + esc(project.checkStatus.latest.actorName) : ''}` : '尚未检查'}${project.checkStatus.updatedAfterCheck ? '<span class="board-check-updated">检查后有更新</span>' : ''}</div><a href="project-detail.html?id=${project.id}">查看详情 ↗</a></div></article>`;
}
function statusContent(project:ListProject){
  const edit=statusEdits.get(project.id),editable=canEditStatus(project),stale=!!edit && (edit.stale || edit.version!==project.version || !editable);
  const notice=frozen?(edit?.committed?'状态已保存，无需重新保存。请重新登录后读取结果，输入保留供复制。':'账号状态已改变，输入和原保存请求保留，请重新登录。'):edit?.committed?edit.message ?? '状态已保存，正在读取正式内容。':stale?'项目已被他人更新，请重新进入项目。未保存文字保留供复制。':edit?.message ?? '';
  if(edit && activeStatus===project.id)return `${edit.value!==edit.base?`<textarea data-status-input="${project.id}" aria-label="旧状态说明草稿" rows="5" ${frozen||stale?'readonly':''}>${esc(edit.value)}</textarea>`:taskPanel(project.tasks??[],edit.ops??[],!frozen&&!stale&&!edit.busy,edit.taskBulk)}<p class="board-status-feedback" role="status">${esc(notice)}</p><div class="board-status-actions">${edit.committed?`<button data-status-action="query" ${edit.busy || frozen?'disabled':''}>读取已保存结果</button>`:edit.pending?`<button data-status-action="query" ${edit.busy || frozen?'disabled':''}>核对原保存结果</button><button data-status-action="retry" ${edit.busy || frozen?'disabled':''}>重试原保存</button>`:`<button data-status-action="save" ${edit.busy || frozen || stale?'disabled':''}>保存状态</button><button data-status-action="cancel" ${edit.busy || frozen?'disabled':''}>取消修改</button><button data-status-action="drafts" ${edit.busy || frozen?'disabled':''}>个人草稿</button>`}${stale || frozen?`<button data-status-action="copy">复制输入</button><a href="project-detail.html?id=${project.id}">重新进入项目</a>`:''}</div>`;
  return `<div class="board-status-lines">${taskPanel(project.tasks??[],[],false)}</div>${editable || edit?`<button data-status-action="edit" ${frozen?'disabled':''}>${edit?'继续编辑':'更新状态'}</button>`:''}`;
}
function renderProjects() {
  if (!currentData) return;
  if(composingStatus){renderStatusPending=true;return;}renderStatusPending=false;
  const input=document.activeElement instanceof HTMLTextAreaElement && document.activeElement.matches('[data-status-input],[data-task-text],[data-task-bulk]')?document.activeElement:undefined,focus=input?{bulk:input.hasAttribute('data-task-bulk'),id:input.dataset.statusInput,task:input.closest<HTMLElement>('[data-task-row]')?.dataset.taskRow,project:input.closest<HTMLElement>('[data-project-id]')?.dataset.projectId,start:input.selectionStart,end:input.selectionEnd,scrollTop:input.scrollTop}:undefined;
  const progress = query.get('layout') === 'progress';
  element('card-grid').classList.toggle('progress-layout', progress);
  element('card-grid').innerHTML = currentData.items.map(card).join('');
  document.querySelectorAll<HTMLTextAreaElement>('[data-status-input],[data-task-text],[data-task-bulk]').forEach(input=>attachStatusMentions(input,()=>mentionPeople ?? []));
  if(focus){const input=document.querySelector<HTMLTextAreaElement>(focus.bulk?`[data-project-id="${focus.project}"] [data-task-bulk]`:focus.task?`[data-project-id="${focus.project}"] [data-task-row="${CSS.escape(focus.task)}"] textarea`:`[data-status-input="${focus.id}"]`);if(input){input.focus({preventScroll:true});input.setSelectionRange(focus.start,focus.end);input.scrollTop=focus.scrollTop;}}
  element('cards-view').hidden = progress; element('dashboard-view').hidden = !progress;
  for (const [id, active] of [['layout-cards', !progress], ['layout-toggle', progress]] as const) { element(id).classList.toggle('active', active); element(id).setAttribute('aria-pressed', String(active)); }
  updateEditing();
}
async function saveStatus(edit:StatusEdit,queryResult=false){
  if(edit.busy || frozen)return;
  const project=currentProject(edit.id);
  if(!edit.pending && (!canEditStatus(project) || edit.stale || project?.version!==edit.version)){edit.stale=true;renderProjects();return;}
  if(!edit.pending && !statusChanged(edit)){await cancelStatus(edit);return;}
  if(!edit.pending){try{if(edit.taskBulk!==undefined){edit.ops=applyTaskText(project?.tasks??[],edit.ops??[],edit.taskBulk);edit.taskBulk=undefined;captureStatus(edit);preserveStatus();}}catch(error){edit.message=(error as Error).message;renderProjects();return;}edit.busy=true;try{if(!await confirmTaskDeletes(project?.tasks??[],edit.ops??[]))return;}finally{edit.busy=false;}if(edit.stale||frozen)return;if(!statusChanged(edit)){await cancelStatus(edit);return;}}
  edit.busy=true;edit.message=queryResult?'正在核对原保存结果…':'正在保存…';renderProjects();
  try{
    if(!edit.pending){
      const original:SaveRequest={expectedVersion:edit.version,idempotencyKey:crypto.randomUUID(),scope:'status',changes:statusChanges(edit)};
      captureStatus(edit);const ref=await drafts(edit.id).prepare('status');if(ref && JSON.stringify(statusChanges(edit))===JSON.stringify(original.changes))original.draft=ref;
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
    const submitted=JSON.stringify(statusChanges(edit))===JSON.stringify(original.changes);
    edit.base=fresh.project.statusDesc;if(submitted){edit.value=edit.base;edit.ops=[];edit.taskBulk=undefined;}edit.version=result.savedVersion;edit.pending=undefined;edit.committed=undefined;
    edit.stale=fresh.project.version!==result.savedVersion || !fresh.capabilities.editOrdinary;
    await drafts(edit.id).advance(result,{kind:'status'});
    const displayed=currentProject(edit.id);if(displayed)Object.assign(displayed,fresh.project);
    if(!statusChanged(edit)){statusEdits.delete(edit.id);if(activeStatus===edit.id)activeStatus=undefined;}
    else edit.message='上次提交已保存，后来输入仍待保存。';
    preserveStatus();renderProjects();
    if(await load(false))feedback('状态已保存。');
  }catch(error){
    edit.message=edit.committed?'状态已保存，正式内容暂未读回，无需重新保存；输入和原结果已保留。':error instanceof SaveError?error.fields?.taskOps ?? error.fields?.statusDesc ?? error.message:(error as Error).message;
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
  const input=event.target as HTMLTextAreaElement,id=input.dataset.statusInput??input.closest<HTMLElement>('[data-project-id]')?.dataset.projectId,edit=id?statusEdits.get(id):undefined;
  if(!edit)return;
  if(input.matches('[data-task-bulk]'))edit.taskBulk=input.value;else if(input.matches('[data-task-text]'))edit.ops=putTaskOp(edit.ops??[],{op:'edit',id:input.closest<HTMLElement>('[data-task-row]')!.dataset.taskRow!,text:input.value});else if(input.matches('[data-status-input]'))edit.value=input.value;else return;
  changedHere.add(edit.id);captureStatus(edit);preserveStatus();updateEditing();
});
element('card-grid').addEventListener('compositionstart',event=>{if((event.target as HTMLElement).matches('[data-status-input],[data-task-text],[data-task-bulk]'))composingStatus=true;});
element('card-grid').addEventListener('compositionend',()=>{composingStatus=false;if(renderStatusPending)queueMicrotask(renderProjects);});
element('card-grid').addEventListener('click',async event=>{
  const mode=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-task-mode]');
  if(mode){const id=mode.closest<HTMLElement>('[data-project-id]')!.dataset.projectId!,edit=statusEdits.get(id);if(!edit||edit.busy||edit.stale||frozen)return;
    try{if(mode.dataset.taskMode==='copy'){await navigator.clipboard.writeText(edit.taskBulk??'');edit.message='整栏输入已复制。';}
      else if(mode.dataset.taskMode==='bulk')edit.taskBulk=taskText(taskCopy(currentProject(id)?.tasks??[],edit.ops??[]));
      else{if(mode.dataset.taskMode==='rows')edit.ops=applyTaskText(currentProject(id)?.tasks??[],edit.ops??[],edit.taskBulk??'');edit.taskBulk=undefined;}
    }catch(error){edit.message=(error as Error).message;}captureStatus(edit);preserveStatus();renderProjects();return;
  }
  const taskButton=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-task-action]');
  if(taskButton&&!taskButton.disabled){const projectId=taskButton.closest<HTMLElement>('[data-project-id]')!.dataset.projectId!,edit=statusEdits.get(projectId);if(!edit)return;
    const op=taskButton.dataset.taskAction as 'add'|'complete'|'reopen'|'delete',id=taskButton.closest<HTMLElement>('[data-task-row]')?.dataset.taskRow??crypto.randomUUID();
    edit.ops=putTaskOp(edit.ops??[],op==='add'?{op,id,text:''}:{op,id});changedHere.add(projectId);captureStatus(edit);preserveStatus();renderProjects();if(op==='add')document.querySelector<HTMLTextAreaElement>(`[data-task-row="${id}"] textarea`)?.focus();return;}
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-status-action]'),id=button?.closest<HTMLElement>('[data-project-id]')?.dataset.projectId;
  if(!button || !id || button.disabled)return;
  let edit=statusEdits.get(id);
  if(button.dataset.statusAction==='edit'){
    const project=currentProject(id);if(!project || frozen || !edit && !canEditStatus(project))return;
    if(!edit){edit={id,ops:[],value:project.statusDesc,base:project.statusDesc,version:project.version};statusEdits.set(id,edit);}
    activeStatus=id;preserveStatus();renderProjects();document.querySelector<HTMLTextAreaElement>(`[data-status-input="${id}"]`)?.focus({preventScroll:true});
    if(!mentionPeople)void loadMentionPeople();
    if(!edit.pending && !statusChanged(edit))void drafts(id).offer();
  }else if(edit){
    if(button.dataset.statusAction==='cancel')void cancelStatus(edit);
    else if(button.dataset.statusAction==='drafts')void drafts(id).open();
    else if(button.dataset.statusAction==='copy'){
      const input=document.querySelector<HTMLTextAreaElement>(`[data-status-input="${id}"]`);input?.focus();input?.select();
      void navigator.clipboard?.writeText(edit.ops?.length?taskText(taskCopy(currentProject(id)?.tasks??[],edit.ops)):edit.value).then(()=>feedback('输入已复制。')).catch(()=>feedback('请复制当前已选中的输入。'));
    }else void saveStatus(edit,button.dataset.statusAction==='query');
  }
});
const distributionNames:Record<string,string>={stage:'项目阶段',productLine:'产品线',customer:'客户',status:'状态',priority:'优先级',signal:'信号灯',odmFactory:'ODM工厂',app:'APP',group:'分组',chip:'芯片',tags:'标签',progress:'进度'};
let visibleDistributions=['stage','productLine','customer','status','priority','signal'];
const chartColors=['#449aca','#9c76d7','#d59548','#55a87a','#df7e84','#6a9ba2','#a58e69','#9588c1'];
function distribution() {
  if (!currentData?.dashboard) return;
  element('distribution-options').innerHTML=Object.entries(distributionNames).map(([key,name])=>`<label><input type="checkbox" value="${key}"${visibleDistributions.includes(key)?' checked':''}>${name}</label>`).join('');
  element('distribution-charts').innerHTML=visibleDistributions.map(key=>{
    const slices=currentData!.dashboard!.distributions[key]??[],total=slices.reduce((sum,item)=>sum+item.count,0);let angle=0;
    const gradient=slices.map((slice,index)=>{const start=angle;angle+=slice.count/Math.max(1,total)*360;return `${chartColors[index%chartColors.length]} ${start}deg ${angle}deg`;}).join(',');
    return `<section class="chart-card"><h3>${distributionNames[key]}</h3><div class="board-pie-layout"><div class="board-pie" aria-hidden="true" style="background:${total?'conic-gradient('+gradient+')':'var(--border)'}"><span>${total}<small>${['customer','productLine','odmFactory','app','group','chip','tags'].includes(key)?'项目关联':'项目'}</small></span></div><ul class="board-pie-legend">${slices.map((slice,index)=>`<li><i style="background:${chartColors[index%chartColors.length]}"></i>${slice.value?`<button class="legend-filter" data-filter="${key}" data-value="${esc(slice.value)}">${esc(filterValue(key,slice.value))}</button>`:'<span>未选择</span>'}<b>${slice.count}</b></li>`).join('')||'<li>暂无匹配项目</li>'}</ul></div></section>`;

  }).join('');
}
function charts(data: Dashboard) {
  element('focus-count').textContent = `当前范围 ${data.focusTotal} 个项目 · 优先级/进度排序 · 展示前 ${data.focus.length} 个`;
  element('focus-projects').innerHTML = data.focus.map(project => {const progress=Math.max(0,Math.min(100,Number(project.progress))),color=project.priority==='high'?'var(--red)':project.priority==='mid'?'var(--yellow)':'var(--accent)';return `<a class="pp-item" data-project-id="${project.id}" href="project-detail.html?id=${project.id}"><div class="pp-ring"><svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" fill="none" stroke="var(--border)" stroke-width="4"/><circle cx="22" cy="22" r="18" fill="none" stroke="${color}" stroke-width="4" pathLength="100" stroke-dasharray="${progress} 100" transform="rotate(-90 22 22)"/></svg><span class="pp-ring-pct">${progress}%</span></div><div class="pp-info"><div class="pp-name">${esc(project.name)}</div><div class="pp-meta">${esc(label(project.stage))} · ${esc(label(project.status))}</div></div></a>`;}).join('') || '<p class="pp-empty">当前范围没有匹配项目</p>';
  const maximum=Math.max(1,...data.managers.map(person=>person.count));
  element('manager-project-counts').innerHTML=`<ul class="board-distribution">${data.managers.map(person=>`<li><button class="legend-filter" data-manager="${esc(person.id)}">${esc(person.name)}</button><span class="board-distribution-track" aria-hidden="true"><i style="width:${person.count/maximum*100}%;background:var(--accent)"></i></span><b>${person.count}</b></li>`).join('')||'<li>暂无负责项目</li>'}</ul>`;
  element('latest-status').innerHTML = data.latest.length ? `<div class="read-table-wrap"><table class="read-table"><thead><tr><th>项目</th><th>最新状态说明</th><th>更新时间</th></tr></thead><tbody>${data.latest.map(project => `<tr><th scope="row"><a data-project-id="${project.id}" href="project-detail.html?id=${project.id}">${esc(project.name)}</a></th><td>${esc(project.statusDesc || '暂无状态说明')}</td><td>${esc(project.contentUpdatedAt?(project.contentUpdatedAt.includes('T')?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(new Date(project.contentUpdatedAt)):project.contentUpdatedAt):'时间未知')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="pp-empty">暂无匹配项目</p>';
  distribution();
}

function filters(options: List['options'], labels: List['optionLabels']) {
  options.stage = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'completed', 'unconfigured'];
  options.progress = ['0', '5', '10', '20', '60', '80', '90', '100'];
  options.deadline = ['upcoming', 'due', 'overdue', 'unset', 'closed_on_time', 'closed_late', 'closed_unplanned', 'closed_unknown', 'terminated'];
  filterRows.innerHTML = `<div class="filter-row"><span class="filter-label">内容更新时间</span><label>从 <input type="date" data-content-date="contentFrom" value="${esc(query.get('contentFrom')??'')}" max="${esc(query.get('contentTo')??'')}"></label><label>至 <input type="date" data-content-date="contentTo" value="${esc(query.get('contentTo')??'')}" min="${esc(query.get('contentFrom')??'')}"></label><span>按说明与任务修改日期筛选</span></div>`+Object.entries(dimensions).map(([key, title]) => {
    const values = options[key] ?? [];
    const selected = query.getAll(key);
    const choices = [...new Set([...selected,...values])];
    return `<div class="filter-row" role="group" aria-label="${title}"><span class="filter-label">${title}</span><button class="chip ${selected.length ? '' : 'active'}" aria-pressed="${!selected.length}" data-filter="${key}" data-value="">全部</button>${choices.map(value => `<button class="chip ${selected.includes(value) ? 'active' : ''}" aria-pressed="${selected.includes(value)}" data-filter="${key}" data-value="${esc(value)}">${esc(labels?.[key]?.[value] ?? filterValue(key, value))}</button>`).join('')}</div>`;
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
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => { const active = button.dataset.view === query.get('view'); button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  try {
    const requestQuery = new URLSearchParams(query); requestQuery.delete('layout'); requestQuery.set('dashboard', '1');
    const requestedPage = Number(requestQuery.get('page') ?? 1);
    const data = await get<List>('/api/projects?' + requestQuery, controller.signal, active);
    if (current !== generation) return;
    if (!data.dashboard || !data.globalChecks) throw new Error('看板统计尚未读取，请刷新。');
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
    element('today-check-count').textContent = `全部项目 ${data.globalChecks.total} · ${data.checkPolicy?.frequency==='manual'?'有检查记录':'本期已检查'} ${data.globalChecks.cycleChecked} · ${data.checkPolicy?.frequency==='manual'?'尚无检查记录':'本期待检查'} ${data.globalChecks.cycleUnchecked}`;
    element<HTMLAnchorElement>('check-entry').href = '/project-checks.html?view=all&checkCycle=unchecked';
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
    element('today-check-count').textContent = '项目检查统计读取失败，请刷新后进入检查';
    element('card-grid').setAttribute('aria-busy', 'false');
    return false;
  }
}
function change(key: string, value: string) { value ? query.set(key, value) : query.delete(key); query.delete('page'); remember();void load(); }
function freezeCheckEntry() { document.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach(button=>button.disabled=true);element('check-entry').removeAttribute('href'); element('check-entry').setAttribute('aria-disabled', 'true'); element('today-check-count').textContent = '正在读取全部项目的检查情况…'; }

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
  if(button){const key=button.dataset.filter!,value=button.dataset.value!,selected=query.getAll(key);query.delete(key);if(value)for(const item of selected.includes(value)?selected.filter(item=>item!==value):[...selected,value])query.append(key,item);query.delete('page');remember();void load();}
};
let searchTimer: ReturnType<typeof setTimeout>;
search.oninput = () => { clearTimeout(searchTimer); controller?.abort(); generation++; freezeCheckEntry(); searchTimer = setTimeout(() => change('search', search.value), 200); };
filterRows.addEventListener('change',event=>{const input=event.target as HTMLInputElement;if(input.dataset.contentDate&&input.reportValidity())change(input.dataset.contentDate,input.value);});
element('clear').onclick = () => { clearTimeout(searchTimer); for (const key of [...query.keys()]) if (key !== 'view' && key !== 'layout') query.delete(key); search.value = ''; remember();void load(); };
element('previous').onclick = () => { if (pagination) { query.set('page', String(pagination.page - 1)); remember();void load(); } };
element('next').onclick = () => { if (pagination) { query.set('page', String(pagination.page + 1)); remember();void load(); } };
element('filter-toggle').onclick = () => { filterRows.hidden = !filterRows.hidden; filterToggle();remember(); };
element('selected-filters').onclick = event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-remove-filter]'); if (button) { clearTimeout(searchTimer); if (button.dataset.removeFilter === 'search') search.value = ''; change(button.dataset.removeFilter!, ''); } };
element('distribution-options').onchange=()=>{visibleDistributions=[...document.querySelectorAll<HTMLInputElement>('#distribution-options input:checked')].map(input=>input.value);remember();distribution();};
element('manager-project-counts').onclick=event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-manager]');if(button)change('owner','user:'+button.dataset.manager);};
element('distribution-charts').onclick = event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-filter]'); if (button) change(button.dataset.filter!, button.dataset.value!); };
element('layout-toggle').onclick = () => { query.set('layout', 'progress');appearance?.update({layout:'progress'}); history.replaceState(null, '', location.pathname + '?' + query); renderProjects(); };
element('layout-cards').onclick = () => { query.delete('layout');appearance?.update({layout:'cards'}); history.replaceState(null, '', location.pathname + '?' + query); renderProjects(); };
document.addEventListener('click', event => {
  if ((event.target as HTMLElement).closest('a')?.closest('[data-project-id],#check-entry')) {
    try { if(account)sessionStorage.setItem('geekdash_board_return:'+account.id, JSON.stringify({ url: location.href, scrollY: scrollY })); } catch { /* 无浏览器存储时可正常跳转。 */ }
  }
});
element('card-grid').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || window.getSelection()?.toString() || target.closest('a,button,input,textarea,select,label,summary,details,[contenteditable],[role="button"],[role="option"]')) return;
  target.closest('[data-project-id]')?.querySelector<HTMLAnchorElement>('[data-project-link]')?.click();
});
element('card-grid').addEventListener('keydown', event => {
  const card = event.target as HTMLElement;
  if (event.key === 'Enter' && card.matches('article[data-project-id]')) { event.preventDefault(); card.querySelector<HTMLAnchorElement>('[data-project-link]')?.click(); }
});
window.addEventListener('focus', () => { if (hasResult) void load(); });
window.addEventListener('scroll',()=>{if(!hasResult || scrollTimer)return;scrollTimer=setTimeout(()=>{scrollTimer=undefined;remember();},2000);},{passive:true});
window.addEventListener('pagehide',()=>{remember();void preference?.flush();});
window.addEventListener('beforeunload',event=>{if([...statusEdits.values()].some(edit=>edit.busy || changedHere.has(edit.id)&&(edit.pending || !edit.committed&&statusChanged(edit)))){event.preventDefault();event.returnValue='';}});
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;generation++;controller?.abort();notifications?.setEditing(false);clearEditors();renderProjects();feedback('账号状态已改变，状态输入保留供复制，请重新登录。');});
document.addEventListener('geekdash-preference-status',event=>{feedback((event as CustomEvent<string>).detail);});
setInterval(() => { if (hasResult && document.visibilityState === 'visible' && businessDate !== new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())) void load(false); }, 60000);
void import('./shared/api').then(async ({ requireIdentity }) => {
  await requireIdentity();preference=new PersonalPreference('board',feedback);const saved=await preference.load();if(Array.isArray(saved.distributions))visibleDistributions=saved.distributions.filter((key:unknown)=>typeof key==='string'&&Object.hasOwn(distributionNames,key));
  try{const cached=JSON.parse(sessionStorage.getItem(statusCache()) ?? '[]');if(Array.isArray(cached))for(const edit of cached)if(typeof edit.id==='string' && /^[1-9][0-9]*$/.test(edit.id) && typeof edit.value==='string' && typeof edit.base==='string' && validTaskDraft(edit.ops) && (edit.taskBulk===undefined||typeof edit.taskBulk==='string') && typeof edit.version==='string' && (!edit.pending || edit.pending.scope==='status'))statusEdits.set(edit.id,{...edit,busy:false});}catch{}
  if(!explicitQuery){if(typeof saved.view==='string')query.set('view',saved.view);if(typeof saved.page==='number')query.set('page',String(saved.page));for(const [key,value] of Object.entries(saved.filters ?? {}))if(allowed.has(key)){query.delete(key);for(const item of Array.isArray(value)?value:[value])if(typeof item==='string')query.append(key,item)};restoredScroll=typeof saved.scrollY==='number'?saved.scrollY:undefined;}
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
