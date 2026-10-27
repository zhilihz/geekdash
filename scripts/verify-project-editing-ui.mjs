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
const prefix='editing_ui_'+randomUUID().slice(0,8),password=randomUUID()+randomUUID(),accounts=[],checks=[],http=[],errors=[],pages=[];
let app,origin,result;
const wait=async predicate=>{const end=Date.now()+15000;while(Date.now()<end){assert.deepEqual(errors,[]);if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('页面状态未到达预期');};
function client(index){
  const jar=new CookieJar();let actor,lostAck=false;
  async function call(path,opts={}){const headers=new Headers(opts.headers);headers.set('Cookie',jar.getCookieStringSync(origin));headers.set('Origin','http://localhost');const response=await fetch(new URL(path,origin),{...opts,headers});for(const value of response.headers.getSetCookie())jar.setCookieSync(value,origin);http.push({path:path.split('?')[0],status:response.status});if(lostAck&&path.endsWith('/membership')&&response.ok){lostAck=false;await response.arrayBuffer();throw new Error('test response lost');}return response;}
  async function api(path,body,status=200){const response=await call(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-GeekDash-Request':'1','X-GeekDash-Account':actor??'','X-GeekDash-CSRF':jar.getCookiesSync(origin).find(cookie=>cookie.key==='geekdash_dev_csrf')?.value??''},...body===undefined?{}:{body:JSON.stringify(body)}});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
  return {jar,call,api,loseAck(){lostAck=true;},async login(){await api('/api/auth/login',{loginName:accounts[index].login,password});actor=(await api('/api/auth/me')).account.id;}};
}
function page(client,file,query='',configure=()=>{}){
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
  configure(w);load('src/web/'+(file==='project-detail'?'detail':file==='index'?'board':file)+'.ts');
  const close=async()=>{if(closed)return;w.dispatchEvent(new w.Event('pagehide'));const end=Date.now()+10000;while(active||Date.now()-lastRequest<1100){assert(Date.now()<end,'页面关闭前请求未收敛');await new Promise(resolve=>setTimeout(resolve,40));}closed=true;dom.window.close();};pages.push(close);return {w,d,click,close};
}
const input=(p,selector,value,event='input')=>{const e=p.d.querySelector(selector);assert(e,selector);assert(!e.disabled,selector+'不可编辑');e.value=value;e.dispatchEvent(new p.w.Event(event,{bubbles:true}));};
try{
 const hash=await hashPassword(password);
 for(let i=0;i<2;i++){const login=prefix+'_'+i;await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[login,hash,'整页DOM合成账号'+i]);accounts.push({id:String((await c.query('SELECT LAST_INSERT_ID() id'))[0][0].id),login});}
 app=await createApp(await openRuntimeDatabase('test_app'),{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
 const a=client(0),b=client(1);await a.login();await b.login();
 const made=await a.api('/api/projects',{idempotencyKey:randomUUID(),fields:{name:prefix}}),id=made.result.projectId,path='/api/projects/'+id;
 const p=page(a,'project-detail','?id='+id);await wait(()=>p.d.querySelector('#edit-name'));
 input(p,'#edit-summary','整页DOM简介');p.click('[data-tab=risk]');p.click('[data-risk=add]');input(p,'#risk-content',' ');p.click('#save-project');
 await wait(()=>p.d.querySelector('#error-riskOps')?.textContent.includes('非空'));assert.equal((await a.api(path)).project.version,'1');
 p.click('[data-risk=correct]');input(p,'#risk-content','修正后的风险');p.click('[data-change=add]');input(p,'#chg-content','同次需求');input(p,'#chg-reason','核对');
 p.click('[data-tab=info]');assert.equal(p.d.querySelector('#edit-summary').value,'整页DOM简介');input(p,'#edit-state','closed','change');input(p,'#edit-closureNote','合成遗留后续核对');p.click('#save-project');
 await wait(()=>p.d.querySelector('#editor-dialog').open);assert(p.d.querySelector('#editor-dialog').textContent.includes('修正后的风险'));assert.equal((await a.api(path)).project.version,'1');
 p.click('#editor-dialog [data-choice=save]');await wait(async()=>(await a.api(path)).project.version==='2');await wait(()=>p.d.querySelector('#save-project').disabled);
 const saved=await a.api(path);assert.equal(saved.project.status,'closed');assert.equal(saved.project.summary,'整页DOM简介');assert.equal(saved.risks.length,1);assert.equal(saved.changes.length,1);assert.equal((await a.api('/api/personal/drafts?projectId='+id)).items.length,0);
 checks.push('实际detail脚本：风险校验失败零写入→就地纠正→另一需求副本→跨页简介/结案→因果预览包含新风险→一次版本且草稿终结');
 p.click('[data-tab=risk]');p.click('[data-risk=add]');input(p,'#risk-content','取消后不应复活的风险');await wait(async()=>(await a.api('/api/personal/drafts?projectId='+id)).items.some(row=>row.payload.editors?.risk));p.click('#risk-cancel');
 await wait(async()=>(await a.api('/api/personal/drafts?projectId='+id)).items.length===0);assert.equal((await a.api(path)).risks.length,1);
 checks.push('新增风险取消后整页底稿清理，不复活已取消输入，正式风险保持');
 p.click('[data-risk=add]');input(p,'#risk-content','跨设备恢复的风险输入');await wait(async()=>(await a.api('/api/personal/drafts?projectId='+id)).items.some(row=>row.payload.editors?.risk?.content==='跨设备恢复的风险输入'));await p.close();
 const restored=page(a,'project-detail','?id='+id);await wait(()=>restored.d.querySelector('[data-continue]'));restored.click('[data-continue]');await wait(()=>restored.d.querySelector('#save-project')&&!restored.d.querySelector('#save-project').disabled);restored.click('[data-tab=risk]');
 restored.click('#save-project');await wait(async()=>(await a.api(path)).project.version==='3');assert((await a.api(path)).risks.some(row=>row.content==='跨设备恢复的风险输入'));await restored.close();
 checks.push('新页面从MySQL恢复未完成风险副本，顶部一次保存并新请求消费');
 const profile=page(a,'profile');await wait(()=>profile.d.querySelector('#profile-name').value);assert.equal(profile.d.querySelector('#profile-login').readOnly,true);input(profile,'#profile-name','本人新显示名 '+prefix);profile.d.querySelector('#profile-form').dispatchEvent(new profile.w.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>profile.d.querySelector('#profile-message').textContent.includes('已保存'));assert.equal((await a.api('/api/profile')).name,'本人新显示名 '+prefix);await profile.close();
 checks.push('个人信息独立页面保存显示名称，登录名只读，服务端新请求一致');
 const board=page(a,'index','?view=all&layout=progress');await wait(()=>board.d.querySelector('#distribution-options input'));
 assert.equal(board.d.querySelectorAll('#distribution-options input').length,6);
 for(const control of board.d.querySelectorAll('#distribution-options input'))control.checked=false;board.d.querySelector('#distribution-options').dispatchEvent(new board.w.Event('change',{bubbles:true}));assert.equal(board.d.querySelectorAll('#distribution-charts .chart-card').length,0);
 for(const value of ['stage','customer']){const control=board.d.querySelector(`#distribution-options input[value="${value}"]`);control.checked=true;control.dispatchEvent(new board.w.Event('change',{bubbles:true}));}
 assert.equal(board.d.querySelectorAll('#distribution-charts .chart-card').length,2);assert(!board.d.body.textContent.includes('团队项目分工'));await board.close();
 checks.push('驾驶舱同时选择多个分布模块，原团队分工退出');
 result={passed:true,prefix,checks,httpCount:http.length};console.log(JSON.stringify(result));
}finally{for(const close of pages)await close();if(app)await app.close();await c.end();assert.deepEqual(errors,[]);}
