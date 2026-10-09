import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { failure } from './project-save.js';

export const businessToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function addDays(date: string, count: number) { return new Date(Date.parse(date) + count * 86400000).toISOString().slice(0, 10); }
export function businessWeek(date: string) { return addDays(date, -((new Date(date).getUTCDay() + 6) % 7)); }
export function weekContext(now: Date, weekday: number | null) {
  const businessDate = businessToday(now), weekStart = businessWeek(businessDate);
  const deadlineDate = weekday === null ? null : addDays(weekStart, weekday - 1);
  return { businessDate, weekStart, deadlineDate, firstCheckWeek: deadlineDate === null ? null : businessDate <= deadlineDate ? weekStart : addDays(weekStart, 7) };
}
export async function checkContext(c: PoolConnection, actorId?: string, now = new Date(), lock = false) {
  const [configs] = await c.query<RowDataPacket[]>(`SELECT CAST(version AS CHAR) configVersion,CAST(maintenance_user_id AS CHAR) maintenanceUserId FROM system_configuration WHERE id=1${lock ? ' FOR SHARE' : ''}`);
  const weekStart = businessWeek(businessToday(now));
  const [rules] = await c.query<RowDataPacket[]>("SELECT CAST(version AS CHAR) version,deadline_weekday deadlineWeekday,DATE_FORMAT(effective_week,'%Y-%m-%d') effectiveWeek,saved_at savedAt,CAST(saved_by AS CHAR) savedBy FROM check_rule_revisions WHERE effective_week<=? ORDER BY effective_week DESC,version DESC LIMIT 1", [weekStart]);
  const rule = rules[0] ?? null;
  return { configVersion: configs[0]?.configVersion ?? null, canMaintain: !!actorId && configs[0]?.maintenanceUserId === actorId, rule, ...weekContext(now, rule?.deadlineWeekday ?? null) };
}
export function requireDate(value: unknown, field: string) {
  if (!validDate(value)) failure('INVALID_PROJECT_DATE', 422, { fields: { [field]: '请选择有效日期' } });
}
