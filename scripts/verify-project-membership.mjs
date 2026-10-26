import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';
import { createApp } from '../dist/server/app.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='membership_'+randomUUID().slice(0,8),password='仅隔离验收 password 2026',checks=[],users=[];
const authOrigin='http://localhost';let app,origin,runtime,fault='',requests=0;
const lastId=async()=>String((await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id);
async function fresh(sql,params=[]) {const {connection}=await connectDatabase('test_app');try{return (await connection.query(sql,params))[0];}finally{await connection.end();}}
async function start() {
  runtime=await openRuntimeDatabase('test_app');const write=runtime.writeTransaction;
  runtime.writeTransaction=work=>write(async lease=>{
    const execute=lease.execute,commit=lease.commit;
    lease.execute=function(sql,params){if(fault==='audit'&&sql.startsWith('INSERT INTO audit_log'))return execute.call(this,'INSERT INTO __missing_membership_probe VALUES (1)');return execute.call(this,sql,params);};
    lease.commit=async function(){await commit.call(this);if(fault==='ack')throw Object.assign(new Error('lost ack'),{code:'PROTOCOL_CONNECTION_LOST'});};
    try{return await work(lease);}finally{lease.execute=execute;if(fault!=='ack')lease.commit=commit;}
  });
  app=await createApp(runtime,{origin:authOrigin,secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
}
function client(index) {
  let cookie='',csrf='',id;
  return {
    async api(path,method='GET',body,status=200) {
      const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:authOrigin,'Content-Type':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,...id?{'X-GeekDash-Account':id}:{}},...body===undefined?{}:{body:JSON.stringify(body)}});requests++;
      for(const value of r.headers.getSetCookie()){const part=value.split(';')[0];if(part.startsWith('geekdash_dev='))cookie=part;if(part.startsWith('geekdash_dev_csrf='))csrf=part.split('=')[1];}
      const value=await r.json();if(Array.isArray(status))assert(status.includes(r.status),path+':'+JSON.stringify(value));else assert.equal(r.status,status,path+':'+JSON.stringify(value));
      if(path==='/api/auth/me'&&r.ok)id=value.account.id;return value;
    },
    async login(status=200){await this.api('/api/auth/login','POST',{loginName:users[index].login,password},status);if(status===200)await this.api('/api/auth/me');},
    async stream(projectId) {
      const abort=new AbortController(),events=[],instanceId=randomUUID();
      const response=await fetch(origin+'/api/events?accountId='+id+'&instanceId='+instanceId+(projectId?'&projectId='+projectId:''),{headers:{Cookie:cookie},signal:abort.signal});requests++;assert.equal(response.status,200);
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',closed=false;
      const consuming=(async()=>{try{for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const raw=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const event=raw.match(/^event: (.+)$/m)?.[1],data=raw.match(/^data: (.+)$/m)?.[1];if(event&&data)events.push({event,data:JSON.parse(data)});}}}catch(error){if(!abort.signal.aborted)throw error;}finally{closed=true;}})();
      return {events,instanceId,get closed(){return closed;},async wait(predicate){const end=Date.now()+5000;while(Date.now()<end){if(predicate(events))return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('通知未返回预期结果');},async close(){abort.abort();await consuming;}};
    },
  };
}
const command=(action,extra={})=>({action,idempotencyKey:randomUUID(),...extra});
const route=id=>'/api/projects/'+id+'/membership';
const membership=async id=>(await fresh('SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=? ORDER BY user_id',[id])).map(v=>v.id);
const version=async id=>(await fresh('SELECT CAST(version AS CHAR) version FROM projects WHERE id=?',[id]))[0].version;
async function create(client,name,inviteeIds=[]) {return (await client.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+' '+name,inviteeIds}})).result.projectId;}
try {
  const hash=await hashPassword(password);
  for(let i=0;i<5;i++){const login=prefix+'_'+i;await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[login,hash,'归属合成账号'+i]);users.push({id:await lastId(),login});}
  await c.execute("INSERT INTO system_configuration(id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE maintenance_user_id=VALUES(maintenance_user_id)",[users[4].id,users[4].id]);
  await start();const [a,b,d,e,maint]=[0,1,2,3,4].map(client);await Promise.all([a.login(),b.login(),d.login(),e.login(),maint.login()]);
  const id=await create(a,'创建邀请',[users[1].id]);assert.deepEqual(await membership(id),[users[0].id]);
  assert(!(await b.api('/api/projects?view=all&dashboard=1')).items.some(v=>v.id===id));
  assert(!(await b.api('/api/project-summary')).items.some(v=>v.id===id));
  const space=(await b.api('/api/project-space')).items.find(v=>v.id===id);assert(space);assert.equal(space.member,false);
  assert.deepEqual(Object.keys(space).sort(),['id','name','status','customer','productLine','summary','chips','tags','collaborators','member','unowned','pendingRequest'].sort());
  assert.equal(space.pendingRequest.kind,'invitation');
  for(const path of ['/api/projects/'+id,'/api/projects/'+id+'/audit','/api/projects/'+id+'/checks','/api/projects/'+id+'/deleted-nodes','/api/projects/'+id+'/source-history?kind=mixed','/api/events?accountId='+users[1].id+'&instanceId='+randomUUID()+'&projectId='+id])await b.api(path,'GET',undefined,403);
  const pending=(await b.api('/api/membership-requests')).items.find(v=>v.projectId===id);assert.equal(pending.status,'pending');
  await b.api('/api/projects/'+id,'PATCH',{scope:'status',changes:{statusDesc:'未接受不得写入'},expectedVersion:'1',idempotencyKey:randomUUID()},403);
  const accepted=await b.api(route(id),'POST',command('accept',{requestId:pending.id}));assert.equal(accepted.result.status,'accepted');assert.equal(await version(id),'2');
  assert.deepEqual(await membership(id),users.slice(0,2).map(v=>v.id));
  const personal=await b.api('/api/projects?view=all&dashboard=1');assert(personal.items.some(v=>v.id===id));assert.equal(personal.globalChecks.total,1);assert.equal(personal.stats.total,1);assert.equal((await b.api('/api/project-summary')).items.length,1);
  const saved=await b.api('/api/projects/'+id,'PATCH',{scope:'status',changes:{statusDesc:'接受后的正式保存'},expectedVersion:'2',idempotencyKey:randomUUID()});
  assert.equal(saved.result.savedVersion,'3');assert.equal((await fresh('SELECT status_description text FROM projects WHERE id=?',[id]))[0].text,'接受后的正式保存');
  assert.equal((await a.api('/api/projects/'+id)).project.statusDesc,'接受后的正式保存');
  checks.push('创建者先负责、邀请待接受不授予写权限、接受后正式保存及新请求回读一致');

  const request=(await d.api(route(id),'POST',command('apply'))).result.requestId;
  const again=await d.api(route(id),'POST',command('apply'));assert.equal(again.result.requestId,request);
  const competing=await Promise.all([a.api(route(id),'POST',command('accept',{requestId:request})),b.api(route(id),'POST',command('reject',{requestId:request}))]);
  assert.equal(competing[0].result.status,competing[1].result.status);
  assert.equal((await membership(id)).includes(users[2].id),competing[0].result.status==='accepted');
  const outsider=await create(e,'外部项目');await d.api(route(outsider),'POST',command('invite',{targetUserId:users[0].id}),403);
  await maint.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+' 不应创建'}},403);
  await a.api('/api/accounts','GET',undefined,403);
  checks.push('重复申请复用、两位经理相反决定只生效一次、非成员和维护账号没有业务越权');

  const pair=await create(a,'退出竞争',[users[1].id]);const inv=(await b.api('/api/membership-requests')).items.find(v=>v.projectId===pair);
  await b.api(route(pair),'POST',command('accept',{requestId:inv.id}));
  const leaveA=command('leave',{expectedVersion:await version(pair)}),leaveB=command('leave',{expectedVersion:await version(pair)});
  // 一次提交获胜，另一操作必须因版本变化或最后负责人保护失败。
  const attempts=await Promise.all([a.api(route(pair),'POST',leaveA,[200,409]),b.api(route(pair),'POST',leaveB,[200,409])]);
  assert.equal(attempts.filter(v=>v.outcome==='committed').length,1);assert.equal(attempts.find(v=>v.outcome!=='committed').code,'PROJECT_VERSION_CONFLICT');assert.equal((await membership(pair)).length,1);
  const remaining=(await membership(pair))[0]===users[0].id?a:b;
  assert.equal((await remaining.api(route(pair),'POST',command('leave',{expectedVersion:await version(pair)}),422)).code,'LAST_RESPONSIBLE');
  const left=(await membership(pair))[0]===users[0].id?b:a;await left.api('/api/projects/'+pair,'GET',undefined,403);assert(!(await left.api('/api/project-summary')).items.some(v=>v.id===pair));
  checks.push('并发退出后仍保留一位负责人，退出者个人查询及详情立即收回，最后一人无法退出');

  const atomicName=prefix+' 原子创建';const bad={idempotencyKey:randomUUID(),fields:{name:atomicName,inviteeIds:['99999999']}};
  await a.api('/api/projects','POST',bad,422);assert.equal((await fresh('SELECT id FROM projects WHERE name=?',[atomicName])).length,0);
  await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'创建旧字段',managerIds:[users[1].id]}},409);
  await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:' '+prefix+' 创建邀请 '}},409);
  checks.push('无效邀请整次创建回滚、旧直接赋权命令拒绝、同名创建拒绝');

  const unowned=await create(a,'空间认领');await c.execute('DELETE FROM project_responsibilities WHERE project_id=?',[unowned]);
  const claimed=await Promise.all([a.api(route(unowned),'POST',command('claim'),[200,409]),d.api(route(unowned),'POST',command('claim'),[200,409])]);
  assert.equal(claimed.filter(v=>v.outcome==='committed').length,1);assert.equal(claimed.find(v=>v.outcome!=='committed').code,'PROJECT_ALREADY_OWNED');assert.equal((await membership(unowned)).length,1);
  const claimOwner=(await membership(unowned))[0]===users[0].id?a:d;
  const application=(await e.api(route(unowned),'POST',command('apply'))).result.requestId;
  await e.api(route(unowned),'POST',command('withdraw',{requestId:application}));
  assert.equal((await claimOwner.api(route(unowned),'POST',command('accept',{requestId:application}))).result.status,'withdrawn');
  const reapplied=(await e.api(route(unowned),'POST',command('apply'))).result.requestId;assert.notEqual(reapplied,application);
  await claimOwner.api(route(unowned),'POST',command('reject',{requestId:reapplied}));
  checks.push('同时认领仅一人取得责任，竞争者明确转申请；撤回不可再接受，重新申请使用新请求');

  const live=await create(a,'通知与回执',[users[1].id]);const liveInvite=(await b.api('/api/membership-requests')).items.find(v=>v.projectId===live);
  await b.api(route(live),'POST',command('accept',{requestId:liveInvite.id}));
  const [ownerStream,memberStream,outsiderStream]=await Promise.all([a.stream(),b.stream(live),e.stream()]);
  try {
    await a.api('/api/editing','POST',{projectId:live,instanceId:ownerStream.instanceId,editing:true});
    await memberStream.wait(events=>events.some(v=>v.event==='editors'&&v.data.users.some(u=>u.id===users[0].id)));
    const ordinary={scope:'status',changes:{statusDesc:'只能成员读取的正式说明'},expectedVersion:await version(live),idempotencyKey:randomUUID()};
    await b.api('/api/projects/'+live,'PATCH',ordinary);
    await ownerStream.wait(events=>events.some(v=>v.event==='project'&&v.data.operationId===ordinary.idempotencyKey));
    const afterLeaveInvite=(await b.api(route(live),'POST',command('invite',{targetUserId:users[3].id}))).result.requestId;
    await b.api(route(live),'POST',command('leave',{expectedVersion:await version(live)}));
    await memberStream.wait(events=>events.some(v=>v.event==='unavailable'));
    assert.equal((await fresh('SELECT status FROM project_membership_requests WHERE id=?',[afterLeaveInvite]))[0].status,'invalidated');
    for(const path of ['/api/projects/'+live+'/save-results/query','/api/projects/'+live]) {
      const result=(await b.api(path,path.endsWith('query')?'POST':'PATCH',ordinary)).result;
      assert.equal(result.accessLost,true);assert.deepEqual(result.values,{});assert(!JSON.stringify(result).includes('只能成员读取的正式说明'));
    }
    const barrier=await create(e,'通知边界');await outsiderStream.wait(events=>events.some(v=>v.event==='project'&&v.data.projectId===barrier));
    assert(!outsiderStream.events.some(v=>v.data.projectId===live));
  } finally {await Promise.all([ownerStream.close(),memberStream.close(),outsiderStream.close()]);}
  checks.push('编辑者和项目通知仅发当前成员；退出关闭详情订阅、失效本人邀请；原保存可确认但不泄漏业务快照');

  const rename={scope:'basic',changes:{name:prefix+' 改名后'},expectedVersion:await version(live),idempotencyKey:randomUUID()};
  await a.api('/api/projects/'+live,'PATCH',rename);
  assert.equal(Number((await fresh('SELECT COUNT(*) n FROM project_name_aliases WHERE project_id=? AND name_key=?',[live,Buffer.from(prefix+' 通知与回执')]))[0].n),1);
  const conflict=await a.api('/api/projects/'+live,'PATCH',{...rename,changes:{name:prefix+' 创建邀请'},expectedVersion:await version(live),idempotencyKey:randomUUID()},409);assert.equal(conflict.code,'PROJECT_NAME_TAKEN');assert.equal((await fresh('SELECT name FROM projects WHERE id=?',[live]))[0].name,rename.changes.name);
  checks.push('改名保留原名候选，冲突改名事务回滚并保留原名称');

  const rollbackBefore=(await fresh('SELECT id FROM project_membership_requests WHERE project_id=?',[outsider])).length;
  fault='audit';await e.api(route(outsider),'POST',command('invite',{targetUserId:users[0].id}),503);fault='';
  assert.equal((await fresh('SELECT id FROM project_membership_requests WHERE project_id=?',[outsider])).length,rollbackBefore);
  const uncertain=command('invite',{targetUserId:users[0].id});fault='ack';const unknown=await e.api(route(outsider),'POST',uncertain,503);fault='';assert.equal(unknown.outcome,'unknown');
  await app.close();await start();const recovered=await e.api(route(outsider)+'-results/query','POST',uncertain);assert.equal(recovered.outcome,'committed');
  assert.deepEqual((await e.api(route(outsider),'POST',uncertain)).result,recovered.result);
  assert.equal((await fresh('SELECT id FROM project_membership_requests WHERE project_id=?',[outsider])).length,rollbackBefore+1);
  checks.push('审计失败请求也回滚；提交回包丢失经重启原键恢复，不重复邀请');

  const solo=await create(b,'停用前交接');
  await b.api('/api/projects/'+solo+'/actions','POST',{action:'closeProject',closureType:'terminated',closedOn:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),closureNote:'合成项目终止',remainingWorkNote:'尚未完成阶段不再推进',expectedVersion:await version(solo),idempotencyKey:randomUUID()});
  assert.equal((await fresh('SELECT status FROM projects WHERE id=?',[solo]))[0].status,'closed');
  let impact=await maint.api('/api/accounts/'+users[1].id+'/impact');assert(impact.unhandedProjects.some(v=>v.id===solo));
  const stateBody=v=>({enabled:false,expectedVersion:v.account.version,impactToken:v.impactToken,idempotencyKey:randomUUID()});
  await maint.api('/api/accounts/'+users[1].id+'/state','POST',stateBody(impact),422);
  const toA=(await b.api(route(solo),'POST',command('invite',{targetUserId:users[0].id}))).result.requestId;
  impact=await maint.api('/api/accounts/'+users[1].id+'/impact');await maint.api('/api/accounts/'+users[1].id+'/state','POST',stateBody(impact),422);
  await a.api(route(solo),'POST',command('accept',{requestId:toA}));
  // 若退出竞争留下B单独负责，也先完成真实交接。
  if((await membership(pair))[0]===users[1].id){const r=(await b.api(route(pair),'POST',command('invite',{targetUserId:users[0].id}))).result.requestId;await a.api(route(pair),'POST',command('accept',{requestId:r}));}
  const unresolved=(await b.api(route(solo),'POST',command('invite',{targetUserId:users[3].id}))).result.requestId;
  impact=await maint.api('/api/accounts/'+users[1].id+'/impact');assert.equal(impact.unhandedProjects.length,0);
  const failedDisable=stateBody(impact);fault='audit';await maint.api('/api/accounts/'+users[1].id+'/state','POST',failedDisable,503);fault='';await b.api('/api/auth/me');assert.equal((await fresh('SELECT status FROM project_membership_requests WHERE id=?',[unresolved]))[0].status,'pending');
  const disable=stateBody(impact);const stopped=await maint.api('/api/accounts/'+users[1].id+'/state','POST',disable);assert.equal(stopped.result.enabled,false);
  await b.api('/api/auth/me','GET',undefined,401);await b.login(401);
  assert.equal((await fresh('SELECT status FROM project_membership_requests WHERE id=?',[unresolved]))[0].status,'invalidated');
  assert((await membership(solo)).includes(users[1].id),'停用不删除原负责关系');
  impact=await maint.api('/api/accounts/'+users[1].id+'/impact');await maint.api('/api/accounts/'+users[1].id+'/state','POST',{...stateBody(impact),enabled:true});
  await b.api('/api/auth/me','GET',undefined,401);await b.login();assert.equal((await fresh('SELECT status FROM project_membership_requests WHERE id=?',[unresolved]))[0].status,'invalidated');
  await maint.api('/api/accounts/'+users[4].id+'/impact','GET',undefined,422);
  checks.push('交接含所有项目、未接受邀请不算交接；停用撤会话及未接受邀请，重新启用不恢复旧请求或会话');
  const result={status:'passed',checkedAt:new Date().toISOString(),requests,checks,scope:'隔离数据库真实HTTP与SQL，含空间白名单及个人详情/历史/检查/统计/简要；含实际SSE分发及失权关闭；页面、导入新链仍需专项验收'};
  await writeFile('test-results/project-membership-check.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
} finally {await c.end();if(app)await app.close();}
