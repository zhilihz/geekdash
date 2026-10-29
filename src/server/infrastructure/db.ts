import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { posix } from 'node:path';
import { isIP } from 'node:net';
import mysql, { type RowDataPacket } from 'mysql2/promise';

const profiles = {
  dev_app: 'geekdash_dev', dev_migrator: 'geekdash_dev',
  test_app: 'geekdash_test', test_migrator: 'geekdash_test',
  rds_app: null, rds_migrator: null,
} as const;
export type DatabaseProfile = keyof typeof profiles;
type Target = { host: string; port: number; database: string; user: string; password: string; caFile?: string };
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }

export function parseDatabaseTarget(profile: DatabaseProfile, value: unknown): Target {
  if (!Object.hasOwn(profiles, profile)) fail('DB_PROFILE_INVALID');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('DB_CONFIG_INVALID');
  const config = value as Record<string, unknown>;
  if (typeof config.password !== 'string' || !config.password) fail('DB_TARGET_INVALID');
  let caFile: string | undefined;
  if (profile.startsWith('rds_')) {
    if (typeof config.host !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(config.host) || isIP(config.host)
        || !Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65535
        || typeof config.database !== 'string' || !/^[A-Za-z0-9_$-]{1,64}$/.test(config.database)
        || ['mysql', 'sys', 'information_schema', 'performance_schema', 'geekdash_dev', 'geekdash_test'].includes(config.database.toLowerCase())
        || typeof config.user !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(config.user)
        || /^(root|gd_(dev|test)_(app|migrator))$/i.test(config.user)) fail('DB_TARGET_INVALID');
    const ssl = config.ssl as Record<string, unknown> | undefined;
    if (!ssl || Object.keys(ssl).some(key => key !== 'caFile') || typeof ssl.caFile !== 'string'
        || !ssl.caFile.startsWith('/run/secrets/') || posix.normalize(ssl.caFile) !== ssl.caFile) fail('DB_TLS_CONFIG_INVALID');
    caFile = ssl.caFile;
  } else if (config.host !== 'mysql' || config.port !== 3306 || config.database !== profiles[profile]
      || config.user !== `gd_${profile}`) {
    fail('DB_TARGET_INVALID');
  }
  return { host: config.host as string, port: config.port as number, database: config.database as string,
    user: config.user as string, password: config.password, ...(caFile ? { caFile } : {}) };
}

async function readTarget(profile: DatabaseProfile) {
  if (!Object.hasOwn(profiles, profile)) fail('DB_PROFILE_INVALID');
  let value: unknown;
  try { value = JSON.parse(await readFile(`/run/secrets/${profile}`, 'utf8')); }
  catch { fail('DB_CONFIG_INVALID'); }
  return parseDatabaseTarget(profile, value);
}

export async function readDatabaseConfig(profile: DatabaseProfile) {
  const { caFile, ...config } = await readTarget(profile);
  let ssl;
  if (caFile) {
    let ca: string;
    try {
      ca = await readFile(caFile, 'utf8');
      const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      if (!certificates?.length || certificates.some(pem => !new X509Certificate(pem).ca)) fail('DB_TLS_CA_INVALID');
    } catch { fail('DB_TLS_CA_INVALID'); }
    ssl = { ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' as const };
  }
  return {
    ...config, ...(ssl ? { ssl } : {}),
    connectTimeout: 5000, charset: 'utf8mb4', timezone: 'Z',
    multipleStatements: false, supportBigNumbers: true, bigNumberStrings: true,
  };
}

export function validateDatabaseGrants(grants: string[], profile: DatabaseProfile, database: string, partialRevokes = false) {
  const required = new Set(profile.endsWith('_app') ? ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
    : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'REFERENCES']);
  const found = new Set<string>();
  for (const line of grants) {
    const grant = /^GRANT (.+?) ON (.+?) TO /i.exec(line);
    if (!grant || /WITH GRANT OPTION/i.test(line)) fail('DB_GRANTS_INVALID');
    const privileges = grant[1].split(',').map(value => value.trim().toUpperCase());
    if (grant[2] === '*.*' && privileges.length === 1 && privileges[0] === 'USAGE') continue;
    const rawScope = grant[2].replace(/`/g, '');
    if (profile.startsWith('rds_') && !partialRevokes && /(^|[^\\])[_%]/.test(rawScope)) fail('DB_GRANTS_INVALID');
    const scope = profile.startsWith('rds_') && partialRevokes ? rawScope : rawScope.replace(/\\([_%])/g, '$1');
    if (scope !== `${database}.*` || privileges.some(value => !required.has(value))) fail('DB_GRANTS_INVALID');
    for (const value of privileges) found.add(value);
  }
  if ([...required].some(value => !found.has(value))) fail('DB_GRANTS_INVALID');
}

export async function validateDatabaseConnection(connection: mysql.Connection, profile: DatabaseProfile, target?: Pick<Target, 'database' | 'user'>) {
  if (!Object.hasOwn(profiles, profile)) fail('DB_PROFILE_INVALID');
  const expected = target ?? (profile.startsWith('rds_') ? await readTarget(profile) : { database: profiles[profile], user: `gd_${profile}` });
  await connection.query({ sql: "SET time_zone = '+00:00'", timeout: 5000 });
  const [rows] = await connection.query<RowDataPacket[]>({
    sql: 'SELECT DATABASE() AS db, CURRENT_USER() AS identity, VERSION() AS version, @@session.time_zone AS timezone'
      + (profile.startsWith('rds_') ? ', @@global.partial_revokes AS partialRevokes' : ''),
    timeout: 5000,
  });
  const fact = rows[0];
  const version = /^(\d+)\.(\d+)\.(\d+)(?:[-.]|$)/.exec(String(fact?.version));
  // CHECK 约束从 MySQL 8.0.16 起真正执行；版本门槛之外仍须完整迁移和结构核验。
  const compatible = version && !/mariadb/i.test(fact.version) && (Number(version[1]) > 8
    || Number(version[1]) === 8 && (Number(version[2]) > 0 || Number(version[3]) >= 16));
  if (!fact || fact.db !== expected.database || String(fact.identity).slice(0, String(fact.identity).lastIndexOf('@')) !== expected.user
      || !(profile.startsWith('rds_') ? compatible : /^8\.4\./.test(fact.version)) || fact.timezone !== '+00:00'
      || !profile.startsWith('rds_') && fact.identity !== `gd_${profile}@%`) fail('DB_IDENTITY_INVALID');
  if (profile.startsWith('rds_')) {
    const [tls] = await connection.query<RowDataPacket[]>({ sql: "SHOW SESSION STATUS LIKE 'Ssl_cipher'", timeout: 5000 });
    if (!tls[0]?.Value) fail('DB_TLS_REQUIRED');
  }
  const [grants] = await connection.query<RowDataPacket[]>({ sql: 'SHOW GRANTS', timeout: 5000 });
  const actual = grants.map(row => Object.values(row)[0] as string);
  validateDatabaseGrants(actual, profile, fact.db, Number(fact.partialRevokes) === 1);
  return { profile, database: fact.db, identity: fact.identity, serverVersion: fact.version, timezone: fact.timezone, grantsVerified: true };
}

export async function connectDatabase(profile: DatabaseProfile) {
  const config = await readDatabaseConfig(profile);
  const connection = await mysql.createConnection(config);
  try {
    return { connection, fact: await validateDatabaseConnection(connection, profile, config) };
  } catch (error) {
    connection.destroy();
    throw error;
  }
}
