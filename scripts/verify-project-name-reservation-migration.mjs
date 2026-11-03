import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { loadSchema, migrateDatabase, verifyDatabase } from '../dist/server/infrastructure/schema.js';

// 专用隔离升级演练。此脚本会模拟0015结构，必须停止同库其他测试/应用后单独运行。
assert.equal(process.env.GEEKDASH_NAME_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('dev_migrator');
assert.equal((await c.query('SELECT @@server_uuid id'))[0][0].id,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const version='0016-project-name-reservation',prefix='migration_'+randomUUID().slice(0,8);
const rows=async(sql,values=[])=>(await c.query(sql,values))[0];
try{
  assert.equal((await rows('SELECT MAX(version) version FROM schema_migrations'))[0].version,version);
  await c.query('ALTER TABLE projects MODIFY COLUMN name_key VARBINARY(1020) NULL');
  await c.execute('DELETE FROM schema_migrations WHERE version=?',[version]);
  const insert=async(name,key,source,deleted)=>{
    await c.execute("INSERT INTO projects(name,name_key,data_kind,source_namespace,source_key,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,summary,deleted_at,created_at,updated_at) VALUES (?,?,'trial','migration-probe',?,'','','','','','','','','',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",[name,key,source,deleted?'2026-11-01 00:00:00':null]);
    return (await rows('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
  };
  const active=await insert(prefix,Buffer.from(prefix),prefix+'-active',false);
  const deleted=await insert(prefix,null,prefix+'-deleted',true);
  await assert.rejects(migrateDatabase('dev_migrator'),error=>error.code==='DB_PROJECT_NAME_DUPLICATE'&&error.differences[0].actual.includes(deleted));
  assert.equal((await rows('SELECT name_key FROM projects WHERE id=?',[deleted]))[0].name_key,null,'预检失败不得回填或自动改名');
  assert.equal((await rows('SELECT COUNT(*) n FROM schema_migrations WHERE version=?',[version]))[0].n,'0');
  // 只改本脚本合成的重名，不替用户自动消解真实重复数据。
  await c.execute('UPDATE projects SET name=? WHERE id=?',[prefix+'-history',deleted]);
  const facts=async()=>createHash('sha256').update(JSON.stringify(await rows('SELECT CAST(id AS CHAR) id,name,version,deleted_at,created_at,updated_at FROM projects ORDER BY id'))).digest('hex');
  const before=await facts();
  await migrateDatabase('dev_migrator');
  assert.equal(await facts(),before,'回填只改变name_key与结构，不改项目业务事实');
  assert.equal((await rows('SELECT COUNT(*) n FROM projects WHERE name_key IS NULL'))[0].n,'0');
  assert.equal((await rows("SELECT IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='projects' AND COLUMN_NAME='name_key'"))[0].nullable,'NO');
  assert.equal((await rows('SELECT name_key FROM projects WHERE id=?',[deleted]))[0].name_key.toString(),prefix+'-history');
  assert.equal((await rows('SELECT name_key FROM projects WHERE id=?',[active]))[0].name_key.toString(),prefix);
  // 模拟DDL已生效但版本登记尚未成功，重新运行应只完成登记。
  await c.execute('DELETE FROM schema_migrations WHERE version=?',[version]);
  await migrateDatabase('dev_migrator');
  assert.equal(await facts(),before);
  assert.equal((await rows('SELECT COUNT(*) n FROM schema_migrations WHERE version=?',[version]))[0].n,'1');
  // 在上述专用隔离库轮换测试值，退出前原样放回；运维升级不改旧账本。
  const legacy=(await loadSchema()).history.find(entry=>entry.version==='0009-project-space');
  const readDigest=async()=>(await rows('SELECT checksum FROM schema_migrations WHERE version=?',[legacy.version]))[0].checksum;
  const writeDigest=value=>c.execute('UPDATE schema_migrations SET checksum=? WHERE version=?',[value,legacy.version]);
  const original=await readDigest();
  try{
    await writeDigest(legacy.alternateChecksum);
    await verifyDatabase('dev_migrator');
    assert.deepEqual(await readDigest(),legacy.alternateChecksum);
    await writeDigest(Buffer.alloc(32));
    await assert.rejects(verifyDatabase('dev_migrator'),{code:'DB_MIGRATION_CHECKSUM_MISMATCH'});
  }finally{await writeDigest(original);}
  console.log(JSON.stringify({status:'passed',scope:'隔离0015至0016升级演练',checks:['现存与已删重名预检拒绝且不写入','历史NULL键回填且业务事实不变','NOT NULL及唯一索引继续生效','DDL完成但登记丢失可重跑','0009已发布换行可读且账本原样保留，未知散列拒绝']}));
}finally{await c.end();}
