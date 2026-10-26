// 只在独立验收库验证0008过渡产物封口、续行及0009读取原结果；保留失败现场。
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {connectDatabase} from '../dist/server/infrastructure/db.js';
import {migrateDatabase} from '../dist/server/infrastructure/schema.js';
import {openRuntimeDatabase} from '../dist/server/infrastructure/runtime-database.js';
import {createApp} from '../dist/server/app.js';
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const oldRoot=process.env.GEEKDASH_DRAIN_BUILD_DIR;assert(oldRoot);
const oldModule=path=>import(pathToFileURL(resolve(oldRoot,'server',path)).href);
const oldSchema=await oldModule('infrastructure/schema.js'),oldRuntime=await oldModule('infrastructure/runtime-database.js'),oldApp=await oldModule('app.js'),oldIdentity=await oldModule('modules/identity.js');
const build=JSON.parse(await readFile(resolve(oldRoot,'build-info.json'),'utf8'));
assert.equal(build.schemaVersion,'0008-import-name-bindings');assert.equal(build.dirty,false);
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='drain_'+randomUUID().slice(0,8),password=randomUUID()+randomUUID(),checks=[];
let app,origin,cookie='',csrf='',account='',requests=0,holdAccepted=false;
async function start(old=true){
  const runtime=await (old?oldRuntime.openRuntimeDatabase:openRuntimeDatabase)('test_app');
  if(old){const write=runtime.writeTransaction;runtime.writeTransaction=work=>write(async conn=>{
    const execute=conn.execute;
    conn.execute=async function(sql,args){const result=await execute.call(this,sql,args);if(holdAccepted&&sql.startsWith('INSERT INTO import_executions'))process.env.GEEKDASH_IMPORT_WRITES='disabled';return result;};
    try{return await work(conn);}finally{conn.execute=execute;}
  });}
  app=await (old?oldApp.createApp:createApp)(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
}
async function api(path,method='GET',body,status=200,raw=false){
  const response=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':raw?'application/octet-stream':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,'X-GeekDash-Account':account},...body===undefined?{}:{body:raw?body:JSON.stringify(body)}});requests++;
  for(const value of response.headers.getSetCookie()){const part=value.split(';')[0];if(part.startsWith('geekdash_dev='))cookie=part;if(part.startsWith('geekdash_dev_csrf='))csrf=part.split('=')[1];}
  const data=await response.json();assert.equal(response.status,status,path+': '+JSON.stringify(data));return data;
}
async function snapshot(tables){const result={};for(const table of tables)if(table.name!=='schema_migrations'){const columns=table.columns.map(v=>'`'+v.name+'`').join(',');const data=(await c.query(`SELECT ${columns} FROM \`${table.name}\``))[0];result[table.name]=data.map(row=>createHash('sha256').update(JSON.stringify(row)).digest('hex')).sort();}return result;}
try{
  await oldSchema.migrateDatabase('test_migrator');
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix,await oldIdentity.hashPassword(password),'过渡产物合成验收']);
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix+'_maint',await oldIdentity.hashPassword(password),'隔离维护账号']);
  const maintenance=(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  await c.execute("INSERT INTO system_configuration(id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))",[maintenance,maintenance]);
  await start();await api('/api/auth/login','POST',{loginName:prefix,password});account=(await api('/api/auth/me')).account.id;
  const recoverUntil=Date.now()+45000;while((await c.query("SELECT id FROM import_executions WHERE status<>'finished'"))[0].length){assert(Date.now()<recoverUntil,'原隔离执行未能恢复，保留现场');await new Promise(resolve=>setTimeout(resolve,300));}
  const source=(await api('/api/imports/sources','POST',{name:prefix,idempotencyKey:randomUUID()})).result.sourceNamespace;
  const uploadPath='/api/imports/upload?'+new URLSearchParams({source,name:prefix+'.json',operation:randomUUID()}),bytes=JSON.stringify({projects:[{id:1,name:prefix+' 甲',status:'提案中'},{id:2,name:prefix+' 乙',status:'提案中'}]});
  const batchId=(await api(uploadPath,'POST',bytes,200,true)).result.batchId,data=await api('/api/imports/'+batchId);
  const body={idempotencyKey:randomUUID(),items:data.items.map(item=>({id:item.id,command:{expectedBatchVersion:data.batch.version,expectedReviewVersion:item.reviewVersion,expectedVersion:item.expectedVersion,basis:item.basis,selected:item.defaultSelected,idempotencyKey:randomUUID()},resolveReferences:true}))};
  holdAccepted=true;const accepted=await api(`/api/imports/${batchId}/executions`,'POST',body,202);
  assert.equal((await c.query('SELECT status FROM import_executions WHERE id=?',[accepted.id]))[0][0].status,'accepted');await app.close();app=undefined;
  holdAccepted=false;process.env.GEEKDASH_IMPORT_ACCEPTING='disabled';delete process.env.GEEKDASH_IMPORT_WRITES;await start();
  await api('/api/imports/sources','POST',{name:'封口后拒绝',idempotencyKey:randomUUID()},503);
  await api(uploadPath,'POST',bytes,503,true);await api(`/api/imports/${batchId}/executions`,'POST',{...body,idempotencyKey:randomUUID()},503);
  let result;const until=Date.now()+15000;do{result=await api(`/api/imports/${batchId}/executions?operation=${body.idempotencyKey}`);if(result?.status==='finished')break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);
  assert.equal(result.status,'finished');assert.equal(result.items.length,2);assert(result.items.every(item=>item.status==='committed'));
  assert.equal((await c.query('SELECT COUNT(*) n FROM import_executions WHERE batch_id=?',[batchId]))[0][0].n,'1');
  checks.push('0008旧命令持久接收后停进程；过渡产物关闭新上传/来源/执行接收，同时旧执行继续并全部提交，原操作查询可用');
  await app.close();app=undefined;
  assert.equal((await c.query("SELECT COUNT(*) n FROM import_executions WHERE status<>'finished'"))[0][0].n,'0');
  const schema=await oldSchema.loadSchema(),before=await snapshot(schema.manifest.tables);
  await migrateDatabase('test_migrator');assert.deepEqual(await snapshot(schema.manifest.tables),before);
  await assert.rejects(()=>oldRuntime.openRuntimeDatabase('test_app'),error=>['DB_SCHEMA_VERSION_UNSUPPORTED','DB_SCHEMA_MISMATCH'].includes(error.code));
  delete process.env.GEEKDASH_IMPORT_ACCEPTING;await start(false);
  const original=await api(`/api/imports/${batchId}/executions?operation=${body.idempotencyKey}`);assert.deepEqual(original,result);
  const replay=await api(`/api/imports/${batchId}/executions`,'POST',body,202);assert.deepEqual(replay,result);
  await api(`/api/imports/${batchId}/executions`,'POST',{...body,idempotencyKey:randomUUID()},410);
  for(const item of result.items)assert.equal((await api('/api/projects/'+item.result.projectId)).project.id,item.result.projectId);
  const current=await api('/api/imports/'+batchId);assert(current.items.every(item=>item.previousResult));
  for(const action of ['review','adopt'])await api(`/api/imports/${batchId}/items/${data.items[0].id}/${action}`,'POST',body.items[0].command,410);
  assert.equal((await c.query('SELECT COUNT(*) n FROM import_adoptions WHERE item_id IN (?)',[data.items.map(item=>item.id)]))[0][0].n,'2');
  checks.push('旧执行全部终态后迁移，38张旧表逐行摘要保持；0008应用拒绝0009；新应用读取及重放原完成结果不重复写入，未接受旧命令返回410');
  await app.close();app=undefined;
  const report={status:'passed',checkedAt:new Date().toISOString(),oldBuild:build,newBuild:JSON.parse(await readFile('dist/build-info.json','utf8')),requests,checks,scope:'隔离验收库演练；未操作线上配置，目标schema兼容回退仍须结合正式构建验证'};
  await writeFile('test-results/import-drain.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(app)await app.close();await c.end();delete process.env.GEEKDASH_IMPORT_ACCEPTING;delete process.env.GEEKDASH_IMPORT_WRITES;}
