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
function publicResult(row:Json){return{id:row.id,batchId:row.batchId,actorId:row.actorId,operationId:row.operationId,status:row.status,stage:row.command.stage ?? 'legacy',items:row.command.entries.map((entry:Json)=>({id:entry.id,kind:entry.kind,...row.progress[entry.id],body:undefined})),operationIds:row.command.entries.map((entry:Json)=>entry.body.idempotencyKey)};}

// 导入专用执行器：一个进程串行推进，每个项目仍使用现有独立事务。
export function importExecutions(database:RuntimeDatabase,committed:(result:Json)=>void=()=>{}) {
  const service=imports(database);
  let stopped=false,running:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined;
  async function read(actor:Actor,batchId:string,key?:string){
    if(!validId(batchId))failure('INVALID_IMPORT_BATCH',400);
    return database.readSnapshot(async c=>{
      await assertActor(c,actor,false,new Date(),false,false);
      const access=(await rows(c,`SELECT b.current_handler_id=? AND u.is_project_manager=1 AND EXISTS(SELECT 1 FROM audit_log a WHERE a.action='import.takeover' AND a.entity_id=CAST(b.id AS CHAR) AND a.actor_id=?) takeover FROM import_batches b JOIN users u ON u.id=? WHERE b.id=?`,[actor.id,actor.id,actor.id,batchId]))[0];
      const disabled=new Set((await rows(c,'SELECT CAST(u.id AS CHAR) id FROM users u JOIN import_executions e ON e.actor_id=u.id WHERE e.batch_id=? AND (u.enabled=0 OR u.deleted_at IS NOT NULL)',[batchId])).map(row=>row.id));
      const result=(row:Json)=>{const resumeMode=row.actorId===actor.id?'continue':Number(access?.takeover)===1&&disabled.has(row.actorId)?'reconcile':null;return{...publicResult(unpack(row)),canResume:!!resumeMode,resumeMode};};
      const found=await rows(c,`SELECT ${columns} FROM import_executions WHERE batch_id=?${key?' AND operation_key=?':''} ORDER BY ${key?'actor_id=? DESC,':''}id DESC LIMIT 1`,[batchId,...key?[key,actor.id]:[]]);
      const unfinished=(await rows(c,`SELECT ${columns} FROM import_executions WHERE batch_id=? AND status IN ('accepted','running','paused') ORDER BY id`,[batchId]))
        .map(result);
      if(found.length)return {...result(found[0]),unfinished};
      return key?null:unfinished.length?{unfinished}:null;
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
      const paused=await rows(c,"SELECT command_json command,progress_json progress FROM import_executions WHERE batch_id=? AND status='paused'",[batchId]);
      const held=new Set(paused.flatMap(value=>{const job=unpack(value);return job.command.entries.filter((entry:Json)=>!['committed','failed'].includes(job.progress[entry.id]?.status)).map((entry:Json)=>entry.id);}));
      if(command.entries.some(entry=>held.has(entry.id)))failure('IMPORT_ITEM_CONFIRMING',409);
      await c.execute("INSERT INTO import_executions(batch_id,actor_id,operation_key,request_hash,command_json,progress_json,status,created_at,updated_at) VALUES (?,?,?,?,?,'{}','accepted',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",[batchId,actor.id,body.idempotencyKey,digest,JSON.stringify(command)]);
      const id=(await rows(c,'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
      return publicResult({id,batchId,actorId:actor.id,operationId:body.idempotencyKey,status:'accepted',command,progress:{}});
    });
    wake();return value;
  }
  async function resume(actor:Actor,batchId:string,key:string){
    if(!validId(batchId)||!/^[a-f0-9-]{36}$/.test(key))failure('INVALID_IMPORT_OPERATION',400);
    const result=await database.writeTransaction(async c=>{
      await assertActor(c,actor);
      const initial=(await rows(c,`SELECT ${columns} FROM import_executions WHERE batch_id=? AND operation_key=? ORDER BY actor_id=? DESC,id DESC LIMIT 1`,[batchId,key,actor.id]))[0];
      if(!initial)failure('IMPORT_EXECUTION_NOT_FOUND',404);
      const users=await rows(c,'SELECT CAST(id AS CHAR) id,enabled,deleted_at deletedAt,is_project_manager manager FROM users WHERE id IN (?,?) ORDER BY id FOR SHARE',[actor.id,initial.actorId]);
      const batch=(await rows(c,'SELECT CAST(current_handler_id AS CHAR) handlerId FROM import_batches WHERE id=? FOR UPDATE',[batchId]))[0];
      const original=users.find(row=>row.id===initial.actorId);
      const takeover=initial.actorId!==actor.id&&batch?.handlerId===actor.id&&users.find(row=>row.id===actor.id)?.manager&&original&&(!original.enabled||original.deletedAt)
        &&(await rows(c,"SELECT id FROM audit_log WHERE action='import.takeover' AND entity_id=? AND actor_id=? LIMIT 1",[batchId,actor.id])).length>0;
      if(initial.actorId!==actor.id&&!takeover)failure('IMPORT_EXECUTION_OWNER_REQUIRED',403);
      const found=(await rows(c,`SELECT ${columns} FROM import_executions WHERE id=? FOR UPDATE`,[initial.id]))[0];
      if(!found)failure('IMPORT_EXECUTION_NOT_FOUND',404);
      if(found.status==='paused'){
        if((await rows(c,"SELECT id FROM import_executions WHERE batch_id=? AND status IN ('accepted','running') LIMIT 1",[batchId])).length)failure('IMPORT_EXECUTION_ACTIVE',409);
        await c.execute("UPDATE import_executions SET status='accepted',lease_token=NULL,lease_until=NULL,updated_at=UTC_TIMESTAMP(3) WHERE id=?",[found.id]);
        found.status='accepted';
      }
      return {...publicResult(unpack(found)),canResume:true,resumeMode:takeover?'reconcile':'continue'};
    });
    wake();return result;
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
      if(entry.dependencies.some((id:string)=>job.progress[id]?.status==='confirming'||job.progress[id]?.status==='waiting')){progress.status='waiting';progress.code='IMPORT_DEPENDENCY_CONFIRMING';continue;}
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
        else {
          // 写入后回读/持久执行进度失败也可能已提交；保留原正文和编号，继续无依赖项。
          progress.status='confirming';progress.code=problem.code ?? 'IMPORT_RESULT_UNKNOWN';
          progress.message=problem.code==='COMMIT_UNKNOWN'?'已发送保存，正在核对是否成功；请查询结果或继续本次操作。':'本项暂未完成核对，输入已保留；请继续本次操作。';
          await persist();
        }
      }
    }
    const finished=job.command.entries.every((entry:Json)=>['committed','failed'].includes(job.progress[entry.id]?.status));
    await persist(finished?'finished':stopped?'running':'paused');
  }
  function wake(){if(!stopped&&!running)running=step().catch(()=>{/* 数据库断连保留租约，下次按持久结果恢复。 */}).finally(()=>{running=undefined;});}
  return {submit,read,resume,start(){timer=setInterval(wake,1000);timer.unref();wake();},async close(){stopped=true;if(timer)clearInterval(timer);await running;}};
}
