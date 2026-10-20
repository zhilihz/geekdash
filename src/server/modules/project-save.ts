import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { applyAction, projectSql, validateAction, type ActionCommand } from './project-actions.js';
import { currentClosure } from './project-closures.js';
import { finishDraft, validateDraftRef, type DraftRef } from './personal-state.js';
import { validateChangeOps, changeCandidate, writeChanges, type ChangeOperation, validateRiskOps, riskCandidate, writeRisks, validateNodeOps, nodeCandidate, writeNodes, type NodeOperation, type RiskOperation } from './project-records.js';
import { businessToday, requireDate } from './project-dates.js';

export const textColumns = { name: 'name', marketExpectation: 'market_expectation', detailNote: 'detail_note', summaryNote: 'summary_note', summary: 'summary' } as const;
export const columns = { ...textColumns, signalNote: 'signal_note', chipstatNote: 'chipstat_note', statusDesc: 'status_description', signal: 'signal', priority: 'priority', customerId: 'customer_id', odmCustomerId: 'odm_customer_id', productLineId: 'product_line_id', appId: 'app_id', groupId: 'group_id' } as const;
export const referenceFields = { customerId: 'customers', odmCustomerId: 'customers', productLineId: 'product_lines', appId: 'apps', groupId: 'project_groups', chipIds: 'chips', tagIds: 'tags', people: 'engineers' } as const;
const collections = ['chipIds', 'tagIds', 'people'] as const;
const roles = ['pm', 'hardware_owner', 'software_owner', 'participant'];
type Person = { id: string; role: string };
type StagePlan = { code: string; plannedDays?: number | null; note?: string };
export type TextValues = Record<keyof typeof textColumns, string>;
type Values = TextValues & { signalNote: string; chipstatNote: string; statusDesc: string; signal: string; priority: string; customerId: string | null; odmCustomerId: string | null; productLineId: string | null; appId: string | null; groupId: string | null; chipIds: string[]; tagIds: string[]; people: Person[]; stagePlans?: StagePlan[]; riskOps?: RiskOperation[]; nodeOps?: NodeOperation[]; changeOps?: ChangeOperation[] };
type Field = keyof Values;
const keys = [...Object.keys(columns), ...collections, 'stagePlans', 'riskOps', 'nodeOps', 'changeOps'] as Field[];
export const scopeFields = {
  basic: ['name', 'summary', 'marketExpectation', 'detailNote', 'priority', 'customerId', 'odmCustomerId', 'productLineId', 'appId', 'groupId', 'chipIds', 'tagIds', 'people'],
  status: ['statusDesc'], tags: ['tagIds'], signal: ['signal', 'signalNote'], summaryNote: ['summaryNote'], chipstatNote: ['chipstatNote'],
  stage: ['stagePlans'], risk: ['riskOps'], change: ['changeOps'], customerNode: ['nodeOps'], projectNodes: ['nodeOps'],
} satisfies Record<string, string[]>;
export type SaveScope = keyof typeof scopeFields;
export type BasicIntent = {
  filingDate: string; startDate: string; dueDate: string; closedOn: string; proposalDate: string; originalDueDate: string;
  state: string; planKind: 'reschedule' | 'correction'; reason: string; measures: string;
  closureType: 'normal' | 'terminated'; closureNote: string; remainingWorkNote: string; maintenance: boolean; clearDates?: string[];
};
export type SaveRequest = { expectedVersion: string; idempotencyKey: string; changes: Partial<Values>; scope?: SaveScope; target?: string; commands?: ActionCommand[]; basicIntent?: BasicIntent; draft?: DraftRef };
export type SaveResult = { baseVersion?: string; draft?: Awaited<ReturnType<typeof finishDraft>>; projectId: string; operationId: string; changed: boolean; savedVersion: string; values: Partial<Values>; savedAt: string | null; scope?: SaveScope; target?: string; actions?: Record<string, unknown>[]; display?: Record<string, unknown>; riskIdMap?: Record<string, string>; risks?: Awaited<ReturnType<typeof riskCandidate>>['rows']; nodeIdMap?: Record<string, string>; nodes?: Awaited<ReturnType<typeof nodeCandidate>>['rows']; changeIdMap?: Record<string, string>; changes?: Awaited<ReturnType<typeof changeCandidate>>['rows'] };

export function failure(code: string, status: number, extra: Record<string, unknown> = {}): never {
  throw Object.assign(new Error(code), { code, status, ...extra });
}
export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validateSave(value: unknown): SaveRequest {
  if (!object(value) || Object.keys(value).some(key => !['expectedVersion', 'idempotencyKey', 'changes', 'scope', 'target', 'commands', 'basicIntent', 'draft'].includes(key)) || !validId(value.expectedVersion) || typeof value.idempotencyKey !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.idempotencyKey)
    || !object(value.changes) || !Object.keys(value.changes).length && !Array.isArray(value.commands) && !object(value.basicIntent)) failure('INVALID_SAVE_REQUEST', 400);
  if (!Object.hasOwn(value, 'scope') && Object.keys(value).length !== 3) failure('INVALID_SAVE_REQUEST', 400);
  const fields: Record<string, string> = {};
  for (const [key, text] of Object.entries(value.changes)) {
    if (!keys.includes(key as Field)) failure('INVALID_SAVE_REQUEST', 400);
    if (key === 'changeOps') { validateChangeOps(text); continue; }
    if (key === 'nodeOps') { validateNodeOps(text); continue; }
    if (key === 'riskOps') { validateRiskOps(text); continue; }
    if (key === 'stagePlans') {
      if (!Array.isArray(text) || !text.length || text.length > 7) failure('INVALID_SAVE_REQUEST', 400);
      for (const item of text) {
        if (!object(item) || typeof item.code !== 'string' || !/^S[1-7]$/.test(item.code) || Object.keys(item).length < 2 || Object.keys(item).some(key => !['code', 'plannedDays', 'note'].includes(key))) failure('INVALID_SAVE_REQUEST', 400);
        if (Object.hasOwn(item, 'plannedDays') && item.plannedDays !== null && (!Number.isInteger(item.plannedDays) || (item.plannedDays as number) < 0 || (item.plannedDays as number) > 65535)) fields.stagePlans = '工期须为空或0～65535的整数天';
        if (Object.hasOwn(item, 'note') && (typeof item.note !== 'string' || !item.note.isWellFormed() || Buffer.byteLength(item.note, 'utf8') > 65535)) fields.stagePlans = '阶段评述须为有效文字，最多65535字节';
      }
      if (new Set(text.map(item => item.code)).size !== text.length) failure('INVALID_SAVE_REQUEST', 400);
      continue;
    }
    if (Object.hasOwn(referenceFields, key)) {
      if (collections.includes(key as typeof collections[number])) {
        if (!Array.isArray(text)) failure('INVALID_SAVE_REQUEST', 400);
        const identities: string[] = [];
        for (const item of text) {
          if (key === 'people') {
            if (!object(item) || Object.keys(item).length !== 2 || !validId(item.id) || typeof item.role !== 'string' || !roles.includes(item.role)) failure('INVALID_SAVE_REQUEST', 400);
            identities.push(item.id + ':' + item.role);
          } else { if (!validId(item)) failure('INVALID_SAVE_REQUEST', 400); identities.push(item); }
        }
        if (new Set(identities).size !== identities.length) fields[key] = '同一关联不能重复选择';
      } else if (text !== null && !validId(text)) failure('INVALID_SAVE_REQUEST', 400);
      continue;
    }
    if (typeof text !== 'string') failure('INVALID_SAVE_REQUEST', 400);
    if (key === 'signal' || key === 'priority') {
      if (!(key === 'signal' ? ['green', 'yellow', 'red'] : ['high', 'mid', 'low']).includes(text)) fields[key] = '请选择有效选项';
      continue;
    }
    // utf8mb4 不支持孤立代理码；禁止传输/数据库替换原输入。
    if (!text.isWellFormed()) fields[key] = '包含无效 Unicode 字符';
    else if (key === 'name' && (!text.trim() || [...text].length > 255 || /[\r\n]/.test(text))) fields[key] = '项目名称应为 1～255 个字符，不能仅含空白或换行';
    else if (key !== 'name' && Buffer.byteLength(text, 'utf8') > 65535) fields[key] = '说明超过 65535 字节，请缩短后保存';
  }
  if (Object.keys(fields).length) failure('INVALID_PROJECT_FIELDS', 422, { fields });
  if (Object.hasOwn(value, 'scope')) validateScope(value);
  if (value.draft !== undefined) validateDraftRef(value.draft);
  const request = value as SaveRequest;
  return { ...request, changes: { ...request.changes, ...(request.changes.changeOps ? { changeOps: validateChangeOps(request.changes.changeOps) } : {}), ...(request.changes.nodeOps ? { nodeOps: validateNodeOps(request.changes.nodeOps) } : {}), ...(request.changes.riskOps ? { riskOps: validateRiskOps(request.changes.riskOps) } : {}), ...(request.changes.people ? { people: request.changes.people.map(({ id, role }) => ({ id, role })) } : {}), ...(request.changes.stagePlans ? { stagePlans: [...request.changes.stagePlans].sort((a, b) => a.code.localeCompare(b.code)).map(item => ({ code: item.code, ...Object.hasOwn(item, 'plannedDays') ? { plannedDays: item.plannedDays } : {}, ...Object.hasOwn(item, 'note') ? { note: item.note } : {} })) } : {}) } };
}
function validateScope(value: Record<string, unknown>) {
  if (typeof value.scope !== 'string' || !Object.hasOwn(scopeFields, value.scope)) failure('INVALID_SAVE_SCOPE', 400);
  const kind = value.scope as SaveScope, changes = value.changes as SaveRequest['changes'];
  if (Object.keys(changes).some(key => !(scopeFields[kind] as string[]).includes(key))) failure('SAVE_SCOPE_MISMATCH', 400);
  const record = ['risk', 'change', 'customerNode'].includes(kind);
  if (kind === 'stage') {
    if (typeof value.target !== 'string' || !/^S[1-7]$/.test(value.target) || changes.stagePlans?.length !== 1 || changes.stagePlans[0].code !== value.target) failure('SAVE_SCOPE_MISMATCH', 400);
  } else if (record) {
    if (!validId(value.target) && (typeof value.target !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.target))) failure('SAVE_SCOPE_MISMATCH', 400);
    const operations = changes.riskOps ?? changes.changeOps ?? changes.nodeOps;
    if (!operations?.length || operations.some(op => ('tempId' in op ? op.tempId : 'id' in op ? op.id : null) !== value.target)) failure('SAVE_SCOPE_MISMATCH', 400);
  } else if (Object.hasOwn(value, 'target')) failure('SAVE_SCOPE_MISMATCH', 400);
  if (kind === 'basic' && changes.people?.some(person => person.role === 'pm')) failure('SAVE_SCOPE_MISMATCH', 400, { fields: { people: '项目经理通过本人加入或退出维护，不能以工程师资料替代账号' } });
  if (Object.hasOwn(value, 'basicIntent')) {
    if (kind !== 'basic' || Object.hasOwn(value, 'commands')) failure('SAVE_SCOPE_MISMATCH', 400);
    validateBasicIntent(value.basicIntent);
  }
  if (Object.hasOwn(value, 'commands')) {
    if (kind !== 'basic' || !Array.isArray(value.commands) || !value.commands.length || value.commands.length > 4) failure('SAVE_SCOPE_MISMATCH', 400);
    const dateActions = ['setPlan', 'reschedulePlan', 'correctProjectDates'];
    const stateActions = ['startProject', 'pauseProject', 'resumeProject', 'closeProject', 'reopenProject', 'setMaintenance', 'correctClosure'];
    const categories = new Set<string>();
    value.commands = value.commands.map(item => {
      if (!object(item) || Object.hasOwn(item, 'expectedVersion') || Object.hasOwn(item, 'idempotencyKey') || Object.hasOwn(item, 'draft')) failure('INVALID_SAVE_REQUEST', 400);
      const category = item.action === 'setMaintenance' ? 'maintenance' : item.action === 'correctProjectDates' ? 'dates' : dateActions.includes(item.action as string) ? 'plan' : stateActions.includes(item.action as string) ? 'state' : '';
      if (!category || categories.has(category)) failure('SAVE_SCOPE_MISMATCH', 400);
      categories.add(category);
      return validateAction({ ...item, expectedVersion: value.expectedVersion, idempotencyKey: value.idempotencyKey });
    }).sort((a, b) => (a.action === 'setMaintenance' ? 2 : Number(stateActions.includes(a.action))) - (b.action === 'setMaintenance' ? 2 : Number(stateActions.includes(b.action))));
    const commands = value.commands as ActionCommand[];
    const startup = commands.find(command => command.action === 'startProject');
    if (categories.has('plan') && commands.some(command => command.action === 'startProject' || command.action === 'resumeProject' && command.dueDate !== undefined || command.action === 'correctProjectDates' && (Object.hasOwn(command.changes, 'dueDate') || Object.hasOwn(command.changes, 'originalDueDate')))
      || startup && commands.some(command => command.action === 'correctProjectDates' && (['startDate', 'originalDueDate'].some(key => Object.hasOwn(command.changes, key)) || Object.hasOwn(command.changes, 'dueDate') && command.changes.dueDate !== startup.dueDate))) failure('SAVE_SCOPE_MISMATCH', 400, { fields: { commands: '同次操作不能包含两份相互覆盖的计划或启动日期' } });
  }
}
function validateBasicIntent(value: unknown): asserts value is BasicIntent {
  const dates = ['filingDate', 'startDate', 'dueDate', 'closedOn', 'proposalDate', 'originalDueDate'];
  const texts = ['reason', 'measures', 'closureNote', 'remainingWorkNote'];
  const fields = [...dates, ...texts, 'state', 'planKind', 'closureType', 'maintenance'];
  if (!object(value) || fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...fields, 'clearDates'].includes(key))
    || !['proposal', 'ongoing', 'paused', 'closed'].includes(value.state as string) || !['reschedule', 'correction'].includes(value.planKind as string)
    || !['normal', 'terminated'].includes(value.closureType as string) || typeof value.maintenance !== 'boolean'
    || texts.some(key => typeof value[key] !== 'string' || !value[key].isWellFormed() || Buffer.byteLength(value[key], 'utf8') > 65535)) failure('INVALID_SAVE_REQUEST', 400);
  for (const key of dates) if (value[key] !== '') requireDate(value[key], key);
  if (value.clearDates !== undefined && (!Array.isArray(value.clearDates) || value.clearDates.some(key => typeof key !== 'string' || !dates.includes(key)) || new Set(value.clearDates).size !== value.clearDates.length)) failure('INVALID_SAVE_REQUEST', 400);
}
// 正式前态在项目锁和版本核对后读取；页面提交目标值，动作顺序只在此确定。
async function basicCommands(connection: PoolConnection, id: string, request: SaveRequest): Promise<ActionCommand[]> {
  const draft = request.basicIntent!;
  const p = (await query(connection, projectSql, [id]))[0];
  const commands: Record<string, unknown>[] = [];
  const starting = p.status === 'proposal' && draft.state === 'ongoing';
  const dateChanges: Record<string, string | null> = {};
  for (const key of ['filingDate', 'proposalDate', 'originalDueDate', 'startDate'] as const) {
    if (draft[key] !== (p[key] ?? '') && !(key === 'startDate' && starting)) dateChanges[key] = draft[key] || null;
  }
  const dueChanged = draft.dueDate !== (p.dueDate ?? '');
  if (dueChanged && (!starting || draft.planKind === 'correction' || !draft.dueDate)) {
    if (draft.planKind === 'correction' || !draft.dueDate) dateChanges.dueDate = draft.dueDate || null;
    else commands.push(p.dueDate ? { action: 'reschedulePlan', dueDate: draft.dueDate, reason: draft.reason, measures: draft.measures } : { action: 'setPlan', dueDate: draft.dueDate });
  }
  if (Object.keys(dateChanges).length) commands.unshift({ action: 'correctProjectDates', changes: dateChanges, reason: draft.reason });
  const closure = p.status === 'closed' ? await currentClosure(connection, id, p as { status: string; sourceImportItemId: unknown }) : null;
  if (draft.state !== p.status) {
    if (starting) commands.push({ action: 'startProject', actualDate: draft.startDate, dueDate: draft.dueDate || null, planReason: draft.reason });
    else if (p.status === 'closed') {
      if (draft.state !== p.preCloseStatus) failure('PROJECT_REOPEN_BASIS_UNKNOWN', 422);
      commands.push({ action: 'reopenProject', closureAuditId: closure?.auditId ?? null, reason: draft.reason });
    } else if (draft.state === 'closed') commands.push({ action: 'closeProject', closedOn: draft.closedOn, closureType: draft.closureType, closureNote: draft.closureNote, remainingWorkNote: draft.remainingWorkNote });
    else if (draft.state === 'paused') commands.push({ action: 'pauseProject', reason: draft.reason });
    else {
      if (p.status === 'paused' && draft.state !== p.resumeStatus) failure('PROJECT_RESUME_BASIS_UNKNOWN', 422);
      commands.push({ action: 'resumeProject', note: draft.reason });
    }
  } else if (p.status === 'closed') {
    const changes: Record<string, string | null> = {};
    for (const key of ['closedOn', 'closureType', 'closureNote', 'remainingWorkNote'] as const) {
      const before = key === 'closureType' ? p.closureType === 'terminated' ? 'terminated' : 'normal' : p[key] ?? '';
      if (draft[key] !== before) changes[key] = key === 'closedOn' ? draft[key] || null : draft[key];
    }
    if (Object.keys(changes).length) commands.push({ action: 'correctClosure', closureAuditId: closure?.auditId ?? null, changes, reason: draft.reason });
    if (draft.maintenance !== !!p.maintenanceEnabled) commands.push({ action: 'setMaintenance', enabled: draft.maintenance, reason: draft.reason });
  }
  if (!commands.length) return [];
  const combined = { ...request, commands };
  delete combined.basicIntent;
  validateScope(combined);
  return combined.commands as ActionCommand[];
}
async function checkNodeScope(connection: PoolConnection, id: string, request: SaveRequest) {
  if (request.scope !== 'customerNode' && request.scope !== 'projectNodes') return;
  const kind = request.scope === 'customerNode' ? 'customer' : 'project';
  const operations = request.changes.nodeOps!;
  const targets = new Set<string>();
  for (const op of operations) {
    if (op.op === 'add') { if (op.kind !== kind) failure('SAVE_SCOPE_MISMATCH', 400); }
    else if ('id' in op) targets.add(op.id);
    else { targets.add(op.from); targets.add(op.to); }
    if ('affectedIds' in op) op.affectedIds.forEach(target => targets.add(target));
    for (const edge of 'replaceEdges' in op ? op.replaceEdges : 'removeEdges' in op ? op.removeEdges : []) { targets.add(edge.from); targets.add(edge.to); }
    if (kind === 'customer' && (['move', 'link', 'unlink'].includes(op.op) || 'affectedIds' in op && op.affectedIds.length || 'removeEdges' in op && op.removeEdges.length)) failure('SAVE_SCOPE_MISMATCH', 400);
  }
  for (const target of targets) {
    if (!validId(target)) continue;
    const row = (await query(connection, 'SELECT kind FROM project_nodes WHERE project_id=? AND id=?', [id, target]))[0];
    if (!row) failure('NODE_NOT_FOUND', 404);
    if (row.kind !== kind) failure('SAVE_SCOPE_MISMATCH', 400);
  }
}
async function query(connection: PoolConnection, sql: string, values: unknown[] = []) {
  return (await connection.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0];
}
function requestHash(id: string, request: SaveRequest) {
  const changes = Object.fromEntries(keys.filter(key => Object.hasOwn(request.changes, key)).map(key => [key, key === 'people' ? request.changes.people!.map(person => ({ id: person.id, role: person.role })) : request.changes[key]]));
  if (request.scope) {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return createHash('sha256').update(JSON.stringify(canonical([id, request.scope, request.target ?? null, request.expectedVersion, changes, request.commands ?? [], ...request.basicIntent ? [{ basicIntent: request.basicIntent }] : [], ...request.draft ? [request.draft] : []]))).digest();
  }
  return createHash('sha256').update(JSON.stringify([id, mode(request), request.expectedVersion, changes])).digest();
}
const mode = (request: SaveRequest) => Object.keys(request.changes).every(key => Object.hasOwn(textColumns, key)) ? 'text' : 'ordinary';
const scope = (id: string, request: SaveRequest, actor?: Actor) => `${actor ? 'user:' + actor.id : 'anonymous'}:project:${id}:${request.scope ? 'scoped' : mode(request)}`;
function receiptResult(receipt: RowDataPacket, hash: Buffer): SaveResult {
  if (!Buffer.isBuffer(receipt.request_hash) || !receipt.request_hash.equals(hash)) failure('OPERATION_KEY_REUSED', 409);
  return typeof receipt.response_json === 'string' ? JSON.parse(receipt.response_json) : receipt.response_json;
}
async function project(connection: PoolConnection, id: string, locked: boolean, authenticated = false) {
  const row = (await query(connection, `SELECT CAST(id AS CHAR) id,CAST(version AS CHAR) version,data_kind,
    ${Object.entries(columns).map(([key, column]) => `${column.endsWith('_id') ? `CAST(\`${column}\` AS CHAR)` : `\`${column}\``} \`${key}\``).join(',')} FROM projects WHERE id=?${locked ? ' FOR UPDATE' : ''}`, [id]))[0];
  if (!row) failure('PROJECT_NOT_FOUND', 404);
  if (!authenticated && row.data_kind !== 'trial') failure('PROJECT_READ_ONLY', 403);
  return row;
}
async function linkedValues(connection: PoolConnection, id: string) {
  const chipIds = (await query(connection, 'SELECT CAST(chip_id AS CHAR) id FROM project_chips WHERE project_id=? ORDER BY sort_order,chip_id', [id])).map(row => row.id);
  const tagIds = (await query(connection, 'SELECT CAST(tag_id AS CHAR) id FROM project_tags WHERE project_id=? ORDER BY sort_order,tag_id', [id])).map(row => row.id);
  const people = (await query(connection, 'SELECT CAST(engineer_id AS CHAR) id,role FROM project_people WHERE project_id=? ORDER BY sort_order,engineer_id,role', [id])).map(row => ({ id: row.id, role: row.role }));
  return { chipIds, tagIds, people };
}
function idsOf(key: string, value: unknown): string[] {
  return key === 'people' ? (value as Person[]).map(person => person.id) : Array.isArray(value) ? value : value === null ? [] : [value as string];
}
export async function lockReferences(connection: PoolConnection, changes: SaveRequest['changes']) {
  const ids: Record<string, Set<string>> = {};
  for (const [key, table] of Object.entries(referenceFields)) if (Object.hasOwn(changes, key)) {
    ids[table] ??= new Set(); idsOf(key, changes[key as Field]).forEach(id => ids[table].add(id));
  }
  const locked: Record<string, RowDataPacket[]> = {};
  for (const table of Object.keys(ids).sort()) {
    locked[table] = [];
    for (const id of [...ids[table]].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)) locked[table].push(...await query(connection, `SELECT CAST(id AS CHAR) id,name,enabled FROM ${table} WHERE id=? FOR SHARE`, [id]));
  }
  return locked;
}
export async function replaceLinks(connection: PoolConnection, id: string, changes: SaveRequest['changes'], preserveLegacyPm: boolean) {
  for (const key of collections) if (Object.hasOwn(changes, key)) {
    const table = key === 'chipIds' ? 'project_chips' : key === 'tagIds' ? 'project_tags' : 'project_people';
    await connection.execute(`DELETE FROM ${table} WHERE project_id=?${key === 'people' && preserveLegacyPm ? " AND role<>'pm'" : ''}`, [id]);
    for (const [order, item] of (changes[key] as (string | Person)[]).entries()) {
      if (key === 'people') await connection.execute('INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,?,?)', [id, (item as Person).id, (item as Person).role, order]);
      else await connection.execute(`INSERT INTO ${table} (project_id,${key === 'chipIds' ? 'chip_id' : 'tag_id'},sort_order) VALUES (?,?,?)`, [id, item, order]);
    }
  }
}
export async function displayValues(connection: PoolConnection, values: Partial<Values>) {
  const display: Record<string, unknown> = { ...values };
  for (const [key, table] of Object.entries(referenceFields)) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key as Field];
    const ids = idsOf(key, value);
    if (!ids.length) continue;
    const rows = await query(connection, `SELECT CAST(id AS CHAR) id,name FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const named = (id: string) => ({ id, name: rows.find(row => row.id === id)?.name ?? id });
    display[key] = key === 'people' ? (value as Person[]).map(person => ({ ...named(person.id), role: person.role })) : Array.isArray(value) ? ids.map(named) : named(ids[0]);
  }
  return display;
}
// 内部事务参与能力：调用方已按资料→项目顺序锁定并重读引用，继续使用同一连接。
export async function applyReferenceProjectChanges(connection: PoolConnection, actor: Actor, projects: {projectId:string;version:string}[], source: {action:string;entityType:string;entityId:string;beforeValues:unknown;afterValues:unknown;requestId:string;at:string}) {
  const affectedProjects: {projectId:string;version:string}[]=[];
  for(const project of projects){
    if(project.version==='18446744073709551615')failure('CATALOG_VERSION_EXHAUSTED',422);
    const version=String(BigInt(project.version)+1n);
    await connection.execute('UPDATE projects SET version=version+1,updated_at=? WHERE id=?',[source.at,project.projectId]);
    await connection.execute("INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user',?,?,?,?,?,?,?,?,?,?)",[actor.id,actor.name,source.action,source.entityType,source.entityId,project.projectId,project.version,version,JSON.stringify(source.beforeValues),JSON.stringify(source.afterValues),source.requestId,source.at]);
    affectedProjects.push({projectId:project.projectId,version});
  }
  return affectedProjects;
}
export function projectSaves(database: RuntimeDatabase) {
  return {
    preview(id: string, request: SaveRequest, actor: Actor) {
      return database.readSnapshot(async connection => {
        await assertActor(connection, actor, false, new Date(), false, false);
        const current = await project(connection, id, false, true);
        if (!(await query(connection, 'SELECT user_id FROM project_responsibilities WHERE project_id=? AND user_id=?', [id, actor.id])).length) failure('PROJECT_READ_ONLY', 403);
        if (current.version !== request.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: current.version });
        await checkNodeScope(connection, id, request);
        if (!request.changes.riskOps && !request.changes.nodeOps && !request.changes.changeOps) failure('INVALID_SAVE_REQUEST', 400);
        const timestamp = new Date().toISOString();
        const change = request.changes.changeOps ? await changeCandidate(connection, id, request.changes.changeOps, actor, timestamp) : undefined;
        const risk = request.changes.riskOps ? await riskCandidate(connection, id, request.changes.riskOps, actor, timestamp) : undefined;
        const node = request.changes.nodeOps ? await nodeCandidate(connection, id, request.changes.nodeOps, timestamp, true) : undefined;
        return { projectId: id, expectedVersion: current.version, ...(change ? { changeEvents: change.events, changes: change.rows } : {}), ...(risk ? { events: risk.events, risks: risk.rows } : {}), ...(node ? { nodeEvents: node.events, nodes: node.rows, requiredUncompleteIds: node.requiredUncompleteIds, confirmed: node.confirmed } : {}) };
      });
    },
    options() {
      return database.readSnapshot(async connection => {
        const result: Record<string, RowDataPacket[]> = {};
        for (const table of [...new Set(Object.values(referenceFields))].sort()) result[table] = await query(connection, `SELECT CAST(id AS CHAR) id,name,enabled${table === 'chips' ? ',original_model originalModel,manufacturer,firmware_version firmwareVersion' : ''} FROM ${table} ORDER BY name,${table}.id`);
        result.managerAccounts = await query(connection, 'SELECT CAST(id AS CHAR) id,display_name name,enabled FROM users WHERE enabled=1 ORDER BY display_name,id');
        return { ...result, businessDate: businessToday() };
      });
    },
    save(id: string, request: SaveRequest, requestId: string, actor?: Actor) {
      if (request.scope && !actor) failure('AUTH_REQUIRED', 401);
      const hash = requestHash(id, request);
      return database.writeTransaction(async connection => {
        if (actor) await assertActor(connection, actor);
        const extended = !!request.scope || mode(request) === 'ordinary';
        // 资料锁在项目锁之前；取得锁后才检查原回执和新增引用资格。
        const locked = extended ? await lockReferences(connection, request.changes) : {};
        const current = await project(connection, id, true, !!actor);
        // 当前锁定读在版本判断前，等待前一次提交后可读到真实回执。
        const receipt = (await query(connection, 'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=? FOR UPDATE', [scope(id, request, actor), request.idempotencyKey]))[0];
        if (receipt) return receiptResult(receipt, hash);
        if (actor && !(await query(connection, 'SELECT user_id FROM project_responsibilities WHERE project_id=? AND user_id=?', [id, actor.id])).length) failure('PROJECT_READ_ONLY', 403);
        if (current.version !== request.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: current.version });
        const commands = request.basicIntent ? await basicCommands(connection, id, request) : request.commands ?? [];
        await checkNodeScope(connection, id, request);
        if ((request.changes.riskOps || request.changes.nodeOps || request.changes.changeOps) && !actor) failure('AUTH_REQUIRED', 401);
        const savedAt = new Date().toISOString();
        const change = request.changes.changeOps ? await changeCandidate(connection, id, request.changes.changeOps, actor!, savedAt) : undefined;
        const risk = request.changes.riskOps ? await riskCandidate(connection, id, request.changes.riskOps, actor!, savedAt) : undefined;
        const node = request.changes.nodeOps ? await nodeCandidate(connection, id, request.changes.nodeOps, savedAt) : undefined;
        if (extended) Object.assign(current, await linkedValues(connection, id));
        if (request.scope === 'basic') current.people = (current.people as Person[]).filter(person => person.role !== 'pm');
        let effective = request.changes;
        if (request.changes.stagePlans) {
          current.stagePlans = await query(connection, 'SELECT stage_code code,planned_days plannedDays,note FROM project_stages WHERE project_id=? ORDER BY stage_code', [id]);
          if (current.stagePlans.length !== 7) failure('STAGE_SEQUENCE_REVIEW_REQUIRED', 422);
          effective = { ...request.changes, stagePlans: current.stagePlans.map((item: StagePlan) => ({ ...item, ...request.changes.stagePlans!.find(change => change.code === item.code) })) };
        }
        const errors: Record<string, string> = {};
        for (const [key, table] of Object.entries(referenceFields)) if (Object.hasOwn(request.changes, key)) {
          const previous = new Set(key === 'people' ? (current.people as Person[]).map(person => person.id + ':' + person.role) : idsOf(key, current[key]));
          for (const target of idsOf(key, request.changes[key as Field])) {
            const row = locked[table]?.find(row => row.id === target);
            const retained = key === 'people' ? request.changes.people!.filter(person => person.id === target).every(person => previous.has(person.id + ':' + person.role)) : previous.has(target);
            if (!row || !row.enabled && !retained) errors[key] = `资料 ${target} 不存在或已停用，请重新选择`;
          }
        }
        if (Object.keys(errors).length) failure('INVALID_PROJECT_FIELDS', 422, { fields: errors });
        const fields = keys.filter(key => key !== 'riskOps' && key !== 'nodeOps' && key !== 'changeOps' && Object.hasOwn(effective, key) && JSON.stringify(effective[key]) !== JSON.stringify(current[key]));
        const effects: Awaited<ReturnType<typeof applyAction>>[] = [];
        // 已校验的命令共同决定最终日期；中途旧日期不应误拒绝合法的联合纠正。
        const combinedDates = Object.assign({}, ...commands.map(command => command.action === 'correctProjectDates' ? command.changes : command.action === 'setPlan' || command.action === 'reschedulePlan' ? { dueDate: command.dueDate } : {}));
        for (const command of commands) effects.push(await applyAction(connection, actor!, id, command, new Date(savedAt), combinedDates));
        const changed = fields.length > 0 || !!risk?.events.length || !!node?.events.length || !!change?.events.length || effects.some(effect => effect.changed);
        if (changed && current.version === '18446744073709551615') failure('PROJECT_VERSION_EXHAUSTED', 422);
        const values = Object.fromEntries((extended ? keys : Object.keys(textColumns) as Field[]).filter(key => key !== 'riskOps' && key !== 'nodeOps' && key !== 'changeOps' && (key !== 'stagePlans' || request.changes.stagePlans)).map(key => [key, Object.hasOwn(effective, key) ? effective[key] : current[key]])) as Values;
        const result: SaveResult = { baseVersion: current.version, projectId: id, operationId: request.idempotencyKey, changed,
          savedVersion: changed ? String(BigInt(current.version) + 1n) : current.version, values, savedAt: changed ? savedAt : null };
        if (changed) {
          const plain = fields.filter(key => Object.hasOwn(columns, key)) as (keyof typeof columns)[];
          const timestamp = result.savedAt!.slice(0, 23).replace('T', ' ');
          const [updated] = await connection.execute<ResultSetHeader>(`UPDATE projects SET ${plain.map(key => `\`${columns[key]}\`=?,`).join('')}${fields.includes('statusDesc') ? 'status_description_updated_at=?,' : ''}version=version+1,updated_at=? WHERE id=? AND version=?`, [...plain.map(key => values[key]), ...(fields.includes('statusDesc') ? [timestamp] : []), timestamp, id, current.version]);
          if (updated.affectedRows !== 1) failure('PROJECT_VERSION_CONFLICT', 409);
          if (fields.includes('stagePlans')) for (const plan of values.stagePlans!) {
            if (JSON.stringify(plan) !== JSON.stringify(current.stagePlans.find((item: StagePlan) => item.code === plan.code))) await connection.execute('UPDATE project_stages SET planned_days=?,note=? WHERE project_id=? AND stage_code=?', [plan.plannedDays ?? null, plan.note ?? '', id, plan.code]);
          }
          await replaceLinks(connection, id, Object.fromEntries(collections.filter(key => fields.includes(key)).map(key => [key, values[key]])), request.scope === 'basic');
          if (risk) Object.assign(result, await writeRisks(connection, id, risk, actor!, current.version, result.savedVersion, requestId, timestamp));
          if (node) Object.assign(result, await writeNodes(connection, id, node, actor!, current.version, result.savedVersion, requestId, timestamp));
          if (change) Object.assign(result, await writeChanges(connection, id, change, actor!, current.version, result.savedVersion, requestId, timestamp));
          const beforeDisplay = extended ? await displayValues(connection, current as Values) : current;
          const afterDisplay = extended ? await displayValues(connection, values) : values;
          if (extended) result.display = afterDisplay;
          const before = Object.fromEntries(fields.map(key => [key, beforeDisplay[key]]));
          const after = Object.fromEntries(fields.map(key => [key, afterDisplay[key]]));
          if (fields.length) await connection.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
            VALUES (?,?,?,?,'project',?,?,?,?,?,?,?,?)`, [actor?.id ?? null, actor?.name ?? '未认证操作', actor ? 'user' : 'anonymous', extended ? 'project.ordinary.save' : 'project.text.save', id, id, current.version, result.savedVersion, JSON.stringify(before), JSON.stringify(after), requestId, timestamp]);
          for (const effect of effects.filter(effect => effect.changed)) await connection.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
            VALUES (?,?,'user',?,?,?,?,?,?,?,?,?,?)`, [actor!.id, actor!.name, effect.action, effect.entity.type, effect.entity.id, id, current.version, result.savedVersion, JSON.stringify(effect.beforeValues), JSON.stringify(effect.afterValues), requestId, timestamp]);
        }
        if (risk && !changed) Object.assign(result, { risks: risk.rows, riskIdMap: {} });
        if (node && !changed) Object.assign(result, { nodes: node.rows, nodeIdMap: {} });
        if (change && !changed) Object.assign(result, { changes: change.rows, changeIdMap: {} });
        if (request.scope) {
          result.scope = request.scope;
          if (request.target) result.target = request.target;
          const allowed = scopeFields[request.scope] as string[];
          result.values = Object.fromEntries(Object.entries(result.values).filter(([key]) => allowed.includes(key)));
          if (result.display) result.display = Object.fromEntries(Object.entries(result.display).filter(([key]) => allowed.includes(key)));
          if (result.values.stagePlans) result.values.stagePlans = result.values.stagePlans.filter(plan => plan.code === request.target);
          if (result.risks) result.risks = result.risks.filter(row => row.id === (result.riskIdMap?.[request.target!] ?? request.target));
          if (result.changes) result.changes = result.changes.filter(row => row.id === (result.changeIdMap?.[request.target!] ?? request.target));
          if (result.nodes) result.nodes = result.nodes.filter(row => request.scope === 'projectNodes' ? row.kind === 'project' : row.id === (result.nodeIdMap?.[request.target!] ?? request.target));
          if (effects.length) result.actions = effects.map(effect => ({ action: effect.action, ...effect.details }));
        }
        if (request.draft && actor) result.draft = await finishDraft(connection, actor, request.draft, id, request.scope!, current.version, result.savedVersion, { scope: request.scope, ...request.target ? { target: request.target } : {}, changes: request.changes, ...request.commands ? { commands: request.commands.map(({expectedVersion, idempotencyKey, ...command}) => command) } : {}, ...request.basicIntent ? { basicIntent: request.basicIntent } : {} });
        await connection.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))', [actor?.id ?? null, scope(id, request, actor), request.idempotencyKey, hash, 200, JSON.stringify(result)]);
        return result;
      });
    },
    confirm(id: string, request: SaveRequest, actor?: Actor) {
      return database.readSnapshot(async connection => {
        const current = await project(connection, id, false, !!actor);
        let receipt = (await query(connection, 'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?', [scope(id, request, actor), request.idempotencyKey]))[0];
        // 旧 trial 匿名提交仅可对账，不把旧请求重放成新的实名写入。
        if (!receipt && actor && current.data_kind === 'trial') receipt = (await query(connection, 'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=? AND actor_id IS NULL', [scope(id, request), request.idempotencyKey]))[0];
        return receipt ? { outcome: 'committed', result: receiptResult(receipt, requestHash(id, request)) } : { outcome: 'not_found' };
      });
    },
    audit(id: string, pageSize: number, before?: string) {
      return database.readSnapshot(async connection => {
        if (!(await query(connection, 'SELECT id FROM projects WHERE id=?', [id])).length) failure('PROJECT_NOT_FOUND', 404);
        const items = await query(connection, `SELECT CAST(id AS CHAR) id,actor_display_name actorDisplayName,actor_kind actorKind,action,
          CAST(version_before AS CHAR) versionBefore,CAST(version_after AS CHAR) versionAfter,before_json beforeValues,after_json afterValues,
          DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt FROM audit_log WHERE project_id=?${before ? ' AND id<?' : ''} ORDER BY audit_log.id DESC LIMIT ?`, [id, ...(before ? [before] : []), pageSize + 1]);
        const hasMore = items.length > pageSize;
        if (hasMore) items.pop();
        return { items, nextCursor: hasMore ? items.at(-1)!.id : null, pageSize };
      });
    },
  };
}
