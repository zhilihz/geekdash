import type { FastifyInstance } from 'fastify';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { projectReads, type ProjectQuery } from '../modules/projects.js';

export function registerProjectReads(app: FastifyInstance, database?: RuntimeDatabase) {
  const reads = database ? projectReads(database) : undefined;
  const properties: Record<string, unknown> = {};
  for (const key of ['search', 'customer', 'productLine', 'odmFactory', 'app', 'group', 'chip', 'tags', 'owner']) properties[key] = { type: 'string', maxLength: 255 };
  properties.view = { type: 'string', enum: ['active', 'proposal', 'closed', 'maintenance', 'all'] };
  properties.status = { type: 'string', enum: ['proposal', 'ongoing', 'paused', 'closed'] };
  properties.priority = { type: 'string', enum: ['high', 'mid', 'low'] };
  properties.signal = { type: 'string', enum: ['green', 'yellow', 'red'] };
  properties.stage = { type: 'string', enum: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'completed', 'unconfigured'] };
  properties.progress = { type: 'string', enum: ['0', '5', '10', '20', '60', '80', '90', '100'] };
  properties.page = { type: 'integer', minimum: 1, maximum: 1000000 };
  properties.pageSize = { type: 'integer', minimum: 1, maximum: 100 };
  const options = { schema: { querystring: { type: 'object', additionalProperties: false, properties } } };
  app.get<{ Querystring: ProjectQuery }>('/api/projects', options, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!reads) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE' });
    try { return await reads.list(request.query); }
    catch (error) { app.log.warn({ code: (error as { code?: string }).code }, '项目查询未完成'); return reply.code(503).send({ code: 'PROJECT_READ_UNAVAILABLE' }); }
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (BigInt(request.params.id) > 18446744073709551615n) return reply.code(400).send({ code: 'INVALID_PROJECT_ID' });
    if (!reads) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE' });
    try {
      const result = await reads.detail(request.params.id);
      return result ?? reply.code(404).send({ code: 'PROJECT_NOT_FOUND' });
    } catch (error) { app.log.warn({ code: (error as { code?: string }).code }, '项目详情未完成'); return reply.code(503).send({ code: 'PROJECT_READ_UNAVAILABLE' }); }
  });
}
