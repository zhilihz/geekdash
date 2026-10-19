import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1','仅在独立测试实例执行');
const {connection:c} = await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'draft_'+randomUUID().slice(0,8), password = '个人草稿 test password 2026';
const users=[], projects=[], checks=[];
let app, origin, fault='';
async function start() {
  const runtime=await openRuntimeDatabase('test_app'), write=runtime.writeTransaction;
  runtime.writeTransaction=work=>write(async lease=>{
    const execute=lease.execute, commit=lease.commit;
    lease.execute=function(sql,params){return fault && sql.startsWith(fault) ? execute.call(this,'INSERT INTO __draft_failure VALUES (1)') : execute.call(this,sql,params);};
    lease.commit=async function(){await commit.call(this);if(fault==='ack')throw new Error('lost COMMIT acknowledgement');};
    try{return await work(lease);}finally{lease.execute=execute;if(fault!=='ack')lease.commit=commit;}
  });
  app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
}
function client(){let cookie='',csrf='',account;return {
  async api(path,method='GET',body,expected=200){
    const response=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,...account?{'X-GeekDash-Account':account.id}:{}},...body?{body:JSON.stringify(body)}:{}});
    for(const value of response.headers.getSetCookie()){const part=value.split(';')[0];if(part.startsWith('geekdash_dev='))cookie=part;if(part.startsWith('geekdash_dev_csrf='))csrf=part.split('=')[1];}
    const result=await response.json(); assert.equal(response.status,expected,path+' '+JSON.stringify(result));if(result.account)account=result.account;return result;
  },async login(i){await this.api('/api/auth/login','POST',{loginName:users[i].name,password});await this.api('/api/auth/me');}
};}
const saveDraft=(a,body,status=200)=>a.api('/api/personal/drafts/save','POST',body,status);
const readDraft=async(a,id)=>(await a.api('/api/personal/drafts?clientDraftId='+id)).items[0];
function draft(projectId,baseVersion,formKind,values,instanceId=randomUUID()){
  return {clientDraftId:randomUUID(),projectId,baseVersion,formKind,expectedDraftVersion:'0',clientSequence:'1',payload:{schemaVersion:1,instanceId,values,submission:formKind==='create'?{fields:values}:{scope:formKind,changes:values}}};
}
const ref=row=>({clientDraftId:row.clientDraftId,draftVersion:row.draftVersion});
try{
  for(let i=0;i<2;i++){
    await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix+i,await hashPassword(password),'草稿测试'+i]);
    users.push({id:(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id,name:prefix+i});
  }
  await start();const a=client(),b=client();await a.login(0);await b.login(1);
  const made=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix}}), id=made.result.projectId,path='/api/projects/'+id;projects.push(id);
  const original=await a.api(path), instance=randomUUID();
  let form=draft(id,'1','basic',{name:prefix+' 输入'},instance), saved=await saveDraft(a,form);
  assert.equal(saved.draftVersion,'1');assert.deepEqual((await readDraft(a,form.clientDraftId)).payload,form.payload);
  assert.equal(await readDraft(b,form.clientDraftId),undefined);
  assert.equal((await b.api('/api/personal/drafts/discard','POST',ref(saved),404)).code,'DRAFT_NOT_FOUND');
  assert.deepEqual(await a.api(path),original,'自动底稿不改变正式数据');
  assert.equal((await saveDraft(a,form)).draftVersion,'1','同序号同正文幂等');
  const newer={...form,expectedDraftVersion:'1',clientSequence:'2',payload:{...form.payload,values:{name:prefix+' 新输入'},submission:{scope:'basic',changes:{name:prefix+' 新输入'}}}};
  saved=await saveDraft(a,newer);assert.equal(saved.draftVersion,'2');await saveDraft(a,form,409);
  await saveDraft(a,{...newer,expectedDraftVersion:'2',clientSequence:'3',payload:{...newer.payload,values:{statusDesc:'跨范围'}}},400);
  await saveDraft(a,{...newer,expectedDraftVersion:'2',clientSequence:'3',payload:{...newer.payload,values:{name:'大'.repeat(350000)}}},413);
  assert.equal((await readDraft(a,form.clientDraftId)).draftVersion,'2');
  checks.push('PRD9.15/SPEC007：本人隔离、新请求读回、同序号重放、迟到修订拒绝、范围白名单与UTF8容量；正式项目保持');

  const statusForm=draft(id,'1','status',{statusDesc:'独立区未提交'},instance), statusDraft=await saveDraft(a,statusForm);
  let request={expectedVersion:'1',idempotencyKey:randomUUID(),scope:'basic',changes:newer.payload.values,draft:ref(saved)};
  fault='INSERT INTO command_receipts';assert.equal((await a.api(path,'PATCH',request,500)).outcome,'not_committed');fault='';
  assert.equal((await a.api(path)).project.version,'1');assert.equal((await readDraft(a,form.clientDraftId)).state,'active');
  fault='ack';assert.equal((await a.api(path,'PATCH',request,503)).outcome,'unknown');fault='';
  await app.close();app=undefined;await start();await a.login(0);
  const confirmed=await a.api(path+'/save-results/query','POST',request);assert.equal(confirmed.outcome,'committed');assert.equal(confirmed.result.draft.state,'committed');
  assert.equal((await a.api(path)).project.name,newer.payload.values.name);assert.equal((await readDraft(a,form.clientDraftId)).state,'committed');
  assert.equal((await readDraft(a,statusForm.clientDraftId)).state,'active');
  assert.deepEqual((await a.api(path,'PATCH',request)).result,confirmed.result);
  assert.equal((await saveDraft(a,{...newer,expectedDraftVersion:'2',clientSequence:'3'},409)).code,'DRAFT_TERMINAL');
  await saveDraft(a,{...statusForm,expectedDraftVersion:'1',clientSequence:'2',baseVersion:'2'},409);
  const rebased={...statusForm,expectedDraftVersion:'1',clientSequence:'2',baseVersion:'2',rebaseOperationId:request.idempotencyKey};
  assert.equal((await saveDraft(a,rebased)).baseVersion,'2');
  const foreign=draft(id,'1','status',{statusDesc:'另一标签'});await saveDraft(a,foreign);
  await saveDraft(a,{...foreign,expectedDraftVersion:'1',clientSequence:'2',baseVersion:'2',rebaseOperationId:request.idempotencyKey},409);
  checks.push('PRD9.4/9.15：草稿终结与正式保存同事务回滚、COMMIT丢回应后重启核对、仅对应范围终结、迟到同步拒绝；同页原回执允许重基线，其他标签拒绝');

  const late=draft(id,'2','basic',{summary:'即将保存'}), first=await saveDraft(a,late);
  const later={...late,expectedDraftVersion:'1',clientSequence:'2',payload:{...late.payload,values:{summary:'保存期间继续输入'},submission:{scope:'basic',changes:{summary:'保存期间继续输入'}}}};
  await saveDraft(a,later);
  const lateSave=await a.api(path,'PATCH',{expectedVersion:'2',idempotencyKey:randomUUID(),scope:'basic',changes:late.payload.values,draft:ref(first)});
  assert.equal(lateSave.result.draft.state,'preserved');assert.equal((await readDraft(a,late.clientDraftId)).payload.values.summary,'保存期间继续输入');
  assert.equal((await a.api(path)).project.summary,'即将保存');
  await saveDraft(a,{...later,expectedDraftVersion:'2',clientSequence:'3'});
  await b.api(path+'/responsibility','POST',{expectedVersion:'3',idempotencyKey:randomUUID(),action:'join'});
  await a.api(path+'/responsibility','POST',{expectedVersion:'4',idempotencyKey:randomUUID(),action:'leave'});
  assert.equal((await readDraft(a,late.clientDraftId)).state,'active');
  await saveDraft(a,{...later,expectedDraftVersion:'3',clientSequence:'4'},403);
  const latest=await readDraft(a,late.clientDraftId);await a.api('/api/personal/drafts/discard','POST',ref(latest));
  assert.equal((await readDraft(a,late.clientDraftId)).state,'discarded');await a.api('/api/personal/drafts/discard','POST',ref(latest));
  checks.push('PRD9.6/9.15：正式提交期间较新输入保留；旧基线可同步，退出负责后只读自己的旧稿，明确丢弃可重试');

  const discardedForm=draft(id,'5','status',{statusDesc:'明确放弃的文字'}),discardedRow=await saveDraft(b,discardedForm),beforeDiscard=await b.api(path);
  await b.api('/api/personal/drafts/discard','POST',ref(discardedRow));
  for(const delayed of [discardedForm,{...discardedForm,expectedDraftVersion:'1',clientSequence:'2'}])assert.equal((await saveDraft(b,delayed,409)).code,'DRAFT_TERMINAL');
  const discardedRead=await readDraft(b,discardedForm.clientDraftId);assert.equal(discardedRead.state,'discarded');assert.equal(discardedRead.draftVersion,'1');assert.deepEqual(discardedRead.payload,discardedForm.payload);
  assert.deepEqual(await b.api(path),beforeDiscard,'迟到同步不能修改正式项目');
  const [discardedSql]=await c.execute('SELECT state,CAST(draft_version AS CHAR) version FROM project_drafts WHERE user_id=? AND client_draft_id=?',[users[1].id,discardedForm.clientDraftId]);assert.equal(discardedSql.length,1);assert.equal(discardedSql[0].state,'discarded');assert.equal(discardedSql[0].version,'1');
  checks.push('PRD9.15-10：仍有负责资格的账号丢弃草稿后，原创建重放及新修订迟到同步均DRAFT_TERMINAL；新GET和SQL确认唯一原稿保持终态/内容/版本，正式项目不变');

  const creation=draft(null,null,'create',{name:prefix+' 从底稿创建',statusDesc:'创建状态'}), creationRow=await saveDraft(a,creation);
  const created=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:creation.payload.values,draft:ref(creationRow)});projects.push(created.result.projectId);
  assert.equal(created.result.draft.state,'committed');assert.equal((await readDraft(a,creation.clientDraftId)).state,'committed');
  assert.equal((await a.api('/api/projects/'+created.result.projectId)).project.statusDesc,'创建状态');
  const action={action:'startStage',stageCode:'S1',actualDate:'2026-10-01'};
  const actionForm={...draft(created.result.projectId,'1','action',{}),payload:{schemaVersion:1,instanceId:randomUUID(),command:action,submission:{command:action}}};
  const actionRow=await saveDraft(a,actionForm);
  const acted=await a.api('/api/projects/'+created.result.projectId+'/actions','POST',{...action,expectedVersion:'1',idempotencyKey:randomUUID(),draft:ref(actionRow)});
  assert.equal(acted.result.draft.state,'committed');assert.equal((await readDraft(a,actionForm.clientDraftId)).state,'committed');
  assert.equal((await a.api('/api/projects/'+created.result.projectId)).stages[0].state,'active');
  checks.push('PRD9.5/9.7/9.15：新建及阶段动作底稿与正式写入同事务终结并新请求读取');

  const prefPath='/api/personal/preferences?deviceKey=account&scope=appearance';
  assert.equal((await a.api(prefPath)).version,'0');
  const pref={deviceKey:'account',scope:'appearance',expectedVersion:'0',value:{schemaVersion:1,theme:'warm',layout:'cards'}};
  assert.equal((await a.api('/api/personal/preferences/save','POST',pref)).version,'1');
  assert.equal((await b.api(prefPath)).version,'0');
  await a.api('/api/personal/preferences/save','POST',{...pref,value:{...pref.value,theme:'dark'}},409);
  assert.equal((await a.api(prefPath)).value.theme,'warm');
  await a.api('/api/personal/preferences/save','POST',{...pref,expectedVersion:'1',value:{...pref.value,password:'不允许'}},400);
  for(const value of [{schemaVersion:1,theme:['dark']},{schemaVersion:1,layout:['cards']}])await a.api('/api/personal/preferences/save','POST',{...pref,expectedVersion:'1',value},400);
  const device=randomUUID(), context={deviceKey:device,scope:'board',expectedVersion:'0',value:{schemaVersion:1,page:2,filters:{chip:['1'],search:'搜索'},scrollY:120}};
  await a.api('/api/personal/preferences/save','POST',context);
  for(const value of [{schemaVersion:1,page:-1},{schemaVersion:1,page:'2'},{schemaVersion:1,scrollY:-1},{schemaVersion:1,filtersOpen:'true'},{schemaVersion:1,view:'不存在'}])await a.api('/api/personal/preferences/save','POST',{...context,expectedVersion:'1',value},400);
  const session=client();await session.login(0);
  assert.deepEqual((await session.api('/api/personal/preferences?deviceKey='+device+'&scope=board')).value,context.value);
  assert.equal((await session.api('/api/personal/preferences?deviceKey='+randomUUID()+'&scope=board')).version,'0');
  const summaryPref={deviceKey:device,scope:'summary',expectedVersion:'0',value:{schemaVersion:1,filters:{chip:['1'],owner:['张工']},sort:'chip',rowOrder:['1','2'],hiddenRows:['2']}};
  await a.api('/api/personal/preferences/save','POST',summaryPref);
  for(const value of [{schemaVersion:1,sort:['chip']},{schemaVersion:1,rowOrder:'1'},{schemaVersion:1,hiddenRows:['0']}])await a.api('/api/personal/preferences/save','POST',{...summaryPref,expectedVersion:'1',value},400);
  const summaryLayout={deviceKey:'account',scope:'summary-layout',expectedVersion:'0',value:{schemaVersion:1,columns:['name','chips','chipNote'],hiddenColumns:['chipNote']}};
  await a.api('/api/personal/preferences/save','POST',summaryLayout);
  for(const value of [{schemaVersion:1,columns:'chips'},{schemaVersion:1,hiddenColumns:['secret']}])await a.api('/api/personal/preferences/save','POST',{...summaryLayout,expectedVersion:'1',value},400);
  assert.deepEqual((await session.api('/api/personal/preferences?deviceKey=account&scope=summary-layout')).value,summaryLayout.value);
  checks.push('PRD9.16：偏好与设备位置独立、跨会话恢复、账号隔离、冲突不覆盖、敏感未知键拒绝');

  await c.execute("DELETE FROM project_drafts WHERE user_id=? AND state='active'",[users[0].id]);
  const blank=draft(null,null,'create',{name:'容量底稿'});
  for(let i=0;i<99;i++)await c.execute("INSERT INTO project_drafts (user_id,client_draft_id,form_kind,client_sequence,payload_json,state,created_at,updated_at) VALUES (?,?,'create',1,?,'active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",[users[0].id,randomUUID(),JSON.stringify(blank.payload)]);
  const attempts=await Promise.all([0,1].map(async()=>{try{return await saveDraft(a,{...blank,clientDraftId:randomUUID()});}catch(error){assert.match(error.message,/DRAFT_CAPACITY_REACHED/);return null;}}));
  assert.equal(attempts.filter(Boolean).length,1);assert.equal(Number((await c.query("SELECT COUNT(*) n FROM project_drafts WHERE user_id=? AND state='active'",[users[0].id]))[0][0].n),100);
  checks.push('PRD9.15：剩余一个名额并发创建两稿，恰好一份成功，持久有效稿不超过100');
  await mkdir('test-results',{recursive:true});await writeFile('test-results/personal-state.json',JSON.stringify({status:'passed',checks,browserTested:false},null,2));
  console.log(JSON.stringify({status:'passed',checks:checks.length,evidence:'test-results/personal-state.json'}));
}finally{
  fault='';if(app)await app.close();
  const ids=users.map(u=>u.id);
  if(ids.length)for(const table of ['project_drafts','user_preferences'])await c.query(`DELETE FROM ${table} WHERE user_id IN (?)`,[ids]);
  if(projects.length){for(const table of ['audit_log','project_checks','schedule_changes','project_changes','project_risks','project_nodes','project_stages','project_people','project_chips','project_tags','project_responsibilities'])await c.query(`DELETE FROM ${table} WHERE project_id IN (?)`,[projects]);await c.query('DELETE FROM projects WHERE id IN (?)',[projects]);}
  if(ids.length){for(const table of ['command_receipts','audit_log'])await c.query(`DELETE FROM ${table} WHERE actor_id IN (?)`,[ids]);await c.query('DELETE FROM sessions WHERE user_id IN (?)',[ids]);await c.query('DELETE FROM users WHERE id IN (?)',[ids]);}
  await c.end();
}
