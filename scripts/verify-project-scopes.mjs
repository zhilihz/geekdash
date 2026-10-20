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
const prefix = 'scope_' + randomUUID().slice(0, 8), password = '范围保存 test password 2026';
const users = [], projects = [], refs = [], catalogs = [], checks = [];
let app, runtime, origin, fault = '';
async function start() {
  runtime = await openRuntimeDatabase('test_app');
  const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) {
      if (fault && sql.startsWith(fault)) return execute.call(this, 'INSERT INTO __scope_failure VALUES (1)');
      return execute.call(this, sql, params);
    };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw new Error('lost COMMIT acknowledgement'); };
    try { return await work(lease); } finally { lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: 'http://localhost', secure: false });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
}
function client() {
  let cookie = '', csrf = '', account;
  return { async api(path, method = 'GET', body, expected = 200) {
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
    const result = await response.json();
    if (Array.isArray(expected)) { assert(expected.includes(response.status), path + JSON.stringify(result)); result.httpStatus = response.status; }
    else assert.equal(response.status, expected, path + JSON.stringify(result));
    if (result.account) account = result.account;
    return result;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].name, password }); await this.api('/api/auth/me'); } };
}
async function fresh(id) {
  const { connection: read } = await connectDatabase('test_app');
  try {
    const result = {};
    for (const table of ['projects', 'project_stages', 'project_people', 'project_nodes', 'project_risks', 'project_changes', 'schedule_changes', 'audit_log']) {
      result[table] = (await read.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY ${table === 'project_people' ? 'engineer_id,role' : 'id'}`, [id]))[0];
    }
    result.receipts = (await read.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0];
    return result;
  } finally { await read.end(); }
}
const body = (version, scope, changes, extra = {}) => ({ expectedVersion: version, idempotencyKey: randomUUID(), scope, changes, ...extra });
try {
  for (let i = 0; i < 2; i++) {
    await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix + i, await hashPassword(password), '范围测试' + i]);
    users.push({ id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id, name: prefix + i });
  }
  await start(); const a = client(), b = client(); await a.login(0); await b.login(1);
  const made = await a.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix, summary: '初始简介' } });
  const id = made.result.projectId, path = '/api/projects/' + id; projects.push(id);
  let version = '1';
  const save = async (scope, changes, extra = {}) => {
    const request = body(version, scope, changes, extra), response = await a.api(path, 'PATCH', request);
    version = response.result.savedVersion;
    assert.equal((await a.api(path)).project.version, version);
    assert.equal(String((await fresh(id)).projects[0].version), version);
    return { request, result: response.result };
  };
  await b.api(path, 'PATCH', body(version, 'basic', { name: '无权' }), 403);
  const before = await fresh(id);
  for (const request of [body(version, 'basic', { statusDesc: '夹带' }), body(version, 'status', { name: '夹带' }), body(version, 'tags', { priority: 'low' }), body(version, 'signal', { signal: 'purple' }), body(version, 'basic', { status: 'closed' }), body(version, 'basic', { people: [{ id: users[0].id, role: 'pm' }] }), body(version, 'stage', { stagePlans: [{ code: 'S1', note: 'a' }, { code: 'S2', note: 'b' }] }, { target: 'S1' })]) await a.api(path, 'PATCH', request, [400, 422]);
  await a.api(path, 'PATCH', { expectedVersion: version, idempotencyKey: randomUUID(), changes: { name: '旧全页协议' } }, 409);
  assert.deepEqual(await fresh(id), before);
  checks.push('PRD9.1/9.4/9.6：范围与字段拒绝、无资格拒绝、旧协议无新写入；独立SQL保持');

  await c.execute("INSERT INTO engineers (name,role,created_at,updated_at) VALUES (?,'pm',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [prefix]);
  const engineer = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id; refs.push(engineer);
  const selected = {};
  for (const [table, columns, blank] of [['customers', ',contact,background', ",'' ,''"], ['chips', ',original_model,manufacturer,firmware_version', ",'' ,'' ,''"], ['apps', ',app_version,description', ",'' ,''"], ['product_lines', '', ''], ['project_groups', '', ''], ['tags', '', '']]) {
    await c.execute(`INSERT INTO ${table} (name${columns},created_at,updated_at) VALUES (?${blank},UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [prefix]);
    selected[table] = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id; catalogs.push([table, selected[table]]);
  }
  const creation = { idempotencyKey: randomUUID(), fields: { name: '完整创建 ' + prefix, summary: '独立简介', marketExpectation: '市场', detailNote: '详情', statusDesc: '最新说明', priority: 'high', customerId: selected.customers, odmCustomerId: selected.customers, productLineId: selected.product_lines, appId: selected.apps, groupId: selected.project_groups, chipIds: [selected.chips], people: [{ id: engineer, role: 'hardware_owner' }], filingDate: '2026-01-01', dueDate: '2030-12-31' } };
  const created = await a.api('/api/projects', 'POST', creation); projects.push(created.result.projectId);
  const newDetail = await a.api('/api/projects/' + created.result.projectId);
  assert.equal(newDetail.project.summary, '独立简介'); assert.equal(newDetail.project.statusDesc, '最新说明'); assert.equal(newDetail.project.summaryNote, '');
  assert.equal(newDetail.project.chips[0].id, selected.chips); assert.equal(newDetail.project.people[0].id, engineer); assert.equal(newDetail.responsible[0].id, users[0].id);
  assert.equal(newDetail.project.filingDate, '2026-01-01'); assert.equal(newDetail.project.dueDate, '2030-12-31'); assert.equal(newDetail.stages.length, 7);
  const createdFacts = await fresh(created.result.projectId); assert.equal(createdFacts.audit_log.length, 1); assert.equal(createdFacts.projects[0].status, 'proposal');
  assert.deepEqual((await a.api('/api/projects', 'POST', creation)).result, created.result); assert.deepEqual(await fresh(created.result.projectId), createdFacts);
  assert.deepEqual((await a.api('/api/projects/create-results/query', 'POST', creation)).result, created.result);
  await c.execute('UPDATE chips SET enabled=0 WHERE id=?', [selected.chips]);
  const countProjects = async () => Number((await c.query('SELECT COUNT(*) n FROM projects WHERE created_by=?', [users[0].id]))[0][0].n);
  const countBefore = await countProjects(); await a.api('/api/projects', 'POST', { ...creation, idempotencyKey: randomUUID() }, 422); assert.equal(await countProjects(), countBefore);
  await c.execute('UPDATE chips SET enabled=1 WHERE id=?', [selected.chips]);
  fault = 'INSERT INTO audit_log'; await a.api('/api/projects', 'POST', { ...creation, idempotencyKey: randomUUID() }, 503); fault = ''; assert.equal(await countProjects(), countBefore);
  checks.push('PRD9.5：完整同构字段创建、七阶段与创建者负责、简介和原备注独立；新GET/SQL、原号重放、停用资料与审计失败无孤儿项目');
  await c.execute("INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,'pm',0)", [id, engineer]);
  const basic = await save('basic', { name: prefix + '修改', summary: '独立简介', people: [{ id: engineer, role: 'hardware_owner' }] });
  assert(!Object.hasOwn(basic.result.values, 'statusDesc')); assert(!Object.hasOwn(basic.result.display, 'tagIds'));
  assert.equal((await fresh(id)).project_people.filter(p => p.role === 'pm').length, 1);
  assert.equal((await a.api(path)).responsible[0].id, users[0].id);
  const status = await save('status', { statusDesc: '第一行\n最新状态' }); assert.deepEqual(Object.keys(status.result.values), ['statusDesc']);
  await save('summaryNote', { summaryNote: '汇总备注' }); await save('chipstatNote', { chipstatNote: '芯片备注' });
  await save('signal', { signal: 'red', signalNote: '人工说明' });
  let scopeRead=await a.api(path),scopeFacts=await fresh(id);
  assert.equal(scopeRead.project.signal,'red');assert.equal(scopeRead.project.signalNote,'人工说明');
  assert.equal(scopeFacts.projects[0].signal,'red');assert.equal(scopeFacts.projects[0].signal_note,'人工说明');
  assert.equal(scopeRead.project.statusDesc,'第一行\n最新状态');assert.equal(scopeRead.project.summaryNote,'汇总备注');assert.equal(scopeRead.project.chipstatNote,'芯片备注');
  await save('tags', { tagIds: [selected.tags] });
  assert.deepEqual((await a.api(path)).project.tags.map(tag=>tag.id),[selected.tags]);
  assert((await a.api('/api/projects?view=all&tags='+encodeURIComponent(prefix))).items.some(project=>project.id===id));
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_tags WHERE project_id=? AND tag_id=?',[id,selected.tags]))[0][0].n),1);
  await save('tags', { tagIds: [] });
  assert.deepEqual((await a.api(path)).project.tags,[]);assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_tags WHERE project_id=?',[id]))[0][0].n),0);
  assert(!(await a.api('/api/projects?view=all&tags='+encodeURIComponent(prefix))).items.some(project=>project.id===id));
  await save('status', { statusDesc: '' });scopeRead=await a.api(path);scopeFacts=await fresh(id);
  assert.equal(scopeRead.project.statusDesc,'');assert.equal(scopeFacts.projects[0].status_description,'');
  assert.equal(scopeRead.project.summaryNote,'汇总备注');assert.equal(scopeRead.project.chipstatNote,'芯片备注');assert.equal(scopeRead.project.signal,'red');
  assert.equal((await a.api('/api/project-summary')).items.find(project=>project.id===id).statusDesc,'');
  assert.equal((await a.api('/api/projects?view=all&search='+encodeURIComponent(prefix))).items.find(project=>project.id===id).statusDesc,'');
  await save('status', { statusDesc: '第一行\n最新状态' });
  const stage = await save('stage', { stagePlans: [{ code: 'S1', plannedDays: 5, note: '阶段说明' }] }, { target: 'S1' });
  assert.equal(stage.result.values.stagePlans.length, 1);
  let facts = await fresh(id); const nAudit = facts.audit_log.length;
  const noop = await save('status', { statusDesc: '第一行\n最新状态' }); assert.equal(noop.result.changed, false); assert.equal((await fresh(id)).audit_log.length, nAudit);
  assert.deepEqual((await a.api(path, 'PATCH', status.request)).result, status.result);
  assert.deepEqual((await a.api(path + '/save-results/query', 'POST', status.request)).result, status.result);
  await a.api(path, 'PATCH', { ...status.request, changes: { statusDesc: '不同内容' } }, 409);
  await a.api(path, 'PATCH', { ...status.request, scope: 'summaryNote', changes: { summaryNote: '相同编号不同范围' } }, 409);
  checks.push('PRD9.4/9.6/9.7/9.20：各范围独立保存、旧PM来源保留、真实经理未改、无变化及重放不新增事实');

  const dueDate = '2030-12-31';
  const combined = await save('basic', { name: prefix + '改期并暂缓' }, { commands: [{ action: 'pauseProject', reason: '合成暂缓' }, { action: 'setPlan', dueDate }] });
  facts = await fresh(id); assert.equal(facts.projects[0].status, 'paused'); assert.equal(facts.projects[0].current_due_date.toISOString().slice(0, 10), dueDate);
  assert.equal(combined.result.actions.length, 2);
  const audits = facts.audit_log.filter(row => String(row.version_after) === version); assert.equal(audits.length, 3); assert.equal(new Set(audits.map(row => String(row.version_before))).size, 1);
  assert.deepEqual((await a.api(path, 'PATCH', combined.request)).result, combined.result);
  for (const point of ['INSERT INTO schedule_changes', 'INSERT INTO audit_log', 'INSERT INTO command_receipts']) {
    const old = await fresh(id); fault = point;
    await a.api(path, 'PATCH', body(version, 'basic', { name: '不能留半份' }, { commands: [{ action: 'reschedulePlan', dueDate: '2031-01-01', reason: '合成调整', measures: '' }, { action: 'resumeProject', note: '' }] }), 500);
    fault = ''; assert.deepEqual(await fresh(id), old);
  }
  const old = await fresh(id);
  await a.api(path, 'PATCH', body(version, 'basic', { name: '名称不能先保存' }, { commands: [{ action: 'reschedulePlan', dueDate: '2031-01-01', reason: '调整', measures: '' }, { action: 'pauseProject', reason: '已经暂缓' }] }), 422);
  assert.deepEqual(await fresh(id), old);
  checks.push('PRD9.4/9.8/9.9：名称＋计划＋状态一次版本与三项审计；前置、改期/审计/回执故障全部回滚');
  await save('basic', {}, { commands: [{ action: 'correctProjectDates', changes: { startDate: '2026-01-01', dueDate: '2026-01-02' }, reason: '合成初值' }] });
  await save('basic', {}, { commands: [{ action: 'correctProjectDates', changes: { startDate: '2026-01-03' }, reason: '原日期误录' }, { action: 'reschedulePlan', dueDate: '2026-01-04', reason: '调整计划', measures: '' }] });
  const dateFacts = await fresh(id); assert.equal(dateFacts.projects[0].started_on.toISOString().slice(0,10), '2026-01-03');
  await a.api(path, 'PATCH', body(version, 'basic', { name: '不应保存' }, { commands: [{ action: 'correctProjectDates', changes: { startDate: '2026-01-05' }, reason: '误录' }, { action: 'reschedulePlan', dueDate: '2026-01-04', reason: '仍矛盾', measures: '' }] }), 422);
  assert.deepEqual(await fresh(id), dateFacts);
  checks.push('PRD9.4/9.8：联合开始/计划按最终候选验证，合法组合通过、最终矛盾全部回滚');

  const riskTemp = randomUUID(); const risk = await save('risk', { riskOps: [{ op: 'add', tempId: riskTemp, content: '风险甲', level: 'mid' }] }, { target: riskTemp });
  assert.equal(risk.result.risks.length, 1);
  const riskId = risk.result.riskIdMap[riskTemp];
  await save('risk', { riskOps: [{ op: 'correct', id: riskId, changes: { content: '只改文字无需原因' }, reason: '' }] }, { target: riskId });
  await save('risk', { riskOps: [{ op: 'correct', id: riskId, changes: { level: 'high' }, reason: '' }] }, { target: riskId });
  assert.equal((await a.api(path)).risks[0].level, 'high');assert.equal((await fresh(id)).project_risks[0].level, 'high');
  const riskOp = operation => body(version, 'risk', { riskOps: [operation] }, { target: riskId });
  for (const operation of [
    { op: 'resolve', id: riskId, resolution: '' },
    { op: 'undoResolve', id: riskId, reason: '尚未解除' },
    { op: 'correct', id: riskId, changes: { resolution: '不能伪装解除' }, reason: '' },
  ]) {
    const before = await fresh(id); await a.api(path, 'PATCH', riskOp(operation), 422); assert.deepEqual(await fresh(id), before);
  }
  await save('risk', { riskOps: [{ op: 'resolve', id: riskId, resolution: '已核对解决' }] }, { target: riskId });
  const resolved = (await a.api(path)).risks[0]; assert.equal(resolved.resolved, 1); assert(resolved.resolvedAt);
  const beforeRepeat = await fresh(id);
  await a.api(path, 'PATCH', riskOp({ op: 'resolve', id: riskId, resolution: '重复解除' }), 422); assert.deepEqual(await fresh(id), beforeRepeat);
  await save('risk', { riskOps: [{ op: 'correct', id: riskId, changes: { resolution: '仅纠正解除说明' }, reason: '' }] }, { target: riskId });
  const corrected = (await a.api(path)).risks[0]; assert.equal(corrected.resolvedAt, resolved.resolvedAt); assert.equal(corrected.createdAt, resolved.createdAt);
  const beforeUndo = await fresh(id); fault = 'INSERT INTO audit_log';
  await a.api(path, 'PATCH', riskOp({ op: 'undoResolve', id: riskId, reason: '误解除' }), 500); fault = ''; assert.deepEqual(await fresh(id), beforeUndo);
  await save('risk', { riskOps: [{ op: 'undoResolve', id: riskId, reason: '误解除' }] }, { target: riskId });
  const undone = (await a.api(path)).risks[0]; assert.equal(undone.resolved, 0); assert.equal(undone.resolvedAt, null); assert.equal(undone.resolution, '');
  checks.push('PRD9.10/DEC-134：等级纠错直接保存、解除与说明纠错保留原时间、重复/不合法动作不写、撤销解除故障回滚及重新保存');
  const riskBeforeDelete = await fresh(id); fault = 'INSERT INTO audit_log';
  await a.api(path, 'PATCH', body(version, 'risk', { riskOps: [{ op: 'delete', id: riskId }] }, { target: riskId }), 500); fault = ''; assert.deepEqual(await fresh(id), riskBeforeDelete);
  const deleted = await save('risk', { riskOps: [{ op: 'delete', id: riskId }] }, { target: riskId });
  assert.equal((await a.api(path)).risks.length, 0); assert((await fresh(id)).project_risks[0].deleted_at); assert.equal((await fresh(id)).project_risks[0].content, '只改文字无需原因');
  assert.deepEqual((await a.api(path, 'PATCH', deleted.request)).result, deleted.result);
  checks.push('PRD9.10/DEC-134：风险文字与等级直接保存、误录删除保留原字段、故障回滚及重放不重复');
  const another = randomUUID(); await a.api(path, 'PATCH', body(version, 'risk', { riskOps: [{ op: 'add', tempId: riskTemp, content: '甲', level: 'low' }, { op: 'add', tempId: another, content: '乙', level: 'low' }] }, { target: riskTemp }), 400);
  const changeTemp = randomUUID(); const change = await save('change', { changeOps: [{ op: 'add', tempId: changeTemp, source: '客户', content: '合成变更', decision: 'accept', reason: '合成决定' }] }, { target: changeTemp });
  const changeId = change.result.changeIdMap[changeTemp];
  await save('change', { changeOps: [{ op: 'correct', id: changeId, changes: { content: '文字纠正', reason: '决定理由补充' }, correctionReason: '' }] }, { target: changeId });
  await save('change', { changeOps: [{ op: 'correct', id: changeId, changes: { decision: 'reject' }, correctionReason: '' }] }, { target: changeId });
  assert.equal((await a.api(path)).changes[0].decision, 'reject');
  const beforeDecision = await fresh(id);assert.equal(beforeDecision.project_changes[0].decision, 'reject');
  const decisionRequest = body(version, 'change', { changeOps: [{ op: 'correct', id: changeId, changes: { source: '业务', decision: 'reject' }, correctionReason: '' }] }, { target: changeId });
  fault = 'INSERT INTO audit_log'; await a.api(path, 'PATCH', decisionRequest, 500); fault = ''; assert.deepEqual(await fresh(id), beforeDecision);
  const decisionSaved = (await a.api(path, 'PATCH', decisionRequest)).result; version = decisionSaved.savedVersion;
  const decisionRead = await a.api(path); assert.equal(decisionRead.changes[0].decision, 'reject'); assert.equal(decisionRead.changes[0].source, '业务');
  const afterDecision = await fresh(id); assert.equal(afterDecision.project_changes[0].decision, 'reject');
  assert.deepEqual(afterDecision.project_stages, beforeDecision.project_stages); assert.deepEqual(afterDecision.project_nodes, beforeDecision.project_nodes); assert.deepEqual(afterDecision.schedule_changes, beforeDecision.schedule_changes);
  assert.deepEqual((await a.api(path, 'PATCH', decisionRequest)).result, decisionSaved); assert.deepEqual(await fresh(id), afterDecision);
  checks.push('PRD9.11/DEC-134：内容/理由/来源/决定直接保存，审计故障全回滚，重试与重放及新SQL/GET确认，不自动改阶段/节点/计划');
  const nodeTemp = randomUUID(); const node = await save('projectNodes', { nodeOps: [{ op: 'add', tempId: nodeTemp, kind: 'project', fields: { title: '项目成果', stage: 'S1', output: '成果', targetDate: '2030-10-01' } }] });
  const nodeId = node.result.nodeIdMap[nodeTemp];
  const customerTemp = randomUUID(); const customer = await save('customerNode', { nodeOps: [{ op: 'add', tempId: customerTemp, kind: 'customer', fields: { title: '交付', note: '客户', targetDate: '2030-11-01' } }] }, { target: customerTemp });
  const customerId = customer.result.nodeIdMap[customerTemp];
  await a.api(path, 'PATCH', body(version, 'customerNode', { nodeOps: [{ op: 'correct', id: nodeId, changes: { title: '非法跨类' }, reason: '核查' }] }, { target: nodeId }), 400);
  await a.api(path, 'PATCH', body(version, 'projectNodes', { nodeOps: [{ op: 'correct', id: customerId, changes: { title: '非法跨类' }, reason: '核查' }] }), 400);
  const detail = await a.api(path); assert.equal(detail.stages[0].expectedEndOn, '2030-10-01'); assert.equal(detail.nodes.length, 2);
  checks.push('PRD9.10/9.11/9.12：单条记录目标隔离、客户/项目节点隔离、节点保存后阶段预计日期新GET联动');

  await b.api(path + '/responsibility', 'POST', { expectedVersion: version, idempotencyKey: randomUUID(), action: 'join' }); version = (await a.api(path)).project.version;
  const fullList = await a.api('/api/projects?view=all&details=checks&dashboard=1&search=' + encodeURIComponent(prefix));
  const card = fullList.items.find(item => item.id === id), live = await a.api(path);
  for (const key of ['project','stages','nodes','risks','changes','responsible','checkRule']) assert.deepEqual(card.inspection[key], live[key], '完整检查卡 ' + key);
  assert.equal(card.inspection.nodes.length, 2); assert.equal(card.inspection.risks.length, 0);
  assert.deepEqual(card.managers.map(person => person.id).sort(), users.map(person => person.id).sort());
  const ownerA = await a.api('/api/projects?view=all&owner=user:' + users[0].id);
  assert(ownerA.items.some(item => item.id === id)); assert(ownerA.options.owner.includes('user:' + users[1].id));
  assert.equal(ownerA.optionLabels.owner['user:' + users[1].id], '范围测试1（项目经理）');
  assert.equal(fullList.dashboard.team.find(person => person.id === 'user:' + users[0].id).pmCount, 2);
  const engineerList = await a.api('/api/projects?view=all&owner=engineer:' + engineer);
  assert(engineerList.items.some(item => item.id === id));
  await b.api(path + '/responsibility', 'POST', { expectedVersion: version, idempotencyKey: randomUUID(), action: 'leave' }); version = (await a.api(path)).project.version;
  assert(!(await a.api('/api/projects?view=all&owner=user:' + users[1].id)).items.some(item => item.id === id));
  await b.api(path, 'PATCH', body(version, 'status', { statusDesc: '退出后无权' }), 403);
  await a.api(path + '/responsibility', 'POST', { expectedVersion: version, idempotencyKey: randomUUID(), action: 'leave' }, 422);
  await b.api(path + '/responsibility', 'POST', { expectedVersion: version, idempotencyKey: randomUUID(), action: 'join' }); version = (await a.api(path)).project.version;
  checks.push('PRD9.6/9.15：完整检查卡与详情同值；真实经理加入/退出、卡片/稳定ID筛选/团队统计联动、退出无权及最后一人保护');
  const requests = [body(version, 'status', { statusDesc: '并发甲' }), body(version, 'summaryNote', { summaryNote: '并发乙' })];
  const responses = await Promise.all([a.api(path, 'PATCH', requests[0], [200, 409]), b.api(path, 'PATCH', requests[1], [200, 409])]);
  assert.deepEqual(responses.map(r => r.httpStatus).sort(), [200, 409]); version = (await a.api(path)).project.version;
  const unknown = body(version, 'basic', { name: prefix + '已提交待确认' }); fault = 'ack';
  assert.equal((await a.api(path, 'PATCH', unknown, 503)).outcome, 'unknown'); fault = '';
  const committed = await fresh(id); assert.equal(committed.projects[0].name, unknown.changes.name);
  await app.close(); app = undefined; await start(); await a.login(0);
  const confirmed = await a.api(path + '/save-results/query', 'POST', unknown); assert.equal(confirmed.outcome, 'committed');
  assert.deepEqual((await a.api(path, 'PATCH', unknown)).result, confirmed.result); assert.deepEqual(await fresh(id), committed);
  const listing = await a.api('/api/projects?view=all&search=' + encodeURIComponent(prefix)); assert.equal(listing.items.length, 2);
  checks.push('PRD9.1/9.4：不同范围同版本竞争仅一次成功；真实COMMIT丢响应、服务重启后查原回执和重放无重复；列表新请求消费');
  checks.push('PRD9.4：灯色/说明真实持久字段一致；已有标签添加后明确清空，正式关联消失；最新说明可清空且不改灯色及两类备注');
  version = (await a.api(path)).project.version;
  const leave = () => ({ expectedVersion: version, idempotencyKey: randomUUID(), action: 'leave' });
  const exits = await Promise.all([a.api(path + '/responsibility', 'POST', leave(), [200, 409]), b.api(path + '/responsibility', 'POST', leave(), [200, 409])]);
  assert.deepEqual(exits.map(result => result.httpStatus).sort(), [200, 409]);
  const remaining = await a.api(path); version = remaining.project.version;
  assert.equal(remaining.responsible.length, 1);
  const retained = remaining.responsible[0].id === users[0].id ? a : b;
  const returning = retained === a ? b : a;
  const protectedState = await fresh(id);
  await retained.api(path + '/responsibility', 'POST', leave(), 422);
  assert.deepEqual(await fresh(id), protectedState);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_responsibilities WHERE project_id=?', [id]))[0][0].n), 1);
  const rejoin = { expectedVersion: version, idempotencyKey: randomUUID(), action: 'join' };
  fault = 'ack'; assert.equal((await returning.api(path + '/responsibility', 'POST', rejoin, 503)).outcome, 'unknown'); fault = '';
  const joinedState = await fresh(id);
  await app.close(); app = undefined; await start();
  const joinedResult = await returning.api(path + '/responsibility-results/query', 'POST', rejoin);
  assert.equal(joinedResult.outcome, 'committed');
  assert.equal(joinedResult.result.savedVersion, String(BigInt(version) + 1n));
  assert.deepEqual((await returning.api(path + '/responsibility', 'POST', rejoin)).result, joinedResult.result);
  assert.deepEqual(await fresh(id), joinedState);
  assert.deepEqual((await a.api(path)).responsible.map(person => person.id).sort(), users.map(person => person.id).sort());
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_responsibilities WHERE project_id=?', [id]))[0][0].n), 2);
  checks.push('PRD9.6：两人同版本退出仅一次成功，最后经理拒绝且SQL不变；加入COMMIT丢响应后重启查原结果及重放，名单/版本/审计无重复');
  version = joinedResult.result.savedVersion;
  const redundantJoin = { expectedVersion: version, idempotencyKey: randomUUID(), action: 'join' };
  const redundant = await returning.api(path + '/responsibility', 'POST', redundantJoin);
  assert.equal(redundant.result.changed, false); assert.equal(redundant.result.savedVersion, version);
  const afterRedundant = await fresh(id);
  assert.deepEqual(afterRedundant.projects, joinedState.projects); assert.deepEqual(afterRedundant.audit_log, joinedState.audit_log);
  assert.deepEqual((await returning.api(path + '/responsibility', 'POST', redundantJoin)).result, redundant.result);
  for (const field of ['userId', 'actorId', 'responsibleUserId']) await a.api(path + '/responsibility', 'POST', { ...redundantJoin, idempotencyKey: randomUUID(), [field]: users[1].id }, 400);
  assert.deepEqual(await fresh(id), afterRedundant);
  assert.deepEqual((await a.api(path)).responsible.map(person => person.id).sort(), users.map(person => person.id).sort());
  checks.push('PRD9.6：已加入再确认不改版本/历史；原号重放同结果；请求夹带他人账号全部拒绝且SQL/责任名单不变');

  const intentProject = (await a.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + ' 业务意图' } })).result.projectId;
  projects.push(intentProject);
  const intentPath = '/api/projects/' + intentProject;
  const intentRequest = async (changes = {}, target = {}) => {
    const { project: p } = await a.api(intentPath);
    return body(p.version, 'basic', changes, { basicIntent: {
      filingDate: p.filingDate ?? '', startDate: p.startDate ?? '', dueDate: p.dueDate ?? '', closedOn: p.closedOn ?? '', proposalDate: p.proposalDate ?? '', originalDueDate: p.originalDueDate ?? '',
      state: p.status, planKind: 'reschedule', reason: '', measures: '', closureType: p.closureType === 'terminated' ? 'terminated' : 'normal', closureNote: p.closureNote ?? '', remainingWorkNote: p.remainingWorkNote ?? '', maintenance: !!p.maintenanceEnabled, ...target,
    } });
  };
  const initialIntent = await intentRequest({ name: '意图字段不能半保存' });
  const intentBefore = await fresh(intentProject);
  for (const request of [
    { ...initialIntent, commands: [{ action: 'pauseProject', reason: '不能混用' }] },
    { ...initialIntent, scope: 'status', changes: { statusDesc: '跨区' } },
    { ...initialIntent, basicIntent: { ...initialIntent.basicIntent, state: ['closed'] } },
    { ...initialIntent, basicIntent: { ...initialIntent.basicIntent, dueDate: null } },
    { ...initialIntent, basicIntent: { ...initialIntent.basicIntent, maintenance: 'true' } },
  ]) await a.api(intentPath, 'PATCH', request, [400, 422]);
  await b.api(intentPath, 'PATCH', initialIntent, 403);
  assert.deepEqual(await fresh(intentProject), intentBefore);
  const pauseIntent = await intentRequest({ name: prefix + ' 计划与暂缓' }, { state: 'paused', dueDate: '2030-12-31', reason: '等待客户确认' });
  const pausedIntent = (await a.api(intentPath, 'PATCH', pauseIntent)).result;
  let intentFacts = await fresh(intentProject), intentDetail = await a.api(intentPath);
  assert.equal(intentDetail.project.status, 'paused'); assert.equal(intentDetail.project.dueDate, '2030-12-31'); assert.equal(intentDetail.project.version, '2');
  assert.equal(intentFacts.projects[0].status, 'paused'); assert.equal(intentFacts.audit_log.filter(row => String(row.version_after) === '2').length, 3);
  assert.deepEqual(pausedIntent.actions.map(effect => effect.action), ['project.plan.setPlan', 'project.pause']);
  assert.deepEqual((await a.api(intentPath, 'PATCH', pauseIntent)).result, pausedIntent);
  await a.api(intentPath, 'PATCH', { ...pauseIntent, basicIntent: { ...pauseIntent.basicIntent, reason: '编号不能换正文' } }, 409);
  checks.push('PRD9.4：新basicIntent边界、权限与旧commands互斥；名称/计划/暂缓由服务端推导一次版本，SQL/新GET/原号回执一致');

  const resumeIntent = await intentRequest({ summary: '恢复后的简介' }, { state: 'proposal', filingDate: '2026-01-01', dueDate: '2031-01-01', reason: '客户调整交付安排' });
  for (const point of ['INSERT INTO schedule_changes', 'INSERT INTO audit_log', 'INSERT INTO command_receipts']) {
    const preserved = await fresh(intentProject); fault = point;
    await a.api(intentPath, 'PATCH', resumeIntent, 500); fault = '';
    assert.deepEqual(await fresh(intentProject), preserved);
  }
  await a.api(intentPath, 'PATCH', { ...resumeIntent, basicIntent: { ...resumeIntent.basicIntent, state: 'ongoing' } }, 422);
  const resumedIntent = (await a.api(intentPath, 'PATCH', resumeIntent)).result;
  intentDetail = await a.api(intentPath); intentFacts = await fresh(intentProject);
  assert.equal(intentDetail.project.status, 'proposal'); assert.equal(intentDetail.project.filingDate, '2026-01-01'); assert.equal(intentDetail.project.dueDate, '2031-01-01');
  assert.equal(intentDetail.project.summary, '恢复后的简介'); assert.equal(resumedIntent.actions.length, 3);
  assert.equal(String(intentFacts.projects[0].version), resumedIntent.savedVersion);
  const rescheduleCount = intentFacts.schedule_changes.length;
  const correctIntent = await intentRequest({}, { dueDate: '2031-01-02', planKind: 'correction' });
  await a.api(intentPath, 'PATCH', correctIntent);
  assert.equal((await a.api(intentPath)).project.dueDate, '2031-01-02'); assert.equal((await fresh(intentProject)).schedule_changes.length, rescheduleCount);
  await a.api(intentPath, 'PATCH', await intentRequest({}, { dueDate: '', planKind: 'correction' }));
  assert.equal((await a.api(intentPath)).project.dueDate, null); assert.equal((await fresh(intentProject)).projects[0].current_due_date, null);
  checks.push('PRD9.4/9.8：意图联合日期/改期/恢复按正式前态推导；三写入故障全回滚，纠错与明确清空不伪造改期');

  const invalidStart = await intentRequest({ name: '前阶段未完成不能启动' }, { state: 'ongoing', startDate: '2026-01-02' });
  const unstarted = await fresh(intentProject); await a.api(intentPath, 'PATCH', invalidStart, 422); assert.deepEqual(await fresh(intentProject), unstarted);
  for (const action of ['startStage', 'completeStage']) {
    const p = (await a.api(intentPath)).project;
    await a.api(intentPath + '/actions', 'POST', { expectedVersion: p.version, idempotencyKey: randomUUID(), action, stageCode: 'S1', actualDate: '2026-01-01' });
  }
  const started = (await a.api(intentPath, 'PATCH', await intentRequest({ detailNote: '实际启动与资料同时保存' }, { state: 'ongoing', startDate: '2026-01-02', dueDate: '2031-01-02' }))).result;
  intentDetail = await a.api(intentPath); assert.equal(intentDetail.project.startDate, '2026-01-02'); assert.equal(intentDetail.project.status, 'ongoing');
  assert.equal(intentDetail.project.detailNote, '实际启动与资料同时保存'); assert.equal(String((await fresh(intentProject)).projects[0].version), started.savedVersion);
  const closed = (await a.api(intentPath, 'PATCH', await intentRequest({}, { state: 'closed', closedOn: '2026-01-03', closureNote: '保留未完成阶段，后续再接续' }))).result;
  const closedFacts = await fresh(intentProject);
  const rename = (await a.api(intentPath, 'PATCH', await intentRequest({ name: prefix + ' 结案后名称纠错' }))).result;
  assert.equal(rename.actions, undefined); intentFacts = await fresh(intentProject);
  assert.equal(intentFacts.audit_log.length, closedFacts.audit_log.length + 1); assert.equal(intentFacts.projects[0].status, 'closed');
  assert.equal(intentFacts.projects[0].closed_on.toISOString(), closedFacts.projects[0].closed_on.toISOString());
  assert.equal((await a.api(intentPath)).project.version, rename.savedVersion); assert.notEqual(closed.savedVersion, rename.savedVersion);
  await a.api(intentPath, 'PATCH', await intentRequest({}, { closureNote: '结案说明更正', maintenance: true }));
  intentDetail = await a.api(intentPath); assert.equal(intentDetail.project.closureNote, '结案说明更正'); assert.equal(!!intentDetail.project.maintenanceEnabled, true);
  await a.api(intentPath, 'PATCH', await intentRequest({}, { state: 'ongoing' }));
  intentDetail = await a.api(intentPath); assert.equal(intentDetail.project.status, 'ongoing'); assert.equal(intentDetail.project.closedOn, null); assert.equal(!!intentDetail.project.maintenanceEnabled, false);
  checks.push('PRD9.4/9.8：未完成S1的启动全部拒绝；真实阶段动作后意图启动/结案/维护/重开复用原规则，结案后只改名称不制造结案动作');

  const draftSubmission = await intentRequest({ summary: '本区精确底稿' }, { dueDate: '2031-01-03', planKind: 'correction' });
  const { expectedVersion: draftBase, idempotencyKey: draftOperation, ...draftContent } = draftSubmission;
  const draftBody = { clientDraftId: randomUUID(), projectId: intentProject, baseVersion: draftBase, formKind: 'basic', expectedDraftVersion: '0', clientSequence: '1', payload: { schemaVersion: 1, instanceId: randomUUID(), values: draftContent.changes, intent: draftContent.basicIntent, submission: draftContent } };
  const draftRow = await a.api('/api/personal/drafts/save', 'POST', draftBody);
  const drafted = { ...draftSubmission, draft: { clientDraftId: draftRow.clientDraftId, draftVersion: draftRow.draftVersion } };
  fault = 'INSERT INTO command_receipts'; await a.api(intentPath, 'PATCH', drafted, 500); fault = '';
  assert.equal((await a.api('/api/personal/drafts?clientDraftId=' + draftRow.clientDraftId)).items[0].state, 'active');
  fault = 'ack'; assert.equal((await a.api(intentPath, 'PATCH', drafted, 503)).outcome, 'unknown'); fault = '';
  await app.close(); app = undefined; await start(); await a.login(0);
  const intentReceipt = await a.api(intentPath + '/save-results/query', 'POST', drafted);
  assert.equal(intentReceipt.result.draft.state, 'committed'); assert.equal(intentReceipt.result.operationId, draftOperation);
  assert.deepEqual((await a.api(intentPath, 'PATCH', drafted)).result, intentReceipt.result);
  assert.equal((await a.api('/api/personal/drafts?clientDraftId=' + draftRow.clientDraftId)).items[0].state, 'committed');
  assert.equal((await a.api(intentPath)).project.summary, '本区精确底稿');
  const newerSubmission = await intentRequest({ summary: '提交期间输入' });
  const { expectedVersion: newerBase, idempotencyKey: newerOperation, ...newerContent } = newerSubmission;
  const newerBody = { ...draftBody, clientDraftId: randomUUID(), baseVersion: newerBase, payload: { ...draftBody.payload, values: newerContent.changes, intent: newerContent.basicIntent, submission: newerContent } };
  const firstDraft = await a.api('/api/personal/drafts/save', 'POST', newerBody);
  await a.api('/api/personal/drafts/save', 'POST', { ...newerBody, expectedDraftVersion: '1', clientSequence: '2', payload: { ...newerBody.payload, values: { summary: '更新的未提交输入' }, submission: { ...newerContent, changes: { summary: '更新的未提交输入' } } } });
  const kept = (await a.api(intentPath, 'PATCH', { ...newerSubmission, draft: { clientDraftId: firstDraft.clientDraftId, draftVersion: '1' } })).result;
  assert.equal(kept.draft.state, 'preserved'); assert.equal(kept.operationId, newerOperation);
  assert.equal((await a.api('/api/personal/drafts?clientDraftId=' + firstDraft.clientDraftId)).items[0].payload.values.summary, '更新的未提交输入');
  assert.equal((await a.api(intentPath)).project.summary, '提交期间输入');
  checks.push('PRD9.15：新意图精确草稿随正式事务终结，回执失败回滚、COMMIT未知后重启恢复；较新底稿原样保留');

  const legacyVersion = (await a.api(intentPath)).project.version;
  const legacy = body(legacyVersion, 'basic', { summary: '旧客户端待确认操作' }, { commands: [{ action: 'pauseProject', reason: '旧正文需要继续恢复' }] });
  const { expectedVersion: legacyBase, idempotencyKey: legacyOperation, ...legacyContent } = legacy;
  const legacyDraft = await a.api('/api/personal/drafts/save', 'POST', { ...draftBody, clientDraftId: randomUUID(), baseVersion: legacyBase, payload: { schemaVersion: 1, instanceId: randomUUID(), values: legacy.changes, submission: legacyContent } });
  legacy.draft = { clientDraftId: legacyDraft.clientDraftId, draftVersion: legacyDraft.draftVersion };
  fault = 'ack'; assert.equal((await a.api(intentPath, 'PATCH', legacy, 503)).outcome, 'unknown'); fault = '';
  await app.close(); app = undefined; await start(); await a.login(0);
  const legacyReceipt = await a.api(intentPath + '/save-results/query', 'POST', legacy);
  assert.equal(legacyReceipt.result.draft.state, 'committed'); assert.deepEqual((await a.api(intentPath, 'PATCH', legacy)).result, legacyReceipt.result);
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const oldHash = createHash('sha256').update(JSON.stringify(canonical([intentProject, 'basic', null, legacyBase, legacy.changes, legacy.commands.map(command => ({ ...command, expectedVersion: legacyBase, idempotencyKey: legacyOperation })), legacy.draft]))).digest('hex');
  assert.equal((await c.query('SELECT LOWER(HEX(request_hash)) hash FROM command_receipts WHERE actor_id=? AND idempotency_key=?', [users[0].id, legacyOperation]))[0][0].hash, oldHash);
  assert.equal((await a.api(intentPath)).project.status, 'paused'); assert.equal((await fresh(intentProject)).projects[0].summary, '旧客户端待确认操作');
  checks.push('PRD9.15：legacy commands与旧草稿正文仍可未知回执恢复，重放不新增；SQL哈希与旧协议公式逐字相同');
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/project-scopes.json', JSON.stringify({ status: 'passed', checks, productBrowserTested: false }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, evidence: 'test-results/project-scopes.json' }));
} finally {
  fault = ''; if (app) await app.close();
  if (projects.length) {
    for (const table of ['project_drafts', 'audit_log', 'project_checks', 'schedule_changes', 'project_changes', 'project_risks', 'project_nodes', 'project_stages', 'project_people', 'project_chips', 'project_tags', 'project_responsibilities']) await c.query(`DELETE FROM ${table} WHERE project_id IN (?)`, [projects]);
    await c.query('DELETE FROM projects WHERE id IN (?)', [projects]);
  }
  if (users.length) { const ids = users.map(u => u.id); for (const table of ['command_receipts', 'audit_log']) await c.query(`DELETE FROM ${table} WHERE actor_id IN (?)`, [ids]); await c.query('DELETE FROM sessions WHERE user_id IN (?)', [ids]); await c.query('DELETE FROM users WHERE id IN (?)', [ids]); }
  if (refs.length) await c.query('DELETE FROM engineers WHERE id IN (?)', [refs]);
  for (const [table, id] of catalogs.reverse()) await c.execute(`DELETE FROM ${table} WHERE id=?`, [id]);
  await c.end();
}
