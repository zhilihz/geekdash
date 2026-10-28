import {validPassword,passwordHint} from '../server/modules/password-policy';
import {setupPasswordInputs} from './shared/password-input';
import './shared/read.css';
import './shared/detail.css';
import './shared/forms.css';
import './shared/design.css';
import {get,send,setAccount,notifyIdentityChange,SaveError,setupTheme,setupAccountHeader,type Account} from './shared/api';
import {loginTarget,afterLogin} from './shared/auth-return';
const form=document.getElementById('password-form') as HTMLFormElement,message=document.getElementById('password-message')!,login=document.getElementById('password-login') as HTMLAnchorElement,back=document.getElementById('password-back') as HTMLAnchorElement;
let busy=false,actor:Account|undefined;
setupTheme();
form.onsubmit=async event=>{
 event.preventDefault();if(busy||!actor)return;
 const body=Object.fromEntries(new FormData(form)) as Record<string,string>;
 if(body.newPassword!==body.confirmPassword){message.textContent='两次新密码不一致。';return;}
 if(!validPassword(body.newPassword)){message.textContent=passwordHint;return;}
 busy=true;const button=form.querySelector<HTMLButtonElement>('button[type="submit"]')!;button.disabled=true;
 try{const change=()=>send('/api/auth/password','POST',body);if(navigator.locks)await navigator.locks.request('geekdash_auth',change);else await change();
 form.reset();form.hidden=true;back.hidden=true;notifyIdentityChange();message.textContent='密码已更新，请使用新密码登录。';login.hidden=false;login.focus();
 }catch(error){
  if(error instanceof SaveError&&error.outcome==='unknown'){form.hidden=true;back.hidden=true;message.textContent='保存结果尚未确认，请先用新密码登录核对，不要重复修改密码。';login.hidden=false;}
  else message.textContent=(error as Error).message;
 }finally{busy=false;button.disabled=false;}
};
void get<{account:Account}>('/api/auth/me').then(result=>{
 actor=result.account;setAccount(actor);if(!actor.mustChangePassword)setupAccountHeader();form.hidden=false;login.href=loginTarget(new URLSearchParams(location.search).has('returnTo')?afterLogin(actor.id):'/profile.html',actor.id);
 if(actor.mustChangePassword){back.hidden=true;document.getElementById('password-notice')!.textContent='这是临时密码，请先设定自己的密码，再重新登录。';}
}).catch(error=>{
 message.textContent=(error as Error).message;back.hidden=true;login.href=loginTarget('/password.html');login.hidden=false;
});

setupPasswordInputs();
