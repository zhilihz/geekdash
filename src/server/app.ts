import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { RuntimeDatabase } from './infrastructure/runtime-database.js';
import { registerProjectReads } from './routes/projects.js';
import { registerIdentity, readAuthConfig, type AuthConfig } from './routes/identity.js';
import { registerSettings } from './routes/settings.js';
import { registerPersonalState } from './routes/personal-state.js';
import { registerNotifications } from './infrastructure/notifications.js';
import { registerCatalog } from './routes/catalog.js';
import { registerImports } from './routes/imports.js';

export async function createApp(database?: RuntimeDatabase, auth?: AuthConfig) {
  const build = JSON.parse(await readFile(new URL('../build-info.json', import.meta.url), 'utf8'));
  const app = Fastify({
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
  });
  if (database && database.fact.version !== build.schemaVersion) throw Object.assign(new Error('BUILD_SCHEMA_VERSION_MISMATCH'), { code: 'BUILD_SCHEMA_VERSION_MISMATCH' });
  if (database) {
    app.addHook('preClose', async () => { database.beginClosing(); });
    app.addHook('onClose', async () => { await database.close(); });
    app.addHook('onRequest', async (request, reply) => {
      const path = request.url.split('?')[0];
      if (path.startsWith('/api/') && !['/api/health/live', '/api/health/ready'].includes(path)) {
        reply.header('Cache-Control', 'no-store');
        const result = await database.checkReadiness();
        if (!result.ready) return reply.code(503).send({ status: 'unavailable', code: 'DATABASE_UNAVAILABLE', reason: result.reason, outcome: 'not_committed', requestId: request.id });
      }
    });
  }

  app.get('/api/health/live', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { status: 'alive', stage: build.stage, build };
  });
  let previousReason: string | undefined;
  app.get('/api/health/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = database ? await database.checkReadiness() : { ready: false, reason: 'database_not_configured', code: undefined };
    if (result.reason !== previousReason) {
      if (!result.ready) app.log.warn({ code: result.code, reason: result.reason }, '数据库暂不可用');
      previousReason = result.reason;
    }
    return result.ready ? { status: 'ready' } : reply.code(503).send({ status: 'unavailable', reason: result.reason });
  });
  await app.register(staticFiles, {
    root: fileURLToPath(new URL('../web/', import.meta.url)),
    index: 'index.html',
    dotfiles: 'deny',
  });
  const notifications = registerNotifications(app, database);
  // 旧匿名回归仅在隔离 test 库运行；实际 dev 服务默认要求身份。
  if (database && (auth || database.fact.database !== 'geekdash_test')) registerIdentity(app, database, auth ?? readAuthConfig(), notifications);
  registerProjectReads(app, database, notifications);
  registerSettings(app, database, notifications);
  registerPersonalState(app, database);
  registerCatalog(app, database, notifications);
  registerImports(app, database, notifications);
  app.get('/GeekDash.html', (_request, reply) => reply.sendFile('index.html'));
  app.get('/chip-statistics.html', (_request, reply) => reply.redirect('/project-status-summary.html'));
  return app;
}
