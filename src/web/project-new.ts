import './shared/detail.css';
import './shared/read.css';
import './shared/reference-picker.css';
import { requireIdentity, get, send, SaveError, account, setupTheme, setupDateZone, esc, type EditValues, type Catalog } from './shared/api';
import { basicFields, referenceSelect, type BasicIntent } from './shared/project-form';
import { scopeFields } from './shared/scoped-editor';
import { mountReferencePickers, syncReferencePickers } from './shared/reference-picker';
import { PersonalDrafts, type DraftRef } from './shared/personal-state';
import { ProjectNotifications } from './shared/notifications';
import { refreshProjectOptions } from './shared/project-options';
import { attachStatusMentions } from './shared/status-mentions';
import { readableFields } from './shared/history';
setupTheme(); setupDateZone();
const form = document.getElementById('create') as HTMLFormElement;
const message = document.getElementById('message')!;
document.addEventListener('geekdash-preference-status',event=>{message.textContent=(event as CustomEvent<string>).detail;});
type Fields = Partial<EditValues> & { filingDate?: string | null; dueDate?: string | null; inviteeIds?:string[]; managerIds?:string[] };
type Command = { idempotencyKey: string; fields: Fields; draft?: DraftRef };
let personalDrafts: PersonalDrafts | undefined;
let pending: Command | undefined, busy = false, identityChanged = false, leaving = false, storageFailed = false;
let catalog: Catalog | undefined, businessDate = '', errors: Record<string, string> = {};
let catalogLoading=false,catalogRefreshPending=false;
let inviteeIds:string[]=[];
const value: EditValues = { name: '', summary: '', marketExpectation: '', detailNote: '', summaryNote: '', statusDesc: '', chipstatNote: '', signalNote: '', signal: 'green', priority: 'mid', customerId: null, odmCustomerId: null, productLineId: null, appId: null, groupId: null, chipIds: [], tagIds: [], people: [] };
const draft: BasicIntent = { filingDate: '', startDate: '', dueDate: '', closedOn: '', proposalDate: '', originalDueDate: '', state: 'proposal', planKind: 'reschedule', reason: '', measures: '', closureType: 'normal', closureNote: '', remainingWorkNote: '', maintenance: false };
const key = () => `geekdash_create:${account!.id}`;
function savedInput(){try{return sessionStorage.getItem(key());}catch{storageFailed=true;message.textContent='本页恢复存储不可用，请确认草稿同步或复制未保存内容。';return null;}}
function fields(): Fields { return { ...Object.fromEntries(scopeFields.basic.map(key => [key, structuredClone(value[key])])), statusDesc: value.statusDesc, filingDate: draft.filingDate || null, dueDate: draft.dueDate || null, inviteeIds:[...inviteeIds] }; }
const emptyFields=JSON.stringify(fields());
const hasInput=()=>JSON.stringify(fields())!==emptyFields;
function restoreFields(restored:Fields){
  restored={...restored,inviteeIds:restored.inviteeIds??restored.managerIds};
  inviteeIds=Array.isArray(restored.inviteeIds)?restored.inviteeIds.filter((id):id is string=>typeof id==='string' && id!==account!.id):[];
  for(const name of Object.keys(value))if(Object.hasOwn(restored,name))Object.assign(value,{[name]:structuredClone(restored[name as keyof Fields])});
  draft.filingDate=String(restored.filingDate ?? '');draft.dueDate=String(restored.dueDate ?? '');
}
async function leave(destination='/'){
  if(busy || leaving)return;
  const choose=async(text:string,choices:[string,string][])=>{
    const dialog=document.createElement('dialog');dialog.className='draft-dialog';dialog.innerHTML=`<h2>离开新建项目</h2><p>${esc(text)}</p><div class="entry-actions">${choices.map(([key,title])=>`<button class="back-btn" data-choice="${key}">${esc(title)}</button>`).join('')}</div>`;
    document.body.append(dialog);dialog.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach(button=>button.onclick=()=>dialog.close(button.dataset.choice));
    const result=new Promise<string>(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue || 'cancel'),{once:true}));dialog.showModal();const selected=await result;dialog.remove();return selected;
  };
  if(hasInput() || pending){
    const choice=await choose(pending?'原创建结果尚未确认，保留原请求后可继续核对。':'信息尚未创建为正式项目，怎样处理这些输入？',[['cancel','继续填写'],['keep','保留草稿并离开'],...pending?[]:[['discard','明确丢弃并离开'] as [string,string]]]);
    if(choice==='cancel')return;
    if(choice==='discard'){
      try{await personalDrafts?.discardAll();sessionStorage.removeItem(key());}catch(error){message.textContent='尚未完成丢弃，输入已保留。'+(error as Error).message;return;}
    }else{
      remember();const synced=await personalDrafts?.sync();
      if(!synced){
        const localProtected=!storageFailed || personalDrafts?.hasLocalCopy();
        if(await choose(localProtected?'草稿尚未全部同步，当前设备保留了副本。仍要离开吗？':'草稿未同步，本机副本也未保存；离开可能丢失输入，请先复制内容。仍要离开吗？',[['cancel','留在这里'],['leave',localProtected?'保留本机副本并离开':'已复制，仍然离开']])!=='leave')return;
      }
    }
  }
  leaving=true;location.href=destination;
}
function remember() {
  if (!account || identityChanged) return;
  try { sessionStorage.setItem(key(), JSON.stringify({ fields: fields(), pending }));storageFailed=false; }
  catch { storageFailed=true;message.textContent = '本页恢复存储不可用，请保留页面直到保存完成。'; }
  if(!pending)personalDrafts?.capture('create',undefined,null,{values:fields(),submission:{fields:fields()}});
}
function controls() {
  form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select').forEach(input => input.disabled = busy || !!pending || identityChanged || !account || input.dataset.reference === 'true' && !catalog);
  (document.getElementById('save') as HTMLButtonElement | null)?.toggleAttribute('disabled', busy || !!pending || !account || identityChanged);
  for (const name of ['confirm', 'retry']) { const button = document.getElementById(name) as HTMLButtonElement; button.hidden = !pending; button.disabled = busy || identityChanged; }
  syncReferencePickers();
}
function reference(key: string, table: string, role?: string) {
    const ids = key==='inviteeIds'?inviteeIds:key === 'people' ? value.people.filter(person => person.role === role).map(person => person.id) : value[key as keyof EditValues];
    const selected=Array.isArray(ids)?ids as string[]:ids?[String(ids)]:[],options=(catalog?.[table] ?? []).filter(item=>key!=='inviteeIds' || item.id!==account?.id);
    const source=document.getElementById(`edit-${key}${role?'-'+role:''}-source`) as HTMLSelectElement|null;
    for(const id of selected)if(!options.some(item=>item.id===id))options.push({id,name:[...(source?.options ?? [])].find(item=>item.value===id)?.textContent?.replace(/（停用\/不可新增）$/,'') ?? id,enabled:0});
    return referenceSelect(key,options,selected,[],role);
}
function render() {
  form.innerHTML = `<section class="project-info"><h2>基本信息与项目分工</h2>${basicFields({ project: { status: 'proposal', chips: [], people: [] }, businessDate, stages: [], nodes: [], risks: [] }, value, draft, true, reference, errors, true)}</section><section class="status-editor"><h2>最新状态说明</h2><textarea id="edit-statusDesc" rows="4" aria-label="最新状态说明">${esc(value.statusDesc)}</textarea><span class="field-error">${esc(errors.statusDesc)}</span></section><div class="entry-actions"><button id="save" type="submit" class="save-btn">保存并进入项目</button><button id="cancel" type="button" class="back-btn">取消</button></div>`;
  document.getElementById('responsibility')!.innerHTML = `<div class="field-fact">${account?'创建后项目归你，受邀者接受后加入。':'读取当前账号…'}</div><label for="edit-inviteeIds" class="read-label">邀请协作者（可选，可多选）</label>${reference('inviteeIds','managerAccounts')}<span class="field-error" id="error-inviteeIds">${esc(errors.inviteeIds)}</span>`;
  form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[id^="edit-"],textarea[id^="edit-"]').forEach(input => {
    input.oninput = () => { const name = input.id.slice(5); if (input.dataset.basic) Object.assign(draft, { [input.dataset.basic]: input.value }); else Object.assign(value, { [name]: input.value }); delete errors[name]; const error = document.getElementById('error-' + name); if (error) error.textContent = ''; remember(); };
  });
  form.querySelectorAll<HTMLSelectElement>('select').forEach(input => input.onchange = () => {
    const name = input.id.replace(/^edit-|-source$/g, '');
    if(name==='inviteeIds')inviteeIds=[...input.selectedOptions].map(option=>option.value);
    else if (name.startsWith('people-')) {
      const role = name.slice(7); value.people = [...value.people.filter(person => person.role !== role), ...[...input.selectedOptions].map(option => ({ id: option.value, role }))];
    } else Object.assign(value, { [name]: input.multiple ? [...input.selectedOptions].map(option => option.value) : input.value || null });
    delete errors[name];const error=document.getElementById('error-'+name);if(error)error.textContent='';remember();
  });
  document.getElementById('cancel')!.onclick = () => { void leave(); };
  attachStatusMentions(document.getElementById('edit-statusDesc') as HTMLTextAreaElement, () => (catalog?.engineers ?? []).filter(person => person.enabled));
  mountReferencePickers(form); controls();
}
async function execute(confirm: boolean) {
  if (!pending || busy || identityChanged) return; busy = true; controls();
  try {
    const result = await send<{ outcome: string; result?: { projectId: string;operationId:string;savedVersion:string;draft?:DraftRef&{instanceId:string;state:string} } }>(confirm ? '/api/projects/create-results/query' : '/api/projects', 'POST', pending, !confirm);
    if (result.outcome === 'committed') { await personalDrafts?.advance(result.result!,{kind:'create'});try{sessionStorage.removeItem(key());}catch{} pending = undefined; leaving = true; location.replace('/project-detail.html?id=' + result.result!.projectId); }
    else if(Object.hasOwn(pending.fields,'managerIds')){restoreFields(pending.fields);pending=undefined;remember();render();message.textContent='旧创建未入库，原信息已保留。原经理选择改为邀请协作者，请核对后创建。';}
    else message.textContent = '暂未查到原创建结果；可重试原创建，不要另建重复项目。';
  } catch (error) {
    message.textContent = error instanceof SaveError && error.fields ? Object.values(error.fields).join('；') : (error as Error).message;
    if (error instanceof SaveError && error.outcome === 'not_committed' && !['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'OPERATION_KEY_REUSED'].includes(error.code)) {
      pending = undefined; errors = error.fields ?? {}; remember(); render(); document.getElementById('edit-' + Object.keys(errors)[0])?.focus();
    }
  } finally { busy = false; controls(); }
}
form.onsubmit = event => { event.preventDefault(); if (pending || busy || !account || identityChanged) return; void(async()=>{
  remember();busy=true;controls();const submitted=fields(),ref=await personalDrafts?.prepare('create');
  if(identityChanged){busy=false;controls();return;}
  pending={idempotencyKey:crypto.randomUUID(),fields:submitted,...ref?{draft:ref}:{}};busy=false;remember();await execute(false);
})(); };
document.getElementById('confirm')!.onclick = () => { void execute(true); };
document.getElementById('retry')!.onclick = () => { void execute(false); };
document.getElementById('options-retry')!.onclick = () => { void loadCatalog(); };
async function loadCatalog() {
  if(identityChanged || !account)return;
  if(catalogLoading){catalogRefreshPending=true;return;}catalogLoading=true;catalogRefreshPending=false;
  try { const next = await get<Catalog>('/api/project-options',undefined,false); if(identityChanged)return;catalog=next;businessDate=next.businessDate;form.querySelectorAll<HTMLInputElement>('input[type="date"][max]').forEach(input=>input.max=businessDate);document.getElementById('options-retry')!.hidden = true;refreshProjectOptions(form,reference);controls(); }
  catch { document.getElementById('options-retry')!.hidden = false; message.textContent = '候选资料暂未读到，输入已保留。可重试读取，或先创建已填写的内容。'; controls(); }
  finally{catalogLoading=false;if(catalogRefreshPending && !identityChanged)void loadCatalog();}
}
window.addEventListener('focus',()=>{if(account && !leaving)void loadCatalog();});
document.addEventListener('geekdash-identity-changed', () => { identityChanged = true; message.textContent = '账号已变化，请保留本页输入，重新登录原账号再核对。'; controls(); });
document.addEventListener('geekdash-login-leave', () => { remember(); leaving = true; });
document.querySelectorAll<HTMLAnchorElement>('.project-nav a, .topbar a.back-btn').forEach(link=>{link.onclick=event=>{if(leaving && new URL(link.href).pathname==='/login.html')return;event.preventDefault();void leave(link.href);};});
window.addEventListener('beforeunload', event => { if (!leaving && (pending || hasInput())){remember();event.preventDefault();} });
void requireIdentity().then(async () => {
  personalDrafts=new PersonalDrafts(null,()=>({version:null,editable:!identityChanged && !pending && !busy}),row=>{
    if(pending || busy || identityChanged)return false;
    const before=JSON.stringify(fields());
    if(hasInput() && !confirm('恢复底稿将替换当前新建输入，是否继续？'))return false;
    if(pending || busy || identityChanged || before!==JSON.stringify(fields()))return false;
    const restored=row.payload.values;if(!restored)return false;
    restoreFields(restored);render();remember();message.textContent='底稿已恢复，点击保存才会创建正式项目。';return true;
  });
  const saved = savedInput();
  let candidate:Fields|undefined;
  if (saved) try { const stored = JSON.parse(saved); pending = stored.idempotencyKey ? stored : stored.pending; const restored = stored.fields; if (restored && typeof restored === 'object') { if(pending)restoreFields(restored);else candidate=restored; } }
  catch { message.textContent = '本页旧稿无法读取，请核对后重新填写。'; }
  render();
  await loadCatalog(); if (pending) void execute(true);
  if(!hasInput() && !pending)void personalDrafts.offer(candidate?{
    text:'本标签页：'+(readableFields(candidate,{inviteeIds:'邀请协作者'}).slice(0,140) || '有未保存的新建项目信息'),
    restore:()=>{if(pending || busy || identityChanged || hasInput() || savedInput()!==saved)return false;restoreFields(candidate!);render();remember();message.textContent='底稿已恢复，点击保存才会创建正式项目。';return true;},
    discard:()=>{if(!pending && !busy && !identityChanged && !hasInput() && savedInput()===saved)sessionStorage.removeItem(key());},
  }:undefined);
  new ProjectNotifications(()=>{},()=>{void loadCatalog();},text=>{if(text)message.textContent=text;},undefined,undefined,event=>{if(event.resource==='catalog')void loadCatalog();});
}).catch(error => { message.textContent = (error as Error).message; document.getElementById('login')!.hidden = false; controls(); });
