import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { writeFile,readFile } from 'node:fs/promises';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { migrateDatabase } from '../dist/server/infrastructure/schema.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { createApp } from '../dist/server/app.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='real_execution_'+randomUUID().slice(0,8),password=randomUUID()+randomUUID(),checks=[];
let app,runtime,origin,cookie='',csrf='',account='',fault=false,hit=false,requests=0;
const digest=value=>createHash('sha256').update(JSON.stringify(value,(_,v)=>Buffer.isBuffer(v)?v.toString('hex'):v)).digest('hex');
async function snapshot(){const result={};for(const row of(await c.query('SHOW TABLES'))[0]){const name=Object.values(row)[0];if(['schema_migrations','import_executions'].includes(name))continue;const data=(await c.query('SELECT * FROM `'+name+'`'))[0];result[name]=data.map(digest).sort();}return digest(result);}
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
try {
  await migrateDatabase('test_migrator');
  const bytes=await readFile('/real-backup.json');
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'a9adbad91869c244985117e6212821325414dcf8e15c11c89651070c49a5e6f9');
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix,await hashPassword(password),'真实来源隔离验收']);
  const user=(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  await c.execute("INSERT IGNORE INTO system_configuration(id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))",[user,user]);
  await start();await api('/api/auth/login','POST',{loginName:prefix,password});account=(await api('/api/auth/me')).account.id;
  const source=(await api('/api/imports/sources','POST',{name:prefix,idempotencyKey:randomUUID()})).result.sourceNamespace;
  const uploaded=await api('/api/imports/upload?'+new URLSearchParams({source,name:'真实来源隔离验收.json',operation:randomUUID()}),'POST',bytes,200,true);
  const data=await api('/api/imports/'+uploaded.result.batchId);
  assert.equal(data.items.length,35);
  function ready(item,visited=new Set()){
    if(!item.canEdit||item.needsMapping||item.conflictKeys.length||item.previousResult||item.unchanged||visited.has(item.id))return false;
    const next=new Set([...visited,item.id]);
    return item.issues.every(issue=>issue.code==='IMPORT_REFERENCE_REQUIRED'&&(item.unresolvedReferences.filter(ref=>ref.path===issue.path).some(ref=>ref.itemIds.length===1&&ready(data.catalogRows.find(row=>row.id===ref.itemIds[0]),next))));
  }
  const projects=data.items.filter(item=>ready(item)),catalogs=data.catalogRows.filter(item=>item.kind!=='company'&&ready(item));
  assert.equal(projects.length,13);assert.equal(data.items.filter(item=>item.issues.some(issue=>issue.code==='IMPORT_STAGE_STATE_REQUIRED')).length,22);
  const body={idempotencyKey:randomUUID(),items:[...projects,...catalogs].map(item=>({id:item.id,command:command(data,item),resolveReferences:true}))};
  await api(`/api/imports/${data.batch.id}/executions`,'POST',body,202);
  const result=await wait(data.batch.id);assert.equal(result.items.filter(item=>item.kind==='project'&&item.status==='committed').length,13,JSON.stringify(result.items.filter(item=>item.status!=='committed').map(item=>({id:item.id,status:item.status,code:item.code}))));
  assert.equal(result.items.filter(item=>item.kind!=='project'&&item.status==='committed').length,86);
  const after=await api('/api/imports/'+data.batch.id);assert.equal(after.counts.processed,13);assert.equal(after.counts.pending,22);
  const board=await api('/api/projects?view=all&pageSize=100'),summary=await api('/api/project-summary');
  for(const item of after.items.filter(item=>item.previousResult)){
    const id=item.previousResult.projectId;assert(board.items.some(row=>row.id===id));assert(JSON.stringify(summary).includes('"id":"'+id+'"'));
    assert.equal((await api('/api/projects/'+id)).project.id,id);
    assert.equal((await c.query('SELECT COUNT(*) n FROM project_responsibilities WHERE project_id=? AND user_id=?',[id,account]))[0][0].n,'1');
  }
  const again=await api('/api/imports/upload?'+new URLSearchParams({source,name:'再次隔离核对.json',operation:randomUUID(),new:'1'}),'POST',bytes,200,true);
  const compared=await api('/api/imports/'+again.result.batchId);assert.equal(compared.items.filter(item=>item.unchanged||item.keptOnline).length,13);
  checks.push('真实原字节SHA与35项目来源一致','一次提交13个可处理项目及86条完整资料；22个阶段依据未知项目保持未入库','首页、详情、状态简要及独立SQL负责人关系逐项目新读','再次导入可靠对应的13项目识别一致；不猜测其余阶段');
  await writeFile('test-results/import-real-execution.json',JSON.stringify({passed:true,verifiedAt:new Date().toISOString(),requests,counts:{sourceProjects:35,committed:13,awaitingStageChoice:22,catalogs:86},checks},null,2));console.log(JSON.stringify({passed:true,requests,checks}));
}finally{if(app)await app.close();await c.end();}
