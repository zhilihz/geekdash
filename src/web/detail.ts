import './shared/detail.css';
import './shared/read.css';
import { get, send, SaveError, esc, label, projectTags, setupTheme, requireIdentity, account, stageMessages, actionLabels, dateTitles, isPlanCommand, isLifecycleCommand, isClosureCommand, isCheckCommand, type ChangeOperation, type ChangeRecord, type ChangePreview, type ChangeFields, type NodeOperation, type NodeRecord, type NodePreview, type NodeFields, type RiskOperation, type RiskRecord, type RiskPreview, type CheckCommand, type CheckPreview, type CheckPage, closureTitles, type ClosureCommand, type ClosurePreview, type LifecycleCommand, type LifecyclePreview, type PlanCommand, type PlanPreview, type ScheduleRecord, type CorrectionCommand, type CorrectionPreview, type StageCommand, type StartCommand, type ProjectCommand, type CheckRuleContext, type Detail, type Entry, type EditValues, type Catalog, type SaveRequest, type SaveResult, type AuditPage } from './shared/api';

const element = (id: string) => document.getElementById(id)!;
const id = new URLSearchParams(location.search).get('id') ?? '';
let snapshot: Detail | undefined;
let tab = 'info';
let generation = 0;
const titles: Record<keyof EditValues, string> = { name: '项目名称', marketExpectation: '市场预期', detailNote: '项目详情备注', summaryNote: '项目简介', statusDesc: '最新状态说明', signalNote: '灯色说明', chipstatNote: '芯片统计备注', signal: '信号灯', priority: '紧急程度', customerId: '客户', odmCustomerId: 'ODM 工厂', productLineId: '产品线', appId: 'APP', groupId: '分组', chipIds: '芯片', tagIds: '项目标签', people: '业务人员', stagePlans: '阶段工期与评述', riskOps: '风险未保存操作', nodeOps: '节点未保存操作', changeOps: '需求变更未保存操作' };
const keys = Object.keys(titles) as (keyof EditValues)[];
const textKeys = ['name', 'marketExpectation', 'detailNote', 'summaryNote', 'statusDesc', 'signalNote', 'chipstatNote'] as const;
const referenceFields = { customerId: 'customers', odmCustomerId: 'customers', productLineId: 'product_lines', appId: 'apps', groupId: 'project_groups', chipIds: 'chips', tagIds: 'tags', people: 'engineers' } as const;
const roles = ['pm', 'hardware_owner', 'software_owner', 'participant'];
let values: EditValues | undefined;
let catalog: Catalog | undefined;
let catalogMessage = '';
let catalogLoading = false;
let observedVersion = '0';
let editBaseVersion = '0';
let stale = false;
let authFrozen = false;
let pending: SaveRequest | undefined;
let inFlight = false;
let loading = false;
let leaving = false;
let storageFailed = false;
let bufferTimer: ReturnType<typeof setTimeout> | undefined;
type Buffer = { format: 2; baseVersion: string; values: EditValues; pending?: SaveRequest; changeDraft?: ChangeOperation; riskDraft?: RiskOperation; nodeDraft?: NodeOperation; nodeRestoreExtras?: NodeOperation[] };
let candidate: Buffer | undefined;
let legacyCopy: Buffer | undefined;
let bufferKey = '';
let changeDraft: ChangeOperation | undefined;
let riskDraft: RiskOperation | undefined;
let nodeDraft: NodeOperation | undefined;
let nodeRestoreExtras: NodeOperation[] = [];
let deletedNodes: import('./shared/api').DeletedNodePage | undefined, deletedLoading = false, deletedMessage = '', deletedGeneration = 0;
const restoredSources = new Map<string, NodeRecord>();
let stagePending: ProjectCommand | undefined;
let stageDraft: Omit<StageCommand, 'idempotencyKey'> | Omit<StartCommand, 'idempotencyKey'> | undefined;
let correctionDraft: CorrectionCommand | undefined;
let planDraft: PlanCommand | undefined;
let lifecycleDraft: LifecycleCommand | undefined;
let closureDraft: ClosureCommand | undefined;
let checkDraft: CheckCommand | undefined;
let checks: CheckPage | undefined, checksLoading = false, checksMessage = '', checksGeneration = 0;
declare const __GEEKDASH_STAGES__: { id: number; name: string; standard: string; progress: number; mid: number; milestone: string; hw: string; sw: string; biz: string }[];
const stageKey = () => `geekdash_stage_action:${account!.id}:${id}`;
function persistStage() {
  try {
    if (stagePending || stageDraft || correctionDraft || planDraft || lifecycleDraft || closureDraft || checkDraft) sessionStorage.setItem(stageKey(), JSON.stringify({ pending: stagePending, draft: stageDraft, correction: correctionDraft, plan: planDraft, lifecycle: lifecycleDraft, closure: closureDraft, check: checkDraft }));
    else sessionStorage.removeItem(stageKey());
  } catch { storageFailed = true; }
}
function stagePanel() {
  const p = snapshot!.project;
  const stages = snapshot!.stages.map(stage => ({ ...stage, ...values?.stagePlans?.find(plan => plan.code === stage.code) } as Entry));
  const doneCount = stages.filter(stage => stage.state === 'completed').length;
  const totalDays = stages.reduce((sum, stage) => sum + Number(stage.plannedDays ?? __GEEKDASH_STAGES__.find(s => 'S' + s.id === stage.code)?.mid ?? 0), 0);
  const estimated = stages.some(stage => stage.plannedDays == null);
  const maxDays = p.proposalDate && p.dueDate ? Math.round((Date.parse(p.dueDate) - Date.parse(p.proposalDate)) / 86400000) : null;
  // 复用原 renderStages 的七张卡片、四态底纹与三线展开；状态/日期及写操作由 API 提供。
  const cards = stages.map(stage => {
    const s = __GEEKDASH_STAGES__.find(item => 'S' + item.id === stage.code)!;
    const item = snapshot!.stageActions.find(item => item.code === stage.code)!;
    const cls = stage.state === 'completed' ? 'stage-done' : p.status === 'closed' ? 'stage-closed' : stage.state === 'active' && p.status !== 'paused' ? 'stage-current' : 'stage-todo';
    const action = stage.state === 'active' ? 'completeStage' : 'startStage';
    const blocked = action === 'startStage' ? item.startBlocked : item.completeBlocked;
    const button = `<button type="button" class="choice-btn choice-done" data-stage="${stage.code}" data-stage-action="${action}"${blocked ? ' disabled' : ''}>${action === 'startStage' ? '开始阶段' : '✅ 里程碑完成'}</button>`;
    return `<div class="stage-card ${cls}"><div class="stage-head"><span class="stage-idx">${esc(stage.code)}</span><span class="stage-name">${esc(s.name)}（${esc(label(stage.state))}${p.status === 'paused' ? '，暂缓保留' : ''}）</span><span class="stage-progress">进度 ${s.progress}%</span></div>
      <div class="stage-milestone"><span class="m-label">里程碑：</span>${esc(s.milestone)}</div>
      <details class="stage-lines"><summary>三线工作要点</summary><div class="line"><b>硬件</b>：${esc(s.hw)}</div><div class="line"><b>固件</b>：${esc(s.sw)}</div><div class="line"><b>业务</b>：${esc(s.biz)}</div></details>
      <div class="stage-days">预期天数 <input data-edit data-stage-plan="${stage.code}" type="number" min="0" max="65535" step="1" class="stage-days-input" aria-label="${esc(s.name)}预期天数" value="${esc(stage.plannedDays ?? '')}" placeholder="建议 ${s.mid} 天"${snapshot!.capabilities.editText ? '' : ' readonly'}>（标准 ${esc(s.standard)} / 建议 ${s.mid} 天）</div>
      <div class="stage-note-view">实际开始：${esc(stage.startedOn ?? '—')} · 实际完成：${esc(stage.completedOn ?? '—')} · 预期完成：${esc(stage.expectedEndOn ?? '—')}</div>
      <label class="stage-note-view">评述<textarea data-edit data-stage-note="${stage.code}" class="choice-note" aria-label="${esc(s.name)}评述"${snapshot!.capabilities.editText ? '' : ' readonly'}>${esc(stage.note ?? '')}</textarea></label>
      ${stage.state === 'completed' ? `<div class="stage-done-tag">✅ 里程碑已完成${stage.completedOn ? ' · ' + esc(stage.completedOn) : ''}</div><button type="button" class="choice-btn stage-rollback" data-correction="rollbackStage" data-stage="${stage.code}"${['proposal', 'ongoing'].includes(p.status) ? '' : ' disabled'}>回退到此阶段</button>` : p.status === 'closed' ? '<div class="stage-locked">⏹ 项目已结案</div>' : stage.state === 'locked' ? `<div class="stage-locked">🔒 ${esc(stageMessages[blocked ?? 'STAGE_PREDECESSOR_INCOMPLETE'])}</div>` : `<div class="stage-choice">${button}<button type="button" class="choice-btn choice-close" data-closure="closeProject" data-closure-type="terminated">⏹ 中途结案</button></div>${blocked ? `<div class="stage-locked">${esc(stageMessages[blocked] ?? blocked)}</div>` : ''}`}
      ${p.status !== 'closed' && ['active', 'completed'].includes(String(stage.state)) ? `<button type="button" class="choice-btn" data-correction="${stage.state === 'active' ? 'undoStageStart' : 'undoStageComplete'}" data-stage="${stage.code}">${stage.state === 'active' ? '撤销误开始' : '撤销误完成'}</button>` : ''}
      <div class="stage-choice-form" id="stage-form-${stage.code}"></div></div>`;
  }).join('');
  const start = p.status === 'proposal' ? `<div class="stage-card"><div class="stage-head"><span class="stage-name">正式启动项目</span></div><p>S1完成后，核对实际启动日期和预计结案日期，明确保存。启动后S2仍为待开始。</p><button class="choice-btn choice-done" id="project-start"${snapshot!.startBlocked ? ' disabled' : ''}>启动项目</button>${snapshot!.startBlocked ? `<p class="stage-locked">${esc(stageMessages[snapshot!.startBlocked] ?? snapshot!.startBlocked)}</p>` : ''}<a class="back-btn" href="/settings.html">查看公共检查规则</a><div class="stage-choice-form" id="project-start-form"></div></div>` : `<div class="stages-hint">首次应检周：${esc(p.firstCheckWeek ?? '依据未知，待核对')} · 本周截止：${esc(snapshot!.checkRule.deadlineDate ?? '规则未初始化')}</div>`;
  return `<div class="stages-wrap">${maxDays !== null && totalDays > maxDays ? `<div class="stages-error">⚠ ${estimated ? '参考工期' : '项目总工期'} <b>${totalDays}</b> 天，超过可用窗口 <b>${maxDays}</b> 天，请核对工期或项目日期。</div>` : ''}<div class="stages-hint">按顺序推进：开始和里程碑完成都需明确保存，完成后只解锁下一阶段。工期与评述统一保存项目；纠错和真实返工分别预览、明确保存。</div>${snapshot!.capabilities.editText ? `<button class="back-btn" data-correction="correctStageFacts">纠正实际日期</button><p id="error-stagePlans" class="field-error">${esc(validationErrors.stagePlans)}</p>` : ''}<div id="correction-form"></div>${correctionDraft && !stagePending ? '<button class="back-btn" id="correction-restore">恢复纠错/回退表单</button><button class="back-btn" id="correction-discard">放弃纠错/回退副本</button>' : ''}${start}<div class="stages-total">${estimated ? '参考总工期' : '项目总工期'}：<b>${totalDays}</b> 天（已完成 <b>${doneCount}</b> / 7 个阶段）${estimated ? ' · 未填工期按建议值估算，不写入项目' : ''}${maxDays !== null ? ` · 可用窗口：<b>${maxDays}</b> 天` : ''}</div>${cards}</div>`
    + (stagePending ? '<p role="status">阶段操作结果待确认。请确认原结果或重试原操作。</p><button class="back-btn" id="stage-confirm">确认原阶段结果</button> <button class="back-btn" id="stage-retry">重试原阶段操作</button>' : '')
    + (stageDraft && !stagePending ? `<button class="back-btn" id="stage-restore">恢复本标签页${stageDraft.action === 'startProject' ? '启动' : '阶段'}表单</button> <button class="back-btn" id="stage-discard">放弃动作表单副本</button>` : '');
}
async function prepareAction(action: ProjectCommand['action'], code?: string) {
  if (!snapshot || inFlight || pending || responsibilityPending || stagePending || stale || authFrozen || loading) return false;
  if (dirty()) {
    const choice = await choose('阶段动作前请处理未保存内容。', [['cancel', '继续编辑'], ['save', '保存项目后继续'], ['discard', '放弃编辑后继续']]);
    if (choice === 'cancel') return false;
    if (choice === 'save') { await saveNew(); if (dirty() || pending || stale || authFrozen) return false; }
    else { values = baseline(); riskDraft = undefined; nodeDraft = undefined; changeDraft = undefined; candidate = undefined; persist(); render(); }
  }
  if (stageDraft?.expectedVersion !== undefined && stageDraft.expectedVersion !== snapshot.project.version) { note('动作副本已过期，请复制核对后放弃，再重新填写。', true); controls(); return false; }
  if (stageDraft && (stageDraft.action !== action || stageDraft.action !== 'startProject' && stageDraft.stageCode !== code)) {
    if (await choose('已有另一个未保存动作表单，是否明确放弃后继续？', [['cancel', '保留原表单'], ['discard', '放弃原表单后继续']]) !== 'discard') return false;
    stageDraft = undefined; persistStage();
  }
  if (correctionDraft && (correctionDraft.expectedVersion !== snapshot.project.version || correctionDraft.action !== action || 'stageCode' in correctionDraft && correctionDraft.stageCode !== code)) {
    if (await choose('已有未保存纠错副本，是否放弃后继续？旧输入可先复制。', [['cancel', '保留副本'], ['discard', '放弃副本后继续']]) !== 'discard') return false;
    correctionDraft = undefined; persistStage();
  }
  if (planDraft && (planDraft.expectedVersion !== snapshot.project.version || planDraft.action !== action || 'recordId' in planDraft && planDraft.recordId !== code)) {
    if (await choose('已有计划/日期副本，是否放弃后继续？可先复制输入。', [['cancel', '保留副本'], ['discard', '放弃副本后继续']]) !== 'discard') return false;
    planDraft = undefined; persistStage();
  }
  if (lifecycleDraft && (lifecycleDraft.expectedVersion !== snapshot.project.version || lifecycleDraft.action !== action || 'auditId' in lifecycleDraft && lifecycleDraft.auditId !== code)) {
    if (await choose('已有暂缓/恢复副本，是否放弃后继续？可先复制输入。', [['cancel', '保留副本'], ['discard', '放弃副本后继续']]) !== 'discard') return false;
    lifecycleDraft = undefined; persistStage();
  }
  if (closureDraft && (closureDraft.expectedVersion !== snapshot.project.version || closureDraft.action !== action)) {
    if (await choose('已有结案操作副本，是否放弃后继续？可先复制输入。', [['cancel', '保留副本'], ['discard', '放弃副本后继续']]) !== 'discard') return false;
    closureDraft = undefined; persistStage();
  }
  if (checkDraft && (checkDraft.expectedVersion !== snapshot.project.version || checkDraft.action !== action || 'checkId' in checkDraft && checkDraft.checkId !== code)) {
    if (await choose('已有未保存检查副本，是否放弃后继续？可先复制输入。', [['cancel', '保留副本'], ['discard', '放弃副本后继续']]) !== 'discard') return false;
    checkDraft = undefined; persistStage();
  }
  return true;
}
const riskNames = { add: '新增风险', correct: '纠正风险', resolve: '人工解除风险', undoResolve: '撤销误解除' };
function validRiskDraft(value: unknown): value is RiskOperation {
  if (!value || typeof value !== 'object') return false;
  const op = value as RiskOperation;
  if (op.op === 'add') return typeof op.tempId === 'string' && typeof op.content === 'string' && ['high', 'mid', 'low'].includes(op.level);
  if (!('id' in op) || typeof op.id !== 'string') return false;
  if (op.op === 'resolve') return typeof op.resolution === 'string';
  if (op.op === 'undoResolve') return typeof op.reason === 'string';
  return op.op === 'correct' && typeof op.reason === 'string' && !!op.changes && typeof op.changes === 'object' && !Array.isArray(op.changes) && Object.entries(op.changes).every(([key, value]) => ['content', 'level', 'resolution'].includes(key) && typeof value === 'string');
}
function riskCopy(): RiskRecord[] {
  const rows = structuredClone(snapshot!.risks);
  for (const op of values?.riskOps ?? []) {
    if (op.op === 'add') rows.push({ id: op.tempId, content: op.content, level: op.level, resolved: 0, resolution: '', resolvedAt: null, createdAt: '保存后记录', createdByName: account?.name ?? null, resolvedByName: null, actorId: account?.id ?? null, sourceKey: null, sortOrder: rows.length });
    else { const row = rows.find(row => row.id === op.id); if (!row) continue;
      if (op.op === 'correct') Object.assign(row, op.changes);
      else if (op.op === 'resolve') Object.assign(row, { resolved: 1, resolution: op.resolution, resolvedAt: '保存后记录', resolvedByName: account?.name });
      else Object.assign(row, { resolved: 0, resolution: '', resolvedAt: null, resolvedByName: null });
    }
  }
  return rows;
}
function riskPanel() {
  const editable = snapshot!.capabilities.editText;
  return `<h2>风险预警</h2><p>风险由人录入、解除；预览确认只加入副本，统一保存项目后生效。</p>${editable ? '<button class="back-btn" data-risk="add">新增风险</button>' : ''}<p id="error-riskOps" class="field-error">${esc(Object.entries(validationErrors).filter(([key]) => key.startsWith('riskOps')).map(([, value]) => value).join('；'))}</p>` + riskCopy().map(r => `<article class="risk-item ${r.resolved ? 'resolved' : ''}"><div class="risk-item-head"><span class="risk-level lv-${esc(label(r.level))}">${esc(label(r.level))}</span><span class="risk-content">${esc(r.content)}</span><span class="risk-badge ${r.resolved ? 'resolved' : 'active'}">${r.resolved ? '已解除' : '预警中'}</span></div><p class="risk-meta">#${esc(r.id)} · 创建：${esc(r.createdByName ?? '原人未知')} · ${esc(r.createdAt)}（UTC）</p>${r.resolved ? `<div class="risk-resolve-info">解除方法：${esc(r.resolution)} · ${esc(r.resolvedByName ?? '原人未知')} · ${esc(r.resolvedAt ?? '原时间未知')}（UTC）</div>` : ''}${editable ? `<div class="risk-actions"><button class="risk-resolve-btn" data-risk="correct" data-risk-id="${esc(r.id)}">纠正信息</button><button class="risk-resolve-btn" data-risk="${r.resolved ? 'undoResolve' : 'resolve'}" data-risk-id="${esc(r.id)}">${r.resolved ? '撤销误解除' : '解除'}</button></div>` : ''}</article>`).join('');
}
async function openRisk(op: RiskOperation['op'], target?: string) {
  if (!snapshot?.capabilities.editText || stale || authFrozen || inFlight || pending || stagePending || responsibilityPending || loading) return;
  if (riskDraft && (riskDraft.op !== op || ('id' in riskDraft && riskDraft.id !== target))) {
    if (await choose('已有未确认风险表单，可先复制；是否明确放弃后继续？', [['cancel', '保留表单'], ['discard', '放弃后继续']]) !== 'discard') return;
    riskDraft = undefined;
  }
  const row = riskCopy().find(row => row.id === target);
  if (!riskDraft) {
    if (op !== 'add' && !row) return;
    riskDraft = op === 'add' ? { op, tempId: crypto.randomUUID(), content: '', level: 'mid' } : op === 'resolve' ? { op, id: target!, resolution: '' } : op === 'undoResolve' ? { op, id: target!, reason: '' } : { op, id: target!, changes: { content: row!.content, level: row!.level as 'high' | 'mid' | 'low', ...(row!.resolved ? { resolution: row!.resolution } : {}) }, reason: '' };
  }
  tab = 'risk'; persist(); render(); const draft = riskDraft; let preview: RiskPreview | undefined;
  const editable = draft.op === 'add' || draft.op === 'correct', data = draft.op === 'correct' ? draft.changes : draft;
  element('risk-form').innerHTML = `<form id="risk-edit" class="risk-item"><h3>${esc(riskNames[draft.op])}</h3><p>固定版本 v${esc(editBaseVersion)}；${row ? '#' + esc(row.id) : '新风险'}。${draft.op === 'undoResolve' ? '预览当前解除事实，撤销后回到预警中；原解除历史保留。' : '确认后加入未保存副本。'}</p>${editable ? `<label for="risk-content">风险内容（必填）</label><textarea id="risk-content" class="risk-note" required>${esc('content' in data ? data.content : '')}</textarea><div class="risk-form-row"><span class="risk-row-label">风险等级</span><div class="risk-level-select">${['high', 'mid', 'low'].map(level => `<button type="button" class="rlv-btn rlv-${label(level)} ${'level' in data && data.level === level ? 'active' : ''}" data-risk-level="${level}" aria-pressed="${'level' in data && data.level === level}">${label(level)}</button>`).join('')}</div></div>` : ''}${draft.op === 'resolve' || draft.op === 'correct' && Object.hasOwn(draft.changes, 'resolution') ? `<label for="risk-resolution">解除方法（必填）</label><textarea id="risk-resolution" class="risk-resolve-note" required>${esc('resolution' in data ? data.resolution : '')}</textarea>` : ''}${'reason' in draft ? `<label for="risk-reason">纠错原因（必填）</label><textarea id="risk-reason" class="risk-note" required>${esc(draft.reason)}</textarea>` : ''}<p id="risk-error" role="alert" class="field-error"></p><div id="risk-preview"></div><button type="submit" class="back-btn">预览</button><button type="button" id="risk-accept" class="back-btn" disabled>确认加入未保存修改</button><button type="button" id="risk-cancel" class="back-btn">取消</button></form>`;
  const form = element('risk-edit') as HTMLFormElement;
  const local = (id: string) => form.querySelector<HTMLElement>('#' + id)!;
  const capture = () => {
    if (draft.op === 'add' || draft.op === 'correct') { const fields = draft.op === 'add' ? draft : draft.changes; fields.content = (element('risk-content') as HTMLTextAreaElement).value; fields.level = (document.querySelector<HTMLButtonElement>('[data-risk-level].active')!.dataset.riskLevel as 'high' | 'mid' | 'low'); }
    const resolution = document.getElementById('risk-resolution') as HTMLTextAreaElement | null;
    if (resolution) { if (draft.op === 'resolve') draft.resolution = resolution.value; else if (draft.op === 'correct') draft.changes.resolution = resolution.value; }
    if ('reason' in draft) draft.reason = (element('risk-reason') as HTMLTextAreaElement).value;
    preview = undefined; local('risk-preview').innerHTML = ''; local('risk-accept').dataset.preview = 'false'; persist();
  };
  form.querySelectorAll('textarea').forEach(input => input.oninput = capture);
  form.querySelectorAll<HTMLButtonElement>('[data-risk-level]').forEach(button => button.onclick = () => { form.querySelectorAll('[data-risk-level]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); }); capture(); });
  form.onsubmit = async event => {
    event.preventDefault(); capture(); inFlight = true; controls();
    try { preview = await send<RiskPreview>('/api/projects/' + id + '/save-preview', 'POST', { expectedVersion: editBaseVersion, idempotencyKey: crypto.randomUUID(), changes: { riskOps: [...(values!.riskOps ?? []), draft] } });
      if (preview.projectId !== id || preview.expectedVersion !== editBaseVersion) throw new SaveError('RESPONSE_UNKNOWN', 'unknown');
      local('risk-preview').innerHTML = preview.events.map(item => `<div class="audit-diff"><div>修改前：<pre>${esc(showValue('risk', item.before))}</pre></div><div>修改后：<pre>${esc(showValue('risk', item.after))}</pre></div></div>`).join('') || '<p>没有实际变化。</p>'; local('risk-accept').dataset.preview = 'true'; local('risk-error').textContent = '';
    } catch (error) { const failure = error as SaveError; if (failure.code === 'PROJECT_VERSION_CONFLICT') stale = true; if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes(failure.code)) authFrozen = true; local('risk-error').textContent = failure.message + ' ' + Object.values(failure.fields ?? {}).join('；'); }
    finally { inFlight = false; controls(); }
  };
  local('risk-accept').onclick = () => { if (!preview || stale || authFrozen || inFlight) return; values!.riskOps = [...(values!.riskOps ?? []), structuredClone(draft)]; riskDraft = undefined; persist(); render(); note('风险修改已加入副本，请点击保存项目后生效。'); };
  local('risk-cancel').onclick = () => { riskDraft = undefined; persist(); render(); };
  controls();
}
const changeFields = { source: '来源', content: '变更内容', decision: '接受/拒绝', reason: '决定理由' } as const;
function validChangeDraft(value: unknown): value is ChangeOperation {
  if (!value || typeof value !== 'object') return false;
  const item = value as ChangeOperation;
  return item.op === 'add' ? typeof item.tempId === 'string' && Object.keys(changeFields).every(key => typeof item[key as keyof ChangeFields] === 'string')
    : item.op === 'correct' && typeof item.id === 'string' && typeof item.correctionReason === 'string' && !!item.changes && typeof item.changes === 'object' && !Array.isArray(item.changes) && Object.entries(item.changes).every(([key, value]) => Object.hasOwn(changeFields, key) && typeof value === 'string');
}
function changeCopy(): ChangeRecord[] {
  const rows = structuredClone(snapshot!.changes);
  for (const op of values?.changeOps ?? []) {
    if (op.op === 'add') rows.push({ id: op.tempId, source: op.source, content: op.content, decision: op.decision, reason: op.reason, actorId: account?.id ?? null, createdAt: '保存后记录', createdByName: account?.name ?? null, sourceKey: null, sortOrder: rows.length });
    else { const row = rows.find(row => row.id === op.id); if (row) Object.assign(row, op.changes); }
  }
  return rows;
}
function changePanel() {
  const editable = snapshot!.capabilities.editText;
  return `<h2>需求变更</h2><p>人工决定接受或拒绝；预览后加入副本，保存项目后生效。</p>${editable ? '<button class="back-btn" data-change="add">新增需求变更</button>' : ''}<p id="error-changeOps" class="field-error">${esc(Object.entries(validationErrors).filter(([key]) => key.startsWith('changeOps')).map(([, value]) => value).join('；'))}</p><div class="chg-list">` + changeCopy().map(c => `<article class="chg-item ${c.decision === 'reject' ? 'rejected' : ''}"><div class="chg-head"><span class="chg-src ${c.source === '客户' ? 'src-customer' : c.source === '业务' ? 'src-biz' : ''}">${esc(c.source)}${['客户', '业务'].includes(c.source) ? '' : '（待核对）'}</span><span class="chg-status ${c.decision === 'accept' ? 'st-accept' : c.decision === 'reject' ? 'st-reject' : ''}">${c.decision === 'accept' ? '接受' : c.decision === 'reject' ? '拒绝' : esc(c.decision) + '（待核对）'}</span></div><div class="chg-content">${esc(c.content)}</div><div class="chg-reason">理由：${esc(c.reason || '原理由未记录（待核对）')}</div><p class="risk-meta">#${esc(c.id)} · ${esc(c.createdByName ?? '原人未知')} · ${esc(c.createdAt)}（UTC）</p>${editable ? `<button class="risk-resolve-btn" data-change="correct" data-change-id="${esc(c.id)}">纠正信息</button>` : ''}</article>`).join('') + '</div>';
}
async function openChange(op: ChangeOperation['op'], target?: string) {
  if (!snapshot?.capabilities.editText || stale || authFrozen || inFlight || pending || stagePending || responsibilityPending || loading) return;
  if (changeDraft && (changeDraft.op !== op || 'id' in changeDraft && changeDraft.id !== target)) {
    if (await choose('已有未确认需求变更表单，可先复制；是否放弃后继续？', [['cancel', '保留表单'], ['discard', '放弃后继续']]) !== 'discard') return;
    changeDraft = undefined;
  }
  const row = changeCopy().find(row => row.id === target);
  if (!changeDraft) {
    if (op !== 'add' && !row) return;
    changeDraft = op === 'add' ? { op, tempId: crypto.randomUUID(), source: '客户', content: '', decision: 'accept', reason: '' } : { op, id: target!, changes: {}, correctionReason: '' };
  }
  tab = 'risk'; persist(); render(); const draft = changeDraft, data = draft.op === 'add' ? draft : { ...row!, ...draft.changes }; let preview: ChangePreview | undefined;
  const field = (key: keyof ChangeFields, control: string) => `<div class="chg-form-row">${draft.op === 'correct' ? `<label><input type="checkbox" data-change-field="${key}" ${Object.hasOwn(draft.changes, key) ? 'checked' : ''}>纠正</label>` : ''}<label class="chg-row-label" for="chg-${key}">${changeFields[key]}</label>${control}</div>`;
  element('change-form').innerHTML = `<form id="change-edit" class="chg-form"><h3>${draft.op === 'add' ? '新增' : '纠正'}需求变更</h3><p>固定版本 v${esc(editBaseVersion)}；${row ? '#' + esc(row.id) : '新记录'}。纠正时只提交勾选字段，原创建事实保留。</p>`
    + field('source', `<select id="chg-source">${!['客户', '业务'].includes(data.source ?? '') ? `<option value="" selected disabled>${esc(data.source ?? '')}（待核对）</option>` : ''}${['客户', '业务'].map(value => `<option ${data.source === value ? 'selected' : ''}>${value}</option>`).join('')}</select>`)
    + field('content', `<textarea id="chg-content" class="chg-content-input">${esc(data.content ?? '')}</textarea>`)
    + field('decision', `<div>${['accept', 'reject'].map(value => `<label class="chg-radio"><input type="radio" name="chg-decision" value="${value}" ${data.decision === value ? 'checked' : ''}>${value === 'accept' ? '接受' : '拒绝'}</label>`).join('')}</div>`)
    + field('reason', `<textarea id="chg-reason" class="chg-reason-input">${esc(data.reason ?? '')}</textarea>`)
    + `${draft.op === 'correct' ? `<label for="chg-correction-reason">纠错原因（必填）</label><textarea id="chg-correction-reason" class="chg-reason-input" required>${esc(draft.correctionReason)}</textarea>` : ''}<p id="change-error" role="alert" class="field-error"></p><div id="change-preview"></div><button type="submit" class="back-btn">预览</button><button type="button" id="change-accept" class="back-btn" disabled>确认加入未保存修改</button><button type="button" id="change-cancel" class="back-btn">取消</button></form>`;
  const form = element('change-edit') as HTMLFormElement;
  const capture = () => {
    const selected = draft.op === 'add' ? Object.keys(changeFields) : [...form.querySelectorAll<HTMLInputElement>('[data-change-field]:checked')].map(input => input.dataset.changeField!);
    const changes = Object.fromEntries(selected.map(key => [key, key === 'decision' ? form.querySelector<HTMLInputElement>('[name="chg-decision"]:checked')?.value ?? '' : (element('chg-' + key) as HTMLInputElement).value])) as Partial<ChangeFields>;
    if (draft.op === 'add') Object.assign(draft, changes); else { draft.changes = changes; draft.correctionReason = (element('chg-correction-reason') as HTMLTextAreaElement).value; }
    preview = undefined; element('change-preview').innerHTML = ''; element('change-accept').dataset.preview = 'false'; persist(); controls();
  };
  form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(input => input.oninput = capture);
  form.onsubmit = async event => {
    event.preventDefault(); capture(); inFlight = true; controls();
    try {
      preview = await send<ChangePreview>('/api/projects/' + id + '/save-preview', 'POST', { expectedVersion: editBaseVersion, idempotencyKey: crypto.randomUUID(), changes: { changeOps: [...(values!.changeOps ?? []), draft] } });
      if (preview.projectId !== id || preview.expectedVersion !== editBaseVersion) throw new SaveError('RESPONSE_UNKNOWN', 'unknown');
      element('change-preview').innerHTML = preview.changeEvents.map(item => `<div class="audit-diff"><div>修改前：<pre>${esc(showValue('change', item.before))}</pre></div><div>修改后：<pre>${esc(showValue('change', item.after))}</pre></div></div>`).join('') || '<p>没有实际变化。</p>';
      element('change-accept').dataset.preview = 'true'; element('change-error').textContent = '';
    } catch (error) { const failure = error as SaveError; if (failure.code === 'PROJECT_VERSION_CONFLICT') stale = true; if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes(failure.code)) authFrozen = true; element('change-error').textContent = failure.message + ' ' + Object.values(failure.fields ?? {}).join('；'); }
    finally { inFlight = false; controls(); }
  };
  element('change-accept').onclick = () => { if (!preview || stale || authFrozen || inFlight) return; values!.changeOps = [...(values!.changeOps ?? []), structuredClone(draft)]; changeDraft = undefined; persist(); render(); note('需求变更已加入副本，请点击保存项目后生效。'); };
  element('change-cancel').onclick = () => { changeDraft = undefined; persist(); render(); };
  controls();
}
function validNodeDraft(value: unknown): value is NodeOperation {
  if (!value || typeof value !== 'object') return false;
  const item = value as NodeOperation;
  const ids = (values: unknown) => Array.isArray(values) && values.every(value => typeof value === 'string');
  if (item.op === 'add') return typeof item.tempId === 'string' && ['project', 'customer'].includes(item.kind) && !!item.fields && typeof item.fields === 'object' && typeof item.fields.title === 'string';
  if (item.op === 'correct') return typeof item.id === 'string' && !!item.changes && typeof item.changes === 'object' && typeof item.reason === 'string';
  if (item.op === 'complete') return typeof item.id === 'string' && typeof item.completedOn === 'string' && (item.reason === undefined || typeof item.reason === 'string');
  if (item.op === 'uncomplete') return typeof item.id === 'string' && typeof item.reason === 'string' && ids(item.affectedIds);
  if (item.op === 'move') return typeof item.id === 'string' && Number.isFinite(item.x) && Number.isFinite(item.y);
  if (item.op === 'link') return typeof item.from === 'string' && typeof item.to === 'string' && typeof item.reason === 'string' && ids(item.affectedIds) && Array.isArray(item.replaceEdges) && item.replaceEdges.every(edge => edge && typeof edge.from === 'string' && typeof edge.to === 'string');
  if (item.op === 'delete') return typeof item.id === 'string' && Array.isArray(item.removeEdges) && item.removeEdges.every(edge => edge && typeof edge.from === 'string' && typeof edge.to === 'string');
  if (item.op === 'restore') return typeof item.id === 'string' && typeof item.reason === 'string';
  return item.op === 'unlink' && typeof item.from === 'string' && typeof item.to === 'string';
}
function nodeCopy(includeDeleted = false) {
  const rows = structuredClone([...new Map([...restoredSources.values(), ...deletedNodes?.items ?? [], ...snapshot!.nodes].map(row => [row.id, row])).values()]), targets = new Map(rows.map(row => [row.id, row]));
  const unlink = (from: string, to: string) => { const a = targets.get(from), b = targets.get(to); if (a?.nextNodeId === to) a.nextNodeId = null; if (b?.previousNodeId === from) b.previousNodeId = null; };
  for (const op of values?.nodeOps ?? []) {
    if (op.op === 'add') { const row = { id: op.tempId, kind: op.kind, stage: null, targetDate: null, output: '', note: '', ...op.fields, completedOn: null, previousNodeId: null, nextNodeId: null, x: null, y: null, sourceKey: null, sortOrder: rows.length } as NodeRecord; rows.push(row); targets.set(row.id, row); }
    else if (op.op === 'link') { op.replaceEdges.forEach(edge => unlink(edge.from, edge.to)); const a = targets.get(op.from), b = targets.get(op.to); if (a) a.nextNodeId = op.to; if (b) b.previousNodeId = op.from; }
    else if (op.op === 'unlink') unlink(op.from, op.to);
    else { const row = targets.get(op.id); if (!row) continue; if (op.op === 'correct') Object.assign(row, op.changes); else if (op.op === 'move') Object.assign(row, { x: op.x, y: op.y }); else if (op.op === 'delete') { for (const item of rows) { if (item.previousNodeId === row.id) item.previousNodeId = null; if (item.nextNodeId === row.id) item.nextNodeId = null; } row.previousNodeId = null; row.nextNodeId = null; row.deletedAt = '未保存删除'; } else if (op.op === 'restore') { row.deletedAt = null; row.previousNodeId = null; row.nextNodeId = null; } else row.completedOn = op.op === 'complete' ? op.completedOn : null; }
    if ('affectedIds' in op) op.affectedIds.forEach(key => { const row = targets.get(key); if (row) row.completedOn = null; });
  }
  return includeDeleted ? rows : rows.filter(row => !row.deletedAt);
}
const nodeLabels: Record<NodeOperation['op'], string> = { add: '新增节点', correct: '纠正节点信息', complete: '填写实际完成日', uncomplete: '纠正为未完成', move: '移动节点', link: '连接节点', unlink: '解除连线', delete: '删除节点', restore: '恢复误删节点' };
function deletedNodePanel(kind: string) {
  const items = nodeCopy(true).filter(row => row.kind === kind && row.deletedAt), editable = snapshot!.capabilities.editText;
  const pending = (values?.nodeOps ?? []).filter(op => op.op === 'delete' || op.op === 'restore');
  return `<details class="secondary-section"${deletedNodes || deletedLoading || pending.length ? ' open' : ''}><summary>已删除节点与误删恢复</summary><p>按需读取两类节点，每页20条；恢复默认不接回旧连线，仍需保存项目。</p><button class="back-btn" id="deleted-refresh">查看/重新读取已删除节点</button>${deletedNodes?.nextCursor ? '<button class="back-btn" id="deleted-more">读取更多已删除节点</button>' : ''}<p role="alert">${esc(deletedLoading ? '正在读取…' : deletedMessage)}</p>${items.map(row => { const fact = deletedNodes?.items.find(item => item.id === row.id)?.deletion; return `<article class="node-item"><h4>${esc(row.title)} #${esc(row.id)}</h4><p>${row.deletedAt === '未保存删除' ? '本次副本待删除，正式数据尚未修改。' : '删除于 ' + esc(row.deletedAt) + '（UTC） · ' + esc(fact?.actorName ?? '原删除人未知')}</p><p>阶段：${esc(row.stage ? label(row.stage) : '—')}；目标日：${esc(row.targetDate ?? '未定')}；实际日：${esc(row.completedOn ?? '未完成')}</p><p>${esc(kind === 'project' ? row.output : row.note)}</p>${fact?.beforeNode ? `<p>原连线：${esc(fact.beforeNode.previousNodeId ?? '无')} → ${esc(row.id)} → ${esc(fact.beforeNode.nextNodeId ?? '无')}；只作核对，不自动接回。</p>` : ''}${editable && row.deletedAt !== '未保存删除' ? `<button class="back-btn" data-node="restore" data-node-id="${esc(row.id)}">恢复误删节点</button>` : ''}</article>`; }).join('')}${editable ? pending.map(op => `<p>${esc(nodeLabels[op.op])} #${esc('id' in op ? op.id : '')} 尚未保存 <button class="back-btn" data-node-withdraw="${esc('id' in op ? op.id : '')}">撤回该删除/恢复副本</button></p>`).join('') : ''}</details>`;
}
async function loadDeletedNodes(more = false) {
  if (!snapshot || stale || authFrozen || inFlight || pending || stagePending || deletedLoading) return;
  const current = ++deletedGeneration, version = snapshot.project.version;
  deletedLoading = true; controls();
  try {
    const page = await get<import('./shared/api').DeletedNodePage>('/api/projects/' + id + '/deleted-nodes' + (more && deletedNodes?.nextCursor ? '?before=' + deletedNodes.nextCursor : ''));
    if (current !== deletedGeneration) return;
    if (page.projectVersion !== version || snapshot.project.version !== version) { stale = true; throw new Error('项目已被他人更新，请重新进入项目；旧副本保留供复制。'); }
    deletedNodes = { ...page, items: more ? [...deletedNodes?.items ?? [], ...page.items] : page.items }; deletedMessage = '';
  } catch (error) { if (current === deletedGeneration) { if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes((error as SaveError).code)) authFrozen = true; deletedMessage = (error as Error).message; } }
  finally { if (current === deletedGeneration) { deletedLoading = false; refreshReadView(); } }
}
async function hydrateRestoredNodes() {
  if (!values?.nodeOps?.some(op => op.op === 'restore') || stale || authFrozen) return;
  const version = editBaseVersion;
  try {
    const preview = await send<NodePreview>('/api/projects/' + id + '/save-preview', 'POST', { expectedVersion: version, idempotencyKey: crypto.randomUUID(), changes: { nodeOps: values.nodeOps } });
    if (editBaseVersion !== version || snapshot?.project.version !== version) return;
    for (const event of preview.nodeEvents) if (event.before?.deletedAt) restoredSources.set(event.id, event.before);
    render();
  } catch (error) { if ((error as SaveError).code === 'PROJECT_VERSION_CONFLICT') stale = true; if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes((error as SaveError).code)) authFrozen = true; note('恢复副本仍保留，请重新预览核对：' + (error as Error).message, true); }
}
async function withdrawNode(target: string, temporary = false) {
  if (!snapshot?.capabilities.editText || stale || authFrozen || inFlight || loading || pending || stagePending) return;
  if (await choose(temporary ? '移除这个未保存节点及引用它的副本操作？正式数据不变。' : '撤回这个节点的未保存删除或恢复？正式数据不变。', [['cancel', '保留'], ['withdraw', '撤回']]) !== 'withdraw') return;
  const references = (op: NodeOperation) => op.op === 'add' ? op.tempId === target : 'id' in op ? op.id === target : op.from === target || op.to === target;
  const operations = (values!.nodeOps ?? []).filter(op => temporary ? !references(op) && !('affectedIds' in op && op.affectedIds.includes(target)) && !('replaceEdges' in op && op.replaceEdges.some(edge => edge.from === target || edge.to === target)) : !((op.op === 'delete' || op.op === 'restore') && op.id === target));
  inFlight = true; controls();
  try {
    if (operations.length) { const preview = await send<NodePreview>('/api/projects/' + id + '/save-preview', 'POST', { expectedVersion: editBaseVersion, idempotencyKey: crypto.randomUUID(), changes: { nodeOps: operations } }); if (!preview.confirmed) throw new Error('剩余节点操作需要重新确认完成影响；原副本保留。'); }
    values!.nodeOps = operations; persist(); render(); note('该副本操作已撤回，正式数据未修改。');
  } catch (error) { if ((error as SaveError).code === 'PROJECT_VERSION_CONFLICT') stale = true; if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes((error as SaveError).code)) authFrozen = true; note((error as Error).message, true); }
  finally { inFlight = false; controls(); }
}
function nodePosition(node: NodeRecord, rows: NodeRecord[]) { const lane = Math.max(0, Number(node.stage?.slice(1) ?? 1) - 1), index = rows.filter(row => row.stage === node.stage).findIndex(row => row.id === node.id); return { x: node.x ?? 220 + index * 170, y: node.y ?? lane * 110 + 20 }; }
function nodePanel(kind: 'project' | 'customer', flow = false) {
  const rows = nodeCopy().filter(row => row.kind === kind), editable = snapshot!.capabilities.editText;
  const actions = (row: NodeRecord) => editable ? `${(['correct', 'complete', ...row.completedOn ? ['uncomplete'] : []] as NodeOperation['op'][]).map(op => `<button class="back-btn" data-node="${op}" data-node-id="${esc(row.id)}">${esc(nodeLabels[op])}</button>`).join('')}${kind === 'project' ? `<button class="back-btn" data-node="link" data-node-id="${esc(row.id)}">连接下一节点</button>${row.nextNodeId ? `<button class="back-btn" data-node="unlink" data-node-id="${esc(row.id)}">解除下一连线</button>` : ''}` : ''}${/^[1-9][0-9]*$/.test(row.id) ? `<button class="node-del" data-node="delete" data-node-id="${esc(row.id)}">删除</button>` : `<button class="node-del" data-node-withdraw="${esc(row.id)}" data-temporary="true">移除未保存节点</button>`}` : '';
  const toolbar = `<div class="nodes-toolbar"><span class="nodes-hint">共 ${rows.length} 个节点 · 已完成 ${rows.filter(row => row.completedOn).length} 个</span>${editable ? '<button class="node-add-btn" data-node="add">＋ 新增节点</button>' : ''}</div><p>编辑、完成、连线和拖动先进入副本，统一点击保存项目。</p><p id="error-nodeOps" class="field-error">${esc(Object.entries(validationErrors).filter(([key]) => key.startsWith('nodeOps')).map(([, value]) => value).join('；'))}</p>`;
  const graph = flow ? `<div class="flow-canvas"><div class="flow-inner" style="height:${Math.max(770, ...rows.map(row => nodePosition(row, rows).y + 100))}px;width:${Math.max(792, ...rows.map(row => nodePosition(row, rows).x + 170))}px">${__GEEKDASH_STAGES__.map((stage, index) => `<div class="flow-lane" style="top:${index * 110}px;height:110px"></div><div class="flow-lane-label lane-${snapshot!.stages[index].state === 'completed' ? 'done' : snapshot!.stages[index].state === 'active' ? 'current' : 'todo'}" style="top:${index * 110}px;height:110px"><span class="sl-name">S${stage.id} ${esc(stage.name)}</span><span class="sl-milestone">${esc(stage.milestone)}</span><span class="sl-state">${esc(label(snapshot!.stages[index].state))}</span></div>`).join('')}<svg class="flow-links" width="100%" height="100%">${rows.map(row => { const next = rows.find(item => item.id === row.nextNodeId); if (!next) return ''; const a = nodePosition(row, rows), b = nodePosition(next, rows); return `<path class="flow-link-path" d="M ${a.x + 140} ${a.y + 30} C ${a.x + 170} ${a.y + 30},${b.x - 30} ${b.y + 30},${b.x} ${b.y + 30}"/>`; }).join('')}</svg>${rows.map(row => { const p = nodePosition(row, rows); return `<div class="flow-node ${row.completedOn ? 'done' : 'todo'}" style="left:${p.x}px;top:${p.y}px" data-node-drag="${esc(row.id)}" tabindex="0" role="button" aria-label="${esc(row.title)}，双击编辑"><div class="fn-name">${esc(row.title || '原名称待核对')}</div><div class="fn-date">${esc(row.completedOn ? '实际完成 ' + row.completedOn : '目标 ' + (row.targetDate ?? '未定'))}</div></div>`; }).join('')}</div></div>` : '';
  return `<div class="nodes-wrap">${toolbar}${flow ? graph : `<div class="node-list">${rows.map(row => `<div class="node-item${row.completedOn ? ' done' : ''}"><div class="node-head"><span class="node-name">${esc(row.title || '原名称待核对')}</span><span class="node-stage">${esc(row.stage ? label(row.stage) : '—')}</span><span class="node-badge ${row.completedOn ? 'done' : 'todo'}">${row.completedOn ? '已完成' : '未完成'}</span></div><div class="node-dates">目标完成：${esc(row.targetDate ?? '未定')} · 实际完成：${esc(row.completedOn ?? '未完成')}</div><div class="node-output">${kind === 'project' ? '输出成果：' + esc(row.output || '—') : '备注：' + esc(row.note || '—')}</div>${row.previousNodeId ? `<p>前置：${esc(nodeCopy().find(node => node.id === row.previousNodeId)?.title ?? row.previousNodeId)}</p>` : ''}${actions(row)}</div>`).join('') || '<div class="node-empty">暂无节点</div>'}</div>`}<div id="pane"></div></div>`;
}
async function openNode(op: NodeOperation['op'], target?: string, move?: { x: number; y: number }) {
  if (!snapshot?.capabilities.editText || stale || authFrozen || inFlight || loading || pending || stagePending || responsibilityPending) return;
  if (nodeDraft && (nodeDraft.op !== op || 'id' in nodeDraft && nodeDraft.id !== target)) {
    if (!(nodeDraft.op === 'correct' && Object.keys(nodeDraft.changes).length === 0 && !nodeDraft.reason) && await choose('已有未确认节点表单，是否放弃该表单？', [['cancel', '保留'], ['discard', '放弃']]) !== 'discard') return; nodeDraft = undefined;
  }
  const rows = nodeCopy(), row = nodeCopy(true).find(row => row.id === target), kind = row?.kind === 'customer' || !row && tab === 'custnodes' ? 'customer' : 'project';
  if (!nodeDraft) nodeRestoreExtras = [];
  if (!nodeDraft) nodeDraft = op === 'add' ? { op, tempId: crypto.randomUUID(), kind, fields: { title: '', targetDate: null, ...kind === 'project' ? { stage: 'S1', output: '' } : { note: '' } } } : op === 'correct' ? { op, id: target!, changes: {}, reason: '' } : op === 'complete' ? { op, id: target!, completedOn: row?.completedOn ?? snapshot.businessDate, reason: '' } : op === 'uncomplete' ? { op, id: target!, reason: '', affectedIds: [] } : op === 'move' ? { op, id: target!, ...move! } : op === 'link' ? { op, from: target!, to: '', replaceEdges: [], affectedIds: [], reason: '' } : op === 'delete' ? { op, id: target!, removeEdges: [] } : op === 'restore' ? { op, id: target!, reason: '' } : { op, from: target!, to: row!.nextNodeId! };
  tab = kind === 'customer' ? 'custnodes' : tab === 'flow' ? 'flow' : 'nodes'; persist(); render(); const draft = nodeDraft; let preview: NodePreview | undefined;
  const data = draft.op === 'add' ? draft.fields : draft.op === 'correct' ? { ...row, ...draft.changes } : {};
  const fieldNames = { title: '节点名称', stage: '所属阶段', targetDate: '目标完成日期', output: '输出成果', note: '客户节点备注' };
  const restoredChanges = nodeRestoreExtras.find(item => item.op === 'correct');
  const restoreFields = draft.op === 'restore' ? (kind === 'project' ? ['title', 'stage', 'targetDate', 'output'] : ['title', 'targetDate', 'note']).map(key => {
    const selected = restoredChanges?.op === 'correct' && Object.hasOwn(restoredChanges.changes, key), value = selected && restoredChanges?.op === 'correct' ? restoredChanges.changes[key as keyof NodeFields] : row?.[key as keyof NodeFields];
    const field = key === 'stage' ? `<select data-restore-field="${key}"><option value="">原阶段未知</option>${__GEEKDASH_STAGES__.map(stage => `<option value="S${stage.id}"${value === 'S' + stage.id ? ' selected' : ''}>S${stage.id} ${esc(stage.name)}</option>`).join('')}</select>` : key === 'output' || key === 'note' ? `<textarea data-restore-field="${key}">${esc(value ?? '')}</textarea>` : `<input data-restore-field="${key}" type="${key === 'targetDate' ? 'date' : 'text'}" value="${esc(value ?? '')}">`;
    return `<label><input type="checkbox" data-restore-select="${key}"${selected ? ' checked' : ''}>恢复时明确纠正${fieldNames[key as keyof typeof fieldNames]}${field}</label>`;
  }).join('') + (() => { const op = nodeRestoreExtras.find(item => item.op === 'complete' || item.op === 'uncomplete'); return `<label><input type="checkbox" id="restore-actual-select"${op ? ' checked' : ''}>恢复时明确纠正实际完成日（留空表示未完成）<input id="restore-actual" type="date" max="${esc(snapshot.businessDate)}" value="${esc(op?.op === 'complete' ? op.completedOn : op ? '' : row?.completedOn ?? '')}"></label>`; })() : '';

  const fields = draft.op === 'add' || draft.op === 'correct' ? (kind === 'project' ? ['title', 'stage', 'targetDate', 'output'] : ['title', 'targetDate', 'note']).map(key => `<div class="field"><label>${draft.op === 'correct' ? `<input type="checkbox" data-node-select="${key}"${Object.hasOwn(draft.changes, key) ? ' checked' : ''}>明确纠正` : ''}${fieldNames[key as keyof typeof fieldNames]}</label>${key === 'stage' ? `<select data-node-field="${key}"><option value="">原阶段未知，请核对</option>${__GEEKDASH_STAGES__.map(stage => `<option value="S${stage.id}"${data.stage === 'S' + stage.id ? ' selected' : ''}>S${stage.id} ${esc(stage.name)}</option>`).join('')}</select>` : key === 'output' || key === 'note' ? `<textarea data-node-field="${key}">${esc(data[key as keyof NodeFields] ?? '')}</textarea>` : `<input data-node-field="${key}" type="${key === 'targetDate' ? 'date' : 'text'}" value="${esc(data[key as keyof NodeFields] ?? '')}">`}</div>`).join('') : draft.op === 'complete' ? `<label>实际完成日期<input id="node-completed" type="date" max="${esc(snapshot.businessDate)}" value="${esc(draft.completedOn)}"></label>` : draft.op === 'link' ? `<label>下一节点<select id="node-to"><option value="">请选择</option>${rows.filter(node => node.kind === 'project' && node.id !== draft.from).map(node => `<option value="${esc(node.id)}"${node.id === draft.to ? ' selected' : ''}>${esc(node.title)}</option>`).join('')}</select></label><label><input type="checkbox" id="node-replace">明确确认替换本次涉及的旧连线</label><p id="node-old-lines"></p>` : draft.op === 'move' ? `<p>位置：${draft.x}, ${draft.y}</p>` : `<p>${esc(row?.title ?? target)}：${draft.op === 'uncomplete' ? '实际完成日期将明确清空' : '解除当前下一连线'}</p>`;
  element('pane').innerHTML = `<form id="node-edit" class="node-form"><h3>${esc(nodeLabels[draft.op])}</h3><div class="node-form-grid">${draft.op === 'delete' ? `<p>${esc(row?.title ?? target)}：从有效节点移除，保留原字段供恢复；邻居不删除、不桥接。</p><label><input type="checkbox" id="node-remove-edges">明确确认解除下面列出的全部原连线</label><p id="node-delete-lines"></p>` : draft.op === 'restore' ? `<p>${esc(row?.title ?? target)}：保留原ID和字段恢复，默认无前后线。确认加入副本后可继续原信息纠正/连线，最终保存项目。</p>${restoreFields}` : fields}</div>${'reason' in draft ? `<label>${draft.op === 'restore' ? '恢复原因（必填）' : draft.op === 'complete' ? '完成日期纠错时必填原因' : draft.op === 'link' ? '联动纠正完成日时必填原因' : '纠错原因'}<textarea id="node-reason">${esc(draft.reason ?? '')}</textarea></label>` : ''}${'affectedIds' in draft ? '<label><input type="checkbox" id="node-impact">明确确认预览列出的依赖完成日一并清空</label>' : ''}<p id="node-error" class="field-error" role="alert"></p><div id="node-preview"></div><button type="submit" class="back-btn">预览</button><button type="button" id="node-accept" class="back-btn" disabled>确认加入未保存修改</button><button type="button" id="node-cancel" class="back-btn">取消</button>${draft.op === 'correct' && row && /^[1-9][0-9]*$/.test(row.id) ? '<button type="button" id="node-delete-selected" class="node-del">删除这个节点</button>' : ''}</form>`;
  const form = element('node-edit') as HTMLFormElement, local = (key: string) => form.querySelector<HTMLElement>('#' + key)!;
  if (draft.op === 'correct' && row) {
    const related = document.createElement('div'); related.className = 'edit-actions';
    related.innerHTML = `<span>实际完成：${esc(row.completedOn ?? '未完成')} · 前置：${esc(rows.find(item => item.id === row.previousNodeId)?.title ?? (row.previousNodeId ? '原关联待核对' : '无'))}</span>` + (['complete', ...row.completedOn ? ['uncomplete'] : [], ...kind === 'project' ? ['link', ...row.nextNodeId ? ['unlink'] : []] : []] as NodeOperation['op'][]).map(action => `<button type="button" class="back-btn" data-node-form-action="${action}">${esc(nodeLabels[action])}</button>`).join('');
    form.querySelector('h3')!.after(related);
    related.querySelectorAll<HTMLButtonElement>('[data-node-form-action]').forEach(button => button.onclick = () => { void openNode(button.dataset.nodeFormAction as NodeOperation['op'], row.id); });
  }
  let impact: string[] = [];
  const capture = () => {
    if (draft.op === 'add' || draft.op === 'correct') {
      const fields: Partial<NodeFields> = {};
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-node-field]').forEach(input => { const key = input.dataset.nodeField as keyof NodeFields; if (draft.op === 'add' || form.querySelector<HTMLInputElement>(`[data-node-select="${key}"]`)!.checked) { if (key === 'targetDate') fields.targetDate = input.value || null; else fields[key] = input.value; } });
      if (draft.op === 'add') draft.fields = fields as typeof draft.fields; else draft.changes = fields;
    } else if (draft.op === 'complete') draft.completedOn = (local('node-completed') as HTMLInputElement).value;
    else if (draft.op === 'delete') {
      const old = new Map<string, { from: string; to: string }>();
      const add = (from: string | null, to: string | null) => { if (from && to) old.set(from + ':' + to, { from, to }); };
      if (row) { add(row.previousNodeId, row.id); add(row.id, row.nextNodeId); for (const item of rows) { if (item.nextNodeId === row.id) add(item.id, row.id); if (item.previousNodeId === row.id) add(row.id, item.id); } }
      local('node-delete-lines').textContent = '将解除：' + ([...old.values()].map(edge => (rows.find(row => row.id === edge.from)?.title ?? edge.from) + ' → ' + (rows.find(row => row.id === edge.to)?.title ?? edge.to)).join('；') || '无');
      draft.removeEdges = (local('node-remove-edges') as HTMLInputElement).checked ? [...old.values()] : [];
    }
    else if (draft.op === 'link') {
      draft.to = (local('node-to') as HTMLSelectElement).value;
      const from = rows.find(row => row.id === draft.from), to = rows.find(row => row.id === draft.to), old = new Map<string, { from: string; to: string }>();
      if (from?.nextNodeId && from.nextNodeId !== draft.to) old.set(from.id + ':' + from.nextNodeId, { from: from.id, to: from.nextNodeId });
      if (to?.previousNodeId && to.previousNodeId !== draft.from) old.set(to.previousNodeId + ':' + to.id, { from: to.previousNodeId, to: to.id });
      local('node-old-lines').textContent = '将解除：' + ([...old.values()].map(edge => (rows.find(row => row.id === edge.from)?.title ?? edge.from) + ' → ' + (rows.find(row => row.id === edge.to)?.title ?? edge.to)).join('；') || '无');
      draft.replaceEdges = (local('node-replace') as HTMLInputElement).checked ? [...old.values()] : [];
    }
    if ('reason' in draft) draft.reason = (local('node-reason') as HTMLTextAreaElement).value;
    if (draft.op === 'restore') {
      nodeRestoreExtras = []; const changes: Partial<NodeFields> = {};
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-restore-field]').forEach(input => { const key = input.dataset.restoreField as keyof NodeFields; if (form.querySelector<HTMLInputElement>(`[data-restore-select="${key}"]`)!.checked) { if (key === 'targetDate') changes.targetDate = input.value || null; else changes[key] = input.value; } });
      if (Object.keys(changes).length) nodeRestoreExtras.push({ op: 'correct', id: draft.id, changes, reason: draft.reason });
      if ((local('restore-actual-select') as HTMLInputElement).checked) { const date = (local('restore-actual') as HTMLInputElement).value; if (date) nodeRestoreExtras.push({ op: 'complete', id: draft.id, completedOn: date, reason: draft.reason }); else if (row?.completedOn) nodeRestoreExtras.push({ op: 'uncomplete', id: draft.id, reason: draft.reason, affectedIds: [] }); }
    }

    if ('affectedIds' in draft) draft.affectedIds = (local('node-impact') as HTMLInputElement).checked ? impact : [];
    preview = undefined; local('node-accept').dataset.preview = 'false'; persist();
  };
  form.querySelectorAll('input,select,textarea').forEach(input => input.addEventListener('input', capture));
  form.onsubmit = async event => {
    event.preventDefault(); capture(); inFlight = true; controls();
    try {
      preview = await send<NodePreview>('/api/projects/' + id + '/save-preview', 'POST', { expectedVersion: editBaseVersion, idempotencyKey: crypto.randomUUID(), changes: { nodeOps: [...values!.nodeOps ?? [], draft, ...draft.op === 'restore' ? nodeRestoreExtras : []] } });
      if (preview.projectId !== id || preview.expectedVersion !== editBaseVersion) throw new SaveError('RESPONSE_UNKNOWN', 'unknown');
      impact = preview.requiredUncompleteIds.filter(key => !(values!.nodeOps ?? []).some(op => 'affectedIds' in op && op.affectedIds.includes(key)));
      local('node-preview').innerHTML = preview.nodeEvents.map(item => `<div class="audit-diff"><div>原值：<pre>${esc(showValue('node', item.before))}</pre></div><div>拟值：<pre>${esc(showValue('node', item.after))}</pre></div></div>`).join('') + (preview.confirmed ? '<p>影响已核对，确认后仍需保存项目。</p>' : `<p>需要明确一并清空完成日期：${esc(preview.requiredUncompleteIds.map(key => rows.find(row => row.id === key)?.title ?? key).join('、'))}。勾选上方确认并填写原因，再次预览。</p>`);
      local('node-accept').dataset.preview = String(preview.confirmed); local('node-error').textContent = '';
    } catch (error) { const failure = error as SaveError; if (failure.code === 'PROJECT_VERSION_CONFLICT') stale = true; if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes(failure.code)) authFrozen = true; local('node-error').textContent = failure.message + ' ' + Object.values(failure.fields ?? {}).join('；'); }
    finally { inFlight = false; controls(); }
  };
  local('node-accept').onclick = () => { if (!preview?.confirmed || stale || authFrozen || inFlight) return; for (const event of preview.nodeEvents) if (event.before?.deletedAt) restoredSources.set(event.id, event.before); values!.nodeOps = [...values!.nodeOps ?? [], structuredClone(draft), ...draft.op === 'restore' ? structuredClone(nodeRestoreExtras) : []]; nodeDraft = undefined; nodeRestoreExtras = []; persist(); render(); note('节点操作已加入副本，请点击保存项目后生效。'); };
  const selectedDelete = document.getElementById('node-delete-selected'); if (selectedDelete) selectedDelete.onclick = () => { void openNode('delete', target); };
  if (draft.op === 'delete') capture();
  local('node-cancel').onclick = () => { nodeDraft = undefined; nodeRestoreExtras = []; persist(); render(); }; controls();
}
function bindNodes() {
  document.querySelectorAll<HTMLButtonElement>('[data-node]').forEach(button => button.onclick = () => { void openNode(button.dataset.node as NodeOperation['op'], button.dataset.nodeId); });
  document.querySelectorAll<HTMLButtonElement>('[data-node-withdraw]').forEach(button => button.onclick = () => { void withdrawNode(button.dataset.nodeWithdraw!, button.dataset.temporary === 'true'); });
  for (const [name, more] of [['deleted-refresh', false], ['deleted-more', true]] as const) { const button = document.getElementById(name); if (button) button.onclick = () => { void loadDeletedNodes(more); }; }
  document.querySelectorAll<HTMLElement>('[data-node-drag]').forEach(node => {
    node.ondblclick = () => { void openNode('correct', node.dataset.nodeDrag); };
    node.onkeydown = event => { if (event.key === 'Enter') void openNode('correct', node.dataset.nodeDrag); };
    node.onpointerdown = event => {
      if (!snapshot?.capabilities.editText || stale || authFrozen || inFlight || pending || stagePending || nodeDraft || loading || event.button !== 0) return;
      const x = parseFloat(node.style.left), y = parseFloat(node.style.top), startX = event.clientX, startY = event.clientY;
      node.setPointerCapture(event.pointerId); node.classList.add('dragging');
      node.onpointermove = move => { node.style.left = Math.max(190, x + move.clientX - startX) + 'px'; node.style.top = Math.max(0, y + move.clientY - startY) + 'px'; };
      const finish = (up: PointerEvent, cancel = false) => { node.onpointermove = null; node.onpointerup = null; node.onpointercancel = null; node.classList.remove('dragging'); const moved = { x: Math.round(parseFloat(node.style.left) * 1000) / 1000, y: Math.round(parseFloat(node.style.top) * 1000) / 1000 }; if (cancel || Math.abs(up.clientX - startX) + Math.abs(up.clientY - startY) < 3) render(); else void openNode('move', node.dataset.nodeDrag, moved); };
      node.onpointerup = finish; node.onpointercancel = event => finish(event, true);
    };
  });
}
async function loadChecks(more = false) {
  if (!snapshot || checksLoading || inFlight || stagePending || authFrozen || stale) return;
  const current = ++checksGeneration, base = snapshot.project.version, cursor = more ? checks?.nextCursor : null;
  checksLoading = true; checksMessage = '正在读取检查记录…'; controls();
  try {
    const page = await get<CheckPage>(`/api/projects/${id}/checks${cursor ? '?before=' + encodeURIComponent(cursor) : ''}`);
    if (current !== checksGeneration) return;
    if (page.projectVersion !== base) { stale = true; checksMessage = '项目已更新，请复制输入并重新进入，检查历史未混入旧视图。'; return; }
    checks = { ...page, items: more ? [...(checks?.items ?? []), ...page.items] : page.items }; checksMessage = '';
  } catch (error) { checksMessage = (error as Error).message + '，原展示保留，可重新读取。'; }
  finally { checksLoading = false; if (current === checksGeneration) refreshReadView(); }
}
function checkHistory() {
  return `<details class="secondary-section"${checks || checksLoading ? ' open' : ''}><summary>检查历史与结论纠正</summary><p>${esc(snapshot!.project.checkStatus.label)}${snapshot!.project.checkStatus.updatedAfterCheck ? ' · 检查后有更新' : ''}；本周 ${esc(snapshot!.checkRule.weekStart)}，截止 ${esc(snapshot!.checkRule.deadlineDate ?? '未初始化')}（全天）。</p><p>核对服务端已保存版本后明确保存；两种结论都不自动解决项目事项。已结案也可主动核对。</p><button class="back-btn" id="checks-refresh">${checks ? '重新读取' : '读取'}检查历史</button><p role="status">${esc(checksMessage)}</p>${checks?.items.map(record => `<article class="audit-entry"><h3>#${esc(record.id)} · ${esc(record.actorName)} · ${esc(record.checkedAt)}（UTC）</h3><p>所属周 ${esc(record.weekStart)}；${record.conclusion === 'follow_up' ? '已核对，需跟进' : '已核对'}；${record.onTime === null ? '截止依据待核对' : record.onTime ? '按当前采用截止按时' : '晚于当前采用截止'} ${esc(record.deadlineDate)}，规则 #${esc(record.effectiveRuleVersion)}。核对 v${esc(record.observedVersion)}，保存至 v${esc(record.resultVersion)}。</p><p>${esc(record.note || '（无备注）')}</p><details><summary>原文与更正来源</summary><p>${esc(record.original.conclusion === 'follow_up' ? '已核对，需跟进' : '已核对')} · ${esc(record.original.note || '（无备注）')}；当时规则 #${esc(record.ruleVersion)}，截止 ${esc(record.originalDeadlineDate)}，${record.originalOnTime ? '按时' : '晚于当时截止'}。</p>${record.correction ? `<p>最新更正：${esc(record.correction.actorName)} · ${esc(record.correction.createdAt)}（UTC） · ${esc(record.correction.reason)}。全部历史见修改历史。</p>` : ''}</details>${snapshot!.capabilities.editText ? `<button class="back-btn" data-check="correctCheck" data-check-id="${esc(record.id)}">纠正这次检查</button>` : ''}</article>`).join('') ?? ''}${checks?.nextCursor ? '<button class="back-btn" id="checks-more">读取更早检查</button>' : ''}</details>`;
}
async function openCheck(action: CheckCommand['action'], checkId?: string) {
  if (!await prepareAction(action, checkId) || !snapshot?.capabilities.editText) return;
  let context: CheckRuleContext;
  try { context = await get<CheckRuleContext>('/api/settings/check-rule'); }
  catch (error) { note((error as Error).message, true); return; }
  if (!checkDraft) {
    const base = { expectedVersion: snapshot.project.version, idempotencyKey: crypto.randomUUID() };
    if (action === 'saveCheck') {
      if (!context.rule) { note('检查规则未初始化，请维护者到设置明确保存。', true); return; }
      checkDraft = { ...base, action, conclusion: 'checked', note: '', ruleVersion: context.rule.version, previewWeek: context.weekStart };
    } else {
      const record = checks?.items.find(record => record.id === checkId);
      if (!record) { note('请先读取检查历史，再选择需要纠正的记录。', true); return; }
      checkDraft = { ...base, action, checkId: record.id, conclusion: record.conclusion, note: record.note, reason: '' };
    }
  }
  const draft = checkDraft; render(); let preview: CheckPreview | undefined;
  const ruleText = () => `当前周 ${context.weekStart}，截止 ${context.deadlineDate ?? '未初始化'}（全天），规则 #${context.rule?.version ?? '未知'}。`;
  element('check-form').innerHTML = `<form id="check-edit" class="stage-card"><h2>${esc(actionLabels[action])}</h2><p>固定项目 v${esc(draft.expectedVersion)}；${draft.action === 'correctCheck' ? '原检查 #' + esc(draft.checkId) + '；原人、时间、周及核对版本保持。' : esc(ruleText())}</p>${draft.action === 'saveCheck' ? '<p id="check-rule-warning"></p><button type="button" class="back-btn" id="check-rule-refresh">重新核对本周检查规则</button>' : ''}<label for="check-conclusion">检查结论</label><select id="check-conclusion"><option value="checked"${draft.conclusion === 'checked' ? ' selected' : ''}>已核对</option><option value="follow_up"${draft.conclusion === 'follow_up' ? ' selected' : ''}>已核对，需跟进</option></select><label for="check-note">备注（选填；纠正时留空表示明确清空）</label><textarea id="check-note" class="choice-note">${esc(draft.note)}</textarea>${draft.action === 'correctCheck' ? `<label for="check-reason">纠错原因（必填）</label><textarea id="check-reason" class="choice-note" required>${esc(draft.reason)}</textarea>` : ''}<p id="check-error" class="field-error" role="alert"></p><div id="check-preview" aria-live="polite"></div><button type="submit" class="choice-btn">预览检查</button><button type="button" id="check-save" class="choice-btn" disabled>保存${esc(actionLabels[action])}</button><button type="button" id="check-cancel" class="choice-btn">取消</button></form>`;
  const capture = () => {
    const before = JSON.stringify(draft);
    draft.conclusion = (element('check-conclusion') as HTMLSelectElement).value as CheckCommand['conclusion']; draft.note = (element('check-note') as HTMLTextAreaElement).value;
    if (draft.action === 'correctCheck') draft.reason = (element('check-reason') as HTMLTextAreaElement).value;
    if (before !== JSON.stringify(draft)) draft.idempotencyKey = crypto.randomUUID();
    preview = undefined; delete element('check-save').dataset.preview; element('check-preview').textContent = '请重新预览，明确保存后生效。'; persistStage(); controls();
  };
  const warning = () => { if (draft.action === 'saveCheck') element('check-rule-warning').textContent = ruleText() + (draft.ruleVersion !== context.rule?.version || draft.previewWeek !== context.weekStart ? ' 原副本依据已变化，请重新核对规则再预览。' : ''); }; warning();
  element('check-edit').oninput = capture;
  element('check-cancel').onclick = () => { capture(); render(); };
  const refresh = document.getElementById('check-rule-refresh'); if (refresh) refresh.onclick = async () => {
    if (inFlight || stale || authFrozen || stagePending) return;
    inFlight = true; controls();
    try {
      context = await get<CheckRuleContext>('/api/settings/check-rule');
      if (draft.action === 'saveCheck' && context.rule) { draft.ruleVersion = context.rule.version; draft.previewWeek = context.weekStart; draft.idempotencyKey = crypto.randomUUID(); capture(); }
      warning();
    } catch (error) { element('check-error').textContent = (error as Error).message; }
    finally { inFlight = false; controls(); }
  };
  element('check-edit').onsubmit = async event => {
    event.preventDefault(); capture(); if (inFlight || loading || stale || authFrozen || stagePending || pending || responsibilityPending || dirty()) return;
    const exact = JSON.stringify(draft); inFlight = true; controls();
    try {
      const result = await send<CheckPreview>(`/api/projects/${id}/actions/preview`, 'POST', draft);
      if (exact !== JSON.stringify(draft)) return;
      preview = result;
      element('check-preview').innerHTML = `<p>${result.beforeValues ? '原有效结论：' + esc(result.beforeValues.check.conclusion === 'follow_up' ? '已核对，需跟进' : '已核对') + '；原备注：' + esc(result.beforeValues.check.note || '（空）') : '本次按服务器实际保存时间新增检查，不回填早期时间。'}</p><p>拟结论：${esc(result.afterValues.check.conclusion === 'follow_up' ? '已核对，需跟进' : '已核对')}；拟备注：${esc(result.afterValues.check.note || '（空）')}。</p><p>${result.checkedAt ? '原检查 ' + esc(result.actorName) + ' · ' + esc(result.checkedAt) + '（UTC），所属周 ' + esc(result.weekStart) + '，事实保持。' : '本周截止 ' + esc(result.deadlineDate) + '；若现在保存，' + (result.onTime ? '按时' : '晚于截止') + '。实际记录由保存时重新确定。'}</p><p>${result.changed ? '明确保存后生效。' : '内容一致，不新增版本或检查。'}</p>`;
      element('check-save').dataset.preview = 'true';
    } catch (error) {
      if (error instanceof SaveError && error.code === 'PROJECT_VERSION_CONFLICT') stale = true;
      if (error instanceof SaveError && ['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes(error.code)) authFrozen = true;
      element('check-error').textContent = (error as Error).message;
    } finally { inFlight = false; controls(); }
  };
  element('check-save').onclick = async () => { if (!preview || dirty() || inFlight || stale || authFrozen || pending || stagePending || responsibilityPending) return; stagePending = structuredClone(draft); persistStage(); await executeStage(false); };
  persistStage(); controls();
}
async function openClosure(action: ClosureCommand['action'], initialType: 'normal' | 'terminated' = 'normal') {
  if (!await prepareAction(action) || !snapshot?.capabilities.editText) return;
  if (!closureDraft) {
    const base = { expectedVersion: snapshot.project.version, idempotencyKey: crypto.randomUUID() }, closureAuditId = snapshot.currentClosure?.auditId ?? null;
    closureDraft = action === 'closeProject' ? { ...base, action, closureType: initialType, closedOn: snapshot.businessDate, closureNote: '', remainingWorkNote: '' }
      : action === 'setMaintenance' ? { ...base, action, enabled: !snapshot.project.maintenanceEnabled, reason: '' }
      : action === 'reopenProject' ? { ...base, action, closureAuditId, reason: '' } : { ...base, action, closureAuditId, changes: {}, reason: '' };
  }
  const draft = closureDraft; render();
  let preview: ClosurePreview | undefined;
  const input = (key: keyof typeof closureTitles, value: unknown) => key === 'closureType' ? `<select id="closure-${key}"><option value="normal"${value === 'normal' ? ' selected' : ''}>正常完成</option><option value="terminated"${value === 'terminated' ? ' selected' : ''}>中途终止</option></select>`
    : key === 'closedOn' || key === 'closureDueDate' ? `<input type="date" id="closure-${key}" value="${esc(value)}">` : `<textarea class="choice-note" id="closure-${key}">${esc(value)}</textarea>`;
  const selected = draft.action === 'correctClosure' ? Object.keys(closureTitles) as (keyof typeof closureTitles)[] : draft.action === 'closeProject' ? ['closureType', 'closedOn', 'closureNote', 'remainingWorkNote'] as const : [];
  const fields = selected.map(key => `<div class="field"><label for="closure-${key}">${esc(closureTitles[key])}</label>${draft.action === 'correctClosure' ? `<label><input type="checkbox" id="closure-select-${key}"${Object.hasOwn(draft.changes, key) ? ' checked' : ''}>明确纠正此项</label>` : ''}${input(key, draft.action === 'correctClosure' ? Object.hasOwn(draft.changes, key) ? draft.changes[key] : snapshot!.project[key] : draft.action === 'closeProject' && key !== 'closureDueDate' ? draft[key] : '')}${draft.action === 'correctClosure' && ['closedOn', 'closureDueDate'].includes(key) ? `<label><input type="checkbox" id="closure-unknown-${key}"${draft.changes[key] === null ? ' checked' : ''}>明确纠正为${key === 'closedOn' ? '日期未知' : '计划未定'}</label>` : ''}</div>`).join('');
  element('closure-form').innerHTML = `<form id="closure-edit" class="stage-card"><h2>${esc(actionLabels[action])}</h2><p>进入版本 ${esc(draft.expectedVersion)}。${draft.action === 'reopenProject' ? '恢复到 ' + esc(label(snapshot.project.preCloseStatus)) + '，保留闭案期间最新修改，关闭维护；不自动开工。' : draft.action === 'setMaintenance' ? '将' + (draft.enabled ? '开启' : '结束') + '结案后维护。项目仍已结案，S7保持。' : '阶段真实进度保持；保存前核对日期及遗留事项。纠正结案时计划不会修改当前计划。'}</p>${fields}${'reason' in draft ? `<label for="closure-reason">本次操作原因（必填）</label><textarea class="choice-note" id="closure-reason" required>${esc(draft.reason)}</textarea>` : ''}<p id="closure-error" class="field-error" role="alert"></p><div id="closure-preview" aria-live="polite"></div><button type="submit" class="choice-btn">预览影响</button><button type="button" class="choice-btn" id="closure-save" disabled>保存${esc(actionLabels[action])}</button><button type="button" class="choice-btn" id="closure-cancel">取消</button></form>`;
  const capture = () => {
    const before = JSON.stringify(draft);
    if ('reason' in draft) draft.reason = (element('closure-reason') as HTMLTextAreaElement).value;
    for (const key of selected) {
      const value = (element('closure-' + key) as HTMLInputElement).value;
      if (draft.action === 'correctClosure') {
        if ((element('closure-select-' + key) as HTMLInputElement).checked) draft.changes[key] = (document.getElementById('closure-unknown-' + key) as HTMLInputElement | null)?.checked ? null : value;
        else delete draft.changes[key];
      } else if (draft.action === 'closeProject') Object.assign(draft, { [key]: value });
    }
    if (before !== JSON.stringify(draft)) draft.idempotencyKey = crypto.randomUUID();
    preview = undefined; (element('closure-save') as HTMLButtonElement).disabled = true; element('closure-preview').textContent = '输入已变化，请重新预览。'; persistStage();
  };
  element('closure-edit').oninput = capture;
  element('closure-cancel').onclick = () => { capture(); render(); };
  element('closure-edit').onsubmit = async event => {
    event.preventDefault(); capture();
    if (dirty() || inFlight || loading || stale || authFrozen || pending || stagePending || responsibilityPending) return;
    const exact = JSON.stringify(draft); inFlight = true; controls();
    try {
      const result = await send<ClosurePreview>(`/api/projects/${id}/actions/preview`, 'POST', draft);
      if (exact !== JSON.stringify(draft)) { element('closure-error').textContent = '输入已变化，请重新预览。'; return; }
      preview = result;
      element('closure-preview').innerHTML = `<h3>保存影响</h3>${Object.entries({ status: '总体状态', ...closureTitles, maintenanceEnabled: '维护标识' }).map(([key, title]) => `<p>${esc(title)}：${esc(label(result.beforeValues.closure[key]))} → ${esc(label(result.afterValues.closure[key]))}</p>`).join('')}<p>阶段实际进度保持 ${result.progress}%；日期结果 ${esc(result.beforeDeadline.label)} → ${esc(result.afterDeadline.label)}；本周检查 ${esc(result.beforeCheck.label)} → ${esc(result.afterCheck.label)}。</p><h3>当前遗留</h3><p>阶段：${esc(result.remaining.stages.map(item => label(item.code) + '：' + label(item.state)).join(' / ') || '无')}；节点：${esc(result.remaining.nodes.map(item => item.title).join(' / ') || '无')}；风险：${esc(result.remaining.risks.map(item => item.content).join(' / ') || '无')}。</p><p>${result.changed ? '明确保存后生效。' : '内容一致，不新增版本或修改历史。'}</p>`;
      element('closure-error').textContent = ''; (element('closure-save') as HTMLButtonElement).disabled = false;
    } catch (error) {
      const failure = error as SaveError;
      if (['PROJECT_VERSION_CONFLICT', 'CLOSURE_CHANGED'].includes(failure.code)) stale = true;
      if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID'].includes(failure.code)) authFrozen = true;
      element('closure-error').textContent = Object.values(failure.fields ?? {})[0] ?? failure.message;
    } finally { inFlight = false; controls(); }
  };
  element('closure-save').onclick = async () => {
    if (!preview || inFlight || loading || stale || authFrozen || dirty() || draft.expectedVersion !== snapshot!.project.version) return;
    stagePending = structuredClone(draft); persistStage(); await executeStage(false);
  };
  persistStage(); controls();
}
async function openLifecycle(action: LifecycleCommand['action'], auditId?: string) {
  if (!await prepareAction(action, auditId) || !snapshot?.capabilities.editText) return;
  const original = snapshot.lifecycleNotes.find(item => item.id === auditId);
  if (action === 'correctLifecycleNote' && !original) { note('未找到原记录，请重新进入核对。', true); return; }
  if (!lifecycleDraft) {
    const base = { expectedVersion: snapshot.project.version, idempotencyKey: crypto.randomUUID() };
    lifecycleDraft = action === 'pauseProject' ? { ...base, action, reason: '' } : action === 'resumeProject' ? { ...base, action, note: '' } : { ...base, action, auditId: auditId!, note: original!.note, reason: '' };
  }
  const draft = lifecycleDraft; render();
  let preview: LifecyclePreview | undefined;
  const fields = ('reason' in draft ? `<label for="lifecycle-reason">${draft.action === 'pauseProject' ? '暂缓原因' : '本次纠错原因'}（必填）</label><textarea class="choice-note" id="lifecycle-reason" required>${esc(draft.reason)}</textarea>` : '')
    + ('note' in draft ? `<label for="lifecycle-note">${draft.action === 'resumeProject' ? '恢复说明（选填）' : '更正后的说明（恢复说明可明确清空）'}</label><textarea class="choice-note" id="lifecycle-note">${esc(draft.note)}</textarea>` : '')
    + (draft.action === 'resumeProject' ? `<p>将恢复为：${esc(label(snapshot.project.resumeStatus))}。使用暂缓期间最新保存的项目/阶段事实。</p><p>当前计划：${esc(snapshot.project.dueDate ?? '未定')}，原始计划：${esc(snapshot.project.originalDueDate ?? '未知')}。不自动顺延。</p><label><input type="checkbox" id="lifecycle-plan-select"${Object.hasOwn(draft, 'dueDate') ? ' checked' : ''}>本次恢复同时明确保存计划日期</label><input type="date" id="lifecycle-due" value="${esc(draft.dueDate ?? snapshot.project.dueDate ?? '')}" aria-label="恢复同时保存计划日期"><label for="lifecycle-plan-reason">调整已有计划的原因</label><textarea class="choice-note" id="lifecycle-plan-reason">${esc(draft.planReason ?? '')}</textarea>` : '');
  element('lifecycle-form').innerHTML = `<form id="lifecycle-edit" class="stage-card"><h2>${esc(actionLabels[action])}</h2><p>进入版本 ${esc(draft.expectedVersion)}。暂缓保留阶段/进度，停止推进；恢复不制造阶段开始或检查记录。纠正说明保留原操作人和时间。</p>${fields}<p id="lifecycle-error" class="field-error" role="alert"></p><div id="lifecycle-preview" aria-live="polite"></div><button type="submit" class="choice-btn">预览影响</button><button type="button" id="lifecycle-save" class="choice-btn" disabled>保存${esc(actionLabels[action])}</button><button type="button" id="lifecycle-cancel" class="choice-btn">取消</button></form>`;
  const capture = () => {
    const before = JSON.stringify(draft);
    if ('reason' in draft) draft.reason = (element('lifecycle-reason') as HTMLTextAreaElement).value;
    if ('note' in draft) draft.note = (element('lifecycle-note') as HTMLTextAreaElement).value;
    if (draft.action === 'resumeProject') {
      if ((element('lifecycle-plan-select') as HTMLInputElement).checked) { draft.dueDate = (element('lifecycle-due') as HTMLInputElement).value; draft.planReason = (element('lifecycle-plan-reason') as HTMLTextAreaElement).value; }
      else { delete draft.dueDate; delete draft.planReason; }
    }
    if (before !== JSON.stringify(draft)) draft.idempotencyKey = crypto.randomUUID();
    preview = undefined; (element('lifecycle-save') as HTMLButtonElement).disabled = true; element('lifecycle-preview').textContent = '输入已变化，请重新预览。'; persistStage();
  };
  element('lifecycle-edit').oninput = capture;
  element('lifecycle-cancel').onclick = () => { capture(); render(); };
  element('lifecycle-edit').onsubmit = async event => {
    event.preventDefault(); capture();
    if (dirty() || inFlight || loading || stale || authFrozen || pending || stagePending || responsibilityPending) return;
    inFlight = true; controls(); const exact = JSON.stringify(draft);
    try {
      const result = await send<LifecyclePreview>(`/api/projects/${id}/actions/preview`, 'POST', draft);
      if (exact !== JSON.stringify(draft)) { element('lifecycle-error').textContent = '输入已变化，请重新预览。'; return; }
      preview = result;
      element('lifecycle-preview').innerHTML = `<h3>保存影响</h3><p>项目状态：${esc(label(result.beforeValues.status ?? snapshot!.project.status))} → ${esc(label(result.afterValues.status ?? snapshot!.project.status))}。阶段事实保持。</p><p>本周检查：${esc(result.beforeCheck.label)} → ${esc(result.afterCheck.label)}${result.afterCheck.updatedAfterCheck ? '；检查后项目有更新' : ''}。首次应检依据保持。</p>${result.plan ? `<p>当前计划：${esc(result.plan.beforeValues.dueDate ?? snapshot!.project.dueDate ?? '未定')} → ${esc(result.plan.afterValues.dueDate ?? snapshot!.project.dueDate ?? '未定')}；${esc(result.plan.afterDeadline.label)}。</p>` : ''}${draft.action === 'correctLifecycleNote' ? `<p>原有效说明：${esc(original!.note)}<br>更正后：${esc(draft.note)}</p>` : ''}<p>${result.changed ? '明确保存后生效。' : '内容一致，不新增修改历史。'}</p>`;
      element('lifecycle-error').textContent = ''; (element('lifecycle-save') as HTMLButtonElement).disabled = false;
    } catch (error) {
      const failure = error as SaveError;
      if (failure.code === 'PROJECT_VERSION_CONFLICT') stale = true;
      if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID'].includes(failure.code)) authFrozen = true;
      element('lifecycle-error').textContent = Object.values(failure.fields ?? {})[0] ?? failure.message;
    } finally { inFlight = false; controls(); }
  };
  element('lifecycle-save').onclick = async () => {
    if (!preview || inFlight || loading || stale || authFrozen || dirty() || draft.expectedVersion !== snapshot!.project.version) return;
    stagePending = structuredClone(draft); persistStage(); await executeStage(false);
  };
  (element('lifecycle-edit').querySelector('textarea') as HTMLTextAreaElement | null)?.focus(); persistStage(); controls();
}
function scheduleHistory(record: ScheduleRecord) {
  return `<article class="audit-entry"><h3>${record.kind === 'reschedule' ? '调整计划' : '补充说明'} #${esc(record.id)}${record.voided ? '（误录已撤销）' : ''}</h3><p>${esc(record.oldDate ?? '未定')} → ${esc(record.newDate ?? '未定')} · 原操作人ID ${esc(record.actorId ?? '未知')} · ${esc(record.createdAt)}（UTC）</p><p>有效原因：${esc(record.reason)}<br>有效措施：${esc(record.measures)}</p><details><summary>原记录及纠错来源</summary><p>原日期：${esc(record.original.oldDate ?? '未定')} → ${esc(record.original.newDate ?? '未定')}<br>原原因：${esc(record.original.reason)}<br>原措施：${esc(record.original.measures)}</p>${record.corrections.map(item => `<p>${esc(item.actorDisplayName)} · ${esc(item.createdAt)} · ${esc(item.reason)}</p>`).join('') || '<p>没有更正记录。</p>'}</details>${snapshot!.capabilities.editText ? `<button class="back-btn" data-plan="correctScheduleRecord" data-record="${esc(record.id)}">纠正这条记录</button>${!record.voided ? `<button class="back-btn" data-plan="voidScheduleRecord" data-record="${esc(record.id)}">撤销误录记录</button>` : ''}` : ''}</article>`;
}
async function openPlan(action: PlanCommand['action'], recordId?: string) {
  if (!await prepareAction(action, recordId) || !snapshot?.capabilities.editText) return;
  const record = recordId ? snapshot.delays.find(item => item.id === recordId) : undefined;
  if (recordId && !record) { note('未找到该项目的计划记录，请重新进入核对。', true); return; }
  if (!planDraft) {
    const base = { expectedVersion: snapshot.project.version, idempotencyKey: crypto.randomUUID() };
    if (action === 'setPlan') planDraft = { ...base, action, dueDate: String(snapshot.project.dueDate ?? '') };
    else if (action === 'reschedulePlan') planDraft = { ...base, action, dueDate: String(snapshot.project.dueDate ?? ''), reason: '', measures: '' };
    else if (action === 'notePlan') planDraft = { ...base, action, reason: '', measures: '' };
    else if (action === 'correctProjectDates') planDraft = { ...base, action, changes: {}, reason: '' };
    else if (action === 'correctScheduleRecord') planDraft = { ...base, action, recordId: recordId!, changes: {}, reason: '' };
    else planDraft = { ...base, action, recordId: recordId!, reason: '' };
  }
  const draft = planDraft; render();
  let preview: PlanPreview | undefined;
  let fields = '';
  if (draft.action === 'setPlan' || draft.action === 'reschedulePlan') fields = `<label for="plan-date">预计结案日期</label><input id="plan-date" type="date" required value="${esc(draft.dueDate)}"><p>当前：${esc(snapshot.project.dueDate ?? '未定')}；原始：${esc(snapshot.project.originalDueDate ?? '未知')}。允许合法过去计划，不自动消除超期。</p>`;
  if (draft.action === 'reschedulePlan' || draft.action === 'notePlan') fields += `<label for="plan-measures">措施（选填）</label><textarea id="plan-measures" class="choice-note">${esc(draft.measures)}</textarea>`;
  if (draft.action === 'correctProjectDates') fields = Object.entries(dateTitles).map(([key, title]) => `<div class="field"><label><input type="checkbox" data-plan-select="${key}"${Object.hasOwn(draft.changes, key) ? ' checked' : ''}>纠正${title}</label><input type="date" data-plan-date="${key}" aria-label="${title}" value="${esc(Object.hasOwn(draft.changes, key) ? draft.changes[key as keyof typeof dateTitles] ?? '' : snapshot!.project[key] ?? '')}"${['proposalDate', 'filingDate', 'startDate'].includes(key) ? ` max="${esc(snapshot!.businessDate)}"` : ''}></div>`).join('');
  if (record) {
    fields = `<p>本项目记录 #${esc(record.id)}，${record.kind === 'note' ? '补充说明' : '真实调整'}；只修改历史不会回滚后来计划。</p>`;
    if (draft.action === 'correctScheduleRecord') fields += (record.kind === 'reschedule' ? ['oldDate', 'newDate', 'reason', 'measures'] : ['reason', 'measures']).map(key => `<div class="field"><label><input type="checkbox" data-record-select="${key}"${Object.hasOwn(draft.changes, key) ? ' checked' : ''}>纠正${({ oldDate: '原日期', newDate: '新日期', reason: '原业务原因', measures: '原措施' } as Record<string, string>)[key]}</label>${key.endsWith('Date') ? `<input type="date" data-record-value="${key}" value="${esc(Object.hasOwn(draft.changes, key) ? draft.changes[key as keyof typeof draft.changes] ?? '' : record[key as keyof ScheduleRecord] ?? '')}">` : `<textarea data-record-value="${key}" class="choice-note">${esc(Object.hasOwn(draft.changes, key) ? draft.changes[key as keyof typeof draft.changes] : record[key as keyof ScheduleRecord])}</textarea>`}</div>`).join('');
    if ('recordId' in draft) fields += `<label><input type="checkbox" id="plan-current-select"${Object.hasOwn(draft, 'currentDueDate') ? ' checked' : ''}>另外明确纠正当前计划（不自动回滚）</label><input id="plan-current-date" type="date" value="${esc(Object.hasOwn(draft, 'currentDueDate') ? draft.currentDueDate ?? '' : snapshot.project.dueDate ?? '')}">`;
  }
  element('plan-form').innerHTML = `<form id="plan-edit" class="stage-card"><h2>${esc(actionLabels[draft.action])}</h2><p>进入版本 ${esc(draft.expectedVersion)}。明确勾选的日期留空表示未知/未定，未选字段保持。状态、阶段、结案时计划与首次义务保持。</p><div class="field-grid">${fields}</div>${draft.action !== 'setPlan' ? `<label for="plan-reason">${draft.action === 'notePlan' ? '原因/说明（原因或措施至少一项）' : '本次调整/纠错原因（必填）'}</label><textarea id="plan-reason" class="choice-note"${draft.action === 'notePlan' ? '' : ' required'}>${esc(draft.reason)}</textarea>` : ''}<p id="plan-error" class="field-error" role="alert"></p><div id="plan-preview" aria-live="polite"></div><button type="submit" class="choice-btn">预览影响</button><button type="button" id="plan-save" class="choice-btn" disabled>保存${esc(actionLabels[draft.action])}</button><button type="button" id="plan-cancel" class="choice-btn">取消</button></form>`;
  const capture = () => {
    const previous = JSON.stringify(draft);
    if ('dueDate' in draft) draft.dueDate = (element('plan-date') as HTMLInputElement).value;
    if ('reason' in draft) draft.reason = (element('plan-reason') as HTMLTextAreaElement).value;
    if ('measures' in draft) draft.measures = (element('plan-measures') as HTMLTextAreaElement).value;
    if (draft.action === 'correctProjectDates') {
      draft.changes = {};
      for (const key of Object.keys(dateTitles) as (keyof typeof dateTitles)[]) if (document.querySelector<HTMLInputElement>(`[data-plan-select="${key}"]`)!.checked) draft.changes[key] = document.querySelector<HTMLInputElement>(`[data-plan-date="${key}"]`)!.value || null;
    }
    if (draft.action === 'correctScheduleRecord') {
      draft.changes = {};
      document.querySelectorAll<HTMLInputElement>('[data-record-select]:checked').forEach(input => { const key = input.dataset.recordSelect as keyof typeof draft.changes; const value = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-record-value="${key}"]`)!.value; if (key === 'oldDate' || key === 'newDate') draft.changes[key] = value || null; else draft.changes[key] = value; });
    }
    if ('recordId' in draft) { if ((element('plan-current-select') as HTMLInputElement).checked) draft.currentDueDate = (element('plan-current-date') as HTMLInputElement).value || null; else delete draft.currentDueDate; }
    if (previous !== JSON.stringify(draft)) draft.idempotencyKey = crypto.randomUUID();
    preview = undefined; (element('plan-save') as HTMLButtonElement).disabled = true; element('plan-preview').textContent = '输入已变化，请重新预览。'; persistStage();
  };
  element('plan-edit').oninput = capture; element('plan-cancel').onclick = () => { capture(); render(); };
  element('plan-edit').onsubmit = async event => {
    event.preventDefault(); capture();
    if (dirty() || inFlight || loading || stale || authFrozen || pending || stagePending || responsibilityPending) return;
    inFlight = true; controls(); const exact = JSON.stringify(draft);
    try {
      const result = await send<PlanPreview>(`/api/projects/${id}/actions/preview`, 'POST', draft);
      if (exact !== JSON.stringify(draft)) { element('plan-error').textContent = '输入变化，请重新预览。'; return; }
      preview = result;
      element('plan-preview').innerHTML = `<h3>影响预览</h3>${table(Object.entries(result.afterValues).map(([key, value]) => ({ field: dateTitles[key as keyof typeof dateTitles] ?? ({ scheduleRecord: '历史有效记录', correctionReason: '纠错原因' } as Record<string, string>)[key] ?? key, before: showValue(key, result.beforeValues[key]), after: showValue(key, value) })), [['field', '明确修改'], ['before', '原有效事实'], ['after', '保存后有效事实']])}<p>${esc(result.beforeDeadline.label)} → ${esc(result.afterDeadline.label)}（截至 ${esc(result.afterDeadline.asOfDate)}）</p>${result.adjustmentDays !== undefined ? `<p>净本次调整：${result.adjustmentDays} 天；${result.direction === 'same' ? '日期相同，不新增改期；原因/措施请保留，若需记录用补充计划说明。' : result.direction === 'later' ? '向后调整' : '提前调整'}。</p>` : ''}${result.scheduleRecord ? `<p>新增${result.scheduleRecord.kind === 'note' ? '补充说明' : '真实改期'}：${esc(result.scheduleRecord.reason)} · ${esc(result.scheduleRecord.measures)}</p>` : ''}${result.startupBasisNote ? `<p>${esc(result.startupBasisNote)}：${esc(result.startupBasis ?? '未知')}</p>` : ''}${!result.changed ? '<p>没有实际变化；保存只记录原结果回执，不增加版本或修改历史。</p>' : ''}`;
      element('plan-error').textContent = ''; (element('plan-save') as HTMLButtonElement).disabled = false;
    } catch (error) { const failure = error as SaveError; if (failure.code === 'PROJECT_VERSION_CONFLICT') stale = true; if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID'].includes(failure.code)) authFrozen = true; element('plan-error').textContent = Object.values(failure.fields ?? {})[0] ?? failure.message; }
    finally { inFlight = false; controls(); }
  };
  element('plan-save').onclick = async () => { if (!preview || dirty() || inFlight || loading || stale || authFrozen || draft.expectedVersion !== snapshot!.project.version) return; stagePending = structuredClone(draft); persistStage(); await executeStage(false); };
  persistStage(); controls();
  element('plan-edit').querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea')?.focus();
}
async function openCorrection(action: CorrectionCommand['action'], code?: string) {
  if (!await prepareAction(action, code) || !snapshot?.capabilities.editText) return;
  if (!correctionDraft) correctionDraft = action === 'correctStageFacts' ? { action, changes: [], reason: '', expectedVersion: snapshot.project.version, idempotencyKey: crypto.randomUUID() } : { action, stageCode: code!, reason: '', expectedVersion: snapshot.project.version, idempotencyKey: crypto.randomUUID(), ...(action === 'undoStageComplete' ? { undoStart: false } : {}) };
  const draft = correctionDraft;
  tab = 'stages'; render();
  let preview: CorrectionPreview | undefined;
  const fields = draft.action === 'correctStageFacts' ? snapshot.stages.map(stage => {
    const change = draft.changes.find(item => item.code === stage.code);
    return `<div class="field"><strong>${esc(label(stage.code))}（${esc(label(stage.state))}）</strong>${(['startedOn', 'completedOn'] as const).map(key => `<label><input type="checkbox" data-correct-select="${stage.code}:${key}"${change && Object.hasOwn(change, key) ? ' checked' : ''}>修改实际${key === 'startedOn' ? '开始' : '完成'}日期</label><input type="date" data-correct-date="${stage.code}:${key}" aria-label="${esc(stage.code)}实际${key === 'startedOn' ? '开始' : '完成'}日期" max="${esc(snapshot!.businessDate)}" value="${esc(change && Object.hasOwn(change, key) ? change[key] ?? '' : stage[key] ?? '')}">`).join('')}</div>`;
  }).join('') : `<p>目标：${esc(label(draft.stageCode))}</p>${draft.action === 'undoStageComplete' ? `<label><input type="checkbox" id="correction-undo-start"${draft.undoStart ? ' checked' : ''}>开始也误记：一同撤销，回到待开始</label>` : ''}`;
  element('correction-form').innerHTML = `<form id="correction-edit" class="stage-card"><h2>${esc(actionLabels[draft.action])}</h2><p>进入版本 ${esc(draft.expectedVersion)}。勾选要纠正的字段；所选日期留空表示明确纠正为未知，状态保持。真实返工回退会清空目标及后续当前实际日期，原历史与资料保留。</p><div class="field-grid">${fields}</div><label for="correction-reason">原因（必填）</label><textarea id="correction-reason" class="choice-note" required>${esc(draft.reason)}</textarea><p id="correction-error" class="field-error" role="alert"></p><div id="correction-preview" aria-live="polite"></div><button type="submit" class="choice-btn">预览影响</button><button type="button" id="correction-save" class="choice-btn" disabled>${draft.action === 'rollbackStage' ? '保存回退' : '保存纠正'}</button><button type="button" id="correction-cancel" class="choice-btn">取消</button></form>`;
  const capture = () => {
    draft.reason = (element('correction-reason') as HTMLTextAreaElement).value;
    if (draft.action === 'correctStageFacts') draft.changes = snapshot!.stages.map(stage => {
      const change: { code: string; startedOn?: string | null; completedOn?: string | null } = { code: String(stage.code) };
      for (const key of ['startedOn', 'completedOn'] as const) if (document.querySelector<HTMLInputElement>(`[data-correct-select="${stage.code}:${key}"]`)!.checked) change[key] = document.querySelector<HTMLInputElement>(`[data-correct-date="${stage.code}:${key}"]`)!.value || null;
      return change;
    }).filter(change => Object.keys(change).length > 1);
    else if (draft.action === 'undoStageComplete') draft.undoStart = (element('correction-undo-start') as HTMLInputElement).checked;
    preview = undefined; (element('correction-save') as HTMLButtonElement).disabled = true; element('correction-preview').textContent = '输入已改变，请重新预览。'; persistStage();
  };
  element('correction-edit').oninput = capture;
  element('correction-cancel').onclick = () => { capture(); render(); };
  element('correction-edit').onsubmit = async event => {
    event.preventDefault(); capture();
    if (dirty()) { element('correction-error').textContent = '请先取消动作表单，保存或处理普通编辑后再预览。'; return; }
    if (inFlight || loading || stale || authFrozen || pending || stagePending || responsibilityPending) return;
    inFlight = true; controls();
    const exact = JSON.stringify(draft);
    try {
      const result = await send<CorrectionPreview>(`/api/projects/${id}/actions/preview`, 'POST', draft);
      if (exact !== JSON.stringify(draft)) { element('correction-error').textContent = '输入已变化，请重新预览。'; return; }
      preview = result;
      element('correction-preview').innerHTML = `<h3>影响预览：进度 ${result.progressBefore}% → ${result.progressAfter}%</h3>${result.changed ? table(result.stageChanges.map((fact, index) => ({ code: label(fact.code), before: showValue('stageChanges', [result.beforeStages[index]]), after: showValue('stageChanges', [fact]) })), [['code', '阶段'], ['before', '原有效事实'], ['after', '保存后有效事实']]) : '<p>内容一致，保存只确认原结果，不新增修改历史。</p>'}<p>原因：${esc(result.reason)}。项目总体状态、计划、节点/成果、风险和负责关系保留。</p>`;
      element('correction-error').textContent = ''; (element('correction-save') as HTMLButtonElement).disabled = false;
    } catch (error) {
      const failure = error as SaveError;
      if (failure.code === 'PROJECT_VERSION_CONFLICT') stale = true;
      if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID'].includes(failure.code)) authFrozen = true;
      element('correction-error').textContent = Object.values(failure.fields ?? {})[0] ?? failure.message;
    } finally { inFlight = false; controls(); }
  };
  element('correction-save').onclick = async () => {
    if (!preview || inFlight || stale || authFrozen || loading || draft.expectedVersion !== snapshot!.project.version) return;
    if (dirty()) { element('correction-error').textContent = '请先取消动作表单，保存或处理普通编辑后重新预览。'; return; }
    stagePending = structuredClone(draft); persistStage(); await executeStage(false);
  };
  persistStage(); controls();
}
async function openStage(code: string, action: StageCommand['action']) {
  if (!await prepareAction(action, code) || !snapshot) return;
  const availability = snapshot.stageActions.find(item => item.code === code);
  const blocked = action === 'startStage' ? availability?.startBlocked : availability?.completeBlocked;
  if (!availability || blocked) { note(stageMessages[blocked ?? 'STAGE_SEQUENCE_REVIEW_REQUIRED'], true); return; }
  if (stageDraft && stageDraft.expectedVersion !== snapshot.project.version) { note('阶段副本已过期，请复制核对后放弃，再重新填写。', true); controls(); return; }
  if (!stageDraft || stageDraft.action === 'startProject' || stageDraft.stageCode !== code || stageDraft.action !== action) stageDraft = { expectedVersion: snapshot.project.version, stageCode: code, action, actualDate: snapshot.businessDate, ...(action === 'completeStage' ? { completionNote: '' } : {}) };
  tab = 'stages'; render();
  const formArea = element('stage-form-' + code);
  const draft = stageDraft;
  formArea.innerHTML = `<p>${esc(snapshot.project.name)} · ${esc(label(code))} · 进入版本 ${esc(draft.expectedVersion)}</p><form id="stage-form"><label for="stage-date">实际${action === 'startStage' ? '开始' : '完成'}日期</label><input type="date" id="stage-date" required max="${esc(snapshot.businessDate)}" value="${esc(draft.actualDate)}">${action === 'completeStage' ? `<label for="stage-note">完成说明（选填）</label><textarea class="choice-note" id="stage-note">${esc(draft.completionNote)}</textarea>` : ''}<p id="stage-error" class="field-error" role="alert"></p><div class="choice-actions"><button class="choice-confirm" type="submit">保存${action === 'startStage' ? '开始' : '完成'}</button><button class="choice-cancel" type="button" id="stage-cancel">取消</button></div></form>`;
  const capture = () => { draft.actualDate = (element('stage-date') as HTMLInputElement).value; if (action === 'completeStage') draft.completionNote = (element('stage-note') as HTMLTextAreaElement).value; persistStage(); };
  element('stage-date').oninput = capture; if (action === 'completeStage') element('stage-note').oninput = capture;
  element('stage-cancel').onclick = () => { capture(); render(); };
  element('stage-form').onsubmit = async event => {
    event.preventDefault(); capture();
    if (inFlight || loading || stagePending || pending || responsibilityPending) return;
    if (dirty()) { element('stage-error').textContent = '请先取消动作表单，保存或处理普通编辑。'; return; }
    if (stale || authFrozen || draft.expectedVersion !== snapshot!.project.version) { element('stage-error').textContent = '项目或账号已变化，请复制输入并重新进入。'; return; }
    stagePending = { ...draft, idempotencyKey: crypto.randomUUID() }; persistStage(); await executeStage(false);
  };
  persistStage(); controls();
}
async function openStart() {
  if (!await prepareAction('startProject') || !snapshot) return;
  if (snapshot.startBlocked && snapshot.startBlocked !== 'CHECK_RULE_REQUIRED') { note(stageMessages[snapshot.startBlocked], true); return; }
  let context: CheckRuleContext;
  try { context = await get<CheckRuleContext>('/api/settings/check-rule'); }
  catch (error) { note((error as Error).message, true); return; }
  if (inFlight || loading || stagePending || pending || responsibilityPending || stale || authFrozen) return;
  if (!context.rule || !context.configVersion || !context.firstCheckWeek) { note(stageMessages.CHECK_RULE_REQUIRED, true); return; }
  if (!stageDraft || stageDraft.action !== 'startProject') stageDraft = { action: 'startProject', actualDate: context.businessDate, dueDate: String(snapshot.project.dueDate ?? ''), planReason: '', expectedVersion: snapshot.project.version, configVersion: context.configVersion, ruleVersion: context.rule.version, previewWeek: context.weekStart, previewFirstCheckWeek: context.firstCheckWeek };
  const draft = stageDraft;
  if (draft.ruleVersion !== context.rule.version || draft.previewWeek !== context.weekStart || draft.previewFirstCheckWeek !== context.firstCheckWeek) note('检查依据已更新，请核对当前截止与首次应检周后保存。', true);
  Object.assign(draft, { configVersion: context.configVersion, ruleVersion: context.rule.version, previewWeek: context.weekStart, previewFirstCheckWeek: context.firstCheckWeek });
  tab = 'stages'; render();
  element('project-start-form').innerHTML = `<form id="start-form"><p>${esc(snapshot.project.name)} · 进入版本 ${esc(draft.expectedVersion)}</p><label for="start-date">实际启动日期</label><input type="date" id="start-date" required max="${esc(context.businessDate)}" value="${esc(draft.actualDate)}"><label for="start-due">预计结案日期</label><input type="date" id="start-due" required value="${esc(draft.dueDate)}"><p>原当前计划：${esc(snapshot.project.dueDate ?? '未定')}。修改已有计划时，下面的调整原因必填。</p><label for="start-reason">同时调整计划的原因</label><textarea class="choice-note" id="start-reason">${esc(draft.planReason)}</textarea><p>本周截止：${esc(context.deadlineDate)}（全天可检查）；首次应检周：${esc(context.firstCheckWeek)}。实际启动日补录为过去，也不补造过去检查。</p><div class="choice-actions"><button class="choice-confirm" type="submit">保存启动项目</button><button class="choice-cancel" type="button" id="start-cancel">取消</button></div></form>`;
  const capture = () => { draft.actualDate = (element('start-date') as HTMLInputElement).value; draft.dueDate = (element('start-due') as HTMLInputElement).value; draft.planReason = (element('start-reason') as HTMLTextAreaElement).value; persistStage(); };
  for (const name of ['start-date', 'start-due', 'start-reason']) element(name).oninput = capture;
  element('start-cancel').onclick = () => { capture(); render(); };
  element('start-form').onsubmit = async event => {
    event.preventDefault(); capture();
    if (inFlight || loading || stagePending || pending || responsibilityPending || stale || authFrozen || draft.expectedVersion !== snapshot!.project.version) return;
    if (dirty()) { note('请先取消动作表单，保存或处理普通编辑。', true); return; }
    stagePending = { ...draft, idempotencyKey: crypto.randomUUID() }; persistStage(); await executeStage(false);
  };
  persistStage(); controls();
}
async function executeStage(confirm: boolean) {
  if (!stagePending || inFlight) return;
  const original = stagePending; inFlight = true; controls();
  let result: { projectId: string; operationId: string; savedVersion: string; changed?: boolean } | undefined;
  try {
    const response = await send<{ outcome: string; result?: typeof result }>(`/api/projects/${id}/${confirm ? 'action-results/query' : 'actions'}`, 'POST', original, !confirm);
    if (response.outcome === 'committed' && response.result) {
      if (response.result.projectId !== id || response.result.operationId !== original.idempotencyKey) throw new SaveError('RESPONSE_UNKNOWN', 'unknown');
      result = response.result; stagePending = undefined; stageDraft = undefined; correctionDraft = undefined; planDraft = isPlanCommand(original) && !result.changed ? original : undefined; lifecycleDraft = isLifecycleCommand(original) && !result.changed ? original : undefined; closureDraft = isClosureCommand(original) && !result.changed ? original : undefined; checkDraft = isCheckCommand(original) && !result.changed ? original : undefined; persistStage();
    } else note('暂未查到阶段回执，结果仍待确认。请重试原操作，不要另造编号。', true);
  } catch (error) {
    const failure = error instanceof SaveError ? error : new SaveError('TRANSPORT_UNKNOWN', 'unknown');
    if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes(failure.code)) authFrozen = true;
    if (failure.code === 'PROJECT_VERSION_CONFLICT') stale = true;
    if (failure.outcome === 'not_committed' && failure.code !== 'OPERATION_KEY_REUSED') stagePending = undefined;
    note(Object.values(failure.fields ?? {})[0] ?? failure.message, true); persistStage();
  } finally { inFlight = false; if (result || !actionFormOpen()) render(); else { if (!stagePending && !stale && !authFrozen) element('action-fields').querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')?.dispatchEvent(new Event('input', { bubbles: true })); controls(); } }
  if (result) {
    observedVersion = result.savedVersion;
    const refreshed = await load();
    if (!refreshed) stale = true;
    note(`${actionLabels[original.action]}${result.changed === false ? isPlanCommand(original) ? '无实际变化，副本已保留；如需记录原因/措施请选择补充说明。' : '无实际变化，副本已保留。' : '已确认保存'}版本${result.savedVersion}。${refreshed ? original.action === 'startProject' ? 'S2仍待开始，请单独保存开始阶段。' : original.action === 'completeStage' && original.stageCode === 'S1' ? '下一步需明确启动项目，项目仍为提案中。' : '' : '后续刷新失败，请重新进入查看；无需再次保存。'}`, !refreshed);
    controls();
  }
}
type ResponsibilityCommand = { expectedVersion: string; idempotencyKey: string; action: 'join' | 'leave' };
let responsibilityPending: ResponsibilityCommand | undefined;
const responsibilityKey = () => `geekdash_responsibility:${account!.id}:${id}`;
function responsibilityControls() {
  if (!snapshot) return;
  const members = (snapshot.responsible ?? []).map(user => esc(user.name) + (user.enabled ? '' : '（已停用）')).join('、') || '尚未建立账号负责关系';
  element('responsibility').innerHTML = `项目负责人：${members}。${snapshot.readOnly ? '当前仅可查看。' : '本人已负责，可编辑。'} <button class="back-btn" id="responsibility-save">${snapshot.readOnly ? '保存加入本人负责范围' : '保存退出本人负责范围'}</button>${responsibilityPending ? ' <button class="back-btn" id="responsibility-confirm">确认原责任变更</button><button class="back-btn" id="responsibility-retry">重试原责任变更</button>' : ''}`;
  (element('responsibility-save') as HTMLButtonElement).disabled = loading || inFlight || stale || !!pending || !!responsibilityPending || !!stagePending || authFrozen;
  element('responsibility-save').onclick = async () => {
    if (!snapshot || inFlight || pending || stale || responsibilityPending || stagePending || authFrozen) return;
    if (dirty()) {
      const choice = await choose('变更负责范围前请处理未保存内容。', [['cancel', '继续编辑'], ['keep', '保留副本供复制，再变更'], ['discard', '放弃未保存内容，再变更']]);
      if (choice === 'cancel') return;
      if (choice === 'keep') { persist(); candidate = { format: 2, baseVersion: editBaseVersion, values: structuredClone(values!), changeDraft, riskDraft, nodeDraft, nodeRestoreExtras }; }
      else { candidate = undefined; sessionStorage.removeItem(bufferKey); }
    }
    responsibilityPending = { expectedVersion: snapshot.project.version, idempotencyKey: crypto.randomUUID(), action: snapshot.readOnly ? 'join' : 'leave' };
    try { sessionStorage.setItem(responsibilityKey(), JSON.stringify(responsibilityPending)); } catch { note('恢复存储不可用，请保留页面至结果确认。', true); }
    await changeResponsibility(false);
  };
  for (const [name, confirm] of [['responsibility-confirm', true], ['responsibility-retry', false]] as const) { const button = document.getElementById(name) as HTMLButtonElement | null; if (button) { button.disabled = inFlight; button.onclick = () => { void changeResponsibility(confirm); }; } }
  if (legacyCopy?.pending) {
    const button = document.createElement('button'); button.className = 'back-btn'; button.textContent = '确认旧试用保存结果'; button.disabled = inFlight;
    button.onclick = async () => { try { const response = await send<{ outcome: string }>(`/api/projects/${id}/save-results/query`, 'POST', legacyCopy!.pending!, false); note(response.outcome === 'committed' ? '旧试用保存已经确认。旧文字保留供复制核对，不会作为实名请求重放。' : '暂未查到旧试用保存；旧文字可复制核对，请重新进入后明确保存。'); } catch (error) { note((error as Error).message, true); } };
    element('responsibility').append(button);
  }
}
async function changeResponsibility(confirm: boolean) {
  if (!responsibilityPending || inFlight) return; inFlight = true; controls();
  let committed = false;
  try {
    const response = await send<{ outcome: string }>(`/api/projects/${id}/${confirm ? 'responsibility-results/query' : 'responsibility'}`, 'POST', responsibilityPending, !confirm);
    if (response.outcome === 'committed') { responsibilityPending = undefined; sessionStorage.removeItem(responsibilityKey()); committed = true; }
    else note('暂未查到原责任变更，可重试原操作；不要另造操作编号。', true);
  } catch (error) {
    note((error as Error).message, true);
    if (error instanceof SaveError && error.outcome === 'not_committed') { responsibilityPending = undefined; sessionStorage.removeItem(responsibilityKey()); if (error.code === 'PROJECT_VERSION_CONFLICT') stale = true; }
  } finally { inFlight = false; controls(); }
  if (committed) await load();
}
let audit: AuditPage | undefined;
let auditGeneration = 0;
let auditMessage = '';
let validationErrors: Record<string, string> = {};
function note(text: string, error = false) { for (const target of [element('message'), element('action-message')]) { target.textContent = text; target.classList.toggle('error', error); } }
function baseline(): EditValues {
  const p = snapshot!.project;
  const ordinary = Object.fromEntries(keys.map(key => [key, p[key]])) as EditValues;
  return { ...ordinary, chipIds: p.chips.map(item => item.id), tagIds: p.tags.map(item => item.id), people: p.people.map(({ id, role }) => ({ id, role })), riskOps: [], nodeOps: [], changeOps: [], stagePlans: snapshot!.stages.map(stage => ({ code: String(stage.code), plannedDays: stage.plannedDays == null ? null : Number(stage.plannedDays), note: String(stage.note ?? '') })) };
}
function changes() { const base = baseline(); return Object.fromEntries(keys.filter(key => JSON.stringify(values![key]) !== JSON.stringify(base[key])).map(key => [key, values![key]])) as Partial<EditValues>; }
function dirty() { return !!values && !!snapshot && (!!riskDraft || !!nodeDraft || !!changeDraft || Object.keys(changes()).length > 0); }
function actionFormOpen() { return !!document.querySelector('#stage-form, #start-form, #correction-edit, #plan-edit, #lifecycle-edit, #closure-edit, #check-edit, #risk-edit, #node-edit, #change-edit'); }
function refreshReadView() { if (actionFormOpen()) controls(); else render(); }
function showActionForm() {
  const form = document.querySelector<HTMLFormElement>('#stage-form, #start-form, #correction-edit, #plan-edit, #lifecycle-edit, #closure-edit, #check-edit, #risk-edit, #node-edit, #change-edit');
  if (!form) return;
  const dialog = element('action-dialog') as HTMLDialogElement;
  if (!dialog.contains(form)) {
    let heading = form.querySelector<HTMLElement>('h2,h3');
    if (!heading) { heading = document.createElement('h2'); heading.textContent = stageDraft ? actionLabels[stageDraft.action] + ('stageCode' in stageDraft ? ' · ' + label(stageDraft.stageCode) : '') : '项目操作'; form.prepend(heading); }
    heading.id = 'action-heading'; element('action-fields').replaceChildren(form); element('action-message').textContent = '';
  }
  if (!dialog.open) dialog.showModal();
}
function dismissAction() {
  if (inFlight || loading) return;
  if (stale || authFrozen || stagePending) { persist(); persistStage(); render(); return; }
  element('action-fields').querySelector<HTMLButtonElement>('button[id$="-cancel"]')?.click();
}
function controls() {
  showActionForm();
  responsibilityControls();
  const frozen = inFlight || !!pending || !!responsibilityPending || !!stagePending || loading || checksLoading;
  const actionOpen = actionFormOpen();
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-edit]').forEach(input => { input.disabled = frozen || actionOpen || stale || authFrozen || input.dataset.reference === 'true' && !catalog; });
  const save = document.getElementById('save') as HTMLButtonElement | null;
  if (save) save.disabled = frozen || actionOpen || stale || authFrozen || !snapshot?.capabilities.editText || !dirty();
  const discard = document.getElementById('discard') as HTMLButtonElement | null;
  if (discard) { discard.disabled = frozen || actionOpen || !dirty(); discard.hidden = !dirty(); }
  for (const action of ['confirm', 'retry']) { const button = document.getElementById(action) as HTMLButtonElement | null; if (button) button.disabled = inFlight; }
  (element('reload') as HTMLButtonElement).disabled = frozen;
  document.querySelectorAll<HTMLButtonElement>('[data-stage-action]').forEach(button => { const item = snapshot?.stageActions.find(item => item.code === button.dataset.stage); const blocked = button.dataset.stageAction === 'startStage' ? item?.startBlocked : item?.completeBlocked; button.disabled = frozen || stale || authFrozen || !item || !!blocked; });
  const startButton = document.getElementById('project-start') as HTMLButtonElement | null; if (startButton) startButton.disabled = frozen || stale || authFrozen || !!snapshot?.startBlocked;
  document.querySelectorAll<HTMLButtonElement>('[data-correction]').forEach(button => { const status = snapshot!.project.status; button.disabled = frozen || stale || authFrozen || !snapshot?.capabilities.editText || button.dataset.correction === 'rollbackStage' && !['proposal', 'ongoing'].includes(status) || button.dataset.correction !== 'correctStageFacts' && status === 'closed'; });
  const correctionSave = document.getElementById('correction-save') as HTMLButtonElement | null; if (correctionSave && (frozen || stale || authFrozen)) correctionSave.disabled = true;
  document.querySelectorAll<HTMLButtonElement>('[data-lifecycle]').forEach(button => { button.disabled = frozen || stale || authFrozen || !snapshot?.capabilities.editText || button.dataset.lifecycle === 'resumeProject' && !['proposal', 'ongoing'].includes(snapshot!.project.resumeStatus ?? ''); });
  const lifecycleSave = document.getElementById('lifecycle-save') as HTMLButtonElement | null; if (lifecycleSave && (frozen || stale || authFrozen)) lifecycleSave.disabled = true;
  document.querySelectorAll<HTMLButtonElement>('[data-closure]').forEach(button => { button.disabled = frozen || stale || authFrozen || !snapshot?.capabilities.editText; });
  const closureSave = document.getElementById('closure-save') as HTMLButtonElement | null; if (closureSave && (frozen || stale || authFrozen)) closureSave.disabled = true;
  document.querySelectorAll<HTMLButtonElement>('[data-node]').forEach(button => { button.disabled = frozen || actionOpen || stale || authFrozen || !snapshot?.capabilities.editText; });
  document.querySelectorAll<HTMLButtonElement>('[data-node-withdraw]').forEach(button => { button.disabled = frozen || actionOpen || stale || authFrozen || !snapshot?.capabilities.editText; });
  for (const name of ['deleted-refresh', 'deleted-more']) { const button = document.getElementById(name) as HTMLButtonElement | null; if (button) button.disabled = frozen || actionOpen || stale || authFrozen || deletedLoading; }
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('#node-edit input,#node-edit select,#node-edit textarea,#node-edit button').forEach(input => { input.disabled = frozen || stale || authFrozen || input.id === 'node-accept' && input.dataset.preview !== 'true'; });
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('#node-edit [data-node-field]').forEach(input => { if (nodeDraft?.op === 'correct' && !document.querySelector<HTMLInputElement>(`[data-node-select="${input.dataset.nodeField}"]`)?.checked) input.disabled = true; });
  document.querySelectorAll<HTMLButtonElement>('[data-change]').forEach(button => { button.disabled = frozen || actionOpen || stale || authFrozen || !snapshot?.capabilities.editText; });
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('#change-edit input,#change-edit select,#change-edit textarea,#change-edit button').forEach(input => { input.disabled = frozen || stale || authFrozen || input.id === 'change-accept' && input.dataset.preview !== 'true'; });
  document.querySelectorAll<HTMLButtonElement>('[data-risk]').forEach(button => { button.disabled = frozen || actionOpen || stale || authFrozen || !snapshot?.capabilities.editText; });
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('#risk-edit input,#risk-edit textarea,#risk-edit button').forEach(input => { input.disabled = frozen || stale || authFrozen || input.id === 'risk-accept' && input.dataset.preview !== 'true'; });
  document.querySelectorAll<HTMLButtonElement>('[data-check]').forEach(button => { button.disabled = frozen || stale || authFrozen || !snapshot?.capabilities.editText; });
  for (const name of ['checks-refresh', 'checks-more']) { const button = document.getElementById(name) as HTMLButtonElement | null; if (button) button.disabled = frozen || actionOpen || stale || authFrozen; }
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('#check-edit input,#check-edit textarea,#check-edit select,#check-edit button').forEach(input => { input.disabled = frozen || stale || authFrozen || input.id === 'check-save' && input.dataset.preview !== 'true'; });
  for (const name of ['stage-confirm' , 'stage-retry']) { const button = document.getElementById(name) as HTMLButtonElement | null; if (button) button.disabled = inFlight || loading || authFrozen; }
  element('copy').hidden = !nodeDraft && !riskDraft && !changeDraft && !dirty() && !candidate && !legacyCopy && !pending && !stageDraft && !stagePending && !correctionDraft && !planDraft && !lifecycleDraft && !closureDraft && !checkDraft;
  const state = document.getElementById('edit-state');
  if (state) state.textContent = stagePending ? actionLabels[stagePending.action] + '结果待确认，请确认原结果或重试原操作。' : pending ? inFlight ? '正在处理原操作，请等待…' : '原操作结果尚未确认，请确认结果或重试原操作。' : stale ? '项目已被他人更新，请重新进入项目。旧文字已保留供复制。' : dirty() ? '有未保存修改 · 本标签页暂存，需点击保存项目' : '当前内容已保存';
  const warning = document.getElementById('storage-warning');
  if (warning) warning.textContent = storageFailed ? dirty() || pending ? '本标签页恢复存储不可用，未保存文字仅留在内存。请及时复制。' : '本标签页恢复存储不可用；已确认保存的数据以服务器为准。' : '';
  (element('action-fields') as HTMLFieldSetElement).disabled = frozen || stale || authFrozen;
  element('action-recovery').hidden = !stagePending;
  for (const name of ['action-close', 'action-copy', 'action-confirm', 'action-retry']) (element(name) as HTMLButtonElement).disabled = inFlight || loading;
  element('action-reload').hidden = !stale && !authFrozen;
  (element('action-reload') as HTMLButtonElement).disabled = frozen;
  if ((element('action-dialog') as HTMLDialogElement).open && (stale || authFrozen || inFlight || stagePending)) note(authFrozen ? '账号已变化或登录失效，保存已暂停。请复制输入后重新登录。' : stale ? '项目已被他人更新，旧内容已保留。请复制输入并重新进入项目。' : inFlight ? '正在处理，请等待结果。' : '保存结果尚未确认，请确认原结果或重试原操作。', stale || authFrozen || !inFlight);
  else if (!frozen && element('action-message').textContent === '正在处理，请等待结果。') note('');
}
function persist() {
  clearTimeout(bufferTimer);
  if (!snapshot || !values) return;
  try {
    if (pending || dirty()) sessionStorage.setItem(bufferKey, JSON.stringify({ format: 2, baseVersion: pending?.expectedVersion ?? editBaseVersion, values, pending, changeDraft, riskDraft, nodeDraft, nodeRestoreExtras }));
    else if (!candidate) sessionStorage.removeItem(bufferKey);
    storageFailed = false;
  } catch { storageFailed = true; }
  controls();
}
function readBuffer(key = bufferKey) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    const valid = (key: string, value: unknown) => {
      if (!keys.includes(key as keyof EditValues)) return false;
      if (key === 'changeOps') return value === undefined || Array.isArray(value) && value.every(validChangeDraft);
      if (key === 'changeOps') return JSON.stringify(value ?? [], null, 2);
  if (key === 'change' && typeof value === 'object') { const c = value as ChangeRecord; return `需求变更 #${c.id} · ${c.source} · ${c.decision === 'accept' ? '接受' : c.decision === 'reject' ? '拒绝' : c.decision + '（待核对）'}\n${c.content}\n理由：${c.reason}\n创建：${c.createdByName ?? '原人未知'} · ${c.createdAt}`; }
  if (key === 'nodeOps') return value === undefined || Array.isArray(value) && value.every(validNodeDraft);
      if (key === 'riskOps') return value === undefined || Array.isArray(value) && value.every(validRiskDraft);
      if (key === 'stagePlans') return value === undefined || Array.isArray(value) && value.length === 7 && value.every(item => /^S[1-7]$/.test(item.code) && (item.plannedDays === null || typeof item.plannedDays === 'number') && typeof item.note === 'string');
      if (key === 'people') return Array.isArray(value) && value.every(person => typeof person?.id === 'string' && /^[1-9][0-9]{0,19}$/.test(person.id) && roles.includes(person.role));
      if (key === 'chipIds' || key === 'tagIds') return Array.isArray(value) && value.every(id => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id));
      if (key.endsWith('Id')) return value === null || typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
      return typeof value === 'string';
    };
    if ([1, 2].includes(parsed?.format) && typeof parsed.baseVersion === 'string' && /^[1-9][0-9]{0,19}$/.test(parsed.baseVersion) && parsed.values && (parsed.format === 1 ? textKeys.slice(0, 4).every(key => typeof parsed.values[key] === 'string') : keys.every(key => valid(key, parsed.values[key])))) {
      if (parsed.changeDraft && !validChangeDraft(parsed.changeDraft) || parsed.riskDraft && !validRiskDraft(parsed.riskDraft) || parsed.nodeDraft && !validNodeDraft(parsed.nodeDraft) || parsed.nodeRestoreExtras && (!Array.isArray(parsed.nodeRestoreExtras) || !parsed.nodeRestoreExtras.every(validNodeDraft))) return;
      if (parsed.pending && (parsed.pending.expectedVersion !== parsed.baseVersion || typeof parsed.pending.idempotencyKey !== 'string' || !parsed.pending.changes || Object.entries(parsed.pending.changes).some(([key, value]) => !valid(key, value)))) return;
      return { ...parsed, format: 2, values: { ...baseline(), ...parsed.values } } as Buffer;
    }
  } catch { storageFailed = true; }
}
function choose(text: string, options: [string, string][], extra = ''): Promise<string> {
  const dialog = element('editor-dialog') as HTMLDialogElement;
  if (dialog.open) return Promise.resolve('cancel');
  dialog.innerHTML = `<p>${esc(text)}</p>${extra}<div class="edit-actions">${options.map(([value, title]) => `<button class="back-btn" data-choice="${value}">${title}</button>`).join('')}</div>`;
  return new Promise(resolve => {
    dialog.oncancel = event => { event.preventDefault(); dialog.close('cancel'); };
    dialog.onclose = () => resolve(dialog.returnValue);
    dialog.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach(button => button.onclick = () => dialog.close(button.dataset.choice!));
    dialog.showModal();
  });
}
async function copyText() {
  const changeCopyText = changeDraft ? '未确认需求变更表单\n' + JSON.stringify(changeDraft, null, 2) + '\n\n' : '';
  const nodeCopyText = nodeDraft ? '未确认节点表单\n' + JSON.stringify({ nodeDraft, nodeRestoreExtras }, null, 2) + '\n\n' : '';
  const riskCopy = riskDraft ? '未确认风险表单\n' + JSON.stringify(riskDraft, null, 2) + '\n\n' : '';
  const stageCopy = stagePending ?? stageDraft ?? correctionDraft ?? planDraft ?? lifecycleDraft ?? closureDraft ?? checkDraft;
  const text = changeCopyText + nodeCopyText + riskCopy + (stageCopy ? (isPlanCommand(stageCopy) || isLifecycleCommand(stageCopy) || isClosureCommand(stageCopy) || isCheckCommand(stageCopy)) ? `${actionLabels[stageCopy.action]}副本\n${JSON.stringify(stageCopy, null, 2)}\n\n` : 'reason' in stageCopy ? `${actionLabels[stageCopy.action]}副本\n原因：${stageCopy.reason}\n进入版本：${stageCopy.expectedVersion}\n${stageCopy.action === 'correctStageFacts' ? JSON.stringify(stageCopy.changes) : label(stageCopy.stageCode) + (stageCopy.undoStart ? '（开始也误记）' : '')}\n\n` : stageCopy.action === 'startProject' ? `启动项目副本\n实际启动：${stageCopy.actualDate}\n预计结案：${stageCopy.dueDate}\n调整原因：${stageCopy.planReason ?? ''}\n首次应检周：${stageCopy.previewFirstCheckWeek}\n进入版本：${stageCopy.expectedVersion}\n\n` : `阶段操作副本\n${label(stageCopy.stageCode)} · ${stageCopy.action === 'startStage' ? '开始' : '完成'}\n实际日期：${stageCopy.actualDate}\n说明：${stageCopy.completionNote ?? ''}\n进入版本：${stageCopy.expectedVersion}\n\n` : '') + keys.map(key => `${titles[key]}\n${showValue(key, values?.[key])}`).join('\n\n') + (candidate ? '\n\n——恢复候选副本——\n' + keys.map(key => `${titles[key]}\n${showValue(key, candidate!.values[key])}`).join('\n\n') + (candidate.changeDraft ? '\n未确认需求变更表单\n' + JSON.stringify(candidate.changeDraft, null, 2) : '') + (candidate.riskDraft ? '\n未确认风险表单\n' + JSON.stringify(candidate.riskDraft, null, 2) : '') + (candidate.nodeDraft ? '\n未确认节点表单\n' + JSON.stringify({ nodeDraft: candidate.nodeDraft, nodeRestoreExtras: candidate.nodeRestoreExtras }, null, 2) : '') : '') + (legacyCopy ? '\n\n——旧匿名试用副本（仅供核对）——\n' + keys.map(key => `${titles[key]}\n${showValue(key, legacyCopy!.values[key])}`).join('\n\n') : '');
  await choose('以下文字可选择后复制；复制不会保存项目。', [['cancel', '关闭']], `<textarea class="copy-text" readonly aria-label="未保存文字">${esc(text)}</textarea>`);
}
function editor() {
  const p = snapshot!.project;
  const field = (key: keyof EditValues, input: string, full = false) => `<div class="field${full ? ' field-full' : ''}"><label class="read-label" for="edit-${key}">${titles[key]}</label>${input}<span class="field-error" id="error-${key}">${esc(validationErrors[key])}</span></div>`;
  const text = (key: typeof textKeys[number]) => field(key, key === 'name' ? `<input data-edit id="edit-${key}" value="${esc(values![key])}" autocomplete="off">` : `<textarea data-edit id="edit-${key}" rows="3">${esc(values![key])}</textarea>`, true);
  const simple = (key: 'signal' | 'priority', choices: string[]) => field(key, `<select data-edit id="edit-${key}">${choices.map(value => `<option value="${value}"${values![key] === value ? ' selected' : ''}>${label(value)}</option>`).join('')}</select>`);
  const reference = (key: Exclude<keyof typeof referenceFields, 'people'>) => field(key, selectReference(key, referenceFields[key]), key === 'chipIds' || key === 'tagIds');
  const people = ['hardware_owner', 'software_owner', 'pm', 'participant'].map(role => `<div class="field"><label class="read-label" for="edit-people-${role}">${label(role)}</label>${selectReference('people', 'engineers', role)}</div>`).join('');
  return `<section class="trial-editor" aria-label="项目基本信息"><div class="field-grid">${text('name')}${text('detailNote')}${reference('customerId')}${reference('groupId')}${reference('productLineId')}${reference('odmCustomerId')}${reference('appId')}<div class="field"><span class="read-label">提案 / 立案日期</span><div class="read-value">${esc(p.proposalDate ?? '未知')} / ${esc(p.filingDate ?? '未知')}</div></div><div class="field field-full"><span class="read-label">项目日期</span><div class="read-value">实际启动 ${esc(p.startDate ?? '未知')} · 当前计划结案 ${esc(p.dueDate ?? '未定')}</div></div>${simple('priority', ['high', 'mid', 'low'])}<div class="field"><span class="read-label">项目状态</span><div class="read-value">${esc(label(p.status))} · 从项目操作变更</div></div>${reference('chipIds')}${people}<span class="field-error field-full" id="error-people">${esc(validationErrors.people)}</span>${reference('tagIds')}${text('summaryNote')}${text('statusDesc')}${text('marketExpectation')}${simple('signal', ['green', 'yellow', 'red'])}${text('signalNote')}${text('chipstatNote')}</div><p class="read-message">${esc(catalogMessage)}</p>${!catalog ? '<button class="back-btn" id="options-retry">重新读取候选资料</button>' : ''}</section>`;
}
function selectReference(key: string, table: string, role?: string) {
  const base = baseline();
  const ids = (value: unknown): string[] => key === 'people' ? (value as EditValues['people']).filter(person => person.role === role).map(person => person.id) : Array.isArray(value) ? value : value ? [String(value)] : [];
  const selected = ids(values![key as keyof EditValues]);
  const old = ids(base[key as keyof EditValues]);
  const options = [...(catalog?.[table] ?? [])];
  for (const id of new Set([...old, ...selected])) if (!options.some(item => item.id === id)) {
    const named = key === 'chipIds' ? snapshot!.project.chips : key === 'tagIds' ? snapshot!.project.tags : key === 'people' ? snapshot!.project.people : [];
    options.push({ id, name: named.find(item => item.id === id)?.name ?? id, enabled: 0 });
  }
  const multiple = ['chipIds', 'tagIds', 'people'].includes(key);
  return `<select data-edit data-reference="true" id="edit-${key}${role ? '-' + role : ''}"${multiple ? ' multiple size="4"' : ''}>${multiple ? '' : '<option value="">未选择</option>'}${options.filter(item => item.enabled || old.includes(item.id) || selected.includes(item.id)).map(item => `<option value="${esc(item.id)}"${selected.includes(item.id) ? ' selected' : ''}${!item.enabled && !old.includes(item.id) ? ' disabled' : ''}>${esc(item.name)}${item.originalModel ? ' · ' + esc(item.originalModel) : ''}${item.manufacturer ? ' · ' + esc(item.manufacturer) : ''}${item.enabled ? '' : '（停用/不可新增）'}</option>`).join('')}</select>`;
}
function showValue(key: string, value: unknown): string {
  if (value == null || value === '' || Array.isArray(value) && !value.length) return '（空）';
  if (key === 'closure' && typeof value === 'object') return Object.entries(value).map(([field, item]) => `${({ status: '总体状态', preCloseStatus: '结案前状态', maintenanceEnabled: '维护标识', ...closureTitles } as Record<string, string>)[field] ?? field}：${item == null || item === '' ? '未知/空' : field === 'maintenanceEnabled' ? item ? '开启' : '关闭' : label(item)}`).join('\n');
  if (key === 'closureSource' && typeof value === 'object') { const item = value as { auditId: string | null; sourceImportItemId: string | null; actorDisplayName: string | null; createdAt: string | null }; return item.auditId ? `原结案 #${item.auditId} · ${item.actorDisplayName} · ${item.createdAt}（UTC）` : `旧来源事实，审查来源 ${item.sourceImportItemId ?? '未知'}；不补造原操作人/时间`; }
  if (key === 'remaining' && typeof value === 'object') { const item = value as { stages: Entry[]; nodes: Entry[]; risks: Entry[] }; return `未完成阶段：${item.stages.map(stage => label(stage.code)).join(' / ') || '无'}\n节点：${item.nodes.map(node => node.title + ' #' + node.id).join(' / ') || '无'}\n未解除风险：${item.risks.map(risk => '#' + risk.id + ' ' + label(risk.level)).join(' / ') || '无'}`; }
  if (key === 'stageFacts' && Array.isArray(value)) return showValue('stageChanges', value);
  if (key === 'stageChanges' && Array.isArray(value)) return value.map(item => `${label(item.code)}：${label(item.state)}；开始 ${item.startedOn ?? '未知'}；完成 ${item.completedOn ?? '未知'}`).join('\n');
  if (key === 'node' && typeof value === 'object') {
    const node = value as NodeRecord;
    const linked = (id: string | null) => id ? nodeCopy(true).find(row => row.id === id)?.title ?? id : '无';
    return `${node.title || '原名称待核对'} · ${node.kind === 'customer' ? '客户节点' : label(node.stage)}\n目标完成：${node.targetDate ?? '未定'}；实际完成：${node.completedOn ?? '未完成'}\n${node.kind === 'customer' ? '备注：' + node.note : '成果：' + node.output + '\n前置：' + linked(node.previousNodeId) + '；后续：' + linked(node.nextNodeId)}${node.deletedAt ? '\n已删除' : ''}`;
  }
  if (key === 'nodeOps') return JSON.stringify(value, null, 2);
      if (key === 'riskOps') return JSON.stringify(value ?? [], null, 2);
  if (key === 'risk' && typeof value === 'object') { const r = value as RiskRecord; return `风险 #${r.id} · ${label(r.level)} · ${r.resolved ? '已解除' : '预警中'}\n${r.content}\n创建：${r.createdByName ?? '原人未知'} · ${r.createdAt}\n解除：${r.resolvedByName ?? '原人未知'} · ${r.resolvedAt ?? '—'}\n${r.resolution}`; }
  if (key === 'change' && typeof value === 'object') { const c = value as ChangeRecord; return `来源：${c.source}\n变更内容：${c.content}\n决定：${c.decision === 'accept' ? '接受' : c.decision === 'reject' ? '拒绝' : c.decision + '（待核对）'}\n决定理由：${c.reason || '（空）'}`; }
  if (key === 'stagePlans' && Array.isArray(value)) return value.map(item => `${label(item.code)}：工期 ${item.plannedDays ?? '未定'}；评述 ${item.note ?? ''}`).join('\n');
  if (key === 'scheduleRecord' && typeof value === 'object') { const record = value as ScheduleRecord; return `记录 #${record.id ?? '新记录'}：${record.kind === 'note' ? '补充说明' : '真实改期'}；${record.oldDate ?? '未定'} → ${record.newDate ?? '未定'}\n原因：${record.reason}\n措施：${record.measures}${record.voided ? '\n误录已撤销' : ''}`; }
  if (key === 'check' && typeof value === 'object') { const item = value as { id?: string; conclusion: string; note: string; checkedAt?: string; weekStart?: string }; return `检查 #${item.id ?? '新记录'}：${item.conclusion === 'follow_up' ? '已核对，需跟进' : '已核对'}；${item.note || '（无备注）'}${item.checkedAt ? '\n' + item.checkedAt + '（UTC），所属周 ' + item.weekStart : ''}`; }
  if (key === 'lifecycleNote' && typeof value === 'object') { const item = value as { auditId: string; note: string }; return `原记录 #${item.auditId}\n说明：${item.note}`; }
  if (Array.isArray(value)) return value.map(item => showValue(key, item)).join('\n');
  if (typeof value === 'object') { const item = value as { id?: string; name?: string; role?: string }; const name = Object.hasOwn(referenceFields, key) ? catalog?.[referenceFields[key as keyof typeof referenceFields]]?.find(row => row.id === item.id)?.name : undefined; return `${item.name ?? name ?? item.id ?? ''}${item.id ? ' [ID ' + item.id + ']' : ''}${item.role ? ' · ' + label(item.role) : ''}`; }
  if (Object.hasOwn(referenceFields, key)) {
    const item = catalog?.[referenceFields[key as keyof typeof referenceFields]]?.find(item => item.id === value);
    return `${item?.name ?? value} [ID ${value}]`;
  }
  return ['signal', 'priority', 'status', 'resumeStatus'].includes(key) ? label(value) : String(value);
}
async function loadCatalog() {
  if (catalogLoading) return;
  catalogLoading = true; catalogMessage = '正在读取候选资料…'; if (snapshot && tab === 'info') refreshReadView();
  try { catalog = await get<Catalog>('/api/project-options'); catalogMessage = ''; }
  catch (error) { catalogMessage = (error as Error).message + ' 原编辑已保留，可重新读取候选资料。'; }
  finally { catalogLoading = false; if (snapshot && tab === 'info') refreshReadView(); else controls(); }
}
function bindEditor() {
  if (!snapshot?.capabilities.editText) return;
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-stage-plan],[data-stage-note]').forEach(input => input.oninput = () => {
    const code = input.dataset.stagePlan ?? input.dataset.stageNote;
    const plan = values!.stagePlans!.find(item => item.code === code)!;
    if (input.dataset.stagePlan) plan.plannedDays = input.value === '' ? null : Number(input.value);
    else plan.note = input.value;
    delete validationErrors.stagePlans; persist();
  });
  textKeys.forEach(key => {
    const input = document.getElementById('edit-' + key) as HTMLInputElement | HTMLTextAreaElement | null;
    if (input) input.oninput = () => { values![key] = input.value; if (key === 'name') element('d-title').textContent = input.value; delete validationErrors[key]; element('error-' + key).textContent = ''; clearTimeout(bufferTimer); bufferTimer = setTimeout(persist, 300); controls(); };
  });
  for (const key of ['signal', 'priority', ...Object.keys(referenceFields)]) {
    for (const role of key === 'people' ? roles : ['']) {
      const input = document.getElementById('edit-' + key + (role ? '-' + role : '')) as HTMLSelectElement | null;
      if (input) input.onchange = () => {
        const selected = [...input.selectedOptions].map(option => option.value);
        const ordered = (old: string[]) => [...old.filter(id => selected.includes(id)), ...selected.filter(id => !old.includes(id))];
        if (key === 'people') {
          const old = values!.people.filter(person => person.role === role).map(person => person.id);
          values!.people = [...values!.people.filter(person => person.role !== role || selected.includes(person.id)), ...ordered(old).filter(id => !old.includes(id)).map(id => ({ id, role }))];
        } else if (key === 'chipIds' || key === 'tagIds') values![key] = ordered(values![key]);
        else Object.assign(values!, { [key]: input.value || null });
        delete validationErrors[key]; const error = document.getElementById('error-' + key); if (error) error.textContent = '';
        persist(); controls();
      };
    }
  }
  const options = document.getElementById('options-retry') as HTMLButtonElement | null;
  if (options) { options.disabled = catalogLoading; options.onclick = () => { void loadCatalog(); }; }
  const save = document.getElementById('save'); if (save) save.onclick = () => { void saveNew(); };
  const discard = document.getElementById('discard'); if (discard) discard.onclick = async () => { if (await choose('明确放弃当前未保存文字？', [['cancel', '继续编辑'], ['discard', '放弃编辑']]) === 'discard') { values = baseline(); riskDraft = undefined; nodeDraft = undefined; changeDraft = undefined; persist(); render(); } };
  const confirm = document.getElementById('confirm'); if (confirm) confirm.onclick = () => { void execute(true); };
  const retry = document.getElementById('retry'); if (retry) retry.onclick = () => { void execute(false); };
  controls();
}
function fieldErrors(errors: Record<string, string>) {
  validationErrors = errors; tab = Object.keys(errors).some(key => key.startsWith('riskOps') || key.startsWith('changeOps')) ? 'risk' : Object.keys(errors).some(key => key.startsWith('nodeOps')) ? ['flow', 'custnodes'].includes(tab) ? tab : 'nodes' : errors.stagePlans ? 'stages' : 'info'; render();
  for (const [key, error] of Object.entries(errors)) { const target = document.getElementById('error-' + key); if (target) target.textContent = error; }
  document.getElementById('edit-' + Object.keys(errors)[0])?.focus();
}
async function saveNew() {
  if (!snapshot?.capabilities.editText || !values || stale || pending || stagePending || inFlight || loading || !dirty()) return;
  if (changeDraft) { note('请先预览并确认需求变更表单，或明确取消，再保存项目。', true); return; }
  if (nodeDraft) { note('请先预览并确认节点表单，或明确取消，再保存项目。', true); return; }
  if (riskDraft) { note('请先预览并确认风险表单，或明确取消，再保存项目。', true); return; }
  const errors: Record<string, string> = {};
  if (!values.name.trim() || [...values.name].length > 255 || /[\r\n]/.test(values.name)) errors.name = '名称应为 1～255 个字符，不能仅含空白或换行';
  for (const key of textKeys.slice(1)) if (new TextEncoder().encode(values[key]).length > 65535) errors[key] = '说明超过 65535 字节';
  if (values.stagePlans?.some(plan => plan.plannedDays !== null && (!Number.isInteger(plan.plannedDays) || plan.plannedDays! < 0 || plan.plannedDays! > 65535)
    || new TextEncoder().encode(plan.note ?? '').length > 65535)
    || [...document.querySelectorAll<HTMLInputElement>('[data-stage-plan]')].some(input => input.validity.badInput)) errors.stagePlans = '工期须为空或0～65535的整数天；阶段评述最多65535字节';
  if (Object.keys(errors).length) { fieldErrors(errors); return; }
  pending = { expectedVersion: editBaseVersion, idempotencyKey: crypto.randomUUID(), changes: changes() };
  candidate = undefined;
  persist();
  await execute(false);
}
async function execute(confirm: boolean) {
  if (!pending || inFlight) return;
  const original = pending;
  inFlight = true; render();
  try {
    const response = await send<{ outcome: string; result?: SaveResult }>('/api/projects/' + id + (confirm ? '/save-results/query' : ''), confirm ? 'POST' : 'PATCH', original);
    if (pending !== original) return;
    if (response.outcome === 'committed' && response.result) {
      const result = response.result;
      if (result.projectId !== id || result.operationId !== original.idempotencyKey) throw new SaveError('RESPONSE_UNKNOWN', 'unknown');
      const higher = BigInt(observedVersion) > BigInt(result.savedVersion);
      const merged = { ...baseline(), ...result.values, riskOps: [], nodeOps: [], changeOps: [] };
      if (BigInt(result.savedVersion) >= BigInt(snapshot!.project.version)) {
        Object.assign(snapshot!.project, result.values, { version: result.savedVersion, ...(result.savedAt ? { updatedAt: result.savedAt } : {}) });
        if ('chipIds' in result.values) {
          const display = result.display ?? {};
          const named = (key: string, id: string) => catalog?.[referenceFields[key as keyof typeof referenceFields]]?.find(item => item.id === id)?.name ?? id;
          for (const [key, field] of [['customerId', 'customer'], ['odmCustomerId', 'odmFactory'], ['productLineId', 'productLine'], ['appId', 'app'], ['groupId', 'projectGroup']]) snapshot!.project[field] = merged[key as keyof EditValues] ? (display[key] as { name?: string } | undefined)?.name ?? named(key, merged[key as keyof EditValues] as string) : null;
          snapshot!.project.chips = (display.chipIds as Detail['project']['chips'] | undefined) ?? merged.chipIds.map(id => ({ id, name: named('chipIds', id) }));
          snapshot!.project.tags = (display.tagIds as Detail['project']['tags'] | undefined) ?? merged.tagIds.map(id => ({ id, name: named('tagIds', id) }));
          snapshot!.project.people = (display.people as Detail['project']['people'] | undefined) ?? merged.people.map(person => ({ ...person, name: named('people', person.id) }));
        }
        if (result.changes) snapshot!.changes = result.changes;
        if (result.risks) snapshot!.risks = result.risks;
        if (result.nodes) snapshot!.nodes = result.nodes;
        if ('stagePlans' in result.values) for (const plan of merged.stagePlans ?? []) Object.assign(snapshot!.stages.find(stage => stage.code === plan.code)!, plan);
      }
      values = merged; editBaseVersion = result.savedVersion; pending = undefined; stale = higher;
      candidate = undefined; riskDraft = undefined; nodeDraft = undefined; changeDraft = undefined;
      deletedNodes = undefined; deletedGeneration++; deletedLoading = false; deletedMessage = ''; restoredSources.clear();
      // 只清除本项目该原操作对应的缓存，不清除后来出现的副本。
      try { const stored = readBuffer(); if (stored?.pending?.idempotencyKey === original.idempotencyKey) sessionStorage.removeItem(bufferKey); } catch { storageFailed = true; }
      note((result.changed ? '项目已保存。' : '内容一致，已确认，无新增修改历史。') + (higher ? ' 项目又被更新，请重新进入项目。' : ''));
      audit = undefined; auditGeneration++; auditMessage = '';
      void observe(true);
      if (tab === 'history') void loadAudit();
    } else { note('暂未查到原操作回执，结果仍未确认。可稍后确认或重试原操作。', true); persist(); }
  } catch (error) {
    const failure = error instanceof SaveError ? error : new SaveError('TRANSPORT_UNKNOWN', 'unknown');
    if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes(failure.code)) authFrozen = true;
    if (failure.code === 'PROJECT_VERSION_CONFLICT') stale = true;
    if (failure.outcome === 'not_committed' && failure.code !== 'OPERATION_KEY_REUSED') pending = undefined;
    note(failure.message, true); persist();
    if (failure.fields) fieldErrors(failure.fields);
  } finally { inFlight = false; render(); }
}
async function observe(afterSave = false, active = true) {
  const entry = snapshot;
  if (!entry) return;
  const token = generation;
  try {
    const current = await get<Detail>('/api/projects/' + id, undefined, active && !afterSave);
    if (token !== generation || snapshot !== entry) return;
    if (BigInt(current.project.version) > BigInt(observedVersion)) observedVersion = current.project.version;
    if (BigInt(observedVersion) > BigInt(entry.project.version)) { stale = true; note('项目已被他人更新，请重新进入项目。未保存文字已保留供复制。', true); controls(); }
    else if (current.project.version === entry.project.version) {
      entry.project.deadline = current.project.deadline; entry.project.checkStatus = current.project.checkStatus; entry.checkRule = current.checkRule; entry.businessDate = current.businessDate;
      element('d-tags').innerHTML = projectTags(entry.project);
      element('d-meta').textContent = detailMeta(entry.project);
    }
  } catch (error) { if (error instanceof SaveError) { authFrozen = true; persist(); note(error.message, true); controls(); } else if (afterSave) note('本次保存已确认，后续详情刷新失败。可重新进入查看；无需重复保存。', true); }
}
async function loadAudit(more = false) {
  const token = ++auditGeneration;
  auditMessage = '正在读取服务器修改历史…'; if (tab === 'history') render();
  try {
    const page = await get<AuditPage>('/api/projects/' + id + '/audit' + (more && audit?.nextCursor ? '?before=' + audit.nextCursor : ''));
    if (token !== auditGeneration) return;
    audit = { ...page, items: more && audit ? [...audit.items, ...page.items] : page.items }; auditMessage = '';
  } catch (error) { if (token === auditGeneration) auditMessage = (error as Error).message + ' 可重试读取历史。'; }
  if (token === auditGeneration && tab === 'history') refreshReadView();
}
element('action-close').onclick = dismissAction;
element('action-copy').onclick = () => { void copyText(); };
element('action-reload').onclick = () => element('reload').click();
(element('action-dialog') as HTMLDialogElement).oncancel = event => { event.preventDefault(); dismissAction(); };
element('action-confirm').onclick = () => { void executeStage(true); };
element('action-retry').onclick = () => { void executeStage(false); };
setupTheme();
function clock() {
  const now = new Date(), day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
  const [year] = day.split('-').map(Number), remaining = Math.round((Date.UTC(year, 11, 31) - Date.parse(day)) / 86400000);
  element('date-zone').innerHTML = `<div class="dz-left"><span class="dz-date">${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' }).format(now)}</span><span class="dz-week">${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(now)}</span><span class="dz-time">${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now)}</span></div><span class="read-label">距年底 ${remaining} 天</span>`;
}
clock(); setInterval(clock, 1000);
try {
  const saved = JSON.parse(sessionStorage.getItem('geekdash_board_return') ?? 'null');
  if (typeof saved?.url === 'string') {
    const url = new URL(saved.url);
    if (url.origin === location.origin && ['/', '/GeekDash.html'].includes(url.pathname)) (element('back') as HTMLAnchorElement).href = url.href;
  }
} catch { /* 无返回上下文时使用普通列表入口。 */ }
function table(items: Entry[], fields: [string, string][]) {
  if (!items.length) return '<p class="read-message">暂无记录。</p>';
  return `<div class="read-table-wrap"><table class="read-table"><thead><tr>${fields.map(([, title]) => `<th scope="col">${title}</th>`).join('')}</tr></thead><tbody>${items.map(item => `<tr>${fields.map(([key]) => `<td>${esc(['code', 'state', 'stage', 'level', 'decision'].includes(key) ? label(item[key]) : item[key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function render() {
  if (!snapshot) return;
  const dialog = element('action-dialog') as HTMLDialogElement;
  if (dialog.open) dialog.close(); element('action-fields').replaceChildren(); element('action-message').textContent = '';
  const p = snapshot.project;
  element('notice').textContent = snapshot.capabilities.editText ? '本人已负责 · 普通修改统一保存，页面保持进入时的内容。' : '当前仅可查看 · 从“管理负责范围”保存加入后可编辑。';
  element('d-title').textContent = values?.name ?? p.name;
  element('d-tags').innerHTML = projectTags(p);
  element('d-meta').textContent = detailMeta(p);
  let content = '';
  if (tab === 'info') {
    const values: [string, unknown][] = [['项目名称', p.name], ['客户', p.customer], ['产品线', p.productLine], ['ODM 工厂', p.odmFactory], ['APP', p.app], ['分组', p.projectGroup], ['项目标签', p.tags.map(tag => tag.name).join(' / ')], ['项目状态', label(p.status)], ['优先级', label(p.priority)], ['信号灯', label(p.signal)], ['灯色说明', p.signalNote], ['提案日期', p.proposalDate], ['立案日期', p.filingDate], ['启动日期', p.startDate], ['原计划结案日期', p.originalDueDate], ['当前计划结案日期', p.dueDate], ['结案日期', p.closedOn], ['结案类型', p.closureType ? label(p.closureType) : '—'], ['市场预期', p.marketExpectation], ['最新状态', p.statusDesc], ['项目备注', p.detailNote], ['汇总备注', p.summaryNote], ['芯片统计备注', p.chipstatNote], ['结案说明', p.closureNote], ['剩余工作', p.remainingWorkNote], ['阶段进度', `${p.progress}%`]];
    for (const role of ['hardware_owner', 'software_owner', 'pm', 'participant']) values.push([label(role), p.people.filter(person => person.role === role).map(person => person.name).join(' / ')]);
    content = (snapshot.capabilities.editText ? editor() : '') + `<div class="field-grid">${values.filter(([title]) => !snapshot!.capabilities.editText || ![...Object.values(titles), '项目备注', '汇总备注', '最新状态', '优先级', '项目状态', '提案日期', '立案日期', '启动日期', '当前计划结案日期', '阶段进度', ...roles.map(label)].includes(title)).map(([title, value]) => `<div class="field"><span class="read-label">${title}</span><div class="read-value">${esc(value === '' || value == null ? '—' : value)}</div></div>`).join('')}</div>`;
  } else if (tab === 'stages') content = stagePanel();
  else if (tab === 'nodes' || tab === 'custnodes' || tab === 'flow') content = nodePanel(tab === 'custnodes' ? 'customer' : 'project', tab === 'flow') + deletedNodePanel(tab === 'custnodes' ? 'customer' : 'project');
  else if (tab === 'history') content = '<h2>服务器修改历史</h2><p class="read-message">时间为 UTC，每页 20 条。只有实际变化才产生修改历史。</p>'
    + (audit?.items.length ? audit.items.map(item => `<article class="audit-entry"><h3>${esc(actionLabels[item.action] ?? item.action)} · ${esc(item.actorDisplayName)} · ${esc(item.createdAt)} · 版本 ${esc(item.versionBefore)} → ${esc(item.versionAfter)}</h3>${Object.keys(item.afterValues).map(key => `<div><strong>${esc(titles[key as keyof EditValues] ?? ({ stageChanges: '阶段状态与实际日期', completionNote: '完成说明', reason: '操作原因', progress: '有效阶段进度', status: '项目状态', startDate: '实际启动日期', dueDate: '当前计划结案日期', originalDueDate: '原计划结案日期', firstCheckWeek: '首次应检周', firstCheckRuleVersion: '首次应检规则版本', resumeStatus: '暂缓前项目状态', closure: '当前结案事实', closureSource: '原结案来源', remaining: '当时遗留', stageFacts: '当时有效阶段事实', lifecycleNote: '有效说明', note: '操作说明' } as Record<string, string>)[key] ?? key)}</strong><div class="audit-diff"><div><span class="read-label">修改前</span><div class="read-value">${esc(showValue(key, item.beforeValues?.[key]))}</div></div><div><span class="read-label">修改后</span><div class="read-value">${esc(showValue(key, item.afterValues[key]))}</div></div></div></div>`).join('')}</article>`).join('') : '<p>暂无服务器修改历史。</p>')
    + `<p class="read-message">${esc(auditMessage)}</p><button class="back-btn" id="audit-refresh">重新读取历史</button>${audit?.nextCursor ? '<button class="back-btn" id="audit-more">读取更早记录</button>' : ''}`
    + '<h2>旧来源历史</h2><p class="read-message">保留原来源时间文本，与服务器修改历史分开。</p>' + table(snapshot.history.slice().reverse(), [['date', '来源时间'], ['text', '更新内容']]);
  else if (tab === 'risk') content = riskPanel() + changePanel() + '<h2>改期与说明</h2>' + (snapshot.delays.map(scheduleHistory).join('') || '<p>没有计划历史。</p>');
  if (['info', 'risk'].includes(tab)) content += `<details class="secondary-section"><summary>计划与日期 · 当前计划 ${esc(p.dueDate ?? '未定')}</summary>${snapshot.capabilities.editText ? '<button class="back-btn" data-plan="notePlan">补充计划说明</button>' : ''}<p>原计划结案：${esc(p.originalDueDate ?? '未定')} · 实际启动：${esc(p.startDate ?? '未知')}</p>`;
  if (['info', 'risk'].includes(tab)) content += `<p class="read-message">有效改期 ${snapshot.planSummary.reschedules} 次，其中向后调整 ${snapshot.planSummary.laterAdjustments} 次；日期待核对 ${snapshot.planSummary.unknownAdjustments} 次。相对原始计划净调整：${snapshot.planSummary.netDays === null ? '无法计算' : snapshot.planSummary.netDays + ' 天'}。</p></details>`;
  if (planDraft && !stagePending) content = `<p>本标签页保留${esc(actionLabels[planDraft.action])}副本。</p><button class="back-btn" id="plan-restore">恢复计划/日期表单</button><button class="back-btn" id="plan-discard">放弃该副本</button>${planDraft.action === 'reschedulePlan' ? '<button class="back-btn" id="plan-as-note">作为补充说明重新预览</button>' : ''}` + content;
  if (tab === 'info') {
    const p = snapshot.project;
    content += `<details class="secondary-section"><summary>暂缓与恢复记录</summary>${p.status === 'paused' ? `<p>项目暂缓；此前状态：${esc(p.resumeStatus ? label(p.resumeStatus) : '未知，需核对来源')}。阶段保留，不代表仍在执行。</p>` : ''}<p>${esc(p.checkStatus.label)}${p.checkStatus.updatedAfterCheck ? '；检查后项目有更新' : ''} · 本周截止 ${esc(p.checkStatus.deadlineDate ?? '未初始化')}；不自动产生检查。</p>${p.checkStatus.latest ? `<p>最新检查：${esc(p.checkStatus.latest.actorName ?? '原账号未知')} · ${esc(p.checkStatus.latest.checkedAt)}（UTC） · ${p.checkStatus.latest.conclusion === 'follow_up' ? '已核对，需跟进' : '已核对'}。</p>` : ''}</details>`;
    content += snapshot.lifecycleNotes.map(item => `<article class="audit-entry"><h3>${esc(actionLabels[item.action])} #${esc(item.id)} · ${esc(item.actorDisplayName)} · ${esc(item.createdAt)}（UTC）</h3><p>有效说明：${esc(item.note || '（空）')}</p><details><summary>原文及纠错来源</summary><p>${esc(item.originalNote || '（空）')}</p>${item.corrections.map(change => `<p>${esc(change.actorDisplayName)} · ${esc(change.createdAt)} · ${esc(change.reason)}</p>`).join('')}</details>${snapshot!.capabilities.editText ? `<button class="back-btn" data-lifecycle="correctLifecycleNote" data-audit="${esc(item.id)}">纠正说明</button>` : ''}</article>`).join('');
  }
  if (lifecycleDraft && !stagePending) content = `<p>本标签页保留${esc(actionLabels[lifecycleDraft.action])}副本。</p><button class="back-btn" id="lifecycle-restore">恢复暂缓/恢复表单</button><button class="back-btn" id="lifecycle-discard">放弃该副本</button>` + content;
  if (stagePending && (isPlanCommand(stagePending) || isLifecycleCommand(stagePending) || isClosureCommand(stagePending) || isCheckCommand(stagePending)) && tab !== 'stages') content = '<p role="status">原动作结果待确认。</p><button class="back-btn" id="stage-confirm">确认原动作结果</button><button class="back-btn" id="stage-retry">重试原动作</button>' + content;
  if (tab === 'info') {
    content += `<details class="secondary-section"><summary>结案与维护事实</summary>${p.status === 'closed' ? `<p>本次结案：${esc(snapshot.currentClosure?.auditId ? '#' + snapshot.currentClosure.auditId + ' · ' + snapshot.currentClosure.actorDisplayName + ' · ' + snapshot.currentClosure.createdAt + '（UTC）' : '旧来源事实，原操作人/时间未知')}；结案时计划 ${esc(p.closureDueDate ?? (snapshot.currentClosure?.auditId ? '未定' : '未知，需核对'))}。阶段实际进度 ${esc(p.progress)}%，维护${p.maintenanceEnabled ? '开启' : '关闭'}，与S7分别记录。</p><p>重开将恢复：${esc(p.preCloseStatus ? label(p.preCloseStatus) : '依据未知，需核对来源')}。原结案及每次更正从修改历史查看。</p>${snapshot.capabilities.editText ? '<button class="back-btn" data-closure="correctClosure">纠正当前结案</button>' : ''}` : `<p>人工确认结案，保留真实阶段/节点/风险及首次检查依据，不自动完成七阶段。</p>`}</details>`;
  }
  if (tab === 'info') content += checkHistory();
  if (checkDraft && !stagePending) content = '<p>本标签页保留检查副本。</p><button class="back-btn" id="check-restore">恢复检查表单</button><button class="back-btn" id="check-discard">放弃该副本</button>' + content;
  if (closureDraft && !stagePending) content = '<p>本标签页保留结案操作副本。</p><button class="back-btn" id="closure-restore">恢复结案操作表单</button><button class="back-btn" id="closure-discard">放弃该副本</button>' + content;
  if (nodeDraft) content += '<p>本标签页保留未确认节点表单。</p><button class="back-btn" id="node-restore">恢复节点表单</button>';
  if (changeDraft) content += '<p>本标签页保留未确认需求变更表单。</p><button class="back-btn" id="change-restore">恢复需求变更表单</button>';
  if (riskDraft) content += '<p>本标签页保留未确认风险表单。</p><button class="back-btn" id="risk-restore">恢复风险表单</button>';
  content += '<div id="change-form"></div><div id="risk-form"></div><div id="plan-form"></div><div id="lifecycle-form"></div><div id="closure-form"></div><div id="check-form"></div>';
  element('project-menu').hidden = !snapshot.capabilities.editText;
  element('project-actions').innerHTML = snapshot.capabilities.editText ? `<button class="back-btn" data-plan="${p.dueDate ? 'reschedulePlan' : 'setPlan'}">${p.dueDate ? '调整计划' : '确定计划'}</button><button class="back-btn" data-plan="correctProjectDates">纠正日期信息</button>${p.status === 'closed' ? '<button class="back-btn" data-closure="reopenProject">重新打开项目</button><button class="back-btn" data-closure="setMaintenance">' + (p.maintenanceEnabled ? '结束维护' : '开启维护') + '</button>' : '<button class="back-btn" data-lifecycle="' + (p.status === 'paused' ? 'resumeProject' : 'pauseProject') + '">' + (p.status === 'paused' ? '恢复项目' : '暂缓项目') + '</button><button class="back-btn" data-closure="closeProject">结案项目</button>'}` : '';
  element('project-context').innerHTML = `<span>${esc(label(p.stage))} · 进度 ${esc(p.progress)}% · 预计结案 ${esc(p.dueDate ?? '未定')} · ${esc(p.checkStatus.label)}${p.checkStatus.updatedAfterCheck ? ' · 检查后有更新' : ''}</span>${snapshot.capabilities.editText ? '<button class="back-btn" data-check="saveCheck">检查</button>' : ''}`;
  element('project-savebar').hidden = !snapshot.capabilities.editText;
  element('project-savebar').innerHTML = snapshot.capabilities.editText ? `<div class="savebar-main"><button class="save-btn" id="save">保存项目</button><button class="back-btn" id="discard" hidden>取消修改</button><span id="edit-state" role="status"></span>${pending ? '<button class="back-btn" id="confirm">确认原保存结果</button><button class="back-btn" id="retry">重试原操作</button>' : ''}</div><p id="storage-warning" class="field-error"></p>` : '';
  element('detail-body').innerHTML = content;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  bindEditor();
  bindNodes();
  const nodeRestore = document.getElementById('node-restore'); if (nodeRestore) nodeRestore.onclick = () => { if (nodeDraft) void openNode(nodeDraft.op, 'id' in nodeDraft ? nodeDraft.id : undefined); };
  document.querySelectorAll<HTMLButtonElement>('[data-change]').forEach(button => button.onclick = () => { void openChange(button.dataset.change as ChangeOperation['op'], button.dataset.changeId); });
  const changeRestore = document.getElementById('change-restore'); if (changeRestore) changeRestore.onclick = () => { if (changeDraft) void openChange(changeDraft.op, 'id' in changeDraft ? changeDraft.id : undefined); };
  document.querySelectorAll<HTMLButtonElement>('[data-risk]').forEach(button => button.onclick = () => { void openRisk(button.dataset.risk as RiskOperation['op'], button.dataset.riskId); });
  const riskRestore = document.getElementById('risk-restore'); if (riskRestore) riskRestore.onclick = () => { if (riskDraft) void openRisk(riskDraft.op, 'id' in riskDraft ? riskDraft.id : undefined); };
  document.querySelectorAll<HTMLButtonElement>('[data-check]').forEach(button => button.onclick = () => { void openCheck(button.dataset.check as CheckCommand['action'], button.dataset.checkId); });
  const checkRestore = document.getElementById('check-restore'); if (checkRestore) checkRestore.onclick = () => { if (checkDraft) void openCheck(checkDraft.action, 'checkId' in checkDraft ? checkDraft.checkId : undefined); };
  const checkDiscard = document.getElementById('check-discard'); if (checkDiscard) checkDiscard.onclick = () => { checkDraft = undefined; persistStage(); render(); };
  const checksRefresh = document.getElementById('checks-refresh'); if (checksRefresh) checksRefresh.onclick = () => { void loadChecks(); };
  const checksMore = document.getElementById('checks-more'); if (checksMore) checksMore.onclick = () => { void loadChecks(true); };
  document.querySelectorAll<HTMLButtonElement>('[data-closure]').forEach(button => button.onclick = () => { void openClosure(button.dataset.closure as ClosureCommand['action'], button.dataset.closureType === 'terminated' ? 'terminated' : 'normal'); });
  const closureRestore = document.getElementById('closure-restore'); if (closureRestore) closureRestore.onclick = () => { if (closureDraft) void openClosure(closureDraft.action); };
  const closureDiscard = document.getElementById('closure-discard'); if (closureDiscard) closureDiscard.onclick = () => { closureDraft = undefined; persistStage(); render(); };
  document.querySelectorAll<HTMLButtonElement>('[data-lifecycle]').forEach(button => button.onclick = () => { void openLifecycle(button.dataset.lifecycle as LifecycleCommand['action'], button.dataset.audit); });
  const lifecycleRestore = document.getElementById('lifecycle-restore'); if (lifecycleRestore) lifecycleRestore.onclick = () => { if (lifecycleDraft) void openLifecycle(lifecycleDraft.action, 'auditId' in lifecycleDraft ? lifecycleDraft.auditId : undefined); };
  const lifecycleDiscard = document.getElementById('lifecycle-discard'); if (lifecycleDiscard) lifecycleDiscard.onclick = () => { lifecycleDraft = undefined; persistStage(); render(); };
  document.querySelectorAll<HTMLButtonElement>('[data-plan]').forEach(button => button.onclick = () => { void openPlan(button.dataset.plan as PlanCommand['action'], button.dataset.record); });
  const planRestore = document.getElementById('plan-restore'); if (planRestore) planRestore.onclick = () => { if (planDraft) void openPlan(planDraft.action, 'recordId' in planDraft ? planDraft.recordId : undefined); };
  const planDiscard = document.getElementById('plan-discard'); if (planDiscard) planDiscard.onclick = () => { planDraft = undefined; persistStage(); render(); };
  const asNote = document.getElementById('plan-as-note'); if (asNote) asNote.onclick = () => { if (planDraft?.action === 'reschedulePlan') { planDraft = { action: 'notePlan', expectedVersion: planDraft.expectedVersion, idempotencyKey: crypto.randomUUID(), reason: planDraft.reason, measures: planDraft.measures }; persistStage(); void openPlan('notePlan'); } };
  document.querySelectorAll<HTMLButtonElement>('[data-stage-action]').forEach(button => button.onclick = () => { void openStage(button.dataset.stage!, button.dataset.stageAction as StageCommand['action']); });
  document.querySelectorAll<HTMLButtonElement>('[data-correction]').forEach(button => button.onclick = () => { void openCorrection(button.dataset.correction as CorrectionCommand['action'], button.dataset.stage); });
  const correctionRestore = document.getElementById('correction-restore'); if (correctionRestore) correctionRestore.onclick = () => { if (correctionDraft) void openCorrection(correctionDraft.action, 'stageCode' in correctionDraft ? correctionDraft.stageCode : undefined); };
  const correctionDiscard = document.getElementById('correction-discard'); if (correctionDiscard) correctionDiscard.onclick = () => { correctionDraft = undefined; persistStage(); render(); };
  for (const [name, confirm] of [['stage-confirm', true], ['stage-retry', false]] as const) { const button = document.getElementById(name); if (button) button.onclick = () => { void executeStage(confirm); }; }
  const startButton = document.getElementById('project-start'); if (startButton) startButton.onclick = () => { void openStart(); };
  const restoreStage = document.getElementById('stage-restore'); if (restoreStage) restoreStage.onclick = () => { if (stageDraft) { if (stageDraft.action === 'startProject') void openStart(); else void openStage(stageDraft.stageCode, stageDraft.action); } };
  const discardStage = document.getElementById('stage-discard'); if (discardStage) discardStage.onclick = () => { stageDraft = undefined; persistStage(); render(); };
  const refresh = document.getElementById('audit-refresh'); if (refresh) refresh.onclick = () => { void loadAudit(); };
  const more = document.getElementById('audit-more'); if (more) more.onclick = () => { void loadAudit(true); };
  controls();
}
async function load(initial = false) {
  const current = ++generation;
  loading = true; controls();
  element('message').classList.remove('error');
  element('message').textContent = '正在读取项目…';
  if (!/^[1-9][0-9]{0,19}$/.test(id)) { element('message').textContent = '项目编号无效，请从列表选择项目。'; loading = false; controls(); return; }
  try {
    const data = await get<Detail>('/api/projects/' + id);
    if (current !== generation) return;
    snapshot = data;
    values = baseline(); riskDraft = undefined; nodeDraft = undefined; changeDraft = undefined; nodeRestoreExtras = []; editBaseVersion = data.project.version; observedVersion = data.project.version; stale = false; validationErrors = {};
    audit = undefined; auditMessage = ''; auditGeneration++; checks = undefined; checksMessage = ''; checksGeneration++;
    deletedNodes = undefined; deletedMessage = ''; deletedGeneration++; deletedLoading = false; restoredSources.clear();
    element('detail-panel').hidden = false;
    render();
    element('message').textContent = '';
    if (initial) {
      if (stagePending) { tab = isPlanCommand(stagePending) || isLifecycleCommand(stagePending) || isClosureCommand(stagePending) || isCheckCommand(stagePending) ? 'info' : 'stages'; render(); await executeStage(true); }
      candidate = readBuffer();
      if (candidate?.pending && data.capabilities.editText) {
        values = { ...candidate.values }; changeDraft = candidate.changeDraft; riskDraft = candidate.riskDraft; nodeDraft = candidate.nodeDraft; nodeRestoreExtras = candidate.nodeRestoreExtras ?? []; editBaseVersion = candidate.baseVersion; pending = candidate.pending; candidate = undefined; render(); await execute(true);
      } else if (candidate) {
        if (candidate.baseVersion === data.project.version && data.capabilities.editText) {
          if (await choose('发现本标签页未保存文字，是否恢复？恢复后仍需明确保存。', [['restore', '恢复编辑'], ['cancel', '暂不恢复']]) === 'restore') { values = { ...candidate.values }; changeDraft = candidate.changeDraft; riskDraft = candidate.riskDraft; nodeDraft = candidate.nodeDraft; nodeRestoreExtras = candidate.nodeRestoreExtras ?? []; candidate = undefined; render(); persist(); }
        } else { note('旧副本的项目版本已过期或当前项目只读，旧文字仅供复制核对。', true); controls(); }
      }
    }
    await hydrateRestoredNodes();
    return true;
  } catch (error) {
    if (current !== generation) return false;
    element('message').classList.add('error');
    element('message').textContent = (error as Error).message + (snapshot ? ' 当前仍显示上次进入的项目版本。' : '');
  } finally { if (current === generation) { loading = false; controls(); } }
}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.onclick = () => { persist(); tab = button.dataset.tab!; render(); if (tab === 'history' && !audit) void loadAudit(); });
element('reload').onclick = async () => {
  if (pending || stagePending || inFlight) return;
  if (dirty()) {
    const choice = await choose('重新进入前请处理未保存文字。保留后可通过复制入口核对，不会自动带入新版本。', [['cancel', '继续编辑'], ['keep', '保留副本并重新进入'], ['discard', '放弃并重新进入']]);
    if (choice === 'cancel') return;
    if (choice === 'keep') { persist(); candidate = { format: 2, baseVersion: editBaseVersion, values: structuredClone(values!), changeDraft, riskDraft, nodeDraft, nodeRestoreExtras }; }
    else { candidate = undefined; try { sessionStorage.removeItem(bufferKey); } catch { storageFailed = true; } }
  }
  await load();
};
element('back').onclick = async event => {
  if (!dirty() && !pending && !stagePending && !stageDraft && !correctionDraft && !planDraft && !lifecycleDraft && !closureDraft && !checkDraft) return;
  event.preventDefault(); persist();
  const choice = await choose(pending || stagePending ? '原保存结果尚未确认，离开会保留原操作恢复信息。' : '项目尚未保存，如何返回列表？', [['cancel', '继续编辑'], ['keep', '保留本标签页副本并离开'], ...(!pending && !stagePending ? [['discard', '放弃编辑并离开'] as [string, string]] : [])]);
  if (choice === 'cancel') return;
  if (choice === 'discard') { candidate = undefined; stageDraft = undefined; correctionDraft = undefined; planDraft = undefined; lifecycleDraft = undefined; closureDraft = undefined; checkDraft = undefined; persistStage(); try { sessionStorage.removeItem(bufferKey); } catch { storageFailed = true; } }
  leaving = true;
  location.href = (element('back') as HTMLAnchorElement).href;
};
element('copy').onclick = () => { void copyText(); };
window.addEventListener('focus', () => { void observe(); });
function detailMeta(p: Detail['project']) { return `客户：${p.customer ?? '—'} · 产品线：${p.productLine ?? '—'} · 芯片：${p.chips.map(chip => chip.name).join(' / ') || '—'}`; }
setInterval(() => { if (snapshot && !inFlight && !loading && document.visibilityState === 'visible' && snapshot.businessDate !== new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())) void observe(false, false); }, 60000);
window.addEventListener('beforeunload', event => { if (!leaving && (dirty() || pending || stagePending || stageDraft || correctionDraft || planDraft || lifecycleDraft || closureDraft || checkDraft)) { persist(); persistStage(); event.preventDefault(); } });
document.addEventListener('geekdash-identity-changed', () => { persist(); authFrozen = true; note('账号已变化。请复制未保存内容，重新登录原账号后再进入。', true); controls(); });
void requireIdentity().then(async () => {
  bufferKey = `geekdash_project_buffer:${account!.id}:${id}`;
  // 匿名副本不归属任一账号；只提示保留供核对，不自动作为实名编辑恢复。
  if (sessionStorage.getItem(`geekdash_trial_text_v1:${id}`)) note('发现旧试用副本，请保留原标签页内容供核对；新编辑按当前账号隔离。');
  try { responsibilityPending = JSON.parse(sessionStorage.getItem(responsibilityKey()) ?? 'null') ?? undefined; } catch { note('责任变更恢复信息损坏，请先核对当前负责人。', true); }
  try {
    const saved = JSON.parse(sessionStorage.getItem(stageKey()) ?? 'null');
    for (const part of ['pending', 'draft', 'correction', 'plan', 'lifecycle', 'closure', 'check'] as const) {
      const v = saved?.[part];
      const validCorrection = v && typeof v.reason === 'string' && (v.action === 'correctStageFacts' ? Array.isArray(v.changes) && v.changes.every((item: { code: string }) => /^S[1-7]$/.test(item.code)) : ['undoStageStart', 'undoStageComplete', 'rollbackStage'].includes(v.action) && /^S[1-7]$/.test(v.stageCode));
      const patch = v?.changes;
      const validPatch = patch && typeof patch === 'object' && !Array.isArray(patch) && Object.values(patch).every(value => value === null || typeof value === 'string');
      const validPlan = v && typeof v.action === 'string' && isPlanCommand(v)
        && (v.action === 'setPlan' ? typeof v.dueDate === 'string' : typeof v.reason === 'string')
        && (!(v.action === 'reschedulePlan' || v.action === 'notePlan') || typeof v.measures === 'string')
        && (v.action !== 'reschedulePlan' || typeof v.dueDate === 'string')
        && (!['correctProjectDates', 'correctScheduleRecord'].includes(v.action) || validPatch && Object.keys(patch).every(key => (v.action === 'correctProjectDates' ? Object.keys(dateTitles) : ['oldDate', 'newDate', 'reason', 'measures']).includes(key)))
        && (!(v.action === 'correctScheduleRecord' || v.action === 'voidScheduleRecord') || /^[1-9][0-9]{0,19}$/.test(v.recordId))
        && (!('currentDueDate' in v) || v.currentDueDate === null || typeof v.currentDueDate === 'string');
      const validLifecycle = v && isLifecycleCommand(v) && (v.action === 'pauseProject' ? typeof v.reason === 'string' : v.action === 'resumeProject' ? typeof v.note === 'string' && (v.dueDate === undefined || typeof v.dueDate === 'string') && (v.planReason === undefined || typeof v.planReason === 'string') : /^[1-9][0-9]{0,19}$/.test(v.auditId) && typeof v.note === 'string' && typeof v.reason === 'string');
      const validClosure = v && isClosureCommand(v) && (v.action === 'closeProject' ? (['closureType', 'closedOn', 'closureNote', 'remainingWorkNote'] as const).every(key => typeof v[key] === 'string') : typeof v.reason === 'string' && (v.action === 'setMaintenance' ? typeof v.enabled === 'boolean' : (v.closureAuditId === null || /^[1-9][0-9]{0,19}$/.test(v.closureAuditId)) && (v.action === 'reopenProject' || validPatch && Object.keys(patch).every(key => Object.hasOwn(closureTitles, key)))));
      const validCheck = v && isCheckCommand(v) && ['checked', 'follow_up'].includes(v.conclusion) && typeof v.note === 'string' && (v.action === 'saveCheck' ? typeof v.ruleVersion === 'string' && typeof v.previewWeek === 'string' : /^[1-9][0-9]{0,19}$/.test(v.checkId) && typeof v.reason === 'string');
      const validAction = validCheck || validClosure || validLifecycle || validPlan || validCorrection || v && typeof v.actualDate === 'string' && (v.action === 'startProject' ? ['dueDate', 'configVersion', 'ruleVersion', 'previewWeek', 'previewFirstCheckWeek'].every(key => typeof v[key] === 'string') : /^S[1-7]$/.test(v.stageCode) && ['startStage', 'completeStage'].includes(v.action) && (v.completionNote === undefined || typeof v.completionNote === 'string'));
      if (validAction && /^[1-9][0-9]{0,19}$/.test(v.expectedVersion) && (part === 'draft' || typeof v.idempotencyKey === 'string')) { if (part === 'pending') stagePending = v; else if (part === 'correction' && validCorrection) correctionDraft = v; else if (part === 'plan' && validPlan) planDraft = v; else if (part === 'lifecycle' && validLifecycle) lifecycleDraft = v; else if (part === 'closure' && validClosure) closureDraft = v; else if (part === 'check' && validCheck) checkDraft = v; else if (part === 'draft' && !validCheck && !validClosure && !validPlan && !validLifecycle && !validCorrection) stageDraft = v; }
    }
  } catch { note('动作恢复信息无法读取，请核对当前项目。', true); }
  await load(true); legacyCopy = readBuffer(`geekdash_trial_text_v1:${id}`); await loadCatalog(); if (responsibilityPending) await changeResponsibility(true);
}).catch(error => { note((error as Error).message, true); const link = document.createElement('a'); link.href = '/login.html'; link.textContent = '登录 GeekDash'; element('message').append(' ', link); });
