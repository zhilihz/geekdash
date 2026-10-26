import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { loadSchema, verifyDatabase } from '../dist/server/infrastructure/schema.js';
import { projectNameKey } from '../dist/server/modules/project-name.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1', '只允许专用隔离实例');
assert.match(process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID ?? '', /^[a-f0-9-]{36}$/);
const { connection: c } = await connectDatabase('test_migrator');
const fixture = resolve('test-results', 'space-upgrade-' + randomUUID());
assert(fixture.startsWith(resolve('test-results') + sep));
const code = resolve(fixture, 'server/infrastructure/schema.js');
const command = resolve(fixture, 'server/commands/database.js');
const checks = [], interruptions = [];
const run = (mode = 'migrate', killStep = '') => new Promise((accept, reject) => {
  const child = spawn(process.execPath, [command, mode, 'test_migrator'], { env: { ...process.env, GEEKDASH_SPACE_KILL_STEP: killStep }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', v => output += v); child.stderr.on('data', v => output += v); child.on('error', reject);
  child.on('close', (exitCode, signal) => {
    const events = output.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { diagnostic: line }; } });
    accept({ exitCode, signal, last: events.at(-1), events });
  });
});
const lastId = async () => (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
async function snapshot(tables) {
  const result = {};
  for (const table of tables) if (table.name !== 'schema_migrations') {
    const columns = table.columns.map(v => '`' + v.name + '`').join(',');
    const order = table.indexes.find(v => v.name === 'PRIMARY').columns.map(v => '`' + v + '`').join(',');
    result[table.name] = (await c.query(`SELECT ${columns} FROM \`${table.name}\` ORDER BY ${order}`))[0];
  }
  return result;
}
try {
  assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
  assert.equal((await c.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'))[0].length, 0, '已有库不重置');
  await mkdir(fixture, { recursive: true }); await cp('dist/server', resolve(fixture, 'server'), { recursive: true }); await cp('dist/migrations', resolve(fixture, 'migrations'), { recursive: true });
  const current = await readFile(code, 'utf8'), old = current.replace(/,\s*\['0009-project-space',\s*8\]/, '');
  assert.notEqual(current, old);
  await writeFile(code, old);
  assert.equal((await run()).exitCode, 0);
  const previous = await (await import(pathToFileURL(code).href + '?old')).loadSchema();
  assert.equal(previous.manifest.version, '0008-import-name-bindings');
  await c.query("INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES ('space_probe','not-a-password','合成迁移账号',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))");
  const user = await lastId();
  const insert = async name => { await c.execute("INSERT INTO projects(name,created_by,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at) VALUES (?,?,'','','','','','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [name, user]); return lastId(); };
  const project = await insert('\u3000迁移项目 A\u00a0'), second = await insert('迁移项目 a');
  await c.execute('INSERT INTO project_responsibilities(project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))', [project, user]);
  await c.execute("INSERT INTO project_stages(project_id,stage_code,state,note) VALUES (?,'S1','ready','保留原状态')", [project]);
  await c.execute("INSERT INTO audit_log(actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,before_json,after_json,request_id,created_at) VALUES (?,'合成账号','user','project.ordinary.save','project',?,?,?,?,'probe',UTC_TIMESTAMP(3))", [user, project, project, JSON.stringify({ name: '旧名称' }), JSON.stringify({ name: '迁移项目 A' })]);
  const duplicate = await insert('迁移项目 A');
  await writeFile(code, current);
  const rejected = await run(); assert.equal(rejected.last.code, 'DB_PROJECT_NAME_DUPLICATE', JSON.stringify(rejected));
  assert.equal((await c.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='projects' AND COLUMN_NAME='name_key'"))[0].length, 0);
  await c.execute('DELETE FROM projects WHERE id=?', [duplicate]);
  checks.push('ECMAScript空白重名在DDL前拒绝，大小写不同保持不同项目');
  const before = await snapshot(previous.manifest.tables), history = (await c.query('SELECT * FROM schema_migrations ORDER BY version'))[0];
  const marker = "console.log(JSON.stringify({ event: 'migration_step_verified', object: step }));";
  assert.equal(current.split(marker).length - 1, 2);
  await writeFile(code, current.replaceAll(marker, marker + " if (process.env.GEEKDASH_SPACE_KILL_STEP === step) process.kill(process.pid, 'SIGKILL');"));
  const resource = await loadSchema(), increment = resource.increments.at(-1);
  for (const [index, step] of increment.steps.entries()) {
    const key = step.data ?? `${step.table}:${index + 1}`, killed = await run('migrate', key);
    assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed));
    assert.deepEqual(await snapshot(previous.manifest.tables), before);
    assert.equal((await c.query('SELECT * FROM schema_migrations'))[0].length, 8);
    interruptions.push({ step: key, oldRowsUnchanged: true, signal: killed.signal });
  }
  await writeFile(code, current);
  const upgraded = await run(); assert.equal(upgraded.exitCode, 0, JSON.stringify(upgraded)); assert.equal(upgraded.last.tables, 40);
  assert.deepEqual(await snapshot(previous.manifest.tables), before);
  assert.deepEqual((await c.query('SELECT * FROM schema_migrations ORDER BY version'))[0].slice(0, 8), history);
  assert.equal((await run()).last.applied, false);
  checks.push('8步真实进程中断后续跑，38张旧表原列内容及迁移登记不变，重复迁移无变化');
  for (const row of (await c.query('SELECT name,name_key FROM projects'))[0]) assert(row.name_key.equals(projectNameKey(row.name)));
  assert.deepEqual((await c.query('SELECT CAST(project_id AS CHAR) id,name_key FROM project_name_aliases'))[0].map(v => [v.id, v.name_key.toString()]), [[project, '旧名称']]);
  await assert.rejects(c.execute('UPDATE projects SET name_key=? WHERE id=?', [projectNameKey('迁移项目 A'), second]), { code: 'ER_DUP_ENTRY' });
  await c.execute("UPDATE project_stages SET state='unknown' WHERE project_id=?", [project]);
  await assert.rejects(c.execute("UPDATE project_stages SET state='invented' WHERE project_id=?", [project]));
  const request = "INSERT INTO project_membership_requests(project_id,kind,initiator_id,target_user_id,status,created_at) VALUES (?,'application',?,?,'pending',UTC_TIMESTAMP(3))";
  await c.execute(request, [project, user, user]); const requestId = await lastId();
  await assert.rejects(c.execute(request, ['9999999', user, user]), { code: 'ER_NO_REFERENCED_ROW_2' });
  await assert.rejects(c.execute("UPDATE project_membership_requests SET status='accepted' WHERE id=?", [requestId]));
  await c.execute("UPDATE project_membership_requests SET status='accepted',resolved_at=UTC_TIMESTAMP(3),resolved_by=?,resolution_code='accepted' WHERE id=?", [user, requestId]);
  await assert.rejects(c.execute("UPDATE project_membership_requests SET status='pending' WHERE id=?", [requestId]));
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_responsibilities'))[0][0].n), 1);
  checks.push('名称唯一与别名、unknown状态、请求外键和终态约束均真实MySQL拒绝反例；迁移不创建邀请或责任');
  const delta = resolve(fixture, 'migrations/0009-project-space.json'), bytes = await readFile(delta);
  await writeFile(delta, Buffer.concat([bytes, Buffer.from(' ')])); assert.equal((await run('verify')).last.code, 'DB_MIGRATION_CHECKSUM_MISMATCH'); await writeFile(delta, bytes);
  await writeFile(code, old); assert.equal((await run('verify')).last.code, 'DB_SCHEMA_MISMATCH'); await writeFile(code, current);
  checks.push('新迁移摘要改动及旧版应用读取新结构均明确拒绝');
  const result = { status: 'passed', checkedAt: new Date().toISOString(), serverUuid: process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID, checks, interruptions, originalRowsHash: createHash('sha256').update(JSON.stringify(before)).digest('hex'), structure: await verifyDatabase('test_migrator'), scope: '独立MySQL合成存量；不代表线上恢复或完整P05验收' };
  await writeFile('test-results/project-space-migration-check.json', JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
} finally { await c.end(); await rm(fixture, { recursive: true, force: true }); }
