import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { connectDatabase } from '../dist/server/infrastructure/db.js';

const stateFile = new URL('../test-results/database-probe.json', import.meta.url);
const resultsFile = new URL('../test-results/database-check.json', import.meta.url);
const phase = process.argv[2];
const checks = [];
let fixture;
let created = false;
let migration;
let runtime;

try {
  assert.ok(['prepare', 'resume'].includes(phase), '仅支持 prepare/resume');
  migration = (await connectDatabase('test_migrator')).connection;
  runtime = (await connectDatabase('test_app')).connection;
  if (phase === 'prepare') {
    await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
    await assert.rejects(readFile(stateFile), error => error.code === 'ENOENT');
    for (const profile of ['dev_app', 'dev_migrator', 'test_app', 'test_migrator']) {
      const { connection, fact } = await connectDatabase(profile);
      try {
        const other = profile.startsWith('dev_') ? 'geekdash_test' : 'geekdash_dev';
        await assert.rejects(connection.query(`USE ${other}`), error => error.code === 'ER_DBACCESS_DENIED_ERROR');
        checks.push({ check: 'identity-and-cross-database-denial', ...fact });
      } finally { await connection.end(); }
    }
    await assert.rejects(mysql.createConnection({
      host: 'mysql', port: 3306, user: 'gd_test_app', password: 'invalid-test-password',
      database: 'geekdash_test', connectTimeout: 5000,
    }), error => error.code === 'ER_ACCESS_DENIED_ERROR');
    checks.push({ check: 'wrong-password-denied', passed: true });
    fixture = { table: `__f02a_probe_${randomBytes(6).toString('hex')}`, token: randomBytes(16).toString('hex') };
    await assert.rejects(runtime.query(`CREATE TABLE ${fixture.table} (id INT)`), error => error.code === 'ER_TABLEACCESS_DENIED_ERROR');
    checks.push({ check: 'runtime-ddl-denied', passed: true });
    await migration.query(`CREATE TABLE ${fixture.table} (id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, value VARCHAR(64) NOT NULL) ENGINE=InnoDB`);
    created = true;
    await runtime.execute(`INSERT INTO ${fixture.table} (id, value) VALUES (?, ?)`, [fixture.token, 'before-update']);
    await runtime.execute(`UPDATE ${fixture.table} SET value = ? WHERE id = ?`, ['persisted', fixture.token]);
    await runtime.execute(`INSERT INTO ${fixture.table} (id, value) VALUES (?, ?)`, ['temporary', 'delete-me']);
    await runtime.execute(`DELETE FROM ${fixture.table} WHERE id = ?`, ['temporary']);
    const fresh = (await connectDatabase('test_app')).connection;
    try {
      const [rows] = await fresh.execute(`SELECT id, value FROM ${fixture.table}`);
      assert.deepEqual(rows, [{ id: fixture.token, value: 'persisted' }]);
    } finally { await fresh.end(); }
    checks.push({ check: 'runtime-crud-and-fresh-connection-readback', passed: true });
    await writeFile(stateFile, JSON.stringify({ ...fixture, checks }, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: 'awaiting-mysql-restart', database: 'geekdash_test', checks }));
  } else {
    fixture = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.match(fixture.table, /^__f02a_probe_[a-f0-9]{12}$/);
    assert.match(fixture.token, /^[a-f0-9]{32}$/);
    const [rows] = await runtime.execute(`SELECT id, value FROM ${fixture.table}`);
    assert.deepEqual(rows, [{ id: fixture.token, value: 'persisted' }]);
    await migration.query(`DROP TABLE ${fixture.table}`);
    const [remaining] = await migration.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', ['geekdash_test', fixture.table]);
    assert.equal(remaining.length, 0);
    const report = {
      status: 'passed', verifiedAt: new Date().toISOString(), database: 'geekdash_test',
      checks: [...fixture.checks, { check: 'mysql-restart-persistence-and-fresh-readback', passed: true }, { check: 'test-fixture-cleanup', passed: true }],
      businessSchemaChecked: false, businessReady: false,
    };
    await writeFile(resultsFile, JSON.stringify(report, null, 2) + '\n');
    await unlink(stateFile);
    console.log(JSON.stringify(report));
  }
} catch (error) {
  if (phase === 'prepare' && created && migration) await migration.query(`DROP TABLE ${fixture.table}`).catch(() => {});
  console.error(JSON.stringify({ status: 'failed', phase, reason: error.code ?? 'DB_TEST_FAILED', completedChecks: checks.map(check => check.check) }));
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.end();
  if (migration) await migration.end();
}
