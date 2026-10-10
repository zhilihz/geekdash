import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { failure, validId } from './project-save.js';
import { checkContext, requireDate } from './project-dates.js';
import { enrichChecks } from './project-checks.js';
import { planCandidate, type ProjectDates } from './project-plans.js';

type Base = { expectedVersion: string; idempotencyKey: string };
export type LifecycleCommand = Base & (
  { action: 'pauseProject'; reason: string }
  | { action: 'resumeProject'; note: string; dueDate?: string; planReason?: string }
  | { action: 'correctLifecycleNote'; auditId: string; note: string; reason: string });
export const lifecycleActions = ['pauseProject', 'resumeProject', 'correctLifecycleNote'];
export function isLifecycleCommand(body: { action: string }): body is LifecycleCommand { return lifecycleActions.includes(body.action); }
const validText = (value: unknown): value is string => typeof value === 'string' && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= 65535;
export function validateLifecycle(value: unknown): LifecycleCommand {
  const body = value as LifecycleCommand;
  const fields = ['action', 'expectedVersion', 'idempotencyKey', ...(body.action === 'pauseProject' ? ['reason'] : body.action === 'resumeProject' ? ['note', 'dueDate', 'planReason'] : ['auditId', 'note', 'reason'])];
  if (!lifecycleActions.includes(body.action) || Object.keys(body).some(key => !fields.includes(key)) || !validId(body.expectedVersion)
    || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)) failure('INVALID_LIFECYCLE_COMMAND', 400);
  if (body.action === 'resumeProject') {
    if (body.note !== undefined && !validText(body.note) || body.planReason !== undefined && (!validText(body.planReason) || body.dueDate === undefined)) failure('INVALID_LIFECYCLE_COMMAND', 400);
    if (Object.hasOwn(body, 'dueDate')) requireDate(body.dueDate, 'dueDate');
    return { ...body, note: body.note ?? '', ...(body.dueDate !== undefined ? { planReason: body.planReason ?? '' } : {}) };
  }
  if (!validText(body.reason)) failure('INVALID_LIFECYCLE_COMMAND', 400);
  if (!body.reason.trim()) failure('LIFECYCLE_REASON_REQUIRED', 422, { fields: { reason: '请填写暂缓或纠错原因' } });
  if (body.action === 'correctLifecycleNote' && (!validId(body.auditId) || !validText(body.note))) failure('INVALID_LIFECYCLE_COMMAND', 400);
  return body;
}
export type LifecycleNote = { id: string; action: string; note: string; originalNote: string; actorDisplayName: string; createdAt: string; versionBefore: string; versionAfter: string; corrections: { id: string; reason: string; actorDisplayName: string; createdAt: string }[] };
export async function lifecycleNotes(c: PoolConnection, id: string): Promise<LifecycleNote[]> {
  const [history] = await c.query<RowDataPacket[]>({ sql: "SELECT CAST(id AS CHAR) id,action,after_json afterValues,actor_display_name actorDisplayName,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,CAST(version_before AS CHAR) versionBefore,CAST(version_after AS CHAR) versionAfter FROM audit_log WHERE project_id=? AND action IN ('project.pause','project.resume','project.lifecycle.note.correct') ORDER BY id", timeout: 3000 }, [id]);
  const notes: LifecycleNote[] = [], byId = new Map<string, LifecycleNote>();
  for (const item of history) {
    const after = typeof item.afterValues === 'string' ? JSON.parse(item.afterValues) : item.afterValues;
    if (item.action === 'project.lifecycle.note.correct') {
      const target = byId.get(after.lifecycleNote?.auditId);
      if (target) { target.note = after.lifecycleNote.note; target.corrections.push({ id: item.id, reason: after.reason, actorDisplayName: item.actorDisplayName, createdAt: item.createdAt }); }
    } else {
      const note = item.action === 'project.pause' ? after.reason : after.note;
      const entry = { id: item.id, action: item.action, note, originalNote: note, actorDisplayName: item.actorDisplayName, createdAt: item.createdAt, versionBefore: item.versionBefore, versionAfter: item.versionAfter, corrections: [] };
      notes.push(entry); byId.set(item.id, entry);
    }
  }
  return notes;
}
export type LifecycleProject = ProjectDates & { resumeStatus: string | null; version: string; firstCheckWeek: string | null };
export async function lifecycleCandidate(c: PoolConnection, id: string, project: LifecycleProject, body: LifecycleCommand, now: Date) {
  const beforeValues: Record<string, unknown> = {}, afterValues: Record<string, unknown> = {};
  let status: string | undefined, resumeStatus: string | null | undefined;
  let plan: Awaited<ReturnType<typeof planCandidate>> | undefined;
  if (body.action === 'pauseProject') {
    if (!['proposal', 'ongoing'].includes(project.status)) failure('PROJECT_PAUSE_BLOCKED', 422);
    status = 'paused'; resumeStatus = project.status;
    Object.assign(beforeValues, { status: project.status, resumeStatus: project.resumeStatus });
    Object.assign(afterValues, { status, resumeStatus, reason: body.reason });
  } else if (body.action === 'resumeProject') {
    if (project.status !== 'paused') failure('PROJECT_RESUME_BLOCKED', 422);
    if (!['proposal', 'ongoing'].includes(project.resumeStatus ?? '')) failure('PROJECT_RESUME_BASIS_UNKNOWN', 422);
    status = project.resumeStatus!; resumeStatus = null;
    Object.assign(beforeValues, { status: project.status, resumeStatus: project.resumeStatus });
    Object.assign(afterValues, { status, resumeStatus, note: body.note });
    if (body.dueDate !== undefined) {
      plan = await planCandidate(c, id, project, project.dueDate ? { action: 'reschedulePlan', expectedVersion: body.expectedVersion, idempotencyKey: body.idempotencyKey, dueDate: body.dueDate, reason: body.planReason ?? '', measures: '' } : { action: 'setPlan', expectedVersion: body.expectedVersion, idempotencyKey: body.idempotencyKey, dueDate: body.dueDate }, now);
      if (plan.insert && !body.planReason?.trim()) failure('PLAN_REASON_REQUIRED', 422, { fields: { planReason: '同次修改已有计划需填写原因' } });
      Object.assign(beforeValues, plan.beforeValues); Object.assign(afterValues, plan.afterValues);
    }
  } else {
    const target = (await lifecycleNotes(c, id)).find(item => item.id === body.auditId);
    if (!target) failure('LIFECYCLE_NOTE_NOT_FOUND', 404);
    if (target.action === 'project.pause' && !body.note.trim()) failure('LIFECYCLE_NOTE_REQUIRED', 422, { fields: { note: '暂缓原因更正后仍需非空' } });
    if (target.note !== body.note) {
      beforeValues.lifecycleNote = { auditId: target.id, action: target.action, note: target.note };
      afterValues.lifecycleNote = { auditId: target.id, action: target.action, note: body.note }; afterValues.reason = body.reason;
    }
  }
  const changed = Object.keys(afterValues).length > 0;
  const context = await checkContext(c, undefined, now);
  const current = { ...project, id } as RowDataPacket;
  const next = { ...current, ...(status ? { status } : {}), version: changed ? (BigInt(project.version) + 1n).toString() : project.version } as RowDataPacket;
  await enrichChecks(c, [current, next], context);
  return { status, resumeStatus, plan, beforeValues, afterValues, changed, preview: { beforeValues, afterValues, changed, beforeCheck: current.checkStatus, afterCheck: next.checkStatus, ...(plan ? { plan: plan.preview } : {}) } };
}
