import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { checkPassword, hashPassword } from '../dist/server/modules/identity.js';
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='cleanup_'+randomUUID().slice(0,8),password='合成整页保存 password 2026',users=[],checks=[];
let app,runtime,origin;
function client(){
  let cookie='',csrf='',account;
  return {async api(path,method='GET',body,expected=200){
    const response=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,...account?{'X-GeekDash-Account':account.id}:{}},...body?{body:JSON.stringify(body)}:{}});
    for(const value of response.headers.getSetCookie()){const part=value.split(';')[0];if(part.startsWith('geekdash_dev='))cookie=part;if(part.startsWith('geekdash_dev_csrf='))csrf=part.split('=')[1];}
    const result=await response.json();assert([expected].flat().includes(response.status),path+' '+response.status+' '+JSON.stringify(result));if(path==='/api/auth/me')account=result.account;return result;
  },async upload(data){
    const response=await fetch(origin+'/api/imports/upload?'+new URLSearchParams({name:'整页合成备份.json',operation:randomUUID(),new:'1'}),{method:'POST',headers:{Cookie:cookie,Origin:'http://localhost','Content-Type':'application/octet-stream','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,'X-GeekDash-Account':account.id},body:JSON.stringify(data)});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result.result.batchId;
  },async login(i){await this.api('/api/auth/login','POST',{loginName:users[i],password});await this.api('/api/auth/me');}};
}
const body=(version,changes,commands=[])=>({expectedVersion:version,idempotencyKey:randomUUID(),scope:'project',changes,commands});

try{
 for(const good of ['Abcdefgh','abcd1234','1234567!','abcd!xyz','AAaa1111'])checkPassword(good);
 for(const bad of ['12345678','abcdefgh','ABCDEFGH','!!!!!!!!','Aa1!123'])assert.throws(()=>checkPassword(bad));
 checks.push('8字符且四类至少两类；短密码及单类拒绝');
 for(const [name,isAdmin] of [['admin',1],['worker',0],['victim',0]]){users.push(prefix+name);await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,is_admin,created_at,updated_at) VALUES (?,?,?,0,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix+name,await hashPassword(password),name,isAdmin]);}
 runtime=await openRuntimeDatabase('test_app');app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
 const admin=client(),worker=client(),victim=client();await admin.login(0);await worker.login(1);await victim.login(2);
 const op=randomUUID(),invite=await admin.api('/api/accounts/invites','POST',{role:'business',idempotencyKey:op});
 assert.equal((await admin.api('/api/accounts/invites','POST',{role:'business',idempotencyKey:op})).code,invite.code);
 assert.equal((await admin.api('/api/accounts/invites')).items.find(i=>i.id===invite.id).code,invite.code);await worker.api('/api/accounts/invites','GET',undefined,403);
 await client().api('/api/auth/register','POST',{loginName:prefix+'registered',name:'新注册',password:'Aa123456',inviteCode:invite.code});
 assert.equal(Number((await admin.api('/api/accounts/invites')).items.find(i=>i.id===invite.id).registrations),1);
 checks.push('邀请码首次/重试/新请求均读回同一码；仅管理员可读；注册人数正确');
 const list=(await admin.api('/api/accounts')).items,target=list.find(u=>u.loginName===users[2]),self=list.find(u=>u.loginName===users[0]);
 await admin.api('/api/accounts/'+self.id+'/impact','GET',undefined,422);
 const made=await victim.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'保留历史'}}),projectId=made.result.projectId;
 let impact=await admin.api('/api/accounts/'+target.id+'/impact');let deletion={enabled:false,expectedVersion:target.version,impactToken:impact.impactToken,idempotencyKey:randomUUID()};
 await admin.api('/api/accounts/'+target.id+'/delete','POST',deletion,422);
 await worker.api('/api/accounts/'+target.id+'/delete','POST',deletion,403);
 await c.execute('INSERT INTO project_responsibilities(project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))',[projectId,self.id]);
 impact=await admin.api('/api/accounts/'+target.id+'/impact');deletion={...deletion,impactToken:impact.impactToken,idempotencyKey:randomUUID()};
 await admin.api('/api/accounts/'+target.id+'/delete','POST',deletion);await admin.api('/api/accounts/'+target.id+'/delete','POST',deletion);
 assert(!(await admin.api('/api/accounts')).items.some(u=>u.id===target.id));await victim.api('/api/auth/me','GET',undefined,401);
 assert((await admin.api('/api/projects/'+projectId)).project);assert((await c.query('SELECT deleted_at FROM users WHERE id=?',[target.id]))[0][0].deleted_at);
 assert(Number((await c.query('SELECT COUNT(*) n FROM audit_log WHERE actor_id=?',[target.id]))[0][0].n)>0);
 checks.push('未交接/业务越权/删除自己拒绝；交接后删除可幂等重试，旧会话失效，项目历史保留');
 const name=prefix+'重复客户';const catalog=await admin.api('/api/catalog/customers/save','POST',{id:null,expectedVersion:'0',idempotencyKey:randomUUID(),changes:{name}});
 const batchId=await admin.upload({version:2,customers:[{id:1,name}],projects:[{id:1,name:prefix+'导入',status:'已结案',customer:name}]});const batch=await admin.api('/api/imports/'+batchId);const item=batch.catalogRows.find(i=>i.kind==='customers'&&i.payload.name===name);
 let command={expectedBatchVersion:batch.batch.version,expectedReviewVersion:item.reviewVersion,expectedVersion:null,idempotencyKey:randomUUID(),basis:item.basis,selected:['name'],mode:'new',targetId:null};
 const conflict=await admin.api(`/api/imports/${batchId}/items/${item.id}/preview`,'POST',command);assert(conflict.issues.some(i=>i.code==='CATALOG_NAME_CONFLICT'&&i.message.includes('已有同名资料')));
 command={...command,payload:{name:name+'修正'},idempotencyKey:randomUUID()};const corrected=await admin.api(`/api/imports/${batchId}/items/${item.id}/preview`,'POST',command);assert.deepEqual(corrected.issues,[]);command.basis=corrected.basis;
 const request={formatVersion:2,idempotencyKey:randomUUID(),items:[{id:item.id,command,resolveReferences:true}]};await admin.api(`/api/imports/${batchId}/executions`,'POST',request,202);
 let result;for(let i=0;i<80;i++){result=await admin.api(`/api/imports/${batchId}/executions?operation=${request.idempotencyKey}`);if(result.status==='finished')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(result.status,'finished');assert.equal(Number((await c.query('SELECT COUNT(*) n FROM customers WHERE name=?',[name+'修正']))[0][0].n),1);
 const fresh=await admin.api('/api/catalog/customers');assert(fresh.items.some(c=>c.name===name+'修正'));
 checks.push('同名资料冲突说明可读；原位改名预览→持久导入→资料新请求读回');
 console.log(JSON.stringify({status:'passed',prefix,checks}));
}finally{if(app)await app.close();else if(runtime)await runtime.close();await c.end();}
