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
let app,origin,dom,user,otherUser,id,otherId,actor,failRead=false,dropPatchAck=false,requests=0,inFlight=0;
async function request(path,options={},cookies=jar){
  requests++;const url=origin+path,headers=new Headers(options.headers);headers.set('Origin','http://localhost');headers.set('Cookie',cookies.getCookieStringSync(url));
  let signal=options.signal;if(signal&&!(signal instanceof AbortSignal)){const bridge=new AbortController();if(signal.aborted)bridge.abort();else signal.addEventListener('abort',()=>bridge.abort(),{once:true});signal=bridge.signal;}
  const response=await fetch(url,{...options,headers,...signal?{signal}:{}});for(const cookie of response.headers.getSetCookie())cookies.setCookieSync(cookie,url);return response;
}
async function api(path,method='GET',body,expected=200,{cookies=jar,account=actor}={}){
  const csrf=cookies.getCookiesSync(origin).find(row=>row.key==='geekdash_dev_csrf')?.value;
  const response=await request(path,{method,headers:{'Content-Type':'application/json','X-GeekDash-Request':'1',...csrf?{'X-GeekDash-CSRF':csrf}:{},...account?{'X-GeekDash-Account':account}:{}},...body?{body:JSON.stringify(body)}:{}},cookies);
  const data=await response.json();assert.equal(response.status,expected,path+': '+JSON.stringify(data));return data;
}
async function login(loginName){jar.removeAllCookiesSync();actor=undefined;await api('/api/auth/login','POST',{loginName,password});actor=(await api('/api/auth/me')).account.id;}
async function wait(predicate,message){const end=Date.now()+10000;while(Date.now()<end){if(errors.length)throw errors[0];if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error(message+'：'+(dom?.window.document.querySelector('#message')?.textContent??''));}
async function facts(projectId=id){const {connection}=await connectDatabase('test_app');try{return {project:(await connection.query('SELECT summary,CAST(version AS CHAR) version FROM projects WHERE id=?',[projectId]))[0][0],tasks:(await connection.query('SELECT task_key id,content text,completed_at_text completedAt,deleted_at_text deletedAt FROM project_tasks WHERE project_id=? ORDER BY sort_order',[projectId]))[0]};}finally{await connection.end();}}
try{
  const hash=await hashPassword(password),insert='INSERT INTO users(login_name,password_hash,display_name,must_change_password,is_admin,is_project_manager,created_at,updated_at) VALUES(?,?,?,0,?,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))';
  user=String((await c.execute(insert,[prefix,hash,prefix,1]))[0].insertId);otherUser=String((await c.execute(insert,[prefix+'_peer',hash,prefix+'_peer',0]))[0].insertId);
  app=await createApp(await openRuntimeDatabase('test_app'),{origin:'http://localhost',secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
  await login(prefix+'_peer');otherId=(await api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:'其他负责人 '+prefix}})).result.projectId;
  // 让同一搜索范围既有 0% 又有 100% 的合成项目，驾驶舱读取真实分布。
  const [stageSeed]=await c.execute("UPDATE project_stages SET state='completed' WHERE project_id=?",[otherId]);assert.equal(stageSeed.affectedRows,7);
  const foreignTask=randomUUID();await api('/api/projects/'+otherId,'PATCH',{scope:'status',expectedVersion:'1',idempotencyKey:randomUUID(),changes:{taskOps:[{op:'add',id:foreignTask,text:'仅供管理员查看'}]}});
  const peer={cookies:CookieJar.deserializeSync(jar.serializeSync()),account:otherUser};await login(prefix);
  id=(await api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix,summary:'原项目状态'}})).result.projectId;
  const taskId=randomUUID();await api('/api/projects/'+id,'PATCH',{scope:'status',expectedVersion:'1',idempotencyKey:randomUUID(),changes:{taskOps:[{op:'add',id:taskId,text:'既有任务'}]}});
  const virtualConsole=new VirtualConsole();virtualConsole.on('jsdomError',error=>errors.push(error));
  dom=new JSDOM(await readFile('src/web/index.html','utf8'),{url:origin+'/?view=all&search='+prefix,cookieJar:jar,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole});
  const w=dom.window,stageSource=(await readFile('geekdashdesktop/projects-data.js','utf8')).match(/const STAGES = (\[[\s\S]*?\n  \]);/);
  Object.assign(w,{structuredClone,TextEncoder,TextDecoder,AbortSignal:{timeout:ms=>AbortSignal.timeout(ms),any:signals=>signals[0]},__GEEKDASH_STAGES__:vm.runInNewContext(stageSource[1])});
  w.BroadcastChannel=class{postMessage(){}};w.ResizeObserver=class{observe(){}disconnect(){}};w.scrollTo=()=>{};w.performance.getEntriesByType=()=>[];w.CSS={escape:value=>value};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;this.returnValue='';};w.HTMLDialogElement.prototype.close=function(value=''){this.returnValue=value;this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.document.addEventListener('submit',event=>{if(event.target.getAttribute('method')==='dialog'){event.preventDefault();event.target.closest('dialog').close(event.submitter.value);}});
  w.fetch=async(path,options={})=>{
    inFlight++;try{
    if(failRead&&path==='/api/projects/'+id&&!options.method){failRead=false;throw Error('模拟保存后读取失败');}
    if(options.method==='PATCH')writes.push(JSON.parse(options.body));
    let response;try{response=await request(path,options);}catch(error){if(!options.signal?.aborted)errors.push(error);throw error;}if(dropPatchAck&&options.method==='PATCH'&&response.ok){dropPatchAck=false;await response.arrayBuffer();throw Error('模拟任务已提交后响应中断');}if(options.method==='PATCH'&&!response.ok)console.log('PATCH_RESULT',await response.clone().text());if(path==='/api/personal/drafts/save'&&response.ok)draftWrites.push(JSON.parse(options.body));return response;
    }finally{inFlight--;}
  };
  const context=dom.getInternalVMContext(),modules=new Map();
  function load(path){if(path.endsWith('.css'))return {};path=resolve(path.endsWith('.ts')?path:path+'.ts');if(modules.has(path))return modules.get(path).exports;const module={exports:{}};modules.set(path,module);const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;vm.runInContext('(function(require,exports,module){'+code+'\n})',context,{filename:path})(name=>load(resolve(dirname(path),name)),module.exports,module);return module.exports;}
  load('src/web/board.ts');
  const $=selector=>w.document.querySelector(selector),input=(selector,value)=>{const el=$(selector);assert(el,selector);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));},click=selector=>{const el=$(selector);assert(el,selector);assert(!el.disabled,selector);el.click();};
  const summary='[data-project-summary="'+id+'"]',card='[data-project-id="'+id+'"]',save=card+' [data-status-action="save"]';
  const settled=count=>writes.length===count&&inFlight===0&&$('#card-grid').getAttribute('aria-busy')!=='true';
  await wait(()=>$('#result-count').textContent.includes('截至'),'看板就绪');
  const show=content=>click('[data-card-content="'+content+'"]');
  assert.equal($(card+' .board-state-note strong').textContent,'状态');assert(!$('.board-card-heading .card-desc'));assert($('[data-card-content="tasks"]'));
  assert.equal($(card+' .board-project-state').textContent,'原项目状态');assert(!$(card+' [data-task-action="complete"]'));
  const bulk=card+' [data-task-bulk]';
  show('tasks');assert.match($(card+' .board-tasks-heading').textContent,/待完成任务.*1/);assert(!$(card+' .board-project-state'));assert($(card+' [data-task-action="complete"]'));assert($(card+' [data-task-action="edit"]'));assert($(card+' [data-task-action="delete"]'));
  assert($(card+' .task-list').compareDocumentPosition($(bulk)) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert($(bulk).compareDocumentPosition($(save)) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  assert($(save).disabled);assert.equal($(save).textContent,'保存任务');assert(!$(card+' [data-status-action="edit"]'));
  show('status');assert.equal(writes.length,0);
  click(card+' [data-status-action="edit"]');const noChange=(await facts()).project.version;click(save);
  await wait(()=>!$(summary),'无修改退出编辑');assert.equal(writes.length,0);assert.equal((await facts()).project.version,noChange);
  click(card+' [data-status-action="edit"]');input(summary,'保留的未保存状态');
  await wait(()=>draftWrites.some(row=>row.formKind==='project'&&row.payload.values.summary==='保留的未保存状态'),'状态文字草稿同步');
  show('tasks');assert(!$(summary));assert.equal(writes.length,0);
  click(card+' [data-task-row="'+taskId+'"] [data-task-action="complete"]');
  await wait(()=>settled(1)&&$(save)?.disabled&&$(bulk)?.value===''&&(w.document.querySelectorAll(card+' [data-task-row]').length===0),'单任务保存完成');
  assert.equal(writes[0].scope,'status');assert.deepEqual(writes[0].changes,{taskOps:[{op:'complete',id:taskId}]});assert(!writes[0].draft);
  let row=await facts();assert.equal(row.project.summary,'原项目状态');assert(row.tasks[0].completedAt);show('status');assert.equal($(summary).value,'保留的未保存状态');assert(!$(card+' [data-task-bulk]'));
  await wait(async()=>{const drafts=await api('/api/personal/drafts?projectId='+id);return drafts.items.some(d=>d.formKind==='project'&&d.baseVersion===row.project.version&&d.state==='active'&&d.payload.values.summary==='保留的未保存状态');},'单任务保存后未保存状态草稿继续存在');
  click(save);await wait(()=>settled(2)&&!$(summary),'状态区保存完成');assert.equal(writes[1].scope,'project');assert.deepEqual(writes[1].changes,{summary:'保留的未保存状态'});assert.equal((await facts()).project.summary,'保留的未保存状态');
  assert.equal((await api('/api/projects/'+id)).project.summary,'保留的未保存状态');
  const cardStateTime=async()=>(await api('/api/projects?view=all&perspective=responsible&search='+prefix)).items.find(p=>p.id===id).summaryUpdatedAt;
  const stateSaved=await cardStateTime();assert(Number.isFinite(Date.parse(stateSaved)));assert.equal($(card+' .board-state-foot time').dateTime,stateSaved);
  checks.push('项目状态与任务清单分别展示，切换不提交；任务按钮常驻；真实单任务完成只提交taskOps，未保存summary与云稿保留，切回后保存仅提交summary');
  click(card+' [data-status-action="edit"]');input(summary,'第二份未保存状态');show('tasks');input(card+' [data-task-bulk]','1、新增并直接完成');
  click(card+' [data-task-action="complete"]');await wait(()=>settled(3)&&$(save)?.disabled&&$(bulk)?.value==='','新增任务直接完成');
  assert.equal(writes[2].scope,'status');assert.deepEqual(writes[2].changes.taskOps.map(op=>op.op),['add','complete']);assert(!('summary' in writes[2].changes));
  row=await facts();assert.equal(row.project.summary,'保留的未保存状态');assert(row.tasks.some(task=>task.text==='新增并直接完成'&&task.completedAt));show('status');assert.equal($(summary).value,'第二份未保存状态');show('tasks');
  input(card+' [data-task-bulk]','1、新增后直接编辑');click(card+' [data-task-action="edit"]');input(card+' [data-task-text]','新增任务修改后');
  [...w.document.querySelectorAll(card+' .task-actions button')].find(button=>button.textContent==='保存').click();
  await wait(()=>settled(4)&&$(save)?.disabled&&$(bulk)?.value.includes('新增任务修改后'),'新增任务逐条编辑保存');assert.equal(writes[3].scope,'status');assert(!('summary' in writes[3].changes));assert.equal((await facts()).project.summary,'保留的未保存状态');assert((await facts()).tasks.some(task=>task.text==='新增任务修改后'&&!task.completedAt));assert.equal(await cardStateTime(),stateSaved);
  checks.push('新任务尚未整体保存时可以直接完成或编辑保存，只保存这条任务，另有summary输入保留');
  const taskInput='1、新增任务修改后\n2、任务区另行保存';input(card+' [data-task-bulk]',taskInput);show('status');assert.equal($(summary).value,'第二份未保存状态');assert.equal(writes.length,4);click(save);
  await wait(()=>settled(5)&&$(save)&&!$(save).disabled,'状态区保存不夹带任务');assert.deepEqual(writes[4].changes,{summary:'第二份未保存状态'});row=await facts();assert.equal(row.project.summary,'第二份未保存状态');assert(!row.tasks.some(task=>task.text==='任务区另行保存'));
  show('tasks');assert.equal($(card+' [data-task-bulk]').value,taskInput);click(save);
  await wait(()=>settled(6)&&$(bulk)?.value===taskInput&&$(save)?.disabled,'任务区保存不夹带状态');assert.equal(writes[5].scope,'project');assert.deepEqual(Object.keys(writes[5].changes),['taskOps']);row=await facts();assert.equal(row.project.summary,'第二份未保存状态');assert(row.tasks.some(task=>task.text==='任务区另行保存'));
  const fresh=(await api('/api/projects/'+id)).project;assert.equal(fresh.summary,row.project.summary);assert(fresh.tasks.some(task=>task.text==='任务区另行保存'));
  checks.push('两区都有输入时，项目状态保存只写summary并保留隐藏的任务大框；任务清单保存只写taskOps，SQL和新GET一致');
  show('status');click(card+' [data-status-action="edit"]');input(summary,'取消任务也应保留的状态');show('tasks');input(card+' [data-task-bulk]',taskInput+'\n3、取消这条');click(card+' [data-status-action="cancel"]');
  await wait(()=>$(bulk)?.value===taskInput&&$(save)?.disabled,'取消当前任务输入');show('status');assert.equal($(card+' .board-project-state').textContent,'取消任务也应保留的状态');click(card+' [data-status-action="edit"]');show('tasks');assert(!$(bulk).value.includes('取消这条'));assert.equal(writes.length,6);show('status');click(card+' [data-status-action="cancel"]');await wait(()=>!$(summary),'取消剩余状态输入');
  checks.push('取消只撤销当前区输入，隐藏的另一类内容保留，切换及取消均不写正式项目');
  const overview='#latest-status [data-summary-project="'+id+'"]',openTasks=(await facts()).tasks.filter(task=>!task.completedAt&&!task.deletedAt);assert.equal(openTasks.length,2);
  const [toComplete,toDelete]=openTasks.map(task=>task.id),overviewRow=key=>overview+' [data-task-row="'+key+'"]';
  assert(!$('#latest-status').closest('details').open,'任务汇总默认折叠');$('#latest-status').closest('details').open=true;
  await wait(()=>$(overviewRow(toComplete)),'身份范围汇总包含本人待办');assert(!$('#latest-status [data-summary-project="'+otherId+'"]'));
  click(card+' [data-status-action="edit"]');input(summary,'汇总操作不得覆盖此状态');const summaryBase=(await facts()).project.summary;
  click(overviewRow(toComplete)+' [data-task-action="edit"]');input(overviewRow(toComplete)+' [data-task-text]','汇总内改过的任务');
  const editButton=[...w.document.querySelectorAll(overviewRow(toComplete)+' button')].find(button=>button.textContent==='保存');assert(editButton);dropPatchAck=true;editButton.click();editButton.click();
  const recover=overview+' [data-summary-result="query"]';await wait(()=>$(recover)&&!$(recover).closest('[hidden]')&&!$(recover).disabled,'汇总可直接核对刚才提交的任务');const committedVersion=(await facts()).project.version;click(recover);
  await wait(()=>settled(7)&&$(overviewRow(toComplete)+' .task-text')?.textContent==='汇总内改过的任务','汇总编辑后重新读回当前行');assert.deepEqual(writes[6].changes,{taskOps:[{op:'edit',id:toComplete,text:'汇总内改过的任务'}]});assert.equal(writes[6].scope,'status');
  assert.equal((await facts()).project.version,committedVersion,'核对回执不重复修改');
  assert.equal($(summary).value,'汇总操作不得覆盖此状态');assert.equal((await facts()).project.summary,summaryBase);
  show('tasks');assert.equal($(card+' [data-task-row="'+toComplete+'"] .task-text').textContent,'汇总内改过的任务');
  const cardDate=$(card+' [data-task-row="'+toComplete+'"] .task-text + .task-date').textContent;
  assert.match(cardDate,/创建 .*\d\d:\d\d:\d\d · 正文更新 .*\d\d:\d\d:\d\d/);
  assert.equal($(overviewRow(toComplete)+' .task-text + .task-date').textContent,cardDate);
  show('status');
  checks.push('汇总编辑只发送当前任务，双击及COMMIT丢响应后在汇总核对，共一次PATCH；汇总和卡片同步显示新内容，另有卡片状态文字仍未落库');
  input('#search',prefix+'_absent');await wait(()=>!$(card)&&$('#result-count').textContent.includes('共 0 个项目')&&$(overviewRow(toComplete))&&inFlight===0,'列表筛选排除本项目，任务汇总仍在');
  const editingRow=overviewRow(toDelete)+' [data-task-text]';click(overviewRow(toDelete)+' [data-task-action="edit"]');input(editingRow,'在另一行完成前已输入');const originalInput=$(editingRow);originalInput.setSelectionRange(1,3);
  click(overviewRow(toComplete)+' [data-task-action="complete"]');await wait(()=>settled(8)&&!$(overviewRow(toComplete))&&$(overviewRow(toDelete)),'筛选页外项目的任务完成');assert.deepEqual(writes[7].changes,{taskOps:[{op:'complete',id:toComplete}]});
  let detail=(await api('/api/projects/'+id)).project;assert(detail.tasks.find(task=>task.id===toComplete)?.completedAt);assert.equal((await facts()).project.summary,summaryBase);
  assert.equal($(editingRow),originalInput);assert.deepEqual([originalInput.value,originalInput.selectionStart,originalInput.selectionEnd],['在另一行完成前已输入',1,3]);assert.notEqual(detail.tasks.find(task=>task.id===toDelete).text,originalInput.value);
  input(editingRow,'在另一行完成后继续编辑并保存');[...$(overviewRow(toDelete)).querySelectorAll('button')].find(b=>b.textContent==='保存').click();
  await wait(()=>settled(9)&&$(overviewRow(toDelete)+' .task-text')?.textContent==='在另一行完成后继续编辑并保存','同组第一个未保存输入在另一任务完成后可以继续保存');assert.deepEqual(writes[8].changes,{taskOps:[{op:'edit',id:toDelete,text:'在另一行完成后继续编辑并保存'}]});assert.equal((await facts()).tasks.find(task=>task.id===toDelete).text,'在另一行完成后继续编辑并保存');
  checks.push('同项目编辑一条任务时完成另一条，原输入与光标均保留，继续输入并保存只更新当前记录');
  const removeButton=overviewRow(toDelete)+' [data-task-action="delete"]';click(removeButton);await wait(()=>$('dialog.task-delete-dialog')?.open,'删除需确认');
  click('dialog.task-delete-dialog button[value="cancel"]');await wait(()=>!$('dialog.task-delete-dialog')&&$(removeButton)&&!$(removeButton).disabled,'取消仍可处理原任务');assert.equal(writes.length,9);assert(!(await facts()).tasks.find(task=>task.id===toDelete).deletedAt);
  click(removeButton);await wait(()=>$('dialog.task-delete-dialog')?.open,'再次删除');click('dialog.task-delete-dialog button[value="delete"]');
  await wait(()=>settled(10)&&!$(overview),'最后待办删除后隐去项目');assert.deepEqual(writes[9].changes,{taskOps:[{op:'delete',id:toDelete}]});
  assert((await facts()).tasks.find(task=>task.id===toDelete).deletedAt);detail=(await api('/api/projects/'+id)).project;assert(!detail.tasks.some(task=>task.id===toDelete&&!task.deletedAt));
  assert(!(await api('/api/projects/tasks-summary?perspective=responsible')).items.some(project=>project.id===id));
  input('#search',prefix);await wait(()=>$(summary)?.value==='汇总操作不得覆盖此状态'&&inFlight===0,'恢复筛选后仍有原未保存输入');show('tasks');assert(!$(card+' [data-task-row]'));show('status');
  click(card+' [data-status-action="cancel"]');await wait(()=>!$(summary),'放弃原未保存状态');assert.equal((await facts()).project.summary,summaryBase);
  checks.push('当前页没有该项目时可完成或删除；删除取消不写入，确认后移除最后一条待办及空组。新详情GET/汇总GET/独立SQL一致，切回筛选卡片和未保存状态仍正确');
  click('[data-perspective="management"]');const readOnly='#latest-status [data-summary-project="'+otherId+'"]';
  await wait(()=>$(readOnly+' [data-task-row="'+foreignTask+'"]'),'管理视角内的非本人项目');assert(!$(readOnly+' [data-task-action]'));
  const latest=(await api('/api/projects/tasks-summary?perspective=management')).items.find(project=>project.id===otherId);assert.equal(latest.canEdit,false);
  const refused=await api('/api/projects/'+otherId,'PATCH',{scope:'status',expectedVersion:latest.version,idempotencyKey:randomUUID(),changes:{taskOps:[{op:'complete',id:foreignTask}]}},403);assert.equal(refused.code,'PROJECT_READ_ONLY');assert(!(await facts(otherId)).tasks[0].completedAt);
  click('[data-perspective="responsible"]');await wait(()=>!$(readOnly)&&$(card)&&inFlight===0,'返回负责人范围');checks.push('管理视角可见他人待办但没有操作按钮；直接写入被真实API拒绝，无SQL修改；负责人视角排除不属于自己的项目');
  await api('/api/projects/'+otherId+'/membership','POST',{action:'join',idempotencyKey:randomUUID()});input('#search',prefix+'_other');
  const foreignRow=readOnly+' [data-task-row="'+foreignTask+'"]',foreignText=foreignRow+' [data-task-text]';await wait(()=>$(foreignRow+' [data-task-action="edit"]')&&inFlight===0,'加入后可原处编辑');click(foreignRow+' [data-task-action="edit"]');input(foreignText,'同事完成前我尚未保存的文字');
  await api('/api/projects/'+otherId,'PATCH',{scope:'status',expectedVersion:(await facts(otherId)).project.version,idempotencyKey:randomUUID(),changes:{taskOps:[{op:'complete',id:foreignTask}]}},200,peer);
  input('#search',prefix);await wait(()=>$(foreignText)?.readOnly&&$(card)&&inFlight===0,'同事完成最后一条待办，原本的输入转为仅供核对');assert.equal($(foreignText).value,'同事完成前我尚未保存的文字');assert($(readOnly+' [data-summary-notice]').textContent.includes('未保存'));assert([...$(foreignRow).querySelectorAll('button')].every(b=>b.disabled));
  assert(!(await api('/api/projects/tasks-summary?perspective=responsible')).items.some(p=>p.id===otherId));const peerTask=(await facts(otherId)).tasks[0];assert(peerTask.completedAt);assert.equal(peerTask.text,'仅供管理员查看');assert.equal(writes.length,10);
  checks.push('不同登录会话的协作者完成项目最后一条待办，正式汇总已移除该项目；当前页保留本人未存文字供核对，不能覆盖完成事实');
  show('tasks');assert.equal($(bulk).value,'');assert($(save).disabled);
  input(bulk,'直接录入任务');click(save);await wait(()=>settled(11)&&$(save)?.disabled&&$(bulk)?.value.includes('直接录入任务'),'默认输入大框直接保存并保留回读');
  assert((await api('/api/projects/'+id)).project.tasks.some(t=>t.text==='直接录入任务'));assert((await facts()).tasks.some(t=>t.text==='直接录入任务'));show('status');
  checks.push('卡片默认按任务列表、整栏输入、保存任务展示，新增可直接保存并读回；卡片与汇总行显示相同时间，状态保存时间不随任务动作改变');
  click('#layout-toggle');click('#distribution-options [value="progress"]');
  const progressButton=value=>'#distribution-charts button[data-filter="progress"][data-value="'+value+'"]';
  const visibleIds=()=>Array.from(w.document.querySelectorAll('#card-grid .card[data-project-id]'),el=>el.dataset.projectId).sort().join(',');
  async function checkProgress(value,ids){
    await wait(()=>inFlight===0&&$('#card-grid').getAttribute('aria-busy')!=='true'&&visibleIds()===ids.sort().join(',')&&new URL(w.location.href).searchParams.get('progress')===value,'驾驶舱选中进度 '+(value??'全部'));
    const query=new URL(w.location.href).searchParams;assert.equal(query.get('search'),prefix);assert.equal($('#search').value,prefix);assert.equal(query.get('perspective'),'responsible');assert.equal(query.get('view'),'all');assert(!$('#dashboard-view').hidden);
    if(value)assert.equal($(progressButton(value)).getAttribute('aria-pressed'),'true');
    else for(const percentage of ['0','100'])assert.equal($(progressButton(percentage)).getAttribute('aria-pressed'),'false');
  }
  await checkProgress(null,[id,otherId]);
  click(progressButton('100'));await checkProgress('100',[otherId]);
  click(progressButton('100'));await checkProgress(null,[id,otherId]);
  click(progressButton('0'));await checkProgress('0',[id]);
  click('[data-clear-distribution="progress"]');await checkProgress(null,[id,otherId]);
  const focusRow=projectId=>$('#focus-projects a[data-project-id="'+projectId+'"]');
  const milestone=projectId=>focusRow(projectId)?.querySelector('.pp-milestone')?.textContent;
  assert.equal(milestone(id),'里程碑：'+w.__GEEKDASH_STAGES__[0].milestone);
  assert.equal(milestone(otherId),'七阶段里程碑已全部完成。');
  // 只改变本次合成项目的阶段投影，重读同一列表，按每条实际 ID 校验。
  await c.execute("UPDATE project_stages SET state=CASE WHEN stage_code<'S4' THEN 'completed' WHEN stage_code='S4' THEN 'active' ELSE 'locked' END WHERE project_id=?",[id]);
  await c.execute('DELETE FROM project_stages WHERE project_id=?',[otherId]);
  w.dispatchEvent(new w.Event('focus'));
  await wait(()=>milestone(id)==='里程碑：'+w.__GEEKDASH_STAGES__[3].milestone && milestone(otherId)==='阶段待确认','阶段变更后读回本条里程碑');
  for(const projectId of [id,otherId])assert.equal(new URL(focusRow(projectId).href).searchParams.get('id'),projectId);
  checks.push('重点进度逐项目读取 S1、S4、全部完成及未配置阶段，各自链接对应详情');
  click('#layout-cards');assert.equal(writes.length,11,'筛选不应修改项目');
  checks.push('驾驶舱同图点击100%筛出完成项目，重复点击恢复两个进度；选择0%后用图内全部进度恢复。每次均保留原搜索、负责人视角及项目范围');
  const beforeRecovery=writes.length;
  click(card+' [data-status-action="edit"]');input(summary,'读取失败后仍可确认');failRead=true;click(save);
  await wait(()=>writes.length===beforeRecovery+1&&$(card+' [data-status-action="query"]')&&!$(card+' [data-status-action="query"]').disabled,'保存成功但读回失败保留确认入口');
  const savedVersion=(await facts()).project.version;click(card+' [data-status-action="query"]');await wait(()=>!$(summary),'读取原结果成功');assert.equal(writes.length,beforeRecovery+1);assert.equal((await facts()).project.version,savedVersion);
  click(card+' [data-status-action="edit"]');input(summary,'冲突时保留此输入');const before=await facts();await api('/api/projects/'+id,'PATCH',{scope:'basic',expectedVersion:before.project.version,idempotencyKey:randomUUID(),changes:{summary:'另一窗口已保存'}});click(save);
  await wait(()=>$(save)?.disabled&&$(card+' .board-status-feedback').textContent.includes('他人更新'),'旧版本被拒绝');assert.equal($(summary).value,'冲突时保留此输入');assert.equal((await facts()).project.summary,'另一窗口已保存');
  checks.push('已提交但新读失败可核对原结果，无重复PATCH/版本；其他窗口更新产生真实冲突并保留未保存文字，不能覆盖');
  await mkdir('test-results',{recursive:true});await writeFile('test-results/board-state.json',JSON.stringify({status:'passed',database,requests,checks,productBrowserTested:false},null,2));console.log(JSON.stringify({status:'passed',checks:checks.length,requests,evidence:'test-results/board-state.json'}));
}finally{
  if(dom){for(let i=0;i<100&&inFlight;i++)await new Promise(resolve=>setTimeout(resolve,20));await new Promise(resolve=>setTimeout(resolve,50));dom.window.close();}if(app)await app.close();
  for(const account of [user,otherUser].filter(Boolean))for(const table of ['project_drafts','user_preferences'])await c.query(`DELETE FROM ${table} WHERE user_id=?`,[account]);
  for(const project of [id,otherId].filter(Boolean)){for(const table of ['audit_log','project_tasks','project_checks','schedule_changes','project_changes','project_risks','project_nodes','project_stages','project_people','project_chips','project_tags','project_responsibilities','project_membership_requests','project_name_aliases'])await c.query(`DELETE FROM ${table} WHERE project_id=?`,[project]);await c.query('DELETE FROM projects WHERE id=?',[project]);}
  for(const account of [user,otherUser].filter(Boolean)){for(const table of ['command_receipts','audit_log'])await c.query(`DELETE FROM ${table} WHERE actor_id=?`,[account]);await c.query('DELETE FROM sessions WHERE user_id=?',[account]);await c.query('DELETE FROM users WHERE id=?',[account]);}await c.end();
}
