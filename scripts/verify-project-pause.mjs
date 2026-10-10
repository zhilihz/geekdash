import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectActions, validateAction } from '../dist/server/modules/project-actions.js';
import { projectReads } from '../dist/server/modules/projects.js';
import { addDays, businessToday } from '../dist/server/modules/project-dates.js';

const { connection: c } = await connectDatabase('test_migrator');
const prefix = 'pause_' + randomUUID().slice(0, 8), password = '暂缓验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '', projectWrites = 0, ownConfig = false;
const authOrigin = 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app'); const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) {
      if (fault === 'middle' && sql.startsWith('UPDATE projects SET') && ++projectWrites === 2 || fault && sql.startsWith(fault)) return execute.call(this, 'INSERT INTO __missing_pause_test_table VALUES (1)');
      return execute.call(this, sql, params);
    };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw new Error('lost acknowledgement'); };
    try { return await work(lease); } finally { lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: authOrigin, secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
}
function client() {
  let cookie = '', csrf = '', account;
  return { get token() { return cookie.split('=')[1]; }, async api(path, method = 'GET', body, status = 200) {
    const began = performance.now();
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
    const data = await response.json();
    if (Array.isArray(status)) { assert(status.includes(response.status), path + ': ' + JSON.stringify(data)); data.httpStatus = response.status; } else assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
    if (path === '/api/auth/me' && status === 200) account = data.account;
    measurements.push({ path, status: response.status, ms: performance.now() - began }); return data;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); } };
}
async function create(user) { const result = await user.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix } }); projects.push(result.result.projectId); return result.result.projectId; }
async function fresh(id) {
  const { connection } = await connectDatabase('test_app');
  try { const result = {}; for (const table of ['projects', 'project_stages', 'project_checks', 'schedule_changes', 'audit_log']) result[table] = (await connection.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY id`, [id]))[0];
    result.receipts = (await connection.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0]; return result;
  } finally { await connection.end(); }
}
const command = (version, action, extra = {}) => ({ action, expectedVersion: version, idempotencyKey: randomUUID(), ...extra });
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  for (const table of ['projects', 'system_configuration', 'check_rule_revisions']) assert.equal(Number((await c.query('SELECT COUNT(*) n FROM ' + table))[0][0].n), 0, '夹具非空，先核对，不覆盖');
  const hash = await hashPassword(password);
  for (let i = 0; i < 3; i++) { const loginName = prefix + '_' + i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '暂缓合成账号' + i]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await start(); const a = client(), b = client(), maint = client(); await a.login(0); await b.login(1); await maint.login(2);
  await c.execute("INSERT INTO system_configuration (id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))", [users[2].id, users[2].id]); ownConfig = true;
  let rule = await maint.api('/api/settings/check-rule'); await maint.api('/api/settings/check-rule', 'POST', { action: 'initializeCheckRule', deadlineWeekday: 5, expectedVersion: rule.configVersion, previewWeek: rule.weekStart, idempotencyKey: randomUUID() }); rule = await maint.api('/api/settings/check-rule');
  const id = await create(a), path = '/api/projects/' + id, today = businessToday(); let version = '1';
  async function perform(action, extra = {}, user = a) {
    const body = command(version, action, extra), before = await fresh(id);
    const preview = await user.api(path + '/actions/preview', 'POST', body); assert.deepEqual(await fresh(id), before, '预览不能写业务');
    const out = (await user.api(path + '/actions', 'POST', body)).result; version = out.savedVersion;
    assert.deepEqual((await user.api(path + '/action-results/query', 'POST', body)).result, out);
    assert.deepEqual((await user.api(path + '/actions', 'POST', body)).result, out);
    assert.equal((await user.api(path)).project.version, version); return { body, out, preview };
  }
  const pause = command(version, 'pauseProject', { reason: '等待客户确认' });
  await client().api(path + '/actions', 'POST', pause, 401); await b.api(path + '/actions', 'POST', pause, 403); await b.api(path + '/actions/preview', 'POST', pause, 403);
  for (const invalid of [{ ...pause, reason: '' }, { ...pause, reason: '   ' }, { ...pause, reason: null }, { ...pause, actorId: users[0].id }, { ...pause, resumeStatus: 'ongoing' }]) await a.api(path + '/actions', 'POST', invalid, invalid.reason === '' || invalid.reason === '   ' ? 422 : 400);
  let before = await fresh(id); const proposalPause = await perform('pauseProject', { reason: pause.reason }); let detail = await a.api(path);
  assert.equal(detail.project.status, 'paused'); assert.equal(detail.project.resumeStatus, 'proposal'); assert.equal(detail.project.checkStatus.required, false); assert.deepEqual((await fresh(id)).project_stages, before.project_stages);
  const pauseId = detail.lifecycleNotes[0].id, pauseAudit = (await fresh(id)).audit_log.find(row => String(row.id) === pauseId);
  await a.api(path + '/actions', 'POST', command(version, 'pauseProject', { reason: '重复暂缓拒绝' }), 422);
  await a.api(path + '/actions', 'POST', command(version, 'startStage', { stageCode: 'S1', actualDate: today }), 422);
  const ordinary = await a.api(path, 'PATCH', { expectedVersion: version, idempotencyKey: randomUUID(), changes: { summaryNote: '暂缓期间最新说明', signal: 'red', priority: 'high' } }); version = ordinary.result.savedVersion;
  await perform('resumeProject', { note: '客户已确认' }); detail = await a.api(path); assert.equal(detail.project.status, 'proposal'); assert.equal(detail.project.resumeStatus, null); assert.equal(detail.project.summaryNote, '暂缓期间最新说明'); assert.equal(detail.project.signal, 'red'); assert.equal(detail.project.priority, 'high'); assert.equal(detail.project.firstCheckWeek, null);
  checks.push('可信身份/负责范围、严格字段及原因、提案暂缓保存此前状态、阶段推进拒绝、普通信息继续可存、恢复使用最新事实、不制造启动或首次义务');

  await perform('correctLifecycleNote', { auditId: pauseId, note: '等待客户需求确认（原说明纠正）', reason: '核对原文' });
  const resumeId = (await a.api(path)).lifecycleNotes.find(item => item.action === 'project.resume').id;
  await perform('correctLifecycleNote', { auditId: resumeId, note: '', reason: '说明误填，明确清空' });
  before = await fresh(id); const noOp = await perform('correctLifecycleNote', { auditId: resumeId, note: '', reason: '相同值' }); assert.equal(noOp.out.changed, false); assert.deepEqual((await fresh(id)).audit_log, before.audit_log);
  detail = await a.api(path); assert.equal(detail.lifecycleNotes[0].note, '等待客户需求确认（原说明纠正）'); assert.equal(detail.lifecycleNotes[0].originalNote, pause.reason); assert.equal(detail.lifecycleNotes[0].corrections.length, 1); assert.equal(detail.lifecycleNotes[1].note, '');
  assert.deepEqual((await fresh(id)).audit_log.find(row => String(row.id) === pauseId), pauseAudit, '原操作者/时间/正文不可变');
  await a.api(path + '/actions', 'POST', command(version, 'correctLifecycleNote', { auditId: pauseId, note: '', reason: '不能清空暂缓原因' }), 422);
  await a.api(path + '/actions', 'POST', command(version, 'correctLifecycleNote', { auditId: String((await fresh(id)).audit_log[0].id), note: '其他类型', reason: '拒绝' }), 404);
  const otherId = await create(a), otherPath = '/api/projects/' + otherId;
  await a.api(otherPath + '/actions', 'POST', command('1', 'pauseProject', { reason: '其他项目原记录' }));
  const foreign = (await a.api(otherPath)).lifecycleNotes[0].id;
  await a.api(path + '/actions', 'POST', command(version, 'correctLifecycleNote', { auditId: foreign, note: '不能跨项目', reason: '拒绝' }), 404);
  checks.push('原因/恢复说明有效投影、原审计不可变、恢复说明明确清空、同值无新历史/版本、暂缓原因非空及错类型/跨项目拒绝');

  await a.api(path + '/actions', 'POST', command(version, 'startStage', { stageCode: 'S1', actualDate: '2020-01-01' })); version = (BigInt(version) + 1n).toString();
  await a.api(path + '/actions', 'POST', command(version, 'completeStage', { stageCode: 'S1', actualDate: '2020-01-02' })); version = (BigInt(version) + 1n).toString();
  await a.api(path + '/actions', 'POST', command(version, 'startProject', { actualDate: '2020-01-03', dueDate: addDays(today, 10), configVersion: rule.configVersion, ruleVersion: rule.rule.version, previewWeek: rule.weekStart, previewFirstCheckWeek: rule.firstCheckWeek })); version = (BigInt(version) + 1n).toString();
  await a.api(path + '/actions', 'POST', command(version, 'startStage', { stageCode: 'S2', actualDate: '2020-01-04' })); version = (BigInt(version) + 1n).toString();
  const obligation = (await fresh(id)).projects[0].first_check_week, originalDue = (await a.api(path)).project.originalDueDate;
  await perform('pauseProject', { reason: '进行中的项目等待资料' }); before = await fresh(id);
  await a.api(path + '/actions', 'POST', command(version, 'completeStage', { stageCode: 'S2', actualDate: today }), 422);
  await a.api(path + '/actions', 'POST', command(version, 'rollbackStage', { stageCode: 'S1', reason: '真实回退需先恢复' }), 422);
  await a.api(path + '/actions', 'POST', command(version, 'correctStageFacts', { changes: [{ code: 'S2', startedOn: '2020-01-05' }], reason: '暂停中纠正误填日期' })); version = (BigInt(version) + 1n).toString();
  await perform('correctProjectDates', { changes: { dueDate: null }, reason: '暂停中明确当前计划未定' });
  await perform('resumeProject', { note: '', dueDate: addDays(today, 15) }); detail = await a.api(path);
  assert.equal(detail.project.status, 'ongoing'); assert.equal(detail.stages[1].state, 'active'); assert.equal(detail.stages[1].startedOn, '2020-01-05'); assert.equal(detail.project.originalDueDate, originalDue); assert.deepEqual((await fresh(id)).projects[0].first_check_week, obligation); assert.equal((await fresh(id)).project_checks.length, 0);
  await perform('pauseProject', { reason: '同次改期验证' });
  await a.api(path + '/actions', 'POST', command(version, 'resumeProject', { note: '', dueDate: addDays(today, 20) }), 422);
  await a.api(path + '/actions', 'POST', command(version, 'resumeProject', { note: '', dueDate: '2025-02-29', planReason: '日期错误' }), 422);
  await a.api(path + '/actions', 'POST', command(version, 'resumeProject', { note: '', dueDate: '2019-01-01', planReason: '早于启动应拒绝' }), 422);
  for (const target of ['middle', 'INSERT INTO schedule_changes', 'INSERT INTO audit_log', 'INSERT INTO command_receipts']) {
    before = await fresh(id); fault = target; projectWrites = 0;
    await a.api(path + '/actions', 'POST', command(version, 'resumeProject', { note: '恢复与改期原子', dueDate: addDays(today, 20), planReason: '明确调整' }), 503); fault = ''; assert.deepEqual(await fresh(id), before, target);
  }
  const combined = await perform('resumeProject', { note: '恢复与改期同次', dueDate: addDays(today, 20), planReason: '等待新排期' }); detail = await a.api(path);
  assert.equal(detail.delays.at(-1).reason, '等待新排期'); assert.equal(detail.delays.at(-1).oldDate, addDays(today, 15)); assert.equal(detail.project.dueDate, addDays(today, 20)); assert.deepEqual((await fresh(id)).projects[0].first_check_week, obligation);
  checks.push('真实S1/启动/S2→暂停中纠错和计划未知→恢复保持新事实/原义务；恢复改期共享日期校验和不可变历史，同事务项目/计划行/审计/回执故障全回滚');

  await b.api(path + '/responsibility', 'POST', { action: 'join', expectedVersion: version, idempotencyKey: randomUUID() }); version = (BigInt(version) + 1n).toString();
  const race = await Promise.all([a.api(path + '/actions', 'POST', command(version, 'pauseProject', { reason: '负责人甲' }), [200, 409]), b.api(path + '/actions', 'POST', command(version, 'pauseProject', { reason: '负责人乙' }), [200, 409])]); assert.equal(race.filter(out => out.httpStatus === 200).length, 1); version = (BigInt(version) + 1n).toString();
  const uncertain = command(version, 'resumeProject', { note: '真实提交后丢确认' }); fault = 'ack'; await a.api(path + '/actions', 'POST', uncertain, 503); fault = ''; await app.close(); app = undefined; await start();
  const restored = (await a.api(path + '/action-results/query', 'POST', uncertain)).result; version = restored.savedVersion; assert.equal((await a.api(path)).project.status, 'ongoing');
  assert.deepEqual((await a.api(path + '/actions', 'POST', uncertain)).result, restored); assert.equal((await b.api(path + '/action-results/query', 'POST', uncertain)).outcome, 'not_found');
  await a.api(path + '/action-results/query', 'POST', { ...uncertain, note: '换正文不应复用编号' }, 409);
  assert.deepEqual((await a.api(path + '/action-results/query', 'POST', combined.body)).result, combined.out);
  checks.push('同版本两负责人单赢家、旧版本409、真实COMMIT丢确认后应用重建、原会话/原结果保持、账号隔离和编号正文冲突拒绝');

  // 下列检查行是隔离库的已有事实夹具。B05只验查询，未把夹具插入声称检查写接口交付。
  await c.execute('UPDATE projects SET first_check_week=? WHERE id=?', [rule.weekStart, id]);
  const friday = addDays(rule.weekStart, 4), beforeDeadline = new Date(friday + 'T15:59:59.999Z'), afterDeadline = new Date(friday + 'T16:00:00.000Z');
  const readsBefore = projectReads(runtime, () => beforeDeadline), readsAfter = projectReads(runtime, () => afterDeadline);
  before = await fresh(id); assert.equal((await readsBefore.detail(id, users[0].id)).project.checkStatus.kind, 'pending'); assert.equal((await readsAfter.detail(id, users[0].id)).project.checkStatus.kind, 'overdue');
  const scope = await readsAfter.list({ view: 'all', search: prefix }); assert.equal(scope.stats.checkOverdue, 1); assert.equal(scope.stats.checkRequired, 1);
  const actor = await identities(runtime).resolve(a.token);
  const pauseControlled = command(version, 'pauseProject', { reason: '截止后暂停' }); await projectActions(runtime, () => afterDeadline).run(actor, id, validateAction(pauseControlled), randomUUID(), false); version = (BigInt(version) + 1n).toString();
  assert.equal((await readsAfter.detail(id, users[0].id)).project.checkStatus.kind, 'excluded'); assert.equal((await readsAfter.list({ view: 'all', search: prefix })).stats.checkRequired, 0);
  const resumeControlled = command(version, 'resumeProject', { note: '周六恢复立即应用本周规则' });
  const preview = await projectActions(runtime, () => afterDeadline).preview(actor, id, validateAction(resumeControlled)); assert.equal(preview.afterCheck.kind, 'overdue');
  await projectActions(runtime, () => afterDeadline).run(actor, id, validateAction(resumeControlled), randomUUID(), false); version = (BigInt(version) + 1n).toString();
  assert.equal((await readsAfter.detail(id, users[0].id)).project.checkStatus.kind, 'overdue'); assert.deepEqual((await fresh(id)).projects[0].first_check_week, before.projects[0].first_check_week); assert.equal((await fresh(id)).project_checks.length, 0);
  for (const [at, observed, result] of [[new Date(beforeDeadline.getTime() - 1), version, (BigInt(version) - 1n).toString()], [new Date(afterDeadline.getTime() + 1), version, version]]) await c.execute("INSERT INTO project_checks (project_id,actor_id,checked_at,week_start,conclusion,note,rule_version,observed_version,result_version) VALUES (?,?,?,?,'checked','已有检查合成夹具',?,?,?)", [id, users[0].id, at.toISOString().slice(0, 23).replace('T', ' '), rule.weekStart, rule.rule.version, observed, result]);
  const checked = (await readsAfter.detail(id, users[0].id)).project.checkStatus; assert.equal(checked.kind, 'checked'); assert.equal(checked.onTime, true); assert.equal(checked.updatedAfterCheck, false); assert.equal(checked.latest.resultVersion, version);
  await perform('pauseProject', { reason: '检查后暂停' }); detail = await a.api(path); assert.equal(detail.project.checkStatus.required, false); assert.equal(detail.project.checkStatus.updatedAfterCheck, true);
  await perform('resumeProject', { note: '已有本周检查继续保留' }); detail = await a.api(path); assert.equal(detail.project.checkStatus.kind, 'checked'); assert.equal(detail.project.checkStatus.updatedAfterCheck, true); assert.equal((await fresh(id)).project_checks.length, 2);
  const knownChecks = (await fresh(id)).project_checks;
  await c.execute('UPDATE project_checks SET checked_at=? WHERE id=?', [new Date(afterDeadline.getTime() + 1).toISOString().slice(0, 23).replace('T', ' '), String(knownChecks[0].id)]);
  assert.equal((await readsAfter.detail(id, users[0].id)).project.checkStatus.kind, 'checked_late');
  const sundayRule = (await c.execute('INSERT INTO check_rule_revisions (deadline_weekday,effective_week,saved_by,saved_at) VALUES (7,?,?,UTC_TIMESTAMP(3))', [rule.weekStart, users[2].id]))[0].insertId;
  const beforeRuleRead = await fresh(id); assert.equal((await readsAfter.detail(id, users[0].id)).project.checkStatus.kind, 'checked'); assert.deepEqual(await fresh(id), beforeRuleRead, '同周新截止立即影响查询但不重写原检查');
  await c.execute('DELETE FROM check_rule_revisions WHERE version=?', [sundayRule]);
  await c.execute('UPDATE projects SET first_check_week=? WHERE id=?', [addDays(rule.weekStart, 7), id]); await c.execute('DELETE FROM project_checks WHERE project_id=?', [id]);
  assert.equal((await readsAfter.detail(id, users[0].id)).project.checkStatus.kind, 'not_due'); assert.equal((await readsAfter.list({ view: 'all', search: prefix })).stats.checkRequired, 0);
  await c.execute('UPDATE projects SET first_check_week=NULL WHERE id=?', [id]); assert.equal((await readsAfter.detail(id, users[0].id)).project.checkStatus.kind, 'basis_unknown');
  before = await fresh(id); const nextWeek = projectReads(runtime, () => new Date(addDays(rule.weekStart, 7) + 'T00:00:00+08:00')); assert.equal((await nextWeek.detail(id, users[0].id)).project.checkStatus.weekStart, addDays(rule.weekStart, 7)); assert.deepEqual(await fresh(id), before, '周查询不写业务');
  checks.push('上海截止毫秒两侧、暂停/恢复必查数量与逾期立即联动、首次/未来/未知依据保持、已有检查首次判按时/最新判更新、纯查询不写业务，检查行明确仅为夹具');

  await c.execute("UPDATE projects SET status='paused',resume_status=NULL WHERE id=?", [otherId]); before = await fresh(otherId);
  await a.api(otherPath + '/actions', 'POST', command('2', 'resumeProject', { note: '未知原状态不猜测' }), 422); assert.deepEqual(await fresh(otherId), before);
  await c.execute("UPDATE projects SET status='closed',resume_status=NULL WHERE id=?", [otherId]);
  await a.api(otherPath + '/actions', 'POST', command('2', 'pauseProject', { reason: '结案不能暂停' }), 422); await a.api(otherPath + '/actions', 'POST', command('2', 'resumeProject', { note: '结案不能恢复' }), 422);
  const build = (await a.api('/api/health/live')).build;
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/project-pause-check.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount: measurements.length, measurements, build, isolatedTestDatabase: true, checkWriteInterfaceDelivered: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount: measurements.length }));
} finally {
  if (app) await app.close();
  for (const id of projects) { for (const table of ['project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  if (ownConfig) { await c.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?', [users[2].id]); await c.execute('DELETE FROM check_rule_revisions WHERE saved_by=?', [users[2].id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
