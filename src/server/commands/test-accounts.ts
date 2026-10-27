import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { connectDatabase } from '../infrastructure/db.js';
import { hashPassword, verifyPassword } from '../modules/identity.js';
import type { RowDataPacket } from 'mysql2/promise';

// 仅受控测试开通；没有公开注册入口，重跑不能重置已有密码。
const [profile, file, environment] = process.argv.slice(2);
try {
  if (!['dev_migrator', 'test_migrator'].includes(profile) || !file || !environment) throw new Error('ACCOUNT_INIT_ARGUMENTS');
  const { connection } = await connectDatabase(profile as 'dev_migrator' | 'test_migrator');
  try {
    const names = ['business01', 'business02', 'business03', 'business04', 'maint01'];
    let record: { environment: string; database: string; operationId: string; accounts: { loginName: string; temporaryPassword?: string; passwordHash?: string }[] };
    const database = (await connection.query<RowDataPacket[]>('SELECT DATABASE() name'))[0][0].name;
    try { record = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      record = { environment, database, operationId: randomUUID(), accounts: await Promise.all(names.map(async loginName => { const temporaryPassword = randomBytes(24).toString('base64url'); return { loginName, temporaryPassword, passwordHash: await hashPassword(temporaryPassword) }; })) };
      await writeFile(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    }
    if (record.database !== database || record.environment !== environment || JSON.stringify(record.accounts.map(item => item.loginName)) !== JSON.stringify(names)) throw new Error('ACCOUNT_FILE_TARGET_MISMATCH');
    const prepared = await Promise.all(record.accounts.map(async item => ({ ...item, hash: item.passwordHash ?? await hashPassword(item.temporaryPassword!) })));
    if (prepared.some(item => !/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(item.hash))) throw new Error('ACCOUNT_FILE_HASH_INVALID');
    const [lock] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK('geekdash.test-accounts',3) acquired");
    if (Number(lock[0].acquired) !== 1) throw new Error('ACCOUNT_INIT_BUSY');
    try {
      // 校验既有临时凭据在事务外计算；锁持有仅供受控初始化，不给应用密码计算持行锁。
      const [existing] = await connection.query<RowDataPacket[]>('SELECT id,login_name,password_hash,must_change_password FROM users WHERE login_name IN (?,?,?,?,?)', names);
      for (const row of existing) {
        const [audit] = await connection.query<RowDataPacket[]>("SELECT id FROM audit_log WHERE actor_kind='system' AND action='identity.test.initialize' AND entity_id=? AND request_id=?", [row.id, record.operationId]);
        const item = prepared.find(item => item.loginName === row.login_name)!;
        if (audit.length !== 1 || row.must_change_password && (item.temporaryPassword ? !await verifyPassword(item.temporaryPassword, row.password_hash) : item.hash !== row.password_hash)) throw new Error('ACCOUNT_INIT_EXISTING_MISMATCH');
      }
      await connection.beginTransaction();
      for (const item of prepared) if (!existing.some(row => row.login_name === item.loginName)) {
        await connection.execute('INSERT INTO users (login_name,password_hash,display_name,created_at,updated_at) VALUES (?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [item.loginName, item.hash, item.loginName]);
        const [id] = await connection.query<RowDataPacket[]>('SELECT CAST(LAST_INSERT_ID() AS CHAR) id');
        await connection.execute("INSERT INTO audit_log (actor_kind,actor_display_name,action,entity_type,entity_id,before_json,after_json,request_id,created_at) VALUES ('system','受控测试初始化','identity.test.initialize','user',?,'null',?,?,UTC_TIMESTAMP(3))", [id[0].id, JSON.stringify({ loginName: item.loginName, mustChangePassword: true }), record.operationId]);
      }
      const [maintenance] = await connection.query<RowDataPacket[]>("SELECT CAST(id AS CHAR) id FROM users WHERE login_name='maint01'");
      const [config] = await connection.query<RowDataPacket[]>('SELECT maintenance_user_id FROM system_configuration WHERE id=1 FOR UPDATE');
      if (config.length && String(config[0].maintenance_user_id) !== maintenance[0].id) throw new Error('MAINTENANCE_TARGET_MISMATCH');
      if (!config.length) await connection.execute("INSERT INTO system_configuration (id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))", [maintenance[0].id, maintenance[0].id]);
      await connection.execute('UPDATE users SET is_admin=1 WHERE id=?',[maintenance[0].id]);
      await connection.commit();
      console.log(JSON.stringify({ status: 'verified', environment, database, accounts: names, credentials: 'controlled_file', existingAccounts: existing.length }));
    } catch (error) { await connection.rollback(); throw error; }
    finally { await connection.query("SELECT RELEASE_LOCK('geekdash.test-accounts')"); }
  } finally { await connection.end(); }
} catch (error) { console.error(JSON.stringify({ status: 'failed', code: (error as { code?: string }).code ?? (error as Error).message })); process.exitCode = 1; }
