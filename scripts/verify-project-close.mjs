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
const prefix = 'close_' + randomUUID().slice(0, 8), password = '结案验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '', projectWrites = 0, ownConfig = false;
const authOrigin = 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app'); const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) {
      if (fault === 'middle' && sql.startsWith('UPDATE projects SET') && ++projectWrites === 2 || fault && sql.startsWith(fault)) return execute.call(this, 'INSERT INTO __missing_close_test_table VALUES (1)');
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
  try { const result = {}; for (const table of ['projects', 'project_stages', 'project_checks', 'schedule_changes', 'project_nodes', 'project_risks', 'audit_log']) result[table] = (await connection.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY id`, [id]))[0];
    result.receipts = (await connection.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0]; return result;
  } finally { await connection.end(); }
}
const command = (version, action, extra = {}) => ({ action, expectedVersion: version, idempotencyKey: randomUUID(), ...extra });
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  for (const table of ['projects', 'system_configuration', 'check_rule_revisions']) assert.equal(Number((await c.query('SELECT COUNT(*) n FROM ' + table))[0][0].n), 0, '夹具非空，先核对，不覆盖');
  const hash = await hashPassword(password);
  for (let i = 0; i < 3; i++) { const loginName = prefix + '_' + i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '结案合成账号' + i]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await start(); const a = client(), b = client(), maint = client(); await a.login(0); await b.login(1); await maint.login(2);
  await c.execute("INSERT INTO system_configuration (id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))", [users[2].id, users[2].id]); ownConfig = true;
  let rule = await maint.api('/api/settings/check-rule'); await maint.api('/api/settings/check-rule', 'POST', { action: 'initializeCheckRule', deadlineWeekday: 5, expectedVersion: rule.configVersion, previewWeek: rule.weekStart, idempotencyKey: randomUUID() }); rule = await maint.api('/api/settings/check-rule');
  const today = businessToday(), id = await create(a), path = '/api/projects/' + id;
  const detail = (id, user = a) => user.api('/api/projects/' + id);
  const bodies = [];
  async function perform(id, action, extra = {}, user = a) {
    const version = (await detail(id, user)).project.version, body = command(version, action, extra), before = await fresh(id), path = '/api/projects/' + id;
    const preview = await user.api(path + '/actions/preview', 'POST', body); assert.deepEqual(await fresh(id), before, '预览不能写业务');
    const out = (await user.api(path + '/actions', 'POST', body)).result;
    assert.deepEqual((await user.api(path + '/action-results/query', 'POST', body)).result, out);
    assert.deepEqual((await user.api(path + '/actions', 'POST', body)).result, out);
    assert.equal((await detail(id)).project.version, out.savedVersion);
    const persisted = await fresh(id); assert.equal(String(persisted.projects[0].version), out.savedVersion);
    assert.equal(persisted.audit_log.length, before.audit_log.length + (out.changed ? 1 : 0));
    assert.deepEqual(persisted.project_stages, before.project_stages); assert.deepEqual(persisted.project_nodes, before.project_nodes); assert.deepEqual(persisted.project_risks, before.project_risks); assert.deepEqual(persisted.project_checks, before.project_checks);
    bodies.push({ id, body, out }); return { body, out, preview };
  }
  const close = (extra = {}) => ({ closureType: 'normal', closedOn: today, closureNote: '人工确认交付', remainingWorkNote: '保留遗留安排，由负责人后续处理', ...extra });
  async function bad(id, action, extra, status = 422, user = a) { const version = (await detail(id, user)).project.version, before = await fresh(id); const body = command(version, action, extra); await user.api('/api/projects/' + id + '/actions/preview', 'POST', body, status); await user.api('/api/projects/' + id + '/actions', 'POST', body, status); assert.deepEqual(await fresh(id), before); }
  await a.api(path + '/actions', 'POST', command('1', 'setPlan', { dueDate: addDays(today, -10) }));
  await bad(id, 'closeProject', close({ closureNote: '  ' })); await bad(id, 'closeProject', close({ remainingWorkNote: '' })); await bad(id, 'closeProject', close({ closedOn: addDays(today, 1) })); await bad(id, 'closeProject', close({ status: 'closed' }), 400);
  const proposal = await perform(id, 'closeProject', close()); let d = await detail(id); const firstClosure = d.currentClosure.auditId;
  assert.equal(d.project.status, 'closed'); assert.equal(d.project.preCloseStatus, 'proposal'); assert.equal(Number(d.project.progress), 0); assert.equal(d.project.closureDueDate, addDays(today, -10)); assert.equal(d.project.deadline.kind, 'closed_late'); assert.equal(d.project.deadline.days, 10); assert.equal(d.project.checkStatus.required, false);
  const oldAudit = (await fresh(id)).audit_log.find(item => String(item.id) === firstClosure);
  await bad(id, 'closeProject', close());
  await a.api(path + '/actions', 'POST', command(d.project.version, 'startStage', { stageCode: 'S1', actualDate: today }), 422);
  await perform(id, 'correctClosure', { closureAuditId: firstClosure, changes: { closedOn: null }, reason: '原日误录，真实日期待核对' }); d = await detail(id); assert.equal(d.project.deadline.kind, 'closed_unknown'); assert.equal(d.project.status, 'closed');
  await perform(id, 'correctClosure', { closureAuditId: firstClosure, changes: { closedOn: today, closureDueDate: addDays(today, 2), closureNote: '纠正后的交付说明' }, reason: '核对本次事实' });
  d = await detail(id); assert.equal(d.project.deadline.kind, 'closed_on_time'); assert.equal(d.project.dueDate, addDays(today, -10));
  assert.deepEqual((await fresh(id)).audit_log.find(item => String(item.id) === firstClosure), oldAudit, '原结案行不改写');
  await perform(id, 'setMaintenance', { enabled: true, reason: '结案后持续支持' }); const noChange = await perform(id, 'setMaintenance', { enabled: true, reason: '再核对开关' }); assert.equal(noChange.out.changed, false);
  assert((await a.api('/api/projects?view=maintenance&search=' + prefix)).items.some(item => item.id === id)); assert(!(await a.api('/api/projects?view=closed&search=' + prefix)).items.some(item => item.id === id));
  d = await detail(id); await a.api(path, 'PATCH', { expectedVersion: d.project.version, idempotencyKey: randomUUID(), changes: { summaryNote: '闭案期间最新说明', signal: 'red', priority: 'high' } });
  d = await detail(id); await a.api(path + '/actions', 'POST', command(d.project.version, 'reschedulePlan', { dueDate: addDays(today, 15), reason: '当前计划另行调整', measures: '' }));
  await perform(id, 'reopenProject', { closureAuditId: firstClosure, reason: '恢复项目核对' }); d = await detail(id);
  assert.equal(d.project.status, 'proposal'); assert.equal(d.project.maintenanceEnabled, 0); assert.equal(d.project.summaryNote, '闭案期间最新说明'); assert.equal(d.project.dueDate, addDays(today, 15)); assert.equal(d.project.signal, 'red'); assert.equal(d.currentClosure, null);
  for (const key of ['closedOn', 'closureDueDate', 'closureType', 'preCloseStatus']) assert.equal(d.project[key], null); for (const key of ['closureNote', 'remainingWorkNote']) assert.equal(d.project[key], '');
  await bad(id, 'reopenProject', { closureAuditId: firstClosure, reason: '不能重复重开' }); await bad(id, 'setMaintenance', { enabled: true, reason: '未结案不能维护' });
  await perform(id, 'closeProject', close({ closureType: 'terminated' })); d = await detail(id); assert.equal(d.project.deadline.kind, 'terminated'); const secondClosure = d.currentClosure.auditId; assert.notEqual(firstClosure, secondClosure);
  await bad(id, 'correctClosure', { closureAuditId: firstClosure, changes: { closureNote: '旧周期不能覆盖' }, reason: '旧表单' }, 409);
  await perform(id, 'correctClosure', { closureAuditId: secondClosure, changes: { closureType: 'normal' }, reason: '误选类型纠正' });
  await perform(id, 'setMaintenance', { enabled: true, reason: '维护' }); await perform(id, 'setMaintenance', { enabled: false, reason: '结束维护' });
  await perform(id, 'correctClosure', { closureAuditId: secondClosure, changes: { closureDueDate: null }, reason: '结案时计划未定' }); assert.equal((await detail(id)).project.deadline.kind, 'closed_unplanned');
  const noop = await perform(id, 'correctClosure', { closureAuditId: secondClosure, changes: { closureNote: close().closureNote }, reason: '值一致' }); assert.equal(noop.out.changed, false);
  checks.push('提案人工结案保留0%与计划快照、当前日期未知/类型/说明纠错、原审计不变、维护分类/无变化、重开保留最新普通及当前计划、两周期绑定');

  const pausedId = await create(a), pp = '/api/projects/' + pausedId; let v = '1';
  for (const [action, actualDate] of [['startStage', '2020-01-01'], ['completeStage', '2020-01-02']]) v = (await a.api(pp + '/actions', 'POST', command(v, action, { stageCode: 'S1', actualDate }))).result.savedVersion;
  v = (await a.api(pp + '/actions', 'POST', command(v, 'startProject', { actualDate: '2020-01-03', dueDate: addDays(today, -2), configVersion: rule.configVersion, ruleVersion: rule.rule.version, previewWeek: rule.weekStart, previewFirstCheckWeek: rule.firstCheckWeek }))).result.savedVersion;
  await a.api(pp + '/actions', 'POST', command(v, 'startStage', { stageCode: 'S2', actualDate: '2020-01-04' }));
  d = await detail(pausedId); const firstWeek = d.project.firstCheckWeek, stageBefore = d.stages;
  await bad(pausedId, 'closeProject', close({ closedOn: '2020-01-03' }));
  await perform(pausedId, 'closeProject', close({ closureType: 'terminated' })); d = await detail(pausedId); assert.equal(d.project.preCloseStatus, 'ongoing');
  await perform(pausedId, 'reopenProject', { closureAuditId: d.currentClosure.auditId, reason: '进行中原状态恢复' });
  d = await detail(pausedId); await a.api(pp + '/actions', 'POST', command(d.project.version, 'pauseProject', { reason: '暂缓保留' }));
  await perform(pausedId, 'closeProject', close()); d = await detail(pausedId); const pauseClosure = d.currentClosure.auditId; assert.equal(d.project.preCloseStatus, 'paused'); assert.equal(d.project.resumeStatus, 'ongoing');
  await perform(pausedId, 'setMaintenance', { enabled: true, reason: '临时维护' });
  d = await detail(pausedId); await a.api(pp + '/actions', 'POST', command(d.project.version, 'correctStageFacts', { changes: [{ code: 'S2', startedOn: '2020-01-05' }], reason: '闭案期间日期纠错' }));
  await perform(pausedId, 'reopenProject', { closureAuditId: pauseClosure, reason: '先回暂缓状态' }); d = await detail(pausedId); assert.equal(d.project.status, 'paused'); assert.equal(d.project.resumeStatus, 'ongoing'); assert.equal(d.project.maintenanceEnabled, 0); assert.equal(d.stages[1].startedOn, '2020-01-05'); assert.equal(d.project.firstCheckWeek, firstWeek);
  await a.api(pp + '/actions', 'POST', command(d.project.version, 'resumeProject', { note: '真实恢复继续' })); d = await detail(pausedId); assert.equal(d.project.status, 'ongoing'); assert.equal(d.project.firstCheckWeek, firstWeek); assert.equal(Number(d.project.progress), 5); assert.equal((await fresh(pausedId)).project_checks.length, 0);
  assert.deepEqual(d.stages.map(item => item.state), stageBefore.map(item => item.state));
  checks.push('真实S1启动/S2、进行中与暂缓结案三目标重开、暂停来源保持、闭案日期纠错继续有效、真实进度/首次义务保持且不生成检查');

  const fullId = await create(a); await c.execute("UPDATE project_stages SET state='completed',started_on='2020-01-01',completed_on='2020-01-08' WHERE project_id=?", [fullId]);
  await c.execute("INSERT INTO project_nodes (project_id,kind,title,output,note,sort_order) VALUES (?,'customer','客户待确认节点','','',0)", [fullId]);
  await c.execute("INSERT INTO project_risks (project_id,content,level,resolved,resolution,created_at,sort_order) VALUES (?,'遗留风险','high',0,'',UTC_TIMESTAMP(3),0)", [fullId]);
  await bad(fullId, 'closeProject', close({ remainingWorkNote: '' })); await bad(fullId, 'closeProject', close({ closedOn: '2020-01-07' }));
  const closedFull = await perform(fullId, 'closeProject', close()); assert.equal(closedFull.preview.progress, 100); assert.equal(closedFull.preview.remaining.stages.length, 0); assert.equal(closedFull.preview.remaining.nodes.length, 1); assert.equal(closedFull.preview.remaining.risks.length, 1);
  d = await detail(fullId); await bad(fullId, 'correctClosure', { closureAuditId: d.currentClosure.auditId, changes: { remainingWorkNote: '' }, reason: '有遗留不能清空' });
  await bad(fullId, 'correctClosure', { closureAuditId: d.currentClosure.auditId, changes: { closureType: null }, reason: '非法类型' }, 400);
  await bad(fullId, 'correctClosure', { closureAuditId: d.currentClosure.auditId, changes: { status: 'ongoing' }, reason: '不能夹带重开' }, 400);
  await perform(fullId, 'reopenProject', { closureAuditId: d.currentClosure.auditId, reason: '回提案且全部完成保留' }); assert.equal(Number((await detail(fullId)).project.progress), 100);
  await c.execute('UPDATE project_nodes SET completed_on=? WHERE project_id=?', [today, fullId]); await c.execute('UPDATE project_risks SET resolved=1 WHERE project_id=?', [fullId]);
  const noRemaining = await perform(fullId, 'closeProject', close({ remainingWorkNote: '' })); assert.equal(noRemaining.preview.remaining.nodes.length, 0); assert.equal(noRemaining.preview.remaining.risks.length, 0);
  checks.push('合成全阶段完成仍人工结案、真实节点/风险遗留必填及保留、全完成重开不凭空开工、没有遗留时说明可空');

  const legacyId = await create(a); await c.execute("UPDATE projects SET status='closed',created_by=NULL,closed_on='2010-01-01',closure_type=NULL,pre_close_status=NULL WHERE id=?", [legacyId]);
  d = await detail(legacyId); assert.equal(d.currentClosure.auditId, null); assert.equal(d.currentClosure.actorDisplayName, null); assert.equal(d.project.deadline.kind, 'closed_unknown');
  await perform(legacyId, 'correctClosure', { closureAuditId: null, changes: { closureNote: '旧事实说明补正' }, reason: '不重演旧生命周期' });
  await bad(legacyId, 'reopenProject', { closureAuditId: null, reason: '来源未知不猜' });
  assert.equal((await fresh(legacyId)).audit_log.filter(item => item.action === 'project.close').length, 0);
  await c.execute("UPDATE projects SET pre_close_status='paused',resume_status=NULL WHERE id=?", [legacyId]); await bad(legacyId, 'reopenProject', { closureAuditId: null, reason: '暂停来源也必须可靠' });
  await c.execute("UPDATE projects SET pre_close_status='closed' WHERE id=?", [legacyId]); await bad(legacyId, 'reopenProject', { closureAuditId: null, reason: '非法原状态不猜' });
  await c.execute("UPDATE projects SET closure_type='normal' WHERE id=?", [legacyId]);
  d = await detail(legacyId); assert.equal(d.project.deadline.kind, 'closed_unknown'); assert.equal(d.project.deadline.label, '结案时历史计划待核对');
  assert((await a.api('/api/projects?view=closed&deadline=closed_unknown&search=' + prefix)).items.some(item => item.id === legacyId));
  assert(!(await a.api('/api/projects?view=closed&deadline=closed_unplanned&search=' + prefix)).items.some(item => item.id === legacyId));
  const missingId = await create(a); await c.execute('DELETE FROM project_stages WHERE project_id=? AND stage_code=\'S7\'', [missingId]);
  const missing = await perform(missingId, 'closeProject', close()); assert(missing.preview.remaining.stages.some(item => item.code === 'S7' && item.state === 'unconfigured'));
  checks.push('旧完结合成事实保留过去日期/未知来源、不重演结案、不伪造身份、可靠重开依据门槛');

  const raceId = await create(a), rp = '/api/projects/' + raceId; await b.api(rp + '/responsibility', 'POST', { action: 'join', expectedVersion: '1', idempotencyKey: randomUUID() }); d = await detail(raceId); let before = await fresh(raceId);
  const race1 = command(d.project.version, 'closeProject', close()), race2 = command(d.project.version, 'closeProject', close({ closureType: 'terminated' }));
  const competing = await Promise.all([a.api(rp + '/actions', 'POST', race1, [200,409]), b.api(rp + '/actions', 'POST', race2, [200,409])]); assert.deepEqual(competing.map(item => item.httpStatus).sort(), [200,409]);
  assert.equal((await fresh(raceId)).audit_log.length, before.audit_log.length + 1);
  const committed = competing[0].httpStatus === 200 ? { body: race1, user: a, other: b, result: competing[0].result } : { body: race2, user: b, other: a, result: competing[1].result };
  assert.equal((await committed.other.api(rp + '/action-results/query', 'POST', committed.body)).outcome, 'not_found');
  await committed.user.api(rp + '/actions', 'POST', { ...committed.body, closureNote: '改变正文复用编号' }, 409);
  d = await detail(raceId); before = await fresh(raceId);
  await maint.api(rp + '/actions', 'POST', command(d.project.version, 'setMaintenance', { enabled: true, reason: '非负责人' }), 403); assert.deepEqual(await fresh(raceId), before);
  await a.api(rp, 'PATCH', { expectedVersion: d.project.version, idempotencyKey: randomUUID(), changes: { maintenanceEnabled: true } }, 400); assert.deepEqual(await fresh(raceId), before);
  const reopen = { closureAuditId: d.currentClosure.auditId, reason: '故障检查' };
  for (const point of ['middle', 'INSERT INTO audit_log', 'INSERT INTO command_receipts']) { fault = point; projectWrites = 0; await a.api(rp + '/actions', 'POST', command(d.project.version, 'reopenProject', reopen), 503); fault = ''; assert.deepEqual(await fresh(raceId), before, point + '全部回滚'); }
  const ackBody = command(d.project.version, 'reopenProject', reopen); fault = 'ack'; await a.api(rp + '/actions', 'POST', ackBody, 503); fault = '';
  const committedState = await fresh(raceId); assert.equal(committedState.projects[0].status, committedState.audit_log.find(item => item.action === 'project.close').before_json.closure.status);
  await app.close(); app = undefined; await start(); await a.api('/api/auth/me');
  const recovered = await a.api(rp + '/action-results/query', 'POST', ackBody); assert.equal(recovered.outcome, 'committed'); assert.deepEqual((await a.api(rp + '/actions', 'POST', ackBody)).result, recovered.result); assert.deepEqual(await fresh(raceId), committedState);
  for (const item of bodies) assert.deepEqual((await a.api('/api/projects/' + item.id + '/action-results/query', 'POST', item.body)).result, item.out);
  const history = await a.api(rp + '/audit'); assert(history.items.some(item => item.action === 'project.reopen')); assert(history.items.some(item => item.action === 'project.close'));
  checks.push('两负责人同版本一赢家、只读/普通PATCH不能越界、原编号绑定账号与正文、快照/版本/审计/回执故障全回滚、真实COMMIT丢确认后原会话与全部原结果恢复');

  const disabledBefore = await fresh(id); await c.execute('UPDATE users SET enabled=0 WHERE id=?', [users[0].id]);
  await a.api(path + '/actions', 'POST', command((await fresh(id)).projects[0].version.toString(), 'setMaintenance', { enabled: true, reason: '失效账号' }), 401); assert.deepEqual(await fresh(id), disabledBefore); await c.execute('UPDATE users SET enabled=1 WHERE id=?', [users[0].id]);
  for (const action of ['reopenProject', 'setMaintenance', 'correctClosure']) {
    d = await detail(raceId);
    if (d.project.status !== 'closed') await perform(raceId, 'closeProject', close());
    d = await detail(raceId); const originalVersion = d.project.version, source = d.currentClosure.auditId;
    const extra = action === 'reopenProject' ? { closureAuditId: source, reason: '并发重开' } : action === 'setMaintenance' ? { enabled: !d.project.maintenanceEnabled, reason: '并发维护' } : { closureAuditId: source, changes: { closureNote: '并发纠正' }, reason: '并发纠错' };
    before = await fresh(raceId);
    const responses = await Promise.all([a.api(rp + '/actions', 'POST', command(originalVersion, action, extra), [200,409]), b.api(rp, 'PATCH', { expectedVersion: originalVersion, idempotencyKey: randomUUID(), changes: { summaryNote: '另一负责人新文字 ' + action } }, [200,409])]);
    assert.deepEqual(responses.map(item => item.httpStatus).sort(), [200,409]); assert.equal((await fresh(raceId)).audit_log.length, before.audit_log.length + 1);
  }
  checks.push('重开/维护/当前纠错分别与另一负责人普通保存竞争，仅一次新版本；已停用账号拒绝，无业务副作用');
  const frozen = (await detail(id)).project.deadline; const actor = await identities(runtime).resolve(a.token); const later = new Date(Date.now() + 5*86400000);
  assert.equal((await projectReads(runtime, () => later).detail(id, users[0].id)).project.deadline.kind, frozen.kind);
  d = await detail(pausedId); await projectActions(runtime, () => later).run(actor, pausedId, validateAction(command(d.project.version, 'closeProject', close({ closedOn: addDays(today, 5) }))), randomUUID(), false);
  const afterClock = await projectReads(runtime, () => later).detail(pausedId, users[0].id); assert.equal(afterClock.project.checkStatus.required, false); assert.equal(afterClock.project.firstCheckWeek, firstWeek);
  checks.push('可控业务时钟：结案结果跨日保持、关闭默认检查、真实日期与操作时间分离、首次义务不重置');
  const build = (await a.api('/api/health/live')).build;
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/project-close-check.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount: measurements.length, measurements, build, isolatedTestDatabase: true, nodeRiskRowsAreExplicitFixtures: true }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount: measurements.length }));
} finally {
  if (app) await app.close();
  for (const id of projects) { for (const table of ['project_nodes', 'project_risks', 'project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  if (ownConfig) { await c.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?', [users[2].id]); await c.execute('DELETE FROM check_rule_revisions WHERE saved_by=?', [users[2].id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
