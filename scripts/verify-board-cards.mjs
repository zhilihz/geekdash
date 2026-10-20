import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';
import { projectReads } from '../dist/server/modules/projects.js';

// 本轮首页卡片和全局检查链路；不代替完整业务回归或原生视觉验收。
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1');
assert.match(process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID ?? '', /^[a-f0-9-]{36}$/);
const { connection: c } = await connectDatabase('test_migrator');
const prefix = 'cards_' + randomUUID().slice(0, 8), password = '卡片检查 password 2026';
const ids = [], references = [], checks = [], views = [], errors = [], pending = new Set();
const keepNative = process.argv.includes('--keep-native');
let app, runtime, origin, actor, cookie = '', csrf = '', requestCount = 0, passed = false;
const sql = async (statement, params = []) => (await c.query(statement, params))[0];
async function request(path, options = {}) {
  requestCount++;
  const response = await fetch(origin + path, { ...options, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(actor ? { 'X-GeekDash-Account': actor } : {}), ...options.headers } });
  for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
  return response;
}
async function api(path, method = 'GET', body) {
  const response = await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); assert.equal(response.status, 200, path + ': ' + JSON.stringify(value)); return value;
}
async function waitFor(test, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (errors.length) throw errors[0]; if (await test()) return; await new Promise(done => setTimeout(done, 20)); }
  throw Error('未达到预期：' + description);
}
async function catalog(kind, fields) {
  const result = await api('/api/catalog/' + kind + '/save', 'POST', { id: null, expectedVersion: '0', changes: fields, idempotencyKey: randomUUID() });
  references.push([({ productLines: 'product_lines', groups: 'project_groups' })[kind] ?? kind, result.result.id]); return result.result.id;
}
async function counts(day) {
  const start = Date.parse(day + 'T00:00:00+08:00'), times = [start, start + 86400000].map(time => new Date(time).toISOString().slice(0, 23).replace('T', ' '));
  const [row] = await sql('SELECT COUNT(*) total,SUM(EXISTS(SELECT 1 FROM project_checks ck WHERE ck.project_id=p.id AND ck.checked_at>=? AND ck.checked_at<?)) todayChecked FROM projects p', times);
  return { total: Number(row.total), todayChecked: Number(row.todayChecked), todayUnchecked: Number(row.total) - Number(row.todayChecked) };
}
async function page(name, query) {
  const { JSDOM, VirtualConsole } = await import(process.env.GEEKDASH_DOM_LIBRARY ?? '../test-results/ui-dom-tools/node_modules/jsdom/lib/api.js');
  const console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(await readFile('src/web/' + name + '.html', 'utf8'), { url: origin + '/' + (name === 'index' ? '' : name + '.html') + query, runScripts: 'outside-only', virtualConsole: console }); views.push(dom);
  const w = dom.window, RealDate = w.Date, intervals = [], reads = [], calls = [];
  let simulatedDate;
  Object.assign(w, { TextEncoder, TextDecoder, structuredClone, AbortController, AbortSignal });
  const stageSource = (await readFile('geekdashdesktop/projects-data.js', 'utf8')).match(/const STAGES = (\[[\s\S]*?\n  \]);/); assert(stageSource);
  w.__GEEKDASH_STAGES__ = vm.runInNewContext(stageSource[1], Object.create(null), { timeout: 1000 });
  w.BroadcastChannel = class { postMessage() {} }; w.scrollTo = () => {}; w.confirm = () => true;
  w.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [simulatedDate ?? Date.now()])); } static now() { return simulatedDate ?? Date.now(); } };
  Object.defineProperty(w.document, 'visibilityState', { value: 'visible' });
  const interval = w.setInterval.bind(w); w.setInterval = (fn, delay, ...args) => { if (delay === 60000) intervals.push(fn); return interval(fn, delay, ...args); };
  w.document.cookie = 'geekdash_dev_csrf=' + csrf;
  w.fetch = (path, options) => {
    const task = (async () => {
      calls.push({ path, method: options?.method ?? 'GET' });
      let response;
      if (simulatedDate !== undefined && path.startsWith('/api/projects?')) {
        const params = Object.fromEntries(new URL(path, origin).searchParams);
        for (const key of ['page', 'pageSize']) if (params[key]) params[key] = Number(params[key]);
        response = new Response(JSON.stringify(await projectReads(runtime, () => new Date(simulatedDate)).list(params, actor)), { headers: { 'Content-Type': 'application/json' } });
      } else response = await request(path, options);
      if (path.startsWith('/api/projects?') && response.ok) reads.push(await response.clone().json());
      return response;
    })(); pending.add(task); void task.finally(() => pending.delete(task)).catch(() => {}); return task;
  };
  const context = dom.getInternalVMContext(), modules = new Map();
  function load(path) {
    if (path.endsWith('.css')) return {};
    path = resolve(path.endsWith('.ts') ? path : path + '.ts'); if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInContext('(function(require,exports,module){' + code + '\n})', context, { filename: path })(name => load(resolve(dirname(path), name)), module.exports, module); return module.exports;
  }
  load('src/web/' + (name === 'index' ? 'board' : name) + '.ts');
  const $ = selector => w.document.querySelector(selector);
  await waitFor(() => reads.length && (name === 'index' ? $('#card-grid').getAttribute('aria-busy') === 'false' : $('#check-list').getAttribute('aria-busy') === 'false' && $('[data-check-project]')), name + '真实页面就绪');
  return { dom, w, $, reads, calls, intervals, simulateDate: value => { simulatedDate = value; } };
}
try {
  assert.equal((await sql('SELECT @@server_uuid uuid'))[0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
  assert.equal((await sql('SELECT DATABASE() db'))[0].db, 'geekdash_test');
  await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix, await hashPassword(password), prefix + ' 经理']);
  actor = (await sql('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
  runtime = await openRuntimeDatabase('test_app'); app = await createApp(runtime, { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
  await api('/api/auth/login', 'POST', { loginName: prefix, password }); await api('/api/auth/me');
  const customer = await catalog('customers', { name: prefix + ' 客户' }), factory = await catalog('customers', { name: prefix + ' 工厂' });
  const product = await catalog('productLines', { name: prefix + ' 产品线' }), group = await catalog('groups', { name: prefix + ' 分组' });
  const appId = await catalog('apps', { name: prefix + ' 配套APP' }), chip = await catalog('chips', { name: prefix + ' 芯片' }), tag = await catalog('tags', { name: prefix + ' 标签' });
  const engineer = await catalog('engineers', { name: prefix + ' 工程师', role: '硬件' });
  const day = (await api('/api/project-options')).businessDate;
  for (const [index, status] of ['ongoing', 'proposal', 'paused', 'closed', 'closed'].entries()) {
    const made = await api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '_' + index, summary: '卡片项目简介', statusDesc: '样机已完成联调，等待反馈。', customerId: customer, odmCustomerId: factory, productLineId: product, groupId: group, appId, chipIds: [chip], tagIds: [tag], people: [{ id: engineer, role: 'hardware_owner' }], filingDate: day, dueDate: '2027-01-15' } });
    ids.push(made.result.projectId);
    // 仅建立不同状态的读取夹具；本轮实际写入链为下方saveCheck，不重验生命周期。
    await c.execute('UPDATE projects SET status=?,maintenance_enabled=? WHERE id=?', [status, index === 4 ? 1 : 0, made.result.projectId]);
  }
  await c.execute('UPDATE projects SET started_on=? WHERE id=?', [day, ids[0]]);
  await c.execute('UPDATE projects SET closed_on=? WHERE id=?', [day, ids[3]]);
  const riskPath = '/api/projects/' + ids[1];
  async function risk(operation, expected) {
    const detail = await api(riskPath), target = operation.tempId ?? operation.id;
    const out = await api(riskPath, 'PATCH', { expectedVersion: detail.project.version, idempotencyKey: randomUUID(), scope: 'risk', target, changes: { riskOps: [operation] } });
    const fresh = await api('/api/projects?view=all&search=' + prefix + '_1');
    assert.deepEqual(fresh.items[0].riskSummary, expected); return operation.tempId ? out.result.riskIdMap[operation.tempId] : target;
  }
  const riskHigh = await risk({ op: 'add', tempId: randomUUID(), content: '供应风险', level: 'low' }, { unresolvedCount: 1, highestLevel: 'low' });
  const riskMid = await risk({ op: 'add', tempId: randomUUID(), content: '验证风险', level: 'mid' }, { unresolvedCount: 2, highestLevel: 'mid' });
  await risk({ op: 'correct', id: riskHigh, changes: { level: 'high' }, reason: '' }, { unresolvedCount: 2, highestLevel: 'high' });
  const expectedBefore = await counts(day), baseQuery = '/api/projects?dashboard=1&pageSize=100';
  for (const view of ['active', 'proposal', 'closed', 'maintenance', 'all']) {
    for (const suffix of ['', '&search=' + prefix, '&search=' + prefix + '_不存在', '&checkToday=checked']) {
      const result = await api(baseQuery + '&view=' + view + suffix); assert.deepEqual(result.globalChecks, expectedBefore);
      if (suffix.includes('_不存在')) assert.equal(result.stats.total, 0);
    }
  }
  checks.push('全局检查总量含进行中/提案/暂缓/结案/维护，跨视图/搜索空结果/今日筛选均与独立SQL一致；现有范围统计仍独立');
  const board = await page('index', '?view=all&search=' + prefix), path = '/api/projects/' + ids[0];
  assert.match(board.$('#today-check-count').textContent, new RegExp(String(expectedBefore.todayUnchecked)));
  const entry = new URL(board.$('#check-entry').href); assert.equal(entry.pathname, '/project-checks.html'); assert.equal(entry.searchParams.get('view'), 'all'); assert.equal(entry.searchParams.get('checkToday'), 'unchecked'); assert(!entry.searchParams.has('search'));
  const scopeGroup = board.$('[aria-labelledby="project-scope-label"]'), layoutGroup = board.$('[aria-labelledby="project-layout-label"]');
  assert.equal(scopeGroup.querySelectorAll('[data-view]').length, 5); assert.equal(layoutGroup.querySelectorAll('button').length, 2);
  assert.equal(scopeGroup.querySelector('#layout-cards'), null); assert.equal(layoutGroup.querySelector('[data-view]'), null);
  board.$('#layout-toggle').click();
  assert.equal(new URL(board.w.location.href).searchParams.get('view'), 'all'); assert.equal(new URL(board.w.location.href).searchParams.get('search'), prefix);
  assert.equal(board.$('#cards-view').hidden, true); assert.equal(board.$('#dashboard-view').hidden, false);
  board.$('[data-view="closed"]').click();
  await waitFor(() => board.$('[data-view="closed"]').getAttribute('aria-pressed') === 'true' && board.$('#card-grid').getAttribute('aria-busy') === 'false', '驾驶舱切换至已结案范围');
  assert.equal(new URL(board.w.location.href).searchParams.get('layout'), 'progress'); assert.equal(board.$('#dashboard-view').hidden, false);
  board.$('#layout-cards').click();
  assert.equal(new URL(board.w.location.href).searchParams.get('view'), 'closed'); assert.equal(board.$('#cards-view').hidden, false); assert.equal(board.$('#dashboard-view').hidden, true);
  board.$('[data-view="all"]').click();
  await waitFor(() => board.$('[data-view="all"]').getAttribute('aria-pressed') === 'true' && board.$('#card-grid').getAttribute('aria-busy') === 'false', '卡片切回全部项目');
  assert.equal(board.$('#layout-cards').getAttribute('aria-pressed'), 'true');
  board.$('#search').value = prefix; board.$('#reload').click();
  await waitFor(() => board.reads.at(-1).items.length === ids.length && board.$('#card-grid').getAttribute('aria-busy') === 'false', '恢复合成项目范围');
  checks.push('项目范围与展示方式分成两个具名按钮组；驾驶舱切换范围保持展示方式，切回卡片保持项目范围及各自选中状态');
  const before = (await api(path)).project;
  const checking = await page('project-checks', '?view=all&search=' + prefix + '_0&checkToday=unchecked');
  assert(checking.$('.check-card-foot').textContent.includes('尚未检查'));
  assert(!checking.$('[data-check-project="' + ids[0] + '"]').disabled);
  checking.$('[data-check-project="' + ids[0] + '"]').click();
  await waitFor(async () => Number((await sql('SELECT COUNT(*) n FROM project_checks WHERE project_id=?', [ids[0]]))[0].n) === 1, '检查点击持久化');
  await waitFor(() => !checking.$('[data-check-project="' + ids[0] + '"]') && checking.reads.at(-1).pagination.total === 0, '已检查移出待查');
  const saved = (await api(path)).project;
  const [fact] = await sql("SELECT CAST(id AS CHAR) id,CAST(actor_id AS CHAR) actorId,DATE_FORMAT(checked_at,'%Y-%m-%dT%H:%i:%s.%fZ') checkedAt,CAST(observed_version AS CHAR) observedVersion,CAST(result_version AS CHAR) resultVersion FROM project_checks WHERE project_id=?", [ids[0]]);
  assert.equal(fact.actorId, actor); assert.equal(fact.observedVersion, before.version); assert.equal(fact.resultVersion, saved.version); assert.equal(saved.checkedToday, true); assert.equal(saved.checkStatus.latest.checkedAt, fact.checkedAt);
  for (const key of ['name', 'summary', 'statusDesc', 'status', 'dueDate']) assert.equal(saved[key], before[key]);
  assert.equal(Number((await sql("SELECT COUNT(*) n FROM audit_log WHERE project_id=? AND entity_id=? AND action='project.check.save'", [ids[0], fact.id]))[0].n), 1);
  const expectedAfter = { ...expectedBefore, todayChecked: expectedBefore.todayChecked + 1, todayUnchecked: expectedBefore.todayUnchecked - 1 };
  assert.deepEqual(await counts(day), expectedAfter); assert.deepEqual((await api(baseQuery + '&view=closed&search=不存在')).globalChecks, expectedAfter);
  checking.$('[data-check-today="checked"]').click();
  await waitFor(() => checking.$('[data-check-project="' + ids[0] + '"]')?.disabled && checking.$('#check-list').getAttribute('aria-busy') === 'false', '检查页切至今日已检查');
  const localTime = new Date(Date.parse(fact.checkedAt) + 8 * 3600000).toISOString().slice(0, 16).replaceAll('-', '/').replace('T', ' ');
  assert(checking.$('.check-card-foot').textContent.includes('最近检查：' + localTime), '检查页显示实际检查年月日时分');
  board.$('#reload').click(); await waitFor(() => board.reads.at(-1).globalChecks.todayChecked === expectedAfter.todayChecked && board.$('#card-grid').getAttribute('aria-busy') === 'false', '首页读到检查结果');
  checks.push('真实检查页点击→唯一检查/审计落库→新详情版本与检查时间→待查移出→首页全局数量减少一项；人工正文与资料不变');
  const selector = '[data-project-id="' + ids[0] + '"]', card = () => board.$(selector);
  for (const suffix of ['客户', '工厂', '产品线', '分组', '配套APP', '芯片', '标签', '工程师', '经理']) assert(card().textContent.includes(prefix + ' ' + suffix), '卡片缺少' + suffix);
  assert(card().textContent.includes('卡片项目简介'));
  assert(card().textContent.includes(board.w.__GEEKDASH_STAGES__[0].milestone), '当前阶段复用原静态里程碑');
  assert.equal(board.$('.board-card-dates'), null, '卡片不展示四个项目日期');
  for (const title of ['立案日期', '实际启动', '预计结案', '实际结案']) assert(!card().textContent.includes(title), '卡片移除日期标签：' + title);
  assert(!card().textContent.includes('2027-01-15'), '卡片移除预计结案值');
  assert.equal(saved.filingDate, day); assert.equal(saved.startDate, day); assert.equal(saved.dueDate, '2027-01-15');
  assert.equal((await api('/api/projects/' + ids[3])).project.closedOn, day, '卡片隐藏日期不影响详情真实日期');
  assert.equal(card().querySelector('.board-check-state').textContent, '✓ 今日已检查');
  assert(board.$('[data-project-id="' + ids[1] + '"] .board-risk').textContent.includes('风险 2'));
  assert(board.$('[data-project-id="' + ids[1] + '"] .board-risk').classList.contains('signal-red'));
  assert.equal(board.$('[data-project-id="' + ids[1] + '"] .board-check-state').textContent, '○ 尚未检查');
  assert(board.$('[data-project-id="' + ids[1] + '"] .board-check-time').textContent.includes('尚未检查'));
  assert(card().querySelector('time[datetime="' + fact.checkedAt + '"]'), '检查时间必须来自真实记录');
  assert.equal(card().querySelector('time[datetime="' + fact.checkedAt + '"]').textContent, localTime);
  let navigations = 0;
  board.w.document.addEventListener('click', event => { if (event.target.closest?.('a[href*="project-detail.html"]')) { navigations++; event.preventDefault(); } }, true);
  card().querySelector('.card-desc').click(); assert.equal(navigations, 1, '普通卡片内容点击进入详情');
  card().dispatchEvent(new board.w.MouseEvent('click', { bubbles: true, button: 0, ctrlKey: true })); assert.equal(navigations, 1, '修饰键不劫持导航');
  card().dispatchEvent(new board.w.MouseEvent('click', { bubbles: true, button: 1 })); assert.equal(navigations, 1, '非主键不劫持导航');
  const text = card().querySelector('.card-desc').firstChild, range = board.w.document.createRange(); range.setStart(text, 0); range.setEnd(text, 3); board.w.getSelection().addRange(range);
  card().click(); assert.equal(navigations, 1, '选择文字不跳页'); board.w.getSelection().removeAllRanges();
  card().querySelector('[data-status-action="edit"]').click(); assert.equal(navigations, 1, '编辑按钮不触发整卡跳页');
  const textarea = card().querySelector('textarea'); assert(textarea); textarea.click(); assert.equal(navigations, 1, '状态输入框不触发跳页');
  textarea.value = '只在卡片输入，未保存'; textarea.dispatchEvent(new board.w.Event('input', { bubbles: true })); assert.equal(navigations, 1);
  card().querySelector('.card-name a').click(); assert.equal(navigations, 2, '原详情链接只导航一次');
  card().dispatchEvent(new board.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.equal(navigations, 3, '卡片键盘进入详情');
  textarea.dispatchEvent(new board.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.equal(navigations, 3, '输入换行不触发卡片导航');
  checks.push('卡片移除四个项目日期而详情原值保留，继续显示真实最近检查时间；今日/从未检查区分；资料/标签/简介/阶段与整卡点击保持，文字选择/原位编辑/输入不导航');
  const midnight = Date.parse(day + 'T00:00:00+08:00') + 86400000, nextDay = new Date(midnight + 8 * 3600000).toISOString().slice(0, 10);
  const next = await projectReads(runtime, () => new Date(midnight)).list({ view: 'all', search: prefix, dashboard: '1' }, actor);
  assert.deepEqual(next.globalChecks, await counts(nextDay)); const nextProject = next.items.find(item => item.id === ids[0]);
  assert.equal(nextProject.checkedToday, false); assert.equal(nextProject.checkStatus.latest.checkedAt, fact.checkedAt); assert.equal(nextProject.version, saved.version);
  board.simulateDate(midnight); const readsBefore = board.reads.length; for (const tick of board.intervals) tick();
  await waitFor(() => board.reads.length > readsBefore && board.reads.at(-1).businessDate === nextDay && board.$('#card-grid').getAttribute('aria-busy') === 'false', '跨日定时补读');
  assert.equal(card().querySelector('.board-check-state').textContent, '○ 已 1 天未检查'); assert(card().querySelector('time[datetime="' + fact.checkedAt + '"]'));
  assert.equal(card().querySelector('textarea').value, '只在卡片输入，未保存', '跨日刷新保留未保存输入');
  const [year, month] = day.split('-').map(Number);
  for (const at of new Set([Date.UTC(year, month, 1) - 8 * 3600000, Date.UTC(year + 1, 0, 1) - 8 * 3600000])) {
    const targetDay = new Date(at + 8 * 3600000).toISOString().slice(0, 10);
    const days = (Date.parse(targetDay) - Date.parse(day)) / 86400000;
    board.simulateDate(at); const oldReads = board.reads.length; for (const tick of board.intervals) tick();
    await waitFor(() => board.reads.length > oldReads && board.reads.at(-1).businessDate === targetDay && board.$('#card-grid').getAttribute('aria-busy') === 'false', '跨月或跨年读取业务日');
    assert.equal(card().querySelector('.board-check-state').textContent, `○ 已 ${days} 天未检查`);
    assert.equal(card().querySelector('time[datetime="' + fact.checkedAt + '"]').textContent, localTime);
    assert.equal(board.$('[data-project-id="' + ids[1] + '"] .board-check-state').textContent, '○ 尚未检查', '从未检查不能编造未查天数');
    assert.equal(card().querySelector('textarea').value, '只在卡片输入，未保存');
  }
  assert.deepEqual((await api(path)).project, saved, '读取跨日投影不能改正式项目');
  checks.push('上海自然日跨日不足24小时显示1天未检查；跨月/跨年从服务端businessDate计算天数，最近时间/版本保持；真实首页定时事件消费投影且保留未保存输入（非真实等候过夜）');
  await risk({ op: 'resolve', id: riskHigh, resolution: '备选供应已确认' }, { unresolvedCount: 1, highestLevel: 'mid' });
  await risk({ op: 'delete', id: riskMid }, { unresolvedCount: 0, highestLevel: null });
  const retainedRisks = await sql('SELECT CAST(id AS CHAR) id,level,resolved,deleted_at deletedAt FROM project_risks WHERE project_id=? ORDER BY id', [ids[1]]);
  assert.equal(retainedRisks.length, 2); assert.equal(retainedRisks[0].id, riskHigh); assert.equal(retainedRisks[0].resolved, 1); assert.equal(retainedRisks[0].deletedAt, null); assert(retainedRisks[1].deletedAt);
  checks.push('风险真实新增/等级纠正/解除/删除后新列表摘要计数及最高等级一致；解除与误录删除保留各自SQL事实且不计当前风险');
  const build = (await api('/api/health/live')).build;
  for (const dom of views) dom.window.document.dispatchEvent(new dom.window.Event('geekdash-identity-changed'));
  await Promise.allSettled([...pending]);
  await api('/api/auth/logout', 'POST', {}); assert.equal((await request('/api/auth/me')).status, 401);
  if (keepNative) await writeFile('test-results/board-cards-native-private.json', JSON.stringify({ projectId: ids[0], actorId: actor, loginName: prefix, password, syntheticOnly: true, database: 'geekdash_test', serverUuid: process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID, build }, null, 2) + '\n', { mode: 0o600 });
  await writeFile('test-results/board-cards.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount, build, projectId: ids[0], savedVersion: saved.version, checkTime: fact.checkedAt, globalCountsBefore: expectedBefore, globalCountsAfter: expectedAfter, isolatedTestDatabase: true, nativeBrowserAcceptance: false, overnightWallClockWait: false, nativeFixtureRetained: keepNative, ownSessionLoggedOut: true }, null, 2) + '\n');
  passed = true;
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount }));
} finally {
  for (const dom of views) dom.window.document.dispatchEvent(new dom.window.Event('geekdash-identity-changed'));
  await Promise.allSettled([...pending]); await new Promise(done => setTimeout(done, 30));
  for (const dom of views) dom.window.close(); if (app) await app.close();
  if (actor) await c.execute('DELETE FROM project_drafts WHERE user_id=?', [actor]);
  for (const id of ids.filter(id => !(keepNative && passed && id === ids[0]))) {
    for (const table of ['audit_log', 'project_checks', 'project_risks', 'project_stages', 'project_people', 'project_chips', 'project_tags', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]);
    await c.execute("DELETE FROM command_receipts WHERE actor_id=? AND JSON_UNQUOTE(JSON_EXTRACT(response_json,'$.projectId'))=?", [actor, id]);
    await c.execute('DELETE FROM projects WHERE id=?', [id]);
  }
  if (!(keepNative && passed)) {
    for (const [table, id] of references.reverse()) { if (table === 'customers') await c.execute('DELETE FROM customer_tags WHERE customer_id=?', [id]); await c.execute('DELETE FROM ' + table + ' WHERE id=?', [id]); }
    if (actor) { for (const table of ['command_receipts', 'audit_log']) await c.execute('DELETE FROM ' + table + ' WHERE actor_id=?', [actor]); for (const table of ['user_preferences', 'sessions']) await c.execute('DELETE FROM ' + table + ' WHERE user_id=?', [actor]); await c.execute('DELETE FROM users WHERE id=?', [actor]); }
  }
  await c.end();
}
