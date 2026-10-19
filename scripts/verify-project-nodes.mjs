import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectSaves, validateSave } from '../dist/server/modules/project-save.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1', '仅在独立测试实例执行');
const { connection: c } = await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'node_' + randomUUID().slice(0, 8), password = '节点验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '';
const authOrigin = 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app'); const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) { if (fault && sql.startsWith(fault)) return execute.call(this, 'INSERT INTO __missing_node_test_table VALUES (1)'); return execute.call(this, sql, params); };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw new Error('lost acknowledgement'); };
    try { return await work(lease); } finally { lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: authOrigin, secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
}
function client() {
  let cookie = '', csrf = '', account;
  return { get token() { return cookie.split('=')[1]; }, async api(path, method = 'GET', body, status = 200) {
    const began = performance.now();
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
    const data = await response.json(); if (Array.isArray(status)) { assert(status.includes(response.status), path + ': ' + JSON.stringify(data)); data.httpStatus = response.status; } else assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
    if (path === '/api/auth/me' && status === 200) account = data.account;
    measurements.push({ path, status: response.status, ms: performance.now() - began }); return data;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); } };
}
async function fresh(id) {
  const { connection } = await connectDatabase('test_app');
  try { const result = {}; for (const table of ['projects', 'project_stages', 'project_checks', 'schedule_changes', 'project_nodes', 'project_risks', 'audit_log']) result[table] = (await connection.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY id`, [id]))[0];
    result.receipts = (await connection.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0]; return result;
  } finally { await connection.end(); }
}
const input = (version, changes, scope = 'projectNodes', target) => ({ expectedVersion: version, idempotencyKey: randomUUID(), scope, ...(target ? {target} : {}), changes });
const add = (content = '人工风险内容🙂', level = 'high') => ({ op: 'add', tempId: randomUUID(), content, level });
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  assert.equal((await c.query('SELECT id FROM projects WHERE source_namespace=?', [prefix]))[0].length, 0);
  const hash = await hashPassword(password);
  for (let i = 0; i < 4; i++) { const loginName = prefix + '_' + i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, '节点合成账号' + i]); users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id }); }
  await start(); const clients = [client(), client(), client(), client()], [a, b] = clients;
  for (const [i, client] of clients.entries()) await client.login(i);
  for (let i = 0; i < 2; i++) { const out = await a.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + '_' + i } }); projects.push(out.result.projectId); }
  const id = projects[0], path = '/api/projects/' + id;
  const detail = () => a.api(path), save = (body, user = a, status = 200) => user.api(path, 'PATCH', body, status);
  for (const user of clients.slice(1)) { const d = await detail(); await user.api(path + '/responsibility', 'POST', { action: 'join', expectedVersion: d.project.version, idempotencyKey: randomUUID() }); }
  const version = async () => (await detail()).project.version;
  const perform = async (ops, user = a, changes = {}) => { const body = input(await version(), { ...changes, nodeOps: ops }); const before = await fresh(id); const preview = await user.api(path + '/save-preview', 'POST', body); assert.equal(preview.expectedVersion, body.expectedVersion); assert.deepEqual(await fresh(id), before, '预览不得正式写'); const result = (await save(body, user)).result; assert.equal((await detail()).project.version, result.savedVersion); return { body, result }; };
  const addNode = (title,kind='project') => ({op:'add',tempId:randomUUID(),kind,fields:kind==='project'?{title,stage:'S4',targetDate:'2020-01-01',output:'原成果保持🙂'}:{title,targetDate:null,note:'客户原备注'}});
  const N=[addNode('节点A'),addNode('节点B'),addNode('节点C'),addNode('客户节点','customer')];
  const mixedBefore=await fresh(id);await save(input(await version(),{nodeOps:N,summaryNote:'不得跨区夹带'}),a,400);assert.deepEqual(await fresh(id),mixedBefore);
  const first=await perform(N.slice(0,3));
  const customer=(await save(input(await version(),{nodeOps:[N[3]]},'customerNode',N[3].tempId))).result;
  const [A,B,C]=N.slice(0,3).map(node=>first.result.nodeIdMap[node.tempId]),K=customer.nodeIdMap[N[3].tempId];assert.equal(new Set([A,B,C,K]).size,4);assert.equal(first.result.nodes.length,3);assert.equal(first.result.changed,true);
  const risk=add();await save(input(await version(),{riskOps:[risk]},'risk',risk.tempId));
  await save(input(await version(),{summaryNote:'独立摘要范围'},'summaryNote'));
  let d=await detail();assert.equal(d.project.summaryNote,'独立摘要范围');assert.equal(Number(d.project.progress),0);assert.equal(d.risks.length,1);
  assert.equal(Number((await c.query('SELECT COUNT(*) n FROM audit_log WHERE project_id=? AND version_after=?',[id,first.result.savedVersion]))[0][0].n),3);
  const link=(from,to,replaceEdges=[],affectedIds=[],reason='')=>({op:'link',from,to,replaceEdges,affectedIds,reason});
  await perform([link(A,B),link(B,C)]);const linked=await detail();assert.equal(linked.nodes.find(n=>n.id===B).previousNodeId,A);assert.equal(linked.nodes.find(n=>n.id===B).nextNodeId,C);
  let prior=await fresh(id);assert.equal((await save(input(await version(),{nodeOps:[{op:'complete',id:B,completedOn:'2020-01-01'}]}),a,422)).code,'NODE_PREDECESSOR_INCOMPLETE');assert.deepEqual(await fresh(id),prior);
  await perform([{op:'complete',id:A,completedOn:'2020-01-03'},{op:'complete',id:B,completedOn:'2020-01-02'},{op:'complete',id:C,completedOn:'2020-01-01'}]);
  await save(input(await version(),{nodeOps:[{op:'complete',id:K,completedOn:'2020-01-01'}]},'customerNode',K));
  assert.equal((await detail()).stages.filter(s=>s.state==='completed').length,0,'节点不推进阶段；实际日期不套相邻阶段规则');
  let uncomplete={op:'uncomplete',id:A,reason:'明确纠正原完成误录',affectedIds:[]},body=input(await version(),{nodeOps:[uncomplete]});
  prior=await fresh(id);let preview=await a.api(path+'/save-preview','POST',body);assert.deepEqual(preview.requiredUncompleteIds.sort(),[B,C].sort());assert.equal(preview.confirmed,false);assert.deepEqual(await fresh(id),prior);
  assert.equal((await save(body,a,422)).code,'NODE_IMPACT_CHANGED');assert.deepEqual(await fresh(id),prior);
  assert.equal((await save(input(await version(),{nodeOps:[{...uncomplete,affectedIds:[B]}]}),a,422)).code,'NODE_IMPACT_CHANGED');
  assert.equal((await save(input(await version(),{nodeOps:[{...uncomplete,affectedIds:[B,C,K]}]}),a,400)).code,'SAVE_SCOPE_MISMATCH');
  await perform([{...uncomplete,affectedIds:[B,C]}]);d=await detail();assert(d.nodes.filter(n=>[A,B,C].includes(n.id)).every(n=>!n.completedOn&&n.output==='原成果保持🙂'&&n.targetDate==='2020-01-01'));assert.equal(d.nodes.find(n=>n.id===K).completedOn,'2020-01-01');
  await perform([{op:'complete',id:A,completedOn:'2020-01-03'},{op:'complete',id:B,completedOn:'2020-01-02'},{op:'complete',id:C,completedOn:'2020-01-01'}]);
  assert.equal((await save(input(await version(),{nodeOps:[{op:'complete',id:A,completedOn:'2020-01-04'}]}),a,422)).code,'NODE_CORRECTION_REASON_REQUIRED');
  await perform([{op:'complete',id:A,completedOn:'2020-01-04',reason:'完成日期原误录'}]);
  const noop=await perform([{op:'move',id:A,x:240,y:20}]);const noChange=await perform([{op:'move',id:A,x:240,y:20}]);assert.equal(noChange.result.changed,false);assert.equal(noop.result.savedVersion,noChange.result.savedVersion);
  checks.push('两类节点/风险/摘要分别保存，跨区夹带拒绝；直接前置与同范围同次完成、日期无额外顺序；明确下游集合、完成纠错与移动同值');
  const D=addNode('新的未完成前置');const addedD=await perform([D]);const DId=addedD.result.nodeIdMap[D.tempId];
  body=input(await version(),{nodeOps:[link(DId,B,[{from:A,to:B}]) ]});preview=await a.api(path+'/save-preview','POST',body);assert.deepEqual(preview.requiredUncompleteIds.sort(),[B,C].sort());assert.equal(preview.confirmed,false);
  assert.equal((await save(input(await version(),{nodeOps:[link(DId,B)]}),a,422)).code,'NODE_REPLACEMENT_CHANGED');
  const replaced=await perform([link(DId,B,[{from:A,to:B}],[B,C],'更换前置并明确纠正依赖完成日')],b);d=await detail();assert.equal(d.nodes.find(n=>n.id===A).nextNodeId,null);assert.equal(d.nodes.find(n=>n.id===B).previousNodeId,DId);assert.equal(d.nodes.find(n=>n.id===C).completedOn,null);assert.equal(d.nodes.find(n=>n.id===DId).nextNodeId,B);
  await perform([{op:'unlink',from:DId,to:B},link(A,B),{op:'complete',id:B,completedOn:'2020-01-02'},{op:'complete',id:C,completedOn:'2020-01-01'}]);
  prior=await fresh(id);const cyclic=input(await version(),{nodeOps:[link(C,A)]});const error=await a.api(path+'/save-preview','POST',cyclic,422);assert.equal(error.code,'NODE_CYCLE');assert(error.fields.nodeOps.includes(A)&&error.fields.nodeOps.includes(B)&&error.fields.nodeOps.includes(C));assert.equal((await save(cyclic,a,422)).code,'NODE_CYCLE');assert.deepEqual(await fresh(id),prior);
  // 明确合成来源旧循环；普通文字与移动不改关系，不能替代循环纠正。
  await c.execute('UPDATE project_nodes SET previous_node_id=? WHERE id=?',[C,A]);await c.execute('UPDATE project_nodes SET next_node_id=? WHERE id=?',[A,C]);
  await save(input(await version(),{summaryNote:'旧循环不拦无关文字'},'summaryNote'));await perform([{op:'move',id:DId,x:500.125,y:150.25}]);
  assert.equal((await save(input(await version(),{nodeOps:[{op:'complete',id:C,completedOn:'2020-01-01'}]}),a,422)).code,'NODE_CYCLE');
  await perform([{op:'unlink',from:C,to:A}]);d=await detail();assert.equal(d.nodes.find(n=>n.id===A).previousNodeId,null);assert.equal(d.nodes.find(n=>n.id===C).nextNodeId,null);
  checks.push('明确旧线替换与双向残留清除、未完成前置下游纠错；新循环拒绝路径、旧循环保留后明确拆除');
  const peerNode=addNode('另一项目节点');const peer=(await a.api('/api/projects/'+projects[1],'PATCH',input('1',{nodeOps:[peerNode]}))).result.nodeIdMap[peerNode.tempId];
  for(const ops of [[link(A,A)],[link(K,A)],[link(A,peer)],[{op:'correct',id:peer,changes:{title:'跨项目'},reason:'不可修改'}],[{op:'correct',id:K,changes:{stage:'S1'},reason:'类型错误'}]]){const before=await fresh(id);await save(input(await version(),{nodeOps:ops}),a,[400,404,422]);assert.deepEqual(await fresh(id),before);}
  const invalid=[{op:'add',tempId:randomUUID(),kind:'project',fields:{title:'不混客户备注',stage:'S1',output:'结果',note:'非法类型字段'}}, {op:'add',tempId:randomUUID(),kind:'project',fields:{title:'空成果',stage:'S1',output:''}}, {op:'add',tempId:randomUUID(),kind:'customer',fields:{title:'不加阶段',stage:'S1'}}, {op:'add',tempId:randomUUID(),kind:'project',fields:{title:'伪造',stage:'S1',output:'结果',actorId:users[1].id}}, {op:'correct',id:A,changes:{completedOn:null},reason:'普通字段不能清实际'}, {op:'move',id:A,x:1000000000,y:0}, {op:'move',id:A,x:1.0001,y:0}, {op:'move',id:K,x:1,y:0}, {op:'complete',id:A,completedOn:'2099-01-01',reason:'未来实际'}, {op:'complete',id:A,completedOn:'2026-02-30'}, {op:'uncomplete',id:A,reason:' ',affectedIds:[]}];
  for(const op of invalid){prior=await fresh(id);await save(input(await version(),{nodeOps:[op]}),a,[400,422]);assert.deepEqual(await fresh(id),prior);}
  await c.execute('UPDATE project_nodes SET source_key=? WHERE id=?',['明确旧节点来源',A]);await perform([{op:'correct',id:A,changes:{title:'A名称纠正',targetDate:null,output:'纠正成果'},reason:'信息误填'}]);assert.equal((await detail()).nodes.find(n=>n.id===A).sourceKey,'明确旧节点来源');
  checks.push('项目/客户字段白名单、同项目ID/阶段/临时引用与日期位置边界；旧来源保持，非法混合整份不提交');
  const v=await version(), beforeRace=await fresh(id);const race=await Promise.all(clients.map((user,i)=>save(input(v,{nodeOps:[{op:'move',id:DId,x:600+i,y:200}]}),user,[200,409])));assert.equal(race.filter(out=>out.httpStatus===200).length,1);assert.equal(race.filter(out=>out.httpStatus===409).length,3);const afterRace=await fresh(id);assert.equal(afterRace.audit_log.length-beforeRace.audit_log.length,1);
  await b.api(path+'/responsibility','POST',{action:'leave',expectedVersion:await version(),idempotencyKey:randomUUID()});assert.equal((await save(input(await version(),{nodeOps:[{op:'move',id:A,x:1,y:1}]}),b,403)).code,'PROJECT_READ_ONLY');
  assert.deepEqual((await save(replaced.body,b)).result,replaced.result,'退出负责仍确认本人原结果');
  const captured=await identities(runtime).resolve(clients[3].token);await c.execute('UPDATE users SET enabled=0 WHERE id=?',[users[3].id]);await assert.rejects(projectSaves(runtime).save(id,validateSave(input(await version(),{nodeOps:[{op:'move',id:A,x:1,y:1}]})),randomUUID(),captured),e=>e.code==='AUTH_REQUIRED');
  checks.push('四会话同版本只一成功；旧版本/退出负责拒绝；事务内停用复核和本人原结果恢复');
  for(const point of ['UPDATE projects','INSERT INTO project_nodes','UPDATE project_nodes SET previous_node_id','UPDATE project_nodes SET stage_id','INSERT INTO audit_log','INSERT INTO command_receipts']) {
    const n=addNode('写点故障');body=input(await version(),{nodeOps:[n,{op:'unlink',from:A,to:B},link(A,n.tempId)]});prior=await fresh(id);fault=point;const rejected=await save(body,a,500);assert.equal(rejected.code,'SAVE_ROLLED_BACK');assert.equal(rejected.outcome,'not_committed');fault='';assert.deepEqual(await fresh(id),prior,point);
  }
  const L=addNode('丢确认新节点'),M=addNode('丢确认下一节点');body=input(await version(),{nodeOps:[L,M,link(L.tempId,M.tempId),{op:'complete',id:L.tempId,completedOn:'2020-01-03'},{op:'complete',id:M.tempId,completedOn:'2020-01-01'}]});
  fault='ack';assert.equal((await save(body,a,503)).code,'COMMIT_UNKNOWN');fault='';const receipt=await a.api(path+'/save-results/query','POST',body);assert.equal(receipt.outcome,'committed');prior=await fresh(id);await app.close();app=undefined;await start();assert.deepEqual((await save(body)).result,receipt.result);assert.deepEqual((await a.api(path+'/save-results/query','POST',body)).result,receipt.result);assert.deepEqual(await fresh(id),prior);
  d=await detail();assert.equal(d.nodes.find(n=>n.id===receipt.result.nodeIdMap[L.tempId]).nextNodeId,receipt.result.nodeIdMap[M.tempId]);assert.equal(d.project.status,'proposal');assert.equal(Number(d.project.progress),0);assert.equal(d.project.signal,'green');assert.equal(d.project.dueDate,null);assert.equal(d.risks.length,1);assert.equal(d.project.checkStatus.latest,null);
  checks.push('信息/位置/清线/置线/多节点/审计/回执写点全回滚；真实COMMIT丢确认后原会话/映射/关系/历史恢复，无业务自动联动');
  const build=(await a.api('/api/health/live')).build;await mkdir('test-results',{recursive:true});await writeFile('test-results/project-nodes-check.json',JSON.stringify({status:'passed',checkedAt:new Date().toISOString(),checks,requestCount:measurements.length,measurements,build,isolatedTestDatabase:true,nodeMigrationDelivered:false},null,2)+'\n');console.log(JSON.stringify({status:'passed',groups:checks.length,requestCount:measurements.length}));
} finally {
  if (app) await app.close();
  for (const id of projects) { await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?',[id]); for (const table of ['project_nodes', 'project_risks', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
