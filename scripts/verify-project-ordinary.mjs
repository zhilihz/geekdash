import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';

const namespace = '__project_ordinary_test__';
const id = '9007199254748890', other = '9007199254748891', business = '9007199254748892';
const ids = [id, other, business];
const { connection } = await connectDatabase('test_migrator');
const refs = {};
let runtime, app, origin, fault = '', owned = false;
const checks = [];
const input = (version, changes) => ({ expectedVersion: version, idempotencyKey: randomUUID(), changes });
async function api(path, method = 'GET', body, status = 200) {
  const response = await fetch(origin + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert.equal(response.status, status, JSON.stringify(data)); return data;
}
const detail = () => api('/api/projects/' + id);
const save = (body, status = 200, target = id) => api('/api/projects/' + target, 'PATCH', body, status);
const confirm = body => api('/api/projects/' + id + '/save-results/query', 'POST', body);
async function state() {
  const { connection: fresh } = await connectDatabase('test_app');
  try {
    const result = {};
    for (const table of ['projects', 'project_chips', 'project_tags', 'project_people', 'audit_log']) result[table] = (await fresh.query(`SELECT * FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'} IN (?,?,?) ORDER BY ${table === 'projects' || table === 'audit_log' ? 'id' : table === 'project_people' ? 'project_id,sort_order,engineer_id,role' : 'project_id,sort_order'}`, ids))[0];
    result.receipts = (await fresh.query('SELECT * FROM command_receipts WHERE command_scope IN (?,?,?,?,?,?) ORDER BY command_scope,idempotency_key', ids.flatMap(id => [`anonymous:project:${id}:text`, `anonymous:project:${id}:ordinary`])))[0];
    return result;
  } finally { await fresh.end(); }
}
async function start() {
  runtime = await openRuntimeDatabase('test_app');
  const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, parameters) {
      if (fault === 'relation' && sql.startsWith('INSERT INTO project_tags') || fault === 'audit' && sql.startsWith('INSERT INTO audit_log')) return execute.call(this, 'INSERT INTO __ordinary_missing_table VALUES (1)');
      return execute.call(this, sql, parameters);
    };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw Object.assign(new Error('lost acknowledgement'), { code: 'PROTOCOL_CONNECTION_LOST' }); };
    try { return await work(lease); } finally { lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime); origin = await app.listen({ host: process.argv.includes('--serve') ? '0.0.0.0' : '127.0.0.1', port: process.argv.includes('--serve') ? 3000 : 0 });
}
try {
  assert.equal((await connection.execute('SELECT id FROM projects WHERE source_namespace=? OR id IN (?,?,?)', [namespace, ...ids]))[0].length, 0, '已有夹具，核对后接续，不删除未知输入');
  await connection.beginTransaction();
  for (const [table, fields] of Object.entries({ customers: ['contact', 'background'], chips: ['original_model', 'manufacturer', 'firmware_version'], engineers: ['role'], tags: [], product_lines: [], apps: ['app_version', 'description'], project_groups: [] })) {
    refs[table] = [];
    for (const index of [0, 1, 2]) refs[table].push(String((await connection.execute(`INSERT INTO ${table} (name,${fields.map(field => field + ',').join('')}enabled,created_at,updated_at) VALUES (?${fields.map(() => ',?').join('')},?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [namespace + '-' + table + '-' + index, ...fields.map(() => '合成资料'), index === 2 ? 0 : 1]))[0].insertId));
  }
  for (const target of ids) await connection.execute(`INSERT INTO projects (id,name,data_kind,source_namespace,source_key,status,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at) VALUES (?,? ,?,? ,?,'ongoing','','初始预期','状态说明','原说明','原摘要','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [target, '普通保存夹具' + target, target === business ? 'business' : 'trial', namespace, target]);
  await connection.execute('INSERT INTO project_chips (project_id,chip_id,sort_order) VALUES (?,?,0)', [id, refs.chips[2]]);
  await connection.commit(); owned = true; await start();
  const options = await api('/api/project-options');
  assert.equal(options.chips.find(item => item.id === refs.chips[2]).enabled, 0);
  const first = input('1', { name: '完整普通保存🙂', statusDesc: '真实说明\n新一行', signal: 'red', priority: 'high', signalNote: '', chipstatNote: '芯片备注', customerId: refs.customers[0], odmCustomerId: refs.customers[1], productLineId: refs.product_lines[0], appId: refs.apps[0], groupId: refs.project_groups[0], chipIds: [refs.chips[2], refs.chips[0], refs.chips[1]], tagIds: [refs.tags[1], refs.tags[0]], people: [{ id: refs.engineers[0], role: 'pm' }, { id: refs.engineers[0], role: 'hardware_owner' }, { id: refs.engineers[1], role: 'participant' }] });
  const original = (await save(first)).result;
  assert.equal(original.savedVersion, '2'); assert.equal(original.display.customerId.name, options.customers.find(item => item.id === refs.customers[0]).name);
  let current = await detail(); assert.equal(current.project.customerId, refs.customers[0]); assert.deepEqual(current.project.chips.map(item => item.id), first.changes.chipIds); assert.deepEqual(current.project.people.map(({ id, role }) => ({ id, role })), first.changes.people);
  const persisted = await state(); assert.equal(persisted.projects[0].signal, 'red'); assert.equal(persisted.projects[0].priority, 'high'); assert.ok(persisted.projects[0].status_description_updated_at); assert.equal(persisted.audit_log.length, 1); assert.equal(persisted.receipts.length, 1);
  const board = await api('/api/projects?view=all&customer=' + encodeURIComponent(original.display.customerId.name) + '&chip=' + encodeURIComponent(original.display.chipIds[1].name)); assert.equal(board.stats.total, 1); assert.equal(board.stats.red, 1); assert.equal(board.stats.high, 1);
  const history = await api('/api/projects/' + id + '/audit'); assert.deepEqual(history.items[0].afterValues.chipIds, original.display.chipIds);
  checks.push({ check: 'ordinary-fields-relations-single-version-fresh-sql-http-filter-stats-audit', passed: true });

  // 重放先于新引用资格，关联内容和人员对象键顺序规范化。
  await connection.execute('UPDATE chips SET enabled=0 WHERE id=?', [refs.chips[0]]);
  const replay = { ...first, changes: Object.fromEntries(Object.entries(first.changes).reverse()) };
  replay.changes.people = first.changes.people.map(({ id, role }) => ({ role, id }));
  assert.deepEqual((await save(replay)).result, original); assert.deepEqual((await confirm(first)).result, original);
  assert.equal((await save({ ...first, changes: { ...first.changes, priority: 'low' } }, 409)).code, 'OPERATION_KEY_REUSED');
  await connection.execute('UPDATE engineers SET enabled=0 WHERE id=?', [refs.engineers[0]]);
  const unchanged = input('2', { chipIds: first.changes.chipIds, signal: 'red', people: replay.changes.people });
  assert.equal((await save(unchanged)).result.changed, false); assert.equal((await detail()).project.version, '2');
  await save(input('2', { people: [...first.changes.people, { id: refs.engineers[0], role: 'software_owner' }] }), 422);
  for (const changes of [{ chipIds: [refs.chips[0]] }, { customerId: refs.customers[2] }, { chipIds: ['18446744073709551615'] }]) { const before = await state(); await save(input('1', changes), 422, other); assert.deepEqual(await state(), before); }
  checks.push({ check: 'existing-disabled-kept-new-disabled-rejected-receipt-replay-and-no-change', passed: true });

  let version = '2';
  for (const changes of [{ status: 'closed' }, { signal: 'blue' }, { chipIds: [refs.chips[1], refs.chips[1]] }, { customerId: 1 }, { people: [{ id: refs.engineers[0], role: 'admin' }] }, { expectedVersion: '5' }]) {
    const before = await state(); const response = await fetch(origin + '/api/projects/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input(version, changes)) }); assert.ok([400, 422].includes(response.status)); assert.deepEqual(await state(), before);
  }
  await save(input('1', { priority: 'high' }), 403, business);
  for (const failure of ['relation', 'audit']) { const before = await state(); fault = failure; await save(input(version, { signal: 'green', summaryNote: '不能半份提交', tagIds: [refs.tags[0]] }), 500); fault = ''; assert.deepEqual(await state(), before); }
  checks.push({ check: 'whitelist-reference-validation-relation-and-audit-failure-all-rollback', passed: true });

  const cleared = (await save(input(version, { customerId: null, chipIds: [], tagIds: [], people: [] }))).result; version = cleared.savedVersion;
  current = await detail(); assert.equal(current.project.customerId, null); assert.equal(current.project.odmCustomerId, first.changes.odmCustomerId); assert.deepEqual(current.project.chips, []); assert.deepEqual(current.project.people, []);
  await save(input(version, { chipIds: [refs.chips[2]] }), 422);
  checks.push({ check: 'explicit-clear-and-omitted-relations-preserved', passed: true });

  const parallel = await Promise.all([{ priority: 'low' }, { signal: 'yellow' }].map(async changes => {
    const response = await fetch(origin + '/api/projects/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input(version, changes)) }); return { status: response.status, data: await response.json() };
  })); assert.deepEqual(parallel.map(item => item.status).sort(), [200, 409]); version = parallel.find(item => item.status === 200).data.result.savedVersion;
  assert.equal((await detail()).project.version, version);
  const pending = input(version, { chipIds: [refs.chips[1]], summaryNote: '已提交丢回执🙂' }); fault = 'ack'; assert.equal((await save(pending, 503)).code, 'COMMIT_UNKNOWN'); fault = '';
  const confirmed = (await confirm(pending)).result; assert.equal(confirmed.savedVersion, String(BigInt(version) + 1n)); const afterCommit = await state();
  await app.close(); await start(); assert.deepEqual((await save(pending)).result, confirmed); assert.deepEqual(await state(), afterCommit);
  checks.push({ check: 'same-version-conflict-real-commit-lost-ack-reopen-and-exact-replay', passed: true });

  // 与资料停用并发：保存须等真实资料行锁，然后拒绝已经停用的新引用。
  const { connection: editor } = await connectDatabase('test_migrator');
  try {
    await editor.beginTransaction(); await editor.execute('UPDATE chips SET enabled=0 WHERE id=?', [refs.chips[1]]);
    const running = save(input('1', { chipIds: [refs.chips[1]] }), 422, other); await delay(150); await editor.commit(); await running;
  } finally { await editor.end(); }
  checks.push({ check: 'reference-row-lock-observes-concurrent-disabled-before-new-link', passed: true });
  // 来源记录可能有相同位置；详情和保存的稳定次序须一致，防止无编辑也产生改动。
  for (const role of ['pm', 'hardware_owner']) await connection.execute('INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,?,0)', [id, refs.engineers[1], role]);
  const tied = (await detail()).project;
  assert.deepEqual(tied.people.map(person => person.role), ['hardware_owner', 'pm']);
  assert.equal((await save(input(tied.version, { people: tied.people.map(({ id, role }) => ({ id, role })) }))).result.changed, false);
  const latencies = [];
  for (let round = 0; round < 5; round++) {
    const base = (await detail()).project.version;
    const competitors = await Promise.all(Array.from({ length: 4 }, async (_, worker) => {
      const began = performance.now();
      const response = await fetch(origin + '/api/projects/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input(base, { summaryNote: `普通保存竞争${round}-${worker}`, priority: 'mid', chipIds: [] })) });
      latencies.push(Math.round(performance.now() - began)); return response.status;
    }));
    assert.deepEqual(competitors.sort(), [200, 409, 409, 409]);
    assert.equal((await detail()).project.version, String(BigInt(base) + 1n));
  }
  latencies.sort((a, b) => a - b);
  checks.push({ check: 'four-workers-same-project-five-rounds-one-winner', passed: true, requests: 20, p95Ms: latencies[18], maxMs: latencies[19] });
  const report = { status: 'passed', checkedAt: new Date().toISOString(), source: '真实 test MySQL 与 HTTP；合成输入', checks };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/project-ordinary-check.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
  if (process.argv.includes('--serve')) {
    for (const reference of refs.chips.slice(0, 2)) await connection.execute('UPDATE chips SET enabled=1 WHERE id=?', [reference]);
    for (const reference of refs.engineers.slice(0, 2)) await connection.execute('UPDATE engineers SET enabled=1 WHERE id=?', [reference]);
    console.log('PROJECT_ORDINARY_BROWSER_READY'); await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  }
} finally {
  fault = ''; await connection.rollback(); await app?.close();
  if (owned) {
    for (const table of ['audit_log', 'project_people', 'project_tags', 'project_chips']) await connection.execute(`DELETE FROM ${table} WHERE project_id IN (?,?,?)`, ids);
    for (const target of ids) for (const mode of ['text', 'ordinary']) await connection.execute('DELETE FROM command_receipts WHERE command_scope=?', [`anonymous:project:${target}:${mode}`]);
    await connection.execute('DELETE FROM projects WHERE source_namespace=? AND id IN (?,?,?)', [namespace, ...ids]);
    for (const [table, values] of Object.entries(refs)) for (const reference of values) await connection.execute(`DELETE FROM ${table} WHERE id=? AND name LIKE ?`, [reference, namespace + '%']);
  }
  await connection.end();
}
