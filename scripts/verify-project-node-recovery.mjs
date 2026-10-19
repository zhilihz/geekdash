import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectSaves, validateSave } from '../dist/server/modules/project-save.js';

const prefix = 'recovery_' + randomUUID().slice(0, 8), password = '节点验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '', faultAfter = 0;
// 当前0004兼容边界由verify-project-compatibility验证；旧0003产物不得在这里启动为ready。
const authOrigin = 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app'); const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) { if (fault && sql.startsWith(fault) && --faultAfter <= 0) return execute.call(this, 'INSERT INTO __missing_node_test_table VALUES (1)'); return execute.call(this, sql, params); };
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
const input = (version, changes, scope='projectNodes', target) => ({ expectedVersion: version, idempotencyKey: randomUUID(), scope, ...(target?{target}:{}), changes });
const add = (content = '人工风险内容🙂', level = 'high') => ({ op: 'add', tempId: randomUUID(), content, level });
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1','仅在独立测试实例执行');
const { connection: c } = await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  const hash = await hashPassword(password);
  for (let i=0;i<4;i++) { const loginName=prefix+'_'+i; await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[loginName,hash,'恢复合成账号'+i]); users.push({loginName,id:(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id}); }
  await start(); const clients=[client(),client(),client(),client()],[a,b]=clients;
  for (const [i,user] of clients.entries()) await user.login(i);
  for (let i=0;i<2;i++) projects.push((await a.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+'_'+i}})).result.projectId);
  const id=projects[0],path='/api/projects/'+id,detail=()=>a.api(path),version=async()=>(await detail()).project.version,save=(body,user=a,status=200)=>user.api(path,'PATCH',body,status);
  for (const user of clients.slice(1)) await user.api(path+'/responsibility','POST',{action:'join',expectedVersion:await version(),idempotencyKey:randomUUID()});
  const perform=async(ops,user=a,changes={})=>{const body=input(await version(),{...changes,nodeOps:ops}),before=await fresh(id);const preview=await user.api(path+'/save-preview','POST',body);assert.deepEqual(await fresh(id),before);assert.equal(preview.confirmed,true);const result=(await save(body,user)).result;assert.equal((await detail()).project.version,result.savedVersion);return {body,result};};
  const addNode=(title,kind='project')=>({op:'add',tempId:randomUUID(),kind,fields:kind==='project'?{title,stage:'S4',targetDate:'2020-01-01',output:'恢复原成果🙂'}:{title,note:'客户原备注',targetDate:null}});
  const link=(from,to,replaceEdges=[],affectedIds=[],reason='')=>({op:'link',from,to,replaceEdges,affectedIds,reason});
  const restore=id=>({op:'restore',id,reason:'原删除误点，明确恢复原节点'});
  const edges=(d,key)=>{const m=new Map(),add=(from,to)=>{if(from&&to)m.set(from+':'+to,{from,to});};const n=d.nodes.find(n=>n.id===key);assert(n);add(n.previousNodeId,key);add(key,n.nextNodeId);for(const n of d.nodes){if(n.nextNodeId===key)add(n.id,key);if(n.previousNodeId===key)add(key,n.id);}return [...m.values()];};
  const del=async key=>({op:'delete',id:key,removeEdges:edges(await detail(),key)});
  const N=['A','B','C','D'].map(s=>addNode(s)),first=await perform(N);
  const [A,B,C,D]=N.map(n=>first.result.nodeIdMap[n.tempId]);
  const customerNode=addNode('客户','customer'),customerCreated=(await save(input(await version(),{nodeOps:[customerNode]},'customerNode',customerNode.tempId))).result,K=customerCreated.nodeIdMap[customerNode.tempId];
  await c.execute('UPDATE project_nodes SET source_key=? WHERE id=?',['明确合成旧来源B',B]);
  await perform([link(A,B),link(B,C),... [A,B,C].map(id=>({op:'complete',id,completedOn:'2020-01-02'}))]);
  await save(input(await version(),{nodeOps:[{op:'complete',id:K,completedOn:'2020-01-02'}]},'customerNode',K));
  const initial=await detail(), originalB=initial.nodes.find(n=>n.id===B);let prior=await fresh(id);
  const bad=input(await version(),{nodeOps:[{op:'delete',id:B,removeEdges:[]}]});assert.equal((await save(bad,a,422)).code,'NODE_DELETE_LINKS_CHANGED');assert.deepEqual(await fresh(id),prior);
  const deleted=await perform([await del(B)]);let d=await detail();assert(!d.nodes.some(n=>n.id===B));assert.equal(d.nodes.find(n=>n.id===A).nextNodeId,null);assert.equal(d.nodes.find(n=>n.id===C).previousNodeId,null);assert(d.nodes.filter(n=>[A,C,K].includes(n.id)).every(n=>n.completedOn==='2020-01-02'));
  let page=await a.api(path+'/deleted-nodes');assert.equal(page.projectVersion,d.project.version);let stored=page.items.find(n=>n.id===B);assert.equal(stored.sourceKey,originalB.sourceKey);assert.equal(stored.completedOn,originalB.completedOn);assert.equal(stored.output,originalB.output);assert.equal(stored.deletion.actorName,'恢复合成账号0');assert.deepEqual(stored.deletion.beforeNode,originalB);
  assert.equal((await save(input(await version(),{nodeOps:[{op:'delete',id:B,removeEdges:[]}]}),a,422)).code,'NODE_ALREADY_DELETED');
  assert.equal((await save(input(await version(),{nodeOps:[link(A,B)]}),a,404)).code,'NODE_NOT_FOUND');
  await perform([link(A,C)],b);const neighbor=await detail();
  const recovered=await perform([restore(B)],b);d=await detail();assert.deepEqual(d.nodes.find(n=>n.id===B),{...originalB,previousNodeId:null,nextNodeId:null});assert.deepEqual(d.nodes.filter(n=>n.id!==B),neighbor.nodes);assert(!(await a.api(path+'/deleted-nodes')).items.some(n=>n.id===B));
  assert.equal((await save(input(await version(),{nodeOps:[restore(B)]}),a,422)).code,'NODE_NOT_DELETED');
  assert.deepEqual((await save(deleted.body)).result,deleted.result);assert.deepEqual((await save(recovered.body,b)).result,recovered.result);
  checks.push('真实删中间并精确确认旧线，来源/实际日/成果保持、邻居不桥接/不清完成；另一负责人新线后恢复同ID默认无旧线、原审计/原结果保持');

  await perform([await del(B),await del(C)]);prior=await fresh(id);
  const multiple=[restore(B),restore(C),link(D,B),link(B,C)];let preview=await a.api(path+'/save-preview','POST',input(await version(),{nodeOps:multiple}));assert.deepEqual(preview.requiredUncompleteIds.sort(),[B,C].sort());assert.equal(preview.confirmed,false);assert.deepEqual(await fresh(id),prior);assert.equal((await save(input(await version(),{nodeOps:multiple}),a,422)).code,'NODE_IMPACT_CHANGED');
  await perform([restore(B),restore(C),link(D,B,[],[B,C],'明确恢复后前置变化，纠正两实际日'),link(B,C)]);d=await detail();assert.equal(d.nodes.find(n=>n.id===B).completedOn,null);assert.equal(d.nodes.find(n=>n.id===C).completedOn,null);assert.equal(d.nodes.find(n=>n.id===B).previousNodeId,D);
  await perform([await del(B)]);await c.execute('UPDATE project_nodes SET stage_id=NULL,completed_on=? WHERE id=?',['2099-01-01',B]);
  prior=await fresh(id);assert.equal((await save(input(await version(),{nodeOps:[restore(B)]}),a,422)).code,'NODE_STAGE_INVALID');assert.deepEqual(await fresh(id),prior);
  assert.equal((await save(input(await version(),{nodeOps:[restore(B),{op:'correct',id:B,changes:{stage:'S3'},reason:'阶段误录'}]}),a,422)).code,'INVALID_PROJECT_FIELDS');
  await perform([restore(B),{op:'correct',id:B,changes:{stage:'S3'},reason:'阶段误录'},{op:'uncomplete',id:B,reason:'原实际日误录',affectedIds:[]}]);
  await save(input(await version(),{nodeOps:[await del(K)]},'customerNode',K));const customer=await save(input(await version(),{nodeOps:[restore(K)]},'customerNode',K));assert.equal(customer.result.nodes.find(n=>n.id===K).completedOn,'2020-01-02');
  // 明确合成旧单边引用，不冒充线上故障；删除须覆盖所有反向引用。
  await c.execute('UPDATE project_nodes SET next_node_id=? WHERE id=?',[B,A]);await c.execute('UPDATE project_nodes SET previous_node_id=? WHERE id=?',[B,C]);
  const correctedDelete=await perform([await del(B)]);d=await detail();assert.equal(d.nodes.find(n=>n.id===A).nextNodeId,null);assert.equal(d.nodes.find(n=>n.id===C).previousNodeId,null);
  checks.push('同份多个恢复与新线复用最终前置/明确影响，异常旧阶段和未来实际日可同次明确纠正；客户恢复与旧单边所有引用预览清除');

  prior=await fresh(id);await app.close();app=undefined;
  await start();assert.equal((await a.api('/api/health/ready')).status,'ready');assert.equal((await a.api('/api/auth/me')).account.id,users[0].id);assert(!(await detail()).nodes.some(n=>n.id===B));assert.deepEqual((await a.api(path+'/save-results/query','POST',first.body)).result,first.result);assert.deepEqual(await fresh(id),prior);
  assert.deepEqual((await a.api(path+'/save-results/query','POST',correctedDelete.body)).result,correctedDelete.result);await perform([restore(B)]);assert.equal((await detail()).nodes.find(n=>n.id===B).sourceKey,'明确合成旧来源B');
  checks.push('当前兼容应用重启后ready/原会话/有效过滤/原回执保持，恢复原ID和来源；跨版本回退另由P04-02兼容测试验证');

  const E=addNode('无可信删除审计的合成来源');const e=(await perform([E])).result.nodeIdMap[E.tempId];await c.execute('UPDATE project_nodes SET deleted_at=UTC_TIMESTAMP(3) WHERE id=?',[e]);assert.equal((await a.api(path+'/deleted-nodes')).items.find(n=>n.id===e).deletion,null);
  const many=Array.from({length:112},(_,i)=>addNode('分页节点'+i));const bulk=await perform(many);const ids=many.map(n=>bulk.result.nodeIdMap[n.tempId]);await perform(ids.map(id=>({op:'delete',id,removeEdges:[]})));
  const all=[];let cursor;do{page=await a.api(path+'/deleted-nodes'+(cursor?'?before='+cursor:''));assert.equal(page.pageSize,20);assert.equal(page.projectVersion,await version());all.push(...page.items.map(n=>n.id));cursor=page.nextCursor;}while(cursor);
  assert.equal(new Set(all).size,all.length);assert(all.every((id,i)=>!i||BigInt(all[i-1])>BigInt(id)));assert.equal(all.length,Number((await c.query('SELECT COUNT(*) n FROM project_nodes WHERE project_id=? AND deleted_at IS NOT NULL',[id]))[0][0].n));assert.equal((await a.api(path+'/deleted-nodes?pageSize=100')).items.length,100);
  for(const query of ['?pageSize=101','?pageSize=0','?before=0','?before=18446744073709551616','?unexpected=1'])await a.api(path+'/deleted-nodes'+query,'GET',undefined,400);
  await a.api('/api/projects/18446744073709551000/deleted-nodes','GET',undefined,404);
  const close=await a.api(path+'/actions/preview','POST',{action:'closeProject',closureType:'normal',closedOn:(await detail()).businessDate,closureNote:'核对',remainingWorkNote:'保留当前有效遗留',expectedVersion:await version(),idempotencyKey:randomUUID()});assert(!close.remaining.nodes.some(n=>ids.includes(n.id)||n.id===e));
  checks.push('已删记录独立20/100数值游标超过100无总量上限，版本同快照；未知删除来源不补造，结案遗留与有效详情排除已删行');

  const peer=addNode('跨项目');const peerId=(await a.api('/api/projects/'+projects[1],'PATCH',input('1',{nodeOps:[peer]}))).result.nodeIdMap[peer.tempId];
  for(const operation of [{op:'delete',id:peerId,removeEdges:[]},restore(peerId),{op:'delete',id:B,removeEdges:[{from:A,to:B},{from:A,to:B}]},{op:'delete',id:B,removeEdges:[],deletedAt:'2020-01-01'}, {...restore(e),reason:' '},{...restore(e),sourceKey:'伪造'}, {op:'delete',id:randomUUID(),removeEdges:[]}]){prior=await fresh(id);await save(input(await version(),{nodeOps:[operation]}),a,[400,404,422]);assert.deepEqual(await fresh(id),prior);}
  const R=addNode('同版竞争');const RId=(await perform([R])).result.nodeIdMap[R.tempId],v=await version();prior=await fresh(id);const race=await Promise.all(clients.map(user=>save(input(v,{nodeOps:[{op:'delete',id:RId,removeEdges:[]}]}),user,[200,409])));assert.equal(race.filter(r=>r.httpStatus===200).length,1);assert.equal(race.filter(r=>r.httpStatus===409).length,3);assert.equal((await fresh(id)).audit_log.length-prior.audit_log.length,1);
  await b.api(path+'/responsibility','POST',{action:'leave',expectedVersion:await version(),idempotencyKey:randomUUID()});await save(input(await version(),{nodeOps:[restore(RId)]}),b,403);assert.deepEqual((await save(recovered.body,b)).result,recovered.result);
  const captured=await identities(runtime).resolve(clients[3].token);await c.execute('UPDATE users SET enabled=0 WHERE id=?',[users[3].id]);await assert.rejects(projectSaves(runtime).save(id,validateSave(input(await version(),{nodeOps:[restore(RId)]})),randomUUID(),captured),e=>e.code==='AUTH_REQUIRED');
  checks.push('新增有限协议白名单/跨项目/非法原线/原因拒绝且普通文字不部分写；四真实会话删除同版一赢家，失权和事务内停用拒绝，本人旧结果仍可确认');

  await perform([link(A,B),link(B,C)]);
  for(const [point,count] of [['UPDATE projects',1],['UPDATE project_nodes SET previous_node_id',2],['UPDATE project_nodes SET stage_id',2],['INSERT INTO audit_log',2],['INSERT INTO command_receipts',1]]){const body=input(await version(),{nodeOps:[await del(B)]});prior=await fresh(id);fault=point;faultAfter=count;assert.equal((await save(body,a,500)).code,'SAVE_ROLLED_BACK');fault='';assert.deepEqual(await fresh(id),prior,point);}
  const gone=await perform([await del(B)]);
  for(const [point,count] of [['UPDATE projects',1],['UPDATE project_nodes SET stage_id',2],['INSERT INTO audit_log',2],['INSERT INTO command_receipts',1]]){const body=input(await version(),{nodeOps:[restore(B),link(A,B),link(B,C)]});prior=await fresh(id);fault=point;faultAfter=count;assert.equal((await save(body,a,500)).code,'SAVE_ROLLED_BACK');fault='';assert.deepEqual(await fresh(id),prior,point);}
  for(const ops of [[restore(B)],[{op:'delete',id:B,removeEdges:[]}]]) {const body=input(await version(),{nodeOps:ops});fault='ack';assert.equal((await save(body,a,503)).code,'COMMIT_UNKNOWN');fault='';const receipt=await a.api(path+'/save-results/query','POST',body);assert.equal(receipt.outcome,'committed');prior=await fresh(id);await app.close();app=undefined;await start();assert.deepEqual((await save(body)).result,receipt.result);assert.deepEqual(await fresh(id),prior);assert.equal((await a.api('/api/auth/me')).account.id,users[0].id);}
  d=await detail();assert.equal(d.project.status,initial.project.status);assert.equal(d.project.signal,initial.project.signal);assert.equal(Number(d.project.progress),Number(initial.project.progress));assert.equal(d.project.dueDate,initial.project.dueDate);assert.equal(d.project.checkStatus.latest,null);
  checks.push('删除/恢复及多邻居第二SQL写点、审计/回执全回滚；两类真实COMMIT丢确认应用重建后原会话/原结果保持，无业务自动联动');
  const build=(await a.api('/api/health/live')).build;await mkdir('test-results',{recursive:true});await writeFile('test-results/project-node-recovery-check.json',JSON.stringify({status:'passed',checkedAt:new Date().toISOString(),checks,requestCount:measurements.length,measurements,build,compatibilityEvidence:'docs/evidence/2026-10-16-p04-02-compatibility.json',processMemory:process.memoryUsage(),isolatedTestDatabase:true,syntheticLegacyAnomalies:true,nativeBrowserAcceptance:false},null,2)+'\n');console.log(JSON.stringify({status:'passed',groups:checks.length,requestCount:measurements.length}));
} finally {
  if (app) await app.close();
  for (const id of projects) { await c.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=?',[id]); for (const table of ['project_nodes', 'project_risks', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
