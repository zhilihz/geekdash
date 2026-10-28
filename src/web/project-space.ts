import './shared/board.css';
import './shared/read.css';
import './shared/project-space.css';
import './shared/reference-picker.css';
import './shared/design.css';
import {mountReferencePickers} from './shared/reference-picker';
import {account,esc,get,label,requireIdentity,setupTheme,SaveError,send} from './shared/api';
import {saveMembership,hasPendingMembership,type MembershipCommand} from './shared/membership';
import {ProjectNotifications} from './shared/notifications';

type SpaceItem={id:string;version:string;name:string;status:string;summary:string;customer:string|null;productLine:string|null;chips:{name:string}[];tags:{name:string}[];collaborators:{name:string;enabled:boolean}[];suggested?:boolean;member:boolean;unowned:boolean;pendingRequest:{id:string;kind:string}|null};
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const messages:Record<string,string>={PROJECT_ALREADY_OWNED:'项目已被其他人认领，可以申请协作。',PROJECT_UNOWNED:'项目已无人负责，可以认领。',REQUEST_NOT_PENDING:'请求已处理，正在读取结果。',MEMBERSHIP_CHANGED:'项目成员已变化，请核对后再操作。',BUSINESS_ACCOUNT_REQUIRED:'此操作需要业务账号。',PROJECT_ACCESS_REQUIRED:'你尚未加入这个项目。',INVITEE_UNAVAILABLE:'该账号当前不能加入。'};
let page=1,pageCount=1,generation=0,busy=false,frozen=false;
const filters:Record<string,string[]>={customer:[],productLine:[],chip:[]};
let filterSignature='';
let items:SpaceItem[]=[];
const deletionKey=(id:string)=>`geekdash_delete:${account!.id}:${id}`;
const search=el<HTMLInputElement>('space-search');
const action=(projectId:string,title:string,action:MembershipCommand['action']|'query',requestId?:string)=>`<button class="head-btn" data-project="${projectId}" data-action="${action}"${requestId?` data-request="${requestId}"`:''}${busy||frozen?' disabled':''}>${title}</button>`;
function card(item:SpaceItem){
  const controls=((item.member||account?.isMaintenance)?`<a class="head-btn" href="/project-detail.html?id=${item.id}">进入项目</a>`:'')+(!item.member&&account?.isProjectManager?action(item.id,'加入项目','join'):'')+(account?.isMaintenance?`<button class="head-btn" data-delete-project="${item.id}"${busy||frozen?' disabled':''}>${sessionStorage.getItem(deletionKey(item.id))?'核对删除结果':'删除项目'}</button>`:'');
  return `<article class="space-card"><div class="space-card-head"><h2>${esc(item.name)}</h2><span class="st-tag">${label(item.status)}</span></div>${item.summary?`<p class="space-intro">${esc(item.summary)}</p>`:''}<dl class="space-facts"><div><dt>客户</dt><dd>${esc(item.customer||'未填写')}</dd></div><div><dt>产品线</dt><dd>${esc(item.productLine||'未填写')}</dd></div><div><dt>芯片</dt><dd>${esc(item.chips.map(v=>v.name).join('、')||'未填写')}</dd></div></dl>${item.tags.length?`<div class="space-tags">${item.tags.map(v=>`<span class="st-tag">${esc(v.name)}</span>`).join('')}</div>`:''}${item.collaborators.length?`<p class="read-label">协作者：${item.collaborators.map(v=>esc(v.name)+(v.enabled?'':'（已停用）')).join('、')}</p>`:''}<footer>${item.suggested?'<span class="st-tag">备份中登记为你负责，可加入项目</span>':''}${controls}${hasPendingMembership(item.id)?action(item.id,'核对原操作','query'):''}</footer></article>`;
}
async function load(){
  const ticket=++generation;
  try{
    const params=new URLSearchParams({page:String(page),search:search.value});for(const [key,values] of Object.entries(filters))for(const value of values)params.append(key,value);
    const result=await get<{items:SpaceItem[];tagOptions:string[];filterOptions:Record<string,string[]>;pagination:{page:number;pageCount:number;total:number}}>('/api/project-space?'+params);
    if(ticket!==generation||frozen)return;
    items=result.items;page=result.pagination.page;pageCount=result.pagination.pageCount;
    const signature=JSON.stringify(result.filterOptions);
    if(signature!==filterSignature){
      filterSignature=signature;
      el('space-filters').innerHTML=Object.entries({customer:'客户',productLine:'产品线',chip:'芯片'}).map(([key,title])=>`<div class="field"><label for="space-${key}">${title}</label><select id="space-${key}-source" data-reference="true" data-filter="${key}" multiple>${[...new Set([...result.filterOptions[key],...filters[key]])].map(value=>`<option value="${esc(value)}"${filters[key].includes(value)?' selected':''}>${esc(value)}</option>`).join('')}</select></div>`).join('');
      mountReferencePickers(el('space-filters'));
    }


    el('space-cards').innerHTML=result.items.map(card).join('')||'<p>没有匹配的项目。</p>';
    if(account?.isMaintenance)for(const key of Object.keys(sessionStorage).filter(key=>key.startsWith(`geekdash_delete:${account!.id}:`))){
      const id=key.split(':').at(-1)!;if(items.some(item=>item.id===id))continue;
      const recovery=document.createElement('p');recovery.textContent='上次删除结果尚待核对。';
      const button=document.createElement('button');button.className='head-btn';button.dataset.deleteProject=id;button.textContent='核对删除结果';recovery.append(button);el('space-cards').prepend(recovery);
    }
    el('space-total').textContent=`共 ${result.pagination.total} 个项目`;
    el('space-page').textContent=`${page} / ${pageCount}`;
    el<HTMLButtonElement>('space-previous').disabled=page<=1;el<HTMLButtonElement>('space-next').disabled=page>=pageCount;
  }catch(error){el('space-message').textContent='项目读取失败，原内容保留。'+(error as Error).message;}
}
async function deleteProject(id:string){
  if(busy||frozen||!account?.isMaintenance)return;
  const key=deletionKey(id),item=items.find(item=>item.id===id);busy=true;
  try{
    let command:{expectedVersion:string;idempotencyKey:string};
    const stored=sessionStorage.getItem(key);
    if(stored)command=JSON.parse(stored);
    else{
      if(!item)return;
      const dialog=document.createElement('dialog');dialog.className='space-delete-dialog';
      dialog.innerHTML=`<h2>删除“${esc(item.name)}”？</h2><p>项目将从项目空间、个人列表、统计和检查中移除，原有历史仍保留。</p><form method="dialog"><button class="head-btn" value="cancel" autofocus>取消</button><button class="head-btn" value="delete">删除项目</button></form>`;
      document.body.append(dialog);
      const accepted=await new Promise<boolean>(resolve=>{dialog.onclose=()=>{resolve(dialog.returnValue==='delete');dialog.remove();};dialog.showModal();});
      if(!accepted||frozen)return;
      command={expectedVersion:item.version,idempotencyKey:crypto.randomUUID()};sessionStorage.setItem(key,JSON.stringify(command));
    }
    let result=await send<{outcome:string}>(`/api/projects/${id}/delete-results/query`,'POST',command,false);
    if(result.outcome==='not_found')result=await send(`/api/projects/${id}/delete`,'POST',command);
    if(result.outcome!=='committed')throw new Error('删除结果尚未确认，请点击“核对删除结果”，无需重新删除。');
    sessionStorage.removeItem(key);el('space-message').textContent='项目已删除。';
  }catch(error){
    if(error instanceof SaveError&&error.outcome==='not_committed'&&error.code!=='OPERATION_KEY_REUSED')sessionStorage.removeItem(key);
    el('space-message').textContent=error instanceof SaveError&&error.code==='PROJECT_VERSION_CONFLICT'?'项目已更新，已重新读取。请核对后再决定是否删除。':(error as Error).message;
  }finally{busy=false;await load();}
}
document.addEventListener('click',event=>{
  const remove=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-delete-project]');if(remove){void deleteProject(remove.dataset.deleteProject!);return;}
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action][data-project]');
  if(!button||button.disabled||busy||frozen)return;
  busy=true;document.querySelectorAll<HTMLButtonElement>('button[data-project]').forEach(value=>value.disabled=true);
  void(async()=>{
    let committed=false;
    try{const result=await saveMembership(button.dataset.project!,button.dataset.action==='query'?undefined:{action:button.dataset.action as MembershipCommand['action'],...button.dataset.request?{requestId:button.dataset.request}:{}});committed=result.outcome==='committed';el('space-message').textContent=committed?'已加入项目，可在我的项目中查看和管理。':'结果尚未确认，请在原位置核对操作。';}
    catch(error){el('space-message').textContent=error instanceof SaveError?messages[error.code]??error.message:(error as Error).message;}
    finally{busy=false;await load();if(committed)document.dispatchEvent(new Event('geekdash-membership'));}
  })();
});
el('space-filters').onchange=event=>{const select=event.target as HTMLSelectElement;if(!select.dataset.filter)return;filters[select.dataset.filter]=[...select.selectedOptions].map(option=>option.value);page=1;void load();};
let searchTimer:ReturnType<typeof setTimeout>;
search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page=1;void load();},200);};
el('space-previous').onclick=()=>{page--;void load();};el('space-next').onclick=()=>{page++;void load();};
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;el('space-cards').replaceChildren();el('space-message').textContent='账号已变化，请重新登录。';});
document.addEventListener('geekdash-membership',()=>{if(!busy&&!frozen)void load();});
setupTheme();
void requireIdentity().then(async()=>{await load();new ProjectNotifications(()=>{void load();},()=>{void load();},()=>{});}).catch(error=>{el('space-message').textContent=(error as Error).message;});
