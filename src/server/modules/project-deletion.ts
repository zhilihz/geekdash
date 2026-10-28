import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, isAdministrator, type Actor } from './identity.js';
import { failure, validId } from './project-save.js';

type Command = { expectedVersion:string; idempotencyKey:string };
export function validateDeletion(value:unknown):Command {
  const body=value as Command;
  if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==2 || !validId(body.expectedVersion) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey??''))failure('INVALID_COMMAND',400);
  return body;
}
const rows=async(c:PoolConnection,sql:string,values:unknown[]=[]) => (await c.query<RowDataPacket[]>(sql,values))[0];
export function projectDeletion(database:RuntimeDatabase) {
  return async(actor:Actor,id:string,body:Command,requestId:string,confirm=false)=>{
    const scope=`user:${actor.id}:project:${id}:delete`,hash=createHash('sha256').update(body.expectedVersion).digest();
    return database.writeTransaction(async c=>{
      await assertActor(c,actor);
      if(!await isAdministrator(c,actor.id))failure('ADMIN_REQUIRED',403);
      // 项目锁同时串行化删除、保存和重复删除；旧回执可在删除后读取。
      const project=(await rows(c,'SELECT name,CAST(version AS CHAR) version,deleted_at FROM projects WHERE id=? FOR UPDATE',[id]))[0];
      if(!project)failure('PROJECT_NOT_FOUND',404);
      const receipt=(await rows(c,'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?',[scope,body.idempotencyKey]))[0];
      if(receipt){if(!receipt.request_hash.equals(hash))failure('OPERATION_KEY_REUSED',409);return {outcome:'committed',result:typeof receipt.response_json==='string'?JSON.parse(receipt.response_json):receipt.response_json};}
      if(confirm)return {outcome:'not_found'};
      if(project.deleted_at)failure('PROJECT_DELETED',410);
      if(project.version!==body.expectedVersion)failure('PROJECT_VERSION_CONFLICT',409);
      if(project.version==='18446744073709551615')failure('PROJECT_VERSION_EXHAUSTED',422);
      const savedVersion=String(BigInt(project.version)+1n),result={projectId:id,savedVersion,operationId:body.idempotencyKey,changed:true,deleted:true};
      await c.execute('UPDATE projects SET deleted_at=UTC_TIMESTAMP(3),name_key=NULL,version=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?',[savedVersion,id]);
      await c.execute("UPDATE project_membership_requests SET status='invalidated',resolution_code='project_deleted',resolved_at=UTC_TIMESTAMP(3),resolved_by=? WHERE project_id=? AND status='pending'",[actor.id,id]);
      await c.execute("INSERT INTO audit_log(actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user','project.delete','project',?,?,?,?,?,?,?,UTC_TIMESTAMP(3))",[actor.id,actor.name,id,id,project.version,savedVersion,JSON.stringify({name:project.name}),JSON.stringify({deleted:true}),requestId]);
      await c.execute('INSERT INTO command_receipts(actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,UTC_TIMESTAMP(3))',[actor.id,scope,body.idempotencyKey,hash,JSON.stringify(result)]);
      return {outcome:'committed',result};
    });
  };
}
