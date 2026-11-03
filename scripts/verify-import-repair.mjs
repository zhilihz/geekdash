import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {connectDatabase} from '../dist/server/infrastructure/db.js';
import {openRuntimeDatabase} from '../dist/server/infrastructure/runtime-database.js';
import {hashPassword} from '../dist/server/modules/identity.js';
import {createApp} from '../dist/server/app.js';
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid id'))[0][0].id,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='repair_'+randomUUID().slice(0,8),password='Repair123!local',checks=[];
let app,origin,cookie='',csrf='',account='',faultName='',loseCommit=false,readFailure='';
const fresh=async(sql,args=[])=>{const {connection:x}=await connectDatabase('test_app');try{return(await x.query(sql,args))[0];}finally{await x.end();}};
async function api(path,method='GET',body,status=200,raw=false){
 const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':raw?'application/octet-stream':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,'X-GeekDash-Account':account},...body===undefined?{}:{body:raw?JSON.stringify(body):JSON.stringify(body)}});
 for(const v of r.headers.getSetCookie()){const p=v.split(';')[0];if(p.startsWith('geekdash_dev='))cookie=p;if(p.startsWith('geekdash_dev_csrf='))csrf=p.split('=')[1];}
 const value=await r.json();assert.equal(r.status,status,path+' '+JSON.stringify(value));return value;
}
const cmd=(b,i,extra={})=>({expectedBatchVersion:b.batch.version,expectedReviewVersion:i.reviewVersion,expectedVersion:i.expectedVersion,basis:i.basis,selected:i.defaultSelected,idempotencyKey:randomUUID(),...extra});
async function upload(payload){return(await api('/api/imports/upload?'+new URLSearchParams({operation:randomUUID(),name:'合成修复验证.json',new:'1'}),'POST',payload,200,true)).result.batchId;}
async function execute(b,items,stage){const body={formatVersion:2,stage,idempotencyKey:randomUUID(),items:items.map(([i,extra])=>({id:i.id,command:cmd(b,i,extra)}))};await api('/api/imports/'+b.batch.id+'/executions','POST',body,202);return await wait(b.batch.id,body.idempotencyKey);}
async function wait(id,key){for(let n=0;n<120;n++){const r=await api('/api/imports/'+id+'/executions?operation='+key);if(['finished','paused'].includes(r.status))return r;await new Promise(resolve=>setTimeout(resolve,100));}assert.fail('执行未结束');}
try{
 await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,is_admin,is_project_manager,created_at,updated_at) VALUES (?,?,?,0,1,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix,await hashPassword(password),prefix]);
 const user=(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
 await c.execute("INSERT IGNORE INTO system_configuration(id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))",[user,user]);
 const runtime=await openRuntimeDatabase('test_app'),write=runtime.writeTransaction,read=runtime.readSnapshot;
 runtime.readSnapshot=async work=>{if(readFailure){const code=readFailure;readFailure='';throw Object.assign(new Error('synthetic read fault'),{code});}return read(work);};
 runtime.writeTransaction=async work=>{
   let leased,original;
   try{return await write(async conn=>{leased=conn;original={execute:conn.execute,query:conn.query,commit:conn.commit};let containsProject=false;
     for(const method of ['execute','query'])conn[method]=async function(sql,args){if(String(sql).startsWith('INSERT INTO projects ')&&args?.includes(faultName))throw Object.assign(new Error('synthetic write interruption'),{code:'PROTOCOL_CONNECTION_LOST'});if(String(sql).startsWith('INSERT INTO projects '))containsProject=true;return original[method].call(this,sql,args);};
     conn.commit=async function(){await original.commit.call(this);if(loseCommit&&containsProject){loseCommit=false;throw Object.assign(new Error('synthetic lost commit acknowledgement'),{code:'PROTOCOL_CONNECTION_LOST'});}};
     return work(conn);
   });}finally{if(leased)Object.assign(leased,original);}
 };
 app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
 await api('/api/auth/login','POST',{loginName:prefix,password});account=(await api('/api/auth/me')).account.id;
 const customer=prefix+'_客户',projectName=prefix+'_项目';
 const source={customers:[{id:1,name:customer,contact:'线上保留'}],projects:[{id:1,name:projectName,status:'提案中',customer:1,summary:'初次简介'}]};
 let id=await upload(source),b=await api('/api/imports/'+id);
 let r=await execute(b,b.catalogRows.map(i=>[i,{}]),'catalogs');assert(r.items.every(i=>i.status==='committed'),JSON.stringify(r));
 assert.equal((await fresh('SELECT id FROM projects WHERE name=?',[projectName])).length,0);
 b=await api('/api/imports/'+id);r=await execute(b,b.items.map(i=>[i,{}]),'projects');assert(r.items.every(i=>i.status==='committed'),JSON.stringify(r));
 const projectId=r.items[0].result.projectId,customerId=(await fresh('SELECT CAST(id AS CHAR) id FROM customers WHERE name=?',[customer]))[0].id;
 assert.equal((await fresh('SELECT CAST(customer_id AS CHAR) id FROM project_customers WHERE project_id=?',[projectId]))[0].id,customerId);
 const options=await api('/api/project-options');assert(options.customers.find(i=>i.id===customerId).version);
 checks.push('资料阶段实际落库但不创建项目，项目阶段引用同一ID；候选含真实版本');
 const backupProject=prefix+'_旧任务时间';
 const oldSource={id:991,name:backupProject,status:'提案中',tasksUpdatedAt:'2026-09-21T10:30:00+08:00',taskUnifiedVersion:1,tasks:[{id:'old',text:'保留这一条',createdAt:'2026-09-20'},{id:'unknown',text:'只有正文'}]};
 let taskBatch=await api('/api/imports/'+await upload({version:2,projects:[oldSource]}));
 const firstTaskImport=await execute(taskBatch,[[taskBatch.items[0],{}]],'projects');assert.equal(firstTaskImport.items[0].status,'committed');
 const importedTaskId=firstTaskImport.items[0].result.projectId,taskPath='/api/projects/'+importedTaskId;
 let taskProject=(await api(taskPath)).project;
 assert.equal(taskProject.contentUpdatedAt,'2026-09-21T02:30:00.000Z');
 assert.deepEqual(taskProject.tasks.map(t=>[t.id,t.createdAt,t.updatedAt]),[['old','2026-09-20',''],['unknown','','']]);
 const legacyText='1、保留这一条\n2、有逐行来源\n3、没有逐行来源';
 taskBatch=await api('/api/imports/'+await upload({projects:[{id:991,name:backupProject,status:'提案中',statusDesc:legacyText,statusDescEntries:[{text:'1、保留这一条',date:'2026-10-01'},{text:'2、有逐行来源',date:'2026-10-02'},{text:'3、没有逐行来源'}]}]}));
 const secondTaskImport=await execute(taskBatch,[[taskBatch.items[0],{}]],'projects');assert.equal(secondTaskImport.items[0].status,'committed',JSON.stringify(secondTaskImport));
 taskProject=(await api(taskPath)).project;
 const oldRows=await fresh('SELECT content text,created_at_text createdAt,updated_at_text updatedAt FROM project_tasks WHERE project_id=? AND deleted_at_text=\'\' ORDER BY sort_order',[importedTaskId]);
 const expectedRows=[['保留这一条','2026-09-20',''],['有逐行来源','','2026-10-02'],['没有逐行来源','','']];
 assert.deepEqual(oldRows.map(t=>[t.text,t.createdAt,t.updatedAt]),expectedRows);
 assert.deepEqual(taskProject.tasks.filter(t=>!t.deletedAt).map(t=>[t.text,t.createdAt,t.updatedAt]),expectedRows);
 checks.push('真实旧备份上传到项目，已知创建和逐行修改日期各自保留，缺日期的任务保持未知；再次采用旧说明不会补上导入时间，独立SQL与新详情一致');
 id=await upload({...source,customers:[{id:1,name:customer,contact:'备份的新内容'}],projects:[{id:1,name:projectName,status:'提案中',customer:1,summary:'更新后的简介'}]});b=await api('/api/imports/'+id);
 const material=b.catalogRows[0];assert.equal(material.targetId,customerId);assert.deepEqual(material.defaultSelected,['binding']);assert.equal(material.needsMapping,false);
 r=await execute(b,[[material,{}]],'catalogs');assert.equal(r.items[0].status,'committed');assert.equal((await fresh('SELECT contact FROM customers WHERE id=?',[customerId]))[0].contact,'线上保留');
 b=await api('/api/imports/'+id);assert(b.items[0].defaultSelected.includes('fields.summary'));r=await execute(b,[[b.items[0],{}]],'projects');assert.equal(r.items[0].status,'committed');
 assert.equal((await api('/api/projects/'+projectId)).project.summary,'更新后的简介');
 b=await api('/api/imports/'+id);const edit=b.catalogRows[0],explicit=cmd(b,edit,{selected:['contact']});const preview=await api(`/api/imports/${id}/items/${edit.id}/preview`,'POST',explicit);assert.equal(preview.canAdopt,true);assert(preview.effects.length);
 r=await execute(b,[[edit,{selected:['contact']}]],'catalogs');assert.equal(r.items[0].status,'committed');assert.equal((await fresh('SELECT contact FROM customers WHERE id=?',[customerId]))[0].contact,'备份的新内容');
 checks.push('同名不同内容默认线上且不挡项目；项目差异默认采用；明确采用资料才更新并预览引用影响');
 // 已处理资料改用另一个线上对象，只更新对应，不覆盖两个公共资料。
 const other=(await api('/api/catalog/customers/save','POST',{id:null,expectedVersion:'0',idempotencyKey:randomUUID(),changes:{name:prefix+'_另一个客户',contact:'不可覆盖'}})).result;
 b=await api('/api/imports/'+id);const former=b.catalogRows[0];
 const mapped=await api(`/api/imports/${id}/items/${former.id}/preview`,'POST',cmd(b,former,{mode:'existing',targetId:other.id,expectedVersion:other.savedVersion,selected:[]}));
 assert(mapped.defaultSelected.includes('binding'));assert(mapped.canAdopt);
 r=await execute(b,[[former,{mode:'existing',targetId:other.id,expectedVersion:other.savedVersion,basis:mapped.basis,selected:['binding']}]],'catalogs');assert.equal(r.items[0].status,'committed',JSON.stringify(r));
 b=await api('/api/imports/'+id);assert.equal(b.catalogRows[0].targetId,other.id);assert.equal(b.items[0].payload.fields.customerIds[0],other.id);
 assert.equal((await fresh('SELECT contact FROM customers WHERE id=?',[other.id]))[0].contact,'不可覆盖');
 checks.push('已保存资料可仅改变对应，新请求的待导入项目使用新对应，公共资料内容不被覆盖');
 let p=(await api('/api/projects/'+projectId)).project;await api(`/api/projects/${projectId}/delete`,'POST',{expectedVersion:p.version,idempotencyKey:randomUUID()});
 b=await api('/api/imports/'+id);assert.equal(b.items[0].targetDeleted,true);assert.equal(b.items[0].targetId,projectId);assert.equal(b.items[0].canAdopt,false);
 const oldNew=await api(`/api/imports/${id}/items/${b.items[0].id}/preview`,'POST',cmd(b,b.items[0],{mode:'new',targetId:null,expectedVersion:'0'}));
 assert.equal(oldNew.targetDeleted,true);assert.equal(oldNew.targetId,projectId);assert.equal(oldNew.deletedVersion,b.items[0].deletedVersion);assert(oldNew.issues.some(issue=>issue.code==='PROJECT_DELETED'));
 await c.execute("UPDATE import_items SET validation_json=JSON_SET(validation_json,'$.choice',JSON_OBJECT('mode','new','targetId',NULL)) WHERE id=?",[b.items[0].id]);
 b=await api('/api/imports/'+id);assert.equal(b.items[0].targetDeleted,true);assert.equal(b.items[0].targetId,projectId);
 checks.push('旧新建选择和持久mode=new均不能掩盖同名已删除项目，返回原ID、版本及恢复提示');
 await c.execute("UPDATE import_items SET validation_json=JSON_SET(validation_json,'$.choice',JSON_OBJECT('mode','existing','targetId',?)) WHERE id=?",[projectId,b.items[0].id]);
 const restore={expectedVersion:b.items[0].deletedVersion,idempotencyKey:randomUUID()};await api(`/api/projects/${projectId}/restore`,'POST',restore);await api(`/api/projects/${projectId}/restore`,'POST',restore);
 b=await api('/api/imports/'+id);assert.equal(b.items[0].targetDeleted,false);assert.equal(b.items[0].targetId,projectId);assert.equal((await fresh('SELECT id FROM projects WHERE name=?',[projectName])).length,1);
 checks.push('已处理旧批次重读识别已删除，恢复沿原ID且幂等，不因旧成功结果创建副本');
 // 已删除资料原处恢复；已明确不使用的标签从客户关联移除。
 const tagName=prefix+'_无需标签',tag=(await api('/api/catalog/tags/save','POST',{id:null,expectedVersion:'0',idempotencyKey:randomUUID(),changes:{name:tagName}})).result;
 const disableTag={id:tag.id,expectedVersion:tag.savedVersion,idempotencyKey:randomUUID(),changes:{enabled:false}};
 await api('/api/catalog/tags/save','POST',{...disableTag,impactToken:(await api('/api/catalog/tags/preview','POST',disableTag)).impactToken});
 id=await upload({tags:[{id:1,name:tagName}],customers:[{id:1,name:prefix+'_忽略标签客户',tags:[1]}],projects:[{id:1,name:prefix+'_忽略标签项目',status:'提案中',customer:1}]});b=await api('/api/imports/'+id);
 const ignored=b.catalogRows.find(i=>i.kind==='tags');assert(ignored.issues.some(i=>i.code==='IMPORT_MAPPING_REQUIRED'||i.code==='CATALOG_DISABLED'));
 await api(`/api/imports/${id}/items/${ignored.id}/ignore`,'POST',{expectedBatchVersion:b.batch.version,expectedReviewVersion:ignored.reviewVersion,idempotencyKey:randomUUID(),ignored:true});
 b=await api('/api/imports/'+id);const remaining=b.catalogRows.find(i=>i.kind==='customers');assert.deepEqual(remaining.payload.tagIds,[]);assert(!remaining.issues.some(i=>i.code==='IMPORT_REFERENCE_REQUIRED'));
 r=await execute(b,[[remaining,{}]],'catalogs');assert.equal(r.items[0].status,'committed',JSON.stringify(r));b=await api('/api/imports/'+id);r=await execute(b,b.items.map(i=>[i,{}]),'projects');assert.equal(r.items[0].status,'committed',JSON.stringify(r));
 assert.equal((await fresh('SELECT * FROM customer_tags WHERE customer_id=?',[b.catalogRows.find(i=>i.kind==='customers').targetId])).length,0);
 // 再次核对同一个删除标签，使用现有恢复接口且不改原资料内容。
 const tagRow=(await api('/api/catalog/tags')).items.find(i=>i.id===tag.id);
 const restoreTag={id:tag.id,expectedVersion:tagRow.version,idempotencyKey:randomUUID(),changes:{enabled:true}};
 const restored=await api('/api/catalog/tags/save','POST',{...restoreTag,impactToken:(await api('/api/catalog/tags/preview','POST',restoreTag)).impactToken});assert.equal(restored.result.id,tag.id);
 checks.push('不使用已删除标签后，客户与项目仍可入库；恢复资料沿原ID且不覆盖内容');
 const oldRequest={formatVersion:2,idempotencyKey:randomUUID(),items:[{id:b.items[0].id,command:cmd(b,b.items[0])}]};
 assert.equal((await api(`/api/imports/${id}/executions`,'POST',oldRequest,410)).code,'IMPORT_CLIENT_OUTDATED');
 checks.push('新受理必须明确资料或项目步骤，旧混合入口不会继续生效');
 const interrupted=prefix+'_中断',independent=prefix+'_独立';id=await upload({projects:[{id:1,name:interrupted,status:'提案中'},{id:2,name:independent,status:'提案中'}]});b=await api('/api/imports/'+id);faultName=interrupted;r=await execute(b,b.items.map(i=>[i,{}]),'projects');assert.equal(r.status,'paused');assert.equal(r.items[0].status,'confirming');assert.equal(r.items[1].status,'committed');assert.equal((await fresh('SELECT id FROM projects WHERE name=?',[interrupted])).length,0);
 const serverState=await api(`/api/imports/${id}/executions`);assert(serverState.unfinished.some(v=>v.operationId===r.operationId&&v.canResume));
 faultName='';await api(`/api/imports/${id}/executions/${r.operationId}/resume`,'POST',{});r=await wait(id,r.operationId);assert(r.items.every(i=>i.status==='committed'),JSON.stringify(r));assert.equal((await fresh('SELECT id FROM projects WHERE name IN (?,?)',[interrupted,independent])).length,2);
 checks.push('单项保存中断不饿死独立项目；暂停有可继续入口，沿原编号正文恢复且不重复');
 id=await upload({projects:[{id:1,name:prefix+'_丢响应',status:'提案中'}]});b=await api('/api/imports/'+id);loseCommit=true;r=await execute(b,b.items.map(i=>[i,{}]),'projects');assert.equal(r.status,'paused');assert.equal((await fresh('SELECT id FROM projects WHERE name=?',[prefix+'_丢响应'])).length,1);await api(`/api/imports/${id}/executions/${r.operationId}/resume`,'POST',{});r=await wait(id,r.operationId);assert.equal(r.items[0].status,'committed');assert.equal((await fresh('SELECT id FROM projects WHERE name=?',[prefix+'_丢响应'])).length,1);
 checks.push('COMMIT后丢响应通过原回执继续，数据库只一个项目');
 for(const [code,expected]of [['ER_BAD_FIELD_ERROR','DATABASE_SCHEMA_INCOMPATIBLE'],['ER_TABLEACCESS_DENIED_ERROR','DATABASE_PERMISSION_DENIED'],['EACCES','IMPORT_STORAGE_UNAVAILABLE'],['ECONNREFUSED','DATABASE_UNAVAILABLE']]){
   readFailure=code;const failure=await api('/api/project-options','GET',undefined,503);assert.equal(failure.code,expected);assert(failure.requestId);
 }
 checks.push('故障注入区分结构、权限、文件写入与连接问题；HTTP保留可追查请求编号');
 await mkdir('test-results',{recursive:true});await writeFile('test-results/import-repair.json',JSON.stringify({status:'passed',checks,userBrowserTested:false},null,2));console.log(JSON.stringify({status:'passed',checks}));
}finally{if(app)await app.close();await c.end();}
