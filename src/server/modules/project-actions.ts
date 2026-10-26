import { createHash } from 'node:crypto';
import { hasProjectAccess, visibleProjectReceipt } from './project-membership.js';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { failure, validId } from './project-save.js';
import { businessToday, closurePlanKnownExpression, initialPlan, requireDate } from './project-dates.js';
import { dateColumns, isPlanCommand, planCandidate, validatePlan, type PlanCommand, type ProjectDates, type DateChanges } from './project-plans.js';
import { isLifecycleCommand, lifecycleCandidate, validateLifecycle, type LifecycleCommand, type LifecycleProject } from './project-lifecycle.js';
import { closureCandidate, closureColumns, isClosureCommand, validateClosure, type ClosureCommand, type ClosureFacts } from './project-closures.js';
import { checkCandidate, isCheckCommand, validateCheck, type CheckCommand } from './project-checks.js';
import { finishDraft, validateDraftRef, type DraftRef } from './personal-state.js';
export { businessToday } from './project-dates.js';

export type StageFact = { code: string; state: string; startedOn: string | null; completedOn: string | null };
export type StageCommand = { action: 'startStage' | 'completeStage'; stageCode: string; actualDate: string; expectedVersion: string; idempotencyKey: string; completionNote?: string };
export type StartCommand = { action: 'startProject'; actualDate: string; dueDate: string | null; planReason?: string; expectedVersion: string; idempotencyKey: string; configVersion?: string; ruleVersion?: string; previewWeek?: string; previewFirstCheckWeek?: string };
export type CorrectionCommand = { action: 'correctStageFacts'; changes: { code: string; startedOn?: string | null; completedOn?: string | null }[]; reason: string; expectedVersion: string; idempotencyKey: string }
  | { action: 'confirmStageState'; stageCode:string; state:'ready'|'active'; reason:string; expectedVersion:string; idempotencyKey:string }
  | { action: 'undoStageStart' | 'undoStageComplete' | 'rollbackStage'; stageCode: string; undoStart?: boolean; reason: string; expectedVersion: string; idempotencyKey: string };
export type ActionCommand = (StageCommand | StartCommand | CorrectionCommand | PlanCommand | LifecycleCommand | ClosureCommand | CheckCommand) & { draft?: DraftRef };
export const correctionActions = ['correctStageFacts', 'confirmStageState', 'undoStageStart', 'undoStageComplete', 'rollbackStage'];
export function validateAction(value: unknown): ActionCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('INVALID_STAGE_COMMAND', 400);
  if (Object.hasOwn(value,'draft')) {
    const {draft,...command} = value as Record<string,unknown>;
    return {...validateAction(command),draft:validateDraftRef(draft)};
  }
  if (isCheckCommand(value as { action: string })) return validateCheck(value);
  if (isClosureCommand(value as { action: string })) return validateClosure(value);
  if (isLifecycleCommand(value as { action: string })) return validateLifecycle(value);
  if (isPlanCommand(value as { action: string })) return validatePlan(value);
  if (correctionActions.includes((value as { action: string }).action)) {
    const body = { ...value, ...!Object.hasOwn(value, 'reason') && ['correctStageFacts','confirmStageState'].includes((value as CorrectionCommand).action) ? { reason: '' } : {} } as CorrectionCommand;
    const required = ['action', 'reason', 'expectedVersion', 'idempotencyKey', body.action === 'correctStageFacts' ? 'changes' : 'stageCode',...body.action==='confirmStageState'?['state']:[]];
    if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => ![...required, ...(body.action === 'undoStageComplete' ? ['undoStart'] : [])].includes(key))
      || !validId(body.expectedVersion) || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)
      || typeof body.reason !== 'string' || !body.reason.isWellFormed() || Buffer.byteLength(body.reason, 'utf8') > 65535) failure('INVALID_STAGE_COMMAND', 400);
    if (!['correctStageFacts','confirmStageState'].includes(body.action) && !body.reason.trim()) failure('CORRECTION_REASON_REQUIRED', 422, { fields: { reason: '请填写撤销或回退原因' } });
    if (body.action === 'correctStageFacts') {
      if (!Array.isArray(body.changes) || !body.changes.length || body.changes.length > 7) failure('INVALID_STAGE_COMMAND', 400);
      for (const item of body.changes) {
        if (!item || typeof item !== 'object' || Array.isArray(item) || !/^S[1-7]$/.test(item.code) || Object.keys(item).length < 2
          || Object.keys(item).some(key => !['code', 'startedOn', 'completedOn'].includes(key))) failure('INVALID_STAGE_COMMAND', 400);
        for (const key of ['startedOn', 'completedOn'] as const) if (Object.hasOwn(item, key) && item[key] !== null) requireDate(item[key], item.code + '.' + key);
      }
      if (new Set(body.changes.map(item => item.code)).size !== body.changes.length) failure('INVALID_STAGE_COMMAND', 400);
      return { ...body, changes: [...body.changes].sort((a, b) => a.code.localeCompare(b.code)).map(item => ({ code: item.code, ...Object.hasOwn(item, 'startedOn') ? { startedOn: item.startedOn } : {}, ...Object.hasOwn(item, 'completedOn') ? { completedOn: item.completedOn } : {} })) };
    }
    if (typeof body.stageCode !== 'string' || !/^S[1-7]$/.test(body.stageCode) || 'undoStart' in body && typeof body.undoStart !== 'boolean' || body.action==='confirmStageState'&&!['ready','active'].includes(body.state)) failure('INVALID_STAGE_COMMAND', 400);
    return { ...body, ...(body.action === 'undoStageComplete' ? { undoStart: body.undoStart ?? false } : {}) };
  }
  if ((value as { action?: string }).action === 'startProject') {
    const body = value as StartCommand;
    const required = ['action', 'actualDate', 'dueDate', 'expectedVersion', 'idempotencyKey'];
    if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => ![...required, 'planReason', 'configVersion', 'ruleVersion', 'previewWeek', 'previewFirstCheckWeek'].includes(key)) || !validId(body.expectedVersion)
      || [body.configVersion, body.ruleVersion].some(version => version !== undefined && !validId(version))
      || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)
      || body.planReason !== undefined && (typeof body.planReason !== 'string' || !body.planReason.isWellFormed() || Buffer.byteLength(body.planReason, 'utf8') > 65535)) failure('INVALID_PROJECT_COMMAND', 400);
    requireDate(body.actualDate, 'actualDate');
    if (body.dueDate !== null) requireDate(body.dueDate, 'dueDate');
    for (const key of ['previewWeek', 'previewFirstCheckWeek'] as const) if (body[key] !== undefined) requireDate(body[key], key);
    return { ...body, planReason: body.planReason ?? '' };
  }
  const body = value as StageCommand;
  const required = ['action', 'stageCode', 'actualDate', 'expectedVersion', 'idempotencyKey'];
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => ![...required, 'completionNote'].includes(key))
    || !['startStage', 'completeStage'].includes(body.action) || typeof body.stageCode !== 'string' || !/^S[1-7]$/.test(body.stageCode) || !validId(body.expectedVersion)
    || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)) failure('INVALID_STAGE_COMMAND', 400);
  if (typeof body.actualDate !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(body.actualDate)
    || Number.isNaN(Date.parse(body.actualDate)) || new Date(body.actualDate).toISOString().slice(0, 10) !== body.actualDate) failure('INVALID_STAGE_DATE', 422, { fields: { actualDate: '请选择有效的实际日期' } });
  if (body.completionNote !== undefined && (body.action !== 'completeStage' || typeof body.completionNote !== 'string'
    || !body.completionNote.isWellFormed() || Buffer.byteLength(body.completionNote, 'utf8') > 65535)) failure('INVALID_STAGE_COMMAND', 400);
  return { ...body, ...(body.action === 'completeStage' ? { completionNote: body.completionNote ?? '' } : {}) };
}
export function validSequence(facts: StageFact[]) {
  if (facts.length !== 7 || facts.some((fact, index) => fact.code !== 'S' + (index + 1))) return false;
  const first = facts.findIndex(fact => fact.state !== 'completed');
  return first === -1 || ['unknown', 'ready', 'active'].includes(facts[first].state) && facts.slice(first + 1).every(fact => fact.state === 'locked');
}
export function startProjectBlock(project: { status: string; startDate: string | null }, facts: StageFact[], today = businessToday()) {
  if (project.status !== 'proposal') return 'PROJECT_START_BLOCKED';
  if (facts[0]?.state !== 'completed') return 'PROJECT_S1_REQUIRED';
  if (!validSequence(facts) || facts[1].state !== 'ready') return 'STAGE_SEQUENCE_REVIEW_REQUIRED';
  if (!facts[0].startedOn || !facts[0].completedOn || facts[0].startedOn > facts[0].completedOn || facts[0].completedOn > today
    || facts.slice(1).some(fact => fact.startedOn || fact.completedOn) || project.startDate) return 'PROJECT_START_HISTORY_REVIEW_REQUIRED';
  return null;
}
export function stageBlock(status: string, facts: StageFact[], code: string, action: StageCommand['action']): string | null {
  if (!validSequence(facts)) return 'STAGE_SEQUENCE_REVIEW_REQUIRED';
  if (!['proposal', 'ongoing'].includes(status)) return 'PROJECT_STAGE_ACTION_BLOCKED';
  const index = facts.findIndex(fact => fact.code === code);
  if (index < 0) return 'STAGE_SEQUENCE_REVIEW_REQUIRED';
  if (status === 'proposal' && index > 0) return 'PROJECT_START_REQUIRED';
  if (facts.slice(0, index).some(fact => fact.state !== 'completed')) return 'STAGE_PREDECESSOR_INCOMPLETE';
  if (facts[index].state === 'unknown') return 'STAGE_STATE_REVIEW_REQUIRED';
  if (facts[index].state !== (action === 'startStage' ? 'ready' : 'active')) return 'STAGE_STATE_CHANGED';
  if (action === 'startStage' && index > 0 && !facts[index - 1].completedOn || action === 'completeStage' && !facts[index].startedOn) return 'STAGE_DATE_REVIEW_REQUIRED';
  return null;
}
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0]; }
function stageCorrection(status: string, facts: StageFact[], body: CorrectionCommand, today: string) {
  const next = structuredClone(facts);
  if (body.action === 'correctStageFacts') {
    for (const change of body.changes) {
      const target = next.find(fact => fact.code === change.code);
      if (!target) failure('STAGE_SEQUENCE_REVIEW_REQUIRED', 422);
      Object.assign(target, change);
    }
  } else if(body.action==='confirmStageState') {
    if(!validSequence(facts))failure('STAGE_SEQUENCE_REVIEW_REQUIRED',422);
    if(status==='closed')failure('PROJECT_REOPEN_REQUIRED',422);
    const target=next.find(fact=>fact.code===body.stageCode);
    if(target?.state!=='unknown')failure('STAGE_STATE_CHANGED',422);
    target.state=body.state;
  } else {
    if (!validSequence(facts)) failure('STAGE_SEQUENCE_REVIEW_REQUIRED', 422);
    if (status === 'closed') failure('PROJECT_REOPEN_REQUIRED', 422);
    if (body.action === 'rollbackStage' && !['proposal', 'ongoing'].includes(status)) failure('PROJECT_RESUME_REQUIRED', 422);
    const index = next.findIndex(fact => fact.code === body.stageCode);
    if (index < 0) failure('STAGE_SEQUENCE_REVIEW_REQUIRED', 422);
    const target = next[index];
    if (target.state !== (body.action === 'undoStageStart' ? 'active' : 'completed')) failure('STAGE_STATE_CHANGED', 422);
    if (body.action === 'undoStageComplete' && !body.undoStart && !target.startedOn) failure('STAGE_DATE_REVIEW_REQUIRED', 422);
    target.state = body.action === 'undoStageComplete' && !body.undoStart ? 'active' : 'ready';
    if (target.state === 'ready') target.startedOn = null;
    target.completedOn = null;
    for (const later of next.slice(index + 1)) Object.assign(later, { state: 'locked', startedOn: null, completedOn: null });
  }
  if (!validSequence(next)) failure('STAGE_SEQUENCE_REVIEW_REQUIRED', 422);
  for (const [index, fact] of next.entries()) {
    if (fact.startedOn && fact.startedOn > today || fact.completedOn && fact.completedOn > today
      || ['ready', 'locked'].includes(fact.state) && (fact.startedOn || fact.completedOn)
      || fact.state === 'active' && fact.completedOn || fact.startedOn && fact.completedOn && fact.startedOn > fact.completedOn
      || index > 0 && fact.startedOn && next[index - 1].completedOn && fact.startedOn < next[index - 1].completedOn!) {
      failure('INVALID_STAGE_DATE', 422, { fields: { [fact.code]: `${fact.code}实际日期与状态、前后顺序或今天冲突，请核对` } });
    }
  }
  const codes = next.filter((fact, index) => JSON.stringify(fact) !== JSON.stringify(facts[index])).map(fact => fact.code);
  const progress = (items: StageFact[]) => [0, 5, 10, 20, 60, 80, 90, 100][items.filter(fact => fact.state === 'completed').length];
  return { stageChanges: next.filter(fact => codes.includes(fact.code)), beforeStages: facts.filter(fact => codes.includes(fact.code)), progressBefore: progress(facts), progressAfter: progress(next), reason: body.reason, changed: codes.length > 0 };
}
const stageSql = "SELECT stage_code code,state,DATE_FORMAT(started_on,'%Y-%m-%d') startedOn,DATE_FORMAT(completed_on,'%Y-%m-%d') completedOn FROM project_stages WHERE project_id=? ORDER BY stage_code";
export const projectSql = `SELECT ${closurePlanKnownExpression} closurePlanKnown,status,pre_close_status preCloseStatus,closure_note closureNote,remaining_work_note remainingWorkNote,maintenance_enabled maintenanceEnabled,resume_status resumeStatus,CAST(version AS CHAR) version,CAST(created_by AS CHAR) createdBy,source_import_item_id sourceImportItemId,DATE_FORMAT(proposed_on,'%Y-%m-%d') proposalDate,DATE_FORMAT(filed_on,'%Y-%m-%d') filingDate,DATE_FORMAT(started_on,'%Y-%m-%d') startDate,DATE_FORMAT(current_due_date,'%Y-%m-%d') dueDate,DATE_FORMAT(original_due_date,'%Y-%m-%d') originalDueDate,DATE_FORMAT(closed_on,'%Y-%m-%d') closedOn,DATE_FORMAT(closure_due_date,'%Y-%m-%d') closureDueDate,closure_type closureType,DATE_FORMAT(first_check_week,'%Y-%m-%d') firstCheckWeek FROM projects p WHERE id=?`;
// 调用者已锁定账号、必要配置和项目，并核验权限/版本。本函数只参与当前事务，
// 不提交、不推进版本、不写回执；独立动作和合并资料保存复用同一套业务处理。
export async function applyAction(c: PoolConnection, actor: Actor, id: string, body: ActionCommand, now: Date, combinedDates?: DateChanges) {
  const project = (await rows(c, projectSql, [id]))[0];
  if (!project) failure('PROJECT_NOT_FOUND', 404);
  const facts = await rows(c, stageSql, [id]) as (RowDataPacket & StageFact)[];
  const savedVersion = String(BigInt(project.version) + 1n);
  const finish = (action: string, beforeValues: unknown, afterValues: unknown, details: Record<string, unknown>, changed = true, entity = { type: 'project', id }) =>
    ({ action, beforeValues, afterValues, details, changed, entity });
  if (isCheckCommand(body)) {
    const candidate = await checkCandidate(c, id, project as { version: string }, body, now);
    let checkId = body.action === 'correctCheck' ? body.checkId : '';
    if (body.action === 'saveCheck') {
      const value = candidate.afterValues.check;
      await c.execute('INSERT INTO project_checks (project_id,actor_id,checked_at,week_start,conclusion,note,rule_version,observed_version,result_version) VALUES (?,?,?,NULL,?,?,NULL,?,?)', [id, actor.id, now.toISOString().slice(0, 23).replace('T', ' '), body.conclusion, body.note, project.version, savedVersion]);
      checkId = (await rows(c, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
      Object.assign(value, { id: checkId, actorId: actor.id, actorName: actor.name });
    }
    return finish(body.action === 'saveCheck' ? 'project.check.save' : 'project.check.correct', candidate.beforeValues, candidate.afterValues, { ...candidate.preview, checkId }, candidate.changed, { type: 'project_check', id: checkId });
  }
  if (isClosureCommand(body)) {
    const candidate = await closureCandidate(c, id, project as RowDataPacket & LifecycleProject & ClosureFacts, facts, body, now);
    const entries = Object.entries(candidate.patch);
    if (entries.length) await c.execute(`UPDATE projects SET ${entries.map(([key]) => closureColumns[key as keyof typeof closureColumns] + '=?').join(',')} WHERE id=?`, [...entries.map(([, value]) => value), id]);
    return finish(body.action === 'closeProject' ? 'project.close' : body.action === 'reopenProject' ? 'project.reopen' : body.action === 'setMaintenance' ? 'project.maintenance' : 'project.closure.correct', candidate.beforeValues, candidate.afterValues, candidate.preview, candidate.changed);
  }
  if (isLifecycleCommand(body)) {
    const candidate = await lifecycleCandidate(c, id, project as RowDataPacket & LifecycleProject, body, now);
    if (candidate.status !== undefined) await c.execute('UPDATE projects SET status=?,resume_status=? WHERE id=?', [candidate.status, candidate.resumeStatus ?? null, id]);
    for (const [key, value] of Object.entries(candidate.plan?.patch ?? {})) await c.execute(`UPDATE projects SET ${dateColumns[key as keyof typeof dateColumns]}=? WHERE id=?`, [value, id]);
    if (candidate.plan?.insert) {
      const record = candidate.plan.insert;
      await c.execute('INSERT INTO schedule_changes (project_id,kind,old_date,new_date,reason,measures,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)', [id, record.kind, record.oldDate, record.newDate, record.reason, record.measures, actor.id, now.toISOString().slice(0, 23).replace('T', ' ')]);
      candidate.afterValues.scheduleRecord = { id: (await rows(c, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id, ...record };
    }
    return finish(body.action === 'pauseProject' ? 'project.pause' : body.action === 'resumeProject' ? 'project.resume' : 'project.lifecycle.note.correct', candidate.beforeValues, candidate.afterValues, candidate.preview, candidate.changed);
  }
  if (isPlanCommand(body)) {
    const candidate = await planCandidate(c, id, project as RowDataPacket & ProjectDates, body, now, combinedDates);
    for (const [key, value] of Object.entries(candidate.patch)) await c.execute(`UPDATE projects SET ${dateColumns[key as keyof typeof dateColumns]}=? WHERE id=?`, [value, id]);
    if (candidate.insert) {
      const record = candidate.insert;
      await c.execute('INSERT INTO schedule_changes (project_id,kind,old_date,new_date,reason,measures,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)', [id, record.kind, record.oldDate, record.newDate, record.reason, record.measures, actor.id, now.toISOString().slice(0, 23).replace('T', ' ')]);
      candidate.afterValues.scheduleRecord = { id: (await rows(c, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id, ...record };
    }
    if (candidate.changed && 'reason' in body && !candidate.afterValues.correctionReason) candidate.afterValues.reason = body.reason;
    return finish('project.plan.' + body.action, candidate.beforeValues, candidate.afterValues, candidate.preview, candidate.changed);
  }
  if ('reason' in body) {
    const correction = stageCorrection(project.status, facts, body, businessToday(now));
    for (const fact of correction.stageChanges) await c.execute('UPDATE project_stages SET state=?,started_on=?,completed_on=? WHERE project_id=? AND stage_code=?', [fact.state, fact.startedOn, fact.completedOn, id, fact.code]);
    return finish('project.stage.' + body.action, { stageChanges: correction.beforeStages, progress: correction.progressBefore }, { stageChanges: correction.stageChanges, progress: correction.progressAfter, reason: body.reason }, correction, correction.changed);
  }
  if (body.action === 'startProject') {
    const blocked = startProjectBlock(project as { status: string; startDate: string | null }, facts, businessToday(now));
    if (blocked) failure(blocked, 422);
    if (body.actualDate > businessToday(now) || body.actualDate < facts[0].completedOn!) failure('INVALID_PROJECT_DATE', 422, { fields: { actualDate: '实际启动日期不能在未来或早于S1实际完成日期' } });
    if (body.dueDate && body.dueDate < body.actualDate) failure('INVALID_PROJECT_DATE', 422, { fields: { dueDate: '预计结案日期不能早于实际启动日期' } });
    if (project.dueDate && project.dueDate !== body.dueDate && !body.planReason?.trim()) failure('PLAN_REASON_REQUIRED', 422);
    const originalDueDate = body.dueDate ? await initialPlan(c, id, project as RowDataPacket & { originalDueDate: string | null; dueDate: string | null; createdBy: string | null; sourceImportItemId: unknown }, body.dueDate) : project.originalDueDate;
    if (project.dueDate && project.dueDate !== body.dueDate) await c.execute("INSERT INTO schedule_changes (project_id,kind,old_date,new_date,reason,measures,actor_id,created_at) VALUES (?,'reschedule',?,?,?,'',?,?)", [id, project.dueDate, body.dueDate, body.planReason, actor.id, now.toISOString().slice(0, 23).replace('T', ' ')]);
    const after = { status: 'ongoing', startDate: body.actualDate, dueDate: body.dueDate, originalDueDate };
    await c.execute("UPDATE projects SET status='ongoing',started_on=?,current_due_date=?,original_due_date=? WHERE id=?", [body.actualDate, body.dueDate, originalDueDate, id]);
    return finish('project.start', { status: project.status, startDate: project.startDate, dueDate: project.dueDate, originalDueDate: project.originalDueDate }, after, after);
  }
  const blocked = stageBlock(project.status, facts, body.stageCode, body.action);
  if (blocked) failure(blocked, 422);
  const today = businessToday(now);
  if (body.actualDate > today) failure('INVALID_STAGE_DATE', 422, { fields: { actualDate: '实际日期不能晚于今天' } });
  const index = facts.findIndex(fact => fact.code === body.stageCode);
  const target = facts[index];
  if (body.action === 'startStage' && (target.startedOn || target.completedOn) || body.action === 'completeStage' && target.completedOn) failure('STAGE_DATE_REVIEW_REQUIRED', 422);
  const lower = body.action === 'startStage' ? facts[index - 1]?.completedOn : target.startedOn;
  if (lower && body.actualDate < lower) failure('INVALID_STAGE_DATE', 422, { fields: { actualDate: `实际日期不能早于${lower}` } });
  if (facts.some((fact, i) => fact.startedOn && fact.startedOn > today || fact.completedOn && fact.completedOn > today
    || ['ready', 'locked'].includes(fact.state) && (fact.startedOn || fact.completedOn)
    || fact.startedOn && fact.completedOn && fact.startedOn > fact.completedOn
    || i > 0 && fact.startedOn && facts[i - 1].completedOn && fact.startedOn < facts[i - 1].completedOn!)) failure('STAGE_DATE_REVIEW_REQUIRED', 422);
  const before = [structuredClone(target)];
  if (body.action === 'startStage') {
    await c.execute("UPDATE project_stages SET state='active',started_on=? WHERE project_id=? AND stage_code=?", [body.actualDate, id, body.stageCode]);
    Object.assign(target, { state: 'active', startedOn: body.actualDate });
  } else {
    await c.execute("UPDATE project_stages SET state='completed',completed_on=? WHERE project_id=? AND stage_code=?", [body.actualDate, id, body.stageCode]);
    Object.assign(target, { state: 'completed', completedOn: body.actualDate });
    if (facts[index + 1]) {
      before.push(structuredClone(facts[index + 1]));
      await c.execute("UPDATE project_stages SET state='ready' WHERE project_id=? AND stage_code=?", [id, facts[index + 1].code]);
      facts[index + 1].state = 'ready';
    }
  }
  const after = facts.slice(index, index + before.length);
  return finish('project.stage.' + (body.action === 'startStage' ? 'start' : 'complete'), { stageChanges: before }, { stageChanges: after, ...(body.action === 'completeStage' ? { completionNote: body.completionNote } : {}) }, { stageCode: body.stageCode, actualDate: body.actualDate, stages: after });
}

export function projectActions(database: RuntimeDatabase, clock = () => new Date()) {
  async function run(actor: Actor, id: string, input: ActionCommand, requestId: string, confirm: boolean) {
    const {draft,...body} = input;
    const scope = `user:${actor.id}:project:${id}:actions`;
    let hash = createHash('sha256').update(JSON.stringify(isPlanCommand(body) || isLifecycleCommand(body) || isClosureCommand(body) || isCheckCommand(body) ? [id, Object.keys(body).filter(key => key !== 'idempotencyKey').sort().map(key => [key, (body as unknown as Record<string, unknown>)[key]])] : body.action === 'startProject' ? [id, body.action, body.actualDate, body.dueDate, body.planReason ?? '', body.expectedVersion, body.configVersion, body.ruleVersion, body.previewWeek, body.previewFirstCheckWeek]
      : 'reason' in body ? [id, body.action, body.expectedVersion, body.reason, body.action === 'correctStageFacts' ? body.changes : body.action==='confirmStageState'?[body.stageCode,body.state]:[body.stageCode, body.undoStart ?? false]] : [id, body.action, body.stageCode, body.actualDate, body.expectedVersion, body.completionNote ?? null])).digest();
    if (draft) hash = createHash('sha256').update(hash).update(JSON.stringify([draft.clientDraftId,draft.draftVersion])).digest();
    const lookup = async (c: PoolConnection, lock: boolean) => {
      const row = (await rows(c, `SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?${lock ? ' FOR UPDATE' : ''}`, [scope, body.idempotencyKey]))[0];
      if (!row) return null;
      if (!row.request_hash.equals(hash)) failure('OPERATION_KEY_REUSED', 409);
      return typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.response_json;
    };
    if (confirm) return database.readSnapshot(async c => { await assertActor(c,actor,false,new Date(),false,false);const result = await lookup(c, false); return result ? { outcome: 'committed', result:await visibleProjectReceipt(c,actor.id,result) } : { outcome: 'not_found' }; });
    return database.writeTransaction(async c => {
      await assertActor(c, actor);
      const project = (await rows(c, projectSql + ' FOR UPDATE', [id]))[0];
      if (!project) failure('PROJECT_NOT_FOUND', 404);
      const prior = await lookup(c, true); if (prior) return { outcome: 'committed', result: await visibleProjectReceipt(c,actor.id,prior) };
      if (!await hasProjectAccess(c,id,actor.id)) failure('PROJECT_READ_ONLY', 403);
      if (project.version !== body.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: project.version });
      const now = clock();
      const savedVersion = String(BigInt(project.version) + 1n);
      const finish = async (action: string, beforeValues: unknown, afterValues: unknown, details: Record<string, unknown>, changed = true, entity = { type: 'project', id }) => {
        const at = now.toISOString().slice(0, 23).replace('T', ' ');
        if (changed) {
          if (project.version === '18446744073709551615') failure('PROJECT_VERSION_EXHAUSTED', 422);
          await c.execute('UPDATE projects SET version=version+1,updated_at=? WHERE id=?', [at, id]);
          await c.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
          VALUES (?,?,'user',?,?,?,?,?,?,?,?,?,?)`, [actor.id, actor.name, action, entity.type, entity.id, id, project.version, savedVersion, JSON.stringify(beforeValues), JSON.stringify(afterValues), requestId, at]);
        }
        const {expectedVersion,idempotencyKey,...command} = body;
        const result = { projectId: id, operationId: body.idempotencyKey, action: body.action, ...details, baseVersion:project.version, savedVersion: changed ? savedVersion : project.version,
          ...draft ? {draft:await finishDraft(c,actor,draft,id,'action',project.version,changed ? savedVersion : project.version,{command})} : {} };
        await c.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,?)', [actor.id, scope, body.idempotencyKey, hash, JSON.stringify(result), at]);
        return { outcome: 'committed', result };
      };
      const effect = await applyAction(c, actor, id, body, now);
      return finish(effect.action, effect.beforeValues, effect.afterValues, effect.details, effect.changed, effect.entity);
    });
  }
  return {
    run,
    preview(actor: Actor, id: string, body: ActionCommand) {
      if (!isPlanCommand(body) && !isLifecycleCommand(body) && !isClosureCommand(body) && !isCheckCommand(body) && !('reason' in body)) failure('INVALID_STAGE_COMMAND', 400);
      return database.readSnapshot(async c => {
        const now = clock();
        await assertActor(c, actor, false, now, false, false);
        const project = (await rows(c, projectSql, [id]))[0];
        if (!project) failure('PROJECT_NOT_FOUND', 404);
        if (!await hasProjectAccess(c,id,actor.id)) failure('PROJECT_READ_ONLY', 403);
        if (project.version !== body.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: project.version });
        if (isCheckCommand(body)) return { projectId: id, expectedVersion: project.version, ...(await checkCandidate(c, id, project as { version: string }, body, now)).preview };
        if (isClosureCommand(body)) return { projectId: id, expectedVersion: project.version, ...(await closureCandidate(c, id, project as RowDataPacket & LifecycleProject & ClosureFacts, await rows(c, stageSql, [id]) as (RowDataPacket & StageFact)[], body, now)).preview };
        if (isLifecycleCommand(body)) return { projectId: id, expectedVersion: project.version, ...(await lifecycleCandidate(c, id, project as RowDataPacket & LifecycleProject, body, now)).preview };
        if (isPlanCommand(body)) return { projectId: id, expectedVersion: project.version, ...(await planCandidate(c, id, project as RowDataPacket & ProjectDates, body, now)).preview };
        const facts = await rows(c, stageSql, [id]) as (RowDataPacket & StageFact)[];
        return { projectId: id, expectedVersion: project.version, ...stageCorrection(project.status, facts, body, businessToday(now)) };
      });
    },
  };
}
