import {validPassword,passwordHint} from '../server/modules/password-policy';
import {setupPasswordInputs} from './shared/password-input';
import './shared/detail.css';
import './shared/read.css';
import './shared/forms.css';
import './shared/design.css';
import {send,get,SaveError} from './shared/api';
const form=document.getElementById('register') as HTMLFormElement,message=document.getElementById('register-message')!;
const errors:Record<string,string>={INVITE_UNAVAILABLE:'邀请码无效、已过期或已撤销，请联系管理员。',LOGIN_NAME_EXISTS:'这个登录名已注册，请更换；若上次注册结果未确认，可直接尝试登录。',INVALID_PROFILE:'请填写有效姓名。',INVALID_REQUEST:'请检查登录名和邀请码格式。'};
let busy=false;
form.onsubmit=async event=>{
 event.preventDefault();if(busy)return;const body=Object.fromEntries(new FormData(form)) as Record<string,string>;
 body.loginName=body.loginName.trim().toLowerCase();body.inviteCode=body.inviteCode.trim();
 if(!validPassword(body.password)){message.textContent=passwordHint;return;}
 busy=true;const button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;button.disabled=true;
 try{const result=await send<{accountId:string}>('/api/auth/register','POST',body);const active=await get<{account:{id:string}}>('/api/auth/me');if(active.account.id!==result.accountId)throw new SaveError('AUTH_CONTEXT_CHANGED','not_committed');form.reset();location.replace('/');}
 catch(error){if(error instanceof SaveError&&error.outcome==='unknown'){try{const active=await get<{account:{loginName:string}}>('/api/auth/me');if(active.account.loginName===body.loginName){form.reset();location.replace('/');return;}}catch{/* 保留原注册输入；不重试创建账号。 */}}message.textContent=error instanceof SaveError?(error.outcome==='unknown'?'注册结果尚未确认，请先尝试登录；不要更换登录名重复注册。':errors[error.code]??error.message):(error as Error).message;}
 finally{busy=false;button.disabled=false;}
};

setupPasswordInputs();
