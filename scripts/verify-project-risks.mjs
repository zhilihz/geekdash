import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectSaves, validateSave } from '../dist/server/modules/project-save.js';

const { connection: c } = await connectDatabase('test_migrator');
const prefix = 'risk_' + randomUUID().slice(0, 8), password = '风险验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '';
const authOrigin = 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app'); const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) { if (fault && sql.startsWith(fault)) return execute.call(this, 'INSERT INTO __missing_risk_test_table VALUES (1)'); return execute.call(this, sql, params); };
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
    const data = await response.json(); if (Array.isArray(status)) { assert(status.includes(response.status), path + ': ' + JSON.stringify(data)); data.httpStatus = response.status; } else assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
    if (path === '/api/auth/me' && status === 200) account = data.account;
    measurements.push({ path, status: response.status, ms: performance.now() - began }); return data;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); } };
}
async function fresh(id) {
  const { connection } = await connectDatabase('test_app');
  try { const result = {}; for (const table of ['projects', 'project_stages', 'project_checks', 'schedule_changes', 'project_nodes', 'project_risks', 'audit_log']) result[table] = (await connection.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY id`, [id]))[0];
    result.receipts = (await connection.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0]; return result;
  } finally { await connection.end(); }
}
const input = (version, changes) => ({ expectedVersion: version, idempotencyKey: randomUUID(), changes });
const add = (content = '人工风险内容🙂', level = 'high') => ({ op: 'add', tempId: randomUUID(), content, level });
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  assert.equal((await c.query('SELECT id FROM projects WHERE source_namespace=?', [prefix]))[0].length, 0);
  const hash = await hashPassword(password);
  for (let i = 0; i < 4; i++) { const loginName = prefix + '_' + i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '风险合成账号' + i]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await start(); const clients = [client(), client(), client(), client()], [a, b] = clients;
  for (const [i, client] of clients.entries()) await client.login(i);
  for (let i = 0; i < 2; i++) { const out = await a.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '_' + i } }); projects.push(out.result.projectId); }
  const id = projects[0], path = '/api/projects/' + id;
  const detail = () => a.api(path), save = (body, user = a, status = 200) => user.api(path, 'PATCH', body, status);
  for (const user of clients.slice(1)) { const d = await detail(); await user.api(path + '/responsibility', 'POST', { action: 'join', expectedVersion: d.project.version, idempotencyKey: randomUUID() }); }
  const version = async () => (await detail()).project.version;
  const perform = async (ops, user = a, changes = {}) => { const body = input(await version(), { ...changes, riskOps: ops }); const before = await fresh(id); const preview = await user.api(path + '/save-preview', 'POST', body); assert.equal(preview.expectedVersion, body.expectedVersion); assert.deepEqual(await fresh(id), before, '预览不得正式写'); const result = (await save(body, user)).result; assert.equal((await detail()).project.version, result.savedVersion); return { body, result }; };
  const initial = await detail(), first = add();
  const original = await perform([first], a, { summaryNote: '普通文字与风险同次保存' }); const riskId = original.result.riskIdMap[first.tempId];
  assert.match(riskId, /^[1-9][0-9]*$/); let current = await detail(); const created = current.risks[0];
  assert.equal(created.id, riskId); assert.equal(created.actorId, users[0].id); assert.equal(created.createdByName, '风险合成账号0'); assert.equal(created.resolved, 0); assert.equal(created.resolvedAt, null); assert.equal(current.project.summaryNote, '普通文字与风险同次保存');
  assert.equal(current.project.signal, initial.project.signal); assert.deepEqual(current.stages, initial.stages); assert.deepEqual((await fresh(id)).project_checks, []); assert.deepEqual((await fresh(id)).schedule_changes, []);
  const firstFacts = await fresh(id); assert.equal(firstFacts.project_risks.length, 1); assert.equal(firstFacts.audit_log.filter(row => row.version_after === original.result.savedVersion).length, 2);
  assert.equal(new Set(firstFacts.audit_log.filter(row => row.version_after === original.result.savedVersion).map(row => row.request_id)).size, 1);
  assert.deepEqual((await save({ ...original.body, changes: { riskOps: [{ level: first.level, content: first.content, tempId: first.tempId, op: 'add' }], summaryNote: original.body.changes.summaryNote } })).result, original.result);
  assert.deepEqual((await a.api(path + '/save-results/query', 'POST', original.body)).result, original.result); assert.deepEqual(await fresh(id), firstFacts);
  await save({ ...original.body, changes: { riskOps: [{ ...first, level: 'mid' }] } }, a, 409);
  checks.push('新增与文字统一一次版本/事务、预览不写、实名/正式ID及新SQL/HTTP/历史消费，旧正文规范化重投保持');

  await perform([{ op: 'correct', id: riskId, changes: { content: '纠正内容', level: 'mid' }, reason: '原内容及等级误填' }], b);
  const resolved = await perform([{ op: 'resolve', id: riskId, resolution: '人工核对后的解除方法' }], b); const resolvedRisk = (await detail()).risks[0];
  assert.equal(resolvedRisk.createdAt, created.createdAt); assert.equal(resolvedRisk.actorId, created.actorId); assert.equal(resolvedRisk.resolvedByName, '风险合成账号1'); assert.equal(resolvedRisk.resolved, 1); assert.ok(resolvedRisk.resolvedAt);
  await c.execute('UPDATE users SET display_name=? WHERE id=?', ['后来改名0', users[0].id]); await c.execute('UPDATE users SET display_name=? WHERE id=?', ['后来改名1', users[1].id]);
  await perform([{ op: 'correct', id: riskId, changes: { resolution: '纠正解除说明' }, reason: '说明误填' }], a);
  current = await detail(); assert.equal(current.risks[0].resolvedAt, resolvedRisk.resolvedAt); assert.equal(current.risks[0].createdByName, '风险合成账号0'); assert.equal(current.risks[0].resolvedByName, '风险合成账号1');
  const beforeNoop = await fresh(id), noop = await perform([{ op: 'correct', id: riskId, changes: { content: '纠正内容', resolution: '纠正解除说明' }, reason: '核对一致' }]);
  assert.equal(noop.result.changed, false); assert.equal(noop.result.savedAt, null); const afterNoop = await fresh(id); assert.deepEqual(afterNoop.project_risks, beforeNoop.project_risks); assert.deepEqual(afterNoop.audit_log, beforeNoop.audit_log); assert.deepEqual(afterNoop.projects, beforeNoop.projects);
  await perform([{ op: 'undoResolve', id: riskId, reason: '误点解除，恢复预警' }], b);
  current = await detail(); assert.equal(current.risks[0].resolved, 0); assert.equal(current.risks[0].resolution, ''); assert.equal(current.risks[0].resolvedAt, null); assert.equal(current.risks[0].createdAt, created.createdAt);
  const recurrence = add('真实复发新条目', 'low'); await perform([recurrence]); assert.equal((await detail()).risks.length, 2);
  const sameSave = add('同次新增且明确解除'); const same = await perform([sameSave, { op: 'resolve', id: sameSave.tempId, resolution: '同次核对解决' }]);
  current = await detail(); const sameRisk = current.risks.find(row => row.id === same.result.riskIdMap[sameSave.tempId]); assert.equal(sameRisk.resolved, 1); assert.equal(sameRisk.createdAt, sameRisk.resolvedAt);
  const audit = await a.api(path + '/audit?pageSize=100'); assert.ok(audit.items.some(row => row.action === 'project.risk.undoResolve')); assert.ok(audit.items.some(row => row.action === 'project.risk.correct' && row.beforeValues.risk.resolution === '人工核对后的解除方法'));
  checks.push('原稳定风险内容/等级/说明纠错、真人解除/撤销与复发新增；原创建/解除人时间及历史快照不改，同值无审计版本，同次临时引用');

  const other = await a.api('/api/projects/' + projects[1]), otherAdd = add('另一个项目风险');
  const otherResult = (await a.api('/api/projects/' + projects[1], 'PATCH', input(other.project.version, { riskOps: [otherAdd] }))).result;
  const invalid = [
    [{ op: 'resolve', id: sameRisk.id, resolution: '重复解除' }, 422, 'RISK_ALREADY_RESOLVED'],
    [{ op: 'undoResolve', id: riskId, reason: '尚未解除' }, 422, 'RISK_NOT_RESOLVED'],
    [{ op: 'correct', id: riskId, changes: { resolution: '不能伪装解除' }, reason: '错误入口' }, 422, 'RISK_RESOLUTION_REQUIRES_RESOLVED'],
    [{ op: 'correct', id: otherResult.riskIdMap[otherAdd.tempId], changes: { content: '跨项目' }, reason: '错误目标' }, 404, 'RISK_NOT_FOUND'],
    [{ ...add(), content: '  ' }, 422, 'INVALID_PROJECT_FIELDS'], [{ ...add(), level: '严重' }, 422, 'INVALID_PROJECT_FIELDS'],
    [{ op: 'correct', id: riskId, changes: { content: '修改' }, reason: '' }, 422, 'INVALID_PROJECT_FIELDS'],
    [{ ...add(), actorId: users[1].id }, 400, 'INVALID_RISK_OPERATIONS'], [{ op: 'correct', id: riskId, changes: { resolved: 1 }, reason: '注入' }, 400, 'INVALID_RISK_OPERATIONS'],
    [{ op: 'resolve', id: riskId, resolution: '解除', resolvedAt: '2020-01-01' }, 400, 'INVALID_RISK_OPERATIONS'], [{ op: 'delete', id: riskId }, 400, 'INVALID_RISK_OPERATIONS'],
  ];
  for (const [op, status, code] of invalid) { const before = await fresh(id); const out = await save(input(await version(), { summaryNote: '不应先保存', riskOps: [op] }), a, status); assert.equal(out.code, code); assert.deepEqual(await fresh(id), before); }
  for (const riskOps of [[first, first], [{ op: 'resolve', id: randomUUID(), resolution: '未知临时引用' }], []]) { const before = await fresh(id); await save(input(await version(), { riskOps }), a, 400); assert.deepEqual(await fresh(id), before); }
  checks.push('内容/枚举/原因、跨项目/未知/重复临时键、重复动作与有限白名单拒绝整份，未指定风险保持，不允许注入时间身份状态或删除');

  const versionBefore = await version();
  const competitors = await Promise.all(clients.map(async (user, index) => { const body = input(versionBefore, { riskOps: [{ op: 'correct', id: riskId, changes: { content: '并发内容' + index }, reason: '并发核对' }] }); const response = await fetch(origin + path, { method: 'PATCH', headers: { Cookie: 'geekdash_dev=' + user.token, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-Account': users[index].id }, body: JSON.stringify(body) }); return response.status; }));
  assert.deepEqual(competitors, [403, 403, 403, 403], '没有CSRF不能绕过保存');
  const results = await Promise.all(clients.map((user, index) => save(input(versionBefore, { riskOps: [{ op: 'correct', id: riskId, changes: { content: '并发内容' + index }, reason: '并发核对' }] }), user, [200, 409])));
  assert.deepEqual(results.map(row => row.httpStatus).sort(), [200, 409, 409, 409]); assert.equal(await version(), String(BigInt(versionBefore) + 1n));
  const beforeOld = await fresh(id); await save(input(versionBefore, { riskOps: [add('旧版本新风险')] }), a, 409); assert.deepEqual(await fresh(id), beforeOld);
  await b.api(path + '/responsibility', 'POST', { action: 'leave', expectedVersion: await version(), idempotencyKey: randomUUID() }); const noOwner = input(await version(), { riskOps: [add('失去负责资格')] }), beforePermission = await fresh(id);
  await save(noOwner, b, 403); await b.api(path + '/save-preview', 'POST', noOwner, 403); assert.deepEqual(await fresh(id), beforePermission);
  const actor = await identities(runtime).resolve(a.token), disabledBody = input(await version(), { riskOps: [add()] }); await c.execute('UPDATE users SET enabled=0 WHERE id=?', [users[0].id]);
  await assert.rejects(() => projectSaves(runtime).save(id, validateSave(disabledBody), randomUUID(), actor), error => error.code === 'AUTH_REQUIRED');
  await c.execute('UPDATE users SET enabled=1 WHERE id=?', [users[0].id]);
  checks.push('四真实会话同版本只有一次提交，旧版/失权/事务内停用与CSRF不能绕过；失败保留持久状态');

  for (const [point, ops] of [['UPDATE projects SET', [add()]], ['INSERT INTO project_risks', [add()]], ['UPDATE project_risks', [{ op: 'resolve', id: riskId, resolution: '失败解除' }]], ['INSERT INTO audit_log', [add()]], ['INSERT INTO command_receipts', [add()]]]) {
    const body = input(await version(), { summaryNote: '写点失败全部回滚', riskOps: ops }), before = await fresh(id); fault = point; await save(body, a, 500); fault = ''; assert.deepEqual(await fresh(id), before);
  }
  const lostAdd = add('真实COMMIT后原结果恢复'), lostBody = input(await version(), { riskOps: [lostAdd, { op: 'resolve', id: lostAdd.tempId, resolution: '持久解除事实' }], summaryNote: '响应丢失仍持久' });
  fault = 'ack'; assert.equal((await save(lostBody, a, 503)).code, 'COMMIT_UNKNOWN'); fault = '';
  const receipt = await a.api(path + '/save-results/query', 'POST', lostBody); assert.equal(receipt.outcome, 'committed'); const beforeRestart = await fresh(id); await app.close(); app = undefined; await start();
  assert.deepEqual((await save(lostBody)).result, receipt.result); assert.deepEqual((await a.api(path + '/save-results/query', 'POST', lostBody)).result, receipt.result); assert.deepEqual(await fresh(id), beforeRestart);
  assert.equal((await detail()).risks.find(row => row.id === receipt.result.riskIdMap[lostAdd.tempId]).resolved, 1);
  assert.deepEqual((await save(resolved.body, b)).result, resolved.result, '原账号成功不被退出负责及当前风险状态挡住');
  checks.push('各SQL写点完整回滚；真实COMMIT后丢确认、应用重建原会话/正文/ID映射与新读保持，旧成功重投不重写');
  const build = (await a.api('/api/health/live')).build; await mkdir('test-results', { recursive: true }); await writeFile('test-results/project-risks-check.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount: measurements.length, measurements, build, isolatedTestDatabase: true }, null, 2) + '\n'); console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount: measurements.length }));
} finally {
  if (app) await app.close();
  for (const id of projects) { for (const table of ['project_risks', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
