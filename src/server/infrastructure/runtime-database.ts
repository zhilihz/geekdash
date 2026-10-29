import mysql, { type PoolConnection } from 'mysql2/promise';
import { readDatabaseConfig, validateDatabaseConnection } from './db.js';
import { loadSchema, verifySchemaConnection } from './schema.js';

export type RuntimeProfile = 'dev_app' | 'test_app' | 'rds_app';
type Readiness = { ready: boolean; reason?: string; code?: string };

export async function openRuntimeDatabase(profile: RuntimeProfile) {
  if (!['dev_app', 'test_app', 'rds_app'].includes(profile)) throw Object.assign(new Error('DB_RUNTIME_PROFILE_INVALID'), { code: 'DB_RUNTIME_PROFILE_INVALID' });
  const resource = await loadSchema();
  const config = await readDatabaseConfig(profile);
  const pool = mysql.createPool({ ...config, connectionLimit: 8, waitForConnections: false, connectTimeout: 3000 });
  let closing = false;
  let fullVerified = false;
  let lastSuccess = 0;
  let state: Readiness = { ready: false, reason: 'database_unavailable' };
  let pending: Promise<Readiness> | undefined;

  // 超时必须销毁实际连接；晚到的连接也不留在池里。
  async function useConnection<T>(milliseconds: number, work: (connection: PoolConnection) => Promise<T>) {
    let connection: PoolConnection | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        connection?.destroy();
        reject(Object.assign(new Error('DB_OPERATION_TIMEOUT'), { code: 'DB_OPERATION_TIMEOUT' }));
      }, milliseconds);
    });
    const operation = (async () => {
      connection = await pool.getConnection();
      if (expired) { connection.destroy(); throw new Error('DB_OPERATION_TIMEOUT'); }
      try { return await work(connection); }
      catch (error) { connection.destroy(); throw error; }
      finally { if (!expired) connection.release(); }
    })();
    try { return await Promise.race([operation, timeout]); }
    finally { clearTimeout(timer); }
  }

  let fact;
  try {
    fact = await useConnection(15000, async connection => {
      const identity = await validateDatabaseConnection(connection, profile, config);
      const structure = await verifySchemaConnection(connection, resource, true);
      return { ...identity, ...structure };
    });
    fullVerified = true;
    lastSuccess = performance.now();
    state = { ready: true };
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    pool, fact,
    async writeTransaction<T>(work: (connection: PoolConnection) => Promise<T>, preview = false): Promise<T> {
      let commitSent = false;
      try {
        return await useConnection(5000, async connection => {
          // 按项目行锁串行化；回执不存在时不锁住其他项目新回执的索引间隙。
          await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
          await connection.beginTransaction();
          let result: T;
          try { result = await work(connection); }
          catch (error) {
            try { await connection.rollback(); } catch { /* 未发送 COMMIT，连接销毁后事务回滚。 */ }
            const sqlError = error as { code?: string; sqlMessage?: string };
            if (sqlError.code === 'ER_DUP_ENTRY' && sqlError.sqlMessage?.includes('uk_projects_name_key')) {
              throw Object.assign(new Error('PROJECT_NAME_TAKEN'), { code: 'PROJECT_NAME_TAKEN', status: 409, fields: { name: '已有同名项目，请使用可区分的名称' } });
            }
            throw error;
          }
          if (preview) { await connection.rollback(); return result; }
          commitSent = true;
          await connection.commit();
          return result;
        });
      } catch (error) {
        if (commitSent) throw Object.assign(new Error('COMMIT_UNKNOWN'), { code: 'COMMIT_UNKNOWN' });
        throw error;
      }
    },
    async readSnapshot<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
      return useConnection(5000, async connection => {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        try {
          const result = await work(connection);
          await connection.commit();
          return result;
        } catch (error) {
          await connection.rollback();
          throw error;
        }
      });
    },
    async checkReadiness(): Promise<Readiness> {
      if (closing) return { ready: false, reason: 'closing' };
      if (pending) return pending;
      if (state.ready && performance.now() - lastSuccess < 2000) return state;
      // 故障恢复需要重验完整结构，不能复用轻量 SELECT 1 的三秒预算。
      pending = useConnection(fullVerified ? 3000 : 15000, async connection => {
        if (!fullVerified) await validateDatabaseConnection(connection, profile, config);
        await connection.query({ sql: 'SELECT 1', timeout: 3000 });
        await verifySchemaConnection(connection, resource, !fullVerified);
      }).then(() => {
        fullVerified = true;
        lastSuccess = performance.now();
        return state = closing ? { ready: false, reason: 'closing' } : { ready: true };
      }).catch((error: { code?: string; message?: string }) => {
        const busy = error.message === 'No connections available.';
        const incompatible = /^DB_(SCHEMA|MIGRATION_CHECKSUM|INDEX|COLUMN|CHECK|FOREIGN|IDENTITY|GRANTS)/.test(error.code ?? '') || error.code === 'ER_NO_SUCH_TABLE';
        if (!busy) fullVerified = false;
        return state = { ready: false, reason: closing ? 'closing' : busy ? 'database_busy' : incompatible ? 'schema_incompatible' : 'database_unavailable', code: busy ? 'DB_POOL_BUSY' : error.code ?? 'DB_CHECK_FAILED' };
      }).finally(() => { pending = undefined; });
      return pending;
    },
    beginClosing() { closing = true; },
    async close() {
      closing = true;
      if (pending) await pending;
      await pool.end();
    },
  };
}

export type RuntimeDatabase = Awaited<ReturnType<typeof openRuntimeDatabase>>;
