import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { normalizeImportProject } from '../dist/server/modules/project-import.js';
import { hashPassword } from '../dist/server/modules/identity.js';

// 必须在本轮独立数据库运行，禁止指向用户正在使用的本地库。
assert.equal(process.env.GEEKDASH_EXPERIENCE_TEST, '1');
const { connection: c } = await connectDatabase('test_migrator');
const uuid = (await c.query('SELECT @@server_uuid id'))[0][0].id;
assert.equal(uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
assert.notEqual(uuid, '3b7588d1-d1c1-11f1-9430-de9c3ef7caac');
const prefix = 'experience_' + randomUUID().slice(0, 8), password = 'Test123!abc';
let app, origin;
const checks = [];
const mixed=normalizeImportProject({id:1,statusDesc:'1、同文\n2、同文',tasks:[{id:'old',text:'原任务'}]});assert.equal(mixed.input.tasks.length,3);assert.equal(new Set(mixed.input.tasks.map(t=>t.id)).size,3);assert.equal(mixed.input.fields.statusDesc,undefined);
function client() {
  let cookie = '', csrf = '', account;
  return {
    async request(path, method = 'GET', body, expected = 200, binary = false) {
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
  const chosen = batch.items.map(item => ({ id: item.id, command: { expectedBatchVersion: batch.batch.version, expectedReviewVersion: item.reviewVersion, expectedVersion: item.expectedVersion, idempotencyKey: randomUUID(), basis: item.basis, selected: item.defaultSelected }, resolveReferences: true }));
  const execution = { formatVersion: 2, idempotencyKey: randomUUID(), items: chosen };
  await member.request(`/api/imports/${batchId}/executions`, 'POST', execution, 202);
  let result; for (let n = 0; n < 80; n++) { result = await member.request(`/api/imports/${batchId}/executions?operation=${execution.idempotencyKey}`); if (result.status === 'finished') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(result.status, 'finished');
  batch = await member.request('/api/imports/' + batchId); assert.equal(batch.counts.processed, 2);
  for (const item of batch.items) { const detail = await member.request('/api/projects/' + item.previousResult.projectId); assert.deepEqual(detail.project.customerIds, []); }
  const board = await member.request('/api/projects?view=all'); assert(board.items.some(p => p.name === prefix + '空客户项目'));
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM customers WHERE name=?', [prefix + '待忽略客户']))[0][0].n), 0);
  checks.push('单独横线按空值；忽略资料可重试、新请求解除待导入引用；两个项目实际入库并出现在详情和个人看板；未创建被忽略资料');

  let detail = await member.request('/api/projects/' + project.projectId);
  const save = async(changes,expected=200,version=detail.project.version)=>member.request('/api/projects/'+project.projectId,'PATCH',{scope:'project',changes,expectedVersion:version,idempotencyKey:randomUUID()},expected);
  await save({statusDesc:'1、旧进展\n2、重复进展\n3、重复进展'});
  detail=await member.request('/api/projects/'+project.projectId);assert.equal(detail.project.tasks.length,3);assert.equal(new Set(detail.project.tasks.map(t=>t.id)).size,3);
  const oldVersion=detail.project.version,first=detail.project.tasks[0].id,added=randomUUID();
  const body={scope:'project',changes:{summary:'任务共同保存',taskOps:[{op:'edit',id:first,text:'修正进展 @工程师'},{op:'complete',id:first},{op:'add',id:added,text:'下一步'}]},expectedVersion:oldVersion,idempotencyKey:randomUUID()};
  for(const scope of ['project','status']){
    const clientDraftId=randomUUID(),changes=scope==='project'?body.changes:{taskOps:body.changes.taskOps};
    const draft=await member.request('/api/personal/drafts/save','POST',{clientDraftId,projectId:project.projectId,formKind:scope,baseVersion:oldVersion,expectedDraftVersion:'0',clientSequence:'1',payload:{schemaVersion:1,instanceId:randomUUID(),values:changes,submission:{scope,changes}}});
    const reloaded=await member.request('/api/personal/drafts?clientDraftId='+clientDraftId);assert.deepEqual(reloaded.items[0].payload.values.taskOps,body.changes.taskOps);assert.equal(draft.draftVersion,'1');
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
  const dashboard=await member.request('/api/projects?view=all&dashboard=1');assert(dashboard.dashboard.managers.some(manager=>manager.id===registered.accountId&&manager.count>=3));assert(dashboard.dashboard.distributions.progress.length);
  checks.push('任务原说明逐行保留且同文不合并；整页任务与简介原子保存；重试不重复；完成/重开/删除/无变化/旧版本冲突；新请求简要与驾驶舱消费');
  const taskBatchId=await admin.upload({version:2,projects:[{id:123,name:prefix+'1056任务',status:'已结案',pm:prefix+'首次登记姓名',taskUnifiedVersion:1,statusDesc:'这个旧投影不能再导入',tasks:[{id:'same',text:'待办任务',createdAt:'2026-10-10',updatedAt:'2026-10-11'},{id:'SAME',text:'已完成任务',completedAt:'2026-10-12'},{id:'gone',text:'已删除任务',deletedAt:'2026-10-13'}]}]});
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

  const suggestion=await member.request('/api/auth/me');assert(suggestion.account.suggestedProjectCount>=1);
  const space=await member.request('/api/project-space');assert(space.items.some(p=>p.id===adopted.result.projectId&&p.suggested));
  await member.request('/api/projects/'+adopted.result.projectId,'GET',undefined,403);
  const ownDashboard=await member.request('/api/projects?view=all&dashboard=1');assert(!ownDashboard.items.some(p=>p.id===adopted.result.projectId));
  const filteredTasks=await member.request('/api/projects?view=all&taskOwner=工程师');assert(filteredTasks.items.some(p=>p.id===project.projectId));
  checks.push('只用首次登记姓名给出可加入项目提示；管理员改名不改匹配名；未加入仍不能读取详情或进入个人统计；任务人员筛选消费未完成任务');
  console.log(JSON.stringify({ status: 'passed', prefix, checks }));
} finally { if (app) await app.close(); await c.end(); }
