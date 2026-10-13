import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

// DOM执行模型用于检查真实前端代码的状态与接口链路，不替代浏览器布局/指针验收。
const { JSDOM, CookieJar, VirtualConsole } = await import(process.env.GEEKDASH_DOM_LIBRARY ?? '../test-results/ui-dom-tools/node_modules/jsdom/lib/api.js');
const users = [], projects = [], views = [], errors = [], checks = [];
const actionsMode = process.argv.includes('--actions'); let ownConfig = false;
const prefix = 'detail_ui_' + randomUUID().slice(0, 8), password = '页面整链测试 长短语 password 2026';
const authOrigin = 'http://localhost';
const html = await readFile(process.env.GEEKDASH_DETAIL_HTML ?? 'src/web/project-detail.html', 'utf8');
const detailSource = await readFile(process.env.GEEKDASH_DETAIL_SOURCE ?? 'src/web/detail.ts', 'utf8');
const apiSource = await readFile('src/web/shared/api.ts', 'utf8');
const stageSource = (await readFile('geekdashdesktop/projects-data.js', 'utf8')).match(/const STAGES = (\[[\s\S]*?\n  \]);/);
assert(stageSource, '原版阶段常量存在');
const stages = vm.runInNewContext(stageSource[1], Object.create(null), { timeout: 1000 });
const { connection: c } = await connectDatabase('test_migrator');
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
async function page(user, projectId, holdCatalog = false) {
  const virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', reject);
  const dom = new JSDOM(html, { url: origin + '/project-detail.html?id=' + projectId, cookieJar: user.jar, runScripts: 'outside-only', virtualConsole });
  views.push(dom); const w = dom.window;
  dom.projectReads = [];
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone, AbortSignal, __GEEKDASH_STAGES__: stages });
  w.BroadcastChannel = class { postMessage() {} };
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; this.returnValue = ''; };
  w.HTMLDialogElement.prototype.close = function(value = '') { this.returnValue = value; this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.fetch = async (path, options) => {
    const response = await user.fetch(path, options);
    if (path === '/api/projects/' + projectId && !options?.method && response.ok) dom.projectReads.push(await response.clone().json());
    if (holdCatalog && path === '/api/project-options') {
      await new Promise(resolve => { dom.releaseCatalog = resolve; });
      const json = response.json.bind(response);
      response.json = async () => { const data = await json(); setTimeout(() => { dom.catalogConsumed = true; }, 0); return data; };
    }
    if (dom.dropSaveAck && options?.method === 'PATCH') { dom.dropSaveAck = false; await response.arrayBuffer(); throw new Error('模拟真实COMMIT后的确认丢失'); }
    if (dom.dropActionAck && path === '/api/projects/' + projectId + '/actions' && options?.method === 'POST') { dom.dropActionAck = false; await response.arrayBuffer(); throw new Error('模拟真实动作COMMIT后的确认丢失'); }
    return response;
  };
  const context = dom.getInternalVMContext(); context.exports = {}; context.module = { exports: context.exports };
  const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext('(function(exports,module){' + transpile(apiSource) + '\n})(exports,module)', context, { filename: 'src/web/shared/api.ts' });
  const api = context.module.exports;
  context.require = name => { if (name === './shared/api') return api; if (name.endsWith('.css')) return {}; throw new Error('未预期的前端依赖：' + name); };
  context.exports = {}; context.module = { exports: context.exports };
  vm.runInContext('(function(){' + transpile(detailSource) + '\n})()', context, { filename: 'src/web/detail.ts' });
  await waitFor(() => !w.document.getElementById('detail-panel').hidden && !w.document.getElementById('reload').disabled, '详情及可信身份就绪');
  const $ = selector => w.document.querySelector(selector);
  const input = (selector, value) => { const element = $(selector); assert(element, selector); element.value = value; element.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const click = selector => { const element = $(selector); assert(element, selector); assert(!element.disabled, selector + ' 不应禁用'); element.click(); };
  return { dom, w, $, input, click, tab: value => click(`[data-tab="${value}"]`) };
}
async function facts(id) {
  const { connection } = await connectDatabase('test_app');
  try { return { project: (await connection.query('SELECT name,summary_note,CAST(version AS CHAR) version FROM projects WHERE id=?', [id]))[0][0], nodes: (await connection.query('SELECT CAST(id AS CHAR) id,title,output FROM project_nodes WHERE project_id=? AND deleted_at IS NULL ORDER BY id', [id]))[0], auditCount: Number((await connection.query('SELECT COUNT(*) n FROM audit_log WHERE project_id=?', [id]))[0][0].n) }; }
  finally { await connection.end(); }
}
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  const hash = await hashPassword(password);
  for (let i = 0; i < (actionsMode ? 3 : 2); i++) { const loginName = prefix + '_' + i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '页面合成账号' + i]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  app = await createApp(await openRuntimeDatabase('test_app'), { origin: authOrigin, secure: false });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const a = client(), b = client(); await a.login(0); await b.login(1);
  const created = (await a.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix, summaryNote: '原项目简介' } })).result;
  const id = created.projectId, path = '/api/projects/' + id; projects.push(id);
  const owner = await page(a, id, true), initial = await facts(id);
  if (process.argv.includes('--baseline-node-mount')) { owner.tab('nodes'); assert(owner.$('#pane'), '节点编辑目标pane必须真实存在'); throw new Error('旧版断点未复现，重新核对源码来源'); }
  assert.equal(owner.w.document.querySelectorAll('[data-tab]').length, 7);
  for (const tab of ['info', 'stages', 'nodes', 'flow', 'custnodes', 'risk', 'history']) { owner.tab(tab); assert.equal(owner.w.document.querySelectorAll('#save').length, 1); }
  owner.tab('info'); owner.input('#edit-name', prefix + ' 修改'); owner.input('#edit-summaryNote', '跨页保留的普通修改');
  owner.tab('nodes'); assert.equal(owner.$('.flow-canvas'), null); assert(owner.$('#pane'));
  owner.click('[data-node="add"]'); await waitFor(() => owner.$('#node-edit'), '新增节点表单');
  owner.input('[data-node-field="title"]', '同源节点');
  await waitFor(() => owner.dom.releaseCatalog, '候选资料真实响应待释放'); owner.dom.releaseCatalog();
  await waitFor(() => owner.dom.catalogConsumed, '候选资料后台读取完成');
  assert.equal(owner.$('[data-node-field="title"]')?.value, '同源节点', '后台读取不能销毁正在填写的表单');
  owner.$('#node-edit').dispatchEvent(new owner.w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => owner.$('#node-error').textContent, '缺成果的真实拒绝');
  assert.equal(owner.$('[data-node-field="title"]').value, '同源节点'); assert.deepEqual(await facts(id), initial);
  owner.input('[data-node-field="output"]', 'BOM与样机');
  owner.$('#node-edit').dispatchEvent(new owner.w.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => !owner.$('#node-accept').disabled, '真实节点预览');
  assert.deepEqual(await facts(id), initial, '预览与普通副本不能写正式库');
  owner.click('#node-accept'); owner.tab('flow'); assert.match(owner.$('.flow-node').textContent, /同源节点/); assert.equal(owner.$('.node-list'), null);
  owner.$('.flow-node').dispatchEvent(new owner.w.KeyboardEvent('keydown', { key: 'Enter' }));
  await waitFor(() => owner.$('#node-edit'), 'Flow节点编辑'); assert(owner.$('[data-tab="flow"]').classList.contains('active'));
  owner.click('#node-cancel'); owner.tab('info'); assert.equal(owner.$('#edit-name').value, prefix + ' 修改'); assert.equal(owner.$('#edit-summaryNote').value, '跨页保留的普通修改');
  owner.tab('flow'); owner.click('#save'); await waitFor(() => owner.$('#save')?.disabled && /当前内容已保存/.test(owner.$('#edit-state').textContent) && owner.dom.projectReads.at(-1)?.project.name === prefix + ' 修改', '项目保存及新GET回读');
  const persisted = await facts(id); assert.equal(persisted.project.name, prefix + ' 修改'); assert.equal(persisted.project.summary_note, '跨页保留的普通修改'); assert.equal(persisted.nodes.length, 1); assert.equal(persisted.nodes[0].title, '同源节点');
  assert.equal(owner.$('.flow-node').dataset.nodeDrag, persisted.nodes[0].id); owner.tab('nodes'); assert.match(owner.$('.node-item').textContent, /同源节点/);
  checks.push('七页签唯一保存；真实前端普通输入与节点副本跨页同源；预览不写库，保存后独立SQL/新GET/Flow与列表一致');
  const viewer = await page(b, id); assert.equal(viewer.$('#save'), null); assert(viewer.$('#project-savebar').hidden); assert(viewer.$('#project-menu').hidden);
  viewer.tab('nodes'); assert.equal(viewer.$('[data-node="add"]'), null);
  checks.push('非负责人只读，七页签共享责任判断，无普通或节点写入口');
  const detail = await b.api(path); await b.api(path + '/responsibility', 'POST', { action: 'join', expectedVersion: detail.project.version, idempotencyKey: randomUUID() });
  owner.click('#reload'); await waitFor(() => /页面合成账号1/.test(owner.$('#responsibility').textContent) && !owner.$('#reload').disabled, '新进入读取加入责任后的版本');
  owner.tab('info'); owner.input('#edit-name', '旧副本供复制');
  const latest = await b.api(path); await b.api(path, 'PATCH', { expectedVersion: latest.project.version, idempotencyKey: randomUUID(), changes: { name: '另一人已经更新' } });
  owner.w.dispatchEvent(new owner.w.Event('focus')); await waitFor(() => owner.$('#save').disabled && /他人更新/.test(owner.$('#edit-state').textContent), '旧版本冻结');
  owner.click('#copy'); assert.match(owner.$('.copy-text').value, /旧副本供复制/); owner.click('[data-choice="cancel"]');
  owner.click('#reload'); await waitFor(() => owner.$('[data-choice="keep"]'), '重新进入前明确保留'); owner.click('[data-choice="keep"]');
  await waitFor(() => owner.$('#edit-name')?.value === '另一人已经更新' && !owner.$('#reload').disabled, '新版本回读'); owner.click('#copy'); assert.match(owner.$('.copy-text').value, /旧副本供复制/); owner.click('[data-choice="cancel"]');
  checks.push('另一负责人真实保存后旧副本冻结、可复制；明确重新进入后显示新版本，旧输入仍保留供核对');
  const recovering = await page(a, id), beforeUnknown = await facts(id); recovering.tab('info'); recovering.input('#edit-name', '真实提交后丢确认'); recovering.dom.dropSaveAck = true; recovering.click('#save');
  await waitFor(() => recovering.$('#confirm') && !recovering.$('#confirm').disabled, '原保存结果待确认'); assert.equal((await facts(id)).project.name, '真实提交后丢确认');
  recovering.click('#confirm'); await waitFor(() => recovering.$('#save')?.disabled && /当前内容已保存/.test(recovering.$('#edit-state').textContent) && recovering.dom.projectReads.at(-1)?.project.name === '真实提交后丢确认', '原编号确认及新读取');
  assert.equal((await facts(id)).auditCount, beforeUnknown.auditCount + 1); assert.equal(recovering.$('#edit-name').value, '真实提交后丢确认');
  checks.push('真实COMMIT后丢响应，页面保留原请求；确认原结果及新读取仅产生一次审计');
  if (actionsMode) {
    assert.equal(Number((await c.query('SELECT COUNT(*) n FROM system_configuration'))[0][0].n), 0, '保留其他配置，不覆盖');
    await c.execute("INSERT INTO system_configuration (id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))", [users[2].id, users[2].id]); ownConfig = true;
    const maint = client(); await maint.login(2); const rule = await maint.api('/api/settings/check-rule');
    await maint.api('/api/settings/check-rule', 'POST', { action: 'initializeCheckRule', deadlineWeekday: 5, expectedVersion: rule.configVersion, previewWeek: rule.weekStart, idempotencyKey: randomUUID() });
    const panel = await page(a, id), read = () => a.api(path), submit = selector => panel.$(selector).dispatchEvent(new panel.w.Event('submit', { bubbles: true, cancelable: true }));
    const mounted = selector => { assert(panel.$('#action-dialog').open); assert(panel.$('#action-fields').contains(panel.$(selector))); assert(panel.$('#save').disabled); };
    const done = async (predicate, label) => { await waitFor(() => !panel.$('#action-dialog').open && !panel.$('#reload').disabled && predicate(panel.dom.projectReads.at(-1)), label); return read(); };
    const preview = async (form, save) => { submit(form); await waitFor(() => !panel.$(save).disabled && !panel.$('#action-fields').disabled, form + '实际预览'); };
    panel.tab('risk'); panel.click('[data-risk="add"]'); await waitFor(() => panel.$('#risk-edit'), '风险弹窗'); mounted('#risk-edit'); panel.input('#risk-content', '取消的风险');
    panel.$('#action-dialog').dispatchEvent(new panel.w.Event('cancel', { cancelable: true })); assert.equal(panel.$('#action-dialog').open, false); assert.equal((await read()).risks.length, 0);
    panel.click('[data-risk="add"]'); await waitFor(() => panel.$('#risk-edit'), '重新录入风险'); panel.input('#risk-content', '硬件风险'); await preview('#risk-edit', '#risk-accept'); panel.input('#risk-content', '硬件风险补充'); assert(panel.$('#risk-accept').disabled); await preview('#risk-edit', '#risk-accept'); panel.click('#risk-accept');
    panel.click('[data-change="add"]'); await waitFor(() => panel.$('#change-edit'), '需求弹窗'); mounted('#change-edit'); panel.input('#chg-content', '取消的变更'); panel.click('#action-close'); assert.match(panel.$('.risk-item').textContent, /硬件风险补充/);
    panel.click('[data-change="add"]'); await waitFor(() => panel.$('#change-edit'), '重填变更'); panel.input('#chg-content', '低功耗接口'); panel.input('#chg-reason', '可复用接口，人工接受'); await preview('#change-edit', '#change-accept');
    assert.match(panel.$('#change-preview').textContent, /来源：客户/); assert.match(panel.$('#change-preview').textContent, /变更内容：低功耗接口/); assert.match(panel.$('#change-preview').textContent, /决定：接受/); assert.match(panel.$('#change-preview').textContent, /决定理由：可复用接口，人工接受/); assert(!panel.$('#action-message').textContent.includes('正在处理')); panel.click('#change-accept');
    panel.tab('custnodes'); panel.click('[data-node="add"]'); await waitFor(() => panel.$('#node-edit'), '客户节点弹窗'); mounted('#node-edit'); panel.input('[data-node-field="title"]', '客户核对'); panel.input('[data-node-field="note"]', '沟通记录'); await preview('#node-edit', '#node-accept'); assert(!panel.$('#node-preview').textContent.includes('previousNodeId')); panel.click('#node-accept');
    panel.click('#save'); await done(data => data?.risks.length === 1 && data?.changes.length === 1 && data?.nodes.some(n => n.kind === 'customer'), '三类副本统一保存及新GET');
    assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_risks WHERE project_id=?', [id]))[0][0].n), 1); assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_changes WHERE project_id=?', [id]))[0][0].n), 1);
    checks.push('风险/需求/客户节点同次普通保存；弹窗暂停主编辑，取消与ESC不入库且保留其他已确认副本；预览后改输入必须重做；人可读节点预览');
    let d = await read(); const today = d.businessDate, date = days => new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
    panel.tab('stages'); panel.click('[data-stage="S1"][data-stage-action="startStage"]'); await waitFor(() => panel.$('#stage-form'), '阶段开始弹窗'); mounted('#stage-form');
    panel.input('#stage-date', '2099-01-01'); const beforeReject = await facts(id); submit('#stage-form'); await waitFor(() => !panel.$('#action-fields').disabled && /日期/.test(panel.$('#action-message').textContent), '未来实际日拒绝'); assert.equal(panel.$('#stage-date').value, '2099-01-01'); assert.deepEqual(await facts(id), beforeReject);
    panel.input('#stage-date', today); submit('#stage-form'); await done(data => data?.stages[0].state === 'active', '开始新GET');
    panel.click('[data-stage="S1"][data-stage-action="completeStage"]'); await waitFor(() => panel.$('#stage-form'), '完成弹窗'); panel.input('#stage-note', '负责人已核对'); panel.dom.dropActionAck = true; submit('#stage-form');
    await waitFor(() => !panel.$('#action-recovery').hidden && !panel.$('#action-confirm').disabled, '动作真实COMMIT后未知'); assert(panel.$('#action-fields').disabled); const afterCommit = await facts(id); panel.click('#action-confirm');
    d = await done(data => data?.stages[0].state === 'completed', '完成原结果及新GET'); assert.equal((await facts(id)).auditCount, afterCommit.auditCount); assert.equal(d.project.status, 'proposal'); assert.equal(d.stages[1].state, 'ready');
    panel.click('#project-start'); await waitFor(() => panel.$('#start-form'), '项目启动弹窗'); panel.input('#start-date', today); panel.input('#start-due', date(10)); submit('#start-form'); d = await done(data => data?.project.status === 'ongoing', '启动新GET'); const obligation = d.project.firstCheckWeek; assert.equal(d.stages[1].state, 'ready');
    checks.push('阶段未来日期失败保留输入与库原值；开始/完成独立保存，真实动作COMMIT丢响应用原编号确认；S1完成仍提案，人工启动后S2待开始');
    panel.tab('flow'); panel.click('[data-plan="reschedulePlan"]'); await waitFor(() => panel.$('#plan-edit'), 'Flow中的计划弹窗'); mounted('#plan-edit'); assert(panel.$('[data-tab="flow"]').classList.contains('active'));
    panel.input('#plan-date', date(14)); panel.input('#plan-reason', '客户窗口调整'); await preview('#plan-edit', '#plan-save'); panel.input('#plan-date', date(15)); assert(panel.$('#plan-save').disabled); await preview('#plan-edit', '#plan-save'); panel.click('#plan-save'); d = await done(data => data?.project.dueDate === date(15), '计划新GET'); assert(panel.$('[data-tab="flow"]').classList.contains('active'));
    panel.click('[data-check="saveCheck"]'); await waitFor(() => panel.$('#check-edit'), 'Flow中的检查弹窗'); panel.input('#check-note', '按实际版本核对'); await preview('#check-edit', '#check-save'); panel.click('#check-save'); d = await done(data => data?.project.checkStatus.latest, '检查新GET'); assert(panel.$('[data-tab="flow"]').classList.contains('active'));
    panel.tab('risk'); panel.click('[data-lifecycle="pauseProject"]'); await waitFor(() => panel.$('#lifecycle-edit'), '暂缓弹窗'); panel.input('#lifecycle-reason', '等待客户'); await preview('#lifecycle-edit', '#lifecycle-save'); panel.click('#lifecycle-save'); await done(data => data?.project.status === 'paused', '暂缓新GET');
    panel.click('[data-lifecycle="resumeProject"]'); await waitFor(() => panel.$('#lifecycle-edit'), '恢复弹窗'); panel.input('#lifecycle-note', '客户已确认'); await preview('#lifecycle-edit', '#lifecycle-save'); panel.click('#lifecycle-save'); d = await done(data => data?.project.status === 'ongoing', '恢复新GET'); assert.equal(d.project.firstCheckWeek, obligation); assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_checks WHERE project_id=?', [id]))[0][0].n), 1);
    checks.push('计划/检查在原Flow上下文保存及新读取；暂缓/恢复留在风险页，首次检查义务及原检查保持，无自动检查或开工');
    const progress = d.project.progress; panel.tab('flow'); panel.click('[data-closure="closeProject"]'); await waitFor(() => panel.$('#closure-edit'), '结案弹窗');
    panel.input('#closure-closedOn', today); panel.input('#closure-closureNote', '本轮交付结束'); panel.input('#closure-remainingWorkNote', '剩余节点及风险由后续安排接续'); await preview('#closure-edit', '#closure-save'); panel.click('#closure-save'); d = await done(data => data?.project.status === 'closed', '结案新GET'); assert.equal(d.project.progress, progress);
    panel.click('[data-closure="setMaintenance"]'); await waitFor(() => panel.$('#closure-edit'), '维护弹窗'); panel.input('#closure-reason', '进入后续维护'); await preview('#closure-edit', '#closure-save'); panel.click('#closure-save'); await done(data => Number(data?.project.maintenanceEnabled) === 1, '维护新GET');
    panel.click('[data-closure="reopenProject"]'); await waitFor(() => panel.$('#closure-edit'), '重开弹窗'); panel.input('#closure-reason', '继续下一轮'); await preview('#closure-edit', '#closure-save'); panel.click('#closure-save'); d = await done(data => data?.project.status === 'ongoing', '重开新GET'); assert.equal(d.project.progress, progress); assert.equal(Number(d.project.maintenanceEnabled), 0); assert.equal(d.project.firstCheckWeek, obligation);
    panel.tab('stages'); panel.click('[data-correction="rollbackStage"][data-stage="S1"]'); await waitFor(() => panel.$('#correction-edit'), '回退弹窗'); panel.input('#correction-reason', '真实返工重新核对'); await preview('#correction-edit', '#correction-save'); panel.click('#correction-save'); d = await done(data => data?.stages[0].state === 'ready', '回退新GET'); assert.equal(d.stages[1].state, 'locked'); assert.equal(d.project.status, 'ongoing'); assert.equal(d.project.firstCheckWeek, obligation);
    checks.push('结案/维护/重开在原上下文保存，真实进度与遗留保持；回退当前有效完成阶段，后续锁定，历史/启动与检查依据保持');
    panel.tab('flow'); panel.$('.flow-node').dispatchEvent(new panel.w.KeyboardEvent('keydown', { key: 'Enter' })); await waitFor(() => panel.$('#node-edit'), 'Flow节点上下文'); assert(panel.$('[data-node-field="title"]').disabled);
    panel.click('[data-node-form-action="complete"]'); await waitFor(() => panel.$('#node-completed'), '同上下文填写完成日'); panel.input('#node-completed', today); await preview('#node-edit', '#node-accept'); panel.click('#node-accept'); panel.click('#save'); d = await done(data => data?.nodes.find(n => n.kind === 'project')?.completedOn === today, 'Flow节点完成正式新读'); assert(panel.$('[data-tab="flow"]').classList.contains('active')); assert.equal(d.stages[0].state, 'ready');
    panel.$('.flow-node').dispatchEvent(new panel.w.KeyboardEvent('keydown', { key: 'Enter' })); await waitFor(() => panel.$('#node-edit'), '节点更正弹窗'); panel.click('[data-node-select="title"]'); panel.input('[data-node-field="title"]', '旧节点输入供复制'); panel.input('#node-reason', '名称误录');
    const concurrent = await b.api(path); await b.api(path, 'PATCH', { expectedVersion: concurrent.project.version, idempotencyKey: randomUUID(), changes: { summaryNote: '另一个负责人已经核对' } });
    panel.w.dispatchEvent(new panel.w.Event('focus')); await waitFor(() => panel.$('#action-fields').disabled && /他人更新/.test(panel.$('#action-message').textContent), '弹窗旧版本冻结'); panel.click('#action-copy'); assert.match(panel.$('.copy-text').value, /旧节点输入供复制/); panel.click('[data-choice="cancel"]'); assert(panel.$('#action-dialog').open);
    panel.click('#action-close'); assert.equal(panel.$('#action-dialog').open, false); panel.click('#copy'); assert.match(panel.$('.copy-text').value, /旧节点输入供复制/); panel.click('[data-choice="cancel"]');
    checks.push('Flow节点弹窗直接进入实际完成操作，明确字段纠错后才编辑；节点完成不自动完成阶段；他人更新时弹窗冻结、可复制，关闭仍保留旧副本');
  }
  assert.equal(errors.length, 0);
  const build = (await a.api('/api/health/live')).build;
  await writeFile('test-results/' + (actionsMode ? 'context-ui-check.json' : 'detail-ui-check.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount, build, frontendSource: 'src/web/detail.ts + shared/api.ts', sourceSha256: Object.fromEntries(Object.entries({ detailSource, apiSource, html }).map(([key, source]) => [key, createHash('sha256').update(source).digest('hex')])), isolatedTestDatabase: true, syntheticOnly: true, domExecution: 'jsdom 27.0.1; CSS/BroadcastChannel/native dialog behavior not validated', nativeBrowserAcceptance: false, visualAcceptance: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount }));
} finally {
  for (const view of views) view.window.close();
  if (app) await app.close();
  for (const id of projects) { await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?', [id]); for (const table of ['project_changes', 'project_risks', 'project_nodes', 'project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); }
  if (ownConfig) { await c.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?', [users[2].id]); await c.execute('DELETE FROM check_rule_revisions WHERE saved_by=?', [users[2].id]); }
  for (const user of users) await c.execute('DELETE FROM users WHERE id=?', [user.id]);
  await c.end(); process.off('unhandledRejection', reject);
}
