import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, identities } from '../dist/server/modules/identity.js';
import { projectActions, validateAction } from '../dist/server/modules/project-actions.js';
import { projectReads } from '../dist/server/modules/projects.js';
import { publicSettings } from '../dist/server/modules/public-settings.js';
import { projectChecks } from '../dist/server/modules/project-checks.js';
import { addDays, businessToday, businessWeek } from '../dist/server/modules/project-dates.js';

const { connection: c } = await connectDatabase('test_migrator');
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'check_' + randomUUID().slice(0, 8), password = '检查验收 password 长短语 2026';
const users = [], projects = [], checks = [], measurements = [];
let app, runtime, origin, fault = '', projectWrites = 0, ownConfig = false, lockGate;
const authOrigin = 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app'); const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit, query = lease.query;
    lease.query = async function(statement, params) { const sql = typeof statement === 'string' ? statement : statement.sql; const gate = lockGate; if (gate?.before && sql.startsWith(gate.before)) gate.attempted(); const value = await query.call(this, statement, params); if (gate?.trace && /system_configuration|check_rule_revisions/.test(sql)) gate.trace.push({ sql, rows: value[0] }); if (gate?.after && sql.startsWith(gate.after)) { gate.locked(); await gate.release; } return value; };
    lease.execute = function(sql, params) {
      if (fault === 'middle' && sql.startsWith('UPDATE projects SET') && ++projectWrites === 2 || fault && sql.startsWith(fault)) return execute.call(this, 'INSERT INTO __missing_close_test_table VALUES (1)');
      return execute.call(this, sql, params);
    };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw new Error('lost acknowledgement'); };
    try { return await work(lease); } finally { lease.query = query; lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: authOrigin, secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
}
function client() {
  let cookie = '', csrf = '', account;
  return { get token() { return cookie.split('=')[1]; }, async api(path, method = 'GET', body, status = 200) {
    const began = performance.now();
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
    const data = await response.json();
    if (Array.isArray(status)) { assert(status.includes(response.status), path + ': ' + JSON.stringify(data)); data.httpStatus = response.status; } else assert.equal(response.status, status, path + ': ' + JSON.stringify(data));
    if (path === '/api/auth/me' && status === 200) account = data.account;
    measurements.push({ path, status: response.status, ms: performance.now() - began }); return data;
  }, async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); } };
}
async function create(user) { const result = await user.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix } }); projects.push(result.result.projectId); return result.result.projectId; }
async function fresh(id) {
  const { connection } = await connectDatabase('test_app');
  try { const result = {}; for (const table of ['projects', 'project_stages', 'project_checks', 'schedule_changes', 'project_nodes', 'project_risks', 'audit_log']) result[table] = (await connection.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=? ORDER BY id`, [id]))[0];
    result.receipts = (await connection.query("SELECT * FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%') ORDER BY command_scope,idempotency_key", [id]))[0]; return result;
  } finally { await connection.end(); }
}
const command = (version, action, extra = {}) => ({ action, expectedVersion: version, idempotencyKey: randomUUID(), ...extra });
try {
  assert.equal((await c.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
  for (const table of ['projects','system_configuration','check_rule_revisions']) assert.equal(Number((await c.query('SELECT COUNT(*) n FROM '+table))[0][0].n),0,'夹具非空，先核对，不覆盖');
  const hash=await hashPassword(password);
  for(let i=0;i<3;i++){const loginName=prefix+'_'+i;await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[loginName,hash,'检查合成账号'+i]);users.push({loginName,id:(await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id});}
  await start();const a=client(),b=client(),maint=client();await a.login(0);await b.login(1);await maint.login(2);
  await c.execute("INSERT INTO system_configuration (id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))",[users[2].id,users[2].id]);ownConfig=true;
  const actors=[await identities(runtime).resolve(a.token),await identities(runtime).resolve(b.token),await identities(runtime).resolve(maint.token)];
  const nextRule=Number((await c.query("SELECT AUTO_INCREMENT value FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='check_rule_revisions'"))[0][0].value);
  const digitBoundary=10 ** String(nextRule).length-1;assert(Number.isSafeInteger(digitBoundary));await c.query('ALTER TABLE check_rule_revisions AUTO_INCREMENT='+digitBoundary);
  const today=businessToday(),week=businessWeek(today), at=(day,hour=4)=>new Date(addDays(week,day)+'T'+String(hour).padStart(2,'0')+':00:00.000Z');
  let now=at(3),rule=await publicSettings(runtime,()=>now).read(users[2].id);
  const initialize={action:'initializeCheckRule',deadlineWeekday:5,expectedVersion:rule.configVersion,previewWeek:week,idempotencyKey:randomUUID()};
  await publicSettings(runtime,()=>now).save(actors[2],initialize,randomUUID(),false);rule=await a.api('/api/settings/check-rule');
  const crossing=await publicSettings(runtime,()=>now).save(actors[2],{action:'modifyCheckRule',deadlineWeekday:3,expectedVersion:rule.configVersion,previewWeek:week,idempotencyKey:randomUUID()},randomUUID(),false);
  rule=await a.api('/api/settings/check-rule');assert.equal(crossing.result.ruleVersion,String(digitBoundary+1));assert.equal(rule.rule.version,crossing.result.ruleVersion);assert.equal(rule.rule.deadlineWeekday,3);
  await publicSettings(runtime,()=>now).save(actors[2],{action:'modifyCheckRule',deadlineWeekday:5,expectedVersion:rule.configVersion,previewWeek:week,idempotencyKey:randomUUID()},randomUUID(),false);rule=await a.api('/api/settings/check-rule');
  checks.push('同周规则版本跨数字位数仍按真实保存顺序立即生效，返回字符串ID不改变数值排序');
  const id=await create(a),path='/api/projects/'+id,bodies=[];
  const detail=(id,user=a)=>user.api('/api/projects/'+id);
  const request=async(id,action,extra={})=>({action,expectedVersion:(await detail(id)).project.version,idempotencyKey:randomUUID(),...extra});
  const check=()=>({conclusion:'checked',note:'实际核对备注',ruleVersion:rule.rule.version,previewWeek:businessWeek(businessToday(now))});
  async function perform(id,action,extra={},user=a){
    const body=await request(id,action,extra),before=await fresh(id),p='/api/projects/'+id;
    if(action==='saveCheck')await projectActions(runtime,()=>now).preview(actors[user===a?0:1],id,validateAction(body));
    else await user.api(p+'/actions/preview','POST',body);
    assert.deepEqual(await fresh(id),before,'预览不能写业务');
    const out=action==='saveCheck'?(await projectActions(runtime,()=>now).run(actors[user===a?0:1],id,validateAction(body),randomUUID(),false)).result:(await user.api(p+'/actions','POST',body)).result;
    assert.deepEqual((await user.api(p+'/action-results/query','POST',body)).result,out);
    assert.deepEqual((await user.api(p+'/actions','POST',body)).result,out);
    const after=await fresh(id),d=await detail(id,user);
    assert.equal(d.project.version,out.savedVersion);assert.equal(String(after.projects[0].version),out.savedVersion);
    assert.equal(after.audit_log.length,before.audit_log.length+(out.changed?1:0));
    assert.deepEqual(after.project_stages,before.project_stages);assert.deepEqual(after.schedule_changes,before.schedule_changes);
    for(const field of ['status','first_check_week','first_check_rule_version','maintenance_enabled','signal','priority','current_due_date'])assert.deepEqual(after.projects[0][field],before.projects[0][field]);
    if(action==='correctCheck')assert.deepEqual(after.project_checks,before.project_checks,'原检查行保持');
    bodies.push({id,body,out,user});return {body,out};
  }
  async function bad(id,extra,status=400,user=a){const before=await fresh(id);await user.api('/api/projects/'+id+'/actions','POST',await request(id,'saveCheck',{...check(),...extra}),status);assert.deepEqual(await fresh(id),before);}
  await bad(id,{actorId:users[1].id});await bad(id,{checkedAt:now.toISOString()});await bad(id,{conclusion:'passed'});await bad(id,{note:null});await bad(id,{previewWeek:addDays(week,-7)},409);await bad(id,{ruleVersion:'18446744073709551614'},409);await bad(id,{},403,b);
  await b.api(path+'/responsibility','POST',{action:'join',expectedVersion:(await detail(id)).project.version,idempotencyKey:randomUUID()});
  const first=await perform(id,'saveCheck',check());let d=await detail(id),original=(await fresh(id)).project_checks[0];
  assert.equal(d.project.status,'proposal');assert.equal(d.project.firstCheckWeek,null);assert.equal(d.project.checkStatus.required,false);assert.equal(d.project.checkStatus.onTime,true);assert.equal(d.project.checkStatus.updatedAfterCheck,false);assert.equal(d.project.checkStatus.latest.id,first.out.checkId);
  assert.equal(String(original.observed_version),first.body.expectedVersion);assert.equal(String(original.result_version),first.out.savedVersion);assert.equal(String(original.actor_id),users[0].id);assert.equal(new Date(original.checked_at).getTime(),now.getTime());
  let v=d.project.version;
  for(const [action,actualDate] of [['startStage','2020-01-01'],['completeStage','2020-01-02']])v=(await a.api(path+'/actions','POST',{action,stageCode:'S1',actualDate,expectedVersion:v,idempotencyKey:randomUUID()})).result.savedVersion;
  const context=await publicSettings(runtime,()=>now).read(users[0].id);
  await projectActions(runtime,()=>now).run(actors[0],id,validateAction({action:'startProject',actualDate:'2020-01-03',dueDate:addDays(today,20),expectedVersion:v,idempotencyKey:randomUUID(),configVersion:context.configVersion,ruleVersion:context.rule.version,previewWeek:context.weekStart,previewFirstCheckWeek:context.firstCheckWeek}),randomUUID(),false);
  d=await detail(id);assert.equal(d.project.firstCheckWeek,week);assert.equal(d.project.checkStatus.required,true);assert.equal(d.project.checkStatus.updatedAfterCheck,true);
  now=at(5);const late=await perform(id,'saveCheck',{...check(),conclusion:'follow_up',note:'另一负责人周六追加核对'},b);d=await detail(id);
  assert.equal(d.project.checkStatus.onTime,true);assert.equal(d.project.checkStatus.updatedAfterCheck,false);assert.equal(d.project.checkStatus.latest.id,late.out.checkId);
  const page=await a.api(path+'/checks');assert.equal(page.items.length,2);assert.equal(page.items[0].onTime,false);assert.equal(page.items[1].onTime,true);
  await perform(id,'saveCheck',{...check(),note:'同毫秒再次检查'});assert.equal((await detail(id)).project.checkStatus.onTime,true);
  let before=await fresh(id);await a.api(path,'PATCH',{scope:'summaryNote',changes:{summaryNote:'检查后正式更新'},expectedVersion:(await detail(id)).project.version,idempotencyKey:randomUUID()});assert.equal((await detail(id)).project.checkStatus.updatedAfterCheck,true);assert.deepEqual((await fresh(id)).project_checks,before.project_checks);
  checks.push('明确检查及多人首查/晚查/同毫秒追加：真实人时周规则与前后版本、原回执、新SQL/HTTP/看板；普通更新不造检查');
  const last=(await detail(id)).project.checkStatus.latest.id;
  const corrected=await perform(id,'correctCheck',{checkId:last,conclusion:'follow_up',note:'纠正后的跟进文字',reason:'原备注有误'},b);
  d=await detail(id);assert.equal(d.project.checkStatus.latest.note,'纠正后的跟进文字');assert.equal(d.project.checkStatus.updatedAfterCheck,true);
  await perform(id,'correctCheck',{checkId:last,conclusion:'checked',note:'',reason:'再次核对并明确清空'});
  const noop=await perform(id,'correctCheck',{checkId:last,conclusion:'checked',note:'',reason:'内容一致'});assert.equal(noop.out.changed,false);
  let history=await a.api(path+'/checks');assert.equal(history.items[0].original.note,'同毫秒再次检查');assert.equal(history.items[0].note,'');assert.equal(history.items[0].correction.reason,'再次核对并明确清空');
  await c.execute('UPDATE users SET display_name=? WHERE id=?',['后改名',users[0].id]);history=await a.api(path+'/checks');assert.equal(history.items[0].actorName,'检查合成账号0');
  const other=await create(a);
  const cross=await request(other,'correctCheck',{checkId:last,conclusion:'checked',note:'跨项目',reason:'不允许'});before=await fresh(other);await a.api('/api/projects/'+other+'/actions','POST',cross,404);assert.deepEqual(await fresh(other),before);
  await bad(id,{action:'correctCheck',checkId:last,reason:'',ruleVersion:undefined,previewWeek:undefined},422);
  checks.push('当前负责人纠正结论/备注、连续更正/清空/无变化与原人名快照，原检查行保持；跨项目/伪造事实/非法结论拒绝');
  const settingsSnapshot=async()=>({config:(await c.query('SELECT * FROM system_configuration'))[0],rules:(await c.query('SELECT * FROM check_rule_revisions ORDER BY version'))[0],audit:(await c.query("SELECT * FROM audit_log WHERE entity_type='system_configuration' ORDER BY id"))[0],receipts:(await c.query("SELECT * FROM command_receipts WHERE command_scope LIKE '%:settings:check-rule' ORDER BY command_scope,idempotency_key"))[0]});
  async function change(weekday){const ctx=await publicSettings(runtime,()=>now).read(users[2].id),body={action:'modifyCheckRule',deadlineWeekday:weekday,expectedVersion:ctx.configVersion,previewWeek:ctx.weekStart,idempotencyKey:randomUUID()};const out=await publicSettings(runtime,()=>now).save(actors[2],body,randomUUID(),false);assert.deepEqual((await maint.api('/api/settings/check-rule/results/query','POST',body)).result,out.result);return {body,out};}
  const countsBefore=(await fresh(id)).projects[0];const earlier=await change(3);rule=await a.api('/api/settings/check-rule');d=await detail(id);
  assert.equal(d.project.checkStatus.onTime,false);assert.equal((await fresh(id)).projects[0].version,countsBefore.version);assert.equal(d.project.firstCheckWeek,week);
  before=await settingsSnapshot();const same=await change(3);assert.equal(same.out.result.changed,false);const afterSame=await settingsSnapshot();assert.equal(afterSame.receipts.length,before.receipts.length+1);delete before.receipts;delete afterSame.receipts;assert.deepEqual(afterSame,before);
  await change(7);rule=await a.api('/api/settings/check-rule');assert.equal((await detail(id)).project.checkStatus.onTime,true);
  const oldForm=await request(id,'saveCheck',check());await change(3);rule=await a.api('/api/settings/check-rule');before=await fresh(id);await a.api(path+'/actions','POST',oldForm,409);assert.deepEqual(await fresh(id),before);
  await a.api('/api/settings/check-rule','POST',{...earlier.body,expectedVersion:(await a.api('/api/settings/check-rule')).configVersion,idempotencyKey:randomUUID()},403);
  const pastRule=rule.rule.version;now=at(7);await change(5);const historical=await projectChecks(runtime,()=>now).read(id,20);
  assert.equal(historical.items[0].effectiveRuleVersion,pastRule);assert.equal(historical.items.find(x=>x.id===first.out.checkId).onTime,false);assert.equal(historical.items.find(x=>x.id===first.out.checkId).originalOnTime,true);
  const nextDetail=await projectReads(runtime,()=>now).detail(id,users[0].id);assert.equal(nextDetail.project.checkStatus.kind,'pending');assert.equal(nextDetail.project.checkStatus.latest,null);assert.equal(nextDetail.project.firstCheckWeek,week);
  await assert.rejects(()=>projectActions(runtime,()=>now).run(actors[0],id,validateAction(oldForm),randomUUID(),false),e=>e.code==='CHECK_PREVIEW_CHANGED');
  checks.push('共同截止提前/延后/同值、本周立即重算但不涨项目版本/重建义务；原规则可追溯、历史周冻结、跨周旧表单拒绝与原回执保持');
  now=at(5);rule=await a.api('/api/settings/check-rule');
  const paused=await a.api(path+'/actions','POST',await request(id,'pauseProject',{reason:'核对暂停'}));before=await fresh(id);await perform(id,'saveCheck',check());assert.equal((await detail(id)).project.status,'paused');assert.equal((await detail(id)).project.checkStatus.required,false);
  await a.api(path+'/actions','POST',await request(id,'closeProject',{closureType:'terminated',closedOn:today,closureNote:'人工终止核对',remainingWorkNote:'遗留阶段保留'}));await perform(id,'saveCheck',check());
  await a.api(path+'/actions','POST',await request(id,'setMaintenance',{enabled:true,reason:'开启维护核对'}));await perform(id,'saveCheck',check());d=await detail(id);assert.equal(d.project.status,'closed');assert.equal(d.project.maintenanceEnabled,1);assert.equal(Number(d.project.progress),5);assert.equal(d.project.checkStatus.required,false);
  const board=await a.api('/api/projects?view=all&search='+prefix);assert.equal(board.stats.checkRequired,board.stats.checkPending+board.stats.checkOverdue+board.stats.checkDone);
  checks.push('提案/暂缓/终止闭案/维护主动检查不改状态、进度、维护或首次义务；默认统计仍仅进行中应检范围');
  const raceId=await create(a),racePath='/api/projects/'+raceId;await b.api(racePath+'/responsibility','POST',{action:'join',expectedVersion:(await detail(raceId)).project.version,idempotencyKey:randomUUID()});
  const cmd=await request(raceId,'saveCheck',check()),two={...cmd,idempotencyKey:randomUUID(),note:'另一人的核对'};
  const race=await Promise.all([a.api(racePath+'/actions','POST',cmd,[200,409]),b.api(racePath+'/actions','POST',two,[200,409])]);assert.deepEqual(race.map(x=>x.httpStatus).sort(),[200,409]);assert.equal((await fresh(raceId)).project_checks.length,1);
  const stale=await request(raceId,'correctCheck',{checkId:(await detail(raceId)).project.checkStatus.latest.id,conclusion:'checked',note:'旧文字',reason:'预览竞争'});await a.api(racePath+'/actions/preview','POST',stale);await b.api(racePath,'PATCH',{scope:'summaryNote',changes:{summaryNote:'他人先保存'},expectedVersion:stale.expectedVersion,idempotencyKey:randomUUID()});before=await fresh(raceId);await a.api(racePath+'/actions','POST',stale,409);assert.deepEqual(await fresh(raceId),before);
  for(const point of ['INSERT INTO project_checks','UPDATE projects SET version','INSERT INTO audit_log','INSERT INTO command_receipts']){const body=await request(raceId,'saveCheck',check());before=await fresh(raceId);fault=point;await a.api(racePath+'/actions','POST',body,503);fault='';assert.deepEqual(await fresh(raceId),before);}
  const correction=await request(raceId,'correctCheck',{checkId:(await detail(raceId)).project.checkStatus.latest.id,conclusion:'follow_up',note:'不得部分更正',reason:'故障验证'});
  for(const point of ['UPDATE projects SET version','INSERT INTO audit_log','INSERT INTO command_receipts']){before=await fresh(raceId);fault=point;await a.api(racePath+'/actions','POST',correction,503);fault='';assert.deepEqual(await fresh(raceId),before);}
  for(const point of ['INSERT INTO check_rule_revisions','UPDATE system_configuration','INSERT INTO audit_log','INSERT INTO command_receipts']){before=await settingsSnapshot();fault=point;await assert.rejects(()=>change(7));fault='';assert.deepEqual(await settingsSnapshot(),before);}
  const lost=await request(raceId,'saveCheck',check());fault='ack';const unknown=await a.api(racePath+'/actions','POST',lost,503);assert.equal(unknown.outcome,'unknown');fault='';assert.equal((await fresh(raceId)).project_checks.length,2);
  await app.close();app=undefined;await start();await a.api('/api/auth/me');await b.api('/api/auth/me');await maint.api('/api/auth/me');
  const restored=await a.api(racePath+'/action-results/query','POST',lost);assert.equal(restored.outcome,'committed');assert.deepEqual((await a.api(racePath+'/actions','POST',lost)).result,restored.result);assert.equal((await fresh(raceId)).project_checks.length,2);
  for(const {id,body,out,user} of bodies)assert.deepEqual((await user.api('/api/projects/'+id+'/action-results/query','POST',body)).result,out);
  assert.equal((await b.api(racePath+'/action-results/query','POST',lost)).outcome,'not_found');
  checks.push('真实同版本竞争/预览后他人保存；检查/纠错/规则各SQL写点全回滚，COMMIT丢确认后真实应用重建与会话/原回执保持');
  now=at(5);await change(5);rule=await a.api('/api/settings/check-rule');
  const actor=await identities(runtime).resolve(a.token),orderId=await create(a);let orderNow=at(5);
  const orderSave=async(note)=>projectActions(runtime,()=>orderNow).run(actor,orderId,validateAction(await request(orderId,'saveCheck',{...check(),note})),randomUUID(),false);
  const orderFirst=await orderSave('第一次真实保存晚于截止');orderNow=at(3);const orderLast=await orderSave('模拟时钟回拨后保存');
  const ordered=await projectReads(runtime,()=>at(5)).detail(orderId,users[0].id);assert.equal(ordered.project.checkStatus.onTime,false);assert.equal(ordered.project.checkStatus.latest.id,orderLast.result.checkId);assert.notEqual(orderFirst.result.checkId,orderLast.result.checkId);
  now=at(5);await change(5);rule=await a.api('/api/settings/check-rule');
  const fridayEnd=new Date(addDays(week,5)+'T00:00:00+08:00');
  let boundaryNow=new Date(fridayEnd.getTime()-1),boundaryId=await create(a);
  const boundarySave=async()=>projectActions(runtime,()=>boundaryNow).run(actor,boundaryId,validateAction(await request(boundaryId,'saveCheck',{...check()})),randomUUID(),false);
  await boundarySave();boundaryNow=fridayEnd;await boundarySave();
  // 截止按上海日界，原检查时点不能因追加记录而改变。
  now=at(5);await change(5);rule=await a.api('/api/settings/check-rule');const boundaryPage=await a.api('/api/projects/'+boundaryId+'/checks'),boundaryRaw=(await fresh(boundaryId)).project_checks;
  assert.equal(new Date(boundaryRaw[0].checked_at).getTime(),fridayEnd.getTime()-1,JSON.stringify(boundaryRaw));assert.equal(new Date(boundaryRaw[1].checked_at).getTime(),fridayEnd.getTime(),JSON.stringify(boundaryRaw));
  const boundaryEvidence={expectedBoundary:fridayEnd.toISOString(),rawChecks:boundaryRaw.map(row=>({id:String(row.id),checkedAt:new Date(row.checked_at).toISOString(),ruleVersion:String(row.rule_version)})),page:boundaryPage};
  assert.equal(Number(boundaryPage.rule.rule.deadlineWeekday),5,JSON.stringify(boundaryEvidence));assert.equal(boundaryPage.items[1].onTime,true,JSON.stringify(boundaryEvidence));assert.equal(boundaryPage.items[0].onTime,false,JSON.stringify(boundaryEvidence));
  for(let repeat=0;repeat<10;repeat++){const copies=await Promise.all(Array.from({length:4},()=>a.api('/api/projects/'+boundaryId+'/checks')));for(const copy of copies)assert.deepEqual(copy,boundaryPage,JSON.stringify({repeat,boundaryEvidence,copy}));}
  for(let i=0;i<22;i++){boundaryNow=new Date(fridayEnd.getTime()+i+1);await boundarySave();}
  const firstPage=await a.api('/api/projects/'+boundaryId+'/checks');assert.equal(firstPage.items.length,20);assert(firstPage.nextCursor);const secondPage=await a.api('/api/projects/'+boundaryId+'/checks?before='+firstPage.nextCursor);assert.equal(secondPage.items.length,4);assert.equal(secondPage.nextCursor,null);assert.equal(new Set([...firstPage.items,...secondPage.items].map(x=>x.id)).size,24);
  await a.api('/api/projects/'+boundaryId+'/checks?pageSize=101','GET',undefined,400);await a.api('/api/projects/'+boundaryId+'/checks?before=01','GET',undefined,400);await a.api('/api/projects/18446744073709551614/checks','GET',undefined,404);
  checks.push('ID稳定首尾、受控时钟回拨不改首次判定、截止排他毫秒边界、检查独立20/100分页及非法游标拒绝');
  // 使用真实配置行锁协调两个深模块，不用延时猜测竞争结果。
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
  now=at(5);rule=await a.api('/api/settings/check-rule');
  const lockBody=await request(raceId,'saveCheck',check()),locked=deferred(),attempted=deferred(),release=deferred();
  const lockTrace=[];
  lockGate={after:'SELECT CAST(version AS CHAR) version,CAST(maintenance_user_id',before:'SELECT id FROM system_configuration',locked:locked.resolve,attempted:attempted.resolve,release:release.promise,trace:lockTrace};
  const changing=change(3);await locked.promise;
  before=await fresh(raceId);const checking=projectActions(runtime,()=>now).run(await identities(runtime).resolve(a.token),raceId,validateAction(lockBody),randomUUID(),false).then(value=>({value}),error=>({error}));
  await attempted.promise;release.resolve();await changing;const rejected=await checking;lockGate=undefined;
  const lockEvidence={expected:'CHECK_PREVIEW_CHANGED',body:lockBody,sql:lockTrace,result:rejected.value,error:rejected.error?.code,rules:(await c.query("SELECT CAST(version AS CHAR) version,deadline_weekday deadlineWeekday,DATE_FORMAT(effective_week,'%Y-%m-%d') effectiveWeek FROM check_rule_revisions ORDER BY version"))[0]};
  await mkdir('test-results',{recursive:true});await writeFile('test-results/check-rule-lock-check.json',JSON.stringify(lockEvidence,null,2));
  assert.equal(rejected.error?.code,'CHECK_PREVIEW_CHANGED',JSON.stringify(lockEvidence));assert.deepEqual(await fresh(raceId),before);
  await change(5);rule=await a.api('/api/settings/check-rule');
  const lockClockBody=await request(raceId,'saveCheck',check()),waiting=deferred();
  await c.beginTransaction();await c.query('SELECT id FROM system_configuration WHERE id=1 FOR UPDATE');
  let writeNow=new Date(fridayEnd.getTime()-1);lockGate={before:'SELECT id FROM system_configuration',attempted:waiting.resolve};
  const afterLock=projectActions(runtime,()=>writeNow).run(await identities(runtime).resolve(a.token),raceId,validateAction(lockClockBody),randomUUID(),false).then(value=>({value}),error=>({error}));
  await waiting.promise;writeNow=fridayEnd;await c.commit();const clockOut=await afterLock;lockGate=undefined;assert(!clockOut.error,clockOut.error?.code);
  const clockRows=(await fresh(raceId)).project_checks;assert.equal(new Date(clockRows.at(-1).checked_at).getTime(),fridayEnd.getTime());assert.equal((await a.api(racePath+'/checks')).items[0].onTime,false);
  const disabled=await request(raceId,'saveCheck',check());await c.execute('UPDATE users SET enabled=0 WHERE id=?',[users[0].id]);before=await fresh(raceId);
  await assert.rejects(()=>projectActions(runtime).run(actors[0],raceId,validateAction(disabled),randomUUID(),false),error=>error.code==='AUTH_REQUIRED');assert.deepEqual(await fresh(raceId),before);await c.execute('UPDATE users SET enabled=1 WHERE id=?',[users[0].id]);
  checks.push('真实规则修改/检查共享锁竞争：旧规则不写入；锁等待越过上海截止日后采用取锁后的时钟；事务重验停用身份');
  const correctionLost=await request(raceId,'correctCheck',{checkId:clockOut.value.result.checkId,conclusion:'follow_up',note:'已提交的文字纠错',reason:'丢确认恢复核对'});
  fault='ack';await a.api(racePath+'/actions','POST',correctionLost,503);fault='';
  const settingCtx=await publicSettings(runtime,()=>now).read(users[2].id),settingLost={action:'modifyCheckRule',deadlineWeekday:7,expectedVersion:settingCtx.configVersion,previewWeek:settingCtx.weekStart,idempotencyKey:randomUUID()};
  fault='ack';await assert.rejects(()=>publicSettings(runtime,()=>now).save(actors[2],settingLost,randomUUID(),false));fault='';
  const beforeRebuild=await fresh(raceId),settingsRebuild=await settingsSnapshot();await app.close();app=undefined;await start();
  const correctionReceipt=await a.api(racePath+'/action-results/query','POST',correctionLost);assert.equal(correctionReceipt.outcome,'committed');assert.deepEqual((await a.api(racePath+'/actions','POST',correctionLost)).result,correctionReceipt.result);
  const settingReceipt=await maint.api('/api/settings/check-rule/results/query','POST',settingLost);assert.equal(settingReceipt.outcome,'committed');assert.deepEqual((await maint.api('/api/settings/check-rule','POST',settingLost)).result,settingReceipt.result);
  assert.deepEqual(await fresh(raceId),beforeRebuild);assert.deepEqual(await settingsSnapshot(),settingsRebuild);assert.equal((await a.api(racePath+'/checks')).items[0].note,'已提交的文字纠错');
  checks.push('纠错/共同规则真实COMMIT后丢确认：应用重建原会话、原结果与有效备注保持，重投不增加规则、检查或历史');
  now=new Date('2027-01-03T23:59:59.999+08:00');await change(7);const sundayContext=await publicSettings(runtime,()=>now).read(users[0].id),yearId=await create(a);
  const sundayBody=await request(yearId,'saveCheck',{conclusion:'checked',note:'跨月年周日截止最后毫秒',ruleVersion:sundayContext.rule.version,previewWeek:sundayContext.weekStart});
  const sundayResult=await projectActions(runtime,()=>now).run(await identities(runtime).resolve(a.token),yearId,validateAction(sundayBody),randomUUID(),false);
  assert.equal(sundayContext.weekStart,'2026-12-28');now=new Date('2027-01-04T00:00:00+08:00');before=await fresh(yearId);const awaitActor=await identities(runtime).resolve(a.token);
  await assert.rejects(()=>projectActions(runtime,()=>now).run(awaitActor,yearId,validateAction({...sundayBody,idempotencyKey:randomUUID(),expectedVersion:sundayResult.result.savedVersion}),randomUUID(),false),error=>error.code==='CHECK_PREVIEW_CHANGED');assert.deepEqual(await fresh(yearId),before);
  const frozenSunday=await projectChecks(runtime,()=>now).read(yearId,20);assert.equal(frozenSunday.items[0].weekStart,'2026-12-28');assert.equal(frozenSunday.items[0].onTime,true);assert.equal(frozenSunday.rule.weekStart,'2027-01-04');
  assert.deepEqual((await a.api('/api/projects/'+yearId+'/actions','POST',sundayBody)).result,sundayResult.result);
  checks.push('真实检查保存跨月年周日最后毫秒、新周00:00拒绝旧周新编号；往周冻结与原编号跨年恢复不重复');
  const build=(await a.api('/api/health/live')).build;await mkdir('test-results',{recursive:true});await writeFile('test-results/project-checks-check.json',JSON.stringify({status:'passed',checkedAt:new Date().toISOString(),checks,requestCount:measurements.length,measurements,build,isolatedTestDatabase:true,boundaryEvidence},null,2)+'\n');console.log(JSON.stringify({status:'passed',groups:checks.length,requestCount:measurements.length}));
} finally {
  if (app) await app.close();
  for (const id of projects) { for (const table of ['project_nodes', 'project_risks', 'project_checks', 'schedule_changes', 'audit_log', 'project_stages', 'project_responsibilities']) await c.execute('DELETE FROM ' + table + ' WHERE project_id=?', [id]); await c.execute("DELETE FROM command_receipts WHERE command_scope LIKE CONCAT('user:%:project:',?,':%')", [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  if (ownConfig) { await c.execute('DELETE FROM system_configuration WHERE id=1 AND maintenance_user_id=?', [users[2].id]); await c.execute('DELETE FROM check_rule_revisions WHERE saved_by=?', [users[2].id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
