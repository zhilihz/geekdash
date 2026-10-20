import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1', '仅在独立测试实例执行');
const { connection: c } = await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'simple_' + randomUUID().slice(0, 8), password = '动作精简 test password 2026';
const users = [], projects = [], checks = [];
let app, origin, fault = '', requests = 0;
async function start() {
  const runtime = await openRuntimeDatabase('test_app'), write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) { return fault && sql.startsWith(fault) ? execute.call(this, 'INSERT INTO __simple_failure VALUES (1)') : execute.call(this, sql, params); };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw new Error('lost COMMIT acknowledgement'); };
    try { return await work(lease); } finally { lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: 'http://localhost', secure: false });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
}
function client() {
  let cookie = '', csrf = '', account;
  return { async api(path, method = 'GET', body, expected = 200) {
    requests++;
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
    const result = await response.json(); assert.equal(response.status, expected, path + JSON.stringify(result));
    if (result.account) account = result.account;
    return result;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].name, password }); await this.api('/api/auth/me'); } };
}
async function fresh(id) {
  const { connection: read } = await connectDatabase('test_app');
  try {
    const result = {};
    for (const table of ['projects', 'project_stages', 'project_nodes', 'project_risks', 'project_changes', 'schedule_changes', 'audit_log']) result[table] = (await read.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY id`, [id]))[0];
    result.receipts = (await read.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0];
    return result;
  } finally { await read.end(); }
}
try {
  const hash = await hashPassword(password);
  for (let i = 0; i < 2; i++) { await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix + i, hash, '精简验收' + i]); users.push({ id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id, name: prefix + i }); }
  await start(); let a = client(), b = client(); await a.login(0); await b.login(1);
  const create = async () => { const id = (await a.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix, managerIds: [users[1].id] } })).result.projectId; projects.push(id); return '/api/projects/' + id; };
  let path = await create(), id = path.split('/').at(-1);
  const command = async (action, extra = {}) => ({ action, expectedVersion: (await a.api(path)).project.version, idempotencyKey: randomUUID(), ...extra });
  const act = async (action, extra = {}) => {
    const body = await command(action, extra), response = await a.api(path + '/actions', 'POST', body);
    assert.equal((await a.api(path)).project.version, response.result.savedVersion);
    assert.equal(String((await fresh(id)).projects[0].version), response.result.savedVersion);
    return { body, result: response.result };
  };
  const patch = async (scope, changes, extra = {}) => {
    const body = { expectedVersion: (await a.api(path)).project.version, idempotencyKey: randomUUID(), scope, changes, ...extra };
    const response = await a.api(path, 'PATCH', body);
    assert.equal((await a.api(path)).project.version, response.result.savedVersion);
    assert.equal(String((await fresh(id)).projects[0].version), response.result.savedVersion);
    return { body, result: response.result };
  };
  await act('startStage', { stageCode: 'S1', actualDate: '2020-01-01' });
  await act('completeStage', { stageCode: 'S1', actualDate: '2020-01-02' });
  const startup = await act('startProject', { actualDate: '2020-01-03', dueDate: null });
  let sql = await fresh(id), detail = await a.api(path);
  assert.equal(detail.project.startDate, '2020-01-03'); assert.equal(sql.projects[0].started_on.toISOString().slice(0, 10), detail.project.startDate); assert.equal(sql.projects[0].first_check_week, null); assert.equal(sql.projects[0].first_check_rule_version, null); assert.equal(detail.project.dueDate, null);
  assert.deepEqual((await a.api(path + '/action-results/query', 'POST', startup.body)).result, startup.result);
  assert.deepEqual((await a.api(path + '/actions', 'POST', startup.body)).result, startup.result); assert.deepEqual(await fresh(id), sql);
  checks.push('启动无需检查规则或首周参数，允许计划未定；实际日期/阶段顺序、新GET/SQL及原号回执保持');

  for (const dueDate of ['2031-02-01', null]) {
    const combinedId = (await a.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '启动纠错', dueDate: '2030-12-31' } })).result.projectId;
    projects.push(combinedId); const combinedPath = '/api/projects/' + combinedId;
    for (const action of ['startStage', 'completeStage']) await a.api(combinedPath + '/actions', 'POST', { action, stageCode: 'S1', actualDate: action === 'startStage' ? '2020-01-01' : '2020-01-02', expectedVersion: (await a.api(combinedPath)).project.version, idempotencyKey: randomUUID() });
    const before = await fresh(combinedId), expectedVersion = (await a.api(combinedPath)).project.version;
    const start = { action: 'startProject', actualDate: '2020-01-03', dueDate, planReason: '' };
    const body = { expectedVersion, idempotencyKey: randomUUID(), scope: 'basic', changes: { name: prefix + '启动纠错已保存' }, commands: [{ action: 'correctProjectDates', changes: { dueDate } }, start] };
    for (const changes of [{ dueDate: '2032-01-01' }, { startDate: '2020-01-03' }]) {
      const rejected = await a.api(combinedPath, 'PATCH', { ...body, idempotencyKey: randomUUID(), commands: [{ action: 'correctProjectDates', changes }, start] }, 400);
      assert.equal(rejected.code, 'SAVE_SCOPE_MISMATCH'); assert.deepEqual(await fresh(combinedId), before);
    }
    const response = await a.api(combinedPath, 'PATCH', body), reread = await a.api(combinedPath), stored = await fresh(combinedId);
    assert.equal(reread.project.name, body.changes.name); assert.equal(reread.project.status, 'ongoing'); assert.equal(reread.project.startDate, start.actualDate); assert.equal(reread.project.dueDate, dueDate);
    assert.equal(BigInt(response.result.savedVersion), BigInt(expectedVersion) + 1n); assert.equal(String(stored.projects[0].version), response.result.savedVersion); assert.equal(stored.projects[0].status, 'ongoing');
    assert.equal(stored.projects[0].started_on.toISOString().slice(0, 10), start.actualDate); assert.equal(stored.projects[0].current_due_date?.toISOString().slice(0, 10) ?? null, dueDate); assert.equal(stored.schedule_changes.length, 0);
    assert.deepEqual((await a.api(combinedPath, 'PATCH', body)).result, response.result); assert.deepEqual((await a.api(combinedPath + '/save-results/query', 'POST', body)).result, response.result); assert.deepEqual(await fresh(combinedId), stored);
  }
  checks.push('首次启动可同事务纠正当前计划或清空未定，一次版本与原号回执保持；不一致计划和启动日期双写均拒绝且SQL无部分写入');

  await act('startStage', { stageCode: 'S2', actualDate: '2020-01-03' });
  await act('correctStageFacts', { changes: [{ code: 'S2', startedOn: '2020-01-04' }] });
  await act('correctProjectDates', { changes: { filingDate: '2020-01-01', dueDate: '2030-12-31' } });
  sql = await fresh(id);
  await a.api(path + '/actions', 'POST', await command('correctStageFacts', { changes: [{ code: 'S2', startedOn: '2019-12-31' }] }), 422);
  await a.api(path + '/actions', 'POST', await command('undoStageStart', { stageCode: 'S2', reason: '' }), 422);
  await a.api(path + '/actions', 'POST', await command('reschedulePlan', { dueDate: '2031-01-01', reason: '', measures: '' }), 422);
  assert.deepEqual(await fresh(id), sql);
  const atomic = await patch('basic', { name: prefix + '已核对' }, { commands: [{ action: 'correctProjectDates', changes: { filingDate: '2020-01-02' } }] });
  const atomicBefore = await fresh(id);
  await a.api(path, 'PATCH', { ...atomic.body, expectedVersion: atomic.result.savedVersion, idempotencyKey: randomUUID(), changes: { name: '不得部分写入' }, commands: [{ action: 'correctProjectDates', changes: { startDate: '2019-01-01' } }] }, 422);
  assert.deepEqual(await fresh(id), atomicBefore);
  checks.push('阶段/项目普通日期无附加原因直接保存；顺序、真实改期与撤销原因仍校验，基本信息联合事务失败无部分写入');

  const riskTemp = randomUUID();
  const risk = await patch('risk', { riskOps: [{ op: 'add', tempId: riskTemp, content: '样片交期仍待确认', level: 'mid' }] }, { target: riskTemp });
  const riskId = risk.result.riskIdMap[riskTemp];
  await patch('risk', { riskOps: [{ op: 'correct', id: riskId, changes: { level: 'high' } }] }, { target: riskId });
  sql = await fresh(id); assert.equal(sql.project_risks[0].level, 'high');
  const riskBody = { expectedVersion: (await a.api(path)).project.version, idempotencyKey: randomUUID(), scope: 'risk', target: riskId, changes: { riskOps: [{ op: 'resolve', id: riskId, resolution: '' }] } };
  await a.api(path, 'PATCH', riskBody, 422); assert.deepEqual(await fresh(id), sql);
  await patch('risk', { riskOps: [{ op: 'resolve', id: riskId, resolution: '供应商已书面确认交期' }] }, { target: riskId });
  await a.api(path, 'PATCH', { ...riskBody, expectedVersion: (await a.api(path)).project.version, changes: { riskOps: [{ op: 'undoResolve', id: riskId, reason: '' }] } }, 422);
  const changeTemp = randomUUID();
  const change = await patch('change', { changeOps: [{ op: 'add', tempId: changeTemp, source: '客户', content: '增加低电量提醒', decision: 'accept', reason: '不影响现有交期' }] }, { target: changeTemp });
  const changeId = change.result.changeIdMap[changeTemp];
  await patch('change', { changeOps: [{ op: 'correct', id: changeId, changes: { source: '业务', decision: 'reject', reason: '当前版本接口尚不支持' } }] }, { target: changeId });
  sql = await fresh(id); assert.equal(sql.project_changes[0].decision, 'reject'); assert.equal(sql.project_changes[0].reason, '当前版本接口尚不支持');
  await a.api(path, 'PATCH', { expectedVersion: (await a.api(path)).project.version, idempotencyKey: randomUUID(), scope: 'change', target: changeId, changes: { changeOps: [{ op: 'correct', id: changeId, changes: { decision: 'accept', reason: '' } }] } }, 422);
  assert.deepEqual(await fresh(id), sql);
  checks.push('风险等级及需求来源/决定可直接保存，新GET/SQL有变化；风险解除说明和业务决定理由仍必填，撤销解除原因保留');

  const aTemp = randomUUID(), bTemp = randomUUID();
  const nodes = await patch('projectNodes', { nodeOps: [
    { op: 'add', tempId: aTemp, kind: 'project', fields: { title: '接口定义', stage: 'S2', targetDate: '2030-06-01', output: '接口文档' } },
    { op: 'add', tempId: bTemp, kind: 'project', fields: { title: '样板联调', stage: 'S2', targetDate: null, output: '联调记录' } },
    { op: 'link', from: aTemp, to: bTemp, replaceEdges: [], affectedIds: [] },
  ] });
  const aNode = nodes.result.nodeIdMap[aTemp], bNode = nodes.result.nodeIdMap[bTemp];
  await patch('projectNodes', { nodeOps: [{ op: 'correct', id: aNode, changes: { stage: 'S3', targetDate: '2030-07-01' } }] });
  sql = await fresh(id);
  await a.api(path, 'PATCH', { expectedVersion: (await a.api(path)).project.version, idempotencyKey: randomUUID(), scope: 'projectNodes', changes: { nodeOps: [{ op: 'complete', id: bNode, completedOn: '2020-01-04' }] } }, 422); assert.deepEqual(await fresh(id), sql);
  await patch('projectNodes', { nodeOps: [{ op: 'complete', id: aNode, completedOn: '2020-01-04' }, { op: 'complete', id: bNode, completedOn: '2020-01-05' }] });
  await patch('projectNodes', { nodeOps: [{ op: 'complete', id: aNode, completedOn: '2020-01-03' }] });
  const undo = { expectedVersion: (await a.api(path)).project.version, idempotencyKey: randomUUID(), scope: 'projectNodes', changes: { nodeOps: [{ op: 'uncomplete', id: aNode, reason: '前置完成误录，同次撤销联调完成', affectedIds: [] }] } };
  sql = await fresh(id); const refused = await a.api(path, 'PATCH', undo, 422); assert.equal(refused.code, 'NODE_IMPACT_CHANGED'); assert.deepEqual(await fresh(id), sql);
  const preview = await a.api(path + '/save-preview', 'POST', undo); assert.deepEqual(preview.requiredUncompleteIds, [bNode]);
  undo.changes.nodeOps[0].affectedIds = [bNode];
  const undone = await a.api(path, 'PATCH', undo); assert.equal((await a.api(path)).project.version, undone.result.savedVersion);
  sql = await fresh(id); assert(sql.project_nodes.every(node => node.completed_on === null));
  checks.push('节点普通归属/目标日/已完日期与无影响连线直接保存；前置未完拒绝，下游撤销必须精确确认同次集合，SQL无静默清空');

  const closeCommand = await command('closeProject', { closureType: 'normal', closedOn: '2020-01-06', closureNote: '本次验证完成，后续阶段留给下一版本' });
  const closed = await a.api(path + '/actions', 'POST', closeCommand);
  detail = await a.api(path); sql = await fresh(id); assert.equal(detail.project.status, 'closed'); assert.equal(sql.projects[0].closure_note, closeCommand.closureNote); assert.equal(sql.projects[0].remaining_work_note, '');
  assert.deepEqual((await a.api(path + '/actions', 'POST', closeCommand)).result, closed.result); assert.deepEqual(await fresh(id), sql);
  await act('setMaintenance', { enabled: true });
  await act('correctClosure', { closureAuditId: detail.currentClosure.auditId, changes: { closureNote: '遗留阶段后续继续，当前交付已结束' } });
  sql = await fresh(id);
  await a.api(path + '/actions', 'POST', await command('correctClosure', { closureAuditId: detail.currentClosure.auditId, changes: { closureNote: '' } }), 422); assert.deepEqual(await fresh(id), sql);
  sql = await fresh(id);
  await a.api(path + '/actions', 'POST', await command('reopenProject', { closureAuditId: '9007199254740991' }), 409); assert.deepEqual(await fresh(id), sql);
  const reopened = await act('reopenProject', { closureAuditId: detail.currentClosure.auditId });
  assert.deepEqual((await a.api(path + '/actions', 'POST', reopened.body)).result, reopened.result);
  assert.equal((await a.api(path)).project.status, 'ongoing');
  await act('pauseProject', { reason: '等待下一轮样片' });
  detail = await a.api(path);
  const pauseAudit = (await fresh(id)).audit_log.find(row => row.action === 'project.pause');
  await act('correctLifecycleNote', { auditId: String(pauseAudit.id), note: '等待下一轮样片到货' });
  await act('resumeProject', { note: '' });
  checks.push('有遗留时一份结案说明即可；维护开关、结案/暂缓文字纠错无重复原因；重开不再要原因但核验原结案记录且原请求重放幂等，暂缓仍写一次业务原因');

  const legacyPath = path, legacyId = id;
  path = await create(); id = path.split('/').at(-1);
  for (let stage = 1; stage <= 7; stage++) {
    if (stage === 2) {
      const legacyStart = await act('startProject', { actualDate: '2020-01-02', dueDate: '2030-12-31', configVersion: '7', ruleVersion: '8', previewWeek: '2020-01-06', previewFirstCheckWeek: '2020-01-13' });
      const input = legacyStart.body;
      const expectedHash = createHash('sha256').update(JSON.stringify([id, input.action, input.actualDate, input.dueDate, '', input.expectedVersion, input.configVersion, input.ruleVersion, input.previewWeek, input.previewFirstCheckWeek])).digest();
      const receipt = (await fresh(id)).receipts.find(row => row.idempotency_key === input.idempotencyKey); assert(receipt.request_hash.equals(expectedHash));
      assert.deepEqual((await a.api(path + '/action-results/query', 'POST', input)).result, legacyStart.result);
    }
    await act('startStage', { stageCode: 'S' + stage, actualDate: '2020-01-02' });
    await act('completeStage', { stageCode: 'S' + stage, actualDate: '2020-01-02' });
  }
  await a.api(path + '/actions', 'POST', await command('closeProject', { closureType: 'terminated', closedOn: '2020-01-02', closureNote: '' }), 422);
  await act('closeProject', { closureType: 'normal', closedOn: '2020-01-02' });
  detail = await a.api(path); assert.equal(detail.project.closureNote, ''); assert.equal(detail.project.status, 'closed');
  await act('reopenProject', { closureAuditId: detail.currentClosure.auditId, reason: '核验旧客户端单说明兼容' });
  await act('closeProject', { closureType: 'terminated', closedOn: '2020-01-02', closureNote: '', remainingWorkNote: '旧客户端说明：订单取消' });
  detail = await a.api(path); assert.equal(detail.project.closureNote, '旧客户端说明：订单取消'); assert.equal(detail.project.remainingWorkNote, '旧客户端说明：订单取消');
  checks.push('正常无遗留结案说明选填，终止说明必填；旧启动参数hash与回执兼容，旧remainingWorkNote仍可作为单份说明');

  path = legacyPath; id = legacyId;
  const retry = await command('correctProjectDates', { changes: { filingDate: '2020-01-03' } });
  sql = await fresh(id); fault = 'INSERT INTO audit_log'; await a.api(path + '/actions', 'POST', retry, 503); fault = ''; assert.deepEqual(await fresh(id), sql);
  fault = 'ack'; const unknown = await a.api(path + '/actions', 'POST', retry, 503); assert.equal(unknown.outcome, 'unknown');
  fault = ''; await app.close(); await start(); a = client(); b = client(); await a.login(0); await b.login(1);
  const recovered = await a.api(path + '/action-results/query', 'POST', retry); assert.equal(recovered.outcome, 'committed');
  sql = await fresh(id); assert.equal((await a.api(path)).project.filingDate, '2020-01-03'); assert.equal(sql.projects[0].filed_on.toISOString().slice(0, 10), '2020-01-03'); assert.deepEqual((await a.api(path + '/actions', 'POST', retry)).result, recovered.result); assert.deepEqual(await fresh(id), sql);
  const stale = await command('correctProjectDates', { changes: { filingDate: '2020-01-04' } });
  await b.api(path, 'PATCH', { expectedVersion: stale.expectedVersion, idempotencyKey: randomUUID(), scope: 'status', changes: { statusDesc: '样片已到货，安排联调' } });
  sql = await fresh(id); await a.api(path + '/actions', 'POST', stale, 409); assert.deepEqual(await fresh(id), sql);
  checks.push('审计失败整笔回滚；COMMIT丢回应沿原号查询/重放不重复；另一经理保存后旧版本拒绝且输入对应正式事实不被覆盖');
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/action-simplification.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount: requests, isolatedTestDatabase: true, browserTested: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount: requests }));
} finally {
  fault = ''; if (app) await app.close();
  if (projects.length) {
    await c.query('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id IN (?)', [projects]);
    for (const table of ['audit_log', 'project_checks', 'schedule_changes', 'project_changes', 'project_risks', 'project_nodes', 'project_stages', 'project_people', 'project_chips', 'project_tags', 'project_responsibilities']) await c.query(`DELETE FROM ${table} WHERE project_id IN (?)`, [projects]);
    await c.query('DELETE FROM projects WHERE id IN (?)', [projects]);
  }
  if (users.length) { const ids = users.map(user => user.id); for (const table of ['command_receipts', 'audit_log']) await c.query(`DELETE FROM ${table} WHERE actor_id IN (?)`, [ids]); await c.query('DELETE FROM sessions WHERE user_id IN (?)', [ids]); await c.query('DELETE FROM users WHERE id IN (?)', [ids]); }
  await c.end();
}
