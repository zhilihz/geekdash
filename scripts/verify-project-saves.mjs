import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { verifyDatabase } from '../dist/server/infrastructure/schema.js';

// 专用库自己的来源键；故障注入仍执行真实 SQL/COMMIT，绝不触碰 dev 人工样本。
const namespace = '__project_save_test__';
const id = '9007199254759997';
const otherId = '9007199254759998';
const businessId = '9007199254759999';
const ids = [id, otherId, businessId];
const { connection } = await connectDatabase('test_migrator');
let runtime, app, origin, originalReceipt;
const checks = [];
let fault = '';
let owned = false;
const importSource = {};
async function start() {
  runtime = await openRuntimeDatabase('test_app');
  const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute;
    const commit = lease.commit;
    lease.execute = function(sql, parameters) {
      if (fault && (fault === 'audit' && sql.startsWith('INSERT INTO audit_log') || fault === 'receipt' && sql.startsWith('INSERT INTO command_receipts'))) return execute.call(this, 'INSERT INTO __save_failure_missing_table VALUES (1)');
      return execute.call(this, sql, parameters);
    };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw Object.assign(new Error('lost commit acknowledgement'), { code: 'PROTOCOL_CONNECTION_LOST' }); };
    try { return await work(lease); } finally {
      // commit 在 work 之后由真实 writeTransaction 调用；ack 夹具在使用后连接会销毁。
      lease.execute = execute;
      if (fault !== 'ack') lease.commit = commit;
    }
  });
  app = await createApp(runtime);
  origin = await app.listen({ host: process.argv.includes('--serve') ? '0.0.0.0' : '127.0.0.1', port: process.argv.includes('--serve') ? 3000 : 0 });
}
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(origin + path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  assert.equal(response.status, expected, JSON.stringify(result));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return result;
}
const input = (version, changes) => ({ expectedVersion: version, idempotencyKey: randomUUID(), changes });
const detail = () => request('/api/projects/' + id);
const save = (body, status = 200, target = id) => request('/api/projects/' + target, 'PATCH', body, status);
const confirm = (body, status = 200) => request('/api/projects/' + id + '/save-results/query', 'POST', body, status);
async function state() {
  const { connection: fresh } = await connectDatabase('test_app');
  try {
    const [projects] = await fresh.query('SELECT CAST(id AS CHAR) id,CAST(version AS CHAR) version,name,market_expectation,detail_note,summary_note FROM projects WHERE id IN (?,?,?) ORDER BY id', ids);
    const [audit] = await fresh.query('SELECT COUNT(*) n FROM audit_log WHERE project_id IN (?,?,?)', ids);
    const [receipts] = await fresh.query('SELECT COUNT(*) n FROM command_receipts WHERE command_scope IN (?,?,?)', ids.map(value => `anonymous:project:${value}:text`));
    return { projects, audit: Number(audit[0].n), receipts: Number(receipts[0].n) };
  } finally { await fresh.end(); }
}
try {
  await verifyDatabase('test_migrator');
  const [existing] = await connection.execute('SELECT id FROM projects WHERE source_namespace=? OR id IN (?,?,?)', [namespace, ...ids]);
  assert.equal(existing.length, 0, '夹具已存在；先核对，禁止清除未知输入');
  await connection.beginTransaction();
  for (const [index, projectId] of ids.entries()) await connection.execute(`INSERT INTO projects (id,name,data_kind,source_namespace,source_key,status,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at)
    VALUES (?, ?, ?, ?, ?, 'ongoing','','初始预期','','初始说明','初始摘要','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [projectId, '保存夹具' + index, index === 2 ? 'business' : 'trial', namespace, String(index)]);
  importSource.user = String((await connection.execute("INSERT INTO users (login_name,password_hash,display_name,enabled,created_at,updated_at) VALUES ('__project_save_test__','disabled-test-fixture','禁用测试来源',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))"))[0].insertId);
  importSource.batch = String((await connection.execute("INSERT INTO import_batches (source_hash,source_file_ref,source_bytes,source_schema_version,source_namespace,mapping_json,created_by,current_handler_id,created_at) VALUES (?, 'test-fixture',0,'test',?,'{}',?,?,UTC_TIMESTAMP(3))", [Buffer.alloc(32), namespace, importSource.user, importSource.user]))[0].insertId);
  importSource.item = String((await connection.execute("INSERT INTO import_items (batch_id,item_kind,source_sequence,source_payload_json,validation_json,status) VALUES (?,'project',0,'{}','{}','committed')", [importSource.batch]))[0].insertId);
  await connection.execute("INSERT INTO legacy_project_history (project_id,source_import_item_id,source_sequence,source_date_text,body) VALUES (?,?,0,'旧时间','原来源历史')", [id, importSource.item]);
  await connection.commit(); owned = true;
  await start();
  assert.equal((await detail()).project.id, id);
  assert.equal((await detail()).capabilities.editText, true);
  let before = await state();
  const first = input('1', { name: '准确保存 中文🙂', marketExpectation: '', detailNote: '保留空格 \n第二行🙂', summaryNote: '<script>window.__injected=1</script>' });
  const result = await save(first); originalReceipt = result.result;
  assert.equal(result.outcome, 'committed'); assert.equal(result.result.savedVersion, '2');
  const after = await state(); assert.equal(after.audit, before.audit + 1); assert.equal(after.receipts, before.receipts + 1);
  assert.equal(after.projects[0].detail_note, first.changes.detailNote); assert.equal(after.projects[0].market_expectation, '');
  assert.equal((await detail()).project.version, '2');
  assert.equal((await request('/api/projects?view=all&search=' + encodeURIComponent(first.changes.name))).pagination.total, 1);
  const [audit] = await connection.query('SELECT actor_id,actor_kind,actor_display_name,before_json,after_json,request_id FROM audit_log WHERE project_id=?', [id]);
  assert.equal(audit[0].actor_id, null); assert.equal(audit[0].actor_kind, 'anonymous'); assert.equal(audit[0].actor_display_name, '未认证操作');
  assert.equal(audit[0].after_json.summaryNote, first.changes.summaryNote); assert.equal(audit[0].request_id, result.requestId);
  checks.push({ check: 'four-fields-atomic-save-bigint-fresh-connection-http-board-and-audit', passed: true });

  before = await state();
  const duplicate = await Promise.all([save(first), save(first)]);
  duplicate.forEach(response => assert.deepEqual(response.result, originalReceipt)); assert.deepEqual(await state(), before);
  assert.equal((await save({ ...first, changes: { name: '另一个文本' } }, 409)).code, 'OPERATION_KEY_REUSED');
  // 插入顺序不同的变化集合与同一请求摘要一致。
  assert.deepEqual((await save({ ...first, changes: { summaryNote: first.changes.summaryNote, detailNote: first.changes.detailNote, marketExpectation: '', name: first.changes.name } })).result, originalReceipt);
  checks.push({ check: 'concurrent-idempotent-replay-canonical-field-order-and-key-reuse', passed: true });

  const sameA = input('2', { detailNote: '并发甲' }), sameB = input('2', { summaryNote: '并发乙' });
  const racing = await Promise.all([fetch(origin + '/api/projects/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sameA) }), fetch(origin + '/api/projects/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sameB) })]);
  assert.deepEqual(racing.map(response => response.status).sort(), [200,409]);
  assert.equal((await state()).audit, before.audit + 1); assert.equal((await detail()).project.version, '3');
  assert.deepEqual((await save(first)).result, originalReceipt);
  const noChange = input('3', { name: first.changes.name });
  before = await state(); const unchanged = await save(noChange);
  assert.equal(unchanged.result.changed, false); assert.equal(unchanged.result.savedAt, null); assert.equal(unchanged.result.savedVersion, '3');
  assert.deepEqual((await save(noChange)).result, unchanged.result); assert.equal((await state()).audit, before.audit); assert.equal((await state()).receipts, before.receipts + 1);
  assert.equal((await save(input('2', { name: first.changes.name }), 409)).code, 'PROJECT_VERSION_CONFLICT');
  checks.push({ check: 'same-version-winner-only-stale-rejected-no-change-receipt-and-old-result', passed: true });

  before = await state();
  for (const body of [null, [], {}, { ...input('3', { name: '值' }), actorId: '1' }, input('3', { dataKind: 'trial' }), input('3', { status: 'closed' }), input('3', { name: 123 }), input('3', { detailNote: null }), input('3', {}), input(3, { name: '值' })]) await save(body, 400);
  for (const changes of [{ name: ' \n ' }, { name: '🙂'.repeat(256) }, { detailNote: '汉'.repeat(21846) }, { summaryNote: '\ud800' }]) assert.equal((await save(input('3', changes), 422)).code, 'INVALID_PROJECT_FIELDS');
  await save(input('1', { name: '不能修改' }), 403, businessId);
  await save(input('1', { name: '不存在' }), 404, '18446744073709551615');
  await save(input('1', { name: '非法编号' }), 400, '18446744073709551616');
  assert.deepEqual(await state(), before);
  const capacity = await save(input('3', { name: '🙂'.repeat(255), detailNote: 'a'.repeat(65535) }));
  assert.equal(capacity.result.values.detailNote.length, 65535); assert.equal([...(await detail()).project.name].length, 255);
  checks.push({ check: 'whitelist-scope-null-type-unicode-byte-capacity-and-no-partial-write', passed: true });

  for (const failure of ['audit', 'receipt']) {
    before = await state(); fault = failure;
    const response = await save(input('4', { name: '失败应回滚' }), 500); fault = '';
    assert.equal(response.outcome, 'not_committed'); assert.deepEqual(await state(), before);
  }
  const commitUnknown = input('4', { name: 'COMMIT已执行🙂', detailNote: '响应未知测试' }); fault = 'ack';
  const unknown = await save(commitUnknown, 503); fault = '';
  assert.equal(unknown.code, 'COMMIT_UNKNOWN'); assert.equal(unknown.outcome, 'unknown');
  before = await state(); assert.equal(before.projects[0].version, '5');
  const confirmed = await confirm(commitUnknown); assert.equal(confirmed.outcome, 'committed'); assert.equal(confirmed.result.savedVersion, '5');
  assert.deepEqual((await save(commitUnknown)).result, confirmed.result); assert.deepEqual(await state(), before);
  checks.push({ check: 'real-audit-receipt-sql-failure-rolls-back-and-real-commit-lost-ack-confirmed-once', passed: true });

  const waitingInput = input('5', { marketExpectation: '在途提交' });
  await connection.beginTransaction(); await connection.query('SELECT id FROM projects WHERE id=? FOR UPDATE', [id]);
  const waiting = save(waitingInput); await delay(100);
  assert.equal((await confirm(waitingInput)).outcome, 'not_found');
  await connection.commit(); assert.equal((await waiting).result.savedVersion, '6');
  before = await state(); await app.close(); app = undefined; await start();
  assert.deepEqual((await save(waitingInput)).result, (await confirm(waitingInput)).result); assert.deepEqual(await state(), before);
  const leases = await Promise.all(Array.from({ length: 8 }, () => runtime.pool.getConnection()));
  try { const unavailable = await save(input('6', { name: '池满不应提交' }), 503); assert.equal(unavailable.outcome, 'not_committed'); await confirm(waitingInput, 503); }
  finally { leases.forEach(lease => lease.release()); }
  assert.deepEqual(await state(), before);
  checks.push({ check: 'inflight-not-found-read-only-process-restart-replay-pool-failure-and-recovery', passed: true });

  const latencies = [];
  for (let round = 0; round < 5; round++) {
    const version = (await detail()).project.version;
    const responses = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const start = performance.now(); const response = await fetch(origin + '/api/projects/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input(version, { summaryNote: `四并发${round}-${index}` })) });
      await response.json(); latencies.push(performance.now() - start); return response.status;
    }));
    assert.equal(responses.filter(status => status === 200).length, 1); assert.equal(responses.filter(status => status === 409).length, 3);
  }
  latencies.sort((a,b) => a-b);
  checks.push({ check: 'four-concurrent-actual-writes-five-rounds-and-fresh-readback', passed: true, requests: 20, p95Ms: Math.round(latencies[Math.ceil(latencies.length * .95)-1]) });

  // 超过 500 条真实保存历史；默认 20、单页最多 100，不限制总量。
  let version = (await detail()).project.version;
  for (let index = 0; index < 505; index++) { const response = await save(input(version, { name: `真实历史夹具${index}` })); version = response.result.savedVersion; }
  await save(input('1', { name: '另项目历史' }), 200, otherId);
  const defaultPage = await request('/api/projects/' + id + '/audit'); assert.equal(defaultPage.items.length, 20); assert.equal(defaultPage.pageSize, 20);
  const one = await request('/api/projects/' + id + '/audit?pageSize=1'); assert.equal(one.items.length, 1);
  const page = await request('/api/projects/' + id + '/audit?pageSize=100'); assert.equal(page.items.length, 100); assert.ok(page.nextCursor);
  await save(input(version, { name: '分页中新增' }));
  const items = [...page.items]; let cursor = page.nextCursor;
  while (cursor) { const next = await request('/api/projects/' + id + '/audit?pageSize=100&before=' + cursor); items.push(...next.items); cursor = next.nextCursor; }
  assert.ok(items.length > 500); assert.equal(new Set(items.map(item => item.id)).size, items.length);
  for (const parameter of ['101', '0', '-1', '1.5', 'bad']) await request('/api/projects/' + id + '/audit?pageSize=' + parameter, 'GET', undefined, 400);
  await request('/api/projects/' + id + '/audit?before=18446744073709551616', 'GET', undefined, 400);
  assert.equal((await detail()).history[0].text, '原来源历史');
  const [plan] = await connection.query('EXPLAIN SELECT id FROM audit_log WHERE project_id=? AND id<? ORDER BY id DESC LIMIT 101', [id, page.nextCursor]);
  assert.ok(plan[0].possible_keys.split(',').includes('idx_project_id_id'));
  assert.notEqual(plan[0].type, 'ALL');
  checks.push({ check: 'audit-default20-max100-unbounded-total-stable-cursor-legacy-separated-index', passed: true, totalRead: items.length, selectedIndex: plan[0].key, accessType: plan[0].type });
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/project-saves-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), status: 'passed', source: '专用 MySQL 测试库及真实 HTTP，新连接回读；仅合成输入', checks }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', checks }));
  if (process.argv.includes('--serve')) { console.log('PROJECT_SAVE_BROWSER_READY'); await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); }
} finally {
  fault = ''; await connection.rollback(); await app?.close();
  if (owned) {
    for (const projectId of ids) { await connection.execute('DELETE FROM audit_log WHERE project_id=?', [projectId]); await connection.execute('DELETE FROM command_receipts WHERE command_scope=?', [`anonymous:project:${projectId}:text`]); }
    await connection.execute('DELETE FROM legacy_project_history WHERE project_id=?', [id]);
    await connection.execute('DELETE FROM projects WHERE source_namespace=? AND id IN (?,?,?)', [namespace,...ids]);
    await connection.execute('DELETE FROM import_items WHERE id=?', [importSource.item]);
    await connection.execute('DELETE FROM import_batches WHERE id=?', [importSource.batch]);
    await connection.execute('DELETE FROM users WHERE id=?', [importSource.user]);
  }
  await connection.end();
}
