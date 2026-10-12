import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    const response = await fetch(url, { ...options, headers }); requestCount++;
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
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone, AbortSignal, __GEEKDASH_STAGES__: stages });
  w.BroadcastChannel = class { postMessage() {} };
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; this.returnValue = ''; };
  w.HTMLDialogElement.prototype.close = function(value = '') { this.returnValue = value; this.open = false; this.dispatchEvent(new w.Event('close')); };
  w.fetch = async (path, options) => {
    const response = await user.fetch(path, options);
    if (holdCatalog && path === '/api/project-options') {
      await new Promise(resolve => { dom.releaseCatalog = resolve; });
      const json = response.json.bind(response);
      response.json = async () => { const data = await json(); setTimeout(() => { dom.catalogConsumed = true; }, 0); return data; };
    }
    if (dom.dropSaveAck && options?.method === 'PATCH') { dom.dropSaveAck = false; await response.arrayBuffer(); throw new Error('模拟真实COMMIT后的确认丢失'); }
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
  for (let i = 0; i < 2; i++) { const loginName = prefix + '_' + i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '页面合成账号' + i]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
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
  owner.tab('flow'); owner.click('#save'); await waitFor(() => owner.$('#save')?.disabled && /当前内容已保存/.test(owner.$('#edit-state').textContent), '项目保存及新GET回读');
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
  recovering.click('#confirm'); await waitFor(() => recovering.$('#save')?.disabled && /当前内容已保存/.test(recovering.$('#edit-state').textContent), '原编号确认及新读取');
  assert.equal((await facts(id)).auditCount, beforeUnknown.auditCount + 1); assert.equal(recovering.$('#edit-name').value, '真实提交后丢确认');
  checks.push('真实COMMIT后丢响应，页面保留原请求；确认原结果及新读取仅产生一次审计');
  assert.equal(errors.length, 0);
  const build = (await a.api('/api/health/live')).build;
  await writeFile('test-results/detail-ui-check.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount, build, frontendSource: 'src/web/detail.ts + shared/api.ts', isolatedTestDatabase: true, syntheticOnly: true, domExecution: 'jsdom 27.0.1; CSS/BroadcastChannel/native dialog behavior not validated', nativeBrowserAcceptance: false, visualAcceptance: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount }));
} finally {
  for (const view of views) view.window.close();
  if (app) await app.close();
  for (const id of projects) { await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?', [id]); for (const table of ['project_changes', 'project_risks', 'project_nodes', 'project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end(); process.off('unhandledRejection', reject);
}
