import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectActions, validateAction } from '../dist/server/modules/project-actions.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1', '仅在独立测试实例执行');
const { connection: c } = await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'correction_' + randomUUID().slice(0, 8), password = '阶段验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '', stageWrites = 0;
const serve = process.argv.includes('--serve');
const authOrigin = serve ? 'http://127.0.0.1:41866' : 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app');
  const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) {
      if (fault === 'middleStage' && sql.startsWith('UPDATE project_stages') && ++stageWrites === 2 || fault === 'stage' && sql.startsWith('UPDATE project_stages') || fault === 'audit' && sql.startsWith('INSERT INTO audit_log') || fault === 'receipt' && sql.startsWith('INSERT INTO command_receipts')) return execute.call(this, 'INSERT INTO __missing_stage_test_table VALUES (1)');
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
  return {
    get cookie() { return cookie; },
    async api(path, method = 'GET', body, status = 200) {
      const began = performance.now();
      const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
      const data = await response.json(); assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
      if (path === '/api/auth/me' && status === 200) account = data.account;
      measurements.push({ path, status, ms: performance.now() - began }); return data;
    },
    async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); },
  };
}
const command = (version, action = 'startStage', stageCode = 'S1', actualDate = '2020-01-02', extra = {}) => ({ expectedVersion: version, idempotencyKey: randomUUID(), action, stageCode, actualDate, ...extra });
async function fresh(id) {
  const { connection } = await connectDatabase('test_app');
  try {
    const p = (await connection.query("SELECT CAST(version AS CHAR) version,p.status,p.signal,p.priority,DATE_FORMAT(started_on,'%Y-%m-%d') startedOn,first_check_week firstCheckWeek,(SELECT COUNT(*) FROM audit_log WHERE project_id=p.id) audits,(SELECT COUNT(*) FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',p.id,':actions')) receipts FROM projects p WHERE id=?", [id]))[0][0];
    const stages = (await connection.query("SELECT stage_code code,state,DATE_FORMAT(started_on,'%Y-%m-%d') startedOn,DATE_FORMAT(completed_on,'%Y-%m-%d') completedOn,note FROM project_stages WHERE project_id=? ORDER BY stage_code", [id]))[0];
    return { p, stages };
  } finally { await connection.end(); }
}
async function create(user) { const result = await user.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix, summaryNote: '原版项目基础' } }); projects.push(result.result.projectId); return result.result.projectId; }
const correction = (version, action, extra = {}) => ({ expectedVersion: version, idempotencyKey: randomUUID(), action, reason: '实际核对后纠正，保留原事实历史', ...extra });
try {
  const hash = await hashPassword(password);
  for (let index = 0; index < 3; index++) { const loginName = prefix + '_' + index; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '纠错合成账号' + index]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await start(); const a = client(), b = client(), outsider = client(); await a.login(0); await b.login(1); await outsider.login(2);
  const id = await create(a), path = '/api/projects/' + id, actionPath = path + '/actions', previewPath = actionPath + '/preview', confirmPath = path + '/action-results/query';
  await b.api(path + '/responsibility', 'POST', { expectedVersion: '1', idempotencyKey: randomUUID(), action: 'join' });
  let before = await fresh(id);
  const dates = correction('2', 'correctStageFacts', { changes: [{ code: 'S1', startedOn: null }] });
  await outsider.api(previewPath, 'POST', dates, 403); await outsider.api(actionPath, 'POST', dates, 403);
  await a.api(actionPath, 'POST', { ...dates, reason: '' }, 422);
  await a.api(actionPath, 'POST', { ...dates, changes: [{ code: 'S1', state: 'completed' }] }, 400);
  await a.api(actionPath, 'POST', { ...dates, changes: [{ code: 'S1', startedOn: '2020-02-30' }] }, 422);
  await a.api(actionPath, 'POST', { ...dates, changes: [{ code: 'S1', startedOn: null }, { code: 'S1', completedOn: null }] }, 400);
  assert.deepEqual(await fresh(id), before);
  assert.equal((await a.api(previewPath, 'POST', dates)).changed, false); assert.deepEqual(await fresh(id), before);
  const noop = await a.api(actionPath, 'POST', dates); assert.equal(noop.result.changed, false); assert.equal(noop.result.savedVersion, '2');
  assert.equal((await fresh(id)).p.audits, before.p.audits); assert.deepEqual((await a.api(actionPath, 'POST', dates)).result, noop.result);
  checks.push('白名单/身份/负责/原因及非法日期；只读预览和无变化回执，不推进版本或虚构历史');
  // 仅本test夹具设置总体进行中，B02人工启动另有独立真实链路，不冒充启动验收。
  await c.execute("UPDATE projects SET status='ongoing',started_on='2026-10-09',current_due_date='2026-11-09',original_due_date='2026-11-09',first_check_week='2026-10-05' WHERE id=?", [id]);
  let version = '2';
  for (let index = 1; index <= 3; index++) { version = (await a.api(actionPath, 'POST', command(version, 'startStage', 'S' + index))).result.savedVersion; version = (await a.api(actionPath, 'POST', command(version, 'completeStage', 'S' + index))).result.savedVersion; }
  version = (await a.api(actionPath, 'POST', command(version, 'startStage', 'S4'))).result.savedVersion;
  const fixed = (await a.api(path)).project;
  await c.execute("INSERT INTO project_nodes (project_id,kind,title,target_date,completed_on,output,note,sort_order) VALUES (?,'project','既有成果节点','2020-01-03','2020-01-02','成果保留','评述保留',0)", [id]);
  await c.execute("INSERT INTO project_risks (project_id,content,level,resolved,resolution,actor_id,created_at,sort_order) VALUES (?,'既有风险','high',0,'',?,UTC_TIMESTAMP(3),0)", [id, users[0].id]);
  await c.execute("INSERT INTO project_changes (project_id,source,content,decision,reason,actor_id,created_at,sort_order) VALUES (?,'customer','既有需求变更','accept','人工决定',?,UTC_TIMESTAMP(3),0)", [id, users[0].id]);
  const preserved = await a.api(path);
  const plans = { expectedVersion: version, idempotencyKey: randomUUID(), scope: 'stage', target: 'S2', changes: { stagePlans: [{ code: 'S2', plannedDays: 12, note: '原卡片评述' }] } };
  const planned = await a.api(path, 'PATCH', plans); version = planned.result.savedVersion;
  let detail = await b.api(path); assert.equal(detail.stages[1].plannedDays, 12); assert.equal(detail.stages[1].note, '原卡片评述'); assert.equal(detail.project.summaryNote, preserved.project.summaryNote); assert.equal(detail.stages[3].state, 'active');
  assert.equal((await a.api(path + '/audit')).items[0].afterValues.stagePlans[1].plannedDays, 12);
  assert.deepEqual((await a.api(path, 'PATCH', plans)).result, planned.result);
  await a.api(path, 'PATCH', { expectedVersion: version, idempotencyKey: randomUUID(), scope: 'stage', target: 'S1', changes: { stagePlans: [{ code: 'S1', startedOn: null }] } }, 400);
  before = await fresh(id); fault = 'stage'; await a.api(path, 'PATCH', { expectedVersion: version, idempotencyKey: randomUUID(), scope: 'stage', target: 'S2', changes: { stagePlans: [{ code: 'S2', plannedDays: 15, note: '失败' }] } }, 500); fault = ''; assert.deepEqual(await fresh(id), before);
  assert.equal((await a.api(path)).project.name, prefix);
  checks.push('当前阶段卡工期/评述独立保存，摘要等其他范围保持；新SQL/详情/历史/原回执，状态白名单及SQL失败全回滚');
  const jointly = correction(version, 'correctStageFacts', { changes: [{ code: 'S3', completedOn: '2020-01-03' }, { code: 'S4', startedOn: '2020-01-03' }] });
  before = await fresh(id); const preview = await a.api(previewPath, 'POST', jointly); assert.equal(preview.stageChanges.length, 2); assert.equal(preview.progressAfter, 20); assert.deepEqual(await fresh(id), before);
  const corrected = await a.api(actionPath, 'POST', jointly); version = corrected.result.savedVersion;
  assert.deepEqual(corrected.result.stageChanges, preview.stageChanges); detail = await b.api(path); assert.equal(detail.stages[2].completedOn, '2020-01-03'); assert.equal(detail.stages[3].startedOn, '2020-01-03');
  before = await fresh(id); await a.api(previewPath, 'POST', correction(version, 'correctStageFacts', { changes: [{ code: 'S3', completedOn: '2020-01-04' }] }), 422); assert.deepEqual(await fresh(id), before);
  await c.execute("UPDATE project_stages SET completed_on='2020-01-04' WHERE project_id=? AND stage_code='S3'", [id]);
  const repair = await a.api(actionPath, 'POST', correction(version, 'correctStageFacts', { changes: [{ code: 'S3', completedOn: '2020-01-03' }] })); version = repair.result.savedVersion;
  const unknown = await a.api(actionPath, 'POST', correction(version, 'correctStageFacts', { changes: [{ code: 'S3', completedOn: null }] })); version = unknown.result.savedVersion;
  detail = await a.api(path); assert.equal(detail.stages[2].state, 'completed'); assert.equal(detail.project.progress, '20'); assert.equal(detail.stages[2].completedOn, null);
  version = (await a.api(path, 'PATCH', { expectedVersion: version, idempotencyKey: randomUUID(), scope: 'basic', changes: { detailNote: '未知日期不阻止无关文字' } })).result.savedVersion;
  version = (await a.api(actionPath, 'POST', correction(version, 'correctStageFacts', { changes: [{ code: 'S3', completedOn: '2020-01-03' }] }))).result.savedVersion;
  checks.push('多阶段日期最终结果共同校验；旧矛盾可纠正，明确未知不撤销完成/进度且普通文字可存');
  const unstart = correction(version, 'undoStageStart', { stageCode: 'S4' });
  before = await fresh(id); await a.api(previewPath, 'POST', unstart); assert.deepEqual(await fresh(id), before);
  version = (await a.api(actionPath, 'POST', unstart)).result.savedVersion;
  assert.equal((await a.api(path)).stages[3].state, 'ready'); assert.equal((await fresh(id)).stages[3].startedOn, null);
  version = (await a.api(actionPath, 'POST', command(version, 'startStage', 'S4', '2020-01-03'))).result.savedVersion;
  const uncomplete = correction(version, 'undoStageComplete', { stageCode: 'S2' });
  const unpreview = await a.api(previewPath, 'POST', uncomplete); assert.equal(unpreview.progressAfter, 5); assert.equal(unpreview.stageChanges.length, 3);
  for (const mode of ['middleStage', 'audit', 'receipt']) { before = await fresh(id); stageWrites = 0; fault = mode; await a.api(actionPath, 'POST', uncomplete, 503); fault = ''; assert.deepEqual(await fresh(id), before); }
  version = (await a.api(actionPath, 'POST', uncomplete)).result.savedVersion;
  detail = await a.api(path); assert.equal(detail.stages[1].state, 'active'); assert.equal(detail.stages[1].startedOn, '2020-01-02'); assert.equal(detail.stages[2].state, 'locked'); assert.equal(detail.stages[3].startedOn, null); assert.equal(detail.stages[1].note, '原卡片评述');
  for (const field of ['status', 'startDate', 'dueDate', 'originalDueDate', 'firstCheckWeek', 'signal', 'priority']) assert.deepEqual(detail.project[field], fixed[field]);
  checks.push('撤销误开始可再开始；误完成整块联动保留目标开始/评述/项目计划/义务，半程SQL/审计/回执失败原子回滚');
  version = (await a.api(actionPath, 'POST', command(version, 'completeStage', 'S2'))).result.savedVersion;
  await c.execute("UPDATE project_stages SET started_on=NULL WHERE project_id=? AND stage_code='S2'", [id]);
  before = await fresh(id); await a.api(actionPath, 'POST', correction(version, 'undoStageComplete', { stageCode: 'S2' }), 422); assert.deepEqual(await fresh(id), before);
  version = (await a.api(actionPath, 'POST', correction(version, 'undoStageComplete', { stageCode: 'S2', undoStart: true }))).result.savedVersion;
  assert.equal((await a.api(path)).stages[1].state, 'ready');
  for (let index = 2; index <= 7; index++) { version = (await a.api(actionPath, 'POST', command(version, 'startStage', 'S' + index))).result.savedVersion; version = (await a.api(actionPath, 'POST', command(version, 'completeStage', 'S' + index))).result.savedVersion; }
  assert.equal((await a.api(path)).project.progress, '100');
  const rollback = correction(version, 'rollbackStage', { stageCode: 'S4', reason: '真实返工，重新进行EVT' });
  assert.equal((await a.api(previewPath, 'POST', rollback)).progressAfter, 20);
  fault = 'ack'; assert.equal((await a.api(actionPath, 'POST', rollback, 503)).outcome, 'unknown'); fault = '';
  await app.close(); await start();
  const recovered = (await a.api(confirmPath, 'POST', rollback)).result; version = recovered.savedVersion;
  assert.deepEqual((await a.api(actionPath, 'POST', rollback)).result, recovered);
  assert.equal((await b.api(confirmPath, 'POST', rollback)).outcome, 'not_found');
  detail = await b.api(path); assert.equal(detail.stages[3].state, 'ready'); assert.equal(detail.stages[3].startedOn, null); assert.equal(detail.stages[6].state, 'locked');
  for (const key of ['nodes', 'risks', 'changes']) assert.deepEqual(detail[key], preserved[key]);
  assert.equal((await a.api(path + '/audit')).items[0].action, 'project.stage.rollbackStage');
  before = await fresh(id); await a.api(actionPath, 'POST', correction(version, 'rollbackStage', { stageCode: 'S4' }), 422); assert.deepEqual(await fresh(id), before);
  checks.push('未知开始不补造，明确连开始撤销；全完成可真实返工且目标待开始，COMMIT丢确认/重建/原回执只有一次');
  for (const status of ['paused', 'closed']) {
    await c.execute('UPDATE projects SET status=? WHERE id=?', [status, id]);
    before = await fresh(id); await a.api(actionPath, 'POST', correction(version, 'rollbackStage', { stageCode: 'S1' }), 422); assert.deepEqual(await fresh(id), before);
    if (status === 'closed') await a.api(actionPath, 'POST', correction(version, 'undoStageComplete', { stageCode: 'S1' }), 422);
    version = (await a.api(actionPath, 'POST', correction(version, 'correctStageFacts', { changes: [{ code: 'S1', completedOn: '2020-01-02' }] }))).result.savedVersion;
  }
  await c.execute("UPDATE projects SET status='ongoing' WHERE id=?", [id]);
  const stale = correction(version, 'rollbackStage', { stageCode: 'S3' }); await a.api(previewPath, 'POST', stale);
  version = (await b.api(path, 'PATCH', { expectedVersion: version, idempotencyKey: randomUUID(), scope: 'basic', changes: { detailNote: '预览后他人保存' } })).result.savedVersion;
  before = await fresh(id); await a.api(actionPath, 'POST', stale, 409); assert.deepEqual(await fresh(id), before);
  const results = await Promise.allSettled([a.api(actionPath, 'POST', correction(version, 'rollbackStage', { stageCode: 'S3' })), b.api(actionPath, 'POST', correction(version, 'rollbackStage', { stageCode: 'S2' }))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const actor = await identities(runtime).resolve(a.cookie.split('=')[1]); await c.execute('UPDATE users SET enabled=0 WHERE id=?', [actor.id]);
  await assert.rejects(projectActions(runtime).preview(actor, id, validateAction(correction((await fresh(id)).p.version, 'rollbackStage', { stageCode: 'S1' }))), e => e.code === 'AUTH_REQUIRED');
  await c.execute('UPDATE users SET enabled=1 WHERE id=?', [actor.id]);
  checks.push('暂停/结案区别限制与日期纠错；预览后保存冲突、双负责人同版一胜出，预览不信停用身份');
  const build = (await a.api('/api/health/live')).build;
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/stage-corrections-check.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount: measurements.length, measurements, build, isolatedTestDatabase: true }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount: measurements.length, output: 'test-results/stage-corrections-check.json' }));
  if (serve) { const uiId = await create(a); await writeFile('test-results/correction-browser-private.json', JSON.stringify({ origin: authOrigin, projectId: uiId, loginName: users[0].loginName, password, secondLoginName: users[1].loginName })); console.log('BROWSER_FIXTURE_READY'); await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); }
} finally {
  if (app) await app.close();
  if (serve && users.length) { const additional = (await c.query('SELECT CAST(id AS CHAR) id FROM projects WHERE created_by IN (' + users.map(() => '?').join(',') + ')', users.map(u => u.id)))[0]; for (const item of additional) if (!projects.includes(item.id)) projects.push(item.id); }
  for (const id of projects) { await c.execute('DELETE FROM command_receipts WHERE command_scope LIKE ?', ['user:%:project:' + id + ':%']); await c.execute('DELETE FROM audit_log WHERE project_id=?', [id]); for (const table of ['project_nodes', 'project_risks', 'project_changes']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute('DELETE FROM project_responsibilities WHERE project_id=?', [id]); await c.execute('DELETE FROM project_stages WHERE project_id=?', [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
