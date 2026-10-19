import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { migrateDatabase, verifyDatabase } from '../dist/server/infrastructure/schema.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { createApp } from '../dist/server/app.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1', '仅限本轮独立空实例');
assert.match(process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID ?? '', /^[a-f0-9-]{36}$/);
const oldSchema = await readFile(process.env.GEEKDASH_P04_OLD_SCHEMA);
assert.equal(createHash('sha256').update(oldSchema).digest('hex'), 'c7c8d5d738ad110356c0e2741cd9465d7fd09c91f58f13d112d8910fb0ec716a');
const { connection: c } = await connectDatabase('test_migrator');
const fixture = resolve('test-results', 'p04-upgrade-' + randomUUID());
assert(fixture.startsWith(resolve('test-results') + sep));
const command = resolve(fixture, 'server/commands/database.js'), code = resolve(fixture, 'server/infrastructure/schema.js');
const checks = [], prefix = 'p04_' + randomUUID().slice(0, 8), password = '迁移核查 password 2026';
let app, origin, cookie = '', csrf = '', account, projectId, userId, engineerId;
const projectIds = [], oldColumns = {}, riskIds = [], nodeIds = [];
async function run(mode = 'migrate', script = command) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [script, ...script === command ? [mode, 'test_migrator'] : ['test_migrator']], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('error', reject);
    child.on('close', (exitCode, signal) => { const last = output.trim().split('\n').at(-1); accept({ exitCode, signal, last: last?.startsWith('{') ? JSON.parse(last) : last }); });
  });
}
async function api(path, method = 'GET', body, expected = 200) {
  const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
  const out = await response.json(); assert.equal(response.status, expected, path + ': ' + JSON.stringify(out)); if (out.account) account = out.account; return out;
}
async function start() { app = await createApp(await openRuntimeDatabase('test_app'), { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 }); }
async function snapshot() {
  const { connection } = await connectDatabase('test_app');
  try {
    const result = {};
    for (const [table, columns] of Object.entries(oldColumns)) result[table] = (await connection.query(`SELECT ${columns.map(name => '`' + name + '`').join(',')} FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY ${table === 'project_responsibilities' ? 'user_id' : table === 'project_people' ? 'engineer_id,role' : 'id'}`, [projectId]))[0];
    result.receipts = (await connection.query('SELECT * FROM command_receipts WHERE actor_id=?', [userId]))[0]; return result;
  } finally { await connection.end(); }
}
try {
  assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'))[0][0].n), 0, '专用升级库已有表，禁止重置重跑');
  const { connection: freshCheck } = await connectDatabase('dev_migrator');
  try { for (const row of (await freshCheck.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME<>'schema_migrations'"))[0]) assert.equal(Number((await freshCheck.query('SELECT COUNT(*) n FROM `' + row.name + '`'))[0][0].n), 0, '新库存在业务数据，停止'); } finally { await freshCheck.end(); }
  const fresh = await migrateDatabase('dev_migrator'); assert.equal(fresh.columns, 317); assert.equal(fresh.tables, 34); assert.equal(fresh.foreignKeys, 55);
  checks.push('独立新库0001至0004完整迁移：34表317列55外键');
  await mkdir(fixture, { recursive: true }); await cp('dist/server', resolve(fixture, 'server'), { recursive: true }); await cp('dist/migrations', resolve(fixture, 'migrations'), { recursive: true });
  const currentCode = await readFile(code, 'utf8'); await writeFile(code, oldSchema); assert.equal((await run()).exitCode, 0);
  const history = (await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0]; assert.equal(history.length, 3);
  await c.execute("INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [prefix, await hashPassword(password), '原人名']); userId = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  await c.execute("INSERT INTO projects (name,created_by,data_kind,source_namespace,source_key,version,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at) VALUES (?,?,'trial',?,'原来源',9,'原灯色说明','原市场预期','原最新状态','原详情','旧备注待核对','原芯片备注','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [prefix, userId, prefix]); projectId = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id; projectIds.push(projectId);
  await c.execute('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))', [projectId, userId]);
  await c.execute("INSERT INTO engineers (name,role,created_at,updated_at) VALUES (?,'pm',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", ['原人名']); engineerId = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  await c.execute("INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,'pm',0)", [projectId, engineerId]);
  for (let i = 1; i <= 7; i++) await c.execute('INSERT INTO project_stages (project_id,stage_code,state,note,expected_end_on) VALUES (?,?,?,?,?)', [projectId, 'S' + i, i === 1 ? 'ready' : 'locked', '原评述', i < 3 ? '2020-06-01' : null]);
  const stages = (await c.query('SELECT CAST(id AS CHAR) id,stage_code code FROM project_stages WHERE project_id=? ORDER BY stage_code', [projectId]))[0];
  for (const [index, date] of ['2020-02-01', '2020-02-03', null, '2020-12-01'].entries()) { await c.execute("INSERT INTO project_nodes (project_id,kind,stage_id,title,target_date,output,note,sort_order,deleted_at) VALUES (?,'project',?,?,?,'原成果','',?,?)", [projectId, stages[0].id, '原节点' + index, date, index, index === 3 ? '2020-01-01' : null]); nodeIds.push((await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id); }
  await c.execute("INSERT INTO project_nodes (project_id,kind,title,target_date,output,note,sort_order) VALUES (?,'customer','客户截止','2021-01-01','','',0)", [projectId]);
  await c.execute("INSERT INTO project_nodes (project_id,kind,stage_id,title,output,note,sort_order) VALUES (?,'project',?,'全未定节点','','',0)", [projectId, stages[2].id]);
  for (let i = 0; i < 2; i++) { await c.execute("INSERT INTO project_risks (project_id,content,level,resolved,resolution,created_at,source_key,sort_order) VALUES (?,?,'high',0,'','2020-01-01',?,?)", [projectId, '原风险' + i, 'risk-' + i, i]); riskIds.push((await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id); }
  const oldBody = { expectedVersion: '8', idempotencyKey: randomUUID(), changes: { summaryNote: '旧备注待核对' } }, oldResult = { projectId, operationId: oldBody.idempotencyKey, changed: true, savedVersion: '9', values: { name: prefix, marketExpectation: '原市场预期', detailNote: '原详情', summaryNote: '旧备注待核对' }, savedAt: '2020-01-01T00:00:00.000Z' };
  const hash = createHash('sha256').update(JSON.stringify([projectId, 'text', '8', oldBody.changes])).digest();
  await c.execute("INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,'2020-01-01')", [userId, 'user:' + userId + ':project:' + projectId + ':text', oldBody.idempotencyKey, hash, JSON.stringify(oldResult)]);
  await c.execute("INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user','project.text.save','project',?,?,8,9,?,?,'old-request','2020-01-01')", [userId, '原人名快照', projectId, projectId, JSON.stringify({ summaryNote: '' }), JSON.stringify({ summaryNote: '旧备注待核对' })]);
  for (const table of ['projects', 'project_stages', 'project_nodes', 'project_risks', 'project_people', 'project_responsibilities', 'audit_log']) oldColumns[table] = (await c.query('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table]))[0].map(row => row.name);
  const before = await snapshot(); await writeFile(code, currentCode);
  await c.query('ALTER TABLE project_risks ADD COLUMN __p04_extra int NULL');
  try { assert.equal((await run()).last.code, 'DB_SCHEMA_MISMATCH'); assert.equal((await c.query('SELECT version FROM schema_migrations'))[0].length, 3); } finally { await c.query('ALTER TABLE project_risks DROP COLUMN __p04_extra'); }
  assert(currentCode.includes('await query(connection, increment.sql);'));
  await writeFile(code, currentCode.replace('await query(connection, increment.sql);', "await query(connection, increment.sql); process.kill(process.pid, 'SIGKILL');"));
  assert.equal((await run()).signal, 'SIGKILL'); assert.equal((await c.query('SELECT version FROM schema_migrations'))[0].length, 3);
  assert.equal(Number((await c.query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='projects' AND COLUMN_NAME='summary'"))[0][0].n), 1);
  assert.equal(Number((await c.query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_risks' AND COLUMN_NAME='deleted_at'"))[0][0].n), 0);
  assert.deepEqual(await snapshot(), before); await writeFile(code, currentCode); assert.equal((await run()).exitCode, 0);
  assert.deepEqual(await snapshot(), before); assert.equal((await c.query('SELECT summary FROM projects WHERE id=?', [projectId]))[0][0].summary, '');
  assert((await c.query('SELECT deleted_at FROM project_risks WHERE project_id=?', [projectId]))[0].every(row => row.deleted_at === null));
  const registered = (await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0]; assert.deepEqual(registered.slice(0, 3), history);
  assert.equal((await run()).last.applied, false); assert.deepEqual((await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0], registered);
  checks.push('含数据0003升级：额外结构拒绝、首个DDL后进程死亡及精确续跑、旧值/计划/来源/责任/历史/回执全部保留、重复迁移不变');
  const resource = resolve(fixture, 'migrations/0004-project-compatibility.json'), bytes = await readFile(resource, 'utf8'); await writeFile(resource, bytes + ' ');
  assert.equal((await run()).last.code, 'DB_MIGRATION_CHECKSUM_MISMATCH'); await writeFile(resource, bytes);
  await writeFile(code, oldSchema); assert.equal((await run('verify')).last.code, 'DB_COLUMN_EXTRA_UNSUPPORTED'); await writeFile(code, currentCode);
  const review = await run('', resolve('dist/server/commands/compatibility-review.js')); assert.equal(review.exitCode, 0, JSON.stringify(review));
  assert.deepEqual(review.last.summarySources, [{ projectId, field: 'summary_note', status: 'source_review_required', retained: true }]);
  assert.deepEqual(review.last.legacyManagers, [{ projectId, engineerId, status: 'legacy_engineer_reference', grantsPermission: false }]);
  assert.equal(review.last.stagePlans[0].expectedEndOn, '2020-02-03'); assert.equal(review.last.stagePlans[1].expectedEndOn, null); assert.deepEqual(await snapshot(), before);
  await writeFile('test-results/p04-compatibility-review.json', JSON.stringify(review.last, null, 2) + '\n');
  checks.push('已应用资源摘要保护；不兼容0003构建拒绝；只读迁移差异不改旧备注及计划');
  await start(); await api('/api/auth/login', 'POST', { loginName: prefix, password }); await api('/api/auth/me'); const path = '/api/projects/' + projectId;
  let d = await api(path); assert.equal(d.project.summary, ''); assert.equal(d.project.summaryNote, '旧备注待核对'); assert.equal(d.project.chipstatNote, '原芯片备注');
  assert.deepEqual(d.stages.slice(0, 3).map(row => [row.expectedEndOn, Number(row.nodeCount), Number(row.undatedNodeCount)]), [['2020-02-03', 3, 1], [null, 0, 0], [null, 1, 1]]);
  assert.deepEqual((await api(path + '/save-results/query', 'POST', oldBody)).result, oldResult);
  await c.execute("UPDATE project_risks SET deleted_at='2020-01-01' WHERE id=?", [riskIds[1]]);
  d = await api(path); assert.deepEqual(d.risks.map(row => row.id), [riskIds[0]]);
  const close = await api(path + '/actions/preview', 'POST', { action: 'closeProject', expectedVersion: '9', idempotencyKey: randomUUID(), closureType: 'terminated', closedOn: '2020-01-01', closureNote: '明确结束', remainingWorkNote: '保留未完事项' }); assert.deepEqual(close.remaining.risks.map(row => row.id), [riskIds[0]]);
  const rejected = await api(path, 'PATCH', { expectedVersion: '9', idempotencyKey: randomUUID(), changes: { summary: '不能提交', riskOps: [{ op: 'resolve', id: riskIds[1], resolution: '已删除禁止修改' }] } }, 404); assert.equal(rejected.code, 'RISK_NOT_FOUND'); assert.equal((await api(path)).project.version, '9');
  checks.push('新GET阶段日期排除客户/删除节点，区分无节点/部分未知/全部未知；风险读取与结案排除删除行，删除行候选拒绝且文字一同回滚');
  for (const [key, value] of [['summary', '核对后的独立简介'], ['summaryNote', '独立状态备注'], ['chipstatNote', '独立芯片备注']]) {
    d = await api(path); const request = { expectedVersion: d.project.version, idempotencyKey: randomUUID(), changes: { [key]: value } };
    const saved = await api(path, 'PATCH', request); const next = await api(path); assert.equal(next.project[key], value);
    for (const other of ['summary', 'summaryNote', 'chipstatNote', 'statusDesc', 'detailNote', 'marketExpectation'].filter(other => other !== key)) assert.equal(next.project[other], d.project[other]);
    assert.deepEqual((await api(path + '/save-results/query', 'POST', request)).result, saved.result);
  }
  const listed = await api('/api/projects?dashboard=1&view=proposal'); const item = listed.items.find(item => item.id === projectId); assert.equal(item.summary, '核对后的独立简介'); assert.equal(item.summaryNote, '独立状态备注');
  const persisted = await snapshot(); assert.deepEqual(persisted.project_stages, before.project_stages); assert.deepEqual(persisted.project_responsibilities, before.project_responsibilities);
  assert(persisted.audit_log.some(row => row.request_id === 'old-request' && row.actor_display_name === '原人名快照'));
  const created = await api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '_new', summary: '新项目简介', summaryNote: '新项目备注' } }); projectIds.push(created.result.projectId);
  const newProject = (await api('/api/projects/' + created.result.projectId)).project; assert.equal(newProject.summary, '新项目简介'); assert.equal(newProject.summaryNote, '新项目备注');
  await app.close(); app = undefined; await start(); assert.equal((await api(path)).project.summary, '核对后的独立简介'); assert.deepEqual((await api(path)).risks.map(row => row.id), [riskIds[0]]);
  assert.deepEqual((await api(path + '/save-results/query', 'POST', oldBody)).result, oldResult);
  const { connection: freshRead } = await connectDatabase('test_app');
  try { const rows = (await freshRead.query('SELECT summary,summary_note,chipstat_note FROM projects WHERE id=?', [projectId]))[0]; assert.deepEqual(rows, [{ summary: '核对后的独立简介', summary_note: '独立状态备注', chipstat_note: '独立芯片备注' }]); assert((await freshRead.query('SELECT content,source_key,deleted_at FROM project_risks WHERE id=?', [riskIds[1]]))[0][0].deleted_at); } finally { await freshRead.end(); }
  checks.push('真实登录后简介/两类备注独立保存、新建、列表消费、新连接SQL；兼容应用重启后同会话、删除过滤及升级前原回执保持');
  const facts = { status: 'passed', checkedAt: new Date().toISOString(), checks, structure: await verifyDatabase('test_migrator'), source: '独立MySQL实例、合成旧数据、真实HTTP和新连接；常驻两库未升级', productRiskDeleteEnabled: false, frontendAcceptance: '未执行，按P04后续页面步骤接入' };
  await writeFile('test-results/project-compatibility-check.json', JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts));
} finally {
  if (app) await app.close();
  for (const id of projectIds) { await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?', [id]); for (const table of ['project_nodes', 'project_risks', 'audit_log', 'project_stages', 'project_people', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  if (engineerId) await c.execute('DELETE FROM engineers WHERE id=?', [engineerId]);
  if (userId) { for (const table of ['command_receipts', 'audit_log']) await c.execute('DELETE FROM ' + table + ' WHERE actor_id=?', [userId]); await c.execute('DELETE FROM sessions WHERE user_id=?', [userId]); await c.execute('DELETE FROM users WHERE id=?', [userId]); }
  await c.end(); await rm(fixture, { recursive: true, force: true });
}
