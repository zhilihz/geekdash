import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectActions, validateAction } from '../dist/server/modules/project-actions.js';

const { connection: c } = await connectDatabase('test_migrator');
const prefix = 'stage_' + randomUUID().slice(0, 8), password = '阶段验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '';
const serve = process.argv.includes('--serve');
const authOrigin = serve ? 'http://127.0.0.1:41863' : 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app');
  const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) {
      if (fault === 'stage' && sql.startsWith('UPDATE project_stages') || fault === 'audit' && sql.startsWith('INSERT INTO audit_log') || fault === 'receipt' && sql.startsWith('INSERT INTO command_receipts')) return execute.call(this, 'INSERT INTO __missing_stage_test_table VALUES (1)');
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
try {
  const hash = await hashPassword(password);
  for (let index = 0; index < 3; index++) { const loginName = prefix + '_' + index; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '阶段合成账号' + index]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await start(); const a = client(), b = client(), outsider = client(); await a.login(0); await b.login(1); await outsider.login(2);
  const id = await create(a), path = '/api/projects/' + id, actionPath = path + '/actions', confirmPath = path + '/action-results/query';
  assert.equal((await a.api(path + '/audit')).items[0].beforeValues, null);
  let before = await fresh(id);
  await outsider.api(actionPath, 'POST', command('1'), 403); assert.deepEqual(await fresh(id), before);
  await a.api(actionPath, 'POST', { ...command('1'), actorId: users[0].id }, 400);
  await a.api(actionPath, 'POST', command('1', 'completeStage'), 422);
  await a.api(actionPath, 'POST', command('1', 'startStage', 'S2'), 422);
  await a.api(actionPath, 'POST', command('1', 'startStage', 'S1', '2020-02-30'), 422);
  await a.api(actionPath, 'POST', command('1', 'startStage', 'S1', '9999-01-01'), 422);
  assert.deepEqual(await fresh(id), before); checks.push('白名单、身份/负责范围、前置、未开始直接完成及非法/未来日期拒绝，持久数据保持');
  for (const [code, date] of [['S1', '2020-01-01'], ['S2', '2020-01-01'], ['S2', '9999-01-01']]) {
    await c.execute('UPDATE project_stages SET started_on=? WHERE project_id=? AND stage_code=?', [date, id, code]);
    const inconsistent = await fresh(id);
    assert.equal((await a.api(actionPath, 'POST', command('1'), 422)).code, 'STAGE_DATE_REVIEW_REQUIRED');
    assert.deepEqual(await fresh(id), inconsistent);
    await c.execute('UPDATE project_stages SET started_on=NULL WHERE project_id=? AND stage_code=?', [id, code]);
  }
  await b.api(path + '/responsibility', 'POST', { expectedVersion: '1', idempotencyKey: randomUUID(), action: 'join' });
  const startBody = command('2'); const started = await a.api(actionPath, 'POST', startBody);
  assert.equal(started.result.savedVersion, '3'); let detail = await b.api(path);
  assert.equal(detail.stages[0].state, 'active'); assert.equal(detail.project.progress, '0'); assert.equal(detail.project.stageState, 'active'); assert.equal(detail.project.status, 'proposal');
  assert.equal((await fresh(id)).stages[0].startedOn, '2020-01-02');
  assert.deepEqual((await a.api(actionPath, 'POST', startBody)).result, started.result);
  assert.equal((await a.api(confirmPath, 'POST', startBody)).outcome, 'committed');
  assert.equal((await b.api(confirmPath, 'POST', startBody)).outcome, 'not_found');
  await a.api(actionPath, 'POST', { ...startBody, actualDate: '2020-01-03' }, 409);
  before = await fresh(id); await a.api(actionPath, 'POST', command('3'), 422); assert.deepEqual(await fresh(id), before);
  checks.push('负责人S1开始→新连接/另一账号详情与阶段状态；进度0、总体不变、原编号只执行一次及账号回执隔离');
  await a.api(actionPath, 'POST', command('3', 'completeStage', 'S1', '2020-01-01'), 422);
  for (const mode of ['stage', 'audit', 'receipt']) { fault = mode; await a.api(actionPath, 'POST', command('3', 'completeStage'), 503); fault = ''; assert.deepEqual(await fresh(id), before); }
  checks.push('阶段更新、审计及回执实际SQL故障，阶段/解锁/项目版本/历史/回执全部回滚');
  const completeBody = command('3', 'completeStage', 'S1', '2020-01-02', { completionNote: '核对真实完成，保留 <原文>\n第二行' });
  const completed = await a.api(actionPath, 'POST', completeBody);
  detail = await b.api(path); assert.equal(detail.project.status, 'proposal'); assert.equal(detail.project.progress, '5'); assert.equal(detail.stages[1].state, 'ready'); assert.equal(detail.stages[1].startedOn, null); assert.equal(detail.stageActions[1].startBlocked, 'PROJECT_START_REQUIRED');
  assert.equal(detail.stages[0].note, '');
  const history = await a.api(path + '/audit'); assert.equal(history.items[0].afterValues.completionNote, completeBody.completionNote); assert.equal(history.items[0].afterValues.stageChanges.length, 2); assert.equal(history.items[0].actorKind, 'user');
  const board = await a.api('/api/projects?view=proposal&search=' + prefix); assert.equal(board.items.find(p => p.id === id).stageState, 'ready');
  await a.api(actionPath, 'POST', command('4', 'startStage', 'S2'), 422);
  await b.api(actionPath, 'POST', command('3', 'completeStage'), 409);
  assert.equal((await fresh(id)).p.audits, '4'); checks.push('S1同日完成/说明原文→只解锁S2、不启动项目/阶段；新GET/看板/历史一致，旧版本拒绝');
  // 专用test库的进行中夹具；这不是尚未施工的“启动项目”API验收。
  await c.execute("UPDATE projects SET status='ongoing',started_on='2026-10-09' WHERE id=?", [id]);
  await a.api(actionPath, 'POST', command('4', 'startStage', 'S2', '2020-01-01'), 422);
  const s2 = command('4', 'startStage', 'S2');
  const races = await Promise.allSettled([a.api(actionPath, 'POST', s2), b.api(path, 'PATCH', { expectedVersion: '4', idempotencyKey: randomUUID(), changes: { detailNote: '并发普通保存' } })]);
  assert.equal(races.filter(r => r.status === 'fulfilled').length, 1); assert.equal((await fresh(id)).p.version, '5');
  if ((await fresh(id)).stages[1].state !== 'active') await a.api(actionPath, 'POST', command('5', 'startStage', 'S2'));
  let version = (await fresh(id)).p.version;
  const lost = command(version, 'completeStage', 'S2'); fault = 'ack'; const unknown = await a.api(actionPath, 'POST', lost, 503); assert.equal(unknown.outcome, 'unknown'); fault = '';
  await app.close(); await start();
  assert.equal((await a.api(confirmPath, 'POST', lost)).outcome, 'committed'); const saved = (await a.api(actionPath, 'POST', lost)).result; assert.equal(saved.savedVersion, String(BigInt(version) + 1n));
  assert.equal((await fresh(id)).stages[1].state, 'completed'); assert.equal((await a.api(path + '/audit')).items[0].afterValues.completionNote, '');
  checks.push('独立进行中夹具：仅相邻日期校验；普通保存/动作同版本竞争、真实COMMIT丢回执、应用重建后会话与原结果恢复');
  version = saved.savedVersion;
  for (const status of ['paused', 'closed']) { await c.execute('UPDATE projects SET status=? WHERE id=?', [status, id]); before = await fresh(id); await a.api(actionPath, 'POST', command(version, 'startStage', 'S3'), 422); assert.deepEqual(await fresh(id), before); }
  await c.execute("UPDATE projects SET status='ongoing' WHERE id=?", [id]);
  const actor = await identities(runtime).resolve(a.cookie.split('=')[1]); before = await fresh(id); await c.execute('UPDATE users SET enabled=0 WHERE id=?', [actor.id]);
  await assert.rejects(projectActions(runtime).run(actor, id, validateAction(command(version, 'startStage', 'S3')), randomUUID(), false), e => e.code === 'AUTH_REQUIRED'); assert.deepEqual(await fresh(id), before); await c.execute('UPDATE users SET enabled=1 WHERE id=?', [actor.id]);
  await c.execute("UPDATE project_stages SET completed_on=NULL WHERE project_id=? AND stage_code='S2'", [id]); await a.api(actionPath, 'POST', command(version, 'startStage', 'S3'), 422); await c.execute("UPDATE project_stages SET completed_on='2020-01-02' WHERE project_id=? AND stage_code='S2'", [id]);
  await c.execute("UPDATE project_stages SET state='ready' WHERE project_id=? AND stage_code='S4'", [id]); before = await fresh(id); await a.api(actionPath, 'POST', command(version, 'startStage', 'S3'), 422); assert.deepEqual(await fresh(id), before); await c.execute("UPDATE project_stages SET state='locked' WHERE project_id=? AND stage_code='S4'", [id]);
  checks.push('暂缓/结案禁止推进、事务内拒绝已停用身份、未知前置日期及非法序列明确核对，不自动修复');
  for (let index = 3; index <= 7; index++) { const started = await a.api(actionPath, 'POST', command(version, 'startStage', 'S' + index)); version = started.result.savedVersion; const done = await a.api(actionPath, 'POST', command(version, 'completeStage', 'S' + index)); version = done.result.savedVersion; }
  detail = await a.api(path); assert.equal(detail.project.progress, '100'); assert.equal(detail.project.status, 'ongoing'); assert.equal(detail.project.stage, 'completed'); assert.equal(detail.project.firstCheckWeek, undefined); assert.equal((await fresh(id)).p.firstCheckWeek, null);
  assert.equal(detail.project.signal, 'green'); assert.equal(detail.project.priority, 'mid'); checks.push('通用七阶段与原版累计进度，全部完成仍不自动结案/检查，不改灯色/优先级/阶段评述');
  const build = (await a.api('/api/health/live')).build;
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/stage-actions-check.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount: measurements.length, measurements, build, isolatedTestDatabase: true }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount: measurements.length, output: 'test-results/stage-actions-check.json' }));
  if (serve) { const uiId = await create(a); await writeFile('test-results/stage-browser-private.json', JSON.stringify({ origin: authOrigin, projectId: uiId, loginName: users[0].loginName, password, secondLoginName: users[1].loginName })); console.log('BROWSER_FIXTURE_READY'); await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); }
} finally {
  if (app) await app.close();
  if (serve && users.length) { const additional = (await c.query('SELECT CAST(id AS CHAR) id FROM projects WHERE created_by IN (' + users.map(() => '?').join(',') + ')', users.map(u => u.id)))[0]; for (const item of additional) if (!projects.includes(item.id)) projects.push(item.id); }
  for (const id of projects) { await c.execute('DELETE FROM command_receipts WHERE command_scope LIKE ?', ['user:%:project:' + id + ':%']); await c.execute('DELETE FROM audit_log WHERE project_id=?', [id]); await c.execute('DELETE FROM project_responsibilities WHERE project_id=?', [id]); await c.execute('DELETE FROM project_stages WHERE project_id=?', [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
