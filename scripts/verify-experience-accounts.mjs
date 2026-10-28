import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { normalizeImportProject } from '../dist/server/modules/project-import.js';
import { hashPassword } from '../dist/server/modules/identity.js';
import {bulkTaskOperations} from '../src/web/shared/task-text.ts';

// 必须在本轮独立数据库运行，禁止指向用户正在使用的本地库。
assert.equal(process.env.GEEKDASH_EXPERIENCE_TEST, '1');
const { connection: c } = await connectDatabase('test_migrator');
const uuid = (await c.query('SELECT @@server_uuid id'))[0][0].id;
assert.equal(uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
assert.notEqual(uuid, '3b7588d1-d1c1-11f1-9430-de9c3ef7caac');
const prefix = 'experience_' + randomUUID().slice(0, 8), password = 'Test123!abc';
let app, origin, httpRequests=0;
const checks = [];
const mixed=normalizeImportProject({id:1,statusDesc:'1、同文\n2、同文',tasks:[{id:'old',text:'原任务'}]});assert.equal(mixed.input.tasks.length,3);assert.equal(new Set(mixed.input.tasks.map(t=>t.id)).size,3);assert.equal(mixed.input.fields.statusDesc,undefined);
function client() {
  let cookie = '', csrf = '', account;
  return {
    async request(path, method = 'GET', body, expected = 200, binary = false) {
      httpRequests++;
      const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': binary ? 'application/octet-stream' : 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...account ? { 'X-GeekDash-Account': account.id } : {} }, ...body ? { body: JSON.stringify(body) } : {} });
      for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
      const result = await response.json();
      assert.equal(response.status, expected, path + ': ' + JSON.stringify(result));
      if (path === '/api/auth/me') account = result.account;
      return result;
    },
    async upload(data) { return (await this.request('/api/imports/upload?' + new URLSearchParams({ name: '合成备份.json', operation: randomUUID(), new: '1' }), 'POST', data, 200, true)).result.batchId; },
  };
}
try {
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,is_admin,is_project_manager,must_change_password,created_at,updated_at) VALUES (?,?,?,1,1,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix, await hashPassword(password), '合成管理员']);
  // 与初始化测试账号命令相同的空企业配置；本脚本仅在隔离实例执行。
  await c.execute("INSERT IGNORE INTO system_configuration(id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) SELECT 1,id,'','','','',id,UTC_TIMESTAMP(3) FROM users WHERE login_name=?",[prefix]);
  const runtime = await openRuntimeDatabase('test_app'); app = await createApp(runtime, { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const admin = client(), member = client(), second = client();
  await admin.request('/api/auth/login', 'POST', { loginName: prefix, password }); await admin.request('/api/auth/me');
  const inviteBody = { role: 'business', idempotencyKey: randomUUID() };
  const invite = await admin.request('/api/accounts/invites', 'POST', inviteBody);
  assert.match(invite.code, /^[A-Za-z0-9]{10}$/); for (const pattern of [/[A-Z]/, /[a-z]/, /[0-9]/]) assert.match(invite.code, pattern);
  const replay = await admin.request('/api/accounts/invites', 'POST', inviteBody); assert.equal(replay.id, invite.id);
  const registered = await member.request('/api/auth/register', 'POST', { loginName: prefix + 'm', name: prefix+'首次登记姓名', password, inviteCode: invite.code });
  assert.equal((await member.request('/api/auth/me')).account.id, registered.accountId);
  const adminInvite = await admin.request('/api/accounts/invites', 'POST', { role: 'admin', idempotencyKey: randomUUID() });
  const created = await second.request('/api/auth/register', 'POST', { loginName: prefix + 'a', name: '第二管理员', password, inviteCode: adminInvite.code });
  assert.equal((await second.request('/api/auth/me')).account.isProjectManager, false);
  await second.request('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '无资格项目' } }, 403);
  checks.push('10位随机邀请码三类字符；注册账号与会话同事务，随后新请求已登录；管理员默认无项目经理资格');
  let users = (await admin.request('/api/accounts')).items;
  let user = users.find(u => u.id === created.accountId);
  const edit = { loginName: user.loginName, name: user.name, isProjectManager: true, expectedVersion: user.version, idempotencyKey: randomUUID() };
  await admin.request(`/api/accounts/${user.id}/edit`, 'POST', edit);
  await admin.request(`/api/accounts/${user.id}/edit`, 'POST', edit);
  assert.equal((await second.request('/api/auth/me')).account.isProjectManager, true);
  const project = (await second.request('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '兼任项目' } })).result;
  user = (await admin.request('/api/accounts')).items.find(u => u.id === user.id);
  const blocked = await admin.request(`/api/accounts/${user.id}/edit`, 'POST', { ...edit, isProjectManager: false, expectedVersion: user.version, idempotencyKey: randomUUID() }, 422);
  assert.equal(blocked.code, 'PROJECT_MEMBERSHIP_REMAINS');
  await member.request(`/api/projects/${project.projectId}/membership`, 'POST', { action: 'join', idempotencyKey: randomUUID() });
  const sharedCounts=await member.request('/api/projects?view=all&dashboard=1&search='+encodeURIComponent(prefix));
  assert.equal(sharedCounts.stats.total,1);
  assert.deepEqual(sharedCounts.dashboard.managers.map(row=>[row.id,row.count]).sort(),[[registered.accountId,1],[created.accountId,1]].sort());
  const emptyCounts=await member.request('/api/projects?view=all&dashboard=1&search='+encodeURIComponent(prefix+'-none'));
  assert.equal(emptyCounts.stats.total,0);assert.deepEqual(emptyCounts.dashboard.managers,[]);
  const current = await second.request('/api/projects/' + project.projectId);
  await second.request(`/api/projects/${project.projectId}/membership`, 'POST', { action: 'leave', expectedVersion: current.project.version, idempotencyKey: randomUUID() });
  await admin.request(`/api/accounts/${user.id}/edit`, 'POST', { ...edit, isProjectManager: false, expectedVersion: user.version, idempotencyKey: randomUUID() });
  await second.request('/api/auth/me');
  assert.equal((await second.request(`/api/projects/${project.projectId}/membership`, 'POST', { action: 'join', idempotencyKey: randomUUID() }, 403)).code, 'PROJECT_MANAGER_REQUIRED');
  checks.push('勾选兼任可创建和负责项目；已负责项目阻止取消；退出后可取消；直接调用加入接口仍拒绝');
  user = (await admin.request('/api/accounts')).items.find(u => u.id === registered.accountId);
  await member.request('/api/profile', 'POST', { name: '自行改名', expectedVersion: user.version, idempotencyKey: randomUUID() }, 403);
  const renamed = { loginName: prefix + 'renamed', name: '管理员更正姓名', isProjectManager: true, expectedVersion: user.version, idempotencyKey: randomUUID() };
  await admin.request(`/api/accounts/${user.id}/edit`, 'POST', renamed);
  const profile = await member.request('/api/profile'); assert.equal(profile.name, renamed.name); assert.equal(profile.loginName, renamed.loginName);
  const stored = (await c.query('SELECT registration_name name FROM users WHERE id=?', [user.id]))[0][0]; assert.equal(stored.name, prefix+'首次登记姓名');
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_responsibilities WHERE project_id=? AND user_id=?', [project.projectId, user.id]))[0][0].n), 1);
  checks.push('个人改名拒绝；管理员改名新请求回读，首次匹配姓名、账号ID和项目归属保持');
  const batchId = await member.upload({ version: 2, customers: [{ id: 1, name: '-' }, { id: 2, name: prefix + '待忽略客户' }], projects: [{ id: 1, name: prefix + '空客户项目', status: '已结案', customer: '-' }, { id: 2, name: prefix + '待忽略项目', status: '已结案', customer: prefix + '待忽略客户' }] });
  let batch = await member.request('/api/imports/' + batchId);
  assert.equal(batch.items[0].issues.some(i => i.code === 'IMPORT_REFERENCE_REQUIRED'), false);
  let item = batch.catalogRows.find(i => i.payload.name === prefix + '待忽略客户');
  const ignore = { ignored: true, expectedBatchVersion: batch.batch.version, expectedReviewVersion: item.reviewVersion, idempotencyKey: randomUUID() };
  await member.request(`/api/imports/${batchId}/items/${item.id}/ignore`, 'POST', ignore);
  await member.request(`/api/imports/${batchId}/items/${item.id}/ignore`, 'POST', ignore);
  batch = await member.request('/api/imports/' + batchId);
  assert.equal(batch.catalogRows.find(i => i.id === item.id).ignored, true);
  assert.equal(batch.items[1].issues.some(i => i.code === 'IMPORT_REFERENCE_REQUIRED'), false,JSON.stringify({issues:batch.items[1].issues,references:batch.items[1].unresolvedReferences,catalogs:batch.catalogRows.map(i=>({name:i.payload.name,ignored:i.ignored,id:i.id}))}));
  assert.deepEqual(batch.items[1].payload.fields.customerIds, []);
  let ignoredRow=batch.catalogRows.find(row=>row.id===item.id);
  const restore={ignored:false,expectedBatchVersion:batch.batch.version,expectedReviewVersion:ignoredRow.reviewVersion,idempotencyKey:randomUUID()};
  assert.equal((await admin.request(`/api/imports/${batchId}/items/${item.id}/ignore`,'POST',restore,403)).code,'IMPORT_HANDLER_REQUIRED');
  assert.equal((await member.request(`/api/imports/${batchId}/items/${item.id}/ignore`,'POST',{...restore,expectedReviewVersion:ignore.expectedReviewVersion,idempotencyKey:randomUUID()},409)).code,'IMPORT_REVIEW_VERSION_CONFLICT');
  await member.request(`/api/imports/${batchId}/items/${item.id}/ignore`,'POST',restore);
  batch=await member.request('/api/imports/'+batchId);ignoredRow=batch.catalogRows.find(row=>row.id===item.id);
  assert.equal(ignoredRow.ignored,false);assert(batch.items[1].unresolvedReferences.length>0);
  const ignoreAgain={...ignore,expectedBatchVersion:batch.batch.version,expectedReviewVersion:ignoredRow.reviewVersion,idempotencyKey:randomUUID()};
  await member.request(`/api/imports/${batchId}/items/${item.id}/ignore`,'POST',ignoreAgain);
  assert.equal((await member.request(`/api/imports/${batchId}/items/${item.id}/ignore/results/query`,'POST',ignoreAgain)).outcome,'committed');
  batch=await member.request('/api/imports/'+batchId);assert.deepEqual(batch.items[1].payload.fields.customerIds,[]);
  const chosen = batch.items.map(item => ({ id: item.id, command: { expectedBatchVersion: batch.batch.version, expectedReviewVersion: item.reviewVersion, expectedVersion: item.expectedVersion, idempotencyKey: randomUUID(), basis: item.basis, selected: item.defaultSelected }, resolveReferences: true }));
  const execution = { formatVersion: 2, idempotencyKey: randomUUID(), items: chosen };
  await member.request(`/api/imports/${batchId}/executions`, 'POST', execution, 202);
  let result; for (let n = 0; n < 80; n++) { result = await member.request(`/api/imports/${batchId}/executions?operation=${execution.idempotencyKey}`); if (result.status === 'finished') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(result.status, 'finished');
  batch = await member.request('/api/imports/' + batchId); assert.equal(batch.counts.processed, 2);
  for (const item of batch.items) { const detail = await member.request('/api/projects/' + item.previousResult.projectId); assert.deepEqual(detail.project.customerIds, []); }
  const board = await member.request('/api/projects?view=all'); assert(board.items.some(p => p.name === prefix + '空客户项目'));
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM customers WHERE name=?', [prefix + '待忽略客户']))[0][0].n), 0);
  const savedProjects=await Promise.all(batch.items.map(row=>member.request('/api/projects/'+row.previousResult.projectId)));
  ignoredRow=batch.catalogRows.find(row=>row.id===item.id);
  await member.request(`/api/imports/${batchId}/items/${item.id}/ignore`,'POST',{...restore,expectedBatchVersion:batch.batch.version,expectedReviewVersion:ignoredRow.reviewVersion,idempotencyKey:randomUUID()});
  for(const prior of savedProjects){const again=await member.request('/api/projects/'+prior.project.id);assert.equal(again.project.version,prior.project.version);assert.deepEqual(again.project.customerIds,prior.project.customerIds);}
  checks.push('忽略资料可恢复、重新忽略并查回执；非处理人和旧项版本被拒绝；恢复未采用资料不反向改变已入库项目。多人项目分别计入双方、空范围无虚假人数');
  checks.push('单独横线按空值；忽略资料可重试、新请求解除待导入引用；两个项目实际入库并出现在详情和个人看板；未创建被忽略资料');

  let detail = await member.request('/api/projects/' + project.projectId);
  const save = async(changes,expected=200,version=detail.project.version)=>member.request('/api/projects/'+project.projectId,'PATCH',{scope:'project',changes,expectedVersion:version,idempotencyKey:randomUUID()},expected);
  await save({statusDesc:'1、旧进展\n2、重复进展\n3、重复进展'});
  detail=await member.request('/api/projects/'+project.projectId);assert.equal(detail.project.tasks.length,3);assert.equal(new Set(detail.project.tasks.map(t=>t.id)).size,3);
  const oldVersion=detail.project.version,first=detail.project.tasks[0].id,added=randomUUID();
  const body={scope:'project',changes:{summary:'任务共同保存',taskOps:[{op:'edit',id:first,text:'修正进展 @工程师'},{op:'complete',id:first},{op:'add',id:added,text:'下一步'}]},expectedVersion:oldVersion,idempotencyKey:randomUUID()};
  for(const scope of ['project','status']){
    const clientDraftId=randomUUID(),changes=scope==='project'?body.changes:{taskOps:body.changes.taskOps};
    const draft=await member.request('/api/personal/drafts/save','POST',{clientDraftId,projectId:project.projectId,formKind:scope,baseVersion:oldVersion,expectedDraftVersion:'0',clientSequence:'1',payload:{schemaVersion:1,instanceId:randomUUID(),values:changes,editors:{task:{text:'整栏尚有歧义的原输入\n必须原样保留'}},submission:{scope,changes}}});
    const reloaded=await member.request('/api/personal/drafts?clientDraftId='+clientDraftId);assert.deepEqual(reloaded.items[0].payload.values.taskOps,body.changes.taskOps);assert.equal(draft.draftVersion,'1');
    assert.equal(reloaded.items[0].payload.editors.task.text,'整栏尚有歧义的原输入\n必须原样保留');
  }
  assert.equal((await member.request('/api/projects/'+project.projectId)).project.version,oldVersion);
  checks.push('详情/卡片任务草稿保存与新请求回读一致，不推进正式项目版本');
  await member.request('/api/projects/'+project.projectId,'PATCH',body);await member.request('/api/projects/'+project.projectId,'PATCH',body);
  detail=await member.request('/api/projects/'+project.projectId);assert.equal(detail.project.summary,'任务共同保存');assert.equal(detail.project.tasks.length,4);assert(detail.project.tasks.find(t=>t.id===first).completedAt);assert(!detail.project.statusDesc.includes('修正进展'));assert(detail.project.statusDesc.includes('下一步'));
  assert.equal((await save({summary:'不得写入',taskOps:[{op:'edit',id:added,text:''}]},422)).code,'INVALID_PROJECT_FIELDS');
  await save({taskOps:[{op:'reopen',id:first}]},409,oldVersion);
  let fresh=await member.request('/api/projects/'+project.projectId);assert.equal(fresh.project.version,detail.project.version);assert.equal(fresh.project.summary,'任务共同保存');
  await save({taskOps:[{op:'reopen',id:first},{op:'delete',id:added}]});detail=await member.request('/api/projects/'+project.projectId);assert(detail.project.statusDesc.includes('修正进展'));assert(!detail.project.statusDesc.includes('下一步'));assert(detail.project.tasks.find(t=>t.id===added).deletedAt);
  await save({taskOps:[{op:'edit',id:first,text:'修正进展 @工程师'}]});fresh=await member.request('/api/projects/'+project.projectId);assert.equal(fresh.project.version,detail.project.version);
  const summary=await member.request('/api/project-summary');assert.equal(summary.items.find(p=>p.id===project.projectId).statusDesc,detail.project.statusDesc);
  const inspection=await member.request('/api/projects?view=all&details=checks&search='+encodeURIComponent(prefix));
  const inspected=inspection.items.find(row=>row.id===project.projectId).inspection.project;
  assert.equal(inspected.statusDesc,detail.project.statusDesc);assert.deepEqual(inspected.tasks,detail.project.tasks);
  const dashboard=await member.request('/api/projects?view=all&dashboard=1');assert(dashboard.dashboard.managers.some(manager=>manager.id===registered.accountId&&manager.count>=3));assert(dashboard.dashboard.distributions.progress.length);
  assert(dashboard.dashboard.latest.some(event=>event.projectId===project.projectId&&event.text.includes('任务')));
  assert(dashboard.dashboard.focus.every(item=>item.status!=='closed'));assert.equal(dashboard.dashboard.focus.length,dashboard.dashboard.focusTotal);
  assert(dashboard.dashboard.latest.every(event=>dashboard.items.some(item=>item.id===event.projectId)));
  const managerFiltered=await member.request('/api/projects?view=all&dashboard=1&manager='+registered.accountId);
  assert(managerFiltered.items.some(item=>item.id===project.projectId));assert(managerFiltered.options.manager.includes(registered.accountId));assert(managerFiltered.options.owner.every(value=>value.startsWith('engineer:')));
  const spaceVersion=await member.request('/api/project-space?search='+encodeURIComponent(prefix));assert(spaceVersion.items.every(item=>/^[1-9][0-9]*$/.test(item.version)));
  const boardPrefs={schemaVersion:1,filterOrder:['manager','taskOwner','customer'],hiddenFilters:['customer'],cardContent:'tasks',chartPercent:false,activityDays:7,activityCount:5};
  const prefKey=randomUUID();await member.request('/api/personal/preferences/save','POST',{deviceKey:prefKey,scope:'board',expectedVersion:'0',value:boardPrefs});assert.deepEqual((await member.request('/api/personal/preferences?'+new URLSearchParams({deviceKey:prefKey,scope:'board'}))).value,boardPrefs);
  checks.push('任务原说明逐行保留且同文不合并；整页任务与简介原子保存；重试不重复；完成/重开/删除/无变化/旧版本冲突；新请求简要与驾驶舱消费');
  const beforeBulk=structuredClone(detail.project.tasks),ops=bulkTaskOperations(beforeBulk,detail.project.statusDesc.replace('修正进展','整栏修改进展')+'\n新增整栏任务');
  await save({taskOps:ops});detail=await member.request('/api/projects/'+project.projectId);
  assert.equal(detail.project.tasks.find(t=>t.id===first).text,'整栏修改进展 @工程师');assert.equal(detail.project.tasks.find(t=>t.id===first).createdAt,beforeBulk.find(t=>t.id===first).createdAt);
  const bulkAdded=detail.project.tasks.find(t=>t.text==='新增整栏任务');assert(bulkAdded);
  await save({taskOps:bulkTaskOperations(detail.project.tasks,detail.project.statusDesc.split('\n').filter(line=>!line.includes('新增整栏任务')).join('\n'))});detail=await member.request('/api/projects/'+project.projectId);assert(detail.project.tasks.find(t=>t.id===bulkAdded.id).deletedAt);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_tasks WHERE project_id=? AND task_key=?',[project.projectId,first]))[0][0].n),1);
  checks.push('真实整栏操作生成→原保存事务→新请求及SQL读回；改文字保留身份/创建时间，删行保留历史；原始整栏草稿可恢复');
  const taskBatchId=await admin.upload({version:2,projects:[{id:123,name:prefix+'1056任务',status:'已结案',pm:prefix+'首次登记姓名',taskUnifiedVersion:1,tasksUpdatedAt:'2026-10-14T20:00:00.000Z',statusDesc:'这个旧投影不能再导入',tasks:[{id:'same',text:'待办任务',createdAt:'2026-10-10',updatedAt:'2026-10-11'},{id:'SAME',text:'已完成任务',completedAt:'2026-10-12'},{id:'gone',text:'已删除任务',deletedAt:'2026-10-13'}]}]});
  const taskBatch=await admin.request('/api/imports/'+taskBatchId),taskItem=taskBatch.items[0];
  assert.equal(taskItem.payload.fields.statusDesc,undefined);assert(taskItem.defaultSelected.includes('tasks'));
  const taskCmd={expectedBatchVersion:taskBatch.batch.version,expectedReviewVersion:taskItem.reviewVersion,expectedVersion:taskItem.expectedVersion,basis:taskItem.basis,selected:taskItem.defaultSelected,idempotencyKey:randomUUID()};
  const taskExecution={formatVersion:2,idempotencyKey:randomUUID(),items:[{id:taskItem.id,command:taskCmd,resolveReferences:true}]};
  await admin.request(`/api/imports/${taskBatchId}/executions`,'POST',taskExecution,202);
  let taskResult;for(let n=0;n<80;n++){taskResult=await admin.request(`/api/imports/${taskBatchId}/executions?operation=${taskExecution.idempotencyKey}`);if(taskResult.status==='finished')break;await new Promise(r=>setTimeout(r,100));}
  const adopted={result:(await admin.request('/api/imports/'+taskBatchId)).items[0].previousResult};assert(adopted.result,JSON.stringify(taskResult));
  const imported=await admin.request('/api/projects/'+adopted.result.projectId);assert.equal(imported.project.tasks.length,3);assert.equal(imported.project.statusDesc,'1、待办任务');assert.equal(imported.project.tasks.find(t=>t.id==='SAME').completedAt,'2026-10-12');assert.equal(imported.project.tasks.find(t=>t.id==='same').createdAt,'2026-10-10');
  await admin.request(`/api/imports/${taskBatchId}/executions`,'POST',taskExecution,202);
  assert.equal((await admin.request('/api/imports/'+taskBatchId)).items[0].previousResult.projectId,adopted.result.projectId);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM project_tasks WHERE project_id=?',[adopted.result.projectId]))[0][0].n),3);
  checks.push('1056任务实际导入保留完成/删除与历史日期；大小写ID分别存储；不重复追加statusDesc；同次重试不增任务');

  assert.equal(imported.project.contentUpdatedOn,'2026-10-15');
  const range=await admin.request('/api/projects?view=all&dashboard=1&contentFrom=2026-10-15&contentTo=2026-10-15');assert(range.items.some(p=>p.id===imported.project.id));assert.equal(range.stats.total,range.pagination.total);assert(range.dashboard.latest.every(p=>range.items.some(item=>item.id===p.projectId)));
  assert(!(await admin.request('/api/projects?view=all&contentTo=2026-10-14')).items.some(p=>p.id===imported.project.id));
  assert(!(await member.request('/api/projects?view=all&contentFrom=2026-10-15&contentTo=2026-10-15')).items.some(p=>p.id===imported.project.id));
  await admin.request('/api/projects/'+imported.project.id,'PATCH',{scope:'project',changes:{summary:'只改简介不能算说明更新'},expectedVersion:imported.project.version,idempotencyKey:randomUUID()});
  assert.equal((await admin.request('/api/projects/'+imported.project.id)).project.contentUpdatedAt,imported.project.contentUpdatedAt);
  assert.equal((await admin.request('/api/projects?contentFrom=2026-10-16&contentTo=2026-10-15','GET',undefined,400)).code,'INVALID_CONTENT_DATE_RANGE');
  assert.equal((await admin.request('/api/projects?contentFrom=2026-02-31','GET',undefined,400)).code,'INVALID_CONTENT_DATE_RANGE');
  const forExport=await admin.request('/api/project-summary');assert.equal(forExport.items.find(p=>p.id===imported.project.id).contentUpdatedOn,'2026-10-15');
  const deviceKey=randomUUID(),filters={contentFrom:'2026-10-15',contentTo:'2026-10-15',taskOwner:['工程师']};
  await member.request('/api/personal/preferences/save','POST',{deviceKey,scope:'board',expectedVersion:'0',value:{schemaVersion:1,filters,distributions:['chip','tags','odmFactory','progress']}});
  const preference=await member.request('/api/personal/preferences?'+new URLSearchParams({deviceKey,scope:'board'}));assert.deepEqual(preference.value.filters,filters);
  checks.push('说明更新时间承接已采用1056来源；上海跨日/边界日期/权限/分页与统计一致；简介修改不误计，简要及个人筛选偏好读回');
  const suggestion=await member.request('/api/auth/me');assert(suggestion.account.suggestedProjectCount>=1);
  const space=await member.request('/api/project-space');assert(space.items.some(p=>p.id===adopted.result.projectId&&p.suggested));
  await member.request('/api/projects/'+adopted.result.projectId,'GET',undefined,403);
  const ownDashboard=await member.request('/api/projects?view=all&dashboard=1');assert(!ownDashboard.items.some(p=>p.id===adopted.result.projectId));
  const filteredTasks=await member.request('/api/projects?view=all&taskOwner=工程师');assert(filteredTasks.items.some(p=>p.id===project.projectId));
  checks.push('只用首次登记姓名给出可加入项目提示；管理员改名不改匹配名；未加入仍不能读取详情或进入个人统计；任务人员筛选消费未完成任务');
  const feedback=(await member.request('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'反馈删除'}})).result.projectId;
  const perspectiveQuery='?view=all&dashboard=1&search='+encodeURIComponent(prefix+'反馈删除');
  const managed=await admin.request('/api/projects'+perspectiveQuery+'&perspective=management');assert.equal(managed.stats.total,1);assert(managed.items.some(p=>p.id===feedback));
  const responsible=await admin.request('/api/projects'+perspectiveQuery+'&perspective=responsible');assert.equal(responsible.stats.total,0);assert.equal(responsible.items.length,0);assert.equal(responsible.dashboard.managers.length,0);
  assert(managed.globalChecks.total>responsible.globalChecks.total);
  const forged=await member.request('/api/projects?view=all&perspective=management');assert(!forged.items.some(p=>p.id===adopted.result.projectId));
  const checkScope=await admin.request('/api/projects'+perspectiveQuery+'&perspective=responsible&details=checks');assert.equal(checkScope.stats.total,0);
  await admin.request('/api/projects?perspective=other','GET',undefined,400);
  let feedbackDetail=await admin.request('/api/projects/'+feedback);assert.equal(feedbackDetail.readOnly,true);assert.equal(feedbackDetail.capabilities.join,true);
  await admin.request('/api/projects/'+feedback,'PATCH',{scope:'project',changes:{summary:'未加入不得写'},expectedVersion:feedbackDetail.project.version,idempotencyKey:randomUUID()},403);
  await admin.request(`/api/projects/${feedback}/membership`,'POST',{action:'join',idempotencyKey:randomUUID()});
  feedbackDetail=await admin.request('/api/projects/'+feedback);assert.equal(feedbackDetail.readOnly,false);
  await admin.request('/api/projects/'+feedback,'PATCH',{scope:'project',changes:{summary:'兼任管理员可保存'},expectedVersion:feedbackDetail.project.version,idempotencyKey:randomUUID()});
  assert.equal((await admin.request('/api/projects/'+feedback)).project.summary,'兼任管理员可保存');
  assert.equal((await admin.request('/api/projects'+perspectiveQuery+'&perspective=responsible')).stats.total,1);
  checks.push('双身份的负责人/管理视角由同一成员条件作用于列表、统计、驾驶舱和检查；加入后负责人视角立即可见；普通账号伪造管理视角不扩大范围，非法视角拒绝');
  for(const state of ['ready','active']){
    await c.execute("UPDATE project_stages SET state='unknown' WHERE project_id=? AND stage_code='S1'",[feedback]);
    feedbackDetail=await admin.request('/api/projects/'+feedback);
    await admin.request('/api/projects/'+feedback,'PATCH',{scope:'project',changes:{},commands:[{action:'confirmStageState',stageCode:'S1',state}],expectedVersion:feedbackDetail.project.version,idempotencyKey:randomUUID()});
    assert.equal((await admin.request('/api/projects/'+feedback)).stages[0].state,state);
  }
  const ownerFilter=await admin.request('/api/projects?view=all&search='+prefix);
  assert(Object.values(ownerFilter.optionLabels.owner).every(name=>!/[（(](业务分工|项目经理)/.test(name)));
  feedbackDetail=await admin.request('/api/projects/'+feedback);
  const removal={expectedVersion:feedbackDetail.project.version,idempotencyKey:randomUUID()};
  await member.request(`/api/projects/${feedback}/delete`,'POST',removal,403);
  await second.request(`/api/projects/${feedback}/delete`,'POST',{...removal,expectedVersion:'1',idempotencyKey:randomUUID()},409);
  const removed=await second.request(`/api/projects/${feedback}/delete`,'POST',removal);
  assert.equal(removed.result.deleted,true);
  assert.deepEqual((await second.request(`/api/projects/${feedback}/delete`,'POST',removal)).result,removed.result);
  assert.deepEqual((await second.request(`/api/projects/${feedback}/delete-results/query`,'POST',removal)).result,removed.result);
  await admin.request('/api/projects/'+feedback,'GET',undefined,404);
  await admin.request('/api/projects/'+feedback,'PATCH',{scope:'project',changes:{summary:'已删不能改'},expectedVersion:feedbackDetail.project.version,idempotencyKey:randomUUID()},404);
  await member.request(`/api/projects/${feedback}/membership`,'POST',{action:'join',idempotencyKey:randomUUID()},404);
  const remaining=await admin.request('/api/projects?view=all&dashboard=1&details=checks&search='+encodeURIComponent(prefix+'反馈删除'));
  assert.equal(remaining.stats.total,0);assert.equal(remaining.pagination.total,0);assert.equal(remaining.items.length,0);assert.equal(remaining.dashboard.managers.length,0);
  assert(!(await admin.request('/api/project-space?search='+encodeURIComponent(prefix+'反馈删除'))).items.length);
  assert(!(await admin.request('/api/project-summary')).items.some(p=>p.id===feedback));
  const deleted=(await c.query('SELECT deleted_at,name_key FROM projects WHERE id=?',[feedback]))[0][0];assert(deleted.deleted_at);assert.equal(deleted.name_key,null);
  assert.equal(Number((await c.query("SELECT COUNT(*) n FROM audit_log WHERE project_id=? AND action='project.delete'",[feedback]))[0][0].n),1);
  const recreated=(await member.request('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'反馈删除'}})).result;
  assert.notEqual(recreated.projectId,feedback);
  checks.push('兼任管理员非成员只读、加入后实际保存；历史阶段两种选择共同保存后读回；人员筛选无角色后缀；管理员删除版本冲突/越权/幂等/旧页写入拒绝/全消费端移除/同名新建及审计保留');
  for(const kind of ['customers','odmFactories','engineers','productLines','apps','tags','groups','chips']){
    const create={id:null,expectedVersion:'0',idempotencyKey:randomUUID(),changes:{name:prefix+'资料'+kind}};
    const preview=await member.request(`/api/catalog/${kind}/preview`,'POST',create);
    const made=(await member.request(`/api/catalog/${kind}/save`,'POST',{...create,impactToken:preview.impactToken})).result;
    let item=(await member.request(`/api/catalog/${kind}/${made.id}`)).item;assert.equal(item.enabled,true);
    let linked;
    if(kind==='customers')linked=(await member.request('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'保留资料引用',customerIds:[made.id]}})).result.projectId;
    const remove={id:made.id,expectedVersion:item.version,idempotencyKey:randomUUID(),changes:{enabled:false}};
    const impact=await member.request(`/api/catalog/${kind}/preview`,'POST',remove);
    const body={...remove,impactToken:impact.impactToken};
    const removed=(await member.request(`/api/catalog/${kind}/save`,'POST',body)).result;
    item=(await member.request(`/api/catalog/${kind}/${made.id}`)).item;assert.equal(item.enabled,false);assert.equal(item.name,create.changes.name);
    if(linked){
      assert.equal((await member.request('/api/projects/'+linked)).project.customer,create.changes.name);
      assert.equal((await member.request(`/api/catalog/${kind}/save`,'POST',body)).result.operationId,removed.operationId);
      const restore={id:made.id,expectedVersion:item.version,idempotencyKey:randomUUID(),changes:{enabled:true}};
      const effect=await member.request(`/api/catalog/${kind}/preview`,'POST',restore);
      await member.request(`/api/catalog/${kind}/save`,'POST',{...restore,impactToken:effect.impactToken});
      assert.equal((await member.request(`/api/catalog/${kind}/${made.id}`)).item.enabled,true);
    }
  }
  checks.push('普通项目经理实际新增/移除八类业务资料，新请求读取一致；有引用客户删除后项目名称与关联保留、幂等重试和恢复通过');
  console.log(JSON.stringify({ status: 'passed', prefix, httpRequests, checks }));
} finally { if (app) await app.close(); await c.end(); }
