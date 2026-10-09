import type { FastifyInstance } from 'fastify';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { projectReads, type ProjectQuery } from '../modules/projects.js';
import { projectSaves, validateSave, validId, type SaveRequest } from '../modules/project-save.js';

export function registerProjectReads(app: FastifyInstance, database?: RuntimeDatabase) {
  const reads = database ? projectReads(database) : undefined;
  const saves = database ? projectSaves(database) : undefined;
  // 不接受浏览器提供的身份、范围或额外业务字段；错误响应不回显正文。
  async function saveHandler(request: { params: { id: string }; body: unknown; id: string }, reply: import('fastify').FastifyReply, confirm: boolean) {
    reply.header('Cache-Control', 'no-store');
    if (!validId(request.params.id)) return reply.code(400).send({ code: 'INVALID_PROJECT_ID' });
    if (!saves) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE', outcome: 'not_committed' });
    try {
      const input: SaveRequest = validateSave(request.body);
      const result = confirm ? await saves.confirm(request.params.id, input) : await saves.save(request.params.id, input, request.id);
      return confirm ? { ...result, requestId: request.id } : { outcome: 'committed', result, requestId: request.id };
    } catch (error) {
      const failure = error as { status?: number; code?: string; fields?: unknown; currentVersion?: string; message?: string };
      const unknown = failure.code === 'COMMIT_UNKNOWN';
      const status = failure.status ?? (unknown || failure.code === 'DB_OPERATION_TIMEOUT' || failure.message === 'No connections available.' || /^PROTOCOL_|^ECONN|^ER_LOCK_/.test(failure.code ?? '') ? 503 : 500);
      if (!failure.status) app.log.warn({ code: failure.code ?? 'SAVE_FAILED' }, '项目保存或结果确认未完成');
      return reply.code(status).send({ code: failure.status ? failure.code : unknown ? 'COMMIT_UNKNOWN' : status === 503 ? 'DATABASE_UNAVAILABLE' : 'SAVE_ROLLED_BACK',
        outcome: confirm || unknown ? 'unknown' : 'not_committed', fields: failure.fields, currentVersion: failure.currentVersion, requestId: request.id });
    }
  }
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/projects/:id', (request, reply) => saveHandler(request, reply, false));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/projects/:id/save-results/query', (request, reply) => saveHandler(request, reply, true));
  app.get<{ Params: { id: string }; Querystring: { pageSize?: number; before?: string } }>('/api/projects/:id/audit', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { pageSize: { type: 'integer', minimum: 1, maximum: 100 }, before: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!validId(request.params.id) || request.query.before && !validId(request.query.before)) return reply.code(400).send({ code: 'INVALID_CURSOR_OR_PROJECT' });
    if (!saves) return reply.code(503).send({ code: 'DATABASE_UNAVAILABLE' });
    try { return await saves.audit(request.params.id, request.query.pageSize ?? 20, request.query.before); }
    catch (error) { const failure = error as { status?: number; code?: string }; return reply.code(failure.status ?? 503).send({ code: failure.code ?? 'AUDIT_UNAVAILABLE' }); }
  });
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
