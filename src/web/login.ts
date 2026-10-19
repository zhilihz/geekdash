import './shared/read.css';
import './shared/detail.css';
import './shared/forms.css';
import { get, send, setAccount, notifyIdentityChange, SaveError, account, type Account } from './shared/api';
const login = document.getElementById('login') as HTMLFormElement;
const password = document.getElementById('password') as HTMLFormElement;
const message = document.getElementById('message')!;
const logout = document.getElementById('logout') as HTMLButtonElement;
let busy = false;
function note(text: string) { message.textContent = text; }
async function restore() {
  const { account } = await get<{ account: Account }>('/api/auth/me'); setAccount(account);
  login.hidden = true; password.hidden = false; logout.hidden = false;
  document.getElementById('back')!.hidden = account.mustChangePassword;
  document.getElementById('notice')!.textContent = account.name + (account.mustChangePassword ? '：请先修改临时密码，再重新登录。' : '：可修改密码或退出；退出会影响同浏览器其他标签页。');
}
function bind(form: HTMLFormElement, path: string, complete: (result: Record<string, unknown>) => Promise<void>) {
  form.onsubmit = async event => {
    event.preventDefault(); if (busy) return; busy = true;
    const button = form.querySelector('button')!; button.disabled = true;
    try { const body = Object.fromEntries(new FormData(form)); await navigator.locks.request('geekdash_auth', async () => { const result = await send<Record<string, unknown>>(path, 'POST', body); form.reset(); await complete(result); }); }
    catch (error) { const unknown = form === password && error instanceof SaveError && error.outcome === 'unknown'; if (unknown) login.hidden = false; note(unknown ? '改密结果待确认，请用新密码正常登录核对；不要自动重复提交密码。' : (error as Error).message); }
    finally { busy = false; button.disabled = false; }
  };
}
bind(login, '/api/auth/login', async result => { await restore(); if (account!.id !== result.accountId) throw new SaveError('AUTH_CONTEXT_CHANGED', 'unknown'); notifyIdentityChange(); if (!document.getElementById('back')!.hidden) location.replace('/'); });
bind(password, '/api/auth/password', async () => { notifyIdentityChange(); login.hidden = false; password.hidden = true; logout.hidden = true; document.getElementById('back')!.hidden = true; note('密码已保存，请用新密码重新登录。'); });
logout.onclick = async () => {
  if (busy || !confirm('退出会影响同浏览器所有标签页，并清除本机恢复副本；服务器个人草稿保留。请先同步或复制未保存内容，确定退出？')) return;
  busy = true; logout.disabled = true;
  try { await navigator.locks.request('geekdash_auth', async () => { await send('/api/auth/logout', 'POST', {}); notifyIdentityChange(true); location.replace('/login.html'); }); }
  catch (error) { note((error as Error).message + ' 请核对登录状态，结果未确认时不要认为已经退出。'); }
  finally { busy = false; logout.disabled = false; }
};
void restore().catch(error => { if (!(error instanceof SaveError && error.code === 'AUTH_REQUIRED')) note((error as Error).message); });
