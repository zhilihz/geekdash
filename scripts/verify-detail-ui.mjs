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
  context.exports = {}; context.module = { exports: context.exports };
  vm.runInContext('(function(exports,module){' + transpile(referenceSource) + '\n})(exports,module)', context, { filename: 'src/web/shared/reference-picker.ts' });
  const referencePicker = context.module.exports;
  context.require = name => { if (name === './shared/api') return api; if (name === './shared/reference-picker') return referencePicker; if (name.endsWith('.css')) return {}; throw new Error('未预期的前端依赖：' + name); };
  context.exports = {}; context.module = { exports: context.exports };
  vm.runInContext('(function(){' + transpile(detailSource) + '\n})()', context, { filename: 'src/web/detail.ts' });
  await waitFor(() => !w.document.getElementById('detail-panel').hidden && !w.document.getElementById('reload').disabled, '详情及可信身份就绪');
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
async function verifyReferences(a, b, id, path) {
  const refs = {};
  for (const [table, fields] of Object.entries({ customers: ['contact', 'background'], chips: ['original_model', 'manufacturer', 'firmware_version'], engineers: ['role'], tags: [], product_lines: [], apps: ['app_version', 'description'], project_groups: [] })) {
    refs[table] = [];
    for (const index of [0, 1]) {
      const name = prefix + '_' + table + (table === 'customers' ? '_同名' : '_' + index);
      await c.execute(`INSERT INTO ${table} (name,${fields.map(field => field + ',').join('')}enabled,created_at,updated_at) VALUES (?${fields.map(() => ',?').join('')},1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [name, ...fields.map(field => field === 'role' ? 'hardware' : '合成资料')]);
      const reference = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
      references.push({ table, id: reference }); refs[table].push(reference);
    }
  }
  const panel = await page(a, id, true), initial = await facts(id), read = () => a.api(path);
  const source = key => panel.$('#edit-' + key + '-source');
  const box = key => panel.$('#edit-' + key).closest('.reference-picker');
  const selected = key => [...source(key).selectedOptions].map(option => option.value).filter(Boolean);
  const search = (key, query) => { panel.$('#edit-' + key).focus(); panel.input('#edit-' + key, query); };
  const pick = (key, reference) => { search(key, prefix); const option = box(key).querySelector('[data-reference-value="' + reference + '"]'); assert(option && !option.disabled); option.click(); };
  const press = (key, value) => panel.$('#edit-' + key).dispatchEvent(new panel.w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const frozen = expected => { for (const element of panel.w.document.querySelectorAll('.reference-picker input,.reference-box button,select[data-reference]')) assert.equal(element.disabled, expected, element.id || element.outerHTML); };
  frozen(true); await waitFor(() => panel.dom.releaseCatalog, '资料响应等待释放'); panel.dom.releaseCatalog();
  await waitFor(() => panel.dom.catalogConsumed && !panel.$('#edit-customerId').disabled, '资料响应后控件恢复'); frozen(false);
  assert.equal(panel.$('#edit-state,#storage-warning'), null, '移除常驻保存/副本状态文字'); assert.equal(panel.$('#project-notice').getAttribute('popover'), 'manual');
  const store = panel.w.Storage.prototype.setItem;
  try {
    panel.w.Storage.prototype.setItem = function(key, value) { if (this === panel.w.sessionStorage && key.startsWith('geekdash_project_buffer:')) throw new panel.w.DOMException('合成暂存容量不足', 'QuotaExceededError'); return store.call(this, key, value); };
    panel.input('#edit-summaryNote', '暂存不可用时仍保留的输入'); await waitFor(() => !panel.$('#project-notice').hidden && /无法保留副本/.test(panel.$('#message').textContent), '暂存失败提示');
    panel.visibleClick('#notice-close'); assert(panel.$('#project-notice').hidden); assert.equal(panel.$('#edit-summaryNote').value, '暂存不可用时仍保留的输入'); assert.deepEqual(await facts(id), initial);
  } finally { panel.w.Storage.prototype.setItem = store; }
  panel.input('#edit-summaryNote', '原项目简介'); assert(panel.$('#save').disabled);
  assert.deepEqual([...panel.w.document.querySelectorAll('.project-info h2')].map(node => node.textContent), ['资料与时间', '项目分工', '最新状态与说明']);
  const dates = panel.$('.project-key-dates');
  assert.deepEqual([...dates.querySelectorAll('.read-label')].map(node => node.textContent), ['立案日期', '实际启动日期', '预计结案日期', '实际结案日期']);
  assert.match(dates.textContent, /未结案/); assert.equal(dates.querySelector('input,select'), null);
  assert(panel.$('#edit-name').compareDocumentPosition(dates) & panel.w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert(dates.compareDocumentPosition(panel.$('#edit-customerId')) & panel.w.Node.DOCUMENT_POSITION_FOLLOWING);
  panel.click('.more-project-dates summary'); assert(panel.$('.more-project-dates').open); assert(panel.$('[data-tab="info"]').classList.contains('active'));
  assert.match(panel.$('.more-project-dates').textContent, /提案日期.*原计划结案/); assert.equal(panel.$('.project-dates [data-tab]'), null);
  search('customerId', prefix + '_未匹配'); assert.equal(source('customerId').value, ''); assert(panel.$('#save').disabled);
  press('customerId', 'Escape'); assert.equal(panel.$('#edit-customerId').getAttribute('aria-expanded'), 'false'); assert.deepEqual(await facts(id), initial);
  search('customerId', prefix); const matches = [...box('customerId').querySelectorAll('[data-reference-value]')].filter(option => refs.customers.includes(option.dataset.referenceValue));
  assert.equal(matches.length, 2); assert.notEqual(matches[0].textContent, matches[1].textContent, '同名资料必须能区分稳定ID');
  pick('customerId', refs.customers[0]); assert.equal(source('customerId').value, refs.customers[0]);
  pick('customerId', refs.customers[1]); assert.equal(source('customerId').value, refs.customers[1]);
  box('customerId').querySelector('[data-reference-clear]').click(); assert.equal(source('customerId').value, '');
  pick('customerId', refs.customers[1]);
  for (const [key, table] of [['odmCustomerId', 'customers'], ['productLineId', 'product_lines'], ['groupId', 'project_groups']]) pick(key, refs[table][0]);
  search('appId', prefix + '_apps_1'); press('appId', 'ArrowDown'); press('appId', 'Enter'); assert.equal(source('appId').value, refs.apps[1]);
  for (const [key, table] of [['chipIds', 'chips'], ['tagIds', 'tags'], ['people-hardware_owner', 'engineers']]) {
    for (const reference of refs[table]) pick(key, reference);
    assert.deepEqual(selected(key), refs[table]); box(key).querySelector('[data-reference-remove="' + refs[table][0] + '"]').click(); assert.deepEqual(selected(key), [refs[table][1]]);
  }
  pick('people-pm', refs.engineers[0]); press('people-pm', 'Escape');
  panel.input('#edit-statusDesc', '资料核对完成，按最新分工推进'); panel.tab('stages'); panel.tab('info');
  assert.equal(source('customerId').value, refs.customers[1]); assert.deepEqual(selected('chipIds'), [refs.chips[1]]); assert.equal(panel.$('#edit-statusDesc').value, '资料核对完成，按最新分工推进');
  assert.deepEqual(await facts(id), initial, '搜索/重选/清空/移除及切页只改共享副本');
  panel.click('#save'); await waitFor(() => panel.$('#save').disabled && panel.dom.projectReads.at(-1)?.project.customerId === refs.customers[1] && !panel.$('#reload').disabled, '关联统一保存后的新GET');
  assert(!panel.$('#project-notice').hidden); assert.match(panel.$('#message').textContent, /项目已保存/); assert.equal(panel.$('#action-message').textContent, '');
  await waitFor(() => panel.$('#project-notice').hidden, '成功反馈自动收起'); assert.equal(panel.$('#edit-state'), null);
  let d = await read(), saved = await facts(id);
  assert.equal(saved.project.version, String(BigInt(initial.project.version) + 1n)); assert.equal(saved.auditCount, initial.auditCount + 1);
  const { connection: fresh } = await connectDatabase('test_app');
  try {
    const p = (await fresh.query('SELECT CAST(customer_id AS CHAR) customer,CAST(odm_customer_id AS CHAR) odm,CAST(product_line_id AS CHAR) product,CAST(app_id AS CHAR) app,CAST(group_id AS CHAR) projectGroup,status_description description FROM projects WHERE id=?', [id]))[0][0];
    assert.deepEqual(p, { customer: refs.customers[1], odm: refs.customers[0], product: refs.product_lines[0], app: refs.apps[1], projectGroup: refs.project_groups[0], description: '资料核对完成，按最新分工推进' });
    for (const [table, column, wanted] of [['project_chips', 'chip_id', refs.chips[1]], ['project_tags', 'tag_id', refs.tags[1]]]) assert.deepEqual((await fresh.query(`SELECT CAST(${column} AS CHAR) id FROM ${table} WHERE project_id=?`, [id]))[0], [{ id: wanted }]);
    assert.deepEqual((await fresh.query('SELECT CAST(engineer_id AS CHAR) id,role FROM project_people WHERE project_id=? ORDER BY role', [id]))[0], [{ id: refs.engineers[1], role: 'hardware_owner' }, { id: refs.engineers[0], role: 'pm' }]);
  } finally { await fresh.end(); }
  assert.equal(d.project.customerId, refs.customers[1]); assert.deepEqual(d.project.chips.map(item => item.id), [refs.chips[1]]);
  const history = await a.api(path + '/audit'); assert.equal(history.items[0].afterValues.customerId.id, refs.customers[1]); assert.equal(history.items[0].afterValues.chipIds[0].id, refs.chips[1]);
  assert.match(panel.$('#edit-customerId').value, /同名/); assert.match(box('chipIds').textContent, /chips_1/);
  panel.tab('history'); await waitFor(() => panel.$('.audit-entry'), '关联变更消费到历史'); assert.match(panel.$('.audit-entry').textContent, /同名/); assert.match(panel.$('.audit-entry').textContent, /chips_1/); panel.tab('info');
  search('customerId', '只搜索而不修改'); press('customerId', 'Escape'); assert(panel.$('#save').disabled); assert.equal(source('customerId').value, refs.customers[1]);
  box('customerId').querySelector('[data-reference-clear]').click(); box('chipIds').querySelector('[data-reference-remove="' + refs.chips[1] + '"]').click();
  panel.click('#save'); await waitFor(() => panel.$('#save').disabled && panel.dom.projectReads.at(-1)?.project.customerId === null && !panel.$('#reload').disabled, '明确清空保存后新GET');
  d = await read(); assert.equal(d.project.customerId, null); assert.deepEqual(d.project.chips, []);
  assert.equal((await c.query('SELECT customer_id FROM projects WHERE id=?', [id]))[0][0].customer_id, null); assert.equal((await c.query('SELECT chip_id FROM project_chips WHERE project_id=?', [id]))[0].length, 0);
  pick('customerId', refs.customers[1]); pick('chipIds', refs.chips[1]); press('chipIds', 'Escape'); panel.click('#save');
  await waitFor(() => panel.$('#save').disabled && panel.dom.projectReads.at(-1)?.project.customerId === refs.customers[1] && !panel.$('#reload').disabled, '清空后可重新选择保存');
  d = await read(); saved = await facts(id); assert.deepEqual(d.project.chips.map(item => item.id), [refs.chips[1]]);
  checks.push('单框搜索/下拉/清空与多选逐个移除；同名稳定ID、键盘选择、切页副本一致；一次保存增加一个版本/审计，独立SQL、新GET及历史消费正式关联');
  panel.click('.date-actions [data-plan="correctProjectDates"]'); await waitFor(() => panel.$('#plan-edit'), '关键日期就近打开明确纠错'); frozen(true);
  assert(panel.$('[data-tab="info"]').classList.contains('active')); panel.click('[data-plan-select="filingDate"]'); panel.input('[data-plan-date="filingDate"]', d.businessDate); panel.input('#plan-reason', '立案日期核对');
  panel.click('#plan-cancel'); assert.equal(panel.$('#action-dialog').open, false); assert.equal(panel.$('#draft-dialog').open, false);
  assert.equal(panel.$('#detail-body #plan-restore'), null); assert(!panel.$('#detail-body').textContent.includes('本标签页保留')); assert(panel.$('#draft-actions #plan-restore'));
  panel.visibleClick('#notice-drafts'); assert(panel.$('#draft-dialog').open); assert(panel.$('#project-notice').hidden);
  panel.visibleClick('#draft-later'); assert.equal(panel.$('#draft-dialog').open, false); assert.deepEqual(await facts(id), saved, '关闭副本弹窗不保存也不丢输入');
  panel.tab('stages'); panel.visibleClick('#drafts'); assert(panel.$('#draft-dialog').open); panel.visibleClick('#plan-restore');
  await waitFor(() => panel.$('#plan-edit'), '跨页从可见副本入口恢复日期表单'); assert.equal(panel.$('#draft-dialog').open, false); assert(panel.$('#action-dialog').open);
  assert.equal(panel.$('[data-plan-date="filingDate"]').value, d.businessDate); assert(panel.$('[data-plan-select="filingDate"]').checked); assert.equal(panel.$('#plan-reason').value, '立案日期核对');
  panel.$('#plan-edit').dispatchEvent(new panel.w.Event('submit', { bubbles: true, cancelable: true })); await waitFor(() => !panel.$('#plan-save').disabled, '日期纠错真实预览');
  assert.deepEqual(await facts(id), saved, '日期预览未提交'); panel.click('#plan-save'); await waitFor(() => !panel.$('#action-dialog').open && panel.dom.projectReads.at(-1)?.project.filingDate === d.businessDate && !panel.$('#reload').disabled, '日期明确保存后新GET'); frozen(false);
  panel.tab('info');
  d = await read(); assert.equal(d.project.filingDate, d.businessDate); assert.match(panel.$('.project-key-dates').textContent, new RegExp(d.businessDate));
  assert.equal((await c.query('SELECT CAST(filed_on AS CHAR) day FROM projects WHERE id=?', [id]))[0][0].day, d.businessDate);
  assert.equal((await a.api(path + '/audit')).items[0].action, 'project.plan.correctProjectDates');
  const viewer = await page(b, id); assert.equal(viewer.$('[role="combobox"]'), null); assert.equal(viewer.$('#save'), null); assert.equal(viewer.$('.date-actions button'), null); assert.match(viewer.$('.project-info').textContent, /同名/);
  checks.push('资料/关键日期/分工/最新说明层级一致；更多日期原位展开；纠错在当前页预览并明确保存后日期新读；非负责人纯文本只读');
  checks.push('成功反馈自动收起且无常驻已保存文字；暂存失败关闭提示仍保留输入；日期副本从可见提示打开，暂不处理后跨页恢复原输入，明确保存后SQL/新GET及历史一致');
  await b.api(path + '/responsibility', 'POST', { action: 'join', expectedVersion: d.project.version, idempotencyKey: randomUUID() });
  panel.click('#reload'); await waitFor(() => /页面合成账号1/.test(panel.$('#responsibility').textContent) && !panel.$('#reload').disabled, '加入责任后新进入');
  pick('customerId', refs.customers[0]); const latest = await b.api(path); await b.api(path, 'PATCH', { expectedVersion: latest.project.version, idempotencyKey: randomUUID(), changes: { summaryNote: '另一个负责人核对资料' } });
  panel.w.dispatchEvent(new panel.w.Event('focus')); await waitFor(() => panel.$('#save').disabled && !panel.$('#project-notice').hidden && /他人更新/.test(panel.$('#message').textContent), '引用旧版本冻结'); frozen(true); assert.equal(source('customerId').value, refs.customers[0]);
  panel.visibleClick('#notice-close'); assert(panel.$('#project-notice').hidden); frozen(true); assert(panel.$('#save').disabled);
  assert.equal((await read()).project.customerId, refs.customers[1], '旧副本未覆盖正式关联'); panel.click('#copy'); assert.match(panel.$('.copy-text').value, new RegExp(refs.customers[0])); panel.click('[data-choice="cancel"]');
  checks.push('候选未到、动作处理中与他人更新统一禁用组合控件；冻结保留旧ID供复制，不覆盖他人新版本');
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
  if (referencesMode) await verifyReferences(a, b, id, path);
  else {
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
  await waitFor(() => !owner.$('#action-dialog').open, '一次完成节点编辑');
  assert.deepEqual(await facts(id), initial, '预览与普通副本不能写正式库');
  owner.tab('flow'); assert.match(owner.$('.flow-node').textContent, /同源节点/); assert.equal(owner.$('.node-list'), null);
  owner.$('.flow-node').dispatchEvent(new owner.w.KeyboardEvent('keydown', { key: 'Enter' }));
  await waitFor(() => owner.$('#node-edit'), 'Flow节点编辑'); assert(owner.$('[data-tab="flow"]').classList.contains('active'));
  owner.click('#node-cancel'); owner.tab('info'); assert.equal(owner.$('#edit-name').value, prefix + ' 修改'); assert.equal(owner.$('#edit-summaryNote').value, '跨页保留的普通修改');
  owner.tab('flow'); owner.click('#save'); await waitFor(() => owner.$('#save')?.disabled && !owner.$('#reload').disabled && owner.dom.projectReads.at(-1)?.project.name === prefix + ' 修改', '项目保存及新GET回读');
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
  owner.w.dispatchEvent(new owner.w.Event('focus')); await waitFor(() => owner.$('#save').disabled && !owner.$('#project-notice').hidden && /他人更新/.test(owner.$('#message').textContent), '旧版本冻结');
  owner.visibleClick('#notice-close'); assert(owner.$('#project-notice').hidden); assert(owner.$('#edit-name').disabled); assert(owner.$('#save').disabled);
  owner.click('#copy'); assert.match(owner.$('.copy-text').value, /旧副本供复制/); owner.click('[data-choice="cancel"]');
  owner.click('#reload'); await waitFor(() => owner.$('[data-choice="keep"]'), '重新进入前明确保留'); owner.click('[data-choice="keep"]');
  await waitFor(() => owner.$('#edit-name')?.value === '另一人已经更新' && !owner.$('#reload').disabled, '新版本回读'); owner.click('#copy'); assert.match(owner.$('.copy-text').value, /旧副本供复制/); owner.click('[data-choice="cancel"]');
  checks.push('另一负责人真实保存后旧副本冻结、可复制；明确重新进入后显示新版本，旧输入仍保留供核对');
  const recovering = await page(a, id), beforeUnknown = await facts(id); recovering.tab('info'); recovering.input('#edit-name', '真实提交后丢确认'); recovering.dom.dropSaveAck = true; recovering.click('#save');
  await waitFor(() => recovering.$('#confirm') && !recovering.$('#confirm').disabled, '原保存结果待确认'); assert.equal((await facts(id)).project.name, '真实提交后丢确认');
  recovering.visibleClick('#confirm'); await waitFor(() => recovering.$('#save')?.disabled && !recovering.$('#reload').disabled && recovering.dom.projectReads.at(-1)?.project.name === '真实提交后丢确认', '原编号确认及新读取');
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
    const preview = async (form, save) => {
      submit(form); await waitFor(() => !panel.$(save).disabled && !panel.$('#action-fields').disabled, form + '实际预览');
      const tables = panel.$('#action-fields').querySelectorAll('table'); assert(tables.length, form + '前后对比表格');
      for (const table of tables) assert.deepEqual([...table.querySelectorAll('th')].slice(-2).map(n => n.textContent), ['修改前', '修改后']);
    };
    panel.tab('risk'); panel.click('[data-risk="add"]'); await waitFor(() => panel.$('#risk-edit'), '风险弹窗'); mounted('#risk-edit'); panel.input('#risk-content', '取消的风险');
    panel.$('#action-dialog').dispatchEvent(new panel.w.Event('cancel', { cancelable: true })); assert.equal(panel.$('#action-dialog').open, false); assert.equal((await read()).risks.length, 0);
    panel.click('[data-risk="add"]'); await waitFor(() => panel.$('#risk-edit'), '重新录入风险'); panel.input('#risk-content', '硬件风险补充'); assert(panel.$('#risk-accept').hidden); submit('#risk-edit'); await waitFor(() => !panel.$('#action-dialog').open, '一次完成风险编辑');
    panel.click('[data-change="add"]'); await waitFor(() => panel.$('#change-edit'), '需求弹窗'); mounted('#change-edit'); panel.input('#chg-content', '取消的变更'); panel.click('#action-close'); assert.match(panel.$('.risk-item').textContent, /硬件风险补充/);
    panel.click('[data-change="add"]'); await waitFor(() => panel.$('#change-edit'), '重填变更'); panel.input('#chg-content', '低功耗接口'); panel.input('#chg-reason', '可复用接口，人工接受'); assert(panel.$('#change-accept').hidden); submit('#change-edit'); await waitFor(() => !panel.$('#action-dialog').open, '一次完成需求编辑'); assert(!panel.$('#message').textContent.includes('正在处理')); assert.match(panel.$('.chg-item').textContent, /低功耗接口/);
    panel.tab('custnodes'); panel.click('[data-node="add"]'); await waitFor(() => panel.$('#node-edit'), '客户节点弹窗'); mounted('#node-edit'); panel.input('[data-node-field="title"]', '客户核对'); panel.input('[data-node-field="note"]', '沟通记录'); assert(panel.$('#node-accept').hidden); submit('#node-edit'); await waitFor(() => !panel.$('#action-dialog').open, '一次完成客户节点编辑');
    assert.equal((await read()).changes.length, 0, '完成编辑只改变副本，尚未写正式数据');
    panel.click('#save'); await done(data => data?.risks.length === 1 && data?.changes.length === 1 && data?.nodes.some(n => n.kind === 'customer'), '三类副本统一保存及新GET');
    assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_risks WHERE project_id=?', [id]))[0][0].n), 1); assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_changes WHERE project_id=?', [id]))[0][0].n), 1);
    const grouped = await read(); panel.tab('history');
    await waitFor(() => panel.$(`.audit-entry[data-audit-version="${grouped.project.version}"]`), '同次保存的历史归组');
    assert.equal(panel.w.document.querySelectorAll(`.audit-entry[data-audit-version="${grouped.project.version}"]`).length, 1);
    assert.equal(panel.$(`.audit-entry[data-audit-version="${grouped.project.version}"]`).querySelectorAll('tbody tr').length, 3, '独立的风险/需求/客户节点各一行');
    panel.tab('risk'); panel.click(`[data-change="correct"][data-change-id="${grouped.changes[0].id}"]`); await waitFor(() => panel.$('#change-edit'), '纠正需求理由');
    panel.input('#chg-reason', '本次只纠正决定理由'); panel.input('#chg-correction-reason', '原理由误录'); await preview('#change-edit', '#change-accept');
    assert.equal(panel.$('[data-change-field]'), null, '直接编辑不要求逐字段勾选'); assert(!panel.$('#chg-source').disabled); const reasonTable = panel.$('#change-preview'); assert.equal(reasonTable.querySelectorAll('tbody tr').length, 1); assert.match(reasonTable.textContent, /本次只纠正决定理由/); assert(!reasonTable.textContent.includes('低功耗接口')); assert(!reasonTable.textContent.includes('来源：')); panel.input('#chg-reason', '预览后再修改理由'); assert(panel.$('#change-accept').disabled, '输入变化必须重新核对'); await preview('#change-edit', '#change-accept'); panel.click('#change-cancel');
    const customerId = grouped.nodes.find(n => n.kind === 'customer').id; panel.tab('custnodes'); panel.click(`[data-node="correct"][data-node-id="${customerId}"]`); await waitFor(() => panel.$('#node-edit'), '明确清空客户备注');
    panel.input('[data-node-field="note"]', ''); panel.input('#node-reason', '客户备注误填'); await preview('#node-edit', '#node-accept');
    const cleared = panel.$('#node-preview'); assert.equal(cleared.querySelectorAll('tbody tr').length, 1); assert.match(cleared.textContent, /沟通记录/); assert.match(cleared.textContent, /客户节点备注：（空）/); assert(!cleared.textContent.includes('节点名称：')); panel.click('#node-cancel');
    panel.click(`[data-node="correct"][data-node-id="${customerId}"]`); await waitFor(() => panel.$('#node-edit'), '无变化节点预览'); panel.input('[data-node-field="note"]', '沟通记录'); panel.input('#node-reason', '再次核对内容一致'); submit('#node-edit'); await waitFor(() => /没有实际变化/.test(panel.$('#node-preview').textContent), '实际无变化预览'); assert(panel.$('#node-accept').disabled); assert.equal(panel.$('#node-preview').querySelectorAll('table').length, 0, '无变化不展示空表'); panel.click('#node-cancel');
    assert.equal((await read()).project.version, grouped.project.version, '纠错预览和取消不正式入库');
    checks.push('同一需求一行；仅纠正理由隐藏不变字段；清空旧备注保留实际变化；同次保存归组，三条独立记录各一行');
    checks.push('三类新增仅一次完成编辑且不入正式库；风险/需求/客户节点同次普通保存；取消与ESC保留其他副本；直接纠错只发送变化');
    let d = await read(); const today = d.businessDate, date = days => new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);
    panel.tab('stages'); panel.click('[data-stage="S1"][data-stage-action="startStage"]'); await waitFor(() => panel.$('#stage-form'), '阶段开始弹窗'); mounted('#stage-form');
    panel.input('#stage-date', '2099-01-01'); const beforeReject = await facts(id); submit('#stage-form'); await waitFor(() => !panel.$('#action-fields').disabled && !panel.$('#project-notice').hidden && /日期/.test(panel.$('#message').textContent), '未来实际日拒绝'); assert.equal(panel.$('#action-message').textContent, ''); assert.equal(panel.$('#stage-date').value, '2099-01-01'); assert.deepEqual(await facts(id), beforeReject);
    panel.input('#stage-date', today); submit('#stage-form'); await done(data => data?.stages[0].state === 'active', '开始新GET');
    panel.click('[data-stage="S1"][data-stage-action="completeStage"]'); await waitFor(() => panel.$('#stage-form'), '完成弹窗'); panel.input('#stage-note', '负责人已核对'); panel.dom.dropActionAck = true; submit('#stage-form');
    await waitFor(() => !panel.$('#action-recovery').hidden && !panel.$('#action-confirm').disabled, '动作真实COMMIT后未知'); assert(panel.$('#action-fields').disabled); const afterCommit = await facts(id);
    panel.visibleClick('#action-close'); assert.equal(panel.$('#action-dialog').open, false); assert.equal(panel.$('#draft-dialog').open, false); assert.equal(panel.$('#detail-body #stage-confirm'), null);
    panel.visibleClick('#drafts'); assert(panel.$('#draft-dialog').open); panel.visibleClick('#draft-close'); assert.equal(panel.$('#draft-dialog').open, false); assert.deepEqual(await facts(id), afterCommit);
    panel.visibleClick('#drafts'); assert(panel.$('#draft-dialog').open); panel.visibleClick('#stage-confirm');
    d = await done(data => data?.stages[0].state === 'completed', '完成原结果及新GET'); assert.equal((await facts(id)).auditCount, afterCommit.auditCount); assert.equal(d.project.status, 'proposal'); assert.equal(d.stages[1].state, 'ready');
    panel.click('#project-start'); await waitFor(() => panel.$('#start-form'), '项目启动弹窗'); panel.input('#start-date', today); panel.input('#start-due', date(10)); submit('#start-form'); d = await done(data => data?.project.status === 'ongoing', '启动新GET'); const obligation = d.project.firstCheckWeek; assert.equal(d.stages[1].state, 'ready');
    checks.push('阶段未来日期失败保留输入与库原值；开始/完成独立保存，真实动作COMMIT丢响应用原编号确认；S1完成仍提案，人工启动后S2待开始');
    checks.push('动作未知结果关闭原表单后，从可见副本弹窗找到原结果确认；关闭提示不丢请求，原编号回读不重复增加审计');
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
    panel.tab('flow'); panel.$('.flow-node').dispatchEvent(new panel.w.KeyboardEvent('keydown', { key: 'Enter' })); await waitFor(() => panel.$('#node-edit'), 'Flow节点上下文'); assert(!panel.$('[data-node-field="title"]').disabled); assert.equal(panel.$('[data-node-select]'), null);
    panel.click('[data-node-form-action="complete"]'); await waitFor(() => panel.$('#node-completed'), '同上下文填写完成日'); panel.input('#node-completed', today); await preview('#node-edit', '#node-accept'); panel.click('#node-accept'); panel.click('#save'); d = await done(data => data?.nodes.find(n => n.kind === 'project')?.completedOn === today, 'Flow节点完成正式新读'); assert(panel.$('[data-tab="flow"]').classList.contains('active')); assert.equal(d.stages[0].state, 'ready');
    panel.$('.flow-node').dispatchEvent(new panel.w.KeyboardEvent('keydown', { key: 'Enter' })); await waitFor(() => panel.$('#node-edit'), '节点更正弹窗'); panel.input('[data-node-field="title"]', '旧节点输入供复制'); panel.input('#node-reason', '名称误录');
    const concurrent = await b.api(path); await b.api(path, 'PATCH', { expectedVersion: concurrent.project.version, idempotencyKey: randomUUID(), changes: { summaryNote: '另一个负责人已经核对' } });
    panel.w.dispatchEvent(new panel.w.Event('focus')); await waitFor(() => panel.$('#action-fields').disabled && !panel.$('#project-notice').hidden && /他人更新/.test(panel.$('#message').textContent), '弹窗旧版本冻结'); assert.equal(panel.$('#action-message').textContent, '');
    panel.visibleClick('#notice-close'); assert(panel.$('#project-notice').hidden); assert(panel.$('#action-fields').disabled); panel.click('#action-copy'); assert.match(panel.$('.copy-text').value, /旧节点输入供复制/); panel.click('[data-choice="cancel"]'); assert(panel.$('#action-dialog').open);
    panel.click('#action-close'); assert.equal(panel.$('#action-dialog').open, false); panel.click('#copy'); assert.match(panel.$('.copy-text').value, /旧节点输入供复制/); panel.click('[data-choice="cancel"]');
    checks.push('Flow节点弹窗直接进入实际完成操作，明确字段纠错后才编辑；节点完成不自动完成阶段；他人更新时弹窗冻结、可复制，关闭仍保留旧副本');
  }
  }
  assert.equal(errors.length, 0);
  const build = (await a.api('/api/health/live')).build;
  await writeFile('test-results/' + (referencesMode ? 'reference-ui-check.json' : actionsMode ? 'context-ui-check.json' : 'detail-ui-check.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount, build, frontendSource: 'src/web/detail.ts + shared/api.ts + shared/reference-picker.ts', sourceSha256: Object.fromEntries(Object.entries({ detailSource, apiSource, referenceSource, html }).map(([key, source]) => [key, createHash('sha256').update(source).digest('hex')])), isolatedTestDatabase: true, syntheticOnly: true, domExecution: 'jsdom 27.0.1; CSS/BroadcastChannel/native dialog/popover behavior not validated', nativeBrowserAcceptance: false, visualAcceptance: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount }));
} finally {
  for (const view of views) view.window.close();
  if (app) await app.close();
  for (const id of projects) { await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?', [id]); for (const table of ['project_changes', 'project_risks', 'project_nodes', 'project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities', 'project_chips', 'project_tags', 'project_people']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const reference of references) await c.execute('DELETE FROM ' + reference.table + ' WHERE id=? AND name LIKE ?', [reference.id, prefix + '%']);
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); }
  if (ownConfig) { await c.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?', [users[2].id]); await c.execute('DELETE FROM check_rule_revisions WHERE saved_by=?', [users[2].id]); }
  for (const user of users) await c.execute('DELETE FROM users WHERE id=?', [user.id]);
  await c.end(); process.off('unhandledRejection', reject);
}
