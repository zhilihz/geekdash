import './shared/board.css';
import './shared/read.css';
import './shared/project-space.css';
import './shared/reference-picker.css';
import './shared/design.css';
import {mountReferencePickers} from './shared/reference-picker';
import {account,esc,get,label,requireIdentity,setupTheme,SaveError,send} from './shared/api';
import {saveMembership,hasPendingMembership,type MembershipCommand} from './shared/membership';
import {ProjectNotifications} from './shared/notifications';

type SpaceItem={deletedAt:string|null;id:string;version:string;name:string;status:string;summary:string;customer:string|null;productLine:string|null;chips:{name:string}[];tags:{name:string}[];collaborators:{name:string;enabled:boolean}[];suggested?:boolean;member:boolean;unowned:boolean;pendingRequest:{id:string;kind:string}|null};
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const messages:Record<string,string>={PROJECT_ALREADY_OWNED:'项目已被其他人认领，可以申请协作。',PROJECT_UNOWNED:'项目已无人负责，可以认领。',REQUEST_NOT_PENDING:'请求已处理，正在读取结果。',MEMBERSHIP_CHANGED:'项目成员已变化，请核对后再操作。',BUSINESS_ACCOUNT_REQUIRED:'此操作需要业务账号。',PROJECT_ACCESS_REQUIRED:'你尚未加入这个项目。',INVITEE_UNAVAILABLE:'该账号当前不能加入。'};
let page=1,pageCount=1,generation=0,busy=false,frozen=false;
let view:'current'|'history'='current';
const filters:Record<string,string[]>={customer:[],productLine:[],chip:[]};
let filterSignature='';
let items:SpaceItem[]=[];
const deletionKey=(id:string,operation='delete')=>`geekdash_${operation}:${account!.id}:${id}`;
const search=el<HTMLInputElement>('space-search');
const action=(projectId:string,title:string,action:MembershipCommand['action']|'query',requestId?:string)=>`<button class="head-btn" data-project="${projectId}" data-action="${action}"${requestId?` data-request="${requestId}"`:''}${busy||frozen?' disabled':''}>${title}</button>`;
function card(item:SpaceItem){
  const controls=item.deletedAt?(account?.isMaintenance?`<button class="head-btn" data-restore-project="${item.id}"${busy||frozen?' disabled':''}>${sessionStorage.getItem(deletionKey(item.id,'restore'))?'核对恢复结果':'恢复原项目'}</button>`:'<span class="read-label">请管理员恢复原项目</span>'):((item.member||account?.isMaintenance)?`<a class="head-btn" href="/project-detail.html?id=${item.id}">进入项目</a>`:'')+(!item.member&&account?.isProjectManager?action(item.id,'加入项目','join'):'')+(account?.isMaintenance?`<button class="head-btn" data-delete-project="${item.id}"${busy||frozen?' disabled':''}>${sessionStorage.getItem(deletionKey(item.id))?'核对删除结果':'删除项目'}</button>`:'');
  return `<article class="space-card"><div class="space-card-head"><h2>${esc(item.name)}</h2><span class="st-tag">${item.deletedAt?'已删除':label(item.status)}</span></div>${item.summary?`<p class="space-intro">${esc(item.summary)}</p>`:''}<dl class="space-facts"><div><dt>客户</dt><dd>${esc(item.customer||'未填写')}</dd></div><div><dt>产品线</dt><dd>${esc(item.productLine||'未填写')}</dd></div><div><dt>芯片</dt><dd>${esc(item.chips.map(v=>v.name).join('、')||'未填写')}</dd></div></dl>${item.tags.length?`<div class="space-tags">${item.tags.map(v=>`<span class="st-tag">${esc(v.name)}</span>`).join('')}</div>`:''}${item.deletedAt?`<p class="read-label">删除时间：${esc(new Date(item.deletedAt).toLocaleString('zh-CN'))}。恢复保留原项目及历史。</p>`:''}${item.unowned?'<p class="read-label">待加入：当前没有启用中的项目经理。</p>':''}${item.collaborators.length?`<p class="read-label">协作者：${item.collaborators.map(v=>esc(v.name)+(v.enabled?'':'（当前不可管理）')).join('、')}</p>`:''}<footer>${item.suggested?'<span class="st-tag">备份中登记为你负责，可加入项目</span>':''}${controls}${hasPendingMembership(item.id)?action(item.id,'核对原操作','query'):''}</footer></article>`;
}
async function load(savedNotice=''){
  const ticket=++generation;
  try{
    const params=new URLSearchParams({page:String(page),search:search.value,view});for(const [key,values] of Object.entries(filters))for(const value of values)params.append(key,value);
    const result=await get<{items:SpaceItem[];tagOptions:string[];filterOptions:Record<string,string[]>;pagination:{page:number;pageCount:number;total:number}}>('/api/project-space?'+params);
    if(ticket!==generation||frozen)return;
    items=result.items;page=result.pagination.page;pageCount=result.pagination.pageCount;
    const signature=JSON.stringify(result.filterOptions);
    if(signature!==filterSignature){
      filterSignature=signature;
      el('space-filters').innerHTML=Object.entries({customer:'客户',productLine:'产品线',chip:'芯片'}).map(([key,title])=>`<div class="field"><label for="space-${key}">${title}</label><select id="space-${key}-source" data-reference="true" data-filter="${key}" multiple>${[...new Set([...result.filterOptions[key],...filters[key]])].map(value=>`<option value="${esc(value)}"${filters[key].includes(value)?' selected':''}>${esc(value)}</option>`).join('')}</select></div>`).join('');
      mountReferencePickers(el('space-filters'));
    }


    el('space-cards').innerHTML=result.items.map(card).join('')||(view==='history'?'<p>没有已删除的项目。</p>':'<p>没有匹配的项目。</p>');
    if(account?.isMaintenance)for(const operation of ['delete','restore'])for(const key of Object.keys(sessionStorage).filter(key=>key.startsWith(`geekdash_${operation}:${account!.id}:`))){
      const id=key.split(':').at(-1)!;if(items.some(item=>item.id===id&&!!item.deletedAt===(operation==='restore')))continue;
      const recovery=document.createElement('p');recovery.textContent=`上次${operation==='delete'?'删除':'恢复'}结果尚待核对。`;
      const button=document.createElement('button');button.className='head-btn';button.dataset[operation==='delete'?'deleteProject':'restoreProject']=id;button.textContent='核对原操作结果';recovery.append(button);el('space-cards').prepend(recovery);
    }
    el('space-total').textContent=`共 ${result.pagination.total} 个项目`;
    el('space-page').textContent=`${page} / ${pageCount}`;
    el<HTMLButtonElement>('space-previous').disabled=page<=1;el<HTMLButtonElement>('space-next').disabled=page>=pageCount;
  }catch(error){el('space-message').textContent=savedNotice+' 项目列表读取失败，原内容保留。'+(error as Error).message;const retry=document.createElement('button');retry.className='head-btn';retry.textContent='重新读取列表';retry.onclick=()=>{void load(savedNotice);};el('space-message').append(retry);}
}
async function changeDeletedProject(id:string,operation:'delete'|'restore'){
  if(busy||frozen||!account?.isMaintenance)return;
  const key=deletionKey(id,operation),item=items.find(item=>item.id===id),title=operation==='delete'?'删除':'恢复';busy=true;let savedNotice='';
  try{
    let command:{expectedVersion:string;idempotencyKey:string};
    const stored=sessionStorage.getItem(key);
    if(stored)command=JSON.parse(stored);
    else{
      if(!item)return;
      const dialog=document.createElement('dialog');dialog.className='space-delete-dialog';
      dialog.innerHTML=`<h2>${title}“${esc(item.name)}”？</h2><p>${operation==='delete'?'项目将移至历史项目，原有内容及历史保留，名称继续保留。':'恢复原项目、历史和仍有效的负责关系，不会自动采用备份内容，也不会自动将你设为负责人。'}</p><form method="dialog"><button class="head-btn" value="cancel" autofocus>取消</button><button class="head-btn" value="confirm">${title}项目</button></form>`;
      document.body.append(dialog);
      const accepted=await new Promise<boolean>(resolve=>{dialog.onclose=()=>{resolve(dialog.returnValue==='confirm');dialog.remove();};dialog.showModal();});
      if(!accepted||frozen)return;
      command={expectedVersion:item.version,idempotencyKey:crypto.randomUUID()};sessionStorage.setItem(key,JSON.stringify(command));
    }
    let result=await send<{outcome:string}>(`/api/projects/${id}/${operation}-results/query`,'POST',command,false);
    if(result.outcome==='not_found')result=await send(`/api/projects/${id}/${operation}`,'POST',command);
    if(result.outcome!=='committed')throw new Error(`${title}结果尚未确认，请点击“核对${title}结果”，无需重复操作。`);
    sessionStorage.removeItem(key);savedNotice=operation==='delete'?'项目已移至历史项目。':'原项目已恢复，可在全部项目中查看；未自动导入备份或添加负责人。';el('space-message').textContent=savedNotice;
  }catch(error){
    if(error instanceof SaveError&&error.outcome==='not_committed'&&error.code!=='OPERATION_KEY_REUSED')sessionStorage.removeItem(key);
    el('space-message').textContent=error instanceof SaveError&&error.code==='PROJECT_VERSION_CONFLICT'?`项目已更新，已重新读取。请核对后再决定是否${title}。`:error instanceof SaveError&&error.code==='PROJECT_ALREADY_RESTORED'?'这个项目已恢复，请切换到全部项目查看。':(error as Error).message;
  }finally{busy=false;await load(savedNotice);}
}
document.addEventListener('click',event=>{
  const remove=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-delete-project]');if(remove){void changeDeletedProject(remove.dataset.deleteProject!,'delete');return;}
  const restore=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-restore-project]');if(restore){void changeDeletedProject(restore.dataset.restoreProject!,'restore');return;}
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
el('space-views').onclick=event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-space-view]');if(!button||busy||frozen)return;view=button.dataset.spaceView as typeof view;page=1;for(const item of el('space-views').querySelectorAll('button'))item.setAttribute('aria-pressed',String(item===button));void load();};
el('space-filters').onchange=event=>{const select=event.target as HTMLSelectElement;if(!select.dataset.filter)return;filters[select.dataset.filter]=[...select.selectedOptions].map(option=>option.value);page=1;void load();};
let searchTimer:ReturnType<typeof setTimeout>;
search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page=1;void load();},200);};
el('space-previous').onclick=()=>{page--;void load();};el('space-next').onclick=()=>{page++;void load();};
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;el('space-cards').replaceChildren();el('space-message').textContent='账号已变化，请重新登录。';});
document.addEventListener('geekdash-membership',()=>{if(!busy&&!frozen)void load();});
setupTheme();
void requireIdentity().then(async()=>{await load();new ProjectNotifications(()=>{void load();},()=>{void load();},()=>{});}).catch(error=>{el('space-message').textContent=(error as Error).message;});
