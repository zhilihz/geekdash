import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { canonical } from './personal-state.js';
import { failure, validId } from './project-save.js';
import { parseImportSource, importCatalogKinds } from './import-source.js';
import { catalogDefinition, catalogNameKey, readCatalogInTransaction, previewCatalogInTransaction, saveCatalogInTransaction, validateCatalog } from './catalog.js';
import { normalizeImportProject, readImportProject, lockImportProject, validateImportProject, applyImportProject, writeImportHistory, type ImportProjectInput } from './project-import.js';

type Json = Record<string, any>;
type Comparison = { source: unknown; saved: unknown };
type Difference = { key: string; label: string; before: unknown; after: unknown; selectable: boolean; status: 'normal'|'conflict'|'needs_choice'|'keep_online'; defaultSelected: boolean; baseline?: Comparison; members?: Difference[]; issues?: Json[] };
type ItemCommand = { expectedBatchVersion: string; expectedReviewVersion: string; expectedVersion: string | null; idempotencyKey: string; basis?: string; selected?: string[]; keepOnline?: string[]; payload?: Json; mode?: 'new' | 'existing'; targetId?: string | null; intent?: ImportProjectInput['intent'] };
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const decode = (v: unknown): any => typeof v === 'string' ? JSON.parse(v) : v;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest();
const equal = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);
const idSort = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
async function rows(c: PoolConnection, sql: string, args: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 4000 }, args))[0]; }
async function lastId(c: PoolConnection): Promise<string> { return (await rows(c, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id; }
function operation(v: unknown) { if (!uuid(v)) failure('INVALID_IMPORT_OPERATION', 400); }
function sourceKey(v: unknown) { if (typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(v)) failure('INVALID_IMPORT_SOURCE', 400); return v as string; }
function command(input: unknown): ItemCommand {
  if (!object(input) || Object.keys(input).some(k => !['expectedBatchVersion','expectedReviewVersion','expectedVersion','idempotencyKey','basis','selected','keepOnline','payload','mode','targetId','intent'].includes(k))) failure('INVALID_IMPORT_COMMAND',400);
  operation(input.idempotencyKey);
  if (!validId(input.expectedBatchVersion) || !validId(input.expectedReviewVersion) || !(input.expectedVersion == null || input.expectedVersion === '0' || validId(input.expectedVersion))
    || ['selected','keepOnline'].some(key=>input[key] !== undefined && (!Array.isArray(input[key]) || input[key].some((k:unknown) => typeof k !== 'string' || k.length > 256) || new Set(input[key]).size !== input[key].length))
    || input.payload !== undefined && !object(input.payload) || input.mode !== undefined && !['new','existing'].includes(input.mode)
    || input.targetId !== undefined && input.targetId !== null && !validId(input.targetId) || input.basis !== undefined && (typeof input.basis !== 'string' || !/^[a-f0-9]{64}$/.test(input.basis))) failure('INVALID_IMPORT_COMMAND',400);
  if (input.payload) {
    for (const key of ['fields','people','histories']) if(input.payload[key]!==undefined&&!object(input.payload[key]))failure('INVALID_IMPORT_PAYLOAD',400);
    for (const key of ['stages','records','statusEntries']) if(input.payload[key]!==undefined&&(!Array.isArray(input.payload[key])||input.payload[key].some((v:unknown)=>!object(v))))failure('INVALID_IMPORT_PAYLOAD',400);
    if(input.payload.records?.some((v:Json)=>typeof v.key!=='string'||!object(v.values)) || input.payload.stages?.some((v:Json)=>typeof v.code!=='string'))failure('INVALID_IMPORT_PAYLOAD',400);
  }
  return input as ItemCommand;
}
async function receipt(c: PoolConnection, actor: Actor, scope: string, key: string, body?: unknown) {
  const row = (await rows(c, 'SELECT request_hash,response_json FROM command_receipts WHERE actor_id=? AND command_scope=? AND idempotency_key=?', [actor.id,scope,key]))[0];
  if (!row) return null;
  if (body !== undefined && !row.request_hash.equals(hash(body))) failure('OPERATION_KEY_REUSED',409);
  return decode(row.response_json);
}
async function remember(c: PoolConnection, actor: Actor, scope: string, key: string, body: unknown, result: unknown) {
  await c.execute('INSERT INTO command_receipts(actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,UTC_TIMESTAMP(3))',[actor.id,scope,key,hash(body),JSON.stringify(result)]);
}
async function itemResult(c: PoolConnection, actor: Actor, scope: string, itemId: string, body: ItemCommand, action?: 'review' | 'adopt') {
  const prior=(await rows(c,'SELECT request_hash,response_json FROM command_receipts WHERE actor_id=? AND command_scope=? AND idempotency_key=?',[actor.id,scope,body.idempotencyKey]))[0];
  if(prior) {
    const result=decode(prior.response_json), savedAction=result.action ?? (result.adoptionId?'adopt':'review');
    if(action && action!==savedAction || !prior.request_hash.equals(hash({action:savedAction,body})) && !(result.action===undefined && prior.request_hash.equals(hash(body)))) failure('OPERATION_KEY_REUSED',409);
    return result;
  }
  const adoption=(await rows(c,'SELECT CAST(id AS CHAR) id,request_hash,adopted_json FROM import_adoptions WHERE item_id=? AND actor_id=? AND operation_key=?',[itemId,actor.id,body.idempotencyKey]))[0];
  if(!adoption)return null;
  if(action==='review' || !adoption.request_hash.equals(hash({action:'adopt',body})))failure('OPERATION_KEY_REUSED',409);
  const result=decode(adoption.adopted_json).result;
  if(!object(result))throw Object.assign(new Error('COMMIT_UNKNOWN'),{code:'COMMIT_UNKNOWN'});
  return {...result,adoptionId:adoption.id};
}
async function audit(c: PoolConnection, actor: Actor, action: string, type: string, id: string, before: unknown, after: unknown, requestId: string) {
  await c.execute("INSERT INTO audit_log(actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,before_json,after_json,request_id,created_at) VALUES (?,?,'user',?,?,?,?,?,?,UTC_TIMESTAMP(3))",[actor.id,actor.name,action,type,id,JSON.stringify(before),JSON.stringify(after),requestId]);
}
const batchColumns = 'CAST(b.id AS CHAR) id,b.source_namespace sourceNamespace,CAST(b.version AS CHAR) version,CAST(b.created_by AS CHAR) uploaderId,CAST(b.current_handler_id AS CHAR) handlerId,b.mapping_json metadata,b.created_at createdAt,u.display_name handlerName,u.enabled handlerEnabled,creator.display_name uploaderName';
async function batch(c: PoolConnection, id: string, lock = false) {
  if (!validId(id)) failure('INVALID_IMPORT_BATCH',400);
  const value = (await rows(c, `SELECT ${batchColumns} FROM import_batches b JOIN users u ON u.id=b.current_handler_id JOIN users creator ON creator.id=b.created_by WHERE b.id=?${lock ? ' FOR UPDATE OF b' : ''}`, [id]))[0];
  if (!value) failure('IMPORT_BATCH_NOT_FOUND',404);
  value.metadata = decode(value.metadata); return value;
}
const itemColumns = 'CAST(id AS CHAR) id,CAST(batch_id AS CHAR) batchId,item_kind kind,source_key sourceKey,source_sequence sequence,CAST(review_version AS CHAR) reviewVersion,CAST(target_project_id AS CHAR) targetProjectId,CAST(expected_project_version AS CHAR) expectedVersion,source_payload_json raw,corrected_payload_json corrected,validation_json validation,status,result_json result';
async function itemRows(c: PoolConnection, batchId: string, itemId?: string, lock = false) {
  if (itemId && !validId(itemId)) failure('INVALID_IMPORT_ITEM',400);
  const values = await rows(c, `SELECT ${itemColumns} FROM import_items WHERE batch_id=?${itemId ? ' AND id=?' : ''} ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [batchId,...itemId ? [itemId] : []]);
  for (const value of values) for (const key of ['raw','corrected','validation','result']) value[key] = decode(value[key]);
  return values;
}
async function bindingRows(c: PoolConnection, source: string, lock = false) {
  return rows(c, `SELECT CAST(id AS CHAR) id,object_kind kind,source_scope scope,source_key sourceKey,CAST(target_id AS CHAR) targetId,CAST(version AS CHAR) version FROM import_bindings WHERE source_namespace=? ORDER BY object_kind,source_scope,source_key${lock ? ' FOR UPDATE' : ''}`, [source]);
}
async function catalogs(c: PoolConnection) {
  const result: Record<string,RowDataPacket[]> = {};
  for (const kind of importCatalogKinds) result[kind] = await readCatalogInTransaction(c,kind);
  return result;
}
async function mayEdit(c: PoolConnection, actor: Actor, b: RowDataPacket, targetId: string | null, project: boolean) {
  if (!project) return true;
  if (!targetId) return b.handlerId === actor.id && !!b.handlerEnabled;
  return !!(await rows(c,'SELECT project_id FROM project_responsibilities WHERE project_id=? AND user_id=?',[targetId,actor.id])).length;
}
const labels: Record<string,string> = { name:'项目名称', status:'项目状态', statusDesc:'最新状态说明', summary:'项目简介', marketExpectation:'市场预期', detailNote:'详细说明', summaryNote:'项目简要备注', chipstatNote:'芯片备注', customerId:'客户', odmCustomerId:'ODM工厂', productLineId:'产品线', appId:'APP', groupId:'分组', chipIds:'芯片', tagIds:'标签', signal:'灯色', signalNote:'灯色说明', priority:'优先级', filingDate:'立案日期', proposalDate:'提案日期', startDate:'实际启动日期', dueDate:'预计结案日期', originalDueDate:'原始计划', closedOn:'实际结案日期', closureType:'结案类型', closureDueDate:'结案时计划', closureNote:'结案说明', remainingWorkNote:'遗留处置说明', maintenanceEnabled:'量产维护', resumeStatus:'暂缓前状态', preCloseStatus:'结案前状态', hardware_owner:'硬件负责人', software_owner:'软件负责人', participant:'参与人员', pm:'本地项目经理资料', fullName:'企业全称', shortName:'企业简称', managerText:'企业负责人文字', namePrefix:'命名前缀', contact:'联系方式', background:'背景资料', role:'岗位', appVersion:'APP版本', description:'说明', originalModel:'原型号', manufacturer:'厂商', firmwareVersion:'固件版本' };

function comparisonAtoms(payload: Json, project: boolean): Json {
  if(!project)return {...payload};
  const atoms:Json={};
  for(const [group,prefix]of [['fields','fields'],['people','people'],['histories','history']])for(const [key,value]of Object.entries(payload[group] ?? {}))atoms[prefix+'.'+key]=value;
  for(const stage of payload.stages ?? [])for(const [key,value]of Object.entries(stage))if(key!=='code')atoms['stage.'+stage.code+'.'+key]=value;
  for(const record of payload.records ?? [])for(const [key,value]of Object.entries(record.values))atoms['record.'+record.key+'.'+key]=value;
  if(Object.hasOwn(payload,'lastCheckAt'))atoms.lastCheckAt=payload.lastCheckAt;
  return atoms;
}
function catalogSource(kind:string,raw:Json):Json {
  const value={...raw};
  if(kind==='company'&&Object.hasOwn(value,'manager'))value.managerText=value.manager;
  if(kind==='apps')for(const [source,target]of [['version','appVersion'],['desc','description']])if(Object.hasOwn(value,source)&&!Object.hasOwn(value,target))value[target]=value[source];
  const result=Object.fromEntries(Object.keys(catalogDefinition(kind).fields).filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
  if(kind==='customers'&&Array.isArray(raw.tags)&&!raw.tags.length)result.tagIds=[];
  return result;
}
async function comparisonBase(c:PoolConnection,b:RowDataPacket,row:RowDataPacket,targetId:string|null,bound:RowDataPacket|undefined,bindings:RowDataPacket[],payload:Json) {
  const values:Record<string,Comparison>={},versions:string[]=[],seen=new Set<string>(),stageSeen=new Set<string>(),unchangedStageChoices:string[]=[];
  if(!targetId||row.kind!=='company'&&(!bound||bound.targetId!==targetId))return {values,versions,unchangedStageChoices};
  const previous=await rows(c,'SELECT CAST(a.id AS CHAR) id,a.adopted_json facts,a.history_manifest_json manifest,i.source_payload_json raw FROM import_adoptions a JOIN import_items i ON i.id=a.item_id WHERE a.source_namespace=? AND a.target_kind=? AND a.target_id=? ORDER BY a.id DESC',[b.sourceNamespace,row.kind,targetId]);
  for(const adoption of previous) {
    const facts=decode(adoption.facts);
    if(row.kind!=='company'&&(facts.sourceKey!==row.sourceKey||facts.bindingAfter?.id!==bound!.id||facts.bindingAfter?.version!==bound!.version))continue;
    versions.push(adoption.id);
    const project=row.kind==='project',saved=project?{...facts,histories:{}}:{...facts.fields};
    if(project)for(const stage of facts.stages ?? [])if(Object.hasOwn(stage,'state')&&!stageSeen.has(stage.code)) {
      stageSeen.add(stage.code);
      const index=Number(stage.code.slice(1))-1,old=decode(adoption.raw).stages?.[index],now=row.raw.stages?.[index];
      const evidence=(value:Json)=>Object.fromEntries(['done','state','startDate'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
      if(object(old)&&object(now)&&equal(evidence(old),evidence(now)))unchangedStageChoices.push(stage.code);
    }
    if(project)for(const kind of Object.keys(decode(adoption.manifest) ?? {}))saved.histories[kind]=(await rows(c,'SELECT source_date_text date,body text FROM legacy_project_history WHERE source_adoption_id=? AND history_kind=? ORDER BY source_sequence,id',[adoption.id,kind])).map(v=>({date:v.date ?? '',text:v.text}));
    const after=comparisonAtoms(saved,project),frozen:Record<string,Comparison>|undefined=facts.comparisonBase;
    let original:Json={};
    if(!frozen) {
      const raw=decode(adoption.raw);
      original=comparisonAtoms(project?normalizeImportProject(raw,{child:(kind,key)=>facts.records?.find((v:Json)=>v.kind===kind&&v.sourceKey===key)?.targetId}).input:catalogSource(row.kind,raw),project);
      // 旧记录没有冻结引用对应时，不能拿现在的映射假装当时的来源值。
      for(const key of Object.keys(original))if(key.startsWith('record.')&&/\.(previousNodeId|nextNodeId)$/.test(key)&&typeof original[key]==='string'&&original[key].startsWith('source:'))delete original[key];
    }
    for(const key of new Set([...Object.keys(after),...Object.keys(frozen ?? {})])) {
      if(seen.has(key))continue;seen.add(key);
      if(key.startsWith('record.')) {
        const record=payload.records?.find((value:Json)=>key.startsWith('record.'+value.key+'.'));
        const child=record?.sourceKey&&bound?bindings.find(value=>value.kind===record.kind&&value.scope===`project:${bound.id}:${bound.version}`&&value.sourceKey===record.sourceKey):null;
        const recorded=facts.comparisonRecords?.[record?.key],legacy=facts.records?.find((value:Json)=>value.key===record?.key);
        if(!record?.targetId||!child||child.targetId!==record.targetId)continue;
        if(recorded ? recorded.targetId!==child.targetId||recorded.id!==child.id||recorded.version!==child.version : legacy?.targetId!==child.targetId||child.version!=='1')continue;
      }
      if(frozen&&Object.hasOwn(frozen,key)&&Object.hasOwn(frozen[key],'source')&&Object.hasOwn(frozen[key],'saved'))values[key]=frozen[key];
      else if(!frozen&&Object.hasOwn(original,key)&&Object.hasOwn(after,key))values[key]={source:original[key],saved:after[key]};
    }
  }
  return {values,versions,unchangedStageChoices};
}
function differences(payload: Json, current: Json | null, project: boolean, baseline:Record<string,Comparison>): Difference[] {
  const diffs: Difference[] = [];
  const difference = (key:string,label:string,before:unknown,after:unknown,isNew=false):Difference|null=> {
    if(!isNew&&current&&equal(before,after))return null;
    const base=baseline[key];
    let status:Difference['status']=!current||isNew?'normal':!base?'needs_choice':equal(after,base.source)?'keep_online':equal(before,base.saved)?'normal':'conflict';
    if(!project&&current&&status==='normal')status='needs_choice';
    return {key,label,before:before ?? null,after,selectable:status!=='keep_online',status,defaultSelected:status==='normal',...base?{baseline:base}:{}};
  };
  const add=(key:string,label:string,before:unknown,after:unknown)=>{const value=difference(key,label,before,after);if(value)diffs.push(value);};
  const group=(key:string,label:string,before:Json|null,after:Json,isNew=false)=> {
    const members=Object.entries(after).map(([field,value])=>difference(key+'.'+field,labels[field] ?? field,before?.[field],value,isNew)).filter((v):v is Difference=>!!v);
    if(!members.length)return;
    const status=members.some(v=>v.status==='conflict')?'conflict':members.some(v=>v.status==='needs_choice')?'needs_choice':members.some(v=>v.status==='normal')?'normal':'keep_online';
    diffs.push({key,label,before:Object.fromEntries(members.map(v=>[v.key.slice(key.length+1),v.before])),after:Object.fromEntries(members.map(v=>[v.key.slice(key.length+1),v.after])),members,status,selectable:members.some(v=>v.selectable),defaultSelected:status==='normal'});
  };
  if (!project) { for (const [key,value] of Object.entries(payload)) add(key,labels[key] ?? key,current?.[key],value); return diffs; }
  for (const [key,value] of Object.entries(payload.fields ?? {})) add('fields.'+key,labels[key] ?? key,current?.fields?.[key],value);
  for (const [key,value] of Object.entries(payload.people ?? {})) add('people.'+key,labels[key] ?? key,current?.people?.[key],value);
  for (const stage of payload.stages ?? []) group('stage.'+stage.code,'阶段 '+stage.code,current?.stages?.find((v:Json)=>v.code===stage.code) ?? null,Object.fromEntries(Object.entries(stage).filter(([key])=>key!=='code')));
  for (const record of payload.records ?? []) {
    const prior=record.targetId?current?.records?.find((v:Json)=>v.kind===record.kind&&v.targetId===record.targetId):null;
    group('record.'+record.key,({project_node:'项目节点',customer_node:'客户节点',risk:'风险',change:'需求变更',schedule:'改期记录'} as Json)[record.kind]+' · '+(record.values.title ?? record.values.content ?? record.values.reason ?? ''),prior?.values ?? null,record.values,record.targetId===null);
  }
  for (const [kind,value] of Object.entries(payload.histories ?? {})) add('history.'+kind,kind==='mixed'?'本地原有记录':'本地状态说明历史',current?.histories?.[kind],value);
  if (Object.hasOwn(payload,'lastCheckAt')) add('lastCheckAt','本地最后标记时间',current?.lastCheckAt,payload.lastCheckAt);
  return diffs;
}
const leaves=(diffs:Difference[])=>diffs.flatMap(diff=>diff.members ?? [diff]);
function selection(diffs:Difference[],keys:string[],keeping=false) {
  const result=new Set<string>();
  for(const key of keys) {
    const found=diffs.find(diff=>diff.key===key) ?? leaves(diffs).find(diff=>diff.key===key);
    if(!found)failure('IMPORT_SELECTION_CHANGED',409);
    for(const value of found.members ?? [found]) {
      if(keeping?['conflict','needs_choice'].includes(value.status):value.selectable)result.add(value.key);
    }
  }
  return [...result];
}

function selectProject(payload: ImportProjectInput, selected: string[]): ImportProjectInput {
  const input: ImportProjectInput = {}, chosen = new Set(selected);
  for (const group of ['fields','people','histories'] as const) {
    const prefix = group === 'histories' ? 'history' : group;
    const values = Object.entries(payload[group] ?? {}).filter(([key])=>chosen.has(prefix+'.'+key));
    if (values.length) Object.assign(input,{[group]:Object.fromEntries(values)});
  }
  const stages = payload.stages?.map(v=>({code:v.code,...Object.fromEntries(Object.entries(v).filter(([key])=>key!=='code'&&(chosen.has('stage.'+v.code)||chosen.has('stage.'+v.code+'.'+key))))})).filter(v=>Object.keys(v).length>1); if (stages?.length) input.stages=stages;
  const records = payload.records?.map(v=>({...v,values:Object.fromEntries(Object.entries(v.values).filter(([key])=>chosen.has('record.'+v.key)||chosen.has('record.'+v.key+'.'+key)))})).filter(v=>Object.keys(v.values).length); if (records?.length) input.records=records;
  if (chosen.has('fields.statusDesc') && payload.statusEntries) input.statusEntries=payload.statusEntries;
  if (chosen.has('lastCheckAt')) input.lastCheckAt=payload.lastCheckAt;
  return input;
}
function freezeComparison(source:Json,adopted:Json,current:Json|null,selected:string[],kept:string[],project:boolean,childIds:Record<string,string>={}) {
  const original=structuredClone(source);
  if(project)for(const record of original.records ?? [])for(const field of ['previousNodeId','nextNodeId']) {
    const edge=record.values[field];
    if(typeof edge==='string'&&edge.startsWith('source:')) {
      const other=original.records.find((v:Json)=>v.kind==='project_node'&&v.sourceKey===edge.slice(7));
      if(other&&(childIds[other.key]||other.targetId))record.values[field]=childIds[other.key]??other.targetId;
    }
  }
  const aligned=project&&current?{...current,records:(original.records ?? []).flatMap((record:Json)=>{const value=current.records?.find((v:Json)=>v.kind===record.kind&&v.targetId===(childIds[record.key]??record.targetId));return value?[{...value,key:record.key}]:[];})}:current;
  const sourceAtoms=comparisonAtoms(original,project),savedAtoms=comparisonAtoms(adopted,project),online=comparisonAtoms(aligned??{},project),pairs:Record<string,Comparison>={};
  for(const key of [...selected,...kept]) {
    const values=kept.includes(key)?online:savedAtoms;
    if(!Object.hasOwn(sourceAtoms,key)||!Object.hasOwn(values,key))continue;
    if(key.startsWith('record.')&&!original.records?.some((record:Json)=>record.sourceKey&&key.startsWith('record.'+record.key+'.')))continue;
    pairs[key]={source:sourceAtoms[key],saved:values[key]};
  }
  return pairs;
}
function validationIssues(error:unknown):Json[] {
  const known=error as {status?:number;code?:string;fields?:Record<string,string>;cause?:string;consequence?:string;requiredKeys?:string[]};
  if(!known.status)throw error;
  const effect={cause:known.cause,consequence:known.consequence,requiredKeys:known.requiredKeys};
  return known.fields?Object.entries(known.fields).map(([path,message])=>({path,message,code:known.code,...effect})):[{code:known.code,message:'所选信息尚不能保存：'+known.code,...effect}];
}

function overlay(base: Json, correction?: Json | null): Json {
  if (!correction) return base;
  const result = {...base,...correction};
  for (const key of ['fields','people','histories']) if (base[key] || correction[key]) result[key] = {...base[key],...correction[key]};
  for (const [key,identity] of [['stages','code'],['records','key']]) if (base[key] && correction[key]) {
    if (!Array.isArray(correction[key])) failure('INVALID_IMPORT_PAYLOAD',400);
    result[key] = base[key].map((row:Json)=> {
      const update = correction[key].find((v:Json)=>v[identity]===row[identity]);
      return update ? {...row,...update,...key==='records' ? {values:{...row.values,...update.values}} : {}} : row;
    });
    for (const row of correction[key]) if (!result[key].some((v:Json)=>v[identity]===row[identity])) result[key].push(row);
  }
  return result;
}
// 只保存人工实际改动，不能把当时自动解析的正式ID冻结成下一次来源的输入。
function correctionFor(base:Json,payload:Json,project:boolean):Json {
  const differs=(old:Json|undefined,key:string,value:unknown)=>!old||!Object.hasOwn(old,key)||!equal(old[key],value);
  if(!project)return Object.fromEntries(Object.entries(payload).filter(([key,value])=>differs(base,key,value)));
  const result:Json={};
  for(const key of ['fields','people','histories'])if(payload[key]) {
    const changed=Object.fromEntries(Object.entries(payload[key]).filter(([field,value])=>differs(base[key],field,value)));
    if(Object.keys(changed).length)result[key]=changed;
  }
  for(const [key,identity]of [['stages','code'],['records','key']])if(payload[key]) {
    const changed=payload[key].map((row:Json)=> {
      const old=base[key]?.find((v:Json)=>v[identity]===row[identity]);if(!old)return row;
      const values=Object.fromEntries(Object.entries(row).filter(([field,value])=>field!==identity&&differs(old,field,value)));
      if(key==='records'&&values.values)values.values=Object.fromEntries(Object.entries(row.values).filter(([field,value])=>differs(old.values,field,value)));
      return Object.keys(values).length?{[identity]:row[identity],...values}:null;
    }).filter(Boolean);
    if(changed.length)result[key]=changed;
  }
  for(const key of ['statusEntries','lastCheckAt'])if(Object.hasOwn(payload,key)&&differs(base,key,payload[key]))result[key]=payload[key];
  return result;
}
function assertRecordIdentity(base:Json,correction?:Json|null) {
  for(const record of correction?.records??[]) {
    const original=base.records?.find((v:Json)=>v.key===record.key);
    if(!original||['kind','sourceKey'].some(key=>Object.hasOwn(record,key)&&record[key]!==original[key]))failure('IMPORT_RECORD_IDENTITY_CHANGED',400);
  }
}
function applicableCorrection(correction:Json|null,metadata:Json,source:string,target:string|null):Json|null {
  if(!correction)return null;
  const value=structuredClone(correction);
  if(metadata.sourceNamespace && metadata.sourceNamespace!==source) {
    for(const key of ['customerId','odmCustomerId','productLineId','appId','groupId','chipIds','tagIds'])if(value.fields)delete value.fields[key];
    delete value.people;
    delete value.tagIds;
  }
  if(metadata.sourceNamespace!==source||metadata.choice?.targetId!==target)for(const record of value.records??[]) {
    delete record.targetId;
    if(record.values){delete record.values.previousNodeId;delete record.values.nextNodeId;}
  }
  return value;
}
function sourceIdentity(row:RowDataPacket,all:RowDataPacket[]) {
  if(row.sourceKey)return {scope:'',key:row.sourceKey};
  if(row.kind==='project'||row.kind==='company'||typeof row.raw?.name!=='string'||!row.raw.name.trim())return null;
  if(all.filter(value=>value.kind===row.kind&&typeof value.raw?.name==='string'&&catalogNameKey(value.raw.name)===catalogNameKey(row.raw.name)).length!==1)return null;
  return {scope:'catalog-name',key:hash(row.raw.name).toString('hex')};
}
function sourceBinding(row:RowDataPacket,all:RowDataPacket[],bindings:RowDataPacket[]) {
  const identity=sourceIdentity(row,all);
  return identity?bindings.find(value=>value.kind===row.kind&&value.scope===identity.scope&&value.sourceKey===identity.key):undefined;
}
async function viewItem(c: PoolConnection, actor: Actor, b: RowDataPacket, row: RowDataPacket, all: RowDataPacket[], bindings: RowDataPacket[], catalog: Record<string,RowDataPacket[]>, input?: Partial<ItemCommand>) {
  const project = row.kind === 'project', metadata = row.validation ?? {}, bound = sourceBinding(row,all,bindings);
  const stored = metadata.sourceNamespace===b.sourceNamespace ? metadata.choice : undefined;
  const choice = input?.mode ? {mode:input.mode,targetId:input.targetId ?? null} : stored;
  const staleChoice=!input?.mode&&stored&&(Object.hasOwn(metadata,'choiceBinding')?!equal(metadata.choiceBinding,bound?{id:bound.id,version:bound.version,targetId:bound.targetId}:null):bound&&stored.targetId!==bound.targetId);
  const targetId: string | null = row.kind==='company' ? '1' : choice ? choice.mode==='existing' ? choice.targetId : null : bound?.targetId ?? null;
  if (targetId!==null && !validId(targetId)) failure('INVALID_IMPORT_TARGET',400);
  const mode = targetId ? 'existing' : 'new';
  const used: unknown[] = [], issues: Json[] = [],unresolvedReferences:{path:string;itemIds:string[]}[]=[];
  if(staleChoice)issues.push({path:'mapping',code:'IMPORT_BINDING_CHANGED',message:'这份来源的对应已被更新，请重新选择本次对应。'});
  const resolveReference = (kind: string,key: string,path='reference') => {
    const direct = bindings.find(v=>v.kind===kind && v.scope==='' && v.sourceKey===key);
    let id = direct?.targetId;
    if (direct) used.push([kind,key,direct.id,direct.version,direct.targetId]);
    if (!direct) {
      const candidates = all.filter(v=>v.kind===kind && (v.sourceKey===key || v.raw?.name===key));
      const resolved = candidates.map(v=> {
        const mapping = sourceBinding(v,all,bindings);
        const adopted = v.result?.sourceNamespace===b.sourceNamespace ? v.result : null;
        used.push(['item',v.id,v.reviewVersion,mapping?.version ?? null,adopted?.id ?? null]);
        return mapping?.targetId ?? adopted?.id ?? null;
      });
      if (resolved.length && resolved.every(v=>v && v===resolved[0])) id=resolved[0];
    }
    if (!id) {
      const candidates=all.filter(v=>v.kind===kind&&(v.sourceKey===key||v.raw?.name===key));
      unresolvedReferences.push({path,itemIds:candidates.length===1?[candidates[0].id]:[]});
      return undefined;
    }
    const reference = catalog[kind]?.find(v=>v.id===id); used.push([kind,id,reference?.version ?? null]);
    return reference ? id : undefined;
  };
  const parentScope = bound && targetId===bound.targetId ? `project:${bound.id}:${bound.version}` : null;
  let payload: Json,basePayload:Json;
  if (project) {
    const normalized=normalizeImportProject(row.raw,{resolve:resolveReference,child:(kind,key)=> {
      const child=parentScope ? bindings.find(v=>v.kind===kind && v.scope===parentScope && v.sourceKey===key) : undefined;
      used.push(['child',kind,key,child?.id ?? null,child?.version ?? null,child?.targetId ?? null]);
      return child?.targetId;
    }});
    basePayload=normalized.input;
    assertRecordIdentity(basePayload,row.corrected);assertRecordIdentity(basePayload,input?.payload);
    payload=overlay(overlay(basePayload,applicableCorrection(row.corrected,metadata,b.sourceNamespace,targetId)),input?.payload);
    for (const problem of normalized.issues) {
      const path=problem.path.split('.');
      const value=path.reduce((v:any,k)=>v?.[k],payload);
      const stage=path[0]==='stage' ? payload.stages?.find((v:Json)=>v.code===path[1]) : null;
      if (problem.code==='IMPORT_REFERENCE_REQUIRED' && value!==undefined || problem.code==='IMPORT_STAGE_STATE_REQUIRED' && stage?.state) continue;
      if (problem.code==='IMPORT_CLOSURE_TYPE_REQUIRED' && (payload.fields?.closureType===null || ['normal','terminated'].includes(payload.fields?.closureType))) continue;
      issues.push(problem);
    }
    if (!targetId) for (const record of payload.records ?? []) if (record.targetId===undefined) record.targetId=null;
    for (const record of payload.records ?? []) if (record.targetId===undefined) issues.push({path:'record.'+record.key,code:'IMPORT_RECORD_TARGET_REQUIRED',message:'请选择该记录对应线上哪一条，或明确新增。'});
  } else {
    const raw=row.raw;
    payload=catalogSource(row.kind,raw);
    if (row.kind==='customers' && Array.isArray(raw.tags)) {
      const ids=raw.tags.map((v:unknown)=>resolveReference('tags',String(v),'tagIds'));
      if (ids.every((id:unknown)=>!!id)) payload.tagIds=[...new Set(ids)];
      else issues.push({path:'tagIds',code:'IMPORT_REFERENCE_REQUIRED',message:'请先确认客户标签的对应资料。'});
    }
    basePayload=structuredClone(payload);
    payload={...payload,...applicableCorrection(row.corrected,metadata,b.sourceNamespace,targetId),...input?.payload};
    if(Array.isArray(payload.tagIds))for(let index=issues.length-1;index>=0;index--)if(issues[index].path==='tagIds'&&issues[index].code==='IMPORT_REFERENCE_REQUIRED')issues.splice(index,1);
  }
  const resolvedReferences=used.slice();
  // 来源字段缺失与明确清空有不同含义；这里只比较拟采用字段。
  const current: Json | null = targetId ? project ? await readImportProject(c,targetId,b.sourceNamespace) : catalog[row.kind]?.find(v=>v.id===targetId) ?? null : null;
  if (targetId && !current) issues.push({code:'IMPORT_TARGET_NOT_FOUND',message:'原对应对象已不存在，请重新选择对应。'});
  const comparison=await comparisonBase(c,b,row,targetId,bound,bindings,payload);
  for(let index=issues.length-1;index>=0;index--)if(issues[index].code==='IMPORT_STAGE_STATE_REQUIRED'&&comparison.unchangedStageChoices.includes(issues[index].path.split('.')[1]))issues.splice(index,1);
  const sourceName=typeof payload.name==='string'?catalogNameKey(payload.name):'';
  const sameName=(catalog[row.kind] ?? []).filter(value=>typeof value.name==='string'&&catalogNameKey(value.name)===sourceName);
  const ambiguousSource=(metadata.issues ?? []).some((issue:Json)=>issue.severity==='error'||issue.code==='IMPORT_SOURCE_KEY_DUPLICATE')
    || all.filter(value=>value.kind===row.kind&&typeof value.raw?.name==='string'&&catalogNameKey(value.raw.name)===sourceName).length>1;
  const automaticNew=!project&&row.kind!=='company'&&!bound&&!choice&&!!sourceName&&!sameName.length&&!ambiguousSource;
  const needsMapping=!!staleChoice||!project&&row.kind!=='company'&&!bound&&!choice&&!automaticNew;
  if(needsMapping&&!staleChoice)issues.push({path:'mapping',code:'IMPORT_MAPPING_REQUIRED',message:'请选择新建这份资料或对应已有资料'});
  const diffs=differences(payload,current,project,comparison.values);
  if (targetId && (!bound || bound.targetId!==targetId) && row.kind!=='company') diffs.unshift({key:'binding',label:'确认来源对应',before:bound?.targetId ?? null,after:targetId,selectable:true,status:'normal',defaultSelected:true});
  for (const issue of issues) {
    const key=issue.path?.startsWith('stage.') ? issue.path.split('.').slice(0,2).join('.') : issue.path;
    const diff=diffs.find(v=>v.key===key)||leaves(diffs).find(v=>v.key===key);
    if (diff) (diff.issues ??= []).push(issue);
  }
  const referenceIds: Record<string,string[]> = {};
  if (project) {
    for (const [key,kind] of Object.entries({customerId:'customers',odmCustomerId:'customers',productLineId:'productLines',appId:'apps',groupId:'groups',chipIds:'chips',tagIds:'tags'})) {
      const value=payload.fields?.[key]; if (value) (referenceIds[kind] ??= []).push(...Array.isArray(value)?value:[value]);
    }
    referenceIds.engineers=Object.values(payload.people ?? {}).flat() as string[];
  } else if (payload.tagIds) referenceIds.tags=payload.tagIds;
  for (const [kind,ids] of Object.entries(referenceIds)) for (const id of [...new Set(ids)].sort(idSort)) {
    const found=catalog[kind]?.find(v=>v.id===id); used.push(['reference',kind,id,found?.version ?? null,found?.enabled ?? null]);
  }
  const canEdit=await mayEdit(c,actor,b,targetId,project);
  const reliable=!!(bound && bound.targetId===targetId || row.kind==='company');
  const defaultSelected=leaves(diffs).filter(diff=>diff.defaultSelected).map(diff=>diff.key);
  const conflictKeys=leaves(diffs).filter(diff=>diff.status==='conflict'||diff.status==='needs_choice').map(diff=>diff.key);
  if(canEdit&&!issues.length&&!conflictKeys.length&&(defaultSelected.length||!targetId)) {
    try {
      if(project)await validateImportProject(c,actor,{...selectProject(payload,defaultSelected),...targetId?{projectId:targetId,expectedVersion:current!.expectedVersion}:{},...input?.intent?{intent:input.intent}:{}},{itemId:row.id,sourceNamespace:b.sourceNamespace,operationKey:input?.idempotencyKey ?? randomUUID(),requestId:'import-read'});
      else {
        const candidate=Object.fromEntries(defaultSelected.filter(key=>key!=='binding').map(key=>[key,payload[key]]));
        if(Object.keys(candidate).length)await previewCatalogInTransaction(c,row.kind,validateCatalog(row.kind,{id:targetId,expectedVersion:current?.version ?? '0',idempotencyKey:input?.idempotencyKey ?? randomUUID(),changes:candidate}),false);
      }
    }catch(error){issues.push(...validationIssues(error).map(issue=>({...issue,defaultSelection:true})));}
  }
  const unchanged=reliable && !diffs.length && !issues.length;
  const keptOnline=reliable && !!diffs.length && leaves(diffs).every(diff=>diff.status==='keep_online') && !issues.length;
  const classification=unchanged||keptOnline?'unchanged':issues.length||conflictKeys.length||!canEdit?'needs_attention':'ready';
  const basis=hash([b.sourceNamespace,b.version,row.reviewVersion,targetId,bound ? [bound.id,bound.version,bound.targetId] : null,used,comparison.versions]).toString('hex');
  const referenceBasis=hash([resolvedReferences,
    Object.fromEntries(['customerId','odmCustomerId','productLineId','appId','groupId','chipIds','tagIds'].map(key=>[key,basePayload.fields?.[key] ?? basePayload[key]])),
    basePayload.people,(basePayload.records ?? []).map((record:Json)=>[record.key,record.targetId,record.values.previousNodeId,record.values.nextNodeId])
  ]).toString('hex');
  const adoptions=await rows(c,'SELECT CAST(id AS CHAR) id,CAST(target_id AS CHAR) targetId,CAST(version_after AS CHAR) savedVersion,adopted_json adopted,JSON_KEYS(history_manifest_json) historyKinds,created_at savedAt FROM import_adoptions WHERE item_id=? ORDER BY id DESC',[row.id]);
  return {id:row.id,kind:row.kind,reviewVersion:row.reviewVersion,sourceKey:row.sourceKey,payload,basePayload,canEdit,canAdopt:canEdit && !unchanged && !keptOnline,targetId,expectedVersion:current?.expectedVersion ?? current?.version ?? (targetId?null:'0'),mode,diffs,issues,unresolvedReferences,unchanged,keptOnline,needsMapping,classification,defaultSelected,conflictKeys,basis,executionBasis:[b.sourceNamespace,b.version,row.reviewVersion,targetId,bound?[bound.id,bound.version,bound.targetId]:null,used,comparison.versions],referenceBasis,bindingVersion:bound?.version ?? null,previousResult:row.result ?? null,adoptions,sourceName:row.raw.name ?? row.raw.fullName ?? '',name:payload.fields?.name ?? payload.name ?? payload.fullName ?? '',target:current,candidates:project?[]:catalog[row.kind] ?? []};
}

async function bind(c: PoolConnection, source: string, kind: string, scope: string, key: string | null, targetId: string) {
  if (!key) return null;
  const previous=(await rows(c,'SELECT CAST(id AS CHAR) id,CAST(target_id AS CHAR) targetId,CAST(version AS CHAR) version FROM import_bindings WHERE source_namespace=? AND object_kind=? AND source_scope=? AND source_key=? FOR UPDATE',[source,kind,scope,key]))[0];
  if (previous) {
    if (previous.targetId!==targetId) { await c.execute('UPDATE import_bindings SET target_id=?,version=version+1 WHERE id=?',[targetId,previous.id]); previous.version=String(BigInt(previous.version)+1n); }
    return {id:previous.id,version:previous.version};
  }
  try { await c.execute('INSERT INTO import_bindings(source_namespace,object_kind,source_scope,source_key,target_id,version) VALUES (?,?,?,?,?,1)',[source,kind,scope,key,targetId]); }
  catch(error) { if ((error as {code?:string}).code==='ER_DUP_ENTRY') failure('IMPORT_BINDING_CHANGED',409); throw error; }
  return {id:await lastId(c),version:'1'};
}

export const importFileLimit = 32 * 1024 * 1024;
export function importDirectory() { return resolve(process.env.GEEKDASH_IMPORT_DIR ?? '../geekdash-data/imports'); }
async function receiveFile(stream: Readable, actor: Actor, key: string) {
  const directory=importDirectory(); await mkdir(directory,{recursive:true,mode:0o700});
  const temporary=join(directory,randomUUID()+'.partial'), final=join(directory,actor.id+'-'+key+'.bak');
  const file=await open(temporary,'wx',0o600), digest=createHash('sha256'); let bytes=0;
  try {
    for await (const value of stream) {
      const chunk=Buffer.isBuffer(value)?value:Buffer.from(value); bytes+=chunk.length;
      if (bytes>importFileLimit) failure('IMPORT_FILE_TOO_LARGE',413);
      digest.update(chunk); await file.writeFile(chunk);
    }
    if (!bytes) failure('IMPORT_FILE_EMPTY',422);
    await file.sync(); await file.close();
    const sha=digest.digest(), parsed=parseImportSource(await readFile(temporary));
    // 每个原操作有不可变文件；重试只允许同一内容。
    try { await link(temporary,final); }
    catch (error) {
      if ((error as {code?:string}).code!=='EEXIST') throw error;
      const existing=await readFile(final);
      if (!createHash('sha256').update(existing).digest().equals(sha)) failure('OPERATION_KEY_REUSED',409);
    }
    await unlink(temporary);
    return {file:final,bytes,sha,parsed};
  } catch(error) { await file.close().catch(()=>{}); await unlink(temporary).catch(()=>{}); throw error; }
}
async function actorLock(c: PoolConnection, actor: Actor) { await rows(c,'SELECT id FROM users WHERE id=? FOR UPDATE',[actor.id]); await assertActor(c,actor); }
async function sourceExists(c: PoolConnection, source: string, lock = false) {
  const found=(await rows(c,`SELECT source_namespace FROM import_sources WHERE source_namespace=?${lock?' FOR SHARE':''}`,[source]))[0];
  if (!found) failure('IMPORT_SOURCE_NOT_FOUND',404);
}
async function sources(c: PoolConnection) { return rows(c,'SELECT source_namespace sourceNamespace,name FROM import_sources ORDER BY created_at,source_namespace'); }
function assertVersions(b: RowDataPacket, row: RowDataPacket, body: ItemCommand) {
  if (b.version!==body.expectedBatchVersion) failure('IMPORT_BATCH_VERSION_CONFLICT',409,{currentVersion:b.version});
  if (row.reviewVersion!==body.expectedReviewVersion) failure('IMPORT_REVIEW_VERSION_CONFLICT',409,{currentVersion:row.reviewVersion});
}
function usefulIssues(view: Awaited<ReturnType<typeof viewItem>>, selected: string[]) {
  const issues=view.issues.filter(issue=>!issue.defaultSelection);
  if (!view.targetId) return issues;
  return issues.filter(issue=>!issue.path || selected.some(key=>issue.path===key || issue.path.startsWith(key+'.') || key.startsWith(issue.path+'.')));
}
function issueFailure(issues: Json[]) {
  failure('IMPORT_REVIEW_REQUIRED',422,{fields:Object.fromEntries(issues.map((issue,index)=>[issue.path ?? 'item.'+index,issue.message ?? issue.code]))});
}
// 已接收任务凭持久授权执行；退出页面或会话不撤销任务，账号停用/改密/交接仍立即阻止后续写入。
async function executionActor(c:PoolConnection,actor:Actor,execution:{id:string;token:string}) {
  const user=(await rows(c,'SELECT enabled,must_change_password,CAST(version AS CHAR) version,display_name name FROM users WHERE id=? FOR SHARE',[actor.id]))[0];
  if(!user?.enabled||user.must_change_password||user.version!==actor.version)failure('AUTH_REQUIRED',401);
  const job=(await rows(c,"SELECT actor_id FROM import_executions WHERE id=? AND actor_id=? AND lease_token=? AND lease_until>UTC_TIMESTAMP(3) AND status='running' FOR UPDATE",[execution.id,actor.id,execution.token]))[0];
  if(!job)failure('IMPORT_EXECUTION_LEASE_LOST',409);
  actor.name=user.name;
}
export function imports(database: RuntimeDatabase) {
  const globalScope = (actor:Actor) => `user:${actor.id}:imports`;
  async function query(actor:Actor, key:string, scope=globalScope(actor), body?:unknown) {
    operation(key);
    return database.readSnapshot(async c=>{await assertActor(c,actor,false,new Date(),false,false);const result=await receipt(c,actor,scope,key,body);return result?{outcome:'committed',result}:{outcome:'not_found'};});
  }
  const service = {
    query,
    executionResult(actor:Actor,itemId:string,body:ItemCommand){return database.readSnapshot(c=>itemResult(c,actor,`user:${actor.id}:import:item:${itemId}`,itemId,body,'adopt'));},
    async planExecution(c:PoolConnection,actor:Actor,batchId:string,input:unknown) {
      if(!object(input)||!uuid(input.idempotencyKey)||!Array.isArray(input.items)||!input.items.length||Object.keys(input).some(key=>!['idempotencyKey','items'].includes(key)))failure('INVALID_IMPORT_COMMAND',400);
      await actorLock(c,actor);
      const b=await batch(c,batchId,true),all=await itemRows(c,batchId),bindings=await bindingRows(c,b.sourceNamespace),catalog=await catalogs(c);
      const requested=new Map<string,ItemCommand>(),resolveReferences=new Set<string>();
      for(const value of input.items){if(!object(value)||!validId(value.id)||requested.has(value.id)||Object.keys(value).some(key=>!['id','command','resolveReferences'].includes(key))||value.resolveReferences!==undefined&&typeof value.resolveReferences!=='boolean')failure('INVALID_IMPORT_COMMAND',400);requested.set(value.id,command(value.command));if(value.resolveReferences===true)resolveReferences.add(value.id);}
      const entries:Json[]=[],visiting=new Set<string>();
      const add=async(id:string):Promise<void>=>{
        if(entries.some(value=>value.id===id))return;
        if(visiting.has(id))failure('IMPORT_DEPENDENCY_REQUIRED',422);visiting.add(id);
        const row=all.find(value=>value.id===id);if(!row)failure('IMPORT_ITEM_NOT_FOUND',404);
        const supplied=requested.get(id),view=await viewItem(c,actor,b,row,all,bindings,catalog,supplied);
        if(!view.canEdit)failure(view.targetId?'PROJECT_RESPONSIBILITY_REQUIRED':'IMPORT_HANDLER_REQUIRED',403);
        const body=supplied ?? {expectedBatchVersion:b.version,expectedReviewVersion:row.reviewVersion,expectedVersion:view.expectedVersion,idempotencyKey:randomUUID(),basis:view.basis,selected:view.defaultSelected};
        assertVersions(b,row,body);
        if(body.basis!==view.basis)failure('IMPORT_BINDING_CHANGED',409);
        if(!supplied&&(row.kind==='project'||row.kind==='company'||view.needsMapping||view.conflictKeys.length||view.issues.some(issue=>issue.code!=='IMPORT_REFERENCE_REQUIRED')))failure('IMPORT_DEPENDENCY_REQUIRED',422);
        const dependencies:string[]=[];
        for(const reference of view.unresolvedReferences){
          if(row.kind==='project'&&!resolveReferences.has(id))continue;
          if(!view.issues.some(issue=>issue.code==='IMPORT_REFERENCE_REQUIRED'&&issue.path===reference.path))continue;
          if(reference.itemIds.length!==1)continue;
          const dependency=reference.itemIds[0];await add(dependency);dependencies.push(dependency);
        }
        entries.push({id,kind:row.kind,sourceKey:row.sourceKey,body,basis:view.executionBasis,dependencies,referencePaths:row.kind==='project'&&!resolveReferences.has(id)?[]:view.unresolvedReferences.map(ref=>ref.path)});visiting.delete(id);
      };
      // 每个项目之前只处理它依赖的资料，其余资料排在项目之后。
      for(const id of [...requested.keys()].sort((a,b)=>Number(all.find(r=>r.id===b)?.kind==='project')-Number(all.find(r=>r.id===a)?.kind==='project')))await add(id);
      return {actorVersion:actor.version,entries};
    },
    async prepareExecution(actor:Actor,batchId:string,entry:Json,completed:Json[],execution:{id:string;token:string}) {
      return database.writeTransaction(async c=>{
        await executionActor(c,actor,execution);
        const prior=await itemResult(c,actor,`user:${actor.id}:import:item:${entry.id}`,entry.id,entry.body);
        if(prior)return {result:prior};
        const b=await batch(c,batchId),all=await itemRows(c,batchId),row=all.find(r=>r.id===entry.id);
        if(!row)failure('IMPORT_ITEM_NOT_FOUND',404);
        const view=await viewItem(c,actor,b,row,all,await bindingRows(c,b.sourceNamespace),await catalogs(c),entry.body);
        const dependencies=completed.filter(value=>entry.dependencies.includes(value.id));
        if(dependencies.length!==entry.dependencies.length)failure('IMPORT_DEPENDENCY_REQUIRED',422);
        for(const dependency of dependencies){
          const current=all.find(r=>r.id===dependency.id),result=dependency.result;
          if(!current||current.result?.adoptionId!==result.adoptionId||current.reviewVersion!==String(BigInt(dependency.body.expectedReviewVersion)+1n))failure('IMPORT_BINDING_CHANGED',409);
          const record=(await readCatalogInTransaction(c,dependency.kind)).find(value=>value.id===result.id);
          if(!record||record.version!==result.savedVersion)failure('CATALOG_VERSION_CONFLICT',409);
        }
        const strip=(basis:Json[])=>basis.map((part,index)=>index!==5?part:part.filter((token:any[])=>!dependencies.some(dep=>
          token[0]==='item'&&token[1]===dep.id || token[0]===dep.kind&&(token[1]===dep.sourceKey||token[1]===dep.result.id) || token[0]==='reference'&&token[1]===dep.kind&&token[2]===dep.result.id)));
        if(!equal(strip(entry.basis),strip(view.executionBasis)))failure('IMPORT_BINDING_CHANGED',409);
        const selected=[...new Set([...(entry.body.selected ?? []),...view.defaultSelected.filter(key=>entry.referencePaths.includes(key))])];
        const body={...entry.body,basis:view.basis,selected};
        return {body};
      });
    },
    sourceItem(actor:Actor,batchId:string,itemId:string,adoptionId?:string) { return database.readSnapshot(async c=> {
      await assertActor(c,actor,false,new Date(),false,false);await batch(c,batchId);
      const row=(await itemRows(c,batchId,itemId))[0];if(!row)failure('IMPORT_ITEM_NOT_FOUND',404);
      if(!adoptionId)return{source:row.raw,issues:row.validation?.issues ?? []};
      if(!validId(adoptionId))failure('INVALID_IMPORT_ADOPTION',400);
      const adoption=(await rows(c,'SELECT CAST(id AS CHAR) id,CAST(target_id AS CHAR) targetId,CAST(version_after AS CHAR) savedVersion,adopted_json adopted,history_manifest_json historyManifest,created_at savedAt FROM import_adoptions WHERE id=? AND item_id=?',[adoptionId,itemId]))[0];
      if(!adoption)failure('IMPORT_ADOPTION_NOT_FOUND',404);
      const histories:Json={};for(const kind of Object.keys(decode(adoption.historyManifest) ?? {}))histories[kind]=(await rows(c,'SELECT source_date_text date,body text FROM legacy_project_history WHERE source_adoption_id=? AND history_kind=? ORDER BY source_sequence,id',[adoptionId,kind])).map(v=>({date:v.date ?? '',text:v.text}));
      return{adoption,histories};
    }); },
    list(actor:Actor) { return database.readSnapshot(async c=> {
      await assertActor(c,actor,false,new Date(),false,false);
      const values=await rows(c,`SELECT ${batchColumns},LOWER(HEX(b.source_hash)) fileHash,(SELECT COUNT(*) FROM import_items i WHERE i.batch_id=b.id AND i.item_kind='project') total,(SELECT COUNT(*) FROM import_items i WHERE i.batch_id=b.id AND i.item_kind='project' AND i.result_json IS NOT NULL) processed FROM import_batches b JOIN users u ON u.id=b.current_handler_id JOIN users creator ON creator.id=b.created_by ORDER BY b.id DESC`);
      return {sources:await sources(c),batches:values.map(value=>({...value,name:decode(value.metadata)?.filename ?? '备份',metadata:undefined}))};
    }); },
    createSource(actor:Actor,input:unknown) {
      if (!object(input) || Object.keys(input).some(k=>!['name','idempotencyKey'].includes(k)) || typeof input.name!=='string' || !input.name.trim() || [...input.name].length>128) failure('INVALID_IMPORT_SOURCE',400);
      operation(input.idempotencyKey);
      return database.writeTransaction(async c=> {
        await actorLock(c,actor);const scope=globalScope(actor),prior=await receipt(c,actor,scope,input.idempotencyKey,input);if(prior)return{outcome:'committed',result:prior};
        const result={sourceNamespace:'local-'+randomUUID(),name:input.name.trim()};
        await c.execute('INSERT INTO import_sources(source_namespace,name,created_at) VALUES (?,?,UTC_TIMESTAMP(3))',[result.sourceNamespace,result.name]);
        await remember(c,actor,scope,input.idempotencyKey,input,result);return{outcome:'committed',result};
      });
    },
    async upload(actor:Actor,options:{source:string;name:string;operation:string;new?:string},stream:Readable) {
      operation(options.operation);sourceKey(options.source);
      if (typeof options.name!=='string' || !options.name.trim() || options.name.length>255 || options.new!==undefined && options.new!=='1') failure('INVALID_IMPORT_UPLOAD',400);
      await database.readSnapshot(async c=>{await assertActor(c,actor,false,new Date(),false,false);await sourceExists(c,options.source);});
      const file=await receiveFile(stream,actor,options.operation);
      const request={source:options.source,name:options.name,hash:file.sha.toString('hex'),bytes:file.bytes,new:options.new==='1'};
      // 已发布文件按原操作保持不可变；事务失败也不能删除另一并发重试正在登记的同一文件。
      return await database.writeTransaction(async c=> {
          await actorLock(c,actor);
          const scope=globalScope(actor),previous=await receipt(c,actor,scope,options.operation,request);if(previous)return{outcome:'committed',result:previous};
          // 同来源登记串行核对字节重复，不把重选文件自动变成新一批。
          if (!(await rows(c,'SELECT source_namespace FROM import_sources WHERE source_namespace=? FOR UPDATE',[options.source])).length) failure('IMPORT_SOURCE_NOT_FOUND',404);
          const same=(await rows(c,'SELECT CAST(id AS CHAR) id FROM import_batches WHERE source_namespace=? AND source_hash=? ORDER BY id DESC LIMIT 1',[options.source,file.sha]))[0];
          if(same && options.new!=='1') {
            const result={batchId:same.id,reused:true};await remember(c,actor,scope,options.operation,request,result);return{outcome:'committed',result};
          }
          await c.execute('INSERT INTO import_batches(source_hash,source_file_ref,source_bytes,source_schema_version,source_app_version,exported_at_text,source_namespace,mapping_json,created_by,current_handler_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',[file.sha,file.file,file.bytes,String(file.parsed.version ?? 'unknown'),file.parsed.appVersion,file.parsed.exportedAt==null?null:String(file.parsed.exportedAt).slice(0,128),options.source,JSON.stringify({filename:options.name,format:file.parsed.format,issues:file.parsed.issues}),actor.id,actor.id]);
          const batchId=await lastId(c);
          for(const item of file.parsed.items) await c.execute('INSERT INTO import_items(batch_id,item_kind,source_sequence,source_key,source_payload_json,validation_json,status) VALUES (?,?,?,?,?,?,\'pending\')',[batchId,item.kind,item.sequence,item.sourceKey,JSON.stringify(item.raw),JSON.stringify({issues:item.issues,present:item.present,originPaths:item.originPaths})]);
          const result={batchId,reused:false};await remember(c,actor,scope,options.operation,request,result);return{outcome:'committed',result};
      });
    },
    readItem(actor:Actor,id:string,itemId:string) { return database.readSnapshot(async c=> {
      await assertActor(c,actor,false,new Date(),false,false);
      const b=await batch(c,id),all=await itemRows(c,id),row=all.find(value=>value.id===itemId);
      if(!row)failure('IMPORT_ITEM_NOT_FOUND',404);
      const {basePayload:_,...item}=await viewItem(c,actor,b,row,all,await bindingRows(c,b.sourceNamespace),await catalogs(c));
      return {item,batchVersion:b.version};
    }); },
    read(actor:Actor,id:string) { return database.readSnapshot(async c=> {
      await assertActor(c,actor,false,new Date(),false,false);const b=await batch(c,id), all=await itemRows(c,id), bindings=await bindingRows(c,b.sourceNamespace), catalog=await catalogs(c);
      const views=[];for(const row of all) {const {basePayload:_,...view}=await viewItem(c,actor,b,row,all,bindings,catalog);views.push(view);}
      const projects=views.filter(v=>v.kind==='project');
      return {batch:{...b,metadata:undefined,name:b.metadata.filename ?? '备份',filename:b.metadata.filename ?? '备份',handlerEnabled:!!b.handlerEnabled,canEdit:b.handlerId===actor.id,canTakeover:!b.handlerEnabled && all.some(v=>v.status==='pending')},sources:await sources(c),items:projects,catalogRows:views.filter(v=>v.kind!=='project'),counts:{total:projects.length,processed:projects.filter(v=>v.previousResult).length,unchanged:projects.filter(v=>!v.previousResult&&(v.unchanged||v.keptOnline)).length,pending:projects.filter(v=>!v.previousResult&&!v.unchanged&&!v.keptOnline).length}};
    }); },
    async item(actor:Actor,batchId:string,itemId:string,action:'preview'|'adopt'|'results/query',input:unknown,requestId:string,execution?:{id:string;token:string}) {
      const body=command(input),scope=`user:${actor.id}:import:item:${itemId}`;
      if(action==='results/query')return database.writeTransaction(async c=> {
        await assertActor(c,actor);await batch(c,batchId,true);
        if(!(await itemRows(c,batchId,itemId,true)).length)failure('IMPORT_ITEM_NOT_FOUND',404);
        const result=await itemResult(c,actor,scope,itemId,body);
        if(result)return{outcome:'committed',result};
        const active=await rows(c,"SELECT id FROM import_executions WHERE batch_id=? AND status IN ('accepted','running') AND JSON_SEARCH(command_json,'one',?,NULL,'$.entries[*].body.idempotencyKey') IS NOT NULL",[batchId,body.idempotencyKey]);
        // 已退役入口不会接受新写入；取原项锁后再次查无结果，才解除旧页面的未知状态。
        return active.length?{outcome:'not_found'}:{outcome:'not_committed',code:'IMPORT_CLIENT_OUTDATED'};
      });
      const execute=async(c:PoolConnection)=> {
        const writing=action!=='preview';
        if(execution)await executionActor(c,actor,execution);else await assertActor(c,actor,false,new Date(),false,writing);
        const initial=await batch(c,batchId);
        const raw=(await itemRows(c,batchId,itemId))[0];if(!raw)failure('IMPORT_ITEM_NOT_FOUND',404);
        if(writing && raw.kind!=='project')await rows(c,'SELECT id FROM system_configuration WHERE id=1 FOR UPDATE');
        await sourceExists(c,initial.sourceNamespace,writing);
        const b=writing?await batch(c,batchId,true):initial;
        if(b.sourceNamespace!==initial.sourceNamespace)failure('IMPORT_BATCH_VERSION_CONFLICT',409,{currentVersion:b.version});
        const row=writing?(await itemRows(c,batchId,itemId,true))[0]:raw;
        if(action!=='preview') { const previous=await itemResult(c,actor,scope,itemId,body,action);if(previous)return{outcome:'committed',result:previous}; assertVersions(b,row,body); }
        const all=await itemRows(c,batchId),bindings=await bindingRows(c,b.sourceNamespace,writing),catalog=await catalogs(c);
        let view=await viewItem(c,actor,b,row,all,bindings,catalog,body);
        if(!view.canEdit && writing)failure(view.targetId?'PROJECT_RESPONSIBILITY_REQUIRED':'IMPORT_HANDLER_REQUIRED',403);
        if(writing && (!body.basis || body.basis!==view.basis))failure('IMPORT_BINDING_CHANGED',409);
        const selected=selection(view.diffs,body.selected ?? []),kept=selection(view.diffs,body.keepOnline ?? [],true),project=row.kind==='project';
        if(selected.some(key=>kept.includes(key)))failure('INVALID_IMPORT_SELECTION',400);
        const candidate=project?selectProject(view.payload,selected):Object.fromEntries(selected.filter(key=>key!=='binding').map(key=>[key,view.payload[key]]));
        if(project)for(const record of view.payload.records??[])if(kept.some(key=>key.startsWith('record.'+record.key+'.'))&&!candidate.records?.some((value:Json)=>value.key===record.key)) (candidate.records??=[]).push({...record,values:{}});
        if(project) Object.assign(candidate,{...(view.targetId?{projectId:view.targetId,expectedVersion:body.expectedVersion ?? view.expectedVersion}:{}),...body.intent?{intent:body.intent}:{}});
        const context={itemId,sourceNamespace:b.sourceNamespace,operationKey:body.idempotencyKey,requestId,
          candidateRecords:view.payload.records ?? [],selectionKeys:Object.fromEntries((view.payload.records ?? []).filter((r:Json)=>view.diffs.some(d=>d.key==='record.'+r.key)).map((r:Json)=>[r.kind+':'+(r.targetId??r.key),'record.'+r.key]))};
        if(action==='preview') {
          const issues=usefulIssues(view,selected),effects:Json[]=[];
          if(selected.length && !issues.length && view.canEdit) {
            try {
              if(project) {
                const result=await validateImportProject(c,actor,candidate,context);
                effects.push(...result.effects);
              } else if(Object.keys(candidate).length) {
                const cmd=validateCatalog(row.kind,{id:view.targetId,expectedVersion:view.expectedVersion ?? '0',idempotencyKey:body.idempotencyKey,changes:candidate});
                const result=await previewCatalogInTransaction(c,row.kind,cmd,false);
                if(result.projects.length)effects.push({message:`共享资料保存后，${result.projects.length} 个已引用项目将使用修改后的资料。`});
              }
            } catch(error) {
              const known=error as {status?:number;code?:string;fields?:Record<string,string>;cause?:string;consequence?:string;requiredKeys?:string[]};if(!known.status)throw error;
              const effect={cause:known.cause,consequence:known.consequence,requiredKeys:known.requiredKeys};
              if(known.fields)for(const [path,message]of Object.entries(known.fields))issues.push({path,message,code:known.code,...effect});
              else issues.push({code:known.code,message:({IMPORT_INTENT_REQUIRED:'阶段倒退或重新打开项目需要明确本次变化原因。',PROJECT_VERSION_CONFLICT:'项目已更新，请重新核对。',IMPORT_RECORD_TARGET_REQUIRED:'请选择记录对应或新增。'} as Json)[known.code ?? ''] ?? '所选信息尚不能保存：'+known.code,...effect});
            }
          }
          const {basePayload:_,...publicView}=view;return {item:publicView,...publicView,issues,effects};
        }
        if(!selected.length&&!kept.length)failure('IMPORT_SELECTION_REQUIRED',422);
        const issues=usefulIssues(view,selected);if(issues.length)issueFailure(issues);
        if(view.targetId && body.expectedVersion!==view.expectedVersion)failure(project?'PROJECT_VERSION_CONFLICT':'CATALOG_VERSION_CONFLICT',409,{currentVersion:view.expectedVersion});
        let result:Json;
        if(project) {
          const locked=await lockImportProject(c,candidate);
          // 锁到实际引用及项目后再次核对资料版本，禁止旧映射悄悄换成新值。
          view=await viewItem(c,actor,b,row,all,bindings,await catalogs(c),body);
          if(view.basis!==body.basis)failure('IMPORT_BINDING_CHANGED',409);
          result=await applyImportProject(c,actor,candidate,context,locked);
        } else if(Object.keys(candidate).length) {
          const cmd=validateCatalog(row.kind,{id:view.targetId,expectedVersion:body.expectedVersion ?? '0',idempotencyKey:body.idempotencyKey,changes:candidate});
          result=await saveCatalogInTransaction(c,actor,row.kind,cmd,requestId,false);
          Object.assign(candidate,cmd.changes);
          result.beforeVersion=view.targetId?view.expectedVersion:null;
        } else {
          if(!view.targetId)failure('IMPORT_SELECTION_REQUIRED',422);
          result={id:view.targetId,savedVersion:view.expectedVersion,beforeVersion:view.expectedVersion,changed:false,affectedProjects:[]};
        }
        const targetId=result.projectId ?? result.id;
        const identity=sourceIdentity(row,all);
        const parent=identity?await bind(c,b.sourceNamespace,row.kind,identity.scope,identity.key,targetId):null;
        const comparisonRecords:Json={};
        if(project && parent)for(const record of (candidate as ImportProjectInput).records ?? []) {
          const id=result.childIdMap[record.key];if(id){const child=await bind(c,b.sourceNamespace,record.kind,`project:${parent.id}:${parent.version}`,record.sourceKey,id);if(child)comparisonRecords[record.key]={...child,targetId:id};}
        }
        if(project&&parent)for(const record of view.payload.records??[])if(kept.some(key=>key.startsWith('record.'+record.key+'.'))&&!comparisonRecords[record.key]) {
          const child=bindings.find(value=>value.kind===record.kind&&value.scope===`project:${parent.id}:${parent.version}`&&value.sourceKey===record.sourceKey&&value.targetId===record.targetId);
          if(child)comparisonRecords[record.key]={id:child.id,version:child.version,targetId:child.targetId};
        }
        const adopted=project?result.adopted:{fields:candidate};
        const sourceComparison=freezeComparison(view.basePayload,project?{...adopted,histories:result.histories}:candidate,view.target,selected,kept,project,result.childIdMap);
        const beforeBinding=sourceBinding(row,all,bindings);
        const frozenResult={action:'adopt',...(project?{projectId:targetId}:{id:targetId,catalogKind:row.kind}),savedVersion:result.savedVersion,beforeVersion:result.beforeVersion ?? null,adoptedCount:selected.filter(k=>k!=='binding').length,keptOnlineCount:kept.length,notAdoptedCount:leaves(view.diffs).filter(v=>!selected.includes(v.key)&&!kept.includes(v.key)&&v.status!=='keep_online').length,changed:result.changed,sourceNamespace:b.sourceNamespace,operationId:body.idempotencyKey,affectedProjects:result.affectedProjects ?? [],savedAt:new Date().toISOString()};
        await c.execute('INSERT INTO import_adoptions(item_id,source_namespace,actor_id,review_version,target_kind,target_id,version_before,version_after,operation_key,request_hash,adopted_json,history_manifest_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))',[itemId,b.sourceNamespace,actor.id,row.reviewVersion,row.kind,targetId,result.beforeVersion ?? null,result.savedVersion,body.idempotencyKey,hash({action:'adopt',body}),JSON.stringify({...adopted,selected,keepOnline:kept,comparisonBase:sourceComparison,comparisonRecords,bindingBefore:beforeBinding?{id:beforeBinding.id,targetId:beforeBinding.targetId,version:beforeBinding.version}:null,bindingAfter:parent,sourceKey:row.sourceKey,result:frozenResult}),project?JSON.stringify(result.historyManifest ?? {}):null]);
        const adoptionId=await lastId(c);
        if(project)await writeImportHistory(c,adoptionId,targetId,itemId,result.histories);
        const resultView={...frozenResult,adoptionId};
        const validation={...row.validation,sourceNamespace:b.sourceNamespace,choice:{mode:'existing',targetId},choiceBinding:parent?{...parent,targetId}:null};
        await c.execute("UPDATE import_items SET corrected_payload_json=?,validation_json=?,target_project_id=?,expected_project_version=?,review_version=review_version+1,corrected_by=IF(? IS NOT NULL,?,corrected_by),corrected_at=IF(? IS NOT NULL,UTC_TIMESTAMP(3),corrected_at),reviewed_by=?,reviewed_at=UTC_TIMESTAMP(3),status='committed',result_json=? WHERE id=?",[JSON.stringify(correctionFor(view.basePayload,view.payload,project)),JSON.stringify(validation),project?targetId:null,project?result.savedVersion:null,body.payload?1:null,actor.id,body.payload?1:null,actor.id,JSON.stringify(resultView),itemId]);
        await remember(c,actor,scope,body.idempotencyKey,{action:'adopt',body},resultView);return{outcome:'committed',result:resultView};
      };
      return action==='preview'?database.readSnapshot(execute):database.writeTransaction(execute);
    },
    async changeBatch(actor:Actor,id:string,action:'source'|'takeover',input:unknown,requestId:string,confirm=false) {
      if(!object(input) || !validId(input.expectedVersion))failure('INVALID_IMPORT_COMMAND',400);operation(input.idempotencyKey);
      const scope=`user:${actor.id}:import:${id}:${action}`;
      if(confirm)return query(actor,input.idempotencyKey,scope,input);
      if(action==='source')sourceKey(input.sourceNamespace);
      if(action==='takeover'&&(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000))failure('IMPORT_TAKEOVER_REASON_REQUIRED',422);
      return database.writeTransaction(async c=> {
        const before=await batch(c,id);
        for(const userId of [...new Set([actor.id,before.handlerId])].sort(idSort))await rows(c,'SELECT id FROM users WHERE id=? FOR UPDATE',[userId]);
        await assertActor(c,actor);
        if(action==='source')await sourceExists(c,input.sourceNamespace,true);
        const current=await batch(c,id,true),prior=await receipt(c,actor,scope,input.idempotencyKey,input);if(prior)return{outcome:'committed',result:prior};
        if(current.version!==input.expectedVersion || before.handlerId!==current.handlerId)failure('IMPORT_BATCH_VERSION_CONFLICT',409,{currentVersion:current.version});
        if(action==='source' && current.handlerId!==actor.id)failure('IMPORT_HANDLER_REQUIRED',403);
        if(action==='takeover' && current.handlerEnabled)failure('IMPORT_HANDLER_ACTIVE',409);
        const after=action==='source'?{sourceNamespace:input.sourceNamespace}:{handlerId:actor.id,reason:input.reason.trim()};
        await c.execute(`UPDATE import_batches SET ${action==='source'?'source_namespace':'current_handler_id'}=?,version=version+1 WHERE id=?`,[action==='source'?input.sourceNamespace:actor.id,id]);
        await audit(c,actor,'import.'+action,'import_batch',id,{sourceNamespace:current.sourceNamespace,handlerId:current.handlerId},after,requestId);
        const result={batchId:id,savedVersion:String(BigInt(current.version)+1n),...after};await remember(c,actor,scope,input.idempotencyKey,input,result);return{outcome:'committed',result};
      });
    },
  };
  return service;
}
