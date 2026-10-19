export type DeadlineKind = 'upcoming' | 'due' | 'overdue' | 'unset' | 'closed_on_time' | 'closed_late' | 'closed_unplanned' | 'closed_unknown' | 'terminated';
export type Deadline = { kind: DeadlineKind; asOfDate: string; days: number | null; label: string };
export type Company = {fullName:string;shortName:string;managerText:string;namePrefix:string;version:string};
export function applyCompany(company:Company|null|undefined) {
  const title=document.querySelector<HTMLElement>('[data-company-title]');
  if(title){const text=(company?.namePrefix || '智能硬件')+'项目看板系统';title.textContent=text;document.title=text;}
  const subtitle=document.querySelector<HTMLElement>('[data-company-subtitle]');
  if(subtitle){subtitle.textContent=company?.shortName ?? '';subtitle.title=company?.fullName ?? '';}
}
export type Project = {
  id: string; version: string; dataKind: 'business' | 'trial'; name: string; status: string; priority: string; signal: string;
  customer: string | null; odmFactory: string | null; productLine: string | null; app: string | null; projectGroup: string | null;
  proposalDate: string | null; dueDate: string | null; marketExpectation: string; statusDesc: string; summaryNote?: string;
  deadline: Deadline; checkStatus: CheckStatus; resumeStatus: string | null; maintenanceEnabled: number; updatedAt: string; stage: string; stageState: string; progress: string | number;
  chips: { id: string; name: string }[]; people: { id: string; name: string; role: string }[]; tags: { id: string; name: string }[];
  managers: { id: string; name: string; enabled: number }[];
};
export type ListProject = Project & { checkedToday: boolean; capabilities: { canCheck: boolean }; inspection?: Detail };
export type Dashboard = { distributions: Record<string, { value: string; count: number }[]>; focusTotal: number; focus: Pick<Project, 'id' | 'name' | 'status' | 'priority' | 'stage' | 'progress'>[]; latest: Pick<Project, 'id' | 'name' | 'statusDesc' | 'updatedAt'>[]; team: { id: string; name: string; count: number; pmCount: number; hardwareCount: number; softwareCount: number }[] };
export type List = { items: ListProject[]; businessDate: string; company?:Company|null; stats: Record<string, number> & { todayChecked: number; todayUnchecked: number }; options: Record<string, string[]>; optionLabels?: Record<string, Record<string, string>>; stageCounts: { value: string; count: string | number }[]; pagination: { page: number; pageSize: number; total: number; pageCount: number }; readOnly: true; dashboard?: Dashboard; quickRanges?: Record<string,string[]> };
export type Entry = Record<string, string | number | null>;
export type TextValues = { name: string; marketExpectation: string; detailNote: string; summaryNote: string; summary: string };
export type RiskOperation = { op: 'add'; tempId: string; content: string; level: 'high' | 'mid' | 'low' } | { op: 'correct'; id: string; changes: Partial<{ content: string; level: 'high' | 'mid' | 'low'; resolution: string }>; reason: string } | { op: 'resolve'; id: string; resolution: string } | { op: 'undoResolve'; id: string; reason: string } | { op: 'delete'; id: string };
export type RiskRecord = { id: string; content: string; level: string; resolved: number; resolution: string; resolvedAt: string | null; createdAt: string; actorId: string | null; createdByName: string | null; resolvedByName: string | null; sourceKey: string | null; sortOrder: number };
export type RiskPreview = { projectId: string; expectedVersion: string; events: { op: RiskOperation['op']; id: string; before: RiskRecord | null; after: RiskRecord; reason: string }[]; risks: RiskRecord[] };
export type ChangeFields = { source: string; content: string; decision: 'accept' | 'reject'; reason: string };
export type ChangeOperation = { op: 'add'; tempId: string } & ChangeFields | { op: 'correct'; id: string; changes: Partial<ChangeFields>; correctionReason: string };
export type ChangeRecord = ChangeFields & { id: string; actorId: string | null; createdAt: string; createdByName: string | null; sourceKey: string | null; sortOrder: number };
export type ChangePreview = { projectId: string; expectedVersion: string; changeEvents: { op: ChangeOperation['op']; id: string; before: ChangeRecord | null; after: ChangeRecord; correctionReason: string }[]; changes: ChangeRecord[] };
export type NodeFields = { title: string; stage: string | null; targetDate: string | null; output: string; note: string };
export type NodeOperation = { op: 'add'; tempId: string; kind: 'project' | 'customer'; fields: Partial<NodeFields> & { title: string } } | { op: 'correct'; id: string; changes: Partial<NodeFields>; reason: string } | { op: 'complete'; id: string; completedOn: string; reason?: string } | { op: 'uncomplete'; id: string; reason: string; affectedIds: string[] } | { op: 'move'; id: string; x: number; y: number } | { op: 'link'; from: string; to: string; replaceEdges: { from: string; to: string }[]; affectedIds: string[]; reason: string } | { op: 'unlink'; from: string; to: string } | { op: 'delete'; id: string; removeEdges: { from: string; to: string }[] } | { op: 'restore'; id: string; reason: string };
export type NodeRecord = NodeFields & { id: string; kind: string; completedOn: string | null; previousNodeId: string | null; nextNodeId: string | null; x: number | null; y: number | null; sourceKey: string | null; sortOrder: number; deletedAt: string | null };
export type DeletedNodePage = { projectVersion: string; items: (NodeRecord & { deletion: { auditId: string; actorName: string; createdAt: string; beforeNode: NodeRecord | null; operations: NodeOperation[]; reason: string } | null })[]; pageSize: number; nextCursor: string | null };
export type NodePreview = { projectId: string; expectedVersion: string; nodeEvents: { id: string; before: NodeRecord | null; after: NodeRecord; operations: NodeOperation[]; reason: string }[]; nodes: NodeRecord[]; requiredUncompleteIds: string[]; confirmed: boolean };
export type EditValues = TextValues & { signalNote: string; chipstatNote: string; statusDesc: string; signal: string; priority: string; customerId: string | null; odmCustomerId: string | null; productLineId: string | null; appId: string | null; groupId: string | null; chipIds: string[]; tagIds: string[]; people: { id: string; role: string }[]; stagePlans?: { code: string; plannedDays: number | null; note: string }[]; riskOps?: RiskOperation[]; nodeOps?: NodeOperation[]; changeOps?: ChangeOperation[] };
export type CatalogItem = { id: string; name: string; enabled: number; originalModel?: string; manufacturer?: string; firmwareVersion?: string };
export type Catalog = Record<string, CatalogItem[]>;
export type SaveScope = 'basic' | 'status' | 'tags' | 'signal' | 'summaryNote' | 'chipstatNote' | 'stage' | 'risk' | 'change' | 'customerNode' | 'projectNodes';
type WithoutEnvelope<T> = T extends unknown ? Omit<T, 'expectedVersion' | 'idempotencyKey'> : never;
export type SaveRequest = { expectedVersion: string; idempotencyKey: string; changes: Partial<EditValues>; scope?: SaveScope; target?: string; commands?: WithoutEnvelope<ProjectCommand>[]; draft?: {clientDraftId:string;draftVersion:string} };
export type SaveResult = { projectId: string; operationId: string; changed: boolean; savedVersion: string; baseVersion?:string; draft?:{clientDraftId:string;draftVersion:string;instanceId:string;state:string}; values: Partial<EditValues>; savedAt: string | null; scope?: SaveScope; target?: string; actions?: Record<string, unknown>[]; display?: Record<string, unknown>; risks?: RiskRecord[]; riskIdMap?: Record<string, string>; nodeIdMap?: Record<string, string>; nodes?: NodeRecord[]; changes?: ChangeRecord[]; changeIdMap?: Record<string, string> };
export type Audit = { id: string; action: string; actorDisplayName: string; actorKind: string; versionBefore: string; versionAfter: string; createdAt: string; beforeValues: Record<string, unknown> | null; afterValues: Record<string, unknown> };
export type AuditPage = { items: Audit[]; nextCursor: string | null; pageSize: number };
export type StageCommand = { action: 'startStage' | 'completeStage'; stageCode: string; actualDate: string; expectedVersion: string; idempotencyKey: string; completionNote?: string };
export type StartCommand = { action: 'startProject'; actualDate: string; dueDate: string; planReason?: string; expectedVersion: string; idempotencyKey: string; configVersion: string; ruleVersion: string; previewWeek: string; previewFirstCheckWeek: string };
export type CorrectionCommand = { action: 'correctStageFacts'; changes: { code: string; startedOn?: string | null; completedOn?: string | null }[]; reason: string; expectedVersion: string; idempotencyKey: string }
  | { action: 'undoStageStart' | 'undoStageComplete' | 'rollbackStage'; stageCode: string; undoStart?: boolean; reason: string; expectedVersion: string; idempotencyKey: string };
export const dateTitles = { proposalDate: '提案日期', filingDate: '立案日期', startDate: '实际启动日期', dueDate: '当前计划结案日期', originalDueDate: '原始计划结案日期' } as const;
export type DateChanges = Partial<Record<keyof typeof dateTitles, string | null>>;
export type PlanCommand = { expectedVersion: string; idempotencyKey: string } & (
  { action: 'setPlan'; dueDate: string }
  | { action: 'reschedulePlan'; dueDate: string; reason: string; measures: string }
  | { action: 'notePlan'; reason: string; measures: string }
  | { action: 'correctProjectDates'; changes: DateChanges; reason: string }
  | { action: 'correctScheduleRecord'; recordId: string; changes: Partial<{ oldDate: string | null; newDate: string | null; reason: string; measures: string }>; reason: string; currentDueDate?: string | null }
  | { action: 'voidScheduleRecord'; recordId: string; reason: string; currentDueDate?: string | null });
export const planActions = ['setPlan', 'reschedulePlan', 'notePlan', 'correctProjectDates', 'correctScheduleRecord', 'voidScheduleRecord'];
export function isPlanCommand(value: { action: string }): value is PlanCommand { return planActions.includes(value.action); }
export type PlanPreview = { projectId: string; expectedVersion: string; changed: boolean; beforeValues: Record<string, unknown>; afterValues: Record<string, unknown>; beforeDeadline: Deadline; afterDeadline: Deadline; startupBasis?: string | null; startupBasisNote?: string; adjustmentDays?: number; direction?: string; reason?: string; scheduleRecord?: { kind: string; oldDate: string | null; newDate: string | null; reason: string; measures: string } };
export type ScheduleRecord = { id: string; kind: 'reschedule' | 'note'; oldDate: string | null; newDate: string | null; reason: string; measures: string; actorId: string | null; createdAt: string; voided: boolean; original: { oldDate: string | null; newDate: string | null; reason: string; measures: string }; corrections: { id: string; reason: string; actorDisplayName: string; createdAt: string }[] };
export type LifecycleCommand = { expectedVersion: string; idempotencyKey: string } & ({ action: 'pauseProject'; reason: string } | { action: 'resumeProject'; note: string; dueDate?: string; planReason?: string } | { action: 'correctLifecycleNote'; auditId: string; note: string; reason: string });
export const lifecycleActions = ['pauseProject', 'resumeProject', 'correctLifecycleNote'];
export function isLifecycleCommand(value: { action: string }): value is LifecycleCommand { return lifecycleActions.includes(value.action); }
export type CheckCommand = { expectedVersion: string; idempotencyKey: string; conclusion: 'checked' | 'follow_up'; note: string } & ({ action: 'saveCheck'; ruleVersion: string; previewWeek: string } | { action: 'correctCheck'; checkId: string; reason: string });
export function isCheckCommand(value: { action: string }): value is CheckCommand { return ['saveCheck', 'correctCheck'].includes(value.action); }
export type CheckRecord = { id: string; actorId: string; actorName: string; checkedAt: string; weekStart: string; conclusion: 'checked' | 'follow_up'; note: string; ruleVersion: string; observedVersion: string; resultVersion: string; deadlineDate: string | null; effectiveRuleVersion: string | null; onTime: boolean | null; originalDeadlineDate: string; originalOnTime: boolean; original: { conclusion: string; note: string }; correction: { id: string; actorName: string; createdAt: string; reason: string } | null };
export type CheckPage = { items: CheckRecord[]; projectVersion: string; nextCursor: string | null; pageSize: number; rule: CheckRuleContext };
export type CheckPreview = { projectId: string; expectedVersion: string; changed: boolean; beforeValues: { check: { conclusion: string; note: string } } | null; afterValues: { check: { conclusion: string; note: string; weekStart?: string; checkedAt?: string } }; deadlineDate?: string | null; onTime?: boolean; checkedAt?: string; actorName?: string; weekStart?: string; ruleVersion?: string; observedVersion?: string; resultVersion?: string };
export type CheckStatus = { kind: string; label: string; required: boolean; weekStart: string; deadlineDate: string | null; onTime: boolean | null; updatedAfterCheck: boolean; latest: { id: string; actorId: string | null; actorName: string | null; checkedAt: string; conclusion: string; note: string; observedVersion: string; resultVersion: string } | null };
export type LifecycleNote = { id: string; action: string; note: string; originalNote: string; actorDisplayName: string; createdAt: string; versionBefore: string; versionAfter: string; corrections: { id: string; reason: string; actorDisplayName: string; createdAt: string }[] };
export type LifecyclePreview = { projectId: string; expectedVersion: string; changed: boolean; beforeValues: Record<string, unknown>; afterValues: Record<string, unknown>; beforeCheck: CheckStatus; afterCheck: CheckStatus; plan?: PlanPreview };
export const closureTitles = { closedOn: '实际结案日', closureDueDate: '结案时计划', closureType: '结案类型', closureNote: '结案说明', remainingWorkNote: '遗留处置说明' } as const;
export type ClosureCommand = { expectedVersion: string; idempotencyKey: string } & (
  { action: 'closeProject'; closureType: 'normal' | 'terminated'; closedOn: string; closureNote: string; remainingWorkNote: string }
  | { action: 'reopenProject'; closureAuditId: string | null; reason: string }
  | { action: 'setMaintenance'; enabled: boolean; reason: string }
  | { action: 'correctClosure'; closureAuditId: string | null; changes: Partial<Record<keyof typeof closureTitles, string | null>>; reason: string });
export function isClosureCommand(value: { action: string }): value is ClosureCommand { return ['closeProject', 'reopenProject', 'setMaintenance', 'correctClosure'].includes(value.action); }
export type ClosurePreview = { projectId: string; expectedVersion: string; changed: boolean; beforeValues: { closure: Record<string, unknown> }; afterValues: { closure: Record<string, unknown> }; remaining: { stages: Entry[]; nodes: NodeRecord[]; risks: Entry[] }; progress: number; beforeDeadline: Deadline; afterDeadline: Deadline; beforeCheck: CheckStatus; afterCheck: CheckStatus };
export type CurrentClosure = { auditId: string | null; sourceImportItemId: string | null; actorDisplayName: string | null; createdAt: string | null; original: Record<string, unknown> | null };
export type ProjectCommand = (StageCommand | StartCommand | CorrectionCommand | PlanCommand | LifecycleCommand | ClosureCommand | CheckCommand) & {draft?:{clientDraftId:string;draftVersion:string}};
export type CorrectionPreview = { projectId: string; expectedVersion: string; stageChanges: Entry[]; beforeStages: Entry[]; progressBefore: number; progressAfter: number; reason: string; changed: boolean };
export const actionLabels: Record<string, string> = { startStage: '开始阶段', completeStage: '完成阶段', startProject: '启动项目', correctStageFacts: '纠正实际日期', undoStageStart: '撤销误开始', undoStageComplete: '撤销误完成', rollbackStage: '真实返工回退', 'project.stage.start': '开始阶段', 'project.stage.complete': '完成阶段', 'project.start': '启动项目', 'project.ordinary.save': '保存普通信息', 'project.text.save': '保存文字', 'project.create': '创建项目', 'project.responsibility.join': '加入负责', 'project.responsibility.leave': '退出负责' };
for (const name of ['correctStageFacts', 'undoStageStart', 'undoStageComplete', 'rollbackStage']) actionLabels['project.stage.' + name] = actionLabels[name];
export type CheckRuleContext = { configVersion: string | null; canMaintain: boolean; rule: { version: string; deadlineWeekday: number; effectiveWeek: string; savedAt: string; savedBy: string } | null; businessDate: string; weekStart: string; deadlineDate: string | null; firstCheckWeek: string | null };
export type Detail = { currentClosure: CurrentClosure | null; project: Project & TextValues & Record<string, unknown>; stages: Entry[]; stageActions: { code: string; startBlocked: string | null; completeBlocked: string | null }[]; businessDate: string; startBlocked: string | null; checkRule: CheckRuleContext; lifecycleNotes: LifecycleNote[]; nodes: NodeRecord[]; risks: RiskRecord[]; changes: ChangeRecord[]; delays: ScheduleRecord[]; planSummary: { reschedules: number; laterAdjustments: number; unknownAdjustments: number; netDays: number | null }; history: Entry[]; responsible?: { id: string; name: string; enabled: number }[]; readOnly: boolean; capabilities: { editText: boolean; editOrdinary?: boolean; join?: boolean; leave?: boolean } };
export const stageMessages: Record<string, string> = { INVALID_STAGE_COMMAND: '阶段请求无效，请重新核对表单。', INVALID_STAGE_DATE: '请核对实际日期及前后顺序。', STAGE_SEQUENCE_REVIEW_REQUIRED: '阶段记录不完整或顺序存在矛盾，需要先纠正。', PROJECT_STAGE_ACTION_BLOCKED: '项目暂缓或已结案，当前不能推进阶段。', PROJECT_START_REQUIRED: '需先明确启动项目；启动功能在后续批次接入。', STAGE_PREDECESSOR_INCOMPLETE: '请先完成前置阶段。', STAGE_STATE_CHANGED: '此阶段当前不能执行该动作，请核对阶段状态。', STAGE_DATE_REVIEW_REQUIRED: '阶段实际日期缺失或存在矛盾，请先核对并纠正。', PROJECT_READ_ONLY: '请先加入本项目负责范围。' };
Object.assign(stageMessages, { PROJECT_START_REQUIRED: '请先明确保存启动项目，再开始此阶段。', PROJECT_START_BLOCKED: '只有提案项目可以首次启动。', PROJECT_S1_REQUIRED: '请先完成S1需求立项。', PROJECT_START_HISTORY_REVIEW_REQUIRED: '已有启动或阶段日期需要核对，不能重复首次启动。', INVALID_PROJECT_COMMAND: '项目动作请求无效，请核对表单。', INVALID_PROJECT_DATE: '请核对实际启动日、S1完成日和预计结案日的顺序。', PLAN_REASON_REQUIRED: '同时调整已有计划需要填写原因。', CHECK_RULE_REQUIRED: '检查规则尚未初始化，请维护账号先明确保存。', SYSTEM_CONFIGURATION_REQUIRED: '维护账号尚未配置，请维护者核对。', MAINTENANCE_REQUIRED: '只有专用维护账号可以保存共同设置。', SETTINGS_VERSION_CONFLICT: '共同设置已更新，请重新读取并核对。', CHECK_RULE_ALREADY_INITIALIZED: '检查规则已经初始化，请读取当前规则。', CHECK_PREVIEW_CHANGED: '检查规则、截止或自然周已经变化，请重新核对后明确保存。', INVALID_CHECK_RULE_COMMAND: '检查截止请求无效，请重新核对。' });
Object.assign(actionLabels, { saveCheck: '检查项目', correctCheck: '纠正检查文字', 'project.check.save': '检查项目', 'project.check.correct': '纠正检查文字' });
Object.assign(actionLabels, { 'project.risk.add': '新增风险', 'project.risk.correct': '纠正风险', 'project.risk.resolve': '人工解除风险', 'project.risk.undoResolve': '撤销误解除风险', 'project.risk.delete': '删除误录风险' });
Object.assign(stageMessages, { INVALID_NODE_OPERATIONS: '节点修改格式无效，请核对选定字段和操作。', NODE_NOT_FOUND: '未找到本项目的节点，请重新进入核对。', NODE_STAGE_INVALID: '请选择当前项目的有效阶段。', NODE_RELATION_INVALID: '节点连线或类型无效，请核对双方及原关系。', NODE_LINK_NOT_FOUND: '原连线已不存在，请重新预览。', NODE_CYCLE: '本次完成或连线涉及循环，请先明确拆线纠正。', NODE_REPLACEMENT_CHANGED: '需要明确确认本次被替换的旧连线。', NODE_PREDECESSOR_INCOMPLETE: '前置节点尚未完成，本次不能完成。', NODE_IMPACT_CHANGED: '依赖完成日影响集合不一致，请重新预览并明确确认。', NODE_CORRECTION_REASON_REQUIRED: '请填写完成事实纠错原因。', NODE_NOT_COMPLETED: '该节点尚未完成，不能撤销完成。', NODE_ORDER_EXHAUSTED: '节点排序已达到存储上限，请联系维护人员。' });
Object.assign(stageMessages, { NODE_DELETE_LINKS_CHANGED: '请核对并明确确认删除时解除的全部旧连线。', NODE_ALREADY_DELETED: '该节点已删除，请重新进入查看已删除记录。', NODE_NOT_DELETED: '该节点当前有效，不能再次恢复。' });
Object.assign(actionLabels, { 'project.change.add': '新增需求变更', 'project.change.correct': '纠正需求变更' });
Object.assign(stageMessages, { INVALID_CHANGE_OPERATIONS: '需求变更修改格式无效，请核对选定字段。', CHANGE_NOT_FOUND: '未找到本项目的需求变更，请重新进入核对。', CHANGE_ORDER_EXHAUSTED: '需求变更排序已到存储上限，请联系维护人员。' });
Object.assign(stageMessages, { INVALID_RISK_OPERATIONS: '风险修改格式无效，请重新核对。', RISK_NOT_FOUND: '未找到本项目的风险，请重新进入核对。', RISK_ALREADY_RESOLVED: '该风险已解除，可使用纠正入口修改解除说明。', RISK_NOT_RESOLVED: '该风险当前未解除，不能撤销解除。', RISK_RESOLUTION_REQUIRES_RESOLVED: '预警中的风险不能更正解除说明，请使用明确解除。', RISK_ORDER_EXHAUSTED: '风险排序已达到存储上限，请联系维护人员。' });
Object.assign(stageMessages, { INVALID_CHECK_COMMAND: '检查请求无效，请核对结论和备注。', CHECK_REASON_REQUIRED: '请填写检查文字纠错原因。', PROJECT_CHECK_NOT_FOUND: '未找到本项目的原检查，请重新核对记录。' });
export type Account = { id: string; name: string; mustChangePassword: boolean };
Object.assign(stageMessages, { CORRECTION_REASON_REQUIRED: '请填写纠错或回退原因。', PROJECT_REOPEN_REQUIRED: '请先重新打开已结案项目，再改变阶段状态。', PROJECT_RESUME_REQUIRED: '请先恢复暂缓项目，再保存真实返工回退。' });
Object.assign(stageMessages, { INVALID_PLAN_COMMAND: '计划请求无效，请核对选定字段。', PLAN_REASON_REQUIRED: '请填写调整或纠错原因。', PLAN_NOTE_REQUIRED: '原因或措施至少填写一项。', PLAN_ALREADY_SET: '已有当前计划，请使用调整计划或明确纠错。', PLAN_REQUIRED: '当前计划未定，请先确定计划。', SCHEDULE_RECORD_NOT_FOUND: '未找到本项目的这条记录，请重新核对。', SCHEDULE_RECORD_KIND_MISMATCH: '补充说明记录不能纠正为一次改期。' });
const planLabels = { setPlan: '确定计划', reschedulePlan: '调整计划', notePlan: '补充计划说明', correctProjectDates: '纠正项目日期', correctScheduleRecord: '纠正计划历史', voidScheduleRecord: '撤销误录计划历史' };
for (const [key, value] of Object.entries(planLabels)) { actionLabels[key] = value; actionLabels['project.plan.' + key] = value; }
import { PersonalPreference } from './personal-state';
export let appearance: PersonalPreference | undefined;
let themeTouched=false;
let activityInstalled=false;
export let account: Account | undefined;
const context = new BroadcastChannel('geekdash_identity');
let contextChanged = false;
context.onmessage = event => { contextChanged = true; document.dispatchEvent(new Event('geekdash-identity-changed'));if(event.data?.clearCache)clearLocalAccountState(); };
function clearLocalAccountState(){
  if(!account)return;
  const prefixes=['geekdash_quick:','geekdash_summary:','geekdash_catalog:','geekdash_draft:','geekdash_page:','geekdash_create:','geekdash_project_buffer:','geekdash_stage_action:','geekdash_responsibility:','geekdash_preference:','geekdash_check:','geekdash_board_return:'].map(prefix=>prefix+account!.id);
  for(const storage of [localStorage,sessionStorage])try{for(const key of Object.keys(storage))if(prefixes.some(prefix=>key===prefix || key.startsWith(prefix+':')))storage.removeItem(key);}catch{/* 清理失败不重新发送旧账号数据；页面身份仍被冻结。 */}
}
function headers(active: boolean) {
  if (contextChanged) throw new SaveError('AUTH_CONTEXT_CHANGED', 'not_committed');
  const csrf = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('__Host-geekdash_csrf=') || item.startsWith('geekdash_dev_csrf='))?.split('=')[1];
  return { 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', ...(account ? { 'X-GeekDash-Account': account.id } : {}), ...(csrf ? { 'X-GeekDash-CSRF': csrf } : {}), ...(active ? { 'X-GeekDash-Active': '1' } : {}) };
}
const authMessages: Record<string, string> = { AUTH_REQUIRED: '登录已失效，请登录后重新进入。未保存内容请先复制。', AUTH_CONTEXT_CHANGED: '账号已发生变化，请先复制未保存内容，再重新进入。', PASSWORD_CHANGE_REQUIRED: '请先修改临时密码。', CSRF_INVALID: '登录凭据不完整，请重新登录。', LAST_RESPONSIBLE: '请先由其他人加入负责范围，再退出。', INVALID_CREDENTIALS: '登录名或密码不正确。', CURRENT_PASSWORD_INCORRECT: '当前密码不正确。', INVALID_PASSWORD: '新密码需要 15～128 个字符。', PASSWORD_CONFIRM_MISMATCH: '两次新密码不一致。', PASSWORD_UNCHANGED: '新密码不能与当前密码相同。', AUTH_RATE_LIMITED: '尝试过于频繁，请稍后再试。', AUTH_BUSY: '身份服务忙，请稍后再试。' };
export async function requireIdentity() {
  const data = await get<{ account: Account }>('/api/auth/me'); account = data.account;
  if (account.mustChangePassword) { location.replace('/login.html?change=1'); throw new Error('请先修改临时密码。'); }
  if(!activityInstalled){activityInstalled=true;let lastInput=0;document.addEventListener('input',event=>{
    if(!event.isTrusted || contextChanged || document.visibilityState!=='visible' || !(event.target instanceof HTMLElement) || !event.target.matches('input,textarea,select,[contenteditable="true"]') || Date.now()-lastInput<60000)return;
    lastInput=Date.now();void send('/api/auth/activity','POST',{},true).catch(error=>{if(error instanceof SaveError && ['AUTH_REQUIRED','AUTH_CONTEXT_CHANGED','PASSWORD_CHANGE_REQUIRED','CSRF_INVALID'].includes(error.code))document.dispatchEvent(new Event('geekdash-identity-changed'));});
  });}
  appearance=new PersonalPreference('appearance',message=>document.dispatchEvent(new CustomEvent('geekdash-preference-status',{detail:message})));
  const preference=await appearance.load();
  if(themeTouched)appearance.update({theme:document.documentElement.dataset.theme});else applyTheme(String(preference.theme ?? 'dark'));
  const toolbar = document.querySelector('.head-actions');
  if (toolbar && !document.getElementById('account-menu')) { const menu = document.createElement('details'); menu.id = 'account-menu'; menu.className = 'read-nav-menu'; const title = document.createElement('summary'); title.className = 'head-btn'; title.textContent = account.name + ' ▾'; const link = document.createElement('a'); link.className = 'head-btn'; link.href = '/login.html?change=1'; link.textContent = '修改密码 / 退出'; menu.append(title, link); toolbar.prepend(menu); }
  return account;
}
export function setAccount(value: Account) { account = value; contextChanged = false; }
export function notifyIdentityChange(clearCache=false) { context.postMessage(clearCache?{type:'changed',clearCache:true}:'changed');if(clearCache)clearLocalAccountState(); }
export class SaveError extends Error {
  constructor(public code: string, public outcome: string, public fields?: Record<string, string>) {
    super(authMessages[code] ?? stageMessages[code] ?? ({ PROJECT_VERSION_CONFLICT: '项目已被他人更新，请重新进入项目。', OPERATION_KEY_REUSED: '操作编号与原请求不一致，请保留文字并核对原操作。', PROJECT_READ_ONLY: '此项目只能查看。', INVALID_PROJECT_FIELDS: '请修正标出的字段。', DATABASE_UNAVAILABLE: '数据库暂时不可用，请重试。', SAVE_ROLLED_BACK: '保存未完成，修改已保留。' } as Record<string, string>)[code] ?? '保存结果尚未确认，请确认结果或重试原操作。');
  }
}
export async function send<T>(path: string, method: 'PATCH' | 'POST', body: unknown, active = true): Promise<T> {
  let response: Response;
  const requestHeaders = headers(active);
  if(path.startsWith('/api/projects') && body && typeof body==='object' && 'idempotencyKey' in body && typeof body.idempotencyKey==='string')document.dispatchEvent(new CustomEvent('geekdash-operation',{detail:body.idempotencyKey}));
  try { response = await fetch(path, { method, headers: requestHeaders, body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(10000) }); }
  catch { throw new SaveError('TRANSPORT_UNKNOWN', 'unknown'); }
  let data;
  try { data = await response.json(); } catch { throw new SaveError('RESPONSE_UNKNOWN', 'unknown'); }
  if (contextChanged) throw new SaveError('AUTH_CONTEXT_CHANGED', 'unknown');
  if (!response.ok) throw new SaveError(data.code, data.outcome ?? 'unknown', data.fields);
  return data as T;
}
export async function get<T>(path: string, signal?: AbortSignal, active = true): Promise<T> {
  let response: Response;
  const requestHeaders = headers(active);
  try { response = await fetch(path, { headers: requestHeaders, cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
  catch { throw new Error('读取超时或网络暂时不可用，请重试。'); }
  if (contextChanged) throw new SaveError('AUTH_CONTEXT_CHANGED', 'not_committed');
  if (!response.ok) { const data = await response.json().catch(() => ({})); if (data.code && authMessages[data.code]) throw new SaveError(data.code, 'not_committed'); throw new Error(response.status === 404 ? '未找到该项目，请返回列表重新选择。' : response.status === 400 ? '查询条件无效，请重新选择。' : '服务器暂时无法读取数据，请重试。'); }
  try { return await response.json(); } catch { throw new Error('服务器响应未能读取，请重试。'); }
}
export function esc(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export const labels: Record<string, string> = { proposal: '提案中', ongoing: '进行中', paused: '暂缓', closed: '已结案', high: '高', mid: '中', low: '低', green: '绿灯', yellow: '黄灯', red: '红灯', locked: '未解锁', ready: '待开始', active: '进行中', completed: '已完成', unconfigured: '阶段未配置', S1: '需求立项', S2: '项目预启动', S3: 'PEVT技术预研', S4: 'EVT集成验证', S5: 'DVT可靠性验证', S6: 'PVT量产验证', S7: 'MP量产维护', hardware_owner: '硬件负责人', software_owner: '软件负责人', pm: '项目经理', participant: '参与人', normal: '正常结案', terminated: '终止结案' };
export function label(value: unknown) { return value === 'accept' ? '接受' : value === 'reject' ? '拒绝' : Object.hasOwn(labels, String(value)) ? labels[String(value)] : String(value ?? '—'); }
Object.assign(labels, { upcoming: '未超期', due: '今日到期', overdue: '已超期', unset: '计划未定', closed_on_time: '按期完成', closed_late: '超期完成', closed_unplanned: '结案时计划未定', closed_unknown: '结案事实待核对', terminated: '终止结案' });
export function projectTags(project: Project) {
  const statuses: Record<string, string> = { ongoing: 'active', proposal: 'proposal', paused: 'hold', closed: 'closed' };
  return `${project.tags.map(tag => `<span class="st-tag">${esc(tag.name)}</span>`).join('')}<span class="signal-tag signal-${esc(project.signal)}"><span class="signal-dot"></span>${label(project.signal)}</span><span class="pri-tag pri-${esc(project.priority)}">${label(project.priority)}优先级</span><span class="st-tag st-${statuses[project.status]}">${label(project.status)}</span><span class="delay-tag" title="截至 ${esc(project.deadline.asOfDate)}">${esc(project.deadline.label)}</span>${project.dataKind === 'trial' ? '<span class="maintenance-badge">测试项目</span>' : ''}<span class="maintenance-badge" title="本周截止 ${esc(project.checkStatus.deadlineDate ?? '未初始化')}">${esc(project.checkStatus.label)}${project.checkStatus.updatedAfterCheck ? ' · 检查后有更新' : ''}</span>${project.status === 'closed' && project.maintenanceEnabled ? '<span class="maintenance-badge">量产维护</span>' : ''}`;
}
export function applyTheme(value: string) {
    document.documentElement.dataset.theme = ['dark', 'light', 'warm'].includes(value) ? value : 'dark';
    document.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach(button => button.classList.toggle('active', button.dataset.theme === document.documentElement.dataset.theme));
}
export function setupTheme() {
  applyTheme('dark');
  document.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach(button => button.onclick = () => {
    if(contextChanged)return;themeTouched=true;applyTheme(button.dataset.theme!);
    appearance?.update({theme:button.dataset.theme!});
  });
  document.addEventListener('geekdash-identity-changed',()=>applyTheme('dark'));
}
export function setupDateZone() {
  const zone = document.getElementById('date-zone'); if (!zone) return;
  const clock = () => {
    const now = new Date(), date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
    const days = Math.round((Date.parse(date.slice(0, 4) + '-12-31') - Date.parse(date)) / 86400000);
    zone.textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now) + '　' + new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now) + '　距年底 ' + days + ' 天';
  };
  clock(); setInterval(clock, 1000);
}

Object.assign(stageMessages, { INVALID_LIFECYCLE_COMMAND: '暂缓/恢复请求无效，请核对表单。', LIFECYCLE_REASON_REQUIRED: '请填写暂缓或纠错原因。', PROJECT_PAUSE_BLOCKED: '只有提案或进行中项目可以暂缓。', PROJECT_RESUME_BLOCKED: '只有暂缓项目可以恢复。', PROJECT_RESUME_BASIS_UNKNOWN: '暂缓前状态未知，需先核对来源；系统不会猜测恢复状态。', LIFECYCLE_NOTE_NOT_FOUND: '未找到本项目的原暂缓/恢复记录。', LIFECYCLE_NOTE_REQUIRED: '纠正后的暂缓原因仍需非空。' });
for (const [command, action, name] of [['pauseProject', 'project.pause', '暂缓项目'], ['resumeProject', 'project.resume', '恢复项目'], ['correctLifecycleNote', 'project.lifecycle.note.correct', '纠正暂缓/恢复说明']]) { actionLabels[command] = name; actionLabels[action] = name; }

Object.assign(stageMessages, { INVALID_CLOSURE_COMMAND: '结案请求无效，请核对选定字段。', CLOSURE_NOTE_REQUIRED: '请填写结案说明。', CLOSURE_REASON_REQUIRED: '请填写本次操作原因。', CLOSURE_REMAINING_REQUIRED: '仍有遗留事项，请填写处置说明。', INVALID_CLOSURE_DATE: '请核对结案日期与已知实际日期。', PROJECT_CLOSE_BLOCKED: '项目已经结案，不能重复结案。', PROJECT_CLOSED_REQUIRED: '此动作仅用于当前已结案项目。', CLOSURE_CHANGED: '当前结案已变化，请重新进入核对本次结案。', PROJECT_REOPEN_BASIS_UNKNOWN: '结案前状态或暂缓恢复依据未知，请核对来源；系统不会猜测。' });
for (const [command, action, name] of [['closeProject', 'project.close', '结案项目'], ['reopenProject', 'project.reopen', '重新打开项目'], ['setMaintenance', 'project.maintenance', '保存维护标识'], ['correctClosure', 'project.closure.correct', '纠正当前结案']]) { actionLabels[command] = name; actionLabels[action] = name; }
