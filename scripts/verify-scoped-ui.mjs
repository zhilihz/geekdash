import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

// DOM执行模型用于检查真实前端代码的状态与接口链路，不替代浏览器布局/指针验收。
const { JSDOM, CookieJar, VirtualConsole } = await import(process.env.GEEKDASH_DOM_LIBRARY ?? '../test-results/ui-dom-tools/node_modules/jsdom/lib/api.js');
const users = [], projects = [], references = [], views = [], errors = [], checks = [];
const actionsMode = process.argv.includes('--actions'); let ownConfig = false;
const referencesMode = process.argv.includes('--references');
const recoveryMode = process.argv.includes('--recovery');
const nodeErrorsMode = process.argv.includes('--node-errors');
const catalogStatesMode = process.argv.includes('--catalog-states');
const nodeFollowupsMode = process.argv.includes('--node-followups');
const impactChainMode = process.argv.includes('--impact-chain');
const prefix = 'detail_ui_' + randomUUID().slice(0, 8), password = '页面整链测试 长短语 password 2026';
const authOrigin = 'http://localhost';
const html = await readFile(process.env.GEEKDASH_DETAIL_HTML ?? 'src/web/project-detail.html', 'utf8');
const detailSource = await readFile(process.env.GEEKDASH_DETAIL_SOURCE ?? 'src/web/detail.ts', 'utf8');
const apiSource = await readFile('src/web/shared/api.ts', 'utf8');
const referenceSource = await readFile('src/web/shared/reference-picker.ts', 'utf8');
const stageSource = (await readFile('geekdashdesktop/projects-data.js', 'utf8')).match(/const STAGES = (\[[\s\S]*?\n  \]);/);
assert(stageSource, '原版阶段常量存在');
const stages = vm.runInNewContext(stageSource[1], Object.create(null), { timeout: 1000 });
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1');
const { connection: c } = await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
let app, origin, requestCount = 0;
const reject = error => errors.push(error);
process.on('unhandledRejection', reject);

function client() {
  const jar = new CookieJar(); let actor;
  return { jar, async fetch(path, options = {}) {
    const url = new URL(path, origin).href, headers = new Headers(options.headers);
    headers.set('Cookie', jar.getCookieStringSync(url)); headers.set('Origin', authOrigin);
    requestCount++; const response = await fetch(url, { ...options, headers });
    for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, url);
    return response;
  }, async api(path, method = 'GET', body) {
    const csrf = jar.getCookiesSync(origin).find(cookie => cookie.key === 'geekdash_dev_csrf')?.value;
    const response = await this.fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', ...(csrf ? { 'X-GeekDash-CSRF': csrf } : {}), ...(actor ? { 'X-GeekDash-Account': actor.id } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json(); assert.equal(response.status, 200, path + ': ' + data.code);
    if (path === '/api/auth/me') actor = data.account; return data;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); } };
}
async function waitFor(predicate, context) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (errors.length) throw errors[0]; if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('未出现预期状态：' + context);
}
async function page(user, projectId, holdCatalog = false, options={}) {
  const virtualConsole = new VirtualConsole(), navigationAttempts=[]; virtualConsole.on('jsdomError', error => { if(options.create && /navigation/i.test(error.message))navigationAttempts.push(error.message);else reject(error); });
  const dom = new JSDOM(options.create?await readFile('src/web/project-new.html','utf8'):options.board?await readFile('src/web/index.html','utf8'):html, { url: origin + (options.create?'/project-new.html':options.board?'/'+(options.query ?? ''):'/project-detail.html?id=' + projectId+(options.returnTo?'&returnTo='+encodeURIComponent(options.returnTo):'')), cookieJar: user.jar, runScripts: 'outside-only', virtualConsole });
  views.push(dom); const w = dom.window;
  dom.projectReads = [];dom.draftWrites=[];dom.preferenceWrites=[];dom.createWrites=[];dom.actionWrites=[];dom.saveWrites=[];dom.previews=[];dom.navigationAttempts=navigationAttempts;dom.requestsRunning=0;
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone, AbortSignal, AbortController, __GEEKDASH_STAGES__: stages });
  dom.confirmPrompts=[];w.performance.getEntriesByType=()=>[];w.confirm=text=>{dom.confirmPrompts.push(text);return true;};
  w.scrollTo=()=>{};
  for(const [key,value] of Object.entries(options.local ?? {}))w.localStorage.setItem(key,value);
  for(const [key,value] of Object.entries(options.session ?? {}))w.sessionStorage.setItem(key,value);
  for(const name of options.blockStorage ?? [])Object.defineProperty(w,name,{get(){throw new w.DOMException('Storage disabled','SecurityError');}});
  w.BroadcastChannel = class { postMessage() {} };
  dom.streams=[];dom.events=[];
  if(options.realtime)w.EventSource=class extends w.EventTarget{
    controller=new AbortController();closed=false;onerror=null;
    constructor(url){super();dom.streams.push(this);void(async()=>{try{
      const response=await user.fetch(url,{signal:this.controller.signal});if(!response.ok)throw Error('SSE '+response.status);
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      for(;;){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=frame.match(/^event: (.+)$/m)?.[1],data=frame.match(/^data: (.+)$/m)?.[1];if(event && data){dom.events.push({event,data:JSON.parse(data)});this.dispatchEvent(new w.MessageEvent(event,{data}));}}}
      if(!this.closed)this.onerror?.();
    }catch{if(!this.closed)this.onerror?.();}})();}
    close(){this.closed=true;this.controller.abort();}
    disconnect(){this.controller.abort();}
  };
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; this.returnValue = ''; };
  w.HTMLDialogElement.prototype.close = function(value = '') { this.returnValue = value; this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.fetch = async (path, options) => {
    dom.requestsRunning++;try{
    if(path==='/api/project-options' && dom.catalogFailure){dom.catalogFailure=false;dom.catalogConsumed=true;throw new Error('模拟候选首次读取失败');}
    if(dom.rejectResultQueries && path.endsWith('/save-results/query'))throw new Error('模拟原结果持续暂不可查询');
    if(dom.rejectDrafts && path==='/api/personal/drafts/save')throw new Error('模拟草稿离线');
    if(dom.rejectDraftRead && path.startsWith('/api/personal/drafts?'))throw new Error('模拟草稿读取离线');
    if(dom.failDetailRead && path==='/api/projects/'+projectId && !options?.method){dom.failDetailRead=false;return new Response(JSON.stringify({code:'DATABASE_UNAVAILABLE',outcome:'not_committed'}),{status:503,headers:{'Content-Type':'application/json'}});}
    if(dom.corruptNodeOutput && options?.method==='PATCH'){dom.corruptNodeOutput=false;const body=JSON.parse(options.body);body.changes.nodeOps.find(op=>op.op==='add').fields.output='';options={...options,body:JSON.stringify(body)};}
    if(options?.method==='PATCH')dom.saveWrites.push(JSON.parse(options.body));
    const response = await user.fetch(path, options);
    if((path.endsWith('/save-preview') || path.endsWith('/actions/preview')) && response.ok)dom.previews.push({path,command:JSON.parse(options.body),result:await response.clone().json()});
    if(path==='/api/project-options' && dom.emptyCatalog){const json=response.json.bind(response);response.json=async()=>Object.fromEntries(Object.entries(await json()).map(([key,value])=>[key,Array.isArray(value)?[]:value]));}
    if(path==='/api/projects' && options?.method==='POST'){
      const data=await response.clone().json();dom.createWrites.push({status:response.status,data});
      if(response.ok && data.result?.projectId && !projects.includes(data.result.projectId))projects.push(data.result.projectId);
      if(dom.dropCreateAck && response.ok){dom.dropCreateAck=false;await response.arrayBuffer();throw Error('模拟创建COMMIT后丢回应');}
    }
    if(path==='/api/personal/preferences/save')dom.preferenceWrites.push({status:response.status,body:await response.clone().json()});
    if(path==='/api/personal/drafts/save' && response.ok)dom.draftWrites.push(await response.clone().json());
    if (path === '/api/projects/' + projectId && !options?.method && response.ok) dom.projectReads.push(await response.clone().json());
    if (holdCatalog && path === '/api/project-options') {
      await new Promise(resolve => { dom.releaseCatalog = resolve; });
      const json = response.json.bind(response);
      response.json = async () => { const data = await json(); setTimeout(() => { dom.catalogConsumed = true; }, 0); return data; };
    }
    if (!holdCatalog && path === '/api/project-options') {const json=response.json.bind(response);response.json=async()=>{const data=await json();setTimeout(()=>{dom.catalogConsumed=true;},0);return data;};}
    if (dom.holdSave && options?.method === 'PATCH') { dom.holdSave = false; await new Promise(resolve => { dom.releaseSave = resolve; }); }
    if (dom.dropSaveAck && options?.method === 'PATCH') { dom.dropSaveAck = false; await response.arrayBuffer(); throw new Error('模拟真实COMMIT后的确认丢失'); }
    if (path === '/api/projects/' + projectId + '/actions' && options?.method === 'POST') {
      dom.actionWrites.push({status:response.status,body:await response.clone().json()});
      if(dom.holdAction){dom.holdAction=false;await new Promise(resolve=>{dom.releaseAction=resolve;});}
      if(dom.dropActionAck){dom.dropActionAck=false;await response.arrayBuffer();throw new Error('模拟真实动作COMMIT后的确认丢失');}
    }
    return response;
    }finally{dom.requestsRunning--;}
  };
  const context = dom.getInternalVMContext(), modules = new Map();
  dom.catalogFailure=!!options.catalogFailure;dom.emptyCatalog=!!options.emptyCatalog;
  function load(path) {
    if (path.endsWith('.css')) return {};
    path = resolve(path.endsWith('.ts') ? path : path + '.ts');
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path,module);
    const code = ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
    vm.runInContext('(function(require,exports,module){' + code + '\n})',context,{filename:path})(name => load(resolve(dirname(path),name)),module.exports,module);
    return module.exports;
  }
  load(options.create?'src/web/project-new.ts':options.board?'src/web/board.ts':'src/web/detail.ts');
  await waitFor(() => options.create?w.document.getElementById('edit-name') && !w.document.getElementById('save').disabled:options.board?w.document.getElementById('result-count').textContent.includes('截至'):!w.document.getElementById('detail-panel').hidden && !w.document.getElementById('reload').disabled, '页面及可信身份就绪');
  if((recoveryMode || catalogStatesMode || nodeFollowupsMode || impactChainMode) && !holdCatalog && !options.board)await waitFor(()=>dom.catalogConsumed,'恢复验收等待初始化读取完成');
  if(options.realtime)await waitFor(()=>dom.events.some(item=>item.event==='connected'),'真实SSE页面连通');
  const $ = selector => w.document.querySelector(selector);
  const input = (selector, value) => { const element = $(selector); assert(element, selector); element.value = value; element.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const click = selector => { const element = $(selector); assert(element, selector); assert(!element.disabled, selector + ' 不应禁用'); element.click(); };
  const visibleClick = selector => { const element = $(selector); assert(element, selector); assert.equal(element.closest('[hidden]'), null, selector + ' 必须实际展示'); const dialog = element.closest('dialog'); if (dialog) assert(dialog.open, selector + ' 所在弹窗必须已打开'); click(selector); };
  return { dom, w, $, input, click, visibleClick, module:load, tab: value => click(`[data-tab="${value}"]`) };
}
async function facts(id) {
  const { connection } = await connectDatabase('test_app');
  try { return { project: (await connection.query('SELECT name,summary_note,CAST(version AS CHAR) version FROM projects WHERE id=?', [id]))[0][0], nodes: (await connection.query('SELECT CAST(id AS CHAR) id,title,output FROM project_nodes WHERE project_id=? AND deleted_at IS NULL ORDER BY id', [id]))[0], auditCount: Number((await connection.query('SELECT COUNT(*) n FROM audit_log WHERE project_id=?', [id]))[0][0].n) }; }
  finally { await connection.end(); }
}
async function recoveryChecks(a,b,id){
  const closePage=async view=>{view.w.document.dispatchEvent(new view.w.Event('geekdash-identity-changed'));await waitFor(()=>!view.dom.requestsRunning,'测试页关闭前已有读取完成');await new Promise(resolve=>setTimeout(resolve,0));view.dom.window.close();};
  const path='/api/projects/'+id, before=await facts(id);
  const blocked=await page(a,id,false,{blockStorage:['localStorage','sessionStorage']});
  blocked.dom.rejectDrafts=true;blocked.input('#edit-statusDesc','本机不可用，仍留在页面的输入');
  assert.match(blocked.$('#personal-drafts').title,/本机底稿存储不可用/);
  blocked.click('#personal-drafts');blocked.click('[data-sync]');
  await waitFor(()=>/本机底稿.*(未保存|不可用|无法读取)/.test(blocked.$('[data-draft-status]').textContent),'草稿及本机均失败，不能声称有副本');
  assert(!/已留在本机|已同步|当前设备保留/.test(blocked.$('[data-draft-status]').textContent));
  assert.equal(blocked.$('#edit-statusDesc').value,'本机不可用，仍留在页面的输入');assert.deepEqual(await facts(id),before);
  blocked.click('[data-close]');blocked.click('.top-sticky a.back-btn');
  await waitFor(()=>blocked.$('[data-choice="keep"]'),'离开先处理输入');blocked.click('[data-choice="keep"]');
  await waitFor(()=>blocked.$('[data-choice="leave"]'),'本机及云端都失败时仍需明确决定');
  assert.match(blocked.$('#editor-dialog').textContent,/本机副本也未保存/);assert.equal(blocked.$('[data-choice="leave"]').textContent,'已复制，仍然离开');blocked.click('[data-choice="cancel"]');
  blocked.dom.rejectDrafts=false;blocked.click('#personal-drafts');blocked.click('[data-sync]');
  await waitFor(()=>blocked.dom.draftWrites.some(row=>row.payload.values?.statusDesc==='本机不可用，仍留在页面的输入'),'存储禁用仍可云端同步');
  const savedBlocked=blocked.dom.draftWrites.at(-1);assert.equal((await a.api('/api/personal/drafts?clientDraftId='+savedBlocked.clientDraftId)).items[0].payload.values.statusDesc,'本机不可用，仍留在页面的输入');
  blocked.click('[data-close]');blocked.click('[data-save-scope="status"]');
  await waitFor(()=>blocked.dom.projectReads.at(-1)?.project.statusDesc==='本机不可用，仍留在页面的输入' && !blocked.$('#reload').disabled,'存储完全禁用仍能正式保存');
  assert.equal(BigInt((await facts(id)).project.version),BigInt(before.project.version)+1n);
  checks.push('PRD9.1/9.15/9.16：localStorage/sessionStorage getter均拒绝时详情仍工作；本机及云同步失败不伪称有副本，保留输入/离开警示准确；云恢复后草稿新GET及正式保存SQL一致');

  const newBlocked=await page(a,null,false,{create:true,blockStorage:['localStorage','sessionStorage']});newBlocked.dom.rejectDrafts=true;newBlocked.input('#edit-name',prefix+'存储禁用创建');
  newBlocked.click('#cancel');await waitFor(()=>newBlocked.$('[data-choice="keep"]'),'新建保留');newBlocked.click('[data-choice="keep"]');await waitFor(()=>newBlocked.$('[data-choice="leave"]'),'新建未同步提示');
  assert.match(newBlocked.$('dialog[open]').textContent,/本机副本也未保存/);newBlocked.click('[data-choice="cancel"]');
  newBlocked.dom.rejectDrafts=false;newBlocked.$('#create').dispatchEvent(new newBlocked.w.Event('submit',{bubbles:true,cancelable:true}));
  await waitFor(()=>newBlocked.dom.createWrites.some(write=>write.data.outcome==='committed') && newBlocked.dom.navigationAttempts.length,'成功创建不被缓存清理异常误判');
  const newResult=newBlocked.dom.createWrites.at(-1).data.result;assert.equal((await a.api('/api/projects/'+newResult.projectId)).project.name,prefix+'存储禁用创建');assert.equal((await facts(newResult.projectId)).project.version,'1');
  checks.push('PRD9.1/9.5/9.15：两类本机存储禁用时新建仍可输入，离开提示准确；正式创建只写一次且跳转，不被缓存清理异常阻断，新GET/SQL核对');

  const made=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'关闭恢复'}}),closedId=made.result.projectId;projects.push(closedId);
  const closing=await page(a,closedId);closing.input('#edit-statusDesc','已确认的云端输入');await waitFor(()=>closing.dom.draftWrites.length,'先有已确认云稿');
  const cloudId=closing.dom.draftWrites.at(-1).clientDraftId;closing.dom.rejectDrafts=true;closing.input('#edit-statusDesc','最后输入尚未同步');
  const local=Object.fromEntries(Object.entries(closing.w.localStorage));closing.dom.window.close();
  assert.equal((await a.api('/api/personal/drafts?clientDraftId='+cloudId)).items[0].payload.values.statusDesc,'已确认的云端输入');
  const reopened=await page(a,closedId,false,{local});reopened.dom.rejectDrafts=true;reopened.click('#personal-drafts');await waitFor(()=>reopened.$('[data-source="local"] [data-restore]'),'重开后本机未同步副本可选择');reopened.click('[data-source="local"] [data-restore]');
  await waitFor(()=>reopened.$('#edit-statusDesc').value==='最后输入尚未同步','恢复本机最后输入');assert.equal((await a.api('/api/projects/'+closedId)).project.statusDesc,'');
  const cloudOnly=await page(a,closedId);cloudOnly.click('#personal-drafts');await waitFor(()=>cloudOnly.$('[data-draft-list]').textContent.includes('已确认的云端输入'),'没有本机副本只能取服务器确认稿');
  assert(!cloudOnly.$('[data-draft-list]').textContent.includes('最后输入尚未同步'));await closePage(reopened);await closePage(cloudOnly);
  checks.push('PRD9.15：关闭页面前最后输入未同步时，云端仍只返回已确认稿；重开有本机副本可恢复最后输入，无本机副本不伪造恢复；恢复本身不写正式项目（执行模型关闭，非OS强杀）');

  const conflict=await page(a,id);conflict.input('#edit-statusDesc','本页同步原稿');await waitFor(()=>conflict.dom.draftWrites.length,'修订冲突原稿');
  const draft=conflict.dom.draftWrites.at(-1),newPayload={...draft.payload,values:{statusDesc:'其他标签更新的云稿'},submission:{scope:'status',changes:{statusDesc:'其他标签更新的云稿'}}};
  await a.api('/api/personal/drafts/save','POST',{clientDraftId:draft.clientDraftId,projectId:id,formKind:'status',baseVersion:draft.baseVersion,expectedDraftVersion:draft.draftVersion,clientSequence:String(BigInt(draft.clientSequence)+1n),payload:newPayload});
  conflict.input('#edit-statusDesc','冲突后本页文字不能丢');conflict.click('#personal-drafts');conflict.click('[data-sync]');await waitFor(()=>conflict.$('[data-draft-status]').textContent.includes('已有新修订'),'草稿修订冲突可理解提示');
  assert.equal(conflict.$('#edit-statusDesc').value,'冲突后本页文字不能丢');assert.equal((await a.api('/api/personal/drafts?clientDraftId='+draft.clientDraftId)).items[0].payload.values.statusDesc,'其他标签更新的云稿');
  const row=(await c.query('SELECT payload_json payload FROM project_drafts WHERE user_id=? AND client_draft_id=?',[users[0].id,draft.clientDraftId]))[0][0];assert.equal((typeof row.payload==='string'?JSON.parse(row.payload):row.payload).values.statusDesc,'其他标签更新的云稿');
  await closePage(conflict);checks.push('PRD9.15：真实另一修订先保存，旧页面同步被拒绝并保留文字；新GET和SQL确认云稿不被覆盖');

  const capacity=await page(b,null,false,{create:true}), blank={schemaVersion:1,instanceId:randomUUID(),values:{name:'合成容量稿'},submission:{fields:{name:'合成容量稿'}}};
  for(let i=0;i<100;i++)await c.execute("INSERT INTO project_drafts (user_id,client_draft_id,form_kind,client_sequence,payload_json,state,created_at,updated_at) VALUES (?,?,'create',1,?,'active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",[users[1].id,randomUUID(),JSON.stringify(blank)]);
  capacity.input('#edit-name','容量已满仍需保护的输入');capacity.click('#personal-drafts');capacity.click('[data-sync]');await waitFor(()=>capacity.$('[data-draft-status]').textContent.includes('个人草稿已满'),'满额明确提示');
  assert.equal(capacity.$('#edit-name').value,'容量已满仍需保护的输入');assert.equal(Number((await c.query("SELECT COUNT(*) n FROM project_drafts WHERE user_id=? AND state='active'",[users[1].id]))[0][0].n),100);
  assert.equal((await b.api('/api/personal/drafts?projectId=new')).items.length,100);await closePage(capacity);
  const oversized=await page(a,id);for(const length of [180000,350000]){oversized.input('#edit-statusDesc','大'.repeat(length));oversized.click('#personal-drafts');oversized.click('[data-sync]');await waitFor(()=>oversized.$('[data-draft-status]').textContent.includes('本份草稿过大'),'单稿容量及HTTP正文容量明确提示');assert.equal(oversized.$('#edit-statusDesc').value.length,length);oversized.click('[data-close]');}await closePage(oversized);
  checks.push('PRD9.15：本人100份有效稿和超大单稿由真实服务拒绝，页面显示具体限制且不截断输入；新GET/SQL确认原稿未被清空，不增加业务数量限制');

  const unknown=await page(a,id),unknownBefore=await facts(id);unknown.input('#edit-name',prefix+'持续查询故障');unknown.input('#edit-statusDesc','另一范围不应提交');unknown.dom.dropSaveAck=true;unknown.dom.rejectResultQueries=true;
  unknown.click('[data-save-scope="basic"]');await waitFor(()=>unknown.$('#confirm') && !unknown.$('#confirm').disabled,'真实提交响应丢失');
  for(let i=0;i<3;i++){unknown.click('#confirm');await waitFor(()=>!unknown.$('#confirm').disabled,'原结果仍无法查询');assert.equal(unknown.$('#edit-statusDesc').value,'另一范围不应提交');}
  assert.equal(unknown.dom.saveWrites.length,1);assert.equal((await a.api(path)).project.name,prefix+'持续查询故障');assert.equal(BigInt((await facts(id)).project.version),BigInt(unknownBefore.project.version)+1n);
  unknown.dom.rejectResultQueries=false;unknown.click('#confirm');await waitFor(()=>!unknown.$('#confirm') && !unknown.$('#reload').disabled,'原结果查询恢复');assert.equal(unknown.dom.saveWrites.length,1);assert.equal(unknown.$('#edit-statusDesc').value,'另一范围不应提交');assert.equal((await facts(id)).auditCount,unknownBefore.auditCount+1);await closePage(unknown);
  checks.push('PRD9.1：真实COMMIT后丢回应且连续三次原结果查询失败，保持原请求和其他范围输入；恢复后确认同一回执，独立SQL/新GET仅一版一条历史');

  const logoutPage=await page(a,id),actor=users[0].id,other=users[1].id;
  for(const storage of [logoutPage.w.localStorage,logoutPage.w.sessionStorage]){storage.setItem('geekdash_draft:'+actor+':test','本人敏感输入');storage.setItem('geekdash_project_buffer:'+actor+':'+id,'本人敏感输入');storage.setItem('geekdash_draft:'+other+':test','其他账号隔离输入');}
  await a.api('/api/auth/logout','POST',{});logoutPage.module('src/web/shared/api.ts').notifyIdentityChange(true);
  for(const storage of [logoutPage.w.localStorage,logoutPage.w.sessionStorage]){assert.equal(storage.getItem('geekdash_draft:'+actor+':test'),null);assert.equal(storage.getItem('geekdash_project_buffer:'+actor+':'+id),null);assert.equal(storage.getItem('geekdash_draft:'+other+':test'),'其他账号隔离输入');}
  assert.equal((await a.fetch('/api/auth/me')).status,401);assert.doesNotThrow(()=>blocked.module('src/web/shared/api.ts').notifyIdentityChange(true));
  await a.login(0);assert((await a.api('/api/personal/drafts?projectId='+id)).items.length>0,'退出不删除服务器私人草稿');
  checks.push('PRD9.2/9.15：真实退出撤销会话，公共身份清理删除本人本机敏感缓存且保留其他账号命名空间；存储getter禁用不抛出误导错误，重新登录仍可读本人云稿');
}
async function nodeErrorChecks(a,id){
  const view=await page(a,id),before=await facts(id);view.tab('nodes');view.click('[data-node="add"]');view.input('[data-node-field="title"]','漏填成果后继续');view.click('#node-edit [type="submit"]');
  await waitFor(()=>view.$('#node-error').textContent.includes('输出成果：请填写有效文字') && !view.$('#node-edit [type="submit"]').disabled,'预览拒绝准确说明输出成果');
  assert.equal(view.w.document.activeElement,view.$('[data-node-field="output"]'));assert.equal(view.$('[data-node-field="output"]').getAttribute('aria-invalid'),'true');assert.equal(view.$('[data-node-field="title"]').value,'漏填成果后继续');assert.deepEqual(await facts(id),before);
  view.input('[data-node-field="output"]','补齐原本要求的成果');assert.equal(view.$('[data-node-field="output"]').getAttribute('aria-invalid'),null);view.click('#node-edit [type="submit"]');
  await waitFor(()=>view.dom.projectReads.at(-1)?.nodes.some(node=>node.title==='漏填成果后继续') && !view.$('#reload').disabled,'同一表单修正后保存');
  let current=await facts(id);assert.equal(current.nodes[0].output,'补齐原本要求的成果');assert.equal(BigInt(current.project.version),BigInt(before.project.version)+1n);assert.equal(current.auditCount,before.auditCount+1);
  checks.push('PRD9.1/9.12：项目节点漏填输出成果，真实预览拒绝后显示业务字段名并聚焦/标识原输入；其余输入及数据库保持，补填同处一次保存，新GET/SQL一致');

  view.click('[data-node="add"]');view.input('[data-node-field="title"]','正式保存拒绝仍保留');view.input('[data-node-field="output"]','界面原成果');view.dom.corruptNodeOutput=true;view.click('#node-edit [type="submit"]');
  await waitFor(()=>view.$('#node-error')?.textContent.includes('输出成果：请填写有效文字') && !view.$('#node-edit [type="submit"]').disabled,'正式写入拒绝仍定位字段');
  assert.equal(view.$('[data-node-field="title"]').value,'正式保存拒绝仍保留');assert.equal(view.$('[data-node-field="output"]').value,'界面原成果');assert.equal(view.w.document.activeElement,view.$('[data-node-field="output"]'));assert.deepEqual(await facts(id),current);
  view.input('[data-node-field="output"]','明确核对后保存成果');view.click('#node-edit [type="submit"]');await waitFor(()=>view.dom.projectReads.at(-1)?.nodes.some(node=>node.output==='明确核对后保存成果') && !view.$('#reload').disabled,'正式错误修正后继续');
  const after=await facts(id);assert.equal(BigInt(after.project.version),BigInt(current.project.version)+1n);assert.equal(after.auditCount,current.auditCount+1);current=after;
  checks.push('PRD9.1/9.12：预览通过后将线上提交包成果清空以触发真实后端拒绝；原表单值完整保留并定位成果，纠正重存后SQL仅一版/一条历史，无部分节点写入');

  view.tab('custnodes');view.click('[data-node="add"]');view.input('[data-node-field="note"]','客户备注保留');view.click('#node-edit [type="submit"]');await waitFor(()=>view.$('#node-error').textContent.includes('节点名称：请填写有效文字') && !view.$('#node-edit [type="submit"]').disabled,'客户节点名称定位');
  assert.equal(view.w.document.activeElement,view.$('[data-node-field="title"]'));assert.equal(view.$('[data-node-field="note"]').value,'客户备注保留');assert.deepEqual(await facts(id),current);
  view.input('[data-node-field="title"]','客户确认');view.click('#node-edit [type="submit"]');await waitFor(()=>view.dom.projectReads.at(-1)?.nodes.some(node=>node.kind==='customer' && node.title==='客户确认') && !view.$('#reload').disabled,'客户节点修正同处保存');
  assert.equal((await a.api('/api/projects/'+id)).nodes.find(node=>node.kind==='customer').note,'客户备注保留');assert.equal(BigInt((await facts(id)).project.version),BigInt(current.project.version)+1n);
  checks.push('PRD9.1/9.12：客户节点复用同一错误定位，空名称被真实服务拒绝，备注原样保留，补名称后同处保存并新GET/SQL回读');
}
async function impactChainChecks(a,id){
  const path='/api/projects/'+id,read=()=>a.api(path),action=async body=>a.api(path+'/actions','POST',{expectedVersion:(await read()).project.version,idempotencyKey:randomUUID(),...body});
  const close=async view=>{view.w.document.dispatchEvent(new view.w.Event('geekdash-identity-changed'));await waitFor(()=>!view.dom.requestsRunning,'影响测试页面结束');await new Promise(resolve=>setTimeout(resolve,0));view.dom.window.close();};
  const stageFacts=async()=> (await c.query("SELECT stage_code code,state,DATE_FORMAT(started_on,'%Y-%m-%d') startedOn,DATE_FORMAT(completed_on,'%Y-%m-%d') completedOn FROM project_stages WHERE project_id=? ORDER BY stage_code",[id]))[0].map(row=>({...row}));
  await action({action:'startStage',stageCode:'S1',actualDate:'2020-01-01'});await action({action:'completeStage',stageCode:'S1',actualDate:'2020-01-02',completionNote:''});
  const stage=await page(a,id);assert(stage.$('.topbar #personal-drafts'),'详情草稿入口位于居中顶栏');stage.tab('stages');stage.click('[data-correction="undoStageComplete"][data-stage="S1"]');await waitFor(()=>stage.$('#correction-reason'),'打开阶段撤销表单');stage.input('#correction-reason','撤销误记的完成');const before=await facts(id),beforeStages=await stageFacts();stage.click('#correction-edit [type="submit"]');
  await waitFor(()=>stage.$('#editor-dialog .impact-chain'),'阶段服务端影响已展示');
  let preview=stage.dom.previews.at(-1).result,chain=stage.$('#editor-dialog .impact-chain').textContent;
  assert.equal(preview.stageChanges.find(row=>row.code==='S1').state,'active');assert.equal(preview.stageChanges.find(row=>row.code==='S2').state,'locked');assert.match(chain,/S1[\s\S]*已完成 → 进行中/);assert.match(chain,/因为 S1[\s\S]*S2[\s\S]*待开始 → 未解锁/);assert(!chain.includes('S3'),'未变化阶段不进入因果链');assert(stage.$('#editor-dialog .comparison-table'));
  assert.deepEqual(await facts(id),before);assert.deepEqual(await stageFacts(),beforeStages);stage.click('[data-choice="cancel"]');await waitFor(()=>!stage.$('#editor-dialog').open && !stage.$('#reload').disabled,'返回修改不写');
  stage.click('#correction-undo-start');stage.click('#correction-edit [type="submit"]');await waitFor(()=>stage.$('#editor-dialog').open && stage.$('#editor-dialog .impact-chain'),'改选后阶段重预览');
  preview=stage.dom.previews.at(-1).result;assert.equal(preview.stageChanges.find(row=>row.code==='S1').state,'ready');assert.match(stage.$('#editor-dialog .impact-chain').textContent,/已完成 → 待开始/);stage.click('[data-choice="save"]');
  await waitFor(()=>stage.dom.projectReads.at(-1)?.stages[0].state==='ready' && !stage.$('#reload').disabled,'阶段影响明确保存');
  for(const change of preview.stageChanges)assert.deepEqual((await stageFacts()).find(row=>row.code===change.code),change);
  assert.equal(BigInt((await facts(id)).project.version),BigInt(before.project.version)+1n);await close(stage);
  checks.push('阶段因果：真实S1撤销完成预览列S1完成→进行中、因S1未完成使S2待开始→未解锁，仅两项实际变化；取消SQL不动，改选连开始一并撤销重算为待开始，确认后SQL阶段与预览一致且仅一版。');
  const add=Object.fromEntries(['A','B','C'].map(name=>[name,randomUUID()]));
  const saved=await a.api(path,'PATCH',{scope:'projectNodes',expectedVersion:(await read()).project.version,idempotencyKey:randomUUID(),changes:{nodeOps:[...Object.entries(add).map(([name,tempId])=>({op:'add',tempId,kind:'project',fields:{title:'因果节点'+name,stage:'S1',output:'成果'+name}})),{op:'link',from:add.A,to:add.B,replaceEdges:[],affectedIds:[],reason:''},{op:'link',from:add.B,to:add.C,replaceEdges:[],affectedIds:[],reason:''},...Object.values(add).map(key=>({op:'complete',id:key,completedOn:'2020-01-02'}))]}});
  const {A,B,C}=Object.fromEntries(Object.entries(add).map(([name,key])=>[name,saved.result.nodeIdMap[key]]));
  const node=await page(a,id);node.tab('nodes');node.click(`[data-node="correct"][data-node-id="${A}"]`);node.click('[data-node-form-action="uncomplete"]');await waitFor(()=>node.$('#node-reason'),'撤销节点表单');node.input('#node-reason','完成误录按依赖撤销');const nodeBefore=await read();node.click('#node-edit [type="submit"]');
  await waitFor(()=>node.$('#node-preview .impact-chain') && !node.$('#node-accept').disabled,'节点实际影响链');preview=node.dom.previews.at(-1).result;
  assert.deepEqual(preview.requiredUncompleteIds.sort(),[B,C].sort());chain=node.$('#node-preview .impact-chain').textContent;assert.match(chain,/因果节点A → 因果节点B/);assert.match(chain,/因果节点A → 因果节点B → 因果节点C/);assert.match(chain,/前置将未完成/);
  const tableText=node.$('#node-preview .comparison-table').textContent;for(const name of ['因果节点A','因果节点B','因果节点C'])assert(tableText.includes(name),'每个实际影响对象以名称对应前后对照');assert.match(tableText,/未完成/);assert.deepEqual((await read()).nodes,nodeBefore.nodes);
  node.click('#node-cancel');await waitFor(()=>!node.$('#node-edit') && !node.$('#reload').disabled,'取消节点影响');node.click(`[data-node="correct"][data-node-id="${B}"]`);node.click('[data-node-form-action="uncomplete"]');await waitFor(()=>node.$('#node-reason'),'改选撤销B');node.input('#node-reason','仅B误录');node.click('#node-edit [type="submit"]');await waitFor(()=>node.$('#node-preview .impact-chain') && !node.$('#node-accept').disabled,'新的B链');
  preview=node.dom.previews.at(-1).result;assert.deepEqual(preview.requiredUncompleteIds,[C]);chain=node.$('#node-preview .impact-chain').textContent;assert(!chain.includes('因果节点A'));assert.match(chain,/因果节点B → 因果节点C/);node.click('#node-accept');
  await waitFor(()=>node.dom.projectReads.at(-1)?.nodes.find(row=>row.id===B)?.completedOn===null && !node.$('#reload').disabled,'B/C完成同次撤销');
  const nodeAfter=await read();assert.equal(nodeAfter.nodes.find(row=>row.id===A).completedOn,'2020-01-02');for(const key of [B,C])assert.equal(nodeAfter.nodes.find(row=>row.id===key).completedOn,null);assert.deepEqual(nodeAfter.stages,nodeBefore.stages);
  const actual=(await c.query('SELECT CAST(id AS CHAR) id,completed_on completed FROM project_nodes WHERE project_id=? ORDER BY id',[id]))[0];assert(actual.find(row=>row.id===A).completed);assert.equal(actual.find(row=>row.id===B).completed,null);assert.equal(actual.find(row=>row.id===C).completed,null);assert.equal(BigInt(nodeAfter.project.version),BigInt(nodeBefore.project.version)+1n);await close(node);
  checks.push('节点因果：真实A→B→C已完成，撤销A预览仅服务端required B/C，展示直接/间接路径及三条实际完成前后；取消无写，改选B后链仅B→C，确认新GET/SQL仅B/C撤销，A和阶段保持。');
  await action({action:'closeProject',closureType:'normal',closedOn:(await read()).businessDate,closureNote:'未完成成果在重开后继续',remainingWorkNote:''});await action({action:'setMaintenance',enabled:true,reason:''});
  const reopen=await page(a,id),closed=await read();reopen.input('#edit-state','proposal');reopen.$('#edit-state').dispatchEvent(new reopen.w.Event('change',{bubbles:true}));reopen.input('#edit-name',prefix+'独立改名');reopen.input('#edit-statusDesc','另区说明保留');reopen.click('[data-save-scope="basic"]');
  await waitFor(()=>reopen.$('#editor-dialog .impact-chain'),'基本区重开复用服务器预览');preview=reopen.dom.previews.at(-1).result;
  assert.equal(preview.beforeValues.closure.status,'closed');assert.equal(preview.afterValues.closure.status,'proposal');chain=reopen.$('#editor-dialog .impact-chain').textContent;assert.match(chain,/已结案 → 提案中/);assert.match(chain,/实际结案日/);assert.match(chain,/结案后维护：开启 → 关闭/);assert(!chain.includes('独立改名'),'独立文字不冒充重开的自动结果');assert.equal((await read()).project.version,closed.project.version);
  reopen.click('[data-choice="save"]');await waitFor(()=>reopen.dom.projectReads.at(-1)?.project.status==='proposal' && !reopen.$('#reload').disabled,'基本区一次保存重开和独立普通输入');
  const open=await read();assert.equal(open.project.closedOn,null);assert.equal(Number(open.project.maintenanceEnabled),0);assert.equal(open.project.name,prefix+'独立改名');assert.equal(open.project.statusDesc,'');assert.equal(reopen.$('#edit-statusDesc').value,'另区说明保留');
  const closure=(await c.query('SELECT status,closed_on,maintenance_enabled FROM projects WHERE id=?',[id]))[0][0];assert.equal(closure.status,'proposal');assert.equal(closure.closed_on,null);assert.equal(closure.maintenance_enabled,0);await close(reopen);
  checks.push('基本区重开因果：既有一次确认复用真实结案预览，显示状态恢复、当前结案事实归历史与维护关闭；确认前版本不变，单次基本保存后新GET/SQL一致，独立名称不伪装成联动，另区说明不夹带。');
}
async function nodeFollowupChecks(a,id){
  const path='/api/projects/'+id,read=()=>a.api(path),save=async nodeOps=>a.api(path,'PATCH',{scope:'projectNodes',expectedVersion:(await read()).project.version,idempotencyKey:randomUUID(),changes:{nodeOps}});
  const temp=Object.fromEntries(['A','B','C','D'].map(name=>[name,randomUUID()]));
  const added=await save(Object.entries(temp).map(([name,tempId])=>({op:'add',kind:'project',tempId,fields:{title:'节点'+name,stage:'S1',output:'成果'+name,targetDate:null}})));
  const ids=Object.fromEntries(Object.entries(temp).map(([name,key])=>[name,added.result.nodeIdMap[key]])),{A,B,C,D}=ids;
  await save([{op:'link',from:A,to:B,replaceEdges:[],affectedIds:[],reason:''}]);
  const view=await page(a,id);view.tab('nodes');view.click(`[data-node="correct"][data-node-id="${A}"]`);view.click('[data-node-form-action="link"]');
  await waitFor(()=>view.$('#node-to'),'打开旧线替换');view.input('#node-to',C);view.click('#node-edit [type="submit"]');
  await waitFor(()=>!view.$('#node-accept').hidden && !view.$('#node-accept').disabled,'旧线变更预览');
  assert.match(view.$('#node-preview').textContent,/节点A/);assert.match(view.$('#node-preview').textContent,/节点B/);const before=await facts(id),beforeRead=await read();
  view.input('#node-to',D);assert(view.$('#node-accept').hidden);assert.equal(view.$('#node-preview').textContent,'');assert.deepEqual(await facts(id),before);
  view.click('#node-edit [type="submit"]');await waitFor(()=>!view.$('#node-accept').hidden && !view.$('#node-accept').disabled,'改目标后重预览');view.click('#node-accept');
  await waitFor(()=>view.dom.projectReads.at(-1)?.nodes.find(node=>node.id===A)?.nextNodeId===D && !view.$('#reload').disabled,'明确保存新目标');
  const linked=await read();assert.equal(linked.nodes.find(node=>node.id===B).previousNodeId,null);assert.equal(linked.nodes.find(node=>node.id===D).previousNodeId,A);assert.equal(linked.nodes.find(node=>node.id===C).previousNodeId,null);assert.equal(BigInt(linked.project.version),BigInt(beforeRead.project.version)+1n);
  const sqlLinks=(await c.query('SELECT CAST(next_node_id AS CHAR) nextId FROM project_nodes WHERE id=?',[A]))[0];assert.equal(sqlLinks[0].nextId,D);
  checks.push('PRD9.12-8：真实旧线A→B在页面预览影响，目标C改为D后旧预览立即失效；重预览并确认仅保存A→D，B旧前置清除、C不变，新GET/SQL只一版。');
  view.w.document.dispatchEvent(new view.w.Event('geekdash-identity-changed'));await waitFor(()=>!view.dom.requestsRunning,'替换链页面完成');view.dom.window.close();
  await c.execute('UPDATE project_nodes SET stage_id=NULL,target_date=NULL,source_key=? WHERE id=?',['合成未知来源节点',B]);
  const legacy=await page(a,id);legacy.tab('nodes');legacy.click(`[data-node="correct"][data-node-id="${B}"]`);
  assert.equal(legacy.$('[data-node-field="stage"]').value,'');assert.match(legacy.$('[data-node-field="stage"] option:checked').textContent,/原阶段未知/);assert.equal(legacy.$('[data-node-field="targetDate"]').value,'');
  legacy.input('[data-node-field="title"]','只改名称不补造旧阶段');legacy.click('#node-edit [type="submit"]');
  await waitFor(()=>legacy.dom.projectReads.at(-1)?.nodes.find(node=>node.id===B)?.title==='只改名称不补造旧阶段' && !legacy.$('#reload').disabled,'未知来源普通文字保存');
  const old=(await read()).nodes.find(node=>node.id===B);assert.equal(old.stage,null);assert.equal(old.targetDate,null);assert.equal(old.sourceKey,'合成未知来源节点');
  const unknown=(await c.query('SELECT stage_id,target_date,source_key FROM project_nodes WHERE id=?',[B]))[0][0];assert.equal(unknown.stage_id,null);assert.equal(unknown.target_date,null);assert.equal(unknown.source_key,'合成未知来源节点');
  checks.push('PRD9.12-10：合成旧节点阶段/目标日为空，实际表单明确原阶段未知且不默认S1；只纠正名称，新GET/SQL保持未知日期、阶段与原来源，不补造业务事实。');
  legacy.w.document.dispatchEvent(new legacy.w.Event('geekdash-identity-changed'));await waitFor(()=>!legacy.dom.requestsRunning,'旧来源页面完成');legacy.dom.window.close();
  await save([{op:'delete',id:B,removeEdges:[]}]);await c.execute('UPDATE project_nodes SET completed_on=? WHERE id=?',['2099-01-01',B]);
  const recovery=await page(a,id);recovery.tab('nodes');recovery.click('#deleted-refresh');await waitFor(()=>recovery.$(`[data-node="restore"][data-node-id="${B}"]`),'已删未知节点可核对');recovery.click(`[data-node="restore"][data-node-id="${B}"]`);recovery.input('#node-reason','纠正原阶段与实际日后恢复');
  const rejected=await facts(id);recovery.click('#node-edit [type="submit"]');await waitFor(()=>recovery.$('#node-error').textContent && !recovery.$('#reload').disabled,'缺阶段恢复拒绝');
  assert.equal(recovery.$('#node-reason').value,'纠正原阶段与实际日后恢复');assert.deepEqual(await facts(id),rejected);
  recovery.click('[data-restore-select="stage"]');recovery.input('[data-restore-field="stage"]','S3');recovery.click('#node-edit [type="submit"]');await waitFor(()=>recovery.$('#node-error').textContent && !recovery.$('#reload').disabled,'未来实际日仍拒绝');
  assert.equal(recovery.$('[data-restore-field="stage"]').value,'S3');assert(recovery.$('[data-restore-select="stage"]').checked);assert.deepEqual(await facts(id),rejected);
  recovery.click('#restore-actual-select');recovery.input('#restore-actual','');recovery.click('#node-edit [type="submit"]');
  await waitFor(()=>recovery.dom.projectReads.at(-1)?.nodes.some(node=>node.id===B) || recovery.$('#node-accept') && !recovery.$('#node-accept').hidden,'纠正后恢复预览或保存');
  if(recovery.$('#node-accept') && !recovery.$('#node-accept').hidden)recovery.click('#node-accept');
  await waitFor(()=>recovery.dom.projectReads.at(-1)?.nodes.some(node=>node.id===B) && !recovery.$('#reload').disabled,'纠正与恢复同次正式保存');
  const restored=(await read()).nodes.find(node=>node.id===B);assert.equal(restored.stage,'S3');assert.equal(restored.completedOn,null);assert.equal(restored.sourceKey,'合成未知来源节点');assert.equal(restored.previousNodeId,null);assert.equal(restored.nextNodeId,null);assert.equal(BigInt((await facts(id)).project.version),BigInt(rejected.project.version)+1n);
  recovery.click(`[data-node="correct"][data-node-id="${B}"]`);recovery.click('[data-node-form-action="link"]');await waitFor(()=>recovery.$('#node-to'),'恢复节点重新选择关系');recovery.input('#node-to',C);recovery.click('#node-edit [type="submit"]');
  await waitFor(()=>recovery.dom.projectReads.at(-1)?.nodes.find(node=>node.id===B)?.nextNodeId===C && !recovery.$('#reload').disabled,'恢复后明确连接新节点');assert.equal((await read()).nodes.find(node=>node.id===C).previousNodeId,B);
  assert.equal((await c.query('SELECT CAST(next_node_id AS CHAR) nextId FROM project_nodes WHERE id=?',[B]))[0][0].nextId,C);
  checks.push('PRD9.12-15：已删除旧节点恢复依次被未知阶段和未来实际日拒绝，原原因与所选纠正保持；同表单明确纠正后原ID恢复且不接旧线，随后主动选新线，新GET/SQL接续可用。');
  recovery.w.document.dispatchEvent(new recovery.w.Event('geekdash-identity-changed'));await waitFor(()=>!recovery.dom.requestsRunning,'恢复链页面完成');await new Promise(resolve=>setTimeout(resolve,0));recovery.dom.window.close();
  await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?',[id]);
}
async function catalogStateChecks(a,id){
  const before=await facts(id),empty=await page(a,id,false,{emptyCatalog:true});
  const sources=[...empty.w.document.querySelectorAll('select[data-reference="true"]')].filter(source=>!source.disabled && ![...source.options].some(option=>option.value));
  assert(sources.length>=6,'实际各类资料候选同时为空');
  for(const source of sources){const input=empty.$('#'+source.id.replace(/-source$/,''));input.focus();assert.equal(empty.$('#'+input.id+'-choices .reference-empty').textContent,'暂无可选资料。');}
  empty.input('#edit-name',prefix+'空候选文字可编辑');assert.equal(empty.$('#edit-name').value,prefix+'空候选文字可编辑');assert.deepEqual(await facts(id),before);
  checks.push('PRD9.18-2：真实详情读取后在候选响应边界注入全部集合为空；各资料下拉明确暂无可选资料，普通输入仍可编辑，正式SQL与新GET保持原值。此项验证空响应消费，不把公共测试资料删除为零。');
  empty.w.document.dispatchEvent(new empty.w.Event('geekdash-identity-changed'));await waitFor(()=>!empty.dom.requestsRunning,'空候选页面结束');empty.dom.window.close();
  const tagIds=[];for(const suffix of ['原选择','重读后新增']){await c.execute('INSERT INTO tags (name,created_at,updated_at) VALUES (?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix+suffix]);const tagId=(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;references.push(tagId);tagIds.push(tagId);}
  await a.api('/api/projects/'+id,'PATCH',{scope:'basic',expectedVersion:before.project.version,idempotencyKey:randomUUID(),changes:{tagIds:[tagIds[0]]}});
  const selected=await facts(id),failed=await page(a,id,false,{catalogFailure:true});
  await waitFor(()=>failed.$('#message').textContent.includes('原编辑已保留'),'候选初读失败就地反馈');
  assert(!failed.$('#options-retry').hidden);assert.equal(failed.$('#edit-tagIds-source').selectedOptions[0].value,tagIds[0]);assert(failed.$('#edit-tagIds').disabled);
  failed.input('#edit-name',prefix+'候选重读保留名称');failed.input('#edit-statusDesc','重读不提交另一范围说明');failed.click('#options-retry');
  await waitFor(()=>!failed.$('#edit-tagIds').disabled && failed.$('#options-retry').hidden,'候选真实重读成功');
  assert.equal(failed.$('#edit-name').value,prefix+'候选重读保留名称');assert.equal(failed.$('#edit-statusDesc').value,'重读不提交另一范围说明');assert.equal(failed.$('#edit-tagIds-source').selectedOptions[0].value,tagIds[0]);assert.deepEqual(await facts(id),selected);
  failed.input('#edit-tagIds',prefix+'重读后新增');failed.click('[data-reference-value="'+tagIds[1]+'"]');failed.click('[data-save-scope="basic"]');
  await waitFor(()=>failed.dom.projectReads.at(-1)?.project.tags.length===2 && !failed.$('#reload').disabled,'重读候选选用后正式保存');
  const fresh=await a.api('/api/projects/'+id);assert.deepEqual(fresh.project.tags.map(tag=>tag.id).sort(),tagIds.sort());assert.equal(fresh.project.statusDesc,'');assert.equal(failed.$('#edit-statusDesc').value,'重读不提交另一范围说明');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_tags WHERE project_id=?',[id]))[0][0].n),2);assert.equal(BigInt((await facts(id)).project.version),BigInt(selected.project.version)+1n);
  checks.push('PRD9.18-2：候选首次读取失败保留正式所选ID与当前文字，明确重读恢复真实候选；重选后只保存基本区，新GET/SQL两条关联、版本仅增一，另区说明保留未提交。');
  failed.w.document.dispatchEvent(new failed.w.Event('geekdash-identity-changed'));await waitFor(()=>!failed.dom.requestsRunning,'候选验证结束');await new Promise(resolve=>setTimeout(resolve,0));failed.dom.window.close();
}
try {
  for (let i=0;i<2;i++) {
    await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix+i,await hashPassword(password),'界面测试'+i]);
    users.push({id:(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id,loginName:prefix+i});
  }
  const db = await openRuntimeDatabase('test_app'); app = await createApp(db,{origin:authOrigin,secure:false}); origin=await app.listen({host:'127.0.0.1',port:0});
  const a=client(), b=client(); await a.login(0); await b.login(1);
  const created=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix,summary:'项目简介',dueDate:'2030-12-31'}});
  const id=created.result.projectId,path='/api/projects/'+id; projects.push(id);
  if(recoveryMode)await recoveryChecks(a,b,id);else if(nodeErrorsMode)await nodeErrorChecks(a,id);else if(impactChainMode)await impactChainChecks(a,id);else if(nodeFollowupsMode)await nodeFollowupChecks(a,id);else if(catalogStatesMode)await catalogStateChecks(a,id);else{
  const tagName=prefix+' 项目标签';
  await c.execute('INSERT INTO tags (name,created_at,updated_at) VALUES (?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[tagName]);
  const tagId=(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id; references.push(tagId);
  const p=await page(a,id), read=()=>a.api(path);
  assert.equal(p.$('#tags-edit'),null);await waitFor(()=>p.$('#edit-tagIds') && !p.$('#edit-tagIds').disabled,'基本信息标签候选加载');
  assert.equal(p.$('[data-save-scope="tags"]'),null);assert.equal(p.$('#d-tags [data-edit]'),null);assert.equal(p.$('#d-meta'),null);
  assert(p.$('[data-region="basic"] #edit-tagIds'),'标签位于基本信息中');
  p.input('#edit-tagIds',tagName);p.click('[data-reference-value="'+tagId+'"]');
  p.input('#edit-name','');p.visibleClick('[data-save-scope="basic"]');
  await waitFor(()=>p.$('#error-name')?.textContent && !p.$('#reload').disabled,'空名称阻止整个基本区提交');
  assert.equal((await read()).project.tags.length,0,'失败不先写标签');assert.equal((await read()).project.name,prefix);
  p.input('#edit-name',prefix);p.visibleClick('[data-save-scope="basic"]');
  await waitFor(()=>p.dom.projectReads.at(-1)?.project.tags.some(tag=>tag.id===tagId) && !p.$('#reload').disabled,'项目标签与基本区同次保存');
  assert(!p.$('#d-tags').textContent.includes(tagName),'标题不重复展示用户标签');
  assert.equal(p.$('[data-save-scope="tags"]'),null);
  const tagReadback=await page(a,id);assert.equal(tagReadback.$('#edit-tagIds-source').selectedOptions[0].value,tagId,'重新进入基本区仍选中正式标签');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_tags WHERE project_id=? AND tag_id=?',[id,tagId]))[0][0].n),1);
  checks.push('PRD9.4/9.7：标签融入基本区同次保存；无独立重复入口，非法名称全事务不写，新请求与独立SQL关联一致');
  assert.equal(p.$('#basic-edit'),null);assert.equal(p.$('#edit-name').value,prefix);assert(p.$('#edit-statusDesc'));
  for(const scope of ['basic','status'])assert(p.$(`[data-region="${scope}"] > .region-save [data-save-scope="${scope}"]`),'区保存位于本区字段之后');
  p.input('#edit-statusDesc','说明暂不提交');p.input('#edit-name',prefix+'改名');
  p.click('[data-save-scope="basic"]'); await waitFor(()=>p.dom.projectReads.at(-1)?.project.name===prefix+'改名' && !p.$('#reload').disabled,'基本区保存并新读');
  assert.equal(p.$('#edit-statusDesc').value,'说明暂不提交'); assert.equal((await read()).project.statusDesc,''); assert.equal((await facts(id)).project.name,prefix+'改名');
  p.input('#edit-summary','未提交简介');p.input('#edit-statusDesc','只保存说明');p.click('[data-save-scope="status"]');
  await waitFor(()=>p.dom.projectReads.at(-1)?.project.statusDesc==='只保存说明' && !p.$('#reload').disabled,'说明保存');
  assert.equal(p.$('#edit-summary').value,'未提交简介');assert.equal((await read()).project.summary,'项目简介');p.click('#basic-cancel');await waitFor(()=>p.$('#edit-summary')?.value==='项目简介','取消本区恢复正式值且仍可输入');
  assert.equal(p.$('#edit-name').value,prefix+'改名');assert.equal(p.$('#edit-statusDesc').value,'只保存说明');
  checks.push('PRD9.4：基本区默认输入、取消恢复本区正式值且继续可编辑；两区交替保存不夹带，人工状态说明原文保留，正式新读及独立SQL');
  p.input('#edit-name',prefix+'迟到确认');p.dom.holdSave=true;p.click('[data-save-scope="basic"]');
  await waitFor(()=>p.dom.releaseSave,'真实提交已返回并暂扣页面响应');p.input('#edit-statusDesc','请求期间的新输入');p.dom.releaseSave();
  await waitFor(()=>p.dom.projectReads.at(-1)?.project.name===prefix+'迟到确认' && !p.$('#reload').disabled,'迟到响应恢复');
  assert.equal(p.$('#edit-statusDesc').value,'请求期间的新输入');assert.equal((await read()).project.statusDesc,'只保存说明');
  p.dom.dropSaveAck=true;p.click('[data-save-scope="status"]');await waitFor(()=>p.$('#confirm') && !p.$('#confirm').disabled,'未知结果恢复入口');
  p.click('#confirm');await waitFor(()=>p.dom.projectReads.at(-1)?.project.statusDesc==='请求期间的新输入' && !p.$('#reload').disabled,'查原结果');
  checks.push('PRD9.1/9.4：真实提交中另一区继续输入，迟到确认不覆盖；丢响应后查原结果');
  p.tab('risk');p.click('[data-risk="add"]');p.input('#risk-content','风险一');p.click('#risk-submit');
  await waitFor(()=>p.$('.risk-content')?.textContent==='风险一' && !p.$('#reload').disabled,'风险一次保存');
  let risk=(await read()).risks[0];p.click('[data-risk="correct"]');p.input('#risk-content','普通文字修正');p.click('#risk-submit');
  await waitFor(()=>p.$('.risk-content')?.textContent==='普通文字修正' && !p.$('#reload').disabled,'风险普通纠错不二次确认');
  p.click('[data-risk="delete"]');p.click('#risk-submit');await waitFor(()=>(p.dom.projectReads.at(-1)?.risks.length===0) && !p.$('#reload').disabled,'风险误录删除');
  assert((await c.query('SELECT deleted_at FROM project_risks WHERE id=?',[risk.id]))[0][0].deleted_at);
  p.click('[data-change="add"]');p.input('#chg-content','变更内容');p.input('#chg-reason','接受原因');p.click('#change-submit');
  await waitFor(()=>p.$('.chg-content')?.textContent==='变更内容' && !p.$('#reload').disabled,'需求一次保存');
  p.click('[data-change="correct"]');p.input('#chg-content','只改需求文字');assert(!p.$('#chg-correction-reason'));p.click('#change-submit');
  await waitFor(()=>p.$('.chg-content')?.textContent==='只改需求文字' && !p.$('#reload').disabled,'需求普通纠错');
  checks.push('PRD9.10/9.11：风险与需求每条正式保存一次，普通纠错不强制预览，风险误录删除持久保留来源');
  const legacyChange = (await read()).changes[0];
  await c.execute('UPDATE project_changes SET source=? WHERE id=?', ['旧未知来源', legacyChange.id]);
  const legacyPage = await page(a,id); legacyPage.tab('risk'); legacyPage.click('[data-change="correct"]');
  assert.equal(legacyPage.$('#chg-source').value,'旧未知来源','未触及旧来源不能自动成为来源纠错');
  legacyPage.input('#chg-content','仅纠正旧记录文字'); legacyPage.click('#change-submit');
  await waitFor(()=>legacyPage.dom.projectReads.at(-1)?.changes[0].content==='仅纠正旧记录文字' && !legacyPage.$('#reload').disabled,'旧来源保持的普通文字保存');
  const legacyRead=(await read()).changes[0]; assert.equal(legacyRead.source,'旧未知来源'); assert.equal(legacyRead.createdAt,legacyChange.createdAt);
  legacyPage.click('[data-change="correct"]'); legacyPage.input('#chg-source','业务'); assert(!legacyPage.$('#chg-correction-reason'));
  assert.equal((await read()).changes[0].source,'旧未知来源'); legacyPage.click('#change-submit');
  await waitFor(()=>legacyPage.dom.projectReads.at(-1)?.changes[0].source==='业务' && !legacyPage.$('#reload').disabled,'明确纠正来源');
  assert.equal((await c.query('SELECT source FROM project_changes WHERE id=?',[legacyChange.id]))[0][0].source,'业务');
  legacyPage.dom.window.close(); p.click('#reload'); await waitFor(()=>p.dom.projectReads.at(-1)?.changes[0].source==='业务' && !p.$('#reload').disabled,'原页重读');
  checks.push('PRD9.11：旧未知来源保留、普通内容直接保存；明确选来源后一次保存且不另填纠错原因，保存前不写，保存后SQL与另一页面新读一致');
  p.tab('custnodes');p.click('[data-node="add"]');p.input('[data-node-field="title"]','客户交付');p.input('[data-node-field="note"]','客户说明');p.click('#node-edit [type="submit"]');
  await waitFor(()=>p.dom.projectReads.at(-1)?.nodes.some(n=>n.title==='客户交付') && !p.$('#reload').disabled,'客户节点一次保存');
  p.tab('nodes');p.click('[data-node="add"]');p.input('[data-node-field="title"]','阶段成果');p.input('[data-node-field="stage"]','S1');p.input('[data-node-field="targetDate"]','2030-10-01');p.input('[data-node-field="output"]','成果说明');p.click('#node-edit [type="submit"]');
  await waitFor(()=>p.dom.projectReads.at(-1)?.nodes.some(n=>n.title==='阶段成果') && !p.$('#reload').disabled,'项目节点一次保存');
  assert.equal((await read()).nodes.filter(n=>n.kind==='project').length,1);
  p.tab('flow');assert.match(p.$('#detail-body').textContent,/阶段成果/);assert(p.$('[data-save-scope="projectNodes"]').disabled,'已保存节点在Flow可直接使用，无第二次保存');
  const dragNode=(dx,dy,cancel=false)=>{const node=p.$('[data-node-drag]');node.setPointerCapture=()=>{};node.onpointerdown({button:0,pointerId:1,clientX:300,clientY:100});node.onpointermove({clientX:300+dx,clientY:100+dy});(cancel?node.onpointercancel:node.onpointerup)({clientX:300+dx,clientY:100+dy});};
  const beforeMove=await read();dragNode(0,0);assert(p.$('[data-save-scope="projectNodes"]').disabled);
  dragNode(100,30,true);assert(p.$('[data-save-scope="projectNodes"]').disabled);assert(!p.$('#action-dialog').open);
  dragNode(100,30);assert(!p.$('#action-dialog').open,'拖动不再打开仅坐标确认弹窗');
  assert.equal((await read()).project.version,beforeMove.project.version);assert.deepEqual((await read()).nodes,beforeMove.nodes);
  const movedLeft=p.$('[data-node-drag]').style.left;p.tab('nodes');p.tab('flow');assert.equal(p.$('[data-node-drag]').style.left,movedLeft);
  p.dom.dropSaveAck=true;p.click('[data-save-scope="projectNodes"]');await waitFor(()=>p.$('#confirm') && !p.$('#confirm').disabled,'坐标保存回应丢失');
  const moved=await read();assert.equal(moved.nodes.find(n=>n.kind==='project').x,parseFloat(movedLeft));
  p.click('#confirm');await waitFor(()=>!p.$('#confirm') && !p.$('#reload').disabled,'坐标原结果恢复');assert.equal((await read()).project.version,moved.project.version);
  checks.push('PRD9.12：未移动/取消拖动不产生修改；移动直接进入共享节点副本且不弹坐标确认，切换视图保持，明确保存COMMIT丢回应后核对原结果不重复写入');
  assert.equal((await read()).stages[0].expectedEndOn,'2030-10-01');p.tab('stages');assert.match(p.$('#detail-body').textContent,/2030-10-01/);
  checks.push('PRD9.12：客户节点独立保存、项目节点跨列表/Flow共享副本，一次保存后阶段预计日期新读');
  p.tab('history');await waitFor(()=>p.$('.audit-entry'),'更新历史');
  const history=p.$('#detail-body').textContent;assert.match(history,/只改需求文字/);assert(!history.includes('createdBy'));assert(!history.includes('recordSource'));
  assert.match(p.$('#detail-body').textContent,/项目节点：阶段成果/);assert.match(p.$('#detail-body').textContent,/需求变更：只改需求文字/);
  checks.push('PRD9.14：真实更新历史展示修改内容，业务操作后新请求消费');
  p.tab('nodes');p.click('[data-node="correct"]');p.click('#node-delete-selected');p.click('#node-edit [type="submit"]');
  await waitFor(()=>!p.dom.projectReads.at(-1)?.nodes.some(n=>n.kind==='project') && !p.$('#reload').disabled,'节点正式删除');
  p.click('#deleted-refresh');await waitFor(()=>p.$('[data-node="restore"]'),'读取原删除节点');p.click('[data-node="restore"]');
  assert(p.$('[data-restore-field="output"]').disabled);assert(p.$('#restore-actual').disabled);
  p.click('[data-restore-select="output"]');assert(!p.$('[data-restore-field="output"]').disabled);
  p.input('[data-restore-field="output"]','恢复时核对后的成果');
  p.click('[data-restore-select="title"]');assert(!p.$('[data-restore-field="title"]').disabled);p.input('[data-restore-field="title"]','取消纠正不提交此名称');p.click('[data-restore-select="title"]');assert(p.$('[data-restore-field="title"]').disabled);
  p.input('#node-reason','合成验收：恢复误删并核对成果');assert(p.$('[data-restore-field="title"]').disabled);assert(!p.$('[data-restore-field="output"]').disabled);p.click('#node-edit [type="submit"]');
  await waitFor(()=>p.dom.projectReads.at(-1)?.nodes.some(n=>n.output==='恢复时核对后的成果') && !p.$('#reload').disabled,'恢复及纠正同次保存');
  const recovered=(await read()).nodes.find(n=>n.kind==='project');assert.equal(recovered.id,moved.nodes.find(n=>n.kind==='project').id);assert.equal(recovered.title,'阶段成果');assert.equal(recovered.output,'恢复时核对后的成果');
  checks.push('PRD9.12：恢复字段仅明确勾选后可编辑，取消勾选不夹带输入；同次恢复和所选纠错直接保存一次，新GET确认原ID');
  p.tab('info');p.input('#edit-statusDesc','服务器个人草稿待恢复');
  await waitFor(()=>p.dom.draftWrites.some(row=>row.payload.values?.statusDesc==='服务器个人草稿待恢复') && p.$('#personal-drafts').title==='草稿已同步；正式项目仍需点击保存','服务器自动底稿确认');
  const syncCount=p.dom.draftWrites.length;await new Promise(resolve=>setTimeout(resolve,1300));assert.equal(p.dom.draftWrites.length,syncCount,'相同JSON内容不能反复同步');
  let drafts=(await a.api('/api/personal/drafts?projectId='+id)).items;
  assert(drafts.some(row=>row.formKind==='status' && row.payload.values.statusDesc==='服务器个人草稿待恢复'));
  assert.equal((await read()).project.statusDesc,'请求期间的新输入');
  const other=client();await other.login(0);const restored=await page(other,id);restored.click('#personal-drafts');
  await waitFor(()=>restored.$('[data-draft-list] [data-restore]'),'新会话草稿列表');
  const statusCard=[...restored.w.document.querySelectorAll('[data-draft-list] section')].find(node=>node.querySelector('h3')?.textContent==='最新状态说明');assert(statusCard);
  statusCard.querySelector('[data-restore]').click();
  await waitFor(()=>restored.$('#edit-statusDesc')?.value==='服务器个人草稿待恢复','选定个人底稿恢复');
  assert.equal((await read()).project.statusDesc,'请求期间的新输入');restored.click('[data-save-scope="status"]');
  await waitFor(()=>restored.dom.projectReads.at(-1)?.project.statusDesc==='服务器个人草稿待恢复' && !restored.$('#reload').disabled,'恢复后明确保存');
  drafts=(await a.api('/api/personal/drafts?projectId='+id)).items;
  assert(drafts.some(row=>row.formKind==='status'),'恢复新副本不擅自删除来源底稿');
  checks.push('SPEC007：页面输入自动同步不改正式项目，新会话列出本人草稿、选择恢复新副本、明确保存后新GET，来源底稿保留');
  restored.tab('stages');restored.click('[data-stage="S1"][data-stage-action="startStage"]');await waitFor(()=>restored.$('#stage-date'),'打开阶段表单');restored.input('#stage-date','2026-10-01');
  await waitFor(()=>restored.dom.draftWrites.some(row=>row.formKind==='action' && row.payload.command.actualDate==='2026-10-01'),'动作底稿自动同步');
  const actionDraft=restored.dom.draftWrites.filter(row=>row.formKind==='action').at(-1);
  restored.dom.dropActionAck=true;restored.click('#stage-form [type="submit"]');
  await waitFor(()=>restored.$('#stage-confirm') && !restored.$('#stage-confirm').disabled,'动作丢回应后原结果入口');restored.click('#stage-confirm');
  await waitFor(()=>restored.dom.projectReads.at(-1)?.stages[0].state==='active' && !restored.$('#reload').disabled,'阶段动作带底稿提交');
  assert.equal((await a.api('/api/personal/drafts?clientDraftId='+actionDraft.clientDraftId)).items[0].state,'committed');
  checks.push('PRD9.7/9.15：阶段表单自动底稿、实际开始保存丢回应后核对原操作、新GET和对应稿同事务终结');
  const beforeStageFailure=await facts(id);restored.click('[data-stage="S1"][data-stage-action="completeStage"]');await waitFor(()=>restored.$('#stage-date'),'完成阶段填写入口');
  restored.input('#stage-date','2026-09-30');restored.input('#stage-note','联调结论输入应保留');restored.dom.holdAction=true;restored.click('#stage-form [type="submit"]');
  await waitFor(()=>restored.dom.releaseAction,'阶段请求回应暂扣');
  for(const input of restored.w.document.querySelectorAll('#stage-form input,#stage-form textarea,#stage-form button'))assert(input.disabled,'实际阶段保存处理中冻结全部操作控件');
  assert.equal(restored.dom.actionWrites.at(-1).status,422);restored.dom.releaseAction();
  await waitFor(()=>restored.$('#stage-date') && !restored.$('#stage-date').disabled && !restored.$('#reload').disabled,'阶段日期非法后恢复原输入');
  assert.equal(restored.$('#stage-date').value,'2026-09-30');assert.equal(restored.$('#stage-note').value,'联调结论输入应保留');assert.deepEqual(await facts(id),beforeStageFailure);
  restored.click('#stage-cancel');await waitFor(()=>!restored.$('#stage-form'),'取消失败动作后无残留表单');
  checks.push('PRD9.7：实际阶段请求处理中输入与按钮冻结；服务端拒绝日期矛盾后原输入可继续修改，版本/审计未变化，取消无残留表单');
  restored.click('[data-correction="correctStageFacts"][data-stage="S1"]');await waitFor(()=>restored.$('#correction-edit'),'阶段日期纠错入口');
  assert(!restored.$('[data-correct-date="S1:startedOn"]').disabled);assert(!restored.$('[data-correct-select]'));assert(!restored.$('#correction-reason'));
  assert.equal(restored.w.document.querySelectorAll('[data-correct-date]').length,2);assert(!restored.$('[data-correct-date="S2:startedOn"]'));
  const actionCount=restored.dom.actionWrites.length;restored.click('#correction-edit [type="submit"]');assert.equal(restored.$('#correction-error').textContent,'没有修改日期。');assert.equal(restored.dom.actionWrites.length,actionCount,'无实际日期变化不发动作请求');
  restored.input('[data-correct-date="S1:startedOn"]','2026-09-29');restored.click('[data-correction="correctStageFacts"][data-stage="S2"]');
  await waitFor(()=>restored.$('[data-choice="cancel"]'),'换阶段先处理未保存日期');restored.click('[data-choice="cancel"]');assert.equal(restored.$('[data-correct-date="S1:startedOn"]').value,'2026-09-29');assert(!restored.$('[data-correct-date="S2:startedOn"]'));
  restored.click('[data-correction="correctStageFacts"][data-stage="S2"]');await waitFor(()=>restored.$('[data-choice="discard"]'),'明确放弃旧阶段稿');restored.click('[data-choice="discard"]');
  await waitFor(()=>restored.$('[data-correct-date="S2:startedOn"]'),'只打开目标阶段日期');assert.equal(restored.w.document.querySelectorAll('[data-correct-date]').length,2);assert(!restored.$('[data-correct-date="S1:startedOn"]'));
  restored.click('#correction-cancel');await waitFor(()=>!restored.$('#correction-edit'),'取消目标阶段日期稿');assert.equal(restored.w.document.querySelectorAll('[data-correct-date]').length,0);
  restored.click('[data-correction="correctStageFacts"][data-stage="S1"]');await waitFor(()=>restored.$('[data-correct-date="S1:startedOn"]'),'取消后重新进入原阶段');assert.equal(restored.$('[data-correct-date="S1:startedOn"]').value,'2026-10-01');
  const stageBeforeCorrection=(await read()).stages[0];restored.input('[data-correct-date="S1:startedOn"]','2026-09-30');restored.click('#correction-edit [type="submit"]');
  await waitFor(()=>restored.dom.projectReads.at(-1)?.stages[0].startedOn==='2026-09-30' && !restored.$('#reload').disabled,'阶段日期直接保存后新读');
  const stageAfterCorrection=(await read()).stages[0];assert.equal(stageAfterCorrection.state,'active');assert.equal(stageAfterCorrection.completedOn,stageBeforeCorrection.completedOn);checks.push('PRD9.7：只显示当前阶段日期，无变化不发请求；换阶段先处理原稿、取消后无残留。直接保存一次免勾选和重复原因，新GET确认只改选中日期，不改完成事实和阶段状态');
  restored.tab('info');restored.input('#edit-name','取消这一份基本稿');restored.input('#edit-statusDesc','状态区仍须保留');
  await waitFor(()=>restored.dom.draftWrites.some(row=>row.payload.values?.name==='取消这一份基本稿') && restored.dom.draftWrites.some(row=>row.payload.values?.statusDesc==='状态区仍须保留'),'两区底稿同步');
  const cancelled=restored.dom.draftWrites.filter(row=>row.payload.values?.name==='取消这一份基本稿').at(-1);
  restored.click('#basic-cancel');await waitFor(()=>restored.$('#edit-name')?.value===prefix+'迟到确认','基本区取消恢复正式值且仍为输入模式');
  assert.equal((await a.api('/api/personal/drafts?clientDraftId='+cancelled.clientDraftId)).items[0].state,'discarded');
  assert.equal(restored.$('#edit-statusDesc').value,'状态区仍须保留');
  const cloud=restored.dom.draftWrites.filter(row=>row.payload.values?.statusDesc==='状态区仍须保留').at(-1);
  restored.dom.rejectDrafts=true;restored.input('#edit-statusDesc','离线时新输入不应丢失');
  await waitFor(()=>restored.$('#personal-drafts').title.includes('草稿未同步'),'离线反馈');restored.click('#personal-drafts');
  await waitFor(()=>restored.$(`[data-draft-id="${cloud.clientDraftId}"][data-source="local"]`),'同时展示不同本机稿');
  restored.click(`[data-draft-id="${cloud.clientDraftId}"][data-source="active"] [data-discard]`);
  await waitFor(()=>!restored.$(`[data-draft-id="${cloud.clientDraftId}"][data-source="active"]`) && restored.$('[data-draft-list]').textContent.includes('离线时新输入不应丢失'),'仅云稿丢弃后列表刷新');
  assert.match(restored.$('[data-draft-list]').textContent,/离线时新输入不应丢失/);assert.equal(restored.$('#edit-statusDesc').value,'离线时新输入不应丢失');
  restored.dom.rejectDrafts=false;restored.click('[data-sync]');
  await waitFor(()=>restored.dom.draftWrites.some(row=>row.payload.values?.statusDesc==='离线时新输入不应丢失'),'新编号补同步');
  assert.equal((await read()).project.statusDesc,'服务器个人草稿待恢复');
  checks.push('PRD9.4/9.15：取消只丢弃本区，其他区保持；离线本机输入与不同云稿分列，丢弃云稿不清本机输入，联网后新编号同步不改正式数据');
  restored.click('[data-close]');restored.input('#edit-name','准备恢复的名称');
  await waitFor(()=>restored.dom.draftWrites.some(row=>row.payload.values?.name==='准备恢复的名称'),'基本稿同步');
  const basicCloud=restored.dom.draftWrites.filter(row=>row.payload.values?.name==='准备恢复的名称').at(-1);
  restored.dom.rejectDrafts=true;restored.input('#edit-summary','不能混入旧稿的后来简介');restored.click('#personal-drafts');
  await waitFor(()=>restored.$(`[data-draft-id="${basicCloud.clientDraftId}"][data-source="active"]`),'恢复前读取旧稿');
  restored.click(`[data-draft-id="${basicCloud.clientDraftId}"][data-source="active"] [data-restore]`);
  await waitFor(()=>restored.$('[data-choice="cancel"]'),'恢复替换提示');restored.click('[data-choice="cancel"]');
  assert.equal(restored.$('#edit-summary').value,'不能混入旧稿的后来简介');
  restored.click('#personal-drafts');await waitFor(()=>restored.$(`[data-draft-id="${basicCloud.clientDraftId}"][data-source="active"]`),'再次读取旧稿');
  restored.click(`[data-draft-id="${basicCloud.clientDraftId}"][data-source="active"] [data-restore]`);
  await waitFor(()=>restored.$('[data-choice="restore"]'),'恢复替换确认');restored.click('[data-choice="restore"]');
  await waitFor(()=>restored.$('#edit-summary')?.value==='项目简介','对应区还原基线后应用草稿差异');
  assert.equal(restored.$('#edit-name').value,'准备恢复的名称');assert.equal(restored.$('#edit-statusDesc').value,'离线时新输入不应丢失');
  restored.dom.rejectDraftRead=true;restored.click('#personal-drafts');
  await waitFor(()=>restored.$('[data-draft-list]').textContent.includes('服务器草稿暂时无法读取'),'读取失败不伪装为空列表');
  restored.click('[data-copy]');await waitFor(()=>restored.$('[data-draft-list] pre:not([hidden])'),'无剪贴板时显示可复制文本');
  checks.push('PRD9.15：恢复取消保留当前输入，确认恢复只替换对应区域并清除该区域旧差异；云稿读取失败保持明确反馈，复制不可用时提供文本');
  restored.click('button[data-theme="warm"]');await waitFor(()=>restored.dom.preferenceWrites.some(row=>row.status===200 && row.body.value.theme==='warm'),'主题保存');
  const themePath='/api/personal/preferences?deviceKey=account&scope=appearance';
  assert.equal((await a.api(themePath)).value.theme,'warm');const themed=await page(a,id);assert.equal(themed.w.document.documentElement.dataset.theme,'warm');
  const pref=await a.api(themePath);await a.api('/api/personal/preferences/save','POST',{deviceKey:'account',scope:'appearance',expectedVersion:pref.version,value:{schemaVersion:1,theme:'dark'}});
  themed.click('button[data-theme="light"]');await waitFor(()=>themed.dom.preferenceWrites.some(row=>row.status===409),'旧主题版本冲突');
  assert.equal(themed.w.document.documentElement.dataset.theme,'light');await new Promise(resolve=>setTimeout(resolve,700));assert.equal((await a.api(themePath)).value.theme,'dark');
  themed.click('button[data-theme="warm"]');await waitFor(()=>themed.dom.preferenceWrites.some(row=>row.status===200),'新明确操作采用新版本');assert.equal((await a.api(themePath)).value.theme,'warm');
  checks.push('PRD9.16：主题即时应用、真实保存、新页面恢复；并发版本冲突不跳当前布局、不自动覆盖远端，新明确操作才同步');
  const board=await page(a,id,false,{board:true,query:'?view=proposal'});board.input('#search',prefix);board.click('#filter-toggle');board.click('#layout-toggle');
  await waitFor(()=>board.dom.preferenceWrites.some(row=>row.status===200 && row.body.value.filters?.search===prefix),'首页筛选同步');
  await waitFor(()=>board.dom.preferenceWrites.some(row=>row.status===200 && row.body.value.layout==='progress'),'首页布局同步');
  const device=board.w.localStorage.getItem('geekdash_device');
  const reopened=await page(a,id,false,{board:true,local:{geekdash_device:device}});
  assert.equal(reopened.$('#search').value,prefix);assert.equal(reopened.$('#filter-rows').hidden,false);assert(reopened.$('#card-grid').classList.contains('progress-layout'));
  const explicit=await page(a,id,false,{board:true,query:'?view=all&search=明确URL',local:{geekdash_device:device}});assert.equal(explicit.$('#search').value,'明确URL');
  const separate=await page(a,id,false,{board:true,local:{geekdash_device:device},session:{['geekdash_preference:'+users[0].id+':board']:JSON.stringify({schemaVersion:1,view:'all',filters:{search:'本标签独立范围'},page:1})}});
  assert.equal(separate.$('#search').value,'本标签独立范围');
  checks.push('PRD9.16：首页搜索/筛选折叠及布局真实保存；同设备重开恢复，明确URL和本标签上下文各自优先，不改正式项目');
  const expiredPage=await page(a,id,false,{board:true,query:'?view=all&page=999&search='+encodeURIComponent(prefix)});
  assert.match(expiredPage.$('#message').textContent,/原第 999 页已不可用，已显示第 1 页/);assert.equal(expiredPage.$('#search').value,prefix);assert.equal(new URL(expiredPage.w.location.href).searchParams.get('page'),'1');assert(expiredPage.$('#card-grid [data-project-id]'));
  checks.push('PRD9.16-5：首页过期页码回落到有效页并就地说明，原搜索及范围保留，不误报空结果');
  const beforeViewport=await a.api('/api/projects/'+id),flow=await page(a,id);
  flow.click('[data-tab="flow"]');
  flow.$('.flow-canvas').scrollLeft=180;flow.$('.flow-canvas').scrollTop=230;flow.$('.flow-canvas').dispatchEvent(new flow.w.Event('scroll'));
  await waitFor(()=>flow.dom.preferenceWrites.some(row=>row.status===200 && row.body.value.viewport?.x===180),'Flow阅读位置真实保存');
  flow.click('[data-tab="nodes"]');flow.click('[data-tab="flow"]');
  assert.equal(flow.$('.flow-canvas').scrollLeft,180);assert.equal(flow.$('.flow-canvas').scrollTop,230);
  await waitFor(()=>flow.dom.preferenceWrites.filter(row=>row.status===200 && row.body.value.tab==='flow').length>=2,'返回Flow页签同步');
  const flowDevice=flow.w.localStorage.getItem('geekdash_device'),flowAgain=await page(a,id,false,{local:{geekdash_device:flowDevice}});
  assert.equal(flowAgain.$('.flow-canvas').scrollLeft,180);assert.equal(flowAgain.$('.flow-canvas').scrollTop,230);
  const otherFlow=await page(b,id,false,{local:{geekdash_device:flowDevice}});assert.equal(otherFlow.$('.flow-canvas'),null);
  const afterViewport=await a.api('/api/projects/'+id);assert.equal(afterViewport.project.version,beforeViewport.project.version);assert.deepEqual(afterViewport.nodes,beforeViewport.nodes);
  checks.push('PRD9.16：Flow视口在切换节点列表和同设备新请求后恢复，账号隔离且正式版本/节点不变；DOM属性验证不代表原生滚动像素验收');
  const liveCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'通知项目'}}),liveId=liveCreated.result.projectId;projects.push(liveId);
  await b.api('/api/projects/'+liveId+'/responsibility','POST',{action:'join',expectedVersion:liveCreated.result.savedVersion,idempotencyKey:randomUUID()});
  const liveA=await page(a,liveId,false,{realtime:true}),sameAccount=await page(a,liveId,false,{realtime:true}),liveB=await page(b,liveId,false,{realtime:true});
  sameAccount.input('#edit-statusDesc','同账号另一标签未保存');liveB.input('#edit-statusDesc','另一账号未保存');liveA.input('#edit-statusDesc','本页正式保存');
  await waitFor(()=>liveA.$('#project-editors').textContent.includes('界面测试0') && liveA.$('#project-editors').textContent.includes('界面测试1'),'真实编辑名单消费');
  liveA.click('[data-save-scope="status"]');await waitFor(()=>liveA.dom.projectReads.at(-1)?.project.statusDesc==='本页正式保存' && !liveA.$('#reload').disabled,'本人提交新GET');
  await waitFor(()=>liveB.$('#message').textContent.includes('项目已被他人更新') && sameAccount.$('#message').textContent.includes('项目已被他人更新'),'另账号及同账号别页冻结');
  assert.equal(liveB.$('#edit-statusDesc').value,'另一账号未保存');assert.equal(sameAccount.$('#edit-statusDesc').value,'同账号另一标签未保存');
  assert(liveB.$('[data-save-scope="status"]').disabled);assert(sameAccount.$('[data-save-scope="status"]').disabled);assert(!liveA.$('#edit-name').disabled);
  const committedEvent=liveA.dom.events.find(item=>item.event==='project' && item.data.projectId===liveId);
  assert(committedEvent,'捕获真实提交事件后再重放');
  const notificationBaseline=await a.api('/api/projects/'+liveId);
  const notificationAudit=await a.api('/api/projects/'+liveId+'/audit'),notificationFacts=await facts(liveId);
  liveA.input('#edit-statusDesc','重复通知后仍保留的未保存输入');
  const noticeBefore=liveA.$('#message').textContent,staleNoticeBefore=liveB.$('#message').textContent;
  for(const destination of ['/','/project-status-summary.html','/data-manage.html']){
    liveA.click('.project-nav a[href="'+destination+'"]');await waitFor(()=>liveA.$('#editor-dialog').open,'全站导航离开保护');
    liveA.click('[data-choice="cancel"]');await waitFor(()=>!liveA.$('#editor-dialog').open,'取消离开');
    assert.equal(liveA.$('#edit-statusDesc').value,'重复通知后仍保留的未保存输入');
  }
  for(const target of [liveA,liveB,sameAccount]){
    const emit=data=>target.dom.streams.at(-1).dispatchEvent(new target.dom.window.MessageEvent('project',{data:JSON.stringify(data)}));
    emit(committedEvent.data);emit(committedEvent.data);
    emit({...committedEvent.data,operationId:randomUUID(),version:notificationBaseline.project.version});
    emit({...committedEvent.data,operationId:randomUUID(),version:String(BigInt(notificationBaseline.project.version)-1n)});
  }
  assert.equal(liveA.$('#edit-statusDesc').value,'重复通知后仍保留的未保存输入');assert(!liveA.$('[data-save-scope="status"]').disabled);
  assert.equal(liveA.$('#message').textContent,noticeBefore);assert.equal(liveB.$('#message').textContent,staleNoticeBefore);
  assert.equal(liveB.$('#edit-statusDesc').value,'另一账号未保存');assert.equal(sameAccount.$('#edit-statusDesc').value,'同账号另一标签未保存');
  const notificationReadback=await a.api('/api/projects/'+liveId);
  assert.equal(notificationReadback.project.version,notificationBaseline.project.version);assert.deepEqual(await a.api('/api/projects/'+liveId+'/audit'),notificationAudit);assert.deepEqual(await facts(liveId),notificationFacts);
  assert.equal(notificationReadback.project.statusDesc,'本页正式保存');
  checks.push('PRD9.17-8：重放实际SSE提交事件及迟到旧版本，不误冻当前页、不清除三页输入、不回退正式版本或重复历史/提示');
  const connections=liveA.dom.events.filter(item=>item.event==='connected').length;liveA.dom.streams.at(-1).disconnect();
  await waitFor(()=>liveA.dom.events.filter(item=>item.event==='connected').length>connections,'断流后有界重连');
  assert.equal((await b.api('/api/projects/'+liveId)).project.statusDesc,'本页正式保存');
  checks.push('PRD9.17：真实SSE驱动三页面编辑名单；本人保存不误冻，同账号另一标签及另一账号保留输入并冻结旧保存；断流后重连补查');
  const liveBoard=await page(a,liveId,false,{board:true,realtime:true,query:'?view=all&search='+encodeURIComponent(prefix+'通知项目')});
  await waitFor(()=>liveA.$('#project-editors .editing-badge') && liveBoard.$(`[data-project-editors="${liveId}"] .editing-badge`),'详情与首页消费同一真实编辑名单');
  liveBoard.click(`[data-project-id="${liveId}"] [data-status-action="edit"]`);liveBoard.input(`[data-status-input="${liveId}"]`,'身份变化时首页状态输入');
  for(const target of [liveA,liveBoard]){
    target.w.document.dispatchEvent(new target.w.Event('geekdash-identity-changed'));
    assert.equal(target.$('.editing-badge'),null,'身份失效即清空旧编辑名单');
    assert(target.dom.streams.every(stream=>stream.closed),'身份失效关闭通知连接');
    target.dom.streams.at(-1).dispatchEvent(new target.w.MessageEvent('editors',{data:JSON.stringify({projectId:liveId,users:[{id:users[1].id,name:'迟到编辑者'}]})}));
    assert.equal(target.$('.editing-badge'),null,'迟到旧连接名单不能恢复徽章');
  }
  assert.equal(liveA.$('#edit-statusDesc').value,'重复通知后仍保留的未保存输入');assert(liveA.$('[data-save-scope="status"]').disabled);
  assert.equal(liveBoard.$(`[data-status-input="${liveId}"]`).value,'身份变化时首页状态输入');assert(liveBoard.$('[data-status-action="save"]').disabled);
  assert.deepEqual(await facts(liveId),notificationFacts,'身份显示失效不写正式业务');
  checks.push('PRD9.17：详情与首页身份失效立即清空真实编辑者徽章，关闭旧连接并忽略迟到名单；两页未保存输入保留、正式保存冻结、业务数据不变');
  const offlineCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'草稿离线'}}),offlineId=offlineCreated.result.projectId;projects.push(offlineId);
  const offline=await page(a,offlineId);offline.dom.rejectDrafts=true;offline.input('#edit-name',prefix+'正式保存可用');offline.input('#edit-statusDesc','其他区离线输入');
  offline.click('[data-save-scope="basic"]');await waitFor(()=>offline.dom.projectReads.at(-1)?.project.name===prefix+'正式保存可用' && !offline.$('#reload').disabled,'仅草稿接口离线仍可正式保存');
  const newBase=offline.dom.projectReads.at(-1).project.version;
  assert.equal(offline.$('#edit-statusDesc').value,'其他区离线输入');
  assert(Object.values(offline.w.localStorage).some(value=>{try{const row=JSON.parse(value);return row.desired?.baseVersion===offlineCreated.result.savedVersion && row.desired.payload.values?.statusDesc==='其他区离线输入';}catch{return false;}}),'旧基线本机稿保留供核对');
  offline.dom.rejectDrafts=false;offline.input('#edit-statusDesc','其他区联网继续输入');
  await waitFor(()=>offline.dom.draftWrites.some(row=>row.baseVersion===newBase && row.payload.values?.statusDesc==='其他区联网继续输入'),'本人保存后其他区新基线草稿接续');
  offline.click('[data-save-scope="status"]');await waitFor(()=>offline.dom.projectReads.at(-1)?.project.statusDesc==='其他区联网继续输入' && !offline.$('#reload').disabled,'接续输入正式保存');
  assert.equal((await a.api('/api/projects/'+offlineId)).project.statusDesc,'其他区联网继续输入');
  checks.push('PRD9.4/9.15：草稿单独离线不阻塞正式保存；仅本人确认并新读后，其他区另建新基线稿，旧稿保留，联网继续输入可同步再正式保存');
  const summaryReturn='/project-status-summary.html?ids='+offlineId;
  const linked=await page(a,offlineId,false,{returnTo:summaryReturn});
  assert.equal(linked.$('#back').textContent,'← 返回项目状态简要');assert.equal(linked.$('#back').href,origin+summaryReturn);
  const unsafe=await page(a,offlineId,false,{returnTo:'https://example.invalid/project-status-summary.html'});
  assert.equal(new URL(unsafe.$('#back').href).origin,origin,'外部返回地址不得被采用');
  checks.push('PRD9.20：统一摘要进入详情后返回原范围，来源页名称明确；外部返回地址拒绝，沿本地默认入口');

  const createPage=await page(a,null,false,{create:true});
  createPage.input('#edit-name',prefix+'新建草稿');createPage.input('#edit-summary','新建与详情共用简介');createPage.input('#edit-statusDesc','尚未正式保存');
  for(const destination of ['/','/project-status-summary.html','/data-manage.html']){
    createPage.click('.project-nav a[href="'+destination+'"]');await waitFor(()=>createPage.$('[data-choice="cancel"]'),'新建全站导航离开保护');createPage.click('[data-choice="cancel"]');
    assert.equal(createPage.$('#edit-name').value,prefix+'新建草稿');assert.equal(createPage.dom.navigationAttempts.length,0);
  }
  checks.push('PRD9.4/9.5：详情和新建全站导航可达，未保存时三个入口均先处理草稿；取消保留原区域输入且不跳转');
  createPage.click('#cancel');await waitFor(()=>createPage.$('[data-choice="cancel"]'),'新建离开选择');createPage.click('[data-choice="cancel"]');
  assert.equal(createPage.$('#edit-name').value,prefix+'新建草稿');assert.equal(createPage.dom.createWrites.length,0);
  createPage.click('#cancel');await waitFor(()=>createPage.$('[data-choice="keep"]'),'保留新建草稿');createPage.click('[data-choice="keep"]');
  await waitFor(()=>createPage.dom.navigationAttempts.length && createPage.dom.draftWrites.length,'云端底稿保存后离开');
  const createStorage=Object.fromEntries(Object.entries(createPage.w.sessionStorage));
  const restoredCreate=await page(a,null,false,{create:true,session:createStorage});
  await waitFor(()=>restoredCreate.$('.draft-recovery [data-continue]'),'本标签页新建底稿非阻断恢复');
  assert.equal(restoredCreate.$('#edit-name').value,'');assert.equal(restoredCreate.dom.confirmPrompts.length,0);assert(!restoredCreate.w.document.querySelector('dialog[open]'));
  restoredCreate.click('.draft-recovery [data-continue]');
  assert.equal(restoredCreate.$('#edit-name').value,prefix+'新建草稿');assert.equal(restoredCreate.$('#edit-summary').value,'新建与详情共用简介');
  const otherCreate=await page(b,null,false,{create:true,session:createStorage});assert.equal(otherCreate.$('#edit-name').value,'','其他账号不恢复原账号新建输入');
  otherCreate.input('#edit-name','账号变化前输入');otherCreate.w.document.dispatchEvent(new otherCreate.w.Event('geekdash-identity-changed'));
  assert(otherCreate.$('#save').disabled);assert.equal(otherCreate.$('#edit-name').value,'账号变化前输入');
  restoredCreate.dom.dropCreateAck=true;restoredCreate.click('#save');
  await waitFor(()=>restoredCreate.dom.createWrites.length && !restoredCreate.$('#confirm').hidden && !restoredCreate.$('#confirm').disabled,'创建确认丢失保留原请求');
  const createResult=restoredCreate.dom.createWrites[0].data.result,newId=createResult.projectId;
  assert.equal((await a.api('/api/projects/'+newId)).project.summary,'新建与详情共用简介');
  restoredCreate.click('#confirm');await waitFor(()=>restoredCreate.dom.navigationAttempts.length,'原创建回执确认后进入详情');
  assert.equal(restoredCreate.dom.createWrites.length,1,'核对原结果不重建项目');
  assert.equal(restoredCreate.w.sessionStorage.getItem('geekdash_create:'+users[0].id),null);
  assert(createResult.draft,'已同步的新建稿应关联正式创建');
  const [draftRows]=await c.query('SELECT state FROM project_drafts WHERE user_id=? AND client_draft_id=?',[users[0].id,createResult.draft.clientDraftId]);assert.equal(draftRows[0].state,'committed');
  const newDetail=await page(a,newId);assert.equal(newDetail.$('#edit-statusDesc').value,'尚未正式保存');
  assert.equal((await a.api('/api/projects/'+newId)).responsible[0].id,users[0].id);
  checks.push('PRD9.5/9.15：新建离开取消保留输入、保留草稿离开后同账号恢复、他账号隔离及身份变化冻结；真实创建COMMIT丢回应后原结果确认无重复，底稿终结，新详情读取及创建者负责');
  const discardCreate=await page(a,null,false,{create:true});discardCreate.input('#edit-name','明确丢弃的新建输入');
  await waitFor(()=>discardCreate.dom.draftWrites.length,'待丢弃底稿已同步');
  const discardedId=discardCreate.dom.draftWrites.at(-1).clientDraftId;
  discardCreate.click('#cancel');await waitFor(()=>discardCreate.$('[data-choice="discard"]'),'新建明确丢弃入口');discardCreate.click('[data-choice="discard"]');
  await waitFor(()=>discardCreate.dom.navigationAttempts.length,'丢弃完成后离开');
  assert.equal(discardCreate.dom.createWrites.length,0);assert.equal(discardCreate.w.sessionStorage.getItem('geekdash_create:'+users[0].id),null);
  const [discardRows]=await c.query('SELECT state FROM project_drafts WHERE user_id=? AND client_draft_id=?',[users[0].id,discardedId]);assert.equal(discardRows[0].state,'discarded');
  const offlineCreate=await page(a,null,false,{create:true});offlineCreate.dom.rejectDrafts=true;offlineCreate.input('#edit-name','离线创建底稿');
  offlineCreate.click('#cancel');await waitFor(()=>offlineCreate.$('[data-choice="keep"]'),'离线保留输入');offlineCreate.click('[data-choice="keep"]');
  await waitFor(()=>offlineCreate.$('[data-choice="leave"]'),'同步未成不能直接离开');
  assert.equal(offlineCreate.dom.navigationAttempts.length,0);assert.equal(offlineCreate.dom.createWrites.length,0);
  offlineCreate.click('[data-choice="leave"]');await waitFor(()=>offlineCreate.dom.navigationAttempts.length,'明确保留本机后离开');
  assert.equal(JSON.parse(offlineCreate.w.sessionStorage.getItem('geekdash_create:'+users[0].id)).fields.name,'离线创建底稿');
  checks.push('PRD9.5/9.15：明确丢弃新建稿终结云稿并清本页且不创建；草稿离线先保留输入，明确选择保留本机后才离开，未宣称已同步');
  assert.equal(errors.length,0);
  const combinedCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'合并区原值'}}),combinedId=combinedCreated.result.projectId;projects.push(combinedId);
  const combined=await page(a,combinedId);combined.input('#edit-name',prefix+'合并区已保存');combined.input('#edit-dueDate','2030-12-01');combined.input('#edit-state','paused');combined.input('#edit-statusDesc','其他区暂不保存');
  combined.$('#edit-state').dispatchEvent(new combined.w.Event('change',{bubbles:true}));
  combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.$('#error-reason')?.textContent && !combined.$('#reload').disabled,'暂缓缺原因整区拒绝');
  const rejectedCombined=await a.api('/api/projects/'+combinedId);assert.equal(rejectedCombined.project.name,prefix+'合并区原值');assert.equal(rejectedCombined.project.dueDate,null);assert.equal(rejectedCombined.project.status,'proposal');assert.equal(combined.$('#edit-name').value,prefix+'合并区已保存');
  combined.input('#edit-reason','合成核对等待');combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.dom.projectReads.at(-1)?.project.status==='paused' && !combined.$('#reload').disabled,'名称日期暂缓同次成功');
  const savedCombined=await a.api('/api/projects/'+combinedId);assert.equal(savedCombined.project.name,prefix+'合并区已保存');assert.equal(savedCombined.project.dueDate,'2030-12-01');assert.equal(BigInt(savedCombined.project.version),BigInt(combinedCreated.result.savedVersion)+1n);assert.equal(savedCombined.project.statusDesc,'');assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  combined.input('#edit-dueDate','');combined.$('#edit-dueDate').dispatchEvent(new combined.w.Event('change',{bubbles:true}));combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.dom.projectReads.at(-1)?.project.dueDate===null && !combined.$('#reload').disabled,'明确纠正为计划未定');
  const cleared=await a.api('/api/projects/'+combinedId);assert.equal(cleared.project.dueDate,null);assert.equal(cleared.project.status,'paused');assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  assert(!combined.$('[data-basic-clear="dueDate"]'));checks.push('PRD9.4/9.8/9.9：真实合并区名称/计划/暂缓缺原因全部拒绝并保留输入；补原因一次版本全部保存，其他区不夹带；日期留空后明确保存纠正为未定，无重复勾选或纠错原因');
  combined.input('#edit-state','closed');combined.$('#edit-state').dispatchEvent(new combined.w.Event('change',{bubbles:true}));
  combined.input('#edit-closedOn',cleared.businessDate);assert(!combined.$('#edit-reason'));assert(!combined.$('#edit-remainingWorkNote'));combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.$('#error-closureNote')?.textContent && !combined.$('#reload').disabled,'有遗留结案缺单份说明拒绝');assert.equal((await a.api('/api/projects/'+combinedId)).project.version,cleared.project.version);
  combined.input('#edit-closureNote','保留成果归档，未完成阶段后续重新安排');combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.dom.projectReads.at(-1)?.project.status==='closed' && !combined.$('#reload').disabled,'结案明确保存');
  assert.equal(combined.$('#error-closureNote').textContent,'','同区成功后不残留之前的拒绝提示');assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  combined.input('[data-basic="maintenance"]','true');assert(!combined.$('#edit-reason'));combined.click('[data-save-scope="basic"]');
  await waitFor(()=>Number(combined.dom.projectReads.at(-1)?.project.maintenanceEnabled)===1 && !combined.$('#reload').disabled,'维护标记保存');assert.equal((await a.api('/api/projects/'+combinedId)).project.status,'closed');
  combined.input('#edit-state','paused');combined.$('#edit-state').dispatchEvent(new combined.w.Event('change',{bubbles:true}));assert(!combined.$('#edit-reason'));combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.$('[data-choice="save"]'),'重开一次确认退出本次结案');assert.equal((await a.api('/api/projects/'+combinedId)).project.status,'closed');combined.click('[data-choice="save"]');
  await waitFor(()=>combined.dom.projectReads.at(-1)?.project.status==='paused' && !combined.$('#reload').disabled,'合法重开恢复此前状态');const reopenedProject=await a.api('/api/projects/'+combinedId);assert.equal(Number(reopenedProject.project.maintenanceEnabled),0);assert.equal(reopenedProject.project.closedOn,null);assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  checks.push('PRD9.8：有遗留结案缺单份说明整次拒绝，补齐后旧错误清除；维护保持结案，重开一次确认恢复此前状态并关闭维护，无重复原因，其他区输入全程保留');
  combined.tab('history');await waitFor(()=>combined.$('#lifecycle-history [data-lifecycle]'),'暂缓说明纠正入口');
  const lifecycleHistory=combined.$('#lifecycle-history');assert.equal(lifecycleHistory.open,false);assert(!lifecycleHistory.textContent.includes('UTC'));assert(!lifecycleHistory.querySelector('h3').textContent.includes('#'));assert(!lifecycleHistory.textContent.includes('本周截止'));
  lifecycleHistory.open=true;combined.click('#lifecycle-history [data-lifecycle]');await waitFor(()=>combined.$('#lifecycle-edit'),'折叠说明仍能原位调用纠正');combined.tab('info');assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  checks.push('PRD9.14：暂缓恢复说明默认折叠、时间按北京时间显示，主阅读无内部编号/UTC或重复检查提示；原纠正入口仍可打开且其他区输入保留');
  for(const dueDate of ['2031-02-01','']){
    const startupCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'启动组合',dueDate:'2030-12-31'}}),startupId=startupCreated.result.projectId,startupPath='/api/projects/'+startupId;projects.push(startupId);
    for(const action of ['startStage','completeStage'])await a.api(startupPath+'/actions','POST',{action,stageCode:'S1',actualDate:action==='startStage'?'2020-01-01':'2020-01-02',expectedVersion:(await a.api(startupPath)).project.version,idempotencyKey:randomUUID()});
    const startupView=await page(a,startupId),beforeStartup=await facts(startupId);
    startupView.input('#edit-name',prefix+'启动组合已保存');startupView.input('#edit-statusDesc','启动时这段说明仍未保存');startupView.input('#edit-state','ongoing');startupView.$('#edit-state').dispatchEvent(new startupView.w.Event('change',{bubbles:true}));
    startupView.input('#edit-startDate','2020-01-03');startupView.input('#edit-dueDate',dueDate);startupView.$('#edit-dueDate').dispatchEvent(new startupView.w.Event('change',{bubbles:true}));
    if(dueDate){
      assert(startupView.$('#edit-reason'));startupView.click('[data-save-scope="basic"]');
      await waitFor(()=>startupView.$('#message').textContent.includes('原因') && !startupView.$('#reload').disabled,'真实启动改期缺说明拒绝');assert.deepEqual(await facts(startupId),beforeStartup);
      const rejectedStartup=await a.api(startupPath);assert.equal(rejectedStartup.project.status,'proposal');assert.equal(rejectedStartup.project.dueDate,'2030-12-31');assert.equal(startupView.$('#edit-dueDate').value,dueDate);
      startupView.input('[data-basic="planKind"]','correction');startupView.$('[data-basic="planKind"]').dispatchEvent(new startupView.w.Event('change',{bubbles:true}));
    }
    assert(!startupView.$('#edit-reason'),'纠正或清空原计划与启动同存，不索要真实改期原因');startupView.click('[data-save-scope="basic"]');
    await waitFor(()=>startupView.dom.projectReads.at(-1)?.project.status==='ongoing' && !startupView.$('#reload').disabled,'计划纠错与项目启动同次保存');
    const started=await a.api(startupPath);assert.equal(started.project.name,prefix+'启动组合已保存');assert.equal(started.project.startDate,'2020-01-03');assert.equal(started.project.dueDate,dueDate||null);assert.equal(BigInt(started.project.version),BigInt(beforeStartup.project.version)+1n);assert.equal(started.project.statusDesc,'');assert.equal(startupView.$('#edit-statusDesc').value,'启动时这段说明仍未保存');
    const {connection:startupRead}=await connectDatabase('test_app');
    try{
      const persisted=(await startupRead.query("SELECT status,DATE_FORMAT(started_on,'%Y-%m-%d') startedOn,DATE_FORMAT(current_due_date,'%Y-%m-%d') dueDate FROM projects WHERE id=?",[startupId]))[0][0];assert.equal(persisted.status,'ongoing');assert.equal(persisted.startedOn,'2020-01-03');assert.equal(persisted.dueDate,dueDate||null);
      assert.equal(Number((await startupRead.query('SELECT COUNT(*) n FROM schedule_changes WHERE project_id=?',[startupId]))[0][0].n),0,'误填纠正不能记录成真实改期');
      const audit=(await startupRead.query("SELECT action FROM audit_log WHERE project_id=? AND version_after=? ORDER BY id",[startupId,started.project.version]))[0].map(row=>row.action);assert(audit.includes('project.start'));assert(audit.some(action=>action.includes('correctProjectDates')));
    }finally{await startupRead.end();}
    startupView.dom.window.close();
  }
  checks.push('PRD9.4/9.9：有原计划首次启动时，明确纠错日期或清空未定均先纠错再启动，同事务一次版本；真实改期缺说明整笔拒绝，未误记改期，SQL/新GET一致且状态说明输入保留');
  const aggregationCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'阶段日期汇总'}});
  const aggregationId=aggregationCreated.result.projectId;projects.push(aggregationId);
  const aggregationPath='/api/projects/'+aggregationId;
  const saveAggregation=async(scope,nodeOps,target)=>{
    const current=await a.api(aggregationPath);
    return a.api(aggregationPath,'PATCH',{expectedVersion:current.project.version,idempotencyKey:randomUUID(),scope,...(target?{target}:{}),changes:{nodeOps}});
  };
  const addAggregation=(title,stage,targetDate)=>({op:'add',tempId:randomUUID(),kind:'project',fields:{title,stage,output:'合成成果',targetDate}});
  const aggregateNodes=[addAggregation('较早','S1','2030-10-01'),addAggregation('最晚','S1','2030-10-31'),addAggregation('未定','S1',null),addAggregation('其他阶段','S2','2030-12-31')];
  const aggregateSaved=await saveAggregation('projectNodes',aggregateNodes);
  const customerAggregate={op:'add',tempId:randomUUID(),kind:'customer',fields:{title:'客户交付',note:'不参与阶段汇总',targetDate:'2031-01-01'}};
  await saveAggregation('customerNode',[customerAggregate],customerAggregate.tempId);
  const verifyAggregation=async(expected,count,undated)=>{
    const current=await a.api(aggregationPath),stage=current.stages.find(s=>s.code==='S1');
    assert.equal(stage.expectedEndOn,expected);assert.equal(Number(stage.nodeCount),count);assert.equal(Number(stage.undatedNodeCount),undated);
    const {connection:read}=await connectDatabase('test_app');
    try {
      const [rows]=await read.query("SELECT DATE_FORMAT(MAX(n.target_date),'%Y-%m-%d') expected,COUNT(*) count,SUM(n.target_date IS NULL) undated FROM project_nodes n JOIN project_stages s ON s.id=n.stage_id WHERE n.project_id=? AND n.kind='project' AND n.deleted_at IS NULL AND s.stage_code='S1'",[aggregationId]);
      assert.equal(rows[0].expected,expected);assert.equal(Number(rows[0].count),count);assert.equal(Number(rows[0].undated),undated);
    } finally {await read.end();}
    const view=await page(a,aggregationId);view.tab('stages');const text=view.$('.stage-card .stage-note-view').textContent;
    assert(text.includes('预期完成：'+(expected??'待确定')));
    assert.equal(text.includes('个节点未填目标日期'),undated>0);if(undated)assert(text.includes(undated+' 个节点未填目标日期'));
  };
  await verifyAggregation('2030-10-31',3,1);
  const deleteAggregation=index=>({op:'delete',id:aggregateSaved.result.nodeIdMap[aggregateNodes[index].tempId],removeEdges:[]});
  await saveAggregation('projectNodes',[deleteAggregation(1)]);await verifyAggregation('2030-10-01',2,1);
  await saveAggregation('projectNodes',[deleteAggregation(0)]);await verifyAggregation(null,1,1);
  await saveAggregation('projectNodes',[deleteAggregation(2)]);await verifyAggregation(null,0,0);
  checks.push('PRD9.7/9.12：同阶段多节点取最晚日期，缺项就地标明；其他阶段及客户节点不参与，删除后逐次重算至待确定，独立SQL/新GET/真实页面代码一致');
  const refreshCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'刷新故障原值'}}),refreshId=refreshCreated.result.projectId;projects.push(refreshId);
  const refreshView=await page(a,refreshId),refreshBefore=await facts(refreshId);
  refreshView.input('#edit-name',prefix+'刷新故障后保存');refreshView.input('#edit-statusDesc','刷新故障时保留的另一区输入');
  refreshView.dom.failDetailRead=true;refreshView.w.dispatchEvent(new refreshView.w.Event('focus'));
  await waitFor(()=>refreshView.$('#message').textContent.includes('暂时无法核对项目更新'),'详情刷新503显示可恢复提示');
  assert.equal(refreshView.$('#edit-name').value,prefix+'刷新故障后保存');assert.equal(refreshView.$('#edit-statusDesc').value,'刷新故障时保留的另一区输入');assert.equal(refreshView.$('[data-save-scope="basic"]').disabled,false,'读取暂时失败不能冻结可信身份及保存');
  const beforeRetryReads=refreshView.dom.projectReads.length;refreshView.w.dispatchEvent(new refreshView.w.Event('focus'));
  await waitFor(()=>refreshView.dom.projectReads.length>beforeRetryReads,'恢复连接后新请求重新读取详情');
  refreshView.click('[data-save-scope="basic"]');await waitFor(()=>refreshView.dom.projectReads.at(-1)?.project.name===prefix+'刷新故障后保存' && !refreshView.$('#reload').disabled,'读取恢复后明确保存基本区');
  const refreshAfter=await facts(refreshId),refreshRead=await a.api('/api/projects/'+refreshId);
  assert.equal(refreshAfter.project.name,prefix+'刷新故障后保存');assert.equal(BigInt(refreshAfter.project.version),BigInt(refreshBefore.project.version)+1n);assert.equal(refreshAfter.auditCount,refreshBefore.auditCount+1);assert.equal(refreshRead.project.statusDesc,'');assert.equal(refreshView.$('#edit-statusDesc').value,'刷新故障时保留的另一区输入');
  checks.push('PRD9.4/9.17：详情刷新HTTP503只提示暂时失败，保留两区输入且不误冻身份；再次聚焦新读恢复，基本区正式保存一次并由独立SQL/GET确认，另一区不夹带');
  const recoveryCreate=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'草稿接续'}}),recoveryId=recoveryCreate.result.projectId;projects.push(recoveryId);
  const recoveryWriter=await page(a,recoveryId),recoveryBefore=await facts(recoveryId);
  recoveryWriter.input('#edit-statusDesc','等待客户确认接口，周三提供样机。');
  await waitFor(()=>recoveryWriter.dom.draftWrites.some(row=>row.payload.values?.statusDesc==='等待客户确认接口，周三提供样机。'),'本人草稿同步');
  const recoveryReader=await page(a,recoveryId);
  await waitFor(()=>recoveryReader.$('.draft-recovery [data-continue]'),'新页面直接提供继续编辑');
  assert.equal(recoveryReader.$('.draft-recovery [data-continue]').textContent,'继续编辑');
  assert(!recoveryReader.w.document.querySelector('dialog[open]'),'恢复提示不阻断页面或抢占输入');
  recoveryReader.click('.draft-recovery [data-continue]');await waitFor(()=>recoveryReader.$('#edit-statusDesc').value==='等待客户确认接口，周三提供样机。','单份草稿直接恢复');
  assert.deepEqual(await facts(recoveryId),recoveryBefore,'恢复不是正式保存');
  recoveryReader.click('[data-save-scope="status"]');await waitFor(()=>recoveryReader.dom.projectReads.at(-1)?.project.statusDesc==='等待客户确认接口，周三提供样机。' && !recoveryReader.$('#reload').disabled,'明确保存草稿恢复内容');
  const recoveryAfter=await facts(recoveryId);assert.equal(BigInt(recoveryAfter.project.version),BigInt(recoveryBefore.project.version)+1n);assert.equal(recoveryAfter.auditCount,recoveryBefore.auditCount+1);
  const oldRecovery=await page(a,recoveryId);oldRecovery.click('#personal-drafts');await waitFor(()=>oldRecovery.$('[data-draft-list] [data-copy]'),'旧草稿仍供核对');
  assert(oldRecovery.$('[data-draft-list] [data-restore]').disabled,'旧项目版本不得恢复覆盖');oldRecovery.click('[data-draft-list] [data-copy]');
  await waitFor(()=>oldRecovery.$('[data-copy-fallback]:not([hidden])'),'可读文字复制回退');
  assert.match(oldRecovery.$('[data-copy-fallback]').textContent,/最新状态说明：等待客户确认接口/);assert(!oldRecovery.$('[data-copy-fallback]').textContent.includes('schemaVersion'));
  const strangerRecovery=await page(b,recoveryId);assert(!strangerRecovery.$('.draft-recovery'));assert.equal(strangerRecovery.$('#edit-statusDesc')?.value ?? '', '');
  checks.push('PRD9.15：新会话发现单份草稿直接继续编辑，无阻断弹窗；恢复不写项目，明确保存后独立SQL与新GET一致；旧版本只供复制可读业务文字，其他账号隔离');
  const copyActionDraft={action:'rollbackStage',stageCode:'S1',actualDate:'2026-10-19',reason:'样机实测需返工，保留这段原因。'};
  await a.api('/api/personal/drafts/save','POST',{clientDraftId:randomUUID(),projectId:recoveryId,formKind:'action',baseVersion:recoveryBefore.project.version,expectedDraftVersion:'0',clientSequence:'1',payload:{schemaVersion:1,instanceId:randomUUID(),command:copyActionDraft,submission:{command:copyActionDraft}}});
  oldRecovery.click('#personal-drafts');await waitFor(()=>[...oldRecovery.w.document.querySelectorAll('[data-draft-list] section')].some(node=>node.textContent.includes('样机实测需返工')),'旧动作草稿以业务文字展示');
  const actionCard=[...oldRecovery.w.document.querySelectorAll('[data-draft-list] section')].find(node=>node.textContent.includes('样机实测需返工'));
  assert(actionCard.querySelector('[data-restore]').disabled);actionCard.querySelector('[data-copy]').click();await waitFor(()=>!actionCard.querySelector('[data-copy-fallback]').hidden,'复制动作草稿');
  const copiedAction=actionCard.querySelector('[data-copy-fallback]').textContent;assert(copiedAction.includes('真实返工回退'));assert(copiedAction.includes('2026-10-19'));assert(copiedAction.includes('样机实测需返工'));assert(copiedAction.includes('阶段：'));assert(!copiedAction.includes('idempotencyKey'));
  assert.deepEqual(await facts(recoveryId),recoveryAfter,'查看或复制旧动作不改变正式数据');
  checks.push('PRD9.15：旧动作草稿保留可读动作、阶段、实际日期和原因，禁止直接恢复；复制及查看不提交正式数据');
  const sessionCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'本标签页恢复'}}),sessionId=sessionCreated.result.projectId;projects.push(sessionId);
  const sessionWriter=await page(a,sessionId);sessionWriter.input('#edit-name','恢复基本区名称');sessionWriter.input('#edit-statusDesc','恢复独立状态说明');
  await waitFor(()=>sessionWriter.dom.draftWrites.some(row=>row.formKind==='basic') && sessionWriter.dom.draftWrites.some(row=>row.formKind==='status'),'两区草稿先持久同步');
  const sessionBasic=sessionWriter.dom.draftWrites.find(row=>row.formKind==='basic'),sessionStorage=Object.fromEntries(Object.entries(sessionWriter.w.sessionStorage));
  const sessionBefore=await facts(sessionId),sessionReader=await page(a,sessionId,false,{session:sessionStorage,realtime:true});
  await waitFor(()=>sessionReader.$('.draft-recovery [data-continue]'),'详情本标签页恢复提示');
  assert(!sessionReader.w.document.querySelector('dialog[open]'));assert.equal(sessionReader.dom.confirmPrompts.length,0);assert.equal(sessionReader.$('#edit-name').value,prefix+'本标签页恢复');assert.equal(sessionReader.$('#edit-statusDesc').value,'');
  sessionReader.click('.draft-recovery [data-continue]');await waitFor(()=>sessionReader.$('#edit-name').value==='恢复基本区名称','本标签页主动继续编辑');assert.equal(sessionReader.$('#edit-statusDesc').value,'恢复独立状态说明');assert.deepEqual(await facts(sessionId),sessionBefore);
  sessionReader.input('#edit-name','后来输入必须保留');sessionReader.click('#personal-drafts');
  await waitFor(()=>sessionReader.$(`[data-draft-id="${sessionBasic.clientDraftId}"][data-source="active"] [data-restore]`),'旧云稿可选择恢复');sessionReader.click(`[data-draft-id="${sessionBasic.clientDraftId}"][data-source="active"] [data-restore]`);
  await waitFor(()=>sessionReader.$('[data-choice="restore"]'),'等待替换确认');
  await a.api('/api/projects/'+sessionId,'PATCH',{scope:'status',expectedVersion:sessionBefore.project.version,idempotencyKey:randomUUID(),changes:{statusDesc:'其他页面已经保存'}});
  await waitFor(()=>sessionReader.$('#message').textContent.includes('项目已被他人更新'),'确认期间收到真实项目更新');const afterExternal=await facts(sessionId);
  sessionReader.click('[data-choice="restore"]');await waitFor(()=>!sessionReader.$('#editor-dialog').open,'过期恢复确认结束');assert.equal(sessionReader.$('#edit-name').value,'后来输入必须保留');assert.equal(sessionReader.$('#edit-statusDesc').value,'恢复独立状态说明');assert.deepEqual(await facts(sessionId),afterExternal);
  const oldSession=await page(a,sessionId,false,{session:sessionStorage});assert(!oldSession.$('.draft-recovery [data-continue]'));assert.equal(oldSession.$('#edit-name').value,prefix+'本标签页恢复');assert.equal(oldSession.$('#edit-statusDesc').value,'其他页面已经保存');
  checks.push('PRD9.15：同账号本标签页新建/详情底稿非阻断且需明确继续编辑，详情两区完整恢复不写正式数据；替换确认期间真实SSE更新则拒绝旧恢复并保留后来输入，旧版本重进只供复制');
  const rebaseCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'草稿基线推进'}}),rebaseId=rebaseCreated.result.projectId;projects.push(rebaseId);
  const rebaseWriter=await page(a,rebaseId);rebaseWriter.input('#edit-name','只保存基本区');rebaseWriter.input('#edit-statusDesc','基本区保存后仍需恢复的状态说明');
  await waitFor(()=>rebaseWriter.dom.draftWrites.some(row=>row.formKind==='basic') && rebaseWriter.dom.draftWrites.some(row=>row.formKind==='status'),'两区原基线草稿完成同步');
  const retainedDraft=rebaseWriter.dom.draftWrites.find(row=>row.formKind==='status'),oldDraftId=randomUUID();
  await a.api('/api/personal/drafts/save','POST',{clientDraftId:oldDraftId,projectId:rebaseId,formKind:'status',baseVersion:'1',expectedDraftVersion:'0',clientSequence:'1',payload:{schemaVersion:1,instanceId:randomUUID(),values:{statusDesc:'旧版本说明仅供复制'},submission:{scope:'status',changes:{statusDesc:'旧版本说明仅供复制'}}}});
  rebaseWriter.click('[data-save-scope="basic"]');
  await waitFor(()=>rebaseWriter.dom.projectReads.at(-1)?.project.name==='只保存基本区' && !rebaseWriter.$('#reload').disabled,'本人基本区保存并新请求回读');
  const rebaseVersion=rebaseWriter.dom.projectReads.at(-1).project.version;
  assert.equal(rebaseVersion,'2');assert.equal(rebaseWriter.$('#edit-statusDesc').value,'基本区保存后仍需恢复的状态说明');assert.equal((await a.api('/api/projects/'+rebaseId)).project.statusDesc,'');
  await waitFor(()=>rebaseWriter.dom.draftWrites.some(row=>row.clientDraftId===retainedDraft.clientDraftId && row.baseVersion===rebaseVersion),'无额外输入或手动重试时另区云稿自动推进基线');
  const [rebasedRows]=await c.query('SELECT CAST(base_version AS CHAR) baseVersion,state,payload_json payload FROM project_drafts WHERE user_id=? AND client_draft_id=?',[users[0].id,retainedDraft.clientDraftId]);
  assert.equal(rebasedRows[0].baseVersion,rebaseVersion);assert.equal(rebasedRows[0].state,'active');
  const rebasedPayload=typeof rebasedRows[0].payload==='string'?JSON.parse(rebasedRows[0].payload):rebasedRows[0].payload;assert.equal(rebasedPayload.values.statusDesc,'基本区保存后仍需恢复的状态说明');
  const rebaseFacts=await facts(rebaseId),rebaseReader=await page(a,rebaseId);
  await waitFor(()=>rebaseReader.$('.draft-recovery [data-continue]')?.textContent==='继续编辑','一份当前可用稿与旧稿共存时直接恢复当前稿');
  assert.equal(rebaseReader.$('#edit-statusDesc').value,'');assert(!rebaseReader.w.document.querySelector('dialog[open]'));
  rebaseReader.click('.draft-recovery [data-continue]');await waitFor(()=>rebaseReader.$('#edit-statusDesc').value==='基本区保存后仍需恢复的状态说明','新页面从提升基线后的云稿恢复');assert.deepEqual(await facts(rebaseId),rebaseFacts);
  rebaseReader.click('#personal-drafts');await waitFor(()=>rebaseReader.$(`[data-draft-id="${oldDraftId}"] [data-restore]`),'旧版本稿仍在个人草稿列表');assert(rebaseReader.$(`[data-draft-id="${oldDraftId}"] [data-restore]`).disabled);
  checks.push('PRD9.15：本人基本区保存后其他区输入不提交、不丢失；无需新输入或手动重试即自动提升原云稿基线并由SQL确认，新页直接恢复唯一当前稿，旧稿仍仅复制');
  }
  const evidence=recoveryMode?'test-results/scoped-ui-recovery.json':nodeErrorsMode?'test-results/scoped-ui-node-errors.json':impactChainMode?'test-results/scoped-ui-impact-chain.json':nodeFollowupsMode?'test-results/scoped-ui-node-followups.json':catalogStatesMode?'test-results/scoped-ui-catalog-states.json':'test-results/scoped-ui.json';
  await writeFile(evidence,JSON.stringify({status:'passed',checkedAt:new Date().toISOString(),checks,requests:requestCount,realBrowserLayout:false},null,2));
  console.log(JSON.stringify({status:'passed',checks:checks.length,evidence}));
} catch (error) { console.error(error); throw error; } finally {
  for(const view of views){for(const stream of view.streams ?? [])stream.close();view.window.close();}if(app)await app.close();
  if(users.length)for(const table of ['project_drafts','user_preferences'])await c.query(`DELETE FROM ${table} WHERE user_id IN (?)`,[users.map(u=>u.id)]);
  if(projects.length){await c.query('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id IN (?)',[projects]);for(const table of ['audit_log','project_checks','schedule_changes','project_changes','project_risks','project_nodes','project_stages','project_people','project_chips','project_tags','project_responsibilities'])await c.query(`DELETE FROM ${table} WHERE project_id IN (?)`,[projects]);await c.query('DELETE FROM projects WHERE id IN (?)',[projects]);}
  if(references.length)await c.query('DELETE FROM tags WHERE id IN (?)',[references]);
  if(users.length){const ids=users.map(u=>u.id);for(const table of ['command_receipts','audit_log'])await c.query(`DELETE FROM ${table} WHERE actor_id IN (?)`,[ids]);await c.query('DELETE FROM sessions WHERE user_id IN (?)',[ids]);await c.query('DELETE FROM users WHERE id IN (?)',[ids]);}
  await c.end();process.off('unhandledRejection',reject);
}

