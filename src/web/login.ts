import {setupPasswordInputs} from './shared/password-input';
import './shared/read.css';
import './shared/detail.css';
import './shared/forms.css';
import {get,send,setAccount,notifyIdentityChange,SaveError,account,type Account} from './shared/api';
import {afterLogin,loginTarget} from './shared/auth-return';
const login=document.getElementById('login') as HTMLFormElement,message=document.getElementById('message')!,notice=document.getElementById('notice')!;
const logout=document.getElementById('logout') as HTMLButtonElement,back=document.getElementById('back') as HTMLAnchorElement;
const query=new URLSearchParams(location.search),exiting=query.get('logout')==='1';
let busy=false;
const authLock=<T>(work:()=>Promise<T>)=>navigator.locks?navigator.locks.request('geekdash_auth',work):work();
function signedOut(){notifyIdentityChange(true);location.replace('/login.html');}
async function exitSession(){
 if(busy)return;busy=true;logout.disabled=true;notice.textContent='正在退出登录…';
 try{if(!account){const current=await get<{account:Account}>('/api/auth/me');setAccount(current.account);}await authLock(async()=>{await send('/api/auth/logout','POST',{});signedOut();});}
 catch(error){
  // 退出回包或同浏览器身份广播可能先到；用新请求确认会话已撤销，不重复判作失败。
  try{const response=await fetch('/api/auth/me',{cache:'no-store',signal:AbortSignal.timeout(10000)});if(response.status===401&&(await response.json()).code==='AUTH_REQUIRED'){signedOut();return;}}catch{/* 无法确认时保留明确重试入口。 */}
  notice.textContent='退出尚未确认。';message.textContent=(error as Error).message;logout.textContent='重试退出登录';logout.hidden=false;
 }finally{busy=false;logout.disabled=false;}
}
async function restore(){
 const result=await get<{account:Account}>('/api/auth/me');setAccount(result.account);
 if(exiting){login.hidden=true;await exitSession();return;}
 const target=afterLogin(result.account.id);
 if(result.account.mustChangePassword||query.get('change')==='1'){location.replace(loginTarget(target,result.account.id,true));return;}
 location.replace(target);
}
login.onsubmit=async event=>{
 event.preventDefault();if(busy)return;busy=true;const button=login.querySelector<HTMLButtonElement>('button[type="submit"]')!;button.disabled=true;
 try{await authLock(async()=>{const result=await send<{accountId:string}>('/api/auth/login','POST',Object.fromEntries(new FormData(login)));const current=await get<{account:Account}>('/api/auth/me');setAccount(current.account);if(current.account.id!==result.accountId)throw new SaveError('AUTH_CONTEXT_CHANGED','unknown');login.reset();notifyIdentityChange();location.replace(current.account.mustChangePassword?loginTarget(afterLogin(current.account.id),current.account.id,true):afterLogin(current.account.id));});}
 catch(error){message.textContent=(error as Error).message;}
 finally{busy=false;button.disabled=false;}
};
logout.onclick=()=>{void exitSession();};back.hidden=true;
if(exiting){login.hidden=true;notice.textContent='正在退出登录…';}
void restore().catch(error=>{
 if(error instanceof SaveError&&error.code==='AUTH_REQUIRED'){
  if(exiting){signedOut();return;}login.hidden=false;
 }else{message.textContent=(error as Error).message;if(exiting){logout.hidden=false;logout.textContent='重试退出登录';}}
});

setupPasswordInputs();
