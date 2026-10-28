import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, isAdministrator, type Actor } from './identity.js';
import { failure, validId } from './project-save.js';
import { canonical } from './personal-state.js';

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
type Command = { action: 'join' | 'claim' | 'apply' | 'invite' | 'accept' | 'reject' | 'withdraw' | 'leave'; idempotencyKey: string; targetUserId?: string; requestId?: string; expectedVersion?: string };
export const membershipRows = async (c: PoolConnection, sql: string, values: unknown[] = []) => (await c.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0];
const rows = membershipRows;
export async function hasProjectAccess(c:PoolConnection,projectId:string,accountId:string) {
  return !!(await rows(c,'SELECT r.project_id FROM project_responsibilities r JOIN users u ON u.id=r.user_id JOIN projects p ON p.id=r.project_id AND p.deleted_at IS NULL WHERE r.project_id=? AND r.user_id=? AND u.enabled=1',[projectId,accountId])).length;
}
// 首次注册姓名只提供归属提示；点击加入仍走统一成员事务。
export async function suggestedProjects(c:PoolConnection,accountId:string) {
  return rows(c,`SELECT CAST(p.id AS CHAR) id,p.name FROM projects p
    JOIN users u ON u.id=? AND u.enabled=1 AND u.is_project_manager=1 AND u.registration_name IS NOT NULL
    WHERE p.deleted_at IS NULL AND (EXISTS(SELECT 1 FROM project_people pp JOIN engineers e ON e.id=pp.engineer_id WHERE pp.project_id=p.id AND pp.role='pm' AND BINARY e.name=BINARY u.registration_name)
      OR EXISTS(SELECT 1 FROM import_items item WHERE item.id=(SELECT a.item_id FROM import_adoptions a WHERE a.target_kind='project' AND a.target_id=p.id ORDER BY a.id DESC LIMIT 1)
        AND JSON_CONTAINS(JSON_EXTRACT(item.source_payload_json,'$.pm'),JSON_QUOTE(u.registration_name))))
    AND (SELECT COUNT(*) FROM users other WHERE other.enabled=1 AND other.is_project_manager=1 AND BINARY other.registration_name=BINARY u.registration_name)=1
    AND NOT EXISTS(SELECT 1 FROM project_responsibilities r WHERE r.project_id=p.id AND r.user_id=u.id) ORDER BY p.id`,[accountId]);
}
export async function assertProjectAccess(c:PoolConnection,projectId:string,accountId:string) {
  if(!(await rows(c,'SELECT id FROM projects WHERE id=? AND deleted_at IS NULL',[projectId])).length)failure('PROJECT_NOT_FOUND',404);
  if(!await hasProjectAccess(c,projectId,accountId) && !await isAdministrator(c,accountId))failure('PROJECT_ACCESS_REQUIRED',403);
}
// 原操作仍能确认成功；退出后只返回提交事实，不再返回正式业务快照。
export async function visibleProjectReceipt<T extends {projectId:string;operationId:string;savedVersion:string;changed?:boolean;baseVersion?:string;savedAt?:string|null}>(c:PoolConnection,accountId:string,result:T) {
  if(await hasProjectAccess(c,result.projectId,accountId))return result;
  return {projectId:result.projectId,operationId:result.operationId,savedVersion:result.savedVersion,baseVersion:result.baseVersion,changed:result.changed ?? false,savedAt:result.savedAt ?? null,values:{},accessLost:true};
}

export function validateMembership(value: unknown): Command {
  const body = value as Command;
  if (!body || typeof body !== 'object' || Array.isArray(body) || !['join','claim','apply','invite','accept','reject','withdraw','leave'].includes(body.action) || !uuid(body.idempotencyKey)) failure('INVALID_MEMBERSHIP_COMMAND',400);
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
export async function assertBusinessActor(c: PoolConnection, actor: Actor) {
  const user=await assertActor(c,actor);
  if(!user.isProjectManager)failure('PROJECT_MANAGER_REQUIRED',403);
}
export async function lockMembershipProject(c: PoolConnection, projectId: string, users: Map<string,RowDataPacket>, joining = false) {
  const project = (await rows(c,'SELECT CAST(id AS CHAR) id,CAST(version AS CHAR) version FROM projects WHERE deleted_at IS NULL AND id=? FOR UPDATE',[projectId]))[0];
  if (!project) failure('PROJECT_NOT_FOUND',404);
  const members = await rows(c,'SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=?',[projectId]);
  if (!joining && members.some(member => !users.has(member.id))) failure('MEMBERSHIP_CHANGED',409);
  return { ...project, members: members.map(member => users.get(member.id)).filter((user): user is RowDataPacket => !!user) } as { id:string;version:string;members:RowDataPacket[] };
}
export async function invalidateMembershipRequests(c: PoolConnection, userId: string, reason: 'account_disabled' | 'inviter_left', projectId?: string) {
  const where = reason === 'account_disabled' ? "(target_user_id=? OR (kind='invitation' AND initiator_id=?))" : "kind='invitation' AND initiator_id=? AND project_id=?";
  const values = reason === 'account_disabled' ? [userId,userId] : [userId,projectId];
  await c.query(`UPDATE project_membership_requests SET status='invalidated',resolved_at=UTC_TIMESTAMP(3),resolved_by=NULL,resolution_code=? WHERE status='pending' AND ${where}`, [reason,...values]);
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
    if (!['join','leave'].includes(body.action)) failure('MEMBERSHIP_PROTOCOL_CHANGED',410);
    return database.writeTransaction(async c=>{
      const members=await rows(c,'SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=?',[projectId]);
      const users=await lockMembershipAccounts(c,[actor.id,...members.map(v=>v.id)]);
      await assertBusinessActor(c,actor);
      const project=await lockMembershipProject(c,projectId,users,body.action==='join');
      const prior=await lookup(c,true);if(prior)return {outcome:'committed',result:prior};
      const member=project.members.some(v=>v.id===actor.id), enabled=project.members.filter(v=>v.enabled);
      let status:string='member', request:string|null=null, changed=false, target=actor.id;
      if(body.action==='join') {
        if(!member) {
          await c.execute('INSERT INTO project_responsibilities(project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))',[projectId,actor.id]);
          changed=true;
        }
      } else {
        if(project.version!==body.expectedVersion)failure('PROJECT_VERSION_CONFLICT',409,{currentVersion:project.version});
        if(member) {
          if(!enabled.some(v=>v.id!==actor.id))failure('LAST_RESPONSIBLE',422);
          await c.execute('DELETE FROM project_responsibilities WHERE project_id=? AND user_id=?',[projectId,actor.id]);
          changed=true;
        }
        status='left';
      }
      if(changed) {
        if(project.version==='18446744073709551615')failure('PROJECT_VERSION_EXHAUSTED',422);
        await c.execute('UPDATE projects SET version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?',[projectId]);
      }
      const savedVersion=String(BigInt(project.version)+(changed?1n:0n));
      const result={projectId,requestId:request,targetUserId:target,status,changed,savedVersion,operationId:body.idempotencyKey};
      if(changed)await c.execute("INSERT INTO audit_log(actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user',?,'project',?,?,?,?,'null',?,?,UTC_TIMESTAMP(3))",[actor.id,actor.name,'project.membership.'+body.action,projectId,projectId,project.version,savedVersion,JSON.stringify({targetUserId:target,requestId:request,status,changed}),requestId]);
      await c.execute('INSERT INTO command_receipts(actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,UTC_TIMESTAMP(3))',[actor.id,scope,body.idempotencyKey,hash,JSON.stringify(result)]);
      return {outcome:'committed',result};
    });
  }
  function list(actor:Actor,before?:string) {
    return database.readSnapshot(async c=>{
      await assertActor(c,actor,false,new Date(),false,false);

      const items=await rows(c,`SELECT CAST(r.id AS CHAR) id,CAST(r.project_id AS CHAR) projectId,p.name projectName,r.kind,r.status,
        CAST(r.initiator_id AS CHAR) initiatorId,u.display_name initiatorName,CAST(r.target_user_id AS CHAR) targetUserId,t.display_name targetName,
        DATE_FORMAT(r.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,r.resolution_code resolution
        FROM project_membership_requests r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.initiator_id JOIN users t ON t.id=r.target_user_id
        WHERE p.deleted_at IS NULL AND (r.target_user_id=? OR r.initiator_id=? OR (r.kind='application' AND EXISTS(SELECT 1 FROM project_responsibilities m WHERE m.project_id=r.project_id AND m.user_id=?)))
        ${before?'AND r.id<?':''} ORDER BY r.id DESC LIMIT 51`,[actor.id,actor.id,actor.id,...before?[before]:[]]);
      const pendingCount=Number((await rows(c,`SELECT COUNT(*) count FROM project_membership_requests r WHERE r.status='pending' AND (r.target_user_id=? OR r.initiator_id=? OR (r.kind='application' AND EXISTS(SELECT 1 FROM project_responsibilities m WHERE m.project_id=r.project_id AND m.user_id=?)))`,[actor.id,actor.id,actor.id]))[0].count);
      return {items:items.slice(0,50),next:items.length>50?items[49].id:null,pendingCount};
    });
  }
  return {run,list};
}
