import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
const sourcePaths = ['src/web/project-checks.html', 'src/web/project-checks.ts', 'src/web/project-detail.html', 'src/web/detail.ts', 'src/web/shared/api.ts', 'src/web/shared/reference-picker.ts'];
const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, await readFile(path, 'utf8')])));
const stageSource = (await readFile('geekdashdesktop/projects-data.js', 'utf8')).match(/const STAGES = (\[[\s\S]*?\n  \]);/);
assert(stageSource);
const stages = vm.runInNewContext(stageSource[1], Object.create(null), { timeout: 1000 });
const { connection: c } = await connectDatabase('test_migrator');
let app, origin, ownRule, requestCount = 0;
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
async function page(user, path, { storage = {}, holdConfirm = false } = {}) {
  const detail = path.startsWith('/project-detail.html'), html = sources[detail ? 'src/web/project-detail.html' : 'src/web/project-checks.html'];
  const virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', reject);
  const dom = new JSDOM(html, { url: origin + path, cookieJar: user.jar, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole }); views.push(dom);
  const w = dom.window, reads = [], requests = [];
  const panel = { dom, w, reads, requests, dropAck: false, releaseConfirm: undefined };
  if (!detail) {
    const NativeDate = w.Date, interval = w.setInterval.bind(w);
    w.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [panel.now ?? NativeDate.now()])); } static now() { return panel.now ?? NativeDate.now(); } };
    w.setInterval = (callback, delay, ...args) => { if (delay === 60000) panel.dayTick = () => callback(...args); return interval(callback, delay, ...args); };
  }
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone, AbortController, AbortSignal, __GEEKDASH_STAGES__: stages });
  w.BroadcastChannel = class { postMessage() {} }; w.scrollTo = () => {};
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; this.returnValue = ''; };
  w.HTMLDialogElement.prototype.close = function(value = '') { this.returnValue = value; this.open = false; this.dispatchEvent(new w.Event('close')); };
  for (const [key, value] of Object.entries(storage)) w.sessionStorage.setItem(key, value);
  w.fetch = async (url, options = {}) => {
    const entry = { path: url, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined }; requests.push(entry);
    const response = await user.fetch(url, options); entry.status = response.status;
    if (entry.method === 'GET' && url.startsWith('/api/projects') && response.ok) reads.push({ path: url, data: await response.clone().json() });
    if (holdConfirm && url.endsWith('/action-results/query')) { holdConfirm = false; await new Promise(resolve => { panel.releaseConfirm = resolve; }); }
    if (panel.dropAck && url.endsWith('/actions') && entry.method === 'POST' && response.ok) { panel.dropAck = false; await response.arrayBuffer(); throw new Error('模拟真实COMMIT后响应丢失'); }
    return response;
  };
  const context = dom.getInternalVMContext();
  const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = source => { context.exports = {}; context.module = { exports: context.exports }; vm.runInContext('(function(exports,module){' + compile(source) + '\n})(exports,module)', context); return context.module.exports; };
  const shared = module(sources['src/web/shared/api.ts']);
  const picker = detail ? module(sources['src/web/shared/reference-picker.ts']) : undefined;
  context.require = name => { if (name === './shared/api') return shared; if (name === './shared/reference-picker') return picker; if (name.endsWith('.css')) return {}; throw new Error('未预期的页面依赖：' + name); };
  vm.runInContext('(function(){' + compile(sources[detail ? 'src/web/detail.ts' : 'src/web/project-checks.ts']) + '\n})()', context);
  panel.$ = selector => w.document.querySelector(selector);
  panel.click = selector => { const node = panel.$(selector); assert(node, selector); assert.equal(node.closest('[hidden]'), null, selector + ' 必须可见'); assert(!node.disabled, selector + ' 不应禁用'); const dialog = node.closest('dialog'); if (dialog) assert(dialog.open); node.click(); };
  panel.input = (selector, value) => { const node = panel.$(selector); assert(node && !node.disabled, selector); node.value = value; node.dispatchEvent(new w.Event('input', { bubbles: true })); };
  await waitFor(() => detail ? panel.$('#edit-statusDesc') && !panel.$('#reload').disabled : panel.$('#page-info').textContent, '实际页面初次读取');
  return panel;
}
const card = id => `[data-project-id="${id}"]`, pass = id => `[data-check-project="${id}"]`;
const lists = panel => panel.reads.filter(item => item.path.startsWith('/api/projects?'));
const settled = panel => panel.$('#check-list').getAttribute('aria-busy') === 'false';
async function facts(id) {
  const { connection } = await connectDatabase('test_app');
  try {
    const [project] = await connection.query('SELECT CAST(version AS CHAR) version,status_description FROM projects WHERE id=?', [id]);
    const [records] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(actor_id AS CHAR) actorId,CAST(observed_version AS CHAR) observedVersion,CAST(result_version AS CHAR) resultVersion,conclusion,note FROM project_checks WHERE project_id=? ORDER BY id', [id]);
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
  let rule = await a.api('/api/settings/check-rule');
  if (!rule.rule) {
    await c.execute('INSERT INTO check_rule_revisions (deadline_weekday,effective_week,saved_at,saved_by) VALUES (5,?,UTC_TIMESTAMP(3),?)', [rule.weekStart, users[0].id]);
    ownRule = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
    rule = await a.api('/api/settings/check-rule');
  }
  const ids = {};
  for (const name of ['success', 'correct', 'conflict', 'lost', 'denied']) {
    const user = name === 'denied' ? b : a;
    const created = await user.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '_' + name, summaryNote: '独立检查页面合成项目' } });
    ids[name] = created.result.projectId; projects.push(created.result.projectId);
    await user.api('/api/projects/' + ids[name], 'PATCH', { expectedVersion: created.result.savedVersion, idempotencyKey: randomUUID(), changes: { statusDesc: '资料已核对\n原说明保持只读' } });
  }
  const listPath = '/api/projects?view=proposal&search=' + prefix;
  const entry = '/project-checks.html?view=proposal&search=' + prefix + '&layout=dashboard';
  const panel = await page(a, entry); await waitFor(() => settled(panel), '初次检查页面就绪');
  assert.equal(panel.w.document.querySelectorAll('#check-list article').length, 5);
  assert.equal(panel.$('#check-list input,#check-list textarea,#check-list select'), null, '检查页最新说明只读');
  assert.equal(new URL(panel.w.location.href).searchParams.has('layout'), false);
  assert.equal(new URL(panel.w.location.href).searchParams.get('checkToday'), 'unchecked');
  assert.match(panel.$('#check-scope').textContent, /提案 \/ 暂缓/);
  assert.equal(panel.$('[data-check-today="checked"]').textContent, '今日已检查', '不展示含日过滤的另一范围错误0计数');
  const nextDay = Date.parse(lists(panel).at(-1).data.businessDate + 'T12:00:00+08:00') + 86400000;
  const sameDayRequests = panel.requests.length; panel.w.dispatchEvent(new panel.w.Event('focus')); panel.dayTick();
  assert.equal(panel.requests.length, sameDayRequests, '同一天不额外刷新');
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
  assert.equal(success.audit[0].entityId, success.records[0].id);
  const freshList = await a.api(listPath); assert(freshList.items.find(item => item.id === ids.success).checkedToday);
  assert.equal((await a.api(listPath + '&checkToday=unchecked')).pagination.total, 4);
  assert.equal((await a.api('/api/projects/' + ids.success + '/checks')).items[0].id, success.records[0].id);
  panel.click('[data-check-today="checked"]'); await waitFor(() => settled(panel) && panel.$(card(ids.success)), '切到今日已检查');
  assert(panel.$(pass(ids.success)).disabled); assert.equal(panel.w.document.querySelectorAll('#check-list article').length, 1);
  panel.click('[data-check-today="unchecked"]'); await waitFor(() => settled(panel) && panel.$(card(ids.correct)), '返回未检查范围');
  checks.push('客户端跨日focus/可见60秒回调触发真实新GET且保持范围，同日不重复刷新；真实页面通过检查→原actions事务→独立连接SQL检查事实/审计/回执→新GET待查消失、首页当日标记、已查页与检查历史一致');

  const correctionLink = panel.$(`[data-correct-project="${ids.correct}"]`);
  correctionLink.addEventListener('click', event => event.preventDefault()); correctionLink.click();
  const target = new URL(correctionLink.href), returnTo = target.searchParams.get('returnTo');
  assert.equal(target.origin, origin); assert.equal(target.pathname, '/project-detail.html');
  assert.equal(returnTo, panel.w.location.pathname + panel.w.location.search);
  assert.equal(JSON.parse(panel.w.sessionStorage.getItem('geekdash_checks_return')).url, panel.w.location.href);
  const detail = await page(a, target.pathname + target.search);
  assert.equal(detail.$('#back').href, origin + returnTo); assert.match(detail.$('#back').textContent, /返回项目检查/);
  detail.input('#edit-statusDesc', '直接修正最新说明，尚未通过检查');
  detail.click('#back'); await waitFor(() => detail.$('[data-choice="cancel"]'), '返回仍保留原未保存保护');
  detail.click('[data-choice="cancel"]'); assert.equal(detail.$('#edit-statusDesc').value, '直接修正最新说明，尚未通过检查');
  detail.click('#save'); await waitFor(() => detail.$('#save').disabled && !detail.$('#reload').disabled && detail.reads.some(item => item.data.project?.statusDesc === '直接修正最新说明，尚未通过检查'), '详情修正保存后的新GET');
  const corrected = await facts(ids.correct); assert.equal(corrected.project.status_description, '直接修正最新说明，尚未通过检查'); assert.equal(corrected.records.length, 0);
  const returned = await page(a, returnTo, { storage: Object.fromEntries(Object.entries(panel.w.sessionStorage)) });
  assert.match(returned.$(card(ids.correct)).textContent, /直接修正最新说明/); assert(!returned.$(pass(ids.correct)).disabled);
  const unsafe = await page(a, '/project-detail.html?id=' + ids.correct + '&returnTo=' + encodeURIComponent('https://invalid.example/project-checks.html'));
  assert.equal(new URL(unsafe.$('#back').href).origin, origin); assert.notEqual(new URL(unsafe.$('#back').href).pathname, '/project-checks.html');
  checks.push('进入修正保留同站检查范围/位置；真实详情输入→返回取消仍保留→正式保存→新GET/独立SQL；修正不自动检查，外站returnTo被拒绝');

  const conflictBefore = await facts(ids.conflict), staleVersion = returned.$(card(ids.conflict)).dataset.projectVersion;
  await a.api('/api/projects/' + ids.conflict, 'PATCH', { expectedVersion: staleVersion, idempotencyKey: randomUUID(), changes: { statusDesc: '另一个页面已更新，需要重新核对' } });
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
  returned.now = nextDay; const pendingRequests = returned.requests.length;
  returned.w.dispatchEvent(new returned.w.Event('focus')); returned.dayTick();
  assert.equal(returned.requests.length, pendingRequests, '跨日不刷新或重放待确认检查');
  assert.deepEqual(JSON.parse(returned.w.sessionStorage.getItem(pendingKey)), original); assert(returned.$(pass(ids.lost)).disabled); returned.now = undefined;
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
  const denied = await a.api('/api/projects/' + ids.denied + '/actions', 'POST', { action: 'saveCheck', expectedVersion: deniedBefore.project.version, idempotencyKey: randomUUID(), ruleVersion: rule.rule.version, previewWeek: rule.weekStart, conclusion: 'checked', note: '' }, 403);
  assert.equal(denied.code, 'PROJECT_READ_ONLY'); assert.deepEqual(await facts(ids.denied), deniedBefore);
  assert.equal(errors.length, 0);
  checks.push('无负责关系仍可读完整卡片但按钮禁用且不发请求；直接HTTP越权403，独立SQL事实/审计/版本保持');

  const build = (await a.api('/api/health/live')).build;
  const result = { status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount, build, sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')])), isolatedTestDatabase: true, syntheticOnly: true, domExecution: true, nativeBrowserAcceptance: false, visualAcceptance: false };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/project-checks-ui-check.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, groups: checks.length, requestCount }));
} finally {
  for (const view of views) view.window.close(); if (app) await app.close();
  for (const id of projects) {
    await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?', [id]);
    for (const table of ['project_changes', 'project_risks', 'project_nodes', 'project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities', 'project_chips', 'project_people', 'project_tags']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]);
    await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]);
  }
  if (ownRule) await c.execute('DELETE FROM check_rule_revisions WHERE version=? AND saved_by=?', [ownRule, users[0].id]);
  for (const user of users) {
    for (const table of ['command_receipts', 'audit_log']) await c.execute('DELETE FROM ' + table + ' WHERE actor_id=?', [user.id]);
    await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]);
  }
  await c.end(); process.off('unhandledRejection', reject);
}
