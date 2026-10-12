import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectActions, validateAction } from '../dist/server/modules/project-actions.js';
import { publicSettings, validateRule } from '../dist/server/modules/public-settings.js';
import { addDays, businessToday, weekContext } from '../dist/server/modules/project-dates.js';

const { connection: c } = await connectDatabase('test_migrator');
const prefix = 'start_' + randomUUID().slice(0, 8), password = '启动验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '', ownConfig = false;
const serve = process.argv.includes('--serve'), authOrigin = serve ? 'http://127.0.0.1:41863' : 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app');
  const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) {
      if (fault && fault !== 'ack' && sql.startsWith(fault)) return execute.call(this, 'INSERT INTO __missing_start_test_table VALUES (1)');
      return execute.call(this, sql, params);
    };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw new Error('lost acknowledgement'); };
    try { return await work(lease); } finally { lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: authOrigin, secure: false }); origin = await app.listen({ host: serve ? '0.0.0.0' : '127.0.0.1', port: serve ? 3000 : 0 });
}
function client() {
  let cookie = '', csrf = '', account;
  return { get cookie() { return cookie; }, async api(path, method = 'GET', body, status = 200) {
    const began = performance.now();
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
    const data = await response.json(); if (Array.isArray(status)) { assert.ok(status.includes(response.status), path + ': ' + JSON.stringify(data)); data.httpStatus = response.status; } else assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
    if (path === '/api/auth/me' && status === 200) account = data.account;
    measurements.push({ path, status, ms: performance.now() - began }); return data;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); } };
}
async function fresh(id) {
  const { connection } = await connectDatabase('test_app');
  try { return {
    p: (await connection.query("SELECT CAST(version AS CHAR) version,status,DATE_FORMAT(started_on,'%Y-%m-%d') startDate,DATE_FORMAT(original_due_date,'%Y-%m-%d') originalDueDate,DATE_FORMAT(current_due_date,'%Y-%m-%d') dueDate,DATE_FORMAT(first_check_week,'%Y-%m-%d') firstCheckWeek,CAST(first_check_rule_version AS CHAR) ruleVersion FROM projects WHERE id=?", [id]))[0][0],
    stages: (await connection.query("SELECT stage_code,state,DATE_FORMAT(started_on,'%Y-%m-%d') startedOn,DATE_FORMAT(completed_on,'%Y-%m-%d') completedOn FROM project_stages WHERE project_id=? ORDER BY stage_code", [id]))[0],
    schedules: (await connection.query("SELECT kind,DATE_FORMAT(old_date,'%Y-%m-%d') oldDate,DATE_FORMAT(new_date,'%Y-%m-%d') newDate,reason FROM schedule_changes WHERE project_id=? ORDER BY id", [id]))[0],
    counts: (await connection.query('SELECT (SELECT COUNT(*) FROM project_checks WHERE project_id=?) checks,(SELECT COUNT(*) FROM audit_log WHERE project_id=?) audits,(SELECT COUNT(*) FROM command_receipts WHERE command_scope LIKE CONCAT(\'user:%:project:\',?,\':actions\')) receipts', [id, id, id]))[0][0],
  }; } finally { await connection.end(); }
}
const body = (detail, extra = {}) => ({ action: 'startProject', actualDate: '2020-01-09', dueDate: '2020-01-20', expectedVersion: detail.project.version, configVersion: detail.checkRule.configVersion, ruleVersion: detail.checkRule.rule?.version ?? '1', previewWeek: detail.checkRule.weekStart, previewFirstCheckWeek: detail.checkRule.firstCheckWeek ?? detail.checkRule.weekStart, idempotencyKey: randomUUID(), ...extra });
async function proposal(a) {
  const id = (await a.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix } })).result.projectId; projects.push(id);
  for (const action of ['startStage', 'completeStage']) await a.api('/api/projects/' + id + '/actions', 'POST', { action, stageCode: 'S1', actualDate: '2020-01-06', expectedVersion: action === 'startStage' ? '1' : '2', idempotencyKey: randomUUID() });
  return id;
}
try {
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM system_configuration'))[0][0].n), 0, 'test configuration occupied; do not overwrite');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM check_rule_revisions'))[0][0].n), 0);
  const hash = await hashPassword(password);
  for (let index = 0; index < 3; index++) { const loginName = prefix + '_' + index; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '启动合成账号' + index]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await c.execute("INSERT INTO system_configuration (id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))", [users[2].id, users[2].id]); ownConfig = true;
  await start(); const a = client(), b = client(), maint = client(); await a.login(0); await b.login(1); await maint.login(2);
  const id = await proposal(a), path = '/api/projects/' + id;
  let detail = await a.api(path), before = await fresh(id); assert.equal(detail.startBlocked, 'CHECK_RULE_REQUIRED');
  await a.api(path + '/actions', 'POST', body(detail), 422); assert.deepEqual(await fresh(id), before);
  let settings = await maint.api('/api/settings/check-rule'); assert.equal(settings.rule, null); assert.equal(settings.canMaintain, true);
  const initialize = { action: 'initializeCheckRule', deadlineWeekday: 5, expectedVersion: settings.configVersion, previewWeek: settings.weekStart, idempotencyKey: randomUUID() };
  await a.api('/api/settings/check-rule', 'POST', initialize, 403);
  assert.equal((await maint.api('/api/settings/check-rule', 'POST', { ...initialize, previewWeek: '2020-01-06', idempotencyKey: randomUUID() }, 409)).code, 'CHECK_PREVIEW_CHANGED');
  for (const target of ['INSERT INTO check_rule_revisions', 'INSERT INTO audit_log', 'INSERT INTO command_receipts']) { fault = target; await maint.api('/api/settings/check-rule', 'POST', { ...initialize, idempotencyKey: randomUUID() }, 503); fault = ''; assert.equal((await maint.api('/api/settings/check-rule')).rule, null); }
  const rule = await maint.api('/api/settings/check-rule', 'POST', initialize); assert.equal(rule.result.savedVersion, '2'); assert.equal((await maint.api('/api/settings/check-rule')).rule.deadlineWeekday, 5);
  assert.deepEqual((await maint.api('/api/settings/check-rule', 'POST', initialize)).result, rule.result);
  await maint.api('/api/settings/check-rule', 'POST', { ...initialize, expectedVersion: '2', idempotencyKey: randomUUID() }, 422);
  assert.equal((await a.api('/api/settings/check-rule/results/query', 'POST', initialize)).outcome, 'not_found');
  checks.push('维护资格、真实初始化及新GET消费；规则/审计/回执SQL失败全回滚，原编号不重复初始化');
  detail = await a.api(path); const command = body(detail);
  await b.api(path + '/actions', 'POST', command, 403);
  for (const extra of [{ dueDate: '2020-01-08' }, { actualDate: '2020-01-05' }, { actualDate: '9999-01-01' }, { actualDate: '2020-02-30' }]) await a.api(path + '/actions', 'POST', { ...command, ...extra, idempotencyKey: randomUUID() }, 422);
  await a.api(path + '/actions', 'POST', { ...command, actorId: users[1].id }, 400);
  for (const extra of [{ configVersion: '1' }, { previewFirstCheckWeek: '2020-01-06' }, { previewWeek: '2020-01-06' }]) assert.equal((await a.api(path + '/actions', 'POST', { ...command, ...extra, idempotencyKey: randomUUID() }, 409)).code, 'CHECK_PREVIEW_CHANGED');
  assert.deepEqual(await fresh(id), before); checks.push('身份/版本/日期/规则及跨周预览拒绝，未保存状态/计划/义务保持');
  for (const target of ["UPDATE projects SET status='ongoing'", 'INSERT INTO audit_log', 'INSERT INTO command_receipts']) { fault = target; await a.api(path + '/actions', 'POST', { ...command, idempotencyKey: randomUUID() }, 503); fault = ''; assert.deepEqual(await fresh(id), before); }
  const started = await a.api(path + '/actions', 'POST', command); assert.equal(started.result.savedVersion, '4');
  const saved = await fresh(id); assert.equal(saved.p.status, 'ongoing'); assert.equal(saved.p.startDate, command.actualDate); assert.equal(saved.p.originalDueDate, command.dueDate); assert.equal(saved.p.firstCheckWeek, detail.checkRule.firstCheckWeek); assert.equal(Number(saved.counts.checks), 0); assert.equal(saved.stages[1].state, 'ready');
  assert.equal((await a.api('/api/projects?view=active&search=' + prefix)).items.some(p => p.id === id), true);
  await a.api(path + '/actions', 'POST', { ...command, expectedVersion: '4', idempotencyKey: randomUUID() }, 422);
  await a.api(path + '/actions', 'POST', { action: 'startStage', stageCode: 'S2', actualDate: '2020-01-07', expectedVersion: '4', idempotencyKey: randomUUID() });
  await a.api(path + '/actions', 'POST', { action: 'completeStage', stageCode: 'S2', actualDate: '2020-01-08', expectedVersion: '5', idempotencyKey: randomUUID() });
  assert.equal((await fresh(id)).stages[1].state, 'completed'); assert.equal((await a.api(path)).project.progress, '10');
  checks.push('真实创建→S1→明确启动→新连接/看板/首次义务→S2补录早于启动且符合相邻顺序；启动不自动检查或开始阶段');
  const old = await proposal(a); await c.execute("UPDATE projects SET created_by=NULL,current_due_date='2020-01-15' WHERE id=?", [old]); before = await fresh(old); let older = await a.api('/api/projects/' + old);
  await a.api('/api/projects/' + old + '/actions', 'POST', body(older), 422); assert.deepEqual(await fresh(old), before);
  fault = 'INSERT INTO schedule_changes'; await a.api('/api/projects/' + old + '/actions', 'POST', body(older, { planReason: '真实同时改期' }), 503); fault = ''; assert.deepEqual(await fresh(old), before);
  await a.api('/api/projects/' + old + '/actions', 'POST', body(older, { planReason: '真实同时改期' })); const revised = await fresh(old); assert.equal(revised.p.originalDueDate, null); assert.deepEqual(revised.schedules.map(({ kind, oldDate, newDate, reason }) => ({ kind, oldDate, newDate, reason })), [{ kind: 'reschedule', oldDate: '2020-01-15', newDate: '2020-01-20', reason: '真实同时改期' }]);
  const retain = await proposal(a); await c.execute("UPDATE projects SET created_by=NULL,current_due_date='2020-01-20' WHERE id=?", [retain]); older = await a.api('/api/projects/' + retain); await a.api('/api/projects/' + retain + '/actions', 'POST', body(older)); assert.equal((await fresh(retain)).p.originalDueDate, null); assert.equal((await fresh(retain)).schedules.length, 0);
  checks.push('首次计划、保留既有计划、未知原始保持未知；明确同次改期及计划写失败全回滚');
  const raceId = await proposal(a); await b.api('/api/projects/' + raceId + '/responsibility', 'POST', { action: 'join', expectedVersion: '3', idempotencyKey: randomUUID() }); const raced = body(await a.api('/api/projects/' + raceId));
  const results = await Promise.all([a.api('/api/projects/' + raceId + '/actions', 'POST', raced, [200, 409]), b.api('/api/projects/' + raceId + '/actions', 'POST', { ...raced, idempotencyKey: randomUUID() }, [200, 409])]);
  assert.deepEqual(results.map(r => r.httpStatus).sort(), [200, 409]); assert.equal((await fresh(raceId)).p.version, '5');
  assert.deepEqual((await a.api(path + '/actions', 'POST', command)).result, started.result);
  const lostId = await proposal(a), lost = body(await a.api('/api/projects/' + lostId)); fault = 'ack'; assert.equal((await a.api('/api/projects/' + lostId + '/actions', 'POST', lost, 503)).outcome, 'unknown'); fault = ''; await app.close(); app = undefined; await start();
  const result = await a.api('/api/projects/' + lostId + '/action-results/query', 'POST', lost); assert.equal(result.outcome, 'committed'); assert.equal(result.result.savedVersion, '4'); assert.deepEqual((await a.api('/api/projects/' + lostId + '/actions', 'POST', lost)).result, result.result); assert.equal(Number((await fresh(lostId)).counts.audits), 4);
  checks.push('双负责人同版启动只提交一次，后来版本重放原结果；真实COMMIT丢确认/应用重建后会话与原启动结果保持');
  assert.equal(weekContext(new Date('2026-10-09T15:59:59.999Z'), 5).firstCheckWeek, '2026-10-05');
  assert.equal(weekContext(new Date('2026-10-09T16:00:00.000Z'), 5).firstCheckWeek, '2026-10-12');
  assert.equal(weekContext(new Date('2026-10-11T15:59:59.999Z'), 7).firstCheckWeek, '2026-10-05');
  assert.equal(weekContext(new Date('2026-10-11T16:00:00.000Z'), 7).firstCheckWeek, '2026-10-12');
  const week = initialize.previewWeek, nextWeek = addDays(week, 7);
  const actor = await identities(runtime).resolve(a.cookie.split('=')[1]); const clockId = await proposal(a); const saturday = new Date(addDays(week, 5) + 'T00:00:00+08:00'); const late = body(await a.api('/api/projects/' + clockId), { previewWeek: week, previewFirstCheckWeek: nextWeek });
  await projectActions(runtime, () => saturday).run(actor, clockId, validateAction(late), randomUUID(), false); assert.equal((await fresh(clockId)).p.firstCheckWeek, nextWeek);
  const maintActor = await identities(runtime).resolve(maint.cookie.split('=')[1]); await assert.rejects(publicSettings(runtime, () => new Date(week + 'T00:00:00Z')).save(maintActor, validateRule({ ...initialize, expectedVersion: '2', previewWeek: week, idempotencyKey: randomUUID() }), randomUUID(), false), e => e.code === 'CHECK_RULE_ALREADY_INITIALIZED');
  checks.push('业务周五全天/次日/周日到下一周的边界、补录过去启动仍按保存周建立义务，真实库受控时钟验证');
  const build = (await a.api('/api/health/live')).build;
  const report = { status: 'passed', checkedAt: new Date().toISOString(), checks, requests: measurements.length, build, measurements };
  const target = process.env.GEEKDASH_TEST_RESULT_DIR ?? 'test-results'; await mkdir(target, { recursive: true }); await writeFile(target + '/project-start-check.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requests: measurements.length }));
  if (serve) { const uiId = await proposal(a); await writeFile('test-results/start-browser-private.json', JSON.stringify({ origin: authOrigin, projectId: uiId, loginName: users[0].loginName, password, maintLoginName: users[2].loginName })); console.log('BROWSER_FIXTURE_READY'); await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); }
} finally {
  if (app) await app.close();
  for (const id of projects) { for (const table of ['project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute(`DELETE FROM ${table} WHERE project_id=?`, [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  if (ownConfig) { await c.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?', [users[2].id]); await c.execute('DELETE FROM check_rule_revisions WHERE saved_by=?', [users[2].id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
