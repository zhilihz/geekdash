import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { loadSchema, migrateDatabase } from '../dist/server/infrastructure/schema.js';
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
try {
  assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
  const resource=await loadSchema(),old=resource.increments.at(-1).previous;
  assert.equal((await c.query('SELECT MAX(version) version FROM schema_migrations'))[0][0].version,'0008-import-name-bindings');
  const hashes=async()=>{
    const result={};for(const table of old.tables){const names=table.columns.map(v=>'`'+v.name+'`').join(','),order=table.indexes.find(v=>v.name==='PRIMARY').columns.map(v=>'`'+v+'`').join(',');
      const values=(await c.query(`SELECT ${names} FROM \`${table.name}\` ${table.name==='schema_migrations'?"WHERE version<>'0009-project-space'":''} ORDER BY ${order}`))[0];
      result[table.name]={rows:values.length,sha256:createHash('sha256').update(JSON.stringify(values)).digest('hex')};}
    return result;
  };
  const files=async(dir,base=dir)=>{let items=[];for(const entry of await readdir(dir,{withFileTypes:true})){const path=resolve(dir,entry.name);assert(path.startsWith(resolve(base)+sep));if(entry.isDirectory())items.push(...await files(path,base));else if(entry.isFile()){const bytes=await readFile(path);items.push({relative:path.slice(resolve(base).length+1),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}else throw new Error('不支持链接作为导入原文件');}return items.sort((a,b)=>a.relative.localeCompare(b.relative));};
  const before=await hashes(),sourceFiles=await files(process.env.GEEKDASH_IMPORT_DIR);
  assert(before.projects.rows>0);assert(before.import_adoptions.rows>0,'本验证须包含实际旧采用成果');
  await writeFile('test-results/project-space-restore-baseline.json',JSON.stringify({before,sourceFiles},null,2)+'\n');
  const migrated=await migrateDatabase('test_migrator');
  assert.deepEqual(await hashes(),before,'恢复副本升级不改变任何旧列值');
  assert.deepEqual(await files(process.env.GEEKDASH_IMPORT_DIR),sourceFiles);
  const missing=(await c.query(`SELECT COUNT(*) n FROM import_adoptions a LEFT JOIN command_receipts r ON r.idempotency_key=a.operation_key AND r.actor_id=a.actor_id AND r.command_scope=CONCAT('user:',a.actor_id,':import:item:',a.item_id) WHERE r.idempotency_key IS NULL`))[0][0].n;
  assert.equal(Number(missing),0);
  const result={status:'passed',checkedAt:new Date().toISOString(),source:'本地0008固定验收库的SQL和原文件恢复副本，含已采用真实备份和合成测试；非线上快照',serverUuid:process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID,structure:migrated,oldTableHashes:before,sourceFileCount:sourceFiles.length,sourceFilesHash:createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),adoptionsHaveReceipts:true};
  await writeFile('test-results/project-space-restore-check.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,source:result.source,oldTables:Object.keys(before).length,projects:before.projects.rows,adoptions:before.import_adoptions.rows,sourceFileCount:sourceFiles.length,version:migrated.version}));
}finally{await c.end();}
