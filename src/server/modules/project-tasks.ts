import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { failure } from './project-save.js';
import { projectStatusEntries, type StatusEntry, type StatusChange } from './project-status-entries.js';
import { statusSourceBaselines } from './project-source-history.js';
import { validDate } from './project-dates.js';

export type ProjectTask = { id:string; text:string; createdAt:string; updatedAt:string; completedAt:string; deletedAt:string };
export type TaskOperation = { op:'add'; id:string; text:string } | { op:'edit'; id:string; text:string } | { op:'complete'|'reopen'|'delete'; id:string };
const rows = async(c:PoolConnection,sql:string,values:unknown[]=[]) => (await c.query<RowDataPacket[]>(sql,values))[0];
// 内容日期只取已采用的来源事实或真实说明/任务操作；不使用整项目updated_at。
export async function attachContentDates(c:PoolConnection,projects:RowDataPacket[]) {
  if(!projects.length)return;
  const ids=projects.map(project=>project.id),dates=new Map<string,string[]>(),versions=new Map<string,string>();
  const add=(id:string,...values:unknown[])=>dates.set(id,[...(dates.get(id)??[]),...values.filter((value):value is string=>typeof value==='string')]);
  const sources=await rows(c,`SELECT CAST(a.target_id AS CHAR) projectId,CAST(a.version_after AS CHAR) version,a.adopted_json facts,i.source_payload_json source FROM import_adoptions a JOIN import_items i ON i.id=a.item_id JOIN
    (SELECT MAX(id) id FROM import_adoptions WHERE target_kind='project' AND target_id IN (?) AND JSON_CONTAINS_PATH(adopted_json,'one','$.tasks','$.statusDescriptionBaseline') GROUP BY target_id) latest ON latest.id=a.id`,[ids]);
  for(const source of sources){
    const facts=typeof source.facts==='string'?JSON.parse(source.facts):source.facts,raw=typeof source.source==='string'?JSON.parse(source.source):source.source;
    versions.set(source.projectId,source.version);
    add(source.projectId,...(facts.tasks??[]).flatMap((task:ProjectTask)=>[task.updatedAt,task.completedAt,task.deletedAt]),...(facts.statusEntries??[]).map((entry:StatusEntry)=>entry.date));
    if(facts.tasks)add(source.projectId,raw.tasksUpdatedAt);else add(source.projectId,raw.statusDescUpdatedAt);
  }
  const tasks=await rows(c,'SELECT CAST(project_id AS CHAR) projectId,updated_at_text updatedAt,completed_at_text completedAt,deleted_at_text deletedAt FROM project_tasks WHERE project_id IN (?)',[ids]);
  for(const task of tasks)add(task.projectId,task.updatedAt,task.completedAt,task.deletedAt);
  const audits=await rows(c,`SELECT CAST(project_id AS CHAR) projectId,CAST(version_after AS CHAR) version,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') at FROM audit_log WHERE project_id IN (?) AND entity_type='project' AND action<>'project.import' AND
    (action='project.tasks.save' OR JSON_TYPE(JSON_EXTRACT(after_json,'$.statusDesc'))='STRING' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(before_json,'$.statusDesc')),'')<>JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.statusDesc')))`,[ids]);
  for(const audit of audits)if(!versions.has(audit.projectId)||BigInt(audit.version)>BigInt(versions.get(audit.projectId)!))add(audit.projectId,audit.at);
  for(const project of projects){
    add(project.id,...(project.statusEntries??[]).map((entry:StatusEntry)=>entry.date));
    const known=(dates.get(project.id)??[]).map(raw=>{
      const dateOnly=/^\d{4}-\d\d-\d\d$/.test(raw),timestamp=/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?$/.test(raw);
      const time=!validDate(raw.slice(0,10))?NaN:dateOnly?Date.parse(raw+'T00:00:00+08:00'):timestamp?Date.parse(raw.replace(' ','T')+(/(?:Z|[+-]\d\d:\d\d)$/.test(raw)?'':'+08:00')):NaN;
      return {raw,time};
    }).filter(value=>Number.isFinite(value.time)).sort((a,b)=>b.time-a.time)[0];
    project.contentUpdatedAt=known?(known.raw.length===10?known.raw:new Date(known.time).toISOString()):'';
    project.contentUpdatedOn=known?new Date(known.time+8*3600_000).toISOString().slice(0,10):'';
  }
}
const stripNumber=(text:string)=>text.replace(/^\s*\d+[、.．)）]\s*/, '').trim();
export const taskDescription=(tasks:ProjectTask[])=>tasks.filter(t=>!t.deletedAt&&!t.completedAt).map((t,i)=>`${i+1}、${t.text}`).join('\n');
export function sourceTasks(value:unknown):ProjectTask[] {
  if(!Array.isArray(value))failure('INVALID_IMPORT_TASKS',422,{fields:{tasks:'任务应为列表，请核对备份中的任务内容。'}});
  const tasks=value.map((raw,index)=>{
    if(!raw||typeof raw.text!=='string'||!raw.text.trim()||!raw.text.isWellFormed()||Buffer.byteLength(raw.text,'utf8')>65535)failure('INVALID_IMPORT_TASKS',422,{fields:{tasks:'任务内容不能为空或超出文字长度。'}});
    const id=String(raw.id??'source-'+createHash('sha256').update(JSON.stringify([index,raw])).digest('hex').slice(0,32));
    if(!id||!id.isWellFormed()||[...id].length>128)failure('INVALID_IMPORT_TASKS',422,{fields:{tasks:'任务编号无效。'}});
    const task:ProjectTask={id,text:raw.text.trim(),createdAt:'',updatedAt:'',completedAt:'',deletedAt:''};
    for(const key of ['createdAt','updatedAt','completedAt','deletedAt'] as const)if(raw[key]!=null){if(typeof raw[key]!=='string'||!raw[key].isWellFormed()||[...raw[key]].length>128)failure('INVALID_IMPORT_TASKS',422,{fields:{tasks:'任务时间格式无效。'}});task[key]=raw[key];}
    return task;
  });
  if(new Set(tasks.map(t=>t.id)).size!==tasks.length)failure('INVALID_IMPORT_TASKS',422,{fields:{tasks:'备份中存在重复的任务编号，请修正后导入。'}});
  return tasks;
}
export function textTaskOperations(before:ProjectTask[],text:string):TaskOperation[] {
  const available=before.filter(t=>!t.completedAt&&!t.deletedAt),used=new Set<string>(),ops:TaskOperation[]=[];
  for(const line of text.replace(/\r\n?/g,'\n').split('\n').map(stripNumber).filter(Boolean)){
    const old=available.find(t=>!used.has(t.id)&&t.text===line);
    if(old)used.add(old.id);else ops.push({op:'add',id:crypto.randomUUID(),text:line});
  }
  for(const task of available)if(!used.has(task.id))ops.push({op:'delete',id:task.id});
  return ops;
}
export function legacyTasks(projectId:string,entries:StatusEntry[]):ProjectTask[] {
  return entries.map((entry,index)=>({id:`legacy-status-${projectId}-${index}`,text:stripNumber(entry.text),createdAt:entry.date,updatedAt:entry.date,completedAt:'',deletedAt:''})).filter(task=>task.text&&task.text!=='-');
}
export function validateTaskOps(value:unknown):asserts value is TaskOperation[] {
  if(!Array.isArray(value)||!value.length)failure('INVALID_TASK_OPERATIONS',400);
  for(const op of value){
    if(!op||!['add','edit','complete','reopen','delete'].includes(op.op)||typeof op.id!=='string'||!op.id||!op.id.isWellFormed()||[...op.id].length>128||Object.keys(op).some(key=>!['op','id',...['add','edit'].includes(op.op)?['text']:[]].includes(key)))failure('INVALID_TASK_OPERATIONS',400);
    if(['add','edit'].includes(op.op)&&(typeof op.text!=='string'||!op.text.trim()||!op.text.isWellFormed()||Buffer.byteLength(op.text,'utf8')>65535))failure('INVALID_PROJECT_FIELDS',422,{fields:{taskOps:'任务内容不能为空，最长65535字节。'}});
  }
}
export async function attachTasks(c:PoolConnection,projects:RowDataPacket[]) {
  if(!projects.length)return;
  const ids=projects.map(project=>project.id);
  const tasks=await rows(c,`SELECT CAST(project_id AS CHAR) projectId,task_key id,content text,created_at_text createdAt,updated_at_text updatedAt,completed_at_text completedAt,deleted_at_text deletedAt FROM project_tasks WHERE project_id IN (?) ORDER BY sort_order,task_key`,[ids]);
  for(const project of projects){
    project.tasks=project.tasksUnified?tasks.filter(task=>task.projectId===project.id).map(({projectId:_,...task})=>task):legacyTasks(project.id,project.statusEntries??project.statusDesc.split('\n').map((text:string)=>({text,date:''})));
    if(project.tasksUnified){project.statusDesc=taskDescription(project.tasks);project.statusEntries=(project.tasks as ProjectTask[]).filter(t=>!t.completedAt&&!t.deletedAt).map((t,i)=>({text:`${i+1}、${t.text}`,date:t.updatedAt}));}
  }
}
export async function readTasks(c:PoolConnection,id:string) {
  const project=(await rows(c,'SELECT CAST(id AS CHAR) id,tasks_unified tasksUnified,status_description statusDesc FROM projects WHERE id=?',[id]))[0];
  if(!project)failure('PROJECT_NOT_FOUND',404);
  if(!project.tasksUnified){
    const baseline=(await statusSourceBaselines(c,[id])).get(id);
    const audits=await rows(c,`SELECT CAST(version_after AS CHAR) version,action,JSON_UNQUOTE(JSON_EXTRACT(before_json,'$.statusDesc')) beforeText,JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.statusDesc')) afterText,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt FROM audit_log WHERE project_id=? AND entity_type='project' AND action<>'project.import' AND JSON_TYPE(JSON_EXTRACT(after_json,'$.statusDesc'))='STRING' ORDER BY id`,[id]);
    project.statusEntries=projectStatusEntries(project.statusDesc,audits.filter(audit=>!baseline||BigInt(audit.version)>BigInt(baseline.version)) as (RowDataPacket&StatusChange)[],baseline?.entries);
  }
  await attachTasks(c,[project]);return {unified:!!project.tasksUnified,tasks:project.tasks as ProjectTask[]};
}
export async function taskCandidate(c:PoolConnection,id:string,operations:TaskOperation[],at:string) {
  const before=await readTasks(c,id),after=structuredClone(before.tasks);
  for(const operation of operations){
    const task=after.find(value=>value.id===operation.id);
    if(operation.op==='add'){
      if(task)failure('TASK_ID_CONFLICT',422);
      after.push({id:operation.id,text:operation.text.trim(),createdAt:at,updatedAt:at,completedAt:'',deletedAt:''});continue;
    }
    if(!task||task.deletedAt)failure('TASK_NOT_FOUND',422,{fields:{taskOps:'这条任务已被删除或不存在，请保留输入后重新读取。'}});
    if(operation.op==='edit'&&task.text!==operation.text.trim()){task.text=operation.text.trim();task.updatedAt=at;}
    if(operation.op==='complete'&&!task.completedAt){task.completedAt=at;task.updatedAt=at;}
    if(operation.op==='reopen'&&task.completedAt){task.completedAt='';task.updatedAt=at;}
    if(operation.op==='delete'){task.deletedAt=at;task.updatedAt=at;}
  }
  const description=taskDescription(after);
  if(Buffer.byteLength(description,'utf8')>65535)failure('INVALID_PROJECT_FIELDS',422,{fields:{taskOps:'待完成任务正文合计不能超过65535字节，请减少本次输入。'}});
  return {before:before.tasks,after,unified:before.unified,changed:JSON.stringify(before.tasks)!==JSON.stringify(after),description};
}
export async function writeTasks(c:PoolConnection,id:string,tasks:ProjectTask[]) {
  for(const [order,task] of tasks.entries())await c.execute(`INSERT INTO project_tasks(project_id,task_key,content,created_at_text,updated_at_text,completed_at_text,deleted_at_text,sort_order) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE content=?,created_at_text=?,updated_at_text=?,completed_at_text=?,deleted_at_text=?,sort_order=?`,[id,task.id,task.text,task.createdAt,task.updatedAt,task.completedAt,task.deletedAt,order,task.text,task.createdAt,task.updatedAt,task.completedAt,task.deletedAt,order]);
  await c.execute('UPDATE projects SET tasks_unified=1 WHERE id=?',[id]);
}
