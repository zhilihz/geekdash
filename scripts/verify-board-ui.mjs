import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';
import { projectReads } from '../dist/server/modules/projects.js';
import { addDays, businessWeek } from '../dist/server/modules/project-dates.js';

// 实际前端事件/API/SQL的数据链；--api供没有DOM工具的固定镜像验证，均不替代原生视觉。
const apiOnly = process.argv.includes('--api'), prefix = 'board_' + randomUUID().slice(0, 8), password = '看板整链 password 2026';
const { connection: c } = await connectDatabase('test_migrator');
const ids = [], references = [], checks = []; let app, origin, user, cookie = '', csrf, dom, requestCount = 0, ownRule;
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
  const runtime = await openRuntimeDatabase('test_app');
  app = await createApp(runtime, { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
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

  let rule = await api('/api/settings/check-rule');
  if (!rule.rule) {
    await c.execute('INSERT INTO check_rule_revisions (deadline_weekday,effective_week,saved_at,saved_by) VALUES (5,?,UTC_TIMESTAMP(3),?)', [rule.weekStart, user]);
    ownRule = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
    rule = await api('/api/settings/check-rule');
  }
  const day = rule.businessDate, start = Date.parse(day + 'T00:00:00+08:00'), end = start + 86400000;
  const sqlTime = time => new Date(time).toISOString().slice(0, 23).replace('T', ' ');
  const seedCheck = async (id, time, date) => {
    // 仅为真实SQL读取构造时点；正式检查写入在下面通过原actions验证。
    const version = (await c.query('SELECT CAST(version AS CHAR) version FROM projects WHERE id=?', [id]))[0][0].version;
    await c.execute("INSERT INTO project_checks (project_id,actor_id,checked_at,week_start,conclusion,note,rule_version,observed_version,result_version) VALUES (?,?,?,?,'checked','日界读取夹具',?,?,?)", [id, user, sqlTime(time), businessWeek(date), rule.rule.version, version, version]);
    return (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  };
  for (const [index, time, date] of [[0,start-1,addDays(day,-1)], [1,start,day], [2,end-1,day], [3,end,addDays(day,1)], [4,start+1,day], [4,start+2,day]]) await seedCheck(ids[index], time, date);
  const assertDaily = (value, checked, unchecked) => {
    assert.equal(value.stats.todayChecked, checked); assert.equal(value.stats.todayUnchecked, unchecked);
    assert.equal(value.stats.todayChecked + value.stats.todayUnchecked, value.stats.total);
    assert(value.items.every(item => typeof item.checkedToday === 'boolean' && typeof item.capabilities.canCheck === 'boolean'));
  };
  data = await api(query); assertDaily(data, 3, 28);
  const uncheckedQuery = query + '&checkToday=unchecked';
  const unchecked1 = await api(uncheckedQuery), unchecked2 = await api(uncheckedQuery + '&page=2');
  assertDaily(unchecked1, 0, 28); assertDaily(unchecked2, 0, 28);
  assert.equal(unchecked1.items.length, 24); assert.equal(unchecked2.items.length, 4);
  assert.deepEqual([...unchecked1.items, ...unchecked2.items].map(item => item.id).sort(), ids.slice(0,31).filter(id => ![ids[1],ids[2],ids[4]].includes(id)).sort());
  assert([...unchecked1.items, ...unchecked2.items].every(item => !item.checkedToday && item.capabilities.canCheck));
  const checked = await api(query + '&checkToday=checked'); assertDaily(checked, 3, 0);
  assert.deepEqual(checked.items.map(item => item.id).sort(), [ids[1],ids[2],ids[4]].sort());
  assert.equal(Number((await c.query("SELECT COUNT(DISTINCT ck.project_id) n FROM project_checks ck JOIN projects p ON p.id=ck.project_id WHERE p.name LIKE ? AND p.status='proposal' AND ck.checked_at>=? AND ck.checked_at<?", [prefix + '%',sqlTime(start),sqlTime(end)]))[0][0].n), data.stats.todayChecked);
  assertDaily(await api(query + '&customer=不存在客户&checkToday=unchecked'), 0, 0);
  assert.equal((await request(query + '&checkToday=wrong')).status, 400);
  checks.push('今日已查/未查在SQL中先过滤再24/4分页，独立SQL与数量及跨页集合一致；重复检查只计一个项目，空范围与非法日条件准确');

  const beforeMidnight = await projectReads(runtime, () => new Date(end-1)).list({view:'proposal',search:prefix,pageSize:100}, user);
  const afterMidnight = await projectReads(runtime, () => new Date(end)).list({view:'proposal',search:prefix,pageSize:100}, user);
  assertDaily(beforeMidnight, 3, 28); assertDaily(afterMidnight, 1, 30);
  assert(beforeMidnight.items.find(item => item.id === ids[2]).checkedToday);
  assert(!beforeMidnight.items.find(item => item.id === ids[3]).checkedToday);
  assert(afterMidnight.items.find(item => item.id === ids[3]).checkedToday);
  assert(!afterMidnight.items.find(item => item.id === ids[2]).checkedToday);
  const wednesday = addDays(rule.weekStart, 2), tuesday = addDays(rule.weekStart, 1);
  const weeklyOnlyId = await seedCheck(ids[5], Date.parse(tuesday + 'T12:00:00+08:00'), tuesday);
  const weeklyOnly = await projectReads(runtime, () => new Date(wednesday + 'T12:00:00+08:00')).list({view:'proposal',search:prefix+'_5'}, user);
  assert.equal(weeklyOnly.items.length, 1); assert.equal(weeklyOnly.items[0].checkStatus.latest.id, weeklyOnlyId); assert.equal(weeklyOnly.items[0].checkedToday, false);
  await c.execute('DELETE FROM project_checks WHERE id=? AND project_id=?', [weeklyOnlyId,ids[5]]);
  const noActor = await projectReads(runtime, () => new Date(end-1)).list({view:'proposal',search:prefix});
  assert(noActor.items.every(item => item.capabilities.canCheck === false));
  checks.push('真实库注入读取时钟核对上海23:59:59.999/00:00日界；周已查与今日未查分离；旧单参数读取兼容且不授予检查权限');

  for (const [id, roles] of [[ids[1],['software_owner']], [ids[2],['hardware_owner','pm']]]) for (const role of roles) await c.execute('INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,?,0)', [id,engineer,role]);
  const assertTeam = (value, expected) => { const member = value.dashboard.team.find(item => item.id === engineer); assert(member); assert.deepEqual(['count','pmCount','hardwareCount','softwareCount'].map(key => member[key]), expected); };
  assertTeam(await api(query), [3,2,2,1]);
  assertTeam(await api(query + '&productLine=' + encodeURIComponent(prefix+'_产品甲')), [2,2,2,0]);
  assertTeam(await api(query + '&productLine=' + encodeURIComponent(prefix+'_产品乙')), [1,0,0,1]);
  assertTeam(await api(query + '&checkToday=checked'), [2,1,1,1]);
  const closed = await api('/api/projects?view=closed&search='+prefix+'&dashboard=1');
  assertTeam(closed, [0,0,0,0]);
  assert.equal(closed.dashboard.focusTotal, closed.pagination.total); assert.equal(closed.dashboard.focusTotal, 1); assert.deepEqual(closed.dashboard.focus.map(item=>item.id), [ids[31]]);
  await c.execute('UPDATE projects SET maintenance_enabled=1 WHERE id=?', [ids[31]]);
  const maintenance = await api('/api/projects?view=maintenance&search='+prefix+'&dashboard=1');
  assertTeam(maintenance, [0,0,0,0]);
  assert.equal(maintenance.dashboard.focusTotal, maintenance.pagination.total); assert.equal(maintenance.dashboard.focusTotal, 1); assert.deepEqual(maintenance.dashboard.focus.map(item=>item.id), [ids[31]]);
  await c.execute('UPDATE projects SET maintenance_enabled=0 WHERE id=?', [ids[31]]);
  checks.push('驾驶舱团队随产品线/日检查范围计数，三岗位分别去重，同人多岗总数只计一项目，结案岗位与范围外项目不计入；重点列表保留已结案和量产维护当前范围');
  await c.execute("INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,'pm',0)",[ids[3],engineer]);
  assert((await api('/api/projects?view=proposal&search='+encodeURIComponent(prefix+'_工程师'))).items.some(item=>item.id===ids[3]),'仅担任项目经理也能按人员搜索');
  await c.execute("DELETE FROM project_people WHERE project_id=? AND engineer_id=? AND role='pm'",[ids[3],engineer]);

  await c.execute('DELETE FROM project_responsibilities WHERE project_id=? AND user_id=?', [ids[1],user]);
  const restricted = await api(query + '&checkToday=checked');
  assert.equal(restricted.items.find(item => item.id === ids[1]).capabilities.canCheck, false);
  assert.equal(restricted.items.find(item => item.id === ids[2]).capabilities.canCheck, true);
  const refusedBody = {action:'saveCheck',expectedVersion:restricted.items.find(item=>item.id===ids[1]).version,idempotencyKey:randomUUID(),conclusion:'checked',note:'',ruleVersion:rule.rule.version,previewWeek:rule.weekStart};
  const beforeDenied = Number((await c.query('SELECT COUNT(*) n FROM project_checks WHERE project_id=?',[ids[1]]))[0][0].n);
  const refused = await request('/api/projects/'+ids[1]+'/actions',{method:'POST',body:JSON.stringify(refusedBody)});
  assert.equal(refused.status,403); assert.equal((await refused.json()).code,'PROJECT_READ_ONLY');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_checks WHERE project_id=?',[ids[1]]))[0][0].n),beforeDenied);
  await c.execute('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))',[ids[1],user]);
  assert((await api(query+'&checkToday=checked')).items.every(item=>item.capabilities.canCheck));
  checks.push('列表权限来自登录账号负责关系；业务分工保留时失去负责权限仍可读但不能检查，403不写入，恢复负责后新GET同步');

  const lastPage = await api(uncheckedQuery+'&pageSize=1&page=28'); assert.equal(lastPage.items[0].id,ids[0]);
  const checkBody = {action:'saveCheck',expectedVersion:lastPage.items[0].version,idempotencyKey:randomUUID(),conclusion:'checked',note:'',ruleVersion:rule.rule.version,previewWeek:rule.weekStart};
  const savedCheck = await api('/api/projects/'+ids[0]+'/actions','POST',checkBody); assert.equal(savedCheck.outcome,'committed');
  const savedRow = (await c.query('SELECT CAST(actor_id AS CHAR) actorId,CAST(observed_version AS CHAR) observedVersion,CAST(result_version AS CHAR) resultVersion,conclusion,note FROM project_checks WHERE id=? AND project_id=?',[savedCheck.result.checkId,ids[0]]))[0][0];
  assert.deepEqual({...savedRow},{actorId:user,observedVersion:checkBody.expectedVersion,resultVersion:savedCheck.result.savedVersion,conclusion:'checked',note:''});
  const savedAudit = (await c.query("SELECT COUNT(*) n FROM audit_log WHERE project_id=? AND entity_type='project_check' AND entity_id=? AND action='project.check.save'",[ids[0],savedCheck.result.checkId]))[0][0]; assert.equal(Number(savedAudit.n),1);
  data = await api(query); assertDaily(data,4,27);
  const checkedAfter = await api(query+'&checkToday=checked'); assert.equal(checkedAfter.items.find(item=>item.id===ids[0]).version,savedCheck.result.savedVersion);
  const remaining = await api(uncheckedQuery+'&page=2'); assertDaily(remaining,0,27); assert.equal(remaining.items.length,3); assert(!remaining.items.some(item=>item.id===ids[0]));
  const clamped = await api(uncheckedQuery+'&pageSize=1&page=28'); assert.equal(clamped.pagination.page,27); assert.equal(clamped.pagination.total,27); assert.equal(clamped.items.length,1);
  assert.equal((await api('/api/projects/'+ids[0]+'/checks')).items[0].id,savedCheck.result.checkId);
  assert.deepEqual((await api('/api/projects/'+ids[0]+'/action-results/query','POST',checkBody)).result,savedCheck.result);
  checks.push('通过检查走真实actions事务；独立SQL事实/审计、新GET卡片及今日计数、检查历史与原回执一致；待查末页从28回退27且24/3分页准确');
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
    assert($('#filter-rows').hidden); assert.equal($('#filter-toggle').getAttribute('aria-expanded'),'false'); assert.match($('#selected-filters').textContent,new RegExp(prefix));
    assert.equal(w.document.querySelectorAll('#filter-rows .filter-row').length,14);
    assert.match($('#today-check-count').textContent,/27/); assert.match($('#card-grid').textContent,/今日未检查/);
    const checkLink = new URL($('#check-entry').href); assert.equal(checkLink.pathname,'/project-checks.html'); assert.equal(checkLink.searchParams.get('search'),prefix); assert.equal(checkLink.searchParams.get('checkToday'),'unchecked'); assert(!checkLink.searchParams.has('page')); assert(!checkLink.searchParams.has('layout'));
    $('#filter-toggle').click(); assert.equal($('#filter-rows').hidden,false); assert.equal($('#filter-toggle').getAttribute('aria-expanded'),'true');
    const before = requestCount; $('#layout-toggle').click(); assert($('#card-grid').classList.contains('progress-layout')); assert($('#cards-view').hidden); assert(!$('#dashboard-view').hidden); assert.equal(requestCount,before);
    $('#layout-toggle').click(); assert($('#cards-view').hidden); assert(!$('#dashboard-view').hidden); assert.equal(requestCount,before);
    $('#layout-cards').click(); assert(!$('#cards-view').hidden); assert($('#dashboard-view').hidden);
    $('#next').click(); await wait(() => reads.at(-1).pagination.page === 2 && $('#card-grid').getAttribute('aria-busy') === 'false'); assert.equal(w.document.querySelectorAll('#card-grid .card').length,7);
    assert.match($('#card-grid').textContent,/今日已检查/);
    $('#layout-toggle').click(); $('#distribution').value='productLine'; $('#distribution').dispatchEvent(new w.Event('change'));
    const legend = $('#distribution-chart [data-value="'+prefix+'_产品甲"]'); assert(legend); legend.click(); await wait(() => reads.at(-1).pagination.total===16 && $('#card-grid').getAttribute('aria-busy')==='false'); assert($('#card-grid').classList.contains('progress-layout'));
    $('#filter-toggle').click(); assert($('#filter-rows').hidden); assert.match($('#selected-filters').textContent,new RegExp('产品线：'+prefix+'_产品甲'));
    holdNext=true; $('#reload').click(); await wait(() => releaseOld); assert.equal(heldData.pagination.total,16); assert.equal($('#check-entry').getAttribute('href'),null);
    const previousReads=reads.length; $('#filter-toggle').click(); const other=$('#filter-rows [data-value="'+prefix+'_产品乙"]'); assert(other); other.click();
    await wait(() => reads.length>previousReads && reads.at(-1).pagination.total===15 && $('#card-grid').getAttribute('aria-busy')==='false');
    const newest=$('#card-grid').innerHTML; releaseOld(); await new Promise(resolve=>setTimeout(resolve,50)); assert.equal($('#card-grid').innerHTML,newest); assert.match($('#selected-filters').textContent,new RegExp('产品线：'+prefix+'_产品乙')); assert.match($('#stats-bar').textContent,/15/);
    $('#filter-rows [data-value="'+prefix+'_产品乙"]').click(); await wait(()=>reads.at(-1).pagination.total===31 && $('#card-grid').getAttribute('aria-busy')==='false'); assert(!new URL(w.location.href).searchParams.has('productLine'));
    $('#filter-rows [data-value="'+prefix+'_产品甲"]').click(); await wait(()=>reads.at(-1).pagination.total===16 && $('#card-grid').getAttribute('aria-busy')==='false');
    $('#filter-toggle').click(); $('#selected-filters [data-remove-filter="productLine"]').click(); await wait(()=>reads.at(-1).pagination.total===31 && $('#card-grid').getAttribute('aria-busy')==='false'); assert($('#filter-rows').hidden); assert.equal(w.sessionStorage.getItem('geekdash_filters_expanded'),'false');
    const preserved = $('#card-grid').innerHTML; fail=true; $('#reload').click(); await wait(() => $('#message').classList.contains('error')); assert.equal($('#card-grid').innerHTML,preserved); assert.match($('#message').textContent,/旧结果/);
    assert.equal($('#check-entry').getAttribute('aria-disabled'),'true'); assert.equal($('#check-entry').getAttribute('href'),null);
    $('#clear').click(); await wait(()=>$('#card-grid').getAttribute('aria-busy')==='false' && !new URL(w.location.href).searchParams.has('search')); assert.equal(new URL(w.location.href).searchParams.get('view'),'proposal'); assert.equal(new URL(w.location.href).searchParams.get('layout'),'progress'); assert($('#selected-filters').hidden);
    assert.equal(errors.length,0); checks.push('实际board.ts事件与API：14维完整筛选、折叠后逐项取消、重复选中取消、清空保持范围/布局；日标记及检查入口继承范围；布局切换不重取；分页/图例联动、账号唯一；旧响应不覆盖新卡片，读取失败保留完整旧结果；CSS/原生另验');
  }
  const build = (await api('/api/health/live')).build;
  const result = { status:'passed', checkedAt:new Date().toISOString(), checks, requestCount, build, ...(sourceHashes ? { sourceHashes } : {}), isolatedTestDatabase:true, syntheticOnly:true, domExecution:!apiOnly, nativeBrowserAcceptance:false, visualAcceptance:false };
  await writeFile('test-results/board-ui-check.json',JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify({status:result.status,groups:checks.length,requestCount}));
} finally {
  dom?.window.close(); if(app)await app.close();
  for(const id of ids) { for(const table of ['project_changes','project_risks','project_nodes','project_checks','schedule_changes','audit_log','project_stages','project_responsibilities','project_chips','project_people','project_tags'])await c.execute('DELETE FROM '+table+' WHERE project_id=?',[id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')",[id]); await c.execute('DELETE FROM projects WHERE id=?',[id]); }
  for(const item of references)await c.execute('DELETE FROM '+item.table+' WHERE id=?',[item.id]);
  if(ownRule)await c.execute('DELETE FROM check_rule_revisions WHERE version=? AND saved_by=?',[ownRule,user]);
  if(user) { for(const table of ['command_receipts','audit_log'])await c.execute('DELETE FROM '+table+' WHERE actor_id=?',[user]); await c.execute('DELETE FROM sessions WHERE user_id=?',[user]); await c.execute('DELETE FROM users WHERE id=?',[user]); } await c.end();
}
