import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { migrateDatabase } from '../dist/server/infrastructure/schema.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { createApp } from '../dist/server/app.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='execution_'+randomUUID().slice(0,8),password=randomUUID()+randomUUID(),checks=[];
let app,runtime,origin,cookie='',csrf='',account='',fault=false,hit=false,requests=0;
const digest=value=>createHash('sha256').update(JSON.stringify(value,(_,v)=>Buffer.isBuffer(v)?v.toString('hex'):v)).digest('hex');
async function snapshot(){const result={};for(const row of(await c.query('SHOW TABLES'))[0]){const name=Object.values(row)[0];if(['schema_migrations','import_executions'].includes(name))continue;const data=(await c.query('SELECT * FROM `'+name+'`'))[0];result[name]=data.map(digest).sort();}return result;}
async function start(){
  runtime=await openRuntimeDatabase('test_app');const write=runtime.writeTransaction;
  runtime.writeTransaction=work=>write(async conn=>{
    const execute=conn.execute,commit=conn.commit;let adopted=false;
    conn.execute=function(sql,args){if(String(sql).startsWith('INSERT INTO import_adoptions'))adopted=true;return execute.call(this,sql,args);};
    conn.commit=async function(){try{await commit.call(this);if(fault&&adopted){fault=false;hit=true;throw Object.assign(new Error('lost commit acknowledgment'),{code:'PROTOCOL_CONNECTION_LOST'});}}finally{conn.commit=commit;}};
    try{return await work(conn);}catch(error){conn.commit=commit;throw error;}finally{conn.execute=execute;}
  });
  app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'0.0.0.0',port:0});
}
async function api(path,method='GET',body,status=200,raw=false){
  const response=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':raw?'application/octet-stream':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,'X-GeekDash-Account':account},...body===undefined?{}:{body:raw?body:JSON.stringify(body)}});requests++;
  for(const value of response.headers.getSetCookie()){const part=value.split(';')[0];if(part.startsWith('geekdash_dev='))cookie=part;if(part.startsWith('geekdash_dev_csrf='))csrf=part.split('=')[1];}
  const data=await response.json();assert.equal(response.status,status,path+': '+JSON.stringify(data));return data;
}
const command=(data,item)=>({expectedBatchVersion:data.batch.version,expectedReviewVersion:item.reviewVersion,expectedVersion:item.expectedVersion,basis:item.basis,selected:item.defaultSelected,idempotencyKey:randomUUID()});
async function upload(fixture){const source=(await api('/api/imports/sources','POST',{name:prefix,idempotencyKey:randomUUID()})).result.sourceNamespace;const result=await api('/api/imports/upload?'+new URLSearchParams({source,name:prefix+'.json',operation:randomUUID()}),'POST',JSON.stringify({version:2,...fixture}),200,true);return api('/api/imports/'+result.result.batchId);}
async function wait(batch){for(let i=0;i<130;i++){const result=await api(`/api/imports/${batch}/executions`);if(result?.status==='finished')return result;await new Promise(r=>setTimeout(r,300));}throw new Error('execution did not finish');}
try{
  const before=await snapshot();await migrateDatabase('test_migrator');const after=await snapshot();for(const [table,rows] of Object.entries(before)){if(table==='import_bindings')assert(rows.every(hash=>after[table].includes(hash)));else assert.deepEqual(after[table],rows,table);}checks.push('增量迁移保留既有业务行与对应，只允许补齐已采用的名称对应；重复迁移无变化');await migrateDatabase('test_migrator');assert.deepEqual(await snapshot(),after);
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix,await hashPassword(password),'持久导入合成验收']);
  await start();await api('/api/auth/login','POST',{loginName:prefix,password});account=(await api('/api/auth/me')).account.id;
  let data=await upload({projects:[{id:1,name:prefix+' A',status:'提案中',chips:[prefix+' chip']},{id:2,name:prefix+' B',status:'提案中'},{id:3,name:prefix+' C',status:'提案中',dueDate:'2026-99-99'}],chips:[{id:1,name:prefix+' chip'},{id:2,name:prefix+' unreferenced'}]});
  const body={idempotencyKey:randomUUID(),items:[...data.items,...data.catalogRows].map(item=>({id:item.id,command:command(data,item),resolveReferences:true}))};
  process.env.GEEKDASH_IMPORT_WRITES='disabled';
  // 接收事务与执行器分开，接收后关闭应用模拟浏览器不再发送任何项目写入。
  delete process.env.GEEKDASH_IMPORT_WRITES;const accepted=await api(`/api/imports/${data.batch.id}/executions`,'POST',body,202);await app.close();
  await start();const result=await wait(data.batch.id);
  assert.equal(result.items.filter(i=>i.kind==='project'&&i.status==='committed').length,2,JSON.stringify(result));assert.equal(result.items.filter(i=>i.kind==='project'&&i.status==='failed').length,1);
  assert.equal(result.items.filter(i=>i.kind!=='project'&&i.status==='committed').length,2);checks.push('整批一次提交、关闭并重启服务后续行；两个项目与全部资料成功，坏日期项目独立失败');
  const replay=await api(`/api/imports/${data.batch.id}/executions`,'POST',body,202);assert.equal(replay.id,accepted.id);
  await api(`/api/imports/${data.batch.id}/executions`,'POST',{...body,items:body.items.slice(1)},409);
  for(const action of ['review','adopt'])await api(`/api/imports/${data.batch.id}/items/${data.items[0].id}/${action}`,'POST',body.items[0].command,410);
  checks.push('同操作重放只有一份执行；改内容复用编号被拒；旧review/adopt入口不写入');
  const project=result.items.find(i=>i.kind==='project'&&i.status==='committed').result.projectId;
  assert((await api('/api/projects?view=all&pageSize=100')).items.some(p=>p.id===project));
  const detail=await api('/api/projects/'+project);assert(detail.project||detail.id);assert.equal((await c.query('SELECT COUNT(*) n FROM project_chips WHERE project_id=?',[project]))[0][0].n,'1');checks.push('新请求首页与详情、独立SQL确认项目与芯片关联已可消费');
  data=await upload({projects:[{id:1,name:prefix+' ACK',status:'提案中'}]});const ackBody={idempotencyKey:randomUUID(),items:data.items.map(item=>({id:item.id,command:command(data,item),resolveReferences:true}))};fault=true;
  await api(`/api/imports/${data.batch.id}/executions`,'POST',ackBody,202);
  for(let i=0;i<70&&!hit;i++)await new Promise(r=>setTimeout(r,100));assert(hit);await app.close();
  await c.execute("UPDATE import_executions SET lease_until=UTC_TIMESTAMP(3)-INTERVAL 1 SECOND WHERE batch_id=? AND status='running'",[data.batch.id]);
  await start();const recovered=await wait(data.batch.id);assert.equal(recovered.items[0].status,'committed');assert.equal((await c.query('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?',[data.items[0].id]))[0][0].n,'1');checks.push('业务COMMIT丢响应并重启按原键恢复，采用/正式项目没有重复');
  await writeFile('test-results/import-executions.json',JSON.stringify({passed:true,verifiedAt:new Date().toISOString(),requests,checks},null,2));console.log(JSON.stringify({passed:true,requests,checks}));
}finally{if(app)await app.close();await c.end();}
