import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='accounts_'+randomUUID().slice(0,8),password='合成整页保存 password 2026',users=[],checks=[];
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
  const loginName=prefix+'admin';users.push(loginName);
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,is_admin,created_at,updated_at) VALUES (?,?,?,0,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[loginName,await hashPassword(password),'合成管理员']);
  runtime=await openRuntimeDatabase('test_app');app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
  const admin=client(),guest=client();await admin.login(0);
  assert.equal((await admin.api('/api/auth/me')).account.isMaintenance,true);
  const businessInvite=await admin.api('/api/accounts/invites','POST',{role:'business',idempotencyKey:randomUUID()});
  const op=randomUUID(),adminInvite=await admin.api('/api/accounts/invites','POST',{role:'admin',idempotencyKey:op});
  const replay=await admin.api('/api/accounts/invites','POST',{role:'admin',idempotencyKey:op});assert.equal(replay.id,adminInvite.id);assert.equal(replay.code,adminInvite.code);
  const reg=(name,inviteCode)=>({loginName:name,name,password,inviteCode});
  await guest.api('/api/auth/register','POST',{...reg(prefix+'bad',businessInvite.code),role:'admin'},400);
  assert.equal((await c.query('SELECT COUNT(*) n FROM users WHERE login_name=?',[prefix+'bad']))[0][0].n,'0');
  for(const [suffix,role,code] of [['user','business',businessInvite.code],['other','business',businessInvite.code],['admin2','admin',adminInvite.code]])await guest.api('/api/auth/register','POST',reg(prefix+suffix,code));
  await guest.api('/api/auth/register','POST',reg(prefix+'user',businessInvite.code),409);
  await admin.api('/api/accounts/invites/'+businessInvite.id+'/revoke','POST',{});
  await guest.api('/api/auth/register','POST',reg(prefix+'revoked',businessInvite.code),422);
  const expired=await admin.api('/api/accounts/invites','POST',{role:'business',idempotencyKey:randomUUID()});await c.execute('UPDATE registration_invites SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND WHERE id=?',[expired.id]);
  await guest.api('/api/auth/register','POST',reg(prefix+'expired',expired.code),422);
  const user=client(),admin2=client();users.push(prefix+'user',prefix+'admin2');await user.login(1);await admin2.login(2);
  assert.equal((await admin2.api('/api/auth/me')).account.isMaintenance,true);assert.equal((await user.api('/api/auth/me')).account.mustChangePassword,false);assert.equal((await user.api('/api/auth/me')).account.isMaintenance,false);
  await user.api('/api/accounts','GET',undefined,403);await user.api('/api/accounts/invites','GET',undefined,403);await user.api('/api/settings/check-rule','GET',undefined,403);
  checks.push('邀请码决定身份、拒绝客户端自报管理员、多次注册、过期/撤销、重复登录名、管理员多账号及业务账号拒绝管理API');
  const catalog=async(kind,changes)=>(await user.api('/api/catalog/'+kind+'/save','POST',{id:null,expectedVersion:'0',idempotencyKey:randomUUID(),changes})).result.id;
  const customer=await catalog('customers',{name:prefix+'客户',contact:'',background:''}),line=await catalog('productLines',{name:prefix+'产品线'}),chip=await catalog('chips',{name:prefix+'芯片',originalModel:'',manufacturer:'',firmwareVersion:''});
  const made=await user.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'项目',customerIds:[customer],productLineIds:[line],chipSelections:[{selectionId:randomUUID(),chipId:chip,note:''}]}}),id=made.result.projectId,path='/api/projects/'+id;
  const detail=await admin2.api(path);assert.equal(detail.readOnly,true);
  await admin2.api(path,'PATCH',body(detail.project.version,{summary:'不得越权'}),403);
  assert((await admin2.api('/api/projects?view=all&search='+prefix)).items.some(item=>item.id===id));
  assert((await admin2.api('/api/project-summary')).items.some(item=>item.id===id));
  let url='/api/project-space?'+new URLSearchParams({customer:prefix+'客户',productLine:prefix+'产品线',chip:prefix+'芯片'});
  assert.equal((await admin.api(url)).pagination.total,1);assert.equal((await admin.api(url+'&chip=另一个')).pagination.total,1);assert.equal((await admin.api(url+'&productLine=不存在')).pagination.total,1);
  assert.equal((await admin.api('/api/project-space?customer=不存在&chip='+encodeURIComponent(prefix+'芯片'))).pagination.total,0);
  checks.push('管理员新请求可读全部项目但未加入不可写；空间三类筛选同组OR跨组AND；基础资料业务账号可维护');
  const policy=await admin.api('/api/settings/check-rule'),change={frequency:'weekly',deadlineWeekday:5,expectedVersion:policy.version,idempotencyKey:randomUUID()};
  const saved=await admin.api('/api/settings/check-policy','POST',change);assert.equal(saved.outcome,'committed');
  assert.equal((await admin.api('/api/settings/check-policy/results/query','POST',change)).outcome,'committed');
  const current=await user.api(path);
  await user.api(path+'/actions','POST',{action:'saveCheck',expectedVersion:current.project.version,idempotencyKey:randomUUID(),conclusion:'checked',note:''});
  const records=await user.api(path+'/checks');assert.equal(records.items[0].ruleVersion,saved.result.version);
  const weekRecord=JSON.stringify(records.items[0]);
  await admin2.api('/api/settings/check-policy','POST',{frequency:'daily',deadlineWeekday:5,expectedVersion:saved.result.version,idempotencyKey:randomUUID()});
  await admin.api('/api/settings/check-policy','POST',{...change,idempotencyKey:randomUUID()},409);
  assert.equal(JSON.stringify((await user.api(path+'/checks')).items[0]),weekRecord);
  const latestPolicy=await admin.api('/api/settings/check-rule');assert.equal(latestPolicy.frequency,'daily');
  const daily=await user.api('/api/projects?view=all&checkCycle=checked&search='+prefix);assert.equal(daily.pagination.total,1);assert.equal(daily.items[0].checkPolicy.checked,true);
  await user.api('/api/settings/check-policy','POST',{frequency:'weekly',deadlineWeekday:5,expectedVersion:latestPolicy.version,idempotencyKey:randomUUID()},403);
  await admin.api('/api/settings/check-policy','POST',{frequency:'weekly',deadlineWeekday:5,expectedVersion:latestPolicy.version,idempotencyKey:randomUUID()});
  const {enrichChecks}=await import('../dist/server/modules/project-checks.js');
  const date=new Date();date.setTime(date.getTime()+8*3600000);const today=date.toISOString().slice(0,10);const monday=Date.parse(today)-((new Date(today).getUTCDay()+6)%7)*86400000;
  for(const offset of [4,5]){const fake=[{id,version:'1'}];const blank=await user.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'未查'+offset}});fake.push({id:blank.result.projectId,version:'1'});await enrichChecks(c,fake,{businessDate:new Date(monday+offset*86400000).toISOString().slice(0,10)});assert.equal(fake[1].checkPolicy.overdue,offset===5);}
  checks.push('CHECK配置版本冲突、全局即时生效、记录原规则；周五包含全天、周六未查逾期，业务账号不可改规则');
  const target=(await admin.api('/api/accounts')).items.find(item=>item.loginName===prefix+'other');const impact=await admin.api('/api/accounts/'+target.id+'/impact');
  await admin.api('/api/accounts/'+target.id+'/state','POST',{enabled:false,expectedVersion:target.version,impactToken:impact.impactToken,idempotencyKey:randomUUID()});
  assert.equal((await admin2.api('/api/accounts')).items.find(item=>item.id===target.id).enabled,0);
  checks.push('第二管理员可读管理列表；启停写入后新请求状态一致');
  console.log(JSON.stringify({status:'passed',prefix,checks},null,2));
}finally{if(app)await app.close();else if(runtime)await runtime.close();await c.end();}
