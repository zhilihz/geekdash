import type { FastifyInstance } from 'fastify';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import type { Notifications } from '../infrastructure/notifications.js';
import { catalog, validateCatalog } from '../modules/catalog.js';
import { failure } from '../modules/project-save.js';

export function registerCatalog(app: FastifyInstance, database?: RuntimeDatabase, notifications?: Notifications) {
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
  for (const action of ['preview','save','results/query']) app.post<{Params:{kind:string}}>('/api/catalog/:kind/'+action,async request=>{
    if (!request.actor) failure('AUTH_REQUIRED',401);
    if (!service) failure('DATABASE_UNAVAILABLE',503);
    const body=validateCatalog(request.params.kind,request.body);
    if(action==='preview')return service.preview(request.actor,request.params.kind,body);
    const value=await service.save(request.actor,request.params.kind,body,request.id,action === 'results/query');
    if(value.outcome==='committed'){
      const result=value.result;
      if(result.changed!==false)notifications?.resourceChanged({resource:'catalog',kind:request.params.kind,operationId:result.operationId});
      for(const project of result.affectedProjects)notifications?.projectChanged({projectId:project.projectId,savedVersion:project.version,operationId:result.operationId});
    }
    return value;
  });
}
