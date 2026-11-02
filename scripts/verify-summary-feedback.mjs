import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1');
const { connection: setup } = await connectDatabase('test_migrator');
const database = (await setup.query('SELECT DATABASE() db,@@server_uuid uuid'))[0][0];
assert.equal(database.db, 'geekdash_test');
assert.equal(database.uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'summary_' + randomUUID().slice(0, 8), password = 'Summary-test-password-2026', users = [], projects = [], engineers = [], checks = [];
let app, origin, requests = 0, sqlReadbacks = 0;
function client() {
  let cookie = '', csrf = '', account;
  return {
    async api(path, method = 'GET', body) {
      requests++;
      const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...account ? { 'X-GeekDash-Account': account.id } : {} }, ...body ? { body: JSON.stringify(body) } : {} });
      for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
      const result = await response.json(); assert.equal(response.status, 200, path + ': ' + JSON.stringify(result)); if (result.account) account = result.account; return result;
    },
    async login(user) { await this.api('/api/auth/login', 'POST', { loginName: user.login, password }); await this.api('/api/auth/me'); }
  };
}
async function sqlFacts(id) {
  const { connection } = await connectDatabase('test_app');
  try {
    sqlReadbacks++;
    return {
      project: (await connection.query('SELECT CAST(version AS CHAR) version FROM projects WHERE id=?', [id]))[0][0],
      people: (await connection.query('SELECT CAST(engineer_id AS CHAR) id,role FROM project_people WHERE project_id=? ORDER BY engineer_id,role', [id]))[0],
      risks: (await connection.query('SELECT content,resolved,resolution,deleted_at deletedAt FROM project_risks WHERE project_id=? ORDER BY sort_order,id', [id]))[0],
      changes: (await connection.query('SELECT source,content,decision,reason FROM project_changes WHERE project_id=? ORDER BY sort_order,id', [id]))[0],
      audits: (await connection.query('SELECT COUNT(*) n FROM audit_log WHERE project_id=?', [id]))[0][0].n
    };
  } finally { await connection.end(); }
}
async function loadSummary() {
  const context = vm.createContext({ document: { addEventListener() {} }, BroadcastChannel: class {}, Intl, structuredClone });
  async function load(path, dependencies) {
    const code = ts.transpileModule(await readFile(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText, module = { exports: {} };
    vm.runInContext('(function(require,exports,module){' + code + '\n})', context)(name => dependencies[name] ?? {}, module.exports, module); return module.exports;
  }
  const api = await load('src/web/shared/api.ts', {}), status = await load('src/web/shared/status-text.ts', { './api': api });
  return load('src/web/shared/summary.ts', { './api': api, './status-text': status });
}
try {
  for (let index = 0; index < 2; index++) {
    const login = prefix + index, name = prefix + ' 项目负责人' + index;
    await setup.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES(?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [login, await hashPassword(password), name]);
    users.push({ id: (await setup.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id, login, name });
  }
  for (const name of [prefix + ' 硬件', prefix + ' 软件', users[0].name, prefix + ' 参与']) {
    await setup.execute('INSERT INTO engineers(name,role,created_at,updated_at) VALUES(?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [name, '硬件']);
    engineers.push({ id: (await setup.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id, name });
  }
  app = await createApp(await openRuntimeDatabase('test_app'), { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const a = client(), b = client(); await a.login(users[0]); await b.login(users[1]);
  const people = [{ id: engineers[0].id, role: 'hardware_owner' }, { id: engineers[1].id, role: 'software_owner' }, ...engineers.map(person => ({ id: person.id, role: 'participant' }))];
  for (const [user, fields] of [[a, { name: prefix + ' 可见项目', people }], [b, { name: prefix + ' 无关项目' }]]) {
    projects.push((await user.api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields })).result.projectId);
  }
  const path = '/api/projects/' + projects[0], riskIds = [randomUUID(), randomUUID(), randomUUID()];
  const first = (await a.api(path, 'PATCH', { scope: 'project', expectedVersion: '1', idempotencyKey: randomUUID(), changes: {
    riskOps: riskIds.map((tempId, index) => ({ op: 'add', tempId, content: ['样机温升高', '供料不足', '误录风险'][index], level: ['high', 'mid', 'low'][index] })),
    changeOps: [{ op: 'add', tempId: randomUUID(), source: '客户', content: '增加按键', decision: 'accept', reason: '已确认' }, { op: 'add', tempId: randomUUID(), source: '业务', content: '缩短验证', decision: 'reject', reason: '保留验证' }]
  } })).result;
  const saved = (await a.api(path, 'PATCH', { scope: 'project', expectedVersion: first.savedVersion, idempotencyKey: randomUUID(), changes: { riskOps: [{ op: 'resolve', id: first.riskIdMap[riskIds[1]], resolution: '已补货' }, { op: 'delete', id: first.riskIdMap[riskIds[2]] }] } })).result;
  const facts = await sqlFacts(projects[0]); assert.equal(facts.project.version, saved.savedVersion); assert.equal(facts.people.length, people.length);
  assert.equal(facts.risks.length, 3); assert(facts.risks[2].deletedAt); assert.equal(facts.risks[1].resolution, '已补货'); assert.equal(facts.changes[1].decision, 'reject');
  checks.push('真实 HTTP 保存分工、风险及变更，独立 test_app 连接读回版本、关联、解除和删除事实');
  const snapshot = await a.api('/api/project-summary'), project = snapshot.items.find(item => item.id === projects[0]);
  assert(project); assert(!snapshot.items.some(item => item.id === projects[1])); assert.equal(project.risks.length, 2); assert.equal(project.changes.length, 2);
  assert.deepEqual(project.risks.map(({ content, resolved, resolution }) => ({ content, resolved, resolution })), facts.risks.filter(row => !row.deletedAt).map(({ content, resolved, resolution }) => ({ content, resolved, resolution })));
  assert.deepEqual(project.changes.map(({ source, content, decision, reason }) => ({ source, content, decision, reason })), facts.changes.map(row => ({ ...row })));
  checks.push('新摘要请求只返回本人可见项目；风险排除已删除记录并与 SQL 内容一致，变更保留接受/拒绝');
  const summary = await loadSummary();
  assert.equal(summary.summaryValue(project, 'projectOwners'), users[0].name); assert.equal(summary.summaryValue(project, 'hardwareOwners'), engineers[0].name); assert.equal(summary.summaryValue(project, 'softwareOwners'), engineers[1].name); assert.equal(summary.summaryValue(project, 'participants'), engineers[3].name);
  assert.equal(summary.summaryRows([project], { risk: ['unresolved'], change: ['reject'] }, 'customer').length, 1); assert.equal(summary.summaryRows([project], { risk: ['none'] }, 'customer').length, 0);
  const columns = ['projectOwners', 'hardwareOwners', 'softwareOwners', 'participants', 'risks', 'changes'], csv = summary.summaryCsv([project], columns);
  for (const text of ['硬件负责人', '软件负责人', '参与者', '样机温升高', '已补货', '增加按键', '保留验证']) assert(csv.includes(text), text);
  assert(!csv.includes('误录风险')); assert(!csv.includes('执行负责人'));
  checks.push('真实摘要数据进入同一前端投影/筛选/CSV：分工拆列、参与者排除已负责者、风险与变更完整导出');
  const empty = (await b.api('/api/project-summary')).items.find(item => item.id === projects[1]); assert.deepEqual(empty.risks, []); assert.deepEqual(empty.changes, []); assert.equal(summary.summaryRows([empty], { risk: ['none'], change: ['none'] }, 'customer').length, 1);
  assert.deepEqual(await sqlFacts(projects[0]), facts);
  checks.push('无记录项目可按无风险/无变更筛选；摘要读取、展示与导出不修改项目版本、分工及审计');
  const audits = (await a.api(path + '/audit')).items; assert(audits.length); assert(audits.every(item => item.actorId === users[0].id && item.actorLoginName === users[0].login && item.actorDisplayName === users[0].name));
  await setup.execute('UPDATE users SET is_admin=1 WHERE id=?', [users[1].id]);
  await setup.execute('UPDATE users SET login_name=?,display_name=?,enabled=0,deleted_at=UTC_TIMESTAMP(3) WHERE id=?', [prefix + '_renamed', prefix + ' 新姓名', users[0].id]);
  const afterRename = (await b.api(path + '/audit')).items;
  assert.equal(afterRename.length, audits.length); assert(afterRename.every(item => item.actorLoginName === prefix + '_renamed' && item.actorDisplayName === users[0].name));
  await setup.execute('UPDATE audit_log SET actor_id=NULL WHERE id=?', [audits[0].id]);
  const missingActor = (await b.api(path + '/audit')).items.find(item => item.id === audits[0].id);
  assert.equal(missingActor.actorId, null); assert.equal(missingActor.actorLoginName, null); assert.equal(missingActor.actorDisplayName, users[0].name);
  checks.push('历史 API 返回账号 ID 与当前登录名；改名、停用、软删除不丢旧姓名与历史，缺失账号只保留原姓名');
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/summary-feedback.json', JSON.stringify({ status: 'passed', database: database.db, serverUuid: database.uuid, httpRequests: requests, independentSqlReadbacks: sqlReadbacks, checks, productBrowserTested: false }, null, 2));
  console.log(JSON.stringify({ status: 'passed', httpRequests: requests, independentSqlReadbacks: sqlReadbacks, checks: checks.length, evidence: 'test-results/summary-feedback.json' }));
} finally {
  if (app) await app.close();
  if (projects.length) {
    for (const table of ['audit_log', 'project_checks', 'schedule_changes', 'project_changes', 'project_risks', 'project_nodes', 'project_stages', 'project_people', 'project_chips', 'project_tags', 'project_responsibilities', 'project_membership_requests', 'project_name_aliases']) await setup.query(`DELETE FROM ${table} WHERE project_id IN (?)`, [projects]);
    await setup.query('DELETE FROM projects WHERE id IN (?)', [projects]);
  }
  if (users.length) { const ids = users.map(user => user.id); for (const table of ['command_receipts', 'audit_log']) await setup.query(`DELETE FROM ${table} WHERE actor_id IN (?)`, [ids]); await setup.query('DELETE FROM sessions WHERE user_id IN (?)', [ids]); await setup.query('DELETE FROM users WHERE id IN (?)', [ids]); }
  if (engineers.length) await setup.query('DELETE FROM engineers WHERE id IN (?)', [engineers.map(person => person.id)]);
  await setup.end();
}
