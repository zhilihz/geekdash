import staticFiles from '@fastify/static';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

export async function registerStaticPages(app: FastifyInstance) {
  await app.register(staticFiles, {
    root: fileURLToPath(new URL('../web/', import.meta.url)),
    index: 'index.html',
    dotfiles: 'deny',
  });
  app.get('/GeekDash.html', (_request, reply) => reply.sendFile('index.html'));
  app.get('/chip-statistics.html', (_request, reply) => reply.redirect('/project-status-summary.html'));
}
