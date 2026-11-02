import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {connectDatabase} from '../dist/server/infrastructure/db.js';
import {openRuntimeDatabase} from '../dist/server/infrastructure/runtime-database.js';
import {identities,hashPassword} from '../dist/server/modules/identity.js';
import {imports} from '../dist/server/modules/imports.js';
import {importExecutions} from '../dist/server/modules/import-execution.js';
import {canonical} from '../dist/server/modules/personal-state.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid id'))[0][0].id,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='takeover_'+randomUUID().slice(0,8),password='Test123!takeover',checks=[];
let runtime,executor;
async function fresh(sql,args=[]){const {connection}=await connectDatabase('test_app');try{return(await connection.query(sql,args))[0];}finally{await connection.end();}}
try{
  const hash=await hashPassword(password),users=[];
  for(const role of ['original','handler','other','admin']){
    const login=prefix+'_'+role;
    await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,is_admin,is_project_manager,created_at,updated_at) VALUES (?,?,?,0,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[login,hash,login,role==='admin'?1:0,role==='admin'?0:1]);
    users.push({id:(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id,login});
  }
  runtime=await openRuntimeDatabase('test_app');const identity=identities(runtime),service=imports(runtime);executor=importExecutions(runtime);
  const actors=[];for(const user of users){const session=await identity.login(user.login,password,'takeover-test');actors.push(await identity.resolve(session.token));}
  const [original,handler,other,admin]=actors;
  const uploaded=await service.upload(original,{name:prefix+'.json',operation:randomUUID()},Readable.from([JSON.stringify({version:2,projects:[],chips:[{id:1,name:prefix+'已提交'},{id:2,name:prefix+'未提交'},{id:3,name:prefix+'未准备'}]})]));
  const batchId=uploaded.result.batchId,read=await service.read(original,batchId);
  const request={formatVersion:2,stage:'catalogs',idempotencyKey:randomUUID(),items:read.catalogRows.filter(row=>row.kind==='chips').map(row=>({id:row.id,command:{expectedBatchVersion:read.batch.version,expectedReviewVersion:row.reviewVersion,expectedVersion:row.expectedVersion,idempotencyKey:randomUUID(),basis:row.basis,selected:row.defaultSelected}}))};
  assert.equal(request.items.length,3);
  const command=await runtime.writeTransaction(conn=>service.planExecution(conn,original,batchId,request)),token=randomUUID();
  await c.execute("INSERT INTO import_executions(batch_id,actor_id,operation_key,request_hash,command_json,progress_json,status,lease_token,lease_until,created_at,updated_at) VALUES (?,?,?,?,?,'{}','running',?,TIMESTAMPADD(HOUR,1,UTC_TIMESTAMP(3)),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",[batchId,original.id,request.idempotencyKey,createHash('sha256').update(canonical(request)).digest(),JSON.stringify(command),token]);
  const execution={id:(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id,token},progress={};
  for(const entry of command.entries.slice(0,2)){const prepared=await service.prepareExecution(original,batchId,entry,[],execution);progress[entry.id]={status:'confirming',body:prepared.body};}
  await c.execute('UPDATE import_executions SET progress_json=? WHERE id=?',[JSON.stringify(progress),execution.id]);
  const first=command.entries[0];
  const committed=await service.item(original,batchId,first.id,'adopt',progress[first.id].body,first.body.idempotencyKey,execution);
  // 保留真实已提交回执，模拟执行进度响应丢失；另外两项确实没有写入。
  await c.execute("UPDATE import_executions SET status='paused',lease_token=NULL,lease_until=NULL WHERE id=?",[execution.id]);
  const before=(await fresh('SELECT actor_id,command_json,request_hash FROM import_executions WHERE id=?',[execution.id]))[0];
  assert.equal((await executor.read(original,batchId,request.idempotencyKey)).resumeMode,'continue');
  assert.equal((await executor.read(handler,batchId,request.idempotencyKey)).canResume,false);
  await assert.rejects(()=>executor.resume(other,batchId,request.idempotencyKey),error=>error.code==='IMPORT_EXECUTION_OWNER_REQUIRED');
  await c.execute('UPDATE users SET enabled=0,deleted_at=UTC_TIMESTAMP(3),version=version+1 WHERE id=?',[original.id]);
  assert.equal((await executor.read(handler,batchId,request.idempotencyKey)).canResume,false,'停用本身不把批次授予别人');
  assert.equal((await service.read(admin,batchId)).batch.canTakeover,false);
  await assert.rejects(()=>service.changeBatch(admin,batchId,'takeover',{expectedVersion:read.batch.version,idempotencyKey:randomUUID(),reason:'纯管理员不得接管'},'takeover-test'),error=>error.code==='PROJECT_MANAGER_REQUIRED');
  assert.equal((await service.read(handler,batchId)).batch.canTakeover,true);
  assert.equal((await fresh('SELECT CAST(current_handler_id AS CHAR) id FROM import_batches WHERE id=?',[batchId]))[0].id,original.id);
  checks.push('纯管理员没有接管资格，界面能力与写入拒绝一致；失败不改变批次处理人，业务账号仍能接管');
  await service.changeBatch(handler,batchId,'takeover',{expectedVersion:read.batch.version,idempotencyKey:randomUUID(),reason:'继续已停用上传者的未完导入'},'takeover-test');
  const ready=await executor.read(handler,batchId,request.idempotencyKey);assert.equal(ready.canResume,true);assert.equal(ready.resumeMode,'reconcile');assert(ready.unfinished.some(row=>row.operationId===request.idempotencyKey&&row.canResume));
  await executor.resume(handler,batchId,request.idempotencyKey);
  let result;for(let i=0;i<100;i++){result=await executor.read(handler,batchId,request.idempotencyKey);if(result.status==='finished')break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(result.status,'finished');assert.equal(result.items[0].status,'committed');assert.equal(result.items[0].result.id,committed.result.id);assert(result.items.slice(1).every(row=>row.status==='failed'&&row.code==='AUTH_REQUIRED'));
  assert.deepEqual((await fresh('SELECT actor_id,command_json,request_hash FROM import_executions WHERE id=?',[execution.id]))[0],before,'核对不改旧身份和冻结请求');
  assert.equal(Number((await fresh('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?',[first.id]))[0].n),1);
  assert.equal(Number((await fresh('SELECT COUNT(*) n FROM chips WHERE name LIKE ?',[prefix+'%']))[0].n),1);
  assert.equal(result.unfinished.length,0);
  checks.push('只有原操作人或已明确接管的现处理人可核对；停用/删除账号的真实提交回执优先复用，另外两项拒绝旧身份写入并释放');
  const next=await service.read(handler,batchId),row=next.catalogRows.find(value=>value.id===command.entries[1].id);
  const retry={formatVersion:2,stage:'catalogs',idempotencyKey:randomUUID(),items:[{id:row.id,command:{expectedBatchVersion:next.batch.version,expectedReviewVersion:row.reviewVersion,expectedVersion:row.expectedVersion,idempotencyKey:randomUUID(),basis:row.basis,selected:row.defaultSelected}}]};
  await executor.submit(handler,batchId,retry);
  for(let i=0;i<100;i++){result=await executor.read(handler,batchId,retry.idempotencyKey);if(result.status==='finished')break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(result.status,'finished');assert.equal(result.items[0].status,'committed');
  assert.equal(Number((await fresh('SELECT COUNT(*) n FROM chips WHERE name LIKE ?',[prefix+'%']))[0].n),2);
  checks.push('接管核对结束后，未提交资料由新处理人新操作保存，新连接回读两条资料且旧成功项没有重复');
  console.log(JSON.stringify({status:'passed',scope:'隔离数据库深接口与持久回读，不代表真实页面验收',checks}));
}finally{await executor?.close();await runtime?.close();await c.end();}
