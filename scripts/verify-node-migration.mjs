import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { loadSchema, migrateDatabase, verifyDatabase } from '../dist/server/infrastructure/schema.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { createApp } from '../dist/server/app.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1', '只在本轮独立空库实例执行，不在常驻两库演练');
assert.match(process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID ?? '', /^[a-f0-9-]{36}$/);
assert(process.env.GEEKDASH_NODE_MIGRATION_OLD_SCHEMA, '先从固定196405e镜像导出旧schema.js，设置GEEKDASH_NODE_MIGRATION_OLD_SCHEMA');
const oldSchema = await readFile(process.env.GEEKDASH_NODE_MIGRATION_OLD_SCHEMA);
assert.equal(createHash('sha256').update(oldSchema).digest('hex'), 'adf52a67e22666b9c0aea988fc06c283acdd7b70d575955e01f69c5abc67f345', '旧固定构建验证代码字节不符，停止隔离演练');
const { connection: c } = await connectDatabase('test_migrator');
const fixture = resolve('test-results', 'node-upgrade-' + randomUUID());
assert(fixture.startsWith(resolve('test-results') + sep));
const checks = [], prefix = 'node_upgrade_' + randomUUID().slice(0, 8), password = '隔离迁移测试 password 2026';
let projectId, userId, app, origin, cookie = '', csrf = '', account;
const command = resolve(fixture, 'server/commands/database.js'), code = resolve(fixture, 'server/infrastructure/schema.js');
async function run(mode = 'migrate') {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [command, mode, 'test_migrator'], { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('error', reject);
    child.on('close', (exitCode, signal) => accept({ exitCode, signal, last: JSON.parse(output.trim().split('\n').at(-1)) }));
  });
}
async function api(path, method = 'GET', body, expected = 200) {
  const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
  const out = await response.json(); assert.equal(response.status, expected, path + ': ' + JSON.stringify(out));
  if (path === '/api/auth/me') account = out.account; return out;
}
async function snapshot() {
  const { connection } = await connectDatabase('test_app');
  try {
    const result = {};
    for (const table of ['projects', 'project_stages', 'project_nodes', 'project_responsibilities', 'audit_log']) {
      const [columns] = await connection.query('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME<>\'deleted_at\' ORDER BY ORDINAL_POSITION', [table]);
      result[table] = (await connection.query(`SELECT ${columns.map(row => '`' + row.name + '`').join(',')} FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY ${table === 'project_responsibilities' ? 'user_id' : 'id'}`, [projectId]))[0];
    }
    result.receipts = (await connection.query('SELECT * FROM command_receipts WHERE actor_id=?', [userId]))[0]; return result;
  } finally { await connection.end(); }
}
try {
  assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
  const resource = await loadSchema(); await verifyDatabase('test_migrator');
  // 只还原已核实独立空实例的本轮列，以形成含数据0002；不删现有业务库。
  for (const table of resource.manifest.tables) if (table.name !== 'schema_migrations') assert.equal(Number((await c.query('SELECT COUNT(*) n FROM `' + table.name + '`'))[0][0].n), 0, '独立实例不再为空，停止重置');
  await mkdir(fixture, { recursive: true }); await cp('dist/server', resolve(fixture, 'server'), { recursive: true }); await cp('dist/migrations', resolve(fixture, 'migrations'), { recursive: true });
  const currentCode = await readFile(code, 'utf8'); await writeFile(code, oldSchema);
  await c.execute("DELETE FROM schema_migrations WHERE version='0003-node-recovery'"); await c.query('ALTER TABLE project_nodes DROP COLUMN deleted_at');
  assert.equal((await run('verify')).exitCode, 0); const history = (await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0]; assert.equal(history.length, 2);
  await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix, await hashPassword(password), '隔离升级合成账号']); userId = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  await c.execute("INSERT INTO projects (name,created_by,data_kind,source_namespace,source_key,version,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at) VALUES (?,?,'trial',?,'原来源',9,'','','','','旧已保存','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [prefix, userId, prefix]); projectId = (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  await c.execute('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))', [projectId, userId]);
  for (let i = 1; i <= 7; i++) await c.execute('INSERT INTO project_stages (project_id,stage_code,state,note) VALUES (?,?,?,?)', [projectId, 'S' + i, i === 1 ? 'ready' : 'locked', '原评述']);
  const stage = (await c.query("SELECT CAST(id AS CHAR) id FROM project_stages WHERE project_id=? AND stage_code='S1'", [projectId]))[0][0].id, ids = [];
  for (let i = 0; i < 2; i++) { await c.execute("INSERT INTO project_nodes (project_id,kind,stage_id,title,target_date,output,note,x,y,source_key,sort_order) VALUES (?,'project',?,?, '2020-01-01','原成果🙂','',240.125,20.25,?,?)", [projectId, stage, '原节点' + i, '旧节点' + i, i]); ids.push((await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id); }
  await c.execute('UPDATE project_nodes SET next_node_id=? WHERE id=?', [ids[1], ids[0]]); await c.execute('UPDATE project_nodes SET previous_node_id=? WHERE id=?', [ids[0], ids[1]]);
  const oldBody = { expectedVersion: '8', idempotencyKey: randomUUID(), changes: { summaryNote: '旧已保存' } }, oldResult = { projectId, operationId: oldBody.idempotencyKey, changed: true, savedVersion: '9', values: { name: prefix, marketExpectation: '', detailNote: '', summaryNote: '旧已保存' }, savedAt: '2020-01-01T00:00:00.000Z' };
  const hash = createHash('sha256').update(JSON.stringify([projectId, 'text', '8', oldBody.changes])).digest();
  await c.execute("INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,'2020-01-01')", [userId, 'user:' + userId + ':project:' + projectId + ':text', oldBody.idempotencyKey, hash, JSON.stringify(oldResult)]);
  await c.execute("INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user','project.text.save','project',?,?,8,9,?,?,'old-request','2020-01-01')", [userId, '原人名快照', projectId, projectId, JSON.stringify({ summaryNote: '' }), JSON.stringify({ summaryNote: '旧已保存' })]);
  const before = await snapshot(); await writeFile(code, currentCode);
  await c.query('ALTER TABLE project_nodes ADD COLUMN __migration_probe_extra int NULL');
  try { const bad = await run(); assert.equal(bad.exitCode, 1); assert.equal(bad.last.code, 'DB_SCHEMA_MISMATCH'); assert.equal((await c.query('SELECT version FROM schema_migrations'))[0].length, 2); } finally { await c.query('ALTER TABLE project_nodes DROP COLUMN __migration_probe_extra'); }
  checks.push('含数据0002、原双向节点/来源/版本/历史/二进制回执；额外对象在新增DDL前拒绝');
  const upgraded = await run(); assert.equal(upgraded.exitCode, 0, JSON.stringify(upgraded.last)); assert.equal(upgraded.last.columns, 315); assert.deepEqual(await snapshot(), before);
  assert((await c.query('SELECT deleted_at FROM project_nodes WHERE project_id=?', [projectId]))[0].every(row => row.deleted_at === null));
  const registered = (await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0]; assert.deepEqual(registered.slice(0, 2), history);
  assert.equal((await run()).last.applied, false); assert.deepEqual((await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0], registered);
  checks.push('真实含数据升级/NULL有效、34表315列55外键、原两摘要/登记时刻及全部业务保持，重复无变化');
  await c.execute("DELETE FROM schema_migrations WHERE version='0003-node-recovery'"); await writeFile(code, currentCode.replace("step = 'register_increment';", "process.kill(process.pid, 'SIGKILL');"));
  const killed = await run(); assert.equal(killed.signal, 'SIGKILL'); assert.equal((await c.query('SELECT version FROM schema_migrations'))[0].length, 2); assert.deepEqual(await snapshot(), before);
  await writeFile(code, currentCode); assert.equal((await run()).exitCode, 0); assert.deepEqual(await snapshot(), before);
  const newResource = resolve(fixture, 'migrations/0003-node-recovery.json'), original = await readFile(newResource, 'utf8'); await writeFile(newResource, original + ' ');
  assert.equal((await run()).last.code, 'DB_MIGRATION_CHECKSUM_MISMATCH'); await writeFile(newResource, original);
  await writeFile(code, oldSchema); assert.equal((await run('verify')).last.code, 'DB_SCHEMA_MISMATCH'); await writeFile(code, currentCode);
  checks.push('新增DDL已生效而未登记时真实进程死亡后精确续跑；0003资源回改拒绝；旧0002不能验证新结构');
  const runtime = await openRuntimeDatabase('test_app'); app = await createApp(runtime, { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
  await api('/api/auth/login', 'POST', { loginName: prefix, password }); await api('/api/auth/me'); const path = '/api/projects/' + projectId;
  assert.equal((await api(path)).nodes.length, 2); assert.deepEqual((await api(path + '/save-results/query', 'POST', oldBody)).result, oldResult);
  // 合成删除事实输入，仅测试读取兼容；此批不开放产品删除写入。
  await c.execute('UPDATE project_nodes SET next_node_id=NULL WHERE id=?', [ids[0]]); await c.execute("UPDATE project_nodes SET previous_node_id=NULL,deleted_at='2020-01-01' WHERE id=?", [ids[1]]);
  const d = await api(path); assert.deepEqual(d.nodes.map(row => row.id), [ids[0]]); assert.equal(d.nodes[0].deletedAt, null);
  const close = await api(path + '/actions/preview', 'POST', { action: 'closeProject', expectedVersion: '9', idempotencyKey: randomUUID(), closureType: 'terminated', closedOn: '2020-01-01', closureNote: '明确结束', remainingWorkNote: '原阶段及有效节点保留' }); assert.deepEqual(close.remaining.nodes.map(row => row.id), [ids[0]]);
  const failed = await api(path, 'PATCH', { expectedVersion: '9', idempotencyKey: randomUUID(), changes: { nodeOps: [{ op: 'link', from: ids[0], to: ids[1], replaceEdges: [], affectedIds: [], reason: '' }], summaryNote: '不应提交' } }, 404); assert.equal(failed.code, 'NODE_NOT_FOUND'); assert.equal((await api(path)).project.version, '9');
  await api(path, 'PATCH', { expectedVersion: '9', idempotencyKey: randomUUID(), changes: { summaryNote: '无关文字可保存' } }); assert.equal((await api(path)).project.summaryNote, '无关文字可保存');
  const deleted = (await c.query('SELECT CAST(id AS CHAR) id,title,output,source_key,deleted_at FROM project_nodes WHERE id=?', [ids[1]]))[0][0]; assert.equal(deleted.output, '原成果🙂'); assert.equal(deleted.source_key, '旧节点1'); assert(deleted.deleted_at);
  assert.deepEqual((await api(path + '/save-results/query', 'POST', oldBody)).result, oldResult);
  checks.push('真实登录/新详情/结案遗留/端点过滤；已删字段ID来源保留，无关文字可保存，旧正文原结果保持');
  const structure = await verifyDatabase('test_migrator'); await mkdir('test-results', { recursive: true });
  const facts = { status: 'passed', checkedAt: new Date().toISOString(), checks, structure, source: '独立自有MySQL空实例/合成旧0002 SQL来源/真实HTTP/新连接；常驻库未参与破坏演练', deleteRestoreDelivered: false };
  await writeFile('test-results/node-migration-check.json', JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts));
} finally {
  if (app) await app.close();
  if (projectId) { await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?', [projectId]); for (const table of ['project_nodes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [projectId]); await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [userId]); await c.execute('DELETE FROM projects WHERE id=?', [projectId]); }
  if (userId) { await c.execute('DELETE FROM audit_log WHERE actor_id=?', [userId]); await c.execute('DELETE FROM sessions WHERE user_id=?', [userId]); await c.execute('DELETE FROM users WHERE id=?', [userId]); }
  await c.end(); await rm(fixture, { recursive: true, force: true });
}
