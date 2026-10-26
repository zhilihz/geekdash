// 只在隔离库演练同结构产物只读恢复；不回退任何已提交业务。
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {connectDatabase} from '../dist/server/infrastructure/db.js';
import {openRuntimeDatabase} from '../dist/server/infrastructure/runtime-database.js';
import {hashPassword} from '../dist/server/modules/identity.js';
import {createApp} from '../dist/server/app.js';
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='recovery_'+randomUUID().slice(0,8),password=randomUUID()+randomUUID();
let app,origin,cookie='',csrf='',account='',requests=0,holdAccepted=false;
async function start(){
  const runtime=await openRuntimeDatabase('test_app'),write=runtime.writeTransaction;
  runtime.writeTransaction=work=>write(async conn=>{const execute=conn.execute;conn.execute=async function(sql,args){const result=await execute.call(this,sql,args);if(holdAccepted&&sql.startsWith('INSERT INTO import_executions'))process.env.GEEKDASH_IMPORT_WRITES='disabled';return result;};try{return await work(conn);}finally{conn.execute=execute;}});
  app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
}
async function api(path,method='GET',body,status=200,raw=false){
  const response=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':raw?'application/octet-stream':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,'X-GeekDash-Account':account},...body===undefined?{}:{body:raw?body:JSON.stringify(body)}});requests++;
  for(const value of response.headers.getSetCookie()){const part=value.split(';')[0];if(part.startsWith('geekdash_dev='))cookie=part;if(part.startsWith('geekdash_dev_csrf='))csrf=part.split('=')[1];}
  const data=await response.json();assert.equal(response.status,status,path+': '+JSON.stringify(data));return data;
}
async function login(){await api('/api/auth/login','POST',{loginName:prefix,password});account=(await api('/api/auth/me')).account.id;}
try{
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix,await hashPassword(password),'只读恢复合成账号']);
  await start();await login();
  const create={idempotencyKey:randomUUID(),fields:{name:prefix+' 原成果'}},created=await api('/api/projects','POST',create),id=created.result.projectId;
  const original=await api('/api/projects/'+id),history=await api('/api/projects/'+id+'/audit');
  const bytes=JSON.stringify({projects:[{name:prefix+' 待完成任务'}]}),upload='/api/imports/upload?'+new URLSearchParams({name:prefix+'.json',operation:randomUUID()});
  const batchId=(await api(upload,'POST',bytes,200,true)).result.batchId,data=await api('/api/imports/'+batchId);
  const body={formatVersion:2,idempotencyKey:randomUUID(),items:data.items.map(item=>({id:item.id,command:{expectedBatchVersion:data.batch.version,expectedReviewVersion:item.reviewVersion,expectedVersion:item.expectedVersion,basis:item.basis,selected:item.defaultSelected,idempotencyKey:randomUUID()},resolveReferences:true}))};
  holdAccepted=true;const accepted=await api(`/api/imports/${batchId}/executions`,'POST',body,202);await app.close();app=undefined;
  holdAccepted=false;delete process.env.GEEKDASH_IMPORT_WRITES;process.env.GEEKDASH_BUSINESS_WRITES='disabled';await start();await login();
  assert.equal((await api('/api/health/ready')).status,'ready');
  assert.deepEqual((await api('/api/projects/'+id)).project,original.project);assert.deepEqual(await api('/api/projects/'+id+'/audit'),history);
  assert.deepEqual((await api('/api/projects/create-results/query','POST',create)).result,created.result);
  for(const [path,method,value,raw] of [['/api/projects','POST',create],['/api/projects/'+id,'PATCH',{}],['/api/projects/'+id+'/membership','POST',{}],['/api/personal/drafts/save','POST',{}],['/api/accounts/1/state','POST',{}],[upload,'POST',bytes,true],[`/api/imports/${batchId}/executions`,'POST',body]]){
    const result=await api(path,method,value,503,raw);assert.equal(result.code,'BUSINESS_WRITES_PAUSED');assert.equal(result.outcome,'not_committed');
  }
  await new Promise(resolve=>setTimeout(resolve,1200));assert.equal((await api(`/api/imports/${batchId}/executions?operation=${body.idempotencyKey}`)).status,'accepted');
  assert.equal((await c.query('SELECT COUNT(*) n FROM projects WHERE name=?',[prefix+' 待完成任务']))[0][0].n,'0');
  await api('/api/auth/logout','POST',{});await app.close();app=undefined;delete process.env.GEEKDASH_BUSINESS_WRITES;await start();await login();
  let result;const until=Date.now()+15000;do{result=await api(`/api/imports/${batchId}/executions?operation=${body.idempotencyKey}`);if(result.status==='finished')break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);
  assert.equal(result.status,'finished');assert(result.items.every(item=>item.status==='committed'));assert.equal(result.id,accepted.id);
  assert.equal((await c.query('SELECT COUNT(*) n FROM projects WHERE name=?',[prefix+' 待完成任务']))[0][0].n,'1');
  const saved=await api('/api/projects/'+id,'PATCH',{scope:'basic',expectedVersion:original.project.version,idempotencyKey:randomUUID(),changes:{name:prefix+' 恢复写入'}});
  assert.equal((await api('/api/projects/'+id)).project.name,prefix+' 恢复写入');assert.equal(saved.outcome,'committed');
  const report={status:'passed',checkedAt:new Date().toISOString(),build:JSON.parse(await readFile('dist/build-info.json','utf8')),requests,checks:['0009兼容产物重启为只读：健康、登录、原详情/历史和原成功回执可用；创建、保存、归属、草稿、账号及导入写入明确未提交','只读期间持久任务保持accepted无项目；恢复同结构写入后原任务仅提交一次，原项目继续保存并由新请求回读'],scope:'隔离MySQL演练，未改变线上配置'};
  await writeFile('test-results/write-recovery.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(app)await app.close();await c.end();delete process.env.GEEKDASH_BUSINESS_WRITES;delete process.env.GEEKDASH_IMPORT_WRITES;}
