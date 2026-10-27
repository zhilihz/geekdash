import {readCheckPolicy,type CheckPolicy} from './public-settings.js';
import { assertProjectAccess } from './project-membership.js';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { businessToday, validDate } from './project-dates.js';
import { failure, validId } from './project-save.js';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';

type Context = { businessDate: string };
export type CheckCommand = { expectedVersion: string; idempotencyKey: string; conclusion: 'checked' | 'follow_up'; note: string } & (
  { action: 'saveCheck'; ruleVersion?: string; previewWeek?: string }
  | { action: 'correctCheck'; checkId: string; reason?: string });
export const isCheckCommand = (body: { action: string }): body is CheckCommand => ['saveCheck', 'correctCheck'].includes(body.action);
export function validateCheck(value: unknown): CheckCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('INVALID_CHECK_COMMAND', 400);
  const body = value as CheckCommand;
  const required = ['action', 'expectedVersion', 'idempotencyKey', 'conclusion', 'note', ...(body.action === 'correctCheck' ? ['checkId'] : [])];
  const fields = [...required, ...(body.action === 'saveCheck' ? ['ruleVersion', 'previewWeek'] : ['reason'])];
  if (!isCheckCommand(body) || required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => !fields.includes(key)) || !validId(body.expectedVersion)
    || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)
    || !['checked', 'follow_up'].includes(body.conclusion) || typeof body.note !== 'string' || !body.note.isWellFormed() || Buffer.byteLength(body.note, 'utf8') > 65535) failure('INVALID_CHECK_COMMAND', 400);
  if (body.action === 'saveCheck') { if (body.ruleVersion !== undefined && !validId(body.ruleVersion) || body.previewWeek !== undefined && !validDate(body.previewWeek)) failure('INVALID_CHECK_COMMAND', 400); }
  else {
    if (!validId(body.checkId) || body.reason !== undefined && (typeof body.reason !== 'string' || !body.reason.isWellFormed() || Buffer.byteLength(body.reason, 'utf8') > 65535)) failure('INVALID_CHECK_COMMAND', 400);
  }
  // 旧命令的可选字段原样参与回执哈希；不为新命令补造规则或原因。
  return body;
}
export type CheckKind = 'unchecked' | 'checked';
export const checkLabels: Record<CheckKind, string> = { unchecked: '今日未检查', checked: '今日已检查' };
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
export async function checkCandidate(c: PoolConnection, id: string, project: { version: string }, body: CheckCommand, now: Date) {
  if (body.action === 'saveCheck') {
    const policy=await readCheckPolicy(c,now);
    const check = { conclusion: body.conclusion, note: body.note, checkedAt: now.toISOString(), weekStart: policy.frequency==='manual'?null:policy.periodStart, ruleVersion: policy.version==='0'?null:policy.version, observedVersion: project.version, resultVersion: (BigInt(project.version) + 1n).toString() };
    return { changed: true, beforeValues: null, afterValues: { check }, preview: { changed: true, beforeValues: null, afterValues: { check } } };
  }
  const [rows] = await c.query<RowDataPacket[]>({ sql: `SELECT ${checkColumns} FROM project_checks ck ${actorJoins} WHERE ck.project_id=? AND ck.id=?`, timeout: 3000 }, [id, body.checkId]);
  if (!rows.length) failure('PROJECT_CHECK_NOT_FOUND', 404);
  const record = (await effectiveChecks(c, rows))[0];
  const beforeValues = { check: { id: record.id, conclusion: record.conclusion, note: record.note } }, afterValues = { check: { id: record.id, conclusion: body.conclusion, note: body.note }, reason: body.reason };
  const changed = record.conclusion !== body.conclusion || record.note !== body.note;
  return { changed, beforeValues, afterValues, preview: { changed, beforeValues, afterValues, original: record.original, checkedAt: record.checkedAt, actorName: record.actorName, weekStart: record.weekStart, ruleVersion: record.ruleVersion, observedVersion: record.observedVersion, resultVersion: record.resultVersion } };
}
export function projectChecks(database: RuntimeDatabase, clock = () => new Date()) {
  return { read(id: string, pageSize: number, before?: string, accountId?:string) { return database.readSnapshot(async c => {
    if(accountId)await assertProjectAccess(c,id,accountId);
    const [projects] = await c.query<RowDataPacket[]>('SELECT CAST(version AS CHAR) version FROM projects WHERE id=?', [id]);
    if (!projects.length) failure('PROJECT_NOT_FOUND', 404);
    const [records] = await c.query<RowDataPacket[]>({ sql: `SELECT ${checkColumns}
      FROM project_checks ck ${actorJoins}
      WHERE ck.project_id=?${before ? ' AND ck.id<?' : ''} ORDER BY ck.id DESC LIMIT ?`, timeout: 3000 }, [id, ...before ? [before] : [], pageSize + 1]);
    const hasMore = records.length > pageSize; if (hasMore) records.pop();
    await effectiveChecks(c, records);
    return { projectVersion: projects[0].version, items: records, nextCursor: hasMore ? records.at(-1)!.id : null, pageSize, businessDate: businessToday(clock()) };
  }); } };
}
export function checkConditions() {
  return [
    { key: 'checkUpdated', sql: 'p.version>(SELECT ck.result_version FROM project_checks ck WHERE ck.project_id=p.id ORDER BY ck.id DESC LIMIT 1)', values: [] },
  ];
}
export function todayCheckCondition(businessDate: string) {
  const start = Date.parse(businessDate) - 8 * 3600000;
  return {
    sql: 'EXISTS (SELECT 1 FROM project_checks today_check WHERE today_check.project_id=p.id AND today_check.checked_at>=? AND today_check.checked_at<?)',
    values: [start, start + 86400000].map(time => new Date(time).toISOString().slice(0, 23).replace('T', ' ')),
  };
}
export function cycleCheckCondition(policy:CheckPolicy){
  if(policy.frequency==='manual')return {sql:'EXISTS(SELECT 1 FROM project_checks cycle_check WHERE cycle_check.project_id=p.id)',values:[] as string[]};
  const start=Date.parse(policy.periodStart)-8*3600000,end=start+(policy.frequency==='daily'?1:7)*86400000;
  return {sql:'EXISTS(SELECT 1 FROM project_checks cycle_check WHERE cycle_check.project_id=p.id AND cycle_check.checked_at>=? AND cycle_check.checked_at<?)',values:[start,end].map(time=>new Date(time).toISOString().slice(0,23).replace('T',' '))};
}
export async function enrichChecks(c: PoolConnection, projects: RowDataPacket[], context: Context) {
  if (!projects.length) return;
  const policy=await readCheckPolicy(c,new Date(context.businessDate+'T04:00:00Z'));
  const cycle=cycleCheckCondition(policy);
  const [cycleRecords]=await c.query<RowDataPacket[]>(`SELECT CAST(p.id AS CHAR) id,(${cycle.sql}) checked FROM projects p WHERE p.id IN (?)`,[...cycle.values,projects.map(p=>p.id)]);
  const [records] = await c.query<RowDataPacket[]>({ sql: `SELECT ${checkColumns},g.checkedToday
    FROM (SELECT project_id,MAX(id) latestId,MAX(checked_at>=? AND checked_at<?) checkedToday FROM project_checks WHERE project_id IN (${projects.map(() => '?').join(',')}) GROUP BY project_id) g
    JOIN project_checks ck ON ck.id=g.latestId ${actorJoins}`, timeout: 3000 }, [...todayCheckCondition(context.businessDate).values, ...projects.map(p => p.id)]);
  await effectiveChecks(c, records);
  const byProject = new Map(records.map(r => [r.projectId, r]));
  for (const p of projects) {
    const record = byProject.get(p.id);
    const checkedCycle=!!Number(cycleRecords.find(row=>row.id===p.id)?.checked);
    p.checkPolicy={...policy,checked:checkedCycle,overdue:policy.deadline!==null && context.businessDate>policy.deadline && !checkedCycle};
    p.checkedToday = Number(record?.checkedToday ?? 0) === 1;
    const kind: CheckKind = p.checkedToday ? 'checked' : 'unchecked';
    p.checkStatus = { kind, label: checkLabels[kind], updatedAfterCheck: !!record && BigInt(p.version) > BigInt(record.resultVersion), latest: record ? { id: record.id, actorId: record.actorId, actorName: record.actorName, checkedAt: record.checkedAt, conclusion: record.conclusion, note: record.note, observedVersion: record.observedVersion, resultVersion: record.resultVersion } : null };
  }
}
