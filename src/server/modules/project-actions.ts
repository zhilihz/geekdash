import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { failure, validId } from './project-save.js';

export type StageFact = { code: string; state: string; startedOn: string | null; completedOn: string | null };
export type StageCommand = { action: 'startStage' | 'completeStage'; stageCode: string; actualDate: string; expectedVersion: string; idempotencyKey: string; completionNote?: string };
export const businessToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
export function validateAction(value: unknown): StageCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('INVALID_STAGE_COMMAND', 400);
  const body = value as StageCommand;
  const required = ['action', 'stageCode', 'actualDate', 'expectedVersion', 'idempotencyKey'];
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => ![...required, 'completionNote'].includes(key))
    || !['startStage', 'completeStage'].includes(body.action) || typeof body.stageCode !== 'string' || !/^S[1-7]$/.test(body.stageCode) || !validId(body.expectedVersion)
    || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)) failure('INVALID_STAGE_COMMAND', 400);
  if (typeof body.actualDate !== 'string' || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(body.actualDate)
    || Number.isNaN(Date.parse(body.actualDate)) || new Date(body.actualDate).toISOString().slice(0, 10) !== body.actualDate) failure('INVALID_STAGE_DATE', 422, { fields: { actualDate: '请选择有效的实际日期' } });
  if (body.completionNote !== undefined && (body.action !== 'completeStage' || typeof body.completionNote !== 'string'
    || !body.completionNote.isWellFormed() || Buffer.byteLength(body.completionNote, 'utf8') > 65535)) failure('INVALID_STAGE_COMMAND', 400);
  return { ...body, ...(body.action === 'completeStage' ? { completionNote: body.completionNote ?? '' } : {}) };
}
function validSequence(facts: StageFact[]) {
  if (facts.length !== 7 || facts.some((fact, index) => fact.code !== 'S' + (index + 1))) return false;
  const first = facts.findIndex(fact => fact.state !== 'completed');
  return first === -1 || ['ready', 'active'].includes(facts[first].state) && facts.slice(first + 1).every(fact => fact.state === 'locked');
}
export function stageBlock(status: string, facts: StageFact[], code: string, action: StageCommand['action']): string | null {
  if (!validSequence(facts)) return 'STAGE_SEQUENCE_REVIEW_REQUIRED';
  if (!['proposal', 'ongoing'].includes(status)) return 'PROJECT_STAGE_ACTION_BLOCKED';
  const index = facts.findIndex(fact => fact.code === code);
  if (index < 0) return 'STAGE_SEQUENCE_REVIEW_REQUIRED';
  if (status === 'proposal' && index > 0) return 'PROJECT_START_REQUIRED';
  if (facts.slice(0, index).some(fact => fact.state !== 'completed')) return 'STAGE_PREDECESSOR_INCOMPLETE';
  if (facts[index].state !== (action === 'startStage' ? 'ready' : 'active')) return 'STAGE_STATE_CHANGED';
  if (action === 'startStage' && index > 0 && !facts[index - 1].completedOn || action === 'completeStage' && !facts[index].startedOn) return 'STAGE_DATE_REVIEW_REQUIRED';
  return null;
}
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0]; }
export function projectActions(database: RuntimeDatabase) {
  async function run(actor: Actor, id: string, body: StageCommand, requestId: string, confirm: boolean) {
    const scope = `user:${actor.id}:project:${id}:actions`;
    const hash = createHash('sha256').update(JSON.stringify([id, body.action, body.stageCode, body.actualDate, body.expectedVersion, body.completionNote ?? null])).digest();
    const lookup = async (c: PoolConnection, lock: boolean) => {
      const row = (await rows(c, `SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?${lock ? ' FOR UPDATE' : ''}`, [scope, body.idempotencyKey]))[0];
      if (!row) return null;
      if (!row.request_hash.equals(hash)) failure('OPERATION_KEY_REUSED', 409);
      return typeof row.response_json === 'string' ? JSON.parse(row.response_json) : row.response_json;
    };
    if (confirm) return database.readSnapshot(async c => { const result = await lookup(c, false); return result ? { outcome: 'committed', result } : { outcome: 'not_found' }; });
    return database.writeTransaction(async c => {
      await assertActor(c, actor);
      const project = (await rows(c, 'SELECT status,CAST(version AS CHAR) version FROM projects WHERE id=? FOR UPDATE', [id]))[0];
      if (!project) failure('PROJECT_NOT_FOUND', 404);
      const prior = await lookup(c, true); if (prior) return { outcome: 'committed', result: prior };
      if (!(await rows(c, 'SELECT user_id FROM project_responsibilities WHERE project_id=? AND user_id=?', [id, actor.id])).length) failure('PROJECT_READ_ONLY', 403);
      if (project.version !== body.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: project.version });
      const facts = await rows(c, "SELECT stage_code code,state,DATE_FORMAT(started_on,'%Y-%m-%d') startedOn,DATE_FORMAT(completed_on,'%Y-%m-%d') completedOn FROM project_stages WHERE project_id=? ORDER BY stage_code", [id]) as (RowDataPacket & StageFact)[];
      const blocked = stageBlock(project.status, facts, body.stageCode, body.action);
      if (blocked) failure(blocked, 422);
      const today = businessToday();
      if (body.actualDate > today) failure('INVALID_STAGE_DATE', 422, { fields: { actualDate: '实际日期不能晚于今天' } });
      const index = facts.findIndex(fact => fact.code === body.stageCode);
      const target = facts[index];
      if (body.action === 'startStage' && (target.startedOn || target.completedOn) || body.action === 'completeStage' && target.completedOn) failure('STAGE_DATE_REVIEW_REQUIRED', 422);
      const lower = body.action === 'startStage' ? facts[index - 1]?.completedOn : target.startedOn;
      if (lower && body.actualDate < lower) failure('INVALID_STAGE_DATE', 422, { fields: { actualDate: `实际日期不能早于${lower}` } });
      if (facts.some((fact, i) => fact.startedOn && fact.startedOn > today || fact.completedOn && fact.completedOn > today
        || ['ready', 'locked'].includes(fact.state) && (fact.startedOn || fact.completedOn)
        || fact.startedOn && fact.completedOn && fact.startedOn > fact.completedOn
        || i > 0 && fact.startedOn && facts[i - 1].completedOn && fact.startedOn < facts[i - 1].completedOn!)) failure('STAGE_DATE_REVIEW_REQUIRED', 422);
      if (project.version === '18446744073709551615') failure('PROJECT_VERSION_EXHAUSTED', 422);
      const before = [structuredClone(target)];
      if (body.action === 'startStage') {
        await c.execute("UPDATE project_stages SET state='active',started_on=? WHERE project_id=? AND stage_code=?", [body.actualDate, id, body.stageCode]);
        Object.assign(target, { state: 'active', startedOn: body.actualDate });
      } else {
        await c.execute("UPDATE project_stages SET state='completed',completed_on=? WHERE project_id=? AND stage_code=?", [body.actualDate, id, body.stageCode]);
        Object.assign(target, { state: 'completed', completedOn: body.actualDate });
        if (facts[index + 1]) {
          before.push(structuredClone(facts[index + 1]));
          await c.execute("UPDATE project_stages SET state='ready' WHERE project_id=? AND stage_code=?", [id, facts[index + 1].code]);
          facts[index + 1].state = 'ready';
        }
      }
      const savedVersion = String(BigInt(project.version) + 1n);
      await c.execute('UPDATE projects SET version=version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [id]);
      const after = facts.slice(index, index + before.length);
      await c.execute(`INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at)
        VALUES (?,?,'user',?,'project',?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`, [actor.id, actor.name, 'project.stage.' + (body.action === 'startStage' ? 'start' : 'complete'), id, id, project.version, savedVersion,
        JSON.stringify({ stageChanges: before }), JSON.stringify({ stageChanges: after, ...(body.action === 'completeStage' ? { completionNote: body.completionNote } : {}) }), requestId]);
      const result = { projectId: id, operationId: body.idempotencyKey, action: body.action, stageCode: body.stageCode, actualDate: body.actualDate, savedVersion, stages: after };
      await c.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,UTC_TIMESTAMP(3))', [actor.id, scope, body.idempotencyKey, hash, JSON.stringify(result)]);
      return { outcome: 'committed', result };
    });
  }
  return { run };
}
