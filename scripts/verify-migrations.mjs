import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { loadSchema, verifyDatabase } from '../dist/server/infrastructure/schema.js';

const fixture = resolve('test-results', `migration-fixture-${randomBytes(6).toString('hex')}`);
assert.ok(fixture.startsWith(resolve('test-results') + sep));
const command = resolve(fixture, 'server/commands/database.js');
const schemaCode = resolve(fixture, 'server/infrastructure/schema.js');
const resource = resolve(fixture, 'migrations/0001-foundation.json');
const checks = [];
const { manifest } = await loadSchema();
const { connection } = await connectDatabase('test_migrator');

function run(mode = 'migrate') {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [command, mode, 'test_migrator'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      const events = output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      accept({ exitCode, signal, events, last: events.at(-1) });
    });
  });
}

try {
  await mkdir(fixture, { recursive: true });
  await cp('dist/server', resolve(fixture, 'server'), { recursive: true });
  await cp('dist/migrations', resolve(fixture, 'migrations'), { recursive: true });
  const originalCode = await readFile(schemaCode, 'utf8');
  const originalResource = await readFile(resource, 'utf8');
  let alreadyComplete = false;
  const [existing] = await connection.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'");
  if (existing.length) {
    const [history] = await connection.query('SELECT version FROM schema_migrations');
    assert.ok(history.length <= 3, '测试库含未知版本，停止演练');
    alreadyComplete = history.some(row => row.version === '0001-foundation');
  }
  if (!alreadyComplete) {
  assert.ok(originalCode.includes('await query(connection, table.sql);'));
  await writeFile(schemaCode, originalCode.replace('await query(connection, table.sql);', "await query(connection, table.sql); process.kill(process.pid, 'SIGKILL');"));
  const interrupted = await run();
  assert.equal(interrupted.signal, 'SIGKILL');
  const [incompleteHistory] = await connection.query('SELECT version FROM schema_migrations');
  const [partialTables] = await connection.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  assert.equal(incompleteHistory.length, 0);
  assert.ok(partialTables.length > 1 && partialTables.length < 34);
  checks.push({ check: 'process-killed-after-ddl-before-step-verification', partialTables: partialTables.length, registeredVersions: 0 });
  await writeFile(schemaCode, originalCode);
  } else {
    await verifyDatabase('test_migrator');
    checks.push({ check: 'initial-ddl-interruption', status: 'skipped-already-complete', reason: '已有完整版本；保留现有表，不清库重测首次建表' });
  }
  const competing = await Promise.all([run(), run()]);
  assert.ok(competing.some(result => result.exitCode === 0), JSON.stringify(competing.map(result => result.last)));
  for (const result of competing) assert.ok(result.exitCode === 0 || result.last?.code === 'DB_MIGRATION_BUSY', JSON.stringify(result.last));
  const structure = await verifyDatabase('test_migrator');
  assert.equal(structure.tables, 34);
  assert.equal(structure.columns, 315);
  assert.equal(structure.foreignKeys, 55);
  checks.push({ check: 'resume-and-two-migration-processes', outcomes: competing.map(result => ({ exitCode: result.exitCode, result: result.last })), structure });
  const [before] = await connection.query('SELECT version, checksum, applied_at FROM schema_migrations');
  const repeated = await run();
  assert.equal(repeated.exitCode, 0, JSON.stringify(repeated.last));
  assert.equal(repeated.last.applied, false);
  const [after] = await connection.query('SELECT version, checksum, applied_at FROM schema_migrations');
  assert.deepEqual(after, before);
  checks.push({ check: 'repeat-keeps-history-unchanged', passed: true });
  await writeFile(resource, originalResource + ' ');
  const checksumFailure = await run();
  assert.equal(checksumFailure.exitCode, 1);
  assert.equal(checksumFailure.last.code, 'DB_MIGRATION_CHECKSUM_MISMATCH');
  await writeFile(resource, originalResource);
  checks.push({ check: 'changed-applied-resource-rejected', passed: true });
  await connection.query('SELECT GET_LOCK(?, 5)', ['geekdash:geekdash_test:schema']);
  try {
    const busy = await run();
    assert.equal(busy.exitCode, 1);
    assert.equal(busy.last.code, 'DB_MIGRATION_BUSY');
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', ['geekdash:geekdash_test:schema']); }
  checks.push({ check: 'lock-timeout-without-ddl', passed: true });
  // 专用空测试库故障演练；不改正式资源、不连接开发库。
  await connection.query("DELETE FROM schema_migrations WHERE version='0003-node-recovery'");
  assert.ok(originalCode.includes("step = 'register_increment';"));
  await writeFile(schemaCode, originalCode.replace("step = 'register_increment';", "process.kill(process.pid, 'SIGKILL');"));
  const beforeRegistration = await run();
  assert.equal(beforeRegistration.signal, 'SIGKILL');
  const [unregistered] = await connection.query('SELECT version FROM schema_migrations');
  assert.equal(unregistered.length, 2);
  assert.ok(beforeRegistration.events.some(event => event.event === 'migration_structure_verified'));
  await writeFile(schemaCode, originalCode);
  const recovered = await run();
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.last));
  checks.push({ check: 'complete-ddl-unregistered-process-death-and-recovery', passed: true });
  const nodeForeign = manifest.tables.find(table => table.name === 'project_nodes').foreignKeys.find(key => key.columns.includes('stage_id'));
  await connection.query(`ALTER TABLE project_nodes DROP FOREIGN KEY \`${nodeForeign.name}\``);
  try {
    const missing = await run('verify');
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.last.code, 'DB_SCHEMA_MISMATCH');
    assert.ok(missing.last.differences.some(diff => diff.table === 'project_nodes' && diff.object === 'foreignKeys'));
  } finally { await connection.query(nodeForeign.sql); }
  checks.push({ check: 'full-version-with-missing-foreign-key-rejected', passed: true });
  const [user] = await connection.execute('INSERT INTO users (login_name,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', ['migration_fixture', 'fixture-unusable-hash', '迁移测试人员']);
  let projectIds = [];
  try {
    await assert.rejects(connection.execute('INSERT INTO users (login_name,password_hash,display_name,enabled,created_at,updated_at) VALUES (?,?,?,2,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', ['invalid_boolean', 'fixture-unusable-hash', '非法标记']), error => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED');
    await assert.rejects(connection.execute('INSERT INTO users (login_name,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', ['migration_fixture', 'fixture-unusable-hash', '重复登录名']), error => error.code === 'ER_DUP_ENTRY');
    await assert.rejects(connection.execute('INSERT INTO users (login_name,password_hash,display_name,created_at,updated_at) VALUES (?,?,NULL,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', ['invalid_null', 'fixture-unusable-hash']), error => error.code === 'ER_BAD_NULL_ERROR');
    for (const name of ['迁移测试项目甲', '迁移测试项目乙']) {
      const [project] = await connection.execute('INSERT INTO projects (name,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [name, '', '', '', '', '', '', '', '']);
      projectIds.push(String(project.insertId));
    }
    const [stage] = await connection.execute('INSERT INTO project_stages (project_id,stage_code,state,note) VALUES (?,\'S1\',\'ready\',\'\')', [projectIds[0]]);
    await assert.rejects(connection.execute('INSERT INTO project_nodes (project_id,kind,stage_id,title,output,note,sort_order) VALUES (?,\'project\',?,\'跨项目节点\',\'\',\'\',0)', [projectIds[1], String(stage.insertId)]), error => error.code === 'ER_NO_REFERENCED_ROW_2');
    await assert.rejects(connection.execute('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))', [projectIds[0], '999999999999']), error => error.code === 'ER_NO_REFERENCED_ROW_2');
    const { connection: fresh } = await connectDatabase('test_app');
    try {
      const [rows] = await fresh.execute('SELECT name,status,priority,`signal`,manual_delayed,maintenance_enabled,version FROM projects WHERE id = ?', [projectIds[0]]);
      assert.deepEqual(rows, [{ name: '迁移测试项目甲', status: 'proposal', priority: 'mid', signal: 'green', manual_delayed: 0, maintenance_enabled: 0, version: '1' }]);
    } finally { await fresh.end(); }
    checks.push({ check: 'check-unique-null-orphan-cross-project-and-fresh-readback', passed: true });
  } finally {
    await connection.execute('DELETE FROM project_stages WHERE project_id = ?', [projectIds[0] ?? '0']);
    for (const id of projectIds) await connection.execute('DELETE FROM projects WHERE id = ?', [id]);
    await connection.execute('DELETE FROM users WHERE id = ?', [String(user.insertId)]);
  }
  const final = await verifyDatabase('test_migrator');
  await writeFile(resolve('test-results/migration-check.json'), JSON.stringify({ status: 'passed', verifiedAt: new Date().toISOString(), structure: final, checks, source: '隔离测试库及编译产物副本故障注入', businessReady: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', structure: final, checks }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'MIGRATION_TEST_FAILED', reason: error.message, completed: checks.map(check => check.check) }));
  process.exitCode = 1;
} finally {
  await connection.end();
  await rm(fixture, { recursive: true, force: true });
}
