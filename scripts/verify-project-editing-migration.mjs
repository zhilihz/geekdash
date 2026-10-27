import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { loadSchema } from '../dist/server/infrastructure/schema.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1');
assert.match(process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID ?? '', /^[a-f0-9-]{36}$/);
const { connection: c } = await connectDatabase('test_migrator');
const fixture = resolve('test-results', 'editing-upgrade-' + randomUUID());
const code = resolve(fixture, 'server/infrastructure/schema.js');
const command = resolve(fixture, 'server/commands/database.js');
const checks = [];
const run = (step = '') => new Promise((accept, reject) => {
  const child = spawn(process.execPath, [command, 'migrate', 'test_migrator'], { env: { ...process.env, GEEKDASH_EDITING_KILL_STEP: step }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', v => output += v); child.stderr.on('data', v => output += v); child.on('error', reject);
  child.on('close', (exitCode, signal) => accept({ exitCode, signal, output }));
});
const id = async () => (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
try {
  assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
  assert.equal((await c.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'))[0].length, 0, '仅在专用空库运行，不重置已有库');
  await mkdir(fixture, { recursive: true }); await cp('dist/server', resolve(fixture, 'server'), { recursive: true }); await cp('dist/migrations', resolve(fixture, 'migrations'), { recursive: true });
  const current = await readFile(code, 'utf8'), old = current.replace(/,\s*\['0010-project-editing',\s*9\]/, '');
  assert.notEqual(current, old); await writeFile(code, old);
  let result = await run(); assert.equal(result.exitCode, 0, result.output);
  const previous = await (await import(pathToFileURL(code).href + '?old')).loadSchema();
  assert.equal(previous.manifest.version, '0009-project-space');
  await c.query("INSERT INTO users(login_name,password_hash,display_name,created_at,updated_at) VALUES ('editing_probe','not-a-password','合成迁移账号',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))");
  const actor = await id();
  await c.query("INSERT INTO customers(name,contact,background,created_at,updated_at) VALUES ('合成双重角色资料','原联系方式','原背景',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))"); const customer = await id();
  await c.query("INSERT INTO chips(name,original_model,manufacturer,firmware_version,created_at,updated_at) VALUES ('合成芯片','原型号','原厂','v1',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))"); const chip = await id();
  const catalogs = {};
  for (const table of ['product_lines','apps','project_groups']) {
    await c.query(`INSERT INTO ${table}(name,${table === 'apps' ? 'app_version,description,' : ''}created_at,updated_at) VALUES ('合成资料',${table === 'apps' ? "'v1','原说明'," : ''}UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`); catalogs[table] = await id();
  }
  await c.execute("INSERT INTO projects(name,name_key,created_by,customer_id,odm_customer_id,product_line_id,app_id,group_id,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at) VALUES ('迁移合成项目','迁移合成项目',?,?,?,?,?,?,'','','旧状态说明','','','','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [actor,customer,customer,catalogs.product_lines,catalogs.apps,catalogs.project_groups]); const project = await id();
  await c.execute('INSERT INTO project_chips(project_id,chip_id,sort_order) VALUES (?,?,3)',[project,chip]);
  await c.execute('INSERT INTO project_responsibilities(project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))',[project,actor]);
  await c.execute("INSERT INTO project_membership_requests(project_id,kind,initiator_id,target_user_id,status,created_at) VALUES (?,'invitation',?,?,'pending',UTC_TIMESTAMP(3))",[project,actor,actor]);
  const before = {};
  for (const table of previous.manifest.tables.filter(t => !['schema_migrations','project_membership_requests'].includes(t.name))) {
    const columns = table.columns.map(v => '`'+v.name+'`').join(',');
    before[table.name] = (await c.query(`SELECT ${columns} FROM ${table.name}`))[0];
  }
  const marker = "console.log(JSON.stringify({ event: 'migration_step_verified', object: step }));";
  assert.equal(current.split(marker).length - 1, 2);
  await writeFile(code, current.replaceAll(marker, marker + " if (process.env.GEEKDASH_EDITING_KILL_STEP === step) process.kill(process.pid, 'SIGKILL');"));
  const resource = await loadSchema();
  for (const [index, step] of resource.increments.at(-1).steps.entries()) {
    const name = step.data ?? (step.table + ":" + (index + 1));
    result = await run(name); assert.equal(result.signal, 'SIGKILL', result.output); checks.push('中断并可续跑：' + name);
  }
  result = await run(); assert.equal(result.exitCode, 0, result.output);
  result = await run(); assert.equal(result.exitCode, 0, result.output);
  for (const table of previous.manifest.tables.filter(t => Object.hasOwn(before,t.name))) {
    const columns = table.columns.map(v => '`'+v.name+'`').join(',');
    assert.deepEqual((await c.query(`SELECT ${columns} FROM ${table.name}`))[0],before[table.name],table.name+'旧成果保持');
  }
  for (const [table,field,target] of [['project_customers','customer_id',customer],['project_odm_factories','customer_id',customer],['project_product_lines','product_line_id',catalogs.product_lines],['project_apps','app_id',catalogs.apps],['project_group_links','group_id',catalogs.project_groups]]) {
    const rows = (await c.query(`SELECT CAST(${field} AS CHAR) id FROM ${table} WHERE project_id=?`,[project]))[0]; assert.deepEqual(rows.map(r=>r.id),[target]);
  }
  const choices = (await c.query('SELECT selection_id id,note,sort_order position FROM project_chip_selections WHERE project_id=?',[project]))[0]; assert.deepEqual(choices,[{id:'legacy:'+chip,note:'',position:3}]);
  assert.deepEqual((await c.query('SELECT is_customer,is_odm FROM customers WHERE id=?',[customer]))[0],[{is_customer:1,is_odm:1}]);
  assert.equal((await c.query('SELECT status FROM project_membership_requests'))[0][0].status,'invalidated');
  await c.execute('INSERT INTO project_chip_selections(project_id,selection_id,chip_id,note,sort_order) VALUES (?,?,?,?,4)',[project,randomUUID(),chip,'同芯片的第二用途']);
  assert.equal((await c.query('SELECT COUNT(*) n FROM project_chip_selections WHERE project_id=?',[project]))[0][0].n,'2');
  await assert.rejects(c.execute('INSERT INTO project_customers(project_id,customer_id,sort_order) VALUES (?,999999999,0)',[project]), e=>e.code==='ER_NO_REFERENCED_ROW_2');
  checks.push('旧字段、历史及负责关系保持；五组关联完整；ODM身份保留；同芯片独立备注；外键拒绝悬空；旧请求失效');
  console.log(JSON.stringify({passed:true,schema:resource.manifest.version,checks}));
} finally { await c.end(); }
