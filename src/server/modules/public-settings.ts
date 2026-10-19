import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { failure, validId } from './project-save.js';
import { checkContext, validDate } from './project-dates.js';

export async function companyInformation(c: import('mysql2/promise').PoolConnection) {
  const [rows]=await c.query<RowDataPacket[]>('SELECT full_name fullName,short_name shortName,manager_text managerText,name_prefix namePrefix,CAST(version AS CHAR) version FROM system_configuration WHERE id=1');
  return rows[0] ?? null;
}

export type RuleCommand = { action: 'initializeCheckRule' | 'modifyCheckRule'; deadlineWeekday: number; expectedVersion: string; previewWeek: string; idempotencyKey: string };
export function validateRule(value: unknown): RuleCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('INVALID_CHECK_RULE_COMMAND', 400);
  const body = value as RuleCommand;
  if (Object.keys(body).length !== 5 || !['initializeCheckRule', 'modifyCheckRule'].includes(body.action) || !Number.isInteger(body.deadlineWeekday) || body.deadlineWeekday < 1 || body.deadlineWeekday > 7 || !validId(body.expectedVersion) || !validDate(body.previewWeek)
    || typeof body.idempotencyKey !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey)) failure('INVALID_CHECK_RULE_COMMAND', 400);
  return { action: body.action, deadlineWeekday: body.deadlineWeekday, expectedVersion: body.expectedVersion, previewWeek: body.previewWeek, idempotencyKey: body.idempotencyKey };
}
export function publicSettings(database: RuntimeDatabase, clock = () => new Date()) {
  return {
    read(actorId: string) { return database.readSnapshot(c => checkContext(c, actorId, clock())); },
    async save(actor: Actor, body: RuleCommand, requestId: string, confirm: boolean) {
      const scope = `user:${actor.id}:settings:check-rule`;
      const hash = createHash('sha256').update(JSON.stringify([body.action, body.deadlineWeekday, body.expectedVersion, body.previewWeek])).digest();
      const lookup = async (c: import('mysql2/promise').PoolConnection) => {
        const [rows] = await c.query<RowDataPacket[]>('SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?', [scope, body.idempotencyKey]);
        if (!rows.length) return null;
        if (!rows[0].request_hash.equals(hash)) failure('OPERATION_KEY_REUSED', 409);
        return typeof rows[0].response_json === 'string' ? JSON.parse(rows[0].response_json) : rows[0].response_json;
      };
      if (confirm) return database.readSnapshot(async c => { const result = await lookup(c); return result ? { outcome: 'committed', result } : { outcome: 'not_found' }; });
      return database.writeTransaction(async c => {
        await assertActor(c, actor);
        const [configs] = await c.query<RowDataPacket[]>('SELECT CAST(version AS CHAR) version,CAST(maintenance_user_id AS CHAR) maintenanceUserId FROM system_configuration WHERE id=1 FOR UPDATE');
        const prior = await lookup(c); if (prior) return { outcome: 'committed', result: prior };
        if (!configs.length) failure('SYSTEM_CONFIGURATION_REQUIRED', 422);
        const config = configs[0];
        if (config.maintenanceUserId !== actor.id) failure('MAINTENANCE_REQUIRED', 403);
        if (config.version !== body.expectedVersion) failure('SETTINGS_VERSION_CONFLICT', 409);
        const now = clock(), context = await checkContext(c, actor.id, now);
        if (body.action === 'initializeCheckRule' && context.rule) failure('CHECK_RULE_ALREADY_INITIALIZED', 422);
        if (body.action === 'modifyCheckRule' && !context.rule) failure('CHECK_RULE_REQUIRED', 422);
        if (body.previewWeek !== context.weekStart) failure('CHECK_PREVIEW_CHANGED', 409);
        const at = now.toISOString().slice(0, 23).replace('T', ' ');
        if (context.rule?.deadlineWeekday === body.deadlineWeekday) {
          const result = { operationId: body.idempotencyKey, savedVersion: config.version, changed: false, ruleVersion: context.rule.version, deadlineWeekday: body.deadlineWeekday, effectiveWeek: context.rule.effectiveWeek };
          await c.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,?)', [actor.id, scope, body.idempotencyKey, hash, JSON.stringify(result), at]);
          return { outcome: 'committed', result };
        }
        if (config.version === '18446744073709551615') failure('SETTINGS_VERSION_EXHAUSTED', 422);
        await c.execute('INSERT INTO check_rule_revisions (deadline_weekday,effective_week,saved_at,saved_by) VALUES (?,?,?,?)', [body.deadlineWeekday, context.weekStart, at, actor.id]);
        const [ids] = await c.query<RowDataPacket[]>('SELECT CAST(LAST_INSERT_ID() AS CHAR) id');
        const savedVersion = String(BigInt(config.version) + 1n);
        const result = { operationId: body.idempotencyKey, savedVersion, ...(body.action === 'modifyCheckRule' ? { changed: true } : {}), ruleVersion: ids[0].id, deadlineWeekday: body.deadlineWeekday, effectiveWeek: context.weekStart };
        await c.execute('UPDATE system_configuration SET version=version+1,updated_by=?,updated_at=? WHERE id=1', [actor.id, at]);
        await c.execute("INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user',?,'system_configuration',1,?,?,?,?,?,?)", [actor.id, actor.name, body.action === 'initializeCheckRule' ? 'settings.check-rule.initialize' : 'settings.check-rule.modify', config.version, savedVersion, JSON.stringify(context.rule), JSON.stringify(result), requestId, at]);
        await c.execute('INSERT INTO command_receipts (actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,?)', [actor.id, scope, body.idempotencyKey, hash, JSON.stringify(result), at]);
        return { outcome: 'committed', result };
      });
    },
  };
}
