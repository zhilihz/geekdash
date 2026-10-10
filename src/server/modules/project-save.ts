import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { validateRiskOps, riskCandidate, writeRisks, validateNodeOps, nodeCandidate, writeNodes, type NodeOperation, type RiskOperation } from './project-records.js';

export const textColumns = { name: 'name', marketExpectation: 'market_expectation', detailNote: 'detail_note', summaryNote: 'summary_note' } as const;
const columns = { ...textColumns, signalNote: 'signal_note', chipstatNote: 'chipstat_note', statusDesc: 'status_description', signal: 'signal', priority: 'priority', customerId: 'customer_id', odmCustomerId: 'odm_customer_id', productLineId: 'product_line_id', appId: 'app_id', groupId: 'group_id' } as const;
const referenceFields = { customerId: 'customers', odmCustomerId: 'customers', productLineId: 'product_lines', appId: 'apps', groupId: 'project_groups', chipIds: 'chips', tagIds: 'tags', people: 'engineers' } as const;
const collections = ['chipIds', 'tagIds', 'people'] as const;
const roles = ['pm', 'hardware_owner', 'software_owner', 'participant'];
type Person = { id: string; role: string };
type StagePlan = { code: string; plannedDays?: number | null; note?: string };
export type TextValues = Record<keyof typeof textColumns, string>;
type Values = TextValues & { signalNote: string; chipstatNote: string; statusDesc: string; signal: string; priority: string; customerId: string | null; odmCustomerId: string | null; productLineId: string | null; appId: string | null; groupId: string | null; chipIds: string[]; tagIds: string[]; people: Person[]; stagePlans?: StagePlan[]; riskOps?: RiskOperation[]; nodeOps?: NodeOperation[] };
type Field = keyof Values;
const keys = [...Object.keys(columns), ...collections, 'stagePlans', 'riskOps', 'nodeOps'] as Field[];
export type SaveRequest = { expectedVersion: string; idempotencyKey: string; changes: Partial<Values> };
export type SaveResult = { projectId: string; operationId: string; changed: boolean; savedVersion: string; values: TextValues | Values; savedAt: string | null; display?: Record<string, unknown>; riskIdMap?: Record<string, string>; risks?: Awaited<ReturnType<typeof riskCandidate>>['rows']; nodeIdMap?: Record<string, string>; nodes?: Awaited<ReturnType<typeof nodeCandidate>>['rows'] };

export function failure(code: string, status: number, extra: Record<string, unknown> = {}): never {
  throw Object.assign(new Error(code), { code, status, ...extra });
}
export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validateSave(value: unknown): SaveRequest {
  if (!object(value) || Object.keys(value).length !== 3 || !validId(value.expectedVersion) || typeof value.idempotencyKey !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.idempotencyKey)
    || !object(value.changes) || !Object.keys(value.changes).length) failure('INVALID_SAVE_REQUEST', 400);
  const fields: Record<string, string> = {};
  for (const [key, text] of Object.entries(value.changes)) {
    if (!keys.includes(key as Field)) failure('INVALID_SAVE_REQUEST', 400);
    if (key === 'nodeOps') { validateNodeOps(text); continue; }
    if (key === 'riskOps') { validateRiskOps(text); continue; }
    if (key === 'stagePlans') {
      if (!Array.isArray(text) || !text.length || text.length > 7) failure('INVALID_SAVE_REQUEST', 400);
      for (const item of text) {
        if (!object(item) || typeof item.code !== 'string' || !/^S[1-7]$/.test(item.code) || Object.keys(item).length < 2 || Object.keys(item).some(key => !['code', 'plannedDays', 'note'].includes(key))) failure('INVALID_SAVE_REQUEST', 400);
        if (Object.hasOwn(item, 'plannedDays') && item.plannedDays !== null && (!Number.isInteger(item.plannedDays) || (item.plannedDays as number) < 0 || (item.plannedDays as number) > 65535)) fields.stagePlans = '工期须为空或0～65535的整数天';
        if (Object.hasOwn(item, 'note') && (typeof item.note !== 'string' || !item.note.isWellFormed() || Buffer.byteLength(item.note, 'utf8') > 65535)) fields.stagePlans = '阶段评述须为有效文字，最多65535字节';
      }
      if (new Set(text.map(item => item.code)).size !== text.length) failure('INVALID_SAVE_REQUEST', 400);
      continue;
    }
    if (Object.hasOwn(referenceFields, key)) {
      if (collections.includes(key as typeof collections[number])) {
        if (!Array.isArray(text)) failure('INVALID_SAVE_REQUEST', 400);
        const identities: string[] = [];
        for (const item of text) {
          if (key === 'people') {
            if (!object(item) || Object.keys(item).length !== 2 || !validId(item.id) || typeof item.role !== 'string' || !roles.includes(item.role)) failure('INVALID_SAVE_REQUEST', 400);
            identities.push(item.id + ':' + item.role);
          } else { if (!validId(item)) failure('INVALID_SAVE_REQUEST', 400); identities.push(item); }
        }
        if (new Set(identities).size !== identities.length) fields[key] = '同一关联不能重复选择';
      } else if (text !== null && !validId(text)) failure('INVALID_SAVE_REQUEST', 400);
      continue;
    }
    if (typeof text !== 'string') failure('INVALID_SAVE_REQUEST', 400);
    if (key === 'signal' || key === 'priority') {
      if (!(key === 'signal' ? ['green', 'yellow', 'red'] : ['high', 'mid', 'low']).includes(text)) fields[key] = '请选择有效选项';
      continue;
    }
    // utf8mb4 不支持孤立代理码；禁止传输/数据库替换原输入。
    if (!text.isWellFormed()) fields[key] = '包含无效 Unicode 字符';
    else if (key === 'name' && (!text.trim() || [...text].length > 255 || /[\r\n]/.test(text))) fields[key] = '项目名称应为 1～255 个字符，不能仅含空白或换行';
    else if (key !== 'name' && Buffer.byteLength(text, 'utf8') > 65535) fields[key] = '说明超过 65535 字节，请缩短后保存';
  }
  if (Object.keys(fields).length) failure('INVALID_PROJECT_FIELDS', 422, { fields });
  const request = value as SaveRequest;
  return { ...request, changes: { ...request.changes, ...(request.changes.nodeOps ? { nodeOps: validateNodeOps(request.changes.nodeOps) } : {}), ...(request.changes.riskOps ? { riskOps: validateRiskOps(request.changes.riskOps) } : {}), ...(request.changes.people ? { people: request.changes.people.map(({ id, role }) => ({ id, role })) } : {}), ...(request.changes.stagePlans ? { stagePlans: [...request.changes.stagePlans].sort((a, b) => a.code.localeCompare(b.code)).map(item => ({ code: item.code, ...Object.hasOwn(item, 'plannedDays') ? { plannedDays: item.plannedDays } : {}, ...Object.hasOwn(item, 'note') ? { note: item.note } : {} })) } : {}) } };
}
async function query(connection: PoolConnection, sql: string, values: unknown[] = []) {
  return (await connection.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0];
}
function requestHash(id: string, request: SaveRequest) {
  const changes = Object.fromEntries(keys.filter(key => Object.hasOwn(request.changes, key)).map(key => [key, key === 'people' ? request.changes.people!.map(person => ({ id: person.id, role: person.role })) : request.changes[key]]));
  return createHash('sha256').update(JSON.stringify([id, mode(request), request.expectedVersion, changes])).digest();
}
const mode = (request: SaveRequest) => Object.keys(request.changes).every(key => Object.hasOwn(textColumns, key)) ? 'text' : 'ordinary';
const scope = (id: string, request: SaveRequest, actor?: Actor) => `${actor ? 'user:' + actor.id : 'anonymous'}:project:${id}:${mode(request)}`;
function receiptResult(receipt: RowDataPacket, hash: Buffer): SaveResult {
  if (!Buffer.isBuffer(receipt.request_hash) || !receipt.request_hash.equals(hash)) failure('OPERATION_KEY_REUSED', 409);
  return typeof receipt.response_json === 'string' ? JSON.parse(receipt.response_json) : receipt.response_json;
}
async function project(connection: PoolConnection, id: string, locked: boolean, authenticated = false) {
  const row = (await query(connection, `SELECT CAST(id AS CHAR) id,CAST(version AS CHAR) version,data_kind,
    ${Object.entries(columns).map(([key, column]) => `${column.endsWith('_id') ? `CAST(\`${column}\` AS CHAR)` : `\`${column}\``} \`${key}\``).join(',')} FROM projects WHERE id=?${locked ? ' FOR UPDATE' : ''}`, [id]))[0];
  if (!row) failure('PROJECT_NOT_FOUND', 404);
  if (!authenticated && row.data_kind !== 'trial') failure('PROJECT_READ_ONLY', 403);
  return row;
}
async function linkedValues(connection: PoolConnection, id: string) {
  const chipIds = (await query(connection, 'SELECT CAST(chip_id AS CHAR) id FROM project_chips WHERE project_id=? ORDER BY sort_order,chip_id', [id])).map(row => row.id);
  const tagIds = (await query(connection, 'SELECT CAST(tag_id AS CHAR) id FROM project_tags WHERE project_id=? ORDER BY sort_order,tag_id', [id])).map(row => row.id);
  const people = (await query(connection, 'SELECT CAST(engineer_id AS CHAR) id,role FROM project_people WHERE project_id=? ORDER BY sort_order,engineer_id,role', [id])).map(row => ({ id: row.id, role: row.role }));
  return { chipIds, tagIds, people };
}
function idsOf(key: string, value: unknown): string[] {
  return key === 'people' ? (value as Person[]).map(person => person.id) : Array.isArray(value) ? value : value === null ? [] : [value as string];
}
async function lockReferences(connection: PoolConnection, changes: SaveRequest['changes']) {
  const ids: Record<string, Set<string>> = {};
  for (const [key, table] of Object.entries(referenceFields)) if (Object.hasOwn(changes, key)) {
    ids[table] ??= new Set(); idsOf(key, changes[key as Field]).forEach(id => ids[table].add(id));
  }
  const locked: Record<string, RowDataPacket[]> = {};
  for (const table of Object.keys(ids).sort()) {
    locked[table] = [];
    for (const id of [...ids[table]].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)) locked[table].push(...await query(connection, `SELECT CAST(id AS CHAR) id,name,enabled FROM ${table} WHERE id=? FOR SHARE`, [id]));
  }
  return locked;
}
async function displayValues(connection: PoolConnection, values: Values) {
  const display: Record<string, unknown> = { ...values };
  for (const [key, table] of Object.entries(referenceFields)) {
    const value = values[key as Field];
    const ids = idsOf(key, value);
    if (!ids.length) continue;
    const rows = await query(connection, `SELECT CAST(id AS CHAR) id,name FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const named = (id: string) => ({ id, name: rows.find(row => row.id === id)?.name ?? id });
    display[key] = key === 'people' ? (value as Person[]).map(person => ({ ...named(person.id), role: person.role })) : Array.isArray(value) ? ids.map(named) : named(ids[0]);
  }
  return display;
}
export function projectSaves(database: RuntimeDatabase) {
  return {
    preview(id: string, request: SaveRequest, actor: Actor) {
      return database.readSnapshot(async connection => {
        await assertActor(connection, actor, false, new Date(), false, false);
        const current = await project(connection, id, false, true);
        if (!(await query(connection, 'SELECT user_id FROM project_responsibilities WHERE project_id=? AND user_id=?', [id, actor.id])).length) failure('PROJECT_READ_ONLY', 403);
        if (current.version !== request.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: current.version });
        if (!request.changes.riskOps && !request.changes.nodeOps) failure('INVALID_SAVE_REQUEST', 400);
        const timestamp = new Date().toISOString();
        const risk = request.changes.riskOps ? await riskCandidate(connection, id, request.changes.riskOps, actor, timestamp) : undefined;
        const node = request.changes.nodeOps ? await nodeCandidate(connection, id, request.changes.nodeOps, timestamp, true) : undefined;
        return { projectId: id, expectedVersion: current.version, ...(risk ? { events: risk.events, risks: risk.rows } : {}), ...(node ? { nodeEvents: node.events, nodes: node.rows, requiredUncompleteIds: node.requiredUncompleteIds, confirmed: node.confirmed } : {}) };
      });
    },
    options() {
      return database.readSnapshot(async connection => {
        const result: Record<string, RowDataPacket[]> = {};
        for (const table of [...new Set(Object.values(referenceFields))].sort()) result[table] = await query(connection, `SELECT CAST(id AS CHAR) id,name,enabled${table === 'chips' ? ',original_model originalModel,manufacturer,firmware_version firmwareVersion' : ''} FROM ${table} ORDER BY name,id`);
        return result;
      });
    },
    save(id: string, request: SaveRequest, requestId: string, actor?: Actor) {
      const hash = requestHash(id, request);
      return database.writeTransaction(async connection => {
        if (actor) await assertActor(connection, actor);
        const extended = mode(request) === 'ordinary';
        // 资料锁在项目锁之前；取得锁后才检查原回执和新增引用资格。
        const locked = extended ? await lockReferences(connection, request.changes) : {};
        const current = await project(connection, id, true, !!actor);
        // 当前锁定读在版本判断前，等待前一次提交后可读到真实回执。
        const receipt = (await query(connection, 'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=? FOR UPDATE', [scope(id, request, actor), request.idempotencyKey]))[0];
        if (receipt) return receiptResult(receipt, hash);
        if (actor && !(await query(connection, 'SELECT user_id FROM project_responsibilities WHERE project_id=? AND user_id=?', [id, actor.id])).length) failure('PROJECT_READ_ONLY', 403);
        if (current.version !== request.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: current.version });
        if ((request.changes.riskOps || request.changes.nodeOps) && !actor) failure('AUTH_REQUIRED', 401);
        const savedAt = new Date().toISOString();
        const risk = request.changes.riskOps ? await riskCandidate(connection, id, request.changes.riskOps, actor!, savedAt) : undefined;
        const node = request.changes.nodeOps ? await nodeCandidate(connection, id, request.changes.nodeOps, savedAt) : undefined;
        if (extended) Object.assign(current, await linkedValues(connection, id));
        let effective = request.changes;
        if (request.changes.stagePlans) {
          current.stagePlans = await query(connection, 'SELECT stage_code code,planned_days plannedDays,note FROM project_stages WHERE project_id=? ORDER BY stage_code', [id]);
          if (current.stagePlans.length !== 7) failure('STAGE_SEQUENCE_REVIEW_REQUIRED', 422);
          effective = { ...request.changes, stagePlans: current.stagePlans.map((item: StagePlan) => ({ ...item, ...request.changes.stagePlans!.find(change => change.code === item.code) })) };
        }
        const errors: Record<string, string> = {};
        for (const [key, table] of Object.entries(referenceFields)) if (Object.hasOwn(request.changes, key)) {
          const previous = new Set(key === 'people' ? (current.people as Person[]).map(person => person.id + ':' + person.role) : idsOf(key, current[key]));
          for (const target of idsOf(key, request.changes[key as Field])) {
            const row = locked[table]?.find(row => row.id === target);
            const retained = key === 'people' ? request.changes.people!.filter(person => person.id === target).every(person => previous.has(person.id + ':' + person.role)) : previous.has(target);
            if (!row || !row.enabled && !retained) errors[key] = `资料 ${target} 不存在或已停用，请重新选择`;
          }
        }
        if (Object.keys(errors).length) failure('INVALID_PROJECT_FIELDS', 422, { fields: errors });
        const fields = keys.filter(key => key !== 'riskOps' && key !== 'nodeOps' && Object.hasOwn(effective, key) && JSON.stringify(effective[key]) !== JSON.stringify(current[key]));
        const changed = fields.length > 0 || !!risk?.events.length || !!node?.events.length;
        if (changed && current.version === '18446744073709551615') failure('PROJECT_VERSION_EXHAUSTED', 422);
        const values = Object.fromEntries((extended ? keys : Object.keys(textColumns) as Field[]).filter(key => key !== 'riskOps' && key !== 'nodeOps' && (key !== 'stagePlans' || request.changes.stagePlans)).map(key => [key, Object.hasOwn(effective, key) ? effective[key] : current[key]])) as Values;
        const result: SaveResult = { projectId: id, operationId: request.idempotencyKey, changed,
          savedVersion: changed ? String(BigInt(current.version) + 1n) : current.version, values, savedAt: changed ? savedAt : null };
        if (changed) {
          const plain = fields.filter(key => Object.hasOwn(columns, key)) as (keyof typeof columns)[];
          const timestamp = result.savedAt!.slice(0, 23).replace('T', ' ');
          const [updated] = await connection.execute<ResultSetHeader>(`UPDATE projects SET ${plain.map(key => `\`${columns[key]}\`=?,`).join('')}${fields.includes('statusDesc') ? 'status_description_updated_at=?,' : ''}version=version+1,updated_at=? WHERE id=? AND version=?`, [...plain.map(key => values[key]), ...(fields.includes('statusDesc') ? [timestamp] : []), timestamp, id, current.version]);
          if (updated.affectedRows !== 1) failure('PROJECT_VERSION_CONFLICT', 409);
          if (fields.includes('stagePlans')) for (const plan of values.stagePlans!) {
            if (JSON.stringify(plan) !== JSON.stringify(current.stagePlans.find((item: StagePlan) => item.code === plan.code))) await connection.execute('UPDATE project_stages SET planned_days=?,note=? WHERE project_id=? AND stage_code=?', [plan.plannedDays ?? null, plan.note ?? '', id, plan.code]);
          }
          for (const key of collections) if (fields.includes(key)) {
            const table = key === 'chipIds' ? 'project_chips' : key === 'tagIds' ? 'project_tags' : 'project_people';
            await connection.execute(`DELETE FROM ${table} WHERE project_id=?`, [id]);
            for (const [order, item] of (values[key] as (string | Person)[]).entries()) {
              if (key === 'people') await connection.execute('INSERT INTO project_people (project_id,engineer_id,role,sort_order) VALUES (?,?,?,?)', [id, (item as Person).id, (item as Person).role, order]);
              else await connection.execute(`INSERT INTO ${table} (project_id,${key === 'chipIds' ? 'chip_id' : 'tag_id'},sort_order) VALUES (?,?,?)`, [id, item, order]);
            }
          }
          if (risk) Object.assign(result, await writeRisks(connection, id, risk, actor!, current.version, result.savedVersion, requestId, timestamp));
          if (node) Object.assign(result, await writeNodes(connection, id, node, actor!, current.version, result.savedVersion, requestId, timestamp));
          const beforeDisplay = extended ? await displayValues(connection, current as Values) : current;
          const afterDisplay = extended ? await displayValues(connection, values) : values;
          if (extended) result.display = afterDisplay;
          const before = Object.fromEntries(fields.map(key => [key, beforeDisplay[key]]));
          const after = Object.fromEntries(fields.map(key => [key, afterDisplay[key]]));
          if (fields.length) await connection.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
            VALUES (?,?,?,?,'project',?,?,?,?,?,?,?,?)`, [actor?.id ?? null, actor?.name ?? '未认证操作', actor ? 'user' : 'anonymous', extended ? 'project.ordinary.save' : 'project.text.save', id, id, current.version, result.savedVersion, JSON.stringify(before), JSON.stringify(after), requestId, timestamp]);
        }
        if (risk && !changed) Object.assign(result, { risks: risk.rows, riskIdMap: {} });
        if (node && !changed) Object.assign(result, { nodes: node.rows, nodeIdMap: {} });
        await connection.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP(3))', [actor?.id ?? null, scope(id, request, actor), request.idempotencyKey, hash, 200, JSON.stringify(result)]);
        return result;
      });
    },
    confirm(id: string, request: SaveRequest, actor?: Actor) {
      return database.readSnapshot(async connection => {
        const current = await project(connection, id, false, !!actor);
        let receipt = (await query(connection, 'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?', [scope(id, request, actor), request.idempotencyKey]))[0];
        // 旧 trial 匿名提交仅可对账，不把旧请求重放成新的实名写入。
        if (!receipt && actor && current.data_kind === 'trial') receipt = (await query(connection, 'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=? AND actor_id IS NULL', [scope(id, request), request.idempotencyKey]))[0];
        return receipt ? { outcome: 'committed', result: receiptResult(receipt, requestHash(id, request)) } : { outcome: 'not_found' };
      });
    },
    audit(id: string, pageSize: number, before?: string) {
      return database.readSnapshot(async connection => {
        if (!(await query(connection, 'SELECT id FROM projects WHERE id=?', [id])).length) failure('PROJECT_NOT_FOUND', 404);
        const items = await query(connection, `SELECT CAST(id AS CHAR) id,actor_display_name actorDisplayName,actor_kind actorKind,action,
          CAST(version_before AS CHAR) versionBefore,CAST(version_after AS CHAR) versionAfter,before_json beforeValues,after_json afterValues,
          DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt FROM audit_log WHERE project_id=?${before ? ' AND id<?' : ''} ORDER BY audit_log.id DESC LIMIT ?`, [id, ...(before ? [before] : []), pageSize + 1]);
        const hasMore = items.length > pageSize;
        if (hasMore) items.pop();
        return { items, nextCursor: hasMore ? items.at(-1)!.id : null, pageSize };
      });
    },
  };
}
