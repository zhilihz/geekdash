import './shared/board.css';
import './shared/read.css';
import './shared/catalog.css';
import { get,send,requireIdentity,account,esc,SaveError,setupTheme } from './shared/api';
import { ProjectNotifications } from './shared/notifications';

const kinds: Record<string,string>={customers:'客户',engineers:'工程师',productLines:'产品线',apps:'APP',tags:'项目标签',company:'企业信息',groups:'项目分组',chips:'核心芯片'};
const fields: Record<string,Record<string,string>>={
  customers:{name:'客户名称',contact:'主要联系人',tagIds:'客户标签',background:'客户背景信息'},engineers:{name:'工程师姓名',role:'业务角色'},productLines:{name:'产品线名称'},apps:{name:'APP名称',appVersion:'APP版本',description:'描述'},tags:{name:'标签名称'},company:{fullName:'企业全称',shortName:'企业简称',managerText:'负责人信息',namePrefix:'名称前缀'},groups:{name:'分组名称'},chips:{name:'芯片名称',originalModel:'原始型号',manufacturer:'厂商',firmwareVersion:'资料固件版本'},
};
type Values=Record<string,string|boolean|string[]>;
type Item=Values & {id:string;version:string;enabled:boolean};
type Impact={projects:{projectId:string;name:string;version:string}[];customers:{id:string;name:string}[]};
type Command={id:string|null;expectedVersion:string;idempotencyKey:string;changes:Values;impactToken?:string};
type Preview=Impact & {impactToken:string;changed:boolean};
type Pending={kind:string;body:Command};
let kind='customers',items:Item[]=[],tags:Item[]=[],selected:Item|undefined,values:Values={},review:Preview|undefined;
let editing=false,canMaintain=false,busy=false,frozen=false,pending:Pending|undefined,search='';
let refreshing=false,refreshRequested=false;
const detail=document.getElementById('catalog-detail')!,list=document.getElementById('catalog-list')!,message=document.getElementById('catalog-message')!;
const newButton=document.getElementById('catalog-new') as HTMLButtonElement,reload=document.getElementById('catalog-reload') as HTMLButtonElement;
const storageKey=()=>`geekdash_catalog:${account!.id}`;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const errorMessages:Record<string,string>={CATALOG_NAME_CONFLICT:'名称与已有资料重复，请核对身份，不要合并不同资料。',CATALOG_VERSION_CONFLICT:'这条资料已经更新。输入已保留，请重新读取后核对。',CATALOG_IMPACT_CHANGED:'引用项目发生变化，请重新保存以核对最新影响。',MAINTENANCE_REQUIRED:'此账号不能修改公共资料，请由维护账号处理。',INVALID_CATALOG_FIELD:'填写格式或长度不符合要求，请核对资料。',CATALOG_NAME_REQUIRED:'请填写资料名称。',CATALOG_REFERENCE_UNAVAILABLE:'所选标签已停用或不存在，请重新选择。',SYSTEM_CONFIGURATION_REQUIRED:'系统维护账号尚未配置，请联系维护人员。'};
function explain(error:unknown){return error instanceof SaveError ? errorMessages[error.code] ?? error.message : (error as Error).message;}
function persist(){try{if(pending)sessionStorage.setItem(storageKey(),JSON.stringify(pending));else sessionStorage.removeItem(storageKey());}catch{message.textContent='本标签恢复存储不可用，请保留页面并核对原保存结果。';}}
function toast(text:string){const box=document.createElement('div');box.className='catalog-toast';box.role='status';box.textContent=text;document.body.append(box);setTimeout(()=>box.remove(),4000);}
function changes():Values{return Object.fromEntries(Object.entries(values).filter(([key,value])=>!selected || !same(selected[key],value)));}
function leave(){return !busy && !pending && (!editing || !Object.keys(changes()).length || window.confirm('此资料的修改尚未保存，是否放弃本次输入？'));}
function controls(){
  newButton.hidden=!canMaintain || kind==='company';newButton.disabled=busy || frozen || !!pending;
  reload.disabled=busy || frozen || !!pending;
  document.querySelectorAll<HTMLButtonElement>('#catalog-tabs button,.catalog-item').forEach(button=>button.disabled=busy || frozen || !!pending);
  detail.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLButtonElement>('input,textarea,button').forEach(input=>input.disabled=busy || frozen || !!pending && !['catalog-confirm','catalog-retry'].includes(input.id) || input.dataset.disabled==='true' && !(input instanceof HTMLInputElement && input.checked));
  if(refreshRequested && !refreshing && !busy && !pending && !frozen)void refreshCatalog();
}
function bindTags(){detail.querySelectorAll<HTMLInputElement>('[data-tag]').forEach(input=>input.onchange=()=>{values.tagIds=[...detail.querySelectorAll<HTMLInputElement>('[data-tag]:checked')].map(el=>el.dataset.tag!);review=undefined;detail.querySelector('.catalog-impact')?.remove();controls();});}
function renderList(){
  list.innerHTML=items.filter(item=>String(item.name ?? item.fullName).toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item=>`<button class="catalog-item" data-id="${esc(item.id)}" aria-current="${item.id===selected?.id}">${esc((item.name ?? item.fullName) || '企业信息')}<span>${kind==='company' ? '企业资料' : item.enabled ? '启用' : '已停用'}</span></button>`).join('') || '<p>没有匹配资料。</p>';
  list.querySelectorAll<HTMLButtonElement>('[data-id]').forEach(button=>button.onclick=()=>{if(leave())void select(button.dataset.id!);});controls();
}
function display(key:string,value:unknown){return key==='enabled' ? value?'启用':'停用' : key==='tagIds' ? (value as string[] ?? []).map(id=>tags.find(tag=>tag.id===id)?.name ?? id).join('、') || '—' : String(value ?? '') || '—';}
function render(){
  document.getElementById('catalog-tabs')!.innerHTML=Object.entries(kinds).map(([key,title])=>`<button class="head-btn" data-kind="${key}" aria-current="${key===kind}">${title}</button>`).join('');
  document.querySelectorAll<HTMLButtonElement>('[data-kind]').forEach(button=>button.onclick=()=>{if(leave()){kind=button.dataset.kind!;selected=undefined;items=[];editing=false;search='';(document.getElementById('catalog-search') as HTMLInputElement).value='';void load();}});
  if(!selected && !editing){detail.innerHTML='<p>选择一条资料查看。</p>';renderList();return;}
  const fieldHtml=Object.entries(fields[kind]).map(([key,title])=>{
    const value=editing ? values[key] : selected?.[key],wide=['contact','background','description','managerText','tagIds'].includes(key);
    let content=esc(value || '—');
    if(key==='tagIds')content=editing ? `<div class="catalog-tags">${tags.map(tag=>`<label><input type="checkbox" data-tag="${esc(tag.id)}"${(value as string[] ?? []).includes(tag.id)?' checked':''}${!tag.enabled && !(selected?.tagIds as string[] ?? []).includes(tag.id)?' data-disabled="true"':''}>${esc(tag.name)}${tag.enabled?'':'（停用）'}</label>`).join('') || '尚无标签，请先在项目标签中录入。'}</div>` : esc((value as string[] ?? []).map(id=>tags.find(tag=>tag.id===id)?.name ?? '来源缺失 '+id).join('、') || '—');
    else if(editing)content=wide ? `<textarea id="catalog-${key}" data-field="${key}" rows="3">${esc(value)}</textarea>` : `<input id="catalog-${key}" data-field="${key}" value="${esc(value)}" maxlength="${key==='role'||key==='appVersion'?64:key==='firmwareVersion'||key==='shortName'||key==='namePrefix'?128:255}">`;
    return `<div class="catalog-field${wide?' wide':''}">${editing?`<label for="catalog-${key}">${title}</label>${content}`:`<dt>${title}</dt><dd>${content}</dd>`}</div>`;
  }).join('');
  const impactHtml=review ? `<section class="catalog-impact"><h3>确认本次资料修改</h3><div class="read-table-wrap"><table class="read-table comparison-table"><thead><tr><th>修改事项</th><th>修改前</th><th>修改后</th></tr></thead><tbody><tr><th>${esc(kinds[kind])}</th><td>${esc(Object.keys(changes()).map(key=>(fields[kind][key] ?? '启用状态')+'：'+display(key,selected?.[key])).join('\n'))}</td><td>${esc(Object.keys(changes()).map(key=>(fields[kind][key] ?? '启用状态')+'：'+display(key,values[key])).join('\n'))}</td></tr></tbody></table></div><button class="head-btn" id="catalog-apply">确认保存</button> <button class="head-btn" id="catalog-back">返回修改</button></section>` : '';
  detail.innerHTML=`<h2>${editing && !selected?'新增':''}${kinds[kind]}资料</h2><${editing?'div':'dl'} class="catalog-fields">${fieldHtml}</${editing?'div':'dl'}>${kind==='chips'?'<p class="read-message">此处固件版本是芯片库资料，不表示项目已升级。</p>':''}${kind==='customers'?'<p class="read-message">客户标签用于客户分类；联系人可包含职位和电话。</p>':''}<div class="catalog-actions">${canMaintain ? editing ? '<button class="head-btn" id="catalog-save">保存资料</button><button class="head-btn" id="catalog-cancel">取消修改</button>' : `<button class="head-btn" id="catalog-edit">修改</button>${kind==='company'?'':`<button class="head-btn" id="catalog-toggle">${selected?.enabled?'停用':'启用'}</button>`}` : '<span>公共资料由维护账号修改。</span>'}</div>${impactHtml}${pending?'<section class="catalog-impact"><p>保存结果尚未确认。请先核对原结果，避免重复修改。</p><button class="head-btn" id="catalog-confirm">核对保存结果</button> <button class="head-btn" id="catalog-retry">重试原保存</button></section>':''}`;
  detail.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-field]').forEach(input=>input.oninput=()=>{values[input.dataset.field!]=input.value;review=undefined;detail.querySelector('.catalog-impact')?.remove();});
  bindTags();
  const on=(id:string,work:()=>void)=>{const button=document.getElementById(id);if(button)button.onclick=work;};
  on('catalog-edit',()=>{editing=true;values=Object.fromEntries(Object.keys(fields[kind]).map(key=>[key,structuredClone(selected![key])]));render();});
  on('catalog-cancel',()=>{editing=false;review=undefined;values={};render();});
  on('catalog-save',()=>void prepare());
  on('catalog-toggle',()=>{editing=true;values={...Object.fromEntries(Object.keys(fields[kind]).map(key=>[key,structuredClone(selected![key])])),enabled:!selected!.enabled};void prepare();});
  on('catalog-back',()=>{review=undefined;render();});on('catalog-apply',()=>void commitPrepared());on('catalog-confirm',()=>void save(true));on('catalog-retry',()=>void save(false));
  renderList();controls();
}
async function select(id:string){
  if(busy || pending || frozen)return;busy=true;controls();
  try{const data=await get<Impact & {item:Item;canMaintain:boolean}>(`/api/catalog/${kind}/${id}`);selected=data.item;canMaintain=data.canMaintain;editing=false;review=undefined;values={};message.textContent='';}
  catch(error){message.textContent=explain(error)+' 当前内容保留，可刷新重试。';}finally{busy=false;render();}
}
async function load(){
  if(busy || pending || frozen)return;busy=true;controls();let loaded=false;
  try{const result=await get<{items:Item[];canMaintain:boolean}>('/api/catalog/'+kind);items=result.items;canMaintain=result.canMaintain;if(kind==='customers')tags=(await get<{items:Item[]}>('/api/catalog/tags')).items;message.textContent=items.length?'选择一条资料查看，修改后保存。':'此分类还没有资料。';loaded=true;}
  catch(error){message.textContent=explain(error)+' 请刷新重试。';}finally{busy=false;render();}
  if(loaded && items.length && !editing)await select(items.some(item=>item.id===selected?.id)?selected!.id:items[0].id);
}
async function refreshCatalog(){
  if(!account || frozen)return;
  if(refreshing || busy || pending){refreshRequested=true;return;}
  refreshing=true;refreshRequested=false;const currentKind=kind,current=selected;
  try{
    const [result,nextTags,record]=await Promise.all([
      get<{items:Item[];canMaintain:boolean}>('/api/catalog/'+currentKind,undefined,false),
      currentKind==='customers'?get<{items:Item[]}>('/api/catalog/tags',undefined,false):undefined,
      current?get<Impact & {item:Item;canMaintain:boolean}>(`/api/catalog/${currentKind}/${current.id}`,undefined,false):undefined,
    ]);
    if(frozen)return;
    if(kind!==currentKind || selected!==current || busy || pending){refreshRequested=true;return;}
    items=result.items;canMaintain=result.canMaintain;
    if(nextTags){
      const selectedTags=editing?values.tagIds as string[] ?? []:[];
      tags=[...nextTags.items,...tags.filter(tag=>selectedTags.includes(tag.id) && !nextTags.items.some(item=>item.id===tag.id)).map(tag=>({...tag,enabled:false}))];
    }
    if(editing){
      if(record && record.item.version!==selected?.version){review=undefined;prepared=undefined;detail.querySelector('.catalog-impact')?.remove();message.textContent='这条资料已经更新，当前输入和原版本已保留。请复制输入后重新读取核对。';}
      const choices=detail.querySelector('.catalog-tags');
      if(choices){choices.innerHTML=tags.map(tag=>`<label><input type="checkbox" data-tag="${esc(tag.id)}"${(values.tagIds as string[] ?? []).includes(tag.id)?' checked':''}${!tag.enabled && !(selected?.tagIds as string[] ?? []).includes(tag.id)?' data-disabled="true"':''}>${esc(tag.name)}${tag.enabled?'':'（停用）'}</label>`).join('');bindTags();}
      renderList();
    }else{if(record){selected=record.item;}render();}
  }catch(error){message.textContent=explain(error)+' 资料尚未刷新，原输入保留，可重新读取。';}
  finally{refreshing=false;if(refreshRequested && !busy && !pending && !frozen)void refreshCatalog();}
}
let prepared:Command|undefined;
async function prepare(){
  if(busy || pending || frozen || !canMaintain)return;
  const changed=changes();if(!Object.keys(changed).length){toast('没有需要保存的修改');return;}
  busy=true;controls();review=undefined;
  try{
    prepared={id:selected?.id ?? null,expectedVersion:selected?.version ?? '0',idempotencyKey:crypto.randomUUID(),changes:changed};
    const result=await send<Preview>('/api/catalog/'+kind+'/preview','POST',prepared);
    prepared={...prepared,impactToken:result.impactToken};
    if(selected && ('name' in changed || 'enabled' in changed) && (result.projects.length || result.customers.length))review=result;
    else {busy=false;await commitPrepared();return;}
  }catch(error){prepared=undefined;message.textContent=explain(error);}finally{busy=false;render();}
}
async function commitPrepared(){if(!prepared || busy || pending || frozen)return;pending={kind,body:prepared};review=undefined;persist();await save(false);}
async function save(confirm:boolean){
  if(!pending || busy || frozen)return;busy=true;render();const operation=pending;
  try{
    const result=await send<{outcome:string;result?:{id:string;operationId:string;changed:boolean}}>('/api/catalog/'+operation.kind+(confirm?'/results/query':'/save'),'POST',operation.body,!confirm);
    if(result.outcome!=='committed' || result.result?.operationId!==operation.body.idempotencyKey){message.textContent='尚未查到原保存结果，可以重试原保存。';return;}
    pending=undefined;prepared=undefined;persist();editing=false;toast(result.result.changed?'资料已保存':'资料没有变化');
    try{const data=await get<Impact & {item:Item;canMaintain:boolean}>(`/api/catalog/${kind}/${result.result.id}`);selected=data.item;canMaintain=data.canMaintain;items=[...items.filter(item=>item.id!==data.item.id),data.item];values={};message.textContent='';}
    catch{selected=undefined;values={};message.textContent='资料已保存，读取新资料失败。请刷新，勿重复新增。';}
  }catch(error){
    const failure=error instanceof SaveError?error:new SaveError('TRANSPORT_UNKNOWN','unknown');
    if(['AUTH_REQUIRED','AUTH_CONTEXT_CHANGED','CSRF_INVALID','PASSWORD_CHANGE_REQUIRED'].includes(failure.code))frozen=true;
    if(failure.outcome==='not_committed' && failure.code!=='OPERATION_KEY_REUSED'){pending=undefined;prepared=undefined;persist();}
    message.textContent=explain(failure)+' 输入已保留。';
  }finally{busy=false;render();}
}
setupTheme();
newButton.onclick=()=>{if(!leave() || !canMaintain)return;selected=undefined;review=undefined;editing=true;values=Object.fromEntries(Object.keys(fields[kind]).map(key=>[key,key==='tagIds'?[]:'']));render();};
reload.onclick=()=>{if(leave()){editing=false;review=undefined;void load();}};
document.getElementById('catalog-search')!.oninput=event=>{search=(event.target as HTMLInputElement).value;renderList();};
window.addEventListener('beforeunload',event=>{if(pending || editing && Object.keys(changes()).length){event.preventDefault();event.returnValue='';}});
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;message.textContent='账号已变化，请重新登录原账号后核对。当前输入保留。';controls();});
window.addEventListener('focus',()=>{if(account)void refreshCatalog();});
void requireIdentity().then(async()=>{
  try{pending=JSON.parse(sessionStorage.getItem(storageKey())??'null')??undefined;}catch{message.textContent='原保存恢复信息无法读取，请保留原页面。';}
  if(pending){kind=pending.kind;editing=true;values=pending.body.changes;render();await save(true);}else await load();
  new ProjectNotifications(()=>{},()=>{void refreshCatalog();},text=>{if(text)message.textContent=text;},undefined,undefined,event=>{if(event.resource==='catalog' && (event.kind===kind || kind==='customers' && event.kind==='tags'))void refreshCatalog();});
}).catch(error=>{message.textContent=explain(error);});
