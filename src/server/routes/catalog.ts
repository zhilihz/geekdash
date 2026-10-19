import type { FastifyInstance } from 'fastify';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { catalog, validateCatalog } from '../modules/catalog.js';
import { failure } from '../modules/project-save.js';

export function registerCatalog(app: FastifyInstance, database?: RuntimeDatabase) {
  const service=database ? catalog(database) : undefined;
  app.get<{Params:{kind:string}}>('/api/catalog/:kind',request=>{
    if (!request.actor) failure('AUTH_REQUIRED',401);
    if (!service) failure('DATABASE_UNAVAILABLE',503);
    return service.read(request.actor,request.params.kind);
  });
  app.get<{Params:{kind:string;id:string}}>('/api/catalog/:kind/:id',request=>{
    if (!request.actor) failure('AUTH_REQUIRED',401);
    if (!service) failure('DATABASE_UNAVAILABLE',503);
    return service.detail(request.actor,request.params.kind,request.params.id);
  });
  for (const action of ['preview','save','results/query']) app.post<{Params:{kind:string}}>('/api/catalog/:kind/'+action,request=>{
    if (!request.actor) failure('AUTH_REQUIRED',401);
    if (!service) failure('DATABASE_UNAVAILABLE',503);
    const body=validateCatalog(request.params.kind,request.body);
    return action === 'preview' ? service.preview(request.actor,request.params.kind,body) : service.save(request.actor,request.params.kind,body,request.id,action === 'results/query');
  });
}
