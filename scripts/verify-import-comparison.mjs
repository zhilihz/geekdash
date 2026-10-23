import { executeImport } from './import-execution-test-helper.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1', '只允许独立合成数据库');
const { connection: c } = await connectDatabase('test_migrator');
const serverUuid = (await c.query('SELECT @@server_uuid uuid'))[0][0].uuid;
assert.equal(serverUuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'p05_compare_' + randomUUID().slice(0, 8), password = 'P05 三方比较 合成验证 password 2026';
const checks = [], projects = [];
let app, origin, requests = 0, cookie = '', csrf = '', account = '';
async function fresh(sql, values = []) { const { connection } = await connectDatabase('test_app'); try { return (await connection.query(sql, values))[0]; } finally { await connection.end(); } }
async function api(path, method = 'GET', body, expected = 200, raw = false) {
  if(typeof path==='object')return executeImport(api,path,body,expected);
  const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, 'X-GeekDash-Account': account }, ...body === undefined ? {} : { body: raw ? body : JSON.stringify(body) } }); requests++;
  for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
  const data = await response.json(); assert.ok((Array.isArray(expected)?expected:[expected]).includes(response.status), path + ': ' + JSON.stringify(data));
  if (path === '/api/auth/me') account = data.account.id;
  return data;
}
const file = projects => ({ version: 2, appVersion: '1054', projects });
const path = (data, item, action = 'adopt') => action === 'adopt' ? {batchId:data.batch.id,itemId:item.id} : `/api/imports/${data.batch.id}/items/${item.id}/${action}`;
const command = (data, item, selected = item.defaultSelected, extra = {}) => ({ expectedBatchVersion: data.batch.version, expectedReviewVersion: item.reviewVersion, expectedVersion: item.expectedVersion, basis: item.basis, selected, mode: item.mode, targetId: item.targetId, idempotencyKey: randomUUID(), ...extra });
const leaves = item => item.diffs.flatMap(diff => diff.members ?? [diff]);
const diff = (item, key) => leaves(item).find(value => value.key === key);
async function upload(source, contents) { const read = await api('/api/imports/upload?' + new URLSearchParams({ source, name: prefix + '.bak', operation: randomUUID(), new: '1' }), 'POST', JSON.stringify(contents), 200, true); return api('/api/imports/' + read.result.batchId); }
async function preview(data, item, extra = {}) { return (await api(path(data, item, 'preview'), 'POST', command(data, item, [], extra))).item; }
async function save(id, scope, changes, extra = {}) { const detail = await api('/api/projects/' + id); return api('/api/projects/' + id, 'PATCH', { scope, changes, expectedVersion: detail.project.version, idempotencyKey: randomUUID(), ...extra }); }
try {
  await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix, await hashPassword(password), '三方比较合成账号']);
  app = await createApp(await openRuntimeDatabase('test_app'), { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '0.0.0.0', port: 0 });
  await api('/api/auth/login', 'POST', { loginName: prefix, password }); await api('/api/auth/me');
  const source = (await api('/api/imports/sources', 'POST', { name: prefix, idempotencyKey: randomUUID() })).result.sourceNamespace;
  const original = { id: 101, name: prefix, status: '提案中', summary: '原简介', detailNote: '原详细说明', marketExpectation: '原预期', stages: [{ state: 'ready', done: false, note: '原阶段说明', days: '2' }], risks: [{ id: 201, content: '原风险内容', level: '中', resolved: false, resolveMethod: '' }] };
  let data = await upload(source, file([original])), item = data.items[0];
  assert.equal(item.classification, 'ready'); assert(item.defaultSelected.includes('fields.name'));
  const created = await api(path(data, item), 'POST', command(data, item)), id = created.result.projectId; projects.push(id);
  let detail = await api('/api/projects/' + id); const riskId = detail.risks[0].id;
  assert.equal(detail.project.summary, '原简介');
  checks.push('无对应项目默认新增；明确主操作后新请求和正式责任关系可用');

  await save(id, 'basic', { detailNote: '线上独立详细说明' });
  await save(id, 'stage', { stagePlans: [{ code: 'S1', plannedDays: 5 }] }, { target: 'S1' });
  await save(id, 'risk', { riskOps: [{ op: 'correct', id: riskId, changes: { level: 'high' }, reason: '' }] }, { target: riskId });
  const next = structuredClone(original); next.summary = '文件新简介'; next.stages[0].note = '文件新阶段说明'; next.risks[0].content = '文件新风险内容';
  data = await upload(source, file([next])); item = data.items[0];
  assert.equal(item.classification, 'ready'); assert.equal(diff(item, 'fields.summary').status, 'normal'); assert.equal(diff(item, 'fields.detailNote').status, 'keep_online');
  assert.equal(diff(item, 'stage.S1.note').status, 'normal'); assert.equal(diff(item, 'stage.S1.plannedDays').status, 'keep_online');
  assert.equal(diff(item, 'record.risk:201.content').status, 'normal'); assert.equal(diff(item, 'record.risk:201.level').status, 'keep_online');
  assert(!item.defaultSelected.includes('record.risk:201.level'));
  await api(path(data, item), 'POST', command(data, item)); detail = await api('/api/projects/' + id);
  assert.equal(detail.project.summary, next.summary); assert.equal(detail.project.detailNote, '线上独立详细说明'); assert.equal(detail.stages[0].plannedDays, 5); assert.equal(detail.stages[0].note, next.stages[0].note); assert.equal(detail.risks[0].level, 'high'); assert.equal(detail.risks[0].content, next.risks[0].content);
  assert.equal((await fresh('SELECT detail_note detail FROM projects WHERE id=?', [id]))[0].detail, '线上独立详细说明');
  checks.push('仅源变化默认采用，线上独立变化保留；阶段与风险同对象逐字段安全合并，SQL和新详情一致');

  data = await upload(source, file([next])); item = data.items[0]; assert.equal(item.keptOnline, true); assert.equal(data.counts.pending, 0); assert(!diff(item, 'fields.summary'));
  await save(id, 'basic', { marketExpectation: '线上新预期' });
  const conflicting = structuredClone(next); conflicting.marketExpectation = '文件新预期'; conflicting.signalNote = '原未采用的灯色说明';
  data = await upload(source, file([conflicting])); item = data.items[0]; assert.equal(item.classification, 'needs_attention'); assert.equal(diff(item, 'fields.marketExpectation').status, 'conflict'); assert.equal(diff(item, 'fields.signalNote').status, 'needs_choice');
  assert.deepEqual(diff(item, 'fields.marketExpectation').baseline, { source: '原预期', saved: '原预期' });
  const beforeKeep = await api('/api/projects/' + id), auditCount = (await fresh('SELECT COUNT(*) n FROM audit_log WHERE project_id=?', [id]))[0].n;
  const keeping = command(data, item, [], { keepOnline: item.conflictKeys });
  const kept = await api(path(data, item), 'POST', keeping); assert.equal(kept.result.changed, false); assert.equal(kept.result.savedVersion, beforeKeep.project.version);
  assert.deepEqual((await api(path(data, item, 'results/query'), 'POST', keeping)).result, kept.result);
  assert.deepEqual((await api(path(data, item), 'POST', keeping)).result, kept.result);
  assert.equal((await fresh('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?', [item.id]))[0].n, '1'); assert.equal((await fresh('SELECT COUNT(*) n FROM audit_log WHERE project_id=?', [id]))[0].n, auditCount);
  data = await upload(source, file([conflicting])); assert.equal(data.items[0].keptOnline, true); assert.equal(data.counts.pending, 0);
  checks.push('双方一致跳过、双改不同冲突、无基准需选择；显式全部保留线上不增业务版或审计，原键重放仅一份决定');

  const typo = { id: 202, name: prefix + ' 纠正同次入库', summary: '文件误填', status: '提案中' };
  data = await upload(source, file([typo])); item = await preview(data, data.items[0], { payload: { fields: { summary: '人工纠正后' } } });
  const corrected = await api(path(data, item), 'POST', command(data, item, item.defaultSelected, { payload: { fields: { summary: '人工纠正后' } } })); projects.push(corrected.result.projectId);
  assert.equal((await api('/api/projects/' + corrected.result.projectId)).project.summary, '人工纠正后');
  const frozen = (await fresh("SELECT JSON_EXTRACT(adopted_json,'$.comparisonBase') data FROM import_adoptions WHERE id=?", [corrected.result.adoptionId]))[0].data;
  assert.deepEqual((typeof frozen === 'string' ? JSON.parse(frozen) : frozen)['fields.summary'], { source: '文件误填', saved: '人工纠正后' });
  data = await upload(source, file([typo])); item = data.items[0]; assert.equal(item.keptOnline, true); assert.equal(diff(item, 'fields.summary').status, 'keep_online');
  checks.push('人工修正随一次采用保存，源原值和正式后值分别冻结；同原文件重传不会覆盖修正值或反复要求处理');

  const missing = { id: 203, name: prefix + ' 未采用基准', summary: '此轮不采用', status: '提案中' };
  data = await upload(source, file([missing])); item = data.items[0]; const partial = await api(path(data, item), 'POST', command(data, item, ['fields.name'])); projects.push(partial.result.projectId);
  data = await upload(source, file([missing])); item = data.items[0]; assert.equal(diff(item, 'fields.summary').status, 'needs_choice');
  assert(!Object.hasOwn(diff(item, 'fields.summary'), 'baseline'));
  checks.push('字段未采用不成为基准；缺失与明确空值不混同');

  const partialSource={id:204,name:prefix+' 部分选择',status:'提案中',stages:[{state:'ready',done:false,days:'2'}]};
  data=await upload(source,file([partialSource]));item=data.items[0];const partialId=(await api(path(data,item),'POST',command(data,item))).result.projectId;projects.push(partialId);
  const partlyInvalid=structuredClone(partialSource);partlyInvalid.name=prefix+' 明确只改名称';partlyInvalid.stages[0].days='-1';
  data=await upload(source,file([partlyInvalid]));item=data.items[0];assert.equal(item.classification,'needs_attention');assert(item.issues.some(issue=>issue.code==='INVALID_IMPORT_STAGE'&&issue.defaultSelection));
  await api(path(data,item),'POST',command(data,item,['fields.name']));detail=await api('/api/projects/'+partialId);assert.equal(detail.project.name,partlyInvalid.name);assert.equal(detail.stages[0].plannedDays,2);
  checks.push('整卡正常导入预检错误不阻挡显式只采用无关合法事项，未选非法工期不写入');

  const childSource={id:205,name:prefix+' 子记录对应',status:'提案中',risks:[{id:501,content:'旧对象',level:'中',resolved:false},{id:502,content:'新对象',level:'中',resolved:false}]};
  data=await upload(source,file([childSource]));item=data.items[0];const childProject=(await api(path(data,item),'POST',command(data,item))).result.projectId;projects.push(childProject);
  detail=await api('/api/projects/'+childProject);const newRisk=detail.risks.find(risk=>risk.content==='新对象').id;
  const childChanged={...childSource,risks:[{...childSource.risks[0],content:'本次新内容'}]};
  data=await upload(source,file([childChanged]));item=await preview(data,data.items[0],{payload:{records:[{key:'risk:501',targetId:newRisk,values:{}}]}});
  await api(path(data,item),'POST',command(data,item,['record.risk:501.content'],{payload:{records:[{key:'risk:501',targetId:newRisk,values:{}}]}}));
  childChanged.risks[0].level='高';data=await upload(source,file([childChanged]));item=data.items[0];assert.equal(diff(item,'record.risk:501.level').status,'needs_choice');assert(!diff(item,'record.risk:501.level').baseline);
  assert.equal((await api('/api/projects/'+childProject)).risks.find(risk=>risk.id===newRisk).level,'mid');
  checks.push('同项目子记录改绑后，未采用字段不继承旧目标基准；新目标相同旧值也不能被误判正常覆盖');
  const oldRisk=detail.risks.find(risk=>risk.content==='旧对象').id;
  await save(childProject,'risk',{riskOps:[{op:'correct',id:oldRisk,changes:{level:'low'},reason:''}]},{target:oldRisk});
  data=await upload(source,file([childChanged]));const keptTarget={records:[{key:'risk:501',targetId:oldRisk,values:{}}]};item=await preview(data,data.items[0],{payload:keptTarget});
  const beforeChildKeep=(await api('/api/projects/'+childProject)).project.version;
  const childKeep=await api(path(data,item),'POST',command(data,item,[],{payload:keptTarget,keepOnline:item.conflictKeys}));assert.equal(childKeep.result.savedVersion,beforeChildKeep);
  const childPair=(await fresh("SELECT JSON_EXTRACT(adopted_json,'$.comparisonBase') data FROM import_adoptions WHERE id=?",[childKeep.result.adoptionId]))[0].data;
  assert.deepEqual((typeof childPair==='string'?JSON.parse(childPair):childPair)['record.risk:501.level'],{source:'high',saved:'low'});
  data=await upload(source,file([childChanged]));item=data.items[0];assert.equal(item.payload.records[0].targetId,oldRisk);assert.equal(item.keptOnline,true);
  checks.push('本次改子对应并全部保留线上，同步明确对应但不改业务版，冻结的是本次实际目标值');

  const staleData=await upload(source,file([{...next,name:prefix+' 旧待审选择'}]));const staleItem=staleData.items[0];
  // 构造升级前已有的待审选择，只验证读取兼容。
  const legacyBinding=(await fresh("SELECT CAST(id AS CHAR) id,CAST(version AS CHAR) version,CAST(target_id AS CHAR) targetId FROM import_bindings WHERE source_namespace=? AND object_kind='project' AND source_scope='' AND source_key=?",[source,staleItem.sourceKey]))[0];
  await c.execute('UPDATE import_items SET validation_json=? WHERE id=?',[JSON.stringify({sourceNamespace:source,choice:{mode:'existing',targetId:id},choiceBinding:legacyBinding}),staleItem.id]);
  data = await upload(source, file([{ ...original, name: prefix + ' 明确重绑新项目' }])); item = await preview(data, data.items[0], { mode: 'new', targetId: null });
  const remade = await api(path(data, item), 'POST', command(data, item)); projects.push(remade.result.projectId); assert.notEqual(remade.result.projectId, id);
  const stale=(await api('/api/imports/'+staleData.batch.id)).items[0];assert.equal(stale.classification,'needs_attention');assert.equal(stale.needsMapping,true);assert(stale.issues.some(issue=>issue.code==='IMPORT_BINDING_CHANGED'&&issue.path==='mapping'));
  checks.push('另一批改绑后旧待审对应要求重新选择，不进入一次导入的正常项目');
  data = await upload(source, file([{ ...original, summary: '无可靠重绑基准的新简介' }])); item = await preview(data, data.items[0], { mode: 'existing', targetId: id });
  await api(path(data, item), 'POST', command(data, item, ['binding']));
  data = await api('/api/imports/' + data.batch.id); item = data.items[0]; assert.equal(diff(item, 'fields.summary').status, 'needs_choice');
  assert.equal((await api('/api/projects/' + id)).project.summary, next.summary);
  checks.push('来源明确重绑后旧绑定版本基准失效；改回旧对象也不借用旧版本自动覆盖');

  const ambiguous = { id: 301, name: prefix + ' 原阶段辨认', status: '提案中', stages: [{ done: false, note: '旧阶段' }] };
  data = await upload(source, file([ambiguous])); item = data.items[0]; assert(item.issues.some(issue => issue.code === 'IMPORT_STAGE_STATE_REQUIRED'));
  const statePayload = { stages: [{ code: 'S1', state: 'ready' }] }; item = await preview(data, item, { payload: statePayload });
  const recognised = await api(path(data, item), 'POST', command(data, item, item.defaultSelected, { payload: statePayload })); projects.push(recognised.result.projectId);
  data = await upload(source, file([ambiguous])); item = data.items[0]; assert.equal(item.unchanged, true); assert(!item.issues.some(issue => issue.code === 'IMPORT_STAGE_STATE_REQUIRED'));
  const completed = { id: 302, name: prefix + ' 回退不能猜', status: '进行中', stages: [{ done: true }, { done: false, state: 'ready' }] };
  data = await upload(source, file([completed])); item = data.items[0]; const staged = await api(path(data, item), 'POST', command(data, item)); projects.push(staged.result.projectId);
  completed.stages[0].done = false; data = await upload(source, file([completed])); item = data.items[0]; assert(item.issues.some(issue => issue.code === 'IMPORT_STAGE_STATE_REQUIRED' && issue.path.startsWith('stage.S1'))); assert.equal(item.classification, 'needs_attention');
  checks.push('旧阶段依据未变且已辨认不反复确认；来源已完成变未完成仍要求确认，不当作缺字段略过');

  const timed={id:402,name:prefix+' 行时间',status:'提案中',statusDesc:'状态正文',statusDescEntries:[{text:'状态正文',updatedAt:'2026-10-01 10:00:00'}]};
  data=await upload(source,file([timed]));item=data.items[0];const timedId=(await api(path(data,item),'POST',command(data,item))).result.projectId;projects.push(timedId);
  timed.statusDescEntries[0].updatedAt='2026-10-02 11:00:00';data=await upload(source,file([timed]));item=data.items[0];assert.equal(item.unchanged,true);
  assert.equal((await api('/api/projects/'+timedId)).project.statusEntries[0].date,'2026-10-01 10:00:00');
  assert.equal((await fresh("SELECT COUNT(*) n FROM import_adoptions WHERE target_kind='project' AND target_id=?",[timedId]))[0].n,'1');
  checks.push('相同正文重传不刷新既有逐行时间，不新建采用；仅来源日期不同也不增加待办');

  const catalogFile={...file([]),tags:[{id:601,name:prefix+' 原标签'}]};
  data=await upload(source,catalogFile);item=data.catalogRows.find(value=>value.kind==='tags');item=await preview(data,item,{mode:'new',targetId:null});
  await api(path(data,item),'POST',command(data,item));catalogFile.tags[0].name=prefix+' 文件改标签';data=await upload(source,catalogFile);item=data.catalogRows.find(value=>value.kind==='tags');
  assert.equal(diff(item,'name').status,'needs_choice');assert(!item.defaultSelected.includes('name'));
  checks.push('已有共享资料本体即使单方源变化也不自动覆盖，原行明确选择后才可采用');

  data = await upload(source, file([{ id: 401, name: prefix + ' 日期矛盾', status: '已结案', startDate: '2026-09-03', closedOn: '2026-09-01' }])); item = data.items[0]; assert.equal(item.classification, 'needs_attention'); assert(item.issues.some(issue => issue.code === 'INVALID_PROJECT_DATE'));
  assert.equal((await fresh('SELECT COUNT(*) n FROM projects WHERE name=?', [prefix + ' 日期矛盾']))[0].n, '0');
  checks.push('GET按最终默认候选做只读业务校验；日期矛盾不会误计可导入或写正式库');
  const named={...file([]),chips:[{name:prefix+' 无编号芯片'}]};
  data=await upload(source,named);item=data.catalogRows[0];assert.equal(item.needsMapping,false);
  const namedId=(await api(path(data,item),'POST',command(data,item))).result.id;
  data=await upload(source,named);item=data.catalogRows[0];assert.equal(item.targetId,namedId);assert.equal(item.unchanged,true);assert.equal(item.needsMapping,false);
  const renamed=structuredClone(named);renamed.chips[0].name+=' 改名';data=await upload(source,renamed);assert.equal(data.catalogRows[0].targetId,null,'名称变化不借用原对应');
  const duplicated={...file([]),chips:[...named.chips,...named.chips]};data=await upload(source,duplicated);assert(data.catalogRows.every(row=>row.needsMapping&&!row.targetId));
  const otherSource=(await api('/api/imports/sources','POST',{name:prefix+' 不同来源',idempotencyKey:randomUUID()})).result.sourceNamespace;
  data=await upload(otherSource,named);assert(data.catalogRows[0].needsMapping&&!data.catalogRows[0].targetId);
  assert.equal((await fresh("SELECT COUNT(*) n FROM import_bindings WHERE source_namespace=? AND object_kind='chips' AND source_scope='catalog-name'",[source]))[0].n,'1');
  checks.push('同来源无编号资料重复导入复用明确名称对应；改名不沿用，重名与跨来源同名不自动合并');
  const result = { status: 'passed', verifiedAt: new Date().toISOString(), build: JSON.parse(await readFile('dist/build-info.json', 'utf8')), serverUuid, prefix, source, requests, projects, checks };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/import-comparison.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { if (app) await app.close(); await c.end(); }
