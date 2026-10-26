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
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error.message));
  dom=new JSDOM(fs.readFileSync('src/web/imports.html','utf8'),{url:origin+'/imports.html',cookieJar:jar,runScripts:'outside-only',virtualConsole});
  const w=dom.window;Object.assign(w,{TextEncoder,TextDecoder,structuredClone,AbortSignal,AbortController,fetch:call});w.BroadcastChannel=class{postMessage(){}};w.EventSource=class{addEventListener(){}close(){}};w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};
  Object.defineProperty(w.crypto,'subtle',{value:globalThis.crypto.subtle});
  w.addEventListener('error',event=>errors.push(event.message));
  const modules=new Map(),context=dom.getInternalVMContext();
  function load(path){if(path.endsWith('.css'))return{};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(modules.has(path))return modules.get(path).exports;const module={exports:{}};modules.set(path,module);const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',context,{filename:path})(name=>load(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  const wait=async predicate=>{const deadline=Date.now()+20000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}fs.writeFileSync('test-results/import-workbench-timeout.html',dom.window.document.documentElement.outerHTML);throw new Error('界面等待超时：'+dom.window.document.getElementById('imports-save-status')?.textContent+' / '+JSON.stringify(errors));};
  const click=selector=>{const element=w.document.querySelector(selector);assert(element,'缺少操作 '+selector);assert(!element.disabled,'操作仍不可用 '+selector);element.click();};
  const change=(selector,value)=>{const input=w.document.querySelector(selector);assert(input,selector);input.value=value;input.dispatchEvent(new w.Event(input.tagName==='SELECT'?'change':'input',{bubbles:true}));};
  const enabled=selector=>!!w.document.querySelector(selector)&&!w.document.querySelector(selector).disabled;
  const choose=(selector,checked)=>{const input=w.document.querySelector(selector);assert(input,selector);input.checked=checked;input.dispatchEvent(new w.Event('change',{bubbles:true}));};
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
  assert.equal(w.document.querySelectorAll('[data-include]:checked').length,3);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM projects WHERE name LIKE ?',[prefix+'%']))[0][0].n),0,'读取文件不写正式项目');
  await wait(()=>enabled('#imports-save'));assert(w.document.getElementById('imports-save').textContent.includes('2个项目'));
  click('#imports-save');await wait(()=>w.document.getElementById('imports-save-status').textContent.includes('已入库 2 / 2')&&enabled('#imports-reload'));
  await wait(()=>w.document.querySelectorAll('.import-result').length===2);
  let after=await api('/api/imports/'+batchId);assert.equal(after.counts.processed,2);assert.equal(after.catalogRows.filter(row=>row.previousResult).length,2);
  const first=after.items[0],second=after.items[1];
  const firstDetail=await api('/api/projects/'+first.previousResult.projectId);assert.equal(firstDetail.stages[3].state,'unknown');assert.equal(firstDetail.project.chips.length,1);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_chips WHERE project_id=?',[first.previousResult.projectId]))[0][0].n),1);
  checks.push('选择文件→查看新增与差异→一次确认保存两个正常项目及全部新资料；错误项目留原行，未知阶段不额外填表');
  click(`#import-item-${ids[2]} [data-action=edit]`);
  await wait(()=>!!w.document.querySelector(`#import-item-${ids[2]} [data-value-path="fields.dueDate"]`));
  change(`#import-item-${ids[2]} [data-value-path="fields.dueDate"]`,'2026-11-12');
  await wait(()=>enabled('#imports-save')&&w.document.getElementById('imports-save').textContent.includes('1个项目'));
  lostAck=true;click('#imports-save');await wait(()=>!lostAck);await wait(()=>w.document.querySelectorAll('.import-result').length===3);
  after=await api('/api/imports/'+batchId);assert.equal((await api('/api/projects/'+after.items[2].previousResult.projectId)).project.dueDate,'2026-11-12');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?',[ids[2]]))[0][0].n),1);
  checks.push('错误日期原位置修正→确认导入；丢失执行响应后查原操作，只产生一次采用');
  const collaborator=prefix+' 协作者';
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix+'_peer',await hashPassword(password),collaborator]);
  const firstProject=after.items[0].previousResult.projectId,firstVersion=(await api('/api/projects/'+firstProject)).project.version;
  const update={version:2,projects:[{id:222,name:prefix+' 二',summary:'新简介',statusDesc:'另一个未选内容'},{name:prefix+' 一',pm:collaborator}]};
  const secondBatch=(await api('/api/imports/upload?'+new URLSearchParams({name:prefix+'-update.json',operation:randomUUID()}),update,true)).result.batchId;
  dom.window.close();
  // 同一浏览器会话进入新批次，执行真实前端模块；保留已登录 Cookie。
  dom=new JSDOM(fs.readFileSync('src/web/imports.html','utf8'),{url:origin+'/imports.html?id='+secondBatch,cookieJar:jar,runScripts:'outside-only',virtualConsole});
  const next=dom.window;Object.assign(next,{TextEncoder,TextDecoder,structuredClone,AbortSignal,AbortController,fetch:call});next.BroadcastChannel=class{postMessage(){}};next.EventSource=class{addEventListener(){}close(){}};next.matchMedia=()=>({matches:false,addEventListener(){}});next.scrollTo=()=>{};
  next.addEventListener('error',event=>errors.push(event.message));
  const secondModules=new Map(),nextContext=dom.getInternalVMContext();
  function nextLoad(path){if(path.endsWith('.css'))return{};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(secondModules.has(path))return secondModules.get(path).exports;const module={exports:{}};secondModules.set(path,module);const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',nextContext,{filename:path})(name=>nextLoad(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  nextLoad('src/web/imports.ts');await wait(()=>!!next.document.querySelector('[data-difference="fields.summary"]'));
  assert(next.document.body.textContent.includes('确认导入后邀请 '+collaborator+' 协作'));assert.equal(next.document.querySelectorAll('[data-include]:checked').length,1);
  const select=next.document.querySelector('[data-difference="fields.summary"]');assert.equal(select.checked,false);assert.equal(next.document.querySelector('[data-difference="fields.statusDesc"]').checked,false);
  const details=select.closest('details');details.open=true;select.checked=true;select.dispatchEvent(new next.Event('change',{bubbles:true}));
  await wait(()=>!next.document.getElementById('imports-save').disabled);
  assert(next.document.querySelector('[data-difference="fields.summary"]').closest('details').open,'勾选后保持当前位置展开');
  next.document.getElementById('imports-save').click();await wait(()=>next.document.querySelectorAll('.import-result').length===2);
  const updated=await api('/api/projects/'+second.previousResult.projectId);assert.equal(updated.project.summary,'新简介');assert.notEqual(updated.project.statusDesc,'另一个未选内容');
  const stored=(await c.query('SELECT summary,status_description FROM projects WHERE id=?',[second.previousResult.projectId]))[0][0];assert.equal(stored.summary,'新简介');assert.notEqual(stored.status_description,'另一个未选内容');
  const personal=await api('/api/projects?view=all&pageSize=100');assert(personal.items.some(row=>row.id===second.previousResult.projectId&&row.summary==='新简介'));
  checks.push('同名旧项目只勾选简介→确认→独立SQL、详情和本人列表新读一致；未选说明不覆盖、勾选不收起当前差异');
  assert.equal((await api('/api/projects/'+firstProject)).project.version,firstVersion);
  assert.equal((await c.query("SELECT r.id FROM project_membership_requests r JOIN users u ON u.id=r.target_user_id WHERE r.project_id=? AND u.display_name=? AND r.status='pending'",[firstProject,collaborator]))[0].length,1);
  checks.push('已有项目正文相同、仅备份新增经理：原结果显示协作请求，允许取消；一次确认产生待接受邀请，未改项目版本');
  const idsInPage=[...next.document.querySelectorAll('[id]')].map(element=>element.id);assert.equal(new Set(idsInPage).size,idsInPage.length);assert.deepEqual(errors,[]);assert(!http.some(row=>row.status>=400));
  const result={status:'passed',checkedAt:new Date().toISOString(),build:JSON.parse(fs.readFileSync('dist/build-info.json','utf8')),requests:http.length,checks,limitation:'实际前端执行模型与真实HTTP/MySQL；原生像素及全部权限结果另验'};
  fs.writeFileSync('test-results/import-workbench.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  await api('/api/auth/logout',{});
}finally{dom?.window.close();if(app)await app.close();await c.end();}
