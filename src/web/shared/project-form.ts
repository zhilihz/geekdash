import { esc, label, type Detail, type EditValues, type CatalogItem } from './api';

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
type Reference = (key: string, table: string, role?: string) => string;
type FormDetail = Pick<Detail, 'businessDate' | 'stages' | 'nodes' | 'risks'> & { project: Partial<Detail['project']> & Pick<Detail['project'], 'status' | 'chips' | 'people'> };
export function referenceSelect(key: string, options: CatalogItem[], selected: string[], old: string[] = [], role?: string) {
  const multiple = ['customerIds','odmFactoryIds','productLineIds','appIds','groupIds', 'tagIds', 'people'].includes(key);
  return `<select data-edit data-scope="basic" data-reference="true" id="edit-${key}${role ? '-' + role : ''}-source"${multiple ? ' multiple' : ''}>${multiple ? '' : '<option value="">未选择</option>'}${options.filter(item => item.enabled || old.includes(item.id) || selected.includes(item.id)).map(item => `<option value="${esc(item.id)}"${selected.includes(item.id) ? ' selected' : ''}${!item.enabled && !old.includes(item.id) ? ' disabled' : ''}>${esc(item.name)}${item.originalModel ? ' · ' + esc(item.originalModel) : ''}${item.manufacturer ? ' · ' + esc(item.manufacturer) : ''}${item.enabled ? '' : '（停用/不可新增）'}</option>`).join('')}</select>`;
}
export function basicFields(detail: FormDetail, value: EditValues, draft: BasicIntent, editing: boolean, reference: Reference, errors: Record<string, string>, creating = false) {
  const p = detail.project;
  const read = (value: unknown) => `<div class="field-fact">${esc(value == null || value === '' ? '—' : value)}</div>`;
  const field = (key: string, title: string, content: string, full = false) => `<div class="field${full ? ' field-full' : ''}"><label class="read-label" for="edit-${key}">${title}</label>${content}<span class="field-error" id="error-${key}">${esc(errors[key])}</span></div>`;
  const text = (key: 'name' | 'summary' | 'marketExpectation' | 'detailNote', title: string, full = false) => field(key, title, editing ? key === 'name' ? `<input data-edit data-scope="basic" id="edit-${key}" value="${esc(value[key])}" autocomplete="off">` : `<textarea data-edit data-scope="basic" id="edit-${key}" rows="2">${esc(value[key])}</textarea>` : read(p[key]), full);
  const names = { customerIds: p.customer, productLineIds: p.productLine, odmFactoryIds: p.odmFactory, groupIds: p.projectGroup, appIds: p.app, chipSelections: p.chips.map(item => item.name).join('、'), tagIds: (p.tags ?? []).map(item => item.name).join('、') };
  const ref = (key: keyof typeof names, title: string, table: string) => field(key, title, editing ? reference(key, table) : read(names[key]), key === 'chipSelections');
  const states = p.status === 'closed' ? ['closed', p.preCloseStatus ?? 'ongoing'] : p.status === 'paused' ? ['paused', p.resumeStatus ?? 'ongoing', 'closed'] : p.status === 'proposal' ? ['proposal', 'ongoing', 'paused', 'closed'] : ['ongoing', 'paused', 'closed'];
  const state = field('state', '项目状态', editing && !creating ? `<select data-edit data-scope="basic" data-basic="state" id="edit-state">${states.map(state => `<option value="${state}"${state === draft.state ? ' selected' : ''}>${label(state)}</option>`).join('')}</select>` : read(label(p.status)));
  const date = (key: 'filingDate' | 'startDate' | 'dueDate' | 'closedOn', title: string) => field(key, title, editing && (!creating || key === 'filingDate' || key === 'dueDate') && (key !== 'closedOn' || draft.state === 'closed') ? `<input data-edit data-scope="basic" data-basic="${key}" id="edit-${key}" type="date"${key !== 'dueDate' ? ` max="${detail.businessDate}"` : ''} value="${esc(draft[key])}">` : read(draft[key] || '—'));
  const close = draft.state === 'closed';
  const stateChanged = draft.state !== p.status;
  const planChanged = draft.dueDate !== (p.dueDate ?? '') && !!p.dueDate && !!draft.dueDate;
  const reasonTitle = stateChanged && p.status !== 'closed' && draft.state === 'paused' ? '暂缓原因' : planChanged && draft.planKind === 'reschedule' ? '改期说明' : '';
  const remaining = detail.stages.filter(s => s.state !== 'completed').map(s => label(s.code)).concat(detail.nodes.filter(n => !n.completedOn).map(n => n.title), detail.risks.filter(r => !r.resolved).map(r => r.content));
  const intentFields = !editing || creating ? '' : `<div class="field-full basic-impact" id="basic-impact"${stateChanged || planChanged || close ? '' : ' hidden'}>
    ${planChanged ? `<label>这次日期修改<select data-edit data-scope="basic" data-basic="planKind"><option value="reschedule"${draft.planKind === 'reschedule' ? ' selected' : ''}>实际调整计划</option><option value="correction"${draft.planKind === 'correction' ? ' selected' : ''}>纠正填错的日期</option></select></label>` : ''}
    ${reasonTitle ? `<label>${reasonTitle}<textarea data-edit data-scope="basic" data-basic="reason" id="edit-reason" rows="2">${esc(draft.reason)}</textarea><span id="error-reason" class="field-error">${esc(errors.reason)}</span></label>` : ''}
    ${close ? `<div class="field-grid"><label>结案类型<select data-edit data-scope="basic" data-basic="closureType"><option value="normal"${draft.closureType === 'normal' ? ' selected' : ''}>正常结案</option><option value="terminated"${draft.closureType === 'terminated' ? ' selected' : ''}>中途结案</option></select></label><label>结案说明${draft.closureType === 'normal' && !remaining.length ? '（选填）' : ''}<textarea data-edit data-scope="basic" data-basic="closureNote" id="edit-closureNote">${esc(draft.closureNote)}</textarea><span class="field-error" id="error-closureNote">${esc(errors.closureNote)}</span></label>${remaining.length ? `<p class="read-message field-full">尚未完成：${remaining.map(esc).join('、')}。在结案说明中说明后续处理。</p>` : ''}${p.status === 'closed' ? `<label>结案后维护<select data-edit data-scope="basic" data-basic="maintenance"><option value="false"${!draft.maintenance ? ' selected' : ''}>关闭</option><option value="true"${draft.maintenance ? ' selected' : ''}>开启</option></select></label>` : ''}</div>` : ''}
  </div>`;
  const division = ['hardware_owner', 'software_owner', 'participant'].map(role => field('people-' + role, label(role), editing ? reference('people', 'engineers', role) : read(p.people.filter(person => person.role === role).map(person => person.name).join('、')))).join('');
  return `<div class="field-grid basic-primary">${text('name', '项目名称')}${state}${intentFields}${text('summary', '项目简介', true)}</div><div class="field-grid basic-references">${ref('customerIds', '客户', 'customers')}${ref('productLineIds', '产品线', 'product_lines')}${ref('odmFactoryIds', 'ODM 工厂', 'odmFactories')}${ref('groupIds', '分组', 'project_groups')}${ref('appIds', 'APP', 'apps')}${ref('tagIds', '项目标签', 'tags')}${ref('chipSelections', '核心芯片（可添加多个）', 'chips')}</div><div class="project-key-dates">${date('filingDate', '立案日期')}${date('startDate', '实际启动日期')}${date('dueDate', '预计结案日期')}${date('closedOn', '实际结案日期')}</div><div class="field-grid">${text('marketExpectation', '市场预期')}${field('priority', '优先级', editing ? `<select data-edit data-scope="basic" id="edit-priority">${['high','mid','low'].map(item => `<option value="${item}"${value.priority === item ? ' selected' : ''}>${label(item)}</option>`).join('')}</select>` : read(label(p.priority)))}</div><h3 class="division-heading">项目分工</h3><div class="field-grid basic-references">${creating?'<div class="field field-full" id="responsibility"></div>':''}${division}<span class="field-error field-full" id="error-people">${esc(errors.people)}</span></div>`;
}
