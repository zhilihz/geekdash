import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { addDays, businessToday, businessWeek } from '../dist/server/modules/project-dates.js';
import { changeRows, riskRows, deletedNodes } from '../dist/server/modules/project-records.js';
import { hashPassword } from '../dist/server/modules/identity.js';

const changeMode = process.argv.includes('--changes'), changeIds = [];
assert(!changeMode || process.argv.includes('--recovery'), '变更容量沿完整已删节点/风险/检查负载验收');
let changeQueryPlan;
const checkMode = process.argv.includes('--checks');
const riskMode = process.argv.includes('--risks');
const nodeMode = process.argv.includes('--nodes'), nodeIds = [];
const recoveryMode = process.argv.includes('--recovery'), deletedIds = [];
assert(!recoveryMode || nodeMode && riskMode && checkMode, '恢复容量沿完整节点/风险/检查负载验收');

const riskIds = [];
let riskQueryPlan;
let deletedQueryPlan;
const namespace = changeMode ? '__capacity_500_changes_test__' : recoveryMode ? '__capacity_500_recovery_test__' : nodeMode ? '__capacity_500_nodes_test__' : riskMode ? '__capacity_500_risks_test__' : checkMode ? '__capacity_500_checks_test__' : '__capacity_500_test__';
const ids = Array.from({length: 501}, (_, i) => String(9007199254780000n + BigInt(i)));
const {connection} = await connectDatabase('test_migrator');
let app, runtime, origin, owned = false, ownConfig = false, checkRule;
const references = {customers: [], chips: [], engineers: [], tags: []};
const measurements = {...(changeMode ? {changePreview: [], changeSave: []} : {}), list: [], detail: [], save: [], audit: [], ...(checkMode ? {checkSave: [], checkHistory: []} : {}), ...(riskMode ? {riskPreview: [], riskSave: []} : {}), ...(nodeMode ? {nodePreview: [], nodeSave: []} : {}), ...(recoveryMode ? {deletedRead: [], restorePreview: [], restoreSave: [], deletePreview: [], deleteSave: []} : {})};
const began = new Date().toISOString();
const accounts = [];
const password = '四人容量验证 password 2026';
async function api(path, method = 'GET', body) {
  const target = /^\/api\/projects\/([0-9]+)/.exec(path)?.[1];
  const index = target ? Math.max(ids.indexOf(target), 0) % 4 : Number(new URL(path, 'http://localhost').searchParams.get('customer')?.slice(-1) ?? 0);
  const account = accounts[index];
  const response = await fetch(origin + path, {method, headers: {'Content-Type':'application/json',Cookie:account.cookie,Origin:'http://localhost','X-GeekDash-Request':'1','X-GeekDash-CSRF':account.csrf,'X-GeekDash-Account':account.id,'X-GeekDash-Active':'1'}, ...(body ? {body: JSON.stringify(body)} : {})});
  const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
}
async function measured(kind, path, method, body) { const start = performance.now(); const result = await api(path,method,body); measurements[kind].push(performance.now()-start); return result; }
try {
  const [existing] = await connection.execute('SELECT id FROM projects WHERE source_namespace=? OR id BETWEEN ? AND ?', [namespace,ids[0],ids.at(-1)]);
  assert.equal(existing.length, 0, '自己的夹具存在；先核对，不能覆盖');
  runtime = await openRuntimeDatabase('test_app');
  app = await createApp(runtime, {origin:'http://localhost',secure:false}); origin = await app.listen({host: '127.0.0.1',port: 0});
  const hash = await hashPassword(password);
  for (let index=0;index<4;index++) {
    const loginName='capacity_'+randomUUID().slice(0,8)+'_'+index;
    await connection.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[loginName,hash,'合成容量账号'+index]);
    const id=(await connection.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
    accounts.push({id});
    const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:'http://localhost','X-GeekDash-Request':'1','Content-Type':'application/json'},body:JSON.stringify({loginName,password})});
    assert.equal(login.status,200); const cookies=login.headers.getSetCookie().map(value=>value.split(';')[0]);
    Object.assign(accounts[index],{cookie:cookies.find(value=>value.startsWith('geekdash_dev=')),csrf:cookies.find(value=>value.startsWith('geekdash_dev_csrf=')).split('=')[1]});
  }
  await connection.beginTransaction();
  for (const [table, columns] of Object.entries({customers:['contact','background'], chips:['original_model','manufacturer','firmware_version'],engineers:['role'],tags:[]})) {
    for (let index = 0; index < 4; index++) {
      const [created] = await connection.execute(`INSERT INTO ${table} (name,${columns.length ? columns.join(',')+',' : ''}enabled,version,created_at,updated_at) VALUES (?${columns.map(()=>',?').join('')},1,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, ['规模夹具-'+table+'-'+index,...columns.map(()=> '')]);
      references[table].push(String(created.insertId));
    }
  }
  for (let index = 0; index < 500; index++) {
    const projectId = ids[index];
    const account = accounts[index%4];
    await connection.execute(`INSERT INTO projects (id,name,data_kind,source_namespace,source_key,status,customer_id,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at)
      VALUES (?,?,'trial',?,?,'ongoing',?,'合成容量夹具','首版规模试用','待验证',?,'初始摘要','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [projectId,'规模项目'+index,namespace,String(index),references.customers[index%4],('合成项目说明\n内容🙂\n').repeat(10)]);
    await connection.execute('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))',[projectId,account.id]);
    for (let stage=1;stage<=7;stage++) await connection.execute('INSERT INTO project_stages (project_id,stage_code,state,note) VALUES (?,?,?,?)',[projectId,'S'+stage,stage===1 ? index%2 ? 'active' : 'completed' : stage===2 && index%2===0 ? 'ready':'locked','阶段说明']);
    await connection.execute('INSERT INTO project_chips (project_id,chip_id,sort_order) VALUES (?,?,0)',[projectId,references.chips[index%4]]);
    await connection.execute("INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,'hardware_owner',0)",[projectId,references.engineers[index%4]]);
    await connection.execute('INSERT INTO project_tags (project_id,tag_id,sort_order) VALUES (?,?,0)',[projectId,references.tags[index%4]]);
    await connection.execute("INSERT INTO project_nodes (project_id,kind,title,output,note,sort_order) VALUES (?,'project','验证节点','输入和输出','合成记录',0)",[projectId]);
    if(changeMode) await connection.execute("INSERT INTO project_changes (project_id,source,content,decision,reason,created_at,source_key,sort_order) VALUES (?,'旧来源待核对','合成旧变更','accept','','2020-01-01','容量旧来源',0)",[projectId]);
    await connection.execute("INSERT INTO project_risks (project_id,content,level,resolved,resolution,created_at,sort_order) VALUES (?,'试用风险','mid',0,'',UTC_TIMESTAMP(3),0)",[projectId]);
  }
  await connection.commit(); owned = true;
  // 每个项目都有通过真实普通保存产生的审计与回执。
  for (let index=0;index<500;index++) await api('/api/projects/'+ids[index],'PATCH',{expectedVersion:'1',idempotencyKey:randomUUID(),changes:{name:'规模测试项目'+index}});
  if (checkMode) {
    for (const table of ['system_configuration','check_rule_revisions']) assert.equal(Number((await connection.query('SELECT COUNT(*) n FROM '+table))[0][0].n),0,'检查规模夹具配置非空，不覆盖');
    await connection.execute("INSERT INTO system_configuration (id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))",[accounts[0].id,accounts[0].id]);ownConfig=true;
    const context=await api('/api/settings/check-rule');const week=businessWeek(businessToday());
    checkRule=(await api('/api/settings/check-rule','POST',{action:'initializeCheckRule',deadlineWeekday:5,expectedVersion:context.configVersion,previewWeek:week,idempotencyKey:randomUUID()})).result.ruleVersion;
    // 明确合成往周历史；本周检查与有效纠错均通过真实 HTTP 深接口保存。
    for(let index=0;index<500;index++){
      for(const offset of [-14,-7])await connection.execute('INSERT INTO project_checks (project_id,actor_id,checked_at,week_start,conclusion,note,rule_version,observed_version,result_version) VALUES (?,?,?,?,?,?,?,1,1)',[ids[index],accounts[index%4].id,addDays(week,offset+2)+' 04:00:00.000',addDays(week,offset),'checked','往周明确合成历史',checkRule]);
      await connection.execute('UPDATE projects SET first_check_week=?,first_check_rule_version=? WHERE id=?',[week,checkRule,ids[index]]);
      const saved=(await api('/api/projects/'+ids[index]+'/actions','POST',{action:'saveCheck',expectedVersion:'2',idempotencyKey:randomUUID(),conclusion:'checked',note:'本周实际核对',ruleVersion:checkRule,previewWeek:week})).result;
      await api('/api/projects/'+ids[index]+'/actions','POST',{action:'correctCheck',expectedVersion:saved.savedVersion,idempotencyKey:randomUUID(),checkId:saved.checkId,conclusion:'follow_up',note:'有效文字更正 '+index,reason:'规模验收明确文字纠错'});
    }
    assert.equal(Number((await connection.query('SELECT COUNT(*) n FROM project_checks ck JOIN projects p ON p.id=ck.project_id WHERE p.source_namespace=?',[namespace]))[0][0].n),1500);
    assert.equal(Number((await connection.query("SELECT COUNT(*) n FROM audit_log a JOIN projects p ON p.id=a.project_id WHERE p.source_namespace=? AND a.action='project.check.correct'",[namespace]))[0][0].n),500);
  }
  if (riskMode) for (let index=0;index<500;index++) {
    const tempId=randomUUID(), path='/api/projects/'+ids[index];
    const added=(await api(path,'PATCH',{expectedVersion:checkMode?'4':'2',idempotencyKey:randomUUID(),changes:{riskOps:[{op:'add',tempId,content:'真实新增容量风险 '+index,level:'mid'}]}})).result;
    riskIds.push(added.riskIdMap[tempId]);
    await api(path,'PATCH',{expectedVersion:added.savedVersion,idempotencyKey:randomUUID(),changes:{riskOps:[{op:'correct',id:riskIds[index],changes:{content:'有效风险更正 '+index},reason:'规模验收明确纠错'}]}});
  }
  if(riskMode) {
    const originalQuery=connection.query;
    connection.query=async function(statement, params) {
      const sql=typeof statement==='string'?statement:statement.sql;
      if(sql.includes('project.risk.add') && sql.includes('MIN(id)')) riskQueryPlan=JSON.parse((await originalQuery.call(this,{sql:'EXPLAIN FORMAT=JSON '+sql,timeout:3000},params))[0][0].EXPLAIN);
      return originalQuery.call(this,statement,params);
    };
    try { await riskRows(connection,ids[0]); } finally { connection.query=originalQuery; }
    const keyed=riskQueryPlan.query_block.nested_loop.find(item=>item.table.table_name==='a').table;assert.equal(keyed.key,'PRIMARY');assert.equal(keyed.access_type,'eq_ref');assert.equal(keyed.rows_examined_per_scan,1);
  }
  if(nodeMode) for(let index=0;index<500;index++) {
    const nodes=Array.from({length:3},(_,n)=>({op:'add',tempId:randomUUID(),kind:'project',fields:{title:'真实容量节点'+n,stage:'S4',output:'明确成果'}}));
    const links=nodes.slice(1).map((node,n)=>({op:'link',from:nodes[n].tempId,to:node.tempId,replaceEdges:[],affectedIds:[],reason:''}));
    const completed=nodes.map(node=>({op:'complete',id:node.tempId,completedOn:'2020-01-01'}));
    const saved=(await api('/api/projects/'+ids[index],'PATCH',{expectedVersion:(await api('/api/projects/'+ids[index])).project.version,idempotencyKey:randomUUID(),changes:{nodeOps:[...nodes,...links,...completed]}})).result;
    nodeIds.push(saved.nodeIdMap[nodes[0].tempId]);assert.equal(saved.nodes.length,4);
    if (recoveryMode) { const target = saved.nodeIdMap[nodes[2].tempId], previous = saved.nodeIdMap[nodes[1].tempId]; deletedIds.push(target); await api('/api/projects/'+ids[index],'PATCH',{expectedVersion:saved.savedVersion,idempotencyKey:randomUUID(),changes:{nodeOps:[{op:'delete',id:target,removeEdges:[{from:previous,to:target}]}]}}); }
  }
  if (recoveryMode) {
    const originalQuery=connection.query;
    connection.query=async function(statement,params) { const sql=typeof statement==='string'?statement:statement.sql; if(sql.includes('n.deleted_at IS NOT NULL')) deletedQueryPlan=JSON.parse((await originalQuery.call(this,{sql:'EXPLAIN FORMAT=JSON '+sql,timeout:3000},params))[0][0].EXPLAIN); return originalQuery.call(this,statement,params); };
    try { await deletedNodes({readSnapshot:work=>work(connection)},ids[0],20); } finally { connection.query=originalQuery; }
    const findNodeScan = value => value && typeof value === 'object' ? value.table_name === 'n' ? value : Object.values(value).map(findNodeScan).find(Boolean) : undefined;
    const scan = findNodeScan(deletedQueryPlan); assert(scan && scan.access_type !== 'ALL' && scan.used_key_parts.includes('project_id'), '500项目已删读取必须使用项目范围索引');
  }
  if(changeMode) {
    for(let index=0;index<500;index++) {
      const path='/api/projects/'+ids[index], tempId=randomUUID();
      const saved=(await api(path,'PATCH',{expectedVersion:(await api(path)).project.version,idempotencyKey:randomUUID(),changes:{changeOps:[{op:'add',tempId,source:index%2?'业务':'客户',content:'真实容量变更'+index,decision:index%2?'reject':'accept',reason:'人工决定理由'}]}})).result;
      changeIds.push(saved.changeIdMap[tempId]);
      await api(path,'PATCH',{expectedVersion:saved.savedVersion,idempotencyKey:randomUUID(),changes:{changeOps:[{op:'correct',id:changeIds[index],changes:{content:'有效变更更正'+index},correctionReason:'规模验收明确纠错'}]}});
    }
    const originalQuery=connection.query;
    connection.query=async function(statement,params) {const sql=typeof statement==='string'?statement:statement.sql;if(sql.includes('project.change.add')&&sql.includes('MIN(id)')) changeQueryPlan=JSON.parse((await originalQuery.call(this,{sql:'EXPLAIN FORMAT=JSON '+sql,timeout:3000},params))[0][0].EXPLAIN);return originalQuery.call(this,statement,params);};
    try {await changeRows(connection,ids[0]);} finally {connection.query=originalQuery;}
    const keyed=changeQueryPlan.query_block.nested_loop.find(item=>item.table.table_name==='a').table;assert.equal(keyed.key,'PRIMARY');assert.equal(keyed.access_type,'eq_ref');assert.equal(keyed.rows_examined_per_scan,1);
    const scans=[];const collect=value=>{if(value&&typeof value==='object'){if(value.table_name==='audit_log')scans.push(value);for(const child of Object.values(value))collect(child);}};collect(changeQueryPlan);assert(scans.length>0&&scans.every(scan=>scan.access_type!=='ALL'&&scan.used_key_parts.includes('entity_id')),'创建人快照必须用目标索引，不能全审计扫描');
  }
  const initial = await api('/api/projects?view=all&search='+encodeURIComponent('规模测试项目'));
  assert.equal(initial.pagination.total,500); assert.equal(initial.stats.total,500); assert.equal(initial.items.length,24);
  const filtered = await api('/api/projects?view=all&customer='+encodeURIComponent('规模夹具-customers-0'));
  assert.equal(filtered.pagination.total,125); assert.equal(filtered.stats.total,125);
  assert.equal(filtered.stageCounts.reduce((n,item)=>n+Number(item.count),0),125);
  const last = await api('/api/projects?view=all&search='+encodeURIComponent('规模测试项目')+'&page=21'); assert.equal(last.items.length,20);
  // 预热一轮；记录包含本地 HTTP 与真实事务的实际延时。
  await api('/api/projects?view=all'); await api('/api/projects/'+ids[0]);
  for (let round=0;round<20;round++) await Promise.all(Array.from({length:4},async(_,worker)=>{
    const target=ids[worker];
    const list=await measured('list','/api/projects?view=all&customer='+encodeURIComponent('规模夹具-customers-'+worker)); assert.equal(list.pagination.total,125);
    const detail=await measured('detail','/api/projects/'+target); assert.equal(detail.stages.length,7); assert.equal(detail.nodes.length,recoveryMode?3:nodeMode?4:1); assert.equal(detail.risks.length,riskMode?2:1);
    if(checkMode){assert.equal(detail.project.checkStatus.latest.note,round===0?'有效文字更正 '+worker:`四人检查${worker}轮次${round-1}`);assert.equal(detail.project.checkStatus.required,true);}
    const result=await measured('save','/api/projects/'+target,'PATCH',{expectedVersion:detail.project.version,idempotencyKey:randomUUID(),changes:{summaryNote:`四人容量验证${worker}轮次${round}`,signal:round%2?'red':'yellow',priority:round%2?'high':'low',chipIds:[references.chips[(worker+round)%4]],people:[{id:references.engineers[worker],role:'hardware_owner'}]}});
    const fresh=await api('/api/projects/'+target); assert.equal(fresh.project.summaryNote,result.result.values.summaryNote); assert.equal(fresh.project.version,result.result.savedVersion); assert.deepEqual(fresh.project.chips.map(chip=>chip.id),result.result.values.chipIds); assert.equal(fresh.project.priority,result.result.values.priority);
    let finalVersion=result.result.savedVersion;
    if(checkMode){
      const savedCheck=await measured('checkSave','/api/projects/'+target+'/actions','POST',{action:'saveCheck',expectedVersion:fresh.project.version,idempotencyKey:randomUUID(),conclusion:'checked',note:`四人检查${worker}轮次${round}`,ruleVersion:checkRule,previewWeek:businessWeek(businessToday())});
      finalVersion=savedCheck.result.savedVersion;
      const checked=await api('/api/projects/'+target);assert.equal(checked.project.version,savedCheck.result.savedVersion);assert.equal(checked.project.checkStatus.latest.id,savedCheck.result.checkId);assert.equal(checked.project.checkStatus.updatedAfterCheck,false);
      const history=await measured('checkHistory','/api/projects/'+target+'/checks');assert.equal(history.items[0].id,savedCheck.result.checkId);assert.equal(history.items[0].note,checked.project.checkStatus.latest.note);
    }
    if(riskMode){
      const body={expectedVersion:finalVersion,idempotencyKey:randomUUID(),changes:{riskOps:[{op:'correct',id:riskIds[worker],changes:{content:`四人风险${worker}轮次${round}`},reason:'规模实际纠错'}]}};
      const preview=await measured('riskPreview','/api/projects/'+target+'/save-preview','POST',body);assert.equal(preview.events.length,1);
      const savedRisk=await measured('riskSave','/api/projects/'+target,'PATCH',body);finalVersion=savedRisk.result.savedVersion;
      const afterRisk=await api('/api/projects/'+target);assert.equal(afterRisk.project.version,finalVersion);assert.equal(afterRisk.risks.find(row=>row.id===riskIds[worker]).content,body.changes.riskOps[0].changes.content);assert.equal(afterRisk.risks.find(row=>row.id===riskIds[worker]).createdByName,'合成容量账号'+worker);
    }
    if(nodeMode){
      const body={expectedVersion:finalVersion,idempotencyKey:randomUUID(),changes:{nodeOps:[{op:'move',id:nodeIds[worker],x:600+round,y:40+worker}]}};
      const preview=await measured('nodePreview','/api/projects/'+target+'/save-preview','POST',body);assert.equal(preview.confirmed,true);
      const saved=await measured('nodeSave','/api/projects/'+target,'PATCH',body);finalVersion=saved.result.savedVersion;
      const after=await api('/api/projects/'+target);assert.equal(after.project.version,finalVersion);assert.equal(after.nodes.find(node=>node.id===nodeIds[worker]).x,600+round);assert.equal(after.nodes.find(node=>node.id===nodeIds[worker]).completedOn,'2020-01-01');
    }
    if (recoveryMode) {
      const page=await measured('deletedRead','/api/projects/'+target+'/deleted-nodes');assert.equal(page.projectVersion,finalVersion);assert.equal(page.items.length,1);assert.equal(page.items[0].id,deletedIds[worker]);assert.equal(page.items[0].deletion.actorName,'合成容量账号'+worker);
      const restore={expectedVersion:finalVersion,idempotencyKey:randomUUID(),changes:{nodeOps:[{op:'restore',id:deletedIds[worker],reason:'实际容量验证恢复'}]}};
      assert.equal((await measured('restorePreview','/api/projects/'+target+'/save-preview','POST',restore)).confirmed,true);
      const saved=(await measured('restoreSave','/api/projects/'+target,'PATCH',restore)).result;finalVersion=saved.savedVersion;
      const restored=await api('/api/projects/'+target);assert.equal(restored.nodes.length,4);assert.equal(restored.nodes.find(n=>n.id===deletedIds[worker]).previousNodeId,null);assert.equal(restored.nodes.find(n=>n.id===deletedIds[worker]).completedOn,'2020-01-01');
      const remove={expectedVersion:finalVersion,idempotencyKey:randomUUID(),changes:{nodeOps:[{op:'delete',id:deletedIds[worker],removeEdges:[]}]}};
      assert.equal((await measured('deletePreview','/api/projects/'+target+'/save-preview','POST',remove)).confirmed,true);
      finalVersion=(await measured('deleteSave','/api/projects/'+target,'PATCH',remove)).result.savedVersion;
      const removed=await api('/api/projects/'+target);assert.equal(removed.project.version,finalVersion);assert.equal(removed.nodes.length,3);assert(!removed.nodes.some(n=>n.id===deletedIds[worker]));
    }
    if(changeMode) {
      const body={expectedVersion:finalVersion,idempotencyKey:randomUUID(),changes:{changeOps:[{op:'correct',id:changeIds[worker],changes:{content:`四人变更${worker}轮次${round}`,decision:round%2?'reject':'accept'},correctionReason:'规模真实纠错'}]}};
      assert.equal((await measured('changePreview','/api/projects/'+target+'/save-preview','POST',body)).changeEvents.length,1);
      const saved=(await measured('changeSave','/api/projects/'+target,'PATCH',body)).result;finalVersion=saved.savedVersion;
      const after=await api('/api/projects/'+target);assert.equal(after.project.version,finalVersion);assert.equal(after.changes.length,2);assert.equal(after.changes.find(row=>row.id===changeIds[worker]).content,body.changes.changeOps[0].changes.content);assert.equal(after.changes.find(row=>row.id===changeIds[worker]).createdByName,'合成容量账号'+worker);assert.equal(after.changes[0].source,'旧来源待核对');assert.equal(after.changes[0].reason,'');
    }
    const audit=await measured('audit' ,'/api/projects/'+target+'/audit'); assert.equal(audit.items[0].versionAfter,finalVersion);
  }));
  // 第 501 个项目可入库和查询，500 是验收规模，不是结构或读取总量上限。
  await connection.execute(`INSERT INTO projects (id,name,data_kind,source_namespace,source_key,status,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at)
    VALUES (?,'规模测试项目500','trial',?,'500','ongoing','','','','','','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[ids[500],namespace]);
  assert.equal((await api('/api/projects?view=all&search='+encodeURIComponent('规模测试项目'))).pagination.total,501);
  const summary=Object.fromEntries(Object.entries(measurements).map(([kind,values])=>{values.sort((a,b)=>a-b);return [kind,{requests:values.length,p50Ms:Math.round(values[Math.ceil(values.length*.5)-1]),p95Ms:Math.round(values[Math.ceil(values.length*.95)-1]),maxMs:Math.round(values.at(-1))}];}));
  await mkdir('test-results',{recursive:true});
  const result={status:'passed',startedAt:began,checkedAt:new Date().toISOString(),projectCount:500,stageCount:3500,initialAuditCount:(checkMode?1500:500)+(riskMode?1000:0)+(nodeMode?1500:0),...(checkMode?{checkCount:1580,initialCorrectionCount:500,weekHistoryCount:1000}:{}),...(riskMode?{riskCount:1000,realRiskAdditions:500,riskCorrections:580,riskQueryPlan}:{}),...(nodeMode?{nodeCount:2000,realNodeAdditions:1500,nodeMoveCount:80}:{}),processMemory:process.memoryUsage(),workers:4,authenticated:true,rounds:20,errorCount:0,measurements:summary,noHardProjectLimit:true,source:'专用测试库/合成数据/四个真实会话 HTTP；本地或云内环回延时，不代表公司公网浏览器延时'};
  if(recoveryMode)Object.assign(result,{initialAuditCount:result.initialAuditCount+1000,initialActiveNodes:1500,deletedNodeCount:500,realInitialDeletes:500,restoreCount:80,deleteCount:580,deletedQueryPlan});
  if(changeMode)Object.assign(result,{initialAuditCount:result.initialAuditCount+1000,changeCount:1000,realChangeAdditions:500,changeCorrections:580,changeQueryPlan});
  await writeFile(changeMode?'test-results/project-changes-capacity-check.json':recoveryMode?'test-results/project-node-recovery-capacity-check.json':nodeMode?'test-results/project-nodes-capacity-check.json':riskMode?'test-results/project-risks-capacity-check.json':checkMode?'test-results/project-checks-capacity-check.json':'test-results/project-capacity-check.json',JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result));
} finally {
  await connection.rollback(); await app?.close();
  if (!app) await runtime?.close();
  if (owned) {
    await connection.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id IN (SELECT id FROM projects WHERE source_namespace=?)',[namespace]);
    for (const table of ['project_changes','audit_log','project_checks','project_risks','project_nodes','project_chips','project_people','project_tags','project_stages','project_responsibilities']) await connection.execute(`DELETE FROM ${table} WHERE project_id IN (SELECT id FROM projects WHERE source_namespace=?)`,[namespace]);
    const scopes=ids.flatMap(id=>['text','ordinary'].map(mode=>'anonymous:project:'+id+':'+mode));
    await connection.execute('DELETE FROM command_receipts WHERE command_scope IN ('+scopes.map(()=>'?').join(',')+')',scopes);
    await connection.execute('DELETE FROM projects WHERE source_namespace=?',[namespace]);
    for (const [table,refs] of Object.entries(references)) for (const reference of refs) await connection.execute(`DELETE FROM ${table} WHERE id=?`,[reference]);
  }
  if(ownConfig){await connection.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?',[accounts[0].id]);await connection.execute('DELETE FROM check_rule_revisions WHERE saved_by=?',[accounts[0].id]);}
  for (const account of accounts) { await connection.execute('DELETE FROM command_receipts WHERE actor_id=?',[account.id]); await connection.execute('DELETE FROM audit_log WHERE actor_id=?',[account.id]); await connection.execute('DELETE FROM sessions WHERE user_id=?',[account.id]); await connection.execute('DELETE FROM users WHERE id=?',[account.id]); }
  await connection.end();
}
