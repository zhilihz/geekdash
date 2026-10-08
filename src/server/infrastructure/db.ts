import { readFile } from 'node:fs/promises';
import mysql, { type RowDataPacket } from 'mysql2/promise';

const profiles = {
  dev_app: 'geekdash_dev', dev_migrator: 'geekdash_dev',
  test_app: 'geekdash_test', test_migrator: 'geekdash_test',
} as const;
export type DatabaseProfile = keyof typeof profiles;

// F02-A 只连接受控本地目标；业务连接池在 F04 接入时建立。
export async function connectDatabase(profile: DatabaseProfile) {
  if (!Object.hasOwn(profiles, profile)) throw Object.assign(new Error('数据库配置类别无效'), { code: 'DB_PROFILE_INVALID' });
  let config;
  try { config = JSON.parse(await readFile(`/run/secrets/${profile}`, 'utf8')); }
  catch { throw Object.assign(new Error('数据库凭据文件缺失或格式错误'), { code: 'DB_CONFIG_INVALID' }); }
  if (config?.host !== 'mysql' || config.port !== 3306 || config.database !== profiles[profile]
      || config.user !== `gd_${profile}` || typeof config.password !== 'string' || !config.password) {
    throw Object.assign(new Error('数据库目标或技术身份配置不符合本地隔离要求'), { code: 'DB_TARGET_INVALID' });
  }
  const connection = await mysql.createConnection({
    host: config.host, port: config.port, database: config.database,
    user: config.user, password: config.password,
    connectTimeout: 5000, charset: 'utf8mb4', timezone: 'Z',
    multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true,
  });
  try {
    await connection.query({ sql: "SET time_zone = '+00:00'", timeout: 5000 });
    const [rows] = await connection.query<RowDataPacket[]>({
      sql: 'SELECT DATABASE() AS db, CURRENT_USER() AS identity, VERSION() AS version, @@session.time_zone AS timezone',
      timeout: 5000,
    });
    const fact = rows[0];
    if (!fact || fact.db !== profiles[profile] || fact.identity !== `gd_${profile}@%`
        || !/^8\.4\./.test(fact.version) || fact.timezone !== '+00:00') {
      throw Object.assign(new Error('实际数据库、身份、版本或时区不符合目标'), { code: 'DB_IDENTITY_INVALID' });
    }
    const [grants] = await connection.query<RowDataPacket[]>({ sql: 'SHOW GRANTS', timeout: 5000 });
    const actual = grants.map(row => Object.values(row)[0] as string);
    const permissions = profile.endsWith('_app')
      ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
      : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES'];
    const scoped = actual.find(line => line.includes(` ON \`${profiles[profile]}\`.* TO `));
    const parsed = scoped?.match(/^GRANT (.+) ON /)?.[1].split(', ').sort();
    if (actual.length !== 2 || !actual.some(line => line.startsWith('GRANT USAGE ON *.* TO '))
        || scoped?.includes('WITH GRANT OPTION') || JSON.stringify(parsed) !== JSON.stringify(permissions.sort())) {
      throw Object.assign(new Error('数据库授权与技术身份用途不一致'), { code: 'DB_GRANTS_INVALID' });
    }
    return {
      connection,
      fact: { profile, database: fact.db, identity: fact.identity, serverVersion: fact.version, timezone: fact.timezone, grantsVerified: true },
    };
  } catch (error) {
    connection.destroy();
    throw error;
  }
}
