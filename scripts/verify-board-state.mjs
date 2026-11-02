import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createApp} from '../dist/server/app.js';
import {connectDatabase} from '../dist/server/infrastructure/db.js';
import {openRuntimeDatabase} from '../dist/server/infrastructure/runtime-database.js';
import {hashPassword} from '../dist/server/modules/identity.js';

// 仅在明确隔离的测试库执行真实页面事件、HTTP保存及独立SQL回读，不代替用户视觉验收。
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
const database=(await c.query('SELECT DATABASE() db,@@server_uuid uuid'))[0][0];
assert.equal(database.db,'geekdash_test');assert.equal(database.uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const {JSDOM,CookieJar,VirtualConsole}=await import(process.env.GEEKDASH_DOM_LIBRARY??'../test-results/ui-dom-tools/node_modules/jsdom/lib/api.js');
const prefix='board_state_'+randomUUID().slice(0,8),password='Board-state-test-2026',jar=new CookieJar(),writes=[],draftWrites=[],errors=[],checks=[];
let app,origin,dom,user,id,actor,failRead=false,requests=0,inFlight=0;
async function request(path,options={}){
  requests++;const url=origin+path,headers=new Headers(options.headers);headers.set('Origin','http://localhost');headers.set('Cookie',jar.getCookieStringSync(url));
  let signal=options.signal;if(signal&&!(signal instanceof AbortSignal)){const bridge=new AbortController();if(signal.aborted)bridge.abort();else signal.addEventListener('abort',()=>bridge.abort(),{once:true});signal=bridge.signal;}
  const response=await fetch(url,{...options,headers,...signal?{signal}:{}});for(const cookie of response.headers.getSetCookie())jar.setCookieSync(cookie,url);return response;
}
async function api(path,method='GET',body){
  const csrf=jar.getCookiesSync(origin).find(row=>row.key==='geekdash_dev_csrf')?.value;
  const response=await request(path,{method,headers:{'Content-Type':'application/json','X-GeekDash-Request':'1',...csrf?{'X-GeekDash-CSRF':csrf}:{},...actor?{'X-GeekDash-Account':actor}:{}},...body?{body:JSON.stringify(body)}:{}});
  const data=await response.json();assert.equal(response.status,200,path+': '+JSON.stringify(data));return data;
}
async function wait(predicate,message){const end=Date.now()+10000;while(Date.now()<end){if(errors.length)throw errors[0];if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error(message+'：'+(dom?.window.document.querySelector('#message')?.textContent??''));}
async function facts(){const {connection}=await connectDatabase('test_app');try{return {project:(await connection.query('SELECT summary,CAST(version AS CHAR) version FROM projects WHERE id=?',[id]))[0][0],tasks:(await connection.query('SELECT task_key id,content text,completed_at_text completedAt,deleted_at_text deletedAt FROM project_tasks WHERE project_id=? ORDER BY sort_order',[id]))[0]};}finally{await connection.end();}}
try{
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES(?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix,await hashPassword(password),prefix]);
  user=(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  app=await createApp(await openRuntimeDatabase('test_app'),{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
  await api('/api/auth/login','POST',{loginName:prefix,password});actor=(await api('/api/auth/me')).account.id;
  id=(await api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix,summary:'原项目状态'}})).result.projectId;
  const taskId=randomUUID();await api('/api/projects/'+id,'PATCH',{scope:'status',expectedVersion:'1',idempotencyKey:randomUUID(),changes:{taskOps:[{op:'add',id:taskId,text:'既有任务'}]}});
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error));
  dom=new JSDOM(await readFile('src/web/index.html','utf8'),{url:origin+'/?view=all&search='+prefix,cookieJar:jar,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  const w=dom.window,stageSource=(await readFile('geekdashdesktop/projects-data.js','utf8')).match(/const STAGES = (\[[\s\S]*?\n  \]);/);
  Object.assign(w,{structuredClone,TextEncoder,TextDecoder,AbortSignal:{timeout:ms=>AbortSignal.timeout(ms),any:signals=>signals[0]},__GEEKDASH_STAGES__:vm.runInNewContext(stageSource[1])});
  w.BroadcastChannel=class{postMessage(){}};w.ResizeObserver=class{observe(){}disconnect(){}};w.scrollTo=()=>{};w.performance.getEntriesByType=()=>[];w.CSS={escape:value=>value};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;this.returnValue='';};w.HTMLDialogElement.prototype.close=function(value=''){this.returnValue=value;this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.fetch=async(path,options={})=>{
    inFlight++;try{
    if(failRead&&path==='/api/projects/'+id&&!options.method){failRead=false;throw Error('模拟保存后读取失败');}
    if(options.method==='PATCH')writes.push(JSON.parse(options.body));
    let response;try{response=await request(path,options);}catch(error){errors.push(error);throw error;}if(path==='/api/personal/drafts/save'&&response.ok)draftWrites.push(JSON.parse(options.body));return response;
    }finally{inFlight--;}
  };
  const context=dom.getInternalVMContext(),modules=new Map();
  function load(path){if(path.endsWith('.css'))return {};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(modules.has(path))return modules.get(path).exports;const module={exports:{}};modules.set(path,module);const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',context,{filename:path})(name=>load(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  load('src/web/board.ts');
  const $=selector=>w.document.querySelector(selector),input=(selector,value)=>{const el=$(selector);assert(el,selector);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));},click=selector=>{const el=$(selector);assert(el,selector);assert(!el.disabled,selector);el.click();};
  const summary='[data-project-summary="'+id+'"]',card='[data-project-id="'+id+'"]',save=card+' [data-status-action="save"]';
  await wait(()=>$('#result-count').textContent.includes('截至'),'看板就绪');
  assert.equal($(card+' .board-status-heading').textContent,'项目状态');assert(!$('.board-card-heading .card-desc'));assert(! $('[data-card-content]'));
  assert.equal($(card+' .board-project-state').textContent,'原项目状态');assert($(card+' [data-task-action="complete"]'));
  click(card+' [data-status-action="edit"]');const noChange=(await facts()).project.version;click(save);
  await wait(()=>!$(summary),'无修改退出编辑');assert.equal(writes.length,0);assert.equal((await facts()).project.version,noChange);
  click(card+' [data-status-action="edit"]');input(summary,'保留的未保存状态');
  await wait(()=>draftWrites.some(row=>row.formKind==='project'&&row.payload.values.summary==='保留的未保存状态'),'状态文字草稿同步');
  click(card+' [data-task-row="'+taskId+'"] [data-task-action="complete"]');
  await wait(()=>writes.length===1&&$(summary)&&!$(save).disabled&&(w.document.querySelectorAll(card+' [data-task-row]').length===0),'单任务保存完成');
  assert.equal(writes[0].scope,'status');assert.deepEqual(writes[0].changes,{taskOps:[{op:'complete',id:taskId}]});assert(!writes[0].draft);
  let row=await facts();assert.equal(row.project.summary,'原项目状态');assert(row.tasks[0].completedAt);assert.equal($(summary).value,'保留的未保存状态');
  await wait(async()=>{const drafts=await api('/api/personal/drafts?projectId='+id);return drafts.items.some(d=>d.formKind==='project'&&d.baseVersion===row.project.version&&d.state==='active'&&d.payload.values.summary==='保留的未保存状态');},'单任务保存后未保存状态草稿继续存在');
  click(save);await wait(()=>writes.length===2&&!$(summary),'状态区保存完成');assert.equal(writes[1].scope,'project');assert.deepEqual(writes[1].changes,{summary:'保留的未保存状态'});assert.equal((await facts()).project.summary,'保留的未保存状态');
  assert.equal((await api('/api/projects/'+id)).project.summary,'保留的未保存状态');
  checks.push('真实卡片单任务完成只提交taskOps，SQL状态文字不变，未保存summary输入/云稿保留并推进版本；后续区域保存只提交summary，新请求读回一致');
  click(card+' [data-status-action="edit"]');input(summary,'第二份未保存状态');input(card+' [data-task-bulk]','1、新增并直接完成');
  click(card+' [data-task-action="complete"]');await wait(()=>writes.length===3&&!$(save).disabled,'新增任务直接完成');
  assert.equal(writes[2].scope,'status');assert.deepEqual(writes[2].changes.taskOps.map(op=>op.op),['add','complete']);assert(!('summary' in writes[2].changes));
  row=await facts();assert.equal(row.project.summary,'保留的未保存状态');assert(row.tasks.some(task=>task.text==='新增并直接完成'&&task.completedAt));assert.equal($(summary).value,'第二份未保存状态');
  input(card+' [data-task-bulk]','1、新增后直接编辑');click(card+' [data-task-action="edit"]');input(card+' [data-task-text]','新增任务修改后');
  [...w.document.querySelectorAll(card+' .task-actions button')].find(button=>button.textContent==='保存').click();
  await wait(()=>writes.length===4&&!$(save).disabled,'新增任务逐条编辑保存');assert.equal(writes[3].scope,'status');assert(!('summary' in writes[3].changes));assert.equal((await facts()).project.summary,'保留的未保存状态');assert((await facts()).tasks.some(task=>task.text==='新增任务修改后'&&!task.completedAt));
  checks.push('新任务尚未整体保存时可以直接完成或编辑保存，只保存这条任务，另有summary输入保留');
  input(card+' [data-task-bulk]','1、新增任务修改后\n2、随状态共同保存');click(save);
  await wait(()=>writes.length===5&&!$(summary),'两字段同区提交');assert.equal(writes[4].scope,'project');assert.deepEqual(Object.keys(writes[4].changes).sort(),['summary','taskOps']);row=await facts();assert.equal(row.project.summary,'第二份未保存状态');assert(row.tasks.some(task=>task.text==='随状态共同保存'));
  const fresh=(await api('/api/projects/'+id)).project;assert.equal(fresh.summary,row.project.summary);assert(fresh.tasks.some(task=>task.text==='随状态共同保存'));
  checks.push('同区明确保存summary与任务，实际项目事务写入，两类内容相互独立，新GET与SQL一致');
  click(card+' [data-status-action="edit"]');input(summary,'读取失败后仍可确认');failRead=true;click(save);
  await wait(()=>writes.length===6&&$(card+' [data-status-action="query"]')&&!$(card+' [data-status-action="query"]').disabled,'保存成功但读回失败保留确认入口');
  const savedVersion=(await facts()).project.version;click(card+' [data-status-action="query"]');await wait(()=>!$(summary),'读取原结果成功');assert.equal(writes.length,6);assert.equal((await facts()).project.version,savedVersion);
  click(card+' [data-status-action="edit"]');input(summary,'冲突时保留此输入');const before=await facts();await api('/api/projects/'+id,'PATCH',{scope:'basic',expectedVersion:before.project.version,idempotencyKey:randomUUID(),changes:{summary:'另一窗口已保存'}});click(save);
  await wait(()=>$(save)?.disabled&&$(card+' .board-status-feedback').textContent.includes('他人更新'),'旧版本被拒绝');assert.equal($(summary).value,'冲突时保留此输入');assert.equal((await facts()).project.summary,'另一窗口已保存');
  checks.push('已提交但新读失败可核对原结果，无重复PATCH/版本；其他窗口更新产生真实冲突并保留未保存文字，不能覆盖');
  await mkdir('test-results',{recursive:true});await writeFile('test-results/board-state.json',JSON.stringify({status:'passed',database,requests,checks,productBrowserTested:false},null,2));console.log(JSON.stringify({status:'passed',checks:checks.length,requests,evidence:'test-results/board-state.json'}));
}finally{
  if(dom){for(let i=0;i<100&&inFlight;i++)await new Promise(resolve=>setTimeout(resolve,20));await new Promise(resolve=>setTimeout(resolve,50));dom.window.close();}if(app)await app.close();
  if(user)for(const table of ['project_drafts','user_preferences'])await c.query(`DELETE FROM ${table} WHERE user_id=?`,[user]);
  if(id){for(const table of ['audit_log','project_tasks','project_checks','schedule_changes','project_changes','project_risks','project_nodes','project_stages','project_people','project_chips','project_tags','project_responsibilities','project_membership_requests','project_name_aliases'])await c.query(`DELETE FROM ${table} WHERE project_id=?`,[id]);await c.query('DELETE FROM projects WHERE id=?',[id]);}
  if(user){for(const table of ['command_receipts','audit_log'])await c.query(`DELETE FROM ${table} WHERE actor_id=?`,[user]);await c.query('DELETE FROM sessions WHERE user_id=?',[user]);await c.query('DELETE FROM users WHERE id=?',[user]);}await c.end();
}
