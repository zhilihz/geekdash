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
  dom.projectReads = [];dom.draftWrites=[];dom.preferenceWrites=[];dom.createWrites=[];dom.navigationAttempts=navigationAttempts;
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone, AbortSignal, AbortController, __GEEKDASH_STAGES__: stages });
  w.performance.getEntriesByType=()=>[];w.confirm=()=>true;
  w.scrollTo=()=>{};
  for(const [key,value] of Object.entries(options.local ?? {}))w.localStorage.setItem(key,value);
  for(const [key,value] of Object.entries(options.session ?? {}))w.sessionStorage.setItem(key,value);
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
    if(dom.rejectDrafts && path==='/api/personal/drafts/save')throw new Error('模拟草稿离线');
    if(dom.rejectDraftRead && path.startsWith('/api/personal/drafts?'))throw new Error('模拟草稿读取离线');
    const response = await user.fetch(path, options);
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
    if (dom.holdSave && options?.method === 'PATCH') { dom.holdSave = false; await new Promise(resolve => { dom.releaseSave = resolve; }); }
    if (dom.dropSaveAck && options?.method === 'PATCH') { dom.dropSaveAck = false; await response.arrayBuffer(); throw new Error('模拟真实COMMIT后的确认丢失'); }
    if (dom.dropActionAck && path === '/api/projects/' + projectId + '/actions' && options?.method === 'POST') { dom.dropActionAck = false; await response.arrayBuffer(); throw new Error('模拟真实动作COMMIT后的确认丢失'); }
    return response;
  };
  const context = dom.getInternalVMContext(), modules = new Map();
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
  if(options.realtime)await waitFor(()=>dom.events.some(item=>item.event==='connected'),'真实SSE页面连通');
  const $ = selector => w.document.querySelector(selector);
  const input = (selector, value) => { const element = $(selector); assert(element, selector); element.value = value; element.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const click = selector => { const element = $(selector); assert(element, selector); assert(!element.disabled, selector + ' 不应禁用'); element.click(); };
  const visibleClick = selector => { const element = $(selector); assert(element, selector); assert.equal(element.closest('[hidden]'), null, selector + ' 必须实际展示'); const dialog = element.closest('dialog'); if (dialog) assert(dialog.open, selector + ' 所在弹窗必须已打开'); click(selector); };
  return { dom, w, $, input, click, visibleClick, tab: value => click(`[data-tab="${value}"]`) };
}
async function facts(id) {
  const { connection } = await connectDatabase('test_app');
  try { return { project: (await connection.query('SELECT name,summary_note,CAST(version AS CHAR) version FROM projects WHERE id=?', [id]))[0][0], nodes: (await connection.query('SELECT CAST(id AS CHAR) id,title,output FROM project_nodes WHERE project_id=? AND deleted_at IS NULL ORDER BY id', [id]))[0], auditCount: Number((await connection.query('SELECT COUNT(*) n FROM audit_log WHERE project_id=?', [id]))[0][0].n) }; }
  finally { await connection.end(); }
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
  const tagName=prefix+' 项目标签';
  await c.execute('INSERT INTO tags (name,created_at,updated_at) VALUES (?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[tagName]);
  const tagId=(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id; references.push(tagId);
  const p=await page(a,id), read=()=>a.api(path);
  p.click('#tags-edit');await waitFor(()=>p.$('#edit-tagIds') && !p.$('#edit-tagIds').disabled,'标签候选加载');p.input('#edit-tagIds',tagName);p.click('[data-reference-value="'+tagId+'"]');p.click('[data-save-scope="tags"]');
  await waitFor(()=>p.dom.projectReads.at(-1)?.project.tags.some(tag=>tag.id===tagId) && !p.$('#reload').disabled,'项目标签正式保存');
  assert(p.$('#d-tags').textContent.includes(tagName),'保存后的标题区必须显示实际项目标签');
  const tagReadback=await page(a,id);assert(tagReadback.$('#d-tags').textContent.includes(tagName),'重新进入仍显示正式标签');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_tags WHERE project_id=? AND tag_id=?',[id,tagId]))[0][0].n),1);
  checks.push('PRD9.7：标签独立保存后标题区实际显示，重新进入与独立SQL关联一致');
  assert(p.$('#basic-edit')); assert.equal(p.$('#edit-name'),null); assert(p.$('#edit-statusDesc'));
  p.input('#edit-statusDesc','说明暂不提交'); p.click('#basic-edit'); p.input('#edit-name',prefix+'改名');
  p.click('[data-save-scope="basic"]'); await waitFor(()=>p.dom.projectReads.at(-1)?.project.name===prefix+'改名' && !p.$('#reload').disabled,'基本区保存并新读');
  assert.equal(p.$('#edit-statusDesc').value,'说明暂不提交'); assert.equal((await read()).project.statusDesc,''); assert.equal((await facts(id)).project.name,prefix+'改名');
  p.click('#basic-edit');p.input('#edit-summary','未提交简介');p.input('#edit-statusDesc','只保存说明');p.click('[data-save-scope="status"]');
  await waitFor(()=>p.dom.projectReads.at(-1)?.project.statusDesc==='只保存说明' && !p.$('#reload').disabled,'说明保存');
  assert.equal(p.$('#edit-summary').value,'未提交简介'); assert.equal((await read()).project.summary,'项目简介');p.click('#basic-cancel');await waitFor(()=>!p.$('#edit-name'),'取消本区底稿后回到静态');
  checks.push('PRD9.4：静态基本区原位切换，两区交替保存与取消仅作用本区；正式新读及独立SQL');
  p.click('#basic-edit');p.input('#edit-name',prefix+'迟到确认');p.dom.holdSave=true;p.click('[data-save-scope="basic"]');
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
  p.click('[data-change="correct"]');p.input('#chg-content','只改需求文字');assert(p.$('#chg-impact').hidden);p.click('#change-submit');
  await waitFor(()=>p.$('.chg-content')?.textContent==='只改需求文字' && !p.$('#reload').disabled,'需求普通纠错');
  checks.push('PRD9.10/9.11：风险与需求每条正式保存一次，普通纠错不强制预览，风险误录删除持久保留来源');
  const legacyChange = (await read()).changes[0];
  await c.execute('UPDATE project_changes SET source=? WHERE id=?', ['旧未知来源', legacyChange.id]);
  const legacyPage = await page(a,id); legacyPage.tab('risk'); legacyPage.click('[data-change="correct"]');
  assert(legacyPage.$('#chg-impact').hidden, '未触及旧来源不能自动成为来源纠错');
  legacyPage.input('#chg-content','仅纠正旧记录文字'); legacyPage.click('#change-submit');
  await waitFor(()=>legacyPage.dom.projectReads.at(-1)?.changes[0].content==='仅纠正旧记录文字' && !legacyPage.$('#reload').disabled,'旧来源保持的普通文字保存');
  const legacyRead=(await read()).changes[0]; assert.equal(legacyRead.source,'旧未知来源'); assert.equal(legacyRead.createdAt,legacyChange.createdAt);
  legacyPage.click('[data-change="correct"]'); legacyPage.input('#chg-source','业务'); assert(!legacyPage.$('#chg-impact').hidden);
  legacyPage.input('#chg-correction-reason','核对原始业务来源'); legacyPage.click('#change-submit');
  await waitFor(()=>!legacyPage.$('#change-accept').hidden && !legacyPage.$('#change-accept').disabled,'来源纠错影响预览');
  assert.equal((await read()).changes[0].source,'旧未知来源'); legacyPage.click('#change-accept');
  await waitFor(()=>legacyPage.dom.projectReads.at(-1)?.changes[0].source==='业务' && !legacyPage.$('#reload').disabled,'明确纠正来源');
  assert.equal((await c.query('SELECT source FROM project_changes WHERE id=?',[legacyChange.id]))[0][0].source,'业务');
  legacyPage.dom.window.close(); p.click('#reload'); await waitFor(()=>p.dom.projectReads.at(-1)?.changes[0].source==='业务' && !p.$('#reload').disabled,'原页重读');
  checks.push('PRD9.11：旧未知来源只读保留、普通内容直接保存；明确选来源后才预览，确认前不写，确认后SQL与另一页面新读一致');
  p.tab('custnodes');p.click('[data-node="add"]');p.input('[data-node-field="title"]','客户交付');p.input('[data-node-field="note"]','客户说明');p.click('#node-edit [type="submit"]');
  await waitFor(()=>p.dom.projectReads.at(-1)?.nodes.some(n=>n.title==='客户交付') && !p.$('#reload').disabled,'客户节点一次保存');
  p.tab('nodes');p.click('[data-node="add"]');p.input('[data-node-field="title"]','阶段成果');p.input('[data-node-field="stage"]','S1');p.input('[data-node-field="targetDate"]','2030-10-01');p.input('[data-node-field="output"]','成果说明');p.click('#node-edit [type="submit"]');
  await waitFor(()=>!p.$('#node-edit'),'项目节点回到共享副本');assert.equal((await read()).nodes.filter(n=>n.kind==='project').length,0);
  p.tab('flow');assert.match(p.$('#detail-body').textContent,/阶段成果/);p.click('[data-save-scope="projectNodes"]');
  await waitFor(()=>p.dom.projectReads.at(-1)?.nodes.some(n=>n.title==='阶段成果') && !p.$('#reload').disabled,'Flow保存同一节点');
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
  await waitFor(()=>p.$('#node-accept') && !p.$('#node-accept').disabled,'删除预览');p.click('#node-accept');p.click('[data-save-scope="projectNodes"]');
  await waitFor(()=>!p.dom.projectReads.at(-1)?.nodes.some(n=>n.kind==='project') && !p.$('#reload').disabled,'节点正式删除');
  p.click('#deleted-refresh');await waitFor(()=>p.$('[data-node="restore"]'),'读取原删除节点');p.click('[data-node="restore"]');
  assert(p.$('[data-restore-field="output"]').disabled);assert(p.$('#restore-actual').disabled);
  p.click('[data-restore-select="output"]');assert(!p.$('[data-restore-field="output"]').disabled);
  p.input('[data-restore-field="output"]','恢复时核对后的成果');
  p.click('[data-restore-select="title"]');assert(!p.$('[data-restore-field="title"]').disabled);p.input('[data-restore-field="title"]','取消纠正不提交此名称');p.click('[data-restore-select="title"]');assert(p.$('[data-restore-field="title"]').disabled);
  p.input('#node-reason','合成验收：恢复误删并核对成果');p.click('#node-edit [type="submit"]');
  await waitFor(()=>p.$('#node-accept') && !p.$('#node-accept').disabled,'恢复及所选纠错预览');assert(p.$('[data-restore-field="title"]').disabled);assert(!p.$('[data-restore-field="output"]').disabled);
  p.click('#node-accept');p.click('[data-save-scope="projectNodes"]');await waitFor(()=>p.dom.projectReads.at(-1)?.nodes.some(n=>n.output==='恢复时核对后的成果') && !p.$('#reload').disabled,'恢复及纠正同次保存');
  const recovered=(await read()).nodes.find(n=>n.kind==='project');assert.equal(recovered.id,moved.nodes.find(n=>n.kind==='project').id);assert.equal(recovered.title,'阶段成果');assert.equal(recovered.output,'恢复时核对后的成果');
  checks.push('PRD9.12：恢复字段仅明确勾选后可编辑，取消勾选不夹带输入；预览后仍保持启用规则，同次恢复和所选纠错新GET确认原ID');
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
  restored.click('[data-correction="correctStageFacts"]');await waitFor(()=>restored.$('#correction-edit'),'阶段日期纠错入口');
  assert(restored.$('[data-correct-date="S1:startedOn"]').disabled);restored.click('[data-correct-select="S1:startedOn"]');assert(!restored.$('[data-correct-date="S1:startedOn"]').disabled);
  restored.input('[data-correct-date="S1:startedOn"]','2026-09-30');restored.input('#correction-reason','合成验收：仅纠正开始日期');restored.click('#correction-edit [type="submit"]');
  await waitFor(()=>!restored.$('#correction-save').disabled,'日期差异预览');const correctionText=restored.$('#correction-preview').textContent;
  assert.match(correctionText,/需求立项 · 实际开始/);assert(!correctionText.includes('实际完成'));assert(!correctionText.includes('需求立项：需求立项'));assert(restored.$('[data-correct-date="S1:completedOn"]').disabled);
  restored.click('#correction-save');await waitFor(()=>restored.dom.projectReads.at(-1)?.stages[0].startedOn==='2026-09-30' && !restored.$('#reload').disabled,'阶段纠错新读');
  assert.equal((await read()).stages[0].state,'active');checks.push('PRD9.7：阶段日期仅勾选可编辑；预览仅变更字段，不重复阶段名称，保存日期不改变阶段状态');
  restored.tab('info');restored.click('#basic-edit');restored.input('#edit-name','取消这一份基本稿');restored.input('#edit-statusDesc','状态区仍须保留');
  await waitFor(()=>restored.dom.draftWrites.some(row=>row.payload.values?.name==='取消这一份基本稿') && restored.dom.draftWrites.some(row=>row.payload.values?.statusDesc==='状态区仍须保留'),'两区底稿同步');
  const cancelled=restored.dom.draftWrites.filter(row=>row.payload.values?.name==='取消这一份基本稿').at(-1);
  restored.click('#basic-cancel');await waitFor(()=>!restored.$('#edit-name'),'基本区取消');
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
  restored.click('[data-close]');restored.click('#basic-edit');restored.input('#edit-name','准备恢复的名称');
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
  assert(liveB.$('[data-save-scope="status"]').disabled);assert(sameAccount.$('[data-save-scope="status"]').disabled);assert(!liveA.$('#basic-edit').disabled);
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
  const offlineCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'草稿离线'}}),offlineId=offlineCreated.result.projectId;projects.push(offlineId);
  const offline=await page(a,offlineId);offline.dom.rejectDrafts=true;offline.click('#basic-edit');offline.input('#edit-name',prefix+'正式保存可用');offline.input('#edit-statusDesc','其他区离线输入');
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
  const combined=await page(a,combinedId);combined.click('#basic-edit');combined.input('#edit-name',prefix+'合并区已保存');combined.input('#edit-dueDate','2030-12-01');combined.input('#edit-state','paused');combined.input('#edit-statusDesc','其他区暂不保存');
  combined.$('#edit-state').dispatchEvent(new combined.w.Event('change',{bubbles:true}));
  combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.$('#error-reason')?.textContent && !combined.$('#reload').disabled,'暂缓缺原因整区拒绝');
  const rejectedCombined=await a.api('/api/projects/'+combinedId);assert.equal(rejectedCombined.project.name,prefix+'合并区原值');assert.equal(rejectedCombined.project.dueDate,null);assert.equal(rejectedCombined.project.status,'proposal');assert.equal(combined.$('#edit-name').value,prefix+'合并区已保存');
  combined.input('#edit-reason','合成核对等待');combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.dom.projectReads.at(-1)?.project.status==='paused' && !combined.$('#reload').disabled,'名称日期暂缓同次成功');
  const savedCombined=await a.api('/api/projects/'+combinedId);assert.equal(savedCombined.project.name,prefix+'合并区已保存');assert.equal(savedCombined.project.dueDate,'2030-12-01');assert.equal(BigInt(savedCombined.project.version),BigInt(combinedCreated.result.savedVersion)+1n);assert.equal(savedCombined.project.statusDesc,'');assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  combined.click('#basic-edit');combined.input('#edit-dueDate','');combined.$('#edit-dueDate').dispatchEvent(new combined.w.Event('change',{bubbles:true}));combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.$('#message').textContent.includes('明确勾选'),'清空日期需要明确意图');assert.equal((await a.api('/api/projects/'+combinedId)).project.dueDate,'2030-12-01');
  combined.$('[data-basic-clear="dueDate"]').checked=true;combined.$('[data-basic-clear="dueDate"]').dispatchEvent(new combined.w.Event('change',{bubbles:true}));combined.input('#edit-reason','原计划误录，当前未定');combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.dom.projectReads.at(-1)?.project.dueDate===null && !combined.$('#reload').disabled,'明确纠正为计划未定');
  const cleared=await a.api('/api/projects/'+combinedId);assert.equal(cleared.project.dueDate,null);assert.equal(cleared.project.status,'paused');assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  checks.push('PRD9.4/9.8/9.9：真实合并区名称/计划/暂缓缺原因全部拒绝并保留输入；补原因一次版本全部保存，其他区不夹带；空日期不自动清除，明确纠正为未定后新读');
  combined.click('#basic-edit');combined.input('#edit-state','closed');combined.$('#edit-state').dispatchEvent(new combined.w.Event('change',{bubbles:true}));
  combined.input('#edit-closedOn',cleared.businessDate);combined.input('#edit-reason','合成结案');combined.input('#edit-closureNote','保留成果归档');combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.$('#error-remainingWorkNote')?.textContent && !combined.$('#reload').disabled,'结案缺遗留说明拒绝');assert.equal((await a.api('/api/projects/'+combinedId)).project.version,cleared.project.version);
  combined.input('#edit-remainingWorkNote','未完成阶段保留，后续重新安排');combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.dom.projectReads.at(-1)?.project.status==='closed' && !combined.$('#reload').disabled,'结案明确保存');combined.click('#basic-edit');
  assert.equal(combined.$('#error-remainingWorkNote').textContent,'','同区成功后不残留之前的拒绝提示');assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  combined.input('[data-basic="maintenance"]','true');combined.input('#edit-reason','结案后继续维护');combined.click('[data-save-scope="basic"]');
  await waitFor(()=>Number(combined.dom.projectReads.at(-1)?.project.maintenanceEnabled)===1 && !combined.$('#reload').disabled,'维护标记保存');assert.equal((await a.api('/api/projects/'+combinedId)).project.status,'closed');
  combined.click('#basic-edit');combined.input('#edit-state','paused');combined.$('#edit-state').dispatchEvent(new combined.w.Event('change',{bubbles:true}));combined.input('#edit-reason','重新打开，恢复结案前暂缓状态');combined.click('[data-save-scope="basic"]');
  await waitFor(()=>combined.dom.projectReads.at(-1)?.project.status==='paused' && !combined.$('#reload').disabled,'合法重开恢复此前状态');const reopenedProject=await a.api('/api/projects/'+combinedId);assert.equal(Number(reopenedProject.project.maintenanceEnabled),0);assert.equal(reopenedProject.project.closedOn,null);assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  checks.push('PRD9.8：结案缺遗留处置整次拒绝，补齐成功后旧错误清除；维护保持结案，重开恢复此前状态并关闭维护，其他区输入全程保留');
  combined.tab('history');await waitFor(()=>combined.$('#lifecycle-history [data-lifecycle]'),'暂缓说明纠正入口');
  const lifecycleHistory=combined.$('#lifecycle-history');assert.equal(lifecycleHistory.open,false);assert(!lifecycleHistory.textContent.includes('UTC'));assert(!lifecycleHistory.querySelector('h3').textContent.includes('#'));assert(!lifecycleHistory.textContent.includes('本周截止'));
  lifecycleHistory.open=true;combined.click('#lifecycle-history [data-lifecycle]');await waitFor(()=>combined.$('#lifecycle-edit'),'折叠说明仍能原位调用纠正');combined.tab('info');assert.equal(combined.$('#edit-statusDesc').value,'其他区暂不保存');
  checks.push('PRD9.14：暂缓恢复说明默认折叠、时间按北京时间显示，主阅读无内部编号/UTC或重复检查提示；原纠正入口仍可打开且其他区输入保留');
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
  await writeFile('test-results/scoped-ui.json',JSON.stringify({status:'passed',checks,requests:requestCount,realBrowserLayout:false},null,2));
  console.log(JSON.stringify({status:'passed',checks:checks.length,evidence:'test-results/scoped-ui.json'}));
} catch (error) { console.error(error); throw error; } finally {
  for(const view of views){for(const stream of view.streams ?? [])stream.close();view.window.close();}if(app)await app.close();
  if(users.length)for(const table of ['project_drafts','user_preferences'])await c.query(`DELETE FROM ${table} WHERE user_id IN (?)`,[users.map(u=>u.id)]);
  if(projects.length){for(const table of ['audit_log','project_checks','schedule_changes','project_changes','project_risks','project_nodes','project_stages','project_people','project_chips','project_tags','project_responsibilities'])await c.query(`DELETE FROM ${table} WHERE project_id IN (?)`,[projects]);await c.query('DELETE FROM projects WHERE id IN (?)',[projects]);}
  if(references.length)await c.query('DELETE FROM tags WHERE id IN (?)',[references]);
  if(users.length){const ids=users.map(u=>u.id);for(const table of ['command_receipts','audit_log'])await c.query(`DELETE FROM ${table} WHERE actor_id IN (?)`,[ids]);await c.query('DELETE FROM sessions WHERE user_id IN (?)',[ids]);await c.query('DELETE FROM users WHERE id IN (?)',[ids]);}
  await c.end();process.off('unhandledRejection',reject);
}

