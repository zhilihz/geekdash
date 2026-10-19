import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { failure, validId } from './project-save.js';
import { businessToday, checkContext, deadlineResult, requireDate } from './project-dates.js';
import { enrichChecks } from './project-checks.js';
import type { LifecycleProject } from './project-lifecycle.js';
import type { StageFact } from './project-actions.js';

export const closureColumns = { status: 'status', preCloseStatus: 'pre_close_status', closedOn: 'closed_on', closureDueDate: 'closure_due_date', closureType: 'closure_type', closureNote: 'closure_note', remainingWorkNote: 'remaining_work_note', maintenanceEnabled: 'maintenance_enabled' } as const;
export type ClosureFacts = { preCloseStatus: string | null; closedOn: string | null; closureDueDate: string | null; closureType: string | null; closureNote: string; remainingWorkNote: string; maintenanceEnabled: number };
export type ClosureChanges = Partial<Pick<ClosureFacts, 'closedOn' | 'closureDueDate' | 'closureType' | 'closureNote' | 'remainingWorkNote'>>;
export type ClosureCommand = { expectedVersion: string; idempotencyKey: string } & (
  { action: 'closeProject'; closureType: 'normal' | 'terminated'; closedOn: string; closureNote: string; remainingWorkNote: string }
  | { action: 'reopenProject'; closureAuditId: string | null; reason: string }
  | { action: 'setMaintenance'; enabled: boolean; reason: string }
  | { action: 'correctClosure'; closureAuditId: string | null; changes: ClosureChanges; reason: string });
export const closureActions = ['closeProject', 'reopenProject', 'setMaintenance', 'correctClosure'];
export function isClosureCommand(value: { action: string }): value is ClosureCommand { return closureActions.includes(value.action); }
const text = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 65535;
export function validateClosure(value: unknown): ClosureCommand {
  const body = value as ClosureCommand;
  const fields = ['action', 'expectedVersion', 'idempotencyKey', ...(body.action === 'closeProject' ? ['closureType', 'closedOn', 'closureNote', 'remainingWorkNote'] : body.action === 'setMaintenance' ? ['enabled', 'reason'] : ['closureAuditId', 'reason', ...(body.action === 'correctClosure' ? ['changes'] : [])])];
  if (!isClosureCommand(body) || Object.keys(body).some(key => !fields.includes(key)) || !validId(body.expectedVersion)
    || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)) failure('INVALID_CLOSURE_COMMAND', 400);
  if (body.action === 'closeProject') {
    if (!['normal', 'terminated'].includes(body.closureType) || !text(body.closureNote) || body.remainingWorkNote !== undefined && !text(body.remainingWorkNote)) failure('INVALID_CLOSURE_COMMAND', 400);
    requireDate(body.closedOn, 'closedOn');
    if (!body.closureNote.trim()) failure('CLOSURE_NOTE_REQUIRED', 422, { fields: { closureNote: '请填写结案说明' } });
    return { ...body, remainingWorkNote: body.remainingWorkNote ?? '' };
  }
  if (!text(body.reason)) failure('INVALID_CLOSURE_COMMAND', 400);
  if (!body.reason.trim()) failure('CLOSURE_REASON_REQUIRED', 422, { fields: { reason: '请填写本次操作原因' } });
  if (body.action === 'setMaintenance') { if (typeof body.enabled !== 'boolean') failure('INVALID_CLOSURE_COMMAND', 400); return body; }
  if (body.closureAuditId !== null && !validId(body.closureAuditId)) failure('INVALID_CLOSURE_COMMAND', 400);
  if (body.action === 'reopenProject') return body;
  const changes = body.changes;
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !['closedOn', 'closureDueDate', 'closureType', 'closureNote', 'remainingWorkNote'].includes(key))) failure('INVALID_CLOSURE_COMMAND', 400);
  const normalized: ClosureChanges = {};
  for (const key of ['closedOn', 'closureDueDate', 'closureType', 'closureNote', 'remainingWorkNote'] as const) if (Object.hasOwn(changes, key)) {
    const value = changes[key];
    if (key === 'closedOn' || key === 'closureDueDate') { if (value !== null) requireDate(value, key); normalized[key] = value; }
    else if (key === 'closureType') { if (!['normal', 'terminated'].includes(value!)) failure('INVALID_CLOSURE_COMMAND', 400); normalized[key] = value; }
    else { if (!text(value)) failure('INVALID_CLOSURE_COMMAND', 400); if (key === 'closureNote' && !value.trim()) failure('CLOSURE_NOTE_REQUIRED', 422, { fields: { closureNote: '结案说明仍需非空' } }); normalized[key] = value; }
  }
  return { ...body, changes: normalized };
}
export async function currentClosure(c: PoolConnection, id: string, project: { status: string; sourceImportItemId: unknown }) {
  if (project.status !== 'closed') return null;
  const [rows] = await c.query<RowDataPacket[]>({ sql: "SELECT CAST(id AS CHAR) auditId,actor_display_name actorDisplayName,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,after_json original FROM audit_log WHERE project_id=? AND action='project.close' ORDER BY id DESC LIMIT 1", timeout: 3000 }, [id]);
  const row = rows[0];
  return { auditId: row?.auditId ?? null, sourceImportItemId: project.sourceImportItemId == null ? null : String(project.sourceImportItemId), actorDisplayName: row?.actorDisplayName ?? null, createdAt: row?.createdAt ?? null, original: row ? (typeof row.original === 'string' ? JSON.parse(row.original) : row.original) : null };
}
export async function closureCandidate(c: PoolConnection, id: string, project: LifecycleProject & ClosureFacts, facts: StageFact[], body: ClosureCommand, now: Date) {
  const before = Object.fromEntries(Object.keys(closureColumns).map(key => [key, project[key as keyof typeof closureColumns]]));
  const next = { ...project }, source = await currentClosure(c, id, project);
  const [nodes] = await c.query<RowDataPacket[]>("SELECT CAST(id AS CHAR) id,title,kind FROM project_nodes WHERE project_id=? AND deleted_at IS NULL AND completed_on IS NULL ORDER BY project_nodes.id", [id]);
  const [risks] = await c.query<RowDataPacket[]>("SELECT CAST(id AS CHAR) id,content,level FROM project_risks WHERE project_id=? AND resolved=0 AND deleted_at IS NULL ORDER BY project_risks.id", [id]);
  const remaining = { stages: Array.from({ length: 7 }, (_, index) => facts.find(fact => fact.code === 'S' + (index + 1)) ?? { code: 'S' + (index + 1), state: 'unconfigured', startedOn: null, completedOn: null }).filter(fact => fact.state !== 'completed'), nodes, risks: risks.map(risk => ({ id: risk.id, level: risk.level })) };
  const hasRemaining = !!(remaining.stages.length || nodes.length || risks.length);
  if (body.action === 'closeProject') {
    if (!['proposal', 'ongoing', 'paused'].includes(project.status)) failure('PROJECT_CLOSE_BLOCKED', 422);
    if (hasRemaining && !body.remainingWorkNote.trim()) failure('CLOSURE_REMAINING_REQUIRED', 422, { fields: { remainingWorkNote: '仍有未完成阶段、节点或未解除风险，请填写处置说明' } });
    Object.assign(next, { status: 'closed', closurePlanKnown: true, preCloseStatus: project.status, closedOn: body.closedOn, closureDueDate: project.dueDate, closureType: body.closureType, closureNote: body.closureNote, remainingWorkNote: body.remainingWorkNote, maintenanceEnabled: 0 });
  } else {
    if (project.status !== 'closed') failure('PROJECT_CLOSED_REQUIRED', 422);
    if (body.action !== 'setMaintenance' && body.closureAuditId !== source!.auditId) failure('CLOSURE_CHANGED', 409);
    if (body.action === 'reopenProject') {
      if (!['proposal', 'ongoing', 'paused'].includes(project.preCloseStatus ?? '') || project.preCloseStatus === 'paused' && !['proposal', 'ongoing'].includes(project.resumeStatus ?? '')) failure('PROJECT_REOPEN_BASIS_UNKNOWN', 422);
      Object.assign(next, { status: project.preCloseStatus, preCloseStatus: null, closedOn: null, closureDueDate: null, closureType: null, closureNote: '', remainingWorkNote: '', maintenanceEnabled: 0 });
    } else if (body.action === 'setMaintenance') next.maintenanceEnabled = Number(body.enabled);
    else {
      if (Object.hasOwn(body.changes, 'remainingWorkNote') && hasRemaining && !body.changes.remainingWorkNote!.trim()) failure('CLOSURE_REMAINING_REQUIRED', 422, { fields: { remainingWorkNote: '有遗留事项时处置说明不能清空' } });
      Object.assign(next, body.changes);
    }
  }
  if (body.action === 'closeProject' || body.action === 'correctClosure' && Object.hasOwn(body.changes, 'closedOn')) {
    const dates = [project.startDate, ...facts.flatMap(fact => [fact.startedOn, fact.completedOn])].filter((date): date is string => !!date);
    if (next.closedOn && (next.closedOn > businessToday(now) || dates.some(date => date > next.closedOn!))) failure('INVALID_CLOSURE_DATE', 422, { fields: { closedOn: '结案日期不能晚于今天，或早于已知实际启动及有效阶段日期；请先纠正错误事实' } });
  }
  const patch = Object.fromEntries(Object.keys(closureColumns).filter(key => project[key as keyof typeof closureColumns] !== next[key as keyof typeof closureColumns]).map(key => [key, next[key as keyof typeof closureColumns]]));
  const changed = Object.keys(patch).length > 0;
  const after = Object.fromEntries(Object.keys(closureColumns).map(key => [key, next[key as keyof typeof closureColumns]]));
  const beforeValues = { closure: before }, afterValues = { closure: after, ...(body.action === 'closeProject' ? { remaining, stageFacts: facts } : { closureSource: source, reason: body.reason }) };
  const current = { ...project, id } as RowDataPacket, candidate = { ...next, id, version: changed ? (BigInt(project.version) + 1n).toString() : project.version } as RowDataPacket;
  await enrichChecks(c, [current, candidate], await checkContext(c, undefined, now));
  return { patch, beforeValues, afterValues, changed, preview: { beforeValues, afterValues, changed, remaining: { ...remaining, risks }, beforeDeadline: deadlineResult(project, businessToday(now)), afterDeadline: deadlineResult(next, businessToday(now)), beforeCheck: current.checkStatus, afterCheck: candidate.checkStatus, progress: [0, 5, 10, 20, 60, 80, 90, 100][facts.filter(fact => fact.state === 'completed').length] } };
}
