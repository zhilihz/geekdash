import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Actor } from './identity.js';
import { failure, validId } from './project-save.js';
import { businessToday, requireDate } from './project-dates.js';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';

type RiskFields = { content: string; level: 'high' | 'mid' | 'low'; resolution: string };
export type RiskOperation =
  | { op: 'add'; tempId: string; content: string; level: RiskFields['level'] }
  | { op: 'correct'; id: string; changes: Partial<RiskFields>; reason: string }
  | { op: 'resolve'; id: string; resolution: string }
  | { op: 'undoResolve'; id: string; reason: string }
  | { op: 'delete'; id: string };
type Risk = RowDataPacket & RiskFields & { id: string; resolved: number; resolvedAt: string | null; deletedAt: string | null; actorId: string | null; createdAt: string; sourceKey: string | null; sortOrder: number; createdByName: string | null; resolvedByName: string | null };
type RiskEvent = { op: RiskOperation['op']; id: string; before: Risk | null; after: Risk; reason: string };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fieldKeys = ['content', 'level', 'resolution'] as const;

export function validateRiskOps(value: unknown): RiskOperation[] {
  if (!Array.isArray(value) || !value.length) failure('INVALID_RISK_OPERATIONS', 400);
  const fields: Record<string, string> = {}, added = new Set<string>();
  function text(value: unknown, key: string, required = true) {
    if (typeof value !== 'string') failure('INVALID_RISK_OPERATIONS', 400);
    if (required && !value.trim() || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 65535) fields[key] = '请填写有效的非空文字，最多65535字节';
  }
  const operations = value.map((item, index) => {
    if (!object(item)) failure('INVALID_RISK_OPERATIONS', 400);
    const keys = item.op === 'add' ? ['op', 'tempId', 'content', 'level'] : item.op === 'correct' ? ['op', 'id', 'changes', 'reason'] : item.op === 'resolve' ? ['op', 'id', 'resolution'] : item.op === 'undoResolve' ? ['op', 'id', 'reason'] : item.op === 'delete' ? ['op', 'id'] : [];
    if (!keys.length || keys.length !== Object.keys(item).length || keys.some(key => !Object.hasOwn(item, key))) failure('INVALID_RISK_OPERATIONS', 400);
    if (item.op === 'add') {
      if (!uuid(item.tempId) || added.has(item.tempId)) failure('INVALID_RISK_OPERATIONS', 400);
      added.add(item.tempId);
    } else if (!validId(item.id) && !(uuid(item.id) && added.has(item.id))) failure('INVALID_RISK_OPERATIONS', 400);
    const prefix = 'riskOps.' + index + '.';
    if (Object.hasOwn(item, 'reason')) text(item.reason, prefix + 'reason', item.op !== 'correct');
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
  const rows = await query(connection, "SELECT CAST(id AS CHAR) id,content,level,resolved,resolution,DATE_FORMAT(deleted_at,'%Y-%m-%dT%H:%i:%s.%fZ') deletedAt,DATE_FORMAT(resolved_at,'%Y-%m-%dT%H:%i:%s.%fZ') resolvedAt,CAST(actor_id AS CHAR) actorId,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,source_key sourceKey,sort_order sortOrder FROM project_risks WHERE project_id=? AND deleted_at IS NULL ORDER BY sort_order,project_risks.id", [id]) as Risk[];
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
      row = { id: operation.tempId, content: operation.content, level: operation.level, deletedAt: null, resolved: 0, resolution: '', resolvedAt: null, actorId: actor.id, createdAt: timestamp, sourceKey: null, sortOrder: order++, createdByName: actor.name, resolvedByName: null } as Risk;
      candidates.push(row); targets.set(row.id, row); events.push({ op: 'add', id: row.id, before: null, after: structuredClone(row), reason: '' }); continue;
    }
    row = targets.get(operation.id)!;
    if (!row || row.deletedAt) failure('RISK_NOT_FOUND', 404);
    const before = structuredClone(row);
    if (operation.op === 'correct') {
      if (Object.hasOwn(operation.changes, 'resolution') && !row.resolved) failure('RISK_RESOLUTION_REQUIRES_RESOLVED', 422, { fields: { ['riskOps.' + index]: '预警中的风险不能更正解除说明，请选择明确解除' } });
      if (operation.changes.level !== undefined && operation.changes.level !== row.level && !operation.reason.trim()) failure('INVALID_PROJECT_FIELDS', 422, { fields: { ['riskOps.' + index + '.reason']: '修改风险等级需要说明原因' } });
      Object.assign(row, operation.changes);
    } else if (operation.op === 'resolve') {
      if (row.resolved) failure('RISK_ALREADY_RESOLVED', 422);
      Object.assign(row, { resolved: 1, resolution: operation.resolution, resolvedAt: timestamp, resolvedByName: actor.name });
    } else if (operation.op === 'delete') { row.deletedAt = timestamp;
    } else {
      if (!row.resolved) failure('RISK_NOT_RESOLVED', 422);
      Object.assign(row, { resolved: 0, resolution: '', resolvedAt: null, resolvedByName: null });
    }
    if (JSON.stringify(before) !== JSON.stringify(row)) events.push({ op: operation.op, id: row.id, before, after: structuredClone(row), reason: 'reason' in operation ? operation.reason : '' });
  }
  return { rows: candidates.filter(row => !row.deletedAt), events };
}
export async function writeRisks(connection: PoolConnection, id: string, candidate: Awaited<ReturnType<typeof riskCandidate>>, actor: Actor, versionBefore: string, versionAfter: string, requestId: string, timestamp: string) {
  const idMap: Record<string, string> = {};
  for (const event of candidate.events) {
    const target = idMap[event.id] ?? event.id, after = event.after;
    if (event.op === 'add') {
      await connection.execute('INSERT INTO project_risks (project_id,content,level,resolved,resolution,resolved_at,actor_id,created_at,sort_order) VALUES (?,?,?,0,\'\',NULL,?,?,?)', [id, after.content, after.level, actor.id, timestamp, after.sortOrder]);
      idMap[event.id] = (await query(connection, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
    } else if (event.op === 'delete') await connection.execute('UPDATE project_risks SET deleted_at=? WHERE project_id=? AND id=?', [timestamp, id, target]);
    else await connection.execute('UPDATE project_risks SET content=?,level=?,resolved=?,resolution=?,resolved_at=? WHERE project_id=? AND id=?', [after.content, after.level, after.resolved, after.resolution, after.resolvedAt?.slice(0, 23).replace('T', ' ') ?? null, id, target]);
    const stableId = idMap[event.id] ?? event.id;
    const before = event.before ? { ...event.before, id: stableId } : null;
    await connection.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
      VALUES (?,?,'user',?,'project_risk',?,?,?,?,?,?,?,?)`, [actor.id, actor.name, 'project.risk.' + event.op, stableId, id, versionBefore, versionAfter, JSON.stringify({ risk: before }), JSON.stringify({ risk: { ...after, id: stableId }, reason: event.reason }), requestId, timestamp]);
  }
  return { riskIdMap: idMap, risks: await riskRows(connection, id) };
}

type ChangeFields = { source: string; content: string; decision: 'accept' | 'reject'; reason: string };
export type ChangeOperation = { op: 'add'; tempId: string } & ChangeFields | { op: 'correct'; id: string; changes: Partial<ChangeFields>; correctionReason: string };
type Change = RowDataPacket & ChangeFields & { id: string; actorId: string | null; createdAt: string; sourceKey: string | null; sortOrder: number; createdByName: string | null };
type ChangeEvent = { op: ChangeOperation['op']; id: string; before: Change | null; after: Change; correctionReason: string };
const changeFieldKeys = ['source', 'content', 'decision', 'reason'] as const;
export function validateChangeOps(value: unknown): ChangeOperation[] {
  if (!Array.isArray(value) || !value.length) failure('INVALID_CHANGE_OPERATIONS', 400);
  const fields: Record<string, string> = {}, added = new Set<string>();
  const text = (value: unknown, key: string, required = true) => {
    if (typeof value !== 'string') failure('INVALID_CHANGE_OPERATIONS', 400);
    if (required && !value.trim() || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 65535) fields[key] = '请填写有效的非空文字，最多65535字节';
  };
  const operations = value.map((item, index) => {
    if (!object(item)) failure('INVALID_CHANGE_OPERATIONS', 400);
    const keys = item.op === 'add' ? ['op', 'tempId', ...changeFieldKeys] : item.op === 'correct' ? ['op', 'id', 'changes', 'correctionReason'] : [];
    if (!keys.length || keys.length !== Object.keys(item).length || keys.some(key => !Object.hasOwn(item, key))) failure('INVALID_CHANGE_OPERATIONS', 400);
    if (item.op === 'add') {
      if (!uuid(item.tempId) || added.has(item.tempId)) failure('INVALID_CHANGE_OPERATIONS', 400);
      added.add(item.tempId);
    } else if (!validId(item.id) && !(uuid(item.id) && added.has(item.id))) failure('INVALID_CHANGE_OPERATIONS', 400);
    const prefix = 'changeOps.' + index + '.', data = item.op === 'correct' ? item.changes : Object.fromEntries(changeFieldKeys.map(key => [key, item[key]]));
    if (!object(data) || !Object.keys(data).length || Object.keys(data).some(key => !changeFieldKeys.includes(key as typeof changeFieldKeys[number]))) failure('INVALID_CHANGE_OPERATIONS', 400);
    if (item.op === 'correct') text(item.correctionReason, prefix + 'correctionReason', false);
    for (const [key, value] of Object.entries(data)) {
      if (key === 'source' || key === 'decision') { if (!(key === 'source' ? ['客户', '业务'] : ['accept', 'reject']).includes(value as string)) fields[prefix + key] = '请选择原面板的有效选项'; }
      else text(value, prefix + key);
    }
    return Object.fromEntries(keys.map(key => [key, key === 'changes' ? Object.fromEntries(changeFieldKeys.filter(field => Object.hasOwn(data, field)).map(field => [field, data[field]])) : item[key]])) as ChangeOperation;
  });
  if (Object.keys(fields).length) failure('INVALID_PROJECT_FIELDS', 422, { fields });
  return operations;
}
export async function changeRows(connection: PoolConnection, id: string): Promise<Change[]> {
  const rows = await query(connection, "SELECT CAST(id AS CHAR) id,source,content,decision,reason,CAST(actor_id AS CHAR) actorId,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,source_key sourceKey,sort_order sortOrder FROM project_changes WHERE project_id=? ORDER BY sort_order,project_changes.id", [id]) as Change[];
  if (!rows.length) return rows;
  const facts = await query(connection, `SELECT CAST(a.entity_id AS CHAR) id,a.actor_display_name name FROM (
    SELECT MIN(id) id FROM audit_log WHERE entity_type='project_change' AND entity_id IN (${rows.map(() => '?').join(',')}) AND action='project.change.add' GROUP BY entity_id
    ) targets JOIN audit_log a ON a.id=targets.id`, rows.map(row => row.id));
  const names = new Map(facts.map(fact => [fact.id, fact.name]));
  for (const row of rows) row.createdByName = names.get(row.id) ?? null;
  return rows;
}
export async function changeCandidate(connection: PoolConnection, id: string, operations: ChangeOperation[], actor: Actor, timestamp: string) {
  const rows = await changeRows(connection, id), candidates = structuredClone(rows), events: ChangeEvent[] = [], targets = new Map(candidates.map(row => [row.id, row]));
  let order = rows.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
  for (const operation of operations) {
    if (operation.op === 'add') {
      if (order > 4294967295) failure('CHANGE_ORDER_EXHAUSTED', 422);
      const row = { id: operation.tempId, source: operation.source, content: operation.content, decision: operation.decision, reason: operation.reason, actorId: actor.id, createdAt: timestamp, sourceKey: null, sortOrder: order++, createdByName: actor.name } as Change;
      candidates.push(row); targets.set(row.id, row); events.push({ op: 'add', id: row.id, before: null, after: structuredClone(row), correctionReason: '' });
    } else {
      const row = targets.get(operation.id); if (!row) failure('CHANGE_NOT_FOUND', 404);
      if (['source', 'decision'].some(key => Object.hasOwn(operation.changes, key) && operation.changes[key as keyof ChangeFields] !== row[key as keyof ChangeFields]) && !operation.correctionReason.trim()) failure('INVALID_PROJECT_FIELDS', 422, { fields: { correctionReason: '修改来源或接受/拒绝决定需要说明原因' } });
      const before = structuredClone(row); Object.assign(row, operation.changes);
      if (JSON.stringify(before) !== JSON.stringify(row)) events.push({ op: 'correct', id: row.id, before, after: structuredClone(row), correctionReason: operation.correctionReason });
    }
  }
  return { rows: candidates, events };
}
export async function writeChanges(connection: PoolConnection, id: string, candidate: Awaited<ReturnType<typeof changeCandidate>>, actor: Actor, versionBefore: string, versionAfter: string, requestId: string, timestamp: string) {
  const idMap: Record<string, string> = {};
  for (const event of candidate.events) {
    const after = event.after;
    if (event.op === 'add') {
      await connection.execute('INSERT INTO project_changes (project_id,source,content,decision,reason,actor_id,created_at,sort_order) VALUES (?,?,?,?,?,?,?,?)', [id, after.source, after.content, after.decision, after.reason, actor.id, timestamp, after.sortOrder]);
      idMap[event.id] = (await query(connection, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
    } else await connection.execute('UPDATE project_changes SET source=?,content=?,decision=?,reason=? WHERE project_id=? AND id=?', [after.source, after.content, after.decision, after.reason, id, idMap[event.id] ?? event.id]);
    const stableId = idMap[event.id] ?? event.id;
    await connection.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
      VALUES (?,?,'user',?,'project_change',?,?,?,?,?,?,?,?)`, [actor.id, actor.name, 'project.change.' + event.op, stableId, id, versionBefore, versionAfter, JSON.stringify({ change: event.before ? { ...event.before, id: stableId } : null }), JSON.stringify({ change: { ...after, id: stableId }, correctionReason: event.correctionReason }), requestId, timestamp]);
  }
  return { changeIdMap: idMap, changes: await changeRows(connection, id) };
}

type NodeFields = { title: string; stage: string | null; targetDate: string | null; output: string; note: string };
type Edge = { from: string; to: string };
export type NodeOperation =
  | { op: 'add'; tempId: string; kind: 'project' | 'customer'; fields: Partial<NodeFields> & { title: string } }
  | { op: 'correct'; id: string; changes: Partial<NodeFields>; reason: string }
  | { op: 'complete'; id: string; completedOn: string; reason?: string }
  | { op: 'uncomplete'; id: string; reason: string; affectedIds: string[] }
  | { op: 'move'; id: string; x: number; y: number }
  | { op: 'link'; from: string; to: string; replaceEdges: Edge[]; affectedIds: string[]; reason: string }
  | { op: 'unlink'; from: string; to: string }
  | { op: 'delete'; id: string; removeEdges: Edge[] }
  | { op: 'restore'; id: string; reason: string };
type Node = RowDataPacket & NodeFields & { id: string; kind: string; completedOn: string | null; previousNodeId: string | null; nextNodeId: string | null; x: number | null; y: number | null; sourceKey: string | null; sortOrder: number; deletedAt: string | null };
type NodeEvent = { id: string; before: Node | null; after: Node; operations: NodeOperation[]; reason: string };
const nodeFieldKeys = ['title', 'stage', 'targetDate', 'output', 'note'] as const;
const edgeKey = (edge: Edge) => edge.from + ':' + edge.to;

export function validateNodeOps(value: unknown): NodeOperation[] {
  if (!Array.isArray(value) || !value.length) failure('INVALID_NODE_OPERATIONS', 400);
  const added = new Set<string>(), fields: Record<string, string> = {};
  const target = (value: unknown) => validId(value) || uuid(value) && added.has(value);
  const text = (value: unknown, key: string, required: boolean, max = 65535) => {
    if (typeof value !== 'string') failure('INVALID_NODE_OPERATIONS', 400);
    if (required && !value.trim() || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > max) fields[key] = '请填写有效文字';
  };
  const result = value.map((item, index) => {
    if (!object(item)) failure('INVALID_NODE_OPERATIONS', 400);
    const keys = item.op === 'add' ? ['op', 'tempId', 'kind', 'fields'] : item.op === 'correct' ? ['op', 'id', 'changes', 'reason'] : item.op === 'complete' ? ['op', 'id', 'completedOn', ...Object.hasOwn(item, 'reason') ? ['reason'] : []] : item.op === 'uncomplete' ? ['op', 'id', 'reason', 'affectedIds'] : item.op === 'move' ? ['op', 'id', 'x', 'y'] : item.op === 'link' ? ['op', 'from', 'to', 'replaceEdges', 'affectedIds', 'reason'] : item.op === 'unlink' ? ['op', 'from', 'to'] : item.op === 'delete' ? ['op', 'id', 'removeEdges'] : item.op === 'restore' ? ['op', 'id', 'reason'] : [];
    if (!keys.length || keys.length !== Object.keys(item).length || keys.some(key => !Object.hasOwn(item, key))) failure('INVALID_NODE_OPERATIONS', 400);
    if (item.op === 'add') {
      if (!uuid(item.tempId) || added.has(item.tempId) || !['project', 'customer'].includes(item.kind as string)) failure('INVALID_NODE_OPERATIONS', 400);
      added.add(item.tempId);
    } else if ('id' in item ? !target(item.id) : !target(item.from) || !target(item.to)) failure('INVALID_NODE_OPERATIONS', 400);
    if ((item.op === 'delete' || item.op === 'restore') && !validId(item.id)) failure('INVALID_NODE_OPERATIONS', 400);
    const prefix = 'nodeOps.' + index + '.';
    if (Object.hasOwn(item, 'reason')) text(item.reason, prefix + 'reason', item.op === 'uncomplete' || item.op === 'restore');
    if (item.op === 'add' || item.op === 'correct') {
      const data = item.op === 'add' ? item.fields : item.changes;
      if (!object(data) || !Object.keys(data).length || Object.keys(data).some(key => !nodeFieldKeys.includes(key as typeof nodeFieldKeys[number]))) failure('INVALID_NODE_OPERATIONS', 400);
      if (item.op === 'add' && (!Object.hasOwn(data, 'title') || item.kind === 'project' && (!Object.hasOwn(data, 'stage') || !Object.hasOwn(data, 'output')))) failure('INVALID_NODE_OPERATIONS', 400);
      if (item.op === 'add' && item.kind === 'customer' && (Object.hasOwn(data, 'stage') || Object.hasOwn(data, 'output'))) failure('INVALID_NODE_OPERATIONS', 400);
      if (item.op === 'add' && item.kind === 'project' && Object.hasOwn(data, 'note')) failure('INVALID_NODE_OPERATIONS', 400);
      for (const [key, v] of Object.entries(data)) {
        if (key === 'targetDate') { if (v !== null) requireDate(v, prefix + key); }
        else if (key === 'stage') { if (typeof v !== 'string' || !/^S[1-7]$/.test(v)) fields[prefix + key] = '请选择本项目阶段'; }
        else text(v, prefix + key, key === 'title' || key === 'output', key === 'title' ? 1020 : 65535);
        if (key === 'title' && typeof v === 'string' && [...v].length > 255) fields[prefix + key] = '名称最多255个字符';
      }
      item = { ...item, [item.op === 'add' ? 'fields' : 'changes']: Object.fromEntries(nodeFieldKeys.filter(key => Object.hasOwn(data, key)).map(key => [key, data[key]])) };
    }
    if (item.op === 'complete') requireDate(item.completedOn, prefix + 'completedOn');
    if (item.op === 'move') for (const key of ['x', 'y']) if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || Math.abs(item[key] as number) > 999999999.999 || Math.abs(Math.round((item[key] as number) * 1000) / 1000 - (item[key] as number)) > 1e-7) fields[prefix + key] = '位置必须在DECIMAL(12,3)范围内';
    if (Object.hasOwn(item, 'affectedIds') && (!Array.isArray(item.affectedIds) || item.affectedIds.some((id: unknown) => !target(id)) || new Set(item.affectedIds).size !== item.affectedIds.length)) failure('INVALID_NODE_OPERATIONS', 400);
    const edges = item.op === 'link' ? item.replaceEdges : item.op === 'delete' ? item.removeEdges : undefined;
    if (edges !== undefined && (!Array.isArray(edges) || edges.some((edge: unknown) => !object(edge) || Object.keys(edge).length !== 2 || !target(edge.from) || !target(edge.to)) || new Set(edges.map((edge: Edge) => edgeKey(edge))).size !== edges.length)) failure('INVALID_NODE_OPERATIONS', 400);
    return Object.fromEntries(keys.map(key => [key, key === 'affectedIds' ? [...item[key] as string[]].sort() : key === 'replaceEdges' || key === 'removeEdges' ? [...item[key] as Edge[]].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))).map(({ from, to }) => ({ from, to })) : item[key]])) as NodeOperation;
  });
  if (Object.keys(fields).length) failure('INVALID_PROJECT_FIELDS', 422, { fields });
  return result;
}
const nodeColumns = "CAST(n.id AS CHAR) id,n.kind,s.stage_code stage,n.title,DATE_FORMAT(n.target_date,'%Y-%m-%d') targetDate,DATE_FORMAT(n.completed_on,'%Y-%m-%d') completedOn,n.output,n.note,CAST(n.previous_node_id AS CHAR) previousNodeId,CAST(n.next_node_id AS CHAR) nextNodeId,n.x,n.y,n.source_key sourceKey,n.sort_order sortOrder,DATE_FORMAT(n.deleted_at,'%Y-%m-%dT%H:%i:%s.%fZ') deletedAt";
const numericPositions = (rows: Node[]) => rows.map(row => ({ ...row, x: row.x === null ? null : Number(row.x), y: row.y === null ? null : Number(row.y) }));
export async function nodeRows(connection: PoolConnection, id: string, deletedIds: string[] = []): Promise<Node[]> {
  const rows = await query(connection, `SELECT ${nodeColumns} FROM project_nodes n LEFT JOIN project_stages s ON s.id=n.stage_id WHERE n.project_id=? AND (n.deleted_at IS NULL${deletedIds.length ? ' OR n.id IN (' + deletedIds.map(() => '?').join(',') + ')' : ''}) ORDER BY n.sort_order,n.id`, [id, ...deletedIds]) as Node[];
  return numericPositions(rows);
}
export function deletedNodes(database: RuntimeDatabase, id: string, pageSize: number, before?: string, kind?: 'project' | 'customer') {
  return database.readSnapshot(async connection => {
    const projects = await query(connection, 'SELECT CAST(version AS CHAR) version FROM projects WHERE id=?', [id]);
    if (!projects.length) failure('PROJECT_NOT_FOUND', 404);
    const rows = numericPositions(await query(connection, `SELECT ${nodeColumns} FROM project_nodes n LEFT JOIN project_stages s ON s.id=n.stage_id WHERE n.project_id=? AND n.deleted_at IS NOT NULL${kind ? ' AND n.kind=?' : ''}${before ? ' AND n.id<?' : ''} ORDER BY n.id DESC LIMIT ?`, [id, ...kind ? [kind] : [], ...before ? [before] : [], pageSize + 1]) as Node[]);
    const hasMore = rows.length > pageSize; if (hasMore) rows.pop();
    const facts = rows.length ? await query(connection, `SELECT CAST(a.id AS CHAR) id,CAST(a.entity_id AS CHAR) nodeId,a.actor_display_name actorName,DATE_FORMAT(a.created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt,a.before_json beforeValues,a.after_json afterValues FROM (SELECT MAX(id) id FROM audit_log WHERE entity_type='project_node' AND entity_id IN (${rows.map(() => '?').join(',')}) AND JSON_TYPE(JSON_EXTRACT(after_json,'$.node.deletedAt'))='STRING' GROUP BY entity_id) targets JOIN audit_log a ON a.id=targets.id`, rows.map(row => row.id)) : [];
    const byId = new Map(facts.map(fact => [fact.nodeId, fact]));
    return { projectVersion: projects[0].version, items: rows.map(row => { const fact = byId.get(row.id); return { ...row, deletion: fact ? { auditId: fact.id, actorName: fact.actorName, createdAt: fact.createdAt, beforeNode: fact.beforeValues.node, operations: fact.afterValues.operations, reason: fact.afterValues.reason } : null }; }), nextCursor: hasMore ? rows.at(-1)!.id : null, pageSize };
  });
}
export async function nodeCandidate(connection: PoolConnection, id: string, operations: NodeOperation[], timestamp: string, preview = false) {
  const deletedIds = [...new Set(operations.flatMap(op => op.op === 'delete' || op.op === 'restore' ? [op.id] : []))];
  const original = await nodeRows(connection, id, deletedIds), candidates = structuredClone(original), rows = new Map(candidates.map(row => [row.id, row])), before = new Map(original.map(row => [row.id, row]));
  const graphIds = new Set<string>(), supplied = new Set<string>(), reasons = new Map<string, string>(), touched = new Map<string, NodeOperation[]>();
  let order = original.reduce((max, row) => Math.max(max, row.sortOrder + 1), 0);
  const touch = (target: string, operation: NodeOperation) => { touched.set(target, [...touched.get(target) ?? [], operation]); if ('reason' in operation && operation.reason) reasons.set(target, operation.reason); };
  const target = (key: string) => { const row = rows.get(key); if (!row || row.deletedAt) failure('NODE_NOT_FOUND', 404); return row; };
  const unlink = (edge: Edge, operation: NodeOperation) => { const a = target(edge.from), b = target(edge.to); if (a.nextNodeId === b.id) { a.nextNodeId = null; touch(a.id, operation); } if (b.previousNodeId === a.id) { b.previousNodeId = null; touch(b.id, operation); } graphIds.add(a.id); graphIds.add(b.id); };
  for (const operation of operations) {
    if (operation.op === 'restore') {
      const row = rows.get(operation.id); if (!row) failure('NODE_NOT_FOUND', 404); if (!row.deletedAt) failure('NODE_NOT_DELETED', 422);
      row.deletedAt = null; row.previousNodeId = null; row.nextNodeId = null; touch(row.id, operation); graphIds.add(row.id); continue;
    }
    if (operation.op === 'delete') {
      const row = rows.get(operation.id); if (!row) failure('NODE_NOT_FOUND', 404); if (row.deletedAt) failure('NODE_ALREADY_DELETED', 422);
      const edges = new Map<string, Edge>();
      const edge = (from: string | null, to: string | null) => { if (from && to) edges.set(edgeKey({ from, to }), { from, to }); };
      edge(row.previousNodeId, row.id); edge(row.id, row.nextNodeId);
      for (const neighbor of candidates.filter(node => !node.deletedAt && node.id !== row.id)) { if (neighbor.nextNodeId === row.id) edge(neighbor.id, row.id); if (neighbor.previousNodeId === row.id) edge(row.id, neighbor.id); }
      if (JSON.stringify([...edges.keys()].sort()) !== JSON.stringify(operation.removeEdges.map(edgeKey).sort())) failure('NODE_DELETE_LINKS_CHANGED', 422, { fields: { nodeOps: '需要明确确认将解除的全部旧线：' + [...edges.keys()].sort().join('、') } });
      for (const neighbor of candidates.filter(node => !node.deletedAt && node.id !== row.id)) { if (neighbor.nextNodeId === row.id) { neighbor.nextNodeId = null; touch(neighbor.id, operation); graphIds.add(neighbor.id); } if (neighbor.previousNodeId === row.id) { neighbor.previousNodeId = null; touch(neighbor.id, operation); graphIds.add(neighbor.id); } }
      row.previousNodeId = null; row.nextNodeId = null; row.deletedAt = timestamp; touch(row.id, operation); graphIds.add(row.id); continue;
    }
    if (operation.op === 'add') {
      if (order > 4294967295) failure('NODE_ORDER_EXHAUSTED', 422);
      const row = { id: operation.tempId, kind: operation.kind, stage: null, targetDate: null, output: '', note: '', ...operation.fields, completedOn: null, previousNodeId: null, nextNodeId: null, x: null, y: null, sourceKey: null, sortOrder: order++, deletedAt: null } as Node;
      candidates.push(row); rows.set(row.id, row); touch(row.id, operation); continue;
    }
    if (operation.op === 'link' || operation.op === 'unlink') {
      const a = target(operation.from), b = target(operation.to);
      if (a.kind !== 'project' || b.kind !== 'project' || a.id === b.id) failure('NODE_RELATION_INVALID', 422);
      if (operation.op === 'unlink') { if (a.nextNodeId !== b.id && b.previousNodeId !== a.id) failure('NODE_LINK_NOT_FOUND', 422); unlink(operation, operation); continue; }
      const old = new Map<string, Edge>();
      if (a.nextNodeId && a.nextNodeId !== b.id) { const edge = { from: a.id, to: a.nextNodeId }; old.set(edgeKey(edge), edge); }
      if (b.previousNodeId && b.previousNodeId !== a.id) { const edge = { from: b.previousNodeId, to: b.id }; old.set(edgeKey(edge), edge); }
      if (JSON.stringify([...old.keys()].sort()) !== JSON.stringify(operation.replaceEdges.map(edgeKey).sort())) failure('NODE_REPLACEMENT_CHANGED', 422, { fields: { nodeOps: '需要明确确认被替换的旧连线：' + [...old.keys()].join('、') } });
      for (const edge of old.values()) unlink(edge, operation);
      a.nextNodeId = b.id; b.previousNodeId = a.id; touch(a.id, operation); touch(b.id, operation); graphIds.add(a.id); graphIds.add(b.id);
      operation.affectedIds.forEach(key => { target(key); supplied.add(key); reasons.set(key, operation.reason); }); continue;
    }
    const row = target(operation.id); touch(row.id, operation);
    if (operation.op === 'correct') {
      const previous = target(operation.id);
      if (['stage', 'targetDate'].some(key => Object.hasOwn(operation.changes, key) && operation.changes[key as keyof NodeFields] !== previous[key as keyof NodeFields]) && !operation.reason.trim()) failure('NODE_CORRECTION_REASON_REQUIRED', 422);
      if (row.kind === 'customer' && (Object.hasOwn(operation.changes, 'stage') || Object.hasOwn(operation.changes, 'output')) || row.kind === 'project' && Object.hasOwn(operation.changes, 'note')) failure('INVALID_NODE_OPERATIONS', 400);
      Object.assign(row, operation.changes);
    } else if (operation.op === 'move') {
      if (row.kind !== 'project') failure('NODE_RELATION_INVALID', 422);
      row.x = operation.x; row.y = operation.y;
    } else if (operation.op === 'complete') {
      if (operation.completedOn > businessToday(new Date(timestamp))) failure('INVALID_PROJECT_FIELDS', 422, { fields: { nodeOps: '节点实际完成日不能在未来' } });
      if (row.completedOn && row.completedOn !== operation.completedOn && !operation.reason?.trim()) failure('NODE_CORRECTION_REASON_REQUIRED', 422);
      row.completedOn = operation.completedOn; graphIds.add(row.id);
    } else {
      if (!row.completedOn) failure('NODE_NOT_COMPLETED', 422);
      row.completedOn = null; graphIds.add(row.id);
      operation.affectedIds.forEach(key => { target(key); supplied.add(key); reasons.set(key, operation.reason); });
    }
  }
  const stages = new Map((await query(connection, 'SELECT stage_code code,CAST(id AS CHAR) id FROM project_stages WHERE project_id=?', [id])).map(row => [row.code, row.id]));
  for (const row of candidates.filter(row => !row.deletedAt)) {
    if (touched.get(row.id)?.some(op => op.op === 'add' || op.op === 'restore' || op.op === 'correct' && Object.hasOwn(op.changes, 'stage')) && row.kind === 'project' && !stages.has(row.stage)) failure('NODE_STAGE_INVALID', 422);
    if (touched.get(row.id)?.some(op => op.op === 'restore') && row.completedOn && row.completedOn > businessToday(new Date(timestamp))) failure('INVALID_PROJECT_FIELDS', 422, { fields: { nodeOps: '恢复节点的实际完成日不能在未来，请同次明确纠正' } });
  }
  // 只检查本次完成/关系涉及的组件；移动和无关文字不被旧异常阻断。
  const scope = new Set<string>(), queue = [...graphIds];
  for (const key of queue) {
    if (scope.has(key)) continue; scope.add(key);
    for (const row of [rows.get(key), before.get(key)]) if (row && !row.deletedAt) for (const neighbor of [row.previousNodeId, row.nextNodeId]) if (neighbor && rows.has(neighbor) && !rows.get(neighbor)!.deletedAt && !scope.has(neighbor)) queue.push(neighbor);
  }
  const checked = new Set<string>();
  for (const key of scope) {
    if (rows.get(key)?.deletedAt) continue;
    const row = target(key);
    if (row.previousNodeId && target(row.previousNodeId).nextNodeId !== key || row.nextNodeId && target(row.nextNodeId).previousNodeId !== key) failure('NODE_RELATION_INVALID', 422);
    const path: string[] = [], visited = new Set<string>(); let current: string | null = key;
    while (current && !checked.has(current)) { if (visited.has(current)) failure('NODE_CYCLE', 422, { fields: { nodeOps: '循环：' + [...path.slice(path.indexOf(current)), current].join(' → ') } }); visited.add(current); path.push(current); current = target(current).nextNodeId; }
    path.forEach(key => checked.add(key));
  }
  const expected = new Set<string>(), hypothetical = new Map(candidates.map(row => [row.id, row.completedOn]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of scope) {
      if (rows.get(key)?.deletedAt) continue;
      const row = target(key);
      if (hypothetical.get(key) && row.previousNodeId && !hypothetical.get(row.previousNodeId)) {
        if (!before.get(key)?.completedOn) failure('NODE_PREDECESSOR_INCOMPLETE', 422, { fields: { nodeOps: '前置节点尚未完成：' + row.previousNodeId + ' → ' + key } });
        hypothetical.set(key, null); expected.add(key); changed = true;
      }
    }
  }
  const requiredUncompleteIds = [...expected].sort(), confirmed = JSON.stringify(requiredUncompleteIds) === JSON.stringify([...supplied].sort());
  if (!confirmed && !preview) failure('NODE_IMPACT_CHANGED', 422, { fields: { nodeOps: '请重新预览并明确确认这些完成日一并清空：' + requiredUncompleteIds.join('、') } });
  if (confirmed) for (const key of supplied) { if (!reasons.get(key)?.trim()) failure('NODE_CORRECTION_REASON_REQUIRED', 422); target(key).completedOn = null; touched.set(key, operations.filter(op => 'affectedIds' in op && op.affectedIds.includes(key))); }
  const events = candidates.filter(row => touched.has(row.id) && JSON.stringify(before.get(row.id) ?? null) !== JSON.stringify(row)).map(row => ({ id: row.id, before: before.get(row.id) ?? null, after: row, operations: touched.get(row.id)!, reason: reasons.get(row.id) ?? '' })) as NodeEvent[];
  return { rows: candidates.filter(row => !row.deletedAt), events, requiredUncompleteIds, confirmed, stages };
}
export async function writeNodes(connection: PoolConnection, id: string, candidate: Awaited<ReturnType<typeof nodeCandidate>>, actor: Actor, versionBefore: string, versionAfter: string, requestId: string, timestamp: string) {
  const idMap: Record<string, string> = {};
  // 全部新对象先取得稳定ID，之后清旧FK/设置双方，临时端点无需伪造数据库ID。
  for (const event of candidate.events.filter(event => !event.before)) {
    const row = event.after;
    await connection.execute('INSERT INTO project_nodes (project_id,kind,stage_id,title,target_date,completed_on,output,note,x,y,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [id, row.kind, row.stage ? candidate.stages.get(row.stage) : null, row.title, row.targetDate, row.completedOn, row.output, row.note, row.x, row.y, row.sortOrder]);
    idMap[row.id] = (await query(connection, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
  }
  const stable = (key: string | null) => key ? idMap[key] ?? key : null;
  for (const event of candidate.events) if (event.before && (event.before.previousNodeId !== event.after.previousNodeId || event.before.nextNodeId !== event.after.nextNodeId)) await connection.execute('UPDATE project_nodes SET previous_node_id=NULL,next_node_id=NULL WHERE project_id=? AND id=?', [id, event.id]);
  for (const event of candidate.events) {
    const row = event.after;
    await connection.execute('UPDATE project_nodes SET stage_id=?,title=?,target_date=?,completed_on=?,output=?,note=?,previous_node_id=?,next_node_id=?,x=?,y=?,deleted_at=? WHERE project_id=? AND id=?', [row.stage ? candidate.stages.get(row.stage) : null, row.title, row.targetDate, row.completedOn, row.output, row.note, stable(row.previousNodeId), stable(row.nextNodeId), row.x, row.y, row.deletedAt?.slice(0, 23).replace('T', ' ') ?? null, id, stable(row.id)]);
    const projectNode = (node: Node | null) => node ? { ...node, id: stable(node.id), previousNodeId: stable(node.previousNodeId), nextNodeId: stable(node.nextNodeId) } : null;
    await connection.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
      VALUES (?,?,'user',?,'project_node',?,?,?,?,?,?,?,?)`, [actor.id, actor.name, event.before ? 'project.node.save' : 'project.node.add', stable(row.id), id, versionBefore, versionAfter, JSON.stringify({ node: projectNode(event.before) }), JSON.stringify({ node: projectNode(row), reason: event.reason, operations: event.operations }), requestId, timestamp]);
  }
  return { nodeIdMap: idMap, nodes: await nodeRows(connection, id) };
}
