import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { riskRows, nodeRows } from './project-records.js';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { stageBlock, startProjectBlock, type StageFact } from './project-actions.js';
import { businessToday, checkContext, closurePlanKnownExpression, dayDifference, deadlineCondition, deadlineKinds, deadlineResult, type DateFacts, type DeadlineKind } from './project-dates.js';
import { scheduleRecords } from './project-plans.js';
import { currentClosure } from './project-closures.js';
import { lifecycleNotes } from './project-lifecycle.js';
import { checkConditions, enrichChecks } from './project-checks.js';

// V1.050 的阶段名称、完成权重和里程碑；查询不自动改变业务状态。
export const stages = [
  { code: 'S1', name: '需求立项', progress: 5 },
  { code: 'S2', name: '项目预启动', progress: 10 },
  { code: 'S3', name: 'PEVT技术预研', progress: 20 },
  { code: 'S4', name: 'EVT集成验证', progress: 60 },
  { code: 'S5', name: 'DVT可靠性验证', progress: 80 },
  { code: 'S6', name: 'PVT量产验证', progress: 90 },
  { code: 'S7', name: 'MP量产维护', progress: 100 },
];
export type ProjectQuery = Partial<Record<'view' | 'search' | 'customer' | 'productLine' | 'odmFactory' | 'app' | 'group' | 'status' | 'priority' | 'signal' | 'stage' | 'progress' | 'chip' | 'tags' | 'owner', string>> & { deadline?: DeadlineKind; page?: number; pageSize?: number };

async function rows(connection: PoolConnection, sql: string, values: unknown[] = []) {
  return (await connection.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0];
}
const joins = `FROM projects p
 LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN customers odm ON odm.id=p.odm_customer_id
 LEFT JOIN product_lines pl ON pl.id=p.product_line_id LEFT JOIN apps a ON a.id=p.app_id
 LEFT JOIN project_groups g ON g.id=p.group_id`;
const columns = `CAST(p.id AS CHAR) id, CAST(p.version AS CHAR) version, p.data_kind dataKind, p.name, p.status, p.priority, p.signal,
 c.name customer, odm.name odmFactory, pl.name productLine, a.name app, g.name projectGroup,
 DATE_FORMAT(p.proposed_on,'%Y-%m-%d') proposalDate, DATE_FORMAT(p.current_due_date,'%Y-%m-%d') dueDate,
 DATE_FORMAT(p.closed_on,'%Y-%m-%d') closedOn,DATE_FORMAT(p.closure_due_date,'%Y-%m-%d') closureDueDate,p.closure_type closureType,${closurePlanKnownExpression} closurePlanKnown,
 p.market_expectation marketExpectation, p.status_description statusDesc,
 p.maintenance_enabled maintenanceEnabled, p.updated_at updatedAt,p.resume_status resumeStatus,DATE_FORMAT(p.first_check_week,'%Y-%m-%d') firstCheckWeek`;
const dimensionColumns: Record<string, string> = { customer: 'c.name', productLine: 'pl.name', odmFactory: 'odm.name', app: 'a.name', group: 'g.name', status: 'p.status', priority: 'p.priority', signal: 'p.signal' };
const collectionFilters: Record<string, string> = {
  chip: 'SELECT 1 FROM project_chips pc JOIN chips r ON r.id=pc.chip_id WHERE pc.project_id=p.id AND r.name=?',
  tags: 'SELECT 1 FROM project_tags pt JOIN tags r ON r.id=pt.tag_id WHERE pt.project_id=p.id AND r.name=?',
  owner: 'SELECT 1 FROM project_people pp JOIN engineers r ON r.id=pp.engineer_id WHERE pp.project_id=p.id AND r.name=?',
};
// 原版 currentStage 取第一个未完成阶段；项目没有完整七阶段时不伪装成全部完成。
const stageExpression = "COALESCE((SELECT MIN(s.stage_code) FROM project_stages s WHERE s.project_id=p.id AND s.state<>'completed'), IF((SELECT COUNT(*) FROM project_stages s WHERE s.project_id=p.id)=7,'completed','unconfigured'))";
const progressExpression = `ELT(1+(SELECT COUNT(*) FROM project_stages s WHERE s.project_id=p.id AND s.state='completed'),${[0, ...stages.map(stage => stage.progress)].join(',')})`;
const stageStateExpression = "COALESCE((SELECT s.state FROM project_stages s WHERE s.project_id=p.id AND s.state<>'completed' ORDER BY s.stage_code LIMIT 1), IF((SELECT COUNT(*) FROM project_stages s WHERE s.project_id=p.id)=7,'completed','unconfigured'))";

function conditions(query: ProjectQuery, includeFilters: boolean, today: string) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  switch (query.view ?? 'active') {
    case 'active': clauses.push("p.status='ongoing'"); break;
    case 'proposal': clauses.push("p.status IN ('proposal','paused')"); break;
    case 'closed': clauses.push("p.status='closed' AND p.maintenance_enabled=0"); break;
    case 'maintenance': clauses.push("p.status='closed' AND p.maintenance_enabled=1"); break;
  }
  if (includeFilters) {
    if (query.deadline) { const condition = deadlineCondition(query.deadline, today); clauses.push('(' + condition.sql + ')'); values.push(...condition.values); }
    for (const [key, column] of Object.entries(dimensionColumns)) {
      const value = query[key as keyof ProjectQuery];
      if (value) { clauses.push(`${column}=?`); values.push(value); }
    }
    for (const [key, sql] of Object.entries(collectionFilters)) {
      const value = query[key as keyof ProjectQuery];
      if (value) { clauses.push(`EXISTS (${sql})`); values.push(value); }
    }
    if (query.stage) { clauses.push(`${stageExpression}=?`); values.push(query.stage); }
    if (query.progress) { clauses.push(`${progressExpression}=?`); values.push(query.progress); }
    if (query.search) {
      const value = '%' + query.search.toLowerCase().replace(/[!%_]/g, char => '!' + char) + '%';
      clauses.push(`(LOWER(CONCAT_WS(' ',p.name,c.name,pl.name,odm.name,a.name,p.market_expectation,p.status_description)) LIKE ? ESCAPE '!'
       OR EXISTS (SELECT 1 FROM project_chips pc JOIN chips r ON r.id=pc.chip_id WHERE pc.project_id=p.id AND LOWER(r.name) LIKE ? ESCAPE '!')
       OR EXISTS (SELECT 1 FROM project_people pp JOIN engineers r ON r.id=pp.engineer_id WHERE pp.project_id=p.id AND pp.role IN ('hardware_owner','software_owner') AND LOWER(r.name) LIKE ? ESCAPE '!'))`);
      values.push(value, value, value);
    }
  }
  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', values };
}

async function enrich(connection: PoolConnection, projects: RowDataPacket[]) {
  if (!projects.length) return projects;
  const ids = projects.map(project => project.id);
  const slots = ids.map(() => '?').join(',');
  const chips = await rows(connection, `SELECT CAST(pc.project_id AS CHAR) projectId, CAST(c.id AS CHAR) id,c.name FROM project_chips pc JOIN chips c ON c.id=pc.chip_id WHERE pc.project_id IN (${slots}) ORDER BY pc.sort_order,c.id`, ids);
  const people = await rows(connection, `SELECT CAST(pp.project_id AS CHAR) projectId,CAST(e.id AS CHAR) id,e.name,pp.role FROM project_people pp JOIN engineers e ON e.id=pp.engineer_id WHERE pp.project_id IN (${slots}) ORDER BY pp.sort_order,e.id,pp.role`, ids);
  const tags = await rows(connection, `SELECT CAST(pt.project_id AS CHAR) projectId,CAST(t.id AS CHAR) id,t.name FROM project_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.project_id IN (${slots}) ORDER BY pt.sort_order,t.id`, ids);
  for (const project of projects) {
    project.chips = chips.filter(item => item.projectId === project.id).map(({ projectId: _projectId, ...item }) => item);
    project.people = people.filter(item => item.projectId === project.id).map(({ projectId: _projectId, ...item }) => item);
    project.tags = tags.filter(item => item.projectId === project.id).map(({ projectId: _projectId, ...item }) => item);
  }
  return projects;
}

export function projectReads(database: RuntimeDatabase, clock = () => new Date()) {
  return {
    list(query: ProjectQuery) {
      const now = clock(), today = businessToday(now);
      return database.readSnapshot(async connection => {
        const checkRule = await checkContext(connection, undefined, now);
        const checkStats = checkConditions(checkRule);
        const base = conditions(query, false, today);
        const filtered = conditions(query, true, today);
        const deadlines = deadlineKinds.map(kind => ({ kind, ...deadlineCondition(kind, today) }));
        const stats = (await rows(connection, `SELECT COUNT(*) total,COALESCE(SUM(p.priority='high'),0) high,COALESCE(SUM(p.signal='green'),0) green,COALESCE(SUM(p.signal='yellow'),0) yellow,COALESCE(SUM(p.signal='red'),0) red,${[...deadlines.map(condition => ({ ...condition, key: condition.kind })), ...checkStats].map(condition => `COALESCE(SUM(${condition.sql}),0) \`${condition.key}\``).join(',')} ${joins} ${filtered.sql}`, [...deadlines.flatMap(condition => condition.values), ...checkStats.flatMap(condition => condition.values), ...filtered.values]))[0];
        const total = Number(stats.total);
        const pageSize = query.pageSize ?? 24;
        const pageCount = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(query.page ?? 1, pageCount);
        const items = await enrich(connection, await rows(connection, `SELECT ${columns},${stageExpression} stage,${stageStateExpression} stageState,${progressExpression} progress ${joins} ${filtered.sql} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...filtered.values, pageSize, (page - 1) * pageSize]));
        for (const project of items) project.deadline = deadlineResult(project as RowDataPacket & DateFacts, today);
        await enrichChecks(connection, items, checkRule);
        const options: Record<string, string[]> = {};
        for (const [key, column] of Object.entries(dimensionColumns)) {
          options[key] = (await rows(connection, `SELECT DISTINCT ${column} value ${joins} ${base.sql}${base.sql ? ' AND ' : ' WHERE '}${column} IS NOT NULL ORDER BY value`, base.values)).map(row => row.value);
        }
        for (const [key, table, link, reference] of [['chip', 'chips', 'project_chips', 'chip_id'], ['tags', 'tags', 'project_tags', 'tag_id'], ['owner', 'engineers', 'project_people', 'engineer_id']]) {
          options[key] = (await rows(connection, `SELECT DISTINCT r.name value ${joins} JOIN ${link} l ON l.project_id=p.id JOIN ${table} r ON r.id=l.${reference} ${base.sql} ORDER BY value`, base.values)).map(row => row.value);
        }
        const stageCounts = await rows(connection, `SELECT ${stageExpression} value,COUNT(*) count ${joins} ${filtered.sql} GROUP BY value`, filtered.values);
        return { items, businessDate: today, stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value)])), stageCounts, options, pagination: { page, pageSize, total, pageCount }, readOnly: true };
      });
    },
    detail(id: string, accountId?: string) {
      const now = clock();
      return database.readSnapshot(async connection => {
        const project = (await enrich(connection, await rows(connection, `SELECT ${columns},${stageExpression} stage,${stageStateExpression} stageState,${progressExpression} progress,
          DATE_FORMAT(p.filed_on,'%Y-%m-%d') filingDate,DATE_FORMAT(p.started_on,'%Y-%m-%d') startDate,
          DATE_FORMAT(p.original_due_date,'%Y-%m-%d') originalDueDate,CAST(p.first_check_rule_version AS CHAR) firstCheckRuleVersion,
          p.signal_note signalNote,p.detail_note detailNote,p.summary_note summaryNote,p.chipstat_note chipstatNote,
          CAST(p.customer_id AS CHAR) customerId,CAST(p.odm_customer_id AS CHAR) odmCustomerId,
          CAST(p.product_line_id AS CHAR) productLineId,CAST(p.app_id AS CHAR) appId,CAST(p.group_id AS CHAR) groupId,
          p.pre_close_status preCloseStatus,CAST(p.source_import_item_id AS CHAR) sourceImportItemId,p.closure_note closureNote,p.remaining_work_note remainingWorkNote,CAST(p.created_by AS CHAR) createdBy
          ${joins} WHERE p.id=?`, [id])))[0];
        if (!project) return null;
        const projectStages = await rows(connection, "SELECT CAST(id AS CHAR) id,stage_code code,state,planned_days plannedDays,note,DATE_FORMAT(started_on,'%Y-%m-%d') startedOn,DATE_FORMAT(completed_on,'%Y-%m-%d') completedOn,DATE_FORMAT(expected_end_on,'%Y-%m-%d') expectedEndOn FROM project_stages WHERE project_id=? ORDER BY stage_code", [id]);
        const nodes = await nodeRows(connection, id);
        const risks = await riskRows(connection, id);
        const changes = await rows(connection, 'SELECT CAST(id AS CHAR) id,source,content,decision,reason FROM project_changes WHERE project_id=? ORDER BY sort_order,id', [id]);
        const delays = await scheduleRecords(connection, id);
        const actualChanges = delays.filter(item => !item.voided && item.kind === 'reschedule' && item.oldDate && item.newDate && item.oldDate !== item.newDate);
        const planSummary = { reschedules: actualChanges.length, laterAdjustments: actualChanges.filter(item => item.newDate! > item.oldDate!).length, unknownAdjustments: delays.filter(item => !item.voided && item.kind === 'reschedule' && (!item.oldDate || !item.newDate)).length, netDays: project.originalDueDate && project.dueDate ? dayDifference(project.originalDueDate, project.dueDate) : null };
        const history = await rows(connection, 'SELECT CAST(id AS CHAR) id,source_date_text date,body text FROM legacy_project_history WHERE project_id=? ORDER BY source_sequence,id', [id]);
        const responsible = await rows(connection, 'SELECT CAST(u.id AS CHAR) id,u.display_name name,u.enabled FROM project_responsibilities r JOIN users u ON u.id=r.user_id WHERE r.project_id=? ORDER BY u.id', [id]);
        const editable = accountId ? responsible.some(user => user.id === accountId && !!user.enabled) : project.dataKind === 'trial';
        const stageActions = projectStages.map(stage => ({ code: stage.code,
          startBlocked: !accountId || !editable ? 'PROJECT_READ_ONLY' : stageBlock(project.status, projectStages as (RowDataPacket & StageFact)[], stage.code, 'startStage'),
          completeBlocked: !accountId || !editable ? 'PROJECT_READ_ONLY' : stageBlock(project.status, projectStages as (RowDataPacket & StageFact)[], stage.code, 'completeStage') }));
        const checkRule = await checkContext(connection, accountId, now);
        await enrichChecks(connection, [project], checkRule);
        const lifecycleHistory = await lifecycleNotes(connection, id);
        project.deadline = deadlineResult(project as RowDataPacket & DateFacts, checkRule.businessDate);
        const startBlocked = !accountId || !editable ? 'PROJECT_READ_ONLY' : startProjectBlock(project as RowDataPacket & { status: string; startDate: string | null; firstCheckWeek: unknown }, projectStages as (RowDataPacket & StageFact)[], checkRule.businessDate) ?? (!checkRule.rule ? 'CHECK_RULE_REQUIRED' : null);
        return { currentClosure: await currentClosure(connection, id, project as RowDataPacket & { status: string; sourceImportItemId: unknown }), project, stages: projectStages, stageActions, startBlocked, checkRule, lifecycleNotes: lifecycleHistory, businessDate: checkRule.businessDate, nodes, risks, changes, delays, planSummary, history, responsible, readOnly: !editable, capabilities: { editText: editable, editOrdinary: editable, join: !!accountId && !editable, leave: !!accountId && editable } };
      });
    },
  };
}
