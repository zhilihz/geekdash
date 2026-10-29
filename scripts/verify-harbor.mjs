// 只操作 single-check / slim-check 隔离容器，不连接用户数据库。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const directory=path.resolve(process.argv[2]??'');
const projects={'single-check':'geekdash-single-check','slim-check':'geekdash-slim-check'};
const project=projects[path.basename(directory)];
assert.ok(project,'只能验证已指定的隔离目录');
const name=project+'-geekdash-1';
const compose=['compose','--project-directory',directory];
function docker(args,input){const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:300000,maxBuffer:2e6});if(r.error)throw r.error;return r;}
function ok(args,input){const r=docker(args,input);assert.equal(r.status,0,r.stderr+r.stdout);return r.stdout;}
function inspect(){return JSON.parse(ok(['inspect',name]))[0];}
const container=inspect();
assert.equal(container.Config.Labels['com.docker.compose.project'],project);
assert.equal(path.resolve(container.Config.Labels['com.docker.compose.project.working_dir']),directory);
const query=body=>ok(['exec','-i',name,'node','--input-type=module'],`
import fs from 'node:fs';import assert from 'node:assert/strict';import mysql from '/app/node_modules/mysql2/promise.js';
import {validateDatabaseConnection} from '/app/dist/server/infrastructure/db.js';
const c=await mysql.createConnection(JSON.parse(fs.readFileSync('/var/lib/mysql/config/dev_migrator.json','utf8')));
try{await validateDatabaseConnection(c,'dev_migrator');const [[target]]=await c.query('SELECT DATABASE() db,@@server_uuid uuid');assert.equal(target.db,'geekdash_dev');assert.notEqual(target.uuid,'3b7588d1-d1c1-11f1-9430-de9c3ef7caac');${body}}finally{await c.end();}`);
const snapshot=()=>JSON.parse(query(`
const [[admin]]=await c.query("SELECT login_name,password_hash,enabled,must_change_password,is_admin,is_project_manager FROM users WHERE login_name='admin'");
const expected=JSON.parse(fs.readFileSync('/run/seed/admin-account.json','utf8'));
assert.equal(admin.password_hash,expected.password_hash);
for(const k of ['enabled','must_change_password','is_admin','is_project_manager'])assert.equal(admin[k],expected[k]);
const [tables]=await c.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');const counts={};
for(const {name}of tables){assert.match(name,/^[a-z_]+$/);counts[name]=Number((await c.query('SELECT COUNT(*) n FROM '+name))[0][0].n);}
assert.equal(counts.users,1);assert.equal(counts.system_configuration,1);assert.equal(counts.audit_log,1);
for(const [name,n]of Object.entries(counts))if(!['schema_migrations','users','system_configuration','audit_log'].includes(name))assert.equal(n,0,name);
console.log(JSON.stringify({databaseUuid:target.uuid,counts,passwordHashPreserved:true,permissionsPreserved:true}));`));
const initial=snapshot();
// 精简只能改变运行包装，全部已构建业务文件必须逐字节保留。
function hashes(root,prefix=''){
  return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(entry=>{
    const file=path.posix.join(prefix,entry.name);
    return entry.isDirectory()?hashes(root,file):[[file,createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')]];
  }).sort(([a],[b])=>a.localeCompare(b,'en'));
}
const expectedFiles=hashes(path.resolve(directory,'../build/dist'));
const imageFiles=JSON.parse(ok(['exec','-i',name,'node','--input-type=module'],`
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
${hashes.toString()}
console.log(JSON.stringify(hashes('/app/dist')));`));
assert.deepEqual(imageFiles,expectedFiles);
// 普通 SQL 备份/恢复必须保留；不用 mysql-shell，也不读取用户库。
const dump=docker(['exec',name,'mysqldump','--defaults-extra-file=/run/secrets/mysql_health.cnf','--single-transaction','--routines','--events','--triggers','--set-gtid-purged=OFF','geekdash_dev']);
assert.equal(dump.status,0,'SQL_BACKUP_FAILED');
assert.ok(dump.stdout.includes('CREATE TABLE'));
ok(['exec',name,'mysql','--defaults-extra-file=/run/secrets/mysql_health.cnf','-e','CREATE DATABASE geekdash_restore_check']);
try{
  const restore=docker(['exec','-i',name,'mysql','--defaults-extra-file=/run/secrets/mysql_health.cnf','geekdash_restore_check'],dump.stdout);
  assert.equal(restore.status,0,'SQL_RESTORE_FAILED');
  const restored=ok(['exec',name,'mysql','--defaults-extra-file=/run/secrets/mysql_health.cnf','-Nse','SELECT (SELECT COUNT(*) FROM geekdash_restore_check.schema_migrations),(SELECT COUNT(*) FROM geekdash_restore_check.users),(SELECT COUNT(*) FROM geekdash_restore_check.projects),(SELECT a.password_hash=b.password_hash FROM geekdash_dev.users a JOIN geekdash_restore_check.users b ON a.id=b.id)']);
  assert.equal(restored.trim(),'15\t1\t0\t1');
}finally{ok(['exec',name,'mysql','--defaults-extra-file=/run/secrets/mysql_health.cnf','-e','DROP DATABASE geekdash_restore_check']);}
const seedArgs=['exec',name,'bash','-c',"cp -p /var/lib/mysql/config/dev_migrator.json /run/secrets/dev_migrator; cp -p /var/lib/mysql/config/admin-account.json /run/secrets/admin_account; trap 'rm -f /run/secrets/dev_migrator /run/secrets/admin_account' EXIT; node /app/initialize.mjs seed"];
assert.match(ok(seedArgs),/数据库已初始化/);
query("await c.query(\"UPDATE audit_log SET request_id='validation-existing-database' WHERE action='identity.harbor.initialize'\");");
try{const r=docker(seedArgs);assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/DATABASE_NOT_EMPTY/);}
finally{query("await c.query(\"UPDATE audit_log SET request_id='harbor-cc4a34b' WHERE action='identity.harbor.initialize'\");");}
// 用实际应用 UID 写入导入目录，验证重建后持久化且不要求应用以 root 运行。
ok(['exec','--user','1000:1000',name,'node','-e',"require('fs').writeFileSync('/var/lib/mysql/imports/.harbor-check','persisted')"]);
ok([...compose,'up','-d','--force-recreate','--wait','--wait-timeout','300']);
assert.deepEqual(snapshot(),initial);
ok(['exec','--user','1000:1000',name,'node','-e',"const f=require('fs');if(f.readFileSync('/var/lib/mysql/imports/.harbor-check','utf8')!=='persisted')process.exit(1);f.unlinkSync('/var/lib/mysql/imports/.harbor-check')"]);
const restarts=inspect().RestartCount;
ok(['exec','-i',name,'node','--input-type=module'],`
import fs from 'node:fs';
const pid=fs.readdirSync('/proc').filter(p=>Number.isSafeInteger(Number(p))).find(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split(String.fromCharCode(0)).includes('/app/dist/server/start.js')}catch{return false}});
if(!pid)throw new Error('APP_PROCESS_NOT_FOUND');process.kill(Number(pid),'SIGKILL');
`);
// Docker 重启策略异步执行；轮询只允许此隔离容器，最长两分钟。
for(let i=0;i<60;i++){const c=inspect();if(c.RestartCount>restarts&&c.State.Health?.Status==='healthy')break;await new Promise(resolve=>setTimeout(resolve,2000));}
assert.ok(inspect().RestartCount>restarts);assert.equal(inspect().State.Health.Status,'healthy');
assert.deepEqual(snapshot(),initial);
const responses=JSON.parse(ok(['exec',name,'node','-e',"(async()=>{const out={};for(const p of ['/api/health/live','/api/health/ready','/']){const r=await fetch('http://127.0.0.1:3000'+p);if(r.status!==200)throw Error(p);out[p]=p==='/'?200:await r.json()}console.log(JSON.stringify(out))})().catch(()=>process.exit(1))"]));
assert.equal(responses['/api/health/ready'].status,'ready');assert.equal(responses['/api/health/live'].build.revision,'cc4a34bac3458984d0a462aa593e89bedad94a44');
const processUids=JSON.parse(ok(['exec',name,'node','-e',"const f=require('fs'),out={};for(const p of f.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{const args=f.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0');const kind=args.includes('/app/dist/server/start.js')?'app':args[0]==='mysqld'?'mysql':null;if(kind)out[kind]=Number(f.readFileSync('/proc/'+p+'/status','utf8').match(/^Uid:\\s+(\\d+)/m)[1])}catch{}}console.log(JSON.stringify(out))"]));
assert.equal(processUids.app,1000);assert.equal(processUids.mysql,999);
const report={...initial,image:inspect().Image,containerCount:1,applicationFilesUnchanged:expectedFiles.length,sqlBackupRestored:true,repeatedSeedPreserved:true,existingDatabaseRejected:true,recreatedContainerPreserved:true,importDirectoryPersisted:true,appFailureRecovered:true,processUids,responses,passwordLoginTested:false,harborPushed:false};
fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
