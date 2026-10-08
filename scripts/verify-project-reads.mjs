import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';

const { connection } = await connectDatabase('test_app');
assert.equal((await connection.query('SELECT DATABASE() db'))[0][0].db, 'geekdash_test');
const namespace = '__project_read_test__';
const bigId = '9007199254740993';
const ids = Array.from({ length: 30 }, (_, i) => (BigInt(bigId) + BigInt(i)).toString());
const referenceIds = {};
const importSource = {};
let ownsFixture = false;
let runtime, app;
const checks = [];
async function request(path, status = 200) {
  const response = await fetch(origin + path);
  assert.equal(response.status, status, path);
  return response.json();
}
let origin;
try {
  assert.equal(Number((await connection.query("SELECT GET_LOCK('__project_read_test__',0) acquired"))[0][0].acquired), 1, '已有项目读取测试正在运行');
  const [existing] = await connection.execute('SELECT id FROM projects WHERE source_namespace=? OR id BETWEEN ? AND ?', [namespace, ids[0], ids.at(-1)]);
  assert.equal(existing.length, 0, '专用夹具已有数据，先核对，不覆盖');
  assert.equal(Number((await connection.query('SELECT COUNT(*) count FROM projects'))[0][0].count), 0, '测试库项目不为空，先核对，不删除');
  ownsFixture = true;
  for (const [table, fields] of Object.entries({ customers: ['contact', 'background'], engineers: ['role'], chips: ['original_model', 'manufacturer', 'firmware_version'], product_lines: [], apps: ['app_version', 'description'], project_groups: [], tags: [] })) {
    const names = ['name', ...fields, 'enabled', 'version', 'created_at', 'updated_at'];
    const [result] = await connection.execute(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, [`测试-${table}`, ...fields.map(() => ''), 1, 1, '2026-10-08 10:00:00', '2026-10-08 10:00:00']);
    referenceIds[table] = String(result.insertId);
  }
  for (let i = 0; i < ids.length; i++) {
    const names = ['id', 'name', 'source_namespace', 'source_key', 'status', 'priority', 'signal', 'customer_id', 'product_line_id', 'app_id', 'group_id', 'maintenance_enabled', 'market_expectation', 'status_description', 'signal_note', 'detail_note', 'summary_note', 'chipstat_note', 'closure_note', 'remaining_work_note', 'created_at', 'updated_at'];
    const values = [ids[i], i === 0 ? '测试项目 <img src=x onerror=alert(1)> %_!' : `测试项目 ${i}`, namespace, String(i), i === 1 ? 'proposal' : i === 2 ? 'paused' : i === 3 || i === 4 ? 'closed' : 'ongoing', i === 0 ? 'high' : 'mid', i === 0 ? 'red' : i === 1 ? 'yellow' : 'green', referenceIds.customers, referenceIds.product_lines, referenceIds.apps, referenceIds.project_groups, i === 4 ? 1 : 0, '测试市场预期', '测试状态\n第二行', '', '测试备注', '', '', '', '', '2026-10-08 10:00:00', '2026-10-08 10:00:00'];
    await connection.execute(`INSERT INTO projects (${names.map(name => '`' + name + '`').join(',')}) VALUES (${names.map(() => '?').join(',')})`, values);
    for (let stage = 1; stage <= 7; stage++) await connection.execute('INSERT INTO project_stages (project_id,stage_code,state,planned_days,note) VALUES (?,?,?,?,?)', [ids[i], 'S' + stage, stage === 1 ? 'completed' : stage === 2 ? 'ready' : 'locked', 4, '旧阶段说明']);
  }
  await connection.execute('INSERT INTO project_chips (project_id,chip_id,sort_order) VALUES (?,?,0)', [bigId, referenceIds.chips]);
  await connection.execute('INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,?,0)', [bigId, referenceIds.engineers, 'hardware_owner']);
  await connection.execute('INSERT INTO project_tags (project_id,tag_id,sort_order) VALUES (?,?,0)', [bigId, referenceIds.tags]);
  const stageId = String((await connection.execute("SELECT id FROM project_stages WHERE project_id=? AND stage_code='S2'", [bigId]))[0][0].id);
  await connection.execute('INSERT INTO project_nodes (project_id,kind,stage_id,title,output,note,sort_order) VALUES (?,?,?,?,?,?,0)', [bigId, 'project', stageId, '测试节点', '测试成果', '测试节点说明']);
  await connection.execute('INSERT INTO project_nodes (project_id,kind,title,output,note,sort_order) VALUES (?,?,?,?,?,0)', [bigId, 'customer', '测试客户节点', '', '']);
  await connection.execute('INSERT INTO project_risks (project_id,content,level,resolved,resolution,created_at,sort_order) VALUES (?,?,?,0,?,UTC_TIMESTAMP(3),0)', [bigId, '测试风险', 'high', '']);
  await connection.execute('INSERT INTO project_changes (project_id,source,content,decision,reason,created_at,sort_order) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3),0)', [bigId, '测试来源', '测试变更', 'accept', '测试原因']);
  await connection.execute('INSERT INTO schedule_changes (project_id,kind,old_date,new_date,reason,measures,created_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))', [bigId, 'reschedule', '2026-10-08', '2026-10-10', '测试改期', '测试措施']);
  importSource.user = String((await connection.execute("INSERT INTO users (login_name,password_hash,display_name,enabled,created_at,updated_at) VALUES ('__project_read_test__','disabled-test-fixture','禁用测试来源',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))"))[0].insertId);
  importSource.batch = String((await connection.execute("INSERT INTO import_batches (source_hash,source_file_ref,source_bytes,source_schema_version,source_namespace,mapping_json,created_by,current_handler_id,created_at) VALUES (?, 'test-fixture',0,'test',?,'{}',?,?,UTC_TIMESTAMP(3))", [Buffer.alloc(32), namespace, importSource.user, importSource.user]))[0].insertId);
  importSource.item = String((await connection.execute("INSERT INTO import_items (batch_id,item_kind,source_sequence,source_payload_json,validation_json,status) VALUES (?,'project',0,'{}','{}','committed')", [importSource.batch]))[0].insertId);
  await connection.execute('INSERT INTO legacy_project_history (project_id,source_import_item_id,source_sequence,source_date_text,body) VALUES (?,?,0,?,?)', [bigId, importSource.item, '2026-10-08', '测试来源历史']);

  runtime = await openRuntimeDatabase('test_app');
  app = await createApp(runtime);
  origin = await app.listen({ host: '0.0.0.0', port: process.argv.includes('--serve') ? 3000 : 0 });
  const active = await request('/api/projects');
  assert.equal(active.pagination.total, 26); assert.equal(active.stats.total, 26); assert.equal(active.items.length, 24);
  const second = await request('/api/projects?page=2');
  assert.equal(second.items.length, 2); assert.ok(second.items.some(item => item.id === bigId));
  assert.equal((await request('/api/projects?view=proposal')).pagination.total, 2);
  assert.equal((await request('/api/projects?view=closed')).pagination.total, 1);
  assert.equal((await request('/api/projects?view=maintenance')).pagination.total, 1);
  assert.equal((await request('/api/projects?view=all')).pagination.total, 30);
  assert.equal((await request('/api/projects?view=all&page=999')).pagination.page, 2);
  for (const [key, value] of Object.entries({ search: '%_!', chip: '测试-chips', owner: '测试-engineers', tags: '测试-tags', signal: 'red', priority: 'high' })) {
    const result = await request('/api/projects?' + new URLSearchParams({ [key]: value }));
    assert.equal(result.pagination.total, 1, key); assert.equal(result.items[0].id, bigId); assert.equal(result.stats.total, 26);
  }
  assert.equal((await request('/api/projects?stage=S2&progress=5')).pagination.total, 26);
  assert.equal((await request('/api/projects?search=not-found')).pagination.total, 0);
  for (const path of ['/api/projects?page=0', '/api/projects?pageSize=101', '/api/projects?view=invalid', '/api/projects?unknown=1', '/api/projects/0', '/api/projects/18446744073709551616']) await request(path, 400);
  await request('/api/projects/18446744073709551615', 404);
  assert.equal((await fetch(origin + '/api/projects/' + bigId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  checks.push({ check: 'actual-http-list-views-filters-pagination-literal-search-id-validation-no-write', passed: true });
  const detail = await request('/api/projects/' + bigId);
  assert.equal(detail.project.id, bigId); assert.equal(detail.project.version, '1'); assert.equal(detail.stages.length, 7);
  for (const key of ['risks', 'changes', 'delays', 'history']) assert.equal(detail[key].length, 1);
  assert.equal(detail.nodes.length, 2); assert.equal(detail.project.chips[0].name, '测试-chips');
  assert.equal(detail.project.people[0].role, 'hardware_owner'); assert.equal(detail.project.stage, 'S2'); assert.equal(Number(detail.project.progress), 5);
  checks.push({ check: 'complete-project-snapshot-with-all-read-collections-and-bigint-precision', passed: true });

  // 在真实详情读取中插入另一连接的提交，证明后续子查询仍读旧快照；不模拟 SQL 返回。
  const readSnapshot = runtime.readSnapshot;
  let changed = false;
  runtime.readSnapshot = work => readSnapshot(async lease => {
    const originalQuery = lease.query;
    lease.query = async function (...args) {
      const result = await originalQuery.apply(this, args);
      const sql = typeof args[0] === 'string' ? args[0] : args[0].sql;
      if (!changed && sql.includes('p.signal_note signalNote')) {
        changed = true;
        await connection.beginTransaction();
        await connection.execute("UPDATE projects SET name='新项目名称', version=2 WHERE id=?", [bigId]);
        await connection.execute("UPDATE project_stages SET note='新阶段说明' WHERE project_id=?", [bigId]);
        await connection.commit();
      }
      return result;
    };
    try { return await work(lease); } finally { lease.query = originalQuery; }
  });
  const consistent = await request('/api/projects/' + bigId);
  runtime.readSnapshot = readSnapshot;
  assert.ok(changed); assert.equal(consistent.project.version, '1'); assert.equal(consistent.stages[0].note, '旧阶段说明');
  const fresh = await request('/api/projects/' + bigId);
  assert.equal(fresh.project.version, '2'); assert.equal(fresh.stages[0].note, '新阶段说明');
  await connection.execute('UPDATE projects SET name=?,version=1 WHERE id=?', [detail.project.name, bigId]);
  checks.push({ check: 'real-concurrent-commit-does-not-mix-detail-versions-fresh-request-sees-new-version', passed: true });
  const latency = [];
  for (let round = 0; round < 5; round++) await Promise.all(Array.from({ length: 4 }, async () => {
    const start = performance.now(); await request('/api/projects?view=all'); latency.push(performance.now() - start);
  }));
  latency.sort((a, b) => a - b);
  const leases = await Promise.all(Array.from({ length: 8 }, () => runtime.pool.getConnection()));
  try { await request('/api/projects', 503); } finally { leases.forEach(lease => lease.release()); }
  await request('/api/projects');
  checks.push({ check: 'four-concurrent-real-list-reads-and-pool-exhaustion-recovery', passed: true, requests: latency.length, p95Ms: Math.round(latency[Math.ceil(latency.length * .95) - 1]) });
  const resultDirectory = process.env.GEEKDASH_TEST_RESULT_DIR ?? 'test-results';
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(resultDirectory + '/project-reads-check.json', JSON.stringify({ checkedAt: new Date().toISOString(), scope: '专用测试库、真实 HTTP/MySQL；不包含业务保存或公网性能', checks }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', origin, checks }));
  if (process.argv.includes('--serve')) { console.log('PROJECT_READ_BROWSER_READY'); await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); }
} finally {
  await app?.close();
  if (!app) await runtime?.close();
  if (ownsFixture) {
    const slots = ids.map(() => '?').join(',');
    for (const table of ['legacy_project_history', 'schedule_changes', 'project_changes', 'project_risks', 'project_nodes', 'project_tags', 'project_people', 'project_chips', 'project_stages']) await connection.execute(`DELETE FROM ${table} WHERE project_id IN (${slots}) AND project_id IN (SELECT id FROM projects WHERE source_namespace=?)`, [...ids, namespace]);
    await connection.execute('DELETE FROM projects WHERE source_namespace=? AND id BETWEEN ? AND ?', [namespace, ids[0], ids.at(-1)]);
  }
  if (importSource.item) await connection.execute('DELETE FROM import_items WHERE id=?', [importSource.item]);
  if (importSource.batch) await connection.execute('DELETE FROM import_batches WHERE id=? AND source_namespace=?', [importSource.batch, namespace]);
  if (importSource.user) await connection.execute("DELETE FROM users WHERE id=? AND login_name='__project_read_test__'", [importSource.user]);
  for (const [table, id] of Object.entries(referenceIds)) await connection.execute(`DELETE FROM ${table} WHERE id=? AND name=?`, [id, '测试-' + table]);
  await connection.end();
}
