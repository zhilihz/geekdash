import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { assertActor, isAdministrator, type Actor } from './identity.js';
import { failure, validId } from './project-save.js';
import { businessToday, validDate } from './project-dates.js';

export async function companyInformation(c: import('mysql2/promise').PoolConnection) {
  const [rows]=await c.query<RowDataPacket[]>('SELECT full_name fullName,short_name shortName,manager_text managerText,name_prefix namePrefix,CAST(version AS CHAR) version FROM system_configuration WHERE id=1');
  return rows[0] ?? null;
}

export type CheckPolicy={version:string;frequency:'daily'|'weekly'|'manual';deadlineWeekday:number;periodStart:string;deadline:string|null;businessDate:string};
export async function readCheckPolicy(c:import('mysql2/promise').PoolConnection,now=new Date()):Promise<CheckPolicy>{
  const [rows]=await c.query<RowDataPacket[]>("SELECT CAST(version AS CHAR) version,frequency,deadline_weekday deadlineWeekday FROM check_rule_revisions ORDER BY version DESC LIMIT 1");
  const current=rows[0]??{version:'0',frequency:'weekly',deadlineWeekday:5};
  const today=businessToday(now),date=new Date(today+'T00:00:00Z'),weekday=(date.getUTCDay()+6)%7;
  const monday=new Date(date.getTime()-weekday*86400000).toISOString().slice(0,10);
  return {...current,businessDate:today,periodStart:current.frequency==='daily'?today:monday,deadline:current.frequency==='manual'?null:current.frequency==='daily'?today:new Date(Date.parse(monday)+(Number(current.deadlineWeekday)-1)*86400000).toISOString().slice(0,10)} as CheckPolicy;
}
export type PolicyCommand={frequency:CheckPolicy['frequency'];deadlineWeekday:number;expectedVersion:string;idempotencyKey:string};
export function validatePolicy(value:unknown):PolicyCommand{
  const body=value as PolicyCommand;
  if(!body||typeof body!=='object'||Object.keys(body).length!==4||!['daily','weekly','manual'].includes(body.frequency)||!Number.isInteger(body.deadlineWeekday)||body.deadlineWeekday<1||body.deadlineWeekday>7||! /^(0|[1-9][0-9]{0,19})$/.test(body.expectedVersion)||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(body.idempotencyKey))failure('INVALID_CHECK_RULE_COMMAND',400);
  return body;
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
    read(actorId: string) { return database.readSnapshot(async c=>{if(!await isAdministrator(c,actorId))failure('MAINTENANCE_REQUIRED',403);return readCheckPolicy(c,clock());}); },
    update(actor:Actor,body:PolicyCommand,requestId:string,confirm=false){
      const scope=`user:${actor.id}:settings:check-policy`,hash=createHash('sha256').update(JSON.stringify([body.frequency,body.deadlineWeekday,body.expectedVersion])).digest();
      return (confirm?database.readSnapshot:database.writeTransaction)(async c=>{
        await assertActor(c,actor,false,clock(),false,!confirm);
        if(!await isAdministrator(c,actor.id))failure('MAINTENANCE_REQUIRED',403);
        if(!confirm)await c.query('SELECT id FROM system_configuration WHERE id=1 FOR UPDATE');
        const [prior]=await c.query<RowDataPacket[]>('SELECT request_hash,response_json FROM command_receipts WHERE command_scope=? AND idempotency_key=?',[scope,body.idempotencyKey]);
        if(prior.length){if(!prior[0].request_hash.equals(hash))failure('OPERATION_KEY_REUSED',409);return {outcome:'committed',result:typeof prior[0].response_json==='string'?JSON.parse(prior[0].response_json):prior[0].response_json};}
        if(confirm)return {outcome:'not_found'};
        const before=await readCheckPolicy(c,clock());if(before.version!==body.expectedVersion)failure('SETTINGS_VERSION_CONFLICT',409);
        const changed=before.frequency!==body.frequency||before.deadlineWeekday!==body.deadlineWeekday;
        if(changed || before.version==='0'){
          const date=new Date(before.businessDate+'T00:00:00Z'),monday=new Date(date.getTime()-((date.getUTCDay()+6)%7)*86400000).toISOString().slice(0,10);
          await c.execute('INSERT INTO check_rule_revisions(deadline_weekday,effective_week,saved_at,saved_by,frequency) VALUES (?,?,?,?,?)',[body.deadlineWeekday,monday,clock(),actor.id,body.frequency]);
        }
        const result={...await readCheckPolicy(c,clock()),changed,operationId:body.idempotencyKey};
        if(changed)await c.execute("INSERT INTO audit_log(actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,before_json,after_json,request_id,created_at) VALUES (?,?,'user','settings.check-policy','check_rule',?,?,?,?,?)",[actor.id,actor.name,result.version,JSON.stringify(before),JSON.stringify(result),requestId,clock()]);
        await c.execute('INSERT INTO command_receipts(actor_id,command_scope,idempotency_key,request_hash,response_code,response_json,committed_at) VALUES (?,?,?,?,200,?,?)',[actor.id,scope,body.idempotencyKey,hash,JSON.stringify(result),clock()]);
        return {outcome:'committed',result};
      });
    },
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
