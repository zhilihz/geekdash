import './shared/read.css';
import './shared/detail.css';
import './shared/forms.css';
import { requireIdentity, send, SaveError, account } from './shared/api';
const form = document.getElementById('create') as HTMLFormElement;
const message = document.getElementById('message')!;
type Command = { idempotencyKey: string; fields: Record<string, string> };
let pending: Command | undefined, busy = false;
let identityChanged = false;
const key = () => `geekdash_create:${account!.id}`;
function controls() {
  form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea').forEach(input => input.disabled = busy || !!pending);
  (document.getElementById('save') as HTMLButtonElement).disabled = busy || !!pending || !account || identityChanged;
  for (const name of ['confirm', 'retry']) { const button = document.getElementById(name) as HTMLButtonElement; button.hidden = !pending; button.disabled = busy; }
}
async function execute(confirm: boolean) {
  if (!pending || busy) return; busy = true; controls();
  try {
    const result = await send<{ outcome: string; result?: { projectId: string } }>(confirm ? '/api/projects/create-results/query' : '/api/projects', 'POST', pending, !confirm);
    if (result.outcome === 'committed') { sessionStorage.removeItem(key()); pending = undefined; form.reset(); location.replace('/project-detail.html?id=' + result.result!.projectId); }
    else message.textContent = '暂未查到原创建结果；可重试原创建，不要另建重复项目。';
  } catch (error) {
    message.textContent = error instanceof SaveError && error.fields ? Object.values(error.fields).join('；') : (error as Error).message;
    if (error instanceof SaveError && error.outcome === 'not_committed' && !['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID'].includes(error.code)) { pending = undefined; sessionStorage.removeItem(key()); }
  } finally { busy = false; controls(); }
}
form.onsubmit = event => { event.preventDefault(); if (pending || busy || !account) return; pending = { idempotencyKey: crypto.randomUUID(), fields: Object.fromEntries(new FormData(form)) as Record<string, string> }; try { sessionStorage.setItem(key(), JSON.stringify(pending)); } catch { message.textContent = '恢复存储不可用，请保留此页面直到结果确认。'; } void execute(false); };
document.getElementById('confirm')!.onclick = () => { void execute(true); };
document.getElementById('retry')!.onclick = () => { void execute(false); };
document.addEventListener('geekdash-identity-changed', () => { identityChanged = true; message.textContent = '账号已变化，请保留本页输入，重新登录原账号再核对。'; controls(); });
window.addEventListener('beforeunload', event => { if (pending || [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].some(input => !!input.value)) event.preventDefault(); });
void requireIdentity().then(() => {
  const saved = sessionStorage.getItem(key()); if (saved) { pending = JSON.parse(saved); for (const [name, value] of Object.entries(pending!.fields)) (form.elements.namedItem(name) as HTMLInputElement).value = value; }
  controls(); if (pending) void execute(true);
}).catch(error => { message.textContent = (error as Error).message; document.getElementById('login')!.hidden = false; controls(); });
