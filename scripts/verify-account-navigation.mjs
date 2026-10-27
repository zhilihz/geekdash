import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createApp} from '../dist/server/app.js';
import {connectDatabase} from '../dist/server/infrastructure/db.js';
import {openRuntimeDatabase} from '../dist/server/infrastructure/runtime-database.js';
import {hashPassword} from '../dist/server/modules/identity.js';
// 只验证导航函数与HTTP/MySQL，不操控浏览器或代替用户验收。
const helper={exports:{},URL,URLSearchParams,location:{origin:'http://localhost',search:''}};
vm.runInNewContext(ts.transpileModule(readFileSync('src/web/shared/auth-return.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,helper);
const nav=helper.exports;
assert.equal(nav.accountLinkTarget('/login.html?logout=1','/profile.html','1'),'/login.html?logout=1');
assert.equal(nav.accountLinkTarget('/login.html?logout=1&returnTo=%2Fproject-detail.html%3Fid%3D42','/profile.html','1'),'/login.html?logout=1');
const change=nav.loginTarget('/project-detail.html?id=42','1',true);assert(change.startsWith('/password.html?'));assert.equal(new URL(change,'http://localhost').searchParams.get('returnTo'),'/project-detail.html?id=42');
const returnLink=nav.loginTarget('/profile.html','1');assert.equal(nav.accountLinkTarget(returnLink,'/password.html','1'),returnLink);
assert.equal(nav.accountLinkTarget('/profile.html','/','1'),undefined);assert.equal(nav.accountLinkTarget('https://example.org/login.html','/','1'),undefined);
assert.equal(nav.afterLogin('1',new URLSearchParams('returnTo=%2Fprofile.html&returnAccount=1')),'/profile.html');
assert.equal(nav.afterLogin('2',new URLSearchParams('returnTo=%2Fprofile.html&returnAccount=1')),'/');
assert.equal(nav.workTarget('https://example.org/'),undefined);
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const loginName='navigation_'+randomUUID().slice(0,8),password='导航接口旧密码 '+randomUUID(),newPassword='导航接口新密码 '+randomUUID();let app,runtime,origin;
function client(){let cookie='',csrf='',id='';return {async api(path,method='GET',body,status=200){const response=await fetch(origin+path,{method,headers:{Origin:'http://localhost',Cookie:cookie,'Content-Type':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,'X-GeekDash-Account':id},...body?{body:JSON.stringify(body)}:{}});const result=await response.json();assert.equal(response.status,status,path+' '+JSON.stringify(result));for(const header of response.headers.getSetCookie()){const item=header.split(';')[0];if(item.startsWith('geekdash_dev='))cookie=item;if(item.startsWith('geekdash_dev_csrf='))csrf=item.split('=')[1];}if(path==='/api/auth/me'&&result.account)id=result.account.id;return result;},async login(pass){await this.api('/api/auth/login','POST',{loginName,password:pass});return this.api('/api/auth/me');}};}
try{
 await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[loginName,await hashPassword(password),'账号导航接口检查']);
 runtime=await openRuntimeDatabase('test_app');app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
 const a=client(),b=client();assert.equal((await a.login(password)).account.mustChangePassword,true);await b.login(password);await a.api('/api/profile','GET',undefined,403);
 await a.api('/api/auth/password','POST',{currentPassword:'错误的当前密码 1234567',newPassword,confirmPassword:newPassword},422);
 await a.api('/api/auth/password','POST',{currentPassword:password,newPassword,confirmPassword:newPassword});
 await b.api('/api/auth/me','GET',undefined,401);await a.api('/api/auth/login','POST',{loginName,password},401);
 assert.equal((await a.login(newPassword)).account.mustChangePassword,false);
 const before=await a.api('/api/profile');await a.api('/api/profile','POST',{name:'个人资料已保存',expectedVersion:before.version,idempotencyKey:randomUUID()});assert.equal((await a.api('/api/profile')).name,'个人资料已保存');
 await a.api('/api/auth/logout','POST',{});await a.api('/api/auth/me','GET',undefined,401);await a.api('/api/profile','GET',undefined,401);
 assert.equal((await a.login(newPassword)).account.name,'个人资料已保存');await a.api('/api/auth/logout','POST',{});
 const [revoked]=await c.query('SELECT COUNT(*) active FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.login_name=? AND s.revoked_at IS NULL',[loginName]);assert.equal(Number(revoked[0].active),0);
 console.log(JSON.stringify({status:'passed',loginName,checks:['退出参数不被改写；资料与改密返回目标保留；跨账号及外站返回保护','首次改密、错误旧密码拒绝、新密码持久化、旧会话及旧密码失效','个人资料保存后新请求读回；退出后auth/me与profile拒绝；再次登录和退出无残留会话']}));
}finally{if(app)await app.close();else if(runtime)await runtime.close();await c.end();}
