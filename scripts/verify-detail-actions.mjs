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
const prefix='detail_actions_'+randomUUID().slice(0,8),password='Board-state-test-2026',jar=new CookieJar(),writes=[],draftWrites=[],errors=[],checks=[];
let app,origin,dom,user,id,actor,failRead=false,dropAck=false,requests=0,inFlight=0;
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
async function recordFacts(){const {connection}=await connectDatabase('test_app');try{return {risks:(await connection.query('SELECT content,level,resolved,deleted_at deletedAt FROM project_risks WHERE project_id=? ORDER BY id',[id]))[0],changes:(await connection.query('SELECT content,decision,reason FROM project_changes WHERE project_id=? ORDER BY id',[id]))[0]};}finally{await connection.end();}}
async function facts(){const {connection}=await connectDatabase('test_app');try{return {project:(await connection.query('SELECT summary,CAST(version AS CHAR) version FROM projects WHERE id=?',[id]))[0][0],tasks:(await connection.query('SELECT task_key id,content text,completed_at_text completedAt,deleted_at_text deletedAt FROM project_tasks WHERE project_id=? ORDER BY sort_order',[id]))[0]};}finally{await connection.end();}}
try{
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES(?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[prefix,await hashPassword(password),prefix]);
  user=(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
  app=await createApp(await openRuntimeDatabase('test_app'),{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
  await api('/api/auth/login','POST',{loginName:prefix,password});actor=(await api('/api/auth/me')).account.id;
  id=(await api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix,summary:'原项目状态'}})).result.projectId;
  const taskId=randomUUID();await api('/api/projects/'+id,'PATCH',{scope:'status',expectedVersion:'1',idempotencyKey:randomUUID(),changes:{taskOps:[{op:'add',id:taskId,text:'既有任务'}]}});
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error));
  dom=new JSDOM(await readFile('src/web/project-detail.html','utf8'),{url:origin+'/project-detail.html?id='+id,cookieJar:jar,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  const w=dom.window,stageSource=(await readFile('geekdashdesktop/projects-data.js','utf8')).match(/const STAGES = (\[[\s\S]*?\n  \]);/);
  Object.assign(w,{structuredClone,TextEncoder,TextDecoder,AbortSignal:{timeout:ms=>AbortSignal.timeout(ms),any:signals=>signals[0]},__GEEKDASH_STAGES__:vm.runInNewContext(stageSource[1])});
  w.BroadcastChannel=class{postMessage(){}};w.ResizeObserver=class{observe(){}disconnect(){}};w.scrollTo=()=>{};w.performance.getEntriesByType=()=>[];w.CSS={escape:value=>value};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;this.returnValue='';};w.HTMLDialogElement.prototype.close=function(value=''){this.returnValue=value;this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.fetch=async(path,options={})=>{
    inFlight++;try{
    if(failRead&&path==='/api/projects/'+id&&!options.method){failRead=false;throw Error('模拟保存后读取失败');}
    if(options.method==='PATCH')writes.push(JSON.parse(options.body));
    let response;try{response=await request(path,options);}catch(error){errors.push(error);throw error;}if(options.method==='PATCH'&&!response.ok)console.log('PATCH_RESULT',await response.clone().text());if(path==='/api/personal/drafts/save'&&response.ok)draftWrites.push(JSON.parse(options.body));if(dropAck&&options.method==='PATCH'&&response.ok){dropAck=false;await response.arrayBuffer();throw Error('模拟COMMIT后确认丢失');}return response;
    }finally{inFlight--;}
  };
  const context=dom.getInternalVMContext(),modules=new Map();
  function load(path){if(path.endsWith('.css'))return {};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(modules.has(path))return modules.get(path).exports;const module={exports:{}};modules.set(path,module);const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',context,{filename:path})(name=>load(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  load('src/web/detail.ts');
  const $=selector=>w.document.querySelector(selector),input=(selector,value)=>{const el=$(selector);assert(el,selector);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));},click=selector=>{const el=$(selector);assert(el,selector);assert(!el.disabled,selector);el.click();};
  const tab=value=>click('[data-tab="'+value+'"]');
  const idle=()=>inFlight===0&&!$('#reload').disabled;
  const submit=selector=>{const form=$(selector);assert(form&&form.reportValidity(),selector+' 有效表单');form.requestSubmit();};
  const getDetail=()=>api('/api/projects/'+id);
  const saved=async(count,message)=>wait(()=>writes.length===count&&idle()&&!$('#risk-edit')&&!$('#change-edit'),message);
  await wait(()=>!$('#detail-panel').hidden&&idle()&&$('[data-task-action="complete"]'),'详情初始读取后任务操作出现');
  const extra=w.document.createElement('section'),taskUi=load('src/web/shared/tasks.ts'),taskEditor=load('src/web/shared/task-editor.ts');
  for(const withBulk of [true,false]){const taskState={tasks:[{id:'a',text:'第一条',completedAt:'',deletedAt:''},{id:'b',text:'第二条',completedAt:'',deletedAt:''}],ops:[],editable:false,showActions:true};
  extra.innerHTML=withBulk?taskUi.taskPanel(taskState.tasks,[],true):taskUi.taskList(taskState.tasks,true);w.document.body.append(extra);taskEditor.bindTaskEditor(extra,()=>taskState,(ops,bulk)=>{taskState.ops=ops;taskState.bulk=bulk;},()=>[],()=>{});
  assert.equal(extra.querySelectorAll('[data-task-action="edit"]').length,2);extra.querySelectorAll('[data-task-action="edit"]')[1].click();assert(!extra.querySelector('[data-task-text]'),'暂时冻结不执行操作');
  taskState.editable=true;extra.querySelectorAll('[data-task-action="edit"]')[1].click();const text=extra.querySelector('[data-task-text]');text.value='临时修改';text.dispatchEvent(new w.Event('input',{bubbles:true}));[...extra.querySelectorAll('button')].find(button=>button.textContent==='取消').click();assert.equal(extra.querySelector('[data-task-row="b"] .task-number').textContent,'2','取消第二条编辑不重编号为1');assert(!extra.querySelector('[data-task-text]'),'无大框的行内取消也恢复普通文本');assert.equal(extra.querySelector('[data-task-row="b"] .task-text').textContent,'第二条');if(withBulk)assert.equal(extra.querySelector('[data-task-bulk]').value,'1、第一条\n2、第二条','取消后大框也恢复，不残留临时文字');extra.remove();}
  for(const action of ['complete','edit','delete'])assert($('[data-task-action="'+action+'"]'));
  click('[data-task-action="edit"]');input('[data-task-text]','任务修改待整体保存');assert.equal(writes.length,0);
  click('[data-task-action="complete"]');assert.equal(writes.length,0);assert.equal((await facts()).tasks[0].completedAt,'');
  click('#save-project');await wait(()=>writes.length===1&&idle()&&!$('#save-project').disabled===false,'标题保存任务');
  assert.equal(writes[0].scope,'project');assert.equal((await facts()).tasks[0].text,'任务修改待整体保存');assert((await facts()).tasks[0].completedAt);
  $('#status-history').open=true;$('#status-history').dispatchEvent(new w.Event('toggle'));await wait(()=>$('[data-task-history="completed"]'),'历史开关');click('[data-task-history="completed"]');
  assert($('[data-task-action="reopen"]'));assert($('[data-task-action="edit"]'));assert($('[data-task-action="delete"]'));
  click('[data-task-action="reopen"]');assert.equal(writes.length,1);click('#save-project');await wait(()=>writes.length===2&&idle(),'任务恢复整体保存');
  assert.equal((await facts()).tasks[0].completedAt,'');assert($('[data-task-action="complete"]'));
  checks.push('实际详情初始化及自身保存后，待办/完成任务操作持续存在；编辑、完成、恢复只暂存，标题保存后SQL和新请求一致');
  input('#edit-name',prefix+'名称未保存');tab('risk');click('[data-risk="add"]');input('#risk-content','原风险');click('[data-risk-level="high"]');assert($('#risk-accept').hidden);assert(!$('#risk-submit').disabled);submit('#risk-edit');await saved(3,'新增风险');
  let d=await getDetail(),risk=d.risks[0].id;assert.equal(writes[2].scope,'risk');assert.deepEqual(Object.keys(writes[2].changes),['riskOps']);assert(!('basicIntent' in writes[2]));assert(!('commands' in writes[2]));assert.equal(d.project.name,prefix);assert.equal(d.risks[0].level,'high');
  tab('info');assert.equal($('#edit-name').value,prefix+'名称未保存');tab('risk');click('[data-risk="correct"][data-risk-id="'+risk+'"]');input('#risk-content','纠正风险文字');click('[data-risk-level="low"]');submit('#risk-edit');await saved(4,'纠正风险文字及等级');
  d=await getDetail();assert.equal(d.risks[0].content,'纠正风险文字');assert.equal(d.risks[0].level,'low');assert.equal(d.project.name,prefix);assert.equal((await recordFacts()).risks[0].content,'纠正风险文字');
  checks.push('风险新增/纠正通过实际输入和submit只保存当前风险，名称等其他区输入保留，原处可见按钮不依赖未发生的预览');
  click('[data-risk="resolve"][data-risk-id="'+risk+'"]');input('#risk-resolution','已处理');submit('#risk-edit');await saved(5,'解除风险');assert.equal((await recordFacts()).risks[0].resolved,1);
  click('[data-risk="undoResolve"][data-risk-id="'+risk+'"]');input('#risk-reason','刚才误解除');submit('#risk-edit');await wait(()=>$('#risk-accept')&&!$('#risk-accept').hidden&&!$('#risk-accept').disabled,'撤销解除预览');assert.equal(writes.length,5);click('#risk-accept');await saved(6,'撤销解除');assert.equal((await recordFacts()).risks[0].resolved,0);
  click('[data-risk="delete"][data-risk-id="'+risk+'"]');submit('#risk-edit');await saved(7,'删除风险');assert((await recordFacts()).risks[0].deletedAt);assert.equal((await getDetail()).risks.length,0);
  checks.push('风险解除、撤销误解除预览和确认、删除均真实提交当前记录；撤销预览不提前写入，原风险历史保留');
  click('[data-change="add"]');input('#chg-content','新增需求');input('#chg-reason','业务需要');submit('#change-edit');await saved(8,'新增需求');d=await getDetail();const change=d.changes[0].id;
  assert.equal(writes[7].scope,'change');assert.deepEqual(Object.keys(writes[7].changes),['changeOps']);assert.equal(d.project.name,prefix);
  click('[data-change="correct"][data-change-id="'+change+'"]');input('#chg-content','需求文字纠正');const decision=$('[name="chg-decision"][value="reject"]');decision.checked=true;decision.dispatchEvent(new w.Event('input',{bubbles:true}));input('#chg-reason','需求超出范围');submit('#change-edit');await saved(9,'纠正需求');
  d=await getDetail();assert.equal(d.changes[0].content,'需求文字纠正');assert.equal(d.changes[0].decision,'reject');assert.equal((await recordFacts()).changes[0].reason,'需求超出范围');assert.equal(d.project.name,prefix);
  checks.push('需求新增、文字/接受拒绝/理由纠正原处保存，独立SQL与新GET一致，不夹带其他区输入');
  // 两类表单都有输入时，原处风险保存仍保留需求表单；标题保存再一起提交需求和基本信息。
  click('[data-change="add"]');input('#chg-content','随标题保存的需求');input('#chg-reason','保留另一区输入');
  click('[data-risk="add"]');input('#risk-content','当前风险单独保存');submit('#risk-edit');await saved(10,'风险保存保留另类未保存表单');
  d=await getDetail();assert.equal(d.changes.length,1);assert.equal(d.project.name,prefix);
  click('#save-project');await wait(()=>writes.length===11&&idle()&&!$('#change-edit'),'标题聚合保存');d=await getDetail();assert.equal(writes[10].scope,'project');assert.equal(d.project.name,prefix+'名称未保存');assert.equal(d.changes.length,2);assert.equal(d.risks.length,1);
  checks.push('原处风险保存后未保存的需求表单和基本信息仍保留；标题只发一次project请求保存剩余修改，未重复保存风险');
  // 标题前端校验不通过时暂存A；原处保存B不能顺带提交A，之后仍可单独纠正并保存A。
  tab('info');input('#edit-name','');tab('risk');click('[data-risk="add"]');input('#risk-content','暂存风险A');click('#save-project');await wait(()=>idle()&&$('#error-name')?.textContent,'标题名称校验');assert.equal(writes.length,11);
  tab('risk');click('[data-risk="add"]');input('#risk-content','单独风险B');submit('#risk-edit');await saved(12,'保存风险B不提交风险A');d=await getDetail();assert(d.risks.some(row=>row.content==='单独风险B'));assert(!d.risks.some(row=>row.content==='暂存风险A'));
  const stagedRisk=[...w.document.querySelectorAll('.risk-item')].find(row=>row.querySelector('.risk-content')?.textContent==='暂存风险A');assert(stagedRisk);stagedRisk.querySelector('[data-risk="correct"]').click();input('#risk-content','暂存风险A已纠正');submit('#risk-edit');await saved(13,'纠正已暂存新增风险并单独保存');assert((await getDetail()).risks.some(row=>row.content==='暂存风险A已纠正'));assert.equal(writes[12].changes.riskOps[0].op,'add');
  tab('info');assert.equal($('#edit-name').value,'');input('#edit-name',prefix+'名称未保存');tab('risk');
  checks.push('标题前端验证失败后暂存的另一条风险不会被原处保存夹带；暂存新增风险可纠正后按原临时ID保存一次；取消第N条任务编辑保持原编号');
  // 已知失败保留原表单；修正后只提交同一条。模拟丢响应发生在真实COMMIT之后。
  click('[data-change="add"]');input('#chg-content','');input('#chg-reason','校验失败后重试');submit('#change-edit');await wait(()=>writes.length===14&&idle()&&$('#change-error')?.textContent,'需求失败原处反馈');assert($('#chg-content'));assert.equal((await getDetail()).changes.length,2);
  input('#chg-content','纠正后可以保存');submit('#change-edit');await saved(15,'原处失败后修正重试');assert.equal((await getDetail()).changes.length,3);
  click('[data-risk="add"]');input('#risk-content','丢响应仅保存一次');dropAck=true;submit('#risk-edit');await wait(()=>writes.length===16&&inFlight===0&&$('#confirm')&&!$('#confirm').disabled,'未知结果保留查询入口');const before=(await getDetail()).project.version;click('#confirm');await saved(16,'原结果查询恢复');assert.equal((await getDetail()).project.version,before);
  checks.push('实际校验失败无写入且原处可纠正；COMMIT后丢响应可以确认原操作，不重复创建/增加项目版本');
  // 其他人已经更新时，旧内容不能覆盖。
  click('[data-risk="correct"][data-risk-id="'+(await getDetail()).risks[0].id+'"]');input('#risk-content','冲突时保留');const version=(await getDetail()).project.version;
  await api('/api/projects/'+id,'PATCH',{scope:'basic',expectedVersion:version,idempotencyKey:randomUUID(),changes:{summary:'其他窗口已修改'}});submit('#risk-edit');await wait(()=>writes.length===17&&idle()&&$('#reload')&&!$('#reload').hidden,'冲突反馈');
  assert.equal((await getDetail()).project.summary,'其他窗口已修改');assert(!(await getDetail()).risks.some(row=>row.content==='冲突时保留'));click('#drafts');assert($('#draft-summary').textContent.includes('冲突时保留'));
  checks.push('真实版本冲突拒绝风险旧版本写入；个人草稿可核对保留文字，不放宽权限或并发保护');
  await mkdir('test-results',{recursive:true});await writeFile('test-results/detail-actions.json',JSON.stringify({status:'passed',database,requests,checks,productBrowserTested:false},null,2));console.log(JSON.stringify({status:'passed',checks:checks.length,requests,evidence:'test-results/detail-actions.json'}));
}finally{
  if(dom){for(let i=0;i<100&&inFlight;i++)await new Promise(resolve=>setTimeout(resolve,20));await new Promise(resolve=>setTimeout(resolve,50));dom.window.close();}if(app)await app.close();
  if(user)for(const table of ['project_drafts','user_preferences'])await c.query(`DELETE FROM ${table} WHERE user_id=?`,[user]);
  if(id){for(const table of ['audit_log','project_tasks','project_checks','schedule_changes','project_changes','project_risks','project_nodes','project_stages','project_people','project_chips','project_tags','project_responsibilities','project_membership_requests','project_name_aliases'])await c.query(`DELETE FROM ${table} WHERE project_id=?`,[id]);await c.query('DELETE FROM projects WHERE id=?',[id]);}
  if(user){for(const table of ['command_receipts','audit_log'])await c.query(`DELETE FROM ${table} WHERE actor_id=?`,[user]);await c.query('DELETE FROM sessions WHERE user_id=?',[user]);await c.query('DELETE FROM users WHERE id=?',[user]);}await c.end();
}
