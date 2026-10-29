import { migrateDatabase, verifyDatabase } from '../infrastructure/schema.js';

const [command, profile = 'dev_migrator'] = process.argv.slice(2);
try {
  if (!['dev_migrator', 'test_migrator', 'rds_migrator'].includes(profile)) throw Object.assign(new Error('DB_PROFILE_INVALID'), { code: 'DB_PROFILE_INVALID' });
  const target = profile as 'dev_migrator' | 'test_migrator' | 'rds_migrator';
  const result = command === 'migrate' ? await migrateDatabase(target)
    : command === 'verify' ? await verifyDatabase(target)
    : (() => { throw Object.assign(new Error('DB_COMMAND_INVALID'), { code: 'DB_COMMAND_INVALID' }); })();
  console.log(JSON.stringify({ status: 'verified', ...result }));
} catch (error) {
  const failure = error as { code?: string; migrationStep?: string; result?: string; differences?: unknown[] };
  console.error(JSON.stringify({ status: 'failed', code: failure.code ?? 'DB_COMMAND_FAILED', step: failure.migrationStep, result: failure.result, differences: failure.differences }));
  process.exitCode = 1;
}
