import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import type { Notifications } from '../infrastructure/notifications.js';
import { imports, importFileLimit } from '../modules/imports.js';
import { failure } from '../modules/project-save.js';

export function registerImports(app:FastifyInstance,database?:RuntimeDatabase,notifications?:Notifications) {
  const service=database?imports(database):undefined;
  const available=()=>{if(!service)failure('DATABASE_UNAVAILABLE',503);return service;};
  const writable=()=>{if(process.env.GEEKDASH_IMPORT_WRITES==='disabled')failure('IMPORT_WRITES_PAUSED',503);};
  // 返回原流，身份/CSRF通过后才将文件写入受控卷。
  app.addContentTypeParser('application/octet-stream',(_request,payload,done)=>done(null,payload));
  app.get('/api/imports',request=>{if(!request.actor)failure('AUTH_REQUIRED',401);return available().list(request.actor);});
  app.post('/api/imports/sources',{bodyLimit:4096},request=>{if(!request.actor)failure('AUTH_REQUIRED',401);writable();return available().createSource(request.actor,request.body);});
  app.post<{Querystring:{source:string;name:string;operation:string;new?:string}}>('/api/imports/upload',{bodyLimit:importFileLimit},request=>{
    if(!request.actor)failure('AUTH_REQUIRED',401);
    writable();
    if(request.headers['content-type']?.split(';')[0]!=='application/octet-stream')failure('INVALID_IMPORT_UPLOAD',415);
    return available().upload(request.actor,request.query,request.body as Readable);
  });
  app.post<{Body:{idempotencyKey:string}}>('/api/imports/results/query',{bodyLimit:4096},request=>{if(!request.actor)failure('AUTH_REQUIRED',401);return available().query(request.actor,request.body?.idempotencyKey);});
  app.get<{Params:{batchId:string}}>('/api/imports/:batchId',request=>{if(!request.actor)failure('AUTH_REQUIRED',401);return available().read(request.actor,request.params.batchId);});
  app.get<{Params:{batchId:string;itemId:string}}>('/api/imports/:batchId/items/:itemId/source',request=>{if(!request.actor)failure('AUTH_REQUIRED',401);return available().sourceItem(request.actor,request.params.batchId,request.params.itemId);});
  app.get<{Params:{batchId:string;itemId:string;adoptionId:string}}>('/api/imports/:batchId/items/:itemId/adoptions/:adoptionId',request=>{if(!request.actor)failure('AUTH_REQUIRED',401);return available().sourceItem(request.actor,request.params.batchId,request.params.itemId,request.params.adoptionId);});
  for(const action of ['source','takeover'] as const)for(const query of [false,true])app.post<{Params:{batchId:string}}>('/api/imports/:batchId/'+action+(query?'/results/query':''),{bodyLimit:4096},request=>{
    if(!request.actor)failure('AUTH_REQUIRED',401);if(!query)writable();return available().changeBatch(request.actor,request.params.batchId,action,request.body,request.id,query);
  });
  for(const action of ['preview','review','adopt','results/query'] as const)app.post<{Params:{batchId:string;itemId:string}}>('/api/imports/:batchId/items/:itemId/'+action,{bodyLimit:4*1024*1024},async request=>{
    if(!request.actor)failure('AUTH_REQUIRED',401);
    if(process.env.GEEKDASH_IMPORT_WRITES==='disabled' && action!=='preview' && action!=='results/query')failure('IMPORT_WRITES_PAUSED',503);
    const value=await available().item(request.actor,request.params.batchId,request.params.itemId,action,request.body,request.id);
    if('outcome' in value && value.outcome==='committed') {
      const result=value.result;
      if(result.projectId)notifications?.projectChanged(result);
      for(const project of result.affectedProjects ?? [])notifications?.projectChanged({projectId:project.projectId,savedVersion:project.version,operationId:result.operationId});
      if(result.id && result.changed)notifications?.resourceChanged({resource:'catalog',kind:result.catalogKind,operationId:result.operationId});
    }
    return value;
  });
}
