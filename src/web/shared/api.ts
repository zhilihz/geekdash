export type DeadlineKind = 'upcoming' | 'due' | 'overdue' | 'unset' | 'closed_on_time' | 'closed_late' | 'closed_unplanned' | 'closed_unknown' | 'terminated';
export type Deadline = { kind: DeadlineKind; asOfDate: string; days: number | null; label: string };
export type Project = {
  id: string; version: string; dataKind: 'business' | 'trial'; name: string; status: string; priority: string; signal: string;
  customer: string | null; odmFactory: string | null; productLine: string | null; app: string | null; projectGroup: string | null;
  proposalDate: string | null; dueDate: string | null; marketExpectation: string; statusDesc: string;
  deadline: Deadline; checkStatus: CheckStatus; resumeStatus: string | null; maintenanceEnabled: number; updatedAt: string; stage: string; stageState: string; progress: string | number;
  chips: { id: string; name: string }[]; people: { id: string; name: string; role: string }[]; tags: { id: string; name: string }[];
};
export type List = { items: Project[]; businessDate: string; stats: Record<string, number>; options: Record<string, string[]>; stageCounts: { value: string; count: string | number }[]; pagination: { page: number; pageSize: number; total: number; pageCount: number }; readOnly: true };
export type Entry = Record<string, string | number | null>;
export type TextValues = { name: string; marketExpectation: string; detailNote: string; summaryNote: string };
export type EditValues = TextValues & { signalNote: string; chipstatNote: string; statusDesc: string; signal: string; priority: string; customerId: string | null; odmCustomerId: string | null; productLineId: string | null; appId: string | null; groupId: string | null; chipIds: string[]; tagIds: string[]; people: { id: string; role: string }[]; stagePlans?: { code: string; plannedDays: number | null; note: string }[] };
export type CatalogItem = { id: string; name: string; enabled: number; originalModel?: string; manufacturer?: string; firmwareVersion?: string };
export type Catalog = Record<string, CatalogItem[]>;
export type SaveRequest = { expectedVersion: string; idempotencyKey: string; changes: Partial<EditValues> };
export type SaveResult = { projectId: string; operationId: string; changed: boolean; savedVersion: string; values: TextValues | EditValues; savedAt: string | null; display?: Record<string, unknown> };
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
export type CheckStatus = { kind: string; label: string; required: boolean; weekStart: string; deadlineDate: string | null; onTime: boolean | null; updatedAfterCheck: boolean; latest: { id: string; actorId: string | null; actorName: string | null; checkedAt: string; conclusion: string; note: string; observedVersion: string; resultVersion: string } | null };
export type LifecycleNote = { id: string; action: string; note: string; originalNote: string; actorDisplayName: string; createdAt: string; versionBefore: string; versionAfter: string; corrections: { id: string; reason: string; actorDisplayName: string; createdAt: string }[] };
export type LifecyclePreview = { projectId: string; expectedVersion: string; changed: boolean; beforeValues: Record<string, unknown>; afterValues: Record<string, unknown>; beforeCheck: CheckStatus; afterCheck: CheckStatus; plan?: PlanPreview };
export type ProjectCommand = StageCommand | StartCommand | CorrectionCommand | PlanCommand | LifecycleCommand;
export type CorrectionPreview = { projectId: string; expectedVersion: string; stageChanges: Entry[]; beforeStages: Entry[]; progressBefore: number; progressAfter: number; reason: string; changed: boolean };
export const actionLabels: Record<string, string> = { startStage: '开始阶段', completeStage: '完成阶段', startProject: '启动项目', correctStageFacts: '纠正实际日期', undoStageStart: '撤销误开始', undoStageComplete: '撤销误完成', rollbackStage: '真实返工回退', 'project.stage.start': '开始阶段', 'project.stage.complete': '完成阶段', 'project.start': '启动项目', 'project.ordinary.save': '保存普通信息', 'project.text.save': '保存文字', 'project.create': '创建项目', 'project.responsibility.join': '加入负责', 'project.responsibility.leave': '退出负责' };
for (const name of ['correctStageFacts', 'undoStageStart', 'undoStageComplete', 'rollbackStage']) actionLabels['project.stage.' + name] = actionLabels[name];
export type CheckRuleContext = { configVersion: string | null; canMaintain: boolean; rule: { version: string; deadlineWeekday: number; effectiveWeek: string; savedAt: string; savedBy: string } | null; businessDate: string; weekStart: string; deadlineDate: string | null; firstCheckWeek: string | null };
export type Detail = { project: Project & TextValues & Record<string, unknown>; stages: Entry[]; stageActions: { code: string; startBlocked: string | null; completeBlocked: string | null }[]; businessDate: string; startBlocked: string | null; checkRule: CheckRuleContext; lifecycleNotes: LifecycleNote[]; nodes: Entry[]; risks: Entry[]; changes: Entry[]; delays: ScheduleRecord[]; planSummary: { reschedules: number; laterAdjustments: number; unknownAdjustments: number; netDays: number | null }; history: Entry[]; responsible?: { id: string; name: string; enabled: number }[]; readOnly: boolean; capabilities: { editText: boolean; editOrdinary?: boolean; join?: boolean; leave?: boolean } };
export const stageMessages: Record<string, string> = { INVALID_STAGE_COMMAND: '阶段请求无效，请重新核对表单。', INVALID_STAGE_DATE: '请核对实际日期及前后顺序。', STAGE_SEQUENCE_REVIEW_REQUIRED: '阶段记录不完整或顺序存在矛盾，需要先纠正。', PROJECT_STAGE_ACTION_BLOCKED: '项目暂缓或已结案，当前不能推进阶段。', PROJECT_START_REQUIRED: '需先明确启动项目；启动功能在后续批次接入。', STAGE_PREDECESSOR_INCOMPLETE: '请先完成前置阶段。', STAGE_STATE_CHANGED: '此阶段当前不能执行该动作，请核对阶段状态。', STAGE_DATE_REVIEW_REQUIRED: '阶段实际日期缺失或存在矛盾，请先核对并纠正。', PROJECT_READ_ONLY: '请先加入本项目负责范围。' };
Object.assign(stageMessages, { PROJECT_START_REQUIRED: '请先明确保存启动项目，再开始此阶段。', PROJECT_START_BLOCKED: '只有提案项目可以首次启动。', PROJECT_S1_REQUIRED: '请先完成S1需求立项。', PROJECT_START_HISTORY_REVIEW_REQUIRED: '已有启动或阶段日期需要核对，不能重复首次启动。', INVALID_PROJECT_COMMAND: '项目动作请求无效，请核对表单。', INVALID_PROJECT_DATE: '请核对实际启动日、S1完成日和预计结案日的顺序。', PLAN_REASON_REQUIRED: '同时调整已有计划需要填写原因。', CHECK_RULE_REQUIRED: '检查规则尚未初始化，请维护账号先明确保存。', SYSTEM_CONFIGURATION_REQUIRED: '维护账号尚未配置，请维护者核对。', MAINTENANCE_REQUIRED: '只有专用维护账号可以保存共同设置。', SETTINGS_VERSION_CONFLICT: '共同设置已更新，请重新读取并核对。', CHECK_RULE_ALREADY_INITIALIZED: '检查规则已经初始化，请读取当前规则。', CHECK_PREVIEW_CHANGED: '检查规则、截止或自然周已经变化，请重新核对后明确保存。', INVALID_CHECK_RULE_COMMAND: '检查截止请求无效，请重新核对。' });
export type Account = { id: string; name: string; mustChangePassword: boolean };
Object.assign(stageMessages, { CORRECTION_REASON_REQUIRED: '请填写纠错或回退原因。', PROJECT_REOPEN_REQUIRED: '请先重新打开已结案项目，再改变阶段状态。', PROJECT_RESUME_REQUIRED: '请先恢复暂缓项目，再保存真实返工回退。' });
Object.assign(stageMessages, { INVALID_PLAN_COMMAND: '计划请求无效，请核对选定字段。', PLAN_REASON_REQUIRED: '请填写调整或纠错原因。', PLAN_NOTE_REQUIRED: '原因或措施至少填写一项。', PLAN_ALREADY_SET: '已有当前计划，请使用调整计划或明确纠错。', PLAN_REQUIRED: '当前计划未定，请先确定计划。', SCHEDULE_RECORD_NOT_FOUND: '未找到本项目的这条记录，请重新核对。', SCHEDULE_RECORD_KIND_MISMATCH: '补充说明记录不能纠正为一次改期。' });
const planLabels = { setPlan: '确定计划', reschedulePlan: '调整计划', notePlan: '补充计划说明', correctProjectDates: '纠正项目日期', correctScheduleRecord: '纠正计划历史', voidScheduleRecord: '撤销误录计划历史' };
for (const [key, value] of Object.entries(planLabels)) { actionLabels[key] = value; actionLabels['project.plan.' + key] = value; }
export let account: Account | undefined;
const context = new BroadcastChannel('geekdash_identity');
let contextChanged = false;
context.onmessage = () => { contextChanged = true; document.dispatchEvent(new Event('geekdash-identity-changed')); };
function headers(active: boolean) {
  if (contextChanged) throw new SaveError('AUTH_CONTEXT_CHANGED', 'not_committed');
  const csrf = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith('__Host-geekdash_csrf=') || item.startsWith('geekdash_dev_csrf='))?.split('=')[1];
  return { 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', ...(account ? { 'X-GeekDash-Account': account.id } : {}), ...(csrf ? { 'X-GeekDash-CSRF': csrf } : {}), ...(active ? { 'X-GeekDash-Active': '1' } : {}) };
}
const authMessages: Record<string, string> = { AUTH_REQUIRED: '登录已失效，请登录后重新进入。未保存内容请先复制。', AUTH_CONTEXT_CHANGED: '账号已发生变化，请先复制未保存内容，再重新进入。', PASSWORD_CHANGE_REQUIRED: '请先修改临时密码。', CSRF_INVALID: '登录凭据不完整，请重新登录。', LAST_RESPONSIBLE: '请先由其他人加入负责范围，再退出。', INVALID_CREDENTIALS: '登录名或密码不正确。', CURRENT_PASSWORD_INCORRECT: '当前密码不正确。', INVALID_PASSWORD: '新密码需要 15～128 个字符。', PASSWORD_CONFIRM_MISMATCH: '两次新密码不一致。', PASSWORD_UNCHANGED: '新密码不能与当前密码相同。', AUTH_RATE_LIMITED: '尝试过于频繁，请稍后再试。', AUTH_BUSY: '身份服务忙，请稍后再试。' };
export async function requireIdentity() {
  const data = await get<{ account: Account }>('/api/auth/me'); account = data.account;
  if (account.mustChangePassword) { location.replace('/login.html?change=1'); throw new Error('请先修改临时密码。'); }
  const toolbar = document.querySelector('.head-actions');
  if (toolbar) { const link = document.createElement('a'); link.className = 'head-btn'; link.href = '/login.html?change=1'; link.textContent = account.name + ' · 密码/退出'; toolbar.prepend(link); }
  return account;
}
export function setAccount(value: Account) { account = value; contextChanged = false; }
export function notifyIdentityChange() { context.postMessage('changed'); }
export class SaveError extends Error {
  constructor(public code: string, public outcome: string, public fields?: Record<string, string>) {
    super(authMessages[code] ?? stageMessages[code] ?? ({ PROJECT_VERSION_CONFLICT: '项目已被他人更新，请重新进入项目。', OPERATION_KEY_REUSED: '操作编号与原请求不一致，请保留文字并核对原操作。', PROJECT_READ_ONLY: '此项目只能查看。', INVALID_PROJECT_FIELDS: '请修正标出的字段。', DATABASE_UNAVAILABLE: '数据库暂时不可用，请重试。', SAVE_ROLLED_BACK: '保存未完成，修改已保留。' } as Record<string, string>)[code] ?? '保存结果尚未确认，请确认结果或重试原操作。');
  }
}
export async function send<T>(path: string, method: 'PATCH' | 'POST', body: unknown, active = true): Promise<T> {
  let response: Response;
  const requestHeaders = headers(active);
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
  return `<span class="signal-tag signal-${esc(project.signal)}"><span class="signal-dot"></span>${label(project.signal)}</span><span class="pri-tag pri-${esc(project.priority)}">${label(project.priority)}优先级</span><span class="st-tag st-${statuses[project.status]}">${label(project.status)}</span><span class="delay-tag" title="截至 ${esc(project.deadline.asOfDate)}">${esc(project.deadline.label)}</span>${project.dataKind === 'trial' ? '<span class="maintenance-badge">测试项目</span>' : ''}<span class="maintenance-badge" title="本周截止 ${esc(project.checkStatus.deadlineDate ?? '未初始化')}">${esc(project.checkStatus.label)}${project.checkStatus.updatedAfterCheck ? ' · 检查后有更新' : ''}</span>${project.status === 'closed' && project.maintenanceEnabled ? '<span class="maintenance-badge">量产维护</span>' : ''}`;
}
export function setupTheme() {
  let theme = 'dark';
  try { theme = localStorage.getItem('geekdash_theme') ?? 'dark'; } catch { /* 浏览偏好不可用不阻止读取。 */ }
  function apply(value: string) {
    document.documentElement.dataset.theme = ['dark', 'light', 'warm'].includes(value) ? value : 'dark';
    document.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach(button => button.classList.toggle('active', button.dataset.theme === document.documentElement.dataset.theme));
  }
  apply(theme);
  document.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach(button => button.onclick = () => {
    apply(button.dataset.theme!);
    try { localStorage.setItem('geekdash_theme', button.dataset.theme!); } catch { /* 本机显示偏好。 */ }
  });
}

Object.assign(stageMessages, { INVALID_LIFECYCLE_COMMAND: '暂缓/恢复请求无效，请核对表单。', LIFECYCLE_REASON_REQUIRED: '请填写暂缓或纠错原因。', PROJECT_PAUSE_BLOCKED: '只有提案或进行中项目可以暂缓。', PROJECT_RESUME_BLOCKED: '只有暂缓项目可以恢复。', PROJECT_RESUME_BASIS_UNKNOWN: '暂缓前状态未知，需先核对来源；系统不会猜测恢复状态。', LIFECYCLE_NOTE_NOT_FOUND: '未找到本项目的原暂缓/恢复记录。', LIFECYCLE_NOTE_REQUIRED: '纠正后的暂缓原因仍需非空。' });
for (const [command, action, name] of [['pauseProject', 'project.pause', '暂缓项目'], ['resumeProject', 'project.resume', '恢复项目'], ['correctLifecycleNote', 'project.lifecycle.note.correct', '纠正暂缓/恢复说明']]) { actionLabels[command] = name; actionLabels[action] = name; }
