import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { connectDatabase } from '../infrastructure/db.js';
import { migrateDatabase, verifyDatabase } from '../infrastructure/schema.js';
import { checkPassword, hashPassword } from '../modules/identity.js';

const action = 'identity.deployment.initialize', requestId = 'geekdash-initialize-v1';
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
type InitialAdministrator = { loginName: string; name: string; password: string; isProjectManager: boolean };

export function parseInitialAdministrator(value: unknown): InitialAdministrator {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INITIAL_ADMIN_INVALID');
  const account = value as Record<string, unknown>;
  if (Object.keys(account).some(key => !['loginName', 'name', 'password', 'isProjectManager'].includes(key))
      || typeof account.loginName !== 'string' || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(account.loginName)
      || typeof account.name !== 'string' || !account.name.trim() || !account.name.isWellFormed()
      || [...account.name].length > 128 || /[\r\n]/.test(account.name)
      || account.isProjectManager !== undefined && typeof account.isProjectManager !== 'boolean') fail('INITIAL_ADMIN_INVALID');
  checkPassword(account.password);
  return { loginName: account.loginName, name: account.name, password: account.password, isProjectManager: account.isProjectManager === true };
}

async function rows(c: Connection, sql: string, values: unknown[] = []) {
  return (await c.query<RowDataPacket[]>({ sql, timeout: 10000 }, values))[0];
}
async function assertEmpty(c: Connection) {
  const tables = await rows(c, 'SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
  for (const { name } of tables) {
    if (name === 'schema_migrations') continue;
    if ((await rows(c, `SELECT 1 FROM \`${String(name).replaceAll('`', '``')}\` LIMIT 1`)).length) fail('INITIALIZE_DATABASE_NOT_EMPTY');
  }
  return tables;
}

export async function initializeDatabase(profile: 'rds_migrator' | 'test_migrator', account: InitialAdministrator) {
  if (!['rds_migrator', 'test_migrator'].includes(profile)) fail('INITIALIZE_PROFILE_INVALID');
  const prepared = parseInitialAdministrator(account);
  const { connection: c, fact } = await connectDatabase(profile);
  const lockDatabase = profile.startsWith('rds_') ? createHash('sha256').update(fact.database).digest('hex').slice(0, 32) : fact.database;
  const lockName = `geekdash:${lockDatabase}:initialize`;
  let locked = false;
  try {
    const [lock] = await rows(c, 'SELECT GET_LOCK(?, 10) acquired', [lockName]);
    if (Number(lock.acquired) !== 1) fail('INITIALIZE_BUSY');
    locked = true;
    const tables = await rows(c, 'SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    if (tables.some(table => table.name === 'audit_log')) {
      const prior = await rows(c, 'SELECT id FROM audit_log WHERE action=? AND request_id=?', [action, requestId]);
      if (prior.length) {
        await verifyDatabase(profile);
        return { outcome: 'already_initialized', database: fact.database, changed: false };
      }
    }
    // 首次部署只接续合法空结构；已有数据必须走正常维护，初始化绝不是找回密码入口。
    await assertEmpty(c);
    await migrateDatabase(profile);
    const passwordHash = await hashPassword(prepared.password);
    await c.beginTransaction();
    await assertEmpty(c);
    await c.execute('INSERT INTO users(login_name,password_hash,display_name,enabled,must_change_password,is_admin,is_project_manager,created_at,updated_at) VALUES (?,?,?,1,1,1,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
      [prepared.loginName, passwordHash, prepared.name, prepared.isProjectManager ? 1 : 0]);
    const [user] = await rows(c, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id');
    await c.execute("INSERT INTO system_configuration(id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))", [user.id, user.id]);
    await c.execute("INSERT INTO check_rule_revisions(deadline_weekday,effective_week,saved_at,saved_by,frequency) VALUES (5,DATE_SUB(DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR),INTERVAL WEEKDAY(DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR)) DAY),UTC_TIMESTAMP(3),?,'weekly')", [user.id]);
    await c.execute("INSERT INTO audit_log(actor_kind,actor_display_name,action,entity_type,entity_id,before_json,after_json,request_id,created_at) VALUES ('system','部署初始化',?,'user',?,'null',?,?,UTC_TIMESTAMP(3))",
      [action, user.id, JSON.stringify({ loginName: prepared.loginName, mustChangePassword: true, isProjectManager: prepared.isProjectManager }), requestId]);
    await c.commit();
    return { outcome: 'initialized', database: fact.database, changed: true };
  } catch (error) {
    try { await c.rollback(); } catch { /* 连接失效时由下一次运行读取提交标记，不重设口令。 */ }
    throw error;
  } finally {
    try { if (locked) await rows(c, 'SELECT RELEASE_LOCK(?)', [lockName]); }
    finally { await c.end(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [profile, file] = process.argv.slice(2);
    if (!['rds_migrator', 'test_migrator'].includes(profile) || !file || !isAbsolute(file) || process.argv.length !== 4) fail('INITIALIZE_ARGUMENTS_INVALID');
    let value: unknown;
    try { value = JSON.parse(await readFile(file, 'utf8')); } catch { fail('INITIAL_ADMIN_FILE_INVALID'); }
    const result = await initializeDatabase(profile as 'rds_migrator' | 'test_migrator', parseInitialAdministrator(value));
    console.log(JSON.stringify({ status: 'verified', ...result }));
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: (error as { code?: string }).code ?? 'INITIALIZE_FAILED' }));
    process.exitCode = 1;
  }
}
