import './shared/board.css';
import './shared/read.css';
import './shared/project-space.css';
import {account,esc,get,requireIdentity,SaveError,send,setupTheme} from './shared/api';
type User={id:string;name:string;loginName:string;enabled:number;isAdmin:number;isProjectManager:number;version:string};
type Impact={account:User;unhandedProjects:{id:string;name:string}[];affectedRequests:{id:string;projectName:string}[];impactToken:string};
type Edit={loginName:string;name:string;isProjectManager:boolean;expectedVersion:string;idempotencyKey:string};
type Command={id:string;deleting?:boolean;editing?:boolean;body:Edit|{enabled:boolean;expectedVersion:string;impactToken:string;idempotencyKey:string}};
let editing:{user:User;body:Edit}|undefined;
let deleting=false;
let users:User[]=[],impact:Impact|undefined,pending:Command|undefined,busy=false,frozen=false,identityChanged=false;
const list=document.getElementById('account-list')!,message=document.getElementById('account-message')!;
const key=()=>`geekdash_accounts:${account!.id}`;
function forget(){try{localStorage.removeItem(key());}catch{/* 原成功回执仍可核对，清理失败不否定已保存结果。 */}}
const errors:Record<string,string>={MAINTENANCE_REQUIRED:'只有管理员可以管理账号。',MAINTENANCE_ACCOUNT_PROTECTED:'不能停用或删除当前账号。',ACCOUNT_DELETED:'账号已经删除，请刷新列表。',LAST_ADMIN_REQUIRED:'至少保留一位启用中的管理员。',ACCOUNT_HANDOFF_REQUIRED:'还有项目无人接续，请先完成交接。',PROJECT_MEMBERSHIP_REMAINS:'请先退出负责的项目，再取消项目经理资格。',LOGIN_NAME_EXISTS:'该登录名已被使用，请更换。',ACCOUNT_VERSION_CONFLICT:'账号已被其他管理员修改，请重新打开当前账号。',ACCOUNT_IMPACT_CHANGED:'账号或项目成员已变化，请重新核对当前影响后确认。'};
function render(){
 const row=(user:User)=>{
  const action=deleting?'删除':user.enabled?'停用':'启用';
  return `<article class="space-request"><div><h3>${esc(user.name)} <small>（${esc(user.loginName)}）</small></h3><p>${user.enabled?'启用':'已停用'}${user.isAdmin&&user.isProjectManager?' · 同时担任项目经理':''}</p></div><button class="head-btn" data-edit-account="${user.id}"${busy||frozen||pending?' disabled':''}>修改信息</button>${user.id===account!.id?'<span>当前账号</span>':`<div class="account-row-actions"><button class="head-btn" data-account="${user.id}"${busy||frozen||pending?' disabled':''}>${user.enabled?'停用':'启用'}</button><button class="head-btn" data-delete="${user.id}"${busy||frozen||pending?' disabled':''}>删除</button></div>`}</article>${impact?.account.id===user.id?`<section class="account-impact"><h3>${action} ${esc(user.name)}</h3>${(user.enabled||deleting)&&impact.unhandedProjects.length?`<p>以下项目尚无其他启用中的协作者，请先交接。</p><ul>${impact.unhandedProjects.map(project=>`<li>${esc(project.name)}</li>`).join('')}</ul>`:`<p>${deleting?'删除后不能再登录，账号从列表移除；项目及过去的操作历史保留。':user.enabled?'停用后撤销登录会话。':'启用后可重新登录。'}${impact.affectedRequests.length?'待处理请求将失效。':''}</p><button class="save-btn" data-confirm${busy||frozen||pending?' disabled':''}>确认${action}</button>`}<button class="head-btn" data-cancel${busy||pending?' disabled':''}>取消</button></section>`:''}`;
 };
 list.innerHTML=`<div class="account-lists">${[[true,'管理员列表'],[false,'项目经理列表']].map(([admin,title])=>`<section class="chart-card"><h2>${title}</h2>${users.filter(user=>admin?!!user.isAdmin:!!user.isProjectManager).map(row).join('')||'<p class="read-label">暂无账号</p>'}</section>`).join('')}</div>`;
 if(editing){const value=editing.body;list.insertAdjacentHTML('afterbegin',`<form id="account-edit" class="chart-card ui-form"><h2>修改 ${esc(editing.user.name)}</h2><div class="account-edit-fields"><label>登录名<input name="loginName" value="${esc(value.loginName)}" required pattern="[a-z0-9][a-z0-9_-]{2,63}" maxlength="64"></label><label>姓名<input name="name" value="${esc(value.name)}" required maxlength="128"></label></div>${editing.user.isAdmin?`<label class="account-role-option"><input type="checkbox" name="isProjectManager"${value.isProjectManager?' checked':''}>同时担任项目经理</label><p class="read-label">勾选后可以创建、导入和加入项目。修改姓名不重新匹配项目。</p>`:''}<button class="save-btn" type="submit"${busy||frozen||pending?' disabled':''}>保存修改</button> <button class="head-btn" type="button" data-cancel-edit${busy||pending?' disabled':''}>取消</button></form>`);
 const form=document.getElementById('account-edit') as HTMLFormElement;form.addEventListener('input',()=>{if(!editing)return;const data=new FormData(form);editing.body={...editing.body,loginName:String(data.get('loginName')??'').trim().toLowerCase(),name:String(data.get('name')??''),isProjectManager:editing.user.isAdmin?data.has('isProjectManager'):true};});
 form.onsubmit=event=>{event.preventDefault();if(!editing||busy||frozen||pending||!form.reportValidity())return;const command:Command={id:editing.user.id,editing:true,body:{...editing.body,idempotencyKey:crypto.randomUUID()}};try{localStorage.setItem(key(),JSON.stringify(command));pending=command;void execute();}catch{message.textContent='无法保留本次操作，尚未发送。请恢复浏览器存储后重试。';}};
 }
 if(pending)list.insertAdjacentHTML('afterbegin',`<p>原操作结果待确认。<button class="head-btn" data-query${busy||frozen?' disabled':''}>核对原结果</button><button class="head-btn" data-retry${busy||frozen?' disabled':''}>重试原操作</button></p>`);
}
async function load(){try{const result=await get<{items:User[]}>('/api/accounts');if(identityChanged)return;users=result.items;render();}catch(error){message.textContent=error instanceof SaveError?Object.values(error.fields??{})[0]??errors[error.code]??error.message:(error as Error).message;}}
async function execute(query=false){
  if(!pending||busy||frozen)return;busy=true;render();
  try{
    const result=await send<{outcome:string}>(`/api/accounts/${pending.id}/${pending.editing?(query?'edit-results/query':'edit'):pending.deleting?(query?'delete-results/query':'delete'):(query?'state-results/query':'state')}`,'POST',pending.body,!query);
    if(result.outcome==='committed'){pending=undefined;impact=undefined;editing=undefined;forget();message.textContent='账号修改已保存。';await load();}
    else message.textContent='原操作尚未完成，可重试原操作。';
  }catch(error){
    message.textContent=error instanceof SaveError?Object.values(error.fields??{})[0]??errors[error.code]??error.message:(error as Error).message;
    if(error instanceof SaveError&&error.outcome==='not_committed'&&error.code!=='OPERATION_KEY_REUSED'){pending=undefined;impact=undefined;forget();}
  }finally{busy=false;render();}
}
list.addEventListener('click',event=>{
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!button||button.disabled||busy||frozen)return;
  void(async()=>{
    if(button.hasAttribute('data-query'))return execute(true);
    if(button.hasAttribute('data-retry')){await execute(true);if(pending)await execute();return;}
    if(pending)return;
    if(button.dataset.editAccount){const user=users.find(v=>v.id===button.dataset.editAccount)!;impact=undefined;editing={user,body:{loginName:user.loginName,name:user.name,isProjectManager:!!user.isProjectManager,expectedVersion:user.version,idempotencyKey:crypto.randomUUID()}};render();return;}
    if(button.hasAttribute('data-cancel-edit')){editing=undefined;render();return;}
    if(button.dataset.account||button.dataset.delete){editing=undefined;deleting=!!button.dataset.delete;busy=true;render();try{impact=await get<Impact>(`/api/accounts/${button.dataset.account??button.dataset.delete}/impact`);}finally{busy=false;render();}}
    if(button.hasAttribute('data-cancel')){impact=undefined;render();}
    if(button.hasAttribute('data-confirm')&&impact){const command={id:impact.account.id,deleting,body:{enabled:deleting?false:!impact.account.enabled,expectedVersion:impact.account.version,impactToken:impact.impactToken,idempotencyKey:crypto.randomUUID()}};try{localStorage.setItem(key(),JSON.stringify(command));}catch{throw new Error('本机无法保留原操作，本次未发送修改。请恢复浏览器存储后重试。');}pending=command;await execute();}
  })().catch(error=>{message.textContent=error instanceof SaveError?Object.values(error.fields??{})[0]??errors[error.code]??error.message:(error as Error).message;});
});
document.getElementById('account-refresh')!.onclick=()=>{if(!busy)void load();};
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;identityChanged=true;document.getElementById('admin-content')!.hidden=true;list.replaceChildren();message.textContent='账号已变化，请重新登录。';});
setupTheme();void requireIdentity().then(async()=>{if(!account!.isMaintenance){message.textContent='只有管理员可以管理账号。';return;}document.getElementById('admin-content')!.hidden=false;try{const cached=localStorage.getItem(key());pending=cached?JSON.parse(cached):undefined;}catch{frozen=true;message.textContent='本机操作记录无法读取，本页暂不修改账号。请恢复浏览器存储后刷新，现有账号仍可查看。';}await load();await loadInvites();if(pending)await execute(true);}).catch(error=>{message.textContent=(error as Error).message;});

type Invite={id:string;code:string|null;role:string;expiresAt:string;revoked:number;registrations:number};
let inviteKey:string|undefined,inviteBusy=false;
const inviteResult=document.getElementById('invite-result')!;
async function loadInvites(){
 const {items}=await get<{items:Invite[]}>('/api/accounts/invites');
 document.getElementById('invite-list')!.innerHTML=`<div class="invite-scroll"><table class="invite-table"><thead><tr><th>权限</th><th>邀请码</th><th>注册人数</th><th>到期时间</th><th>状态 / 操作</th></tr></thead><tbody>${items.map(item=>`<tr><td>${item.role==='admin'?'管理员':'项目经理'}</td><td>${item.code?`<code>${esc(item.code)}</code>`:'旧码未保存，请重新生成'}</td><td>${item.registrations}</td><td>${new Date(item.expiresAt).toLocaleString('zh-CN')}</td><td>${item.revoked?'已撤销':new Date(item.expiresAt).getTime()<=Date.now()?'已过期':`有效 <button class="head-btn" data-invite="${item.id}">撤销</button>`}</td></tr>`).join('')||'<tr><td colspan="5">还没有邀请码</td></tr>'}</tbody></table></div>`;
}
document.getElementById('invite-create')!.onclick=async()=>{
 if(inviteBusy||frozen||!account?.isMaintenance)return;inviteBusy=true;
 const button=document.getElementById('invite-create') as HTMLButtonElement,role=document.getElementById('invite-role') as HTMLSelectElement;
 button.disabled=true;role.disabled=true;inviteKey??=crypto.randomUUID();
 try{await send<{id:string;code?:string;replayed:boolean}>('/api/accounts/invites','POST',{role:role.value,idempotencyKey:inviteKey});
 inviteResult.textContent='邀请码已生成，可从下表复制。';
 inviteKey=undefined;await loadInvites();
 }catch(error){inviteResult.textContent=(error as Error).message+' 请重试生成以核对原结果。';}
 finally{inviteBusy=false;button.disabled=false;role.disabled=!!inviteKey;}
};
document.getElementById('invite-list')!.onclick=async event=>{
 const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-invite]');if(!button||inviteBusy||frozen)return;button.disabled=true;
 try{await send(`/api/accounts/invites/${button.dataset.invite}/revoke`,'POST',{});await loadInvites();}catch(error){inviteResult.textContent=(error as Error).message;button.disabled=false;}
};
