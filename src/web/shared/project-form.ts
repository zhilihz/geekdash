import { esc, label, type Detail, type EditValues, type SaveRequest, type CatalogItem } from './api';

export type BasicIntent = {
  filingDate: string; startDate: string; dueDate: string; closedOn: string; proposalDate: string; originalDueDate: string;
  state: string; planKind: 'reschedule' | 'correction'; reason: string; measures: string;
  closureType: 'normal' | 'terminated'; closureNote: string; remainingWorkNote: string; maintenance: boolean;
  clearDates?: string[];
};
export function basicIntent(detail: Detail): BasicIntent {
  const p = detail.project;
  return { filingDate: String(p.filingDate ?? ''), startDate: String(p.startDate ?? ''), dueDate: p.dueDate ?? '', closedOn: String(p.closedOn ?? ''),
    proposalDate: String(p.proposalDate ?? ''), originalDueDate: String(p.originalDueDate ?? ''), state: p.status, planKind: 'reschedule', reason: '', measures: '',
    closureType: p.closureType === 'terminated' ? 'terminated' : 'normal', closureNote: String(p.closureNote ?? ''), remainingWorkNote: String(p.remainingWorkNote ?? ''), maintenance: !!p.maintenanceEnabled };
}
export function basicIntentChanged(detail: Detail, draft: BasicIntent) {
  const base = basicIntent(detail);
  return Object.keys(base).some(key => !['reason', 'measures', 'planKind'].includes(key) && draft[key as keyof BasicIntent] !== base[key as keyof BasicIntent]);
}
export function basicCommands(detail: Detail, draft: BasicIntent): NonNullable<SaveRequest['commands']> {
  const p = detail.project, base = basicIntent(detail), commands: NonNullable<SaveRequest['commands']> = [];
  const starting = p.status === 'proposal' && draft.state === 'ongoing';
  for (const key of ['filingDate', 'proposalDate', 'originalDueDate', 'startDate', 'dueDate', 'closedOn'] as const) {
    if (base[key] && !draft[key] && !draft.clearDates?.includes(key)) throw new Error('日期已清空，请在该日期下明确勾选“纠正为未知”后保存。');
  }
  const dateChanges: Record<string, string | null> = {};
  for (const key of ['filingDate', 'proposalDate', 'originalDueDate', 'startDate'] as const) {
    if (draft[key] !== base[key] && !(key === 'startDate' && starting)) dateChanges[key] = draft[key] || null;
  }
  const dueChanged = draft.dueDate !== base.dueDate;
  if (dueChanged && !starting) {
    if (draft.planKind === 'correction' || !draft.dueDate) dateChanges.dueDate = draft.dueDate || null;
    else commands.push(p.dueDate ? { action: 'reschedulePlan', dueDate: draft.dueDate, reason: draft.reason, measures: draft.measures } : { action: 'setPlan', dueDate: draft.dueDate });
  }
  if (Object.keys(dateChanges).length) commands.unshift({ action: 'correctProjectDates', changes: dateChanges, reason: draft.reason });
  if (draft.state !== p.status) {
    if (starting) {
      const context = detail.checkRule;
      if (!context.configVersion || !context.rule || !context.firstCheckWeek) throw new Error('检查规则尚未配置，请维护人员先设置检查截止。');
      commands.push({ action: 'startProject', actualDate: draft.startDate, dueDate: draft.dueDate, planReason: draft.reason, configVersion: context.configVersion, ruleVersion: context.rule.version, previewWeek: context.weekStart, previewFirstCheckWeek: context.firstCheckWeek });
    } else if (p.status === 'closed') commands.push({ action: 'reopenProject', closureAuditId: detail.currentClosure?.auditId ?? null, reason: draft.reason });
    else if (draft.state === 'closed') commands.push({ action: 'closeProject', closedOn: draft.closedOn, closureType: draft.closureType, closureNote: draft.closureNote, remainingWorkNote: draft.remainingWorkNote });
    else if (draft.state === 'paused') commands.push({ action: 'pauseProject', reason: draft.reason });
    else commands.push({ action: 'resumeProject', note: draft.reason });
  } else if (p.status === 'closed') {
    const changes: Record<string, string | null> = {};
    for (const key of ['closedOn', 'closureType', 'closureNote', 'remainingWorkNote'] as const) if (draft[key] !== base[key]) changes[key] = draft[key] || null;
    if (Object.keys(changes).length) commands.push({ action: 'correctClosure', closureAuditId: detail.currentClosure?.auditId ?? null, changes, reason: draft.reason });
    if (draft.maintenance !== base.maintenance) commands.push({ action: 'setMaintenance', enabled: draft.maintenance, reason: draft.reason });
  }
  return commands;
}

type Reference = (key: string, table: string, role?: string) => string;
type FormDetail = Pick<Detail, 'businessDate' | 'stages' | 'nodes' | 'risks'> & { project: Partial<Detail['project']> & Pick<Detail['project'], 'status' | 'chips' | 'people'> };
export function referenceSelect(key: string, options: CatalogItem[], selected: string[], old: string[] = [], role?: string) {
  const multiple = ['chipIds', 'tagIds', 'people', 'managerIds'].includes(key);
  return `<select data-edit data-scope="${key === 'tagIds' ? 'tags' : 'basic'}" data-reference="true" id="edit-${key}${role ? '-' + role : ''}-source"${multiple ? ' multiple' : ''}>${multiple ? '' : '<option value="">未选择</option>'}${options.filter(item => item.enabled || old.includes(item.id) || selected.includes(item.id)).map(item => `<option value="${esc(item.id)}"${selected.includes(item.id) ? ' selected' : ''}${!item.enabled && !old.includes(item.id) ? ' disabled' : ''}>${esc(item.name)}${item.originalModel ? ' · ' + esc(item.originalModel) : ''}${item.manufacturer ? ' · ' + esc(item.manufacturer) : ''}${item.enabled ? '' : '（停用/不可新增）'}</option>`).join('')}</select>`;
}
export function basicFields(detail: FormDetail, value: EditValues, draft: BasicIntent, editing: boolean, reference: Reference, errors: Record<string, string>, creating = false) {
  const p = detail.project;
  const read = (value: unknown) => `<div class="field-fact">${esc(value == null || value === '' ? '—' : value)}</div>`;
  const field = (key: string, title: string, content: string, full = false) => `<div class="field${full ? ' field-full' : ''}"><label class="read-label" for="edit-${key}">${title}</label>${content}<span class="field-error" id="error-${key}">${esc(errors[key])}</span></div>`;
  const text = (key: 'name' | 'summary' | 'marketExpectation' | 'detailNote', title: string, full = false) => field(key, title, editing ? key === 'name' ? `<input data-edit data-scope="basic" id="edit-${key}" value="${esc(value[key])}" autocomplete="off">` : `<textarea data-edit data-scope="basic" id="edit-${key}" rows="2">${esc(value[key])}</textarea>` : read(p[key]), full);
  const names = { customerId: p.customer, productLineId: p.productLine, odmCustomerId: p.odmFactory, groupId: p.projectGroup, appId: p.app, chipIds: p.chips.map(item => item.name).join('、') };
  const ref = (key: keyof typeof names, title: string, table: string) => field(key, title, editing ? reference(key, table) : read(names[key]));
  const states = p.status === 'closed' ? ['closed', p.preCloseStatus ?? 'ongoing'] : p.status === 'paused' ? ['paused', p.resumeStatus ?? 'ongoing', 'closed'] : p.status === 'proposal' ? ['proposal', 'ongoing', 'paused', 'closed'] : ['ongoing', 'paused', 'closed'];
  const state = field('state', '项目状态', editing && !creating ? `<select data-edit data-scope="basic" data-basic="state" id="edit-state">${states.map(state => `<option value="${state}"${state === draft.state ? ' selected' : ''}>${label(state)}</option>`).join('')}</select>` : read(label(p.status)));
  const date = (key: 'filingDate' | 'startDate' | 'dueDate' | 'closedOn', title: string) => field(key, title, editing && (!creating || key === 'filingDate' || key === 'dueDate') && (key !== 'closedOn' || draft.state === 'closed') ? `<input data-edit data-scope="basic" data-basic="${key}" id="edit-${key}" type="date"${key !== 'dueDate' ? ` max="${detail.businessDate}"` : ''} value="${esc(draft[key])}">${!creating && p[key] && !draft[key] ? `<label class="date-clear"><input type="checkbox" data-edit data-scope="basic" data-basic-clear="${key}"${draft.clearDates?.includes(key) ? ' checked' : ''}>纠正为${key === 'dueDate' ? '计划未定' : '未知'}</label>` : ''}` : read(draft[key] || '—'));
  const dateChanged = ['filingDate', 'startDate', 'dueDate', 'closedOn'].some(key => draft[key as keyof BasicIntent] !== (p[key] ?? ''));
  const close = draft.state === 'closed';
  const remaining = detail.stages.filter(s => s.state !== 'completed').map(s => label(s.code)).concat(detail.nodes.filter(n => !n.completedOn).map(n => n.title), detail.risks.filter(r => !r.resolved).map(r => r.content));
  const intentFields = !editing || creating ? '' : `<div class="field-full basic-impact" id="basic-impact"${dateChanged || draft.state !== p.status || close ? '' : ' hidden'}>
    ${draft.dueDate !== (p.dueDate ?? '') && p.dueDate && draft.state !== 'ongoing' || draft.dueDate !== (p.dueDate ?? '') && p.dueDate && p.status !== 'proposal' ? `<label>计划变更方式<select data-edit data-scope="basic" data-basic="planKind"><option value="reschedule"${draft.planKind === 'reschedule' ? ' selected' : ''}>实际调整计划</option><option value="correction"${draft.planKind === 'correction' ? ' selected' : ''}>纠正原来填错的日期</option></select></label>` : ''}
    ${dateChanged || draft.state !== p.status || close ? `<label>变更原因<textarea data-edit data-scope="basic" data-basic="reason" id="edit-reason" rows="2">${esc(draft.reason)}</textarea><span id="error-reason" class="field-error">${esc(errors.reason)}</span></label>` : ''}
    ${draft.dueDate !== (p.dueDate ?? '') && draft.planKind === 'reschedule' && p.dueDate ? `<label>应对措施（选填）<textarea data-edit data-scope="basic" data-basic="measures" rows="2">${esc(draft.measures)}</textarea></label>` : ''}
    ${close ? `<div class="field-grid"><label>结案类型<select data-edit data-scope="basic" data-basic="closureType"><option value="normal"${draft.closureType === 'normal' ? ' selected' : ''}>正常结案</option><option value="terminated"${draft.closureType === 'terminated' ? ' selected' : ''}>中途结案</option></select></label><label>结案说明<textarea data-edit data-scope="basic" data-basic="closureNote" id="edit-closureNote">${esc(draft.closureNote)}</textarea><span class="field-error" id="error-closureNote">${esc(errors.closureNote)}</span></label><label class="field-full">遗留事项处置${remaining.length ? `<p class="read-message">尚未完成：${remaining.map(esc).join('、')}</p>` : ''}<textarea data-edit data-scope="basic" data-basic="remainingWorkNote" id="edit-remainingWorkNote">${esc(draft.remainingWorkNote)}</textarea><span class="field-error" id="error-remainingWorkNote">${esc(errors.remainingWorkNote)}</span></label>${p.status === 'closed' ? `<label>结案后维护<select data-edit data-scope="basic" data-basic="maintenance"><option value="false"${!draft.maintenance ? ' selected' : ''}>关闭</option><option value="true"${draft.maintenance ? ' selected' : ''}>开启</option></select></label>` : ''}</div>` : ''}
  </div>`;
  const division = ['hardware_owner', 'software_owner'].map(role => field('people-' + role, label(role), editing ? reference('people', 'engineers', role) : read(p.people.filter(person => person.role === role).map(person => person.name).join('、')))).join('');
  return `<div class="field-grid basic-primary">${text('name', '项目名称')}${state}</div><div class="field-grid basic-references">${ref('customerId', '客户', 'customers')}${ref('productLineId', '产品线', 'product_lines')}${ref('odmCustomerId', 'ODM 工厂', 'customers')}${ref('groupId', '分组', 'project_groups')}${ref('appId', 'APP', 'apps')}${ref('chipIds', '芯片', 'chips')}</div><div class="project-key-dates">${date('filingDate', '立案日期')}${date('startDate', '实际启动日期')}${date('dueDate', '预计结案日期')}${date('closedOn', '实际结案日期')}</div><div class="field-grid">${intentFields}${text('summary', '项目简介')}${text('marketExpectation', '市场预期')}${text('detailNote', '详细说明', true)}${field('priority', '优先级', editing ? `<select data-edit data-scope="basic" id="edit-priority">${['high','mid','low'].map(item => `<option value="${item}"${value.priority === item ? ' selected' : ''}>${label(item)}</option>`).join('')}</select>` : read(label(p.priority)))}${field('people-participant', '参与人员', editing ? reference('people', 'engineers', 'participant') : read(p.people.filter(person => person.role === 'participant').map(person => person.name).join('、')))}</div><h3 class="division-heading">项目分工</h3><div class="field-grid basic-references"><div class="field"><span class="read-label">项目经理</span><div id="responsibility"></div>${p.people.some(person => person.role === 'pm') ? `<small class="read-label">旧资料经理：${esc(p.people.filter(person => person.role === 'pm').map(person => person.name).join('、'))}</small>` : ''}</div>${division}<span class="field-error field-full" id="error-people">${esc(errors.people)}</span></div>`;
}
