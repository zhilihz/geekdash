import { attachTasks,attachContentDates } from './project-tasks.js';
import { failure } from './project-save.js';
import { suggestedProjects } from './project-membership.js';
import { isAdministrator } from './identity.js';
import { projectReferences } from './project-references.js';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { assertProjectAccess } from './project-membership.js';
import { changeRows, riskRows, nodeRows } from './project-records.js';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import { stageBlock, startProjectBlock, type StageFact } from './project-actions.js';
import { businessToday, validDate, closurePlanKnownExpression, dayDifference, deadlineCondition, deadlineKinds, deadlineResult, type DateFacts, type DeadlineKind } from './project-dates.js';
import { scheduleRecords } from './project-plans.js';
import { currentClosure } from './project-closures.js';
import { lifecycleNotes } from './project-lifecycle.js';
import { checkConditions, enrichChecks, todayCheckCondition, cycleCheckCondition } from './project-checks.js';
import { companyInformation, readCheckPolicy, type CheckPolicy } from './public-settings.js';
import { projectStatusEntries, projectStatusOwners, type StatusChange, type StatusEntry } from './project-status-entries.js';
import { sourceHistory, statusSourceBaselines, localCheckMarks, recordSourceFacts, originalRecordTimes, type SourceHistoryKind } from './project-source-history.js';

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
export type ProjectQuery = Partial<Record<'customer' | 'productLine' | 'odmFactory' | 'app' | 'group' | 'status' | 'priority' | 'signal' | 'stage' | 'progress' | 'chip' | 'tags' | 'owner' | 'taskOwner', string | string[]>> & { contentFrom?:string; contentTo?:string; view?: string; search?: string; deadline?: DeadlineKind | DeadlineKind[]; checkToday?: 'unchecked' | 'checked'; checkCycle?: 'unchecked'|'checked'; page?: number; pageSize?: number; dashboard?: '1'; details?: 'checks' };

async function rows(connection: PoolConnection, sql: string, values: unknown[] = []) {
  return (await connection.query<RowDataPacket[]>({ sql, timeout: 3000 }, values))[0];
}
const joins = 'FROM projects p';
const columns = `CAST(p.id AS CHAR) id, CAST(p.version AS CHAR) version, p.data_kind dataKind, p.name,p.tasks_unified tasksUnified, p.status, p.priority, p.signal,
 NULL customer, NULL odmFactory, NULL productLine, NULL app, NULL projectGroup,
 DATE_FORMAT(p.proposed_on,'%Y-%m-%d') proposalDate, DATE_FORMAT(p.current_due_date,'%Y-%m-%d') dueDate,
 DATE_FORMAT(p.filed_on,'%Y-%m-%d') filingDate,DATE_FORMAT(p.started_on,'%Y-%m-%d') startDate,
 DATE_FORMAT(p.closed_on,'%Y-%m-%d') closedOn,DATE_FORMAT(p.closure_due_date,'%Y-%m-%d') closureDueDate,p.closure_type closureType,${closurePlanKnownExpression} closurePlanKnown,
 p.market_expectation marketExpectation, p.summary summary, p.status_description statusDesc,
 p.maintenance_enabled maintenanceEnabled, p.updated_at updatedAt,p.resume_status resumeStatus,DATE_FORMAT(p.first_check_week,'%Y-%m-%d') firstCheckWeek`;
const dimensionColumns: Record<string, string> = { status: 'p.status', priority: 'p.priority', signal: 'p.signal' };
const collectionFilters: Record<string, string> = {
  ...Object.fromEntries(Object.values(projectReferences).map(link => [link.dimension, `SELECT 1 FROM ${link.table} l JOIN ${link.catalog} r ON r.id=l.${link.reference} WHERE l.project_id=p.id AND r.name=?`])),
  chip: 'SELECT 1 FROM project_chip_selections pc JOIN chips r ON r.id=pc.chip_id WHERE pc.project_id=p.id AND r.name=?',
  tags: 'SELECT 1 FROM project_tags pt JOIN tags r ON r.id=pt.tag_id WHERE pt.project_id=p.id AND r.name=?',
};
// 原版 currentStage 取第一个未完成阶段；项目没有完整七阶段时不伪装成全部完成。
const stageExpression = "COALESCE((SELECT MIN(s.stage_code) FROM project_stages s WHERE s.project_id=p.id AND s.state<>'completed'), IF((SELECT COUNT(*) FROM project_stages s WHERE s.project_id=p.id)=7,'completed','unconfigured'))";
const progressExpression = `ELT(1+(SELECT COUNT(*) FROM project_stages s WHERE s.project_id=p.id AND s.state='completed'),${[0, ...stages.map(stage => stage.progress)].join(',')})`;
const stageStateExpression = "COALESCE((SELECT s.state FROM project_stages s WHERE s.project_id=p.id AND s.state<>'completed' ORDER BY s.stage_code LIMIT 1), IF((SELECT COUNT(*) FROM project_stages s WHERE s.project_id=p.id)=7,'completed','unconfigured'))";

const selectedValues = (value: string | string[] | undefined) => value === undefined ? [] : Array.isArray(value) ? [...new Set(value)] : [value];
function conditions(query: ProjectQuery, includeFilters: boolean, today: string, accountId?:string, policy?:CheckPolicy) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if(accountId){clauses.push('EXISTS(SELECT 1 FROM project_responsibilities own JOIN users owner ON owner.id=own.user_id WHERE own.project_id=p.id AND own.user_id=? AND owner.enabled=1)');values.push(accountId);}
  switch (query.view ?? 'active') {
    case 'active': clauses.push("p.status='ongoing'"); break;
    case 'proposal': clauses.push("p.status IN ('proposal','paused')"); break;
    case 'closed': clauses.push("p.status='closed' AND p.maintenance_enabled=0"); break;
    case 'maintenance': clauses.push("p.status='closed' AND p.maintenance_enabled=1"); break;
  }
  if (includeFilters) {
    if(query.checkCycle && policy){const condition=cycleCheckCondition(policy);clauses.push((query.checkCycle==='unchecked'?'NOT ':'')+condition.sql);values.push(...condition.values);}
    if (query.checkToday) { const condition = todayCheckCondition(today); clauses.push((query.checkToday === 'unchecked' ? 'NOT ' : '') + condition.sql); values.push(...condition.values); }
    const deadlines=selectedValues(query.deadline).map(value=>deadlineCondition(value as DeadlineKind,today));
    if(deadlines.length){clauses.push('('+deadlines.map(item=>'('+item.sql+')').join(' OR ')+')');values.push(...deadlines.flatMap(item=>item.values));}
    for(const [key,column] of Object.entries({...dimensionColumns,stage:stageExpression,progress:progressExpression})) {
      const selected=selectedValues(query[key as keyof ProjectQuery] as string|string[]|undefined);
      if(selected.length){clauses.push(`${column} IN (?)`);values.push(selected);}
    }
    for(const [key,sql] of Object.entries(collectionFilters)) {
      const selected=selectedValues(query[key as keyof ProjectQuery] as string|string[]|undefined);
      if(selected.length){clauses.push(`EXISTS (${sql.replace('r.name=?','r.name IN (?)')})`);values.push(selected);}
    }
    const owners=selectedValues(query.owner),ownerConditions:string[]=[];
    for(const owner of owners){
      if(/^user:[1-9][0-9]*$/.test(owner)){ownerConditions.push('EXISTS (SELECT 1 FROM project_responsibilities r WHERE r.project_id=p.id AND r.user_id=?)');values.push(owner.slice(5));}
      else if(/^engineer:[1-9][0-9]*$/.test(owner)){ownerConditions.push("EXISTS (SELECT 1 FROM project_people r WHERE r.project_id=p.id AND r.engineer_id=? AND r.role<>'pm')");values.push(owner.slice(9));}
      else{ownerConditions.push("EXISTS (SELECT 1 FROM project_people pp JOIN engineers r ON r.id=pp.engineer_id WHERE pp.project_id=p.id AND r.name=? AND pp.role<>'pm')");values.push(owner);}
    }
    if(owners.length)clauses.push('('+ownerConditions.join(' OR ')+')');
    if (query.search) {
      const value = '%' + query.search.toLowerCase().replace(/[!%_]/g, char => '!' + char) + '%';
      clauses.push(`(LOWER(CONCAT_WS(' ',p.name,p.market_expectation,p.status_description)) LIKE ? ESCAPE '!'
       ${Object.values(projectReferences).map(link => `OR EXISTS(SELECT 1 FROM ${link.table} l JOIN ${link.catalog} r ON r.id=l.${link.reference} WHERE l.project_id=p.id AND LOWER(r.name) LIKE ? ESCAPE '!')`).join(' ')}
       OR EXISTS (SELECT 1 FROM project_chip_selections pc JOIN chips r ON r.id=pc.chip_id WHERE pc.project_id=p.id AND LOWER(r.name) LIKE ? ESCAPE '!')
       OR EXISTS (SELECT 1 FROM project_people pp JOIN engineers r ON r.id=pp.engineer_id WHERE pp.project_id=p.id AND pp.role<>'pm' AND LOWER(r.name) LIKE ? ESCAPE '!')
       OR EXISTS (SELECT 1 FROM project_responsibilities pr JOIN users u ON u.id=pr.user_id WHERE pr.project_id=p.id AND LOWER(u.display_name) LIKE ? ESCAPE '!'))`);
      values.push(value, ...Object.values(projectReferences).map(() => value), value, value, value);
    }
  }
  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', values };
}

async function enrichReferenceNames(connection: PoolConnection, projects: RowDataPacket[]) {
  if (!projects.length) return;
  const ids = projects.map(project => project.id);
  for (const [key, link] of Object.entries(projectReferences)) {
    const items = await rows(connection, `SELECT CAST(l.project_id AS CHAR) projectId,CAST(r.id AS CHAR) id,r.name FROM ${link.table} l JOIN ${link.catalog} r ON r.id=l.${link.reference} WHERE l.project_id IN (?) ORDER BY l.sort_order,r.id`, [ids]);
    for (const project of projects) {
      const values = items.filter(item => item.projectId === project.id).map(({ id, name }) => ({ id, name }));
      project[key] = values.map(item => item.id);
      project[link.dimension + 'Items'] = values;
      project[link.dimension === 'group' ? 'projectGroup' : link.dimension] = values.map(item => item.name).join(' / ');
    }
  }
}

async function enrich(connection: PoolConnection, projects: RowDataPacket[], includeStatusEntries = true) {
  if (!projects.length) return projects;
  await enrichReferenceNames(connection, projects);
  const ids = projects.map(project => project.id);
  const slots = ids.map(() => '?').join(',');
  const chips = await rows(connection, `SELECT CAST(pc.project_id AS CHAR) projectId, CAST(c.id AS CHAR) id,c.name,pc.selection_id selectionId,pc.note FROM project_chip_selections pc JOIN chips c ON c.id=pc.chip_id WHERE pc.project_id IN (${slots}) ORDER BY pc.sort_order,c.id`, ids);
  const people = await rows(connection, `SELECT CAST(pp.project_id AS CHAR) projectId,CAST(e.id AS CHAR) id,e.name,pp.role FROM project_people pp JOIN engineers e ON e.id=pp.engineer_id WHERE pp.project_id IN (${slots}) ORDER BY pp.sort_order,e.id,pp.role`, ids);
  const tags = await rows(connection, `SELECT CAST(pt.project_id AS CHAR) projectId,CAST(t.id AS CHAR) id,t.name FROM project_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.project_id IN (${slots}) ORDER BY pt.sort_order,t.id`, ids);
  const responsible = await rows(connection, `SELECT CAST(r.project_id AS CHAR) projectId,CAST(u.id AS CHAR) id,u.display_name name,u.enabled FROM project_responsibilities r JOIN users u ON u.id=r.user_id WHERE r.project_id IN (${slots}) ORDER BY u.id`, ids);
  const statusChanges = new Map<string, StatusChange[]>();
  const sourceBaselines = includeStatusEntries ? await statusSourceBaselines(connection, ids) : new Map();
  if (includeStatusEntries) {
    const audits = await rows(connection, `SELECT CAST(project_id AS CHAR) projectId,CAST(version_after AS CHAR) version,action,
      CASE WHEN JSON_TYPE(JSON_EXTRACT(before_json,'$.statusDesc'))='STRING' THEN JSON_UNQUOTE(JSON_EXTRACT(before_json,'$.statusDesc')) ELSE NULL END beforeText,
      JSON_UNQUOTE(JSON_EXTRACT(after_json,'$.statusDesc')) afterText,DATE_FORMAT(created_at,'%Y-%m-%dT%H:%i:%s.%fZ') createdAt
      FROM audit_log WHERE project_id IN (${slots}) AND entity_type='project' AND action<>'project.import' AND JSON_TYPE(JSON_EXTRACT(after_json,'$.statusDesc'))='STRING' ORDER BY audit_log.id`, ids);
    for (const audit of audits) {
      const baseline = sourceBaselines.get(audit.projectId);
      if (baseline && BigInt(audit.version) <= BigInt(baseline.version)) continue;
      const changes = statusChanges.get(audit.projectId) ?? [];
      changes.push(audit as RowDataPacket & StatusChange); statusChanges.set(audit.projectId, changes);
    }
  }
  for (const project of projects) {
    project.chips = chips.filter(item => item.projectId === project.id).map(({ projectId: _projectId, ...item }) => item);
    project.chipSelections = project.chips.map((item: { id: string; selectionId: string; note: string }) => ({ selectionId: item.selectionId, chipId: item.id, note: item.note }));
    project.people = people.filter(item => item.projectId === project.id).map(({ projectId: _projectId, ...item }) => item);
    project.tags = tags.filter(item => item.projectId === project.id).map(({ projectId: _projectId, ...item }) => item);
    project.managers = responsible.filter(item => item.projectId === project.id).map(({ projectId: _projectId, ...item }) => item);
    if (includeStatusEntries) project.statusEntries = projectStatusEntries(project.statusDesc, statusChanges.get(project.id) ?? [], sourceBaselines.get(project.id)?.entries);
  }
  await attachTasks(connection,projects);
  await attachContentDates(connection,projects);
  return projects;
}

async function readDetail(connection: PoolConnection, id: string, accountId: string | undefined, now: Date, withHistory = true, statusEntries?: StatusEntry[]) {
        if(accountId)await assertProjectAccess(connection,id,accountId);
        const todayCheck = todayCheckCondition(businessToday(now));
        const project = (await enrich(connection, await rows(connection, `SELECT ${columns},${stageExpression} stage,${stageStateExpression} stageState,${progressExpression} progress,${todayCheck.sql} checkedToday,
          DATE_FORMAT(p.original_due_date,'%Y-%m-%d') originalDueDate,CAST(p.first_check_rule_version AS CHAR) firstCheckRuleVersion,
          p.signal_note signalNote,p.detail_note detailNote,p.summary_note summaryNote,p.chipstat_note chipstatNote,
          p.pre_close_status preCloseStatus,CAST(p.source_import_item_id AS CHAR) sourceImportItemId,p.closure_note closureNote,p.remaining_work_note remainingWorkNote,CAST(p.created_by AS CHAR) createdBy
          ${joins} WHERE p.id=?`, [...todayCheck.values, id]), statusEntries === undefined))[0];
        if (!project) return null;
        if (statusEntries && !project.tasksUnified) project.statusEntries = statusEntries;
        project.checkedToday = Number(project.checkedToday) === 1;
        const projectStages = await rows(connection, `SELECT CAST(s.id AS CHAR) id,s.stage_code code,s.state,s.planned_days plannedDays,s.note,
          DATE_FORMAT(s.started_on,'%Y-%m-%d') startedOn,DATE_FORMAT(s.completed_on,'%Y-%m-%d') completedOn,
          DATE_FORMAT(n.expected_end_on,'%Y-%m-%d') expectedEndOn,COALESCE(n.node_count,0) nodeCount,COALESCE(n.undated_count,0) undatedNodeCount
          FROM project_stages s LEFT JOIN (SELECT stage_id,MAX(target_date) expected_end_on,COUNT(*) node_count,SUM(target_date IS NULL) undated_count
            FROM project_nodes WHERE project_id=? AND kind='project' AND deleted_at IS NULL GROUP BY stage_id) n ON n.stage_id=s.id
          WHERE s.project_id=? ORDER BY s.stage_code`, [id, id]);
        const nodes = await nodeRows(connection, id);
        const risks = await riskRows(connection, id);
        const changes = await changeRows(connection, id);
        const delays = await scheduleRecords(connection, id);
        const recordOrigins = await recordSourceFacts(connection, id);
        for (const [kind, records] of [['risk', risks], ['change', changes], ['schedule', delays]] as const) for (const record of records) originalRecordTimes(record, recordOrigins.get(kind + ':' + record.id)?.values);
        const actualChanges = delays.filter(item => !item.voided && item.kind === 'reschedule' && item.oldDate && item.newDate && item.oldDate !== item.newDate);
        const planSummary = { reschedules: actualChanges.length, laterAdjustments: actualChanges.filter(item => item.newDate! > item.oldDate!).length, unknownAdjustments: delays.filter(item => !item.voided && item.kind === 'reschedule' && (!item.oldDate || !item.newDate)).length, netDays: project.originalDueDate && project.dueDate ? dayDifference(project.originalDueDate, project.dueDate) : null };
        const sourceHistories = withHistory ? { mixed: await sourceHistory(connection, id, 'mixed'), status_description: await sourceHistory(connection, id, 'status_description') } : undefined;
        const history = sourceHistories?.mixed.sources.flatMap(source => source.entries) ?? [];
        const localMarks = withHistory ? await localCheckMarks(connection, id) : [];
        const responsible = await rows(connection, 'SELECT CAST(u.id AS CHAR) id,u.display_name name,u.enabled FROM project_responsibilities r JOIN users u ON u.id=r.user_id WHERE r.project_id=? ORDER BY u.id', [id]);
        const editable = accountId ? responsible.some(user => user.id === accountId && !!user.enabled) : project.dataKind === 'trial';
        const stageActions = projectStages.map(stage => ({ code: stage.code,
          startBlocked: !accountId || !editable ? 'PROJECT_READ_ONLY' : stageBlock(project.status, projectStages as (RowDataPacket & StageFact)[], stage.code, 'startStage'),
          completeBlocked: !accountId || !editable ? 'PROJECT_READ_ONLY' : stageBlock(project.status, projectStages as (RowDataPacket & StageFact)[], stage.code, 'completeStage') }));
        const businessDate = businessToday(now);
        await enrichChecks(connection, [project], { businessDate });
        const lifecycleHistory = withHistory ? await lifecycleNotes(connection, id) : [];
        project.deadline = deadlineResult(project as RowDataPacket & DateFacts, businessDate);
        const startBlocked = !accountId || !editable ? 'PROJECT_READ_ONLY' : startProjectBlock(project as RowDataPacket & { status: string; startDate: string | null }, projectStages as (RowDataPacket & StageFact)[], businessDate);
        return { currentClosure: await currentClosure(connection, id, project as RowDataPacket & { status: string; sourceImportItemId: unknown }), project, stages: projectStages, stageActions, startBlocked, lifecycleNotes: lifecycleHistory, businessDate, nodes, risks, changes, delays, planSummary, history, sourceHistories, localCheckMarks: localMarks, responsible, readOnly: !editable, capabilities: { editText: editable, editOrdinary: editable, join: !!accountId && !editable && !!(await rows(connection,'SELECT id FROM users WHERE id=? AND enabled=1 AND is_project_manager=1',[accountId])).length, leave: !!accountId && editable } };
}

export function projectReads(database: RuntimeDatabase, clock = () => new Date()) {
  return {
    space(query:{search?:string;tags?:string[];customer?:string[];productLine?:string[];chip?:string[];page?:number;pageSize?:number},accountId:string) {
      return database.readSnapshot(async c=>{
        const clauses: string[] = [], params: unknown[] = [];
        if (query.search) {
          const term = '%' + query.search.toLowerCase().replace(/[!%_]/g, char => '!' + char) + '%';
          const refs = Object.values(projectReferences).map(link => `EXISTS(SELECT 1 FROM ${link.table} l JOIN ${link.catalog} r ON r.id=l.${link.reference} WHERE l.project_id=p.id AND LOWER(r.name) LIKE ? ESCAPE '!')`);
          clauses.push(`(LOWER(p.name) LIKE ? ESCAPE '!' OR ${refs.join(' OR ')} OR EXISTS(SELECT 1 FROM project_chip_selections pc JOIN chips chip ON chip.id=pc.chip_id WHERE pc.project_id=p.id AND LOWER(chip.name) LIKE ? ESCAPE '!'))`);
          params.push(...Array(refs.length + 2).fill(term));
        }
        if (query.tags?.length) { clauses.push('EXISTS(SELECT 1 FROM project_tags l JOIN tags t ON t.id=l.tag_id WHERE l.project_id=p.id AND t.name IN (?))'); params.push(query.tags); }
        for (const [key,table,catalog,column] of [['customer','project_customers','customers','customer_id'],['productLine','project_product_lines','product_lines','product_line_id'],['chip','project_chip_selections','chips','chip_id']] as const) {
          if (query[key]?.length) { clauses.push(`EXISTS(SELECT 1 FROM ${table} l JOIN ${catalog} r ON r.id=l.${column} WHERE l.project_id=p.id AND r.name IN (?))`); params.push(query[key]); }
        }
        const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
        const total=Number((await rows(c,`SELECT COUNT(*) total FROM projects p ${where}`,params))[0].total);
        const pageSize=query.pageSize??24,pageCount=Math.max(1,Math.ceil(total/pageSize)),page=Math.min(query.page??1,pageCount);
        const items=await rows(c,`SELECT CAST(p.id AS CHAR) id,p.name,p.status,p.summary FROM projects p ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`,[...params,pageSize,(page-1)*pageSize]);
        await enrichReferenceNames(c, items);
        if(items.length) {
          const ids=items.map(v=>v.id);
          const chips=await rows(c,'SELECT CAST(pc.project_id AS CHAR) projectId,CAST(c.id AS CHAR) id,c.name,pc.selection_id selectionId,pc.note FROM project_chip_selections pc JOIN chips c ON c.id=pc.chip_id WHERE pc.project_id IN (?) ORDER BY pc.sort_order,c.id',[ids]);
          const tags=await rows(c,'SELECT CAST(pt.project_id AS CHAR) projectId,CAST(t.id AS CHAR) id,t.name FROM project_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.project_id IN (?) ORDER BY pt.sort_order,t.id',[ids]);
          const members=await rows(c,'SELECT CAST(r.project_id AS CHAR) projectId,CAST(u.id AS CHAR) id,u.display_name name,u.enabled FROM project_responsibilities r JOIN users u ON u.id=r.user_id WHERE r.project_id IN (?) ORDER BY u.id',[ids]);

          for(const item of items){
            const own=members.filter(v=>v.projectId===item.id),member=own.some(v=>v.id===accountId&&v.enabled);
            item.chips=chips.filter(v=>v.projectId===item.id).map(({projectId:_id,...v})=>v);
            item.tags=tags.filter(v=>v.projectId===item.id).map(({projectId:_id,...v})=>v);
            item.collaborators=own.length>1?own.filter(v=>!member||v.id!==accountId).map(({id,name,enabled})=>({id,name,enabled:!!enabled})):[];
            item.member=member;item.unowned=!own.some(v=>v.enabled);

          }
        }
        const tagOptions=(await rows(c,'SELECT DISTINCT t.name FROM tags t JOIN project_tags p ON p.tag_id=t.id ORDER BY t.name')).map(row=>row.name);
        const filterOptions:Record<string,string[]>={};
        for (const [key,table,catalog,column] of [['customer','project_customers','customers','customer_id'],['productLine','project_product_lines','product_lines','product_line_id'],['chip','project_chip_selections','chips','chip_id']]) filterOptions[key]=(await rows(c,`SELECT DISTINCT r.name FROM ${catalog} r JOIN ${table} l ON l.${column}=r.id ORDER BY r.name`)).map(row=>row.name);
        const suggested=await suggestedProjects(c,accountId);for(const item of items)item.suggested=suggested.some(value=>value.id===item.id);
        return {items,tagOptions,filterOptions,suggestedCount:suggested.length,pagination:{page,pageSize,total,pageCount}};
      });
    },
    sourceHistory(id: string, kind: SourceHistoryKind, sourceNamespace?: string, adoptionId?: string, before?: string, accountId?:string) { return database.readSnapshot(async connection => { if(accountId)await assertProjectAccess(connection,id,accountId);return sourceHistory(connection, id, kind, sourceNamespace, adoptionId, before); }); },
    summary(accountId: string) {
      const now=clock(),today=businessToday(now);
      return database.readSnapshot(async connection=>{
        const items=await enrich(connection,await rows(connection,`SELECT ${columns},p.summary_note summaryNote,p.chipstat_note chipstatNote,p.detail_note detailNote,${stageExpression} stage,${stageStateExpression} stageState,${progressExpression} progress ${joins} WHERE (EXISTS(SELECT 1 FROM users admin WHERE admin.id=? AND admin.enabled=1 AND admin.is_admin=1) OR EXISTS(SELECT 1 FROM project_responsibilities own JOIN users owner ON owner.id=own.user_id WHERE own.project_id=p.id AND own.user_id=? AND owner.enabled=1)) ORDER BY p.id`,[accountId,accountId]));
        await enrichChecks(connection,items,{businessDate:today});
        const nodes=await rows(connection,"SELECT CAST(project_id AS CHAR) projectId,CAST(id AS CHAR) id,title,DATE_FORMAT(target_date,'%Y-%m-%d') targetDate FROM project_nodes WHERE kind='project' AND deleted_at IS NULL AND completed_on IS NULL ORDER BY project_id,sort_order,id");
        const engineers=await rows(connection,'SELECT name FROM engineers ORDER BY name,id'),engineerNames=engineers.map(item=>String(item.name));
        for(const item of items){
          item.deadline=deadlineResult(item as RowDataPacket & DateFacts,today);
          item.canEdit=item.managers.some((manager:{id:string;enabled:number})=>manager.id===accountId && !!manager.enabled);
          item.pendingNodes=nodes.filter(node=>node.projectId===item.id).map(({projectId:_projectId,...node})=>node);
          // 继承1051的当前说明提名语义；不写人员库，不授予责任或账号权限。
          item.statusOwners=projectStatusOwners(String(item.statusDesc ?? ''),engineerNames);
        }
        return {items,businessDate:today,capturedAt:now.toISOString(),company:await companyInformation(connection),ownerOptions:[...new Set([...engineers.map(item=>item.name),...items.flatMap(item=>item.statusOwners)])]};
      });
    },
    list(query: ProjectQuery, accountId?: string) {
      if(query.contentFrom&&!validDate(query.contentFrom)||query.contentTo&&!validDate(query.contentTo)||query.contentFrom&&query.contentTo&&query.contentFrom>query.contentTo)failure('INVALID_CONTENT_DATE_RANGE',400);
      const now = clock(), today = businessToday(now);
      return database.readSnapshot(async connection => {
        const policy=await readCheckPolicy(connection,now);
        const scopeAccount = accountId && !await isAdministrator(connection,accountId) ? accountId : undefined;
        const checkStats = checkConditions();
        const base = conditions(query, false, today, scopeAccount,policy);
        const filtered = conditions(query, true, today, scopeAccount,policy);
        const taskPeople=(await rows(connection,'SELECT name FROM engineers')).map(row=>String(row.name));
        const taskSources=await rows(connection,`SELECT CAST(p.id AS CHAR) id,p.status_description text FROM projects p ${base.sql}`,base.values);
        if(query.contentFrom||query.contentTo){await attachContentDates(connection,taskSources);const ids=taskSources.filter(row=>row.contentUpdatedOn&&(!query.contentFrom||row.contentUpdatedOn>=query.contentFrom)&&(!query.contentTo||row.contentUpdatedOn<=query.contentTo)).map(row=>row.id);filtered.sql+=(filtered.sql?' AND ':' WHERE ')+(ids.length?'p.id IN (?)':'0');if(ids.length)filtered.values.push(ids);}
        const taskOwners=new Map(taskSources.map(row=>[row.id,projectStatusOwners(row.text,taskPeople)]));
        const selectedTaskOwners=selectedValues(query.taskOwner);
        if(selectedTaskOwners.length){const ids=[...taskOwners].filter(([,names])=>names.some(name=>selectedTaskOwners.includes(name))).map(([id])=>id);filtered.sql+=(filtered.sql?' AND ':' WHERE ')+(ids.length?`p.id IN (${ids.map(()=>'?').join(',')})`:'0');filtered.values.push(...ids);}
        const deadlines = deadlineKinds.map(kind => ({ kind, ...deadlineCondition(kind, today) }));
        const todayCheck = todayCheckCondition(today);
        const statistics = [...deadlines.map(condition => ({ ...condition, key: condition.kind })), ...checkStats, { key: 'todayChecked', ...todayCheck }, { key: 'todayUnchecked', sql: 'NOT ' + todayCheck.sql, values: todayCheck.values }];
        const stats = (await rows(connection, `SELECT COUNT(*) total,COALESCE(SUM(p.priority='high'),0) high,COALESCE(SUM(p.signal='green'),0) green,COALESCE(SUM(p.signal='yellow'),0) yellow,COALESCE(SUM(p.signal='red'),0) red,${statistics.map(condition => `COALESCE(SUM(${condition.sql}),0) \`${condition.key}\``).join(',')} ${joins} ${filtered.sql}`, [...statistics.flatMap(condition => condition.values), ...filtered.values]))[0];
        const total = Number(stats.total);
        let quickRanges:Record<string,string[]>|undefined;
        let globalChecks:{total:number;todayChecked:number;todayUnchecked:number;cycleChecked:number;cycleUnchecked:number}|undefined;
        if(query.dashboard){
          const personal=conditions({view:'all'},false,today,scopeAccount);
          const cycleCheck=cycleCheckCondition(policy);
          const allChecks=(await rows(connection,`SELECT COUNT(*) total,COALESCE(SUM(${todayCheck.sql}),0) todayChecked,COALESCE(SUM(${cycleCheck.sql}),0) cycleChecked FROM projects p ${personal.sql}`,[...todayCheck.values,...cycleCheck.values,...personal.values]))[0];
          globalChecks={cycleChecked:Number(allChecks.cycleChecked),cycleUnchecked:Number(allChecks.total)-Number(allChecks.cycleChecked),total:Number(allChecks.total),todayChecked:Number(allChecks.todayChecked),todayUnchecked:Number(allChecks.total)-Number(allChecks.todayChecked)};
          const quickConditions=[{key:'total',sql:'1',values:[]},{key:'high',sql:"p.priority='high'",values:[]},...['green','yellow','red'].map(color=>({key:color,sql:`p.signal='${color}'`,values:[]})),...statistics];
          const matches=await rows(connection,`SELECT CAST(p.id AS CHAR) id,${quickConditions.map(condition=>`(${condition.sql}) AS \`${condition.key}\``).join(',')} ${joins} ${filtered.sql} ORDER BY p.id DESC`,[...quickConditions.flatMap(condition=>condition.values),...filtered.values]);
          quickRanges=Object.fromEntries(quickConditions.map(condition=>[condition.key,matches.filter(row=>Number(row[condition.key])===1).map(row=>String(row.id))]));
        }
        const pageSize = query.pageSize ?? 24;
        const pageCount = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(query.page ?? 1, pageCount);
        const items = await enrich(connection, await rows(connection, `SELECT ${columns},${query.dashboard ? 'p.summary_note summaryNote,' : ''}${stageExpression} stage,${stageStateExpression} stageState,${progressExpression} progress,${todayCheck.sql} checkedToday,EXISTS (SELECT 1 FROM project_responsibilities r WHERE r.project_id=p.id AND r.user_id=?) canCheck ${joins} ${filtered.sql} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...todayCheck.values, accountId ?? null, ...filtered.values, pageSize, (page - 1) * pageSize]));
        const risks = items.length ? await rows(connection, `SELECT CAST(project_id AS CHAR) projectId,COUNT(*) unresolvedCount,ELT(MAX(FIELD(level,'low','mid','high')),'low','mid','high') highestLevel FROM project_risks WHERE project_id IN (${items.map(() => '?').join(',')}) AND deleted_at IS NULL AND resolved=0 GROUP BY project_id`, items.map(project => project.id)) : [];
        for (const project of items) {
          const risk = risks.find(risk => risk.projectId === project.id);
          project.riskSummary = { unresolvedCount: Number(risk?.unresolvedCount ?? 0), highestLevel: risk?.highestLevel ?? null };
          project.deadline = deadlineResult(project as RowDataPacket & DateFacts, today);
          project.checkedToday = Number(project.checkedToday) === 1;
          project.capabilities = { canCheck: Number(project.canCheck) === 1 };
          delete project.canCheck;
        }
        await enrichChecks(connection, items, { businessDate: today });
        if (query.details === 'checks') for (const item of items) item.inspection = await readDetail(connection, item.id, accountId, now, false, item.statusEntries);
        const options: Record<string, string[]> = {};
        const optionQueries: string[] = [];
        for (const [key, column] of Object.entries(dimensionColumns)) {
          options[key] = [];
          optionQueries.push(`(SELECT DISTINCT '${key}' dimension,${column} value ${joins} ${base.sql}${base.sql ? ' AND ' : ' WHERE '}${column} IS NOT NULL ORDER BY value)`);
        }
        for (const [key, table, link, reference] of [...Object.values(projectReferences).map(link => [link.dimension,link.catalog,link.table,link.reference]), ['chip', 'chips', 'project_chip_selections', 'chip_id'], ['tags', 'tags', 'project_tags', 'tag_id']]) {
          options[key] = [];
          optionQueries.push(`(SELECT DISTINCT '${key}' dimension,r.name value ${joins} JOIN ${link} l ON l.project_id=p.id JOIN ${table} r ON r.id=l.${reference} ${base.sql} ORDER BY value)`);
        }
        for (const option of await rows(connection, optionQueries.join(' UNION ALL ') + ' ORDER BY dimension,value', optionQueries.flatMap(() => base.values))) options[option.dimension].push(option.value);
        const owners = await rows(connection, `(SELECT DISTINCT CONCAT('user:',u.id) id,CONCAT(u.display_name,'（项目经理）') name ${joins} JOIN project_responsibilities r ON r.project_id=p.id JOIN users u ON u.id=r.user_id ${base.sql}) UNION ALL (SELECT DISTINCT CONCAT('engineer:',e.id) id,CONCAT(e.name,'（业务分工）') name ${joins} JOIN project_people pp ON pp.project_id=p.id AND pp.role<>'pm' JOIN engineers e ON e.id=pp.engineer_id ${base.sql}) ORDER BY name,id`, [...base.values, ...base.values]);
        options.taskOwner=[...new Set([...taskOwners.values()].flat())].sort((a,b)=>a.localeCompare(b,'zh-CN'));
        options.owner = owners.map(item => item.id);
        const optionLabels = { owner: Object.fromEntries(owners.map(item => [item.id, item.name])) };
        const stageCounts = await rows(connection, `SELECT ${stageExpression} value,COUNT(*) count ${joins} ${filtered.sql} GROUP BY value`, filtered.values);
        let dashboard;
        if (query.dashboard) {
          const all = await rows(connection, `SELECT CAST(p.id AS CHAR) id,p.name,p.tasks_unified tasksUnified,p.status,p.priority,p.signal,p.status_description statusDesc,p.updated_at updatedAt,${stageExpression} stage,${progressExpression} progress ${joins} ${filtered.sql} ORDER BY p.id DESC`, filtered.values);
          await enrich(connection, all, false);
          const distributions = Object.fromEntries(['customer','productLine','odmFactory','app','group','chip','tags','status','priority','signal','stage','progress'].map(key => {
            const counts = new Map<string, number>();
            for (const project of all) {
              const collection=['customer','productLine','odmFactory','app','group'].includes(key)?project[key+'Items']:key==='chip'?project.chips:key==='tags'?project.tags:null;
              const values=collection?[...new Set((collection as {name:string}[]).map(item=>item.name))]:[String(project[key]??'')];
              for (const value of values.length ? values : ['']) counts.set(value, (counts.get(value) ?? 0) + 1);
            }
            return [key, [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh-CN'))];
          }));
          const focus = [...all];
          const priorities: Record<string, number> = { high: 0, mid: 1, low: 2 };
          focus.sort((a, b) => priorities[a.priority] - priorities[b.priority] || Number(b.progress) - Number(a.progress));
          const managerCounts=new Map<string,{id:string;name:string;count:number}>();
          for(const project of all)for(const manager of project.managers as {id:string;name:string;enabled:number}[])if(manager.enabled){const item=managerCounts.get(manager.id)??{id:manager.id,name:manager.name,count:0};item.count++;managerCounts.set(manager.id,item);}
          dashboard = { managers:[...managerCounts.values()].sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'zh-CN')),distributions, focusTotal: focus.length, focus: focus.slice(0, 12).map(({ id, name, status, priority, stage, progress }) => ({ id, name, status, priority, stage, progress })), latest: [...all].sort((a,b)=>String(b.contentUpdatedOn).localeCompare(String(a.contentUpdatedOn))||String(b.contentUpdatedAt).localeCompare(String(a.contentUpdatedAt))).slice(0,10).map(({id,name,statusDesc,updatedAt,contentUpdatedAt,contentUpdatedOn})=>({id,name,statusDesc,updatedAt,contentUpdatedAt,contentUpdatedOn})) };
        }
        return { items, businessDate: today, checkPolicy:policy, company:await companyInformation(connection),stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value)])), stageCounts, options, optionLabels, pagination: { page, pageSize, total, pageCount }, readOnly: true, ...(dashboard ? { dashboard,quickRanges,globalChecks } : {}) };
      });
    },
    detail(id: string, accountId?: string) {
      const now = clock();
      return database.readSnapshot(async connection => {
        return readDetail(connection, id, accountId, now);
      });
    },
  };
}
