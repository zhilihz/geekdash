import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RuntimeDatabase } from './runtime-database.js';
import { assertActor, type Actor } from '../modules/identity.js';
import { failure, validId } from '../modules/project-save.js';

const uuid = (value:unknown):value is string => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
type Viewer={actor:Actor;instanceId:string;projectId?:string;reply:FastifyReply};
type Editor={actor:Actor;projectId:string;until:number};
export type ResourceNotification={resource:'catalog';kind:string;operationId:string}|{resource:'check-rule';version:string;operationId:string};
export type Notifications=ReturnType<typeof registerNotifications>;

// 单进程短期通知；正式项目和原请求回执仍是唯一保存依据。
export function registerNotifications(app:FastifyInstance,database?:RuntimeDatabase){
  const viewers=new Map<string,Viewer>(),editors=new Map<string,Editor>(),epoch=randomUUID();
  const key=(actor:Actor,instance:string)=>actor.tokenHash.toString('hex')+':'+instance;
  let closing=false,ticking=false;
  function send(viewer:Viewer,event:string,data:unknown){
    if(viewer.reply.raw.destroyed || viewer.reply.raw.writableEnded)return;
    if(viewer.reply.raw.writableLength>65536){viewer.reply.raw.end();return;}
    viewer.reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function names(projectId:string){return [...new Map([...editors.values()].filter(item=>item.projectId===projectId && item.until>Date.now()).map(item=>[item.actor.id,{id:item.actor.id,name:item.actor.name}])).values()];}
  async function presence(projectId:string){if(closing)return;for(const viewer of [...viewers.values()])if((!viewer.projectId || viewer.projectId===projectId) && await valid(viewer))send(viewer,'editors',{projectId,users:names(projectId)});}
  function remove(id:string,viewer:Viewer){
    if(viewers.get(id)!==viewer)return;viewers.delete(id);const previous=editors.get(id);editors.delete(id);
    if(previous)void presence(previous.projectId).catch(()=>{});
  }
  async function valid(viewer:Viewer){
    try{await database!.readSnapshot(async c=>{await assertActor(c,viewer.actor,false,new Date(),false,false);});return true;}
    catch{send(viewer,'unavailable',{});viewer.reply.raw.end();remove(key(viewer.actor,viewer.instanceId),viewer);return false;}
  }
  app.get<{Querystring:{accountId:string;instanceId:string;projectId?:string}}>('/api/events',{
    schema:{querystring:{type:'object',additionalProperties:false,required:['accountId','instanceId'],properties:{accountId:{type:'string'},instanceId:{type:'string'},projectId:{type:'string'}}}},
  },async(request,reply)=>{
    if(!database)failure('DATABASE_UNAVAILABLE',503);if(!request.actor)failure('AUTH_REQUIRED',401);
    if(!uuid(request.query.instanceId) || request.query.projectId!==undefined && !validId(request.query.projectId))failure('INVALID_NOTIFICATION_CONTEXT',400);
    if(request.query.projectId){const [found]=await database!.readSnapshot(c=>c.query('SELECT id FROM projects WHERE id=?',[request.query.projectId]));if(!(found as unknown[]).length)failure('PROJECT_NOT_FOUND',404);}
    if(closing)failure('DATABASE_UNAVAILABLE',503);
    const viewer:Viewer={actor:request.actor!,instanceId:request.query.instanceId,projectId:request.query.projectId,reply};
    const id=key(viewer.actor,viewer.instanceId),previous=viewers.get(id);if(previous){previous.reply.raw.end();remove(id,previous);}
    reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','Connection':'keep-alive'});
    viewers.set(id,viewer);reply.raw.on('close',()=>remove(id,viewer));send(viewer,'connected',{epoch});
    if(viewer.projectId)send(viewer,'editors',{projectId:viewer.projectId,users:names(viewer.projectId)});
    else for(const projectId of new Set([...editors.values()].filter(item=>item.until>Date.now()).map(item=>item.projectId)))send(viewer,'editors',{projectId,users:names(projectId)});
  });
  app.post<{Body:{projectId:string;instanceId:string;editing:boolean}}>('/api/editing',{
    bodyLimit:1024,schema:{body:{type:'object',additionalProperties:false,required:['projectId','instanceId','editing'],properties:{projectId:{type:'string'},instanceId:{type:'string'},editing:{type:'boolean'}}}},
  },async request=>{
    if(!database)failure('DATABASE_UNAVAILABLE',503);if(!request.actor)failure('AUTH_REQUIRED',401);
    const body=request.body;if(!validId(body.projectId) || !uuid(body.instanceId))failure('INVALID_NOTIFICATION_CONTEXT',400);
    const id=key(request.actor!,body.instanceId),previous=editors.get(id);
    if(body.editing){
      await database!.readSnapshot(async c=>{await assertActor(c,request.actor!,false,new Date(),false,false);const [found]=await c.query('SELECT project_id FROM project_responsibilities WHERE project_id=? AND user_id=?',[body.projectId,request.actor!.id]);if(!(found as unknown[]).length)failure('PROJECT_READ_ONLY',403);});
      editors.set(id,{actor:request.actor!,projectId:body.projectId,until:Date.now()+75000});
    }else if(previous?.projectId===body.projectId)editors.delete(id);
    if(previous && previous.projectId!==body.projectId && body.editing)await presence(previous.projectId);
    await presence(body.projectId);return {status:body.editing?'editing':'ended'};
  });
  async function publish(projectId:string,version:string,operationId:string){
    for(const [id,item] of editors)if(item.projectId===projectId){const [found]=await database!.readSnapshot(c=>c.query('SELECT project_id FROM project_responsibilities WHERE project_id=? AND user_id=?',[projectId,item.actor.id]));if(!(found as unknown[]).length)editors.delete(id);}
    for(const viewer of [...viewers.values()])if(await valid(viewer))send(viewer,'project',{projectId,version,operationId});
    await presence(projectId);
  }
  // 由写入口在事务提交或回执确认后显式调用；通知失败不改变已提交结果。
  function dispatch(work:()=>Promise<void>){void work().catch(()=>{app.log.warn('变更通知未发送，客户端需重新读取');});}
  const timer=setInterval(()=>{if(ticking || closing)return;ticking=true;void(async()=>{
    const changed=new Set<string>();for(const [id,item] of editors)if(item.until<=Date.now()){editors.delete(id);changed.add(item.projectId);}
    for(const viewer of [...viewers.values()])if(await valid(viewer)){
      const id=key(viewer.actor,viewer.instanceId),editor=editors.get(id);
      if(editor){const [found]=await database!.readSnapshot(c=>c.query('SELECT project_id FROM project_responsibilities WHERE project_id=? AND user_id=?',[editor.projectId,editor.actor.id]));if(!(found as unknown[]).length){editors.delete(id);changed.add(editor.projectId);}}
      send(viewer,'heartbeat',{});
    }
    for(const projectId of changed)await presence(projectId);
  })().catch(()=>{}).finally(()=>{ticking=false;});},15000);timer.unref();
  app.addHook('preClose',async()=>{closing=true;clearInterval(timer);for(const viewer of viewers.values())viewer.reply.raw.end();viewers.clear();editors.clear();});
  return {
    projectChanged(result:{projectId:string;savedVersion:string;operationId:string;changed?:boolean}){
      if(result.changed===false || !validId(result.projectId) || !validId(result.savedVersion) || !uuid(result.operationId))return;
      dispatch(()=>publish(result.projectId,result.savedVersion,result.operationId));
    },
    resourceChanged(event:ResourceNotification){
      dispatch(async()=>{for(const viewer of [...viewers.values()])if(await valid(viewer))send(viewer,'resource',event);});
    },
    identityChanged(actor:Actor,allSessions=false){
      dispatch(async()=>{
        for(const [id,viewer] of viewers)if(allSessions ? viewer.actor.id===actor.id : viewer.actor.tokenHash.equals(actor.tokenHash)){send(viewer,'identity',{});viewer.reply.raw.end();remove(id,viewer);}
        for(const [id,item] of editors)if(allSessions ? item.actor.id===actor.id : item.actor.tokenHash.equals(actor.tokenHash)){editors.delete(id);void presence(item.projectId).catch(()=>{});}
      });
    },
  };
}
