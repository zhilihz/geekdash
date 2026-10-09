import type { FastifyInstance } from 'fastify';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { publicSettings, validateRule } from '../modules/public-settings.js';
import { failure } from '../modules/project-save.js';

export function registerSettings(app: FastifyInstance, database?: RuntimeDatabase) {
  const settings = database ? publicSettings(database) : undefined;
  app.get('/api/settings/check-rule', request => {
    if (!request.actor) failure('AUTH_REQUIRED', 401);
    if (!settings) failure('DATABASE_UNAVAILABLE', 503);
    return settings.read(request.actor.id);
  });
  for (const confirm of [false, true]) app.post(confirm ? '/api/settings/check-rule/results/query' : '/api/settings/check-rule', request => {
    if (!request.actor) failure('AUTH_REQUIRED', 401);
    if (!settings) failure('DATABASE_UNAVAILABLE', 503);
    return settings.save(request.actor, validateRule(request.body), request.id, confirm);
  });
}
