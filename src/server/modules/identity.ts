import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { failure } from './project-save.js';

export const digest = (value: string) => createHash('sha256').update(value).digest();
export type Actor = { id: string; name: string; version: string; mustChangePassword: boolean; tokenHash: Buffer; csrfHash: Buffer };
let computing = 0;
const waiting: { start: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
async function derive(password: string, salt: Buffer) {
  if (computing >= 2) await new Promise<void>((resolve, reject) => {
    if (waiting.length >= 4) return reject(Object.assign(new Error('AUTH_BUSY'), { code: 'AUTH_BUSY', status: 503 }));
    const entry = { start: () => { computing++; resolve(); }, timer: setTimeout(() => { waiting.splice(waiting.indexOf(entry), 1); reject(Object.assign(new Error('AUTH_BUSY'), { code: 'AUTH_BUSY', status: 503 })); }, 2000) };
    waiting.push(entry);
  });
  else computing++;
  try { return await new Promise<Buffer>((resolve, reject) => argon2('argon2id', { message: password, nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32 }, (error, key) => error ? reject(error) : resolve(key))); }
  finally { computing--; const next = waiting.shift(); if (next) { clearTimeout(next.timer); next.start(); } }
}
export function checkPassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length < 15 || [...value].length > 128) failure('INVALID_PASSWORD', 422);
}
export async function hashPassword(password: string) {
  checkPassword(password);
  const salt = randomBytes(16), key = await derive(password, salt);
  return `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString('base64').replace(/=+$/, '')}$${key.toString('base64').replace(/=+$/, '')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const match = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/.exec(hash);
  if (!match) throw Object.assign(new Error('PASSWORD_HASH_INVALID'), { code: 'PASSWORD_HASH_INVALID' });
  return timingSafeEqual(await derive(password, Buffer.from(match[1], 'base64')), Buffer.from(match[2], 'base64'));
}
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0]; }
const accountColumns = 'CAST(id AS CHAR) id,login_name loginName,display_name name,password_hash passwordHash,enabled,must_change_password mustChangePassword,CAST(version AS CHAR) version';
function sessionValid(row: RowDataPacket | undefined, now: Date) {
  const utc = (value: string | Date) => value instanceof Date ? value.getTime() : new Date(value.replace(' ', 'T') + 'Z').getTime();
  return row && !row.revoked_at && utc(row.absolute_expires_at) > now.getTime() && utc(row.last_seen_at) + 7 * 86400000 > now.getTime();
}
// 所有业务写入按账号→会话→资料→项目取锁；不信任入口检查后的旧身份。
export async function assertActor(c: PoolConnection, actor: Actor, allowChange = false, now = new Date(), exclusiveSession = false) {
  const user = (await rows(c, `SELECT ${accountColumns} FROM users WHERE id=? FOR SHARE`, [actor.id]))[0];
  const session = (await rows(c, `SELECT * FROM sessions WHERE token_hash=? AND user_id=? FOR ${exclusiveSession ? 'UPDATE' : 'SHARE'}`, [actor.tokenHash, actor.id]))[0];
  if (!user?.enabled || user.version !== actor.version || !sessionValid(session, now)) failure('AUTH_REQUIRED', 401);
  if (user.mustChangePassword && !allowChange) failure('PASSWORD_CHANGE_REQUIRED', 403);
  return user;
}
async function audit(c: PoolConnection, actor: { id: string; name: string }, action: string, requestId: string, before: unknown = null, after: unknown = null) {
  await c.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,before_json,after_json,request_id,created_at)
    VALUES (?,?,'user',?,'user',?,?,?,?,UTC_TIMESTAMP(3))`, [actor.id, actor.name, action, actor.id, JSON.stringify(before), JSON.stringify(after), requestId]);
}
export function identities(database: RuntimeDatabase, now = () => new Date()) {
  const dummy = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  return {
    async login(loginName: string, password: string, requestId: string, oldToken?: string) {
      const account = await database.readSnapshot(async c => (await rows(c, `SELECT ${accountColumns} FROM users WHERE login_name=?`, [loginName]))[0]);
      const valid = await verifyPassword(password, account?.passwordHash ?? dummy);
      if (!valid || !account?.enabled) failure('INVALID_CREDENTIALS', 401);
      const token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
      await database.writeTransaction(async c => {
        const current = (await rows(c, `SELECT ${accountColumns} FROM users WHERE id=? FOR UPDATE`, [account.id]))[0];
        if (!current?.enabled || current.version !== account.version || current.passwordHash !== account.passwordHash) failure('INVALID_CREDENTIALS', 401);
        if (oldToken) {
          const old = (await rows(c, 'SELECT * FROM sessions WHERE token_hash=? FOR UPDATE', [digest(oldToken)]))[0];
          if (sessionValid(old, now()) && String(old!.user_id) !== current.id) failure('AUTH_CONTEXT_CHANGED', 409);
          if (old && String(old.user_id) === current.id) await c.execute('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL', [now(), digest(oldToken)]);
        }
        const time = now();
        await c.execute('INSERT INTO sessions (user_id,token_hash,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES (?,?,?,?,?,?)', [current.id, digest(token), digest(csrf), time, time, new Date(time.getTime() + 30 * 86400000)]);
        await audit(c, current as Actor, 'identity.login', requestId);
      });
      return { token, csrf, accountId: account.id };
    },
    resolve(token: string, active = false) {
      return database.readSnapshot(async c => {
        const row = (await rows(c, `SELECT CAST(u.id AS CHAR) id,u.login_name loginName,u.display_name name,u.enabled,u.must_change_password mustChangePassword,CAST(u.version AS CHAR) version,s.csrf_hash,s.created_at,s.last_seen_at,s.absolute_expires_at,s.revoked_at
          FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`, [digest(token)]))[0];
        if (!row?.enabled || !sessionValid(row, now())) failure('AUTH_REQUIRED', 401);
        const actor: Actor = { id: row.id, name: row.name, version: row.version, mustChangePassword: !!row.mustChangePassword, tokenHash: digest(token), csrfHash: row.csrf_hash };
        return actor;
      }).then(async actor => {
        if (active) await database.writeTransaction(async c => { await assertActor(c, actor, true, now(), true); await c.execute('UPDATE sessions SET last_seen_at=GREATEST(last_seen_at,?) WHERE token_hash=?', [now(), actor.tokenHash]); });
        return actor;
      });
    },
    async changePassword(actor: Actor, currentPassword: string, newPassword: string, requestId: string) {
      checkPassword(newPassword);
      const current = await database.readSnapshot(async c => (await rows(c, `SELECT ${accountColumns} FROM users WHERE id=?`, [actor.id]))[0]);
      if (!current || !await verifyPassword(currentPassword, current.passwordHash)) failure('CURRENT_PASSWORD_INCORRECT', 422);
      if (currentPassword === newPassword) failure('PASSWORD_UNCHANGED', 422);
      const hash = await hashPassword(newPassword);
      await database.writeTransaction(async c => {
        const user = (await rows(c, `SELECT ${accountColumns} FROM users WHERE id=? FOR UPDATE`, [actor.id]))[0];
        await assertActor(c, actor, true, now(), true);
        if (user.passwordHash !== current.passwordHash) failure('AUTH_CONTEXT_CHANGED', 409);
        await c.execute('UPDATE users SET password_hash=?,must_change_password=0,version=version+1,updated_at=? WHERE id=?', [hash, now(), actor.id]);
        await c.execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', [now(), actor.id]);
        await audit(c, actor, 'identity.password.change', requestId, { mustChangePassword: !!user.mustChangePassword, version: user.version }, { mustChangePassword: false, version: String(BigInt(user.version) + 1n) });
      });
    },
    logout(actor: Actor, requestId: string) {
      return database.writeTransaction(async c => {
        await assertActor(c, actor, true, now(), true);
        const [updated] = await c.execute<import('mysql2/promise').ResultSetHeader>('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL', [now(), actor.tokenHash]);
        if (updated.affectedRows) await audit(c, actor, 'identity.logout', requestId);
      });
    },
  };
}
