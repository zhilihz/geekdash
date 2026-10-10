import './shared/detail.css';
import './shared/read.css';
import { get, send, SaveError, esc, label, projectTags, setupTheme, requireIdentity, account, stageMessages, actionLabels, type CorrectionCommand, type CorrectionPreview, type StageCommand, type StartCommand, type ProjectCommand, type CheckRuleContext, type Detail, type Entry, type EditValues, type Catalog, type SaveRequest, type SaveResult, type AuditPage } from './shared/api';

const element = (id: string) => document.getElementById(id)!;
const id = new URLSearchParams(location.search).get('id') ?? '';
let snapshot: Detail | undefined;
let tab = 'info';
let generation = 0;
const titles: Record<keyof EditValues, string> = { name: '项目名称', marketExpectation: '市场预期', detailNote: '详细说明', summaryNote: '摘要说明', statusDesc: '最新状态说明', signalNote: '灯色说明', chipstatNote: '芯片统计备注', signal: '信号灯', priority: '紧急程度', customerId: '客户', odmCustomerId: 'ODM 工厂', productLineId: '产品线', appId: 'APP', groupId: '分组', chipIds: '芯片', tagIds: '项目标签', people: '业务人员', stagePlans: '阶段工期与评述' };
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
type Buffer = { format: 2; baseVersion: string; values: EditValues; pending?: SaveRequest };
let candidate: Buffer | undefined;
let legacyCopy: Buffer | undefined;
let bufferKey = '';
let stagePending: ProjectCommand | undefined;
let stageDraft: Omit<StageCommand, 'idempotencyKey'> | Omit<StartCommand, 'idempotencyKey'> | undefined;
let correctionDraft: CorrectionCommand | undefined;
declare const __GEEKDASH_STAGES__: { id: number; name: string; standard: string; progress: number; mid: number; milestone: string; hw: string; sw: string; biz: string }[];
const stageKey = () => `geekdash_stage_action:${account!.id}:${id}`;
function persistStage() {
  try {
    if (stagePending || stageDraft || correctionDraft) sessionStorage.setItem(stageKey(), JSON.stringify({ pending: stagePending, draft: stageDraft, correction: correctionDraft }));
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
    const cls = stage.state === 'completed' ? 'stage-done' : p.status === 'closed' ? 'stage-closed' : stage.state === 'active' ? 'stage-current' : 'stage-todo';
    const action = stage.state === 'active' ? 'completeStage' : 'startStage';
    const blocked = action === 'startStage' ? item.startBlocked : item.completeBlocked;
    const button = `<button type="button" class="choice-btn choice-done" data-stage="${stage.code}" data-stage-action="${action}"${blocked ? ' disabled' : ''}>${action === 'startStage' ? '开始阶段' : '✅ 里程碑完成'}</button>`;
    return `<div class="stage-card ${cls}"><div class="stage-head"><span class="stage-idx">${esc(stage.code)}</span><span class="stage-name">${esc(s.name)}（${esc(label(stage.state))}）</span><span class="stage-progress">进度 ${s.progress}%</span></div>
      <div class="stage-milestone"><span class="m-label">里程碑：</span>${esc(s.milestone)}</div>
      <details class="stage-lines"><summary>三线工作要点</summary><div class="line"><b>硬件</b>：${esc(s.hw)}</div><div class="line"><b>固件</b>：${esc(s.sw)}</div><div class="line"><b>业务</b>：${esc(s.biz)}</div></details>
      <div class="stage-days">预期天数 <input data-edit data-stage-plan="${stage.code}" type="number" min="0" max="65535" step="1" class="stage-days-input" aria-label="${esc(s.name)}预期天数" value="${esc(stage.plannedDays ?? '')}" placeholder="建议 ${s.mid} 天"${snapshot!.capabilities.editText ? '' : ' readonly'}>（标准 ${esc(s.standard)} / 建议 ${s.mid} 天）</div>
      <div class="stage-note-view">实际开始：${esc(stage.startedOn ?? '—')} · 实际完成：${esc(stage.completedOn ?? '—')} · 预期完成：${esc(stage.expectedEndOn ?? '—')}</div>
      <label class="stage-note-view">评述<textarea data-edit data-stage-note="${stage.code}" class="choice-note" aria-label="${esc(s.name)}评述"${snapshot!.capabilities.editText ? '' : ' readonly'}>${esc(stage.note ?? '')}</textarea></label>
      ${stage.state === 'completed' ? `<div class="stage-done-tag">✅ 里程碑已完成${stage.completedOn ? ' · ' + esc(stage.completedOn) : ''}</div><button type="button" class="choice-btn stage-rollback" data-correction="rollbackStage" data-stage="${stage.code}"${['proposal', 'ongoing'].includes(p.status) ? '' : ' disabled'}>回退到此阶段</button>` : p.status === 'closed' ? '<div class="stage-locked">⏹ 项目已结案</div>' : stage.state === 'locked' ? `<div class="stage-locked">🔒 ${esc(stageMessages[blocked ?? 'STAGE_PREDECESSOR_INCOMPLETE'])}</div>` : `<div class="stage-choice">${button}<button type="button" class="choice-btn choice-close" disabled title="结案功能暂不可用">⏹ 中途结案</button></div>${blocked ? `<div class="stage-locked">${esc(stageMessages[blocked] ?? blocked)}</div>` : ''}`}
      ${p.status !== 'closed' && ['active', 'completed'].includes(String(stage.state)) ? `<button type="button" class="choice-btn" data-correction="${stage.state === 'active' ? 'undoStageStart' : 'undoStageComplete'}" data-stage="${stage.code}">${stage.state === 'active' ? '撤销误开始' : '撤销误完成'}</button>` : ''}
      <div class="stage-choice-form" id="stage-form-${stage.code}"></div></div>`;
  }).join('');
  const start = p.status === 'proposal' ? `<div class="stage-card"><div class="stage-head"><span class="stage-name">正式启动项目</span></div><p>S1完成后，核对实际启动日期和预计结案日期，明确保存。启动后S2仍为待开始。</p><button class="choice-btn choice-done" id="project-start"${snapshot!.startBlocked ? ' disabled' : ''}>启动项目</button>${snapshot!.startBlocked ? `<p class="stage-locked">${esc(stageMessages[snapshot!.startBlocked] ?? snapshot!.startBlocked)}</p>` : ''}<a class="back-btn" href="/settings.html">查看公共检查规则</a><div class="stage-choice-form" id="project-start-form"></div></div>` : `<div class="stages-hint">首次应检周：${esc(p.firstCheckWeek ?? '依据未知，待核对')} · 本周截止：${esc(snapshot!.checkRule.deadlineDate ?? '规则未初始化')}</div>`;
  return `<div class="stages-wrap">${maxDays !== null && totalDays > maxDays ? `<div class="stages-error">⚠ ${estimated ? '参考工期' : '项目总工期'} <b>${totalDays}</b> 天，超过可用窗口 <b>${maxDays}</b> 天，请核对工期或项目日期。</div>` : ''}<div class="stages-hint">按顺序推进：开始和里程碑完成都需明确保存，完成后只解锁下一阶段。工期与评述统一保存项目；纠错和真实返工分别预览、明确保存。</div>${snapshot!.capabilities.editText ? `<button class="back-btn" data-correction="correctStageFacts">纠正实际日期</button><p id="edit-state" role="status"></p><p id="storage-warning" class="field-error"></p><p id="error-stagePlans" class="field-error">${esc(validationErrors.stagePlans)}</p><div class="edit-actions"><button class="back-btn" id="save">保存项目</button><button class="back-btn" id="discard">放弃当前编辑</button>${pending ? '<button class="back-btn" id="confirm">确认原保存结果</button><button class="back-btn" id="retry">重试原操作</button>' : ''}</div>` : ''}<div id="correction-form"></div>${correctionDraft && !stagePending ? '<button class="back-btn" id="correction-restore">恢复纠错/回退表单</button><button class="back-btn" id="correction-discard">放弃纠错/回退副本</button>' : ''}${start}<div class="stages-total">${estimated ? '参考总工期' : '项目总工期'}：<b>${totalDays}</b> 天（已完成 <b>${doneCount}</b> / 7 个阶段）${estimated ? ' · 未填工期按建议值估算，不写入项目' : ''}${maxDays !== null ? ` · 可用窗口：<b>${maxDays}</b> 天` : ''}</div>${cards}</div>`
    + (stagePending ? '<p role="status">阶段操作结果待确认。请确认原结果或重试原操作。</p><button class="back-btn" id="stage-confirm">确认原阶段结果</button> <button class="back-btn" id="stage-retry">重试原阶段操作</button>' : '')
    + (stageDraft && !stagePending ? `<button class="back-btn" id="stage-restore">恢复本标签页${stageDraft.action === 'startProject' ? '启动' : '阶段'}表单</button> <button class="back-btn" id="stage-discard">放弃动作表单副本</button>` : '');
}
async function prepareAction(action: ProjectCommand['action'], code?: string) {
  if (!snapshot || inFlight || pending || responsibilityPending || stagePending || stale || authFrozen || loading) return false;
  if (dirty()) {
    const choice = await choose('阶段动作前请处理未保存内容。', [['cancel', '继续编辑'], ['save', '保存项目后继续'], ['discard', '放弃编辑后继续']]);
    if (choice === 'cancel') return false;
    if (choice === 'save') { await saveNew(); if (dirty() || pending || stale || authFrozen) return false; }
    else { values = baseline(); candidate = undefined; persist(); render(); }
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
  return true;
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
  const original = stagePending; inFlight = true; render();
  let result: { projectId: string; operationId: string; savedVersion: string } | undefined;
  try {
    const response = await send<{ outcome: string; result?: typeof result }>(`/api/projects/${id}/${confirm ? 'action-results/query' : 'actions'}`, 'POST', original, !confirm);
    if (response.outcome === 'committed' && response.result) {
      if (response.result.projectId !== id || response.result.operationId !== original.idempotencyKey) throw new SaveError('RESPONSE_UNKNOWN', 'unknown');
      result = response.result; stagePending = undefined; stageDraft = undefined; correctionDraft = undefined; persistStage();
    } else note('暂未查到阶段回执，结果仍待确认。请重试原操作，不要另造编号。', true);
  } catch (error) {
    const failure = error instanceof SaveError ? error : new SaveError('TRANSPORT_UNKNOWN', 'unknown');
    if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes(failure.code)) authFrozen = true;
    if (failure.code === 'PROJECT_VERSION_CONFLICT') stale = true;
    if (failure.outcome === 'not_committed' && failure.code !== 'OPERATION_KEY_REUSED') stagePending = undefined;
    note(Object.values(failure.fields ?? {})[0] ?? failure.message, true); persistStage();
  } finally { inFlight = false; render(); }
  if (result) {
    observedVersion = result.savedVersion;
    const refreshed = await load();
    if (!refreshed) stale = true;
    note(`${actionLabels[original.action]}已确认保存，版本${result.savedVersion}。${refreshed ? original.action === 'startProject' ? 'S2仍待开始，请单独保存开始阶段。' : original.action === 'completeStage' && original.stageCode === 'S1' ? '下一步需明确启动项目，项目仍为提案中。' : '' : '后续刷新失败，请重新进入查看；无需再次保存。'}`, !refreshed);
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
      if (choice === 'keep') { persist(); candidate = { format: 2, baseVersion: editBaseVersion, values: structuredClone(values!) }; }
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
function note(text: string, error = false) { element('message').textContent = text; element('message').classList.toggle('error', error); }
function baseline(): EditValues {
  const p = snapshot!.project;
  return { ...Object.fromEntries(keys.map(key => [key, p[key]])), chipIds: p.chips.map(item => item.id), tagIds: p.tags.map(item => item.id), people: p.people.map(({ id, role }) => ({ id, role })), stagePlans: snapshot!.stages.map(stage => ({ code: String(stage.code), plannedDays: stage.plannedDays == null ? null : Number(stage.plannedDays), note: String(stage.note ?? '') })) } as EditValues;
}
function changes() { const base = baseline(); return Object.fromEntries(keys.filter(key => JSON.stringify(values![key]) !== JSON.stringify(base[key])).map(key => [key, values![key]])) as Partial<EditValues>; }
function dirty() { return !!values && !!snapshot && Object.keys(changes()).length > 0; }
function controls() {
  responsibilityControls();
  const frozen = inFlight || !!pending || !!responsibilityPending || !!stagePending || loading;
  const actionOpen = !!document.querySelector('#stage-form, #start-form, #correction-edit');
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-edit]').forEach(input => { input.disabled = frozen || actionOpen || stale || authFrozen || input.dataset.reference === 'true' && !catalog; });
  const save = document.getElementById('save') as HTMLButtonElement | null;
  if (save) save.disabled = frozen || stale || authFrozen || !dirty();
  const discard = document.getElementById('discard') as HTMLButtonElement | null;
  if (discard) discard.disabled = frozen || !dirty();
  for (const action of ['confirm', 'retry']) { const button = document.getElementById(action) as HTMLButtonElement | null; if (button) button.disabled = inFlight; }
  (element('reload') as HTMLButtonElement).disabled = frozen;
  document.querySelectorAll<HTMLButtonElement>('[data-stage-action]').forEach(button => { const item = snapshot?.stageActions.find(item => item.code === button.dataset.stage); const blocked = button.dataset.stageAction === 'startStage' ? item?.startBlocked : item?.completeBlocked; button.disabled = frozen || stale || authFrozen || !item || !!blocked; });
  const startButton = document.getElementById('project-start') as HTMLButtonElement | null; if (startButton) startButton.disabled = frozen || stale || authFrozen || !!snapshot?.startBlocked;
  document.querySelectorAll<HTMLButtonElement>('[data-correction]').forEach(button => { const status = snapshot!.project.status; button.disabled = frozen || stale || authFrozen || !snapshot?.capabilities.editText || button.dataset.correction === 'rollbackStage' && !['proposal', 'ongoing'].includes(status) || button.dataset.correction !== 'correctStageFacts' && status === 'closed'; });
  const correctionSave = document.getElementById('correction-save') as HTMLButtonElement | null; if (correctionSave && (frozen || stale || authFrozen)) correctionSave.disabled = true;
  for (const name of ['stage-confirm', 'stage-retry']) { const button = document.getElementById(name) as HTMLButtonElement | null; if (button) button.disabled = inFlight || loading || authFrozen; }
  element('copy').hidden = !dirty() && !candidate && !legacyCopy && !pending && !stageDraft && !stagePending && !correctionDraft;
  const state = document.getElementById('edit-state');
  if (state) state.textContent = stagePending ? '阶段操作结果待确认，请打开项目阶段确认原结果。' : pending ? inFlight ? '正在处理原操作，请等待…' : '原操作结果尚未确认，请确认结果或重试原操作。' : stale ? '项目已被他人更新，请重新进入项目。旧文字已保留供复制。' : dirty() ? '项目尚未保存' : '与进入版本一致';
  const warning = document.getElementById('storage-warning');
  if (warning) warning.textContent = storageFailed ? dirty() || pending ? '本标签页恢复存储不可用，未保存文字仅留在内存。请及时复制。' : '本标签页恢复存储不可用；已确认保存的数据以服务器为准。' : '';
}
function persist() {
  clearTimeout(bufferTimer);
  if (!snapshot || !values) return;
  try {
    if (pending || dirty()) sessionStorage.setItem(bufferKey, JSON.stringify({ format: 2, baseVersion: pending?.expectedVersion ?? editBaseVersion, values, pending }));
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
      if (key === 'stagePlans') return value === undefined || Array.isArray(value) && value.length === 7 && value.every(item => /^S[1-7]$/.test(item.code) && (item.plannedDays === null || typeof item.plannedDays === 'number') && typeof item.note === 'string');
      if (key === 'people') return Array.isArray(value) && value.every(person => typeof person?.id === 'string' && /^[1-9][0-9]{0,19}$/.test(person.id) && roles.includes(person.role));
      if (key === 'chipIds' || key === 'tagIds') return Array.isArray(value) && value.every(id => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id));
      if (key.endsWith('Id')) return value === null || typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
      return typeof value === 'string';
    };
    if ([1, 2].includes(parsed?.format) && typeof parsed.baseVersion === 'string' && /^[1-9][0-9]{0,19}$/.test(parsed.baseVersion) && parsed.values && (parsed.format === 1 ? textKeys.slice(0, 4).every(key => typeof parsed.values[key] === 'string') : keys.every(key => valid(key, parsed.values[key])))) {
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
  const stageCopy = stagePending ?? stageDraft ?? correctionDraft;
  const text = (stageCopy ? 'reason' in stageCopy ? `${actionLabels[stageCopy.action]}副本\n原因：${stageCopy.reason}\n进入版本：${stageCopy.expectedVersion}\n${stageCopy.action === 'correctStageFacts' ? JSON.stringify(stageCopy.changes) : label(stageCopy.stageCode) + (stageCopy.undoStart ? '（开始也误记）' : '')}\n\n` : stageCopy.action === 'startProject' ? `启动项目副本\n实际启动：${stageCopy.actualDate}\n预计结案：${stageCopy.dueDate}\n调整原因：${stageCopy.planReason ?? ''}\n首次应检周：${stageCopy.previewFirstCheckWeek}\n进入版本：${stageCopy.expectedVersion}\n\n` : `阶段操作副本\n${label(stageCopy.stageCode)} · ${stageCopy.action === 'startStage' ? '开始' : '完成'}\n实际日期：${stageCopy.actualDate}\n说明：${stageCopy.completionNote ?? ''}\n进入版本：${stageCopy.expectedVersion}\n\n` : '') + keys.map(key => `${titles[key]}\n${showValue(key, values?.[key])}`).join('\n\n') + (candidate ? '\n\n——恢复候选副本——\n' + keys.map(key => `${titles[key]}\n${showValue(key, candidate!.values[key])}`).join('\n\n') : '') + (legacyCopy ? '\n\n——旧匿名试用副本（仅供核对）——\n' + keys.map(key => `${titles[key]}\n${showValue(key, legacyCopy!.values[key])}`).join('\n\n') : '');
  await choose('以下文字可选择后复制；复制不会保存项目。', [['cancel', '关闭']], `<textarea class="copy-text" readonly aria-label="未保存文字">${esc(text)}</textarea>`);
}
function editor() {
  const field = (key: keyof EditValues, input: string) => `<div class="field"><label class="read-label" for="edit-${key}">${titles[key]}</label>${input}<span class="field-error" id="error-${key}">${esc(validationErrors[key])}</span></div>`;
  const simple = (key: 'signal' | 'priority', choices: string[]) => field(key, `<select data-edit id="edit-${key}">${choices.map(value => `<option value="${value}"${values![key] === value ? ' selected' : ''}>${label(value)}</option>`).join('')}</select>`);
  const selects = Object.entries(referenceFields).filter(([key]) => key !== 'people').map(([key, table]) => field(key as keyof EditValues, selectReference(key, table)));
  const people = `<div class="field"><span class="read-label">业务人员（不代表账号负责范围）</span>${roles.map(role => `<label class="read-label" for="edit-people-${role}">${label(role)}</label>${selectReference('people', 'engineers', role)}`).join('')}<span class="field-error" id="error-people">${esc(validationErrors.people)}</span></div>`;
  return `<section class="trial-editor" aria-label="测试项目普通编辑"><h2>普通信息编辑</h2><p class="read-message">文字、选择和关联统一点击保存。芯片/标签/业务人员可多选；停用的原引用可保留或移除。</p><div class="field-grid">${textKeys.map(key => field(key, key === 'name' ? `<input data-edit id="edit-${key}" value="${esc(values![key])}" autocomplete="off">` : `<textarea data-edit id="edit-${key}" rows="3">${esc(values![key])}</textarea>`)).join('')}${simple('signal', ['green', 'yellow', 'red'])}${simple('priority', ['high', 'mid', 'low'])}${selects.join('')}${people}</div><p class="read-message">${esc(catalogMessage)}</p>${!catalog ? '<button class="back-btn" id="options-retry">重新读取候选资料</button>' : ''}<p id="edit-state" role="status"></p><p id="storage-warning" class="field-error"></p><div class="edit-actions"><button class="back-btn" id="save">保存项目</button><button class="back-btn" id="discard">放弃当前编辑</button>${pending ? '<button class="back-btn" id="confirm">确认原保存结果</button><button class="back-btn" id="retry">重试原操作</button>' : ''}</div></section>`;
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
  if (key === 'stageChanges' && Array.isArray(value)) return value.map(item => `${label(item.code)}：${label(item.state)}；开始 ${item.startedOn ?? '未知'}；完成 ${item.completedOn ?? '未知'}`).join('\n');
  if (key === 'stagePlans' && Array.isArray(value)) return value.map(item => `${label(item.code)}：工期 ${item.plannedDays ?? '未定'}；评述 ${item.note ?? ''}`).join('\n');
  if (Array.isArray(value)) return value.map(item => showValue(key, item)).join('\n');
  if (typeof value === 'object') { const item = value as { id?: string; name?: string; role?: string }; const name = Object.hasOwn(referenceFields, key) ? catalog?.[referenceFields[key as keyof typeof referenceFields]]?.find(row => row.id === item.id)?.name : undefined; return `${item.name ?? name ?? item.id ?? ''}${item.id ? ' [ID ' + item.id + ']' : ''}${item.role ? ' · ' + label(item.role) : ''}`; }
  if (Object.hasOwn(referenceFields, key)) {
    const item = catalog?.[referenceFields[key as keyof typeof referenceFields]]?.find(item => item.id === value);
    return `${item?.name ?? value} [ID ${value}]`;
  }
  return ['signal', 'priority', 'status'].includes(key) ? label(value) : String(value);
}
async function loadCatalog() {
  if (catalogLoading) return;
  catalogLoading = true; catalogMessage = '正在读取候选资料…'; if (snapshot) render();
  try { catalog = await get<Catalog>('/api/project-options'); catalogMessage = ''; }
  catch (error) { catalogMessage = (error as Error).message + ' 原编辑已保留，可重新读取候选资料。'; }
  finally { catalogLoading = false; if (snapshot) render(); }
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
    if (input) input.oninput = () => { values![key] = input.value; delete validationErrors[key]; element('error-' + key).textContent = ''; clearTimeout(bufferTimer); bufferTimer = setTimeout(persist, 300); controls(); };
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
  const discard = document.getElementById('discard'); if (discard) discard.onclick = async () => { if (await choose('明确放弃当前未保存文字？', [['cancel', '继续编辑'], ['discard', '放弃编辑']]) === 'discard') { values = baseline(); persist(); render(); } };
  const confirm = document.getElementById('confirm'); if (confirm) confirm.onclick = () => { void execute(true); };
  const retry = document.getElementById('retry'); if (retry) retry.onclick = () => { void execute(false); };
  controls();
}
function fieldErrors(errors: Record<string, string>) {
  validationErrors = errors; tab = errors.stagePlans ? 'stages' : 'info'; render();
  for (const [key, error] of Object.entries(errors)) { const target = document.getElementById('error-' + key); if (target) target.textContent = error; }
  document.getElementById('edit-' + Object.keys(errors)[0])?.focus();
}
async function saveNew() {
  if (!snapshot?.capabilities.editText || !values || stale || pending || stagePending || inFlight || loading || !dirty()) return;
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
      const merged = { ...baseline(), ...result.values };
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
        if ('stagePlans' in result.values) for (const plan of merged.stagePlans ?? []) Object.assign(snapshot!.stages.find(stage => stage.code === plan.code)!, plan);
      }
      values = merged; editBaseVersion = result.savedVersion; pending = undefined; stale = higher;
      candidate = undefined;
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
async function observe(afterSave = false) {
  const entry = snapshot;
  if (!entry) return;
  const token = generation;
  try {
    const current = await get<Detail>('/api/projects/' + id, undefined, !afterSave);
    if (token !== generation || snapshot !== entry) return;
    if (BigInt(current.project.version) > BigInt(observedVersion)) observedVersion = current.project.version;
    if (BigInt(observedVersion) > BigInt(entry.project.version)) { stale = true; note('项目已被他人更新，请重新进入项目。未保存文字已保留供复制。', true); controls(); }
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
  if (token === auditGeneration && tab === 'history') render();
}
setupTheme();
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
  const p = snapshot.project;
  element('notice').textContent = snapshot.capabilities.editText ? '本人负责项目：普通文字、灯色、紧急程度和资料关联点击“保存项目”后生效，历史记录实际账号。页面保持进入版本。' : '当前项目只能查看。保存加入本人负责范围后可编辑；重新进入读取最新版。';
  element('d-title').textContent = p.name;
  element('d-tags').innerHTML = projectTags(p);
  element('d-meta').textContent = `客户：${p.customer ?? '—'} · 产品线：${p.productLine ?? '—'} · 核心芯片：${p.chips.map(chip => chip.name).join(' / ') || '—'} · 项目版本：${p.version}`;
  let content = '';
  if (tab === 'info') {
    const values: [string, unknown][] = [['项目名称', p.name], ['客户', p.customer], ['产品线', p.productLine], ['ODM 工厂', p.odmFactory], ['APP', p.app], ['分组', p.projectGroup], ['项目标签', p.tags.map(tag => tag.name).join(' / ')], ['项目状态', label(p.status)], ['优先级', label(p.priority)], ['信号灯', label(p.signal)], ['灯色说明', p.signalNote], ['提案日期', p.proposalDate], ['立案日期', p.filingDate], ['启动日期', p.startDate], ['原计划结案日期', p.originalDueDate], ['当前计划结案日期', p.dueDate], ['结案日期', p.closedOn], ['结案类型', p.closureType ? label(p.closureType) : '—'], ['市场预期', p.marketExpectation], ['最新状态', p.statusDesc], ['项目备注', p.detailNote], ['汇总备注', p.summaryNote], ['芯片统计备注', p.chipstatNote], ['结案说明', p.closureNote], ['剩余工作', p.remainingWorkNote], ['阶段进度', `${p.progress}%`]];
    values.push(['更新时间（UTC）', p.updatedAt]);
    for (const role of ['hardware_owner', 'software_owner', 'pm', 'participant']) values.push([label(role), p.people.filter(person => person.role === role).map(person => person.name).join(' / ')]);
    content = (snapshot.capabilities.editText ? editor() : '') + `<div class="field-grid">${values.filter(([title]) => !snapshot!.capabilities.editText || ![...Object.values(titles), '项目备注', '汇总备注', '最新状态', '优先级', ...roles.map(label)].includes(title)).map(([title, value]) => `<div class="field"><span class="read-label">${title}</span><div class="read-value">${esc(value === '' || value == null ? '—' : value)}</div></div>`).join('')}</div>`;
  } else if (tab === 'stages') content = stagePanel();
  else if (tab === 'nodes' || tab === 'custnodes') content = table(snapshot.nodes.filter(node => node.kind === (tab === 'nodes' ? 'project' : 'customer')), [['title', '节点'], ['stage', '阶段'], ['targetDate', '目标日期'], ['completedOn', '完成日期'], ['output', '成果'], ['note', '说明']]);
  else if (tab === 'history') content = '<h2>服务器修改历史</h2><p class="read-message">时间为 UTC，每页 20 条。只有实际变化才产生修改历史。</p>'
    + (audit?.items.length ? audit.items.map(item => `<article class="audit-entry"><h3>${esc(actionLabels[item.action] ?? item.action)} · ${esc(item.actorDisplayName)} · ${esc(item.createdAt)} · 版本 ${esc(item.versionBefore)} → ${esc(item.versionAfter)}</h3>${Object.keys(item.afterValues).map(key => `<div><strong>${esc(titles[key as keyof EditValues] ?? ({ stageChanges: '阶段状态与实际日期', completionNote: '完成说明', reason: '操作原因', progress: '有效阶段进度', status: '项目状态', startDate: '实际启动日期', dueDate: '当前计划结案日期', originalDueDate: '原计划结案日期', firstCheckWeek: '首次应检周', firstCheckRuleVersion: '首次应检规则版本' } as Record<string, string>)[key] ?? key)}</strong><div class="audit-diff"><div><span class="read-label">修改前</span><div class="read-value">${esc(showValue(key, item.beforeValues?.[key]))}</div></div><div><span class="read-label">修改后</span><div class="read-value">${esc(showValue(key, item.afterValues[key]))}</div></div></div></div>`).join('')}</article>`).join('') : '<p>暂无服务器修改历史。</p>')
    + `<p class="read-message">${esc(auditMessage)}</p><button class="back-btn" id="audit-refresh">重新读取历史</button>${audit?.nextCursor ? '<button class="back-btn" id="audit-more">读取更早记录</button>' : ''}`
    + '<h2>旧来源历史</h2><p class="read-message">保留原来源时间文本，与服务器修改历史分开。</p>' + table(snapshot.history.slice().reverse(), [['date', '来源时间'], ['text', '更新内容']]);
  else if (tab === 'risk') content = '<h2>风险</h2>' + table(snapshot.risks.map(risk => ({ ...risk, resolved: risk.resolved ? '已解决' : '未解决' })), [['content', '风险内容'], ['level', '级别'], ['resolved', '状态'], ['resolution', '解决说明']]) + '<h2>需求变更</h2>' + table(snapshot.changes, [['source', '来源'], ['content', '内容'], ['decision', '结论'], ['reason', '原因']]) + '<h2>改期与说明</h2>' + table(snapshot.delays, [['oldDate', '原日期'], ['newDate', '新日期'], ['reason', '原因'], ['measures', '措施']]);
  element('detail-body').innerHTML = content;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  bindEditor();
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
    values = baseline(); editBaseVersion = data.project.version; observedVersion = data.project.version; stale = false; validationErrors = {};
    audit = undefined; auditMessage = ''; auditGeneration++;
    element('detail-panel').hidden = false;
    render();
    element('message').textContent = '';
    if (initial) {
      if (stagePending) { tab = 'stages'; render(); await executeStage(true); }
      candidate = readBuffer();
      if (candidate?.pending && data.capabilities.editText) {
        values = { ...candidate.values }; editBaseVersion = candidate.baseVersion; pending = candidate.pending; candidate = undefined; render(); await execute(true);
      } else if (candidate) {
        if (candidate.baseVersion === data.project.version && data.capabilities.editText) {
          if (await choose('发现本标签页未保存文字，是否恢复？恢复后仍需明确保存。', [['restore', '恢复编辑'], ['cancel', '暂不恢复']]) === 'restore') { values = { ...candidate.values }; candidate = undefined; render(); persist(); }
        } else { note('旧副本的项目版本已过期或当前项目只读，旧文字仅供复制核对。', true); controls(); }
      }
    }
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
    if (choice === 'keep') { persist(); candidate = { format: 2, baseVersion: editBaseVersion, values: structuredClone(values!) }; }
    else { candidate = undefined; try { sessionStorage.removeItem(bufferKey); } catch { storageFailed = true; } }
  }
  await load();
};
element('back').onclick = async event => {
  if (!dirty() && !pending && !stagePending && !stageDraft && !correctionDraft) return;
  event.preventDefault(); persist();
  const choice = await choose(pending || stagePending ? '原保存结果尚未确认，离开会保留原操作恢复信息。' : '项目尚未保存，如何返回列表？', [['cancel', '继续编辑'], ['keep', '保留本标签页副本并离开'], ...(!pending && !stagePending ? [['discard', '放弃编辑并离开'] as [string, string]] : [])]);
  if (choice === 'cancel') return;
  if (choice === 'discard') { candidate = undefined; stageDraft = undefined; correctionDraft = undefined; persistStage(); try { sessionStorage.removeItem(bufferKey); } catch { storageFailed = true; } }
  leaving = true;
  location.href = (element('back') as HTMLAnchorElement).href;
};
element('copy').onclick = () => { void copyText(); };
window.addEventListener('focus', () => { void observe(); });
window.addEventListener('beforeunload', event => { if (!leaving && (dirty() || pending || stagePending || stageDraft || correctionDraft)) { persist(); event.preventDefault(); } });
document.addEventListener('geekdash-identity-changed', () => { persist(); authFrozen = true; note('账号已变化。请复制未保存内容，重新登录原账号后再进入。', true); controls(); });
void requireIdentity().then(async () => {
  bufferKey = `geekdash_project_buffer:${account!.id}:${id}`;
  // 匿名副本不归属任一账号；只提示保留供核对，不自动作为实名编辑恢复。
  if (sessionStorage.getItem(`geekdash_trial_text_v1:${id}`)) note('发现旧试用副本，请保留原标签页内容供核对；新编辑按当前账号隔离。');
  try { responsibilityPending = JSON.parse(sessionStorage.getItem(responsibilityKey()) ?? 'null') ?? undefined; } catch { note('责任变更恢复信息损坏，请先核对当前负责人。', true); }
  try {
    const saved = JSON.parse(sessionStorage.getItem(stageKey()) ?? 'null');
    for (const part of ['pending', 'draft', 'correction'] as const) {
      const v = saved?.[part];
      const validCorrection = v && typeof v.reason === 'string' && (v.action === 'correctStageFacts' ? Array.isArray(v.changes) && v.changes.every((item: { code: string }) => /^S[1-7]$/.test(item.code)) : ['undoStageStart', 'undoStageComplete', 'rollbackStage'].includes(v.action) && /^S[1-7]$/.test(v.stageCode));
      const validAction = validCorrection || v && typeof v.actualDate === 'string' && (v.action === 'startProject' ? ['dueDate', 'configVersion', 'ruleVersion', 'previewWeek', 'previewFirstCheckWeek'].every(key => typeof v[key] === 'string') : /^S[1-7]$/.test(v.stageCode) && ['startStage', 'completeStage'].includes(v.action) && (v.completionNote === undefined || typeof v.completionNote === 'string'));
      if (validAction && /^[1-9][0-9]{0,19}$/.test(v.expectedVersion) && (part === 'draft' || typeof v.idempotencyKey === 'string')) { if (part === 'pending') stagePending = v; else if (part === 'correction' && validCorrection) correctionDraft = v; else stageDraft = v; }
    }
  } catch { note('动作恢复信息无法读取，请核对当前项目。', true); }
  await load(true); legacyCopy = readBuffer(`geekdash_trial_text_v1:${id}`); await loadCatalog(); if (responsibilityPending) await changeResponsibility(true);
}).catch(error => { note((error as Error).message, true); const link = document.createElement('a'); link.href = '/login.html'; link.textContent = '登录 GeekDash'; element('message').append(' ', link); });
