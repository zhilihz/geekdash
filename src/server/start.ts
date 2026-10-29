import { createApp } from './app.js';
import { readConfig, readShutdownTimeout } from './infrastructure/config.js';
import { openRuntimeDatabase, type RuntimeDatabase } from './infrastructure/runtime-database.js';
import { readAuthConfig } from './routes/identity.js';

let database: RuntimeDatabase | undefined;
try {
  const { databaseProfile, ...listen } = readConfig();
  const shutdownTimeout = readShutdownTimeout();
  database = await openRuntimeDatabase(databaseProfile);
  const app = await createApp(database, readAuthConfig());
  app.log.info({ database: database.fact.database, schemaVersion: database.fact.version }, '数据库已核验');
  let shuttingDown = false;
  const close = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    database!.beginClosing();
    app.log.info({ timeoutMs: shutdownTimeout }, '停止接收请求，等待当前操作结束');
    const timeout = setTimeout(() => {
      app.log.error({ code: 'SHUTDOWN_TIMEOUT', timeoutMs: shutdownTimeout }, '关闭超时；未确认操作将按持久回执恢复');
      process.exit(1);
    }, shutdownTimeout);
    timeout.unref();
    try {
      await app.close();
      clearTimeout(timeout);
      app.log.info('服务已关闭');
    } catch (error) {
      app.log.error(error, '关闭失败');
      process.exitCode = 1;
    }
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await app.listen(listen);
} catch (error) {
  if (database) await database.close();
  const failure = error as { code?: string; field?: string };
  console.error(JSON.stringify({ status: 'startup_failed', code: failure.code ?? 'APP_START_FAILED', field: ['HOST', 'PORT', 'GEEKDASH_DB_PROFILE', 'GEEKDASH_SERVE_STATIC', 'GEEKDASH_TRUST_PROXY', 'GEEKDASH_SHUTDOWN_TIMEOUT_MS', 'GEEKDASH_MAINTENANCE_FILE'].includes(failure.field ?? '') ? failure.field : undefined }));
  process.exitCode = 1;
}
