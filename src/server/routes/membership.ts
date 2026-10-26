import type { FastifyInstance } from 'fastify';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import type { Notifications } from '../infrastructure/notifications.js';
import { projectMembership, validateMembership } from '../modules/project-membership.js';
import { failure, validId } from '../modules/project-save.js';

export function registerMembership(app:FastifyInstance,database?:RuntimeDatabase,notifications?:Notifications) {
  const membership=database?projectMembership(database):undefined;
  for(const confirm of [false,true])app.post<{Params:{id:string};Body:unknown}>(confirm?'/api/projects/:id/membership-results/query':'/api/projects/:id/membership',async request=>{
    if(!request.actor)failure('AUTH_REQUIRED',401);
    if(!membership)failure('DATABASE_UNAVAILABLE',503);
    if(!validId(request.params.id))failure('INVALID_PROJECT_ID',400);
    const result=await membership.run(request.actor,request.params.id,validateMembership(request.body),request.id,confirm);
    if(result.outcome==='committed'){
      notifications?.projectChanged(result.result);
      notifications?.membershipChanged(request.params.id,[request.actor.id,result.result.targetUserId],result.result.operationId);
    }
    return {...result,requestId:request.id};
  });
  app.get<{Querystring:{before?:string}}>('/api/membership-requests',{schema:{querystring:{type:'object',additionalProperties:false,properties:{before:{type:'string',pattern:'^[1-9][0-9]{0,19}$'}}}}},request=>{
    if(!request.actor)failure('AUTH_REQUIRED',401);
    if(!membership)failure('DATABASE_UNAVAILABLE',503);
    if(request.query.before&&!validId(request.query.before))failure('INVALID_CURSOR',400);
    return membership.list(request.actor,request.query.before);
  });
}
