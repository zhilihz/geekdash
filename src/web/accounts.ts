import './shared/board.css';
import './shared/read.css';
import './shared/project-space.css';
import {account,esc,get,requireIdentity,SaveError,send,setupTheme} from './shared/api';
type User={id:string;name:string;loginName:string;enabled:number;version:string};
type Impact={account:User;unhandedProjects:{id:string;name:string}[];affectedRequests:{id:string;projectName:string}[];impactToken:string};
type Command={id:string;body:{enabled:boolean;expectedVersion:string;impactToken:string;idempotencyKey:string}};
let users:User[]=[],impact:Impact|undefined,pending:Command|undefined,busy=false,frozen=false;
const list=document.getElementById('account-list')!,message=document.getElementById('account-message')!;
const key=()=>`geekdash_accounts:${account!.id}`;
const errors:Record<string,string>={MAINTENANCE_REQUIRED:'只有维护账号可以管理账号。',MAINTENANCE_ACCOUNT_PROTECTED:'不能停用维护账号。',ACCOUNT_HANDOFF_REQUIRED:'还有项目无人接续，请先完成交接。',ACCOUNT_IMPACT_CHANGED:'账号或项目成员已变化，请重新核对当前影响后确认。'};
function render(){
  list.innerHTML=users.map(user=>`<article class="space-request"><div><h3>${esc(user.name)} <small>（${esc(user.loginName)}）</small></h3><p>${user.enabled?'启用':'已停用'}${user.id===account!.id?' · 维护账号':''}</p></div>${user.id===account!.id?'':`<button class="head-btn" data-account="${user.id}"${busy||frozen||pending?' disabled':''}>${user.enabled?'停用':'启用'}</button>`}</article>${impact?.account.id===user.id?`<section class="account-impact"><h3>${user.enabled?'停用':'启用'} ${esc(user.name)}</h3>${user.enabled&&impact.unhandedProjects.length?`<p>以下项目尚无其他启用中的协作者，交接完成后才能停用。</p><ul>${impact.unhandedProjects.map(project=>`<li>${esc(project.name)}</li>`).join('')}</ul><button class="head-btn" data-account="${user.id}">重新核对</button>`:`${user.enabled?`<p>停用后撤销登录会话，${impact.affectedRequests.length} 个待处理请求将失效。</p>${impact.affectedRequests.length?`<ul>${impact.affectedRequests.map(request=>`<li>${esc(request.projectName)}</li>`).join('')}</ul>`:''}`:'<p>重新启用后需重新登录，已失效的协作请求不会恢复。</p>'}<button class="save-btn" data-confirm${busy||frozen||pending?' disabled':''}>确认${user.enabled?'停用':'启用'}</button>`}<button class="head-btn" data-cancel${busy||pending?' disabled':''}>取消</button></section>`:''}`).join('');
  if(pending)list.insertAdjacentHTML('afterbegin',`<p>原操作结果待确认。<button class="head-btn" data-query${busy||frozen?' disabled':''}>核对原结果</button><button class="head-btn" data-retry${busy||frozen?' disabled':''}>重试原操作</button></p>`);
}
async function load(){try{const result=await get<{items:User[]}>('/api/accounts');if(frozen)return;users=result.items;render();}catch(error){message.textContent=error instanceof SaveError?errors[error.code]??error.message:(error as Error).message;}}
async function execute(query=false){
  if(!pending||busy||frozen)return;busy=true;render();
  try{
    const result=await send<{outcome:string}>(`/api/accounts/${pending.id}/${query?'state-results/query':'state'}`,'POST',pending.body,!query);
    if(result.outcome==='committed'){pending=undefined;impact=undefined;localStorage.removeItem(key());message.textContent='账号状态已保存。';await load();}
    else message.textContent='原操作尚未完成，可重试原操作。';
  }catch(error){
    message.textContent=error instanceof SaveError?errors[error.code]??error.message:(error as Error).message;
    if(error instanceof SaveError&&error.outcome==='not_committed'&&error.code!=='OPERATION_KEY_REUSED'){pending=undefined;impact=undefined;localStorage.removeItem(key());}
  }finally{busy=false;render();}
}
list.addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button||button.disabled||busy||frozen)return;
  void(async()=>{
    if(button.hasAttribute('data-query'))return execute(true);
    if(button.hasAttribute('data-retry')){await execute(true);if(pending)await execute();return;}
    if(pending)return;
    if(button.dataset.account){busy=true;render();try{impact=await get<Impact>(`/api/accounts/${button.dataset.account}/impact`);}finally{busy=false;render();}}
    if(button.hasAttribute('data-cancel')){impact=undefined;render();}
    if(button.hasAttribute('data-confirm')&&impact){pending={id:impact.account.id,body:{enabled:!impact.account.enabled,expectedVersion:impact.account.version,impactToken:impact.impactToken,idempotencyKey:crypto.randomUUID()}};localStorage.setItem(key(),JSON.stringify(pending));await execute();}
  })().catch(error=>{message.textContent=error instanceof SaveError?errors[error.code]??error.message:(error as Error).message;});
});
document.getElementById('account-refresh')!.onclick=()=>{if(!busy)void load();};
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;list.replaceChildren();message.textContent='账号已变化，请重新登录。';});
setupTheme();void requireIdentity().then(async()=>{if(!account!.isMaintenance){message.textContent='只有维护账号可以管理账号。';return;}const cached=localStorage.getItem(key());pending=cached?JSON.parse(cached):undefined;await load();if(pending)await execute(true);}).catch(error=>{message.textContent=(error as Error).message;});
