import type { FastifyInstance } from 'fastify';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { personalState } from '../modules/personal-state.js';
import { failure } from '../modules/project-save.js';

export function registerPersonalState(app: FastifyInstance, database?: RuntimeDatabase) {
  const state = database ? personalState(database) : undefined;
  app.addHook('preHandler',async request => {
    if (!request.url.startsWith('/api/personal/')) return;
    if (!request.actor) failure('AUTH_REQUIRED',401);
    if (!state) failure('DATABASE_UNAVAILABLE',503);
  });
  app.get<{ Querystring: { projectId?: string; clientDraftId?: string } }>('/api/personal/drafts', { schema: { querystring: { type:'object',additionalProperties:false,properties:{projectId:{type:'string'},clientDraftId:{type:'string'}} } } },request => state!.read(request.actor!,request.query.projectId === 'new' ? null : request.query.projectId,request.query.clientDraftId));
  app.post('/api/personal/drafts/save',{bodyLimit:1100000},request => state!.save(request.actor!,request.body));
  app.post('/api/personal/drafts/discard',request => state!.discard(request.actor!,request.body));
  app.get<{Querystring:{deviceKey:string;scope:string}}>('/api/personal/preferences',{schema:{querystring:{type:'object',additionalProperties:false,required:['deviceKey','scope'],properties:{deviceKey:{type:'string',maxLength:36},scope:{type:'string',maxLength:96}}}}},request => state!.preferences(request.actor!,request.query.deviceKey,request.query.scope));
  app.post('/api/personal/preferences/save',{bodyLimit:1100000},request => state!.savePreferences(request.actor!,request.body));
}
