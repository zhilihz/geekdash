import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { migrateDatabase, verifyDatabase } from '../dist/server/infrastructure/schema.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectActions, validateAction } from '../dist/server/modules/project-actions.js';
import { projectReads } from '../dist/server/modules/projects.js';
import { projectChecks } from '../dist/server/modules/project-checks.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1');
assert.match(process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID ?? '', /^[a-f0-9-]{36}$/);
const { connection: c } = await connectDatabase('test_migrator');
const prefix = 'checkfacts_' + randomUUID().slice(0, 8), password = '检查事实验收 password 2026';
const users = [], checks = [], requests = [];
let projectId, ruleId, app, runtime, origin, fault = '', trace = [];
let migrationEvidence;
const sql = async (query, values = []) => (await c.query(query, values))[0];
const id = async () => (await sql('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
const body = (version, extra = {}) => ({ action: 'saveCheck', expectedVersion: version, idempotencyKey: randomUUID(), conclusion: 'checked', note: '', ...extra });
function client() {
  let cookie = '', csrf = '', account;
  return {
    get token() { return cookie.split('=')[1]; },
    async api(path, method = 'GET', value, expected = 200) {
      const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
      const out = await response.json(); assert.equal(response.status, expected, path + ': ' + JSON.stringify(out));
      if (path === '/api/auth/me') account = out.account;
      requests.push({ path, status: response.status }); return out;
    },
    async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); },
  };
}
async function snapshot() {
  const { connection } = await connectDatabase('test_app');
  try {
    const value = {};
    for (const table of ['projects', 'project_stages', 'project_checks', 'audit_log']) value[table] = (await connection.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY id`, [projectId]))[0];
    value.receipts = (await connection.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [projectId]))[0];
    return value;
  } finally { await connection.end(); }
}
async function start() {
  runtime = await openRuntimeDatabase('test_app');
  const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const query = lease.query, execute = lease.execute, commit = lease.commit;
    lease.query = function (statement, values) { const sql = typeof statement === 'string' ? statement : statement.sql; if (/system_configuration|check_rule_revisions/.test(sql)) trace.push(sql); return query.call(this, statement, values); };
    lease.execute = function (sql, values) { if (fault === 'rollback' && sql.startsWith('UPDATE projects SET')) return execute.call(this, 'INSERT INTO __missing_check_fact_probe VALUES (1)'); return execute.call(this, sql, values); };
    lease.commit = async function () { await commit.call(this); if (fault === 'ack') throw new Error('synthetic lost acknowledgement'); };
    try { return await work(lease); } finally { lease.query = query; lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
}
try {
  assert.equal((await sql('SELECT @@server_uuid uuid'))[0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
  assert.equal((await sql('SELECT DATABASE() db'))[0].db, 'geekdash_test');
  const afterMigration = process.argv.includes('--after-migration');
  assert.equal((await sql('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'))[0].version, afterMigration ? '0005-check-facts' : '0004-project-compatibility', '迁移验收不反向修改或重建现有库；已升级只能明确选择--after-migration续验业务');
  if (afterMigration) { migrationEvidence = JSON.parse(await readFile('test-results/check-facts-migration.json', 'utf8')); assert.equal(migrationEvidence.serverUuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID); assert(['passed', 'values_preserved'].includes(migrationEvidence.status)); }
  const hash = await hashPassword(password);
  for (let i = 0; i < 2; i++) {
    const loginName = prefix + '_' + i;
    await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '检查事实合成账号' + i]); users.push({ id: await id(), loginName });
  }
  await c.execute("INSERT INTO projects (name,created_by,data_kind,version,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,summary,closure_note,remaining_work_note,created_at,updated_at) VALUES (?,?,'trial',2,'','','人工业务说明保持不变','','','','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [prefix, users[0].id]); projectId = await id();
  await c.execute('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))', [projectId, users[0].id]);
  for (let i = 1; i <= 7; i++) await c.execute("INSERT INTO project_stages (project_id,stage_code,state,note) VALUES (?,?,?,'')", [projectId, 'S' + i, i === 1 ? 'ready' : 'locked']);
  await c.execute("INSERT INTO check_rule_revisions (deadline_weekday,effective_week,saved_at,saved_by) VALUES (5,'2020-01-06','2020-01-06',?)", [users[0].id]); ruleId = await id();
  await c.execute("INSERT INTO project_checks (project_id,actor_id,checked_at,week_start,conclusion,note,rule_version,observed_version,result_version) VALUES (?,?,'2020-01-10 12:00:00','2020-01-06','follow_up','旧备注原值',?,1,2)", [projectId, users[0].id, ruleId]);
  const legacyCheckId = await id(), legacyBody = body('1', { conclusion: 'follow_up', note: '旧备注原值', ruleVersion: ruleId, previewWeek: '2020-01-06' });
  const legacyResult = { projectId, operationId: legacyBody.idempotencyKey, action: 'saveCheck', changed: true, baseVersion: '1', savedVersion: '2', checkId: legacyCheckId, onTime: false, deadlineDate: '2020-01-10' };
  const legacyHash = createHash('sha256').update(JSON.stringify([projectId, Object.keys(legacyBody).filter(key => key !== 'idempotencyKey').sort().map(key => [key, legacyBody[key]])])).digest();
  await c.execute("INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,'2020-01-10 12:00:00')", [users[0].id, `user:${users[0].id}:project:${projectId}:actions`, legacyBody.idempotencyKey, legacyHash, JSON.stringify(legacyResult)]);
  const retained = {};
  for (const table of ['project_checks', 'check_rule_revisions', 'command_receipts', 'audit_log']) retained[table] = await sql('SELECT * FROM ' + table + ' ORDER BY ' + (table === 'command_receipts' ? 'command_scope,idempotency_key' : table === 'check_rule_revisions' ? 'version' : 'id'));
  const migration = await migrateDatabase('test_migrator'); assert.equal(migration.version, '0005-check-facts');
  for (const [table, before] of Object.entries(retained)) assert.deepEqual(await sql('SELECT * FROM ' + table + ' ORDER BY ' + (table === 'command_receipts' ? 'command_scope,idempotency_key' : table === 'check_rule_revisions' ? 'version' : 'id')), before, '迁移保留原始 ' + table);
  const columns = await sql("SELECT COLUMN_NAME name,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_checks' AND COLUMN_NAME IN ('week_start','rule_version') ORDER BY COLUMN_NAME");
  assert(columns.every(column => column.nullable === 'YES')); assert.equal(columns.length, 2);
  assert.equal(Number((await sql("SELECT COUNT(*) n FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_checks' AND CONSTRAINT_NAME='fk_project_checks_rule_version'"))[0].n), 1);
  assert.equal((await migrateDatabase('test_migrator')).applied, false); assert.equal((await verifyDatabase('test_migrator')).version, '0005-check-facts');
  if (!afterMigration) {
    migrationEvidence = { status: 'passed', checkedAt: new Date().toISOString(), serverUuid: process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID, from: '0004-project-compatibility', to: migration.version, checksum: migration.checksum, preservedCounts: Object.fromEntries(Object.entries(retained).map(([table, rows]) => [table, rows.length])) };
    await mkdir('test-results', { recursive: true }); await writeFile('test-results/check-facts-migration.json', JSON.stringify(migrationEvidence, null, 2) + '\n');
  }
  assert.equal(migrationEvidence.checksum, migration.checksum);
  if (migrationEvidence.status !== 'passed') { migrationEvidence = { ...migrationEvidence, status: 'passed', completedAt: new Date().toISOString() }; await writeFile('test-results/check-facts-migration.json', JSON.stringify(migrationEvidence, null, 2) + '\n'); }
  checks.push(afterMigration ? '复用此前同库同校验和0004升级证据；本轮0005结构/FK/重复迁移及旧事实保留复验' : '0004含数据升级0005：检查/规则/回执/审计逐值不变，两列允许NULL、旧外键保留、重复迁移无变更');
  await start(); const a = client(), b = client(); await a.login(0); await b.login(1); const path = '/api/projects/' + projectId;
  let before = await snapshot();
  assert.deepEqual((await a.api(path + '/action-results/query', 'POST', legacyBody)).result, legacyResult);
  assert.deepEqual((await a.api(path + '/actions', 'POST', legacyBody)).result, legacyResult);
  assert.deepEqual(await snapshot(), before);
  let history = await a.api(path + '/checks'); assert.equal(history.items[0].weekStart, '2020-01-06'); assert.equal(history.items[0].ruleVersion, ruleId); assert.equal(history.items[0].note, '旧备注原值'); assert(!Object.hasOwn(history.items[0], 'onTime'));
  checks.push('旧带周字段回执原样恢复/重投不重复写；旧历史字段保留但不重新计算按时或截止');
  const correction = { action: 'correctCheck', expectedVersion: '2', idempotencyKey: randomUUID(), checkId: legacyCheckId, conclusion: 'checked', note: '人工纠正备注' };
  const corrected = await a.api(path + '/actions', 'POST', correction); assert.equal(corrected.result.savedVersion, '3');
  assert.deepEqual((await snapshot()).project_checks, before.project_checks); history = await a.api(path + '/checks'); assert.equal(history.items[0].note, '人工纠正备注'); assert.equal(history.items[0].original.note, '旧备注原值'); assert.equal(history.items[0].observedVersion, '1');
  const correctedDetail = await a.api(path); assert.equal(correctedDetail.project.checkStatus.latest.id, legacyCheckId); assert.equal(correctedDetail.project.checkStatus.updatedAfterCheck, true); assert.equal(correctedDetail.project.checkedToday, false);
  checks.push('结论/备注直接保存追加更正审计，原检查人时间版本周规则和原备注不改写');
  trace = []; before = await snapshot(); const saved = await a.api(path + '/actions', 'POST', body('3')); const after = await snapshot();
  assert.equal(trace.length, 0, '检查不能读取或锁定周规则/公共配置');
  assert.equal(after.project_checks.length, before.project_checks.length + 1); assert.equal(after.project_checks.at(-1).week_start, null); assert.equal(after.project_checks.at(-1).rule_version, null);
  assert.deepEqual(after.project_stages, before.project_stages);
  for (const [key, value] of Object.entries(before.projects[0])) if (!['version', 'updated_at'].includes(key)) assert.deepEqual(after.projects[0][key], value, '检查不得改业务字段 ' + key);
  const detail = await a.api(path); assert.equal(detail.project.version, saved.result.savedVersion); assert.equal(detail.project.checkedToday, true); assert.equal(detail.project.checkStatus.updatedAfterCheck, false); assert(!Object.hasOwn(detail, 'checkRule'));
  for (const source of [await a.api('/api/projects?view=all&pageSize=100'), await a.api('/api/project-summary')]) { const item = source.items.find(item => item.id === projectId); assert(item); assert.equal(item.checkedToday, true); assert.equal(item.checkStatus.latest.id, saved.result.checkId); }
  checks.push('无需规则的新检查写NULL来源且不改业务正文；SQL、新详情、列表和简要消费同一今日事实');
  before = await snapshot();
  await a.api(path + '/actions', 'POST', body('2'), 409); await b.api(path + '/actions', 'POST', body(saved.result.savedVersion), 403); await a.api(path + '/actions', 'POST', body(saved.result.savedVersion, { actorId: users[1].id }), 400);
  assert.deepEqual(await snapshot(), before);
  checks.push('旧项目版本、非负责人及伪造操作者均拒绝，检查/正文/版本/历史/回执不写入');
  const actor = await identities(runtime).resolve(a.token);
  const sunday = new Date('2027-01-03T23:59:59.999+08:00'), monday = new Date('2027-01-04T00:00:00+08:00');
  const weekBody = body(saved.result.savedVersion, { ruleVersion: ruleId, previewWeek: '1999-12-27' });
  const weekOut = await projectActions(runtime, () => sunday).run(actor, projectId, validateAction(weekBody), randomUUID(), false);
  const nextDay = await projectReads(runtime, () => monday).detail(projectId, actor.id); assert.equal(nextDay.project.checkedToday, false); assert.equal(nextDay.project.checkStatus.latest.id, weekOut.result.checkId); assert.equal(nextDay.project.checkStatus.updatedAfterCheck, false);
  const crossed = await projectActions(runtime, () => monday).run(actor, projectId, validateAction(body(weekOut.result.savedVersion, { ruleVersion: ruleId, previewWeek: '1999-12-27' })), randomUUID(), false);
  assert.equal((await projectReads(runtime, () => monday).detail(projectId, actor.id)).project.checkedToday, true);
  const previousDay = await projectChecks(runtime, () => monday).read(projectId, 20); assert.equal(previousDay.items.find(item => item.id === weekOut.result.checkId).checkedAt, sunday.toISOString().replace('999Z', '999000Z'));
  checks.push('跨年周日最后毫秒及周一00:00均可检查，旧周参数不再阻拦；跨日只变今日标记，最近检查仍可读');
  before = await snapshot(); fault = 'rollback'; await a.api(path + '/actions', 'POST', body(crossed.result.savedVersion), 503); fault = ''; assert.deepEqual(await snapshot(), before);
  const lost = body(crossed.result.savedVersion); fault = 'ack'; await a.api(path + '/actions', 'POST', lost, 503); fault = ''; const committed = await snapshot();
  await app.close(); app = undefined; await start();
  const receipt = await a.api(path + '/action-results/query', 'POST', lost); assert.equal(receipt.outcome, 'committed'); assert.deepEqual((await a.api(path + '/actions', 'POST', lost)).result, receipt.result); assert.deepEqual(await snapshot(), committed);
  checks.push('检查事务中途失败全回滚；COMMIT丢响应后重启查原回执与重投不增加检查/历史');
  const build = (await a.api('/api/health/live')).build;
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/check-facts.json', JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks, requestCount: requests.length, requests, build, isolatedTestDatabase: true, migration: migrationEvidence }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', groups: checks.length, requestCount: requests.length }));
} finally {
  if (app) await app.close();
  if (projectId) { for (const table of ['project_checks', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [projectId]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [projectId]); await c.execute('DELETE FROM projects WHERE id=?', [projectId]); }
  if (ruleId) await c.execute('DELETE FROM check_rule_revisions WHERE version=?', [ruleId]);
  for (const user of users) { for (const table of ['command_receipts', 'audit_log']) await c.execute('DELETE FROM ' + table + ' WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
