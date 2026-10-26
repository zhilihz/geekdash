import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { failure, validId } from './project-save.js';
import { canonical } from './personal-state.js';

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
type Command = { action: 'claim' | 'apply' | 'invite' | 'accept' | 'reject' | 'withdraw' | 'leave'; idempotencyKey: string; targetUserId?: string; requestId?: string; expectedVersion?: string };
export const membershipRows = async (c: PoolConnection, sql: string, values: unknown[] = []) => (await c.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0];
const rows = membershipRows;
export async function hasProjectAccess(c:PoolConnection,projectId:string,accountId:string) {
  return !!(await rows(c,'SELECT r.project_id FROM project_responsibilities r JOIN users u ON u.id=r.user_id WHERE r.project_id=? AND r.user_id=? AND u.enabled=1 AND NOT EXISTS(SELECT 1 FROM system_configuration s WHERE s.maintenance_user_id=u.id)',[projectId,accountId])).length;
}
export async function assertProjectAccess(c:PoolConnection,projectId:string,accountId:string) {
  if(!await hasProjectAccess(c,projectId,accountId))failure('PROJECT_ACCESS_REQUIRED',403);
}
// 原操作仍能确认成功；退出后只返回提交事实，不再返回正式业务快照。
export async function visibleProjectReceipt<T extends {projectId:string;operationId:string;savedVersion:string;changed?:boolean;baseVersion?:string;savedAt?:string|null}>(c:PoolConnection,accountId:string,result:T) {
  if(await hasProjectAccess(c,result.projectId,accountId))return result;
  return {projectId:result.projectId,operationId:result.operationId,savedVersion:result.savedVersion,baseVersion:result.baseVersion,changed:result.changed ?? false,savedAt:result.savedAt ?? null,values:{},accessLost:true};
}

export function validateMembership(value: unknown): Command {
  const body = value as Command;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !['claim','apply','invite','accept','reject','withdraw','leave'].includes(body.action) || !uuid(body.idempotencyKey)) failure('INVALID_MEMBERSHIP_COMMAND',400);
  const field = body.action === 'invite' ? 'targetUserId' : ['accept','reject','withdraw'].includes(body.action) ? 'requestId' : body.action === 'leave' ? 'expectedVersion' : null;
  const keys = ['action','idempotencyKey', ...(field ? [field] : [])];
  if (Object.keys(body).length !== keys.length || Object.keys(body).some(key => !keys.includes(key)) || field && !validId(body[field as keyof Command])) failure('INVALID_MEMBERSHIP_COMMAND',400);
  return body;
}

// 与账号启停共用锁顺序；新增成员在项目锁内重核，不反向补账号锁。
export async function lockMembershipAccounts(c: PoolConnection, ids: string[]) {
  const users = new Map<string, RowDataPacket>();
  for (const id of [...new Set(ids)].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1)) {
    const user = (await rows(c,'SELECT CAST(id AS CHAR) id,display_name name,enabled,CAST(version AS CHAR) version FROM users WHERE id=? FOR UPDATE',[id]))[0];
    if (user) users.set(id,user);
  }
  return users;
}
export async function maintenanceAccount(c: PoolConnection, lock = true) {
  const config = (await rows(c,`SELECT CAST(maintenance_user_id AS CHAR) id FROM system_configuration WHERE id=1${lock ? ' FOR SHARE' : ''}`))[0];
  if (!config?.id) failure('SYSTEM_CONFIGURATION_REQUIRED',422);
  return config.id as string;
}
export async function assertBusinessActor(c: PoolConnection, actor: Actor) {
  await assertActor(c,actor);
  if (await maintenanceAccount(c) === actor.id) failure('BUSINESS_ACCOUNT_REQUIRED',403);
}
export async function lockMembershipProject(c: PoolConnection, projectId: string, users: Map<string,RowDataPacket>) {
  const project = (await rows(c,'SELECT CAST(id AS CHAR) id,CAST(version AS CHAR) version FROM projects WHERE id=? FOR UPDATE',[projectId]))[0];
  if (!project) failure('PROJECT_NOT_FOUND',404);
  const members = await rows(c,'SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=?',[projectId]);
  if (members.some(member => !users.has(member.id))) failure('MEMBERSHIP_CHANGED',409);
  return { ...project, members: members.map(member => users.get(member.id)!) } as { id:string;version:string;members:RowDataPacket[] };
}
export async function invalidateMembershipRequests(c: PoolConnection, userId: string, reason: 'account_disabled' | 'inviter_left', projectId?: string) {
  const where = reason === 'account_disabled' ? "(target_user_id=? OR (kind='invitation' AND initiator_id=?))" : "kind='invitation' AND initiator_id=? AND project_id=?";
  const values = reason === 'account_disabled' ? [userId,userId] : [userId,projectId];
  await c.query(`UPDATE project_membership_requests SET status='invalidated',resolved_at=UTC_TIMESTAMP(3),resolved_by=NULL,resolution_code=? WHERE status='pending' AND ${where}`, [reason,...values]);
}
export async function inviteCollaborator(c: PoolConnection, projectId:string, actor:Actor, target:string, explicit=true) {
  if ((await rows(c,'SELECT user_id FROM project_responsibilities WHERE project_id=? AND user_id=?',[projectId,target])).length) return { status:'member',requestId:null,created:false };
  const previous=(await rows(c,`SELECT CAST(id AS CHAR) id,status FROM project_membership_requests WHERE project_id=? AND target_user_id=?${explicit ? " AND status='pending'" : ''} ORDER BY id DESC LIMIT 1 FOR UPDATE`,[projectId,target]))[0];
  if(previous)return {status:previous.status as string,requestId:previous.id as string,created:false};
  await c.execute("INSERT INTO project_membership_requests(project_id,kind,initiator_id,target_user_id,status,created_at) VALUES (?,'invitation',?,?,'pending',UTC_TIMESTAMP(3))",[projectId,actor.id,target]);
  return {status:'pending',requestId:(await rows(c,'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id as string,created:true};
}

export function projectMembership(database:RuntimeDatabase) {
  async function run(actor:Actor, projectId:string, body:Command, requestId:string, confirm=false) {
    const scope=`user:${actor.id}:project:${projectId}:membership`, hash=createHash('sha256').update(canonical(body)).digest();
    const lookup=async(c:PoolConnection,lock=false)=>{
      const prior=(await rows(c,`SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?${lock?' FOR UPDATE':''}`,[scope,body.idempotencyKey]))[0];
      if(!prior)return null;if(!prior.request_hash.equals(hash))failure('OPERATION_KEY_REUSED',409);
      return typeof prior.response_json==='string'?JSON.parse(prior.response_json):prior.response_json;
    };
    if(confirm)return database.readSnapshot(async c=>{await assertActor(c,actor,false,new Date(),false,false);const result=await lookup(c);return result?{outcome:'committed',result}:{outcome:'not_found'};});
    return database.writeTransaction(async c=>{
      const initial=body.requestId?(await rows(c,'SELECT CAST(initiator_id AS CHAR) initiator,CAST(target_user_id AS CHAR) target FROM project_membership_requests WHERE id=? AND project_id=?',[body.requestId,projectId]))[0]:undefined;
      const members=await rows(c,'SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=?',[projectId]);
      const users=await lockMembershipAccounts(c,[actor.id,...members.map(v=>v.id),...(body.targetUserId?[body.targetUserId]:[]),...(initial?[initial.initiator,initial.target]:[])]);
      await assertBusinessActor(c,actor);
      const maintenance=await maintenanceAccount(c);
      let project:Awaited<ReturnType<typeof lockMembershipProject>>;
      try { project=await lockMembershipProject(c,projectId,users); }
      catch(error) {
        if(body.action==='claim'&&(error as {code?:string}).code==='MEMBERSHIP_CHANGED'&&(await rows(c,'SELECT r.user_id FROM project_responsibilities r JOIN users u ON u.id=r.user_id WHERE r.project_id=? AND u.enabled=1',[projectId])).length)failure('PROJECT_ALREADY_OWNED',409);
        throw error;
      }
      const prior=await lookup(c,true);if(prior)return {outcome:'committed',result:prior};
      const member=project.members.some(v=>v.id===actor.id), enabled=project.members.filter(v=>v.enabled);
      let status:string='member', request:string|null=null, changed=false, requestChanged=false, target=actor.id;
      if(body.action==='claim'||body.action==='apply') {
        if(!member) {
          if(body.action==='claim') {
            if(enabled.length)failure('PROJECT_ALREADY_OWNED',409);
            await c.execute('INSERT INTO project_responsibilities(project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))',[projectId,actor.id]);changed=true;
          } else {
            if(!enabled.length)failure('PROJECT_UNOWNED',409);
            const pending=(await rows(c,"SELECT CAST(id AS CHAR) id FROM project_membership_requests WHERE project_id=? AND target_user_id=? AND status='pending' FOR UPDATE",[projectId,actor.id]))[0];
            if(pending)request=pending.id;
            else {await c.execute("INSERT INTO project_membership_requests(project_id,kind,initiator_id,target_user_id,status,created_at) VALUES (?,'application',?,?,'pending',UTC_TIMESTAMP(3))",[projectId,actor.id,actor.id]);request=(await rows(c,'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;requestChanged=true;}
            status='pending';
          }
        }
      } else if(body.action==='invite') {
        if(!member)failure('PROJECT_READ_ONLY',403);
        target=body.targetUserId!;
        if(!users.get(target)?.enabled||target===maintenance)failure('INVITEE_UNAVAILABLE',422);
        const invited=await inviteCollaborator(c,projectId,actor,target);status=invited.status;request=invited.requestId;requestChanged=invited.created;
      } else if(body.action==='leave') {
        if(project.version!==body.expectedVersion)failure('PROJECT_VERSION_CONFLICT',409,{currentVersion:project.version});
        if(member) {
          if(!enabled.some(v=>v.id!==actor.id))failure('LAST_RESPONSIBLE',422);
          await c.execute('DELETE FROM project_responsibilities WHERE project_id=? AND user_id=?',[projectId,actor.id]);
          await invalidateMembershipRequests(c,actor.id,'inviter_left',projectId);changed=true;
        }
        status='left';
      } else {
        const item=(await rows(c,'SELECT CAST(id AS CHAR) id,kind,CAST(initiator_id AS CHAR) initiator,CAST(target_user_id AS CHAR) target,status FROM project_membership_requests WHERE id=? AND project_id=? FOR UPDATE',[body.requestId,projectId]))[0];
        if(!item)failure('MEMBERSHIP_REQUEST_NOT_FOUND',404);
        request=item.id;target=item.target;
        const allowed=body.action==='withdraw'?item.initiator===actor.id:item.kind==='invitation'?item.target===actor.id:member;
        if(!allowed)failure('MEMBERSHIP_DECISION_FORBIDDEN',403);
        status=item.status;
        if(status==='pending') {
          requestChanged=true;
          const inviterValid=item.kind!=='invitation'||!!users.get(item.initiator)?.enabled&&project.members.some(v=>v.id===item.initiator);
          if(!users.get(target)?.enabled||!inviterValid)status='invalidated';
          else status=body.action==='accept'?'accepted':body.action==='reject'?'rejected':'withdrawn';
          await c.execute('UPDATE project_membership_requests SET status=?,resolved_at=UTC_TIMESTAMP(3),resolved_by=?,resolution_code=? WHERE id=?',[status,status==='invalidated'?null:actor.id,status==='invalidated'?'eligibility_changed':status,request]);
          if(status==='accepted'&&!project.members.some(v=>v.id===target)) {await c.execute('INSERT INTO project_responsibilities(project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))',[projectId,target]);changed=true;}
        }
      }
      if(changed) {
        if(project.version==='18446744073709551615')failure('PROJECT_VERSION_EXHAUSTED',422);
        await c.execute('UPDATE projects SET version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?',[projectId]);
      }
      const savedVersion=String(BigInt(project.version)+(changed?1n:0n));
      const result={projectId,requestId:request,targetUserId:target,status,changed,savedVersion,operationId:body.idempotencyKey};
      if(changed||requestChanged)await c.execute("INSERT INTO audit_log(actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user',?,'project',?,?,?,?,'null',?,?,UTC_TIMESTAMP(3))",[actor.id,actor.name,'project.membership.'+body.action,projectId,projectId,project.version,savedVersion,JSON.stringify({targetUserId:target,requestId:request,status,changed}),requestId]);
      await c.execute('INSERT INTO command_receipts(actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,UTC_TIMESTAMP(3))',[actor.id,scope,body.idempotencyKey,hash,JSON.stringify(result)]);
      return {outcome:'committed',result};
    });
  }
  function list(actor:Actor,before?:string) {
    return database.readSnapshot(async c=>{
      await assertActor(c,actor,false,new Date(),false,false);
      if(await maintenanceAccount(c,false)===actor.id)failure('BUSINESS_ACCOUNT_REQUIRED',403);
      const items=await rows(c,`SELECT CAST(r.id AS CHAR) id,CAST(r.project_id AS CHAR) projectId,p.name projectName,r.kind,r.status,
        CAST(r.initiator_id AS CHAR) initiatorId,u.display_name initiatorName,CAST(r.target_user_id AS CHAR) targetUserId,t.display_name targetName,
        DATE_FORMAT(r.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,r.resolution_code resolution
        FROM project_membership_requests r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.initiator_id JOIN users t ON t.id=r.target_user_id
        WHERE (r.target_user_id=? OR r.initiator_id=? OR (r.kind='application' AND EXISTS(SELECT 1 FROM project_responsibilities m WHERE m.project_id=r.project_id AND m.user_id=?)))
        ${before?'AND r.id<?':''} ORDER BY r.id DESC LIMIT 51`,[actor.id,actor.id,actor.id,...before?[before]:[]]);
      const pendingCount=Number((await rows(c,`SELECT COUNT(*) count FROM project_membership_requests r WHERE r.status='pending' AND (r.target_user_id=? OR r.initiator_id=? OR (r.kind='application' AND EXISTS(SELECT 1 FROM project_responsibilities m WHERE m.project_id=r.project_id AND m.user_id=?)))`,[actor.id,actor.id,actor.id]))[0].count);
      return {items:items.slice(0,50),next:items.length>50?items[49].id:null,pendingCount};
    });
  }
  return {run,list};
}
