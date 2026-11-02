import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { createApp } from '../dist/server/app.js';
import { hashPassword } from '../dist/server/modules/identity.js';

// 本轮独立测试库。真实项目库及用户浏览器不参与。
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid id'))[0][0].id,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='recovery_'+randomUUID().slice(0,8),password='Test123!recovery',checks=[];
let app,origin;
function client(){
  let cookie='',csrf='',account;
  return {async api(path,method='GET',body,expected=200){
    const response=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,...account?{'X-GeekDash-Account':account.id}:{}},...body?{body:JSON.stringify(body)}:{}});
    for(const value of response.headers.getSetCookie()){const part=value.split(';')[0];if(part.startsWith('geekdash_dev='))cookie=part;if(part.startsWith('geekdash_dev_csrf='))csrf=part.split('=')[1];}
    const result=await response.json();assert.equal(response.status,expected,path+':'+JSON.stringify(result));
    if(path==='/api/auth/me')account=result.account;return result;
  },async login(loginName){await this.api('/api/auth/login','POST',{loginName,password});return this.api('/api/auth/me');}};
}
async function fresh(sql,params=[]){const {connection}=await connectDatabase('test_app');try{return (await connection.query(sql,params))[0];}finally{await connection.end();}}
const command=expectedVersion=>({expectedVersion,idempotencyKey:randomUUID()});
try{
  const hash=await hashPassword(password),users=[];
  for(const [role,admin,manager] of [['admin',1,0],['owner',0,1],['other',0,1],['dual',1,1]]){
    const login=prefix+'_'+role;
    await c.execute('INSERT INTO users(login_name,password_hash,display_name,is_admin,is_project_manager,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[login,hash,role,admin,manager]);
    users.push({login,id:String((await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id)});
  }
  await c.execute("INSERT IGNORE INTO system_configuration(id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))",[users[0].id,users[0].id]);
  app=await createApp(await openRuntimeDatabase('test_app'),{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
  const [admin,owner,other,dual]=users.map(()=>client());
  await Promise.all([admin,owner,other,dual].map((api,i)=>api.login(users[i].login)));
  const create=async(api,name)=>(await api.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name}})).result;
  const original=await create(owner,prefix+'保留名称'),id=original.projectId;
  const detail=await owner.api('/api/projects/'+id);
  const task={op:'add',id:randomUUID(),text:'恢复后仍存在的任务'};
  const saved=await owner.api('/api/projects/'+id,'PATCH',{scope:'status',expectedVersion:detail.project.version,idempotencyKey:randomUUID(),changes:{taskOps:[task]}});
  const before=(await fresh('SELECT name_key,status_description description FROM projects WHERE id=?',[id]))[0];
  await other.api(`/api/projects/${id}/delete`,'POST',command(saved.result.savedVersion),403);
  const removal=command(saved.result.savedVersion);
  const removed=await admin.api(`/api/projects/${id}/delete`,'POST',removal);
  assert.equal(removed.result.deleted,true);
  const afterDelete=(await fresh('SELECT name_key,deleted_at FROM projects WHERE id=?',[id]))[0];
  assert(afterDelete.deleted_at);assert.deepEqual(afterDelete.name_key,before.name_key);
  assert(!(await owner.api('/api/projects?view=all')).items.some(item=>item.id===id));
  assert(!(await admin.api('/api/projects/tasks-summary?perspective=management')).items.some(item=>item.id===id));
  const history=(await other.api('/api/project-space?view=history&search='+encodeURIComponent(prefix))).items;
  assert.equal(history.find(item=>item.id===id).name,prefix+'保留名称');
  await other.api(`/api/projects/${id}/restore`,'POST',command(removed.result.savedVersion),403);
  assert.equal((await owner.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'保留名称'}},409)).code,'PROJECT_NAME_TAKEN');
  const restoration=command(removed.result.savedVersion);
  const restored=await admin.api(`/api/projects/${id}/restore`,'POST',restoration);
  assert.equal(restored.result.deleted,false);assert.equal(restored.result.unowned,false);
  assert.deepEqual((await admin.api(`/api/projects/${id}/restore`,'POST',restoration)).result,restored.result);
  assert.deepEqual((await admin.api(`/api/projects/${id}/restore-results/query`,'POST',restoration)).result,restored.result);
  const readback=await owner.api('/api/projects/'+id);
  assert.equal(readback.project.version,restored.result.savedVersion);assert.equal(readback.project.name,prefix+'保留名称');
  assert(readback.project.tasks.some(t=>t.id===task.id&&t.text===task.text));
  assert.equal(readback.readOnly,false);assert.equal((await admin.api('/api/projects/'+id)).readOnly,true);
  assert.equal(readback.responsible.find(user=>user.id===users[1].id).enabled,true);
  assert.equal(readback.project.managers.find(user=>user.id===users[1].id).enabled,true);
  assert.equal((await fresh("SELECT COUNT(*) n FROM audit_log WHERE project_id=? AND action='project.restore'",[id]))[0].n,'1');
  assert.deepEqual((await fresh('SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=?',[id])).map(v=>v.id),[users[1].id]);
  checks.push('删除保留名称；历史列表与正式列表分离；恢复保留ID、任务和责任；重复恢复只有一次历史；普通账号不可恢复');

  const ownTasks=await owner.api('/api/projects/tasks-summary?perspective=responsible');assert(ownTasks.items.find(v=>v.id===id));
  assert(!(await other.api('/api/projects/tasks-summary?perspective=management')).items.some(v=>v.id===id),'业务账号伪造管理视角不扩大范围');
  assert(!(await dual.api('/api/projects/tasks-summary')).items.some(v=>v.id===id),'双身份默认负责视角');
  assert((await dual.api('/api/projects/tasks-summary?perspective=management')).items.some(v=>v.id===id));
  const complete=await owner.api('/api/projects/'+id,'PATCH',{scope:'status',expectedVersion:restored.result.savedVersion,idempotencyKey:randomUUID(),changes:{taskOps:[{op:'complete',id:task.id}]}});
  assert(!(await owner.api('/api/projects/tasks-summary')).items.some(v=>v.id===id));
  checks.push('未完成任务按实际身份范围汇总；完成任务后新请求消失；外部业务账号不能扩大管理范围');

  const deletedAgain=await admin.api(`/api/projects/${id}/delete`,'POST',command(complete.result.savedVersion));
  // 模拟项目删除期间旧经理失去资格：原责任记录保留，但恢复不能恢复写权限。
  await c.execute('UPDATE users SET is_project_manager=0 WHERE id=?',[users[1].id]);
  const unowned=await admin.api(`/api/projects/${id}/restore`,'POST',command(deletedAgain.result.savedVersion));
  assert.equal(unowned.result.unowned,true);
  const space=(await other.api('/api/project-space?search='+encodeURIComponent(prefix))).items.find(v=>v.id===id);assert(space.unowned);assert.equal(space.member,false);
  await owner.api('/api/projects/'+id,'GET',undefined,403);
  await other.api(`/api/projects/${id}/membership`,'POST',{action:'join',idempotencyKey:randomUUID()});
  assert.equal((await other.api('/api/projects/'+id)).readOnly,false);
  assert.equal((await admin.api('/api/projects/'+id)).readOnly,true);
  checks.push('恢复时没有有效经理则待加入；旧失效资格不授予写权限；明确加入后可管理');

  const dualOwned=await create(dual,prefix+'管理员旧责任');
  await c.execute('UPDATE users SET is_project_manager=0 WHERE id=?',[users[3].id]);
  const inactiveDetail=await dual.api('/api/projects/'+dualOwned.projectId);
  assert.equal(inactiveDetail.readOnly,true);assert.equal(inactiveDetail.capabilities.leave,false);
  assert.equal(inactiveDetail.responsible.find(user=>user.id===users[3].id).enabled,false);
  assert.equal(inactiveDetail.project.managers.find(user=>user.id===users[3].id).enabled,false);
  const inactiveSpace=(await dual.api('/api/project-space?search='+encodeURIComponent(prefix+'管理员旧责任'))).items[0];
  assert.equal(inactiveSpace.member,false);assert.equal(inactiveSpace.unowned,true);
  const inactiveList=(await dual.api('/api/projects?view=all&perspective=management')).items.find(item=>item.id===dualOwned.projectId);
  assert.equal(inactiveList.managers.find(user=>user.id===users[3].id).enabled,false);
  const collaborators=(await other.api('/api/project-space?search='+encodeURIComponent(prefix+'保留名称'))).items[0].collaborators;
  assert.equal(collaborators.find(user=>user.id===users[1].id).enabled,false);
  checks.push('SQL资格表达式显式转布尔；管理员取消经理资格后详情只读、空间待加入，列表及协作者不把字符串0当启用');
  console.log(JSON.stringify({status:'passed',scope:'隔离数据库/API，不代表真实页面验收',checks}));
}finally{await app?.close();await c.end();}
