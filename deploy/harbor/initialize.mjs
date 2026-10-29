import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const required = ['mysql_root', 'mysql_health.cnf', 'bootstrap.sql', 'dev_app.json', 'dev_migrator.json', 'admin-account.json'];
const state = '/var/lib/mysql';
function checkAccount(account) {
  if (account.login_name !== 'admin' || account.enabled !== 1 || account.is_admin !== 1
      || ![0, 1].includes(account.is_project_manager) || ![0, 1].includes(account.must_change_password)
      || typeof account.display_name !== 'string'
      || !/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(account.password_hash)) {
    throw new Error('ADMIN_ACCOUNT_INVALID');
  }
  return account;
}

function prepare() {
  const origin = process.env.GEEKDASH_ORIGIN;
  const url = new URL(origin);
  if (url.origin !== origin || (!['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol !== 'https:')) throw new Error('AUTH_CONFIG_INVALID');
  if (fs.existsSync(state + '/config')) {
    if (required.some(name => !fs.existsSync(state + '/config/' + name)) || !fs.existsSync(state + '/mysql-data') || !fs.existsSync(state + '/imports')) throw new Error('EXISTING_STATE_INCOMPLETE');
    console.log('复用已有配置；不覆盖数据库密码或账号密码。');
    return;
  }
  if (fs.readdirSync(state).length) throw new Error('STATE_NOT_EMPTY');
  const account = checkAccount(JSON.parse(fs.readFileSync('/run/seed/admin-account.json', 'utf8')));
  const password = () => randomBytes(32).toString('hex');
  const rootPassword = password();
  const files = { mysql_root: rootPassword, 'mysql_health.cnf': `[client]\nuser=root\npassword=${rootPassword}\n`, 'admin-account.json': JSON.stringify(account) };
  let sql = 'CREATE DATABASE geekdash_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\n';
  for (const role of ['app', 'migrator']) {
    const user = `gd_dev_${role}`, secret = password();
    files[`dev_${role}.json`] = JSON.stringify({ host: 'mysql', port: 3306, database: 'geekdash_dev', user, password: secret });
    const grants = 'SELECT, INSERT, UPDATE, DELETE' + (role === 'migrator' ? ', CREATE, DROP, ALTER, INDEX, REFERENCES' : '');
    sql += `CREATE USER '${user}'@'%' IDENTIFIED BY '${secret}';\nGRANT ${grants} ON geekdash_dev.* TO '${user}'@'%';\n`;
  }
  files['bootstrap.sql'] = sql;
  fs.mkdirSync(state + '/config.pending', { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    const file = state + '/config.pending/' + name;
    fs.writeFileSync(file, content + '\n', { mode: 0o400, flag: 'wx' });
    fs.chownSync(file, name.endsWith('.json') ? 1000 : 999, name.endsWith('.json') ? 1000 : 999);
  }
  fs.mkdirSync(state + '/mysql-data', { mode: 0o700 });
  fs.mkdirSync(state + '/imports', { mode: 0o700 });
  fs.chownSync(state + '/imports', 1000, 1000);
  fs.renameSync(state + '/config.pending', state + '/config');
  console.log('已生成独立数据库凭据；业务账号凭据保存在受控文件中。');
}

async function seed() {
  const account = checkAccount(JSON.parse(fs.readFileSync('/run/secrets/admin_account', 'utf8')));
  const { connectDatabase } = await import('/app/dist/server/infrastructure/db.js');
  const { migrateDatabase, verifyDatabase } = await import('/app/dist/server/infrastructure/schema.js');
  const { connection: c } = await connectDatabase('dev_migrator');
  try {
    const [lock] = await c.query("SELECT GET_LOCK('geekdash.harbor.initialize', 10) acquired");
    if (Number(lock[0].acquired) !== 1) throw new Error('INITIALIZE_BUSY');
    const [tables] = await c.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');
    if (tables.some(t => t.name === 'audit_log')) {
      const [initialized] = await c.query("SELECT id FROM audit_log WHERE action='identity.harbor.initialize' AND request_id='harbor-cc4a34b' LIMIT 1");
      if (initialized.length) {
        await verifyDatabase('dev_migrator');
        console.log('数据库已初始化并核验通过；不修改既有账号和业务数据。');
        return;
      }
    }
    // 只初始化空库；绝不为制作空白环境而清空既有业务数据。
    for (const { name } of tables) {
      if (name === 'schema_migrations') continue;
      const [rows] = await c.query('SELECT 1 FROM `' + name.replaceAll('`', '``') + '` LIMIT 1');
      if (rows.length) throw new Error('DATABASE_NOT_EMPTY');
    }
    await migrateDatabase('dev_migrator');
    await c.beginTransaction();
    const [insert] = await c.execute('INSERT INTO users(login_name,password_hash,display_name,enabled,must_change_password,is_admin,is_project_manager,created_at,updated_at) VALUES (?,?,?,?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',
      [account.login_name, account.password_hash, account.display_name, account.enabled, account.must_change_password, account.is_admin, account.is_project_manager]);
    await c.execute("INSERT INTO system_configuration(id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3))", [insert.insertId, insert.insertId]);
    await c.execute("INSERT INTO audit_log(actor_kind,actor_display_name,action,entity_type,entity_id,before_json,after_json,request_id,created_at) VALUES ('system','部署初始化','identity.harbor.initialize','user',?,'null','{\"loginName\":\"admin\"}','harbor-cc4a34b',UTC_TIMESTAMP(3))", [insert.insertId]);
    await c.commit();
    console.log('初始化完成：仅 admin 账号及必要系统配置；项目、资料、导入记录和旧历史均未迁移。');
  } catch (error) { await c.rollback(); throw error; }
  finally { await c.query("SELECT RELEASE_LOCK('geekdash.harbor.initialize')"); await c.end(); }
}

try {
  if (process.argv[2] === 'prepare') prepare();
  else if (process.argv[2] === 'seed') await seed();
  else throw new Error('INITIALIZE_COMMAND_INVALID');
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? error.message }));
  process.exitCode = 1;
}
