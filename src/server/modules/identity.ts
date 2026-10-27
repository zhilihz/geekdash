import { validPassword } from './password-policy.js';
import { argon2, createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { failure, validId } from './project-save.js';
import { lockMembershipAccounts, lockMembershipProject, invalidateMembershipRequests, suggestedProjects } from './project-membership.js';
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
  if (!validPassword(value)) failure('INVALID_PASSWORD', 422);
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
export async function isAdministrator(c: PoolConnection, id: string) { return !!(await rows(c,'SELECT id FROM users WHERE id=? AND enabled=1 AND is_admin=1',[id])).length; }
const accountColumns = 'CAST(id AS CHAR) id,login_name loginName,display_name name,password_hash passwordHash,enabled,must_change_password mustChangePassword,is_project_manager isProjectManager,CAST(version AS CHAR) version';
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
export function newInviteCode() {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for(;;){const value=Array.from({length:10},()=>alphabet[randomInt(alphabet.length)]).join('');if(/[A-Z]/.test(value)&&/[a-z]/.test(value)&&/[0-9]/.test(value))return value;}
}
export function identities(database: RuntimeDatabase, now = () => new Date()) {
  const dummy = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  async function requireMaintenance(c:PoolConnection,actor:Actor,lock=false) {
    await assertActor(c,actor,false,now(),false,lock);
    if(!await isAdministrator(c,actor.id))failure('MAINTENANCE_REQUIRED',403);
  }
  async function accountImpact(c:PoolConnection,id:string) {
    const user=(await rows(c,'SELECT CAST(id AS CHAR) id,login_name loginName,display_name name,enabled,is_admin isAdmin,deleted_at deletedAt,CAST(version AS CHAR) version FROM users WHERE id=?',[id]))[0];
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
    profile(actor: Actor) {
      return database.readSnapshot(async c => {
        await assertActor(c,actor,false,now(),false,false);
        return (await rows(c,'SELECT CAST(id AS CHAR) id,login_name loginName,display_name name,CAST(version AS CHAR) version FROM users WHERE id=?',[actor.id]))[0];
      });
    },
    profileSave(actor: Actor, body: { name: string; expectedVersion: string; idempotencyKey: string }, _requestId: string, confirm = false) {
      if (!body || Object.keys(body).length !== 3 || typeof body.name !== 'string' || !body.name.isWellFormed() || !body.name.trim() || [...body.name].length > 128 || /[\r\n]/.test(body.name) || !validId(body.expectedVersion) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)) failure('INVALID_PROFILE',422,{fields:{name:'姓名应为1～128个字符，不能只含空白或换行'}});
      const scope='user:'+actor.id+':profile', hash=digest(canonical(body));
      return (confirm ? database.readSnapshot : database.writeTransaction)(async c => {
        if (!confirm) await rows(c,'SELECT id FROM users WHERE id=? FOR UPDATE',[actor.id]);
        await assertActor(c,actor,false,now(),false,!confirm);
        const prior=(await rows(c,`SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?${confirm?'':' FOR UPDATE'}`,[scope,body.idempotencyKey]))[0];
        if (prior) {
          if (!prior.request_hash.equals(hash)) failure('OPERATION_KEY_REUSED',409);
          return {outcome:'committed',result:typeof prior.response_json==='string'?JSON.parse(prior.response_json):prior.response_json};
        }
        if (confirm) return {outcome:'not_found'};
        failure('USERNAME_ADMIN_ONLY',403);

      });
    },
    accountRole(actor:Actor) {
      return database.readSnapshot(async c=>{const user=await assertActor(c,actor,true,now(),false,false);return {loginName:user.loginName,isMaintenance:await isAdministrator(c,actor.id),isProjectManager:!!user.isProjectManager,suggestedProjectCount:(await suggestedProjects(c,actor.id)).length};});
    },
    accounts(actor:Actor) {
      return database.readSnapshot(async c=>{
        await requireMaintenance(c,actor);
        return {items:await rows(c,'SELECT CAST(id AS CHAR) id,login_name loginName,display_name name,enabled,is_admin isAdmin,is_project_manager isProjectManager,CAST(version AS CHAR) version FROM users WHERE deleted_at IS NULL ORDER BY id'),maintenanceId:actor.id};
      });
    },
    accountEdit(actor:Actor,id:string,body:{loginName:string;name:string;isProjectManager:boolean;expectedVersion:string;idempotencyKey:string},requestId:string,confirm=false) {
      if(!body.name.trim()||!body.name.isWellFormed()||/[\r\n]/.test(body.name))failure('INVALID_PROFILE',422);
      const scope=`user:${actor.id}:account:${id}:edit`,hash=digest(canonical(body));
      return (confirm?database.readSnapshot:database.writeTransaction)(async c=>{
        if(!confirm)await lockMembershipAccounts(c,[actor.id,id]);
        await requireMaintenance(c,actor,!confirm);
        const prior=(await rows(c,`SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?${confirm?'':' FOR UPDATE'}`,[scope,body.idempotencyKey]))[0];
        if(prior){if(!prior.request_hash.equals(hash))failure('OPERATION_KEY_REUSED',409);return {outcome:'committed',result:typeof prior.response_json==='string'?JSON.parse(prior.response_json):prior.response_json};}
        if(confirm)return {outcome:'not_found'};
        const user=(await rows(c,'SELECT CAST(id AS CHAR) id,login_name loginName,display_name name,is_admin isAdmin,is_project_manager isProjectManager,deleted_at deletedAt,CAST(version AS CHAR) version FROM users WHERE id=?',[id]))[0];
        if(!user||user.deletedAt)failure('ACCOUNT_NOT_FOUND',404);
        if(user.version!==body.expectedVersion)failure('ACCOUNT_VERSION_CONFLICT',409);
        if(!user.isAdmin&&!body.isProjectManager)failure('BUSINESS_ROLE_REQUIRED',422);
        if(user.isProjectManager&&!body.isProjectManager){const owned=await rows(c,'SELECT CAST(p.id AS CHAR) id,p.name FROM projects p JOIN project_responsibilities r ON r.project_id=p.id WHERE r.user_id=?',[id]);if(owned.length)failure('PROJECT_MEMBERSHIP_REMAINS',422,{fields:{isProjectManager:'请先退出负责的项目：'+owned.map(p=>p.name).join('、')}});}
        const changed=user.loginName!==body.loginName||user.name!==body.name||!!user.isProjectManager!==body.isProjectManager;
        if(changed){
          if(user.version==='18446744073709551615')failure('ACCOUNT_VERSION_EXHAUSTED',422);
          try{await c.execute('UPDATE users SET login_name=?,display_name=?,is_project_manager=?,version=version+1,updated_at=? WHERE id=?',[body.loginName,body.name,body.isProjectManager?1:0,now(),id]);}catch(error){if((error as {code?:string}).code==='ER_DUP_ENTRY')failure('LOGIN_NAME_EXISTS',409);throw error;}
          if(!body.isProjectManager)await invalidateMembershipRequests(c,id,'account_disabled');
          await audit(c,actor,'identity.account.edit',requestId,{id,loginName:user.loginName,name:user.name,isProjectManager:!!user.isProjectManager},{id,loginName:body.loginName,name:body.name,isProjectManager:body.isProjectManager});
        }
        const result={accountId:id,name:body.name,savedVersion:String(BigInt(user.version)+(changed?1n:0n)),changed,operationId:body.idempotencyKey};
        await c.execute('INSERT INTO command_receipts(actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,UTC_TIMESTAMP(3))',[actor.id,scope,body.idempotencyKey,hash,JSON.stringify(result)]);
        return {outcome:'committed',result};
      });
    },
    accountImpact(actor:Actor,id:string) {
      return database.readSnapshot(async c=>{await requireMaintenance(c,actor);if(id===actor.id)failure('MAINTENANCE_ACCOUNT_PROTECTED',422);const value=await accountImpact(c,id);return {account:value.user,unhandedProjects:value.unhanded,affectedRequests:value.requests,impactToken:value.token};});
    },
    accountState(actor:Actor,id:string,body:{enabled:boolean;deleted?:boolean;expectedVersion:string;impactToken:string;idempotencyKey:string},requestId:string,confirm=false) {
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
        if(value.user.deletedAt)failure('ACCOUNT_DELETED',409);
        if(body.deleted&&body.enabled)failure('INVALID_REQUEST',422);
        if(value.user.version!==body.expectedVersion||value.token!==body.impactToken)failure('ACCOUNT_IMPACT_CHANGED',409);
        if(!body.enabled&&value.user.isAdmin){await rows(c,'SELECT id FROM system_configuration WHERE id=1 FOR UPDATE');const administrators=await rows(c,'SELECT id FROM users WHERE enabled=1 AND is_admin=1');if(administrators.length<=1)failure('LAST_ADMIN_REQUIRED',422);}
        if(!body.enabled&&value.unhanded.length)failure('ACCOUNT_HANDOFF_REQUIRED',422);
        const changed=!!value.user.enabled!==body.enabled||!!body.deleted;
        if(changed) {
          if(value.user.version==='18446744073709551615')failure('ACCOUNT_VERSION_EXHAUSTED',422);
          await c.execute('UPDATE users SET enabled=?,deleted_at=?,version=version+1,updated_at=? WHERE id=?',[Number(body.enabled),body.deleted?now():null,now(),id]);
          await c.execute('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL',[now(),id]);
          if(!body.enabled)await invalidateMembershipRequests(c,id,'account_disabled');
          await c.execute("INSERT INTO audit_log(actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,before_json,after_json,request_id,created_at) VALUES (?,?,'user','identity.account.state','user',?,?,?,?,?)",[actor.id,actor.name,id,JSON.stringify({enabled:!!value.user.enabled,version:value.user.version}),JSON.stringify({enabled:body.enabled,deleted:!!body.deleted,version:String(BigInt(value.user.version)+1n),invalidatedRequestIds:body.enabled?[]:value.requests.map(v=>v.id)}),requestId,now()]);
        }
        const result={accountId:id,enabled:body.enabled,deleted:!!body.deleted,version:String(BigInt(value.user.version)+(changed?1n:0n)),changed,operationId:body.idempotencyKey};
        await c.execute('INSERT INTO command_receipts(actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,?)',[actor.id,scope,body.idempotencyKey,hash,JSON.stringify(result),now()]);
        return {outcome:'committed',result};
      });
    },
    invites(actor: Actor) {
      return database.readSnapshot(async c=>{await requireMaintenance(c,actor);return {items:await rows(c,`SELECT CAST(i.id AS CHAR) id,i.role,i.code_value code,DATE_FORMAT(i.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,DATE_FORMAT(i.expires_at,'%Y-%m-%dT%H:%i:%s.%fZ') expiresAt,i.revoked_at IS NOT NULL revoked,(SELECT COUNT(*) FROM users u WHERE u.registration_invite_id=i.id) registrations FROM registration_invites i ORDER BY i.id DESC`)};});
    },
    async createInvite(actor: Actor, role: 'business'|'admin', idempotencyKey: string, requestId: string) {
      let code=newInviteCode();const scope=`user:${actor.id}:invites:create`, hash=digest(role);
      const result=await database.writeTransaction(async c=>{
        await rows(c,'SELECT id FROM users WHERE id=? FOR UPDATE',[actor.id]);await requireMaintenance(c,actor,true);
        const prior=(await rows(c,'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=? FOR UPDATE',[scope,idempotencyKey]))[0];
        if(prior){if(!prior.request_hash.equals(hash))failure('OPERATION_KEY_REUSED',409);const saved=typeof prior.response_json==='string'?JSON.parse(prior.response_json):prior.response_json;const original=(await rows(c,'SELECT code_value code FROM registration_invites WHERE id=?',[saved.id]))[0];return {...saved,code:original?.code,replayed:true};}
        const expiresAt=new Date(now().getTime()+7*86400000);
        for(let attempt=0;;attempt++)try{await c.execute('INSERT INTO registration_invites(code_hash,role,created_by,created_at,expires_at,code_value) VALUES (?,?,?,?,?,?)',[digest(code),role,actor.id,now(),expiresAt,code]);break;}catch(error){if((error as {code?:string}).code!=='ER_DUP_ENTRY'||attempt===4)throw error;code=newInviteCode();}
        const id=(await rows(c,'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
        const receipt={id,role,expiresAt:expiresAt.toISOString()};
        await audit(c,actor,'identity.invite.create',requestId,null,{inviteId:id,role,expiresAt:receipt.expiresAt});
        await c.execute('INSERT INTO command_receipts(actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,?)',[actor.id,scope,idempotencyKey,hash,JSON.stringify(receipt),now()]);
        return {...receipt,replayed:false};
      });
      return {...result,...result.replayed?{}:{code}};
    },
    revokeInvite(actor: Actor, id: string, requestId: string) {
      return database.writeTransaction(async c=>{
        await requireMaintenance(c,actor,true);
        const invite=(await rows(c,'SELECT id,revoked_at FROM registration_invites WHERE id=? FOR UPDATE',[id]))[0];if(!invite)failure('INVITE_NOT_FOUND',404);
        if(!invite.revoked_at){await c.execute('UPDATE registration_invites SET revoked_at=? WHERE id=?',[now(),id]);await audit(c,actor,'identity.invite.revoke',requestId,null,{inviteId:id});}
        return {id,revoked:true};
      });
    },
    async register(body:{loginName:string;name:string;password:string;inviteCode:string},requestId:string,oldToken?:string) {
      checkPassword(body.password);
      if(!body.name.trim()||!body.name.isWellFormed()||/[\r\n]/.test(body.name))failure('INVALID_PROFILE',422);
      const passwordHash=await hashPassword(body.password),token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
      try{return await database.writeTransaction(async c=>{
        if(oldToken){const old=(await rows(c,'SELECT * FROM sessions WHERE token_hash=? FOR UPDATE',[digest(oldToken)]))[0];if(sessionValid(old,now()))failure('AUTH_CONTEXT_CHANGED',409);}
        const invite=(await rows(c,'SELECT CAST(id AS CHAR) id,role,expires_at> ? valid,revoked_at FROM registration_invites WHERE code_hash=? FOR UPDATE',[now(),digest(body.inviteCode)]))[0];
        if(!invite||!Number(invite.valid)||invite.revoked_at)failure('INVITE_UNAVAILABLE',422);
        if(!['business','admin'].includes(invite.role))failure('INVITE_UNAVAILABLE',422);
        await c.execute('INSERT INTO users(login_name,password_hash,display_name,registration_name,is_admin,is_project_manager,registration_invite_id,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)',[body.loginName,passwordHash,body.name,body.name,invite.role==='admin'?1:0,invite.role==='business'?1:0,invite.id,now(),now()]);
        const id=(await rows(c,'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
        await audit(c,{id,name:body.name},'identity.register',requestId,null,{loginName:body.loginName,role:invite.role,inviteId:invite.id});
        const time=now();await c.execute('INSERT INTO sessions(user_id,token_hash,csrf_hash,created_at,last_seen_at,absolute_expires_at) VALUES (?,?,?,?,?,?)',[id,digest(token),digest(csrf),time,time,new Date(time.getTime()+30*86400000)]);
        return {status:'authenticated',accountId:id,token,csrf};
      });}catch(error){if((error as {code?:string}).code==='ER_DUP_ENTRY')failure('LOGIN_NAME_EXISTS',409);throw error;}
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
