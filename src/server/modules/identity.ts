import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { failure } from './project-save.js';
import { lockMembershipAccounts, lockMembershipProject, maintenanceAccount, invalidateMembershipRequests } from './project-membership.js';
import { canonical } from './personal-state.js';

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
export async function assertActor(c: PoolConnection, actor: Actor, allowChange = false, now = new Date(), exclusiveSession = false, locked = true) {
  const user = (await rows(c, `SELECT ${accountColumns} FROM users WHERE id=?${locked ? ' FOR SHARE' : ''}`, [actor.id]))[0];
  const session = (await rows(c, `SELECT * FROM sessions WHERE token_hash=? AND user_id=?${locked ? ' FOR ' + (exclusiveSession ? 'UPDATE' : 'SHARE') : ''}`, [actor.tokenHash, actor.id]))[0];
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
  async function requireMaintenance(c:PoolConnection,actor:Actor,lock=false) {
    await assertActor(c,actor,false,now(),false,lock);
    if(await maintenanceAccount(c,lock)!==actor.id)failure('MAINTENANCE_REQUIRED',403);
  }
  async function accountImpact(c:PoolConnection,id:string) {
    const user=(await rows(c,'SELECT CAST(id AS CHAR) id,login_name loginName,display_name name,enabled,CAST(version AS CHAR) version FROM users WHERE id=?',[id]))[0];
    if(!user)failure('ACCOUNT_NOT_FOUND',404);
    const owned=await rows(c,`SELECT CAST(p.id AS CHAR) id,p.name,CAST(p.version AS CHAR) version FROM projects p
      JOIN project_responsibilities r ON r.project_id=p.id WHERE r.user_id=? ORDER BY p.id`,[id]);
    const members=owned.length?await rows(c,`SELECT CAST(r.project_id AS CHAR) projectId,CAST(r.user_id AS CHAR) id,u.enabled FROM project_responsibilities r JOIN users u ON u.id=r.user_id WHERE r.project_id IN (?) ORDER BY r.project_id,r.user_id`,[owned.map(v=>v.id)]):[];
    const requests=await rows(c,`SELECT CAST(r.id AS CHAR) id,CAST(r.project_id AS CHAR) projectId,p.name projectName,r.kind,CAST(r.initiator_id AS CHAR) initiatorId,CAST(r.target_user_id AS CHAR) targetUserId
      FROM project_membership_requests r JOIN projects p ON p.id=r.project_id WHERE r.status='pending' AND (r.target_user_id=? OR (r.kind='invitation' AND r.initiator_id=?)) ORDER BY r.id`,[id,id]);
    const unhanded=owned.filter(p=>!members.some(m=>m.projectId===p.id&&m.id!==id&&m.enabled));
    const token=digest(canonical({user,owned,members,requests})).toString('hex');
    return {user,owned,members,requests,unhanded,token};
  }
  return {
    accountRole(actor:Actor) {
      return database.readSnapshot(async c=>({isMaintenance:(await rows(c,'SELECT maintenance_user_id FROM system_configuration WHERE maintenance_user_id=?',[actor.id])).length>0}));
    },
    accounts(actor:Actor) {
      return database.readSnapshot(async c=>{
        await requireMaintenance(c,actor);
        return {items:await rows(c,'SELECT CAST(id AS CHAR) id,login_name loginName,display_name name,enabled,CAST(version AS CHAR) version FROM users ORDER BY id'),maintenanceId:actor.id};
      });
    },
    accountImpact(actor:Actor,id:string) {
      return database.readSnapshot(async c=>{await requireMaintenance(c,actor);if(id===actor.id)failure('MAINTENANCE_ACCOUNT_PROTECTED',422);const value=await accountImpact(c,id);return {account:value.user,unhandedProjects:value.unhanded,affectedRequests:value.requests,impactToken:value.token};});
    },
    accountState(actor:Actor,id:string,body:{enabled:boolean;expectedVersion:string;impactToken:string;idempotencyKey:string},requestId:string,confirm=false) {
      const scope=`user:${actor.id}:account:${id}:state`,hash=digest(canonical(body));
      const lookup=async(c:PoolConnection,lock=false)=>{
        const prior=(await rows(c,`SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?${lock?' FOR UPDATE':''}`,[scope,body.idempotencyKey]))[0];
        if(!prior)return null;if(!prior.request_hash.equals(hash))failure('OPERATION_KEY_REUSED',409);
        return typeof prior.response_json==='string'?JSON.parse(prior.response_json):prior.response_json;
      };
      if(confirm)return database.readSnapshot(async c=>{await requireMaintenance(c,actor);const result=await lookup(c);return result?{outcome:'committed',result}:{outcome:'not_found'};});
      return database.writeTransaction(async c=>{
        const before=await accountImpact(c,id);
        const projectIds=[...new Set([...before.owned.map(p=>p.id),...before.requests.map(r=>r.projectId)])].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
        const related=projectIds.length?await rows(c,'SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id IN (?)',[projectIds]):[];
        const users=await lockMembershipAccounts(c,[actor.id,id,...related.map(v=>v.id)]);
        await requireMaintenance(c,actor,true);
        if(id===actor.id)failure('MAINTENANCE_ACCOUNT_PROTECTED',422);
        for(const projectId of projectIds)await lockMembershipProject(c,projectId,users);
        const prior=await lookup(c,true);if(prior)return {outcome:'committed',result:prior};
        const value=await accountImpact(c,id);
        if(value.user.version!==body.expectedVersion||value.token!==body.impactToken)failure('ACCOUNT_IMPACT_CHANGED',409);
        if(!body.enabled&&value.unhanded.length)failure('ACCOUNT_HANDOFF_REQUIRED',422);
        const changed=!!value.user.enabled!==body.enabled;
        if(changed) {
          if(value.user.version==='18446744073709551615')failure('ACCOUNT_VERSION_EXHAUSTED',422);
          await c.execute('UPDATE users SET enabled=?,version=version+1,updated_at=? WHERE id=?',[Number(body.enabled),now(),id]);
          await c.execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',[now(),id]);
          if(!body.enabled)await invalidateMembershipRequests(c,id,'account_disabled');
          await c.execute("INSERT INTO audit_log(actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,before_json,after_json,request_id,created_at) VALUES (?,?,'user','identity.account.state','user',?,?,?,?,?)",[actor.id,actor.name,id,JSON.stringify({enabled:!!value.user.enabled,version:value.user.version}),JSON.stringify({enabled:body.enabled,version:String(BigInt(value.user.version)+1n),invalidatedRequestIds:body.enabled?[]:value.requests.map(v=>v.id)}),requestId,now()]);
        }
        const result={accountId:id,enabled:body.enabled,version:String(BigInt(value.user.version)+(changed?1n:0n)),changed,operationId:body.idempotencyKey};
        await c.execute('INSERT INTO command_receipts(actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,?)',[actor.id,scope,body.idempotencyKey,hash,JSON.stringify(result),now()]);
        return {outcome:'committed',result};
      });
    },
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
