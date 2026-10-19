import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { loadSchema } from '../dist/server/infrastructure/schema.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';

const checks = [];
const { connection: migration } = await connectDatabase('test_migrator');
const { manifest } = await loadSchema();
const [history] = await migration.query('SELECT version, checksum, applied_at FROM schema_migrations');
assert.equal(history.length, 4);
const foreign = manifest.tables.find(table => table.name === 'project_nodes').foreignKeys.find(key => key.columns.includes('stage_id'));
let removedForeign = false;
let runtime;
let app;
let child;
const leases = [];
async function restoreHistory() {
  await migration.execute('DELETE FROM schema_migrations');
  for (const row of history) await migration.execute('INSERT INTO schema_migrations (version,checksum,applied_at) VALUES (?,?,?)', [row.version,row.checksum,row.applied_at]);
}
async function ready(origin, expected, reason) {
  const response = await fetch(origin + '/api/health/ready');
  assert.equal(response.status, expected);
  const body = await response.json();
  if (reason) assert.equal(body.reason, reason);
  assert.ok(!JSON.stringify(body).includes('gd_test_app'));
  return body;
}
try {
  const invalid = spawnSync(process.execPath, ['dist/server/start.js'], { env: { ...process.env, GEEKDASH_DB_PROFILE: 'test_migrator' }, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.deepEqual(JSON.parse(invalid.stderr.trim()), { status: 'startup_failed', code: 'APP_CONFIG_INVALID', field: 'GEEKDASH_DB_PROFILE' });
  checks.push({ check: 'actual-start-invalid-runtime-config-exits-nonzero-with-field', passed: true });
  await assert.rejects(openRuntimeDatabase('test_migrator'), error => error.code === 'DB_RUNTIME_PROFILE_INVALID');
  await migration.execute("UPDATE schema_migrations SET version = '9999-future' WHERE version='0004-project-compatibility'");
  await assert.rejects(openRuntimeDatabase('test_app'), error => error.code === 'DB_SCHEMA_VERSION_UNSUPPORTED');
  await restoreHistory();
  checks.push({ check: 'runtime-role-and-future-version-rejected-before-listening', passed: true });
  runtime = await openRuntimeDatabase('test_app');
  assert.equal(runtime.fact.tables, 34);
  assert.equal(runtime.fact.columns, 317);
  assert.equal(runtime.fact.foreignKeys, 55);
  await assert.rejects(runtime.pool.query('CREATE TABLE __readiness_forbidden (id INT)'), error => error.code === 'ER_TABLEACCESS_DENIED_ERROR');
  await assert.rejects(runtime.pool.query('USE geekdash_dev'), error => error.code === 'ER_DBACCESS_DENIED_ERROR');
  app = await createApp(runtime);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  await ready(origin, 200);
  assert.equal((await fetch(origin + '/api/health/live')).status, 200);
  await delay(2100);
  const concurrent = await Promise.all(Array.from({ length: 20 }, () => fetch(origin + '/api/health/ready')));
  assert.ok(concurrent.every(response => response.status === 200));
  assert.ok(concurrent.every(response => response.headers.get('cache-control') === 'no-store'));
  checks.push({ check: 'full-startup-schema-runtime-grants-and-twenty-http-requests', passed: true });

  await migration.execute('UPDATE schema_migrations SET checksum = ?', [Buffer.alloc(32)]);
  await delay(2100);
  await ready(origin, 503, 'schema_incompatible');
  assert.equal((await fetch(origin + '/api/health/live')).status, 200);
  assert.equal((await fetch(origin + '/api/projects')).status, 503);
  await restoreHistory();
  await migration.query(`ALTER TABLE project_nodes DROP FOREIGN KEY \`${foreign.name}\``);
  removedForeign = true;
  await ready(origin, 503, 'schema_incompatible');
  await assert.rejects(openRuntimeDatabase('test_app'), error => error.code === 'DB_SCHEMA_MISMATCH');
  await migration.query(foreign.sql);
  removedForeign = false;
  await ready(origin, 200);
  checks.push({ check: 'checksum-failure-and-missing-constraint-block-startup-or-recovery', passed: true });

  for (let index = 0; index < 8; index++) leases.push(await runtime.pool.getConnection());
  await delay(2100);
  const busyStarted = performance.now();
  await ready(origin, 503, 'database_busy');
  assert.ok(performance.now() - busyStarted < 1000);
  leases.splice(0).forEach(connection => connection.release());
  await ready(origin, 200);
  checks.push({ check: 'eight-connections-exhausted-fails-fast-and-recovers', passed: true });

  // 只替换此测试池一条连接的探测 SQL；仍执行真实 SELECT SLEEP，验证实际超时销毁。
  const slow = await runtime.pool.getConnection();
  const originalQuery = slow.connection.query.bind(slow.connection);
  let slowQueryExecuted = false;
  slow.connection.query = (options, ...parameters) => {
    if (options.sql === 'SELECT 1') {
      slowQueryExecuted = true;
      return originalQuery({ ...options, sql: 'SELECT SLEEP(10)' }, ...parameters);
    }
    return originalQuery(options, ...parameters);
  };
  slow.release();
  await delay(2100);
  const started = performance.now();
  const waiting = fetch(origin + '/api/health/ready');
  await delay(200);
  assert.equal((await fetch(origin + '/api/health/live')).status, 200);
  const timedOut = await waiting;
  assert.equal(timedOut.status, 503);
  assert.equal((await timedOut.json()).reason, 'database_unavailable');
  assert.ok(slowQueryExecuted);
  assert.ok(performance.now() - started < 5000);
  await ready(origin, 200);
  checks.push({ check: 'real-slow-sql-timeout-live-responsive-and-new-connection-recovery', passed: true });
  runtime.beginClosing();
  await ready(origin, 503, 'closing');
  await app.close();
  app = undefined;
  runtime = undefined;

  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let output = '';
  child = spawn(process.execPath, ['dist/server/start.js'], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), GEEKDASH_DB_PROFILE: 'test_app' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.on('close', (exitCode, signal) => resolve({ exitCode, signal })));
  let running = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health/ready`)).status === 200) { running = true; break; } }
    catch {}
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(running, output);
  const closedAt = performance.now();
  child.kill('SIGTERM');
  const outcome = await Promise.race([exited, delay(6000).then(() => { throw new Error('关闭超时'); })]);
  assert.equal(outcome.exitCode, 0);
  assert.ok(performance.now() - closedAt < 6000);
  child = undefined;
  checks.push({ check: 'actual-start-process-sigterm-clean-exit-within-budget', passed: true });
  const [after] = await migration.query('SELECT version, checksum, applied_at FROM schema_migrations');
  assert.deepEqual(after, history);
  const [counts] = await migration.query('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM projects) AS projects');
  assert.equal(Number(counts[0].users), 0);
  assert.equal(Number(counts[0].projects), 0);
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/readiness-check.json', JSON.stringify({ status: 'passed', verifiedAt: new Date().toISOString(), target: 'geekdash_test', checks, businessReady: false }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code, reason: error.message, completed: checks }));
  process.exitCode = 1;
} finally {
  if (child) child.kill('SIGKILL');
  leases.forEach(connection => connection.release());
  if (app) await app.close();
  else if (runtime) await runtime.close();
  if (removedForeign) await migration.query(foreign.sql);
  await restoreHistory();
  await migration.end();
}
