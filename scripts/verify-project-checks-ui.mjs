import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

// 执行实际页面源码和真实HTTP/MySQL。DOM模型不替代原生浏览器的样式、弹窗和导航验收。
const { JSDOM, CookieJar, VirtualConsole } = await import(process.env.GEEKDASH_DOM_LIBRARY ?? '../test-results/ui-dom-tools/node_modules/jsdom/lib/api.js');
const prefix = 'checks_ui_' + randomUUID().slice(0, 8), password = '检查页面整链 password 2026';
const users = [], projects = [], views = [], errors = [], checks = [];
const initialStatesMode = process.argv.includes('--initial-states');
const sourcePaths = ['src/web/project-checks.html', 'src/web/project-checks.ts', 'src/web/project-detail.html', 'src/web/detail.ts', 'src/web/shared/api.ts', 'src/web/shared/reference-picker.ts'];
const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await readFile(path, 'utf8')])));
const stageSource = (await readFile('geekdashdesktop/projects-data.js', 'utf8')).match(/const STAGES = (\[[\s\S]*?\n  \]);/);
assert(stageSource);
const stages = vm.runInNewContext(stageSource[1], Object.create(null), { timeout: 1000 });
const { connection: c } = await connectDatabase('test_migrator');
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
let app, origin, requestCount = 0;
const reject = error => errors.push(error);
process.on('unhandledRejection', reject);

function client() {
  const jar = new CookieJar(); let actor;
  return { jar, async fetch(path, options = {}) {
    const url = new URL(path, origin).href, headers = new Headers(options.headers);
    headers.set('Cookie', jar.getCookieStringSync(url)); headers.set('Origin', 'http://localhost');
    requestCount++; const response = await fetch(url, { ...options, headers });
    for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, url);
    return response;
  }, async api(path, method = 'GET', body, status = 200) {
    const csrf = jar.getCookiesSync(origin).find(cookie => cookie.key === 'geekdash_dev_csrf')?.value;
    const response = await this.fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', ...(csrf ? { 'X-GeekDash-CSRF': csrf } : {}), ...(actor ? { 'X-GeekDash-Account': actor.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
    if (path === '/api/auth/me' && status === 200) actor = data.account;
    return data;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); } };
}
async function waitFor(predicate, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (errors.length) throw errors[0]; if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('未出现预期状态：' + message);
}
async function page(user, path, { storage = {}, holdConfirm = false, realtime = false, restorePrompt = false, failInitialList = false, missingInspection = false } = {}) {
  const detail = path.startsWith('/project-detail.html'), html = sources[detail ? 'src/web/project-detail.html' : 'src/web/project-checks.html'];
  const virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', reject);
  const dom = new JSDOM(html, { url: origin + path, cookieJar: user.jar, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole }); views.push(dom);
  const w = dom.window, reads = [], requests = [];
  const panel = { dom, w, reads, requests, events: [], dropAck: false, releaseConfirm: undefined, failNextList: failInitialList, missingInspection };
  if (!detail) {
    const NativeDate = w.Date, interval = w.setInterval.bind(w);
    w.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [panel.now ?? NativeDate.now()])); } static now() { return panel.now ?? NativeDate.now(); } };
    w.setInterval = (callback, delay, ...args) => { if (delay === 60000) panel.dayTick = () => callback(...args); return interval(callback, delay, ...args); };
  }
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone, AbortController, AbortSignal, __GEEKDASH_STAGES__: stages });
  w.BroadcastChannel = class { postMessage() {} }; w.scrollTo = () => {};
  dom.streams=[];
  if(realtime)w.EventSource=class extends w.EventTarget{
    controller=new AbortController();closed=false;onerror=null;
    constructor(url){super();dom.streams.push(this);void(async()=>{try{
      const response=await user.fetch(url,{signal:this.controller.signal});if(!response.ok)throw Error('SSE '+response.status);
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      for(;;){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=frame.match(/^event: (.+)$/m)?.[1],data=frame.match(/^data: (.+)$/m)?.[1];if(event && data){panel.events.push({event,data:JSON.parse(data)});this.dispatchEvent(new w.MessageEvent(event,{data}));}}}
      if(!this.closed)this.onerror?.();
    }catch{if(!this.closed)this.onerror?.();}})();}
    close(){this.closed=true;this.controller.abort();}
  };
  w.performance.getEntriesByType = () => [];
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; this.returnValue = ''; };
  w.HTMLDialogElement.prototype.close = function(value = '') { this.returnValue = value; this.open = false; this.dispatchEvent(new w.Event('close')); };
  for (const [key, value] of Object.entries(storage)) w.sessionStorage.setItem(key, value);
  w.fetch = async (url, options = {}) => {
    if (panel.failHistory && /\/(checks|audit)(\?|$)/.test(url)) throw new Error('模拟历史读取失败');
    if (panel.failNextList && url.startsWith('/api/projects?')) { panel.failNextList = false; throw new Error('模拟提交后列表读取失败'); }
    const entry = { path: url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined }; requests.push(entry);
    const response = await user.fetch(url, options); entry.status = response.status;
    if(panel.missingInspection && url.startsWith('/api/projects?')){const json=response.json.bind(response);response.json=async()=>{const data=await json();for(const item of data.items)delete item.inspection;return data;};}
    if(panel.holdDetailRead && entry.method==='GET' && /^\/api\/projects\/\d+$/.test(url) && response.ok){panel.holdDetailRead=false;await new Promise(resolve=>{panel.releaseDetailRead=resolve;});}
    if (entry.method === 'GET' && url.startsWith('/api/projects') && response.ok) reads.push({ path: url, data: await response.clone().json() });
    if (holdConfirm && url.endsWith('/action-results/query')) { holdConfirm = false; await new Promise(resolve => { panel.releaseConfirm = resolve; }); }
    if (panel.dropAck && url.endsWith('/actions') && entry.method === 'POST' && response.ok) { panel.dropAck = false; await response.arrayBuffer(); throw new Error('模拟真实COMMIT后响应丢失'); }
    return response;
  };
  const context = dom.getInternalVMContext();
  const modules = new Map();
  function load(path) {
    if (path.endsWith('.css')) return {};
    path = resolve(path.endsWith('.ts') ? path : path + '.ts');
    if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const source = readFileSync(path, 'utf8'); sources[path] = source;
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInContext('(function(require,exports,module){' + code + '\n})', context, { filename: path })(name => load(resolve(dirname(path), name)), module.exports, module);
    return module.exports;
  }
  load(detail ? 'src/web/detail.ts' : 'src/web/project-checks.ts');
  panel.$ = selector => w.document.querySelector(selector);
  panel.click = selector => { const node = panel.$(selector); assert(node, selector); assert.equal(node.closest('[hidden]'), null, selector + ' 必须可见'); assert(!node.disabled, selector + ' 不应禁用'); const dialog = node.closest('dialog'); if (dialog) assert(dialog.open); node.click(); };
  panel.input = (selector, value) => { const node = panel.$(selector); assert(node && !node.disabled, selector); node.value = value; node.dispatchEvent(new w.Event('input', { bubbles: true })); };
  await waitFor(() => detail ? restorePrompt ? panel.$('[data-choice="restore"]') : !panel.$('#detail-panel').hidden && !panel.$('#reload').disabled : failInitialList ? panel.$('#check-loading').textContent.includes('读取失败') && !panel.$('#check-reload').disabled : panel.$('#page-info').textContent, '实际页面初次读取');
  if(realtime)await waitFor(()=>panel.events.some(event=>event.event==='connected'),'实际页面SSE连接');
  return panel;
}
const card = id => `[data-project-id="${id}"]`, pass = id => `[data-check-project="${id}"]`;
const lists = panel => panel.reads.filter(item => item.path.startsWith('/api/projects?'));
const settled = panel => panel.$('#check-list').getAttribute('aria-busy') === 'false';
async function facts(id) {
  const { connection } = await connectDatabase('test_app');
  try {
    const [project] = await connection.query('SELECT CAST(version AS CHAR) version,status_description FROM projects WHERE id=?', [id]);
    const [records] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(actor_id AS CHAR) actorId,CAST(observed_version AS CHAR) observedVersion,CAST(result_version AS CHAR) resultVersion,conclusion,note,week_start,rule_version FROM project_checks WHERE project_id=? ORDER BY id', [id]);
    const [audit] = await connection.query("SELECT CAST(id AS CHAR) id,CAST(entity_id AS CHAR) entityId FROM audit_log WHERE project_id=? AND action='project.check.save' ORDER BY id", [id]);
    const [receipts] = await connection.query("SELECT idempotency_key FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':actions') ORDER BY idempotency_key", [id]);
    return { project: { ...project[0] }, records: records.map(row => ({ ...row })), audit: audit.map(row => ({ ...row })), receipts: receipts.map(row => row.idempotency_key) };
  } finally { await connection.end(); }
}

try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test', '只能操作独立测试库');
  for (const name of ['owner', 'other']) {
    const loginName = prefix + '_' + name;
    await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, await hashPassword(password), '检查合成' + name]);
    users.push({ id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id, loginName });
  }
  const runtime = await openRuntimeDatabase('test_app'); app = await createApp(runtime, { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const a = client(), b = client(); await a.login(0); await b.login(1);
  const ids = {};
  for (const name of initialStatesMode?['success']:['success', 'correct', 'conflict', 'lost', 'denied']) {
    const user = name === 'denied' ? b : a;
    const created = await user.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '_' + name, summaryNote: '独立检查页面合成项目' } });
    ids[name] = created.result.projectId; projects.push(created.result.projectId);
    await user.api('/api/projects/' + ids[name], 'PATCH', { scope: 'status', expectedVersion: created.result.savedVersion, idempotencyKey: randomUUID(), changes: { statusDesc: '资料已核对\n原说明保持只读' } });
  }
  if(initialStatesMode){
    const id=ids.success,path='/project-checks.html?view=all&search='+prefix,before=await facts(id);
    const failed=await page(a,path,{failInitialList:true});
    assert.equal(failed.$('.checks-empty'),null);assert.equal(failed.$('.check-card'),null);assert(failed.$('#next').disabled);assert.match(failed.$('#check-loading').textContent,/读取失败/);assert.deepEqual(await facts(id),before);
    failed.click('#check-reload');await waitFor(()=>failed.$(pass(id)) && !failed.$(pass(id)).disabled && settled(failed),'首次失败后重读完整卡片');
    assert.match(failed.$(card(id)).textContent,/资料已核对/);assert.equal(new URL(failed.$('#back').href).searchParams.get('search'),prefix);assert.deepEqual(await facts(id),before);
    checks.push('PRD9.13-4：检查初始列表请求失败明确报错，无伪空集合、无通过入口；重读真实完整卡片成功，原筛选/返回范围保留，新SQL确认未写检查。');
    failed.click('[data-check-today="checked"]');await waitFor(()=>settled(failed) && failed.$('.checks-empty'),'真实已查范围为空');
    assert.equal(failed.$('.checks-empty').textContent,'当前范围今天还没有检查记录');assert.equal(lists(failed).at(-1).data.pagination.total,0);assert.equal(failed.$('[data-check-project]'),null);assert(failed.$('#next').disabled);assert(failed.$('#previous').disabled);
    failed.click('[data-check-today="unchecked"]');await waitFor(()=>settled(failed) && failed.$(pass(id)) && !failed.$(pass(id)).disabled,'切回唯一未查项目');failed.click(pass(id));
    await waitFor(()=>settled(failed) && failed.$('.checks-empty')?.textContent==='当前范围今天没有待检查项目','全范围已查后未查集合为空');
    const after=await facts(id);assert.equal(after.records.length,1);assert.equal(after.audit.length,1);assert.equal(lists(failed).at(-1).data.pagination.total,0);assert.equal(failed.$('[data-check-project]'),null);assert.equal(new URL(failed.$('#back').href).searchParams.get('search'),prefix);
    failed.click('[data-check-today="checked"]');await waitFor(()=>settled(failed) && failed.$(card(id)),'已查列表消费刚保存事实');assert(failed.$(pass(id)).disabled);assert((await a.api('/api/projects/'+id)).project.checkedToday);assert.deepEqual(await facts(id),after);
    checks.push('PRD9.13-2：真实筛选先得到已查0条；唯一未查项目通过后未查0条，专属空文案/分页/返回范围正确；已查新请求看到原项目，SQL一条检查和审计，无重复写。');
    const missingCreated=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'_missing',summary:'缺快照合成项目'}}),missingId=missingCreated.result.projectId;projects.push(missingId);
    const missingBefore=await facts(missingId),missing=await page(a,path+'_missing',{missingInspection:true});
    assert.match(missing.$(card(missingId)).textContent,/完整项目内容尚未读到，请重新读取后检查/);assert(missing.$(pass(missingId)).disabled);assert.deepEqual(await facts(missingId),missingBefore);
    assert.equal((await a.api('/api/projects/'+missingId)).project.checkedToday,false,'用未检查项目验证缺快照时禁用');
    missing.missingInspection=false;missing.click('#check-reload');await waitFor(()=>settled(missing) && !missing.$(card(missingId)).textContent.includes('完整项目内容尚未读到'),'缺快照重读恢复完整信息');assert(!missing.$(pass(missingId)).disabled,'完整快照恢复后同一未查项目才可检查');assert.deepEqual(await facts(missingId),missingBefore);
    checks.push('PRD9.13-4：在真实读取响应边界移除inspection模拟不完整快照，卡片明确重读且拒绝通过；真实重读恢复完整内容，检查事实不变。');
  }else{
  const recordPath='/api/projects/'+ids.success;
  const recordSave=async(scope,changes,target)=>{
    const detail=await a.api(recordPath);
    return a.api(recordPath,'PATCH',{scope,expectedVersion:detail.project.version,idempotencyKey:randomUUID(),changes,...(target?{target}:{})});
  };
  const nodeA=randomUUID(),nodeB=randomUUID(),customerNode=randomUUID();
  const nodeSaved=await recordSave('projectNodes',{nodeOps:[
    {op:'add',tempId:nodeA,kind:'project',fields:{title:'检查已完节点',stage:'S1',output:'完整成果甲',targetDate:'2030-10-01'}},
    {op:'add',tempId:nodeB,kind:'project',fields:{title:'检查待完节点',stage:'S1',output:'完整成果乙',targetDate:null}}
  ]});
  await recordSave('projectNodes',{nodeOps:[{op:'complete',id:nodeSaved.result.nodeIdMap[nodeA],completedOn:'2020-01-01'}]});
  await recordSave('customerNode',{nodeOps:[{op:'add',tempId:customerNode,kind:'customer',fields:{title:'检查客户交付',note:'完整客户备注',targetDate:'2030-11-01'}}]},customerNode);
  for(const resolved of [false,true]){
    const tempId=randomUUID();const saved=await recordSave('risk',{riskOps:[{op:'add',tempId,content:resolved?'检查已解除风险':'检查预警风险',level:'high'}]},tempId);
    if(resolved)await recordSave('risk',{riskOps:[{op:'resolve',id:saved.result.riskIdMap[tempId],resolution:'已验证解除'}]},saved.result.riskIdMap[tempId]);
  }
  for(const decision of ['accept','reject']){
    const tempId=randomUUID();await recordSave('change',{changeOps:[{op:'add',tempId,source:'客户',content:'检查需求'+decision,decision,reason:'人工决定依据'}]},tempId);
  }
  const listPath = '/api/projects?view=proposal&search=' + prefix;
  const entry = '/project-checks.html?view=proposal&search=' + prefix + '&layout=dashboard';
  const panel = await page(a, entry); await waitFor(() => settled(panel), '初次检查页面就绪');
  assert.equal(panel.requests.some(item=>item.path.startsWith('/api/settings/check-rule')),false,'检查页不再读取或初始化截止规则');
  assert.equal(panel.w.document.querySelectorAll('#check-list article').length, 5);
  assert.equal(panel.$('#check-list input,#check-list textarea,#check-list select'), null, '检查页最新说明只读');
  const inspected=panel.$(card(ids.success));
  for(const [section,summary,rows] of [['项目阶段','需求立项 · 待开始',7],['项目节点','1 项未完成',2],['客户节点','1 项未完成',1],['风险','1 项预警中',2],['需求变更','1 项已接受，1 项已拒绝',2]]){
    const region=inspected.querySelector(`[data-inspection="${section}"]`);
    assert.equal(region.open,false);assert(region.querySelector('summary').textContent.includes(summary));
    region.open=true;assert.equal(region.querySelectorAll('tbody tr').length,rows);
  }
  for(const text of ['完整成果甲','完整成果乙','完整客户备注','检查预警风险','已验证解除','检查需求accept','检查需求reject'])assert(inspected.textContent.includes(text));
  const originalRecords=(await a.api(recordPath));
  assert.equal(new URL(panel.w.location.href).searchParams.has('layout'), false);
  assert.equal(new URL(panel.w.location.href).searchParams.get('checkToday'), 'unchecked');
  assert.match(panel.$('#check-scope').textContent, /提案 \/ 暂缓/);
  assert.equal(panel.$('[data-check-today="checked"]').textContent, '今日已检查', '不展示含日过滤的另一范围错误0计数');
  const nextDay = Date.parse(lists(panel).at(-1).data.businessDate + 'T12:00:00+08:00') + 86400000;
  const sameDayRequests = panel.requests.length;panel.dayTick();
  assert.equal(panel.requests.length,sameDayRequests,'同一天的定时检查不额外刷新');
  const focusReads=lists(panel).length;panel.w.dispatchEvent(new panel.w.Event('focus'));
  await waitFor(()=>settled(panel) && lists(panel).length>focusReads,'回到检查页重新读取当前项目与检查事实');
  assert.equal(new URL(lists(panel).at(-1).path,origin).searchParams.get('search'),prefix);
  for (const trigger of [() => panel.w.dispatchEvent(new panel.w.Event('focus')), () => panel.dayTick()]) {
    panel.now = nextDay; const beforeDayReads = lists(panel).length; trigger();
    await waitFor(() => settled(panel) && lists(panel).length > beforeDayReads, '客户端日期变化后实际新GET');
    assert.equal(new URL(lists(panel).at(-1).path, origin).searchParams.get('search'), prefix);
    assert.equal(panel.w.document.querySelectorAll('#check-list article').length, 5); panel.now = undefined;
  }
  const version = panel.$(card(ids.success)).dataset.projectVersion, beforeReads = lists(panel).length;
  panel.click(pass(ids.success));
  await waitFor(() => settled(panel) && lists(panel).length > beforeReads && !panel.$(card(ids.success)), '通过检查后新GET移出待查列表');
  const success = await facts(ids.success);
  assert.equal(success.records.length, 1); assert.equal(success.audit.length, 1); assert.equal(success.receipts.length, 1);
  assert.equal(success.records[0].actorId, users[0].id); assert.equal(success.records[0].observedVersion, version);
  assert.equal(success.records[0].resultVersion, success.project.version); assert.equal(success.records[0].conclusion, 'checked'); assert.equal(success.records[0].note, '');
  assert.equal(success.records[0].week_start,null);assert.equal(success.records[0].rule_version,null,'新检查不伪造旧规则来源');
  const savedCommand=panel.requests.find(item=>item.path===recordPath+'/actions').body;
  assert(!Object.hasOwn(savedCommand,'ruleVersion'));assert(!Object.hasOwn(savedCommand,'previewWeek'));assert.equal(panel.requests.some(item=>item.path.endsWith('/preview')),false);
  assert.equal(success.audit[0].entityId, success.records[0].id);
  const checkedRecords=await a.api(recordPath);
  for(const key of ['stages','nodes','risks','changes'])assert.deepEqual(checkedRecords[key],originalRecords[key],'通过检查不修改'+key);
  checks.push('PRD9.13完整卡：折叠即读当前阶段、未完节点、预警风险和决定数量；展开完整首末记录且只读，有风险/未完节点仍可人工通过，实际新GET确认不改业务记录');
  const freshList = await a.api(listPath); assert(freshList.items.find(item => item.id === ids.success).checkedToday);
  assert.equal((await a.api(listPath + '&checkToday=unchecked')).pagination.total, 4);
  assert.equal((await a.api('/api/projects/' + ids.success + '/checks')).items[0].id, success.records[0].id);
  panel.click('[data-check-today="checked"]'); await waitFor(() => settled(panel) && panel.$(card(ids.success)), '切到今日已检查');
  assert(panel.$(pass(ids.success)).disabled); assert.equal(panel.w.document.querySelectorAll('#check-list article').length, 1);
  const savedHistory = panel.$(card(ids.success) + ' [data-check-history]'); savedHistory.open = true;
  await waitFor(() => savedHistory.dataset.loaded === 'true', '已查卡历史实际读取');
  assert.match(savedHistory.querySelector('.inspection-audits').textContent, /检查结论：已核对/);
  assert.doesNotMatch(savedHistory.querySelector('.inspection-audits').textContent, /actorName|检查结论：checked/);
  panel.click('[data-check-today="unchecked"]'); await waitFor(() => settled(panel) && panel.$(card(ids.correct)), '返回未检查范围');
  checks.push('客户端聚焦及跨日可见60秒回调触发真实新GET且保持范围，同日定时器不重复刷新；真实页面通过检查→原actions事务→独立连接SQL检查事实/审计/回执→新GET待查消失、首页当日标记、已查页与检查历史一致');

  const correctionLink = panel.$(`[data-correct-project="${ids.correct}"]`);
  const stageSection = panel.$(card(ids.correct) + ' [data-inspection="项目阶段"]'); stageSection.open = true;
  panel.failHistory = true;
  const historySection = panel.$(card(ids.correct) + ' [data-check-history]'); historySection.open = true;
  await waitFor(() => historySection.textContent.includes('历史读取失败'), '历史失败在原卡提供重试');
  assert.match(panel.$(card(ids.correct)).textContent, /资料已核对/); assert(!panel.$(pass(ids.correct)).disabled, '历史失败不阻止当前信息检查');
  panel.failHistory = false; historySection.querySelector('button').click();
  await waitFor(() => historySection.dataset.loaded === 'true', '历史重试成功');
  correctionLink.addEventListener('click', event => event.preventDefault()); correctionLink.click();
  const target = new URL(correctionLink.href), returnTo = target.searchParams.get('returnTo');
  assert.equal(target.origin, origin); assert.equal(target.pathname, '/project-detail.html');
  assert.equal(returnTo, panel.w.location.pathname + panel.w.location.search);
  assert.equal(JSON.parse(panel.w.sessionStorage.getItem('geekdash_checks_return:' + users[0].id)).url, panel.w.location.href);
  const detail = await page(a, target.pathname + target.search);
  assert.equal(detail.$('#back').href, origin + returnTo); assert.match(detail.$('#back').textContent, /返回项目检查/);
  detail.input('#edit-statusDesc', '直接修正最新说明，尚未通过检查');
  detail.click('#back'); await waitFor(() => detail.$('[data-choice="cancel"]'), '返回仍保留原未保存保护');
  detail.click('[data-choice="cancel"]'); assert.equal(detail.$('#edit-statusDesc').value, '直接修正最新说明，尚未通过检查');
  detail.click('[data-save-scope="status"]'); await waitFor(() => !detail.$('#reload').disabled && detail.reads.some(item => item.data.project?.statusDesc === '直接修正最新说明，尚未通过检查'), '详情修正保存后的新GET');
  const corrected = await facts(ids.correct); assert.equal(corrected.project.status_description, '直接修正最新说明，尚未通过检查'); assert.equal(corrected.records.length, 0);
  const returned = await page(a, returnTo, { storage: Object.fromEntries(Object.entries(panel.w.sessionStorage)) });
  assert.match(returned.$(card(ids.correct)).textContent, /直接修正最新说明/); assert(!returned.$(pass(ids.correct)).disabled);
  assert(returned.$(card(ids.correct) + ' [data-inspection="项目阶段"]').open, '返回保留原项目阶段展开');
  assert(returned.$(card(ids.correct) + ' [data-check-history]').open, '返回历史展开后重新读取');
  const unsafe = await page(a, '/project-detail.html?id=' + ids.correct + '&returnTo=' + encodeURIComponent('https://invalid.example/project-checks.html'));
  assert.equal(new URL(unsafe.$('#back').href).origin, origin); assert.notEqual(new URL(unsafe.$('#back').href).pathname, '/project-checks.html');
  checks.push('进入修正保留同站检查范围/位置；真实详情输入→返回取消仍保留→正式保存→新GET/独立SQL；修正不自动检查，外站returnTo被拒绝');

  const conflictBefore = await facts(ids.conflict), staleVersion = returned.$(card(ids.conflict)).dataset.projectVersion;
  await a.api('/api/projects/' + ids.conflict, 'PATCH', { scope: 'status', expectedVersion: staleVersion, idempotencyKey: randomUUID(), changes: { statusDesc: '另一个页面已更新，需要重新核对' } });
  returned.click(pass(ids.conflict));
  await waitFor(() => settled(returned) && /他人更新/.test(returned.$('#message').textContent), '旧展示版本409');
  assert(returned.requests.some(item => item.path === '/api/projects/' + ids.conflict + '/actions' && item.status === 409 && item.body.expectedVersion === staleVersion));
  returned.click('#notice-close'); assert(returned.$('#project-notice').hidden); assert(returned.$(pass(ids.conflict)).disabled);
  assert.deepEqual((await facts(ids.conflict)).records, conflictBefore.records);
  returned.click('#check-reload'); await waitFor(() => settled(returned) && !returned.$(pass(ids.conflict)).disabled && returned.$(card(ids.conflict)).dataset.projectVersion !== staleVersion, '刷新后才可检查最新版');
  assert.match(returned.$(card(ids.conflict)).textContent, /另一个页面已更新/);
  returned.click(pass(ids.conflict)); await waitFor(() => settled(returned) && !returned.$(card(ids.conflict)), '重新核对后明确通过');
  assert.equal((await facts(ids.conflict)).records.length, 1);
  checks.push('并发真实普通保存使原卡片版本过期；旧版本409无检查写入，关闭提示仍冻结；主动刷新读取新说明后明确通过');

  returned.dropAck = true; returned.click(pass(ids.lost));
  await waitFor(() => settled(returned) && returned.$('[data-confirm-check="' + ids.lost + '"]'), '真实提交后丢响应进入恢复');
  assert(returned.$(pass(ids.lost)).disabled);
  const pendingKey = `geekdash_check:${users[0].id}:${ids.lost}`;
  const original = JSON.parse(returned.w.sessionStorage.getItem(pendingKey));
  const committed = await facts(ids.lost); assert.equal(committed.records.length, 1); assert.deepEqual(committed.receipts, [original.command.idempotencyKey]);
  returned.now = nextDay;const pendingReads=lists(returned).length,pendingWrites=returned.requests.filter(item=>item.path.endsWith('/actions') || item.path.endsWith('/action-results/query')).length;
  returned.w.dispatchEvent(new returned.w.Event('focus')); returned.dayTick();
  await waitFor(()=>settled(returned) && lists(returned).length>pendingReads,'待确认时聚焦只重读正式列表');
  assert.equal(returned.requests.filter(item=>item.path.endsWith('/actions') || item.path.endsWith('/action-results/query')).length,pendingWrites,'自动刷新不得重放待确认检查');
  assert.deepEqual(JSON.parse(returned.w.sessionStorage.getItem(pendingKey)),original);assert(returned.$('[data-confirm-check="'+ids.lost+'"]'));assert(!returned.$(pass(ids.lost)) || returned.$(pass(ids.lost)).disabled);returned.now=undefined;
  returned.dropAck = true; returned.click('[data-retry-check="' + ids.lost + '"]');
  await waitFor(() => settled(returned) && returned.requests.filter(item => item.path === '/api/projects/' + ids.lost + '/actions').length === 2, '重试原命令仍可恢复');
  assert.deepEqual(returned.requests.filter(item => item.path === '/api/projects/' + ids.lost + '/actions').map(item => item.body.idempotencyKey), [original.command.idempotencyKey, original.command.idempotencyKey]);
  assert.deepEqual(await facts(ids.lost), committed, '重试原命令不增加事实/审计/回执');
  await a.api('/api/auth/logout', 'POST', {});
  returned.click('[data-confirm-check="' + ids.lost + '"]');
  await waitFor(() => settled(returned) && !returned.$('#login').hidden && returned.requests.some(item => item.path.endsWith('/action-results/query') && item.status === 401), '原回执确认遇到真实会话失效');
  assert.deepEqual(JSON.parse(returned.w.sessionStorage.getItem(pendingKey)), original, '确认401不能证明原操作未提交，必须保留原请求');
  assert(returned.$('[data-confirm-check="' + ids.lost + '"]').disabled);
  assert.deepEqual(await facts(ids.lost), committed);
  await a.login(0);
  const stored = Object.fromEntries(Object.entries(returned.w.sessionStorage));
  const recovered = await page(a, returnTo, { storage: stored, holdConfirm: true });
  await waitFor(() => recovered.releaseConfirm, '刷新后自动查询原回执');
  assert.equal(recovered.requests.filter(item => item.path.endsWith('/actions')).length, 0);
  const confirm = recovered.requests.find(item => item.path.endsWith('/action-results/query')); assert.deepEqual(confirm.body, original.command);
  recovered.releaseConfirm(); await waitFor(() => settled(recovered) && recovered.$('#check-recovery').hidden && !recovered.w.sessionStorage.getItem(pendingKey), '原回执确认后清理恢复信息并新GET');
  assert.deepEqual(await facts(ids.lost), committed); assert.equal((await a.api('/api/projects/' + ids.lost + '/checks')).items[0].id, committed.records[0].id);
  const other = await page(b, returnTo, { storage: stored }); await waitFor(() => settled(other), '不同账号恢复隔离');
  assert.equal(other.requests.filter(item => item.path.endsWith('/action-results/query') || item.path.endsWith('/actions')).length, 0);
  assert(other.w.sessionStorage.getItem(pendingKey), '另一账号不消费原账号恢复信息');
  checks.push('真实COMMIT后丢响应：普通按钮冻结、原命令按账号项目暂存；显式重试及刷新确认均使用同一key，不重复检查/审计；确认遇到真实会话失效401仍保留原请求，重新登录同账号恢复；不同账号不重放或删除原账号请求');

  const deniedBefore = await facts(ids.denied), deniedButton = recovered.$(pass(ids.denied));
  assert(deniedButton.disabled); assert.match(recovered.$(card(ids.denied)).textContent, /仅项目负责人/);
  const requestsBefore = recovered.requests.length; deniedButton.click(); assert.equal(recovered.requests.length, requestsBefore, '禁用按钮不发请求');
  const denied = await a.api('/api/projects/' + ids.denied + '/actions', 'POST', { action: 'saveCheck', expectedVersion: deniedBefore.project.version, idempotencyKey: randomUUID(), conclusion: 'checked', note: '' }, 403);
  assert.equal(denied.code, 'PROJECT_READ_ONLY'); assert.deepEqual(await facts(ids.denied), deniedBefore);
  assert.equal(errors.length, 0);
  checks.push('无负责关系仍可读完整卡片但按钮禁用且不发请求；直接HTTP越权403，独立SQL事实/审计/版本保持');

  recovered.failNextList = true; recovered.click(pass(ids.correct));
  await waitFor(() => settled(recovered) && /检查已保存，但列表读取失败/.test(recovered.$('#message').textContent), '已提交但列表失败明确反馈');
  const confirmed = await facts(ids.correct); assert.equal(confirmed.records.length, 1);
  assert(recovered.$(pass(ids.correct)).disabled); assert.equal(recovered.w.sessionStorage.getItem(`geekdash_check:${users[0].id}:${ids.correct}`), null);
  const submits = recovered.requests.filter(item => item.path.endsWith('/actions')).length;
  recovered.click('#check-reload'); await waitFor(() => settled(recovered) && !recovered.$(card(ids.correct)), '仅重读恢复待查列表');
  assert.equal(recovered.requests.filter(item => item.path.endsWith('/actions')).length, submits);
  assert.deepEqual(await facts(ids.correct), confirmed);
  checks.push('PRD9.13：历史读取失败就地重试不阻止当前信息核对；修正返回恢复阶段/历史展开并新读；检查已提交但列表失败明确告知，禁用旧卡且仅重读恢复，无重复事实');

  const detailProjects={};
  for(const name of ['direct','conflict','lost','refresh']){
    const made=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'_详情_'+name,dueDate:'2030-12-31'}});
    const id=made.result.projectId;projects.push(id);detailProjects[name]=id;
    await a.api('/api/projects/'+id,'PATCH',{scope:'status',expectedVersion:made.result.savedVersion,idempotencyKey:randomUUID(),changes:{statusDesc:'人工进展原文\n等待客户确认；不由系统拼接。'}});
  }
  const directId=detailProjects.direct,directPath='/api/projects/'+directId,checkButton='[data-check="saveCheck"]';
  let directBefore=await a.api(directPath);
  const directRisk=randomUUID();await a.api(directPath,'PATCH',{scope:'risk',target:directRisk,expectedVersion:directBefore.project.version,idempotencyKey:randomUUID(),changes:{riskOps:[{op:'add',tempId:directRisk,content:'人工检查时保留的已有风险',level:'mid'}]}});
  directBefore=await a.api(directPath);
  const direct=await page(a,'/project-detail.html?id='+directId,{realtime:true}),watcher=await page(b,'/project-detail.html?id='+directId,{realtime:true});
  assert.equal(directBefore.project.checkedToday,false);assert.equal(direct.$('.project-title-row #d-title').textContent,directBefore.project.name);assert.equal(direct.$('.project-title-row #project-context '+checkButton).textContent,'检查');
  assert.equal(watcher.$(checkButton),null,'非负责人没有可执行检查入口');assert.equal(watcher.$('#edit-name'),null,'非负责人仍只读');
  const businessFacts=async()=>{const {connection}=await connectDatabase('test_app');try{const row=(await connection.query('SELECT * FROM projects WHERE id=?',[directId]))[0][0];const {version,updated_at,...business}=row;return business;}finally{await connection.end();}};
  const directBusiness=await businessFacts();direct.input('#edit-name','尚未保存的基本资料');direct.input('#edit-statusDesc','尚未保存的人工说明');
  direct.click(checkButton);
  await waitFor(()=>direct.reads.some(item=>item.path===directPath && item.data.project.checkedToday) && !direct.$('#reload').disabled,'标题一键检查后新读当日状态');
  const directRequest=direct.requests.find(item=>item.path===directPath+'/actions'),directFacts=await facts(directId),directAfter=await a.api(directPath);
  assert.equal(directRequest.body.action,'saveCheck');assert.equal(directRequest.body.conclusion,'checked');assert.equal(directRequest.body.note,'');assert.equal(directRequest.body.expectedVersion,directBefore.project.version);
  assert(!Object.hasOwn(directRequest.body,'ruleVersion'));assert(!Object.hasOwn(directRequest.body,'previewWeek'));assert.equal(direct.requests.some(item=>item.path.startsWith('/api/settings/check-rule')),false);assert.equal(directAfter.project.checkStatus.updatedAfterCheck,false);
  assert.equal(direct.requests.filter(item=>item.path===directPath+'/actions').length,1);assert.equal(direct.requests.some(item=>item.path.endsWith('/preview')),false,'普通检查不增加预览步骤');assert.equal(direct.$('#check-edit'),null);assert.equal(direct.$('dialog[open]'),null);assert.equal(direct.$(checkButton),null,'已检查后隐藏检查入口');
  assert.equal(direct.$('#edit-name').value,'尚未保存的基本资料');assert.equal(direct.$('#edit-statusDesc').value,'尚未保存的人工说明');assert.deepEqual(await businessFacts(),directBusiness,'检查不夹带未保存输入或改写业务信息');
  for(const key of ['stages','nodes','risks','changes'])assert.deepEqual(directAfter[key],directBefore[key]);
  assert.equal(directFacts.records.length,1);assert.equal(directFacts.audit.length,1);assert.deepEqual(directFacts.receipts,[directRequest.body.idempotencyKey]);assert.equal(directFacts.records[0].conclusion,'checked');assert.equal(directFacts.records[0].note,'');assert.equal(directFacts.records[0].actorId,users[0].id);assert.equal(directFacts.records[0].observedVersion,directBefore.project.version);assert.equal(directFacts.records[0].resultVersion,directAfter.project.version);
  await waitFor(()=>watcher.events.some(item=>item.event==='project' && item.data.operationId===directRequest.body.idempotencyKey),'另一账号收到检查提交真实SSE');
  const checkEvent=watcher.events.find(item=>item.event==='project' && item.data.operationId===directRequest.body.idempotencyKey).data;
  assert.deepEqual(checkEvent,{projectId:directId,version:directAfter.project.version,operationId:directRequest.body.idempotencyKey});assert.equal((await b.api(directPath)).project.checkedToday,true);assert.equal((await a.api(directPath+'/checks')).items[0].id,directFacts.records[0].id);
  direct.input('#edit-statusDesc','人工保存的最终进展\n保留原样，不追加系统状态。');direct.click('[data-save-scope="status"]');
  await waitFor(()=>direct.reads.some(item=>item.path===directPath && item.data.project.statusDesc==='人工保存的最终进展\n保留原样，不追加系统状态。') && !direct.$('#reload').disabled,'检查后人工说明独立保存');
  assert.equal(direct.$('#edit-name').value,'尚未保存的基本资料');assert.equal(direct.$('#edit-statusDesc').value,'人工保存的最终进展\n保留原样，不追加系统状态。');assert.equal((await facts(directId)).project.status_description,'人工保存的最终进展\n保留原样，不追加系统状态。');assert.equal((await facts(directId)).records.length,1);
  const updatedAfterCheck=await a.api(directPath);assert.equal(updatedAfterCheck.project.checkStatus.updatedAfterCheck,true);assert.equal(updatedAfterCheck.project.checkStatus.latest.id,directFacts.records[0].id);assert.equal(updatedAfterCheck.project.checkedToday,true);
  const reopened=await page(a,'/project-detail.html?id='+directId);assert.equal(reopened.$('#edit-statusDesc').value,'人工保存的最终进展\n保留原样，不追加系统状态。');assert.equal(reopened.$(checkButton).textContent,'检查更新');
  const beforeRecheck=await facts(directId);reopened.click(checkButton);
  await waitFor(()=>reopened.reads.some(item=>item.path===directPath && item.data.project.version!==updatedAfterCheck.project.version && !item.data.project.checkStatus.updatedAfterCheck) && !reopened.$('#reload').disabled,'人工检查更新后新读确认');
  const afterRecheck=await facts(directId);assert.equal(afterRecheck.records.length,2);assert.deepEqual(afterRecheck.records[0],beforeRecheck.records[0]);assert.equal(afterRecheck.project.status_description,beforeRecheck.project.status_description);assert.equal(reopened.$(checkButton),null);assert.equal(reopened.requests.filter(item=>item.path===directPath+'/actions').length,1);assert.equal(reopened.requests.some(item=>item.path.endsWith('/preview')),false);
  checks.push('详情一键检查：标题同排入口、无表单/预览，一次明确提交；未保存基本信息和说明保持，正式业务字段/阶段/风险不变，SQL检查事实/审计/回执与新GET及真实SSE一致；随后人工说明保存及重入原文保持，检查更新追加事实并保留原记录，不改业务正文');

  const staleDetailId=detailProjects.conflict,staleDetailPath='/api/projects/'+staleDetailId,staleDetail=await page(a,'/project-detail.html?id='+staleDetailId),staleDetailBefore=await a.api(staleDetailPath);
  staleDetail.input('#edit-name','过期版本的基本区输入');staleDetail.input('#edit-statusDesc','过期版本的人工说明');
  await a.api(staleDetailPath,'PATCH',{scope:'status',expectedVersion:staleDetailBefore.project.version,idempotencyKey:randomUUID(),changes:{statusDesc:'另一次真实保存后的说明'}});
  staleDetail.click(checkButton);await waitFor(()=>staleDetail.requests.some(item=>item.path===staleDetailPath+'/actions' && item.status===409) && /他人更新/.test(staleDetail.$('#message').textContent),'详情检查旧版本明确拒绝');
  assert.equal((await facts(staleDetailId)).records.length,0);assert.equal(staleDetail.$('#edit-name').value,'过期版本的基本区输入');assert.equal(staleDetail.$('#edit-statusDesc').value,'过期版本的人工说明');assert(staleDetail.$(checkButton).disabled);
  checks.push('详情检查权限与冲突：非负责人只读无检查按钮；真实并发更新后旧版本409不写检查，原输入保留且旧入口禁用');

  const lostDetailId=detailProjects.lost,lostDetailPath='/api/projects/'+lostDetailId,lostDetail=await page(a,'/project-detail.html?id='+lostDetailId);
  lostDetail.input('#edit-name','丢响应时的基本区输入');lostDetail.input('#edit-statusDesc','丢响应时的人工说明');lostDetail.dropAck=true;lostDetail.click(checkButton);
  await waitFor(()=>lostDetail.$('#stage-confirm') && !lostDetail.$('#stage-confirm').disabled,'详情检查丢响应保留原结果恢复入口');
  const lostDetailCommand=lostDetail.requests.find(item=>item.path===lostDetailPath+'/actions').body,lostDetailFacts=await facts(lostDetailId);
  assert.equal(lostDetailFacts.records.length,1);assert.equal(lostDetailFacts.audit.length,1);assert.deepEqual(lostDetailFacts.receipts,[lostDetailCommand.idempotencyKey]);assert(lostDetail.$(checkButton).disabled);
  const detailPendingKey=`geekdash_stage_action:${users[0].id}:${lostDetailId}`;assert.deepEqual(JSON.parse(lostDetail.w.sessionStorage.getItem(detailPendingKey)).pending,lostDetailCommand);
  lostDetail.holdDetailRead=true;lostDetail.click('#drafts');lostDetail.click('#stage-confirm');
  await waitFor(()=>lostDetail.releaseDetailRead,'原检查结果已确认，暂扣后续真实详情回读');
  assert(lostDetail.$(checkButton).disabled,'已确认提交但回读未完成期间检查按钮持续禁用');const lostWrites=lostDetail.requests.filter(item=>item.path===lostDetailPath+'/actions').length;
  lostDetail.$(checkButton).click();assert.equal(lostDetail.requests.filter(item=>item.path===lostDetailPath+'/actions').length,lostWrites,'回读期间再次点击不生成第二次检查');lostDetail.releaseDetailRead();
  await waitFor(()=>lostDetail.reads.some(item=>item.path===lostDetailPath && item.data.project.checkedToday) && !lostDetail.$('#reload').disabled,'确认原检查结果后新读并隐藏入口');
  assert.deepEqual(lostDetail.requests.find(item=>item.path===lostDetailPath+'/action-results/query').body,lostDetailCommand);assert.equal(lostDetail.requests.filter(item=>item.path===lostDetailPath+'/actions').length,1);assert.deepEqual(await facts(lostDetailId),lostDetailFacts);assert.equal(lostDetail.$(checkButton),null);assert.equal(lostDetail.w.sessionStorage.getItem(detailPendingKey),null);assert.equal(lostDetail.$('#edit-name').value,'丢响应时的基本区输入');assert.equal(lostDetail.$('#edit-statusDesc').value,'丢响应时的人工说明');
  checks.push('详情检查未知结果：真实COMMIT后丢响应仅保留原命令，普通入口冻结；可见副本入口查询同一回执，不重复检查/审计，新读后隐藏入口并保留两区未保存输入');

  const refreshDetailId=detailProjects.refresh,refreshDetailPath='/api/projects/'+refreshDetailId,refreshDetail=await page(a,'/project-detail.html?id='+refreshDetailId);
  refreshDetail.input('#edit-name','页面刷新后继续保存的名称');refreshDetail.input('#edit-statusDesc','页面刷新后保留的人工说明');refreshDetail.dropAck=true;refreshDetail.click(checkButton);
  await waitFor(()=>refreshDetail.$('#stage-confirm') && !refreshDetail.$('#stage-confirm').disabled,'刷新前检查真实提交但回应丢失');
  const refreshCommand=refreshDetail.requests.find(item=>item.path===refreshDetailPath+'/actions').body,refreshFacts=await facts(refreshDetailId),refreshStorage=Object.fromEntries(Object.entries(refreshDetail.w.sessionStorage));
  assert.equal(refreshFacts.records.length,1);refreshDetail.dom.window.close();
  const refreshRecovered=await page(a,'/project-detail.html?id='+refreshDetailId,{storage:refreshStorage,restorePrompt:true});
  assert.equal(refreshRecovered.requests.filter(item=>item.path===refreshDetailPath+'/actions').length,0,'刷新自动核对不得另提交检查');assert.deepEqual(refreshRecovered.requests.find(item=>item.path===refreshDetailPath+'/action-results/query').body,refreshCommand);
  assert.deepEqual(await facts(refreshDetailId),refreshFacts,'自动核对原回执不重复检查/审计');refreshRecovered.click('[data-choice="restore"]');
  await waitFor(()=>!refreshRecovered.$('#reload').disabled && refreshRecovered.$('#edit-name')?.value==='页面刷新后继续保存的名称','恢复两区输入后完成页面加载');
  assert.equal(refreshRecovered.$('#edit-statusDesc').value,'页面刷新后保留的人工说明');assert.equal(refreshRecovered.$(checkButton),null);assert(!refreshRecovered.$('[data-save-scope="basic"]').disabled);
  refreshRecovered.click('[data-save-scope="basic"]');await waitFor(()=>refreshRecovered.reads.some(item=>item.path===refreshDetailPath && item.data.project.name==='页面刷新后继续保存的名称') && !refreshRecovered.$('#reload').disabled,'刷新恢复后基于本人检查的新版本保存基本区');
  const refreshSave=refreshRecovered.requests.find(item=>item.path===refreshDetailPath && item.method==='PATCH');assert.equal(refreshSave.body.expectedVersion,refreshFacts.project.version);assert.equal(refreshSave.body.scope,'basic');
  const refreshAfter=await a.api(refreshDetailPath),refreshAfterFacts=await facts(refreshDetailId);
  assert.equal(refreshAfter.project.name,'页面刷新后继续保存的名称');assert.equal(refreshAfter.project.statusDesc,'人工进展原文\n等待客户确认；不由系统拼接。');assert.equal(refreshRecovered.$('#edit-statusDesc').value,'页面刷新后保留的人工说明');assert.deepEqual(refreshAfterFacts.records,refreshFacts.records);assert.deepEqual(refreshAfterFacts.audit,refreshFacts.audit);assert.deepEqual(refreshAfterFacts.receipts,refreshFacts.receipts);
  checks.push('详情检查刷新恢复：两区未保存→真实COMMIT丢响应→销毁页面并恢复同一sessionStorage→自动查询原回执→明确恢复两区输入；按本人已确认检查版本继续保存且不夹带另一区，检查事实/审计/回执仅一条；另验证回读暂扣期间不能二次检查');

  }
  const build = (await a.api('/api/health/live')).build;
  const result = { status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount, build, sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')])), isolatedTestDatabase: true, syntheticOnly: true, domExecution: true, nativeBrowserAcceptance: false, visualAcceptance: false };
  await mkdir('test-results', { recursive: true }); await writeFile(initialStatesMode?'test-results/project-checks-ui-initial-states.json':'test-results/project-checks-ui-check.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, groups: checks.length, requestCount }));
} finally {
  for (const view of views) {for(const stream of view.streams ?? [])stream.close();view.window.close();} if (app) await app.close();
  for (const user of users) for (const table of ['project_drafts', 'user_preferences']) await c.execute('DELETE FROM ' + table + ' WHERE user_id=?', [user.id]);
  for (const id of projects) {
    await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?', [id]);
    for (const table of ['project_changes', 'project_risks', 'project_nodes', 'project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities', 'project_chips', 'project_people', 'project_tags']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]);
    await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]);
  }
  for (const user of users) {
    for (const table of ['command_receipts', 'audit_log']) await c.execute('DELETE FROM ' + table + ' WHERE actor_id=?', [user.id]);
    await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]);
  }
  await c.end(); process.off('unhandledRejection', reject);
}
