import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { failure, validId, applyReferenceProjectChanges } from './project-save.js';
import { canonical } from './personal-state.js';

const definitions: Record<string, { table: string; fields: Record<string, [string, number]> }> = {
  customers: { table: 'customers', fields: { name: ['name',255], contact: ['contact',65535], background: ['background',65535] } },
  odmFactories: { table: 'customers', fields: { name: ['name',255], contact: ['contact',65535], background: ['background',65535] } },
  engineers: { table: 'engineers', fields: { name: ['name',255], role: ['role',64] } },
  productLines: { table: 'product_lines', fields: { name: ['name',255] } },
  apps: { table: 'apps', fields: { name: ['name',255], appVersion: ['app_version',64], description: ['description',65535] } },
  tags: { table: 'tags', fields: { name: ['name',255] } },
  groups: { table: 'project_groups', fields: { name: ['name',255] } },
  chips: { table: 'chips', fields: { name: ['name',255], originalModel: ['original_model',255], manufacturer: ['manufacturer',255], firmwareVersion: ['firmware_version',128] } },
  company: { table: 'system_configuration', fields: { fullName: ['full_name',255], shortName: ['short_name',128], managerText: ['manager_text',65535], namePrefix: ['name_prefix',128] } },
};
type Values = Record<string, string | boolean | string[]>;
export type CatalogCommand = { id: string | null; expectedVersion: string; idempotencyKey: string; changes: Values; impactToken?: string };
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const nameKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en-US');
function definition(kind: string) { if (!Object.hasOwn(definitions,kind)) failure('CATALOG_KIND_NOT_FOUND',404); return definitions[kind]; }
export function validateCatalog(kind: string, input: unknown): CatalogCommand {
  const def = definition(kind), body = input as CatalogCommand;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['id','expectedVersion','idempotencyKey','changes','impactToken'].includes(key))
    || !(body.id === null || validId(body.id)) || !(body.id === null ? body.expectedVersion === '0' : validId(body.expectedVersion)) || !uuid(body.idempotencyKey)
    || !body.changes || typeof body.changes !== 'object' || Array.isArray(body.changes) || !Object.keys(body.changes).length
    || body.impactToken !== undefined && (typeof body.impactToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.impactToken))) failure('INVALID_CATALOG_COMMAND',400);
  if (kind === 'company' && body.id !== '1') failure('INVALID_CATALOG_COMMAND',400);
  const changes: Values = {};
  for (const [key,value] of Object.entries(body.changes)) {
    if (key === 'enabled' && kind !== 'company') { if (typeof value !== 'boolean') failure('INVALID_CATALOG_FIELD',400,{field:key}); changes[key]=value; }
    else if (key === 'tagIds' && kind === 'customers') {
      if (!Array.isArray(value) || value.some(id => !validId(id)) || new Set(value).size !== value.length) failure('INVALID_CATALOG_FIELD',400,{field:key}); changes[key]=value;
    } else {
      const field=def.fields[key];
      if (!field || typeof value !== 'string' || !value.isWellFormed() || value.includes('\0') || [...value].length > field[1] || field[1] === 65535 && Buffer.byteLength(value,'utf8') > 65535) failure('INVALID_CATALOG_FIELD',400,{field:key});
      changes[key]=key === 'name' ? value.trim() : value;
      if (key === 'name' && !nameKey(value)) failure('CATALOG_NAME_REQUIRED',422,{field:key});
    }
  }
  if (body.id === null && !changes.name) failure('CATALOG_NAME_REQUIRED',422,{field:'name'});
  return { id:body.id, expectedVersion:body.expectedVersion, idempotencyKey:body.idempotencyKey, changes, ...(body.impactToken ? {impactToken:body.impactToken} : {}) };
}

async function configuration(c: PoolConnection, actor: Actor, lock = false) {
  await assertActor(c,actor);
  const [rows]=await c.query<RowDataPacket[]>(`SELECT id FROM system_configuration WHERE id=1${lock ? ' FOR UPDATE' : ''}`);
  if (!rows.length) failure('SYSTEM_CONFIGURATION_REQUIRED',422);
}
async function rows(c: PoolConnection, kind: string, id?: string, lock = false) {
  const def=definition(kind);
  const [items]=await c.query<RowDataPacket[]>(`SELECT CAST(id AS CHAR) id,CAST(version AS CHAR) version,${Object.entries(def.fields).map(([key,[column]]) => `COALESCE(\`${column}\`,'') \`${key}\``).join(',')}${kind === 'company' ? '' : ',enabled'} FROM ${def.table}${id ? ' WHERE id=?' : ''}${kind === 'odmFactories' ? (id ? ' AND ' : ' WHERE ') + '(is_odm=1 OR EXISTS(SELECT 1 FROM project_odm_factories l WHERE l.customer_id=customers.id))' : kind === 'customers' ? (id ? ' AND ' : ' WHERE ') + 'is_customer=1' : ''} ORDER BY id${lock ? ' FOR UPDATE' : ''}`,id ? [id] : []);
  for (const item of items) {
    if (kind !== 'company') item.enabled=!!item.enabled;
    if (kind === 'customers') { const [tags]=await c.query<RowDataPacket[]>('SELECT CAST(tag_id AS CHAR) id FROM customer_tags WHERE customer_id=? ORDER BY sort_order,tag_id',[item.id]); item.tagIds=tags.map(tag=>tag.id); }
  }
  return items;
}
async function references(c: PoolConnection, kind: string, id: string) {
  const conditions: Record<string,string> = {
    customers:'EXISTS(SELECT 1 FROM project_customers l WHERE l.project_id=p.id AND l.customer_id=?) OR EXISTS(SELECT 1 FROM project_odm_factories l WHERE l.project_id=p.id AND l.customer_id=?)',
    odmFactories:'EXISTS(SELECT 1 FROM project_customers l WHERE l.project_id=p.id AND l.customer_id=?) OR EXISTS(SELECT 1 FROM project_odm_factories l WHERE l.project_id=p.id AND l.customer_id=?)',
    productLines:'EXISTS(SELECT 1 FROM project_product_lines l WHERE l.project_id=p.id AND l.product_line_id=?)', apps:'EXISTS(SELECT 1 FROM project_apps l WHERE l.project_id=p.id AND l.app_id=?)', groups:'EXISTS(SELECT 1 FROM project_group_links l WHERE l.project_id=p.id AND l.group_id=?)',
    chips:'EXISTS (SELECT 1 FROM project_chip_selections r WHERE r.project_id=p.id AND r.chip_id=?)',
    engineers:'EXISTS (SELECT 1 FROM project_people r WHERE r.project_id=p.id AND r.engineer_id=?)',
    tags:'EXISTS (SELECT 1 FROM project_tags r WHERE r.project_id=p.id AND r.tag_id=?) OR EXISTS (SELECT 1 FROM customer_tags r WHERE r.tag_id=? AND (EXISTS(SELECT 1 FROM project_customers l WHERE l.project_id=p.id AND l.customer_id=r.customer_id) OR EXISTS(SELECT 1 FROM project_odm_factories l WHERE l.project_id=p.id AND l.customer_id=r.customer_id)))',
  };
  if (kind === 'company') return { projects:[] as RowDataPacket[], customers:[] as RowDataPacket[] };
  const condition=conditions[kind];
  const [projects]=await c.query<RowDataPacket[]>(`SELECT CAST(p.id AS CHAR) projectId,p.name,CAST(p.version AS CHAR) version FROM projects p WHERE p.deleted_at IS NULL AND (${condition}) ORDER BY p.id`,Array(condition.split('?').length-1).fill(id));
  const customers = kind === 'tags' ? (await c.query<RowDataPacket[]>('SELECT CAST(c.id AS CHAR) id,c.name,CAST(c.version AS CHAR) version FROM customers c JOIN customer_tags r ON r.customer_id=c.id WHERE r.tag_id=? ORDER BY c.id',[id]))[0] : [];
  return {projects,customers};
}
async function prepare(c: PoolConnection, kind: string, body: CatalogCommand, lock: boolean) {
  const def=definition(kind);
  if (lock && kind === 'tags' && body.id) {
    // 客户标签间接影响项目。先锁客户再锁标签，沿项目保存的资料表顺序阻止漏掉新引用。
    const [customers]=await c.query<RowDataPacket[]>('SELECT CAST(customer_id AS CHAR) id FROM customer_tags WHERE tag_id=? ORDER BY customer_id',[body.id]);
    for (const customer of customers) await c.query('SELECT id FROM customers WHERE id=? FOR UPDATE',[customer.id]);
  }
  const before=body.id ? (await rows(c,kind,body.id,lock))[0] : null;
  if (body.id && !before) failure('CATALOG_NOT_FOUND',404);
  if (before && before.version !== body.expectedVersion) failure('CATALOG_VERSION_CONFLICT',409,{currentVersion:before.version});
  const after: Values={...(before as Values | null ?? Object.fromEntries(Object.keys(def.fields).map(key=>[key,'']))),...(!before ? {enabled:true,...kind === 'customers' ? {tagIds:[]} : {}} : {}),...body.changes};
  // 共享资料写入由配置行串行化；现有歧义允许纠正其他字段，不把同名实体合并。
  if (Object.hasOwn(body.changes,'name') && (!before || before.name !== after.name)) {
    const [names]=await c.query<RowDataPacket[]>(`SELECT CAST(id AS CHAR) id,name FROM ${def.table}`);
    const conflicts=names.filter(item=>item.id !== body.id && nameKey(item.name) === nameKey(after.name as string));
    if (conflicts.length) failure('CATALOG_NAME_CONFLICT',409,{field:'name',conflicts});
  }
  if (kind === 'customers' && Object.hasOwn(body.changes,'tagIds')) {
    for (const id of [...body.changes.tagIds as string[]].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1)) {
      const [tags]=await c.query<RowDataPacket[]>(`SELECT enabled FROM tags WHERE id=?${lock ? ' FOR SHARE' : ''}`,[id]);
      if (!tags.length || !tags[0].enabled && !before?.tagIds.includes(id)) failure('CATALOG_REFERENCE_UNAVAILABLE',422,{field:'tagIds',id});
    }
  }
  const impact=body.id ? await references(c,kind,body.id) : {projects:[],customers:[]};
  if (lock) {
    for (const project of impact.projects) await c.query('SELECT id FROM projects WHERE id=? FOR UPDATE',[project.projectId]);
    // 移除旧引用不必锁资料；取得项目锁后重读，禁止以过时的引用清单提交。
    if (body.id) Object.assign(impact,await references(c,kind,body.id));
  }
  const changed=!before || Object.keys(body.changes).some(key=>canonical(before[key]) !== canonical(after[key]));
  return {before,after,changed,...impact,impactToken:digest([kind,body.id,body.expectedVersion,body.changes,impact])};
}

export async function saveCatalogInTransaction(c: PoolConnection, actor: Actor, kind: string, body: CatalogCommand, requestId: string, requireImpact = true) {
  const def=definition(kind);
  const preview=await prepare(c,kind,body,true), {before,after,changed}=preview;
  if (requireImpact && body.id && changed && kind !== 'company' && body.impactToken !== preview.impactToken) failure('CATALOG_IMPACT_CHANGED',409,{projects:preview.projects,customers:preview.customers});
  let id=body.id, savedVersion=before?.version ?? '1';
  let affectedProjects: {projectId:string;version:string}[]=[];
  const at=new Date().toISOString().slice(0,23).replace('T',' ');
  if (changed) {
    if (before?.version === '18446744073709551615') failure('CATALOG_VERSION_EXHAUSTED',422);
    const keys=Object.keys(def.fields), columns=keys.map(key=>`\`${def.fields[key][0]}\``), values=keys.map(key=>after[key]);
    if (kind !== 'company') {columns.push('enabled');values.push(!!after.enabled);}
    if (id) {
      savedVersion=String(BigInt(before!.version)+1n);
      await c.execute(`UPDATE ${def.table} SET ${columns.map(column=>column+'=?').join(',')},version=version+1,updated_at=?${kind === 'company' ? ',updated_by=?' : ''} WHERE id=?`,[...values,at,...kind === 'company' ? [actor.id] : [],id]);
    } else {
      if (kind === 'odmFactories') { columns.push('is_customer','is_odm'); values.push(false,true); }
      await c.execute(`INSERT INTO ${def.table} (${columns.join(',')},created_at,updated_at) VALUES (${columns.map(()=>'?').join(',')},?,?)`,[...values,at,at]);
      id=(await c.query<RowDataPacket[]>('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id;
    }
    if (kind === 'customers' && (!before || Object.hasOwn(body.changes,'tagIds'))) {
      await c.execute('DELETE FROM customer_tags WHERE customer_id=?',[id]);
      for (const [index,tag] of (after.tagIds as string[]).entries()) await c.execute('INSERT INTO customer_tags (customer_id,tag_id,sort_order) VALUES (?,?,?)',[id,tag,index]);
    }
    const oldValues=before ? {catalogName:before.name ?? before.fullName,...Object.fromEntries(Object.keys(body.changes).map(key=>[key,before[key]]))} : null;
    const newValues={catalogName:after.name ?? after.fullName,...Object.fromEntries(Object.keys(body.changes).map(key=>[key,after[key]]))};
    await c.execute("INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user',?,?,?,?,?,?,?,?,?,?)",[actor.id,actor.name,`catalog.${kind}.save`,def.table,id,null,before?.version ?? null,savedVersion,JSON.stringify(oldValues),JSON.stringify(newValues),requestId,at]);
    affectedProjects=await applyReferenceProjectChanges(c,actor,preview.projects.map(project=>({projectId:project.projectId,version:project.version})),{action:`catalog.${kind}.save`,entityType:def.table,entityId:id!,beforeValues:oldValues,afterValues:newValues,requestId,at});
  }
  const result={id,savedVersion,changed,operationId:body.idempotencyKey,affectedProjects};
  return result;
}

export { rows as readCatalogInTransaction, prepare as previewCatalogInTransaction, configuration as lockCatalogConfiguration, definition as catalogDefinition, nameKey as catalogNameKey };

export function catalog(database: RuntimeDatabase) {
  return {
    read(actor: Actor, kind: string) { definition(kind); return database.readSnapshot(async c=>{await configuration(c,actor);return {canMaintain:true,items:await rows(c,kind)};}); },
    detail(actor: Actor, kind: string, id: string) { return database.readSnapshot(async c=>{
      if (!validId(id)) failure('INVALID_CATALOG_COMMAND',400);
      await configuration(c,actor);const item=(await rows(c,kind,id))[0];
      if (!item) failure('CATALOG_NOT_FOUND',404);
      return {canMaintain:true,item,...await references(c,kind,id)};
    }); },
    preview(actor: Actor, kind: string, body: CatalogCommand) { return database.readSnapshot(async c=>{
      await configuration(c,actor);
      return prepare(c,kind,body,false);
    }); },
    save(actor: Actor, kind: string, body: CatalogCommand, requestId: string, confirm = false) {
      const scope=`user:${actor.id}:catalog:${kind}`, hash=Buffer.from(digest(body),'hex');
      const lookup=async(c: PoolConnection)=>{
        const [found]=await c.query<RowDataPacket[]>('SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?',[scope,body.idempotencyKey]);
        if (!found.length) return null;
        if (!found[0].request_hash.equals(hash)) failure('OPERATION_KEY_REUSED',409);
        return typeof found[0].response_json === 'string' ? JSON.parse(found[0].response_json) : found[0].response_json;
      };
      if (confirm) return database.readSnapshot(async c=>{await assertActor(c,actor);const result=await lookup(c);return result ? {outcome:'committed',result} : {outcome:'not_found'};});
      return database.writeTransaction(async c=>{
        // ponytail: 共享资料写入共用配置行锁防止跨账号重名；仅在资料写入吞吐成为瓶颈时细分。
        await configuration(c,actor,true);const prior=await lookup(c);
        if (prior) return {outcome:'committed',result:prior};
        const result=await saveCatalogInTransaction(c,actor,kind,body,requestId);
        const at=new Date().toISOString().slice(0,23).replace('T',' ');
        await c.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,?)',[actor.id,scope,body.idempotencyKey,hash,JSON.stringify(result),at]);
        return {outcome:'committed',result};
      });
    },
  };
}
