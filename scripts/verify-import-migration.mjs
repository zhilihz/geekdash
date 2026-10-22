import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { loadSchema, verifyDatabase } from '../dist/server/infrastructure/schema.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1', '仅允许在专用空实例执行');
assert.match(process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID ?? '', /^[a-f0-9-]{36}$/);
const { connection: c } = await connectDatabase('test_migrator');
const fixture = resolve('test-results', 'import-upgrade-' + randomUUID());
assert(fixture.startsWith(resolve('test-results') + sep));
const code = resolve(fixture, 'server/infrastructure/schema.js'), command = resolve(fixture, 'server/commands/database.js');
const checks = [], interruptions = [], namespace = 'migration-probe-' + randomUUID();
const run = (mode = 'migrate', killStep = '') => new Promise((accept, reject) => {
  const child = spawn(process.execPath, [command, mode, 'test_migrator'], { env: { ...process.env, GEEKDASH_IMPORT_KILL_STEP: killStep }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; }); child.on('error', reject);
  child.on('close', (exitCode, signal) => {
    const events = output.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { diagnostic: line }; } });
    accept({ exitCode, signal, last: events.at(-1), events });
  });
});
const lastId = async () => (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
async function snapshot(tables) {
  const result = {};
  for (const table of tables) if (table.name !== 'schema_migrations') {
    const names = table.columns.map(column => '`' + column.name + '`').join(',');
    const order = table.indexes.find(index => index.name === 'PRIMARY').columns.map(name => '`' + name + '`').join(',');
    result[table.name] = (await c.query(`SELECT ${names} FROM \`${table.name}\` ORDER BY ${order}`))[0];
  }
  return result;
}
try {
  assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
  assert.equal((await c.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'))[0].length, 0, '实例必须从空test库开始；不重置已有库');
  await mkdir(fixture, { recursive: true }); await cp('dist/server', resolve(fixture, 'server'), { recursive: true }); await cp('dist/migrations', resolve(fixture, 'migrations'), { recursive: true });
  const current = await readFile(code, 'utf8');
  const old = current.replace(/,\s*\['0006-imports',\s*11\]/, '');
  assert.notEqual(old, current, '精确移除本轮增量以建立0005，不猜测版本');
  await writeFile(code, old);
  const initial = await run(); assert.equal(initial.exitCode, 0, JSON.stringify(initial));
  const oldResource = await (await import(pathToFileURL(code).href + '?old')).loadSchema();
  assert.equal(oldResource.manifest.version, '0005-check-facts'); assert.equal(oldResource.manifest.tables.length, 34);
  const oldHistory = (await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0];
  await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', ['import_probe', 'probe-not-a-login-password', '合成迁移账号']);
  const userId = await lastId();
  await c.execute("INSERT INTO projects (name,created_by,data_kind,source_namespace,source_key,version,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at) VALUES ('迁移合成项目',?,'trial',?,'7',9,'','','','','原简要','原芯片备注','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [userId, namespace]);
  const projectId = await lastId();
  await c.execute("INSERT INTO import_batches (source_hash,source_file_ref,source_bytes,source_schema_version,source_namespace,mapping_json,created_by,current_handler_id,created_at) VALUES (?,'probe/source.json',2,'2',?,'{}',?,?,'2020-01-02 03:04:05.678')", [createHash('sha256').update('{}').digest(), namespace, userId, userId]);
  const batchId = await lastId();
  await c.execute("INSERT INTO import_items (batch_id,item_kind,source_sequence,source_key,target_project_id,source_payload_json,validation_json,status) VALUES (?,'project',1,'7',?,'{}','[]','committed')", [batchId, projectId]);
  const itemId = await lastId();
  await c.execute('UPDATE projects SET source_import_item_id=? WHERE id=?', [itemId, projectId]);
  for (const sequence of [1, 2]) await c.execute("INSERT INTO legacy_project_history (project_id,source_import_item_id,source_sequence,source_date_text,body) VALUES (?,?,?,'未知旧时间','同文真实记录')", [projectId, itemId, sequence]);
  await c.execute("INSERT INTO project_risks (project_id,content,level,resolved,resolution,created_at,sort_order) VALUES (?,'旧风险','mid',0,'','2020-02-03 04:05:06.789',0)", [projectId]);
  await c.execute("INSERT INTO project_changes (project_id,source,content,decision,reason,created_at,sort_order) VALUES (?,'客户','旧需求','accept','','2020-02-03 04:05:06.789',0)", [projectId]);
  await c.execute("INSERT INTO schedule_changes (project_id,kind,reason,measures,created_at) VALUES (?,'note','旧说明','','2020-02-03 04:05:06.789')", [projectId]);
  const before = await snapshot(oldResource.manifest.tables);
  await writeFile(code, current);
  await c.query('ALTER TABLE projects ADD COLUMN __import_probe_extra int NULL');
  try {
    const drift = await run(); assert.equal(drift.exitCode, 1); assert.equal(drift.last.code, 'DB_SCHEMA_MISMATCH');
    assert.equal(Number((await c.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='import_sources'"))[0][0].n), 0);
  } finally { await c.query('ALTER TABLE projects DROP COLUMN __import_probe_extra'); }
  checks.push('含数据0005额外结构在新增DDL前拒绝');

  const marker = "console.log(JSON.stringify({ event: 'migration_step_verified', object: step }));";
  assert.equal(current.split(marker).length - 1, 2, '只在增量结构/数据步骤后插入隔离进程中断');
  await writeFile(code, current.replaceAll(marker, marker + " if (process.env.GEEKDASH_IMPORT_KILL_STEP === step) process.kill(process.pid, 'SIGKILL');"));
  const resource = await loadSchema(), steps = resource.increments.at(-1).steps;
  for (const [index, step] of steps.entries()) {
    const key = step.data ?? `${step.table}:${index + 1}`, killed = await run('migrate', key);
    assert.equal(killed.signal, 'SIGKILL', JSON.stringify(killed));
    assert.equal(Number((await c.query('SELECT COUNT(*) n FROM schema_migrations'))[0][0].n), 5);
    assert.deepEqual(await snapshot(oldResource.manifest.tables), before, '中断和续跑不改旧字段/历史/时间');
    interruptions.push({ step: key, signal: killed.signal, registeredVersions: 5, originalRowsUnchanged: true });
  }
  await writeFile(code, current);
  const upgraded = await run(); assert.equal(upgraded.exitCode, 0, JSON.stringify(upgraded));
  assert.equal(upgraded.last.tables, 37); assert.deepEqual(await snapshot(oldResource.manifest.tables), before);
  assert.deepEqual((await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0].slice(0, 5), oldHistory);
  const registered = (await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0];
  assert.equal((await run()).last.applied, false);
  assert.deepEqual((await c.query('SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version'))[0], registered);
  checks.push('11个结构/数据步骤逐个真实进程中断后续跑、旧34表全部旧列逐值保持、重复迁移不变');

  const legacy = (await c.query('SELECT source_adoption_id,legacy_source_namespace,history_kind,body FROM legacy_project_history ORDER BY id'))[0];
  assert.equal(legacy.length, 2); assert(legacy.every(row => row.source_adoption_id === null && row.legacy_source_namespace === namespace && row.history_kind === 'mixed'));
  await c.execute("INSERT INTO import_sources (source_namespace,name,created_at) VALUES (?,'另一来源',UTC_TIMESTAMP(3))", [namespace + '-new']);
  await c.execute('UPDATE import_batches SET source_namespace=? WHERE id=?', [namespace + '-new', batchId]);
  assert.deepEqual((await c.query('SELECT source_adoption_id,legacy_source_namespace,history_kind,body FROM legacy_project_history ORDER BY id'))[0], legacy);
  const bindingSQL = 'INSERT INTO import_bindings (source_namespace,object_kind,source_scope,source_key,target_id) VALUES (?,\'project\',?,?,?)';
  await c.execute(bindingSQL, [namespace, '', '7', projectId]);
  await assert.rejects(c.execute(bindingSQL, [namespace, '', '7', projectId]), { code: 'ER_DUP_ENTRY' });
  await c.execute(bindingSQL, [namespace, '', '8', projectId]);
  await c.execute(bindingSQL, [namespace, 'project:1:1', '7', projectId]);
  await c.execute(bindingSQL, [namespace, 'project:1:2', '7', projectId]);
  await assert.rejects(c.execute(bindingSQL, [namespace + '-missing', '', '7', projectId]), { code: 'ER_NO_REFERENCED_ROW_2' });
  const operationKey = randomUUID(), hash = createHash('sha256').update('adoption').digest();
  const adoptionSQL = 'INSERT INTO import_adoptions (item_id,source_namespace,actor_id,review_version,target_kind,target_id,version_before,version_after,operation_key,request_hash,adopted_json,history_manifest_json,created_at) VALUES (?,?,?,?,\'project\',?,9,10,?,?,\'{}\',\'{"mixed":{"count":1}}\',UTC_TIMESTAMP(3))';
  await c.execute(adoptionSQL, [itemId, namespace, userId, 1, projectId, operationKey, hash]); const adoptionId = await lastId();
  await assert.rejects(c.execute(adoptionSQL, [itemId, namespace, userId, 1, projectId, randomUUID(), hash]), { code: 'ER_DUP_ENTRY' });
  await assert.rejects(c.execute(adoptionSQL, [itemId, namespace, userId, 2, projectId, operationKey, hash]), { code: 'ER_DUP_ENTRY' });
  await c.execute("INSERT INTO legacy_project_history (project_id,source_import_item_id,source_adoption_id,history_kind,source_sequence,source_date_text,body) VALUES (?,?,?,'mixed',1,'','新完整版本')", [projectId, itemId, adoptionId]);
  await assert.rejects(c.execute("INSERT INTO legacy_project_history (project_id,source_import_item_id,source_adoption_id,legacy_source_namespace,history_kind,source_sequence,source_date_text,body) VALUES (?,?,?,?, 'mixed',2,'','不应双来源')", [projectId, itemId, adoptionId, namespace]));
  await assert.rejects(c.execute("INSERT INTO legacy_project_history (project_id,source_import_item_id,source_sequence,source_date_text,body) VALUES (?,?,3,'','不应缺来源')", [projectId, itemId]));
  for (const table of ['project_risks', 'project_changes', 'schedule_changes']) {
    await c.query(`UPDATE \`${table}\` SET created_at=NULL`);
    assert.equal((await c.query(`SELECT created_at FROM \`${table}\``))[0][0].created_at, null);
    await c.query(`UPDATE \`${table}\` SET created_at='2020-02-03 04:05:06.789'`);
  }
  checks.push('旧历史双同文不丢、批次改来源不追改旧历史、来源对应唯一键与子范围代次隔离、两采用唯一键及历史单一来源约束、三类未知时间可空');

  const deltaPath = resolve(fixture, 'migrations/0006-imports.json'), delta = await readFile(deltaPath, 'utf8');
  await writeFile(deltaPath, delta + ' '); assert.equal((await run('verify')).last.code, 'DB_MIGRATION_CHECKSUM_MISMATCH'); await writeFile(deltaPath, delta);
  await writeFile(code, old); assert.equal((await run('verify')).last.code, 'DB_SCHEMA_MISMATCH'); await writeFile(code, current);
  checks.push('登记摘要回改拒绝、0005结构识别拒绝新结构，必须兼容恢复产物');
  const structure = await verifyDatabase('test_migrator');
  const facts = { status: 'passed', checkedAt: new Date().toISOString(), nodeVersion: process.version, serverUuid: process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID, checks, interruptions, oldRowsHash: createHash('sha256').update(JSON.stringify(before)).digest('hex'), structure, source: '独立空MySQL实例与合成0005数据；常驻数据库未参与' };
  await writeFile('test-results/import-migration-check.json', JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify(facts));
} finally {
  await c.end(); await rm(fixture, { recursive: true, force: true });
}
