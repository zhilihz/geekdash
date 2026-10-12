import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectSaves, validateSave } from '../dist/server/modules/project-save.js';

const prefix = 'changes_' + randomUUID().slice(0, 8), password = '变更验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '', faultAfter = 0;
const fallbackDir = process.env.GEEKDASH_CHANGES_FALLBACK_DIR;
assert(fallbackDir, '必须指定从固定兼容镜像导出的GEEKDASH_CHANGES_FALLBACK_DIR');
const fallbackBuild = JSON.parse(await readFile(fallbackDir + '/build-info.json', 'utf8'));
assert.equal(fallbackBuild.revision, '2a342d66bee15248ad382d2c0050ebe01730a6e7'); assert.equal(fallbackBuild.dirty, false);
const fallbackModules = await Promise.all([import(fallbackDir + '/server/app.js'), import(fallbackDir + '/server/infrastructure/runtime-database.js')]);
const authOrigin = 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app'); const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) { if (fault && sql.startsWith(fault) && --faultAfter <= 0) return execute.call(this, 'INSERT INTO __missing_change_test_table VALUES (1)'); return execute.call(this, sql, params); };
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
  try { const result = {}; for (const table of ['projects', 'project_stages', 'project_checks', 'schedule_changes', 'project_nodes', 'project_risks', 'project_changes', 'audit_log']) result[table] = (await connection.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY id`, [id]))[0];
    result.receipts = (await connection.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0]; return result;
  } finally { await connection.end(); }
}
const input = (version, changes) => ({ expectedVersion: version, idempotencyKey: randomUUID(), changes });
const add = (source = '客户', decision = 'accept') => ({ op: 'add', tempId: randomUUID(), source, content: '真实需求变更🙂', decision, reason: '人工决定理由' });
const correct = (id, changes, correctionReason = '原信息误填，明确纠正') => ({ op: 'correct', id, changes, correctionReason });
const { connection: c } = await connectDatabase('test_migrator');
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  const hash = await hashPassword(password);
  for (let i = 0; i < 4; i++) { const loginName = prefix + '_' + i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '变更合成账号' + i]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await start(); const clients = [client(), client(), client(), client()], [a, b] = clients;
  for (const [index, user] of clients.entries()) await user.login(index);
  for (let i = 0; i < 2; i++) projects.push((await a.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '_' + i } })).result.projectId);
  const id = projects[0], path = '/api/projects/' + id, detail = () => a.api(path), version = async () => (await detail()).project.version, save = (body, user = a, status = 200) => user.api(path, 'PATCH', body, status);
  for (const user of clients.slice(1)) await user.api(path + '/responsibility', 'POST', { action: 'join', expectedVersion: await version(), idempotencyKey: randomUUID() });
  const perform = async (ops, user = a, extra = {}) => { const body = input(await version(), { ...extra, changeOps: ops }), before = await fresh(id), preview = await user.api(path + '/save-preview', 'POST', body); assert.deepEqual(await fresh(id), before); assert.equal(preview.expectedVersion, body.expectedVersion); const result = (await save(body, user)).result; assert.equal((await detail()).project.version, result.savedVersion); return { body, result }; };
  const initial = await detail(), first = add(), second = add('业务', 'reject');
  const created = await perform([first, second], a, { summaryNote: '文字与两个人工决定统一保存' }); const [A, B] = [first, second].map(op => created.result.changeIdMap[op.tempId]);
  let d = await detail(), original = d.changes.find(row => row.id === A), prior = await fresh(id);
  assert.match(A, /^[1-9][0-9]*$/); assert.equal(original.createdByName, '变更合成账号0'); assert.equal(original.actorId, users[0].id); assert.equal(original.sourceKey, null); assert.equal(d.changes.find(row => row.id === B).decision, 'reject');
  assert.deepEqual(d.stages, initial.stages); assert.equal(d.project.signal, initial.project.signal); assert.equal(d.project.dueDate, initial.project.dueDate); assert.deepEqual(prior.project_checks, []); assert.deepEqual(prior.schedule_changes, []);
  const events = prior.audit_log.filter(row => row.version_after === created.result.savedVersion); assert.equal(events.length, 3); assert.equal(new Set(events.map(row => row.request_id)).size, 1);
  const reordered = { ...created.body, changes: { changeOps: [Object.fromEntries(Object.entries(first).reverse()), Object.fromEntries(Object.entries(second).reverse())], summaryNote: created.body.changes.summaryNote } };
  assert.deepEqual((await save(reordered)).result, created.result); assert.deepEqual((await a.api(path + '/save-results/query', 'POST', reordered)).result, created.result); assert.deepEqual(await fresh(id), prior);
  assert.equal((await save({ ...created.body, changes: { changeOps: [{ ...first, decision: 'reject' }, second] } }, a, 409)).code, 'OPERATION_KEY_REUSED');
  checks.push('两来源/两决定与文字同一版本/事务，预览不写、正式ID/实名/新SQL与详情/历史；原正文键顺序重投无二次写入，无计划/阶段/灯色/检查联动');

  await perform([correct(A, { source: '业务', content: '完整纠错内容', decision: 'reject', reason: '重新核对后的业务理由' })], b);
  d = await detail(); assert.deepEqual(d.changes.find(row => row.id === A), { ...original, source: '业务', content: '完整纠错内容', decision: 'reject', reason: '重新核对后的业务理由' });
  await perform([correct(A, { decision: 'accept' })], b);
  const temporary = add(), same = await perform([temporary, correct(temporary.tempId, { decision: 'reject', content: '同次新增后纠正' })]);
  assert.equal(same.result.changes.find(row => row.id === same.result.changeIdMap[temporary.tempId]).decision, 'reject');
  prior = await fresh(id); const noop = await perform([correct(A, { decision: 'accept', content: '完整纠错内容' }, '核对一致')]); let after = await fresh(id);
  assert.equal(noop.result.changed, false); assert.equal(noop.result.savedAt, null); for (const table of Object.keys(prior).filter(key => key !== 'receipts')) assert.deepEqual(after[table], prior[table]);
  for (let i = 0; i < 28; i++) await perform([correct(A, { content: '第' + i + '次明确纠错' })], b);
  await c.execute('UPDATE users SET display_name=? WHERE id=?', ['后来改名0', users[0].id]); assert.equal((await detail()).changes.find(row => row.id === A).createdByName, '变更合成账号0');
  await c.execute("INSERT INTO project_changes (project_id,source,content,decision,reason,actor_id,created_at,source_key,sort_order) VALUES (?,'旧未知来源','旧内容','accept','',NULL,'2020-01-01 00:00:00.123','合成旧来源',99)", [id]);
  const legacyId = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id, legacy = (await detail()).changes.find(row => row.id === legacyId); assert.equal(legacy.createdByName, null);
  await save(input(await version(), { detailNote: '无关文字保留旧未知来源与空理由' })); assert.deepEqual((await detail()).changes.find(row => row.id === legacyId), legacy);
  await perform([correct(legacyId, { content: '只明确改内容' })]); assert.deepEqual((await detail()).changes.find(row => row.id === legacyId), { ...legacy, content: '只明确改内容' });
  await perform([correct(legacyId, { source: '客户', reason: '补充真实人工理由' })]); const fixedLegacy = (await detail()).changes.find(row => row.id === legacyId); assert.equal(fixedLegacy.actorId, null); assert.equal(fixedLegacy.createdAt, legacy.createdAt); assert.equal(fixedLegacy.sourceKey, legacy.sourceKey); assert.equal(fixedLegacy.createdByName, null);
  let cursor, history = []; do { const page = await a.api(path + '/audit?pageSize=20' + (cursor ? '&before=' + cursor : '')); history.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert(history.length > 20); assert(history.some(row => row.action === 'project.change.correct' && row.beforeValues.change.decision === 'reject' && row.afterValues.change.decision === 'accept')); assert(history.some(row => row.action === 'project.change.correct' && row.afterValues.correctionReason === '原信息误填，明确纠正'));
  const heldOrder = fixedLegacy.sortOrder; await c.execute('UPDATE project_changes SET sort_order=4294967295 WHERE id=?', [legacyId]); prior = await fresh(id);
  assert.equal((await save(input(await version(), { changeOps: [add()] }), a, 422)).code, 'CHANGE_ORDER_EXHAUSTED'); assert.deepEqual(await fresh(id), prior); await c.execute('UPDATE project_changes SET sort_order=? WHERE id=?', [heldOrder, legacyId]);
  checks.push('四字段/误选决定明确纠错、原创建事实/同值/临时引用；28次历史与创建姓名快照保持，未知旧来源空理由仅校验触及字段，排序上限整份拒绝');

  const other = add(); const otherPath = '/api/projects/' + projects[1]; const otherResult = (await a.api(otherPath, 'PATCH', input((await a.api(otherPath)).project.version, { changeOps: [other] }))).result;
  const invalid = [
    [correct(otherResult.changeIdMap[other.tempId], { content: '跨项目' }), 404, 'CHANGE_NOT_FOUND'],
    [correct('18446744073709551615', { content: '未知对象' }), 404, 'CHANGE_NOT_FOUND'],
    [{ ...add(), content: '  ' }, 422, 'INVALID_PROJECT_FIELDS'], [{ ...add(), reason: '' }, 422, 'INVALID_PROJECT_FIELDS'], [{ ...add(), source: '未知' }, 422, 'INVALID_PROJECT_FIELDS'], [{ ...add(), decision: '接受' }, 422, 'INVALID_PROJECT_FIELDS'],
    [correct(A, { source: 'unknown' }), 422, 'INVALID_PROJECT_FIELDS'], [correct(A, { reason: '' }), 422, 'INVALID_PROJECT_FIELDS'], [correct(A, { content: 'x' }, ''), 422, 'INVALID_PROJECT_FIELDS'],
    [{ ...add(), actorId: users[1].id }, 400, 'INVALID_CHANGE_OPERATIONS'], [{ ...add(), createdAt: '2020-01-01' }, 400, 'INVALID_CHANGE_OPERATIONS'], [{ ...add(), sourceKey: '伪造' }, 400, 'INVALID_CHANGE_OPERATIONS'],
    [correct(A, { sortOrder: 0 }), 400, 'INVALID_CHANGE_OPERATIONS'], [correct(A, {}), 400, 'INVALID_CHANGE_OPERATIONS'], [{ op: 'delete', id: A }, 400, 'INVALID_CHANGE_OPERATIONS'],
    [{ ...add(), content: '\ud800' }, 422, 'INVALID_PROJECT_FIELDS'], [{ ...add(), reason: '🙂'.repeat(16384) }, 422, 'INVALID_PROJECT_FIELDS'], [{ ...add(), content: 1 }, 400, 'INVALID_CHANGE_OPERATIONS'],
  ];
  for (const [op, status, code] of invalid) { prior = await fresh(id); const body = input(await version(), { summaryNote: '整份不得提前保存', changeOps: [op] }); assert.equal((await save(body, a, status)).code, code); assert.equal((await a.api(path + '/save-preview', 'POST', body, status)).code, code); assert.deepEqual(await fresh(id), prior); }
  const dup = add(); for (const ops of [[], [dup, dup], [correct(randomUUID(), { content: '未知临时引用' })]]) { prior = await fresh(id); await save(input(await version(), { changeOps: ops }), a, 400); assert.deepEqual(await fresh(id), prior); }
  const competingVersion = await version(); const results = await Promise.all(clients.map((user, index) => save(input(competingVersion, { changeOps: [correct(A, { content: '四人同时编辑' + index })] }), user, [200, 409])));
  assert.deepEqual(results.map(row => row.httpStatus).sort(), [200, 409, 409, 409]); assert.equal(await version(), String(BigInt(competingVersion) + 1n));
  prior = await fresh(id); await save(input(competingVersion, { changeOps: [add()] }), a, 409); assert.deepEqual(await fresh(id), prior);
  const response = await fetch(origin + path, { method: 'PATCH', headers: { Cookie: 'geekdash_dev=' + a.token, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-Account': users[0].id }, body: JSON.stringify(input(await version(), { changeOps: [add()] })) }); assert.equal(response.status, 403);
  await b.api(path + '/responsibility', 'POST', { action: 'leave', expectedVersion: await version(), idempotencyKey: randomUUID() }); prior = await fresh(id); const noOwner = input(await version(), { changeOps: [add()] }); await save(noOwner, b, 403); await b.api(path + '/save-preview', 'POST', noOwner, 403); assert.deepEqual(await fresh(id), prior);
  const actor = await identities(runtime).resolve(a.token); await c.execute('UPDATE users SET enabled=0 WHERE id=?', [users[0].id]); await assert.rejects(() => projectSaves(runtime).save(id, validateSave(input('1', { changeOps: [add()] })), randomUUID(), actor), error => error.code === 'AUTH_REQUIRED'); await c.execute('UPDATE users SET enabled=1 WHERE id=?', [users[0].id]);
  checks.push('有限白名单/类型/UTF/字节/原因/未知/跨项目/重复临时引用逐项不写；四真实会话同版一胜三冲突，CSRF/失权/事务内停用不可绕过');

  const risk = { op: 'add', tempId: randomUUID(), content: '混合风险', level: 'mid' }, node = { op: 'add', tempId: randomUUID(), kind: 'project', fields: { title: '混合节点', stage: 'S4', output: '人工成果' } }, mixed = add();
  const mixedCreate = await perform([mixed], a, { summaryNote: '四种正式写入同一事务', riskOps: [risk], nodeOps: [node] }); const riskId = mixedCreate.result.riskIdMap[risk.tempId], nodeId = mixedCreate.result.nodeIdMap[node.tempId], changeId = mixedCreate.result.changeIdMap[mixed.tempId];
  assert.equal(mixedCreate.result.risks.find(row => row.id === riskId).content, risk.content); assert.equal(mixedCreate.result.nodes.find(row => row.id === nodeId).title, node.fields.title);
  const faultBody = () => ({ summaryNote: '所有对象写点失败须一并回滚', riskOps: [{ op: 'correct', id: riskId, changes: { content: '故障风险新值' }, reason: '明确修改' }], nodeOps: [{ op: 'correct', id: nodeId, changes: { output: '故障新成果' }, reason: '明确修改' }], changeOps: [add(), add('业务', 'reject'), correct(A, { content: '故障内容A' }), correct(B, { content: '故障内容B' })] });
  for (const [point, count] of [['UPDATE projects SET', 1], ['UPDATE project_risks', 1], ['UPDATE project_nodes', 1], ['INSERT INTO project_changes', 2], ['UPDATE project_changes', 2], ['INSERT INTO audit_log', 4], ['INSERT INTO command_receipts', 1]]) { const body = input(await version(), faultBody()); prior = await fresh(id); fault = point; faultAfter = count; await save(body, a, 500); fault = ''; assert.deepEqual(await fresh(id), prior); }
  const lost = add(), lostBody = input(await version(), { ...faultBody(), changeOps: [lost, correct(lost.tempId, { decision: 'reject' })] }); fault = 'ack'; assert.equal((await save(lostBody, a, 503)).code, 'COMMIT_UNKNOWN'); fault = '';
  const receipt = await a.api(path + '/save-results/query', 'POST', lostBody); assert.equal(receipt.outcome, 'committed'); prior = await fresh(id); await app.close(); app = undefined; await start(); assert.deepEqual((await save(lostBody)).result, receipt.result); assert.deepEqual((await a.api(path + '/save-results/query', 'POST', lostBody)).result, receipt.result); assert.deepEqual(await fresh(id), prior); assert.equal((await detail()).changes.find(row => row.id === receipt.result.changeIdMap[lost.tempId]).decision, 'reject');
  assert.deepEqual((await save(created.body)).result, created.result); assert.deepEqual((await save(mixedCreate.body)).result, mixedCreate.result);
  checks.push('文字/风险/节点/变更原子保存，各写点含第二对象失败完整SQL回滚；真实COMMIT丢确认/应用重建后原会话、映射、原结果及新请求保持');

  // 实际固定D/E产物在同库运行；未知新正文不可另造替代记录。
  const legacyTextBody = input(await version(), { detailNote: '旧D/E正文可回读' }), legacyText = (await save(legacyTextBody)).result;
  prior = await fresh(id); await app.close(); app = undefined; const oldRuntime = await fallbackModules[1].openRuntimeDatabase('test_app'), oldApp = await fallbackModules[0].createApp(oldRuntime, { origin: authOrigin, secure: false });
  try {
    origin = await oldApp.listen({ host: '127.0.0.1', port: 0 }); assert.deepEqual((await a.api(path + '/save-results/query', 'POST', legacyTextBody)).result, legacyText);
    await a.api(path + '/save-results/query', 'POST', lostBody, 400); await save(lostBody, a, 400); const oldDetail = await detail(); assert.equal(oldDetail.changes.find(row => row.id === receipt.result.changeIdMap[lost.tempId]).decision, 'reject'); assert.deepEqual(await fresh(id), prior);
  } finally { await oldApp.close(); }
  await start(); assert.deepEqual((await a.api(path + '/save-results/query', 'POST', lostBody)).result, receipt.result); assert.deepEqual((await save(lostBody)).result, receipt.result); assert.deepEqual(await fresh(id), prior);
  const build = (await a.api('/api/health/live')).build; checks.push('实际2a342d6兼容D/E同库回退，旧会话/文字结果/当前变更保持；新changeOps窗口未知保留正文，升级后原结果确认无重写');
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/project-changes-check.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount: measurements.length, measurements, build, fallbackBuild, isolatedTestDatabase: true }, null, 2) + '\n'); console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount: measurements.length }));
} finally {
  if (app) await app.close();
  for (const id of projects) { await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?', [id]); for (const table of ['project_changes', 'project_risks', 'project_nodes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
