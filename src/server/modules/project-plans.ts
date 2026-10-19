import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { failure, validId } from './project-save.js';
import { businessToday, dayDifference, deadlineResult, initialPlan, requireDate, type DateFacts } from './project-dates.js';

type Base = { expectedVersion: string; idempotencyKey: string };
export const dateColumns = { proposalDate: 'proposed_on', filingDate: 'filed_on', startDate: 'started_on', dueDate: 'current_due_date', originalDueDate: 'original_due_date' } as const;
export type DateChanges = Partial<Record<keyof typeof dateColumns, string | null>>;
export type PlanCommand = Base & (
  { action: 'setPlan'; dueDate: string }
  | { action: 'reschedulePlan'; dueDate: string; reason: string; measures: string }
  | { action: 'notePlan'; reason: string; measures: string }
  | { action: 'correctProjectDates'; changes: DateChanges; reason: string }
  | { action: 'correctScheduleRecord'; recordId: string; changes: Partial<Pick<ScheduleRecord, 'oldDate' | 'newDate' | 'reason' | 'measures'>>; reason: string; currentDueDate?: string | null }
  | { action: 'voidScheduleRecord'; recordId: string; reason: string; currentDueDate?: string | null });
export const planActions = ['setPlan', 'reschedulePlan', 'notePlan', 'correctProjectDates', 'correctScheduleRecord', 'voidScheduleRecord'];
export function isPlanCommand(body: { action: string }): body is PlanCommand { return planActions.includes(body.action); }
export type ScheduleRecord = { id: string; kind: 'reschedule' | 'note'; oldDate: string | null; newDate: string | null; reason: string; measures: string; actorId: string | null; createdAt: string; voided: boolean };
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0]; }
function text(value: unknown) { return typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 65535; }
function changes(value: unknown, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).some(key => !fields.includes(key))) failure('INVALID_PLAN_COMMAND', 400);
}
export function validatePlan(value: unknown): PlanCommand {
  const body = value as PlanCommand;
  const required = ['action', 'expectedVersion', 'idempotencyKey'];
  const extra = body.action === 'setPlan' ? ['dueDate'] : body.action === 'reschedulePlan' ? ['dueDate', 'reason', 'measures'] : body.action === 'notePlan' ? ['reason', 'measures'] : body.action === 'correctProjectDates' ? ['changes', 'reason'] : body.action === 'correctScheduleRecord' ? ['recordId', 'changes', 'reason', 'currentDueDate'] : ['recordId', 'reason', 'currentDueDate'];
  if (!planActions.includes(body.action) || required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => ![...required, ...extra].includes(key)) || !validId(body.expectedVersion)
    || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)) failure('INVALID_PLAN_COMMAND', 400);
  if ('reason' in body && !text(body.reason) || 'measures' in body && !text(body.measures)) failure('INVALID_PLAN_COMMAND', 400);
  if (body.action !== 'setPlan' && (!Object.hasOwn(body, 'reason') || !text(body.reason))) failure('INVALID_PLAN_COMMAND', 400);
  if (body.action !== 'setPlan' && body.action !== 'notePlan' && !body.reason.trim()) failure('PLAN_REASON_REQUIRED', 422, { fields: { reason: '请填写调整或纠错原因' } });
  if (body.action === 'notePlan' && !body.reason.trim() && !(body.measures ?? '').trim()) failure('PLAN_NOTE_REQUIRED', 422, { fields: { reason: '原因或措施至少填写一项' } });
  if (body.action === 'setPlan' || body.action === 'reschedulePlan') { requireDate(body.dueDate, 'dueDate'); return { ...body, ...(body.action === 'reschedulePlan' ? { measures: body.measures ?? '' } : {}) }; }
  if (body.action === 'notePlan') return { ...body, measures: body.measures ?? '' };
  if (body.action === 'correctProjectDates') {
    changes(body.changes, Object.keys(dateColumns));
    const normalized: DateChanges = {};
    for (const key of Object.keys(dateColumns) as (keyof DateChanges)[]) if (Object.hasOwn(body.changes, key)) { if (body.changes[key] !== null) requireDate(body.changes[key], key); normalized[key] = body.changes[key]; }
    return { ...body, changes: normalized };
  }
  if (!validId(body.recordId)) failure('INVALID_PLAN_COMMAND', 400);
  if (Object.hasOwn(body, 'currentDueDate') && body.currentDueDate !== null) requireDate(body.currentDueDate, 'currentDueDate');
  if (body.action === 'voidScheduleRecord') return body;
  changes(body.changes, ['oldDate', 'newDate', 'reason', 'measures']);
  const normalized: typeof body.changes = {};
  for (const key of ['oldDate', 'newDate', 'reason', 'measures'] as const) if (Object.hasOwn(body.changes, key)) {
    if (key === 'reason' || key === 'measures') { if (!text(body.changes[key])) failure('INVALID_PLAN_COMMAND', 400); normalized[key] = body.changes[key]; }
    else { if (body.changes[key] !== null) requireDate(body.changes[key], key); normalized[key] = body.changes[key]; }
  }
  return { ...body, changes: normalized };
}

export async function scheduleRecords(c: PoolConnection, id: string) {
  const originals = await rows(c, "SELECT CAST(id AS CHAR) id,kind,DATE_FORMAT(old_date,'%Y-%m-%d') oldDate,DATE_FORMAT(new_date,'%Y-%m-%d') newDate,reason,measures,CAST(actor_id AS CHAR) actorId,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt FROM schedule_changes WHERE project_id=? ORDER BY created_at,schedule_changes.id", [id]) as (RowDataPacket & Omit<ScheduleRecord, 'voided'>)[];
  const records = originals.map(original => ({ ...original, voided: false, original: { ...original }, corrections: [] as { id: string; reason: string; actorDisplayName: string; createdAt: string }[] }));
  if (!records.length) return records;
  const audits = await rows(c, "SELECT CAST(id AS CHAR) id,after_json afterValues,actor_display_name actorDisplayName,created_at createdAt FROM audit_log WHERE project_id=? AND action IN ('project.plan.correctScheduleRecord','project.plan.voidScheduleRecord') ORDER BY audit_log.id", [id]);
  const byId = new Map(records.map(record => [record.id, record]));
  for (const audit of audits) {
    const after = typeof audit.afterValues === 'string' ? JSON.parse(audit.afterValues) : audit.afterValues;
    const record = byId.get(after.scheduleRecord?.id);
    if (record) { Object.assign(record, after.scheduleRecord); record.corrections.push({ id: audit.id, reason: after.correctionReason, actorDisplayName: audit.actorDisplayName, createdAt: audit.createdAt }); }
  }
  return records;
}

async function firstS1Completion(c: PoolConnection, id: string) {
  const history = await rows(c, "SELECT action,after_json afterValues FROM audit_log WHERE project_id=? AND (action='project.start' OR action LIKE 'project.stage.%') ORDER BY id", [id]);
  let completed: string | null = null, started = false, detached = false;
  for (const item of history) {
    const after = typeof item.afterValues === 'string' ? JSON.parse(item.afterValues) : item.afterValues;
    if (item.action === 'project.start') started = true;
    const s1 = after.stageChanges?.find((stage: { code: string }) => stage.code === 'S1');
    if (!s1 || detached) continue;
    if (started && ['project.stage.rollbackStage', 'project.stage.undoStageComplete', 'project.stage.undoStageStart'].includes(item.action)) {
      if (item.action !== 'project.stage.rollbackStage') completed = null;
      detached = true;
    } else completed = s1.completedOn ?? null;
  }
  return completed;
}
export type ProjectDates = DateFacts & Record<keyof typeof dateColumns, string | null> & { createdBy: string | null; sourceImportItemId: unknown };
export async function planCandidate(c: PoolConnection, id: string, project: ProjectDates, body: PlanCommand, now: Date, combinedDates: DateChanges = {}) {
  const today = businessToday(now), next = { ...project };
  const patch: DateChanges = {}, beforeValues: Record<string, unknown> = {}, afterValues: Record<string, unknown> = {};
  let insert: Pick<ScheduleRecord, 'kind' | 'oldDate' | 'newDate' | 'reason' | 'measures'> | undefined;
  let startupBasis: string | null | undefined;
  if (body.action === 'setPlan') {
    if (project.dueDate) failure('PLAN_ALREADY_SET', 422);
    patch.dueDate = body.dueDate;
    patch.originalDueDate = await initialPlan(c, id, project, body.dueDate);
  } else if (body.action === 'reschedulePlan') {
    if (!project.dueDate) failure('PLAN_REQUIRED', 422);
    patch.dueDate = body.dueDate;
    if (project.dueDate !== body.dueDate) insert = { kind: 'reschedule', oldDate: project.dueDate, newDate: body.dueDate, reason: body.reason, measures: body.measures };
  } else if (body.action === 'notePlan') insert = { kind: 'note', oldDate: null, newDate: null, reason: body.reason, measures: body.measures };
  else if (body.action === 'correctProjectDates') {
    Object.assign(patch, body.changes);
    if (Object.hasOwn(patch, 'startDate')) startupBasis = await firstS1Completion(c, id);
  } else {
    const record = (await scheduleRecords(c, id)).find(item => item.id === body.recordId);
    if (!record) failure('SCHEDULE_RECORD_NOT_FOUND', 404);
    if (body.action === 'correctScheduleRecord' && record.kind === 'note' && ['oldDate', 'newDate'].some(key => Object.hasOwn(body.changes, key))) failure('SCHEDULE_RECORD_KIND_MISMATCH', 422);
    const fields = ['id', 'kind', 'oldDate', 'newDate', 'reason', 'measures', 'voided'] as const;
    const before = Object.fromEntries(fields.map(key => [key, record[key]]));
    const after = { ...before, ...body.action === 'voidScheduleRecord' ? { voided: true } : body.changes };
    if (JSON.stringify(before) !== JSON.stringify(after)) { beforeValues.scheduleRecord = before; afterValues.scheduleRecord = after; afterValues.correctionReason = body.reason; }
    if (Object.hasOwn(body, 'currentDueDate')) patch.dueDate = body.currentDueDate!;
  }
  for (const key of Object.keys(patch) as (keyof DateChanges)[]) {
    next[key] = patch[key]!;
    if (['proposalDate', 'filingDate', 'startDate'].includes(key) && patch[key] && patch[key]! > today) failure('INVALID_PROJECT_DATE', 422, { fields: { [key]: '实际日期不能晚于今天' } });
    if (project[key] !== patch[key]) { beforeValues[key] = project[key]; afterValues[key] = patch[key]; }
  }
  const finalDates = { ...next, ...combinedDates };
  if ((Object.hasOwn(patch, 'dueDate') || Object.hasOwn(patch, 'startDate')) && finalDates.startDate && finalDates.dueDate && finalDates.dueDate < finalDates.startDate) failure('INVALID_PROJECT_DATE', 422, { fields: { dueDate: '当前计划不能早于已知实际启动日期，可明确联合纠正' } });
  if (startupBasis && next.startDate && next.startDate < startupBasis) failure('INVALID_PROJECT_DATE', 422, { fields: { startDate: `实际启动日期不能早于首次S1完成日 ${startupBasis}` } });
  const changed = !!insert || Object.keys(afterValues).length > 0;
  const actualPatch = Object.fromEntries(Object.entries(patch).filter(([key, value]) => project[key as keyof DateChanges] !== value)) as DateChanges;
  const preview = { changed, beforeValues, afterValues, beforeDeadline: deadlineResult(project, today), afterDeadline: deadlineResult(next, today), ...(startupBasis !== undefined ? { startupBasis, startupBasisNote: startupBasis ? '首次S1有效完成依据，后续返工日期不覆盖' : '首次S1依据未知，需人工核对来源' } : {}), ...(body.action === 'reschedulePlan' ? { direction: dayDifference(project.dueDate!, body.dueDate) > 0 ? 'later' : dayDifference(project.dueDate!, body.dueDate) < 0 ? 'earlier' : 'same', adjustmentDays: dayDifference(project.dueDate!, body.dueDate) } : {}), ...(insert ? { scheduleRecord: insert } : {}), ...(body.action !== 'setPlan' ? { reason: body.reason } : {}) };
  return { patch: actualPatch, insert, beforeValues, afterValues, changed, preview };
}
