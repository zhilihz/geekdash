import { createHash, randomUUID } from 'node:crypto';
import type { RowDataPacket, PoolConnection } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { canonical } from './personal-state.js';
import { failure, validId } from './project-save.js';
import { imports } from './imports.js';

type Json=Record<string,any>;
const decode=(value:any)=>typeof value==='string'?JSON.parse(value):value;
const columns='CAST(id AS CHAR) id,CAST(batch_id AS CHAR) batchId,CAST(actor_id AS CHAR) actorId,operation_key operationId,request_hash requestHash,command_json command,progress_json progress,status';
async function rows(c:PoolConnection,sql:string,args:unknown[]=[]){return(await c.query<RowDataPacket[]>({sql,timeout:4000},args))[0];}
function unpack(row:Json):Json{return{...row,command:decode(row.command),progress:decode(row.progress)};}
function publicResult(row:Json){return{id:row.id,batchId:row.batchId,actorId:row.actorId,operationId:row.operationId,status:row.status,items:row.command.entries.map((entry:Json)=>({id:entry.id,kind:entry.kind,...row.progress[entry.id],body:undefined})),operationIds:row.command.entries.map((entry:Json)=>entry.body.idempotencyKey)};}

// 导入专用执行器：一个进程串行推进，每个项目仍使用现有独立事务。
export function importExecutions(database:RuntimeDatabase,committed:(result:Json)=>void=()=>{}) {
  const service=imports(database);
  let stopped=false,running:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined;
  async function read(actor:Actor,batchId:string,key?:string){
    if(!validId(batchId))failure('INVALID_IMPORT_BATCH',400);
    return database.readSnapshot(async c=>{
      await assertActor(c,actor,false,new Date(),false,false);
      const found=await rows(c,`SELECT ${columns} FROM import_executions WHERE batch_id=?${key?' AND actor_id=? AND operation_key=?':''} ORDER BY id DESC LIMIT 1`,[batchId,...key?[actor.id,key]:[]]);
      return found.length?publicResult(unpack(found[0])):null;
    });
  }
  async function submit(actor:Actor,batchId:string,input:unknown){
    const body=input as Json;
    if(!validId(batchId)||!body||typeof body.idempotencyKey!=='string')failure('INVALID_IMPORT_COMMAND',400);
    const digest=createHash('sha256').update(canonical(body)).digest();
    const value=await database.writeTransaction(async c=>{
      await assertActor(c,actor);
      const previous=(await rows(c,`SELECT ${columns} FROM import_executions WHERE batch_id=? AND actor_id=? AND operation_key=?`,[batchId,actor.id,body.idempotencyKey]))[0];
      if(previous){if(!previous.requestHash.equals(digest))failure('OPERATION_KEY_REUSED',409);return publicResult(unpack(previous));}
      if(body.formatVersion!==2)failure('IMPORT_CLIENT_OUTDATED',410);
      const command=await service.planExecution(c,actor,batchId,body);
      // planExecution 持有批次锁，重复接收在此再查一次。
      const duplicate=(await rows(c,`SELECT ${columns} FROM import_executions WHERE batch_id=? AND actor_id=? AND operation_key=?`,[batchId,actor.id,body.idempotencyKey]))[0];
      if(duplicate){if(!duplicate.requestHash.equals(digest))failure('OPERATION_KEY_REUSED',409);return publicResult(unpack(duplicate));}
      if((await rows(c,"SELECT id FROM import_executions WHERE batch_id=? AND status IN ('accepted','running') LIMIT 1",[batchId])).length)failure('IMPORT_EXECUTION_ACTIVE',409);
      await c.execute("INSERT INTO import_executions(batch_id,actor_id,operation_key,request_hash,command_json,progress_json,status,created_at,updated_at) VALUES (?,?,?,?,?,'{}','accepted',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",[batchId,actor.id,body.idempotencyKey,digest,JSON.stringify(command)]);
      const id=(await rows(c,'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
      return publicResult({id,batchId,actorId:actor.id,operationId:body.idempotencyKey,status:'accepted',command,progress:{}});
    });
    wake();return value;
  }
  async function step(){
    if(stopped||process.env.GEEKDASH_IMPORT_WRITES==='disabled'||process.env.GEEKDASH_BUSINESS_WRITES==='disabled')return;
    const token=randomUUID();
    const job=await database.writeTransaction(async c=>{
      const found=(await rows(c,`SELECT ${columns} FROM import_executions WHERE status='accepted' OR (status='running' AND lease_until<UTC_TIMESTAMP(3)) ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`))[0];
      if(!found)return;
      if(decode(found.command).formatVersion!==2)failure('IMPORT_LEGACY_EXECUTION_PENDING',503);
      await c.execute("UPDATE import_executions SET status='running',lease_token=?,lease_until=TIMESTAMPADD(SECOND,30,UTC_TIMESTAMP(3)),updated_at=UTC_TIMESTAMP(3) WHERE id=?",[token,found.id]);return unpack(found);
    });
    if(!job)return;
    const actor:Actor={id:job.actorId,version:job.command.actorVersion,name:'',mustChangePassword:false,tokenHash:Buffer.alloc(0),csrfHash:Buffer.alloc(0)};
    const execution={id:job.id,token};
    const persist=async(status='running')=>database.writeTransaction(async c=>{
      const [result]=await c.execute<any>("UPDATE import_executions SET progress_json=?,status=?,lease_until=TIMESTAMPADD(SECOND,30,UTC_TIMESTAMP(3)),updated_at=UTC_TIMESTAMP(3) WHERE id=? AND lease_token=?",[JSON.stringify(job.progress),status,job.id,token]);
      if(result.affectedRows!==1)failure('IMPORT_EXECUTION_LEASE_LOST',409);
    });
    for(const entry of job.command.entries){
      if(stopped||process.env.GEEKDASH_IMPORT_WRITES==='disabled'||process.env.GEEKDASH_BUSINESS_WRITES==='disabled')break;
      let progress=job.progress[entry.id] ??= {status:'pending'};
      if(['committed','failed'].includes(progress.status))continue;
      try {
        if(!progress.body){
          const done=job.command.entries.filter((value:Json)=>job.progress[value.id]?.status==='committed').map((value:Json)=>({...value,result:job.progress[value.id].result}));
          const prepared=await service.prepareExecution(actor,job.batchId,entry,done,execution);
          if(prepared.result){progress.status='committed';progress.result=prepared.result;await persist();continue;}
          progress.body=prepared.body;progress.status='saving';await persist();
        }
        // 原请求体先持久化，再发送业务事务；崩溃恢复必须重放同一编号和同一内容。
        const prior=await service.executionResult(actor,entry.id,progress.body);
        const result=prior?{outcome:'committed',result:prior}:await service.item(actor,job.batchId,entry.id,'adopt',progress.body,entry.body.idempotencyKey,{...execution,collaborators:entry.collaborators});
        if(!('result' in result))throw new Error('IMPORT_RESULT_UNKNOWN');
        progress.status='committed';progress.result=result.result;await persist();committed(result.result);
      }catch(error){
        const problem=error as {status?:number;code?:string;fields?:unknown};
        if(problem.code==='IMPORT_EXECUTION_LEASE_LOST')return;
        if(problem.status && problem.status<500){progress.status='failed';progress.code=problem.code;progress.statusCode=problem.status;progress.fields=problem.fields;await persist();}
        else {progress.status='confirming';progress.code=problem.code ?? 'DATABASE_UNAVAILABLE';await persist();return;}
      }
    }
    const finished=job.command.entries.every((entry:Json)=>['committed','failed'].includes(job.progress[entry.id]?.status));
    await persist(finished?'finished':'running');
  }
  function wake(){if(!stopped&&!running)running=step().catch(()=>{/* 数据库断连保留租约，下次按持久结果恢复。 */}).finally(()=>{running=undefined;});}
  return {submit,read,start(){timer=setInterval(wake,1000);timer.unref();wake();},async close(){stopped=true;if(timer)clearInterval(timer);await running;}};
}
