import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

// 实际前端事件/API/SQL的数据链；--api供没有DOM工具的固定镜像验证，均不替代原生视觉。
const apiOnly = process.argv.includes('--api'), prefix = 'board_' + randomUUID().slice(0, 8), password = '看板整链 password 2026';
const { connection: c } = await connectDatabase('test_migrator');
const ids = [], references = [], checks = []; let app, origin, user, cookie = '', csrf, dom, requestCount = 0;
async function request(path, options = {}) {
  requestCount++;
  const response = await fetch(origin + path, { ...options, headers: { Origin: 'http://localhost', Cookie: cookie, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', ...(csrf ? { 'X-GeekDash-CSRF': csrf } : {}), ...(user ? { 'X-GeekDash-Account': user } : {}), ...options.headers } });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) { cookie = cookies.map(value => value.split(';')[0]).join('; '); csrf = /geekdash_dev_csrf=([^;]+)/.exec(cookie)?.[1]; }
  return response;
}
async function api(path, method = 'GET', body) { const response = await request(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.equal(response.status, 200, path + ': ' + data.code); return data; }
const query = '/api/projects?view=proposal&search=' + prefix + '&dashboard=1';
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix, await hashPassword(password), '看板合成账号']);
  user = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  app = await createApp(await openRuntimeDatabase('test_app'), { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
  await api('/api/auth/login', 'POST', { loginName: prefix, password }); await api('/api/auth/me');
  for (const table of ['product_lines', 'engineers']) {
    const names = table === 'product_lines' ? [prefix + '_产品甲', prefix + '_产品乙'] : [prefix + '_工程师'];
    for (const name of names) { await c.execute(`INSERT INTO ${table} (name,${table === 'engineers' ? 'role,' : ''}created_at,updated_at) VALUES (?,${table === 'engineers' ? "'hardware'," : ''}UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [name]); references.push({ table, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  }
  for (let i = 0; i < 32; i++) {
    const result = (await api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '_' + i, summaryNote: '卡片简介' + i } })).result; ids.push(result.projectId);
    // 只读投影夹具；真实状态动作的建立路径由E04整链单独验收。
    await c.execute('UPDATE projects SET product_line_id=?,priority=?,status=? WHERE id=?', [references[i % 2].id, i === 0 ? 'high' : 'low', i === 31 ? 'closed' : 'proposal', result.projectId]);
  }
  const engineer = references.find(item => item.table === 'engineers').id;
  for (const [id, roles] of [[ids[0], ['hardware_owner', 'pm']], [ids[31], ['software_owner']]]) for (const role of roles) await c.execute('INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,?,0)', [id, engineer, role]);
  let data = await api(query);
  assert.equal(data.items.length, 24); assert.equal(data.stats.total, 31); assert.equal(data.dashboard.focusTotal, 31); assert.equal(data.dashboard.focus.length, 12);
  assert.equal(data.dashboard.focus[0].id, ids[0]); assert.equal(data.dashboard.team.find(item => item.id === engineer).count, 1);
  assert.deepEqual(data.dashboard.distributions.productLine.map(item => item.count).sort((a,b)=>a-b), [15,16]);
  const page2 = await api(query + '&page=2'); assert.equal(page2.items.length, 7); assert.deepEqual(page2.dashboard.distributions, data.dashboard.distributions);
  const filtered = await api(query + '&productLine=' + encodeURIComponent(prefix + '_产品甲')); assert.equal(filtered.stats.total, 16); assert.equal(filtered.dashboard.distributions.productLine.length, 1);
  const empty = await api(query + '&customer=不存在客户'); assert.equal(empty.stats.total, 0); assert.equal(empty.dashboard.focus.length, 0); assert.equal(empty.dashboard.latest.length, 0);
  assert.equal((await request('/api/projects?dashboard=wrong')).status, 400);
  checks.push('31项完整筛选投影与24/7分页；分布/重点跨页相同，真实重复职责按项目去重且结案排除；空范围与非法查询准确');
  const target = data.items[0].id, current = await api('/api/projects/' + target);
  await api('/api/projects/' + target, 'PATCH', { expectedVersion: current.project.version, idempotencyKey: randomUUID(), changes: { summaryNote: '真实保存的新简介', statusDesc: '真实保存的新状态' } });
  data = await api(query); assert.equal(data.items.find(item => item.id === target).summaryNote, '真实保存的新简介'); assert.equal(data.dashboard.latest[0].id, target);
  assert.equal((await c.query('SELECT summary_note,status_description FROM projects WHERE id=?', [target]))[0][0].summary_note, '真实保存的新简介');
  checks.push('普通保存真实事务后新GET/独立SQL/卡片简介及最近状态消费同一项目');
  let sourceHashes;
  if (!apiOnly) {
    const { JSDOM, VirtualConsole } = await import(process.env.GEEKDASH_DOM_LIBRARY ?? '../test-results/ui-dom-tools/node_modules/jsdom/lib/api.js');
    const ts = await import('typescript'), errors = [], reads = [];
    const sources = Object.fromEntries(await Promise.all(['src/web/index.html','src/web/board.ts','src/web/shared/api.ts'].map(async name => [name, await readFile(name, 'utf8')])));
    sourceHashes = Object.fromEntries(Object.entries(sources).map(([key,value]) => [key, createHash('sha256').update(value).digest('hex')]));
    const console = new VirtualConsole(); console.on('jsdomError', error => errors.push(error));
    dom = new JSDOM(sources['src/web/index.html'], { url: origin + '/?view=proposal&search=' + prefix, runScripts: 'outside-only', virtualConsole: console }); const w = dom.window;
    const stageSource = (await readFile('geekdashdesktop/projects-data.js','utf8')).match(/const STAGES = (\[[\s\S]*?\n  \]);/); assert(stageSource);
    Object.assign(w, { TextEncoder, TextDecoder, AbortController, AbortSignal, __GEEKDASH_STAGES__: vm.runInNewContext(stageSource[1], Object.create(null), { timeout: 1000 }) });
    w.BroadcastChannel = class { postMessage() {} }; w.scrollTo = () => {};
    let fail = false, holdNext = false, releaseOld, heldData;
    w.fetch = async (path, options) => {
      if (fail && path.startsWith('/api/projects?')) { fail = false; return new Response(JSON.stringify({ code: 'DATABASE_UNAVAILABLE' }), { status: 503 }); }
      const hold = holdNext && path.startsWith('/api/projects?'); if (hold) holdNext = false;
      const response = await request(path, options);
      if (path.startsWith('/api/projects?') && response.ok) { const data = await response.clone().json(); reads.push(data); if (hold) { heldData = data; await new Promise(resolve => { releaseOld = resolve; }); } }
      return response;
    };
    const context = dom.getInternalVMContext(), transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
    context.exports = {}; context.module = { exports: context.exports }; vm.runInContext('(function(exports,module){' + transpile(sources['src/web/shared/api.ts']) + '\n})(exports,module)', context);
    const shared = context.module.exports; context.require = name => { if (name === './shared/api') return shared; if (name.endsWith('.css')) return {}; throw new Error(name); };
    vm.runInContext('(function(){' + transpile(sources['src/web/board.ts']) + '\n})()', context);
    const $ = selector => w.document.querySelector(selector), wait = async predicate => { const end = Date.now()+10000; while(Date.now()<end) { if(errors.length)throw errors[0]; if(predicate())return; await new Promise(resolve=>setTimeout(resolve,20)); } throw new Error('看板未出现预期结果'); };
    await wait(() => $('#card-grid').getAttribute('aria-busy') === 'false' && reads.length);
    assert.equal(w.document.querySelectorAll('#card-grid .card').length,24); assert.match($('#card-grid').textContent,/真实保存的新简介/); assert.match($('#focus-projects').textContent,new RegExp(prefix+'_0'));
    assert.match($('#date-zone').textContent,/2026年/); assert.equal(w.document.querySelectorAll('#account-menu').length,1);
    assert($('#filter-rows').hidden); assert.equal($('#filter-toggle').getAttribute('aria-expanded'),'false'); assert.match($('#result-count').textContent,new RegExp(prefix));
    $('#filter-toggle').click(); assert.equal($('#filter-rows').hidden,false); assert.equal($('#filter-toggle').getAttribute('aria-expanded'),'true');
    const before = requestCount; $('#layout-toggle').click(); assert($('#card-grid').classList.contains('progress-layout')); assert.equal(requestCount,before);
    $('#next').click(); await wait(() => reads.at(-1).pagination.page === 2 && $('#card-grid').getAttribute('aria-busy') === 'false'); assert.equal(w.document.querySelectorAll('#card-grid .card').length,7);
    const legend = $('#distribution-chart [data-value="'+prefix+'_产品甲"]'); assert(legend); legend.click(); await wait(() => reads.at(-1).pagination.total===16 && $('#card-grid').getAttribute('aria-busy')==='false'); assert($('#card-grid').classList.contains('progress-layout'));
    $('#filter-toggle').click(); assert($('#filter-rows').hidden); assert.match($('#result-count').textContent,new RegExp('产品线：'+prefix+'_产品甲'));
    holdNext=true; $('#reload').click(); await wait(() => releaseOld); assert.equal(heldData.pagination.total,16);
    const previousReads=reads.length; $('#filter-toggle').click(); const other=$('#filter-rows [data-value="'+prefix+'_产品乙"]'); assert(other); other.click();
    await wait(() => reads.length>previousReads && reads.at(-1).pagination.total===15 && $('#card-grid').getAttribute('aria-busy')==='false');
    const newest=$('#card-grid').innerHTML; releaseOld(); await new Promise(resolve=>setTimeout(resolve,50)); assert.equal($('#card-grid').innerHTML,newest); assert.match($('#result-count').textContent,new RegExp('产品线：'+prefix+'_产品乙')); assert.match($('#stats-bar').textContent,/15/);
    const preserved = $('#card-grid').innerHTML; fail=true; $('#reload').click(); await wait(() => $('#message').classList.contains('error')); assert.equal($('#card-grid').innerHTML,preserved); assert.match($('#message').textContent,/旧结果/);
    assert.equal(errors.length,0); checks.push('实际board.ts事件与API：筛选默认收起/展开/当前条件；切换布局不重取；分页/图例联动、账号唯一；迟到旧响应不覆盖新卡片/条件/统计，读取失败保留完整旧结果；CSS/原生未验');
  }
  const build = (await api('/api/health/live')).build;
  const result = { status:'passed', checkedAt:new Date().toISOString(), checks, requestCount, build, ...(sourceHashes ? { sourceHashes } : {}), isolatedTestDatabase:true, syntheticOnly:true, domExecution:!apiOnly, nativeBrowserAcceptance:false, visualAcceptance:false };
  await writeFile('test-results/board-ui-check.json',JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify({status:result.status,groups:checks.length,requestCount}));
} finally {
  dom?.window.close(); if(app)await app.close();
  for(const id of ids) { for(const table of ['project_changes','project_risks','project_nodes','project_checks','schedule_changes','audit_log','project_stages','project_responsibilities','project_chips','project_people','project_tags'])await c.execute('DELETE FROM '+table+' WHERE project_id=?',[id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')",[id]); await c.execute('DELETE FROM projects WHERE id=?',[id]); }
  for(const item of references)await c.execute('DELETE FROM '+item.table+' WHERE id=?',[item.id]);
  if(user) { for(const table of ['command_receipts','audit_log'])await c.execute('DELETE FROM '+table+' WHERE actor_id=?',[user]); await c.execute('DELETE FROM sessions WHERE user_id=?',[user]); await c.execute('DELETE FROM users WHERE id=?',[user]); } await c.end();
}
