import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Actor } from './identity.js';
import { failure, validId } from './project-save.js';

type RiskFields = { content: string; level: 'high' | 'mid' | 'low'; resolution: string };
export type RiskOperation =
  | { op: 'add'; tempId: string; content: string; level: RiskFields['level'] }
  | { op: 'correct'; id: string; changes: Partial<RiskFields>; reason: string }
  | { op: 'resolve'; id: string; resolution: string }
  | { op: 'undoResolve'; id: string; reason: string };
type Risk = RowDataPacket & RiskFields & { id: string; resolved: number; resolvedAt: string | null; actorId: string | null; createdAt: string; sourceKey: string | null; sortOrder: number; createdByName: string | null; resolvedByName: string | null };
type RiskEvent = { op: RiskOperation['op']; id: string; before: Risk | null; after: Risk; reason: string };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fieldKeys = ['content', 'level', 'resolution'] as const;

export function validateRiskOps(value: unknown): RiskOperation[] {
  if (!Array.isArray(value) || !value.length) failure('INVALID_RISK_OPERATIONS', 400);
  const fields: Record<string, string> = {}, added = new Set<string>();
  function text(value: unknown, key: string) {
    if (typeof value !== 'string') failure('INVALID_RISK_OPERATIONS', 400);
    if (!value.trim() || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 65535) fields[key] = '请填写有效的非空文字，最多65535字节';
  }
  const operations = value.map((item, index) => {
    if (!object(item)) failure('INVALID_RISK_OPERATIONS', 400);
    const keys = item.op === 'add' ? ['op', 'tempId', 'content', 'level'] : item.op === 'correct' ? ['op', 'id', 'changes', 'reason'] : item.op === 'resolve' ? ['op', 'id', 'resolution'] : item.op === 'undoResolve' ? ['op', 'id', 'reason'] : [];
    if (!keys.length || keys.length !== Object.keys(item).length || keys.some(key => !Object.hasOwn(item, key))) failure('INVALID_RISK_OPERATIONS', 400);
    if (item.op === 'add') {
      if (!uuid(item.tempId) || added.has(item.tempId)) failure('INVALID_RISK_OPERATIONS', 400);
      added.add(item.tempId);
    } else if (!validId(item.id) && !(uuid(item.id) && added.has(item.id))) failure('INVALID_RISK_OPERATIONS', 400);
    const prefix = 'riskOps.' + index + '.';
    if (Object.hasOwn(item, 'reason')) text(item.reason, prefix + 'reason');
    const values = item.op === 'correct' ? item.changes : item.op === 'add' ? { content: item.content, level: item.level } : item.op === 'resolve' ? { resolution: item.resolution } : {};
    if (!object(values) || item.op === 'correct' && (!Object.keys(values).length || Object.keys(values).some(key => !fieldKeys.includes(key as typeof fieldKeys[number])))) failure('INVALID_RISK_OPERATIONS', 400);
    for (const [key, value] of Object.entries(values)) {
      if (key === 'level') { if (!['high', 'mid', 'low'].includes(value as string)) fields[prefix + key] = '请选择高、中或低'; }
      else text(value, prefix + key);
    }
    // 固定对象键顺序，原正文键顺序变化仍是同一个保存。
    return Object.fromEntries(keys.map(key => [key, key === 'changes' ? Object.fromEntries(fieldKeys.filter(field => Object.hasOwn(values, field)).map(field => [field, values[field]])) : item[key]])) as RiskOperation;
  });
  if (Object.keys(fields).length) failure('INVALID_PROJECT_FIELDS', 422, { fields });
  return operations;
}
async function query(connection: PoolConnection, sql: string, values: unknown[] = []) { return (await connection.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0]; }
export async function riskRows(connection: PoolConnection, id: string): Promise<Risk[]> {
  const rows = await query(connection, "SELECT CAST(id AS CHAR) id,content,level,resolved,resolution,DATE_FORMAT(resolved_at,'%Y-%m-%dT%H:%i:%s.%fZ') resolvedAt,CAST(actor_id AS CHAR) actorId,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,source_key sourceKey,sort_order sortOrder FROM project_risks WHERE project_id=? ORDER BY sort_order,id", [id]) as Risk[];
  if (!rows.length) return rows;
  const placeholders = rows.map(() => '?').join(',');
  const facts = await query(connection, `SELECT CAST(a.entity_id AS CHAR) id,a.action,a.actor_display_name name FROM (
    SELECT MIN(id) id FROM audit_log WHERE entity_type='project_risk' AND entity_id IN (${placeholders}) AND action='project.risk.add' GROUP BY entity_id
    UNION ALL SELECT MAX(id) id FROM audit_log WHERE entity_type='project_risk' AND entity_id IN (${placeholders}) AND action='project.risk.resolve' GROUP BY entity_id
    ) targets JOIN audit_log a ON a.id=targets.id`, [...rows.map(row => row.id), ...rows.map(row => row.id)]);
  const names = new Map(facts.map(fact => [fact.id + ':' + fact.action, fact.name]));
  for (const row of rows) { row.createdByName = names.get(row.id + ':project.risk.add') ?? null; row.resolvedByName = row.resolved ? names.get(row.id + ':project.risk.resolve') ?? null : null; }
  return rows;
}
export async function riskCandidate(connection: PoolConnection, id: string, operations: RiskOperation[], actor: Actor, timestamp: string) {
  const rows = await riskRows(connection, id), candidates = structuredClone(rows), events: RiskEvent[] = [], targets = new Map(candidates.map(row => [row.id, row]));
  let order = rows.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
  for (const [index, operation] of operations.entries()) {
    let row: Risk;
    if (operation.op === 'add') {
      if (order > 4294967295) failure('RISK_ORDER_EXHAUSTED', 422);
      row = { id: operation.tempId, content: operation.content, level: operation.level, resolved: 0, resolution: '', resolvedAt: null, actorId: actor.id, createdAt: timestamp, sourceKey: null, sortOrder: order++, createdByName: actor.name, resolvedByName: null } as Risk;
      candidates.push(row); targets.set(row.id, row); events.push({ op: 'add', id: row.id, before: null, after: structuredClone(row), reason: '' }); continue;
    }
    row = targets.get(operation.id)!;
    if (!row) failure('RISK_NOT_FOUND', 404);
    const before = structuredClone(row);
    if (operation.op === 'correct') {
      if (Object.hasOwn(operation.changes, 'resolution') && !row.resolved) failure('RISK_RESOLUTION_REQUIRES_RESOLVED', 422, { fields: { ['riskOps.' + index]: '预警中的风险不能更正解除说明，请选择明确解除' } });
      Object.assign(row, operation.changes);
    } else if (operation.op === 'resolve') {
      if (row.resolved) failure('RISK_ALREADY_RESOLVED', 422);
      Object.assign(row, { resolved: 1, resolution: operation.resolution, resolvedAt: timestamp, resolvedByName: actor.name });
    } else {
      if (!row.resolved) failure('RISK_NOT_RESOLVED', 422);
      Object.assign(row, { resolved: 0, resolution: '', resolvedAt: null, resolvedByName: null });
    }
    if (JSON.stringify(before) !== JSON.stringify(row)) events.push({ op: operation.op, id: row.id, before, after: structuredClone(row), reason: 'reason' in operation ? operation.reason : '' });
  }
  return { rows: candidates, events };
}
export async function writeRisks(connection: PoolConnection, id: string, candidate: Awaited<ReturnType<typeof riskCandidate>>, actor: Actor, versionBefore: string, versionAfter: string, requestId: string, timestamp: string) {
  const idMap: Record<string, string> = {};
  for (const event of candidate.events) {
    const target = idMap[event.id] ?? event.id, after = event.after;
    if (event.op === 'add') {
      await connection.execute('INSERT INTO project_risks (project_id,content,level,resolved,resolution,resolved_at,actor_id,created_at,sort_order) VALUES (?,?,?,0,\'\',NULL,?,?,?)', [id, after.content, after.level, actor.id, timestamp, after.sortOrder]);
      idMap[event.id] = (await query(connection, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
    } else await connection.execute('UPDATE project_risks SET content=?,level=?,resolved=?,resolution=?,resolved_at=? WHERE project_id=? AND id=?', [after.content, after.level, after.resolved, after.resolution, after.resolvedAt?.slice(0, 23).replace('T', ' ') ?? null, id, target]);
    const stableId = idMap[event.id] ?? event.id;
    const before = event.before ? { ...event.before, id: stableId } : null;
    await connection.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
      VALUES (?,?,'user',?,'project_risk',?,?,?,?,?,?,?,?)`, [actor.id, actor.name, 'project.risk.' + event.op, stableId, id, versionBefore, versionAfter, JSON.stringify({ risk: before }), JSON.stringify({ risk: { ...after, id: stableId }, reason: event.reason }), requestId, timestamp]);
  }
  return { riskIdMap: idMap, risks: await riskRows(connection, id) };
}
