import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { failure } from './project-save.js';

export const businessToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function addDays(date: string, count: number) { return new Date(Date.parse(date) + count * 86400000).toISOString().slice(0, 10); }
export function businessWeek(date: string) { return addDays(date, -((new Date(date).getUTCDay() + 6) % 7)); }
export function requireDate(value: unknown, field: string) {
  if (!validDate(value)) failure('INVALID_PROJECT_DATE', 422, { fields: { [field]: '请选择有效日期' } });
}

export const deadlineKinds = ['upcoming', 'due', 'overdue', 'unset', 'closed_on_time', 'closed_late', 'closed_unplanned', 'closed_unknown', 'terminated'] as const;
export type DeadlineKind = typeof deadlineKinds[number];
export type DateFacts = { status: string; dueDate: string | null; closedOn: string | null; closureDueDate: string | null; closureType: string | null; closurePlanKnown?: boolean | number | string };
export type Deadline = { kind: DeadlineKind; asOfDate: string; days: number | null; label: string };
export const closurePlanKnownExpression = `COALESCE((SELECT JSON_UNQUOTE(JSON_EXTRACT(ia.adopted_json,'$.effectiveClosure.planKnown'))='true' FROM import_adoptions ia
  WHERE ia.target_kind='project' AND ia.target_id=p.id AND JSON_CONTAINS_PATH(ia.adopted_json,'one','$.effectiveClosure')
  AND ia.version_after>COALESCE((SELECT MAX(ac.version_after) FROM audit_log ac WHERE ac.project_id=p.id AND ac.action='project.close'),0)
  ORDER BY ia.id DESC LIMIT 1),(p.created_by IS NOT NULL AND p.source_import_item_id IS NULL OR EXISTS (SELECT 1 FROM audit_log ac WHERE ac.project_id=p.id AND ac.action='project.close')))`;
export const dayDifference = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86400000;
export function deadlineResult(project: DateFacts, today: string): Deadline {
  if (project.status === 'closed') {
    if (project.closureType === 'terminated') return { kind: 'terminated', asOfDate: today, days: null, label: '终止结案' };
    if (project.closureType !== 'normal' || !project.closedOn) return { kind: 'closed_unknown', asOfDate: today, days: null, label: '结案事实待核对' };
    if (!project.closureDueDate && project.closurePlanKnown !== undefined && Number(project.closurePlanKnown) === 0) return { kind: 'closed_unknown', asOfDate: today, days: null, label: '结案时历史计划待核对' };
    if (!project.closureDueDate) return { kind: 'closed_unplanned', asOfDate: today, days: null, label: '结案时计划未定' };
    const days = Math.max(0, dayDifference(project.closureDueDate, project.closedOn));
    return { kind: days ? 'closed_late' : 'closed_on_time', asOfDate: today, days, label: days ? `超期完成 ${days} 天` : '按期完成' };
  }
  if (!project.dueDate) return { kind: 'unset', asOfDate: today, days: null, label: '计划未定' };
  const delta = dayDifference(today, project.dueDate);
  return { kind: delta > 0 ? 'upcoming' : delta < 0 ? 'overdue' : 'due', asOfDate: today, days: Math.abs(delta), label: delta > 0 ? `剩余 ${delta} 天` : delta < 0 ? `已超期 ${-delta} 天` : '今日到期' };
}
// 筛选与范围统计共用同一组已保存事实及业务日；不读取旧人工标记或回放历史。
export function deadlineCondition(kind: DeadlineKind, today: string) {
  switch (kind) {
    case 'upcoming': return { sql: "p.status<>'closed' AND p.current_due_date>?", values: [today] };
    case 'due': return { sql: "p.status<>'closed' AND p.current_due_date=?", values: [today] };
    case 'overdue': return { sql: "p.status<>'closed' AND p.current_due_date<?", values: [today] };
    case 'unset': return { sql: "p.status<>'closed' AND p.current_due_date IS NULL", values: [] };
    case 'terminated': return { sql: "p.status='closed' AND p.closure_type='terminated'", values: [] };
    case 'closed_unknown': return { sql: `p.status='closed' AND (p.closure_type IS NULL OR p.closure_type<>'terminated' AND (p.closure_type<>'normal' OR p.closed_on IS NULL OR p.closure_due_date IS NULL AND NOT ${closurePlanKnownExpression}))`, values: [] };
    case 'closed_unplanned': return { sql: `p.status='closed' AND p.closure_type='normal' AND p.closed_on IS NOT NULL AND p.closure_due_date IS NULL AND ${closurePlanKnownExpression}`, values: [] };
    case 'closed_on_time': return { sql: "p.status='closed' AND p.closure_type='normal' AND p.closed_on<=p.closure_due_date", values: [] };
    case 'closed_late': return { sql: "p.status='closed' AND p.closure_type='normal' AND p.closed_on>p.closure_due_date", values: [] };
  }
}

export async function initialPlan(c: PoolConnection, id: string, project: { originalDueDate: string | null; dueDate: string | null; createdBy: string | null; sourceImportItemId: unknown }, date: string) {
  const [previous] = await c.query<RowDataPacket[]>("SELECT EXISTS(SELECT 1 FROM schedule_changes WHERE project_id=?) OR EXISTS(SELECT 1 FROM audit_log WHERE project_id=? AND JSON_CONTAINS_PATH(after_json,'one','$.dueDate','$.originalDueDate','$.currentDueDate')) recorded", [id, id]);
  return !project.originalDueDate && !project.dueDate && project.createdBy && !project.sourceImportItemId && !Number(previous[0].recorded) ? date : project.originalDueDate;
}
