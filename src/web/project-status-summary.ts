import './shared/board.css';
import './shared/read.css';
import './shared/summary.css';
import {get,send,requireIdentity,account,esc,SaveError,setupTheme,type SaveRequest,type SaveResult} from './shared/api';
import {PersonalPreference,PersonalDrafts} from './shared/personal-state';
import {ProjectNotifications} from './shared/notifications';
import {summaryColumns,summaryFilterTitles,summaryFilterOptions,summaryRows,summaryValue,selectedSummary,visibleColumns,summaryCsv,summaryMarkdown,type SummaryColumn,type SummaryFilter,type SummaryFilters,type SummarySort,type SummarySnapshot} from './shared/summary';
import {summaryPng,printSummary} from './shared/summary-output';
import {statusHtml} from './shared/status-text';

const element=(id:string)=>document.getElementById(id)!;
const table=element('summary-table');
type NoteKind='summaryNote'|'chipstatNote';
type NoteEdit={id:string;kind:NoteKind;value:string;base:string;version:string;pending?:SaveRequest;busy?:boolean;message?:string};
type Directory={name:string;getFileHandle:(name:string,options:{create:boolean})=>Promise<{createWritable:()=>Promise<{write:(data:Blob)=>Promise<void>;close:()=>Promise<void>;abort:()=>Promise<void>}>}>};
let snapshot:SummarySnapshot|undefined,filters:SummaryFilters={},filtersOpen=false,sort:SummarySort='customer',order:string[]=[],hidden:string[]=[],columnOrder=Object.keys(summaryColumns) as SummaryColumn[],hiddenColumns:string[]=['chipNote'];
let frozen=false,loading=false,generation=0,exporting=false,composing=false,renderPending=false,directory:Directory|undefined;
const selected=new Set<string>(),edits=new Map<string,NoteEdit>();
const draftStores=new Map<string,PersonalDrafts>();
let preference:PersonalPreference,layout:PersonalPreference;
const parameters=new URLSearchParams(location.search),quick=parameters.get('ids');
let quickIds=quick===null?undefined:[...new Set(quick.split(',').filter(id=>/^[1-9][0-9]*$/.test(id)))];
const key=(id:string,kind:NoteKind)=>id+':'+kind;
let scopeError='';
const message=(text:string)=>{element('summary-feedback').textContent=[scopeError,text].filter(Boolean).join(' ');};
const rows=()=>summaryRows(snapshot?.items ?? [],filters,sort,order,hidden,quickIds);
const columns=()=>visibleColumns(columnOrder,hiddenColumns);
const cacheKey=()=>`geekdash_summary:${account!.id}`;
const returnKey=()=>`geekdash_page:${account!.id}:summary-return`;
document.addEventListener('click',event=>{
  const link=(event.target as HTMLElement).closest<HTMLAnchorElement>('#summary-table a');
  if(!link || !account)return;
  try{sessionStorage.setItem(returnKey(),JSON.stringify({url:location.pathname+location.search,selected:[...selected],title:(element('report-title') as HTMLInputElement).value,scrollY:Math.round(scrollY)}));}
  catch{event.preventDefault();message('无法保留返回时的选择，请重试；当前选择和输入保持。');}
});
function preserve(){try{sessionStorage.setItem(cacheKey(),JSON.stringify([...edits.values()].map(edit=>({...edit,busy:false}))));}catch{message('本机副本未能保留，请保持页面打开或复制未保存备注。');}}
function drafts(id:string){
  let store=draftStores.get(id);if(store)return store;
  store=new PersonalDrafts(id,()=>{const p=snapshot?.items.find(p=>p.id===id);return {version:p?.version ?? null,editable:!frozen && !!p?.canEdit};},row=>{
    const kind=row.formKind as NoteKind,current=edits.get(key(id,kind)),project=snapshot?.items.find(p=>p.id===id),value=row.payload.values?.[kind];
    if(!project || frozen || !project.canEdit || row.baseVersion!==project.version || !['summaryNote','chipstatNote'].includes(kind) || typeof value!=='string' || current?.pending || current?.busy)return false;
    if(current && current.value!==current.base && !window.confirm('本格已有未保存输入，是否用选中的个人草稿替换？'))return false;
    const edit={id,kind,value,base:project[kind] ?? '',version:project.version};edits.set(key(id,kind),edit);capture(edit);preserve();renderTable();return true;
  },{button:false,kinds:['summaryNote','chipstatNote']});draftStores.set(id,store);return store;
}
function capture(edit:NoteEdit){if(edit.value===edit.base || edit.pending)return;drafts(edit.id).capture(edit.kind,undefined,edit.version,{values:{[edit.kind]:edit.value},submission:{scope:edit.kind,changes:{[edit.kind]:edit.value}}});}
function remember(){preference.update({filters,filtersOpen,sort,rowOrder:order,hiddenRows:hidden});}
function renderSelectedFilters(){
  if(!snapshot)return;
  const options=summaryFilterOptions(snapshot);
  element('summary-selected-filters').innerHTML=(filters.search?`<button data-clear-search>搜索：${esc(filters.search)} <span aria-hidden="true">×</span></button>`:'')+(['contentFrom','contentTo'] as const).filter(key=>filters[key]).map(key=>`<button data-clear-date="${key}">${key==='contentFrom'?'内容更新起日':'内容更新止日'}：${esc(filters[key]!)} ×</button>`).join('')+(Object.keys(summaryFilterTitles) as SummaryFilter[]).flatMap(kind=>(filters[kind] ?? []).map(value=>`<button data-remove-filter="${kind}" data-value="${esc(value)}">${summaryFilterTitles[kind]}：${esc(options[kind].find(option=>option[0]===value)?.[1] ?? value)} <span aria-hidden="true">×</span></button>`)).join('');
  element('summary-selected-filters').hidden=!element('summary-selected-filters').childElementCount;
}
function renderFilters(){
  if(!snapshot)return;
  if(!document.getElementById('summary-search')){
    element('summary-filters').innerHTML=`<label class="summary-search">搜索项目<input id="summary-search" type="search" maxlength="255" placeholder="项目名称 / 客户 / 芯片 / 人员" value="${esc(filters.search ?? '')}"></label><div class="summary-filter-tools"><button id="summary-filter-toggle" aria-controls="summary-filter-rows"></button><span>全部筛选条件</span><button data-clear-filters>清空筛选</button></div><div id="summary-selected-filters"></div><div id="summary-filter-rows"></div>`;
  }
  const options=summaryFilterOptions(snapshot);
  element('summary-filter-rows').innerHTML=`<div class="summary-filter"><span>内容更新时间：</span><label>从 <input type="date" data-content-date="contentFrom" value="${esc(filters.contentFrom??'')}" max="${esc(filters.contentTo??'')}"></label><label>至 <input type="date" data-content-date="contentTo" value="${esc(filters.contentTo??'')}" min="${esc(filters.contentFrom??'')}"></label></div>`+(Object.keys(summaryFilterTitles) as SummaryFilter[]).map(kind=>{
    const chosen=filters[kind] ?? [],values=[...options[kind],...chosen.filter(value=>!options[kind].some(option=>option[0]===value)).map(value=>[value,value])];
    return `<div class="summary-filter" role="group" aria-label="${summaryFilterTitles[kind]}"><span>${summaryFilterTitles[kind]}：</span><button data-all="${kind}" aria-pressed="${!chosen.length}">全选</button>${values.map(([value,title])=>`<label><input type="checkbox" data-filter="${kind}" value="${esc(value)}" ${chosen.includes(value)?'checked':''}>${esc(title)}</label>`).join('')}</div>`;
  }).join('');
  element('summary-filter-rows').hidden=!filtersOpen;
  element('summary-filter-toggle').textContent=filtersOpen?'▾ 收起筛选':'▸ 展开筛选';
  element('summary-filter-toggle').setAttribute('aria-expanded',String(filtersOpen));
  renderSelectedFilters();
  element('summary-columns').innerHTML='<div class="summary-fields"><span>字段显示：</span>'+columnOrder.filter(c=>c!=='name').map(c=>`<label><input type="checkbox" data-column-toggle="${c}" ${!hiddenColumns.includes(c)?'checked':''}>${summaryColumns[c]}</label>`).join('')+'</div>';
}
function noteCell(id:string,kind:NoteKind){
  const project=snapshot!.items.find(p=>p.id===id)!,edit=edits.get(key(id,kind));
  if(!edit)return `<span class="summary-note-text">${esc(project[kind] || '—')}</span>${project.canEdit && !frozen?`<button data-edit="${kind}" data-id="${id}">修改</button>`:''}`;
  const stale=edit.version!==project.version;
  return `<div class="summary-note-edit" data-note="${kind}" data-id="${id}"><textarea aria-label="${kind==='summaryNote'?'备注':'芯片备注'}" ${frozen?'readonly':''}>${esc(edit.value)}</textarea><p role="status">${esc(edit.message || (stale?'项目已更新，输入保留供复制；取消本次编辑后可重新读取修改。':''))}</p>${edit.pending?`<button data-note-action="query" ${edit.busy || frozen?'disabled':''}>核对原保存结果</button><button data-note-action="retry" ${edit.busy || frozen?'disabled':''}>重试原保存</button>`:`<button data-note-action="save" ${edit.busy || frozen || stale?'disabled':''}>保存</button><button data-note-action="cancel" ${edit.busy?'disabled':''}>取消</button><button data-note-action="drafts" ${edit.busy || frozen?'disabled':''}>个人草稿</button>`}</div>`;
}
function renderTable(){
  if(composing){renderPending=true;return;}renderPending=false;
  const active=document.activeElement instanceof HTMLTextAreaElement?document.activeElement:undefined,activeCell=active?.closest<HTMLElement>('[data-note]'),focus=activeCell?{id:activeCell.dataset.id,kind:activeCell.dataset.note,start:active!.selectionStart,end:active!.selectionEnd}:undefined;
  const list=rows(),fields=columns();
  element('summary-count').textContent=`${list.length} 个项目　已选 ${list.filter(p=>selected.has(p.id)).length} 个`;
  element('show-hidden').hidden=!hidden.length;
  table.innerHTML=`<thead><tr><th><input type="checkbox" id="select-all" aria-label="选择当前全部项目" ${list.length && list.every(p=>selected.has(p.id))?'checked':''}></th>${fields.map(c=>`<th draggable="true" data-column-drag="${c}">${summaryColumns[c]}</th>`).join('')}<th>操作</th></tr></thead><tbody>${list.map(p=>`<tr data-row="${p.id}"><td class="summary-select"><input type="checkbox" data-select="${p.id}" aria-label="选择${esc(p.name)}" ${selected.has(p.id)?'checked':''}><span class="summary-drag" draggable="true" data-row-drag="${p.id}" title="拖动调整顺序">⠿</span></td>${fields.map(c=>`<td data-column="${c}">${c==='name'?`<a href="/project-detail.html?id=${p.id}&amp;returnTo=${encodeURIComponent(location.pathname+location.search)}">${esc(p.name)}</a>`:c==='note' || c==='chipNote'?noteCell(p.id,c==='note'?'summaryNote':'chipstatNote'):c==='status'?statusHtml(p):esc(summaryValue(p,c) || '—')}</td>`).join('')}<td class="summary-actions"><button data-hide="${p.id}">隐藏</button></td></tr>`).join('') || `<tr><td colspan="${fields.length+2}">${snapshot?'没有匹配项目，请调整筛选或显示隐藏项目。':'尚未读取项目，请点击刷新信息。'}</td></tr>`}</tbody>`;
  const selectAll=element('select-all') as HTMLInputElement;selectAll.indeterminate=list.some(p=>selected.has(p.id)) && !list.every(p=>selected.has(p.id));
  if(focus){const input=table.querySelector<HTMLTextAreaElement>(`[data-note="${focus.kind}"][data-id="${focus.id}"] textarea`);if(input){input.focus({preventScroll:true});input.setSelectionRange(focus.start,focus.end);}}
}
async function load(){
  const own=++generation;loading=true;
  try{const next=await get<SummarySnapshot>('/api/project-summary',undefined,false);if(own!==generation || frozen)return false;snapshot=next;element('summary-date').textContent='列表读取日期：'+new Date(next.capturedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});renderFilters();renderTable();return true;}
  catch(error){if(own===generation)message((error as Error).message+' 已有列表与输入保持，请刷新重试。');return false;}
  finally{if(own===generation)loading=false;}
}
async function save(edit:NoteEdit,query=false){
  if(edit.busy || frozen)return;
  const project=snapshot?.items.find(p=>p.id===edit.id);if(!project)return;
  if(!edit.pending && edit.version!==project.version){edit.message='项目已更新，请复制输入后重新编辑。';renderTable();return;}
  if(!edit.pending && edit.value===edit.base){await cancel(edit);return;}
  edit.busy=true;edit.message='正在保存…';renderTable();
  try{
    if(!edit.pending){const original:SaveRequest={expectedVersion:edit.version,idempotencyKey:crypto.randomUUID(),scope:edit.kind,changes:{[edit.kind]:edit.value}};capture(edit);const ref=await drafts(edit.id).prepare(edit.kind);if(ref && edit.value===original.changes[edit.kind])original.draft=ref;edit.pending=original;preserve();}
    const original=edit.pending;
    const response=await send<{outcome:string;result?:SaveResult}>(`/api/projects/${edit.id}${query?'/save-results/query':''}`,query?'POST':'PATCH',original,!query);
    if(response.outcome==='committed' && response.result){
      const result=response.result;message('备注已保存，正在读取正式结果。');
      if(!await load()){edit.message='备注已保存，但新信息尚未读回。请核对原结果，输入保持。';return;}
      edit.pending=undefined;edit.base=String(original.changes[edit.kind] ?? '');edit.version=result.savedVersion;
      if(snapshot!.items.find(p=>p.id===edit.id)?.version===result.savedVersion){
        await drafts(edit.id).advance(result,{kind:edit.kind});
        for(const other of edits.values())if(other.id===edit.id && other!==edit && other.version===original.expectedVersion && !other.pending){other.version=result.savedVersion;capture(other);}
      }
      if(edit.value===edit.base)edits.delete(key(edit.id,edit.kind));else edit.message='已保存上次提交；后来输入仍待保存。';
      preserve();message('备注已保存。');
    }else edit.message='尚未查到原保存结果。输入与原请求保留，可再次核对或重试原保存。';
  }catch(error){edit.message=(error as Error).message;if(error instanceof SaveError && error.outcome==='not_committed' && error.code!=='OPERATION_KEY_REUSED'){edit.pending=undefined;if(error.code==='PROJECT_VERSION_CONFLICT')await load();}}
  finally{edit.busy=false;if(edits.has(key(edit.id,edit.kind)))capture(edit);preserve();renderTable();}
}
async function cancel(edit:NoteEdit){
  if(edit.pending || edit.busy)return;edit.busy=true;renderTable();
  try{await drafts(edit.id).discard(edit.kind);edits.delete(key(edit.id,edit.kind));}
  catch(error){edit.message=(error as Error).message;}
  finally{edit.busy=false;preserve();renderTable();}
}
element('summary-filters').onclick=event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button)return;
  if(button.id==='summary-filter-toggle'){filtersOpen=!filtersOpen;remember();renderFilters();return;}
  if(button.hasAttribute('data-clear-filters')){filters={};(element('summary-search') as HTMLInputElement).value='';}
  else if(button.hasAttribute('data-clear-search')){delete filters.search;(element('summary-search') as HTMLInputElement).value='';}
  else if(button.dataset.clearDate)delete filters[button.dataset.clearDate as 'contentFrom'|'contentTo'];
  else if(button.dataset.removeFilter){const kind=button.dataset.removeFilter as SummaryFilter;filters[kind]=(filters[kind] ?? []).filter(value=>value!==button.dataset.value);}
  else if(button.dataset.all)filters[button.dataset.all as SummaryFilter]=[];
  else return;
  remember();renderFilters();renderTable();
};
element('summary-filters').onchange=event=>{const input=event.target as HTMLInputElement,kind=input.dataset.filter as SummaryFilter;if(input.dataset.contentDate){if(!input.reportValidity())return;filters[input.dataset.contentDate as 'contentFrom'|'contentTo']=input.value;remember();renderFilters();renderTable();return;}if(!kind)return;filters[kind]=input.checked?[...new Set([...(filters[kind] ?? []),input.value])]:(filters[kind] ?? []).filter(value=>value!==input.value);remember();renderFilters();renderTable();};
function searchProjects(event:Event){const input=event.target as HTMLInputElement;if(input.id!=='summary-search' || event instanceof InputEvent && event.isComposing)return;filters.search=input.value;remember();renderSelectedFilters();renderTable();}
element('summary-filters').addEventListener('input',searchProjects);
element('summary-filters').addEventListener('compositionend',searchProjects);
element('summary-columns').onchange=event=>{const input=event.target as HTMLInputElement,c=input.dataset.columnToggle;if(!c)return;hiddenColumns=input.checked?hiddenColumns.filter(v=>v!==c):[...new Set([...hiddenColumns,c])];layout.update({columns:columnOrder,hiddenColumns});renderTable();};
table.oninput=event=>{const input=event.target as HTMLTextAreaElement,cell=input.closest<HTMLElement>('[data-note]');if(!cell || frozen)return;const edit=edits.get(key(cell.dataset.id!,cell.dataset.note as NoteKind));if(edit){edit.value=input.value;capture(edit);preserve();}};
table.addEventListener('compositionstart',()=>{composing=true;});
table.addEventListener('compositionend',()=>{composing=false;if(renderPending)queueMicrotask(renderTable);});
table.onchange=event=>{const input=event.target as HTMLInputElement;if(input.id==='select-all'){for(const p of rows())input.checked?selected.add(p.id):selected.delete(p.id);}else if(input.dataset.select){input.checked?selected.add(input.dataset.select):selected.delete(input.dataset.select);}renderTable();};
table.onclick=event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button)return;const id=button.dataset.id;
  if(button.dataset.edit && id && !frozen){const p=snapshot!.items.find(p=>p.id===id)!,kind=button.dataset.edit as NoteKind;if(p.canEdit){edits.set(key(id,kind),{id,kind,value:p[kind] ?? '',base:p[kind] ?? '',version:p.version});preserve();renderTable();}}
  if(button.dataset.hide){hidden.push(button.dataset.hide);remember();renderTable();}
  if(button.dataset.noteAction){const cell=button.closest<HTMLElement>('[data-note]')!,edit=edits.get(key(cell.dataset.id!,cell.dataset.note as NoteKind))!;if(button.dataset.noteAction==='cancel')void cancel(edit);else if(button.dataset.noteAction==='drafts')void drafts(edit.id).open();else void save(edit,button.dataset.noteAction==='query');}
};
let dragged:{kind:'row'|'column';id:string}|undefined;
table.ondragstart=event=>{const source=(event.target as HTMLElement).closest<HTMLElement>('[data-row-drag],[data-column-drag]');if(!source)return;dragged=source.dataset.rowDrag?{kind:'row',id:source.dataset.rowDrag}:{kind:'column',id:source.dataset.columnDrag!};event.dataTransfer?.setData('text/plain',dragged.id);};
table.ondragover=event=>{if(dragged)event.preventDefault();};
table.ondrop=event=>{if(!dragged)return;event.preventDefault();const target=(event.target as HTMLElement).closest<HTMLElement>(dragged.kind==='row'?'[data-row]':'[data-column-drag]'),id=dragged.kind==='row'?target?.dataset.row:target?.dataset.columnDrag;if(id && id!==dragged.id){const values=dragged.kind==='row'?rows().map(p=>p.id):columnOrder,sorted=values.filter(v=>v!==dragged!.id);sorted.splice(sorted.indexOf(id),0,dragged.id);if(dragged.kind==='row'){order=sorted;remember();}else{columnOrder=sorted as SummaryColumn[];layout.update({columns:columnOrder,hiddenColumns});renderFilters();}renderTable();}dragged=undefined;};
element('summary-sort').onchange=()=>{sort=(element('summary-sort') as HTMLSelectElement).value as SummarySort;order=[];remember();renderTable();};
element('reset-order').onclick=()=>{order=[];remember();renderTable();};
element('show-hidden').onclick=()=>{hidden=[];remember();renderTable();};
element('refresh-summary').onclick=()=>{if(!frozen)void load();};
element('choose-folder').onclick=async()=>{
  const choose=(window as Window & {showDirectoryPicker?:()=>Promise<Directory>}).showDirectoryPicker;
  if(!choose){message('此浏览器不支持选择文件夹，导出将使用浏览器下载目录。');return;}
  try{directory=await choose();element('folder-status').textContent='保存位置：'+directory.name;}
  catch(error){message((error as Error).name==='AbortError'?'已取消选择，原保存位置保持。':'文件夹未获授权，原保存位置保持。');}
};
async function write(blob:Blob,name:string){
  if(directory){const file=await directory.getFileHandle(name,{create:true}),writer=await file.createWritable();try{await writer.write(blob);await writer.close();}catch(error){await writer.abort().catch(()=>{});throw error;}return '已保存到 '+directory.name+' / '+name;}
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);return '已发起下载：'+name+'。请在浏览器下载记录中核对文件。';
}
document.querySelectorAll<HTMLButtonElement>('[data-export]').forEach(button=>button.onclick=async()=>{
  if(exporting || frozen || !snapshot)return;exporting=true;
  try{const data=selectedSummary(rows(),selected),fields=columns(),context=structuredClone(snapshot),title=(element('report-title') as HTMLInputElement).value.trim() || '项目状态简要',name=title.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)+'_'+context.businessDate,format=button.dataset.export;
    const notice=edits.size?'未保存备注未进入导出，输入已保留。 ':'';
    if(format==='pdf'){printSummary(data,fields,title,context);message(notice+'已打开打印页面，请在打印窗口选择保存为 PDF；尚未确认文件保存。');}
    else {const blob=format==='png'?await summaryPng(data,fields,title,context):new Blob([format==='md'?summaryMarkdown(data,fields,title,context):summaryCsv(data,fields,format==='chip')],{type:format==='md'?'text/markdown;charset=utf-8':'text/csv;charset=utf-8'});message(notice+await write(blob,name+(format==='chip'?'_芯片清单':'')+'.'+(format==='chip'?'csv':format)));}
  }catch(error){message((error as Error).message+' 范围、选择和未保存输入保持。');}finally{exporting=false;}
});
window.addEventListener('beforeunload',event=>{if([...edits.values()].some(e=>e.pending || e.value!==e.base)){event.preventDefault();event.returnValue='';}});
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;generation++;message('账号状态已改变，输入保留供复制，请重新登录。');renderTable();});
window.addEventListener('scroll',()=>preference?.update({scrollY:Math.round(window.scrollY)}),{passive:true});
const refresh=()=>{if(!frozen && snapshot)void load();};
window.addEventListener('focus',refresh);
window.addEventListener('pageshow',event=>{if(event.persisted && account && !frozen){try{const saved=JSON.parse(sessionStorage.getItem(returnKey()) ?? 'null');if(saved?.url===location.pathname+location.search)sessionStorage.removeItem(returnKey());}catch{}}});
setInterval(()=>{if(snapshot && !loading && document.visibilityState==='visible' && snapshot.businessDate!==new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()))refresh();},60000);
setupTheme();
async function initialize(){if(await requireIdentity()){
  const quickKey=parameters.get('quick');
  if(quickKey){
    quickIds=[];
    try{
      const saved=JSON.parse(sessionStorage.getItem(`geekdash_quick:${account!.id}:${quickKey}`) ?? 'null');
      if(!saved || !Array.isArray(saved.ids) || !saved.ids.every((id:unknown)=>typeof id==='string' && /^[1-9][0-9]*$/.test(id)))throw new Error('missing');
      quickIds=[...new Set(saved.ids as string[])];
      if(typeof saved.title==='string')(element('report-title') as HTMLInputElement).value=saved.title+' · 项目状态简要';
      const source=new URL(saved.sourceUrl,location.origin);
      if(source.origin===location.origin && ['/', '/GeekDash.html'].includes(source.pathname) && !source.username && !source.password)document.querySelector<HTMLAnchorElement>('.summary-heading a')!.href=source.href;
    }catch{scopeError='原统计范围无法恢复，请返回看板重新选择。未扩大到全部项目。';message('');}
  }
  preference=new PersonalPreference('summary',message);layout=new PersonalPreference('summary-layout',message);
  const [state,view]=await Promise.all([preference.load(),layout.load()]);
  const strings=(v:unknown):string[]=>Array.isArray(v)?v.filter((s):s is string=>typeof s==='string'):[];
  if(state.filters && typeof state.filters==='object'){
    const saved=state.filters as Record<string,unknown>;
    for(const field of Object.keys(summaryFilterTitles) as SummaryFilter[])filters[field]=strings(saved[field]);
    if(typeof saved.search==='string')filters.search=saved.search;
    for(const key of ['contentFrom','contentTo'] as const)if(typeof saved[key]==='string')filters[key]=saved[key];
  }
  filtersOpen=state.filtersOpen===true;
  if(['customer','group','chip','stage','dueDate'].includes(String(state.sort)))sort=state.sort as SummarySort;
  order=strings(state.rowOrder);hidden=strings(state.hiddenRows);columnOrder=visibleColumns(view.columns,[]);hiddenColumns=view.hiddenColumns===undefined?['chipNote']:strings(view.hiddenColumns);
  (element('summary-sort') as HTMLSelectElement).value=sort;
  try{const saved=JSON.parse(sessionStorage.getItem(cacheKey()) ?? '[]');if(Array.isArray(saved))for(const edit of saved)if(typeof edit.id==='string' && ['summaryNote','chipstatNote'].includes(edit.kind) && typeof edit.value==='string' && typeof edit.version==='string')edits.set(key(edit.id,edit.kind),{...edit,busy:false});}catch{}
  if(await load()){
    let returned=false,position=state.scrollY;
    try{
      const saved=JSON.parse(sessionStorage.getItem(returnKey()) ?? 'null');
      if(saved?.url===location.pathname+location.search && Array.isArray(saved.selected)){
        const current=new Set(snapshot!.items.map(p=>p.id));for(const id of saved.selected)if(current.has(id))selected.add(id);
        if(typeof saved.title==='string')(element('report-title') as HTMLInputElement).value=saved.title;
        if(Number.isFinite(saved.scrollY) && saved.scrollY>=0)position=saved.scrollY;
        returned=true;sessionStorage.removeItem(returnKey());
      }
    }catch{message('返回位置无法恢复，当前项目已重新读取。');}
    if(!returned && quickIds)for(const p of rows())selected.add(p.id);
    renderTable();if(typeof position==='number')window.scrollTo(0,position);
  }
  for(const edit of edits.values())if(edit.pending)void save(edit,true);else capture(edit);
  new ProjectNotifications((_event,own)=>{if(!own)refresh();},()=>{if(!frozen)void load();},text=>{if(text)message(text);},undefined,undefined,refresh);
}}
void initialize();
