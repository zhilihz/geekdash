import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';
import { projectReads } from '../dist/server/modules/projects.js';
import { addDays, businessToday, deadlineResult, validDate } from '../dist/server/modules/project-dates.js';

const { connection: c } = await connectDatabase('test_migrator');
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'dates_' + randomUUID().slice(0, 8), password = '日期验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let runtime, app, origin, fault = '', projectWrites = 0, ownConfig = false;
const serve = process.argv.includes('--serve'), authOrigin = serve ? 'http://127.0.0.1:41867' : 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app');
  const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) {
      if (fault === 'middle' && sql.startsWith('UPDATE projects SET') && ++projectWrites === 2 || fault && sql.startsWith(fault)) return execute.call(this, 'INSERT INTO __missing_plan_test_table VALUES (1)');
      return execute.call(this, sql, params);
    };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw new Error('lost acknowledgement'); };
    try { return await work(lease); } finally { lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: authOrigin, secure: false });
  origin = await app.listen({ host: serve ? '0.0.0.0' : '127.0.0.1', port: serve ? 3000 : 0 });
}
function client() {
  let cookie = '', csrf = '', account;
  return { async api(path, method = 'GET', body, status = 200) {
    const began = performance.now();
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
    const data = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
    if (path === '/api/auth/me' && status === 200) account = data.account;
    measurements.push({ path, status, ms: performance.now() - began }); return data;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); } };
}
async function create(user) { const result = await user.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix } }); projects.push(result.result.projectId); return result.result.projectId; }
async function fresh(id) {
  const { connection } = await connectDatabase('test_app');
  try { return {
    project: (await connection.query('SELECT * FROM projects WHERE id=?', [id]))[0],
    records: (await connection.query('SELECT * FROM schedule_changes WHERE project_id=? ORDER BY id', [id]))[0],
    audits: (await connection.query('SELECT * FROM audit_log WHERE project_id=? ORDER BY id', [id]))[0],
    receipts: (await connection.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0],
    stages: (await connection.query('SELECT * FROM project_stages WHERE project_id=? ORDER BY stage_code', [id]))[0],
  }; } finally { await connection.end(); }
}
const command = (version, action, extra = {}) => ({ action, expectedVersion: version, idempotencyKey: randomUUID(), ...extra });
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  for (const table of ['projects', 'system_configuration', 'check_rule_revisions']) assert.equal(Number((await c.query('SELECT COUNT(*) n FROM ' + table))[0][0].n), 0, '夹具非空，先核对，不覆盖');
  const hash = await hashPassword(password);
  for (let i = 0; i < 3; i++) { const loginName = prefix + '_' + i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '日期合成账号' + i]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await start(); const a = client(), b = client(), maint = client(); await a.login(0); await b.login(1); await maint.login(2);
  const id = await create(a), path = '/api/projects/' + id;
  let version = '1'; const today = businessToday();
  async function perform(action, extra = {}, user = a) {
    const body = command(version, action, extra), before = await fresh(id);
    const preview = await user.api(path + '/actions/preview', 'POST', body); assert.deepEqual(await fresh(id), before, '预览不能写业务');
    const out = (await user.api(path + '/actions', 'POST', body)).result; version = out.savedVersion;
    assert.deepEqual((await user.api(path + '/action-results/query', 'POST', body)).result, out);
    assert.deepEqual((await user.api(path + '/actions', 'POST', body)).result, out);
    assert.equal((await user.api(path)).project.version, version); return { body, out, preview };
  }
  const first = command('1', 'setPlan', { dueDate: addDays(today, 10) });
  await b.api(path + '/actions/preview', 'POST', first, 403); await b.api(path + '/actions', 'POST', first, 403);
  for (const invalid of [{ ...first, ownerId: users[0].id }, { ...first, dueDate: '' }, { ...first, dueDate: '2025-02-29' }]) await a.api(path + '/actions', 'POST', invalid, invalid.ownerId ? 400 : 422);
  const initial = await perform('setPlan', { dueDate: first.dueDate }); let detail = await a.api(path);
  assert.equal(detail.project.dueDate, first.dueDate); assert.equal(detail.project.originalDueDate, first.dueDate); assert.equal(detail.delays.length, 0); assert.equal(detail.project.deadline.kind, 'upcoming'); assert(!Object.hasOwn(detail.project, 'manualDelayed'));
  await a.api(path + '/actions', 'POST', command(version, 'setPlan', { dueDate: first.dueDate }), 422);
  const unchanged = await perform('reschedulePlan', { dueDate: first.dueDate, reason: '保留文字，明确未改日期', measures: '稍后补说明' }); assert.equal(unchanged.out.changed, false); assert.equal(version, initial.out.savedVersion);
  const earlier = await perform('reschedulePlan', { dueDate: addDays(today, 5), reason: '真实提前', measures: '安排资源' }); assert.equal(earlier.preview.adjustmentDays, -5);
  const firstRecord = (await a.api(path)).delays[0].id;
  await perform('reschedulePlan', { dueDate: addDays(today, 20), reason: '真实向后', measures: '' });
  const current = (await a.api(path)).project.dueDate;
  await perform('notePlan', { reason: '', measures: '追加措施，无新日期' }); detail = await a.api(path); assert.equal(detail.project.dueDate, current); assert.equal(detail.delays.at(-1).kind, 'note');
  assert.deepEqual(detail.planSummary, { reschedules: 2, laterAdjustments: 1, unknownAdjustments: 0, netDays: 10 });
  await a.api(path + '/actions', 'POST', command(version, 'notePlan', { reason: '', measures: '' }), 422);
  checks.push('可信负责人、输入白名单、首次原始/当前计划、提前与向后真实记录、同值无变化与说明保持计划；独立SQL/新HTTP/原回执');

  const originalRows = (await fresh(id)).records;
  await perform('correctScheduleRecord', { recordId: firstRecord, changes: { newDate: addDays(today, 7), reason: '原说明误写，已纠正' }, reason: '核对原记录' });
  detail = await a.api(path); assert.equal(detail.project.dueDate, current); assert.equal(detail.delays[0].reason, '原说明误写，已纠正'); assert.equal(detail.delays[0].original.reason, '真实提前');
  for (let i = 0; i < 22; i++) await perform('notePlan', { reason: '超过审计第一页 ' + i, measures: '' });
  await perform('correctScheduleRecord', { recordId: firstRecord, changes: { measures: '更晚的有效修正' }, reason: '分页后仍读取全部目标更正' });
  await perform('voidScheduleRecord', { recordId: firstRecord, reason: '第一条是误录，后续真实计划保持' });
  detail = await a.api(path); assert.equal(detail.project.dueDate, current); assert.equal(detail.delays[0].voided, true); assert.equal(detail.delays[0].measures, '更晚的有效修正'); assert.equal(detail.delays[0].corrections.length, 3);
  assert.deepEqual(detail.planSummary, { reschedules: 1, laterAdjustments: 1, unknownAdjustments: 0, netDays: 10 });
  assert.deepEqual((await fresh(id)).records.slice(0, originalRows.length), originalRows, '原改期记录不可变');
  const another = await create(a); const other = command('1', 'reschedulePlan', { dueDate: current, reason: '其他项目', measures: '' });
  await a.api('/api/projects/' + another + '/actions', 'POST', command('1', 'setPlan', { dueDate: addDays(today, 3) })); other.expectedVersion = '2'; const foreign = (await a.api('/api/projects/' + another + '/actions', 'POST', other)).result.afterValues.scheduleRecord.id;
  await a.api(path + '/actions', 'POST', command(version, 'voidScheduleRecord', { recordId: foreign, reason: '跨项目拒绝' }), 404);
  const noteId = detail.delays.find(record => record.kind === 'note').id;
  await a.api(path + '/actions', 'POST', command(version, 'correctScheduleRecord', { recordId: noteId, changes: { newDate: today }, reason: '说明不是改期' }), 422);
  await perform('voidScheduleRecord', { recordId: detail.delays.find(record => record.kind === 'reschedule' && !record.voided).id, reason: '明确同次纠正当前', currentDueDate: null });
  assert.deepEqual((await a.api(path)).planSummary, { reschedules: 0, laterAdjustments: 0, unknownAdjustments: 0, netDays: null });
  await perform('correctProjectDates', { changes: { originalDueDate: null }, reason: '原始日期也是误录，明确未知' });
  await perform('setPlan', { dueDate: current }); detail = await a.api(path); assert.equal(detail.project.originalDueDate, null);
  await perform('correctScheduleRecord', { recordId: firstRecord, changes: { oldDate: null }, reason: '已撤销的原日期未知不重新计数' });
  assert.deepEqual((await a.api(path)).planSummary, { reschedules: 0, laterAdjustments: 0, unknownAdjustments: 0, netDays: null });
  await c.execute('UPDATE projects SET created_by=NULL WHERE id=?', [another]);
  await a.api('/api/projects/' + another + '/actions', 'POST', command('3', 'correctProjectDates', { changes: { dueDate: null, originalDueDate: null }, reason: '旧来源未知' }));
  await a.api('/api/projects/' + another + '/actions', 'POST', command('4', 'setPlan', { dueDate: today })); assert.equal((await a.api('/api/projects/' + another)).project.originalDueDate, null);
  checks.push('不可变原行、关联原ID完整有效更正/撤销、超过20条审计、后续计划不自动回滚、当前明确同次纠正、说明类型/跨项目拒绝、原始未知不补造');

  await perform('correctProjectDates', { changes: { proposalDate: '2020-01-10', filingDate: '2020-01-01', startDate: '2020-01-03', dueDate: '2020-01-05' }, reason: '联合核对事实，不额外强制提案立案先后' });
  let before = await fresh(id);
  await a.api(path + '/actions', 'POST', command(version, 'correctProjectDates', { changes: { startDate: '2020-01-06' }, reason: '已知计划小于启动应拒绝' }), 422);
  await a.api(path + '/actions', 'POST', command(version, 'correctProjectDates', { changes: { proposalDate: addDays(today, 1) }, reason: '未来实际日期拒绝' }), 422); assert.deepEqual(await fresh(id), before);
  await perform('correctProjectDates', { changes: { startDate: null, dueDate: null }, reason: '明确未知，状态与阶段保持' });
  assert.deepEqual((await fresh(id)).stages, before.stages); assert.equal((await a.api(path)).project.status, 'proposal');
  for (const target of ['middle', 'INSERT INTO schedule_changes', 'INSERT INTO audit_log', 'INSERT INTO command_receipts']) {
    before = await fresh(id); fault = target; projectWrites = 0;
    const body = target === 'INSERT INTO schedule_changes' ? command(version, 'notePlan', { reason: '业务行故障', measures: '' }) : command(version, 'correctProjectDates', { changes: { dueDate: today, originalDueDate: today }, reason: '两项同次故障回滚' });
    await a.api(path + '/actions', 'POST', body, 503); fault = ''; assert.deepEqual(await fresh(id), before, target);
  }
  before = await fresh(id); fault = 'INSERT INTO audit_log';
  await a.api(path + '/actions', 'POST', command(version, 'correctScheduleRecord', { recordId: firstRecord, changes: { reason: '同次历史与当前计划' }, reason: '验证联合事务', currentDueDate: today }), 503);
  fault = ''; assert.deepEqual(await fresh(id), before, '历史更正与当前计划的审计失败一起回滚');
  await b.api(path + '/responsibility', 'POST', { action: 'join', expectedVersion: version, idempotencyKey: randomUUID() }); version = String(BigInt(version) + 1n);
  const stale = command(version, 'setPlan', { dueDate: current }); await a.api(path + '/actions/preview', 'POST', stale);
  version = (await b.api(path, 'PATCH', { scope:'basic', expectedVersion: version, idempotencyKey: randomUUID(), changes: { detailNote: '他人先保存' } })).result.savedVersion;
  await a.api(path + '/actions', 'POST', stale, 409);
  const race = await Promise.allSettled([a.api(path + '/actions', 'POST', command(version, 'setPlan', { dueDate: current })), b.api(path + '/actions', 'POST', command(version, 'setPlan', { dueDate: addDays(today, 1) }))]);
  assert.equal(race.filter(result => result.status === 'fulfilled').length, 1); version = (await a.api(path)).project.version;
  const uncertain = command(version, 'reschedulePlan', { dueDate: addDays(today, 40), reason: '提交后丢失确认', measures: '' }); fault = 'ack';
  await a.api(path + '/actions', 'POST', uncertain, 503); fault = ''; await app.close(); app = undefined; await start();
  const recovered = (await a.api(path + '/action-results/query', 'POST', uncertain)).result;
  assert.deepEqual((await a.api(path + '/actions', 'POST', uncertain)).result, recovered); version = recovered.savedVersion;
  assert.equal((await b.api(path + '/action-results/query', 'POST', uncertain)).outcome, 'not_found');
  checks.push('联合日期/明确未知保持生命周期，旧版/同版并发，项目中途/业务行/审计/回执故障全回滚，真实COMMIT丢确认与应用重建后会话/原结果接续');

  await c.execute("INSERT INTO system_configuration (id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))", [users[2].id, users[2].id]); ownConfig = true;
  let rule = await maint.api('/api/settings/check-rule'); await maint.api('/api/settings/check-rule', 'POST', { action: 'initializeCheckRule', deadlineWeekday: 5, expectedVersion: rule.configVersion, previewWeek: rule.weekStart, idempotencyKey: randomUUID() });
  const startupId = await create(a), startupPath = '/api/projects/' + startupId;
  await a.api(startupPath + '/actions', 'POST', command('1', 'startStage', { stageCode: 'S1', actualDate: '2020-01-01' }));
  await a.api(startupPath + '/actions', 'POST', command('2', 'completeStage', { stageCode: 'S1', actualDate: '2020-01-02' }));
  rule = await maint.api('/api/settings/check-rule');
  await a.api(startupPath + '/actions', 'POST', command('3', 'startProject', { actualDate: '2020-01-03', dueDate: current, configVersion: rule.configVersion, ruleVersion: rule.rule.version, previewWeek: rule.weekStart, previewFirstCheckWeek: rule.firstCheckWeek }));
  const firstObligation = (await a.api(startupPath)).project.firstCheckWeek;
  await a.api(startupPath + '/actions', 'POST', command('4', 'rollbackStage', { stageCode: 'S1', reason: '真实返工' }));
  await a.api(startupPath + '/actions', 'POST', command('5', 'startStage', { stageCode: 'S1', actualDate: '2020-02-01' }));
  await a.api(startupPath + '/actions', 'POST', command('6', 'completeStage', { stageCode: 'S1', actualDate: '2020-02-02' }));
  const startupCorrection = command('7', 'correctProjectDates', { changes: { startDate: '2020-01-04' }, reason: '首次启动日期不受返工S1约束' });
  assert.equal((await a.api(startupPath + '/actions/preview', 'POST', startupCorrection)).startupBasis, '2020-01-02');
  await a.api(startupPath + '/actions', 'POST', startupCorrection);
  await a.api(startupPath + '/actions', 'POST', command('8', 'correctProjectDates', { changes: { startDate: '2020-01-01' }, reason: '首次S1之前应拒绝' }), 422);
  assert.equal((await a.api(startupPath)).project.firstCheckWeek, firstObligation);
  checks.push('真实S1→启动→返工→再次S1之后纠正首次启动，原首次S1依据及检查义务保持；已知原依据的日期冲突拒绝');

  const cases = [
    ['proposal', addDays(today, 1), null, null, null, 'upcoming'], ['ongoing', today, null, null, null, 'due'], ['paused', addDays(today, -1), null, null, null, 'overdue'], ['proposal', null, null, null, null, 'unset'],
    ['closed', addDays(today, -5), '2024-02-29', '2024-02-29', 'normal', 'closed_on_time'], ['closed', null, '2025-01-01', '2024-12-31', 'normal', 'closed_late'], ['closed', today, '2020-01-01', null, 'normal', 'closed_unplanned'], ['closed', today, null, '2020-01-01', 'normal', 'closed_unknown'], ['closed', today, null, null, null, 'closed_unknown'], ['closed', today, null, null, 'terminated', 'terminated'],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [status, due, closed, closureDue, type, kind] = cases[i], caseId = await create(a);
    await c.execute('UPDATE projects SET status=?,current_due_date=?,closed_on=?,closure_due_date=?,closure_type=?,manual_delayed=? WHERE id=?', [status, due, closed, closureDue, type, i % 2, caseId]);
    const d = await a.api('/api/projects/' + caseId); assert.equal(d.project.deadline.kind, kind); assert.equal(d.businessDate, today);
    await c.execute('UPDATE projects SET manual_delayed=? WHERE id=?', [1 - i % 2, caseId]);
    assert.deepEqual((await a.api('/api/projects/' + caseId)).project.deadline, d.project.deadline, '相同日期事实不受人工值影响');
    const board = await a.api('/api/projects?view=all&deadline=' + kind); assert(board.items.some(p => p.id === caseId)); assert.equal(board.stats[kind], board.stats.total); assert.equal(board.businessDate, today);
  }
  const allStats = (await a.api('/api/projects?view=all')).stats;
  assert.equal(['upcoming', 'due', 'overdue', 'unset', 'closed_on_time', 'closed_late', 'closed_unplanned', 'closed_unknown', 'terminated'].reduce((sum, kind) => sum + allStats[kind], 0), allStats.total);
  before = await fresh(projects[projects.length - cases.length + 1]);
  const boundaryId = projects[projects.length - cases.length + 1];
  const day0 = projectReads(runtime, () => new Date(today + 'T15:59:59.999Z')), day1 = projectReads(runtime, () => new Date(today + 'T16:00:00.000Z'));
  assert.equal((await day0.detail(boundaryId, users[0].id)).project.deadline.kind, 'due');
  assert.equal((await day1.detail(boundaryId, users[0].id)).project.deadline.days, 1);
  const afterDay = await day1.list({ view: 'all', deadline: 'overdue' }); assert(afterDay.items.some(p => p.id === boundaryId)); assert.equal(afterDay.stats.overdue, afterDay.stats.total);
  assert.deepEqual(await fresh(boundaryId), before, '跨日派生不推进版本或历史');
  for (const invalid of ['2025-02-29', '2024-02-30', '2026-13-01', '0000-01-01']) assert(!validDate(invalid));
  assert.equal(deadlineResult({ status: 'ongoing', dueDate: '2024-02-28' }, '2024-03-01').days, 2);
  assert.equal(deadlineResult({ status: 'ongoing', dueDate: '2025-12-31' }, '2026-01-01').days, 1);
  await a.api(path, 'PATCH', { scope:'basic', expectedVersion: version, idempotencyKey: randomUUID(), changes: { manualDelayed: true } }, 400);
  checks.push('统一服务器业务日、全部未结案/结案/终止/未知结果、同条件筛选与范围聚合、闰日年末/午夜两侧，原人工值不参与且直接写拒绝，跨日不写项目/历史');
  const build = (await a.api('/api/health/live')).build;
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/project-dates-check.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount: measurements.length, measurements, build, isolatedTestDatabase: true }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount: measurements.length }));
  if (serve) { const uiId = await create(a); await writeFile('test-results/dates-browser-private.json', JSON.stringify({ origin: authOrigin, projectId: uiId, loginName: users[0].loginName, password, secondLoginName: users[1].loginName })); console.log('BROWSER_FIXTURE_READY'); await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); }
} finally {
  if (app) await app.close();
  for (const id of projects) { for (const table of ['project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  if (ownConfig) { await c.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?', [users[2].id]); await c.execute('DELETE FROM check_rule_revisions WHERE saved_by=?', [users[2].id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
