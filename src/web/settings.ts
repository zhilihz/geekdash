import './shared/board.css';
import './shared/read.css';
import './shared/design.css';
import {account,get,send,setupTheme,requireIdentity,SaveError,type CheckPolicy} from './shared/api';
const form=document.getElementById('check-settings') as HTMLFormElement,frequency=document.getElementById('check-frequency') as HTMLSelectElement,weekday=document.getElementById('check-weekday') as HTMLSelectElement;
const message=document.getElementById('settings-message')!,save=document.getElementById('settings-save') as HTMLButtonElement,query=document.getElementById('settings-query') as HTMLButtonElement;
type Command={frequency:CheckPolicy['frequency'];deadlineWeekday:number;expectedVersion:string;idempotencyKey:string};
let policy:CheckPolicy,pending:Command|undefined,busy=false,frozen=false;
const key=()=>`geekdash_check_policy:${account!.id}`;
function render(){
 document.getElementById('check-weekday-field')!.hidden=frequency.value!=='weekly';
 document.getElementById('check-setting-impact')!.textContent=frequency.value==='manual'?'保存后立即停止周期与逾期判断，检查人和时间继续保留。':`截止当天全天有效；次日00:00起未检查则逾期。保存后立即应用当前${frequency.value==='weekly'?'周':'天'}和以后周期，已保存的检查事实与历史规则保留。`;
 frequency.disabled=weekday.disabled=busy||!!pending||frozen;save.disabled=query.disabled=busy||frozen;query.hidden=!pending;save.textContent=pending?'重试原保存':'保存设置';
}
async function load(){policy=await get<CheckPolicy>('/api/settings/check-rule');frequency.value=policy.frequency;weekday.value=String(policy.deadlineWeekday);render();}
async function execute(confirm=false){
 if(busy||frozen)return;pending??={frequency:frequency.value as CheckPolicy['frequency'],deadlineWeekday:Number(weekday.value),expectedVersion:policy.version,idempotencyKey:crypto.randomUUID()};
 busy=true;render();
 try{sessionStorage.setItem(key(),JSON.stringify(pending));const result=await send<{outcome:string}>('/api/settings/check-policy'+(confirm?'/results/query':''),'POST',pending);
 if(result.outcome==='committed'){pending=undefined;sessionStorage.removeItem(key());await load();message.textContent='CHECK设置已保存，当前周期已应用。';}else message.textContent='尚未查到保存结果，可以重试原保存。';
 }catch(error){message.textContent=(error as Error).message;if(error instanceof SaveError&&error.outcome==='not_committed'){pending=undefined;sessionStorage.removeItem(key());if(error.code==='SETTINGS_VERSION_CONFLICT'){policy=await get<CheckPolicy>('/api/settings/check-rule');message.textContent='设置已被另一管理员更新。你的选择已保留，请核对后保存。';}}}
 finally{busy=false;render();}
}
form.onsubmit=event=>{event.preventDefault();void execute();};query.onclick=()=>{void execute(true);};frequency.onchange=render;
document.addEventListener('geekdash-identity-changed',()=>{frozen=true;form.hidden=true;message.textContent='账号已变化，请重新登录。';});
setupTheme();void requireIdentity().then(async()=>{if(!account?.isMaintenance){message.textContent='项目设置由管理员维护。';return;}await load();form.hidden=false;const cached=sessionStorage.getItem(key());if(cached){pending=JSON.parse(cached);frequency.value=pending!.frequency;weekday.value=String(pending!.deadlineWeekday);await execute(true);}}).catch(error=>{message.textContent=(error as Error).message;});
