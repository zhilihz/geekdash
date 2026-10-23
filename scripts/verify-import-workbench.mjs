// 真实 HTTP/MySQL + 前端执行模型；JSDOM 为验收工具，不进入应用依赖。
// GEEKDASH_JSDOM_PATH 可指向本机既有 JSDOM 的 api.js。
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
const {JSDOM,CookieJar,VirtualConsole}=await import(pathToFileURL(resolve(process.env.GEEKDASH_JSDOM_PATH ?? 'test-results/ui-dom-tools/node_modules/jsdom/lib/api.js')));
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='p05_ui_'+randomUUID().slice(0,8),password=randomUUID()+randomUUID(),jar=new CookieJar(),checks=[],http=[],errors=[];
let app,dom,origin,actor,batchId,lostAck=false;
try {
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix,await hashPassword(password),'导入交互合成验收']);
  const runtime=await openRuntimeDatabase('test_app');app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'0.0.0.0',port:0});
  async function call(path,opts={}) {
    const headers=new Headers(opts.headers);headers.set('Cookie',jar.getCookieStringSync(origin));headers.set('Origin','http://localhost');
    const response=await fetch(new URL(path,origin),{...opts,headers});for(const cookie of response.headers.getSetCookie())jar.setCookieSync(cookie,origin);
    http.push({path:path.split('?')[0],status:response.status});
    if(lostAck&&path.endsWith('/executions')&&response.ok){lostAck=false;await response.arrayBuffer();throw new Error('test: response lost after commit');}
    return response;
  }
  async function api(path,body,raw=false) {
    const csrf=jar.getCookiesSync(origin).find(cookie=>cookie.key==='geekdash_dev_csrf')?.value ?? '';
    const response=await call(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':raw?'application/octet-stream':'application/json','X-GeekDash-Request':'1','X-GeekDash-Account':actor ?? '','X-GeekDash-CSRF':csrf},...body===undefined?{}:{body:raw?JSON.stringify(body):JSON.stringify(body)}});
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
  }
  await api('/api/auth/login',{loginName:prefix,password});actor=(await api('/api/auth/me')).account.id;
  const source=(await api('/api/imports/sources',{name:prefix,idempotencyKey:randomUUID()})).result.sourceNamespace;
  const fixture={version:2,projects:[
    {id:1,name:prefix+' 一',status:'进行中',proposalDate:'-',chips:[prefix+' 芯片'],stages:Array.from({length:7},()=>({done:false,startDate:'-',doneDate:'-'}))},
    {id:2,name:prefix+' 二',status:'提案中',summary:'原简介'},
    {id:3,name:prefix+' 三',status:'提案中',dueDate:'2026-99-99'},
  ],chips:[{id:1,name:prefix+' 芯片'},{id:2,name:prefix+' 未引用芯片'}]};
  batchId=(await api('/api/imports/upload?'+new URLSearchParams({source,name:prefix+'.json',operation:randomUUID()}),fixture,true)).result.batchId;
  const before=await api('/api/imports/'+batchId),ids=before.items.map(row=>row.id);
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error.message));
  dom=new JSDOM(fs.readFileSync('src/web/imports.html','utf8'),{url:origin+'/imports.html?id='+batchId,cookieJar:jar,runScripts:'outside-only',virtualConsole});
  const w=dom.window;Object.assign(w,{TextEncoder,TextDecoder,structuredClone,AbortSignal,AbortController,fetch:call});w.BroadcastChannel=class{postMessage(){}};w.EventSource=class{addEventListener(){}close(){}};w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};
  w.addEventListener('error',event=>errors.push(event.message));
  const modules=new Map(),context=dom.getInternalVMContext();
  function load(path){if(path.endsWith('.css'))return{};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(modules.has(path))return modules.get(path).exports;const module={exports:{}};modules.set(path,module);const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',context,{filename:path})(name=>load(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  const wait=async predicate=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('界面等待超时：'+w.document.querySelector('.import-feedback')?.textContent);};
  const click=selector=>{const element=w.document.querySelector(selector);assert(element,'缺少操作 '+selector);assert(!element.disabled,'操作仍不可用 '+selector);element.click();};
  const change=(selector,value)=>{const input=w.document.querySelector(selector);assert(input,selector);input.value=value;input.dispatchEvent(new w.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  const current=()=>w.document.querySelector('.import-review')?.dataset.card;
  const enabled=selector=>!!w.document.querySelector(selector)&&!w.document.querySelector(selector).disabled;
  load('src/web/imports.ts');await wait(()=>!!w.document.querySelector('.import-stage-choice select'));
  change('.import-stage-choice select','ready');await wait(()=>enabled('[data-action=approve]'));
  click('[data-action=approve]');await wait(()=>current()!==ids[0]&&w.document.getElementById('imports-save').textContent!=='正在导入…');
  let after=await api('/api/imports/'+batchId),first=after.items[0];assert(first.previousResult);
  assert.equal(after.catalogRows.filter(row=>row.previousResult).length,1,'单项目只准备其引用资料');
  const firstDetail=await api('/api/projects/'+first.previousResult.projectId);assert.equal(firstDetail.stages[0].state,'ready');assert.equal(firstDetail.project.chips.length,1);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_chips WHERE project_id=?',[first.previousResult.projectId]))[0][0].n),1);
  checks.push('缺阶段依据原位一次选择→通过自动准备所需芯片→项目事务→独立SQL/详情新读→自动下一个');
  assert.equal(current(),ids[2]);click('[data-action=edit]');await wait(()=>!!w.document.querySelector('[data-value-path="fields.dueDate"]'));
  change('[data-value-path="fields.dueDate"]','2026-11-12');await wait(()=>enabled('[data-action=approve]'));
  lostAck=true;click('[data-action=approve]');await wait(()=>!lostAck);
  await wait(()=>current()!==ids[2]);
  after=await api('/api/imports/'+batchId);const third=after.items[2];assert(third.previousResult);assert.equal((await api('/api/projects/'+third.previousResult.projectId)).project.dueDate,'2026-11-12');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?',[ids[2]]))[0][0].n),1);
  checks.push('错误日期直接在差异处修正；提交成功丢响应时留在本项，自动查询原任务只产生一次采用且自动接续');
  click('[data-view=ready]');await wait(()=>current()===ids[1]);click('[data-action=skip]');
  click('[data-view=skipped]');assert.equal(current(),ids[1]);assert.equal((await api('/api/imports/'+batchId)).items[1].previousResult,null);
  click('[data-action=edit]');await wait(()=>!!w.document.querySelector('[data-value-path="fields.summary"]'));change('[data-value-path="fields.summary"]','修正后的简介');await wait(()=>enabled('[data-action=approve]'));click('[data-action=approve]');
  await wait(()=>current()!==ids[1]);after=await api('/api/imports/'+batchId);assert.equal(after.counts.processed,3);
  assert.equal((await api('/api/projects/'+after.items[1].previousResult.projectId)).project.summary,'修正后的简介');
  checks.push('不通过不写正式项目→已跳过找回→原位置修正正文→通过后只保存本项目');
  const idsInPage=[...w.document.querySelectorAll('[id]')].map(element=>element.id);assert.equal(new Set(idsInPage).size,idsInPage.length);assert.deepEqual(errors,[]);assert(!http.some(row=>row.status>=400));
  const result={status:'passed',build:JSON.parse(fs.readFileSync('dist/build-info.json','utf8')),requests:http.length,checks,limitation:'实际前端执行模型与真实HTTP/MySQL；SSE及原生像素另验'};
  fs.writeFileSync('test-results/import-workbench.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  await api('/api/auth/logout',{});
}finally{dom?.window.close();if(app)await app.close();await c.end();}
