// 原页面脚本 + 真实 HTTP/MySQL；DOM 只承担浏览器事件，不替代业务服务。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {connectDatabase} from '../dist/server/infrastructure/db.js';
import {openRuntimeDatabase} from '../dist/server/infrastructure/runtime-database.js';
import {createApp} from '../dist/server/app.js';
import {hashPassword} from '../dist/server/modules/identity.js';
const {JSDOM,CookieJar,VirtualConsole}=await import(pathToFileURL(resolve(process.env.GEEKDASH_JSDOM_PATH??'test-results/ui-dom-tools/node_modules/jsdom/lib/api.js')));
const stages=vm.runInNewContext(fs.readFileSync('geekdashdesktop/projects-data.js','utf8').match(/const STAGES = (\[[\s\S]*?\n  \]);/)[1],Object.create(null),{timeout:1000});
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='space_ui_'+randomUUID().slice(0,8),password=randomUUID()+randomUUID(),accounts=[],checks=[],http=[],errors=[],pages=[];
let app,origin,result;
const wait=async predicate=>{const end=Date.now()+15000;while(Date.now()<end){assert.deepEqual(errors,[]);if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('页面状态未到达预期');};
function client(index){
  const jar=new CookieJar();let actor,lostAck=false;
  async function call(path,opts={}){const headers=new Headers(opts.headers);headers.set('Cookie',jar.getCookieStringSync(origin));headers.set('Origin','http://localhost');const response=await fetch(new URL(path,origin),{...opts,headers});for(const value of response.headers.getSetCookie())jar.setCookieSync(value,origin);http.push({path:path.split('?')[0],status:response.status});if(lostAck&&path.endsWith('/membership')&&response.ok){lostAck=false;await response.arrayBuffer();throw new Error('test response lost');}return response;}
  async function api(path,body,status=200){const response=await call(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-GeekDash-Request':'1','X-GeekDash-Account':actor??'','X-GeekDash-CSRF':jar.getCookiesSync(origin).find(cookie=>cookie.key==='geekdash_dev_csrf')?.value??''},...body===undefined?{}:{body:JSON.stringify(body)}});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
  return {jar,call,api,loseAck(){lostAck=true;},async login(){await api('/api/auth/login',{loginName:accounts[index].login,password});actor=(await api('/api/auth/me')).account.id;}};
}
function page(client,file,query=''){
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>{if(!error.message.includes('Not implemented: navigation'))errors.push(error.message);});
  const dom=new JSDOM(fs.readFileSync('src/web/'+file+'.html','utf8'),{url:origin+'/'+file+'.html'+query,cookieJar:client.jar,runScripts:'outside-only',virtualConsole});
  let active=0,lastRequest=Date.now(),closed=false;
  const pageFetch=async(...args)=>{active++;lastRequest=Date.now();try{return await client.call(...args);}finally{active--;lastRequest=Date.now();}};
  const w=dom.window;Object.assign(w,{TextEncoder,TextDecoder,structuredClone,AbortSignal,AbortController,fetch:pageFetch});w.BroadcastChannel=class{postMessage(){}};w.EventSource=class{addEventListener(){}close(){}};w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.addEventListener('error',event=>errors.push(event.message));
  w.__GEEKDASH_STAGES__=stages;
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(value=''){this.returnValue=value;this.open=false;this.dispatchEvent(new w.Event('close'));};
  const modules=new Map(),context=dom.getInternalVMContext();
  function load(path){if(path.endsWith('.css'))return{};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(modules.has(path))return modules.get(path).exports;const module={exports:{}};modules.set(path,module);const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',context,{filename:path})(name=>load(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  const d=w.document,click=selector=>{const control=d.querySelector(selector);assert(control,selector);assert(!control.disabled,'禁用 '+selector);control.click();};
  load('src/web/'+(file==='project-detail'?'detail':file)+'.ts');
  const close=async()=>{if(closed)return;w.dispatchEvent(new w.Event('pagehide'));const end=Date.now()+10000;while(active||Date.now()-lastRequest<1100){assert(Date.now()<end,'页面关闭前请求未收敛');await new Promise(resolve=>setTimeout(resolve,40));}closed=true;dom.window.close();};pages.push(close);return {w,d,click,close};
}
try{
  const hash=await hashPassword(password);
  for(let i=0;i<4;i++){const login=prefix+'_'+i;await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[login,hash,'页面合成账号'+i]);accounts.push({id:String((await c.query('SELECT LAST_INSERT_ID() id'))[0][0].id),login});}
  await c.execute('UPDATE system_configuration SET maintenance_user_id=? WHERE id=1',[accounts[3].id]);
  app=await createApp(await openRuntimeDatabase('test_app'),{origin:'http://localhost',secure:false});origin=await app.listen({host:'0.0.0.0',port:0});
  const [a,b,m]=[0,1,3].map(client);await Promise.all([a.login(),b.login(),m.login()]);
  const create=page(a,'project-new');await wait(()=>!!create.d.querySelector('#edit-name')&&create.d.querySelectorAll('#edit-inviteeIds-source option').length>1);
  assert(!create.d.querySelector('#edit-managerIds-source'));
  const name=create.d.getElementById('edit-name');name.value=prefix+' 项目';name.dispatchEvent(new create.w.Event('input',{bubbles:true}));
  const invite=create.d.getElementById('edit-inviteeIds-source');assert.equal(invite.multiple,true);for(const user of accounts.slice(1,3))invite.querySelector(`option[value="${user.id}"]`).selected=true;invite.dispatchEvent(new create.w.Event('change',{bubbles:true}));
  await wait(async()=>{const drafts=(await a.api('/api/personal/drafts?projectId=new')).items;return drafts.some(row=>row.payload.values?.inviteeIds?.length===2);});
  create.d.getElementById('create').dispatchEvent(new create.w.Event('submit',{bubbles:true,cancelable:true}));
  let project;
  await wait(async()=>{project=(await a.api('/api/projects?view=all')).items.find(row=>row.name===prefix+' 项目');return !!project;});
  assert.equal((await c.query('SELECT user_id FROM project_responsibilities WHERE project_id=?',[project.id]))[0].length,1);
  assert.equal((await c.query("SELECT id FROM project_membership_requests WHERE project_id=? AND status='pending'",[project.id]))[0].length,2);
  await b.api('/api/projects/'+project.id,undefined,403);await create.close();
  checks.push('新建页多选邀请可存服务器草稿；一次创建产生两条邀请，只有创建者负责，被邀者尚不能读详情');
  const space=page(b,'project-space');await wait(()=>!!space.d.querySelector('button[data-action=accept]'));
  space.d.getElementById('space-search').value=prefix;space.d.getElementById('space-search').dispatchEvent(new space.w.Event('input',{bubbles:true}));await wait(()=>space.d.querySelectorAll('.space-card').length===1);
  assert(!space.d.querySelector('.space-card').textContent.includes('最新状态说明'));
  b.loseAck();space.click('button[data-action=accept]');await wait(()=>!!space.d.querySelector(`a[href="/project-detail.html?id=${project.id}"]`));
  await wait(()=>!!space.d.querySelector('button[data-action=query]'));space.click('button[data-action=query]');await wait(()=>!space.d.querySelector('button[data-action=query]'));
  assert.equal((await c.query('SELECT user_id FROM project_responsibilities WHERE project_id=?',[project.id]))[0].length,2);
  assert((await b.api('/api/projects?view=all')).items.some(row=>row.id===project.id));assert((await b.api('/api/project-summary')).items.some(row=>row.id===project.id));
  checks.push('基础空间→接受邀请（注入丢响应）→原结果核对→同一项目进入个人列表和简要；不重复责任');await space.close();
  // 合成历史缺失依据，确认状态不能补造日期；随后退出不能继续读取正式详情。
  await c.execute("UPDATE project_stages SET state='unknown' WHERE project_id=? AND stage_code='S1'",[project.id]);
  const detail=page(b,'project-detail','?id='+project.id);await wait(()=>!!detail.d.querySelector('#edit-name'));
  detail.click('[data-tab=stages]');await wait(()=>!!detail.d.querySelector('[data-confirm-state=S1]'));
  const known=detail.d.getElementById('stage-known-S1');known.value='active';detail.click('[data-confirm-state=S1]');
  await wait(async()=>(await b.api('/api/projects/'+project.id)).stages[0].state==='active');
  await wait(()=>!detail.d.querySelector('[data-confirm-state=S1]'));
  const stage=(await c.query('SELECT state,started_on,completed_on FROM project_stages WHERE project_id=? AND stage_code=\'S1\'',[project.id]))[0][0];assert.equal(stage.started_on,null);assert.equal(stage.completed_on,null);
  detail.click('#responsibility-save');await wait(async()=>!(await b.api('/api/projects?view=all')).items.some(row=>row.id===project.id));
  await b.api('/api/projects/'+project.id,undefined,403);assert.equal((await c.query('SELECT user_id FROM project_responsibilities WHERE project_id=?',[project.id]))[0].length,1);await detail.close();
  checks.push('原阶段卡确认历史开始状态，保存后新读与SQL一致且日期仍未知；详情退出后正式读取和个人列表同步收回');
  // 接续后续账号交接验证，退出者重新申请、由现任成员接受。
  const application=(await b.api('/api/projects/'+project.id+'/membership',{action:'apply',idempotencyKey:randomUUID()})).result.requestId;
  await a.api('/api/projects/'+project.id+'/membership',{action:'accept',requestId:application,idempotencyKey:randomUUID()});
  const admin=page(m,'accounts');await wait(()=>!!admin.d.querySelector(`[data-account="${accounts[0].id}"]`));admin.click(`[data-account="${accounts[0].id}"]`);await wait(()=>!!admin.d.querySelector('[data-confirm]'));admin.click('[data-confirm]');
  await wait(async()=>Number((await c.query('SELECT enabled FROM users WHERE id=?',[accounts[0].id]))[0][0].enabled)===0);
  await wait(()=>admin.d.getElementById('account-message').textContent==='账号状态已保存。');await a.api('/api/projects?view=all',undefined,401);
  assert((await b.api('/api/projects?view=all')).items.some(row=>row.id===project.id));
  admin.click(`[data-account="${accounts[0].id}"]`);await wait(()=>!!admin.d.querySelector('[data-confirm]'));admin.click('[data-confirm]');await wait(()=>admin.d.getElementById('account-message').textContent==='账号状态已保存。'&&!admin.d.querySelector('[data-confirm]'));await a.login();assert((await a.api('/api/projects?view=all')).items.some(row=>row.id===project.id));
  checks.push('维护页就地显示影响→一次确认停用→撤销旧会话、其他协作者继续管理→重新启用需新登录');
  const unowned=(await a.api('/api/projects',{fields:{name:prefix+' 无负责人'},idempotencyKey:randomUUID()})).result.projectId;
  await c.execute('DELETE FROM project_responsibilities WHERE project_id=?',[unowned]);
  const claimant=page(b,'project-space');await wait(()=>!!claimant.d.querySelector(`[data-project="${unowned}"][data-action=claim]`));claimant.click(`[data-project="${unowned}"][data-action=claim]`);await wait(()=>!!claimant.d.querySelector(`a[href="/project-detail.html?id=${unowned}"]`));assert((await b.api('/api/projects?view=all')).items.some(row=>row.id===unowned));
  checks.push('原存量无负责人项目可在空间认领，随后同一ID进入本人项目');
  assert.deepEqual(errors,[]);
  result={status:'passed',checkedAt:new Date().toISOString(),build:JSON.parse(fs.readFileSync('dist/build-info.json','utf8')),requests:http.length,checks,limitation:'真实前端模块、HTTP及MySQL；原生视觉和全部切换场景另验'};
}finally{for(const close of pages)await close();if(app)await app.close();await c.end();}
assert.deepEqual(errors,[]);fs.writeFileSync('test-results/project-space-ui.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
