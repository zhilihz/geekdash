import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';
import { addDays, businessToday } from '../dist/server/modules/project-dates.js';

const prefix = 'integration_' + randomUUID().slice(0, 8), password = '集成验证 password 长短语 2026';
const users = [], projects = [], receipts = [], checks = [];
let app, runtime, origin, fault = '', ownConfig = false, requestCount = 0;
const { connection: c } = await connectDatabase('test_migrator');
async function start() {
  runtime = await openRuntimeDatabase('test_app'); const transaction = runtime.writeTransaction;
  runtime.writeTransaction = work => transaction(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) { return execute.call(this, fault && sql.startsWith(fault) ? 'INSERT INTO __missing_integration_table VALUES (1)' : sql, params); };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw new Error('lost acknowledgement'); };
    try { return await work(lease); } finally { lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
}
function client() {
  let cookie = '', csrf = '', account;
  return { async api(path, method = 'GET', body, status = 200) {
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
    const data = await response.json(); requestCount++;
    if (Array.isArray(status)) { assert(status.includes(response.status), path + ': ' + data.code); data.httpStatus = response.status; } else assert.equal(response.status, status, path + ': ' + data.code);
    if (path === '/api/auth/me' && status === 200) account = data.account; return data;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); } };
}
async function fresh(id) {
  const { connection } = await connectDatabase('test_app');
  try {
    const result = {};
    for (const table of ['projects', 'project_stages', 'project_responsibilities', 'project_checks', 'schedule_changes', 'project_nodes', 'project_risks', 'project_changes', 'audit_log']) result[table] = (await connection.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY ${table === 'project_responsibilities' ? 'user_id' : 'id'}`, [id]))[0];
    result.receipts = (await connection.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0]; return result;
  } finally { await connection.end(); }
}
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  for (const table of ['projects', 'system_configuration', 'check_rule_revisions']) assert.equal(Number((await c.query('SELECT COUNT(*) n FROM ' + table))[0][0].n), 0, '隔离夹具非空，核对后接续，不覆盖');
  const hash = await hashPassword(password);
  for (let i = 0; i < 5; i++) { const loginName = prefix + '_' + i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '集成合成账号' + i]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await start(); const clients = Array.from({ length: 5 }, client), [a, b, third, fourth, maint] = clients;
  for (const [i, user] of clients.entries()) await user.login(i);
  await c.execute("INSERT INTO system_configuration (id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))", [users[4].id, users[4].id]); ownConfig = true;
  let rule = await maint.api('/api/settings/check-rule'); await maint.api('/api/settings/check-rule', 'POST', { action: 'initializeCheckRule', deadlineWeekday: 5, expectedVersion: rule.configVersion, previewWeek: rule.weekStart, idempotencyKey: randomUUID() }); rule = await maint.api('/api/settings/check-rule');
  const creation = { idempotencyKey: randomUUID(), fields: { name: prefix, summaryNote: '原面板跨功能合成输入' } }, created = (await a.api('/api/projects', 'POST', creation)).result;
  const id = created.projectId, path = '/api/projects/' + id, today = businessToday(); projects.push(id);
  receipts.push({ user: a, path: '/api/projects/create-results/query', body: creation, result: created });
  const detail = () => a.api(path), version = async () => (await detail()).project.version;
  for (const user of [b, third, fourth]) { const body = { action: 'join', expectedVersion: await version(), idempotencyKey: randomUUID() }, result = (await user.api(path + '/responsibility', 'POST', body)).result; receipts.push({ user, path: path + '/responsibility-results/query', body, result }); }
  async function perform(kind, extra, user = a) {
    const body = { expectedVersion: await version(), idempotencyKey: randomUUID(), ...(kind === 'save' ? { changes: extra } : extra) }, before = await fresh(id);
    if (kind === 'save' || !['startStage', 'completeStage', 'startProject'].includes(extra.action)) await user.api(path + (kind === 'save' ? '/save-preview' : '/actions/preview'), 'POST', body);
    assert.deepEqual(await fresh(id), before);
    const result = (await user.api(path + (kind === 'save' ? '' : '/actions'), kind === 'save' ? 'PATCH' : 'POST', body)).result;
    assert.equal((await detail()).project.version, result.savedVersion); receipts.push({ user, path: path + (kind === 'save' ? '/save-results/query' : '/action-results/query'), body, result }); return result;
  }
  const tempA = randomUUID(), tempB = randomUUID(), tempRisk = randomUUID(), tempChange = randomUUID();
  const mixed = await perform('save', { summaryNote: '四种正式内容同一保存', stagePlans: [{ code: 'S1', plannedDays: 2, note: '原卡片工期评述' }], riskOps: [{ op: 'add', tempId: tempRisk, content: '人工记录风险', level: 'high' }], nodeOps: [tempA, tempB].map((tempId, i) => ({ op: 'add', tempId, kind: 'project', fields: { title: '集成节点' + i, stage: 'S1', output: '原成果' } })), changeOps: [{ op: 'add', tempId: tempChange, source: '客户', content: '原客户需求', decision: 'accept', reason: '人工决定' }] });
  const A = mixed.nodeIdMap[tempA], B = mixed.nodeIdMap[tempB], R = mixed.riskIdMap[tempRisk], C = mixed.changeIdMap[tempChange];
  await perform('save', { nodeOps: [{ op: 'link', from: A, to: B, replaceEdges: [], affectedIds: [], reason: '' }, { op: 'complete', id: A, completedOn: today }, { op: 'complete', id: B, completedOn: today }] }, b);
  await perform('action', { action: 'startStage', stageCode: 'S1', actualDate: today }); await perform('action', { action: 'completeStage', stageCode: 'S1', actualDate: today }, b);
  await perform('action', { action: 'startProject', actualDate: today, dueDate: addDays(today, 10), configVersion: rule.configVersion, ruleVersion: rule.rule.version, previewWeek: rule.weekStart, previewFirstCheckWeek: rule.firstCheckWeek });
  const obligation = (await detail()).project.firstCheckWeek;
  await perform('action', { action: 'startStage', stageCode: 'S2', actualDate: today }); await perform('action', { action: 'completeStage', stageCode: 'S2', actualDate: today }, b); await perform('action', { action: 'startStage', stageCode: 'S3', actualDate: today });
  await perform('action', { action: 'rollbackStage', stageCode: 'S2', reason: '真实返工，明确重做' }, b);
  let d = await detail(); assert.equal(d.stages[1].state, 'ready'); assert.equal(d.stages[2].state, 'locked'); assert(d.nodes.every(n => n.completedOn === today));
  await perform('action', { action: 'startStage', stageCode: 'S2', actualDate: today });
  const checkInput = note => ({ action: 'saveCheck', conclusion: 'checked', note, ruleVersion: rule.rule.version, previewWeek: rule.weekStart });
  const firstCheck = await perform('action', checkInput('第一次明确核对'), b);
  await perform('save', { changeOps: [{ op: 'correct', id: C, changes: { decision: 'reject', reason: '原选择误点，人工拒绝' }, correctionReason: '明确纠错' }], riskOps: [{ op: 'resolve', id: R, resolution: '人工核对已解除' }] });
  d = await detail(); assert.equal(d.project.checkStatus.updatedAfterCheck, true);
  await perform('action', checkInput('再次明确核对'), third); assert.equal((await detail()).project.checkStatus.updatedAfterCheck, false);
  checks.push('四真实负责人、文字工期/风险节点变更统一保存、S1/实际启动/S2/S3与返工、首次义务保持、首次与最新检查消费');

  await perform('action', { action: 'pauseProject', reason: '等待客户反馈' });
  await perform('action', { action: 'correctProjectDates', changes: { dueDate: null }, reason: '误录日期，当前计划未定' }, b);
  await perform('save', { summaryNote: '暂停期间最新说明', nodeOps: [{ op: 'delete', id: B, removeEdges: [{ from: A, to: B }] }] }, third);
  assert.equal((await detail()).project.checkStatus.required, false);
  await perform('action', { action: 'resumeProject', note: '已明确新的计划', dueDate: addDays(today, 15) }, b);
  await perform('save', { nodeOps: [{ op: 'restore', id: B, reason: '原节点误删，恢复原事实' }] });
  d = await detail(); assert.equal(d.project.status, 'ongoing'); assert.equal(d.project.firstCheckWeek, obligation); assert.equal(d.project.summaryNote, '暂停期间最新说明'); assert.equal(d.nodes.find(n => n.id === B).completedOn, today); assert.equal(d.nodes.find(n => n.id === B).previousNodeId, null);
  await perform('action', { action: 'closeProject', closureType: 'normal', closedOn: today, closureNote: '人工确认结案', remainingWorkNote: '未完成阶段后续核对' }, fourth);
  d = await detail(); const closureId = d.currentClosure.auditId; assert.equal(d.project.status, 'closed'); assert.equal(Number(d.project.progress), 5); assert.equal(d.project.checkStatus.required, false);
  await perform('action', checkInput('结案后主动核对'));
  await perform('action', { action: 'setMaintenance', enabled: true, reason: '结案后维护' }, b);
  assert.equal((await detail()).project.status, 'closed');
  await perform('action', { action: 'reopenProject', closureAuditId: closureId, reason: '明确重新继续研发' });
  await perform('action', { action: 'correctStageFacts', changes: [{ code: 'S2', startedOn: null }], reason: '日期误记，实际暂不清楚' });
  await perform('action', { action: 'correctProjectDates', changes: { dueDate: null }, reason: '当前计划待明确' });
  await perform('action', { action: 'correctCheck', checkId: firstCheck.checkId, conclusion: 'follow_up', note: '第一次核对结论纠正', reason: '原文字误填' }, b);
  d = await detail(); assert.equal(d.project.status, 'ongoing'); assert.equal(d.project.firstCheckWeek, obligation); assert.equal(d.stages[1].state, 'active'); assert.equal(d.stages[1].startedOn, null); assert.equal(d.project.dueDate, null); assert.equal(d.changes.find(x => x.id === C).decision, 'reject'); assert.equal(d.project.signal, 'green');
  checks.push('暂缓改计划/普通子记录→恢复→同ID节点恢复→遗留结案/主动检查/维护→可靠重开、实际未知纠错、原检查文字纠正，原创建及首次义务保留');

  let before = await fresh(id), oldVersion = await version();
  const competing = await Promise.all(clients.slice(0, 4).map((user, i) => user.api(path, 'PATCH', { expectedVersion: oldVersion, idempotencyKey: randomUUID(), changes: { summaryNote: '集成四人竞争' + i } }, [200, 409])));
  assert.deepEqual(competing.map(r => r.httpStatus).sort(), [200, 409, 409, 409]);
  const stale = { expectedVersion: oldVersion, idempotencyKey: randomUUID(), action: 'pauseProject', reason: '过期独立动作不可覆盖' }; before = await fresh(id); await a.api(path + '/actions', 'POST', stale, 409); assert.deepEqual(await fresh(id), before);
  const leave = { expectedVersion: await version(), idempotencyKey: randomUUID(), action: 'leave' }; await fourth.api(path + '/responsibility', 'POST', leave);
  const illegal = { expectedVersion: await version(), idempotencyKey: randomUUID(), changes: { summaryNote: '不可部分保存', changeOps: [{ op: 'correct', id: C, changes: { decision: 'reject' }, correctionReason: '' }] } };
  before = await fresh(id); await a.api(path, 'PATCH', illegal, 422); await fourth.api(path, 'PATCH', { ...illegal, changes: { summaryNote: '失权不能写' } }, 403); assert.deepEqual(await fresh(id), before);
  const faultBody = { expectedVersion: await version(), idempotencyKey: randomUUID(), changes: { summaryNote: '事务必须一起提交', changeOps: [{ op: 'correct', id: C, changes: { content: '集成故障后正式内容' }, correctionReason: '人工核对' }] } };
  fault = 'INSERT INTO audit_log'; await a.api(path, 'PATCH', faultBody, 500); fault = ''; assert.deepEqual(await fresh(id), before);
  fault = 'ack'; assert.equal((await a.api(path, 'PATCH', faultBody, 503)).code, 'COMMIT_UNKNOWN'); fault = '';
  const restored = (await a.api(path + '/save-results/query', 'POST', faultBody)).result; assert(restored); receipts.push({ user: a, path: path + '/save-results/query', body: faultBody, result: restored });
  before = await fresh(id); await app.close(); app = undefined; await start();
  for (const item of receipts) assert.deepEqual((await item.user.api(item.path, 'POST', item.body)).result, item.result);
  assert.deepEqual(await fresh(id), before); d = await detail(); assert.equal(d.project.summaryNote, faultBody.changes.summaryNote); assert.equal(d.changes.find(x => x.id === C).content, '集成故障后正式内容');
  const board = await a.api('/api/projects?view=all&search=' + encodeURIComponent(prefix)); assert.equal(board.pagination.total, 1); assert.equal(board.items[0].version, d.project.version); assert.equal(board.items[0].checkStatus.updatedAfterCheck, true);
  checks.push('四会话普通保存竞争一胜三冲突、旧动作/失权/混合非法拒绝；目标审计失败全部回滚、真实COMMIT丢确认重建后原会话及全链原结果、新SQL/看板消费');
  await mkdir('test-results', { recursive: true }); const facts = { status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount, originalReceiptsAfterRestart: receipts.length, finalVersion: d.project.version, build: (await a.api('/api/health/live')).build, isolatedTestDatabase: true, syntheticOnly: true, nativeBrowserAcceptance: false };
  await writeFile('test-results/project-integration-check.json', JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts));
} finally {
  await app?.close();
  for (const id of projects) { await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?', [id]); for (const table of ['project_changes', 'project_risks', 'project_nodes', 'project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); }
  if (ownConfig) { await c.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?', [users[4].id]); await c.execute('DELETE FROM check_rule_revisions WHERE saved_by=?', [users[4].id]); }
  for (const user of users) await c.execute('DELETE FROM users WHERE id=?', [user.id]); await c.end();
}
