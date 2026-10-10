import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { addDays, businessToday, businessWeek } from '../dist/server/modules/project-dates.js';
import { hashPassword } from '../dist/server/modules/identity.js';

const checkMode = process.argv.includes('--checks');
const namespace = checkMode ? '__capacity_500_checks_test__' : '__capacity_500_test__';
const ids = Array.from({length: 501}, (_, i) => String(9007199254780000n + BigInt(i)));
const {connection} = await connectDatabase('test_migrator');
let app, runtime, origin, owned = false, ownConfig = false, checkRule;
const references = {customers: [], chips: [], engineers: [], tags: []};
const measurements = {list: [], detail: [], save: [], audit: [], ...(checkMode ? {checkSave: [], checkHistory: []} : {})};
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
    const detail=await measured('detail','/api/projects/'+target); assert.equal(detail.stages.length,7); assert.equal(detail.nodes.length,1); assert.equal(detail.risks.length,1);
    if(checkMode){assert.equal(detail.project.checkStatus.latest.note,round===0?'有效文字更正 '+worker:`四人检查${worker}轮次${round-1}`);assert.equal(detail.project.checkStatus.required,true);}
    const result=await measured('save','/api/projects/'+target,'PATCH',{expectedVersion:detail.project.version,idempotencyKey:randomUUID(),changes:{summaryNote:`四人容量验证${worker}轮次${round}`,signal:round%2?'red':'yellow',priority:round%2?'high':'low',chipIds:[references.chips[(worker+round)%4]],people:[{id:references.engineers[worker],role:'hardware_owner'}]}});
    const fresh=await api('/api/projects/'+target); assert.equal(fresh.project.summaryNote,result.result.values.summaryNote); assert.equal(fresh.project.version,result.result.savedVersion); assert.deepEqual(fresh.project.chips.map(chip=>chip.id),result.result.values.chipIds); assert.equal(fresh.project.priority,result.result.values.priority);
    if(checkMode){
      const savedCheck=await measured('checkSave','/api/projects/'+target+'/actions','POST',{action:'saveCheck',expectedVersion:fresh.project.version,idempotencyKey:randomUUID(),conclusion:'checked',note:`四人检查${worker}轮次${round}`,ruleVersion:checkRule,previewWeek:businessWeek(businessToday())});
      const checked=await api('/api/projects/'+target);assert.equal(checked.project.version,savedCheck.result.savedVersion);assert.equal(checked.project.checkStatus.latest.id,savedCheck.result.checkId);assert.equal(checked.project.checkStatus.updatedAfterCheck,false);
      const history=await measured('checkHistory','/api/projects/'+target+'/checks');assert.equal(history.items[0].id,savedCheck.result.checkId);assert.equal(history.items[0].note,checked.project.checkStatus.latest.note);
    }
    const audit=await measured('audit','/api/projects/'+target+'/audit'); assert.equal(audit.items[0].versionAfter,checkMode ? String(BigInt(result.result.savedVersion)+1n) : result.result.savedVersion);
  }));
  // 第 501 个项目可入库和查询，500 是验收规模，不是结构或读取总量上限。
  await connection.execute(`INSERT INTO projects (id,name,data_kind,source_namespace,source_key,status,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at)
    VALUES (?,'规模测试项目500','trial',?,'500','ongoing','','','','','','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,[ids[500],namespace]);
  assert.equal((await api('/api/projects?view=all&search='+encodeURIComponent('规模测试项目'))).pagination.total,501);
  const summary=Object.fromEntries(Object.entries(measurements).map(([kind,values])=>{values.sort((a,b)=>a-b);return [kind,{requests:values.length,p50Ms:Math.round(values[Math.ceil(values.length*.5)-1]),p95Ms:Math.round(values[Math.ceil(values.length*.95)-1]),maxMs:Math.round(values.at(-1))}];}));
  await mkdir('test-results',{recursive:true});
  const result={status:'passed',startedAt:began,checkedAt:new Date().toISOString(),projectCount:500,stageCount:3500,initialAuditCount:checkMode?1500:500,...(checkMode?{checkCount:1580,initialCorrectionCount:500,weekHistoryCount:1000,processMemory:process.memoryUsage()}:{}),workers:4,authenticated:true,rounds:20,errorCount:0,measurements:summary,noHardProjectLimit:true,source:'专用测试库/合成数据/四个真实会话 HTTP；本地或云内环回延时，不代表公司公网浏览器延时'};
  await writeFile(checkMode?'test-results/project-checks-capacity-check.json':'test-results/project-capacity-check.json',JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result));
} finally {
  await connection.rollback(); await app?.close();
  if (!app) await runtime?.close();
  if (owned) {
    for (const table of ['audit_log','project_checks','project_risks','project_nodes','project_chips','project_people','project_tags','project_stages','project_responsibilities']) await connection.execute(`DELETE FROM ${table} WHERE project_id IN (SELECT id FROM projects WHERE source_namespace=?)`,[namespace]);
    const scopes=ids.flatMap(id=>['text','ordinary'].map(mode=>'anonymous:project:'+id+':'+mode));
    await connection.execute('DELETE FROM command_receipts WHERE command_scope IN ('+scopes.map(()=>'?').join(',')+')',scopes);
    await connection.execute('DELETE FROM projects WHERE source_namespace=?',[namespace]);
    for (const [table,refs] of Object.entries(references)) for (const reference of refs) await connection.execute(`DELETE FROM ${table} WHERE id=?`,[reference]);
  }
  if(ownConfig){await connection.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?',[accounts[0].id]);await connection.execute('DELETE FROM check_rule_revisions WHERE saved_by=?',[accounts[0].id]);}
  for (const account of accounts) { await connection.execute('DELETE FROM command_receipts WHERE actor_id=?',[account.id]); await connection.execute('DELETE FROM audit_log WHERE actor_id=?',[account.id]); await connection.execute('DELETE FROM sessions WHERE user_id=?',[account.id]); await connection.execute('DELETE FROM users WHERE id=?',[account.id]); }
  await connection.end();
}
