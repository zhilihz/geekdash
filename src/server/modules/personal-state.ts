import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { failure, validId, scopeFields, validateSave } from './project-save.js';
import { validateAction } from './project-actions.js';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : object(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sorted(v[key])])) : v;
  return JSON.stringify(sorted(value));
}
const nestedKeys = new Set('id role code plannedDays note op tempId kind fields changes content level resolved resolution reason correctionReason source decision title stage targetDate output startedOn completedOn previousNodeId nextNodeId x y from to removeEdges replaceEdges affectedIds filingDate startDate dueDate closedOn proposalDate originalDueDate state planKind measures closureType closureNote remainingWorkNote maintenance clearDates action stageCode actualDate completionNote undoStart configVersion ruleVersion previewWeek previewFirstCheckWeek planReason closureAuditId enabled auditId recordId checkId conclusion currentDueDate oldDate newDate'.split(' '));
function tree(value: unknown, depth = 0) {
  if (depth > 12) failure('INVALID_PERSONAL_STATE', 400);
  if (typeof value === 'string' && !value.isWellFormed()) failure('INVALID_PERSONAL_STATE', 400);
  if (Array.isArray(value)) value.forEach(item => tree(item, depth + 1));
  else if (object(value)) for (const [key, item] of Object.entries(value)) { if (!nestedKeys.has(key)) failure('INVALID_PERSONAL_STATE', 400); tree(item, depth + 1); }
  else if (value !== null && !['string','number','boolean'].includes(typeof value)) failure('INVALID_PERSONAL_STATE', 400);
}
const createFields = () => [...scopeFields.basic, 'statusDesc', 'tagIds', 'filingDate', 'dueDate', 'managerIds'];
export type DraftPayload = { schemaVersion: 1; instanceId: string; target?: string; values?: Record<string, unknown>; intent?: Record<string, unknown>; record?: Record<string, unknown>; command?: Record<string, unknown>; submission?: Record<string, unknown> };
export type DraftWrite = { clientDraftId: string; projectId: string | null; formKind: string; baseVersion: string | null; expectedDraftVersion: string; clientSequence: string; payload: DraftPayload; rebaseOperationId?: string };
export type DraftRef = { clientDraftId: string; draftVersion: string };
export function validateDraftRef(value: unknown): DraftRef {
  if (!object(value) || Object.keys(value).length !== 2 || !uuid(value.clientDraftId) || !validId(value.draftVersion)) failure('INVALID_DRAFT_REFERENCE', 400);
  return value as DraftRef;
}
function payload(kind: string, value: unknown): asserts value is DraftPayload {
  if (!object(value) || value.schemaVersion !== 1 || !uuid(value.instanceId) || Object.keys(value).some(key => !['schemaVersion','instanceId','target','values','intent','record','command','submission'].includes(key))) failure('INVALID_PERSONAL_STATE', 400);
  if (value.target !== undefined && !validId(value.target) && !uuid(value.target) && !/^S[1-7]$/.test(String(value.target))) failure('INVALID_PERSONAL_STATE', 400);
  const allowed = kind === 'create' ? createFields() : Object.hasOwn(scopeFields, kind) ? scopeFields[kind as keyof typeof scopeFields] as string[] : [];
  if (value.values !== undefined) { if (!object(value.values) || Object.keys(value.values).some(key => !allowed.includes(key))) failure('INVALID_PERSONAL_STATE', 400); Object.values(value.values).forEach(item => tree(item)); }
  if (value.intent !== undefined) { if (kind !== 'basic' && kind !== 'create' || !object(value.intent)) failure('INVALID_PERSONAL_STATE', 400); tree(value.intent); }
  if (value.record !== undefined) { if (!['risk','change','customerNode','projectNodes'].includes(kind) || !object(value.record)) failure('INVALID_PERSONAL_STATE', 400); tree(value.record); }
  if (value.command !== undefined) { if (kind !== 'action' || !object(value.command)) failure('INVALID_PERSONAL_STATE', 400); tree(value.command); }
  if (value.submission !== undefined) {
    const submission = value.submission;
    if (!object(submission) || Object.keys(submission).some(key => !['scope','target','changes','commands','basicIntent','fields','command'].includes(key))) failure('INVALID_PERSONAL_STATE', 400);
    const fields = kind === 'create' ? submission.fields : kind === 'action' ? undefined : submission.changes;
    if (kind !== 'action' && (!object(fields) || Object.keys(fields).some(key => !allowed.includes(key)))) failure('INVALID_PERSONAL_STATE', 400);
    if (fields) Object.values(fields).forEach(item => tree(item));
    if (kind === 'create' ? Object.keys(submission).some(key => key !== 'fields') : kind === 'action' ? Object.keys(submission).some(key => key !== 'command') : submission.scope !== kind || submission.target !== value.target) failure('INVALID_PERSONAL_STATE', 400);
    if (submission.commands !== undefined) { if (kind !== 'basic') failure('INVALID_PERSONAL_STATE', 400); tree(submission.commands); }
    if (submission.basicIntent !== undefined) { if (kind !== 'basic' || submission.commands !== undefined || !object(submission.basicIntent)) failure('INVALID_PERSONAL_STATE', 400); tree(submission.basicIntent); }
    if (submission.command !== undefined) tree(submission.command);
  }
  if (Buffer.byteLength(canonical(value), 'utf8') > 1048576) failure('DRAFT_TOO_LARGE', 413);
}
function validateWrite(value: unknown): DraftWrite {
  if (!object(value) || Object.keys(value).some(key => !['clientDraftId','projectId','formKind','baseVersion','expectedDraftVersion','clientSequence','payload','rebaseOperationId'].includes(key)) || !uuid(value.clientDraftId) || !['create','action',...Object.keys(scopeFields)].includes(String(value.formKind)) || !validId(value.clientSequence) || !(value.expectedDraftVersion === '0' || validId(value.expectedDraftVersion))) failure('INVALID_PERSONAL_STATE', 400);
  if (value.formKind === 'create' ? value.projectId !== null || value.baseVersion !== null : !validId(value.projectId) || !validId(value.baseVersion)) failure('INVALID_PERSONAL_STATE', 400);
  if (value.rebaseOperationId !== undefined && !uuid(value.rebaseOperationId)) failure('INVALID_PERSONAL_STATE', 400);
  payload(String(value.formKind), value.payload); return value as DraftWrite;
}
const columns = 'CAST(id AS CHAR) id,client_draft_id clientDraftId,CAST(project_id AS CHAR) projectId,form_kind formKind,CAST(base_version AS CHAR) baseVersion,CAST(draft_version AS CHAR) draftVersion,CAST(client_sequence AS CHAR) clientSequence,payload_json payload,state,CAST(submitted_project_version AS CHAR) submittedProjectVersion,updated_at updatedAt';
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0]; }
async function editable(c: PoolConnection, actor: Actor, id: string) {
  if (!(await rows(c,'SELECT id FROM projects WHERE id=? FOR SHARE',[id])).length) failure('PROJECT_NOT_FOUND',404);
  if (!(await rows(c,'SELECT user_id FROM project_responsibilities WHERE project_id=? AND user_id=?',[id,actor.id])).length) failure('PROJECT_READ_ONLY',403);
}
const preferenceKeys: Record<string, string[]> = {
  appearance: ['theme','layout','visibleFilters'], 'summary-layout': ['columns','hiddenColumns','showStatus','showNotes','showChipNotes'],
  board: ['view','filters','sort','page','anchor','scrollY','filtersOpen'], checks: ['view','filters','page','anchor','scrollY','expanded'],
  summary: ['filters','sort','rowOrder','hiddenRows','scrollY','anchor','filtersOpen'], detail: ['projectId','tab','expanded','scrollY','viewport'],
  imports: ['batchId','sourceNamespace','sourceName','view','search','cards','pendingUpload','pendingBatch'],
};
function preferenceAddress(device: unknown, scope: unknown) {
  if (typeof scope !== 'string' || !Object.hasOwn(preferenceKeys,scope) || (['appearance','summary-layout','imports'].includes(scope) ? device !== 'account' : !uuid(device))) failure('INVALID_PERSONAL_STATE',400);
}
function preferenceValue(scope: string, value: unknown) {
  if (!object(value) || value.schemaVersion !== 1 || Object.keys(value).some(key => key !== 'schemaVersion' && !preferenceKeys[scope].includes(key))) failure('INVALID_PERSONAL_STATE',400);
  if (scope === 'imports') {
    if (Buffer.byteLength(canonical(value),'utf8') > 1048576) failure('PREFERENCE_TOO_LARGE',413);
    for (const [key,item] of Object.entries(value)) {
      if (key === 'schemaVersion' || item === null) continue;
      if (['cards','pendingUpload','pendingBatch'].includes(key) ? !object(item) : typeof item !== 'string' || item.length > 2048) failure('INVALID_PERSONAL_STATE',400);
    }
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'schemaVersion') continue;
    if (key==='page' && (typeof item!=='number' || !Number.isSafeInteger(item) || item<1) || key==='scrollY' && (typeof item!=='number' || !Number.isFinite(item) || item<0)) failure('INVALID_PERSONAL_STATE',400);
    if (['filtersOpen','showStatus','showNotes','showChipNotes'].includes(key) && typeof item!=='boolean') failure('INVALID_PERSONAL_STATE',400);
    if (key==='view' && (typeof item!=='string' || !['active','proposal','closed','maintenance','all'].includes(item))) failure('INVALID_PERSONAL_STATE',400);
    if (scope==='summary' && key==='sort' && (typeof item!=='string' || !['customer','group','chip','stage','dueDate'].includes(item))) failure('INVALID_PERSONAL_STATE',400);
    if (scope==='summary' && ['rowOrder','hiddenRows'].includes(key) && (!Array.isArray(item) || item.some(id=>!validId(id)))) failure('INVALID_PERSONAL_STATE',400);
    if (scope==='summary-layout' && ['columns','hiddenColumns'].includes(key) && (!Array.isArray(item) || item.some(name=>!['customer','group','name','chips','status','engineers','note','chipNote','stage','node','dueDate','delay'].includes(name)))) failure('INVALID_PERSONAL_STATE',400);
    if (key === 'theme' && (typeof item!=='string' || !['dark','light','warm'].includes(item)) || key === 'layout' && (typeof item!=='string' || !['cards','progress'].includes(item))) failure('INVALID_PERSONAL_STATE',400);
    if (key === 'filters') { if (!object(item) || Object.keys(item).some(name => !['search','customer','productLine','odmFactory','app','group','status','priority','signal','stage','progress','chip','tags','owner','deadline','checkToday',...scope==='summary'?['assignment']:[]].includes(name)) || Object.values(item).some(v => typeof v !== 'string' && (!Array.isArray(v) || v.some(x => typeof x !== 'string')))) failure('INVALID_PERSONAL_STATE',400); }
    else if (key === 'viewport') { if (!object(item) || Object.keys(item).some(k => !['x','y','zoom'].includes(k)) || Object.values(item).some(v => typeof v !== 'number' || !Number.isFinite(v))) failure('INVALID_PERSONAL_STATE',400); }
    else if (Array.isArray(item)) { if (item.some(v => typeof v !== 'string' || v.length > 255)) failure('INVALID_PERSONAL_STATE',400); }
    else if (!['string','number','boolean'].includes(typeof item) || typeof item === 'string' && item.length > 2048) failure('INVALID_PERSONAL_STATE',400);
  }
  if (Buffer.byteLength(canonical(value),'utf8') > 1048576) failure('PREFERENCE_TOO_LARGE',413);
}
// 只能终结同范围、同修订、同正文；较新输入保留，正式保存不依赖另一次删除请求。
function submissionText(kind: string, value: unknown) {
  if (!object(value)) return undefined;
  const envelope = {expectedVersion:'1',idempotencyKey:'00000000-0000-4000-8000-000000000000'};
  try {
    if (kind === 'create') return canonical(value);
    if (kind === 'action') {
      const {expectedVersion,idempotencyKey,...command} = validateAction({...value.command as object,...envelope});
      return canonical({command});
    }
    const {expectedVersion,idempotencyKey,...request} = validateSave({...value,...envelope});
    if (request.commands) request.commands = request.commands.map(({expectedVersion,idempotencyKey,...command}) => command) as typeof request.commands;
    return canonical(request);
  } catch { return undefined; } // 尚未填完或与正式校验不同的底稿继续保留。
}
export async function finishDraft(c: PoolConnection, actor: Actor, ref: DraftRef | undefined, projectId: string, kind: string, baseVersion: string | null, savedVersion: string, submission: unknown) {
  if (!ref) return undefined;
  const row = (await rows(c,`SELECT ${columns} FROM project_drafts WHERE user_id=? AND client_draft_id=? FOR UPDATE`,[actor.id,ref.clientDraftId]))[0];
  if (!row) failure('DRAFT_NOT_FOUND',404);
  if (row.projectId !== (kind === 'create' ? null : projectId) || row.formKind !== kind) failure('DRAFT_SCOPE_MISMATCH',400);
  const savedText = submissionText(kind,row.payload.submission);
  const matched = row.state === 'active' && row.draftVersion === ref.draftVersion && row.baseVersion === baseVersion && savedText !== undefined && savedText === submissionText(kind,submission);
  if (matched) await c.execute("UPDATE project_drafts SET state='committed',submitted_project_version=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?",[savedVersion,row.id]);
  return { ...ref, instanceId: row.payload.instanceId, state: matched ? 'committed' : 'preserved' };
}
export function personalState(database: RuntimeDatabase) {
  return {
    preferences(actor: Actor, device: string, scope: string) {
      preferenceAddress(device,scope);
      return database.readSnapshot(async c => { await assertActor(c,actor,false,new Date(),false,false); return (await rows(c,'SELECT value_json value,CAST(version AS CHAR) version FROM user_preferences WHERE user_id=? AND device_key=? AND scope=?',[actor.id,device,scope]))[0] ?? {version:'0',value:null}; });
    },
    savePreferences(actor: Actor, input: unknown) {
      if (!object(input) || Object.keys(input).length !== 4 || Object.keys(input).some(key => !['deviceKey','scope','expectedVersion','value'].includes(key)) || !(input.expectedVersion === '0' || validId(input.expectedVersion))) failure('INVALID_PERSONAL_STATE',400);
      preferenceAddress(input.deviceKey,input.scope); preferenceValue(String(input.scope),input.value);
      const deviceKey = String(input.deviceKey), scope = String(input.scope);
      return database.writeTransaction(async c => {
        await rows(c,'SELECT id FROM users WHERE id=? FOR UPDATE',[actor.id]); await assertActor(c,actor);
        const row = (await rows(c,'SELECT value_json value,CAST(version AS CHAR) version FROM user_preferences WHERE user_id=? AND device_key=? AND scope=? FOR UPDATE',[actor.id,input.deviceKey,input.scope]))[0];
        if (row?.version !== input.expectedVersion && !(input.expectedVersion === '0' && !row)) failure('PREFERENCE_VERSION_CONFLICT',409);
        if (row && canonical(row.value) === canonical(input.value)) return row;
        if (row?.version === '18446744073709551615') failure('PREFERENCE_VERSION_EXHAUSTED',422);
        if (row) await c.execute('UPDATE user_preferences SET value_json=?,version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE user_id=? AND device_key=? AND scope=?',[canonical(input.value),actor.id,deviceKey,scope]);
        else await c.execute('INSERT INTO user_preferences (user_id,device_key,scope,value_json,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP(3))',[actor.id,deviceKey,scope,canonical(input.value)]);
        return {version:row ? String(BigInt(row.version)+1n) : '1',value:input.value};
      });
    },
    save(actor: Actor, input: unknown) {
      const body = validateWrite(input);
      return database.writeTransaction(async c => {
        // ponytail: 每账号用现有用户行串行校验100份容量，未来实测争用明显再拆容量锁。
        await rows(c,'SELECT id FROM users WHERE id=? FOR UPDATE',[actor.id]); await assertActor(c,actor);
        if (body.projectId) await editable(c,actor,body.projectId);
        const current = (await rows(c,`SELECT ${columns} FROM project_drafts WHERE user_id=? AND client_draft_id=? FOR UPDATE`,[actor.id,body.clientDraftId]))[0];
        if (current) {
          if (current.state !== 'active') failure('DRAFT_TERMINAL',409);
          if (current.projectId !== body.projectId || current.formKind !== body.formKind || current.payload.instanceId !== body.payload.instanceId || current.payload.target !== body.payload.target) failure('DRAFT_SCOPE_MISMATCH',400);
          if (current.clientSequence === body.clientSequence && current.baseVersion === body.baseVersion && canonical(current.payload) === canonical(body.payload)) return current;
          if (current.draftVersion !== body.expectedDraftVersion || BigInt(body.clientSequence) <= BigInt(current.clientSequence)) failure('DRAFT_VERSION_CONFLICT',409);
          if (current.baseVersion !== body.baseVersion) {
            if (!body.rebaseOperationId) failure('DRAFT_BASE_CHANGED',409);
            const receipt = (await rows(c,"SELECT response_json result FROM command_receipts WHERE actor_id=? AND command_scope IN (?,?) AND idempotency_key=?",[actor.id,`user:${actor.id}:project:${body.projectId}:scoped`,`user:${actor.id}:project:${body.projectId}:actions`,body.rebaseOperationId]))[0]?.result;
            if (!receipt || receipt.baseVersion !== current.baseVersion || receipt.savedVersion !== body.baseVersion || receipt.draft?.instanceId !== current.payload.instanceId || receipt.draft?.clientDraftId === body.clientDraftId) failure('DRAFT_BASE_CHANGED',409);
            const currentProject = (await rows(c,'SELECT CAST(version AS CHAR) version FROM projects WHERE id=?',[body.projectId]))[0];
            if (currentProject.version !== body.baseVersion) failure('PROJECT_VERSION_CONFLICT',409);
          }
          if (current.draftVersion === '18446744073709551615') failure('DRAFT_VERSION_EXHAUSTED',422);
          await c.execute('UPDATE project_drafts SET base_version=?,draft_version=draft_version+1,client_sequence=?,payload_json=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?',[body.baseVersion,body.clientSequence,canonical(body.payload),current.id]);
        } else {
          if (body.expectedDraftVersion !== '0' || body.rebaseOperationId) failure('DRAFT_VERSION_CONFLICT',409);
          const count = (await rows(c,"SELECT COUNT(*) n FROM project_drafts WHERE user_id=? AND state='active'",[actor.id]))[0].n;
          if (Number(count) >= 100) failure('DRAFT_CAPACITY_REACHED',422);
          await c.execute("INSERT INTO project_drafts (user_id,project_id,client_draft_id,form_kind,base_version,client_sequence,payload_json,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",[actor.id,body.projectId,body.clientDraftId,body.formKind,body.baseVersion,body.clientSequence,canonical(body.payload)]);
        }
        return (await rows(c,`SELECT ${columns} FROM project_drafts WHERE user_id=? AND client_draft_id=?`,[actor.id,body.clientDraftId]))[0];
      });
    },
    read(actor: Actor, projectId?: string | null, clientDraftId?: string) {
      if (projectId !== undefined && projectId !== null && !validId(projectId) || clientDraftId !== undefined && !uuid(clientDraftId)) failure('INVALID_PERSONAL_STATE',400);
      return database.readSnapshot(async c => { await assertActor(c,actor,false,new Date(),false,false); return { items: await rows(c,`SELECT ${columns} FROM project_drafts WHERE user_id=?${clientDraftId ? ' AND client_draft_id=?' : " AND state='active'"}${projectId === null ? ' AND project_id IS NULL' : projectId ? ' AND project_id=?' : ''} ORDER BY updated_at DESC,id DESC`,[actor.id,...clientDraftId ? [clientDraftId] : [],...projectId ? [projectId] : []]) }; });
    },
    discard(actor: Actor, input: unknown) {
      const ref = validateDraftRef(input);
      return database.writeTransaction(async c => {
        await assertActor(c,actor); const row = (await rows(c,`SELECT ${columns} FROM project_drafts WHERE user_id=? AND client_draft_id=? FOR UPDATE`,[actor.id,ref.clientDraftId]))[0];
        if (!row) failure('DRAFT_NOT_FOUND',404);
        if (row.state === 'discarded' && row.draftVersion === ref.draftVersion) return { state: 'discarded' };
        if (row.state !== 'active') failure('DRAFT_TERMINAL',409);
        if (row.draftVersion !== ref.draftVersion) failure('DRAFT_VERSION_CONFLICT',409);
        await c.execute("UPDATE project_drafts SET state='discarded',updated_at=UTC_TIMESTAMP(3) WHERE id=?",[row.id]); return { state: 'discarded' };
      });
    },
  };
}
