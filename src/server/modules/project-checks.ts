import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { addDays, checkContext, validDate } from './project-dates.js';
import { failure, validId } from './project-save.js';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';

type Context = Awaited<ReturnType<typeof checkContext>>;
export type CheckCommand = { expectedVersion: string; idempotencyKey: string; conclusion: 'checked' | 'follow_up'; note: string } & (
  { action: 'saveCheck'; ruleVersion: string; previewWeek: string }
  | { action: 'correctCheck'; checkId: string; reason: string });
export const isCheckCommand = (body: { action: string }): body is CheckCommand => ['saveCheck', 'correctCheck'].includes(body.action);
export function validateCheck(value: unknown): CheckCommand {
  const body = value as CheckCommand;
  const fields = ['action', 'expectedVersion', 'idempotencyKey', 'conclusion', 'note', ...(body.action === 'saveCheck' ? ['ruleVersion', 'previewWeek'] : ['checkId', 'reason'])];
  if (!isCheckCommand(body) || Object.keys(body).length !== fields.length || Object.keys(body).some(key => !fields.includes(key)) || !validId(body.expectedVersion)
    || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)
    || !['checked', 'follow_up'].includes(body.conclusion) || typeof body.note !== 'string' || !body.note.isWellFormed() || Buffer.byteLength(body.note, 'utf8') > 65535) failure('INVALID_CHECK_COMMAND', 400);
  if (body.action === 'saveCheck') { if (!validId(body.ruleVersion) || !validDate(body.previewWeek)) failure('INVALID_CHECK_COMMAND', 400); }
  else {
    if (!validId(body.checkId) || typeof body.reason !== 'string' || !body.reason.isWellFormed() || Buffer.byteLength(body.reason, 'utf8') > 65535) failure('INVALID_CHECK_COMMAND', 400);
    if (!body.reason.trim()) failure('CHECK_REASON_REQUIRED', 422, { fields: { reason: '请填写检查文字纠错原因' } });
  }
  return body;
}
export type CheckKind = 'excluded' | 'not_due' | 'basis_unknown' | 'rule_unknown' | 'pending' | 'overdue' | 'checked' | 'checked_late';
export const checkLabels: Record<CheckKind, string> = { excluded: '不在默认必查范围', not_due: '首次应检周未到', basis_unknown: '首次应检依据待核对', rule_unknown: '检查规则待初始化', pending: '本周待检查', overdue: '本周检查逾期', checked: '本周已检查', checked_late: '本周已检查（晚于截止）' };
// checked_at 为 UTC。截止日次日上海 00:00 是排他上界，保留毫秒精度。
const boundary = (context: { deadlineDate: string | null }) => context.deadlineDate ? new Date(Date.parse(addDays(context.deadlineDate, 1)) - 8 * 3600000).toISOString() : null;
async function effectiveChecks(c: PoolConnection, records: RowDataPacket[]) {
  if (!records.length) return records;
  const [changes] = await c.query<RowDataPacket[]>({ sql: `SELECT CAST(a.id AS CHAR) id,CAST(a.entity_id AS CHAR) checkId,a.actor_display_name actorName,DATE_FORMAT(a.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,a.after_json value
    FROM (SELECT entity_id,MAX(id) id FROM audit_log WHERE entity_type='project_check' AND action='project.check.correct' AND entity_id IN (${records.map(() => '?').join(',')}) GROUP BY entity_id) g JOIN audit_log a ON a.id=g.id`, timeout: 3000 }, records.map(r => r.id));
  const byId = new Map(changes.map(change => [change.checkId, change]));
  for (const record of records) {
    record.original = { conclusion: record.conclusion, note: record.note };
    const correction = byId.get(record.id);
    if (correction) {
      const value = typeof correction.value === 'string' ? JSON.parse(correction.value) : correction.value;
      Object.assign(record, value.check); record.correction = { id: correction.id, actorName: correction.actorName, createdAt: correction.createdAt, reason: value.reason };
    } else record.correction = null;
  }
  return records;
}
const checkColumns = `CAST(ck.project_id AS CHAR) projectId,CAST(ck.id AS CHAR) id,CAST(ck.actor_id AS CHAR) actorId,COALESCE(originalAudit.actor_display_name,u.display_name) actorName,
  DATE_FORMAT(ck.checked_at,'%Y-%m-%dT%H:%i:%s.%fZ') checkedAt,DATE_FORMAT(ck.week_start,'%Y-%m-%d') weekStart,
  ck.conclusion,ck.note,CAST(ck.rule_version AS CHAR) ruleVersion,CAST(ck.result_version AS CHAR) resultVersion,CAST(ck.observed_version AS CHAR) observedVersion`;
const actorJoins = "LEFT JOIN users u ON u.id=ck.actor_id LEFT JOIN audit_log originalAudit ON originalAudit.entity_type='project_check' AND originalAudit.entity_id=ck.id AND originalAudit.action='project.check.save'";
export async function checkCandidate(c: PoolConnection, id: string, project: { version: string }, body: CheckCommand, now: Date, context?: Context) {
  if (body.action === 'saveCheck') {
    const rule = context ?? await checkContext(c, undefined, now);
    if (!rule.rule) failure('CHECK_RULE_REQUIRED', 422);
    if (body.ruleVersion !== rule.rule.version || body.previewWeek !== rule.weekStart) failure('CHECK_PREVIEW_CHANGED', 409);
    const check = { conclusion: body.conclusion, note: body.note, checkedAt: now.toISOString(), weekStart: rule.weekStart, ruleVersion: rule.rule.version, observedVersion: project.version, resultVersion: (BigInt(project.version) + 1n).toString() };
    return { changed: true, beforeValues: null, afterValues: { check }, preview: { changed: true, beforeValues: null, afterValues: { check }, deadlineDate: rule.deadlineDate, onTime: now.getTime() < Date.parse(boundary(rule)!) } };
  }
  const [rows] = await c.query<RowDataPacket[]>({ sql: `SELECT ${checkColumns} FROM project_checks ck ${actorJoins} WHERE ck.project_id=? AND ck.id=?`, timeout: 3000 }, [id, body.checkId]);
  if (!rows.length) failure('PROJECT_CHECK_NOT_FOUND', 404);
  const record = (await effectiveChecks(c, rows))[0];
  const beforeValues = { check: { id: record.id, conclusion: record.conclusion, note: record.note } }, afterValues = { check: { id: record.id, conclusion: body.conclusion, note: body.note }, reason: body.reason };
  const changed = record.conclusion !== body.conclusion || record.note !== body.note;
  return { changed, beforeValues, afterValues, preview: { changed, beforeValues, afterValues, original: record.original, checkedAt: record.checkedAt, actorName: record.actorName, weekStart: record.weekStart, ruleVersion: record.ruleVersion, observedVersion: record.observedVersion, resultVersion: record.resultVersion } };
}
export function projectChecks(database: RuntimeDatabase, clock = () => new Date()) {
  return { read(id: string, pageSize: number, before?: string) { return database.readSnapshot(async c => {
    const [projects] = await c.query<RowDataPacket[]>('SELECT CAST(version AS CHAR) version FROM projects WHERE id=?', [id]);
    if (!projects.length) failure('PROJECT_NOT_FOUND', 404);
    const context = await checkContext(c, undefined, clock());
    const [records] = await c.query<RowDataPacket[]>({ sql: `SELECT ${checkColumns},originalRule.deadline_weekday originalDeadlineWeekday,
      effectiveRule.deadline_weekday effectiveDeadlineWeekday,CAST(effectiveRule.version AS CHAR) effectiveRuleVersion
      FROM project_checks ck ${actorJoins} JOIN check_rule_revisions originalRule ON originalRule.version=ck.rule_version
      LEFT JOIN check_rule_revisions effectiveRule ON effectiveRule.version=(SELECT r.version FROM check_rule_revisions r WHERE r.effective_week<=ck.week_start AND r.saved_at<DATE_SUB(DATE_ADD(ck.week_start,INTERVAL 7 DAY),INTERVAL 8 HOUR) ORDER BY r.effective_week DESC,r.version DESC LIMIT 1)
      WHERE ck.project_id=?${before ? ' AND ck.id<?' : ''} ORDER BY ck.id DESC LIMIT ?`, timeout: 3000 }, [id, ...before ? [before] : [], pageSize + 1]);
    const hasMore = records.length > pageSize; if (hasMore) records.pop();
    await effectiveChecks(c, records);
    for (const record of records) {
      const current = record.weekStart === context.weekStart;
      const weekday = current ? context.rule?.deadlineWeekday ?? null : record.effectiveDeadlineWeekday;
      record.deadlineDate = weekday == null ? null : addDays(record.weekStart, Number(weekday) - 1);
      record.effectiveRuleVersion = current ? context.rule?.version ?? null : record.effectiveRuleVersion;
      record.onTime = record.deadlineDate ? Date.parse(record.checkedAt) < Date.parse(boundary(record as { deadlineDate: string })!) : null;
      record.originalDeadlineDate = addDays(record.weekStart, Number(record.originalDeadlineWeekday) - 1);
      record.originalOnTime = Date.parse(record.checkedAt) < Date.parse(boundary({ deadlineDate: record.originalDeadlineDate })!);
    }
    return { projectVersion: projects[0].version, items: records, nextCursor: hasMore ? records.at(-1)!.id : null, pageSize, rule: context };
  }); } };
}
export function checkConditions(context: Context) {
  const required = context.rule ? 'p.status=\'ongoing\' AND p.first_check_week<=?' : 'FALSE';
  const requiredValues = context.rule ? [context.weekStart] : [];
  const checked = 'EXISTS (SELECT 1 FROM project_checks ck WHERE ck.project_id=p.id AND ck.week_start=?)';
  const unchecked = `${required} AND NOT ${checked}`;
  return [
    { key: 'checkRequired', sql: required, values: requiredValues },
    { key: 'checkPending', sql: context.deadlineDate && context.businessDate <= context.deadlineDate ? unchecked : 'FALSE', values: context.deadlineDate && context.businessDate <= context.deadlineDate ? [...requiredValues, context.weekStart] : [] },
    { key: 'checkOverdue', sql: context.deadlineDate && context.businessDate > context.deadlineDate ? unchecked : 'FALSE', values: context.deadlineDate && context.businessDate > context.deadlineDate ? [...requiredValues, context.weekStart] : [] },
    { key: 'checkDone', sql: `${required} AND ${checked}`, values: [...requiredValues, context.weekStart] },
    { key: 'checkUpdated', sql: `${required} AND p.version>(SELECT ck.result_version FROM project_checks ck WHERE ck.project_id=p.id AND ck.week_start=? ORDER BY ck.id DESC LIMIT 1)`, values: [...requiredValues, context.weekStart] },
  ];
}
export function todayCheckCondition(businessDate: string) {
  const start = Date.parse(businessDate) - 8 * 3600000;
  return {
    sql: 'EXISTS (SELECT 1 FROM project_checks today_check WHERE today_check.project_id=p.id AND today_check.checked_at>=? AND today_check.checked_at<?)',
    values: [start, start + 86400000].map(time => new Date(time).toISOString().slice(0, 23).replace('T', ' ')),
  };
}
export async function enrichChecks(c: PoolConnection, projects: RowDataPacket[], context: Context) {
  if (!projects.length) return;
  const [records] = await c.query<RowDataPacket[]>({ sql: `SELECT ${checkColumns},DATE_FORMAT(first.checked_at,'%Y-%m-%dT%H:%i:%s.%fZ') firstAt
    FROM (SELECT project_id,MIN(id) firstId,MAX(id) latestId FROM project_checks WHERE week_start=? AND project_id IN (${projects.map(() => '?').join(',')}) GROUP BY project_id) g
    JOIN project_checks ck ON ck.id=g.latestId JOIN project_checks first ON first.id=g.firstId ${actorJoins}`, timeout: 3000 }, [context.weekStart, ...projects.map(p => p.id)]);
  await effectiveChecks(c, records);
  const byProject = new Map(records.map(r => [r.projectId, r]));
  const end = boundary(context);
  for (const p of projects) {
    const record = byProject.get(p.id);
    const required = p.status === 'ongoing' && !!context.rule && !!p.firstCheckWeek && p.firstCheckWeek <= context.weekStart;
    const onTime = record && end ? Date.parse(record.firstAt) < Date.parse(end) : null;
    const kind: CheckKind = record ? onTime === false ? 'checked_late' : 'checked' : p.status !== 'ongoing' ? 'excluded' : !p.firstCheckWeek ? 'basis_unknown' : !context.rule ? 'rule_unknown' : p.firstCheckWeek > context.weekStart ? 'not_due' : context.businessDate > context.deadlineDate! ? 'overdue' : 'pending';
    p.checkStatus = { kind, label: checkLabels[kind], required, weekStart: context.weekStart, deadlineDate: context.deadlineDate, onTime, updatedAfterCheck: !!record && BigInt(p.version) > BigInt(record.resultVersion), latest: record ? { id: record.id, actorId: record.actorId, actorName: record.actorName, checkedAt: record.checkedAt, conclusion: record.conclusion, note: record.note, observedVersion: record.observedVersion, resultVersion: record.resultVersion } : null };
  }
}
