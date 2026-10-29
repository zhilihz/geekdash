import assert from 'node:assert/strict';
import { parseDatabaseTarget, validateDatabaseGrants, validateDatabaseConnection, connectDatabase } from '../dist/server/infrastructure/db.js';
import { readConfig } from '../dist/server/infrastructure/config.js';
import { parseInitialAdministrator, initializeDatabase } from '../dist/server/commands/initialize.js';
import { migrateDatabase, verifyDatabase } from '../dist/server/infrastructure/schema.js';
import { hashPassword, verifyPassword } from '../dist/server/modules/identity.js';

const target = { host: 'mysql.example.internal', port: 3306, database: 'geekdash_k3s_verify_unit', user: 'gd_rds_app', password: 'Synthetic-db-only', ssl: { caFile: '/run/secrets/rds-ca.pem' } };
const admin = { loginName: 'verify_admin', name: '隔离初始化验证', password: 'Synthetic-admin-42', isProjectManager: false };
const code = expected => error => error?.code === expected;
const grant = (privileges, scope = '`geekdash\\_k3s\\_verify\\_unit`.*') => `GRANT ${privileges} ON ${scope} TO \`gd_rds_app\`@\`%\``;
const crud = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const ddl = ['CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES'];
let checks = 0;
function rejects(work, expected) { assert.throws(work, code(expected)); checks++; }
assert.equal(parseDatabaseTarget('rds_app', target).database, target.database); checks++;
for (const patch of [{ database: 'geekdash_dev' }, { database: 'mysql' }, { user: 'root' }, { port: '3306' }, { port: 0 }, { host: 'mysql://bad' }, { host: '127.0.0.1' }, { password: '' }])
  rejects(() => parseDatabaseTarget('rds_app', { ...target, ...patch }), 'DB_TARGET_INVALID');
for (const ssl of [undefined, false, { caFile: '/tmp/ca.pem' }, { caFile: '/run/secrets/../ca' }, { caFile: '/run/secrets/rds-ca.pem', rejectUnauthorized: false }])
  rejects(() => parseDatabaseTarget('rds_app', { ...target, ssl }), 'DB_TLS_CONFIG_INVALID');
rejects(() => parseDatabaseTarget('dev_app', target), 'DB_TARGET_INVALID');
rejects(() => parseDatabaseTarget('test_app', { host: 'mysql', port: 3306, database: 'geekdash_dev', user: 'gd_test_app', password: 'synthetic' }), 'DB_TARGET_INVALID');
assert.equal(parseDatabaseTarget('test_app', { host: 'mysql', port: 3306, database: 'geekdash_test', user: 'gd_test_app', password: 'synthetic' }).database, 'geekdash_test'); checks++;
assert.equal(readConfig({ GEEKDASH_DB_PROFILE: 'rds_app' }).databaseProfile, 'rds_app'); checks++;
rejects(() => readConfig({ GEEKDASH_DB_PROFILE: 'rds_migrator' }), 'APP_CONFIG_INVALID');
validateDatabaseGrants(crud.map(privilege => grant(privilege)), 'rds_app', target.database); checks++;
validateDatabaseGrants([grant('USAGE', '*.*'), grant([...crud, ...ddl].join(', '))], 'rds_migrator', target.database); checks++;
rejects(() => validateDatabaseGrants([grant(crud.join(', '), '`geekdash_k3s_verify_unit`.*')], 'rds_app', target.database), 'DB_GRANTS_INVALID');
validateDatabaseGrants([grant(crud.join(', '), '`geekdash_k3s_verify_unit`.*')], 'rds_app', target.database, true); checks++;
validateDatabaseGrants([grant(crud.join(', '), '`geekdash_dev`.*')], 'dev_app', 'geekdash_dev'); checks++;
for (const grants of [[], [grant('SELECT')], [grant(crud.join(', '), '*.*')], [grant('ALL PRIVILEGES')], [grant(crud.join(', ')) + ' WITH GRANT OPTION'], [grant([...crud, 'CREATE'].join(', '))], [grant(crud.join(', ')), grant('SELECT', '`other`.*')], [grant(crud.join(', ')), 'GRANT `privileged_role`@`%` TO `gd_rds_app`@`%`']])
  rejects(() => validateDatabaseGrants(grants, 'rds_app', target.database), 'DB_GRANTS_INVALID');

function fakeConnection(version = '8.0.45', identity = 'gd_rds_app@10.%', cipher = 'TLS_AES_256_GCM_SHA384') {
  return { async query({ sql }) {
    if (sql.startsWith('SET ')) return [[], []];
    if (sql.startsWith('SELECT DATABASE')) return [[{ db: target.database, identity, version, timezone: '+00:00' }], []];
    if (sql.startsWith('SHOW SESSION STATUS')) return [[{ Variable_name: 'Ssl_cipher', Value: cipher }], []];
    if (sql === 'SHOW GRANTS') return [crud.map(privilege => ({ grant: grant(privilege) })), []];
    assert.fail(`unexpected query: ${sql}`);
  } };
}
for (const version of ['8.0.16', '8.0.45', '8.4.8', '9.1.0']) { await validateDatabaseConnection(fakeConnection(version), 'rds_app', target); checks++; }
for (const version of ['5.7.44', '8.0.15', '10.11.9-MariaDB', 'invalid']) { await assert.rejects(() => validateDatabaseConnection(fakeConnection(version), 'rds_app', target), code('DB_IDENTITY_INVALID')); checks++; }
await assert.rejects(() => validateDatabaseConnection(fakeConnection('8.4.8', 'other@%'), 'rds_app', target), code('DB_IDENTITY_INVALID')); checks++;
await assert.rejects(() => validateDatabaseConnection(fakeConnection('8.4.8', 'gd_rds_app@%', ''), 'rds_app', target), code('DB_TLS_REQUIRED')); checks++;
assert.equal(parseInitialAdministrator(admin).isProjectManager, false); checks++;
rejects(() => parseInitialAdministrator({ ...admin, password: 'short' }), 'INVALID_PASSWORD');
rejects(() => parseInitialAdministrator({ ...admin, password: 'abcdefgh' }), 'INVALID_PASSWORD');
rejects(() => parseInitialAdministrator({ ...admin, loginName: 'Bad Name' }), 'INITIAL_ADMIN_INVALID');
rejects(() => parseInitialAdministrator({ ...admin, isProjectManager: 'false' }), 'INITIAL_ADMIN_INVALID');
rejects(() => parseInitialAdministrator({ ...admin, password_hash: 'unexpected' }), 'INITIAL_ADMIN_INVALID');
console.log(JSON.stringify({ status: 'verified', scope: 'configuration-and-permission-negative-cases', checks, actualMysqlTest: false }));

if (process.argv.includes('--empty-database')) {
  // 显式入口只允许全新隔离验证库；绝不清空用户库，也不接 dev/test 既有运行实例。
  const { connection: c, fact } = await connectDatabase('rds_migrator');
  try {
    assert.match(fact.database, /^geekdash_k3s_verify_[a-z0-9_]+$/);
    const [tables] = await c.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    assert.equal(tables.length, 0, '必须提供完全空白的隔离验证库');
    await migrateDatabase('rds_migrator');
    const sentinelHash = await hashPassword(admin.password);
    await c.execute('INSERT INTO users(login_name,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', ['verify_existing', sentinelHash, '非空保护验证']);
    await assert.rejects(() => initializeDatabase('rds_migrator', admin), code('INITIALIZE_DATABASE_NOT_EMPTY'));
    const [sentinel] = await c.query("SELECT login_name,password_hash FROM users WHERE login_name='verify_existing'");
    assert.equal(sentinel.length, 1); assert.equal(sentinel[0].password_hash, sentinelHash);
    await c.execute("DELETE FROM users WHERE login_name='verify_existing'");
    assert.equal((await initializeDatabase('rds_migrator', admin)).outcome, 'initialized');
    const [first] = await c.query('SELECT id,login_name,password_hash,must_change_password,is_admin,is_project_manager,registration_name FROM users');
    assert.equal(first.length, 1); assert.equal(first[0].must_change_password, 1); assert.equal(first[0].is_admin, 1); assert.equal(first[0].is_project_manager, 0); assert.equal(first[0].registration_name, null);
    assert.equal(await verifyPassword(admin.password, first[0].password_hash), true);
    assert.equal((await initializeDatabase('rds_migrator', { ...admin, password: 'Changed-password-84', name: '不应被写入' })).outcome, 'already_initialized');
    const { connection: fresh } = await connectDatabase('rds_app');
    try {
      const [again] = await fresh.query('SELECT login_name,password_hash,display_name FROM users');
      assert.equal(again.length, 1); assert.equal(again[0].password_hash, first[0].password_hash); assert.equal(again[0].display_name, admin.name);
      for (const table of ['system_configuration', 'check_rule_revisions', 'audit_log']) {
        const [count] = await fresh.query(`SELECT COUNT(*) count FROM ${table}`); assert.equal(Number(count[0].count), 1);
      }
      const [projects] = await fresh.query('SELECT COUNT(*) count FROM projects'); assert.equal(Number(projects[0].count), 0);
      await assert.rejects(() => fresh.query('CREATE TABLE forbidden_ddl(id int)'), error => error.code === 'ER_TABLEACCESS_DENIED_ERROR');
    } finally { await fresh.end(); }
    await verifyDatabase('rds_migrator');
    console.log(JSON.stringify({ status: 'verified', scope: 'actual-mysql-empty-database-initialize', serverVersion: fact.serverVersion, database: fact.database, checked: ['full-migration', 'existing-data-refusal', 'initial-admin-password-policy', 'repeated-initialization-preserves-password', 'fresh-app-connection-readback', 'app-ddl-denied'] }));
  } finally { await c.end(); }
} else if (process.argv.length > 2) throw new Error('仅支持 --empty-database；默认不连接数据库');
