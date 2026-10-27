import type { FastifyInstance } from 'fastify';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import type { Notifications } from '../infrastructure/notifications.js';
import { publicSettings, validateRule, validatePolicy } from '../modules/public-settings.js';
import { failure } from '../modules/project-save.js';

export function registerSettings(app: FastifyInstance, database?: RuntimeDatabase, _notifications?: Notifications) {
  const settings = database ? publicSettings(database) : undefined;
  app.get('/api/settings/check-rule', request => {
    if (!request.actor) failure('AUTH_REQUIRED', 401);
    if (!settings) failure('DATABASE_UNAVAILABLE', 503);
    return settings.read(request.actor.id);
  });
  for(const confirm of [false,true])app.post(confirm?'/api/settings/check-policy/results/query':'/api/settings/check-policy',async request=>{
    if(!request.actor)failure('AUTH_REQUIRED',401);if(!settings)failure('DATABASE_UNAVAILABLE',503);
    const result=await settings.update(request.actor,validatePolicy(request.body),request.id,confirm);
    if(result.outcome==='committed')_notifications?.resourceChanged({resource:'check-rule',version:result.result.version,operationId:result.result.operationId});
    return result;
  });
  for (const confirm of [false, true]) app.post(confirm ? '/api/settings/check-rule/results/query' : '/api/settings/check-rule', async request => {
    if (!request.actor) failure('AUTH_REQUIRED', 401);
    if (!settings) failure('DATABASE_UNAVAILABLE', 503);
    return settings.save(request.actor, validateRule(request.body), request.id, confirm);
  });
}
