import './shared/detail.css';
import './shared/read.css';
import { get, send, SaveError, esc, label, projectTags, setupTheme, type Detail, type Entry, type EditValues, type Catalog, type SaveRequest, type SaveResult, type AuditPage } from './shared/api';

const element = (id: string) => document.getElementById(id)!;
const id = new URLSearchParams(location.search).get('id') ?? '';
let snapshot: Detail | undefined;
let tab = 'info';
let generation = 0;
const titles: Record<keyof EditValues, string> = { name: '项目名称', marketExpectation: '市场预期', detailNote: '详细说明', summaryNote: '摘要说明', statusDesc: '最新状态说明', signalNote: '灯色说明', chipstatNote: '芯片统计备注', signal: '信号灯', priority: '紧急程度', customerId: '客户', odmCustomerId: 'ODM 工厂', productLineId: '产品线', appId: 'APP', groupId: '分组', chipIds: '芯片', tagIds: '项目标签', people: '业务人员' };
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
let pending: SaveRequest | undefined;
let inFlight = false;
let loading = false;
let leaving = false;
let storageFailed = false;
let bufferTimer: ReturnType<typeof setTimeout> | undefined;
type Buffer = { format: 2; baseVersion: string; values: EditValues; pending?: SaveRequest };
let candidate: Buffer | undefined;
const bufferKey = `geekdash_trial_text_v1:${id}`;
let audit: AuditPage | undefined;
let auditGeneration = 0;
let auditMessage = '';
let validationErrors: Record<string, string> = {};
function note(text: string, error = false) { element('message').textContent = text; element('message').classList.toggle('error', error); }
function baseline(): EditValues {
  const p = snapshot!.project;
  return { ...Object.fromEntries(keys.map(key => [key, p[key]])), chipIds: p.chips.map(item => item.id), tagIds: p.tags.map(item => item.id), people: p.people.map(({ id, role }) => ({ id, role })) } as EditValues;
}
function changes() { const base = baseline(); return Object.fromEntries(keys.filter(key => JSON.stringify(values![key]) !== JSON.stringify(base[key])).map(key => [key, values![key]])) as Partial<EditValues>; }
function dirty() { return !!values && !!snapshot && Object.keys(changes()).length > 0; }
function controls() {
  const frozen = inFlight || !!pending || loading;
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-edit]').forEach(input => { input.disabled = frozen || stale || input.dataset.reference === 'true' && !catalog; });
  const save = document.getElementById('save') as HTMLButtonElement | null;
  if (save) save.disabled = frozen || stale || !dirty();
  const discard = document.getElementById('discard') as HTMLButtonElement | null;
  if (discard) discard.disabled = frozen || !dirty();
  for (const action of ['confirm', 'retry']) { const button = document.getElementById(action) as HTMLButtonElement | null; if (button) button.disabled = inFlight; }
  (element('reload') as HTMLButtonElement).disabled = frozen;
  element('copy').hidden = !dirty() && !candidate && !pending;
  const state = document.getElementById('edit-state');
  if (state) state.textContent = pending ? inFlight ? '正在处理原操作，请等待…' : '原操作结果尚未确认，请确认结果或重试原操作。' : stale ? '项目已被他人更新，请重新进入项目。旧文字已保留供复制。' : dirty() ? '项目尚未保存' : '与进入版本一致';
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
function readBuffer() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(bufferKey) ?? 'null');
    const valid = (key: string, value: unknown) => {
      if (!keys.includes(key as keyof EditValues)) return false;
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
  const text = keys.map(key => `${titles[key]}\n${showValue(key, values?.[key])}`).join('\n\n') + (candidate ? '\n\n——恢复候选副本——\n' + keys.map(key => `${titles[key]}\n${showValue(key, candidate!.values[key])}`).join('\n\n') : '');
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
  if (Array.isArray(value)) return value.map(item => showValue(key, item)).join('\n');
  if (typeof value === 'object') { const item = value as { id?: string; name?: string; role?: string }; const name = Object.hasOwn(referenceFields, key) ? catalog?.[referenceFields[key as keyof typeof referenceFields]]?.find(row => row.id === item.id)?.name : undefined; return `${item.name ?? name ?? item.id ?? ''}${item.id ? ' [ID ' + item.id + ']' : ''}${item.role ? ' · ' + label(item.role) : ''}`; }
  if (Object.hasOwn(referenceFields, key)) {
    const item = catalog?.[referenceFields[key as keyof typeof referenceFields]]?.find(item => item.id === value);
    return `${item?.name ?? value} [ID ${value}]`;
  }
  return ['signal', 'priority'].includes(key) ? label(value) : String(value);
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
  validationErrors = errors; tab = 'info'; render();
  for (const [key, error] of Object.entries(errors)) { const target = document.getElementById('error-' + key); if (target) target.textContent = error; }
  document.getElementById('edit-' + Object.keys(errors)[0])?.focus();
}
async function saveNew() {
  if (!snapshot?.capabilities.editText || !values || stale || pending || inFlight || loading || !dirty()) return;
  const errors: Record<string, string> = {};
  if (!values.name.trim() || [...values.name].length > 255 || /[\r\n]/.test(values.name)) errors.name = '名称应为 1～255 个字符，不能仅含空白或换行';
  for (const key of textKeys.slice(1)) if (new TextEncoder().encode(values[key]).length > 65535) errors[key] = '说明超过 65535 字节';
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
    const current = await get<Detail>('/api/projects/' + id);
    if (token !== generation || snapshot !== entry) return;
    if (BigInt(current.project.version) > BigInt(observedVersion)) observedVersion = current.project.version;
    if (BigInt(observedVersion) > BigInt(entry.project.version)) { stale = true; note('项目已被他人更新，请重新进入项目。未保存文字已保留供复制。', true); controls(); }
  } catch { if (afterSave) note('本次保存已确认，后续详情刷新失败。可重新进入查看；无需重复保存。', true); }
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
  element('notice').textContent = snapshot.capabilities.editText ? '合成测试项目：普通文字、灯色、紧急程度和资料关联点击“保存项目”后生效，历史记为未认证操作。页面保持进入版本。' : '当前项目只能查看。页面保持进入时的项目版本，点击重新进入读取最新版。';
  element('d-title').textContent = p.name;
  element('d-tags').innerHTML = projectTags(p);
  element('d-meta').textContent = `客户：${p.customer ?? '—'} · 产品线：${p.productLine ?? '—'} · 核心芯片：${p.chips.map(chip => chip.name).join(' / ') || '—'} · 项目版本：${p.version}`;
  let content = '';
  if (tab === 'info') {
    const values: [string, unknown][] = [['项目名称', p.name], ['客户', p.customer], ['产品线', p.productLine], ['ODM 工厂', p.odmFactory], ['APP', p.app], ['分组', p.projectGroup], ['项目标签', p.tags.map(tag => tag.name).join(' / ')], ['项目状态', label(p.status)], ['优先级', label(p.priority)], ['信号灯', label(p.signal)], ['灯色说明', p.signalNote], ['提案日期', p.proposalDate], ['立案日期', p.filingDate], ['启动日期', p.startDate], ['原计划结案日期', p.originalDueDate], ['当前计划结案日期', p.dueDate], ['结案日期', p.closedOn], ['结案类型', p.closureType ? label(p.closureType) : '—'], ['市场预期', p.marketExpectation], ['最新状态', p.statusDesc], ['项目备注', p.detailNote], ['汇总备注', p.summaryNote], ['芯片统计备注', p.chipstatNote], ['结案说明', p.closureNote], ['剩余工作', p.remainingWorkNote], ['阶段进度', `${p.progress}%`]];
    values.push(['更新时间（UTC）', p.updatedAt]);
    for (const role of ['hardware_owner', 'software_owner', 'pm', 'participant']) values.push([label(role), p.people.filter(person => person.role === role).map(person => person.name).join(' / ')]);
    content = (snapshot.capabilities.editText ? editor() : '') + `<div class="field-grid">${values.filter(([title]) => !snapshot!.capabilities.editText || ![...Object.values(titles), '项目备注', '汇总备注', '最新状态', '优先级', ...roles.map(label)].includes(title)).map(([title, value]) => `<div class="field"><span class="read-label">${title}</span><div class="read-value">${esc(value === '' || value == null ? '—' : value)}</div></div>`).join('')}</div>`;
  } else if (tab === 'stages') content = table(snapshot.stages, [['code', '阶段'], ['state', '状态'], ['plannedDays', '计划天数'], ['startedOn', '实际开始'], ['completedOn', '实际完成'], ['expectedEndOn', '预期完成'], ['note', '说明']]);
  else if (tab === 'nodes' || tab === 'custnodes') content = table(snapshot.nodes.filter(node => node.kind === (tab === 'nodes' ? 'project' : 'customer')), [['title', '节点'], ['stage', '阶段'], ['targetDate', '目标日期'], ['completedOn', '完成日期'], ['output', '成果'], ['note', '说明']]);
  else if (tab === 'history') content = '<h2>服务器修改历史</h2><p class="read-message">时间为 UTC，每页 20 条。只有实际变化才产生修改历史。</p>'
    + (audit?.items.length ? audit.items.map(item => `<article class="audit-entry"><h3>${esc(item.actorDisplayName)} · ${esc(item.createdAt)} · 版本 ${esc(item.versionBefore)} → ${esc(item.versionAfter)}</h3>${Object.keys(item.afterValues).map(key => `<div><strong>${esc(titles[key as keyof EditValues] ?? key)}</strong><div class="audit-diff"><div><span class="read-label">修改前</span><div class="read-value">${esc(showValue(key, item.beforeValues[key]))}</div></div><div><span class="read-label">修改后</span><div class="read-value">${esc(showValue(key, item.afterValues[key]))}</div></div></div></div>`).join('')}</article>`).join('') : '<p>暂无服务器修改历史。</p>')
    + `<p class="read-message">${esc(auditMessage)}</p><button class="back-btn" id="audit-refresh">重新读取历史</button>${audit?.nextCursor ? '<button class="back-btn" id="audit-more">读取更早记录</button>' : ''}`
    + '<h2>旧来源历史</h2><p class="read-message">保留原来源时间文本，与服务器修改历史分开。</p>' + table(snapshot.history.slice().reverse(), [['date', '来源时间'], ['text', '更新内容']]);
  else if (tab === 'risk') content = '<h2>风险</h2>' + table(snapshot.risks.map(risk => ({ ...risk, resolved: risk.resolved ? '已解决' : '未解决' })), [['content', '风险内容'], ['level', '级别'], ['resolved', '状态'], ['resolution', '解决说明']]) + '<h2>需求变更</h2>' + table(snapshot.changes, [['source', '来源'], ['content', '内容'], ['decision', '结论'], ['reason', '原因']]) + '<h2>改期与说明</h2>' + table(snapshot.delays, [['oldDate', '原日期'], ['newDate', '新日期'], ['reason', '原因'], ['measures', '措施']]);
  element('detail-body').innerHTML = content;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  bindEditor();
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
      candidate = readBuffer();
      if (candidate?.pending && data.capabilities.editText) {
        values = { ...candidate.values }; editBaseVersion = candidate.baseVersion; pending = candidate.pending; candidate = undefined; render(); await execute(true);
      } else if (candidate) {
        if (candidate.baseVersion === data.project.version && data.capabilities.editText) {
          if (await choose('发现本标签页未保存文字，是否恢复？恢复后仍需明确保存。', [['restore', '恢复编辑'], ['cancel', '暂不恢复']]) === 'restore') { values = { ...candidate.values }; candidate = undefined; render(); persist(); }
        } else { note('旧副本的项目版本已过期或当前项目只读，旧文字仅供复制核对。', true); controls(); }
      }
    }
  } catch (error) {
    if (current !== generation) return;
    element('message').classList.add('error');
    element('message').textContent = (error as Error).message + (snapshot ? ' 当前仍显示上次进入的项目版本。' : '');
  } finally { if (current === generation) { loading = false; controls(); } }
}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.onclick = () => { persist(); tab = button.dataset.tab!; render(); if (tab === 'history' && !audit) void loadAudit(); });
element('reload').onclick = async () => {
  if (pending || inFlight) return;
  if (dirty()) {
    const choice = await choose('重新进入前请处理未保存文字。保留后可通过复制入口核对，不会自动带入新版本。', [['cancel', '继续编辑'], ['keep', '保留副本并重新进入'], ['discard', '放弃并重新进入']]);
    if (choice === 'cancel') return;
    if (choice === 'keep') { persist(); candidate = { format: 2, baseVersion: editBaseVersion, values: structuredClone(values!) }; }
    else { candidate = undefined; try { sessionStorage.removeItem(bufferKey); } catch { storageFailed = true; } }
  }
  await load();
};
element('back').onclick = async event => {
  if (!dirty() && !pending) return;
  event.preventDefault(); persist();
  const choice = await choose(pending ? '原保存结果尚未确认，离开会保留原操作恢复信息。' : '项目尚未保存，如何返回列表？', [['cancel', '继续编辑'], ['keep', '保留本标签页副本并离开'], ...(!pending ? [['discard', '放弃编辑并离开'] as [string, string]] : [])]);
  if (choice === 'cancel') return;
  if (choice === 'discard') { candidate = undefined; try { sessionStorage.removeItem(bufferKey); } catch { storageFailed = true; } }
  leaving = true;
  location.href = (element('back') as HTMLAnchorElement).href;
};
element('copy').onclick = () => { void copyText(); };
window.addEventListener('focus', () => { void observe(); });
window.addEventListener('beforeunload', event => { if (!leaving && (dirty() || pending)) { persist(); event.preventDefault(); } });
void load(true);
void loadCatalog();
