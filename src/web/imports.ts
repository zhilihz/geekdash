import './shared/board.css';
import './shared/read.css';
import './shared/reference-picker.css';
import './shared/imports.css';
import { account, esc, get, label, requireIdentity, SaveError, send, sendFile, setupTheme, type List } from './shared/api';
import { PersonalPreference } from './shared/personal-state';
import { mountReferencePickers } from './shared/reference-picker';
import { ProjectNotifications } from './shared/notifications';

type Values = Record<string, unknown>;
type Source = { sourceNamespace: string; name: string };
type Difference = { key: string; label: string; before: unknown; after: unknown; selectable: boolean; issues?: Issue[]; status?: 'normal'|'conflict'|'needs_choice'|'keep_online'; defaultSelected?: boolean; baseline?: {source:unknown;saved:unknown}; members?: Difference[] };
type Issue = string | { code?: string; message?: string; key?: string; field?: string; path?: string; requiredKeys?: string[]; cause?: string; consequence?: string };
type Effect = string | { cause?: string; consequence?: string; message?: string; requiredKeys?: string[] };
type Result = { projectId?: string; id?: string; batchId?: string; reused?: boolean; sourceNamespace?: string; name?: string; savedVersion?: string; adoptionId?: string; adoptedCount?: number; notAdoptedCount?: number; changed?: boolean; operationId?: string };
type Outcome = { outcome: string; result?: Result };
type RecordValue = { key: string; kind: string; sourceKey: string | null; targetId?: string | null; values: Values };
type Payload = Values & { fields?: Values; people?: Record<string, string[]>; stages?: Values[]; records?: RecordValue[]; histories?: Record<string, unknown[]>; statusEntries?: { text: string; date: string | null }[]; lastCheckAt?: unknown };
type Item = { id: string; kind: string; reviewVersion: string; basis?: string; referenceBasis: string; sourceKey?: string; payload: Payload; canEdit: boolean; canAdopt: boolean; targetId?: string | null; expectedVersion?: string | null; mode: 'new' | 'existing'; diffs: Difference[]; issues: Issue[]; sourceIssues?: Issue[]; extraSource?: Values; unchanged?: boolean; previousResult?: Result | null; adoptions?: Values[]; candidates?: { id: string; name: string; version: string }[]; name?: string; sourceName?: string; bindingVersion?: string; target?: Values; classification?:'ready'|'unchanged'|'needs_attention'; defaultSelected?:string[]; conflictKeys?:string[]; keptOnline?:boolean;needsMapping?:boolean; unresolvedReferences?:{path:string;itemIds:string[]}[] };
type Batch = { id: string; name: string; sourceNamespace: string; version: string; handlerId: string; handlerName: string; handlerEnabled: boolean; canTakeover: boolean; canEdit: boolean; uploaderName?: string; filename?: string; uploadedAt?: string };
type BatchData = { batch: Batch; counts: { total: number; pending: number; processed: number; unchanged: number }; catalogRows: Item[]; items: Item[]; sources: Source[] };
type BatchBrief = Partial<Batch> & { id: string; name: string; fileHash?: string; filename?: string; pending?: number; processed?: number; total?: number; createdAt?: string };
type Command = { expectedBatchVersion: string; expectedReviewVersion: string; expectedVersion: string | null; basis?: string; selected?: string[]; keepOnline?:string[]; intent?: { kind: string; reason: string }; idempotencyKey: string; payload?: Payload; mode?: 'new' | 'existing'; targetId?: string | null };
type Pending = { path: string; body: Command | Values; action: 'review' | 'adopt' | 'source' | 'takeover' | 'createSource'; queryPath: string; recoverOnly?: boolean; queue?: Pending[] };
type CardState = { basis: string; referenceBasis?: string; serverReferenceBasis?:string; selected: string[]; choices?:Record<string,{value:'source'|'online';basis:string}>; editing?: boolean; editGroup?:string; full?: boolean; mapping?: boolean; payload?: Payload; editedPaths?: string[]; localCopy?: Payload; mode?: 'new' | 'existing'; targetId?: string | null; expectedVersion?: string | null; intent?: { kind: string; reason: string }; pending?: Pending; feedback?: string; fieldErrors?: Record<string,string>; tone?: string; stale?: boolean; continuing?: boolean };
type UploadState = { idempotencyKey: string; name: string; sourceNamespace: string; hash: string; size: number; allowDuplicate: boolean; queue?: UploadState[] };
type PageState = { batchId?: string; sourceNamespace?: string; view?: string; search?: string; cards?: Record<string, CardState>; pendingUpload?: UploadState; pendingBatch?: Pending; sourceName?: string };
type Field = { key: string; title: string; type?: 'date' | 'number' | 'text' | 'textarea' | 'select' | 'reference' | 'boolean'; options?: string[]; catalog?: string; multiple?: boolean; wide?: boolean };

const kindNames: Record<string, string> = { project: '项目', customers: '客户', engineers: '工程师', productLines: '产品线', product_lines: '产品线', apps: 'APP', tags: '标签', company: '企业信息', groups: '分组', project_groups: '分组', chips: '芯片', project_node: '项目节点', customer_node: '客户节点', risk: '风险', change: '需求变更', schedule: '计划记录' };
const catalogKinds: Record<string, string> = { product_lines: 'productLines', project_groups: 'groups' };
const basicFields: Field[] = [
  { key: 'name', title: '项目名称' }, { key: 'status', title: '项目状态', type: 'select', options: ['proposal','ongoing','paused','closed'] }, { key: 'summary', title: '项目简介', type: 'textarea', wide: true },
  { key: 'customerId', title: '客户', type: 'reference', catalog: 'customers' }, { key: 'productLineId', title: '产品线', type: 'reference', catalog: 'productLines' }, { key: 'odmCustomerId', title: 'ODM 工厂', type: 'reference', catalog: 'customers' }, { key: 'appId', title: 'APP', type: 'reference', catalog: 'apps' }, { key: 'groupId', title: '分组', type: 'reference', catalog: 'groups' }, { key: 'chipIds', title: '芯片', type: 'reference', catalog: 'chips', multiple: true }, { key: 'tagIds', title: '项目标签', type: 'reference', catalog: 'tags', multiple: true },
  { key: 'filingDate', title: '立案日期', type: 'date' }, { key: 'startDate', title: '实际启动日期', type: 'date' }, { key: 'dueDate', title: '预计结案日期', type: 'date' }, { key: 'closedOn', title: '实际结案日期', type: 'date' }, { key: 'priority', title: '优先级', type: 'select', options: ['high','mid','low'] }, { key: 'marketExpectation', title: '市场预期', type: 'textarea' }, { key: 'detailNote', title: '详细说明', type: 'textarea' },
];
const extraFields: Field[] = [{ key: 'proposalDate', title: '提案日期', type: 'date' }, { key: 'originalDueDate', title: '原始计划结案日期', type: 'date' }, { key: 'closureDueDate', title: '结案时计划', type: 'date' }, { key: 'closureType', title: '结案类型', type: 'select', options: ['normal','terminated'] }, { key: 'resumeStatus', title: '暂缓前状态', type: 'select', options: ['proposal','ongoing'] }, { key: 'preCloseStatus', title: '结案前状态', type: 'select', options: ['proposal','ongoing','paused'] }, { key: 'closureNote', title: '结案说明', type: 'textarea' }, { key: 'remainingWorkNote', title: '遗留处置说明', type: 'textarea' }, { key: 'maintenanceEnabled', title: '结案后维护', type: 'boolean' }];
const stageFields: Field[] = [{ key: 'state', title: '阶段状态', type: 'select', options: ['locked','ready','active','completed'] }, { key: 'plannedDays', title: '工期（天）', type: 'number' }, { key: 'startedOn', title: '实际开始', type: 'date' }, { key: 'completedOn', title: '实际完成', type: 'date' }, { key: 'expectedEndOn', title: '本地原预计完成', type: 'date' }, { key: 'note', title: '阶段评述', type: 'textarea', wide: true }];
const recordFields: Record<string, Field[]> = {
  project_node: [{ key: 'title', title: '节点名称' }, { key: 'stage', title: '所属阶段', type: 'select', options: ['S1','S2','S3','S4','S5','S6','S7'] }, { key: 'targetDate', title: '目标日期', type: 'date' }, { key: 'completedOn', title: '实际完成', type: 'date' }, { key: 'output', title: '成果', type: 'textarea', wide: true }, { key: 'previousNodeId', title: '前置节点', type: 'reference', catalog: 'nodes' }, { key: 'nextNodeId', title: '后续节点', type: 'reference', catalog: 'nodes' }, { key: 'x', title: 'Flow 横向位置', type: 'number' }, { key: 'y', title: 'Flow 纵向位置', type: 'number' }],
  customer_node: [{ key: 'title', title: '客户节点名称' }, { key: 'targetDate', title: '截止日期', type: 'date' }, { key: 'completedOn', title: '实际完成', type: 'date' }, { key: 'note', title: '备注', type: 'textarea', wide: true }],
  risk: [{ key: 'content', title: '风险内容', type: 'textarea', wide: true }, { key: 'level', title: '风险等级', type: 'select', options: ['high','mid','low'] }, { key: 'resolved', title: '是否已解除', type: 'boolean' }, { key: 'resolution', title: '解除说明', type: 'textarea', wide: true }, { key: 'resolvedAt', title: '来源解除时间' }, { key: 'createdAt', title: '来源记录时间' }],
  change: [{ key: 'source', title: '来源', type: 'select', options: ['客户','业务'] }, { key: 'decision', title: '决定', type: 'select', options: ['accept','reject'] }, { key: 'content', title: '变更内容', type: 'textarea', wide: true }, { key: 'reason', title: '决定理由', type: 'textarea', wide: true }, { key: 'createdAt', title: '来源记录时间' }],
  schedule: [{ key: 'kind', title: '记录类型', type: 'select', options: ['reschedule','note'] }, { key: 'oldDate', title: '原日期', type: 'date' }, { key: 'newDate', title: '新日期', type: 'date' }, { key: 'reason', title: '原因', type: 'textarea' }, { key: 'measures', title: '措施', type: 'textarea' }, { key: 'createdAt', title: '来源记录时间' }],
};
const catalogFields: Record<string, Field[]> = {
  customers: [{ key: 'name', title: '客户名称' }, { key: 'contact', title: '主要联系人' }, { key: 'background', title: '客户背景', type: 'textarea', wide: true }, { key: 'tagIds', title: '客户标签', type: 'reference', catalog: 'tags', multiple: true }],
  engineers: [{ key: 'name', title: '工程师姓名' }, { key: 'role', title: '业务角色' }], productLines: [{ key: 'name', title: '产品线名称' }], apps: [{ key: 'name', title: 'APP名称' }, { key: 'appVersion', title: '版本' }, { key: 'description', title: '描述', type: 'textarea' }], tags: [{ key: 'name', title: '标签名称' }], groups: [{ key: 'name', title: '分组名称' }], chips: [{ key: 'name', title: '芯片名称' }, { key: 'originalModel', title: '原始型号' }, { key: 'manufacturer', title: '厂商' }, { key: 'firmwareVersion', title: '固件版本' }], company: [{ key: 'fullName', title: '企业全称' }, { key: 'shortName', title: '企业简称' }, { key: 'managerText', title: '负责人信息' }, { key: 'namePrefix', title: '名称前缀' }],
};
const titles = Object.fromEntries([...basicFields, ...extraFields, ...stageFields, ...Object.values(recordFields).flat(), ...Object.values(catalogFields).flat(), { key: 'statusDesc', title: '最新状态说明' }, { key: 'summaryNote', title: '备注' }, { key: 'chipstatNote', title: '芯片备注' }, { key: 'signal', title: '灯色' }, { key: 'signalNote', title: '灯色说明' }].map(f => [f.key, f.title]));
Object.assign(titles, { hardware_owner: '硬件负责人', software_owner: '软件负责人', participant: '参与人员', pm: '本地经理姓名', mixed: '本地更新历史', status_description: '状态说明历史', text: '内容', body: '内容', date: '来源时间', reschedule: '调整计划', note: '补充说明' });
const errors: Record<string, string> = { IMPORT_VERSION_CONFLICT: '待审内容已更新，请重新核对。', IMPORT_BATCH_VERSION_CONFLICT: '本批次的来源或处理人已变化，请重新核对。', IMPORT_REVIEW_VERSION_CONFLICT: '这张卡片已更新，请重新核对。', IMPORT_PROJECT_VERSION_CONFLICT: '项目已被他人更新，请重新核对导入信息。', IMPORT_MAPPING_REQUIRED: '请先在共享资料区确认对应资料。', IMPORT_READ_ONLY: '你暂不能修改这张卡片。已有项目需要项目经理资格。', IMPORT_INVALID_FILE: '备份无法解析，请选择完整的 GeekDash 备份文件。', IMPORT_UNSUPPORTED_VERSION: '此备份版本暂不支持，请核对来源。', IMPORT_TAKEOVER_BLOCKED: '当前处理人仍可使用账号，不能接管此批次。', IMPORT_REASON_REQUIRED: '请填写这次变更的原因。', IMPORT_DEPENDENCY_REQUIRED: '所选信息存在前置影响，请在原卡核对。', IMPORT_EMPTY_SELECTION: '请选择需要采用的信息。', CATALOG_VERSION_CONFLICT: '这条共享资料已更新，请重新核对。', PROJECT_VERSION_CONFLICT: '项目已被他人更新，请重新核对导入信息。' };
Object.assign(errors,{IMPORT_FORMAT_INVALID:'无法读取此备份，请选择完整的 GeekDash 备份文件。',IMPORT_ENCODING_INVALID:'文件编码无法读取，请重新从本地面板导出备份。',IMPORT_VERSION_UNSUPPORTED:'此备份结构版本暂不支持，请核对来源。',IMPORT_FILE_EMPTY:'文件为空，请重新选择完整备份。',IMPORT_FILE_TOO_LARGE:'文件超出允许大小，请保留原文件并联系维护人员。',IMPORT_REVIEW_REQUIRED:'请修正本卡标出的信息。',IMPORT_HANDLER_REQUIRED:'首次入库项目由本批次当前处理人修正和提交。',PROJECT_RESPONSIBILITY_REQUIRED:'你不是这个项目的项目经理，当前只能查看。',IMPORT_HANDLER_ACTIVE:'当前处理人仍在使用账号，不能接管此批次。',IMPORT_TAKEOVER_REASON_REQUIRED:'请填写接管原因。',IMPORT_BINDING_CHANGED:'来源或资料对应已更新，请重新核对当前差异。',IMPORT_SELECTION_CHANGED:'所选信息已变化，请重新核对后选择。',IMPORT_SELECTION_REQUIRED:'请选择需要采用的信息。',IMPORT_WRITES_PAUSED:'导入保存暂时暂停，输入保持，请稍后重试原操作。'});

let data: BatchData | undefined, sources: Source[] = [], batches: BatchBrief[] = [], state: PageState = { cards: {} };
let preference: PersonalPreference, frozen = false, busy = false, loading = false, generation = 0, file: File | undefined;
let sourceName = '', selectedSource = '', catalogue: Record<string, Values[]> = {}, projectOptions: Values[] = [], duplicateBatches: BatchBrief[] = [];
const previews = new Map<string, { issues: Issue[]; effects: Effect[]; pending?: boolean }>();
const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
const defaultDisabled = new WeakMap<HTMLElement,boolean>();
const ownOperations = new Set<string>();
const sourceSnapshots = new Map<string,{source:Values;issues:Issue[]}>();
const adoptionSnapshots = new Map<string,{adoption:Values;histories:Payload['histories']}>();
const entry = document.getElementById('imports-entry')!, content = document.getElementById('imports-batch')!, list = document.getElementById('imports-list')!, message = document.getElementById('imports-message')!;
const savebar = document.getElementById('imports-savebar')!, saveButton = document.getElementById('imports-save') as HTMLButtonElement;
const button = (text: string, action: string, id = '', primary = false) => `<button type="button" class="${primary ? 'save-btn' : 'head-btn'}" data-action="${action}"${id ? ` data-item="${esc(id)}"` : ''}>${text}</button>`;
const itemPath = (id: string) => `/api/imports/${encodeURIComponent(data!.batch.id)}/items/${encodeURIComponent(id)}`;
const allItems = () => data ? [...data.catalogRows, ...data.items] : [];
const findItem = (id: string) => allItems().find(item => item.id === id);
const isProject = (item: Item) => data?.items.some(row => row.id === item.id) ?? item.kind === 'project';
const issueText = (issue: Issue | Effect) => typeof issue === 'string' ? issue : issue.message ?? ([issue.cause, issue.consequence].filter(Boolean).join('：') || ('code' in issue ? issue.code : '') || '请核对相关信息。');
const explain = (error: unknown) => error instanceof SaveError ? errors[error.code] ?? error.message : (error as Error).message;
const key = () => `geekdash_imports:${account!.id}`;
function notice(text: string, error = false) { message.textContent = text; message.classList.toggle('error', error); }
function basis(item: Item) { return JSON.stringify([data!.batch.version, data!.batch.sourceNamespace, item.reviewVersion, item.targetId, item.expectedVersion, item.bindingVersion, item.basis]); }
const referenceFields = ['customerId','odmCustomerId','productLineId','appId','groupId','chipIds','tagIds'];
function referenceBasis(item: Item) { return JSON.stringify([data!.batch.sourceNamespace,item.targetId,item.bindingVersion,item.referenceBasis]); }
function card(item: Item) { return state.cards![item.id] ??= { basis: basis(item), referenceBasis:referenceBasis(item),serverReferenceBasis:referenceBasis(item), selected: [] }; }
const leaves=(item:Item)=>item.diffs.flatMap(diff=>diff.members?.length?diff.members:[diff]);
const selectionKeys=(item:Item,keys:string[])=>keys.flatMap(key=>{const group=item.diffs.find(diff=>diff.key===key);return group?.members?.length?group.members.filter(diff=>diff.selectable).map(diff=>diff.key):[key];});
const choiceBasis=(diff:Difference)=>JSON.stringify([diff.before,diff.after,diff.baseline]);
function editedKey(item:Item,path:string) {
  const payload=card(item).payload ?? item.payload,[group,index,field,part]=path.split('.');
  if(group==='stages')return `stage.${payload.stages?.[Number(index)]?.code}.${field}`;
  if(group==='records')return field==='values'?`record.${payload.records?.[Number(index)]?.key}.${part}`:'';
  return path;
}
function applySelection(item:Item) {
  const current=card(item); if(current.pending)return;
  const values=leaves(item),edited=(current.editedPaths ?? []).map(path=>editedKey(item,path));
  for(const diff of values)if(edited.includes(diff.key)&&current.choices?.[diff.key]?.basis!==choiceBasis(diff)){current.choices ??={};current.choices[diff.key]={value:'source',basis:choiceBasis(diff)};}
  for(const [key,choice] of Object.entries(current.choices ?? {}))if(!values.some(diff=>diff.key===key&&choice.basis===choiceBasis(diff)))delete current.choices![key];
  current.selected=values.filter(diff=>diff.selectable&&(current.choices?.[diff.key]?.value==='source'||current.choices?.[diff.key]?.value!=='online'&&(item.defaultSelected ?? []).includes(diff.key))).map(diff=>diff.key);
}
const keepOnline=(item:Item)=>Object.entries(card(item).choices ?? {}).filter(([,choice])=>choice.value==='online').map(([key])=>key);
function needsChoice(item:Item) { return (item.conflictKeys ?? []).some(key=>!card(item).choices?.[key]); }
function itemIssues(item:Item) { const preview=previews.get(item.id);return preview&&!preview.pending?preview.issues:item.issues ?? []; }
function canImport(item:Item) {
  const current=card(item);
  if(item.needsMapping)return false;
  return item.canAdopt&&!frozen&&!current.pending&&!current.stale&&!previews.get(item.id)?.pending&&(!item.previousResult||current.continuing)&&!needsChoice(item)&&!itemIssues(item).length&&(current.selected.length>0||keepOnline(item).length>0);
}
function waitingForCatalog(item:Item,visited=new Set<string>()):boolean {
  const current=card(item),issues=itemIssues(item);
  if(!item.canEdit||current.pending||current.stale||previews.get(item.id)?.pending||needsChoice(item)||visited.has(item.id)||!issues.length)return false;
  if(item.needsMapping)return false;
  const next=new Set(visited).add(item.id);
  return issues.every(issue=>{
    if(typeof issue==='string'||issue.code!=='IMPORT_REFERENCE_REQUIRED')return false;
    const references=item.unresolvedReferences?.filter(reference=>reference.path===(issue.path ?? issue.field)) ?? [];
    return references.length>0&&references.every(reference=>{
      if(reference.itemIds.length!==1)return false;
      const dependency=data?.catalogRows.find(candidate=>candidate.id===reference.itemIds[0]);
      return !!dependency&&card(dependency).tone!=='error'&&(canImport(dependency)||waitingForCatalog(dependency,next));
    });
  });
}
function itemState(item:Item) {
  if(card(item).pending||card(item).stale||card(item).tone==='error')return 'attention';
  if(item.previousResult&&!card(item).continuing)return 'processed';
  if(item.unchanged||item.keptOnline||item.classification==='unchanged')return 'unchanged';
  return canImport(item)||waitingForCatalog(item)?'ready':'attention';
}
function correction(item: Item): Payload | undefined {
  const current = card(item), full = current.payload;
  if (!full) return;
  const result: Payload = {};
  for (const path of current.editedPaths ?? []) {
    const [group,index,field,part] = path.split('.');
    if (group === 'stages') { const source = full.stages?.[Number(index)]; if(!source)continue; const target = (result.stages ??= []).find(stage=>stage.code===source.code) ?? {code:source.code}; if(!result.stages.includes(target))result.stages.push(target); target[field] = source[field]; }
    else if (group === 'records') { const source = full.records?.[Number(index)]; if(!source)continue; const target = (result.records ??= []).find(record=>record.key===source.key) ?? {key:source.key,kind:source.kind,sourceKey:source.sourceKey,values:{}}; if(!result.records.includes(target))result.records.push(target); if(field==='values')target.values[part]=source.values[part];else if(field==='targetId')target.targetId=source.targetId; }
    else if (group === 'fields' || group === 'people') { ((result[group] ??= {}) as Values)[index] = (full[group] as Values)?.[index]; }
    else result[group] = full[group];
  }
  return result;
}
function correctedPayload(base: Payload, change?: Payload) {
  const next = structuredClone(base); if(!change)return next;
  for (const [key,value] of Object.entries(change)) {
    if(key==='fields' || key==='people')Object.assign(next,{[key]:{...next[key],...(value as Values)}});
    else if(key==='stages')for(const row of value as Values[]){const target=(next.stages ??= []).find(stage=>stage.code===row.code);if(target)Object.assign(target,row);else next.stages.push(structuredClone(row));}
    else if(key==='records')for(const row of value as RecordValue[]){const target=(next.records ??= []).find(record=>record.key===row.key);if(target){const values={...target.values,...row.values};Object.assign(target,row,{values});}else next.records.push(structuredClone(row));}
    else next[key]=structuredClone(value);
  }
  return next;
}
function resetReferenceEdits(item: Item) {
  const current=card(item);
  current.editedPaths=(current.editedPaths ?? []).filter(path=>!(path.startsWith('people.') || referenceFields.some(field=>path==='fields.'+field || path===field) || /^records\.\d+\.(targetId|values\.(previousNodeId|nextNodeId))$/.test(path)));
  current.selected=[];current.choices=undefined;
}
function retainRequests<T extends {queue?:T[]}>(server:T|undefined,local:T|undefined,identity:(value:T)=>unknown):T|undefined {
  const all=[...(server?[server,...server.queue ?? []]:[]),...(local?[local,...local.queue ?? []]:[])];
  const requests=new Map<unknown,T>();
  for(const request of all)if(!requests.has(identity(request)))requests.set(identity(request),request);
  const distinct=[...requests.values()];
  if(!distinct.length)return;
  return {...distinct[0],queue:distinct.slice(1).map(({queue,...request})=>request as T)};
}
function nextRequest<T extends {queue?:T[]}>(request:T):T|undefined { const next=request.queue?.[0];return next?{...next,queue:request.queue!.slice(1)}:undefined; }
function persist() {
  if (!account || frozen) return;
  try { localStorage.setItem(key(), JSON.stringify({state,baseVersion:preference?.revision()})); } catch { notice('本机恢复信息无法保存，请保留此页面，核对完原保存结果再离开。', true); }
  preference?.update({ ...state, cards: state.cards ?? {} });
}
function feedback(item: Item, text: string, tone = '') { Object.assign(card(item), { feedback: text, tone }); persist(); }
function locked(item?: Item) { return frozen || busy || !!(item && card(item).pending); }
function readable(value: unknown, name = '', references = true, recordKind = '', records: RecordValue[] = []): string {
  if (value === undefined) return '来源未提供';
  if (value === null || value === '') return '未填写';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? value.map(v => readable(v, name,references,recordKind,records)).join('\n') : '空名单';
  if (typeof value === 'object') return Object.entries(value as Values).filter(([k]) => !['id','key','sourceKey','targetId','version','actorId','sortOrder'].includes(k)).map(([k, v]) => `${recordFields[recordKind]?.find(field=>field.key===k)?.title ?? titles[k] ?? k}：${readable(v, k,references,recordKind,records)}`).join('\n');
  if (references && ['previousNodeId','nextNodeId'].includes(name)) { const match=records.find(record=>record.kind==='project_node' && (String(value).startsWith('source:') ? record.sourceKey===String(value).slice(7) : record.targetId===String(value))); if(match?.values.title)return String(match.values.title); }
  if (references && (name.endsWith('Id') || name.endsWith('Ids') || ['hardware_owner','software_owner','participant','pm'].includes(name))) { const kind = ({customerId:'customers',odmCustomerId:'customers',productLineId:'productLines',appId:'apps',groupId:'groups',chipIds:'chips',tagIds:'tags',hardware_owner:'engineers',software_owner:'engineers',participant:'engineers',pm:'engineers'} as Record<string,string>)[name]; const match = (catalogue[kind] ?? []).find(item => String(item.id) === String(value)); if (match) return String(match.name); }
  return label(value);
}
function sourceOptions(value: string) { return `<option value="">新来源</option>${sources.map(source => `<option value="${esc(source.sourceNamespace)}"${source.sourceNamespace === value ? ' selected' : ''}>${esc(source.name)}</option>`).join('')}`; }
function renderEntry() {
  entry.hidden = !!data; list.hidden = !!data;
  if (data) return;
  entry.innerHTML = `<div class="import-panel"><h2>读取本地备份</h2><div class="import-grid"><div class="field"><label for="import-source">备份来自哪里</label><select id="import-source">${sourceOptions(selectedSource)}</select></div><div class="field"${selectedSource ? ' hidden' : ''}><label for="import-source-name">来源名称</label><input id="import-source-name" value="${esc(sourceName)}" placeholder="例如：研发本地库" maxlength="128"></div><div class="field"><label for="import-file">备份文件</label><input type="file" id="import-file" accept=".bak,.json,application/json"></div></div><div class="import-actions">${button(state.pendingUpload ? '核对原读取结果' : '读取备份', state.pendingUpload ? 'upload-query' : 'upload', '', true)}${state.pendingUpload ? button('重试原文件读取', 'upload-retry') : ''}<span class="import-muted">读取后先核对信息，项目尚未入库。</span></div><p id="import-file-note" class="import-muted">${esc(file?.name ?? state.pendingUpload?.name ?? '')}</p>${state.pendingBatch ? `<div class="import-impact"><p>来源登记结果待确认，请先核对原结果。</p>${button('核对原操作','batch-query')}${button('重试原操作','batch-retry')}</div>` : ''}<div id="import-duplicate">${duplicateBatches.length ? duplicateNotice() : ''}</div></div>`;
  list.innerHTML = `<h2>已有导入批次</h2><div class="import-batch-list">${batches.map(batch => `<a class="import-batch-link" href="/imports.html?id=${encodeURIComponent(batch.id)}"><div><strong>${esc(batch.name || batch.filename || '未命名批次')}</strong><span>${esc(batch.handlerName ?? batch.uploaderName ?? '')}${batch.createdAt ? '　' + formatTime(batch.createdAt) : ''}</span></div><span>${batch.total == null ? '进入核对' : `共 ${batch.total} 个项目　待处理 ${batch.pending ?? 0} 个`}</span></a>`).join('') || '<p class="import-empty">还没有导入批次。</p>'}</div>`;
  const source = document.getElementById('import-source') as HTMLSelectElement;
  source.onchange = () => { selectedSource = source.value; duplicateBatches = []; state.sourceNamespace = selectedSource; persist(); renderEntry(); };
  document.getElementById('import-source-name')!.oninput = e => { sourceName = (e.target as HTMLInputElement).value; state.sourceName = sourceName; persist(); };
  document.getElementById('import-file')!.onchange = e => { file = (e.target as HTMLInputElement).files?.[0]; duplicateBatches = []; document.getElementById('import-duplicate')!.innerHTML = ''; document.getElementById('import-file-note')!.textContent = file?.name ?? ''; };
  controls();
}
function duplicateNotice() { return `<div class="import-impact"><p>这份文件已在同一来源登记。可以继续原批次，也可以明确另开一份。</p><div class="import-actions">${duplicateBatches.map(batch => `<a class="head-btn" href="/imports.html?id=${encodeURIComponent(batch.id)}">继续 ${esc(batch.name)}</a>`).join('')}${button('仍然另开批次', 'upload-new')}</div></div>`; }
function formatTime(value: unknown) { if (!value) return '时间未知'; const date = new Date(typeof value==='number'?value:String(value)); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai', hour12: false }).format(date); }
function mapping(item: Item, current: CardState) {
  if (item.kind === 'company') return '';
  if (!current.mapping && !item.needsMapping && item.targetId) return `<p class="import-muted">已对应：${esc((item.target?.fields as Values)?.name ?? item.target?.name ?? item.name ?? (isProject(item) ? '线上项目' : '线上资料'))}${button('修改对应', 'map', item.id)}</p>`;
  const project = isProject(item), mode = item.needsMapping&&!current.mode?'':current.mode ?? item.mode;
  const options = project ? projectOptions : catalogue[catalogKinds[item.kind] ?? item.kind] ?? [];
  const targetId = item.needsMapping&&!current.mode?null:current.targetId === undefined ? item.targetId : current.targetId;
  return `<div class="import-source-row"><div class="field"><label for="mode-${item.id}">本次如何采用</label><select id="mode-${item.id}" data-mode="${item.id}">${mode?'':'<option value="">请选择如何对应</option>'}<option value="new"${mode === 'new' ? ' selected' : ''}>${project ? '作为新项目入库' : '新建资料'}</option><option value="existing"${mode === 'existing' ? ' selected' : ''}>${project ? '对应已有项目' : '对应已有资料'}</option></select></div>${mode === 'existing' ? `<div class="field"><label for="target-${item.id}">${project ? '线上项目' : '线上资料'}</label><select id="target-${item.id}-source" data-reference="true" data-target="${item.id}"><option value="">请选择</option>${options.map(option => `<option value="${esc(option.id)}"${String(option.id) === String(targetId) ? ' selected' : ''}>${esc(option.name ?? option.fullName)}${project ? `（#${esc(option.id)}）` : ''}</option>`).join('')}</select></div>` : ''}</div>${mode === 'new' && project ? '<p class="import-muted">新项目由实际保存入库的人负责。本地经理姓名保留为来源，不改变账号权限。</p>' : '<p class="import-muted">核对差异后，所选信息和对应会一起保存。</p>'}`;
}
function differences(item: Item, current: CardState) {
  const visible=item.diffs.map(diff=>({diff,members:(diff.members?.length?diff.members:[diff]).filter(member=>current.full||(item.conflictKeys ?? []).includes(member.key))})).filter(row=>row.members.length);
  if(!visible.length)return '';
  const records=[...(item.payload.records ?? []),...((item.target?.records as RecordValue[]) ?? [])];
  return `<div class="import-diff"><table><thead><tr><th>需要核对的信息</th><th>线上信息</th><th>文件信息</th></tr></thead><tbody>${visible.map(({diff,members})=>{
    const recordKind=diff.key.startsWith('record.')?diff.key.slice(7).split(':')[0]:'';
    const title=isProject(item)?diff.label:catalogFields[catalogKinds[item.kind] ?? item.kind]?.find(field=>field.key===diff.key)?.title ?? diff.label;
    const display=(member:Difference,value:unknown)=>readable(value,member.key.split('.').at(-1),true,recordKind,records);
    const choice=(member:Difference)=>{
      if(!(item.conflictKeys ?? []).includes(member.key))return `<small class="import-muted">${member.status==='keep_online'?'保留线上':'随本次导入'}</small>`;
      return `<div class="import-choices" role="group" aria-label="${esc(member.label)}采用内容">${[['online','保留线上'],['source','采用文件']].map(([value,label])=>`<button type="button" class="head-btn" data-choice="${esc(member.key)}" data-choice-value="${value}" data-item="${item.id}" aria-pressed="${current.choices?.[member.key]?.value===value}"${!item.canAdopt||locked(item)?' disabled':''}>${label}</button>`).join('')}</div>`;
    };
    return `<tr><td><strong>${esc(title)}</strong>${members.map(member=>`<div class="import-diff-part">${diff.members?.length?`<span>${esc(member.label)}</span>`:''}${choice(member)}</div>`).join('')}</td><td>${members.map(member=>`<div class="import-diff-part">${diff.members?.length?`<small>${esc(member.label)}</small>`:''}${esc(display(member,member.before))}</div>`).join('')}</td><td>${members.map(member=>`<div class="import-diff-part">${diff.members?.length?`<small>${esc(member.label)}</small>`:''}${esc(display(member,member.after))}${member.issues?.length?`<p class="import-error">${member.issues.map(issue=>esc(issueText(issue))).join('\n')}</p>`:''}</div>`).join('')}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function impact(item: Item, current: CardState) {
  const preview = previews.get(item.id), issues = preview && !preview.pending ? preview.issues : item.issues ?? [];
  if (!issues.length && !preview?.effects.length && !preview?.pending) return '';
  const rows = [...new Set(issues.map(issueText))];
  const dependencyKeys = selectionKeys(item,[...new Set(issues.flatMap(issue => typeof issue === 'object' ? issue.requiredKeys ?? [] : []).concat((preview?.effects ?? []).flatMap(effect => typeof effect === 'object' ? effect.requiredKeys ?? [] : [])))]).filter(k => !current.selected.includes(k));
  const needsIntent = issues.some(issue => /INTENT|REOPEN|ROLLBACK|LIFECYCLE/.test(typeof issue === 'string' ? issue : issue.code ?? '')) || (preview?.effects ?? []).some(effect => /回退|重开|已结案/.test(issueText(effect)));
  return `<div class="import-impact"><h3>${preview?.pending ? '正在核对所选信息…' : '这次选择的影响'}</h3>${rows.length ? `<ul>${rows.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : ''}${preview?.effects.length ? `<ol>${preview.effects.map(effect => `<li>${esc(issueText(effect))}</li>`).join('')}</ol>` : ''}${dependencyKeys.length ? button('一并选择所需的前置信息', 'select-dependencies', item.id) : ''}${needsIntent ? `<div class="import-grid"><div class="field"><label for="intent-${item.id}">这次状态变化的原因</label><select id="intent-${item.id}" data-intent="kind" data-item="${item.id}"><option value="">请选择</option>${[['correction','线上误录，需要纠正'],['rework','本地发生实际返工'],['reopen','本地已重新打开项目']].map(([v,t]) => `<option value="${v}"${current.intent?.kind === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div><div class="field import-wide"><label for="reason-${item.id}">原因说明</label><textarea id="reason-${item.id}" data-intent="reason" data-item="${item.id}" rows="2">${esc(current.intent?.reason)}</textarea></div></div><p class="import-muted">如需保持线上状态，在对应冲突中选择“保留线上”。</p>` : ''}</div>`;
}
function fieldControl(item: Item, spec: Field, values: Values, prefix: string, editing: boolean) {
  const value = values[spec.key], present = Object.hasOwn(values, spec.key), path = prefix + spec.key;
  const id = `field-${item.id}-${path.replaceAll('.', '-')}`;
  if (!editing) return present ? `<div class="field${spec.wide ? ' import-wide' : ''}"><dt>${esc(spec.title)}</dt><dd>${esc(readable(value, spec.key,true,'',[...(item.payload.records ?? []),...((item.target?.records as RecordValue[]) ?? [])]))}</dd></div>` : '';
  let input = '';
  if (spec.type === 'reference') {
    const nodeOptions = spec.catalog === 'nodes' ? [...((card(item).payload ?? item.payload).records ?? []), ...((item.target?.records as RecordValue[]) ?? [])].filter(r => r.kind === 'project_node' && (r.targetId || r.sourceKey)).map(r => ({ id: r.targetId ?? `source:${r.sourceKey}`, name: r.values.title })) : [];
    const options: Values[] = spec.catalog === 'nodes' ? [...new Map(nodeOptions.map(node => [node.id,node])).values()] : catalogue[spec.catalog!] ?? [];
    const selected = (Array.isArray(value) ? value : value == null ? [] : [value]).map(String);
    const missing = selected.filter(id => !options.some(o => String(o.id) === id));
    input = `<select id="${id}-source" data-reference="true" data-value-path="${esc(path)}" data-item="${item.id}"${spec.multiple ? ' multiple' : ''}><option value="">${present ? '未选择' : '来源未提供'}</option>${options.map(o => `<option value="${esc(o.id)}"${selected.includes(String(o.id)) ? ' selected' : ''}${o.enabled === false && !selected.includes(String(o.id)) ? ' disabled' : ''}>${esc(o.name)}</option>`).join('')}${missing.map(v => `<option value="${esc(v)}" selected>待核对来源：${esc(v)}</option>`).join('')}</select>`;
  } else if (spec.type === 'select' || spec.type === 'boolean') {
    const options = spec.type === 'boolean' ? ['false','true'] : spec.options ?? [];
    const current = spec.type === 'boolean' && value !== undefined && value !== null ? String(!!value) : String(value ?? '');
    input = `<select id="${id}" data-value-path="${esc(path)}" data-item="${item.id}" data-value-type="${spec.type}"><option value="">${present ? '未知 / 未填写' : '来源未提供'}</option>${current && !options.includes(current) ? `<option selected value="${esc(current)}">原值：${esc(current)}</option>` : ''}${options.map(option => `<option value="${esc(option)}"${option === current ? ' selected' : ''}>${spec.type === 'boolean' ? option === 'true' ? '是' : '否' : esc(titles[option] ?? label(option))}</option>`).join('')}</select>`;
  } else if (spec.type === 'textarea') input = `<textarea id="${id}" data-value-path="${esc(path)}" data-item="${item.id}" rows="3" placeholder="${present ? '未填写' : '来源未提供'}">${esc(value)}</textarea>`;
  else input = `<input id="${id}" data-value-path="${esc(path)}" data-item="${item.id}" data-value-type="${spec.type ?? 'text'}" type="${spec.type === 'date' ? 'date' : spec.type === 'number' ? 'number' : 'text'}" value="${esc(value)}" placeholder="${present ? '未填写' : '来源未提供'}">`;
  return `<div class="field${spec.wide ? ' import-wide' : ''}"><label for="${id}">${esc(spec.title)}</label>${input}${spec.type === 'date' && present ? '<small class="import-muted">留空并保存表示日期未知。</small>' : ''}<span class="field-error" data-field-error="${esc(path)}">${esc(card(item).fieldErrors?.[path])}</span></div>`;
}
function group(title: string, html: string, open = false) { return html ? `<details class="import-group"${open ? ' open' : ''}><summary>${title}</summary>${html}</details>` : ''; }
function sourceHistory(payload: Payload) {
  const history = payload.histories ?? {};
  return Object.entries(history).map(([kind, entries]) => `<section><h3>${esc(titles[kind] ?? kind)}</h3>${entries.length ? entries.map(entry => `<div class="import-history">${esc(readable(entry))}</div>`).join('') : '<p class="import-muted">本次来源为空，采用后当前来源历史为空；以往采用版本仍保留。</p>'}</section>`).join('') + (payload.lastCheckAt != null ? `<div class="import-history"><h3>本地最后标记时间</h3><p>${esc(formatTime(payload.lastCheckAt))}</p><p class="import-muted">本地创建或打开详情也可能生成此标记，操作人未知，不计入线上今日检查。</p></div>` : '');
}
function adoptionHistory(item: Item) {
  return item.adoptions?.length ? group('以往采用记录', item.adoptions.map(adoption => {
    const snapshot = adoptionSnapshots.get(item.id + ':' + adoption.id);
    if (!snapshot) return `<div class="import-history"><span>${esc(formatTime(adoption.savedAt))}</span> <button class="head-btn" data-action="view-adoption" data-item="${item.id}" data-adoption="${esc(adoption.id)}">查看这次采用的内容</button></div>`;
    const adopted = snapshot.adoption.adopted as Payload | undefined;
    const groups = adopted ? [adopted.fields,adopted.people].filter(Boolean).map(values => `<p>${esc(readable(values))}</p>`).join('') : '';
    const records = adopted?.records?.map(record => `<p><b>${esc(kindNames[record.kind])}</b><br>${esc(readable(record.values,'',true,record.kind,adopted.records))}</p>`).join('') ?? '';
    const stages = adopted?.stages?.map(stage => `<p><b>${esc(label(stage.code))}</b><br>${esc(readable(stage))}</p>`).join('') ?? '';
    return `<details class="import-history" open><summary>${esc(formatTime(adoption.savedAt))}采用的内容</summary>${groups}${stages}${records}${sourceHistory({histories:snapshot.histories,...adopted && Object.hasOwn(adopted,'lastCheckAt') ? {lastCheckAt:adopted.lastCheckAt} : {}})}</details>`;
  }).join('')) : '';
}
function originalSource(item: Item) {
  const source = sourceSnapshots.get(item.id);
  return source ? `<h3>原文件中的本项信息</h3>${source.issues?.length ? `<ul>${source.issues.map(issue => `<li>${esc(issueText(issue))}</li>`).join('')}</ul>` : ''}<p>${esc(readable(source.source,'',false))}</p>` : button('查看完整来源信息','view-source',item.id);
}
function suggestedGroup(item:Item) {
  const issue=itemIssues(item).find(issue=>typeof issue==='object') as Exclude<Issue,string>|undefined;
  const path=issue?.path ?? issue?.field ?? issue?.key ?? item.conflictKeys?.[0] ?? '';
  if(path.startsWith('stage'))return 'stages';
  const record=item.payload.records?.find(record=>path.includes(record.key));if(record)return record.kind;
  if(/statusDesc|summaryNote|chipstatNote/.test(path))return 'status';
  return 'basic';
}
function fullInformation(item: Item, editing = false) {
  const current = card(item), payload = editing ? current.payload ?? item.payload : item.payload;
  if (!isProject(item)) return `<div class="import-grid">${(catalogFields[catalogKinds[item.kind] ?? item.kind] ?? [{ key: 'name', title: '名称' }]).map(spec => fieldControl(item, spec, payload, '', editing)).join('')}</div>` + (!editing ? group('本地原有记录',originalSource(item)) + adoptionHistory(item) : '');
  const fields = payload.fields ?? {}, people = payload.people ?? {};
  const render = (specs: Field[], v = fields, prefix = 'fields.') => `<div class="import-grid">${specs.map(spec => fieldControl(item, spec, v, prefix, editing)).join('')}</div>`;
  const peopleHtml = render(['pm','hardware_owner','software_owner','participant'].map(key => ({ key, title: titles[key], type: 'reference', catalog: 'engineers', multiple: true })), people, 'people.') + ('pm' in people ? '<p class="import-muted">本地经理姓名是来源资料，不授予线上账号权限。</p>' : '');
  const stages = (payload.stages ?? []).map((stage, index) => `<div class="import-record"><h3>${esc(label(stage.code))}</h3>${render(stageFields, stage, `stages.${index}.`)}</div>`).join('');
  const records = Object.keys(recordFields).map(kind => {
    const rows = (payload.records ?? []).map((record, index) => ({record,index})).filter(({record}) => record.kind === kind);
    if(editing&&current.editGroup!==kind)return '';
    return group(kindNames[kind], rows.map(({record,index}) => {
      const targets = ((item.target?.records as RecordValue[]) ?? []).filter(row => row.kind === kind);
      const mapping = editing && (current.mode ?? item.mode) === 'existing' ? `<div class="field"><label for="record-target-${item.id}-${index}">这条记录如何采用</label><select id="record-target-${item.id}-${index}-source" data-reference="true" data-item="${item.id}" data-value-path="records.${index}.targetId" data-value-type="record-target"><option value="">请选择新增或对应</option><option value="__new"${record.targetId === null ? ' selected' : ''}>作为新记录加入</option>${targets.map(row => `<option value="${esc(row.targetId)}"${row.targetId === record.targetId ? ' selected' : ''}>${esc(row.values.title ?? row.values.content ?? row.values.reason ?? kindNames[kind])}（#${esc(row.targetId)}）</option>`).join('')}</select></div>` : '';
      return `<div class="import-record"><div class="import-record-head"><h3>${esc(record.values.title ?? record.values.content ?? (kindNames[kind] + ' ' + (index + 1)))}</h3>${record.targetId ? '<span class="import-badge">对应线上记录</span>' : '<span class="import-badge">来源记录</span>'}</div>${mapping}${render(recordFields[kind], record.values, `records.${index}.values.`)}</div>`;
    }).join(''),editing);
  }).join('');
  const history = sourceHistory(payload) + originalSource(item);
  const adoptions = adoptionHistory(item);
  const sections:Record<string,[string,string]>={
    basic:['基本信息与项目分工',render(basicFields)+`<h3>项目分工</h3>${peopleHtml}`],
    status:['最新状态说明与导出备注',render([{key:'statusDesc',title:'最新状态说明',type:'textarea',wide:true},{key:'summaryNote',title:'备注',type:'textarea'},{key:'chipstatNote',title:'芯片备注',type:'textarea'}])],
    stages:['阶段',stages],
    other:['灯色与其他历史事实',render([{key:'signal',title:'灯色',type:'select',options:['green','yellow','red']},{key:'signalNote',title:'灯色说明',type:'textarea'},...extraFields])],
  };
  if(editing){
    current.editGroup ??= 'basic';
    const options=[...Object.entries(sections).map(([key,[title]])=>[key,title]),...Object.keys(recordFields).filter(kind=>payload.records?.some(record=>record.kind===kind)).map(kind=>[kind,kindNames[kind]])];
    return `<div class="field import-editor-choice"><label for="edit-group-${item.id}">需要修正的信息</label><select id="edit-group-${item.id}" data-edit-group="${item.id}">${options.map(([key,title])=>`<option value="${key}"${current.editGroup===key?' selected':''}>${title}</option>`).join('')}</select></div>`+(sections[current.editGroup]?.[1] ?? records);
  }
  return Object.values(sections).map(([title,html])=>group(title,html)).join('')+records+group('本地原有记录',history)+adoptions;
}
function itemName(item: Item) { return String(item.payload.fields?.name ?? item.payload.name ?? item.payload.fullName ?? item.name ?? item.sourceName ?? kindNames[item.kind] ?? '来源项目'); }
function renderCard(item: Item, catalog = false) {
  const current=card(item),prior=item.previousResult,status=itemState(item),mode=current.mode ?? item.mode;
  const statusText=status==='processed'?'已处理':status==='unchanged'?(item.keptOnline?'保留线上':'已相同'):status==='ready'?(mode==='existing'?'可更新':'可新增'):'需处理';
  const active=!prior||current.continuing;
  const actions=active&&item.canEdit&&!current.pending?`<div class="import-actions">${current.editing?button('收起修正','finish-edit',item.id)+button('撤销本次修正','cancel-edit',item.id):button('修正信息','edit',item.id)}${button(current.full?'收起完整信息':'查看完整信息','full',item.id)}${button('更改对应','map',item.id)}</div>`:button(current.full?'收起完整信息':'查看完整信息','full',item.id);
  return `<article class="import-card" id="import-item-${item.id}" data-card="${item.id}"${catalog?' data-catalog="true"':''}><div class="import-heading"><h2><span>${catalog?esc(kindNames[item.kind] ?? '资料')+'：':''}${esc(itemName(item))}</span></h2><span class="import-badge" data-state="${status}">${statusText}</span></div>
    ${prior?`<div class="import-result"><span>已采用 ${prior.adoptedCount ?? 0} 项${prior.notAdoptedCount?`，本次未采用 ${prior.notAdoptedCount} 项`:''}。</span>${prior.projectId?`<a href="/project-detail.html?id=${encodeURIComponent(prior.projectId)}">进入正式项目</a>`:''}${!current.continuing&&!current.pending?button('继续选择','continue',item.id):''}</div>`:''}
    ${active&&(current.mapping||item.needsMapping&&isProject(item))?mapping(item,current):active&&catalog&&item.needsMapping&&!current.mode?`<p class="import-muted">这条资料还没有线上对应。</p><div class="import-actions">${button('新建此资料','new-catalog',item.id)}${button('对应已有资料','existing-catalog',item.id)}</div>`:''}
    ${active?differences(item,current):''}
    ${active?impact(item,current):''}${active&&waitingForCatalog(item)?'<p class="import-muted">对应资料已选好，将随底部导入操作先保存资料，再导入本项目。</p>':''}
    ${current.editing?fullInformation(item,true):current.full?fullInformation(item):''}${actions}
    ${active&&!current.pending&&item.canAdopt?`<div class="import-actions"><button class="save-btn" data-action="adopt-item" data-item="${item.id}"${canImport(item)?'':' disabled'}>${catalog?'导入这条资料':'导入此项目'}</button>${current.editing?'<span class="import-muted">修正与选用的内容一起保存。</span>':''}</div>`:''}
    ${!item.canEdit?'<p class="import-muted">当前只能查看。新项目由本批次处理人导入；已有项目由项目经理导入。</p>':''}
    ${current.stale?`<div class="import-impact"><p>线上信息已更新。输入已保留，请重新核对。</p>${button('重新核对这一项','refresh-item',item.id)}</div>`:''}
    ${current.localCopy?group('本机尚未同步的输入',`<p class="import-muted">服务器内容保持，本机输入留在这里供复制。</p><p>${esc(readable(current.localCopy,'',false))}</p>`):''}
    <div class="import-feedback" data-tone="${esc(current.tone)}" role="status">${esc(current.feedback)}</div>
    ${current.pending?`<div class="import-impact"><p>这次保存结果还需确认，输入与前次成果保持。</p>${button('核对保存结果','query',item.id)}${button('重试原保存','retry',item.id)}</div>`:''}</article>`;
}
function render() {
  renderEntry();content.hidden=!data;savebar.hidden=!data;document.getElementById('imports-back')!.hidden=!data;
  if(!data){document.getElementById('imports-title')!.textContent='导入项目';document.getElementById('imports-subtitle')!.textContent='选择本地备份，系统核对后导入；有冲突的内容再处理。';return;}
  const {batch,counts}=data;
  document.getElementById('imports-title')!.textContent=batch.name;
  document.getElementById('imports-subtitle')!.textContent=`${batch.uploaderName ?? batch.handlerName}上传 · 共 ${counts.total} 个项目`;
  const source=sources.find(s=>s.sourceNamespace===batch.sourceNamespace);
  const proposedSource=state.pendingBatch?.path===`/api/imports/${batch.id}/source`?(state.pendingBatch.body as Values).sourceNamespace:batch.sourceNamespace;
  const numbers=Object.fromEntries(['ready','unchanged','attention','processed'].map(status=>[status,data!.items.filter(item=>itemState(item)===status).length]));
  const ready=data.items.filter(item=>itemState(item)==='ready'),newCount=ready.filter(item=>(card(item).mode ?? item.mode)==='new').length;
  const view=['attention','ready','unchanged','processed','all'].includes(state.view ?? '')?state.view!:'attention';
  const shown=data.items.filter(item=>view==='all'||itemState(item)===view);
  const catalogAttention=data.catalogRows.filter(item=>itemState(item)==='attention');
  const catalogOthers=data.catalogRows.filter(item=>itemState(item)!=='attention');
  content.innerHTML=`<section class="import-panel import-summary"><div class="import-heading"><div><h2>核对结果</h2><p class="import-muted">可导入项目中，将新增 ${newCount} 个，更新 ${ready.length-newCount} 个。相同内容和仅线上修改的内容保持。</p></div><span class="import-muted">${esc(source?.name ?? '本地来源')}</span></div><div class="import-counts">${[['ready','可导入'],['unchanged','已相同 / 保留线上'],['attention','需处理'],['processed','已处理']].map(([value,title])=>`<button class="head-btn" data-view="${value}" aria-pressed="${view===value}"><strong>${numbers[value]}</strong><span>${title}</span></button>`).join('')}</div>${group('文件与来源',`<p>文件：${esc(batch.filename ?? batch.name)}</p><div class="import-source-row"><div class="field"><label for="batch-source">来源</label><select id="batch-source">${sources.map(s=>`<option value="${esc(s.sourceNamespace)}"${s.sourceNamespace===proposedSource?' selected':''}>${esc(s.name)}</option>`).join('')}</select></div>${button('保存来源','source')}</div><p class="import-muted">同一本地库继续使用同一来源，对应会在下次复用。</p>`)}${batch.canTakeover?`<div class="import-impact"><p>当前处理人 ${esc(batch.handlerName)} 已停用。</p><div class="field"><label for="takeover-reason">接管原因</label><textarea id="takeover-reason" rows="2"></textarea></div>${button('接管未完成项目','takeover')}</div>`:''}${state.pendingBatch?`<div class="import-impact"><p>有一次来源或接管操作需要核对结果。</p>${button('核对原操作','batch-query')}${button('重试原操作','batch-retry')}</div>`:''}</section>
    ${catalogAttention.length?`<section aria-label="需处理的共享资料"><h2>这些资料需要核对</h2>${catalogAttention.map(item=>renderCard(item,true)).join('')}</section>`:''}
    ${catalogOthers.length?group(`共享资料（${catalogOthers.length} 条）`,catalogOthers.map(item=>renderCard(item,true)).join('')):''}
    <div class="import-toolbar" aria-label="导入项目范围"><h2>${({attention:'需要处理的项目',ready:'可导入的项目',unchanged:'保持现有内容',processed:'已处理的项目',all:'全部项目'} as Record<string,string>)[view]}（${shown.length}）</h2><button class="head-btn" data-view="all" aria-pressed="${view==='all'}">查看全部</button><div class="field"><label for="import-search">查找本批次项目</label><input id="import-search" type="search" value="${esc(state.search)}" placeholder="输入项目名称"></div></div>
    <section id="import-project-cards" aria-label="项目卡片">${shown.map(item=>renderCard(item)).join('')||`<p class="import-empty">${view==='attention'?'没有需要处理的项目，可以直接导入可处理的内容。':'当前范围没有项目。'}</p>`}</section>`;
  mountReferencePickers(content);bindValues();filterCards();controls();
}
function filterCards() {
  const value = (state.search ?? '').toLocaleLowerCase();
  content.querySelectorAll<HTMLElement>('#import-project-cards [data-card]').forEach(node => { const item = findItem(node.dataset.card!)!; node.hidden = !itemName(item).toLocaleLowerCase().includes(value); });
}
function renderOne(item: Item) {
  const previous=document.getElementById('import-item-'+item.id);
  if(!previous){render();return;}
  const active=document.activeElement;
  const focused=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement||active instanceof HTMLSelectElement?active:null;
  const focusId=focused&&previous.contains(focused)?focused.id:'';
  const selection=focused instanceof HTMLInputElement||focused instanceof HTMLTextAreaElement?[focused.selectionStart,focused.selectionEnd]:null;
  const expanded=[...previous.querySelectorAll<HTMLDetailsElement>('details[open]')].map(node=>node.querySelector('summary')?.textContent);
  previous.outerHTML=renderCard(item,!isProject(item));
  const root=document.getElementById('import-item-'+item.id)!;
  root.querySelectorAll<HTMLDetailsElement>('details').forEach(node=>{if(expanded.includes(node.querySelector('summary')?.textContent))node.open=true;});
  mountReferencePickers(root);bindValues(root);controls();
  const next=focusId?document.getElementById(focusId):null;
  next?.focus({preventScroll:true});
  if(selection&&selection[0]!==null&&selection[1]!==null&&(next instanceof HTMLInputElement||next instanceof HTMLTextAreaElement))try{next.setSelectionRange(selection[0],selection[1]);}catch{}
}
function controls() {
  const ready=data?.items.filter(item=>itemState(item)==='ready') ?? [],count=ready.length;
  content.querySelectorAll<HTMLElement>('.import-counts [data-view] strong').forEach(node=>{
    const status=node.parentElement?.dataset.view;
    node.textContent=String(data?.items.filter(item=>itemState(item)===status).length ?? 0);
  });
  const summary=content.querySelector<HTMLElement>('.import-summary .import-heading>div>p');
  const newCount=ready.filter(item=>(card(item).mode ?? item.mode)==='new').length;
  if(summary)summary.textContent=`可导入项目中，将新增 ${newCount} 个，更新 ${count-newCount} 个。相同内容和仅线上修改的内容保持。`;
  const catalogs=data?.catalogRows.filter(item=>itemState(item)==='ready').length ?? 0;
  saveButton.textContent=busy?'正在导入…':`导入可处理内容（${count} 个项目${catalogs?`、${catalogs} 条资料`:''}）`;
  saveButton.disabled=frozen||busy||!count&&!catalogs||!!state.pendingBatch;
  document.getElementById('imports-reload')!.toggleAttribute('disabled', frozen || busy || loading);
  document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('#imports-entry button,#imports-entry input,#imports-entry select,#imports-batch button,#imports-batch input,#imports-batch select,#imports-batch textarea').forEach(control => {
    const item = findItem(control.dataset.item ?? control.closest<HTMLElement>('[data-card]')?.dataset.card ?? '');
    if (!defaultDisabled.has(control)) defaultDisabled.set(control,control.dataset.action==='adopt-item'?false:control.disabled);
    const matching = !!(control.dataset.mode || control.dataset.target || control.closest('.field')?.querySelector('select[data-target]'));
    control.disabled = !!(defaultDisabled.get(control) || frozen || busy || item && inFlight.has(item.id)
      || data && !data.batch.canEdit && (control.id === 'batch-source' || control.dataset.action === 'source')
      || state.pendingBatch && !['batch-query','batch-retry','full','view-adoption','view-source'].includes(control.dataset.action ?? '')
      || item && control.dataset.action==='adopt-item' && !canImport(item)
      || item && card(item).pending && !['query','retry','full','view-adoption','view-source'].includes(control.dataset.action ?? '')
      || item && !item.canEdit && !['query','retry','full','continue','refresh-item','map','view-adoption','view-source'].includes(control.dataset.action ?? '') && !matching);
  });
}
function setPath(payload: Payload, path: string, value: unknown) {
  const parts = path.split('.'); let target: Values = payload;
  for (const part of parts.slice(0,-1)) { if (target[part] == null) target[part] = {}; target = target[part] as Values; }
  target[parts.at(-1)!] = value;
}
function bindValues(root: ParentNode = content) {
  root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('[data-value-path]').forEach(input => {
    const write = () => { const item = findItem(input.dataset.item!)!, current = card(item); if (locked(item) || !current.editing) return; current.payload ??= structuredClone(item.payload);
      let value: unknown = input.value;
      if (input instanceof HTMLSelectElement && input.multiple) value = [...input.selectedOptions].map(o => o.value).filter(Boolean);
      else if (input.dataset.valueType === 'record-target') value = input.value === '__new' ? null : input.value || undefined;
      else if (input.dataset.valueType === 'number') value = input.value === '' ? null : Number(input.value);
      else if (input.dataset.valueType === 'boolean') value = input.value === '' ? null : input.value === 'true';
      else if (input.dataset.valueType === 'date' || input instanceof HTMLSelectElement) value = input.value || null;
      setPath(current.payload, input.dataset.valuePath!, value);if(current.choices)delete current.choices[editedKey(item,input.dataset.valuePath!)];current.tone='';current.feedback=''; current.editedPaths=[...new Set([...(current.editedPaths ?? []),input.dataset.valuePath!])]; if(current.fieldErrors)delete current.fieldErrors[input.dataset.valuePath!]; current.selected = []; previews.delete(item.id); persist(); schedulePreview(item);
    };
    input.addEventListener(input instanceof HTMLSelectElement ? 'change' : 'input', write);
  });
}
function command(item: Item): Command {
  const current = card(item),mode=current.mode ?? (isProject(item)&&!item.targetId&&!item.needsMapping?'new':undefined);
  return { expectedBatchVersion: data!.batch.version, expectedReviewVersion: item.reviewVersion, expectedVersion: current.expectedVersion === undefined ? item.expectedVersion ?? null : current.expectedVersion, ...(item.basis ? {basis:item.basis} : {}), selected: [...current.selected], keepOnline:keepOnline(item), ...(current.payload ? { payload: correction(item) } : {}), ...(mode?{mode,targetId:mode==='new'?null:current.targetId ?? item.targetId ?? null}:{}), ...(current.intent?.kind ? { intent: structuredClone(current.intent) } : {}), idempotencyKey: crypto.randomUUID() };
}
async function loadOptions() {
  const kinds = ['customers','engineers','productLines','apps','tags','groups','chips'];
  const result = await Promise.allSettled(kinds.map(async kind => { const response = await get<{ items: Values[] }>('/api/catalog/' + kind); catalogue[kind] = response.items; }));
  if (result.some(row => row.status === 'rejected')) notice('部分资料候选尚未读取。原输入保持，请刷新后再核对对应。', true);
}
async function loadProjectOptions() {
  const options: Values[] = []; let page = 1;
  while (true) {
    const result = await get<List>(`/api/projects?view=all&pageSize=100&page=${page}`);
    options.push(...result.items.map(p => ({ id: p.id, name: p.name, version: p.version })));
    if (page >= result.pagination.pageCount || !result.items.length) break;
    page++;
  }
  projectOptions = options;
}
async function loadList() {
  if (loading || frozen) return;
  loading = true; controls();
  try {
    const result = await get<{ batches: BatchBrief[]; sources: Source[] }>('/api/imports');
    batches = result.batches; sources = result.sources;
    selectedSource = state.sourceNamespace && sources.some(s => s.sourceNamespace === state.sourceNamespace) ? state.sourceNamespace : sources.length === 1 ? sources[0].sourceNamespace : '';
    sourceName = state.sourceName ?? '';
    render();
  } catch (error) { notice(explain(error) + ' 请重试读取，当前文件和输入保留。', true); }
  finally { loading = false; controls(); }
}
async function readBatch(id: string, replaceItem?: string, acceptFresh = false) {
  const ticket = ++generation;
  loading = true; controls();
  try {
    const next = await get<BatchData>('/api/imports/' + encodeURIComponent(id));
    if (ticket !== generation || frozen) return false;
    next.items ??= []; next.catalogRows ??= []; next.sources ??= sources;
    const previousId = data?.batch.id ?? state.batchId;
    data = next; sources = next.sources; state.batchId = id;
    const candidates:Item[]=[];
    for (const item of allItems()) {
      item.diffs ??= []; item.issues ??= [];
      const current = card(item), nextBasis = basis(item);
      const nextReferences=referenceBasis(item),serverReferences=current.serverReferenceBasis ?? current.referenceBasis;
      const referencesChanged=!!serverReferences&&serverReferences!==nextReferences;
      const previousReferences=serverReferences?JSON.parse(serverReferences) as unknown[]:[];
      if(!current.pending && previousReferences.length && (previousReferences[0]!==data.batch.sourceNamespace || previousReferences[1]!==item.targetId||item.needsMapping&&referencesChanged)){current.mode=undefined;current.targetId=undefined;current.expectedVersion=undefined;current.intent=undefined;}
      const hadSelection=current.selected.length>0;
      if(referencesChanged && !current.pending)resetReferenceEdits(item);
      if(current.payload && !current.pending)current.payload=correctedPayload(item.payload,correction(item));
      current.referenceBasis=nextReferences;current.serverReferenceBasis=nextReferences;
      if (current.basis !== nextBasis) {
        if (hadSelection || current.editing || current.pending || referencesChanged && current.payload) {
          current.selected = [];
          if (!current.pending) current.feedback = referencesChanged ? '对应信息已更新，人写内容保留；资料与节点对应已按最新内容重新读取，请核对后选择。' : '对应信息已更新，原输入保留。请核对后重新选择。';
          current.stale = !!current.editing && !(replaceItem === item.id && acceptFresh);
        }
        current.basis = nextBasis; previews.delete(item.id);
      }
      if (acceptFresh && (!replaceItem || replaceItem === item.id)) current.stale = false;
      if(!current.pending&&!current.stale&&(current.mode||current.editedPaths?.length||current.intent?.kind)){previews.set(item.id,{issues:[],effects:[],pending:true});candidates.push(item);}else applySelection(item);
    }
    if(previousId!==id)state.view='attention';
    if (previousId !== id) history.replaceState(null, '', '/imports.html?id=' + encodeURIComponent(id));
    persist();render();
    for(const item of candidates)await preview(item);
    return true;
  } catch (error) { notice(explain(error) + ' 原内容保留，读取失败不代表保存失败。', true); return false; }
  finally { if (ticket === generation) { loading = false; controls(); } }
}
function schedulePreview(item: Item) {
  clearTimeout(previewTimers.get(item.id));
  previews.set(item.id,{issues:[],effects:[],pending:true}); controls();
  previewTimers.set(item.id, setTimeout(() => { void preview(item); }, 250));
}
async function preview(item: Item):Promise<void> {
  clearTimeout(previewTimers.get(item.id));
  const current = card(item);
  if (current.pending || current.stale || frozen) { previews.delete(item.id); return; }
  const signature = JSON.stringify([current.selected,current.choices,current.intent,current.basis,current.mode,current.targetId,current.payload]);
  const submittedSelection=JSON.stringify([current.selected,keepOnline(item)]);
  previews.set(item.id, { issues: [], effects: [], pending: true });
  try {
    const result = await send<{ item?: Item; diffs?: Difference[]; issues?: Issue[]; effects?: Effect[]; canEdit?: boolean; canAdopt?: boolean; unchanged?: boolean; expectedVersion?: string | null }>(itemPath(item.id) + '/preview', 'POST', command(item), false);
    if (signature !== JSON.stringify([current.selected,current.choices,current.intent,current.basis,current.mode,current.targetId,current.payload]) || frozen) return;
    if (result.item) {
      const chosenTarget=current.mode==='new'?null:current.targetId ?? item.targetId;
      const choosingTarget=current.mode!==undefined && chosenTarget!==item.targetId;
      if (!choosingTarget && current.referenceBasis !== referenceBasis(result.item)) {
        current.selected=[];current.stale=true;
        feedback(item,'资料或节点对应已变化，正在重新读取；你填写的文字保持。');
        await readBatch(data!.batch.id,item.id,true);
        return;
      }
      if (!choosingTarget && (item.expectedVersion !== result.item.expectedVersion || item.reviewVersion !== result.item.reviewVersion) && current.selected.length) { current.selected = []; current.feedback = '线上内容或待审信息已变化，请核对当前差异后重新选择。'; }
      Object.assign(item, result.item); current.basis = basis(item);current.referenceBasis=referenceBasis(item);
      if(current.payload)current.payload=correctedPayload(item.payload,correction(item));
    }
    if (result.diffs) item.diffs = result.diffs;
    if (result.canEdit !== undefined) item.canEdit = result.canEdit;
    if (result.canAdopt !== undefined) item.canAdopt = result.canAdopt;
    if (result.unchanged !== undefined) item.unchanged = result.unchanged;
    if (result.expectedVersion !== undefined && current.mode === 'existing') current.expectedVersion = result.expectedVersion;
    applySelection(item);current.tone='';
    previews.set(item.id, { issues: result.issues ?? [], effects: result.effects ?? [] });
    persist();
    if(submittedSelection!==JSON.stringify([current.selected,keepOnline(item)]))return preview(item);
  } catch (error) {
    if (signature !== JSON.stringify([current.selected,current.choices,current.intent,current.basis,current.mode,current.targetId,current.payload])) return;
    previews.set(item.id, { issues: [explain(error)], effects: [] });
    current.feedback = explain(error); current.tone = 'error';
  }
  if(current.editing)renderOne(item);else render();
}
async function adopt(item: Item) {
  const current = card(item);
  if(!canImport(item))return;
  current.pending = { path: itemPath(item.id) + '/adopt', queryPath: itemPath(item.id) + '/results/query', action: 'adopt', body: command(item) };
  current.feedback = '正在保存所选信息…'; current.tone = ''; persist(); renderOne(item);
  await performItem(item, false);
}
async function performItem(item: Item, query: boolean) {
  const current = card(item), operation = current.pending;
  if (!operation || frozen || inFlight.has(item.id)) return;
  inFlight.add(item.id);
  ownOperations.add(String(operation.body.idempotencyKey));
  renderOne(item);
  try {
    if (!query) await preference.flush();
    const response = await send<Outcome>(query ? operation.queryPath : operation.path, 'POST', operation.body, !query);
    if (current.pending !== operation || frozen) return;
    if (response.outcome !== 'committed') { feedback(item, '本次结果尚未确认。请核对原结果或重试原保存，前次成功结果保持。'); renderOne(item); return; }
    if (operation.action === 'adopt' && response.result) {
      if (isProject(item) && !item.previousResult) { data!.counts.processed++; data!.counts.pending = Math.max(0,data!.counts.pending-1); }
      item.previousResult = response.result; item.targetId = response.result.projectId ?? response.result.id ?? item.targetId;
    }
    current.pending = nextRequest(operation); current.selected = [];
    if(!operation.recoverOnly){current.editing = false;current.choices=undefined; current.mapping = false; current.payload = undefined; current.editedPaths=undefined; current.intent = undefined; current.mode = undefined; current.targetId = undefined; current.expectedVersion = undefined; current.stale = false; current.continuing = false; current.fieldErrors = undefined;}
    feedback(item, operation.action === 'review' ? '待审修正已保存。核对后选择需要采用的信息。' : isProject(item) ? (Array.isArray(operation.body.selected)&&!operation.body.selected.length?'已保留线上内容，本项已处理。':`本次已采用 ${response.result?.adoptedCount ?? 0} 项。`) : '共享资料已保存。', 'success');
    if (!isProject(item)) await loadOptions();
    if (!await readBatch(data!.batch.id, item.id, true)) { current.stale = true; feedback(item,'保存已成功，最新内容暂未读回。请重新核对这一项，不需要再次保存。','success'); }
  } catch (error) {
    if (current.pending !== operation) return;
    const failure = error instanceof SaveError ? error : new SaveError('TRANSPORT_UNKNOWN','unknown');
    if (failure.outcome === 'not_committed' && failure.code !== 'OPERATION_KEY_REUSED') current.pending = nextRequest(operation);
    if (/VERSION|BINDING|MAPPING_CHANGED/.test(failure.code)) current.stale = true;
    if (/AUTH_|PASSWORD_CHANGE|CSRF/.test(failure.code)) frozen = true;
    current.fieldErrors = failure.fields;
    feedback(item, failure.outcome === 'unknown' ? '本次保存结果待确认。输入和原操作已保留，前次成功结果保持。' : explain(failure) + (failure.fields ? '\n' + [...new Set(Object.values(failure.fields))].join('\n') : ''), failure.outcome === 'unknown' ? '' : 'error');
    persist(); renderOne(item);
  } finally { inFlight.delete(item.id); const next = findItem(item.id); if (next) renderOne(next); }
}
async function saveSelected() {
  if(busy||frozen||state.pendingBatch)return;
  const projects=data!.items.filter(item=>itemState(item)==='ready').map(item=>item.id);
  const catalogs=data!.catalogRows.filter(item=>itemState(item)==='ready').map(item=>item.id);
  if(!projects.length&&!catalogs.length)return;
  busy=true;controls();let completed=0;
  try {
    const remaining=new Set(catalogs);
    while(remaining.size&&!frozen){
      const item=data!.catalogRows.find(item=>remaining.has(item.id)&&canImport(item));
      if(!item)break;
      remaining.delete(item.id);await preview(item);const next=findItem(item.id);if(next&&canImport(next))await adopt(next);
      await readBatch(data!.batch.id,undefined,true);
    }
    for(const id of projects){
      if(frozen)break;
      const item=findItem(id);if(!item||card(item).pending)continue;
      await preview(item);
      const next=findItem(id);if(next&&canImport(next))await adopt(next);
      completed++;
      document.getElementById('imports-save-status')!.textContent=`已核对 ${completed} / ${projects.length} 个项目。成功内容保留，有问题的留在原卡。`;
    }
  } finally {busy=false;state.view='attention';render();}
}
async function batchOperation(operation: Pending, query = false) {
  if (frozen) return;
  state.pendingBatch = operation; persist(); busy = true; controls();
  try {
    if (!query) await preference.flush();
    const response = await send<Outcome>(query ? operation.queryPath : operation.path, 'POST', operation.body, !query);
    if (response.outcome !== 'committed') { notice('原操作结果尚未确认，请继续核对，输入保持。'); return; }
    state.pendingBatch = nextRequest(operation);
    if (operation.action === 'createSource' && response.result?.sourceNamespace) { selectedSource = response.result.sourceNamespace; state.sourceNamespace = selectedSource; }
    persist(); notice(operation.action === 'takeover' ? '已保存接管，请核对剩余项目。' : '已保存。');
    if (data) await readBatch(data.batch.id); else await loadList();
    return response;
  } catch (error) {
    if (error instanceof SaveError && error.outcome === 'not_committed' && error.code !== 'OPERATION_KEY_REUSED') state.pendingBatch = nextRequest(operation);
    notice(explain(error), true); persist();
  } finally { busy = false; render(); }
}
async function upload(query = false, retry = false, allowDuplicate = false) {
  if (busy || frozen) return;
  if (state.pendingBatch) { notice('请先核对原批次操作结果。', true); return; }
  let operation = state.pendingUpload;
  if (!operation) {
    if (!file) { notice('请选择备份文件。', true); return; }
    if (!selectedSource) {
      if (!sourceName.trim()) { notice('请填写来源名称，便于下次复用对应。', true); return; }
      const response = await batchOperation({ path: '/api/imports/sources', queryPath: '/api/imports/results/query', action: 'createSource', body: { name: sourceName.trim(), idempotencyKey: crypto.randomUUID() } });
      if (!response?.result?.sourceNamespace) return;
      selectedSource = response.result.sourceNamespace; state.sourceNamespace = selectedSource; persist();
    }
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(n => n.toString(16).padStart(2,'0')).join('');
    const matches = batches.filter(batch => batch.fileHash === hash && batch.sourceNamespace === selectedSource);
    if (matches.length && !allowDuplicate) {
      duplicateBatches = matches; document.getElementById('import-duplicate')!.innerHTML = duplicateNotice(); return;
    }
    duplicateBatches = [];
    operation = state.pendingUpload = { idempotencyKey: crypto.randomUUID(), name: file.name, sourceNamespace: selectedSource, hash, size: file.size, allowDuplicate };
    persist();
  }
  if (!query && (!file || file.size !== operation.size || [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(n => n.toString(16).padStart(2,'0')).join('') !== operation.hash)) { notice('请重新选择原备份文件，再重试原读取。不能用另一个文件替换待确认操作。', true); return; }
  busy = true; notice(query ? '正在核对原读取结果…' : '正在读取并登记备份…'); controls();
  try {
    if (!query) await preference.flush();
    const response = query ? await send<Outcome>('/api/imports/results/query','POST',{idempotencyKey:operation.idempotencyKey},false) : await sendFile<Outcome>('/api/imports/upload?' + new URLSearchParams({ source: operation.sourceNamespace, name: operation.name, operation: operation.idempotencyKey, ...(operation.allowDuplicate ? {new:'1'} : {}) }), file!);
    if (response.outcome !== 'committed' || !response.result?.batchId) { notice('登记结果尚未确认，请核对原结果。原文件未被修改。'); return; }
    state.pendingUpload = nextRequest(operation); persist();
    if (response.result.reused) { duplicateBatches = [{ id:response.result.batchId, name: operation.name }]; notice('找到了同一文件的原批次。'); return; }
    file = undefined; notice('备份已读取并自动核对。可以一次导入可处理的内容。');
    await readBatch(response.result.batchId);
  } catch (error) {
    if (error instanceof SaveError && error.outcome === 'not_committed' && error.code !== 'OPERATION_KEY_REUSED') state.pendingUpload = nextRequest(operation);
    notice(explain(error), true); persist();
  } finally { busy = false; render(); }
}

document.addEventListener('change', event => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  if (frozen || busy) return;
  const id = target.dataset.item ?? target.dataset.editGroup ?? target.dataset.mode ?? target.dataset.target;
  const item = id ? findItem(id) : undefined;
  if (!item) return;
  const current = card(item);
  if (current.pending) return;
  if(target.dataset.editGroup){current.editGroup=target.value;persist();renderOne(item);}
  else if (target.dataset.mode || target.dataset.target) {
    current.mapping = true; current.selected = [];current.choices=undefined; previews.delete(item.id);
    resetReferenceEdits(item);
    if (target.dataset.mode) { current.mode = target.value ? target.value as 'new' | 'existing' : undefined; current.targetId = null; current.expectedVersion = null; }
    else {
      current.mode = 'existing'; current.targetId = target.value || null;
      const option = (isProject(item) ? projectOptions : catalogue[catalogKinds[item.kind] ?? item.kind] ?? []).find(o => String(o.id) === target.value);
      current.expectedVersion = option?.version ? String(option.version) : null;
    }
    persist(); renderOne(item);
    if (isProject(item) && current.mode === 'existing' && !projectOptions.length) void loadProjectOptions().then(() => renderOne(item)).catch(error => { feedback(item,explain(error),'error'); renderOne(item); });
    if (current.mode === 'new' || current.targetId) schedulePreview(item);
  } else if (target.dataset.intent === 'kind') {
    current.intent ??= {kind:'',reason:''}; current.intent.kind = target.value; persist(); schedulePreview(item);
  } else if (target.dataset.intent === 'reason') schedulePreview(item);
});
document.addEventListener('input', event => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'import-search') {
    state.search = target.value; persist();
    filterCards();
  }
  if (target.dataset.intent === 'reason' && target.dataset.item) {
    const item = findItem(target.dataset.item)!; if (locked(item)) return;
    card(item).intent ??= {kind:'',reason:''}; card(item).intent!.reason = target.value; persist();
  }
});
document.addEventListener('click', event => {
  const control = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action],button[data-view],button[data-choice]');
  if (!control || control.disabled || frozen) return;
  if (control.dataset.view) { state.view = control.dataset.view; persist(); render(); return; }
  const action = control.dataset.action!, item = control.dataset.item ? findItem(control.dataset.item) : undefined;
  void (async () => {
    if (action === 'upload') return upload();
    if (action === 'upload-query') return upload(true);
    if (action === 'upload-retry') return upload(false,true);
    if (action === 'upload-new') return upload(false,false,true);
    if (action === 'batch-query' || action === 'batch-retry') { if (state.pendingBatch) await batchOperation(state.pendingBatch,action === 'batch-query'); return; }
    if (action === 'source' && data) {
      const sourceNamespace = (document.getElementById('batch-source') as HTMLSelectElement).value;
      if (sourceNamespace === data.batch.sourceNamespace) return notice('来源没有变化。');
      return batchOperation({ path: `/api/imports/${data.batch.id}/source`, queryPath: `/api/imports/${data.batch.id}/source/results/query`, action: 'source', body: {expectedVersion:data.batch.version,sourceNamespace,idempotencyKey:crypto.randomUUID()} });
    }
    if (action === 'takeover' && data) {
      const reason = (document.getElementById('takeover-reason') as HTMLTextAreaElement).value.trim();
      if (!reason) return notice('请填写接管原因。', true);
      return batchOperation({ path: `/api/imports/${data.batch.id}/takeover`, queryPath: `/api/imports/${data.batch.id}/takeover/results/query`, action: 'takeover', body: {expectedVersion:data.batch.version,reason,idempotencyKey:crypto.randomUUID()} });
    }
    if (!item) return;
    const current = card(item);
    if (action === 'query' || action === 'retry') return performItem(item, action === 'query');
    if (action === 'full') { current.full = !current.full; persist(); renderOne(item); return; }
    if (action === 'view-source') { sourceSnapshots.set(item.id,await get<{source:Values;issues:Issue[]}>(itemPath(item.id) + '/source')); renderOne(item); return; }
    if (action === 'view-adoption') { const id = control.dataset.adoption!; adoptionSnapshots.set(item.id+':'+id,await get<{adoption:Values;histories:Payload['histories']}>(itemPath(item.id) + '/adoptions/' + encodeURIComponent(id))); renderOne(item); return; }
    if (current.pending || busy) return;
    if(control.dataset.choice){const diff=leaves(item).find(diff=>diff.key===control.dataset.choice);if(!diff||!item.canAdopt)return;current.choices ??={};current.choices[diff.key]={value:control.dataset.choiceValue as 'source'|'online',basis:choiceBasis(diff)};current.tone='';current.feedback='';applySelection(item);persist();renderOne(item);schedulePreview(item);return;}
    if (action === 'edit') { current.payload ??= structuredClone(item.payload); current.editedPaths ??= []; current.editing = true; current.editGroup ??= suggestedGroup(item); await loadOptions(); persist(); renderOne(item); }
    if (action === 'cancel-edit') { current.editing = false; current.payload = undefined; current.editedPaths=undefined; persist(); await readBatch(data!.batch.id,item.id,true); }
    if(action==='finish-edit'){current.editing=false;persist();await preview(item);return;}
    if(action==='new-catalog'){current.mode='new';current.targetId=null;current.expectedVersion=null;current.mapping=false;persist();await preview(item);return;}
    if(action==='existing-catalog'){current.mode='existing';current.targetId=null;current.mapping=true;await loadOptions();persist();renderOne(item);return;}
    if (action === 'map') { if (isProject(item) && !projectOptions.length) await loadProjectOptions(); else if (!isProject(item)) await loadOptions(); current.mapping = true; if(!item.needsMapping&&(item.targetId||isProject(item)))current.mode = item.mode; current.targetId = item.targetId; current.expectedVersion = item.expectedVersion; renderOne(item); }
    if (action === 'continue' || action === 'refresh-item') {
      current.selected = [];current.choices=undefined; current.intent = undefined;
      if (action === 'continue') current.continuing = true;
      const refreshed = await readBatch(data!.batch.id,item.id,true);
      const next = findItem(item.id); if(next&&refreshed)card(next).tone=''; if (next) { card(next).feedback = refreshed ? '已重新读取，请核对当前信息后选择。' : '最新内容未能读取，原结果保持。请重试重新核对。'; if(!refreshed)card(next).stale = true; renderOne(next); }
    }
    if (action === 'select-dependencies') {
      const preview = previews.get(item.id), keys = [...(item.issues ?? []), ...(preview?.issues ?? []), ...(preview?.effects ?? [])].flatMap(issue => typeof issue === 'object' ? issue.requiredKeys ?? [] : []);
      current.choices ??={};for(const key of selectionKeys(item,keys)){const diff=leaves(item).find(diff=>diff.key===key);if(diff?.selectable)current.choices[key]={value:'source',basis:choiceBasis(diff)};}applySelection(item);persist();renderOne(item);schedulePreview(item);
    }
    if(action==='adopt-item'){busy=true;controls();try{await preview(item);const next=findItem(item.id);if(next&&canImport(next))await adopt(next);}finally{busy=false;render();}}
  })().catch(error => { if (item) { feedback(item,explain(error),'error'); renderOne(item); } else notice(explain(error),true); });
});

saveButton.onclick = () => { void saveSelected(); };
document.getElementById('imports-reload')!.onclick = () => { void (data ? readBatch(data.batch.id) : loadList()); };
window.addEventListener('beforeunload', event => { if (state.pendingUpload || state.pendingBatch || Object.values(state.cards ?? {}).some(card => card.editing || card.pending)) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('geekdash-identity-changed', () => { frozen = true; notice('账号已变化，已停止保存。请重新登录原账号，继续核对本批次。输入保持。',true); controls(); });
document.addEventListener('geekdash-login-leave', () => { persist(); });
setupTheme();
void requireIdentity().then(async () => {
  preference = new PersonalPreference('imports', text => notice(text));
  const stored = await preference.load();
  let local: PageState | undefined, localVersion: string | undefined;
  try { const cached = JSON.parse(localStorage.getItem(key()) ?? 'null'); local = cached?.state ?? cached ?? undefined; localVersion=cached?.baseVersion; } catch { notice('本机恢复信息无法读取，将读取已保存的批次。'); }
  const localCurrent=!!local && localVersion!==undefined && localVersion===preference.revision();
  state = localCurrent ? {...stored,...local,cards:{...(stored.cards as Record<string,CardState> ?? {}),...local?.cards}} : {...stored,cards:{...(stored.cards as Record<string,CardState> ?? {})}};
  if(local && !localCurrent) {
    for(const [id,copy] of Object.entries(local.cards ?? {})) {
      const current=state.cards![id] ??= {basis:'',selected:[]};
      if(copy.payload)current.localCopy=copy.payload;
      const recover=copy.pending?{...copy.pending,recoverOnly:true,queue:copy.pending.queue?.map(request=>({...request,recoverOnly:true}))}:undefined;
      current.pending=retainRequests(current.pending,recover,request=>request.body.idempotencyKey);
    }
    state.pendingUpload=retainRequests(state.pendingUpload,local.pendingUpload,request=>request.idempotencyKey);
    state.pendingBatch=retainRequests(state.pendingBatch,local.pendingBatch,request=>request.body.idempotencyKey);
  }
  selectedSource = state.sourceNamespace ?? ''; sourceName = state.sourceName ?? '';
  await Promise.all([loadList(),loadOptions()]);
  const id = new URLSearchParams(location.search).get('id');
  if (id) await readBatch(id);
  if (state.pendingUpload && !data) notice('上次文件登记结果尚未确认，请核对原读取结果。');
  if (data) for (const item of allItems()) if (card(item).pending) await performItem(item,true);
  new ProjectNotifications(event => {
    if (!data || frozen) return;
    if (ownOperations.has(event.operationId)) return;
    for (const item of data.items.filter(item => item.targetId === event.projectId && item.expectedVersion !== event.version)) {
      const current = card(item); current.stale = true; current.selected = []; feedback(item,'项目已被他人更新，请重新核对导入信息。'); renderOne(item);
    }
  }, () => {}, text => { if (text) notice(text); }, undefined, undefined, event => {
    if (event.resource !== 'catalog' || !data || frozen) return;
    if (ownOperations.has(event.operationId)) return;
    void loadOptions();
    for (const item of allItems()) { const current = card(item); if (current.selected.length || current.editing) { current.stale = true; current.selected = []; feedback(item,'共享资料已更新，请核对当前对应后重新选择。'); renderOne(item); } }
  });
}).catch(error => { notice(explain(error),true); });
