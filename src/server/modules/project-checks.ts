import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { addDays, type checkContext } from './project-dates.js';

type Context = Awaited<ReturnType<typeof checkContext>>;
export type CheckKind = 'excluded' | 'not_due' | 'basis_unknown' | 'rule_unknown' | 'pending' | 'overdue' | 'checked' | 'checked_late';
export const checkLabels: Record<CheckKind, string> = { excluded: '不在默认必查范围', not_due: '首次应检周未到', basis_unknown: '首次应检依据待核对', rule_unknown: '检查规则待初始化', pending: '本周待检查', overdue: '本周检查逾期', checked: '本周已检查', checked_late: '本周已检查（晚于截止）' };
// checked_at 为 UTC。截止日次日上海 00:00 是排他上界，保留毫秒精度。
const boundary = (context: Context) => context.deadlineDate ? new Date(Date.parse(addDays(context.deadlineDate, 1)) - 8 * 3600000).toISOString() : null;
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
export async function enrichChecks(c: PoolConnection, projects: RowDataPacket[], context: Context) {
  if (!projects.length) return;
  const [records] = await c.query<RowDataPacket[]>({ sql: `SELECT CAST(ck.project_id AS CHAR) projectId,CAST(ck.id AS CHAR) id,CAST(ck.actor_id AS CHAR) actorId,u.display_name actorName,
    DATE_FORMAT(g.firstAt,'%Y-%m-%dT%H:%i:%s.%fZ') firstAt,DATE_FORMAT(ck.checked_at,'%Y-%m-%dT%H:%i:%s.%fZ') checkedAt,
    ck.conclusion,ck.note,CAST(ck.result_version AS CHAR) resultVersion,CAST(ck.observed_version AS CHAR) observedVersion
    FROM (SELECT project_id,MIN(checked_at) firstAt,MAX(id) latestId FROM project_checks WHERE week_start=? AND project_id IN (${projects.map(() => '?').join(',')}) GROUP BY project_id) g
    JOIN project_checks ck ON ck.id=g.latestId LEFT JOIN users u ON u.id=ck.actor_id`, timeout: 3000 }, [context.weekStart, ...projects.map(p => p.id)]);
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
