import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, type Actor } from './identity.js';
import { failure, validId } from './project-save.js';
import { businessToday, validDate } from './project-dates.js';

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
    read(_actorId: string) { return { retired: true, code: 'CHECK_RULE_RETIRED', businessDate: businessToday(clock()) }; },
    async save(actor: Actor, body: RuleCommand, _requestId: string, confirm: boolean) {
      const scope = `user:${actor.id}:settings:check-rule`;
      const hash = createHash('sha256').update(JSON.stringify([body.action, body.deadlineWeekday, body.expectedVersion, body.previewWeek])).digest();
      const lookup = async (c: import('mysql2/promise').PoolConnection) => {
        const [rows] = await c.query<RowDataPacket[]>('SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?', [scope, body.idempotencyKey]);
        if (!rows.length) return null;
        if (!rows[0].request_hash.equals(hash)) failure('OPERATION_KEY_REUSED', 409);
        return typeof rows[0].response_json === 'string' ? JSON.parse(rows[0].response_json) : rows[0].response_json;
      };
      return database.readSnapshot(async c => {
        await assertActor(c, actor, false, clock(), false, false);
        const result = await lookup(c);
        if (result) return { outcome: 'committed', result };
        if (confirm) return { outcome: 'not_found' };
        failure('CHECK_RULE_RETIRED', 410);
      });
    },
  };
}
