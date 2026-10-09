import { createApp } from './app.js';
import { readConfig } from './infrastructure/config.js';
import { openRuntimeDatabase, type RuntimeDatabase } from './infrastructure/runtime-database.js';
import { readAuthConfig } from './routes/identity.js';

let database: RuntimeDatabase | undefined;
try {
  const { databaseProfile, ...listen } = readConfig();
  database = await openRuntimeDatabase(databaseProfile);
  const app = await createApp(database, readAuthConfig());
  app.log.info({ database: database.fact.database, schemaVersion: database.fact.version }, '数据库已核验');
  let shuttingDown = false;
  const close = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    database!.beginClosing();
    const timeout = setTimeout(() => process.exit(1), 5000);
    timeout.unref();
    try {
      await app.close();
      clearTimeout(timeout);
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
  console.error(JSON.stringify({ status: 'startup_failed', code: failure.code ?? 'APP_START_FAILED', field: ['HOST', 'PORT', 'GEEKDASH_DB_PROFILE'].includes(failure.field ?? '') ? failure.field : undefined }));
  process.exitCode = 1;
}
