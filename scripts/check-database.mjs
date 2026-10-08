import { connectDatabase } from '../dist/server/infrastructure/db.js';

try {
  const targets = [];
  for (const profile of ['dev_app', 'dev_migrator', 'test_app', 'test_migrator']) {
    const { connection, fact } = await connectDatabase(profile);
    try { targets.push(fact); }
    finally { await connection.end(); }
  }
  console.log(JSON.stringify({ status: 'verified', targets, businessSchemaChecked: false, businessReady: false }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', reason: error.code ?? 'DB_CHECK_FAILED' }));
  process.exitCode = 1;
}
