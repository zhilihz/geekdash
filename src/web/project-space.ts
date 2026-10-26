import './shared/board.css';
import './shared/read.css';
import './shared/project-space.css';
import {account,esc,get,label,requireIdentity,setupTheme,SaveError} from './shared/api';
import {saveMembership,hasPendingMembership,type MembershipCommand} from './shared/membership';
import {ProjectNotifications} from './shared/notifications';

type SpaceItem={id:string;name:string;status:string;summary:string;customer:string|null;productLine:string|null;chips:{name:string}[];tags:{name:string}[];collaborators:{name:string;enabled:boolean}[];member:boolean;unowned:boolean;pendingRequest:{id:string;kind:string}|null};
type Request={id:string;projectId:string;projectName:string;kind:string;status:string;initiatorId:string;initiatorName:string;targetUserId:string;targetName:string;createdAt:string};
type RequestPage={items:Request[];next:string|null};
const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const messages:Record<string,string>={PROJECT_ALREADY_OWNED:'项目已被其他人认领，可以申请协作。',PROJECT_UNOWNED:'项目已无人负责，可以认领。',REQUEST_NOT_PENDING:'请求已处理，正在读取结果。',MEMBERSHIP_CHANGED:'项目成员已变化，请核对后再操作。',BUSINESS_ACCOUNT_REQUIRED:'此操作需要业务账号。',PROJECT_ACCESS_REQUIRED:'你尚未加入这个项目。',INVITEE_UNAVAILABLE:'该账号当前不能加入。'};
const statusNames:Record<string,string>={pending:'等待回应',accepted:'已接受',rejected:'已拒绝',withdrawn:'已撤回',invalidated:'已失效',member:'已加入'};
let page=1,pageCount=1,generation=0,requestGeneration=0,busy=false,frozen=false,requests:Request[]=[],next:string|null=null;
const search=el<HTMLInputElement>('space-search');
const action=(projectId:string,title:string,action:MembershipCommand['action']|'query',requestId?:string)=>`<button class="head-btn" data-project="${projectId}" data-action="${action}"${requestId?` data-request="${requestId}"`:''}${busy||frozen?' disabled':''}>${title}</button>`;
function card(item:SpaceItem){
  const request=item.pendingRequest;
  const controls=item.member?`<a class="head-btn" href="/project-detail.html?id=${item.id}">进入项目</a>`:account?.isMaintenance?'':request?request.kind==='invitation'?`<a class="head-btn" href="#requests">查看邀请</a>`:`<span>等待回应</span>${action(item.id,'撤回','withdraw',request.id)}`:action(item.id,item.unowned?'认领':'申请协作',item.unowned?'claim':'apply');
  return `<article class="space-card"><div class="space-card-head"><h2>${esc(item.name)}</h2><span class="st-tag">${label(item.status)}</span></div>${item.summary?`<p class="space-intro">${esc(item.summary)}</p>`:''}<dl class="space-facts"><div><dt>客户</dt><dd>${esc(item.customer||'未填写')}</dd></div><div><dt>产品线</dt><dd>${esc(item.productLine||'未填写')}</dd></div><div><dt>芯片</dt><dd>${esc(item.chips.map(v=>v.name).join('、')||'未填写')}</dd></div></dl>${item.tags.length?`<div class="space-tags">${item.tags.map(v=>`<span class="st-tag">${esc(v.name)}</span>`).join('')}</div>`:''}${item.collaborators.length?`<p class="read-label">协作者：${item.collaborators.map(v=>esc(v.name)+(v.enabled?'':'（已停用）')).join('、')}</p>`:''}<footer>${controls}${hasPendingMembership(item.id)?action(item.id,'核对原操作','query'):''}</footer></article>`;
}
async function load(){
  const ticket=++generation;
  try{
    const result=await get<{items:SpaceItem[];pagination:{page:number;pageCount:number;total:number}}>('/api/project-space?'+new URLSearchParams({page:String(page),search:search.value}));
    if(ticket!==generation||frozen)return;
    page=result.pagination.page;pageCount=result.pagination.pageCount;
    el('space-cards').innerHTML=result.items.map(card).join('')||'<p>没有匹配的项目。</p>';
    el('space-total').textContent=`共 ${result.pagination.total} 个项目`;
    el('space-page').textContent=`${page} / ${pageCount}`;
    el<HTMLButtonElement>('space-previous').disabled=page<=1;el<HTMLButtonElement>('space-next').disabled=page>=pageCount;
  }catch(error){el('space-message').textContent='项目读取失败，原内容保留。'+(error as Error).message;}
}
function renderRequests(){
  el('request-list').innerHTML=requests.map(row=>{
    const controls=row.status!=='pending'?'':row.kind==='invitation'&&row.targetUserId===account!.id||row.kind==='application'&&row.targetUserId!==account!.id?action(row.projectId,'接受','accept',row.id)+action(row.projectId,'拒绝','reject',row.id):row.initiatorId===account!.id?action(row.projectId,'撤回','withdraw',row.id):'';
    return `<article class="space-request"><div><h3>${esc(row.projectName)}</h3><p>${row.kind==='invitation'?`${esc(row.initiatorName)}邀请${row.targetUserId===account!.id?'你':esc(row.targetName)}协作`:`${row.targetUserId===account!.id?'你':esc(row.targetName)}申请协作`} · ${statusNames[row.status]??esc(row.status)}</p></div><div class="space-request-actions">${controls}</div></article>`;
  }).join('')||'<p class="read-label">暂无协作请求。</p>';
  el('request-more').hidden=!next;
}
async function loadRequests(more=false){
  if(account!.isMaintenance){el('requests').hidden=true;return;}
  const ticket=++requestGeneration;
  try{const result=await get<RequestPage>('/api/membership-requests'+(more&&next?'?before='+next:''));if(ticket!==requestGeneration||frozen)return;requests=more?[...requests,...result.items]:result.items;next=result.next;renderRequests();el('request-message').textContent='';}
  catch(error){el('request-message').textContent='请求暂未读到，可刷新重试。'+(error as Error).message;}
}
document.addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action][data-project]');
  if(!button||button.disabled||busy||frozen)return;
  busy=true;document.querySelectorAll<HTMLButtonElement>('button[data-project]').forEach(value=>value.disabled=true);
  void(async()=>{
    let committed=false;
    try{const result=await saveMembership(button.dataset.project!,button.dataset.action==='query'?undefined:{action:button.dataset.action as MembershipCommand['action'],...button.dataset.request?{requestId:button.dataset.request}:{}});committed=result.outcome==='committed';el('space-message').textContent=committed?statusNames[result.result!.status]??'已保存':'结果尚未确认，请在原位置核对操作。';}
    catch(error){el('space-message').textContent=error instanceof SaveError?messages[error.code]??error.message:(error as Error).message;}
    finally{busy=false;await Promise.all([load(),loadRequests()]);if(committed)document.dispatchEvent(new Event('geekdash-membership'));}
  })();
});
let searchTimer:ReturnType<typeof setTimeout>;
search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page=1;void load();},200);};
el('space-previous').onclick=()=>{page--;void load();};el('space-next').onclick=()=>{page++;void load();};el('request-more').onclick=()=>{void loadRequests(true);};
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;el('space-cards').replaceChildren();el('request-list').replaceChildren();el('space-message').textContent='账号已变化，请重新登录。';});
document.addEventListener('geekdash-membership',()=>{if(!busy&&!frozen)void Promise.all([load(),loadRequests()]);});
setupTheme();
void requireIdentity().then(async()=>{await Promise.all([load(),loadRequests()]);new ProjectNotifications(()=>{void load();},()=>{void Promise.all([load(),loadRequests()]);},()=>{});}).catch(error=>{el('space-message').textContent=(error as Error).message;});
