import { sourceTasks,readTasks,writeTasks,taskDescription,textTaskOperations,taskCandidate,type ProjectTask } from './project-tasks.js';
import { projectReferences, readProjectReferences } from './project-references.js';
import { projectNameKey } from './project-name.js';
import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Actor } from './identity.js';
import { columns, referenceFields, failure, validId, validateSave, lockReferences, replaceLinks, displayValues, type SaveRequest } from './project-save.js';
import { businessToday, validDate, closurePlanKnownExpression } from './project-dates.js';
import { validSequence, type StageFact } from './project-actions.js';
import { riskRows, changeRows, nodeRows } from './project-records.js';
import { scheduleRecords } from './project-plans.js';
import type { StatusEntry } from './project-status-entries.js';
import { localCheckMarks, recordSourceFacts, originalRecordTimes, statusSourceBaselines } from './project-source-history.js';
import { projectStatusEntries, type StatusChange } from './project-status-entries.js';
import { importSourceKey, emptyImportReference } from './import-source.js';

export type ImportRole = 'pm' | 'hardware_owner' | 'software_owner' | 'participant';
export type ImportStage = { code: string; state?: 'unknown' | 'locked' | 'ready' | 'active' | 'completed'; plannedDays?: number | null; note?: string; startedOn?: string | null; completedOn?: string | null; expectedEndOn?: string | null };
export type ImportRecordKind = 'project_node' | 'customer_node' | 'risk' | 'change' | 'schedule';
export type ImportRecord = { key: string; kind: ImportRecordKind; sourceKey: string | null; targetId?: string | null; values: Record<string, unknown> };
export type ImportHistoryLine = { date: string; text: string };
export type ImportHistories = Partial<Record<'mixed' | 'status_description', ImportHistoryLine[]>>;
export type ImportProjectFields = Omit<SaveRequest['changes'], 'people' | 'stagePlans' | 'riskOps' | 'nodeOps' | 'changeOps' | 'taskOps'> & {
  status?: 'proposal' | 'ongoing' | 'paused' | 'closed'; resumeStatus?: string | null; preCloseStatus?: string | null;
  proposalDate?: string | null; filingDate?: string | null; startDate?: string | null; dueDate?: string | null; originalDueDate?: string | null;
  closedOn?: string | null; closureDueDate?: string | null; closureType?: 'normal' | 'terminated' | null;
  closureNote?: string; remainingWorkNote?: string; maintenanceEnabled?: boolean;
};
export type ImportProjectInput = { projectId?: string; expectedVersion?: string; fields?: ImportProjectFields; people?: Partial<Record<ImportRole, string[]>>;
  stages?: ImportStage[]; records?: ImportRecord[]; histories?: ImportHistories; tasks?: ProjectTask[]; statusEntries?: StatusEntry[]; lastCheckAt?: unknown;
  intent?: { kind: 'correction' | 'rework' | 'reopen'; reason: string } };
export type ImportProjectContext = { itemId: string; sourceNamespace: string; operationKey: string; requestId: string; now?: Date; selectionKeys?: Record<string, string>; candidateRecords?: ImportRecord[] };
export type ImportEffect = { cause: string; consequence: string; requiredKeys?: string[] };
export type ImportSourceProblem = { path: string; code: string; message: string };
export type ImportResolver = { resolve?: (kind: string, sourceKeyOrName: string, path?: string) => string | null | undefined; child?: (kind: ImportRecordKind, sourceKey: string) => string | null | undefined };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const json = (v: unknown): any => typeof v === 'string' ? JSON.parse(v) : v;
const own = Object.hasOwn;
const stateNames: Record<string, string> = { '提案中': 'proposal', '进行中': 'ongoing', '暂缓': 'paused', '已结案': 'closed' };
const signalNames: Record<string, string> = { '绿': 'green', '绿灯': 'green', '黄': 'yellow', '黄灯': 'yellow', '红': 'red', '红灯': 'red' };
const levelNames: Record<string, string> = { '高': 'high', '中': 'mid', '低': 'low' };
const stageNames = ['需求立项', '项目预启动', 'PEVT技术预研', 'EVT集成验证', 'DVT可靠性验证', 'PVT量产验证', 'MP量产维护'];
const stageName = (code: string) => stageNames[Number(code.slice(1)) - 1] ?? code;
const stageStateName = (state?: string) => ({ locked: '未解锁', ready: '待开始', active: '进行中', completed: '已完成' } as Record<string, string>)[state ?? ''] ?? '未知';
const dateColumns = { proposalDate: 'proposed_on', filingDate: 'filed_on', startDate: 'started_on', dueDate: 'current_due_date', originalDueDate: 'original_due_date', closedOn: 'closed_on', closureDueDate: 'closure_due_date' } as const;
const factColumns = { ...dateColumns, status: 'status', resumeStatus: 'resume_status', preCloseStatus: 'pre_close_status', closureType: 'closure_type', closureNote: 'closure_note', remainingWorkNote: 'remaining_work_note', maintenanceEnabled: 'maintenance_enabled' } as const;
const ordinaryKeys = () => new Set([...Object.keys(columns), ...Object.keys(projectReferences), 'chipSelections', 'tagIds']);
// 本地日期控件把未填写保存为“-”；原文仍保存在来源记录中。
const dateValue = (v: unknown) => v === '' || v === '-' || v === null ? null : v;
const sourceKey = importSourceKey;
async function rows(c: PoolConnection, sql: string, values: unknown[] = []) { return (await c.query<RowDataPacket[]>({ sql, timeout: 10000 }, values))[0]; }

// 只转换来源中实际存在的字段；候选名称和旧ID不能成为正式ID。
export function normalizeImportProject(raw: Record<string, unknown>, resolver: ImportResolver = {}) {
  const fields: Record<string, unknown> = {}, input: ImportProjectInput = { fields }, issues: ImportSourceProblem[] = [];
  const issue = (path: string, code: string, message: string) => issues.push({ path, code, message });
  for (const key of Object.keys(columns).filter(key => !Object.hasOwn(referenceFields, key))) if (own(raw, key)) fields[key] = raw[key];
  for (const [source, target] of Object.entries({ summary_note: 'summaryNote', chipstat_note: 'chipstatNote', closeReason: 'closureNote', isProductionMaintenance: 'maintenanceEnabled' })) if (own(raw, source)) fields[target] = raw[source];
  for (const key of Object.keys(factColumns)) if (own(raw, key)) fields[key] = own(dateColumns, key) ? dateValue(raw[key]) : raw[key];
  if (typeof fields.status === 'string') fields.status = stateNames[fields.status] ?? fields.status;
  for (const key of ['resumeStatus', 'preCloseStatus']) if (typeof fields[key] === 'string') fields[key] = stateNames[fields[key] as string] ?? fields[key];
  if (typeof fields.signal === 'string') fields.signal = signalNames[fields.signal] ?? fields.signal;
  if (typeof fields.priority === 'string') fields.priority = levelNames[fields.priority] ?? fields.priority;
  if (fields.closureType === 'completed') fields.closureType = 'normal';
  if (fields.closureType === 'early') issue('fields.closureType', 'IMPORT_CLOSURE_TYPE_REQUIRED', '中途结案不代表终止，请核对结案类型或明确为未知');
  if (!own(fields, 'preCloseStatus') && object(raw.stageCloseBefore) && own(raw.stageCloseBefore, 'status')) fields.preCloseStatus = stateNames[String(raw.stageCloseBefore.status)] ?? raw.stageCloseBefore.status;
  const reference = (kind: string, value: unknown, path: string) => {
    if (emptyImportReference(value)) return null;
    const name = typeof value === 'string' ? value : object(value) ? String(value.id ?? value.name ?? '') : typeof value === 'number' ? String(value) : '';
    const id = name ? resolver.resolve?.(kind, name, path) : undefined;
    if (id === null) return null;
    if (!id || !validId(id)) { issue(path, 'IMPORT_REFERENCE_REQUIRED', '所引用的资料需要处理'); return undefined; }
    return id;
  };
  for (const [key, target, kind] of [['customer', 'customerIds', 'customers'], ['odmFactory', 'odmFactoryIds', 'odmFactories'], ['productLine', 'productLineIds', 'productLines'], ['app', 'appIds', 'apps'], ['group', 'groupIds', 'groups']]) if (own(raw, key)) {
    const values = Array.isArray(raw[key]) ? raw[key] as unknown[] : raw[key] === '' || raw[key] === null ? [] : [raw[key]];
    if(values.length&&values.every(value=>typeof value==='string'&&value.trim()==='-'))continue;
    const ids = values.map(value => reference(kind, value, 'fields.' + target));
    if (ids.every(id => id !== undefined)) fields[target] = [...new Set(ids.filter(id => id !== null))];
  }
  if (own(raw, 'tags')) {
    if (!Array.isArray(raw.tags)) issue('fields.tagIds', 'IMPORT_INVALID_COLLECTION', '来源名单应为数组');
    else {
      const ids = raw.tags.map(value => reference('tags', value, 'fields.tagIds'));
      if (ids.every(id => id !== undefined)) fields.tagIds = [...new Set(ids.filter(id => id !== null))];
    }
  }
  if (own(raw, 'chipSelections') || own(raw, 'chips')) {
    const values = own(raw, 'chipSelections') ? raw.chipSelections : raw.chips;
    if (!Array.isArray(values)) issue('fields.chipSelections', 'IMPORT_INVALID_COLLECTION', '来源名单应为数组');
    else {
      const selections = values.map((value, index) => {
        const chipId = reference('chips', object(value) ? value.name : value, 'fields.chipSelections');
        const sourceId = object(value) && typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id) ? value.id : createHash('sha256').update(JSON.stringify([index,value])).digest('hex').slice(0,32);
        const selectionId = sourceId.length === 36 ? sourceId : sourceId.slice(0,8)+'-'+sourceId.slice(8,12)+'-'+sourceId.slice(12,16)+'-'+sourceId.slice(16,20)+'-'+sourceId.slice(20);
        return { selectionId, chipId, note: object(value) && typeof value.note === 'string' ? value.note : '' };
      });
      if (selections.every(item => item.chipId !== undefined)) fields.chipSelections = selections.filter(item => item.chipId !== null);
    }
  }
  for (const [key, role] of [['hwOwner', 'hardware_owner'], ['swOwner', 'software_owner'], ['participants', 'participant']] as const) if (own(raw, key)) {
    const values = Array.isArray(raw[key]) ? raw[key] as unknown[] : raw[key] === '' || raw[key] === null ? [] : [raw[key]];
    const ids = values.map(v => reference('engineers', v, 'people.' + role));
    if (ids.every(v => v !== undefined)) (input.people ??= {})[role] = [...new Set(ids.filter((v): v is string => !!v))];
  }
  if (own(raw, 'stages')) {
    if (!Array.isArray(raw.stages) || raw.stages.length > 7) issue('stages', 'IMPORT_INVALID_STAGES', '请核对七阶段来源结构');
    else {
      const first = raw.stages.findIndex(v => !object(v) || v.done !== true);
      input.stages = raw.stages.flatMap((v, index) => {
        if (!object(v)) { issue('stage.S' + (index + 1), 'IMPORT_INVALID_STAGE', '阶段内容应为对象'); return []; }
        const stage: Record<string, unknown> = { code: 'S' + (index + 1) };
        if (own(v, 'state')) stage.state = v.state;
        else if (v.done === true) stage.state = 'completed';
        else if (v.done === false && index > first) stage.state = 'locked';
        else if (v.done === false) stage.state = 'unknown';
        for (const [source, target] of Object.entries({ days: 'plannedDays', note: 'note', startDate: 'startedOn', doneDate: 'completedOn', expectedEndDate: 'expectedEndOn' })) if (own(v, source)) {
          stage[target] = source === 'days' ? v[source] === '' || v[source] === null ? null : typeof v[source] === 'string' && /^\d+$/.test(v[source]) ? Number(v[source]) : v[source] : source === 'note' ? v[source] : dateValue(v[source]);
        }
        return [stage as ImportStage];
      });
    }
  }
  const sets: [string, ImportRecordKind, Record<string, string>][] = [
    ['nodes', 'project_node', { name: 'title', stage: 'stage', stageId: 'stage', targetDate: 'targetDate', output: 'output', doneDate: 'completedOn', prevId: 'previousNodeId', nextId: 'nextNodeId', x: 'x', y: 'y' }],
    ['customerNodes', 'customer_node', { name: 'title', targetDate: 'targetDate', doneDate: 'completedOn', note: 'note' }],
    ['risks', 'risk', { content: 'content', level: 'level', createdAt: 'createdAt', resolved: 'resolved', resolveMethod: 'resolution', resolvedAt: 'resolvedAt' }],
    ['changes', 'change', { source: 'source', content: 'content', status: 'decision', reason: 'reason', createdAt: 'createdAt' }],
    ['delays', 'schedule', { reason: 'reason', newTargetDate: 'newDate', oldDate: 'oldDate', measures: 'measures', createdAt: 'createdAt', kind: 'kind' }],
  ];
  for (const [key, kind, names] of sets) if (own(raw, key)) {
    if (!Array.isArray(raw[key])) { issue(key, 'IMPORT_INVALID_COLLECTION', '来源记录应为数组'); continue; }
    const items = raw[key] as unknown[], keys = items.map(v => object(v) ? sourceKey(v.id) : null);
    for (const [index, value] of items.entries()) {
      if (!object(value)) { issue(key + '.' + index, 'IMPORT_INVALID_RECORD', '来源记录应为对象'); continue; }
      const stable = keys[index] && keys.filter(v => v === keys[index]).length === 1 ? keys[index] : null;
      const record: ImportRecord = { key: kind + ':' + (stable ?? '@' + index), kind, sourceKey: stable, values: {} };
      if (stable) { const target = resolver.child?.(kind, stable); if (target !== undefined) record.targetId = target; }
      for (const [source, target] of Object.entries(names)) if (own(value, source)) {
        let next = value[source];
        if (['targetDate', 'completedOn', 'oldDate', 'newDate'].includes(target)) next = dateValue(next);
        if (target === 'stage') { if (typeof next === 'number' || typeof next === 'string' && /^\d$/.test(next)) next = 'S' + next; else if (typeof next === 'string') { const index = ['需求立项', '项目预启动', 'PEVT技术预研', 'EVT集成验证', 'DVT可靠性验证', 'PVT量产验证', 'MP量产维护'].indexOf(next); if (index >= 0) next = 'S' + (index + 1); } }
        if (target === 'level' && typeof next === 'string') next = levelNames[next] ?? next;
        if (target === 'decision' && typeof next === 'string') next = ({ '接受': 'accept', '拒绝': 'reject' } as Record<string, string>)[next] ?? next;
        if (target === 'previousNodeId' || target === 'nextNodeId') {
          const edge = sourceKey(next); next = edge ? resolver.child?.('project_node', edge) ?? 'source:' + edge : null;
        }
        record.values[target] = next;
      }
      (input.records ??= []).push(record);
    }
  }
  for (const [key, kind] of [['statusHistory', 'mixed'], ['statusDescHistory', 'status_description']] as const) if (own(raw, key)) {
    if (raw[key] === null) (input.histories ??= {})[kind] = [];
    else if (!Array.isArray(raw[key]) || (raw[key] as unknown[]).some(v => !object(v) || typeof v.text !== 'string' || v.date !== undefined && typeof v.date !== 'string')) issue('history.' + kind, 'IMPORT_INVALID_HISTORY', '来源历史应保留原日期和正文');
    else (input.histories ??= {})[kind] = (raw[key] as Record<string, unknown>[]).map(v => ({ date: v.date as string ?? '', text: v.text as string }));
  }
  if (Array.isArray(raw.statusDescEntries)) input.statusEntries = raw.statusDescEntries.filter(object).map(v => ({ text: typeof v.text === 'string' ? v.text : '', date: typeof v.updatedAt === 'string' ? v.updatedAt : typeof v.date === 'string' ? v.date : '' }));
  if (own(raw,'tasks')) {
    try {
      input.tasks=sourceTasks(raw.tasks);
      if(raw.taskUnifiedVersion!==1&&typeof raw.statusDesc==='string'){
        const legacy=raw.statusDesc.replace(/\r\n?/g,'\n').split('\n').map((line,index)=>({id:'legacy-source-'+createHash('sha256').update(JSON.stringify([raw.id??'',index,line])).digest('hex').slice(0,32),text:line.replace(/^\s*\d+[、.．)）]\s*/, '').trim(),createdAt:input.statusEntries?.[index]?.text===line?input.statusEntries[index].date:'',updatedAt:input.statusEntries?.[index]?.text===line?input.statusEntries[index].date:'',completedAt:'',deletedAt:''})).filter(task=>task.text&&task.text!=='-');
        input.tasks.push(...legacy);
      }
      delete fields.statusDesc;
    }
    catch(error) { issue('tasks','INVALID_IMPORT_TASKS',(error as {fields?:{tasks:string}}).fields?.tasks ?? '任务内容无效'); }
  }
  if(Array.isArray(raw.taskHistory)) {
    const entries=raw.taskHistory.filter(object).filter(v=>typeof v.text==='string').map(v=>({date:typeof v.date==='string'?v.date:'',text:v.text as string}));
    if(entries.length)(input.histories??={}).status_description=[...(input.histories?.status_description??[]),...entries];
  }
  if (own(raw, 'lastCheckAt')) input.lastCheckAt = raw.lastCheckAt;
  return { input, issues };
}

const selectFields = () => [...Object.entries(columns).map(([key, column]) => `${column.endsWith('_id') ? `CAST(\`${column}\` AS CHAR)` : '\`' + column + '\`'} \`${key}\``), ...Object.entries(factColumns).map(([key, column]) => `${own(dateColumns, key) ? `DATE_FORMAT(\`${column}\`,'%Y-%m-%d')` : '\`' + column + '\`'} \`${key}\``)].join(',');
export type LockedImportProject = { current: RowDataPacket | null; references: Record<string, RowDataPacket[]> };
export async function lockImportProject(c: PoolConnection, input: ImportProjectInput, lock = true): Promise<LockedImportProject> {
  if (!object(input) || input.fields !== undefined && !object(input.fields) || input.people !== undefined && (!object(input.people) || Object.values(input.people).some(ids => !Array.isArray(ids)))
    || input.stages !== undefined && (!Array.isArray(input.stages) || input.stages.some(stage => !object(stage))) || input.records !== undefined && (!Array.isArray(input.records) || input.records.some(record => !object(record)))
    || input.histories !== undefined && !object(input.histories) || input.statusEntries !== undefined && (!Array.isArray(input.statusEntries) || input.statusEntries.some(entry => !object(entry) || typeof entry.text !== 'string' || typeof entry.date !== 'string'))
    || input.intent !== undefined && (!object(input.intent) || !['correction', 'rework', 'reopen'].includes(input.intent.kind) || typeof input.intent.reason !== 'string')) failure('INVALID_IMPORT_PROJECT', 400);
  if(input.tasks!==undefined)sourceTasks(input.tasks);
  const ordinary = Object.fromEntries(Object.entries(input.fields ?? {}).filter(([key]) => ordinaryKeys().has(key))) as SaveRequest['changes'];
  if (input.people) ordinary.people = Object.entries(input.people).flatMap(([role, ids]) => (ids ?? []).map(id => ({ id, role })));
  if (Object.keys(ordinary).length) validateSave({ changes: ordinary, expectedVersion: '1', idempotencyKey: '00000000-0000-4000-8000-000000000001' });
  const references: Record<string, RowDataPacket[]> = lock ? await lockReferences(c, ordinary) : {};
  if (!lock) for (const [key, table] of Object.entries(referenceFields)) if (own(ordinary, key)) {
    const value = ordinary[key as keyof typeof ordinary], ids = key === 'people' ? ordinary.people!.map(v => v.id) : Array.isArray(value) ? value as string[] : value ? [value as string] : [];
    references[table] ??= [];
    if (ids.length) references[table].push(...await rows(c, `SELECT CAST(id AS CHAR) id,name,enabled FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids));
  }
  let current: RowDataPacket | null = null;
  if (input.projectId) {
    if (!validId(input.projectId)) failure('INVALID_PROJECT_ID', 400);
    current = (await rows(c, `SELECT CAST(id AS CHAR) id,CAST(version AS CHAR) version,${selectFields()},CAST(source_import_item_id AS CHAR) sourceImportItemId FROM projects WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [input.projectId]))[0] ?? null;
    if (!current) failure('PROJECT_NOT_FOUND', 404);
  }
  return { current, references };
}

export async function readImportProject(c: PoolConnection, projectId: string, sourceNamespace?: string): Promise<ImportProjectInput | null> {
  const current = (await rows(c, `SELECT CAST(version AS CHAR) version,${selectFields()} FROM projects WHERE id=?`, [projectId]))[0];
  if (!current) return null;
  const fields: ImportProjectFields & Record<string, unknown> = { ...current }; delete fields.version;
  fields.maintenanceEnabled = !!fields.maintenanceEnabled;
  Object.assign(fields, await readProjectReferences(c, projectId));
  fields.tagIds = (await rows(c, 'SELECT CAST(tag_id AS CHAR) id FROM project_tags WHERE project_id=? ORDER BY sort_order,tag_id', [projectId])).map(v => v.id);
  const people: ImportProjectInput['people'] = { pm: [], hardware_owner: [], software_owner: [], participant: [] };
  for (const item of await rows(c, 'SELECT role,CAST(engineer_id AS CHAR) id FROM project_people WHERE project_id=? ORDER BY sort_order,engineer_id', [projectId])) people[item.role as ImportRole]?.push(item.id);
  const stages = await rows(c, "SELECT stage_code code,state,planned_days plannedDays,note,DATE_FORMAT(started_on,'%Y-%m-%d') startedOn,DATE_FORMAT(completed_on,'%Y-%m-%d') completedOn,DATE_FORMAT(expected_end_on,'%Y-%m-%d') expectedEndOn FROM project_stages WHERE project_id=? ORDER BY stage_code", [projectId]) as (RowDataPacket & ImportStage)[];
  const records: ImportRecord[] = [];
  for (const [kind, source] of [['node', await nodeRows(c, projectId)], ['risk', await riskRows(c, projectId)], ['change', await changeRows(c, projectId)], ['schedule', await scheduleRecords(c, projectId)]] as const) for (const row of source) {
    const recordKind: ImportRecordKind = kind === 'node' ? (row as RowDataPacket).kind === 'customer' ? 'customer_node' : 'project_node' : kind;
    const values = Object.fromEntries(Object.keys(recordColumns[recordKind]).map(key => [key, (row as RowDataPacket)[key] ?? null]));
    if (kind === 'risk') values.resolved = !!values.resolved;
    records.push({ key: recordKind + ':' + row.id, kind: recordKind, sourceKey: (row as RowDataPacket).sourceKey ?? null, targetId: row.id, values });
  }
  const histories: ImportHistories = {};
  if (sourceNamespace) for (const kind of ['mixed', 'status_description'] as const) {
    const latest = (await rows(c, `SELECT CAST(id AS CHAR) id,history_manifest_json manifest FROM import_adoptions WHERE target_kind='project' AND target_id=? AND source_namespace=? AND JSON_CONTAINS_PATH(history_manifest_json,'one',?) ORDER BY id DESC LIMIT 1`, [projectId, sourceNamespace, '$.' + kind]))[0];
    if (latest) histories[kind] = (await rows(c, 'SELECT source_date_text date,body text FROM legacy_project_history WHERE source_adoption_id=? AND history_kind=? ORDER BY source_sequence,id', [latest.id, kind])).map(v => ({ date: v.date ?? '', text: v.text }));
    else {
      const legacy = await rows(c, 'SELECT source_date_text date,body text FROM legacy_project_history WHERE project_id=? AND legacy_source_namespace=? AND history_kind=? ORDER BY source_sequence,id', [projectId, sourceNamespace, kind]);
      if (legacy.length) histories[kind] = legacy.map(v => ({ date: v.date ?? '', text: v.text }));
    }
  }
  const origins = await recordSourceFacts(c, projectId);
  for (const record of records) originalRecordTimes(record.values, origins.get(record.kind + ':' + record.targetId)?.values);
  const mark = sourceNamespace ? (await localCheckMarks(c, projectId)).find(row => row.sourceNamespace === sourceNamespace) : undefined;
  const baseline = (await statusSourceBaselines(c, [projectId])).get(projectId);
  const statusChanges = await rows(c, `SELECT action,CASE WHEN JSON_TYPE(JSON_EXTRACT(before_json,'$.statusDesc'))='STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(before_json,'$.statusDesc')) ELSE NULL END beforeText,JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.statusDesc')) afterText,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt FROM audit_log WHERE project_id=? AND action<>'project.import' AND JSON_TYPE(JSON_EXTRACT(after_json,'$.statusDesc'))='STRING'${baseline ? ' AND version_after>?' : ''} ORDER BY id`, [projectId, ...baseline ? [baseline.version] : []]) as (RowDataPacket & StatusChange)[];
  return { projectId, expectedVersion: current.version, fields, people, stages, records, histories, tasks:(await readTasks(c,projectId)).tasks, statusEntries: projectStatusEntries(fields.statusDesc ?? '', statusChanges, baseline?.entries), ...(mark ? { lastCheckAt: mark.value } : {}) };
}

const recordColumns: Record<ImportRecordKind, Record<string, string>> = {
  project_node: { title: 'title', stage: 'stage_id', targetDate: 'target_date', completedOn: 'completed_on', output: 'output', previousNodeId: 'previous_node_id', nextNodeId: 'next_node_id', x: 'x', y: 'y' },
  customer_node: { title: 'title', targetDate: 'target_date', completedOn: 'completed_on', note: 'note' },
  risk: { content: 'content', level: 'level', resolved: 'resolved', resolution: 'resolution', resolvedAt: 'resolved_at', createdAt: 'created_at' },
  change: { source: 'source', content: 'content', decision: 'decision', reason: 'reason', createdAt: 'created_at' },
  schedule: { kind: 'kind', oldDate: 'old_date', newDate: 'new_date', reason: 'reason', measures: 'measures', createdAt: 'created_at' },
};
const recordTables: Record<ImportRecordKind, string> = { project_node: 'project_nodes', customer_node: 'project_nodes', risk: 'project_risks', change: 'project_changes', schedule: 'schedule_changes' };
const recordDefaults: Record<ImportRecordKind, Record<string, unknown>> = {
  project_node: { title: '', stage: null, targetDate: null, completedOn: null, output: '', previousNodeId: null, nextNodeId: null, x: null, y: null },
  customer_node: { title: '', targetDate: null, completedOn: null, note: '' },
  risk: { content: '', level: '', resolved: false, resolution: '', resolvedAt: null, createdAt: null },
  change: { source: '', content: '', decision: '', reason: '', createdAt: null },
  schedule: { kind: 'note', oldDate: null, newDate: null, reason: '', measures: '', createdAt: null },
};
function text(value: unknown, field: string, required = false, max = 65535) {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > max || required && !value.trim()) failure('INVALID_PROJECT_FIELDS', 422, { fields: { [field]: '请核对有效文字' } });
}
// 无时区旧文字只冻结在采用来源中；不能把本地文字假定成UTC。
function sourceTime(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') failure('INVALID_IMPORT_TIME', 422);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString().slice(0, 23).replace('T', ' ');
}
function validateProjectFacts(before: ImportProjectInput | null, input: ImportProjectInput, next: ImportProjectFields, facts: ImportStage[], today: string) {
  const fields = input.fields ?? {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ordinaryKeys().has(key) && !own(factColumns, key)) failure('INVALID_IMPORT_FIELDS', 400);
    if (own(dateColumns, key) && value !== null && !validDate(value)) failure('INVALID_PROJECT_DATE', 422, { fields: { [key]: '请纠正日期或明确改为未知' } });
  }
  if (!['proposal', 'ongoing', 'paused', 'closed'].includes(next.status ?? '')) failure('INVALID_IMPORT_STATE', 422);
  for (const key of ['resumeStatus', 'preCloseStatus'] as const) if (next[key] !== null && next[key] !== undefined && !['proposal', 'ongoing', ...(key === 'preCloseStatus' ? ['paused'] : [])].includes(next[key]!)) failure('INVALID_IMPORT_STATE', 422);
  if (next.closureType != null && !['normal', 'terminated'].includes(next.closureType)) failure('INVALID_IMPORT_CLOSURE', 422);
  if (own(fields, 'maintenanceEnabled') && typeof fields.maintenanceEnabled !== 'boolean') failure('INVALID_IMPORT_FIELDS', 400);
  for (const key of ['closureNote', 'remainingWorkNote'] as const) if (own(fields, key)) text(fields[key], key);
  if (next.maintenanceEnabled && next.status !== 'closed') failure('INVALID_IMPORT_CLOSURE', 422, { fields: { maintenanceEnabled: '量产维护须属于已结案项目' } });
  const validateSequence = !before || !!input.stages?.some(stage => ['state', 'startedOn', 'completedOn'].some(key => own(stage, key))) || own(fields, 'status');
  if (validateSequence && !validSequence(facts as StageFact[])) {
    const first = facts.findIndex(stage => stage.state !== 'completed'), blocked = facts.slice(first + 1).find(stage => stage.state !== 'locked');
    const cause = blocked ? `“${stageName(blocked.code)}”拟变为${stageStateName(blocked.state)}，但前面的“${stageName(facts[first].code)}”仍为${stageStateName(facts[first].state)}` : `“${stageName(facts[first]?.code ?? '')}”不能成为当前有效阶段`;
    const consequence = '请核对并明确选择前置阶段及相关状态，或取消本次阶段变化；所选信息尚未写入。';
    failure('STAGE_SEQUENCE_REVIEW_REQUIRED', 422, { fields: { stages: cause + '。' + consequence }, cause, consequence });
  }
  if (validateSequence && next.status === 'proposal' && facts.slice(1).some(stage => ['active', 'completed'].includes(stage.state ?? ''))) failure('PROJECT_START_REQUIRED', 422, { fields: { status: '项目仍为提案中，但已有后续阶段开始或完成；请一起核对项目状态或取消相应阶段变化' } });
  if (new Set((input.stages ?? []).map(stage => stage.code)).size !== (input.stages ?? []).length) failure('INVALID_IMPORT_STAGE', 400);
  for (const fact of input.stages ?? []) {
    if (!/^S[1-7]$/.test(fact.code) || Object.keys(fact).some(key => !['code', 'state', 'plannedDays', 'note', 'startedOn', 'completedOn', 'expectedEndOn'].includes(key))) failure('INVALID_IMPORT_STAGE', 400);
    if (fact.plannedDays != null && (!Number.isInteger(fact.plannedDays) || fact.plannedDays < 0 || fact.plannedDays > 65535)) failure('INVALID_IMPORT_STAGE', 422);
    if (own(fact, 'note')) text(fact.note, 'stage.' + fact.code + '.note');
    for (const key of ['startedOn', 'completedOn', 'expectedEndOn'] as const) if (own(fact, key) && fact[key] !== null && !validDate(fact[key])) failure('INVALID_STAGE_DATE', 422);
  }
  if (validateSequence) for (const [index, fact] of facts.entries()) {
    const cause = fact.startedOn && fact.startedOn > today ? `“${stageName(fact.code)}”实际开始日 ${fact.startedOn} 晚于今天` : fact.completedOn && fact.completedOn > today ? `“${stageName(fact.code)}”实际完成日 ${fact.completedOn} 晚于今天`
      : fact.startedOn && fact.completedOn && fact.startedOn > fact.completedOn ? `“${stageName(fact.code)}”实际开始日 ${fact.startedOn} 晚于完成日 ${fact.completedOn}`
      : ['ready', 'locked'].includes(fact.state ?? '') && (fact.startedOn || fact.completedOn) ? `“${stageName(fact.code)}”拟为${stageStateName(fact.state)}，但仍带有实际开始或完成日期`
      : fact.state === 'active' && fact.completedOn ? `“${stageName(fact.code)}”拟为进行中，但仍带有实际完成日 ${fact.completedOn}`
      : index > 0 && fact.startedOn && facts[index - 1].completedOn && fact.startedOn < facts[index - 1].completedOn! ? `“${stageName(fact.code)}”开始日 ${fact.startedOn} 早于前阶段“${stageName(facts[index - 1].code)}”完成日 ${facts[index - 1].completedOn}` : null;
    if (cause) { const consequence = '请纠正这处日期或状态；无法确认的原日期可明确为未知后再采用。'; failure('INVALID_STAGE_DATE', 422, { fields: { ['stage.' + fact.code]: cause + '。' + consequence }, cause, consequence }); }
  }
  if (!before || validateSequence || Object.keys(fields).some(key => own(dateColumns, key) || key === 'status')) {
    const future = (['startDate', 'filingDate', 'closedOn'] as const).find(key => next[key] && next[key]! > today);
    const later = next.closedOn && [{ name: '项目实际启动', date: next.startDate }, ...facts.flatMap(f => [{ name: stageName(f.code) + '实际开始', date: f.startedOn }, { name: stageName(f.code) + '实际完成', date: f.completedOn }])].find(fact => fact.date && fact.date > next.closedOn!);
    const cause = future ? `${({ startDate: '实际启动', filingDate: '立案', closedOn: '实际结案' })[future]}日期 ${next[future]} 晚于今天` : later ? `${later.name}日 ${later.date} 晚于实际结案日 ${next.closedOn}` : null;
    if (cause) { const consequence = '请纠正冲突日期；原日期无法确认时可明确为未知。此次所选信息均未写入。'; failure('INVALID_PROJECT_DATE', 422, { fields: { [future ?? 'closedOn']: cause + '。' + consequence }, cause, consequence }); }
  }
  if (before) {
    const rank = ['locked', 'ready', 'active', 'completed'];
    const backwards = facts.some(f => rank.indexOf(f.state ?? '') < rank.indexOf(before.stages?.find(old => old.code === f.code)?.state ?? ''));
    const reopening = before.fields?.status === 'closed' && next.status !== 'closed';
    if (backwards || reopening) {
      if (!input.intent || !['correction', ...(reopening ? ['reopen'] : ['rework'])].includes(input.intent.kind) || !input.intent.reason.trim()) {
        const cause = reopening ? '拟将已结案项目改为' + (Object.entries(stateNames).find(([, state]) => state === next.status)?.[0] ?? next.status) : facts.filter(f => rank.indexOf(f.state ?? '') < rank.indexOf(before.stages?.find(old => old.code === f.code)?.state ?? '')).map(f => `“${stageName(f.code)}”将回到${stageStateName(f.state)}`).join('；');
        const consequence = '请明确这是误录纠正还是实际返工／重开，并说明原因；原有历史继续保留。';
        failure('IMPORT_STATE_INTENT_REQUIRED', 422, { fields: { intent: cause + '。' + consequence }, cause, consequence });
      }
      if (input.intent.kind === 'rework') {
        const index = facts.findIndex((f, i) => f.state !== before.stages?.[i]?.state);
        if (!['proposal', 'ongoing'].includes(before.fields?.status ?? '') || before.stages?.[index]?.state !== 'completed' || facts[index]?.state !== 'ready' || facts.slice(index).some((f, offset) => f.state !== (offset ? 'locked' : 'ready') || f.startedOn || f.completedOn)) failure('IMPORT_REWORK_IMPACT_REQUIRED', 422, { fields: { stages: '真实回退须明确采用目标待开始、后续未解锁及对应实际日期清空' } });
      }
      if (input.intent.kind === 'reopen' && (next.status !== before.fields?.preCloseStatus || next.maintenanceEnabled || next.closedOn || next.closureType || next.closureDueDate || next.closureNote || next.remainingWorkNote || next.preCloseStatus)) failure('IMPORT_REOPEN_IMPACT_REQUIRED', 422, { fields: { status: '重开须采用原结案前状态，并明确处理结案事实与维护状态' } });
      if (reopening && (next.maintenanceEnabled || next.closedOn || next.closureType || next.closureDueDate || next.closureNote || next.remainingWorkNote || next.preCloseStatus)) failure('IMPORT_REOPEN_IMPACT_REQUIRED', 422, { fields: { status: '改为未结案时，请明确一并处理当前结案事实和维护标识；原结案历史继续保留' } });
    }
  }
}

function recordCandidate(before: ImportProjectInput | null, input: ImportProjectInput, today: string, context: ImportProjectContext) {
  const suggestedKey = (record: ImportRecord, accepts: (candidate: ImportRecord) => boolean) => {
    const candidate = context.candidateRecords?.find(value => value.kind === record.kind && (record.targetId ? value.targetId === record.targetId : value.key === record.key));
    return candidate && accepts(candidate) ? context.selectionKeys?.[record.kind + ':' + (record.targetId ?? record.key)] : undefined;
  };
  const all = new Map((before?.records ?? []).map(row => [row.kind + ':' + row.targetId, structuredClone(row)]));
  const touched: { request: ImportRecord; before: ImportRecord | null; after: ImportRecord }[] = [], seen = new Set<string>();
  for (const record of input.records ?? []) {
    if (!object(record) || !own(recordTables, record.kind) || typeof record.key !== 'string' || !record.key || !object(record.values) || record.targetId === undefined) failure('IMPORT_RECORD_TARGET_REQUIRED', 422, { fields: { ['record.' + record.key]: '请确定新增或对应当前项目的记录' } });
    if (record.targetId !== null && !validId(record.targetId) || seen.has(record.key) || Object.keys(record.values).some(key => !own(recordColumns[record.kind], key))) failure('INVALID_IMPORT_RECORD', 400);
    seen.add(record.key);
    const key = record.kind + ':' + (record.targetId ?? record.key), old = record.targetId ? all.get(key) : undefined;
    if (record.targetId && !old) failure('IMPORT_RECORD_NOT_FOUND', 422, { fields: { ['record.' + record.key]: '对应记录不属于当前项目或已删除' } });
    if (touched.some(item => item.request.kind === record.kind && record.targetId && item.request.targetId === record.targetId)) failure('IMPORT_DUPLICATE_TARGET', 422);
    const next = { ...record, values: { ...recordDefaults[record.kind], ...old?.values, ...record.values } };
    const v = next.values;
    for (const [field, value] of Object.entries(v)) {
      const path = 'record.' + record.key + '.' + field;
      if (['title', 'content', 'output', 'note', 'resolution', 'reason', 'measures'].includes(field)) text(value, path, ['title', 'content'].includes(field), field === 'title' ? 1020 : 65535);
      if (field === 'title' && typeof value === 'string' && [...value].length > 255) failure('INVALID_IMPORT_RECORD', 422);
      if (['targetDate', 'completedOn', 'oldDate', 'newDate'].includes(field) && value !== null && !validDate(value)) failure('INVALID_PROJECT_DATE', 422, { fields: { [path]: '请纠正日期或明确改为未知' } });
      if (field === 'completedOn' && typeof value === 'string' && value > today) failure('INVALID_PROJECT_DATE', 422, { fields: { [path]: '实际完成日期不能晚于今天' } });
      if (field === 'stage' && value !== null && (typeof value !== 'string' || !/^S[1-7]$/.test(value))) failure('NODE_STAGE_INVALID', 422);
      if (field === 'x' || field === 'y') if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 999999999.999 || Math.abs(Math.round(value * 1000) / 1000 - value) > 1e-7)) failure('INVALID_IMPORT_RECORD', 422);
      if (field === 'level' && !['high', 'mid', 'low'].includes(value as string) || field === 'source' && !['客户', '业务'].includes(value as string) || field === 'decision' && !['accept', 'reject'].includes(value as string) || field === 'resolved' && typeof value !== 'boolean' || field === 'kind' && !['reschedule', 'note'].includes(value as string)) failure('INVALID_IMPORT_RECORD', 422, { fields: { [path]: '请选择有效选项' } });
      if (field === 'createdAt' || field === 'resolvedAt') sourceTime(value);
    }
    if (record.kind === 'schedule' && !own(record.values, 'kind') && !old) v.kind = v.newDate ? 'reschedule' : 'note';
    if (record.kind === 'risk' && !v.resolved && (v.resolution || v.resolvedAt) && (!old || ['resolved', 'resolution', 'resolvedAt'].some(key => own(record.values, key) && record.values[key] !== old.values[key]))) failure('IMPORT_RISK_STATE_CONFLICT', 422, { fields: { ['record.' + record.key]: '未解除的风险不能同时保留解除事实，请一起核对解除状态、说明和时间' } });
    if (record.kind === 'project_node' && !v.stage) failure('NODE_STAGE_INVALID', 422);
    if (old && ((record.kind === 'risk' && old.values.resolved && !v.resolved) || ['project_node', 'customer_node'].includes(record.kind) && old.values.completedOn && !v.completedOn) && !input.intent?.reason?.trim()) failure('IMPORT_CORRECTION_REASON_REQUIRED', 422, { fields: { ['record.' + record.key]: '请说明撤销完成或解除的原因' } });
    all.set(key, next); touched.push({ request: record, before: old ?? null, after: next });
  }
  const nodes = new Map<string, ImportRecord>();
  for (const row of all.values()) if (row.kind === 'project_node') nodes.set(row.targetId ?? row.key, row);
  const sourceNodes = new Map((input.records ?? []).filter(row => row.kind === 'project_node' && row.sourceKey).map(row => [row.sourceKey!, row.targetId ?? row.key]));
  for (const item of touched.filter(item => item.request.kind === 'project_node')) for (const field of ['previousNodeId', 'nextNodeId']) {
    const value = item.after.values[field];
    if (typeof value === 'string' && value.startsWith('source:')) {
      const target = sourceNodes.get(value.slice(7));
      if (!target) {
        const cause = `“${item.after.values.title}”的${field === 'previousNodeId' ? '前置' : '后续'}连线指向尚未对应的来源节点 ${value.slice(7)}`;
        const consequence = '请同时采用所关联节点，或先确定其现有对应，再保存这组连线。';
        const candidate = context.candidateRecords?.find(record => record.kind === 'project_node' && record.sourceKey === value.slice(7)), key = candidate && context.selectionKeys?.['project_node:' + (candidate.targetId ?? candidate.key)];
        failure('IMPORT_NODE_REFERENCE_REQUIRED', 422, { fields: { ['record.' + item.request.key + '.' + field]: cause + '。' + consequence }, cause, consequence, requiredKeys: key ? [key] : [] });
      }
      item.after.values[field] = target;
    } else if (value !== null && typeof value !== 'string') failure('INVALID_IMPORT_RECORD', 400);
  }
  const graph = touched.filter(item => item.request.kind === 'project_node' && (!item.before || ['completedOn', 'previousNodeId', 'nextNodeId'].some(key => own(item.request.values, key) && item.before!.values[key] !== item.after.values[key]))).map(item => item.after.targetId ?? item.after.key);
  const scope = new Set<string>(), queue = [...graph];
  for (const id of queue) {
    if (scope.has(id)) continue; scope.add(id);
    const row = nodes.get(id);
    if (!row) failure('NODE_RELATION_INVALID', 422);
    for (const field of ['previousNodeId', 'nextNodeId']) if (row.values[field]) {
      const neighbor = String(row.values[field]); if (!scope.has(neighbor)) queue.push(neighbor);
    }
  }
  for (const id of scope) {
    const row = nodes.get(id)!, v = row.values, previous = v.previousNodeId ? nodes.get(String(v.previousNodeId)) : undefined, next = v.nextNodeId ? nodes.get(String(v.nextNodeId)) : undefined;
    if (previous && previous.values.nextNodeId !== id || next && next.values.previousNodeId !== id) {
      const neighbor = previous && previous.values.nextNodeId !== id ? previous : next!;
      const cause = `“${v.title}”与“${neighbor.values.title}”的前后连线两端不一致`, consequence = '请明确采用两端一致的连线，或取消这次连线变化。';
      const key = suggestedKey(neighbor, candidate => candidate.values[previous === neighbor ? 'nextNodeId' : 'previousNodeId'] === id);
      failure('NODE_RELATION_INVALID', 422, { fields: { nodes: cause + '。' + consequence }, cause, consequence, requiredKeys: key ? [key] : [] });
    }
    if (v.completedOn && previous && !previous.values.completedOn) {
      const undo = touched.some(item => (item.after.targetId ?? item.after.key) === (previous.targetId ?? previous.key) && item.before?.values.completedOn && !item.after.values.completedOn);
      const cause = undo ? `撤销“${previous.values.title}”完成后，依赖它的“${v.title}”仍已完成` : `“${v.title}”拟完成，但前置“${previous.values.title}”尚未完成`;
      const consequence = undo ? '请明确将受影响的后续节点一并纠正为未完成，或取消前置节点的撤销。' : '请选择前置的合法完成信息，或取消当前完成变化。';
      const key = undo ? suggestedKey(row, candidate => candidate.values.completedOn === null) : suggestedKey(previous, candidate => validDate(candidate.values.completedOn) && (candidate.values.completedOn as string) <= today);
      failure('NODE_PREDECESSOR_INCOMPLETE', 422, { fields: { ['record.' + row.key]: cause + '。' + consequence }, cause, consequence, requiredKeys: key ? [key] : [] });
    }
    const visited = new Set<string>(); let cursor: string | null = id;
    while (cursor) { if (visited.has(cursor)) { const cause = '节点连线形成循环：' + [...visited, cursor].map(key => nodes.get(key)?.values.title ?? '未对应节点').join(' → '), consequence = '请明确拆开其中的连线，保持前后两端一致后再保存。'; failure('NODE_CYCLE', 422, { fields: { nodes: cause + '。' + consequence }, cause, consequence }); } visited.add(cursor); cursor = nodes.get(cursor)?.values.nextNodeId as string | null; }
  }
  return touched;
}

export function importHistoryManifest(histories: ImportHistories = {}) {
  const result: Partial<Record<keyof ImportHistories, { hash: string; count: number }>> = {};
  for (const [kind, values] of Object.entries(histories)) {
    if (!['mixed', 'status_description'].includes(kind) || !Array.isArray(values)) failure('INVALID_IMPORT_HISTORY', 400);
    for (const row of values) { if (!object(row) || Object.keys(row).some(key => !['date', 'text'].includes(key))) failure('INVALID_IMPORT_HISTORY', 400); text(row.date, 'history.date'); text(row.text, 'history.text'); }
    result[kind as keyof ImportHistories] = { hash: createHash('sha256').update(JSON.stringify([kind, values.map(({ date, text }) => [date, text])])).digest('hex'), count: values.length };
  }
  return result;
}
export async function writeImportHistory(c: PoolConnection, adoptionId: string, projectId: string, itemId: string, histories: ImportHistories = {}) {
  importHistoryManifest(histories);
  for (const [kind, entries] of Object.entries(histories)) for (const [sequence, entry] of entries.entries()) await c.execute('INSERT INTO legacy_project_history (project_id,source_import_item_id,source_adoption_id,history_kind,legacy_source_namespace,source_sequence,source_date_text,body) VALUES (?,?,?,?,NULL,?,?,?)', [projectId, itemId, adoptionId, kind, sequence, entry.date, entry.text]);
}

async function prepareImportProject(c: PoolConnection, actor: Actor, input: ImportProjectInput, context: ImportProjectContext, locked: LockedImportProject) {
  const now = context.now ?? new Date(), today = businessToday(now), timestamp = now.toISOString().slice(0, 23).replace('T', ' ');
  let id = input.projectId;
  if (id && (!locked.current || locked.current.id !== id)) failure('IMPORT_PROJECT_LOCK_REQUIRED', 500);
  if (id) {
    if (!(await rows(c, 'SELECT user_id FROM project_responsibilities WHERE project_id=? AND user_id=?', [id, actor.id])).length) failure('PROJECT_READ_ONLY', 403);
    if (locked.current!.version !== input.expectedVersion) failure('PROJECT_VERSION_CONFLICT', 409, { currentVersion: locked.current!.version });
  }
  const before = id ? await readImportProject(c, id, context.sourceNamespace) : null;
  const defaults: ImportProjectFields = { name: '', summary: '', marketExpectation: '', detailNote: '', summaryNote: '', chipstatNote: '', signalNote: '', statusDesc: '', priority: 'mid', signal: 'green', status: 'proposal', proposalDate: null, filingDate: null, startDate: null, dueDate: null, originalDueDate: null, closedOn: null, closureDueDate: null, closureType: null, closureNote: '', remainingWorkNote: '', resumeStatus: null, preCloseStatus: null, maintenanceEnabled: false, customerIds: [], odmFactoryIds: [], productLineIds: [], appIds: [], groupIds: [], chipSelections: [], tagIds: [] };
  const next = { ...defaults, ...before?.fields, ...input.fields };
  let tasks:ProjectTask[]|undefined;
  if(input.tasks!==undefined){
    const incoming=sourceTasks(input.tasks);tasks=[...(before?.tasks??[]).filter(old=>!incoming.some(task=>task.id===old.id)),...incoming];
    next.statusDesc=taskDescription(tasks);
  } else if(id&&own(input.fields??{},'statusDesc')&&(await readTasks(c,id)).unified){
    tasks=(await taskCandidate(c,id,textTaskOperations(before?.tasks??[],next.statusDesc??''),now.toISOString())).after;next.statusDesc=taskDescription(tasks);
  }
  const tasksChanged=tasks!==undefined&&JSON.stringify(tasks)!==JSON.stringify(before?.tasks??[]);
  const ordinary = Object.fromEntries(Object.entries(input.fields ?? {}).filter(([key]) => ordinaryKeys().has(key))) as SaveRequest['changes'];
  if (!id && !next.name?.trim()) failure('INVALID_PROJECT_FIELDS', 422, { fields: { name: '请填写项目名称' } });
  if(next.name&&(await rows(c,'SELECT id FROM projects WHERE name_key=? AND id<>?',[projectNameKey(next.name),id??'0'])).length)failure('PROJECT_NAME_TAKEN',409,{fields:{name:'已有同名项目，请重新核对项目名称。'}});
  if (Object.keys(ordinary).length) validateSave({ changes: ordinary, expectedVersion: '1', idempotencyKey: context.operationKey });
  const people = { ...before?.people, ...input.people };
  if (input.people) {
    if (Object.keys(input.people).some(role => !['pm', 'hardware_owner', 'software_owner', 'participant'].includes(role))) failure('INVALID_IMPORT_PEOPLE', 400);
    ordinary.people = Object.entries(people).flatMap(([role, ids]) => (ids ?? []).map(id => ({ id, role })));
    validateSave({ changes: { people: ordinary.people }, expectedVersion: '1', idempotencyKey: context.operationKey });
  }
  for (const [key, table] of Object.entries(referenceFields)) if (own(ordinary, key)) {
    const values = key === 'chipSelections' ? ordinary.chipSelections!.map(item => item.chipId) : key === 'people' ? ordinary.people!.map(v => v.id) : Array.isArray(ordinary[key as keyof typeof ordinary]) ? ordinary[key as keyof typeof ordinary] as string[] : ordinary[key as keyof typeof ordinary] ? [ordinary[key as keyof typeof ordinary] as string] : [];
    const previous = key === 'chipSelections' ? before?.fields?.chipSelections?.map(item => item.chipId) : key === 'people' ? Object.values(before?.people ?? {}).flat() : before?.fields?.[key as keyof ImportProjectFields];
    for (const target of values) {
      if (key === 'people' && !Object.values(input.people ?? {}).flat().includes(target)) continue;
      const ref = locked.references[table]?.find(row => row.id === target);
      const retained = key === 'people' ? Object.entries(input.people ?? {}).filter(([, ids]) => ids?.includes(target)).every(([role]) => before?.people?.[role as ImportRole]?.includes(target)) : Array.isArray(previous) ? (previous as unknown[]).includes(target) : previous === target;
      if (!ref || !ref.enabled && !retained) failure('INVALID_PROJECT_FIELDS', 422, { fields: { [key]: '资料已停用或不存在，请重新核对' } });
    }
  }
  const baseStages = before?.stages ?? Array.from({ length: 7 }, (_, i): ImportStage => ({ code: 'S' + (i + 1), state: i ? 'locked' : 'unknown', plannedDays: null, note: '', startedOn: null, completedOn: null, expectedEndOn: null }));
  if (new Set((input.stages ?? []).map(v => v.code)).size !== (input.stages ?? []).length) failure('INVALID_IMPORT_STAGE', 400);
  const stageFacts = baseStages.map(stage => ({ ...stage, ...input.stages?.find(v => v.code === stage.code) }));
  validateProjectFacts(before, input, next, stageFacts, today);
  const recordChanges = recordCandidate(before, input, today, context);
  const historyManifest = importHistoryManifest(input.histories);
  const previousManifest = importHistoryManifest(before?.histories);
  const historyChanged = Object.entries(historyManifest).some(([kind, value]) => value.hash !== previousManifest[kind as keyof ImportHistories]?.hash);
  const changedFields = [...new Set([...Object.keys(input.fields ?? {}),...tasks?['statusDesc']:[]])].filter(key => JSON.stringify(before?.fields?.[key as keyof ImportProjectFields] ?? defaults[key as keyof ImportProjectFields]) !== JSON.stringify(next[key as keyof ImportProjectFields]));
  const changedRoles = Object.keys(input.people ?? {}).filter(role => JSON.stringify(before?.people?.[role as ImportRole] ?? []) !== JSON.stringify(people[role as ImportRole]));
  const changedStages = stageFacts.filter((stage, index) => JSON.stringify(stage) !== JSON.stringify(baseStages[index]));
  const changedRecords = recordChanges.filter(item => !item.before || JSON.stringify(item.before.values) !== JSON.stringify(item.after.values));
  let oldSource: Record<string, unknown> = {};
  if (id) oldSource = json((await rows(c, "SELECT adopted_json data FROM import_adoptions WHERE target_kind='project' AND target_id=? AND source_namespace=? AND JSON_CONTAINS_PATH(adopted_json,'one','$.lastCheckAt') ORDER BY id DESC LIMIT 1", [id, context.sourceNamespace]))[0]?.data ?? {});
  const sourceChanged = own(input, 'lastCheckAt') && JSON.stringify(oldSource.lastCheckAt) !== JSON.stringify(input.lastCheckAt);
  const changed = !id || !!(changedFields.length || changedRoles.length || changedStages.length || changedRecords.length || historyChanged || sourceChanged || tasksChanged);
  const beforeVersion: string | null = locked.current?.version ?? null;
  if (changed && beforeVersion === '18446744073709551615') failure('PROJECT_VERSION_EXHAUSTED', 422);
  const savedVersion = beforeVersion ? String(BigInt(beforeVersion) + (changed ? 1n : 0n)) : '1';
  return { before, next, tasks, tasksChanged, ordinary, people, baseStages, stageFacts, recordChanges, changedRecords, historyManifest, historyChanged, sourceChanged, changedFields, changedRoles, changedStages, changed, beforeVersion, savedVersion, timestamp };
}

export async function validateImportProject(c: PoolConnection, actor: Actor, input: ImportProjectInput, context: ImportProjectContext, current?: LockedImportProject) {
  const candidate = await prepareImportProject(c, actor, input, context, current ?? await lockImportProject(c, input, false));
  const effects: ImportEffect[] = [];
  for (const stage of candidate.changedStages) {
    const prior = candidate.baseStages.find(value => value.code === stage.code)!;
    if (stage.state !== prior.state) effects.push({ cause: `“${stageName(stage.code)}”由${stageStateName(prior.state)}改为${stageStateName(stage.state)}`,
      consequence: `详情与项目卡片将使用这份阶段结果；${candidate.stageFacts.filter(value => value.state === 'ready' || value.state === 'active' || value.state === 'unknown').map(value => `当前“${stageName(value.code)}”为${stageStateName(value.state)}`).join('；') || '当前七个阶段均已完成'}。` });
  }
  const beforeNodes = candidate.before?.records?.filter(record => record.kind === 'project_node') ?? [];
  const nextNodes = new Map(beforeNodes.map(record => [record.targetId ?? record.key, record]));
  for (const item of candidate.changedRecords.filter(item => item.request.kind === 'project_node')) {
    const beforeValue = item.before?.values, value = item.after.values;
    nextNodes.set(item.after.targetId ?? item.after.key, item.after);
    if (beforeValue?.completedOn !== value.completedOn && (beforeValue?.completedOn || value.completedOn)) effects.push({ cause: `“${value.title}”${value.completedOn ? '完成日期改为 ' + value.completedOn : '纠正为未完成'}`,
      consequence: value.completedOn ? '该节点从项目状态简要的未完成节点中移出；节点列表与 Flow 同时显示已完成。' : '该节点重新出现在项目状态简要的未完成节点中；节点列表与 Flow 同时显示未完成。' });
    if (['previousNodeId', 'nextNodeId'].some(key => (beforeValue?.[key] ?? null) !== value[key])) {
      const label = (id: unknown) => !id ? '无' : candidate.recordChanges.find(item => (item.after.targetId ?? item.after.key) === id)?.after.values.title ?? beforeNodes.find(record => record.targetId === id)?.values.title ?? '对应节点';
      effects.push({ cause: `“${value.title}”的连线变为“${label(value.previousNodeId)} → ${value.title} → ${label(value.nextNodeId)}”`, consequence: '节点列表与 Flow 使用同一条连线；后续完成时按这份前置关系校验。' });
    }
  }
  const latestTarget = (records: ImportRecord[], code: string) => records.filter(record => record.values.stage === code && typeof record.values.targetDate === 'string').map(record => record.values.targetDate as string).sort().at(-1) ?? null;
  for (const stage of candidate.stageFacts) {
    const prior = latestTarget(beforeNodes, stage.code), next = latestTarget([...nextNodes.values()], stage.code);
    if (prior !== next) effects.push({ cause: `“${stageName(stage.code)}”下节点的最晚目标日由${prior ?? '待确定'}改为${next ?? '待确定'}`, consequence: `阶段预计完成日期将同步显示${next ?? '待确定'}。` });
  }
  if (candidate.changedFields.includes('status')) effects.push({ cause: `项目状态改为${Object.entries(stateNames).find(([, state]) => state === candidate.next.status)?.[0] ?? candidate.next.status}`,
    consequence: '首页分类、详情及项目状态简要同步使用该状态；之前的状态记录继续保留。' });
  for (const kind of Object.keys(input.histories ?? {}) as (keyof ImportHistories)[]) if (candidate.historyManifest[kind]?.hash !== importHistoryManifest(candidate.before?.histories)[kind]?.hash) effects.push({
    cause: `采用本来源完整${kind === 'mixed' ? '更新历史' : '状态说明历史'}，由${candidate.before?.histories?.[kind]?.length ?? 0}条改为${input.histories![kind]!.length}条`, consequence: '原有记录区默认展示这份完整版本，旧版本仍可在原位置选择查看；最新状态说明正文保持本次明确选择的结果。' });
  return { projectId: input.projectId ?? null, beforeVersion: candidate.beforeVersion, savedVersion: candidate.savedVersion, changed: candidate.changed,
    before: candidate.before, after: { fields: candidate.next, people: candidate.people, stages: candidate.stageFacts, records: candidate.recordChanges.map(v => v.after), tasks:candidate.tasks, histories: input.histories },
    changedFields: candidate.changedFields, changedRoles: candidate.changedRoles, changedStages: candidate.changedStages.map(v => v.code), historyChanged: candidate.historyChanged, sourceChanged: candidate.sourceChanged, effects };
}

export async function applyImportProject(c: PoolConnection, actor: Actor, input: ImportProjectInput, context: ImportProjectContext, locked: LockedImportProject) {
  const { before, next, tasks, tasksChanged, ordinary, baseStages, stageFacts, recordChanges, changedRecords, historyManifest, changedFields, changedRoles, changedStages, changed, beforeVersion, savedVersion, timestamp } = await prepareImportProject(c, actor, input, context, locked);
  let id = input.projectId;
  if (!id) {
    await c.query("INSERT INTO projects (name,name_key,data_kind,created_by,source_namespace,source_key,source_import_item_id,signal_note,market_expectation,status_description,detail_note,summary_note,chipstat_note,closure_note,remaining_work_note,summary,created_at,updated_at) VALUES (?,?,'business',?,NULL,NULL,?,'','','','','','','','','',?,?)", [next.name, projectNameKey(next.name!), actor.id, context.itemId, timestamp, timestamp]);
    id = (await rows(c, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
    await c.query('INSERT INTO project_responsibilities (project_id,user_id,joined_at) VALUES (?,?,?)', [id, actor.id, timestamp]);
    for (const stage of baseStages) await c.query('INSERT INTO project_stages (project_id,stage_code,state,note) VALUES (?,?,?,?)', [id, stage.code, stage.state, '']);
  }
  if(tasks!==undefined)await writeTasks(c,id!,tasks);
  const childIdMap: Record<string, string> = Object.fromEntries((input.records ?? []).filter(record => record.targetId).map(record => [record.key, record.targetId!]));
  if (changed) {
    const selected = before ? changedFields : Object.keys(next).filter(key => own(columns, key) || own(factColumns, key));
    const scalar = selected.filter(key => own(columns, key) || own(factColumns, key));
    const assignments = scalar.map(key => `\`${(columns as Record<string, string>)[key] ?? (factColumns as Record<string, string>)[key]}\`=?`);
    const params: unknown[] = scalar.map(key => next[key as keyof ImportProjectFields]);
    if (scalar.includes('name')) {
      if (before) await c.query('INSERT INTO project_name_aliases(project_id,name_key) VALUES (?,?) ON DUPLICATE KEY UPDATE project_id=project_id', [id, projectNameKey(before.fields!.name!)]);
      assignments.push('name_key=?'); params.push(projectNameKey(next.name!));
    }
    if (changedFields.includes('statusDesc')) assignments.push('status_description_updated_at=NULL');
    assignments.push('version=?', 'updated_at=?');
    await c.query(`UPDATE projects SET ${assignments.join(',')} WHERE id=?`, [...params, savedVersion, timestamp, id]);
    await replaceLinks(c, id!, ordinary, false);
    for (const stage of (before ? changedStages : stageFacts)) await c.query('UPDATE project_stages SET state=?,planned_days=?,note=?,started_on=?,completed_on=?,expected_end_on=? WHERE project_id=? AND stage_code=?', [stage.state, stage.plannedDays ?? null, stage.note ?? '', stage.startedOn ?? null, stage.completedOn ?? null, stage.expectedEndOn ?? null, id, stage.code]);
    const stageIds = new Map((await rows(c, 'SELECT stage_code code,CAST(id AS CHAR) id FROM project_stages WHERE project_id=?', [id])).map(v => [v.code, v.id]));
    // 先取得本次新节点ID，再写前后连线，避免来源ID误作正式ID。
    for (const item of recordChanges) {
      let target = item.request.targetId;
      if (!target) {
        const kind = item.request.kind, v = item.after.values, table = recordTables[kind];
        if (kind === 'project_node' || kind === 'customer_node') await c.query(`INSERT INTO ${table} (project_id,kind,title,output,note,sort_order,source_key) VALUES (?,?,?,?,?,?,?)`, [id, kind === 'project_node' ? 'project' : 'customer', v.title, v.output ?? '', v.note ?? '', (before?.records?.length ?? 0) + Object.keys(childIdMap).length, item.request.sourceKey]);
        else if (kind === 'risk') await c.query(`INSERT INTO ${table} (project_id,content,level,resolved,resolution,created_at,actor_id,sort_order,source_key) VALUES (?,?,?,?,?,NULL,NULL,?,?)`, [id, v.content, v.level, Number(v.resolved), v.resolution, (before?.records?.length ?? 0) + Object.keys(childIdMap).length, item.request.sourceKey]);
        else if (kind === 'change') await c.query(`INSERT INTO ${table} (project_id,source,content,decision,reason,created_at,actor_id,sort_order,source_key) VALUES (?,?,?,?,?,NULL,NULL,?,?)`, [id, v.source, v.content, v.decision, v.reason, (before?.records?.length ?? 0) + Object.keys(childIdMap).length, item.request.sourceKey]);
        else await c.query(`INSERT INTO ${table} (project_id,kind,reason,measures,created_at,actor_id,source_key) VALUES (?,?,?,?,NULL,NULL,?)`, [id, v.kind, v.reason, v.measures, item.request.sourceKey]);
        target = (await rows(c, 'SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0].id;
      }
      childIdMap[item.request.key] = target!;
    }
    for (const item of changedRecords) {
      const kind = item.request.kind, target = childIdMap[item.request.key], v = item.after.values;
      const keys = Object.keys(recordColumns[kind]);
      const data = keys.map(key => key === 'stage' ? v.stage ? stageIds.get(String(v.stage)) : null : key === 'previousNodeId' || key === 'nextNodeId' ? v[key] ? childIdMap[String(v[key])] ?? v[key] : null : key === 'createdAt' || key === 'resolvedAt' ? sourceTime(v[key]) : key === 'resolved' ? Number(v[key]) : v[key]);
      await c.query(`UPDATE ${recordTables[kind]} SET ${keys.map(key => '\`' + recordColumns[kind][key] + '\`=?').join(',')} WHERE project_id=? AND id=?`, [...data, id, target]);
    }
    const beforeValues: Record<string, unknown> = Object.fromEntries(changedFields.map(key => [key, before?.fields?.[key as keyof ImportProjectFields] ?? null]));
    const afterValues: Record<string, unknown> = Object.fromEntries(changedFields.map(key => [key, next[key as keyof ImportProjectFields]]));
    if (changedRoles.length) { beforeValues.people = Object.entries(before?.people ?? {}).flatMap(([role, ids]) => ids!.map(id => ({ id, role }))); afterValues.people = ordinary.people; }
    if(tasksChanged){beforeValues.tasks=before?.tasks??[];afterValues.tasks=tasks;}
    if (changedStages.length) { beforeValues.stageChanges = baseStages.filter(stage => changedStages.some(v => v.code === stage.code)); afterValues.stageChanges = changedStages; }
    // 来源时间由采用基线提供，审计不冒充旧说明的实际保存时间。
    const beforeDisplay = await displayValues(c, beforeValues), afterDisplay = await displayValues(c, afterValues);
    if (!before || Object.keys(afterDisplay).length) await c.query("INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user','project.import','project',?,?,?,?,?,?,?,?)", [actor.id, actor.name, id, id, beforeVersion, savedVersion, JSON.stringify(beforeDisplay), JSON.stringify(afterDisplay), context.requestId, timestamp]);
    for (const item of changedRecords) {
      const kind = item.request.kind, label = kind === 'project_node' || kind === 'customer_node' ? 'node' : kind === 'schedule' ? 'scheduleRecord' : kind;
      const recordKind = label === 'node' ? { kind: kind === 'customer_node' ? 'customer' : 'project' } : {};
      const savedValues = { ...item.after.values };
      for (const key of ['previousNodeId', 'nextNodeId']) if (savedValues[key]) savedValues[key] = childIdMap[String(savedValues[key])] ?? savedValues[key];
      await c.query("INSERT INTO audit_log (actor_id,actor_display_name,actor_kind,action,entity_type,entity_id,project_id,version_before,version_after,before_json,after_json,request_id,created_at) VALUES (?,?,'user',?,?,?,?,?,?,?,?,?,?)", [actor.id, actor.name, 'project.import.' + kind, kind === 'schedule' ? 'schedule_change' : 'project_' + (label === 'node' ? 'node' : kind), childIdMap[item.request.key], id, beforeVersion, savedVersion, JSON.stringify(item.before ? { [label]: { id: item.request.targetId, ...recordKind, ...item.before.values } } : null), JSON.stringify({ [label]: { id: childIdMap[item.request.key], ...recordKind, ...savedValues } }), context.requestId, timestamp]);
    }
  }
  const bodyChanged = !before || changedFields.includes('statusDesc');
  const statusEntries = bodyChanged && typeof next.statusDesc === 'string' ? next.statusDesc.replace(/\r\n?/g, '\n').split('\n').map((line, index) => ({ text: line, date: input.statusEntries?.[index]?.text === line && typeof input.statusEntries[index].date === 'string' ? input.statusEntries[index].date : '' })) : undefined;
  const closureChanged = !before || changedFields.some(key => ['status', 'closedOn', 'closureType', 'closureDueDate', 'closureNote', 'remainingWorkNote', 'preCloseStatus'].includes(key));
  const adoptedRecords = (input.records ?? []).map(record => {
    const final = recordChanges.find(change => change.request.key === record.key)!.after;
    return { ...record, targetId: childIdMap[record.key] ?? record.targetId, values: Object.fromEntries(Object.keys(record.values).map(key => [key, ['previousNodeId', 'nextNodeId'].includes(key) && final.values[key] ? childIdMap[String(final.values[key])] ?? final.values[key] : final.values[key]])) };
  });
  const adopted = { fields: input.fields ?? {}, ...(input.tasks?{tasks:input.tasks}:{}), ...(input.people ? { people: input.people } : {}), ...(input.stages ? { stages: input.stages } : {}), records: adoptedRecords, ...(input.intent ? { intent: input.intent } : {}), ...(statusEntries ? { statusEntries, statusDescriptionBaseline: next.statusDesc } : {}), ...(own(input, 'lastCheckAt') ? { lastCheckAt: input.lastCheckAt } : {}), ...(closureChanged ? { effectiveClosure: { status: next.status, preCloseStatus: next.preCloseStatus, closedOn: next.closedOn, closureDueDate: next.closureDueDate, closureType: next.closureType, closureNote: next.closureNote, remainingWorkNote: next.remainingWorkNote, maintenanceEnabled: next.maintenanceEnabled, planKnown: own(input.fields ?? {}, 'closureDueDate') ? next.closureDueDate != null : before?.fields?.status === 'closed' ? !!(await rows(c, `SELECT ${closurePlanKnownExpression} known FROM projects p WHERE p.id=?`, [id]))[0].known : false } } : {}) };
  return { projectId: id!, beforeVersion, savedVersion, changed, childIdMap, adopted, historyManifest, histories: input.histories ?? {}, changedFields, changedRoles, changedStages: changedStages.map(v => v.code) };
}
