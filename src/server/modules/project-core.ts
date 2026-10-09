import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { failure, validId, validateSave, textColumns } from './project-save.js';
import { stages } from './projects.js';
type Command = { idempotencyKey: string; expectedVersion?: string; fields?: Record<string, string>; action?: 'join' | 'leave' };
export function validateCore(value: unknown, create: boolean): Command {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('INVALID_COMMAND', 400);
  const body = value as Command;
  const names = create ? ['idempotencyKey', 'fields'] : ['idempotencyKey', 'expectedVersion', 'action'];
  if (Object.keys(body).length !== names.length || Object.keys(body).some(key => !names.includes(key)) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey ?? '')) failure('INVALID_COMMAND', 400);
  if (create) {
    const input = validateSave({ idempotencyKey: body.idempotencyKey, expectedVersion: '1', changes: body.fields });
    if (!Object.hasOwn(input.changes, 'name') || Object.keys(input.changes).some(key => !Object.hasOwn(textColumns, key))) failure('INVALID_COMMAND', 400);
  } else if (!validId(body.expectedVersion) || !['join', 'leave'].includes(body.action ?? '')) failure('INVALID_COMMAND', 400);
  return body;
}
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0]; }
export function projectCore(database: RuntimeDatabase) {
  async function run(actor: Actor, body: Command, id: string | undefined, requestId: string, confirm: boolean) {
    const scope = `user:${actor.id}:project:${id ?? 'new'}:${id ? 'responsibility' : 'create'}`;
    const hash = createHash('sha256').update(JSON.stringify([id ?? null, body.expectedVersion ?? null, body.action ?? null, body.fields ? Object.keys(textColumns).filter(key => Object.hasOwn(body.fields!, key)).map(key => [key, body.fields![key]]) : null])).digest();
    const lookup = async (c: PoolConnection, lock: boolean) => {
      const row = (await rows(c, `SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?${lock ? ' FOR UPDATE' : ''}`, [scope, body.idempotencyKey]))[0];
      if (!row) return null;
      if (!row.request_hash.equals(hash)) failure('OPERATION_KEY_REUSED', 409);
      return typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.response_json;
    };
    if (confirm) return database.readSnapshot(async c => { const result = await lookup(c, false); return result ? { outcome: 'committed', result } : { outcome: 'not_found' }; });
    return database.writeTransaction(async c => {
      if (!id) await rows(c, 'SELECT id FROM users WHERE id=? FOR UPDATE', [actor.id]);
      await assertActor(c, actor);
      // 同一账号的新建命令序列化，唯一回执先于 INSERT 项目。
      let current: RowDataPacket | undefined;
      if (id) { current = (await rows(c, 'SELECT CAST(version AS CHAR) version FROM projects WHERE id=? FOR UPDATE', [id]))[0]; if (!current) failure('PROJECT_NOT_FOUND', 404); }
      const previous = await lookup(c, true); if (previous) return { outcome: 'committed', result: previous };
      const before = current?.version ?? null;
      let changed = true;
      if (!id) {
        const fields = body.fields!;
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
        const [inserted] = await c.execute<ResultSetHeader>(`INSERT INTO projects (name,data_kind,created_by,source_namespace,source_key,proposed_on,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,created_at,updated_at)
          VALUES (?,'trial',?,'geekdash-manual-v1',?,?,'',?,'',?,?,'','','',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [fields.name, actor.id, actor.id + ':' + body.idempotencyKey, date, fields.marketExpectation ?? '', fields.detailNote ?? '', fields.summaryNote ?? '']);
        // mysql2 insertId 的 JS number 可能失真，必须从连接读十进制字符串。
        id = (await rows(c, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
        if (!inserted.affectedRows) failure('CREATE_FAILED', 500);
        for (const stage of stages) await c.execute('INSERT INTO project_stages (project_id,stage_code,state,note) VALUES (?,?,?,?)', [id!, stage.code, stage.code === 'S1' ? 'ready' : 'locked', '']);
        await c.execute('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))', [id!, actor.id]);
      } else {
        if (current!.version !== body.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: current!.version });
        const members = await rows(c, 'SELECT CAST(r.user_id AS CHAR) id,u.enabled FROM project_responsibilities r JOIN users u ON u.id=r.user_id WHERE r.project_id=?', [id]);
        const joined = members.some(user => user.id === actor.id);
        changed = body.action === 'join' ? !joined : joined;
        if (changed && body.action === 'leave' && !members.some(user => user.id !== actor.id && !!user.enabled)) failure('LAST_RESPONSIBLE', 422);
        if (changed) {
          if (current!.version === '18446744073709551615') failure('PROJECT_VERSION_EXHAUSTED', 422);
          if (body.action === 'join') await c.execute('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,UTC_TIMESTAMP(3))', [id, actor.id]);
          else await c.execute('DELETE FROM project_responsibilities WHERE project_id=? AND user_id=?', [id, actor.id]);
          await c.execute('UPDATE projects SET version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [id]);
        }
      }
      const version = before ? String(BigInt(before) + (changed ? 1n : 0n)) : '1';
      const result = { projectId: id, savedVersion: version, operationId: body.idempotencyKey, changed, responsible: !body.action || body.action === 'join' };
      if (changed) await c.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
        VALUES (?,?,'user',?,'project',?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [actor.id, actor.name, before ? 'project.responsibility.' + body.action : 'project.create', id, id, before, version, before ? JSON.stringify({ responsibleUserId: actor.id, responsible: body.action === 'leave' }) : 'null', JSON.stringify(before ? { responsibleUserId: actor.id, responsible: body.action === 'join' } : { ...body.fields, createdBy: actor.id }), requestId]);
      await c.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,UTC_TIMESTAMP(3))', [actor.id, scope, body.idempotencyKey, hash, JSON.stringify(result)]);
      return { outcome: 'committed', result };
    });
  }
  return { run };
}
