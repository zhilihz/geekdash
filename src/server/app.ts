import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function createApp() {
  const build = JSON.parse(await readFile(new URL('../build-info.json', import.meta.url), 'utf8'));
  const app = Fastify({
    logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] },
  });

  app.get('/api/health/live', async () => ({ status: 'alive', stage: 'foundation', build }));
  app.get('/api/health/ready', async (_request, reply) => {
    return reply.code(503).send({ status: 'unavailable', reason: 'database_not_implemented' });
  });
  await app.register(staticFiles, {
    root: fileURLToPath(new URL('../web/', import.meta.url)),
    index: 'index.html',
    dotfiles: 'deny',
  });
  return app;
}
