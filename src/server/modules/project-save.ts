import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';

export const textColumns = { name: 'name', marketExpectation: 'market_expectation', detailNote: 'detail_note', summaryNote: 'summary_note' } as const;
type Field = keyof typeof textColumns;
export type TextValues = Record<Field, string>;
export type SaveRequest = { expectedVersion: string; idempotencyKey: string; changes: Partial<TextValues> };
export type SaveResult = { projectId: string; operationId: string; changed: boolean; savedVersion: string; values: TextValues; savedAt: string | null };

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
    if (!Object.hasOwn(textColumns, key) || typeof text !== 'string') failure('INVALID_SAVE_REQUEST', 400);
    // utf8mb4 不支持孤立代理码；禁止传输/数据库替换原输入。
    if (!text.isWellFormed()) fields[key] = '包含无效 Unicode 字符';
    else if (key === 'name' && (!text.trim() || [...text].length > 255 || /[\r\n]/.test(text))) fields[key] = '项目名称应为 1～255 个字符，不能仅含空白或换行';
    else if (key !== 'name' && Buffer.byteLength(text, 'utf8') > 65535) fields[key] = '说明超过 65535 字节，请缩短后保存';
  }
  if (Object.keys(fields).length) failure('INVALID_PROJECT_FIELDS', 422, { fields });
  return value as SaveRequest;
}
async function query(connection: PoolConnection, sql: string, values: unknown[] = []) {
  return (await connection.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0];
}
function requestHash(id: string, request: SaveRequest) {
  const changes = Object.fromEntries(Object.keys(textColumns).filter(key => Object.hasOwn(request.changes, key)).map(key => [key, request.changes[key as Field]]));
  return createHash('sha256').update(JSON.stringify([id, 'text', request.expectedVersion, changes])).digest();
}
const scope = (id: string) => `anonymous:project:${id}:text`;
function receiptResult(receipt: RowDataPacket, hash: Buffer): SaveResult {
  if (!Buffer.isBuffer(receipt.request_hash) || !receipt.request_hash.equals(hash)) failure('OPERATION_KEY_REUSED', 409);
  return typeof receipt.response_json === 'string' ? JSON.parse(receipt.response_json) : receipt.response_json;
}
async function project(connection: PoolConnection, id: string, locked: boolean) {
  const row = (await query(connection, `SELECT CAST(id AS CHAR) id,CAST(version AS CHAR) version,data_kind,
    name,market_expectation marketExpectation,detail_note detailNote,summary_note summaryNote FROM projects WHERE id=?${locked ? ' FOR UPDATE' : ''}`, [id]))[0];
  if (!row) failure('PROJECT_NOT_FOUND', 404);
  if (row.data_kind !== 'trial') failure('PROJECT_READ_ONLY', 403);
  return row;
}
export function projectSaves(database: RuntimeDatabase) {
  return {
    save(id: string, request: SaveRequest, requestId: string) {
      const hash = requestHash(id, request);
      return database.writeTransaction(async connection => {
        const current = await project(connection, id, true);
        // 当前锁定读在版本判断前，等待前一次提交后可读到真实回执。
        const receipt = (await query(connection, 'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=? FOR UPDATE', [scope(id), request.idempotencyKey]))[0];
        if (receipt) return receiptResult(receipt, hash);
        if (current.version !== request.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: current.version });
        const fields = (Object.keys(textColumns) as Field[]).filter(key => Object.hasOwn(request.changes, key) && request.changes[key] !== current[key]);
        if (fields.length && current.version === '18446744073709551615') failure('PROJECT_VERSION_EXHAUSTED', 422);
        const values = Object.fromEntries(Object.keys(textColumns).map(key => [key, Object.hasOwn(request.changes, key) ? request.changes[key as Field] : current[key]])) as TextValues;
        const result: SaveResult = { projectId: id, operationId: request.idempotencyKey, changed: fields.length > 0,
          savedVersion: fields.length ? String(BigInt(current.version) + 1n) : current.version, values, savedAt: fields.length ? new Date().toISOString() : null };
        if (fields.length) {
          const [updated] = await connection.execute<ResultSetHeader>(`UPDATE projects SET ${fields.map(key => `${textColumns[key]}=?`).join(',')},version=version+1,updated_at=? WHERE id=? AND version=?`, [...fields.map(key => values[key]), result.savedAt!.slice(0, 23).replace('T', ' '), id, current.version]);
          if (updated.affectedRows !== 1) failure('PROJECT_VERSION_CONFLICT', 409);
          const before = Object.fromEntries(fields.map(key => [key, current[key]]));
          const after = Object.fromEntries(fields.map(key => [key, values[key]]));
          await connection.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
            VALUES (NULL,'未认证操作','anonymous','project.text.save','project',?,?,?,?,?,?,?,?)`, [id, id, current.version, result.savedVersion, JSON.stringify(before), JSON.stringify(after), requestId, result.savedAt!.slice(0, 23).replace('T', ' ')]);
        }
        await connection.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (NULL,?,?,?,?,?,UTC_TIMESTAMP(3))', [scope(id), request.idempotencyKey, hash, 200, JSON.stringify(result)]);
        return result;
      });
    },
    confirm(id: string, request: SaveRequest) {
      return database.readSnapshot(async connection => {
        await project(connection, id, false);
        const receipt = (await query(connection, 'SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?', [scope(id), request.idempotencyKey]))[0];
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
