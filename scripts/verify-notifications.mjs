import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {createApp} from '../dist/server/app.js';
import {connectDatabase} from '../dist/server/infrastructure/db.js';
import {openRuntimeDatabase} from '../dist/server/infrastructure/runtime-database.js';
import {hashPassword} from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='notify_'+randomUUID().slice(0,8),password='通知真实验证 临时长短语 2026',users=[],projects=[],streams=[],checks=[];
let app,origin;
function client(){const cookies=new Map();let actor;return {
  async request(path,method='GET',body,signal){
    const headers={'Content-Type':'application/json','X-GeekDash-Request':'1',Origin:'http://localhost',Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),...actor?{'X-GeekDash-Account':actor}:{},...cookies.has('geekdash_dev_csrf')?{'X-GeekDash-CSRF':cookies.get('geekdash_dev_csrf')}: {}};
    const response=await fetch(origin+path,{method,headers,signal,...body?{body:JSON.stringify(body)}:{}});
    for(const item of response.headers.getSetCookie()){const [name,...value]=item.split(';')[0].split('=');cookies.set(name,value.join('='));}return response;
  },
  async api(path,method='GET',body,status=200){const response=await this.request(path,method,body),value=await response.json();assert.equal(response.status,status,path+':'+JSON.stringify(value));return value;},
  async login(index){await this.api('/api/auth/login','POST',{loginName:prefix+index,password});actor=(await this.api('/api/auth/me')).account.id;return actor;}
};}
async function waitFor(predicate,message,milliseconds=10000){const until=Date.now()+milliseconds;while(Date.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error(message);}
async function stream(user,actor,projectId){
  const controller=new AbortController(),instanceId=randomUUID(),events=[];
  const query=new URLSearchParams({accountId:actor,instanceId});if(projectId)query.set('projectId',projectId);
  const response=await user.request('/api/events?'+query,'GET',undefined,controller.signal);
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);assert.equal(response.headers.get('x-accel-buffering'),'no');
  const item={instanceId,events,controller,closed:false};streams.push(item);
  item.done=(async()=>{const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';try{for(;;){const next=await reader.read();if(next.done)break;buffer+=decoder.decode(next.value,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const event=frame.match(/^event: (.+)$/m)?.[1],data=frame.match(/^data: (.+)$/m)?.[1];if(event && data)events.push({event,data:JSON.parse(data)});}}}catch(error){if(!controller.signal.aborted)throw error;}finally{item.closed=true;}})();
  await waitFor(()=>events.some(event=>event.event==='connected'),'SSE连接消息');return item;
}
const lastEditors=(s,projectId)=>s.events.filter(event=>event.event==='editors' && (!projectId || event.data.projectId===projectId)).at(-1)?.data.users;
const editorIds=(s,projectId)=>lastEditors(s,projectId)?.map(user=>user.id).sort();
try{
  for(let i=0;i<2;i++){await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES(?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix+i,await hashPassword(password),'通知验证'+i]);users.push((await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id);}
  const db=await openRuntimeDatabase('test_app');app=await createApp(db,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
  const a=client(),b=client();await a.login(0);await b.login(1);
  const created=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix}}),id=created.result.projectId,path='/api/projects/'+id;projects.push(id);
  await b.api('/api/events?'+new URLSearchParams({accountId:users[1],instanceId:randomUUID(),projectId:id}),'GET',undefined,403);
  async function joinB(){const invite=await a.api(path+'/membership','POST',{action:'invite',targetUserId:users[1],idempotencyKey:randomUUID()});await b.api(path+'/membership','POST',{action:'accept',requestId:invite.result.requestId,idempotencyKey:randomUUID()});}
  await joinB();
  const s1=await stream(a,users[0],id),s2=await stream(a,users[0],id);let sb=await stream(b,users[1],id);
  await waitFor(()=>lastEditors(sb)?.length===0,'只查看不登记编辑');
  await b.api('/api/events?'+new URLSearchParams({accountId:users[0],instanceId:randomUUID(),projectId:id}),'GET',undefined,409);
  const editor=(s,editing)=>({projectId:id,instanceId:s.instanceId,editing});
  await b.api('/api/editing','POST',editor(sb,false));
  const auditBefore=(await c.query('SELECT COUNT(*) n FROM audit_log WHERE project_id=?',[id]))[0][0].n;
  const seenBefore=(await c.query('SELECT token_hash,last_seen_at FROM sessions WHERE user_id=? ORDER BY token_hash',[users[0]]))[0];
  await a.api('/api/editing','POST',editor(s1,true));await a.api('/api/editing','POST',editor(s2,true));
  await waitFor(()=>lastEditors(sb)?.length===1,'同人多标签按人汇总');
  await a.api('/api/editing','POST',editor(s1,false));await waitFor(()=>lastEditors(sb)?.length===1,'另一标签仍在编辑');
  assert.equal((await c.query('SELECT COUNT(*) n FROM audit_log WHERE project_id=?',[id]))[0][0].n,auditBefore);
  assert.deepEqual((await c.query('SELECT token_hash,last_seen_at FROM sessions WHERE user_id=? ORDER BY token_hash',[users[0]]))[0],seenBefore);
  checks.push('PRD9.17：真实Cookie与SSE账号上下文校验；只查看不在场、非负责人拒绝、同账号双标签按人合并；登记不写审计或续会话');
  let home=await stream(b,users[1]);
  await waitFor(()=>editorIds(home,id)?.join()===users[0],'首页无projectId订阅收到既有编辑者快照');
  assert.deepEqual(lastEditors(home,id),[{id:users[0],name:'通知验证0'}]);
  assert.deepEqual(Object.keys(home.events.find(event=>event.event==='editors').data).sort(),['projectId','users']);
  await b.api('/api/editing','POST',editor(sb,true));await waitFor(()=>lastEditors(s1)?.length===2,'两名实际编辑者');
  await waitFor(()=>editorIds(home,id)?.join()===users.slice().sort().join(),'首页收到后续两名编辑者');
  await a.api('/api/editing','POST',editor(s2,false));
  await waitFor(()=>editorIds(home,id)?.join()===users[1],'首页收到明确结束编辑');
  const disconnecting=await stream(a,users[0],id);
  await a.api('/api/editing','POST',editor(disconnecting,true));
  await waitFor(()=>editorIds(home,id)?.join()===users.slice().sort().join(),'断流前首页显示两人');
  disconnecting.controller.abort();await disconnecting.done;
  await waitFor(()=>editorIds(home,id)?.join()===users[1],'编辑者断流后首页清除其名单');
  await a.api('/api/editing','POST',editor(s2,true));
  await waitFor(()=>editorIds(home,id)?.join()===users.slice().sort().join(),'原编辑实例重新登记后首页恢复');
  checks.push('PRD9.17：首页无projectId真实SSE收到已有名单快照、两人变化、明确结束与编辑者断流清除；仅含项目及人员标识，不写业务');
  const before=await a.api(path),operationId=randomUUID();
  const saved=await a.api(path,'PATCH',{expectedVersion:before.project.version,idempotencyKey:operationId,scope:'basic',changes:{name:prefix+'新名称'}});
  await waitFor(()=>sb.events.some(event=>event.event==='project' && event.data.operationId===operationId),'真实提交后通知');
  const message=sb.events.find(event=>event.data.operationId===operationId).data;
  assert.deepEqual(Object.keys(message).sort(),['operationId','projectId','version']);assert.equal(message.version,saved.result.savedVersion);
  assert.equal((await b.api(path)).project.name,prefix+'新名称');assert.equal((await c.query('SELECT name FROM projects WHERE id=?',[id]))[0][0].name,prefix+'新名称');
  const rejected=randomUUID();await b.api(path,'PATCH',{expectedVersion:before.project.version,idempotencyKey:rejected,scope:'status',changes:{statusDesc:'旧版本拒绝'}},409);
  await new Promise(resolve=>setTimeout(resolve,100));assert(!sb.events.some(event=>event.data.operationId===rejected));
  assert(!JSON.stringify(sb.events).includes('旧版本拒绝'));assert(!JSON.stringify(sb.events).includes(prefix+'新名称'));
  checks.push('PRD9.17：保存后真实事件→另一会话新GET→独立SQL；消息只有编号/版本/操作号；冲突拒绝不发提交事件，不泄露字段输入');
  await b.api(path+'/membership','POST',{action:'leave',expectedVersion:saved.result.savedVersion,idempotencyKey:randomUUID()});
  await waitFor(()=>lastEditors(s1)?.length===1,'退出责任后清编辑名单');
  await waitFor(()=>sb.closed&&home.events.some(event=>event.event==='membership'),'退出后详情流关闭、本人首页收到重读通知');
  assert(!(await b.api('/api/projects?view=all')).items.some(item=>item.id===id),'重读后无权项目退出本人卡片');
  await b.api('/api/editing','POST',editor(sb,true),403);
  await b.api(path,'GET',undefined,403);
  home.controller.abort();await home.done;home=await stream(a,users[0]);
  await joinB();sb=await stream(b,users[1],id);
  const second=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'第二项目'}}),secondId=second.result.projectId;projects.push(secondId);
  const homeEditor=await stream(a,users[0]);
  await a.api('/api/editing','POST',editor(s2,false));
  await waitFor(()=>editorIds(home,id)?.length===0,'切项目前结束旧详情实例');
  await a.api('/api/editing','POST',editor(homeEditor,true));
  await waitFor(()=>editorIds(home,id)?.join()===users[0],'首页同实例开始编辑项目A');
  await a.api('/api/editing','POST',{projectId:secondId,instanceId:homeEditor.instanceId,editing:true});
  await waitFor(()=>editorIds(home,id)?.length===0 && editorIds(home,secondId)?.join()===users[0],'同实例切B后A清空、B显示');
  await a.api('/api/editing','POST',editor(homeEditor,false));
  const freshSecond=await stream(a,users[0],secondId);
  await waitFor(()=>editorIds(freshSecond,secondId)?.join()===users[0],'迟到A结束请求后新订阅仍读到B编辑事实');
  assert.equal((await a.api('/api/projects/'+secondId)).project.version,second.result.savedVersion,'切换编辑对象不改项目版本');
  await a.api('/api/editing','POST',{projectId:secondId,instanceId:homeEditor.instanceId,editing:false});
  await waitFor(()=>editorIds(home,secondId)?.length===0 && editorIds(freshSecond,secondId)?.length===0,'明确结束B后首页与详情均清空');
  await a.api('/api/editing','POST',editor(s2,true));
  await waitFor(()=>editorIds(home,id)?.join()===users[0],'恢复A编辑用于退出会话核对');
  checks.push('PRD9.17：首页同一instance从A切B清除A并展示B；迟到A的editing=false不删除B，独立新SSE确认；失权即时清除，编辑切换不改版本');
  await a.api('/api/auth/logout','POST',{});await waitFor(()=>s1.closed && s2.closed,'退出会话关闭全部对应流');
  await waitFor(()=>lastEditors(sb)?.length===0 && home.closed,'退出后其他成员名单清空、本人首页流关闭');assert(s1.events.some(event=>event.event==='identity'));
  checks.push('PRD9.17：退出负责后立即清名单并拒绝续报；退出登录关闭该会话双标签SSE，其他账号名单更新');
  sb.controller.abort();await sb.done;
  const again=await stream(b,users[1],id);assert.deepEqual(lastEditors(again) ?? [],[]);again.controller.abort();await again.done;
  checks.push('PRD9.17：断流后重新建立真实SSE收到连接及当前名单；旧版本写入仍由数据库拒绝');
  const previousEpoch=again.events.find(event=>event.event==='connected').data.epoch;
  await app.close();const restarted=await openRuntimeDatabase('test_app');app=await createApp(restarted,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
  const afterRestart=await stream(b,users[1],id);assert.notEqual(afterRestart.events.find(event=>event.event==='connected').data.epoch,previousEpoch);
  assert.equal((await b.api(path)).project.name,prefix+'新名称');
  await a.login(0);const expiring=await stream(a,users[0],id);
  await c.execute('UPDATE sessions SET absolute_expires_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 SECOND) WHERE user_id=? AND revoked_at IS NULL',[users[0]]);
  const activity=(await c.query('SELECT last_seen_at FROM sessions WHERE user_id=? AND revoked_at IS NULL',[users[0]]))[0];
  await waitFor(()=>expiring.closed,'会话随真实时间到期后自动关闭SSE',20000);
  assert(expiring.events.some(event=>event.event==='unavailable'));
  await a.api('/api/auth/me','GET',undefined,401);
  assert.deepEqual((await c.query('SELECT last_seen_at FROM sessions WHERE user_id=? AND revoked_at IS NULL',[users[0]]))[0],activity);
  checks.push('PRD9.17：缩短合成会话有效期后真实等待自然到期，服务端心跳关闭流，后续请求401；心跳不续会话');
  const nextPassword='通知验证改密后的 长短语 2026';await b.api('/api/auth/password','POST',{currentPassword:password,newPassword:nextPassword,confirmPassword:nextPassword});
  await waitFor(()=>afterRestart.closed,'改密撤销流');assert(afterRestart.events.some(event=>event.event==='identity'));
  checks.push('PRD9.17：关闭并重建应用后SSE进程标识变化、正式数据仍可新读；改密立即撤销原会话并关闭通知流');
  await writeFile('test-results/notifications.json',JSON.stringify({status:'passed',checks,realBrowser:false,publicProxy:false},null,2));console.log(JSON.stringify({status:'passed',checks:checks.length}));
}finally{
  for(const item of streams)item.controller.abort();await Promise.allSettled(streams.map(item=>item.done));if(app)await app.close();
  if(projects.length){for(const table of ['audit_log','project_stages','project_responsibilities','project_people','project_chips','project_tags','project_membership_requests','project_name_aliases'])await c.query(`DELETE FROM ${table} WHERE project_id IN (?)`,[projects]);await c.query('DELETE FROM projects WHERE id IN (?)',[projects]);}
  if(users.length){for(const table of ['audit_log','command_receipts'])await c.query(`DELETE FROM ${table} WHERE actor_id IN (?)`,[users]);await c.query('DELETE FROM sessions WHERE user_id IN (?)',[users]);await c.query('DELETE FROM users WHERE id IN (?)',[users]);}await c.end();
}
