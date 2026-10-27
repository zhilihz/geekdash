import { projectNameKey } from './project-name.js';
import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { failure, validId, validateSave, textColumns, columns, referenceFields, lockReferences, replaceLinks, displayValues, type SaveRequest } from './project-save.js';
import { requireDate, businessToday } from './project-dates.js';
import { finishDraft, validateDraftRef, type DraftRef } from './personal-state.js';
import { stages } from './projects.js';
import { assertBusinessActor } from './project-membership.js';
type CreateFields = SaveRequest['changes'] & { filingDate?: string | null; dueDate?: string | null; inviteeIds?: string[]; managerIds?: string[] };
const createKeys = [...Object.keys(textColumns), 'priority', 'customerIds', 'odmFactoryIds', 'productLineIds', 'appIds', 'groupIds', 'chipSelections', 'people', 'tagIds', 'statusDesc', 'filingDate', 'dueDate', 'inviteeIds', 'managerIds'];
const legacyCreateKeys=[...Object.keys(textColumns),'priority','customerId','odmCustomerId','productLineId','appId','groupId','chipIds','people','tagIds','statusDesc','filingDate','dueDate','inviteeIds','managerIds'];
type Command = { draft?: DraftRef; idempotencyKey: string; expectedVersion?: string; fields?: CreateFields; action?: 'join' | 'leave' };
export function validateCore(value: unknown, create: boolean, legacy = false): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('INVALID_COMMAND', 400);
  const body = value as Command;
  const names = create ? ['idempotencyKey', 'fields', ...Object.hasOwn(body,'draft') ? ['draft'] : []] : ['idempotencyKey', 'expectedVersion', 'action'];
  if (Object.keys(body).length !== names.length || Object.keys(body).some(key => !names.includes(key)) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey ?? '')) failure('INVALID_COMMAND', 400);
  if (!legacy && body.fields && (Object.hasOwn(body.fields, 'managerIds') || Object.hasOwn(body.fields, 'inviteeIds'))) failure('CREATE_PROTOCOL_CHANGED', 409);
  if (body.draft !== undefined) validateDraftRef(body.draft);
  if (create) {
    if (!body.fields || typeof body.fields !== 'object' || Array.isArray(body.fields) || Object.keys(body.fields).some(key => !(legacy?legacyCreateKeys:createKeys).includes(key))) failure('INVALID_COMMAND', 400);
    const { filingDate, dueDate, inviteeIds, managerIds: _legacyManagers, ...fields } = body.fields;
    if (inviteeIds !== undefined && (!Array.isArray(inviteeIds) || inviteeIds.some(id => !validId(id)))) failure('INVALID_PROJECT_FIELDS', 422, { fields: { inviteeIds: '请选择有效的协作者账号' } });
    if (inviteeIds && new Set(inviteeIds).size !== inviteeIds.length) failure('INVALID_PROJECT_FIELDS', 422, { fields: { inviteeIds: '协作者不能重复选择' } });
    const input = validateSave({ idempotencyKey: body.idempotencyKey, expectedVersion: '1', changes: fields },legacy);
    if (!Object.hasOwn(input.changes, 'name') || input.changes.people?.some(person => person.role === 'pm')) failure('INVALID_COMMAND', 400);
    for (const [key, value] of Object.entries({ filingDate, dueDate })) if (value !== undefined && value !== null) requireDate(value, key);
  } else if (!validId(body.expectedVersion) || !['join', 'leave'].includes(body.action ?? '')) failure('INVALID_COMMAND', 400);
  return body;
}
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0]; }
export function projectCore(database: RuntimeDatabase) {
  async function run(actor: Actor, body: Command, id: string | undefined, requestId: string, confirm: boolean) {
    const scope = `user:${actor.id}:project:${id ?? 'new'}:${id ? 'responsibility' : 'create'}`;
    const hash = createHash('sha256').update(JSON.stringify([id ?? null, body.expectedVersion ?? null, body.action ?? null, body.fields ? (Object.keys(body.fields!).some(key=>['customerId','odmCustomerId','productLineId','appId','groupId','chipIds'].includes(key))?legacyCreateKeys:createKeys).filter(key => Object.hasOwn(body.fields!, key)).map(key => [key, body.fields![key as keyof CreateFields]]) : null, ...body.draft ? [body.draft] : []])).digest();
    const lookup = async (c: PoolConnection, lock: boolean) => {
      const row = (await rows(c, `SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?${lock ? ' FOR UPDATE' : ''}`, [scope, body.idempotencyKey]))[0];
      if (!row) return null;
      if (!row.request_hash.equals(hash)) failure('OPERATION_KEY_REUSED', 409);
      return typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.response_json;
    };
    if (id && !confirm) failure('MEMBERSHIP_PROTOCOL_CHANGED', 410);
    if (confirm) return database.readSnapshot(async c => { await assertActor(c,actor,false,new Date(),false,false);const result = await lookup(c, false); return result ? { outcome: 'committed', result } : { outcome: 'not_found' }; });
    return database.writeTransaction(async c => {
      await rows(c, 'SELECT id FROM users WHERE id=? FOR UPDATE',[actor.id]);
      await assertBusinessActor(c, actor);
      // 同一账号的新建命令序列化，唯一回执先于 INSERT 项目。
      const previous = await lookup(c, true); if (previous) return { outcome: 'committed', result: previous };
      const fields = body.fields!;
      const date = businessToday(new Date());
      if (fields.filingDate && fields.filingDate > date) failure('INVALID_PROJECT_DATE', 422, { fields: { filingDate: '立案日期不能晚于今天' } });
      const locked = await lockReferences(c, fields);
      const errors: Record<string, string> = {};
      for (const [key, table] of Object.entries(referenceFields)) {
        const value = fields[key as keyof CreateFields];
        const ids = key === 'chipSelections' ? fields.chipSelections?.map(item => item.chipId) ?? [] : key === 'people' ? fields.people?.map(person => person.id) ?? [] : Array.isArray(value) ? value as string[] : typeof value === 'string' ? [value] : [];
        if (ids.some(id => !locked[table]?.some(row => row.id === id && row.enabled))) errors[key] = '所选资料已停用或不存在，请重新选择';
      }
      if (Object.keys(errors).length) failure('INVALID_PROJECT_FIELDS', 422, { fields: errors });
      const [inserted] = await c.execute<ResultSetHeader>(`INSERT INTO projects (name,name_key,data_kind,created_by,source_namespace,source_key,proposed_on,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,summary,created_at,updated_at)
        VALUES (?,?,'trial',?,'geekdash-manual-v1',?,?,'',?,?,?,?,'','','',?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [fields.name!, projectNameKey(fields.name!), actor.id, actor.id + ':' + body.idempotencyKey, date, fields.marketExpectation ?? '', fields.statusDesc ?? '', fields.detailNote ?? '', fields.summaryNote ?? '', fields.summary ?? '']);
      // mysql2 insertId 的 JS number 可能失真，必须从连接读十进制字符串。
      id = (await rows(c, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
      if (!inserted.affectedRows) failure('CREATE_FAILED', 500);
      const ordinary = Object.keys(columns).filter(key => ['priority', 'customerId', 'odmCustomerId', 'productLineId', 'appId', 'groupId'].includes(key) && Object.hasOwn(fields, key)) as (keyof typeof columns)[];
      const assignments = ordinary.map(key => `\`${columns[key]}\`=?`), params: unknown[] = ordinary.map(key => fields[key]);
      if (fields.filingDate !== undefined) { assignments.push('filed_on=?'); params.push(fields.filingDate); }
      if (fields.dueDate !== undefined) { assignments.push('current_due_date=?', 'original_due_date=?'); params.push(fields.dueDate, fields.dueDate); }
      if (fields.statusDesc) assignments.push('status_description_updated_at=UTC_TIMESTAMP(3)');
      if (assignments.length) await c.query(`UPDATE projects SET ${assignments.join(',')} WHERE id=?`, [...params, id]);
      await replaceLinks(c, id!, fields, true);
      for (const stage of stages) await c.execute('INSERT INTO project_stages (project_id,stage_code,state,note) VALUES (?,?,?,?)', [id!, stage.code, stage.code === 'S1' ? 'ready' : 'locked', '']);
      await c.execute('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))', [id!, actor.id]);
      const version = '1';
      const result = { draft: await finishDraft(c, actor, body.draft, id!, 'create', null, version, {fields: body.fields}), projectId: id, savedVersion: version, operationId: body.idempotencyKey, changed: true, responsible: true };
      const {inviteeIds: _selectedManagers, ...createdFields} = body.fields ?? {};
      await c.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
        VALUES (?,?,'user',?,'project',?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [actor.id, actor.name, 'project.create', id!, id!, null, version, 'null', JSON.stringify({ ...await displayValues(c, createdFields), createdBy: actor.id, managers: [{id:actor.id,name:actor.name}] }), requestId]);
      await c.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,UTC_TIMESTAMP(3))', [actor.id, scope, body.idempotencyKey, hash, JSON.stringify(result)]);
      return { outcome: 'committed', result };
    });
  }
  return { run };
}
