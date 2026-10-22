import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1', '只在独立合成验收实例执行');
const { connection: c } = await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'p05_domain_' + randomUUID().slice(0, 8), password = 'P05 domain 合成验证 长短语 password 2026';
const checks = [], users = [], projects = [];
let app, origin, requests = 0, fault = false;
const ownId = async () => (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
async function fresh(sql, values = []) { const { connection } = await connectDatabase('test_app'); try { return (await connection.query(sql, values))[0]; } finally { await connection.end(); } }
function client() {
  let cookie = '', csrf = '', account = '';
  return {
    async api(path, method = 'GET', body, expected = 200, raw = false) {
      const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, 'X-GeekDash-Account': account }, ...body === undefined ? {} : { body: raw ? body : JSON.stringify(body) } }); requests++;
      for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
      const data = await response.json(); assert.equal(response.status, expected, path + ': ' + JSON.stringify(data));
      if (path === '/api/auth/me' && expected === 200) account = data.account.id;
      return data;
    },
    async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password }); await this.api('/api/auth/me'); },
    async upload(source, file, anew = false) { const result = await this.api('/api/imports/upload?' + new URLSearchParams({ source, name: prefix + '.bak', operation: randomUUID(), ...anew ? { new: '1' } : {} }), 'POST', JSON.stringify(file), 200, true); return this.api('/api/imports/' + result.result.batchId); },
  };
}
const path = (data, item, action = 'adopt') => `/api/imports/${data.batch.id}/items/${item.id}/${action}`;
const command = (data, item, selected = item.diffs.map(row => row.key), more = {}) => ({ expectedBatchVersion: data.batch.version, expectedReviewVersion: item.reviewVersion, expectedVersion: item.expectedVersion, basis: item.basis, mode: item.mode, targetId: item.targetId, selected, idempotencyKey: randomUUID(), ...more });
const projectItem = data => data.items.find(item => item.kind === 'project');
const recordKey = (item, sourceId) => 'record.' + item.payload.records.find(record => record.sourceKey === String(sourceId)).key;
try {
  const hash = await hashPassword(password);
  for (let index = 0; index < 2; index++) { const loginName = prefix + '_' + index; await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, 'P05领域合成账号' + index]); users.push({ id: await ownId(), loginName }); }
  const runtime = await openRuntimeDatabase('test_app'), transaction = runtime.writeTransaction;
  runtime.writeTransaction = work => transaction(async lease => { const query = lease.query; lease.query = async function (sql, args) { const result = await query.call(this, sql, args); if (fault && /^UPDATE projects SET/.test(String(sql))) throw Object.assign(new Error('injected after project update'), { code: 'PROBE_AFTER_PROJECT_WRITE' }); return result; }; try { return await work(lease); } finally { lease.query = query; } });
  app = await createApp(runtime, { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '0.0.0.0', port: 0 });
  const a = client(), b = client(); await a.login(0); await b.login(1);
  const source = (await a.api('/api/imports/sources', 'POST', { name: prefix, idempotencyKey: randomUUID() })).result.sourceNamespace;
  const dates = ['2026-09-01 09:00:00', '2026-09-01 10:00:00', '2026-09-02 09:00:00'];
  const file = { version: 2, appVersion: '1054', projects: [{ id: 101, name: prefix + ' 业务项目', status: '进行中', signal: '绿', priority: '中', summary: '卡片简介', statusDesc: '重复行\n重复行\n第三行', detailNote: '保留详细资料', filingDate: '2026-09-01', startDate: '2026-09-02', dueDate: '2026-11-20',
    stages: Array.from({ length: 7 }, (_, index) => ({ done: index === 0, ...index === 1 ? { state: 'active' } : {}, days: index < 2 ? '2' : '', note: index === 1 ? '当前阶段评述' : '', startDate: index < 2 ? '2026-09-0' + (index + 1) : '', doneDate: index === 0 ? '2026-09-01' : '', expectedEndDate: '' })),
    nodes: [{ id: 201, name: '前置节点', stageId: 2, stage: '项目预启动', targetDate: '2026-10-26', output: '', doneDate: '', prevId: null, nextId: 202, x: 0, y: 40 }, { id: 202, name: '后续节点', stageId: 2, stage: '项目预启动', targetDate: '2026-10-29', output: '', doneDate: '', prevId: 201, nextId: null, x: 240, y: 40 }],
    customerNodes: [{ id: 203, name: '客户交付', targetDate: '2026-11-20', doneDate: '', note: '客户原备注' }],
    risks: [{ id: 301, content: '来源风险', level: '中', resolved: false, resolveMethod: '', createdAt: '2026-09-05 09:00:00', resolvedAt: '' }],
    changes: [{ id: 401, content: '来源需求', source: '客户', status: '接受', reason: '原决定理由', createdAt: '2026-09-06 10:00:00' }],
    delays: [{ id: 501, reason: '来源改期', newTargetDate: '2026-11-20', measures: '原应对措施', createdAt: '2026-09-07 10:00:00' }],
    statusDescEntries: ['重复行', '重复行', '第三行'].map((text, index) => ({ text, updatedAt: dates[index] })), statusDescHistory: [{ date: '', text: '' }, { date: '旧时间', text: '原说明' }], statusHistory: [{ date: '旧时间', text: '重复原文' }, { date: '旧时间', text: '重复原文' }], lastCheckAt: 1700000000000,
  }], preferences: { hw_project_board_summary_notes: JSON.stringify({ 101: '简要备注' }), hw_project_board_chipstat_notes: JSON.stringify({ 101: '芯片专属备注' }) } };
  let data = await a.upload(source, file), item = projectItem(data); assert.equal(item.issues.length, 0, JSON.stringify(item.issues));
  const preview = await a.api(path(data, item, 'preview'), 'POST', command(data, item)); assert.equal(preview.issues.length, 0, JSON.stringify(preview.issues));
  assert(preview.effects.some(effect => effect.cause?.includes('最晚目标日') && effect.consequence?.includes('2026-10-29')));
  assert.equal((await fresh('SELECT COUNT(*) n FROM projects WHERE name=?', [file.projects[0].name]))[0].n, '0');
  const saved = await a.api(path(data, item), 'POST', command(data, item)), id = saved.result.projectId; projects.push(id);
  let detail = await a.api('/api/projects/' + id);
  assert.equal(detail.project.version, '1'); assert.equal(detail.stages[1].state, 'active'); assert.equal(detail.stages[1].expectedEndOn, '2026-10-29');
  const firstNode = detail.nodes.find(node => node.title === '前置节点'), nextNode = detail.nodes.find(node => node.title === '后续节点'); assert.equal(firstNode.nextNodeId, nextNode.id); assert.equal(nextNode.previousNodeId, firstNode.id); assert.equal(firstNode.x, 0);
  assert.equal((await fresh("SELECT JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.node.nextNodeId')) nextId FROM audit_log WHERE project_id=? AND entity_id=? AND action='project.import.project_node'", [id, firstNode.id]))[0].nextId, nextNode.id);
  assert.equal((await fresh("SELECT JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.node.kind')) kind FROM audit_log WHERE project_id=? AND action='project.import.customer_node'", [id]))[0].kind, 'customer');
  assert.equal(detail.nodes.filter(node => node.kind === 'customer').length, 1); assert.equal(detail.risks[0].createdAt, '2026-09-05 09:00:00'); assert.equal(detail.risks[0].createdByName, null);
  assert.equal((await fresh('SELECT created_at FROM project_risks WHERE project_id=?', [id]))[0].created_at, null);
  assert.equal(detail.changes[0].content, '来源需求'); assert.equal(detail.delays[0].kind, 'reschedule'); assert.equal(detail.delays[0].oldDate, null);
  assert.equal(detail.project.summaryNote, '简要备注'); assert.equal(detail.project.chipstatNote, '芯片专属备注');
  assert.deepEqual(detail.project.statusEntries.map(entry => entry.date), dates);
  const summary = (await a.api('/api/project-summary')).items.find(project => project.id === id); assert.equal(summary.summaryNote, '简要备注'); assert.equal(summary.chipstatNote, '芯片专属备注'); assert.equal(summary.pendingNodes.length, 2);
  assert.equal((await fresh('SELECT COUNT(*) n FROM project_checks WHERE project_id=?', [id]))[0].n, '0'); assert.equal(detail.project.checkedToday, false); assert.equal(detail.localCheckMarks[0].value, 1700000000000);
  checks.push('正常采用全部子记录与两类备注；节点正式ID及连线、位置、阶段预计日、详情/简要新请求接续；未知旧人/时间与本地检查标记不伪造成线上事实');

  data = await a.upload(source, file, true); item = projectItem(data); assert.equal(item.unchanged, true, JSON.stringify(item.diffs)); assert.equal(data.counts.pending, 0);
  assert.equal((await fresh('SELECT COUNT(*) n FROM import_adoptions WHERE target_kind=\'project\' AND target_id=?', [id]))[0].n, '1');
  checks.push('完整来源重传全一致只读，不增加采用、版本、历史或检查');

  file.projects[0].nodes[0].doneDate = '2026-09-03'; file.projects[0].nodes[1].doneDate = '2026-09-04';
  data = await a.upload(source, file); item = projectItem(data); const aKey = recordKey(item, 201), bKey = recordKey(item, 202), blocked = command(data, item, [bKey]);
  const dependency = await a.api(path(data, item, 'preview'), 'POST', blocked); assert(dependency.issues.some(issue => issue.code === 'NODE_PREDECESSOR_INCOMPLETE')); assert(dependency.issues.some(issue => issue.message.includes('前置节点')));
  assert(dependency.issues.some(issue => issue.requiredKeys?.includes(aKey) && issue.cause?.includes('前置节点')));
  await a.api(path(data, item), 'POST', blocked, 422); detail = await a.api('/api/projects/' + id); assert.equal(detail.nodes.find(node => node.id === nextNode.id).completedOn, null);
  await a.api(path(data, item), 'POST', command(data, item, [aKey, bKey])); detail = await a.api('/api/projects/' + id); assert.equal(detail.nodes.find(node => node.id === firstNode.id).completedOn, '2026-09-03'); assert.equal(detail.nodes.find(node => node.id === nextNode.id).completedOn, '2026-09-04');
  assert.equal((await a.api('/api/project-summary')).items.find(project => project.id === id).pendingNodes.length, 0);
  checks.push('仅采用后置完成被具体因果提示拦截；明确同选前置后整体保存，简要未完成节点随之消失');

  file.projects[0].nodes[0].doneDate = ''; file.projects[0].nodes[1].doneDate = '';
  data = await a.upload(source, file); item = projectItem(data);
  const undo = { intent: { kind: 'correction', reason: '合成验收：原完成误填' } };
  const undoPreview = await a.api(path(data, item, 'preview'), 'POST', command(data, item, [recordKey(item, 201)], undo));
  assert(undoPreview.issues.some(issue => issue.cause?.includes('撤销') && issue.requiredKeys?.includes(recordKey(item, 202))));
  await a.api(path(data, item), 'POST', command(data, item, [recordKey(item, 201)], undo), 422);
  await a.api(path(data, item), 'POST', command(data, item, [recordKey(item, 201), recordKey(item, 202)], undo));
  detail = await a.api('/api/projects/' + id); assert(detail.nodes.filter(node => node.kind === 'project').every(node => node.completedOn === null));
  file.projects[0].nodes[0].doneDate = '2026-09-03'; file.projects[0].nodes[1].doneDate = '2026-09-04';
  data = await a.upload(source, file); item = projectItem(data); await a.api(path(data, item), 'POST', command(data, item));
  file.projects[0].stages[2].done = true;
  data = await a.upload(source, file); item = projectItem(data);
  const stagePreview = await a.api(path(data, item, 'preview'), 'POST', command(data, item, ['stage.S3']));
  assert(stagePreview.issues.some(issue => issue.code === 'STAGE_SEQUENCE_REVIEW_REQUIRED' && issue.cause?.includes('项目预启动') && issue.cause?.includes('PEVT')));
  file.projects[0].stages[2].done = false; detail = await a.api('/api/projects/' + id);
  checks.push('前置撤销明确展示受影响下游，仅在来源具有未完成候选时提供同选；阶段越级显示具体前后阶段及恢复入口');

  const onlineText = '重复行\n重复行\n线上修改行';
  await a.api('/api/projects/' + id, 'PATCH', { scope: 'status', expectedVersion: detail.project.version, idempotencyKey: randomUUID(), changes: { statusDesc: onlineText } });
  detail = await a.api('/api/projects/' + id); assert.deepEqual(detail.project.statusEntries.slice(0, 2).map(entry => entry.date), dates.slice(0, 2)); assert.match(detail.project.statusEntries[2].date, /Z$/);
  const actualLineTime = detail.project.statusEntries[2].date;
  file.projects[0].statusDesc = onlineText; file.projects[0].statusDescEntries = onlineText.split('\n').map(text => ({ text, updatedAt: '1999-01-01 00:00:00' }));
  data = await a.upload(source, file); assert.equal(projectItem(data).unchanged, true, JSON.stringify(projectItem(data).diffs)); detail = await a.api('/api/projects/' + id); assert.equal(detail.project.statusEntries[2].date, actualLineTime);
  checks.push('来源同文重复行按出现顺序保留各自时间；线上修改仅变动行获真实时间，相同正文重传不刷新行时间');

  file.projects[0].statusHistory = [{ date: '修正来源时间', text: '缩短后的完整历史' }];
  data = await a.upload(source, file); item = projectItem(data);
  const beforeVersion = detail.project.version, beforeAuditCount = (await fresh('SELECT COUNT(*) n FROM audit_log WHERE project_id=?', [id]))[0].n;
  const historySaved = await a.api(path(data, item), 'POST', command(data, item, ['history.mixed'])); detail = await a.api('/api/projects/' + id);
  assert.equal(detail.project.version, String(BigInt(beforeVersion) + 1n)); assert.equal((await fresh('SELECT COUNT(*) n FROM audit_log WHERE project_id=?', [id]))[0].n, beforeAuditCount);
  assert.deepEqual(detail.history.map(row => row.text), ['缩短后的完整历史']); assert.equal(detail.project.statusDesc, onlineText);
  let sourcePage = await a.api('/api/projects/' + id + '/source-history?kind=mixed');
  const original = sourcePage.versions.find(version => version.count === 2); assert(original);
  const originalPage = await a.api('/api/projects/' + id + '/source-history?kind=mixed&adoption=' + original.id); assert.deepEqual(originalPage.sources[0].entries.map(row => row.text), ['重复原文', '重复原文']);
  file.projects[0].statusHistory = []; file.projects[0].statusDescHistory = [];
  data = await a.upload(source, file); item = projectItem(data); await a.api(path(data, item), 'POST', command(data, item, ['history.mixed', 'history.status_description'])); detail = await a.api('/api/projects/' + id);
  assert.equal(detail.history.length, 0); assert.equal(detail.sourceHistories.mixed.sources.length, 1); assert.equal(detail.sourceHistories.status_description.sources[0].entries.length, 0); assert.equal(detail.project.statusDesc, onlineText);
  const statusPage = await a.api('/api/projects/' + id + '/source-history?kind=status_description'); const oldStatus = statusPage.versions.find(version => version.count === 2); assert(oldStatus);
  assert.equal((await a.api('/api/projects/' + id + '/source-history?kind=status_description&adoption=' + oldStatus.id)).sources[0].entries[0].text, '');
  assert.equal((await a.api('/api/imports/' + data.batch.id)).counts.pending, 0);
  checks.push('完整历史缩短/显式清空替换当前展示，旧版本与内部重复/空正文仍可回看；仅历史采用推进一次版本、不伪造普通字段审计或改当前正文');

  const minimal = { version: 2, projects: [{ id: 101, name: file.projects[0].name + ' 只改名称', summary_note: '' }] };
  data = await a.upload(source, minimal); item = projectItem(data); await a.api(path(data, item), 'POST', command(data, item, ['fields.name'])); detail = await a.api('/api/projects/' + id);
  assert.equal(detail.project.summaryNote, '简要备注'); assert.equal(detail.project.detailNote, '保留详细资料'); assert.equal(detail.nodes.length, 3); assert.equal(detail.risks.length, 1); assert.equal(detail.project.statusDesc, onlineText);
  data = await a.api('/api/imports/' + data.batch.id); item = projectItem(data); await a.api(path(data, item), 'POST', command(data, item, ['fields.summaryNote'])); detail = await a.api('/api/projects/' + id); assert.equal(detail.project.summaryNote, ''); assert.equal(detail.project.chipstatNote, '芯片专属备注'); assert.equal(data.counts.processed, 1);
  checks.push('缺失字段/子记录不清空；部分采用不顺带保存未选备注；成功卡继续选择可单独明确清空一份备注，其他正文/关联保持');

  const proposed = { version: 2, projects: [{ id: 101, name: prefix + ' 禁止覆盖', detailNote: '禁止部分写入' }] };
  data = await b.upload(source, proposed); item = projectItem(data); const denied = await b.api(path(data, item), 'POST', command(data, item), 403); assert.equal(denied.code, 'PROJECT_RESPONSIBILITY_REQUIRED');
  data = await a.api('/api/imports/' + data.batch.id); item = projectItem(data); const rolledBack = command(data, item);
  fault = true; await a.api(path(data, item), 'POST', rolledBack, 503); fault = false;
  let current = await a.api('/api/projects/' + id); assert.equal(current.project.name, detail.project.name); assert.equal(current.project.detailNote, '保留详细资料'); assert.equal(current.project.version, detail.project.version);
  await a.api('/api/projects/' + id, 'PATCH', { scope: 'status', expectedVersion: current.project.version, idempotencyKey: randomUUID(), changes: { statusDesc: onlineText + '\n新的线上状态' } });
  await a.api(path(data, item), 'POST', rolledBack, 409); current = await a.api('/api/projects/' + id); assert.equal(current.project.name, detail.project.name); assert.equal(current.project.detailNote, '保留详细资料');
  const invalid = await a.upload(source, { version: 2, projects: [{ id: 101, name: '非法日期不能带入名称', startDate: '2099-01-01' }] });
  await a.api(path(invalid, projectItem(invalid)), 'POST', command(invalid, projectItem(invalid)), 422); assert.equal((await a.api('/api/projects/' + id)).project.name, detail.project.name);
  checks.push('非经理即使上传更新也不能采用；项目写后故障全部回滚；原版本失效/非法已知日期不留下部分字段写入，保留旧正式结果');

  const closed = { version: 2, projects: [{ id: 9001, name: prefix + ' 历史结案', status: '已结案', closeReason: '原结案说明', stages: Array.from({ length: 7 }, () => ({ done: true })) }] };
  data = await a.upload(source, closed); item = projectItem(data); const closedSaved = await a.api(path(data, item), 'POST', command(data, item)); projects.push(closedSaved.result.projectId);
  let closedDetail = await a.api('/api/projects/' + closedSaved.result.projectId); assert.equal(closedDetail.project.status, 'closed'); assert.equal(closedDetail.project.closedOn, null); assert.equal(closedDetail.project.closureType, null); assert.equal(Number(closedDetail.project.closurePlanKnown), 0); assert.equal(closedDetail.project.deadline.kind, 'closed_unknown'); assert.equal(closedDetail.currentClosure.auditId, null); assert.equal(closedDetail.currentClosure.actorDisplayName, null); assert.equal(closedDetail.stages.filter(stage => stage.state === 'completed').length, 7);
  assert.equal((await fresh('SELECT COUNT(*) n FROM audit_log WHERE project_id=? AND action IN (\'project.start\',\'project.close\',\'project.stage.start\',\'project.stage.complete\')', [closedSaved.result.projectId]))[0].n, '0');
  const reopening = { version: 2, projects: [{ id: 9001, name: closed.projects[0].name, status: '进行中', closureType: null, closedOn: null, closureDueDate: null, closeReason: '', remainingWorkNote: '', preCloseStatus: null, isProductionMaintenance: false }] };
  data = await a.upload(source, reopening); item = projectItem(data); await a.api(path(data, item), 'POST', command(data, item), 422);
  const corrected = command(data, item, undefined, { intent: { kind: 'correction', reason: '合成来源：先前结案状态误录' } });
  await a.api(path(data, item), 'POST', corrected); closedDetail = await a.api('/api/projects/' + closedSaved.result.projectId); assert.equal(closedDetail.project.status, 'ongoing'); assert.equal(closedDetail.project.closureNote, ''); assert.equal(closedDetail.stages.filter(stage => stage.state === 'completed').length, 7);
  checks.push('历史已结案可保持阶段完成及未知日期/类型，不重演线上动作、不冒充旧结案人；重开类状态差异必须明确意图及同次处理结案关联事实');
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/import-projects.json', JSON.stringify({ status: 'passed', verifiedAt: new Date().toISOString(), build: JSON.parse(await readFile('dist/build-info.json', 'utf8')), prefix, source, requests, projects, checks, historyAdoptionVersion: historySaved.result.savedVersion }, null, 2));
  console.log(JSON.stringify({ status: 'passed', requests, projects, checks }));
} finally { if (app) await app.close(); await c.end(); }
