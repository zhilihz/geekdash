import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createApp} from '../dist/server/app.js';
import {connectDatabase} from '../dist/server/infrastructure/db.js';
import {openRuntimeDatabase} from '../dist/server/infrastructure/runtime-database.js';
import {hashPassword} from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1','只允许隔离验证实例');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='panel_task_'+randomUUID().slice(0,8),password='Card tasks test 2026!',users=[],projects=[],checks=[];
let app,origin,runtime,loseAck=false;
async function start(){
 runtime=await openRuntimeDatabase('test_app');const write=runtime.writeTransaction;
 runtime.writeTransaction=work=>write(async lease=>{const commit=lease.commit;lease.commit=async function(){await commit.call(this);if(loseAck)throw Object.assign(new Error('lost task acknowledgement'),{code:'PROTOCOL_CONNECTION_LOST'});};return work(lease);});
 app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
}
function client(){let cookie='',csrf='',actor;return {async api(path,method='GET',body,status=200){const response=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,...actor?{'X-GeekDash-Account':actor.id}:{}},...body?{body:JSON.stringify(body)}:{}});for(const value of response.headers.getSetCookie()){const part=value.split(';')[0];if(part.startsWith('geekdash_dev='))cookie=part;if(part.startsWith('geekdash_dev_csrf='))csrf=part.split('=')[1];}const data=await response.json();assert.equal(response.status,status,path+' '+JSON.stringify(data));if(data.account)actor=data.account;return data;},async login(index){await this.api('/api/auth/login','POST',{loginName:users[index].login,password});await this.api('/api/auth/me');}};}
async function sqlTasks(id){const {connection}=await connectDatabase('test_app');try{return (await connection.execute('SELECT task_key,content,completed_at_text,deleted_at_text FROM project_tasks WHERE project_id=? ORDER BY sort_order',[id]))[0];}finally{await connection.end();}}
try{
 for(let i=0;i<2;i++){const login=prefix+i;await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,is_admin,is_project_manager,created_at,updated_at) VALUES (?,?,?,0,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[login,await hashPassword(password),login,i===0?1:0]);users.push({id:(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id,login});}
 await start();const a=client(),b=client();await a.login(0);await b.login(1);
 const created=await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix}}),id=created.result.projectId,path='/api/projects/'+id;projects.push(id);
 const other=(await b.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'_other'}})).result.projectId;projects.push(other);
 let version=(await a.api(path)).project.version;
 const taskA=randomUUID(),taskB=randomUUID(),request=ops=>({expectedVersion:version,idempotencyKey:randomUUID(),scope:'status',changes:{taskOps:ops}});
 const saved=await a.api(path,'PATCH',request([{op:'add',id:taskA,text:'核对图纸'},{op:'add',id:taskB,text:'安排发货'}]));version=saved.result.savedVersion;
 const direct=request([{op:'edit',id:taskA,text:'核对第二版图纸'}]);const edited=await a.api(path,'PATCH',direct);version=edited.result.savedVersion;
 let fresh=await a.api(path);assert.equal(fresh.project.tasks.find(t=>t.id===taskA).text,'核对第二版图纸');assert.equal(fresh.project.tasks.find(t=>t.id===taskB).text,'安排发货');assert.equal((await sqlTasks(id)).find(t=>t.task_key===taskA).content,'核对第二版图纸');
 const countBefore=(await c.execute('SELECT COUNT(*) n FROM audit_log WHERE project_id=?',[id]))[0][0].n;
 assert.deepEqual((await a.api(path,'PATCH',direct)).result,edited.result);assert.equal((await c.execute('SELECT COUNT(*) n FROM audit_log WHERE project_id=?',[id]))[0][0].n,countBefore);
 checks.push('TK01/02：单条编辑持久化、新GET与SQL回读，另一任务保持，原请求重放不重复历史');
 const foreign={...request([{op:'edit',id:taskA,text:'无权覆盖'}]),expectedVersion:version};await b.api(path,'PATCH',foreign,403);
 const stale=request([{op:'edit',id:taskB,text:'不应覆盖'}]);const complete=request([{op:'complete',id:taskA}]);loseAck=true;const unknown=await a.api(path,'PATCH',complete,503);loseAck=false;assert.equal(unknown.outcome,'unknown');
 await app.close();app=undefined;await start();await a.login(0);await b.login(1);
 const receipt=await a.api(path+'/save-results/query','POST',complete);assert.equal(receipt.outcome,'committed');version=receipt.result.savedVersion;
 assert.deepEqual((await a.api(path,'PATCH',complete)).result,receipt.result);
 await a.api(path,'PATCH',stale,409);
 fresh=await a.api(path);assert(fresh.project.tasks.find(t=>t.id===taskA).completedAt);assert.equal(fresh.project.tasks.find(t=>t.id===taskB).text,'安排发货');assert(!fresh.project.statusDesc.includes('核对第二版图纸'));assert(fresh.project.statusDesc.includes('安排发货'));
 checks.push('TK04/05/07：无权、旧版本拒绝；COMMIT后响应丢失经重启查原回执，任务仅完成一次，兼容正文同步');
 await b.api('/api/projects/'+other,'PATCH',{expectedVersion:(await b.api('/api/projects/'+other)).project.version,idempotencyKey:randomUUID(),scope:'status',changes:{taskOps:[{op:'add',id:randomUUID(),text:'另一人任务'}]}});
 const summary=await a.api('/api/projects/tasks-summary?perspective=responsible');assert(summary.items.some(p=>p.id===id));assert(!summary.items.some(p=>p.id===other));assert.deepEqual(summary.items.find(p=>p.id===id).tasks.map(t=>t.id),[taskB]);
 const all=await a.api('/api/projects/tasks-summary?perspective=management');assert(all.items.some(p=>p.id===other));
 const filtered=await a.api('/api/projects?view=all&search='+encodeURIComponent('不匹配_'+prefix)+'&perspective=responsible');assert.equal(filtered.items.length,0);assert((await a.api('/api/projects/tasks-summary?perspective=responsible')).items.some(p=>p.id===id));
 checks.push('TK03/08：任务汇总按身份及负责范围，只含未完成；列表筛选为空不改变汇总');
 const deleted=await a.api(path,'PATCH',request([{op:'delete',id:taskB}]));version=deleted.result.savedVersion;
 assert((await sqlTasks(id)).find(t=>t.task_key===taskB).deleted_at_text);assert(!(await a.api('/api/projects/tasks-summary?perspective=responsible')).items.some(p=>p.id===id));
 fresh=await a.api(path);assert(fresh.project.tasks.find(t=>t.id===taskA).completedAt);assert.equal(fresh.project.statusDesc,'');
 checks.push('TK06：单条删除保留SQL事实/历史，不影响另一已完成任务，汇总和兼容正文同步');
 await mkdir('test-results',{recursive:true});await writeFile('test-results/panel-task-repair.json',JSON.stringify({status:'passed',checks,productBrowserTested:false},null,2));console.log(JSON.stringify({status:'passed',checks,evidence:'test-results/panel-task-repair.json'}));
}finally{
 loseAck=false;if(app)await app.close();
 for(const id of projects){for(const table of ['project_drafts','audit_log','project_checks','schedule_changes','project_changes','project_risks','project_nodes','project_stages','project_people','project_chips','project_tags','project_tasks','project_responsibilities','project_membership_requests','project_name_aliases'])await c.execute(`DELETE FROM ${table} WHERE project_id=?`,[id]);await c.execute('DELETE FROM projects WHERE id=?',[id]);}
 for(const user of users){for(const table of ['command_receipts','audit_log'])await c.execute(`DELETE FROM ${table} WHERE actor_id=?`,[user.id]);await c.execute('DELETE FROM sessions WHERE user_id=?',[user.id]);await c.execute('DELETE FROM users WHERE id=?',[user.id]);}
 await c.end();
}
