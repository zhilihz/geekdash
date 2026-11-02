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
let app,dom,origin,actor,batchId,lostAck=false,lostRead=false;
try {
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix,await hashPassword(password),'导入交互合成验收']);
  const runtime=await openRuntimeDatabase('test_app');app=await createApp(runtime,{origin:'http://localhost',secure:false});origin=await app.listen({host:'0.0.0.0',port:0});
  async function call(path,opts={}) {
    const headers=new Headers(opts.headers);headers.set('Cookie',jar.getCookieStringSync(origin));headers.set('Origin','http://localhost');
    const response=await fetch(new URL(path,origin),{...opts,headers});for(const cookie of response.headers.getSetCookie())jar.setCookieSync(cookie,origin);
    http.push({path:path.split('?')[0],status:response.status});
    if(lostAck&&path.endsWith('/executions')&&response.ok){lostAck=false;await response.arrayBuffer();throw new Error('test: response lost after commit');}
    if(lostRead&&path.includes('/executions?')&&(!opts.method||opts.method==='GET')){lostRead=false;await response.arrayBuffer();return new Response(JSON.stringify({code:'DATABASE_UNAVAILABLE',requestId:'synthetic-read-failure'}),{status:503,headers:{'content-type':'application/json'}});}
    return response;
  }
  async function api(path,body,raw=false,expectedStatus=200) {
    const csrf=jar.getCookiesSync(origin).find(cookie=>cookie.key==='geekdash_dev_csrf')?.value ?? '';
    const response=await call(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':raw?'application/octet-stream':'application/json','X-GeekDash-Request':'1','X-GeekDash-Account':actor ?? '','X-GeekDash-CSRF':csrf},...body===undefined?{}:{body:raw?JSON.stringify(body):JSON.stringify(body)}});
    const data=await response.json();assert.equal(response.status,expectedStatus,JSON.stringify(data));return data;
  }
  await api('/api/auth/login',{loginName:prefix,password});actor=(await api('/api/auth/me')).account.id;
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error.message));
  dom=new JSDOM(fs.readFileSync('src/web/imports.html','utf8'),{url:origin+'/imports.html',cookieJar:jar,runScripts:'outside-only',virtualConsole});
  const w=dom.window;Object.assign(w,{TextEncoder,TextDecoder,structuredClone,AbortSignal,AbortController,fetch:call});w.BroadcastChannel=class{postMessage(){}};w.EventSource=class{addEventListener(){}close(){}};w.ResizeObserver=class{observe(){}disconnect(){}};w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};
  Object.defineProperty(w.crypto,'subtle',{value:globalThis.crypto.subtle});
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.addEventListener('error',event=>errors.push(event.message));
  const modules=new Map(),context=dom.getInternalVMContext();
  function load(path){if(path.endsWith('.css'))return{};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(modules.has(path))return modules.get(path).exports;const module={exports:{}};modules.set(path,module);const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',context,{filename:path})(name=>load(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  const wait=async predicate=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}fs.writeFileSync('test-results/import-workbench-timeout.html',dom.window.document.documentElement.outerHTML);throw new Error('界面等待超时：'+dom.window.document.getElementById('imports-save-status')?.textContent+' / '+JSON.stringify(errors));};
  const click=selector=>{const element=w.document.querySelector(selector);assert(element,'缺少操作 '+selector);assert(!element.disabled,'操作仍不可用 '+selector);element.click();};
  const change=(selector,value)=>{const input=w.document.querySelector(selector);assert(input,selector);input.value=value;input.dispatchEvent(new w.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  const enabled=selector=>!!w.document.querySelector(selector)&&!w.document.querySelector(selector).disabled;
  const fixture={version:2,projects:[
    {id:1,name:prefix+' 一',status:'进行中',chips:[prefix+' 芯片'],stages:Array.from({length:7},(_,index)=>({done:index<3,startDate:'-',doneDate:'-'}))},
    {id:2,name:prefix+' 二',status:'提案中',summary:'原简介'},
    {id:3,name:prefix+' 三',status:'提案中',dueDate:'2026-99-99'}
  ],chips:[{id:1,name:prefix+' 芯片'},{id:2,name:prefix+' 未引用芯片'}]};
  load('src/web/imports.ts');await wait(()=>!!w.document.querySelector('#import-file'));
  const uploadFile=new File([JSON.stringify(fixture)],prefix+'.json',{type:'application/json'});
  Object.defineProperty(w.document.getElementById('import-file'),'files',{value:[uploadFile]});
  w.document.getElementById('import-file').dispatchEvent(new w.Event('change',{bubbles:true}));
  await wait(()=>!!w.document.querySelector('[data-card]'));
  batchId=new URL(w.location.href).searchParams.get('id');assert(batchId);
  const before=await api('/api/imports/'+batchId),ids=before.items.map(row=>row.id);
  assert(!w.document.querySelector('#batch-source,.import-workbench,[data-action=approve],[data-action=skip]'));
  assert.equal(w.document.querySelectorAll('[data-include],[data-difference][type=checkbox]').length,0,'不要求逐字段勾选');
  assert.equal(w.document.querySelector('.import-steps [aria-current=step]').textContent,'1 资料');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM projects WHERE name LIKE ?',[prefix+'%']))[0][0].n),0,'读取文件不写正式项目');
  click('[data-action=step-projects]');click(`#import-item-${ids[0]} [data-action=open-catalog]`);
  assert.equal(w.document.querySelector('.import-steps [aria-current=step]').textContent,'1 资料','项目依赖入口切回可保存资料的步骤');
  assert(w.document.querySelector('[data-action=back-project]'),'保留返回原项目入口');
  await wait(()=>enabled('#imports-save'));assert(w.document.getElementById('imports-save').textContent.includes('保存资料并查看项目'));
  click('#imports-save');await wait(()=>w.document.querySelector('.import-steps [aria-current=step]').textContent==='2 项目');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM projects WHERE name LIKE ?',[prefix+'%']))[0][0].n),0,'资料步骤不写正式项目');
  assert.equal((await api('/api/imports/'+batchId)).catalogRows.filter(row=>row.previousResult).length,2,'先保存引用及未引用资料');
  await wait(()=>enabled('#imports-save'));click('#imports-save');await wait(()=>w.document.getElementById('imports-save-status').textContent.includes('已保存 2 个')&&enabled('#imports-reload'));
  await wait(()=>w.document.querySelectorAll('.import-result').length===2);
  let after=await api('/api/imports/'+batchId);assert.equal(after.counts.processed,2);assert.equal(after.catalogRows.filter(row=>row.previousResult).length,2);
  const first=after.items[0],second=after.items[1];
  const firstDetail=await api('/api/projects/'+first.previousResult.projectId);assert.equal(firstDetail.stages[3].state,'unknown');assert.equal(firstDetail.project.chips.length,1);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_chip_selections WHERE project_id=?',[first.previousResult.projectId]))[0][0].n),1);
  checks.push('选择文件→先保存全部资料、项目仍未写入→项目确认保存正常项目；错误项目留原行');
  click(`#import-item-${ids[2]} [data-action=edit]`);
  await wait(()=>!!w.document.querySelector(`#import-item-${ids[2]} [data-value-path="fields.dueDate"]`));
  change(`#import-item-${ids[2]} [data-value-path="fields.dueDate"]`,'2026-11-12');
  await wait(()=>enabled('#imports-save')&&w.document.getElementById('imports-save').textContent.includes('1个'));
  lostAck=true;click('#imports-save');await wait(()=>!lostAck);await wait(()=>enabled('[data-action=execution-query]'));lostRead=true;click('[data-action=execution-query]');await wait(()=>!lostRead&&enabled('[data-action=execution-query]')&&w.document.body.textContent.includes('synthetic-read-failure'));
  assert(w.document.body.textContent.includes('synthetic-read-failure'),'查询失败提供排查编号');click('[data-action=execution-query]');await wait(()=>w.document.querySelectorAll('.import-result').length===3);
  after=await api('/api/imports/'+batchId);assert.equal((await api('/api/projects/'+after.items[2].previousResult.projectId)).project.dueDate,'2026-11-12');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?',[ids[2]]))[0][0].n),1);
  checks.push('错误日期原位置修正→确认导入；丢失执行响应且结果查询503后保留原请求，再查同一操作，仅一次采用');
  const firstProject=after.items[0].previousResult.projectId,firstVersion=(await api('/api/projects/'+firstProject)).project.version;
  const update={version:2,projects:[{id:222,name:prefix+' 二',summary:'新简介',statusDesc:'另一个未选内容'},{name:prefix+' 一'}]};
  const secondBatch=(await api('/api/imports/upload?'+new URLSearchParams({name:prefix+'-update.json',operation:randomUUID()}),update,true)).result.batchId;
  dom.window.close();
  // 同一浏览器会话进入新批次，执行真实前端模块；保留已登录 Cookie。
  dom=new JSDOM(fs.readFileSync('src/web/imports.html','utf8'),{url:origin+'/imports.html?id='+secondBatch,cookieJar:jar,runScripts:'outside-only',virtualConsole});
  const next=dom.window;Object.assign(next,{TextEncoder,TextDecoder,structuredClone,AbortSignal,AbortController,fetch:call});next.BroadcastChannel=class{postMessage(){}};next.EventSource=class{addEventListener(){}close(){}};next.ResizeObserver=class{observe(){}disconnect(){}};next.matchMedia=()=>({matches:false,addEventListener(){}});next.scrollTo=()=>{};
  next.addEventListener('error',event=>errors.push(event.message));
  next.HTMLElement.prototype.scrollIntoView=()=>{};
  const secondModules=new Map(),nextContext=dom.getInternalVMContext();
  function nextLoad(path){if(path.endsWith('.css'))return{};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(secondModules.has(path))return secondModules.get(path).exports;const module={exports:{}};secondModules.set(path,module);const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',nextContext,{filename:path})(name=>nextLoad(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  nextLoad('src/web/imports.ts');await wait(()=>!!next.document.querySelector('[data-difference="fields.summary"]'));
  assert(next.document.body.textContent.includes('与线上一致'));
  next.document.querySelector('[data-action=step-projects]').click();
  const select=next.document.querySelector('[data-difference="fields.summary"]');assert.equal(select.textContent,'保留线上');
  const exclude=next.document.querySelector('[data-difference="fields.statusDesc"]');assert.equal(exclude.textContent,'保留线上');exclude.click();
  await wait(()=>!next.document.getElementById('imports-save').disabled);
  assert(next.document.querySelector('[data-difference="fields.summary"]').closest('details').open,'默认展开前后差异');
  next.document.getElementById('imports-save').click();await wait(()=>next.document.querySelectorAll('.import-result').length===1);
  const updated=await api('/api/projects/'+second.previousResult.projectId);assert.equal(updated.project.summary,'新简介');assert.notEqual(updated.project.statusDesc,'另一个未选内容');
  const stored=(await c.query('SELECT summary,status_description FROM projects WHERE id=?',[second.previousResult.projectId]))[0][0];assert.equal(stored.summary,'新简介');assert.notEqual(stored.status_description,'另一个未选内容');
  const personal=await api('/api/projects?view=all&pageSize=100');assert(personal.items.some(row=>row.id===second.previousResult.projectId&&row.summary==='新简介'));
  checks.push('同名旧项目默认采用差异→排除状态说明→确认；独立SQL、详情和本人列表新读一致，排除说明不覆盖');
  assert.equal((await api('/api/projects/'+firstProject)).project.version,firstVersion);
  assert.equal((await api('/api/imports/'+secondBatch)).items[1].unchanged,true);
  checks.push('已有对应且内容相同的项目无需保存，不推进项目版本');
  const idsInPage=[...next.document.querySelectorAll('[id]')].map(element=>element.id);assert.equal(new Set(idsInPage).size,idsInPage.length);assert.deepEqual(errors,[]);assert(!http.some(row=>row.status>=400));

  // 在持久回执已提交、执行进度未确认这一崩溃边界重启页面；不在浏览器缓存提交正文。
  dom.window.close();
  const recoveryBatch=(await api('/api/imports/upload?'+new URLSearchParams({name:prefix+'-recovery.json',operation:randomUUID()}),{projects:[{name:prefix+' 冷启动恢复',status:'提案中'}]},true)).result.batchId;
  const recovery=await api('/api/imports/'+recoveryBatch),recoveryItem=recovery.items[0],operationId=randomUUID();
  const recoveryCommand={expectedBatchVersion:recovery.batch.version,expectedReviewVersion:recoveryItem.reviewVersion,expectedVersion:recoveryItem.expectedVersion,basis:recoveryItem.basis,selected:recoveryItem.defaultSelected,idempotencyKey:randomUUID()};
  await api('/api/imports/'+recoveryBatch+'/executions',{formatVersion:2,stage:'projects',idempotencyKey:operationId,items:[{id:recoveryItem.id,command:recoveryCommand}]},false,202);
  let original;
  for(let attempt=0;attempt<100;attempt++){original=await api('/api/imports/'+recoveryBatch+'/executions?operation='+operationId);if(original.status==='finished')break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(original.status,'finished');assert.equal(original.items[0].status,'committed');
  const storedProgress=(await c.query('SELECT progress_json FROM import_executions WHERE id=?',[original.id]))[0][0].progress_json;
  const progress=typeof storedProgress==='string'?JSON.parse(storedProgress):storedProgress;progress[recoveryItem.id]={status:'confirming',code:'IMPORT_RESULT_UNKNOWN'};
  await c.execute("UPDATE import_executions SET status='paused',progress_json=?,lease_token=NULL,lease_until=NULL WHERE id=?",[JSON.stringify(progress),original.id]);
  dom=new JSDOM(fs.readFileSync('src/web/imports.html','utf8'),{url:origin+'/imports.html?id='+recoveryBatch,cookieJar:jar,runScripts:'outside-only',virtualConsole});
  const cold=dom.window;Object.assign(cold,{TextEncoder,TextDecoder,structuredClone,AbortSignal,AbortController,fetch:call});cold.BroadcastChannel=class{postMessage(){}};cold.EventSource=class{addEventListener(){}close(){}};cold.ResizeObserver=class{observe(){}disconnect(){}};cold.matchMedia=()=>({matches:false,addEventListener(){}});cold.scrollTo=()=>{};
  cold.addEventListener('error',event=>errors.push(event.message));
  cold.HTMLElement.prototype.scrollIntoView=()=>{};
  const coldModules=new Map(),coldContext=dom.getInternalVMContext();
  function coldLoad(path){if(path.endsWith('.css'))return{};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(coldModules.has(path))return coldModules.get(path).exports;const module={exports:{}};coldModules.set(path,module);const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',coldContext,{filename:path})(name=>coldLoad(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  coldLoad('src/web/imports.ts');await wait(()=>!!cold.document.querySelector('[data-action=execution-resume][data-operation="'+operationId+'"]'));
  const browserState=JSON.parse(cold.localStorage.getItem('geekdash_imports:'+actor)).state;
  assert(!Object.values(browserState.executions??{}).some(request=>request.body.idempotencyKey===operationId),'恢复入口不依赖本机提交缓存');
  cold.document.querySelector('[data-action=execution-resume][data-operation="'+operationId+'"]').click();
  await wait(()=>!cold.document.querySelector('[data-action=execution-resume][data-operation="'+operationId+'"]')&&cold.document.body.textContent.includes('原操作已确认保存。'));
  assert.equal((await api('/api/imports/'+recoveryBatch+'/executions?operation='+operationId)).status,'finished');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM import_executions WHERE batch_id=?',[recoveryBatch]))[0][0].n),1);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?',[recoveryItem.id]))[0][0].n),1);
  assert.deepEqual(errors,[]);checks.push('无本机请求缓存的冷启动从服务器显示恢复入口→沿原操作核对成功→反馈解除，执行与采用均只有一条');
  const result={status:'passed',checkedAt:new Date().toISOString(),build:JSON.parse(fs.readFileSync('dist/build-info.json','utf8')),requests:http.length,checks,limitation:'实际前端执行模型与真实HTTP/MySQL；原生像素及全部权限结果另验'};
  fs.writeFileSync('test-results/import-workbench.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  await api('/api/auth/logout',{});
}finally{dom?.window.close();if(app)await app.close();await c.end();}
