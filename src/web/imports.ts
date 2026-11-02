import {chipPicker,bindChipPicker} from './shared/chip-picker';
import type {Catalog,ChipSelection} from './shared/api';
import './shared/board.css';
import './shared/read.css';
import './shared/reference-picker.css';
import './shared/imports.css';
import './shared/design.css';
import { account, esc, get, label, requireIdentity, SaveError, send, sendFile, setupTheme, type List } from './shared/api';
import { PersonalPreference } from './shared/personal-state';
import { mountReferencePickers } from './shared/reference-picker';
import { ProjectNotifications } from './shared/notifications';
import { saveMembership } from './shared/membership';

type Values = Record<string, unknown>;
type Difference = { key: string; label: string; before: unknown; after: unknown; selectable: boolean; issues?: Issue[]; status?: 'normal'|'conflict'|'needs_choice'|'keep_online'; defaultSelected?: boolean; members?: Difference[] };
type Issue = string | { code?: string; message?: string; key?: string; field?: string; path?: string; requiredKeys?: string[]; cause?: string; consequence?: string };
type Effect = string | { cause?: string; consequence?: string; message?: string; requiredKeys?: string[] };
type Result = { projectId?: string; id?: string; batchId?: string; reused?: boolean; sourceNamespace?: string; name?: string; savedVersion?: string; adoptionId?: string; adoptedCount?: number; notAdoptedCount?: number; changed?: boolean; operationId?: string };
type Outcome = { outcome: string; result?: Result };
type RecordValue = { key: string; kind: string; sourceKey: string | null; targetId?: string | null; values: Values };
type Payload = Values & { fields?: Values; people?: Record<string, string[]>; stages?: Values[]; records?: RecordValue[]; histories?: Record<string, unknown[]>; statusEntries?: { text: string; date: string | null }[]; lastCheckAt?: unknown };
type Item = { targetDeleted?:boolean; deletedVersion?:string|null; ignored?:boolean; id: string; kind: string; reviewVersion: string; basis?: string; referenceBasis: string; sourceKey?: string; payload: Payload; canEdit: boolean; canAdopt: boolean; targetId?: string | null; expectedVersion?: string | null; mode: 'new' | 'existing'; diffs: Difference[]; issues: Issue[]; sourceIssues?: Issue[]; extraSource?: Values; unchanged?: boolean; previousResult?: Result | null; adoptions?: Values[]; candidates?: { id: string; name: string; version: string; enabled?:boolean }[]; name?: string; sourceName?: string; bindingVersion?: string; restricted?:boolean; basic?:Values; pendingInvitations?:string[]; managers?:{name:string;targetId:string|null;status:string;candidates:{id:string;name:string}[]}[]; target?: Values; classification?:'ready'|'unchanged'|'needs_attention'; defaultSelected?:string[]; conflictKeys?:string[]; keptOnline?:boolean;needsMapping?:boolean; unresolvedReferences?:{path:string;itemIds:string[]}[] };
type Batch = { id: string; name: string; sourceNamespace: string; version: string; handlerId: string; handlerName: string; handlerEnabled: boolean; canTakeover: boolean; canEdit: boolean; uploaderName?: string; filename?: string; uploadedAt?: string };
type BatchData = { batch: Batch; counts: { total: number; pending: number; processed: number; unchanged: number }; catalogRows: Item[]; items: Item[];  };
type BatchBrief = Partial<Batch> & { id: string; name: string; fileHash?: string; filename?: string; pending?: number; processed?: number; total?: number; createdAt?: string };
type Command = { expectedBatchVersion: string; expectedReviewVersion: string; expectedVersion: string | null; basis?: string; selected?: string[]; keepOnline?:string[]; intent?: { kind: string; reason: string }; managerMatches?:Record<string,string>; idempotencyKey: string; payload?: Payload; mode?: 'new' | 'existing'; targetId?: string | null };
type Pending = { itemId?:string; path: string; body: Command | Values; action: 'review' | 'adopt' | 'source' | 'takeover' | 'createSource' | 'ignore' | 'restoreProject' | 'restoreCatalog'; queryPath: string; recoverOnly?: boolean; queue?: Pending[]; advance?: boolean };
type CardState = { executionFeedbackId?:string; diagnostic?:{code:string;requestId?:string}; basis: string; referenceBasis?: string; serverReferenceBasis?:string; selected: string[]; choices?:Record<string,{value:'source'|'online';basis:string}>; included?:boolean; managerMatches?:Record<string,string>; editing?: boolean; full?: boolean; mapping?: boolean; payload?: Payload; editedPaths?: string[]; localCopy?: Payload; mode?: 'new' | 'existing'; targetId?: string | null; expectedVersion?: string | null; intent?: { kind: string; reason: string }; pending?: Pending; feedback?: string; fieldErrors?: Record<string,string>; tone?: string; stale?: boolean; continuing?: boolean };
type UploadState = { idempotencyKey: string; name: string; sourceNamespace?: string; hash: string; size: number; allowDuplicate: boolean; queue?: UploadState[] };
type ExecutionRequest={waitingIds?:string[];body:{formatVersion?:number;stage?:'catalogs'|'projects';idempotencyKey:string;items:{id:string;command:Command;resolveReferences:boolean}[]};advance?:string};
type Execution={id:string;status:string;operationId:string;operationIds:string[];canResume?:boolean;resumeMode?:'continue'|'reconcile';unfinished?:Execution[];items:{id:string;kind:string;status?:string;result?:Outcome['result'];code?:string;message?:string;fields?:Record<string,string>}[]};
type PageState = { executions?:Record<string,ExecutionRequest>; batchId?: string; sourceNamespace?: string; view?: string; search?: string; activeItemId?: string; catalogItemId?: string; cards?: Record<string, CardState & { reviewing?: boolean; skipped?: boolean }>; pendingUpload?: UploadState; pendingBatch?: Pending; sourceName?: string };
type Field = { key: string; title: string; type?: 'date' | 'number' | 'text' | 'textarea' | 'select' | 'reference' | 'boolean'; options?: string[]; catalog?: string; multiple?: boolean; wide?: boolean };

const kindNames: Record<string, string> = { project: '项目', odmFactories:'ODM 工厂', customers: '客户', engineers: '工程师', productLines: '产品线', product_lines: '产品线', apps: 'APP', tags: '标签', company: '企业信息', groups: '分组', project_groups: '分组', chips: '芯片', project_node: '项目节点', customer_node: '客户节点', risk: '风险', change: '需求变更', schedule: '计划记录' };
const catalogKinds: Record<string, string> = { product_lines: 'productLines', project_groups: 'groups' };
const basicFields: Field[] = [
  { key: 'name', title: '项目名称' }, { key: 'status', title: '项目状态', type: 'select', options: ['proposal','ongoing','paused','closed'] }, { key: 'summary', title: '项目简介', type: 'textarea', wide: true },
  { key: 'customerIds', title: '客户', type: 'reference', catalog: 'customers', multiple: true }, { key: 'productLineIds', title: '产品线', type: 'reference', catalog: 'productLines', multiple: true }, { key: 'odmFactoryIds', title: 'ODM 工厂', type: 'reference', catalog: 'odmFactories', multiple: true }, { key: 'appIds', title: 'APP', type: 'reference', catalog: 'apps', multiple: true }, { key: 'groupIds', title: '分组', type: 'reference', catalog: 'groups', multiple: true }, { key: 'chipSelections', title: '芯片', type: 'reference', catalog: 'chips', multiple: true }, { key: 'tagIds', title: '项目标签', type: 'reference', catalog: 'tags', multiple: true },
  { key: 'filingDate', title: '立案日期', type: 'date' }, { key: 'startDate', title: '实际启动日期', type: 'date' }, { key: 'dueDate', title: '预计结案日期', type: 'date' }, { key: 'closedOn', title: '实际结案日期', type: 'date' }, { key: 'priority', title: '优先级', type: 'select', options: ['high','mid','low'] }, { key: 'marketExpectation', title: '市场预期', type: 'textarea' }, { key: 'detailNote', title: '详细说明', type: 'textarea' },
];
const extraFields: Field[] = [{ key: 'proposalDate', title: '提案日期', type: 'date' }, { key: 'originalDueDate', title: '原始计划结案日期', type: 'date' }, { key: 'closureDueDate', title: '结案时计划', type: 'date' }, { key: 'closureType', title: '结案类型', type: 'select', options: ['normal','terminated'] }, { key: 'resumeStatus', title: '暂缓前状态', type: 'select', options: ['proposal','ongoing'] }, { key: 'preCloseStatus', title: '结案前状态', type: 'select', options: ['proposal','ongoing','paused'] }, { key: 'closureNote', title: '结案说明', type: 'textarea' }, { key: 'remainingWorkNote', title: '遗留处置说明', type: 'textarea' }, { key: 'maintenanceEnabled', title: '结案后维护', type: 'boolean' }];
const stageFields: Field[] = [{ key: 'state', title: '阶段状态', type: 'select', options: ['unknown','locked','ready','active','completed'] }, { key: 'plannedDays', title: '工期（天）', type: 'number' }, { key: 'startedOn', title: '实际开始', type: 'date' }, { key: 'completedOn', title: '实际完成', type: 'date' }, { key: 'expectedEndOn', title: '本地原预计完成', type: 'date' }, { key: 'note', title: '阶段评述', type: 'textarea', wide: true }];
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
errors.IMPORT_EXECUTION_OWNER_REQUIRED='仅原操作人或已接管批次的处理人可以继续核对。';
Object.assign(errors,{IMPORT_FORMAT_INVALID:'无法读取此备份，请选择完整的 GeekDash 备份文件。',IMPORT_ENCODING_INVALID:'文件编码无法读取，请重新从本地面板导出备份。',IMPORT_VERSION_UNSUPPORTED:'此备份结构版本暂不支持，请核对来源。',IMPORT_FILE_EMPTY:'文件为空，请重新选择完整备份。',IMPORT_FILE_TOO_LARGE:'文件超出允许大小，请保留原文件并联系维护人员。',IMPORT_REVIEW_REQUIRED:'请修正本卡标出的信息。',IMPORT_HANDLER_REQUIRED:'首次入库项目由本批次当前处理人修正和提交。',PROJECT_RESPONSIBILITY_REQUIRED:'你不是这个项目的项目经理，当前只能查看。',IMPORT_HANDLER_ACTIVE:'当前处理人仍在使用账号，不能接管此批次。',IMPORT_TAKEOVER_REASON_REQUIRED:'请填写接管原因。',IMPORT_BINDING_CHANGED:'来源或资料对应已更新，请重新核对当前差异。',IMPORT_SELECTION_CHANGED:'所选信息已变化，请重新核对后选择。',IMPORT_SELECTION_REQUIRED:'请选择需要采用的信息。',IMPORT_WRITES_PAUSED:'导入保存暂时暂停，输入保持，请稍后重试原操作。'});

let data: BatchData | undefined, batches: BatchBrief[] = [], state: PageState = { cards: {} };
let preference: PersonalPreference, frozen = false, busy = false, loading = false, generation = 0, file: File | undefined;
let executionActive=false,polling=false,executionFeedback='',pausedExecution:string|undefined;
let executionReadFailed=false;
let serverExecutions:Execution[]=[],activeOperation:string|undefined;
const seenExecutions=new Map<string,string>();
let catalogue: Record<string, Values[]> = {}, projectOptions: Values[] = [];
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
const readableError=(text:string)=>text.replace(/CATALOG_NAME_CONFLICT/g,'已有同名资料，请在本条选择已有资料或修改名称。').replace(/IMPORT_REFERENCE_REQUIRED/g,'引用的资料需要处理');
const issueText = (issue: Issue | Effect) => typeof issue === 'string' ? errors[issue]??readableError(issue) : readableError(issue.message ?? ([issue.cause, issue.consequence].filter(Boolean).join('：') || ('code' in issue ? errors[issue.code??''] : '') || '这项信息尚不能保存，请在本卡核对并修正。'));
const explain = (error: unknown) => error instanceof SaveError&&error.code==='CATALOG_NAME_CONFLICT'?'已有同名资料，请使用已有资料或改名后导入。':error instanceof SaveError ? errors[error.code] ?? error.message : (error as Error).message;
const key = () => `geekdash_imports:${account!.id}`;
const diagnostic=(problem:unknown)=>problem instanceof SaveError?{code:problem.code,requestId:problem.requestId}:undefined;
const diagnosticMarkup=(value?:{code:string;requestId?:string})=>value?`<details class="import-diagnostic"><summary>排查信息</summary><p>错误编号：${esc(value.code)}${value.requestId?'；请求编号：'+esc(value.requestId):''}</p></details>`:'';
function notice(text: string, error = false, problem?:unknown) { message.textContent = text; message.classList.toggle('error', error);if(problem)message.insertAdjacentHTML('beforeend',diagnosticMarkup(diagnostic(problem))); }
function basis(item: Item) { return JSON.stringify([data!.batch.version, data!.batch.sourceNamespace, item.reviewVersion, item.targetId, item.expectedVersion, item.bindingVersion, item.basis]); }
const referenceFields = ['customerIds','odmFactoryIds','productLineIds','appIds','groupIds','chipSelections','tagIds'];
function referenceBasis(item: Item) { return JSON.stringify([data!.batch.sourceNamespace,item.targetId,item.bindingVersion,item.referenceBasis]); }
function card(item: Item) { return state.cards![item.id] ??= { basis: basis(item), referenceBasis:referenceBasis(item),serverReferenceBasis:referenceBasis(item), selected: [] }; }
const leaves=(item:Item)=>item.diffs.flatMap(diff=>diff.members?.length?diff.members:[diff]);
const selectionKeys=(item:Item,keys:string[])=>keys.flatMap(key=>{const group=item.diffs.find(diff=>diff.key===key);return group?.members?.length?group.members.filter(diff=>diff.selectable).map(diff=>diff.key):[key];});
const choiceBasis=(diff:Difference)=>JSON.stringify([diff.before,diff.after]);
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

function itemIssues(item:Item) { const preview=previews.get(item.id);return preview&&!preview.pending?preview.issues:item.issues ?? []; }
function canImport(item:Item) {
  const current=card(item);
  if(item.targetDeleted||item.ignored||item.needsMapping||itemAwaitingResult(item))return false;
  const inviting=!!item.pendingInvitations?.length||Object.keys(current.managerMatches??{}).length>0;
  return (item.canAdopt||item.canEdit&&inviting)&&!frozen&&!current.pending&&!current.stale&&!previews.get(item.id)?.pending&&(!item.previousResult||current.continuing)&&!itemIssues(item).length&&(current.selected.length>0||inviting);
}
function waitingForCatalog(item:Item,visited=new Set<string>()):boolean {
  const current=card(item),issues=itemIssues(item);
  if(!item.canEdit||current.pending||current.stale||previews.get(item.id)?.pending||visited.has(item.id)||!issues.length)return false;
  if(item.ignored||item.needsMapping)return false;
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
const canApprove=(item:Item)=>canImport(item)||!isProject(item)&&card(item).selected.length>0&&waitingForCatalog(item);
const step=()=>state.view==='projects'?'projects':'catalogs';
function pausedRequests(){
  const requests=new Map(Object.entries(state.executions??{}).filter(([id])=>id.startsWith((data?.batch.id??'')+':')).map(([,request])=>[request.body.idempotencyKey,{operationId:request.body.idempotencyKey,items:request.waitingIds??request.body.items.map(row=>row.id),canResume:true,resumeLabel:'继续本次操作'}]));
  for(const execution of serverExecutions.filter(value=>value.status==='paused'))requests.set(execution.operationId,{operationId:execution.operationId,items:execution.items.filter(row=>row.status==='confirming'||row.status==='waiting').map(row=>row.id),canResume:execution.canResume===true,resumeLabel:execution.resumeMode==='reconcile'?'核对并结束原操作':'继续本次操作'});
  return [...requests.values()];
}
const itemAwaitingResult=(item:Item)=>pausedRequests().some(request=>request.items.includes(item.id));
function selectedItems() {
  return (step()==='projects'?data?.items??[]:data?.catalogRows??[]).filter(item=>{
    const current=card(item);
    return (!item.previousResult||current.continuing)&&current.included!==false&&canApprove(item);
  });
}
function referenceDependencies(item:Item,seen=new Set<string>()):Item[] {
  if(seen.has(item.id))return [];
  seen.add(item.id);
  const paths=itemIssues(item).flatMap(issue=>typeof issue==='object'&&issue.code==='IMPORT_REFERENCE_REQUIRED'?[issue.path ?? issue.field]:[]);
  const direct=data?.catalogRows.filter(row=>item.unresolvedReferences?.some(ref=>paths.includes(ref.path)&&ref.itemIds.includes(row.id))) ?? [];
  return [...new Map(direct.flatMap(row=>[...referenceDependencies(row,seen),row]).map(row=>[row.id,row])).values()];
}
function itemState(item:Item) {
  if(item.ignored)return 'ignored';
  if(item.targetDeleted)return 'attention';
  if(card(item).pending||card(item).stale||card(item).tone==='error')return 'attention';
  if(itemIssues(item).length)return 'attention';
  if(item.previousResult&&!card(item).continuing&&!item.targetDeleted)return 'processed';
  if(!item.pendingInvitations?.length&&(item.unchanged||item.keptOnline||item.classification==='unchanged'))return 'unchanged';
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
  const dependent=(key:string)=>key==='binding'||key.startsWith('people.')||referenceFields.some(field=>key==='fields.'+field||key===field)||/^record\..+\.(previousNodeId|nextNodeId)$/.test(key);
  current.selected=current.selected.filter(key=>!dependent(key));
  if(current.choices)current.choices=Object.fromEntries(Object.entries(current.choices).filter(([key])=>!dependent(key)));
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
function feedback(item: Item, text: string, tone = '', problem?:unknown) { Object.assign(card(item), { feedback: text, tone,diagnostic:diagnostic(problem) }); persist(); }
function locked(item?: Item) { return frozen || busy || executionActive || !!(item && (card(item).pending||itemAwaitingResult(item))); }
function readable(value: unknown, name = '', references = true, recordKind = '', records: RecordValue[] = []): string {
  if(name==='tasks'&&Array.isArray(value))return value.map(task=>`${task.deletedAt?'已删除':task.completedAt?'已完成':'待完成'}：${task.text}`).join('\n')||'无任务';
  if (value === undefined) return '来源未提供';
  if (value === null || value === '') return '未填写';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if(references&&name==='chipSelections'&&Array.isArray(value))return value.map(item=>{const chip=item as Values;return String(catalogue.chips?.find(c=>String(c.id)===String(chip.chipId))?.name??chip.chipId)+(chip.note?'（'+chip.note+'）':'');}).join('、');
  if (Array.isArray(value)) return value.length ? value.map(v => readable(v, name,references,recordKind,records)).join('\n') : '空名单';
  if (typeof value === 'object') return Object.entries(value as Values).filter(([k]) => !['id','key','sourceKey','targetId','version','actorId','sortOrder'].includes(k)).map(([k, v]) => `${recordFields[recordKind]?.find(field=>field.key===k)?.title ?? titles[k] ?? k}：${readable(v, k,references,recordKind,records)}`).join('\n');
  if (references && ['previousNodeId','nextNodeId'].includes(name)) { const match=records.find(record=>record.kind==='project_node' && (String(value).startsWith('source:') ? record.sourceKey===String(value).slice(7) : record.targetId===String(value))); if(match?.values.title)return String(match.values.title); }
  if (references && (name.endsWith('Id') || name.endsWith('Ids') || ['hardware_owner','software_owner','participant','pm'].includes(name))) { const kind = ({customerIds:'customers',odmFactoryIds:'odmFactories',productLineIds:'productLines',appIds:'apps',groupIds:'groups',chipSelections:'chips',tagIds:'tags',hardware_owner:'engineers',software_owner:'engineers',participant:'engineers',pm:'engineers'} as Record<string,string>)[name]; const match = (catalogue[kind] ?? []).find(item => String(item.id) === String(value)); if (match) return String(match.name); }
  return label(value);
}
function renderEntry() {
  entry.hidden=!!data;list.hidden=!!data;if(data)return;
  entry.innerHTML=`<section class="import-panel import-upload"><h2>上传本地备份</h2><p class="import-muted">选择文件后显示新增项目与已有项目差异，确认后入库。</p><label class="head-btn import-file-pick">选择备份文件<input type="file" id="import-file" accept=".bak,.json,application/json"></label><span class="import-muted">${esc(file?.name??state.pendingUpload?.name??'支持 .bak 和 .json')}</span>${state.pendingUpload?`<div class="import-actions">${button('核对读取结果','upload-query')}${button('重试原文件','upload-retry')}</div>`:''}${state.pendingBatch?button('核对原操作','batch-query'):''}</section>`;
  (document.getElementById('import-file') as HTMLInputElement).onchange=event=>{file=(event.target as HTMLInputElement).files?.[0];if(file&&!state.pendingUpload)void upload();};
  list.innerHTML=batches.length?`<h2>最近上传</h2><div class="import-batch-list">${batches.map(batch=>`<a class="import-batch-link" href="/imports.html?id=${encodeURIComponent(batch.id)}"><strong>${esc(batch.name)}</strong><span>${formatTime(batch.createdAt)} · ${batch.total??0} 个项目</span></a>`).join('')}</div>`:'';
}
function formatTime(value: unknown) { if (!value) return '时间未知'; const date = new Date(typeof value==='number'?value:String(value)); return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai', hour12: false }).format(date); }
function mapping(item: Item, current: CardState) {
  if (item.kind === 'company') return '';
  if (!current.mapping && !item.needsMapping && item.targetId) return `<p class="import-muted">已对应：${esc((item.target?.fields as Values)?.name ?? item.target?.name ?? item.name ?? (isProject(item) ? '线上项目' : '线上资料'))}${button('修改对应', 'map', item.id)}</p>`;
  const project = isProject(item), mode = item.needsMapping&&!current.mode?'':current.mode ?? item.mode;
  const options = project ? projectOptions : catalogue[catalogKinds[item.kind] ?? item.kind] ?? [];
  const targetId = item.needsMapping&&!current.mode?null:current.targetId === undefined ? item.targetId : current.targetId;
  return `<div class="import-source-row"><div class="field"><label for="mode-${item.id}">本次如何采用</label><select id="mode-${item.id}" data-mode="${item.id}">${mode?'':'<option value="">请选择如何对应</option>'}<option value="new"${mode === 'new' ? ' selected' : ''}>${project ? '作为新项目入库' : '新建资料'}</option><option value="existing"${mode === 'existing' ? ' selected' : ''}>${project ? '对应已有项目' : '对应已有资料'}</option></select></div>${mode === 'existing' ? `<div class="field"><label for="target-${item.id}">${project ? '线上项目' : '线上资料'}</label><select id="target-${item.id}-source" data-reference="true" data-target="${item.id}"><option value="">请选择</option>${options.map(option => `<option value="${esc(option.id)}"${String(option.id) === String(targetId) ? ' selected' : ''}>${esc(option.name ?? option.fullName)}${project ? `（#${esc(option.id)}）` : ''}</option>`).join('')}</select></div>` : ''}</div>${mode === 'new' && project ? '<p class="import-muted">新增项目导入后归当前处理人；已有项目的负责关系保持。</p>' : '<p class="import-muted">核对差异后，所选信息和对应会一起保存。</p>'}`;
}
function differences(item: Item, current: CardState) {
  const project=isProject(item);
  const visible=item.diffs.map(diff=>({diff,members:(diff.members?.length?diff.members:[diff]).filter(member=>member.key!=='binding'&&(project||current.full||(item.conflictKeys ?? []).includes(member.key))&&(item.targetId||current.editing||member.after!==null&&member.after!==''&&(!Array.isArray(member.after)||member.after.length)))})).filter(row=>row.members.length);
  if(!visible.length)return '';
  const records=[...(item.payload.records ?? []),...((item.target?.records as RecordValue[]) ?? [])];
  return `<div class="import-diff"><table><thead><tr><th>修改事项</th><th>线上信息</th><th>${project?'最终内容':'文件信息'}</th></tr></thead><tbody>${visible.map(({diff,members})=>{
    const recordKind=diff.key.startsWith('record.')?diff.key.slice(7).split(':')[0]:'';
    const title=diff.key.startsWith('stage.')?label(diff.key.slice(6))+'阶段':isProject(item)?diff.label:catalogFields[catalogKinds[item.kind] ?? item.kind]?.find(field=>field.key===diff.key)?.title ?? diff.label;
    const memberTitle=(member:Difference)=>titles[member.key.split('.').at(-1)!] ?? member.label;
    const display=(member:Difference,value:unknown)=>member.key.startsWith('history.')?(Array.isArray(value)?`${value.length} 条原记录；完整内容可在下方展开查看。`:'无来源记录'):member.key==='lastCheckAt'?formatTime(value):readable(value,member.key.split('.').at(-1),true,recordKind,records);
    const choice=(member:Difference)=>member.selectable?`<button type="button" class="head-btn import-choice" data-action="toggle-difference" data-difference="${esc(member.key)}" data-item="${item.id}"${!item.canEdit||locked(item)?' disabled':''}>${current.selected.includes(member.key)?'保留线上':project?'采用备份':'采用备份内容'}</button>`:'';

    return `<tr><td><strong>${esc(title)}</strong>${members.map(choice).join('')}</td><td data-label="线上信息">${members.map(member=>`<div class="import-diff-part">${diff.members?.length?`<small>${esc(memberTitle(member))}</small>`:''}${esc(display(member,member.before))}</div>`).join('')}</td><td data-label="最终内容">${members.map(member=>{
      const value=project&&!current.selected.includes(member.key)?member.before:member.after;
      const input=current.editing?differenceControl(item,member,value):'';
      return `<div class="import-diff-part">${input||`${diff.members?.length?`<small>${esc(memberTitle(member))}</small>`:''}${esc(display(member,value))}`}${member.issues?.length?`<p class="import-error">${member.issues.map(issue=>esc(issueText(issue))).join('\n')}</p>`:''}</div>`;
    }).join('')}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function differenceControl(item:Item,diff:Difference,value:unknown) {
  const payload=card(item).payload ?? item.payload;
  if(diff.key==='tasks'&&Array.isArray(value))return value.map((task,index)=>`<label>${task.deletedAt?'已删除':task.completedAt?'已完成':'待完成'}<textarea data-item="${esc(item.id)}" data-value-path="tasks.${index}.text" rows="2" aria-label="任务内容">${esc(task.text)}</textarea></label>`).join('');
  let prefix='',spec:Field|undefined;
  if(diff.key.startsWith('fields.')){prefix='fields.';spec=[...basicFields,...extraFields,{key:'statusDesc',title:'最新状态说明',type:'textarea'},{key:'summaryNote',title:'备注',type:'textarea'},{key:'chipstatNote',title:'芯片备注',type:'textarea'},{key:'signal',title:'灯色',type:'select',options:['green','yellow','red']},{key:'signalNote',title:'灯色说明',type:'textarea'}].find(field=>diff.key===prefix+field.key) as Field;}
  else if(diff.key.startsWith('people.')){prefix='people.';const key=diff.key.slice(7);spec={key,title:titles[key],type:'reference',catalog:'engineers',multiple:true};}
  else if(diff.key.startsWith('stage.')){const index=payload.stages?.findIndex(stage=>diff.key.startsWith(`stage.${stage.code}.`)) ?? -1;if(index>=0){prefix=`stages.${index}.`;spec=stageFields.find(field=>diff.key===`stage.${payload.stages![index].code}.${field.key}`);}}
  else if(diff.key.startsWith('record.')){const index=payload.records?.findIndex(record=>diff.key.startsWith(`record.${record.key}.`)) ?? -1;if(index>=0){prefix=`records.${index}.values.`;const record=payload.records![index];spec=recordFields[record.kind]?.find(field=>diff.key===`record.${record.key}.${field.key}`);}}
  if(!isProject(item))spec=catalogFields[catalogKinds[item.kind]??item.kind]?.find(field=>field.key===diff.key);
  return spec?fieldControl(item,spec,{[spec.key]:value},prefix,true):'';
}
function impact(item: Item, current: CardState) {
  const preview = previews.get(item.id), issues = preview && !preview.pending ? preview.issues : item.issues ?? [];
  if (!issues.length && !preview?.effects.length && !preview?.pending) return '';
  const blocked=referenceDependencies(item).filter(dependency=>!dependency.ignored);
  const referenceLinks=blocked.length?`<p class="import-reference-link">先处理共用资料：${blocked.map(dependency=>`<button class="head-btn" data-action="open-catalog" data-project="${item.id}" data-item="${dependency.id}">处理${esc(kindNames[dependency.kind])}「${esc(itemName(dependency))}」</button>`).join('、')}。处理一次，相关项目会一起更新。</p>`:'';
  const visibleIssues=issues;
  const rows = [...new Set(visibleIssues.filter(issue=>typeof issue==='string'||issue.code!=='IMPORT_STAGE_STATE_REQUIRED'&&!(issue.code==='IMPORT_REFERENCE_REQUIRED'&&blocked.length)).map(issueText))];
  const dependencyKeys = selectionKeys(item,[...new Set(issues.flatMap(issue => typeof issue === 'object' ? issue.requiredKeys ?? [] : []).concat((preview?.effects ?? []).flatMap(effect => typeof effect === 'object' ? effect.requiredKeys ?? [] : [])))]).filter(k => !current.selected.includes(k));
  const needsIntent = issues.some(issue => /INTENT|REOPEN|ROLLBACK|LIFECYCLE/.test(typeof issue === 'string' ? issue : issue.code ?? '')) || !!current.intent?.kind;

  const stageChoices=issues.flatMap(issue=>typeof issue==='object'&&issue.code==='IMPORT_STAGE_STATE_REQUIRED'&&issue.path?[issue.path]:[]).map(path=>{const code=path.split('.')[1];return `<div class="import-stage-choice"><strong>${esc(label(code))}</strong><p>备份未记录是否已经开始，请确认当前状态。</p><button class="head-btn" data-action="stage-ready" data-stage="${esc(code)}" data-item="${item.id}">待开始</button><button class="head-btn" data-action="stage-active" data-stage="${esc(code)}" data-item="${item.id}">进行中</button></div>`;}).join('');
  const effects=(preview?.effects ?? []).map(effect=>typeof effect==='object'&&effect.cause&&effect.consequence?`<li><span>${esc(effect.cause)}</span><b aria-label="导致">→</b><span>${esc(effect.consequence)}</span></li>`:`<li class="import-effect-note">${esc(issueText(effect))}</li>`).join('');
  if(!rows.length&&!effects&&!stageChoices&&!preview?.pending)return referenceLinks;
  return `${referenceLinks}<div class="import-impact"><h3>${preview?.pending ? '正在核对当前内容…' : '修改与影响'}</h3>${stageChoices}${rows.length ? `<ul>${rows.map(text => `<li>${esc(text)}</li>`).join('')}</ul>` : ''}${effects ? `<ol class="import-causal-chain">${effects}</ol>` : ''}${dependencyKeys.length ? button('一并采用关联内容', 'select-dependencies', item.id) : ''}${needsIntent ? `<div class="import-grid"><div class="field"><label for="intent-${item.id}">这次状态变化的原因</label><select id="intent-${item.id}" data-intent="kind" data-item="${item.id}"><option value="">请选择</option>${[['correction','线上误录，需要纠正'],['rework','本地发生实际返工'],['reopen','本地已重新打开项目']].map(([v,t]) => `<option value="${v}"${current.intent?.kind === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div><div class="field import-wide"><label for="reason-${item.id}">原因说明</label><textarea id="reason-${item.id}" data-intent="reason" data-item="${item.id}" rows="2">${esc(current.intent?.reason)}</textarea></div></div>` : ''}</div>`;
}
function fieldControl(item: Item, spec: Field, values: Values, prefix: string, editing: boolean) {
  const value = values[spec.key], present = Object.hasOwn(values, spec.key), path = prefix + spec.key;
  const id = `field-${item.id}-${path.replaceAll('.', '-')}`;
  if (!editing) return present ? `<div class="field${spec.wide ? ' import-wide' : ''}"><dt>${esc(spec.title)}</dt><dd>${esc(readable(value, spec.key,true,'',[...(item.payload.records ?? []),...((item.target?.records as RecordValue[]) ?? [])]))}</dd></div>` : '';
  let input = '';
  if(spec.key==='chipSelections')input=chipPicker((value??[]) as ChipSelection[],catalogue as unknown as Catalog).replace('id="chip-picker"',`id="chip-picker" data-item="${item.id}"`);
  else if (spec.type === 'reference') {
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
function fullInformation(item: Item, editing = false) {
  const current = card(item), payload = editing ? current.payload ?? item.payload : item.payload;
  if (!isProject(item)) return `<div class="import-grid">${(catalogFields[catalogKinds[item.kind] ?? item.kind] ?? [{ key: 'name', title: '名称' }]).filter(spec=>!editing||(current.mode??item.mode)!=='existing'||!leaves(item).some(diff=>diff.key===spec.key)).map(spec => fieldControl(item, spec, payload, '', editing)).join('')}</div>` + (!editing ? group('本地原有记录',originalSource(item)) + adoptionHistory(item) : '');
  const fields = payload.fields ?? {}, people = payload.people ?? {};
  const render = (specs: Field[], v = fields, prefix = 'fields.') => `<div class="import-grid">${specs.filter(spec=>!editing||!leaves(item).some(diff=>diff.key===editedKey(item,prefix+spec.key))&&!itemIssues(item).some(issue=>typeof issue==='object'&&issue.code==='IMPORT_STAGE_STATE_REQUIRED'&&issue.path===editedKey(item,prefix+spec.key))).map(spec => fieldControl(item, spec, v, prefix, editing)).join('')}</div>`;
  const peopleHtml = render(['pm','hardware_owner','software_owner','participant'].map(key => ({ key, title: titles[key], type: 'reference', catalog: 'engineers', multiple: true })), people, 'people.') + ('pm' in people ? '<p class="import-muted">本地经理姓名是来源资料，不授予线上账号权限。</p>' : '');
  const stages = (payload.stages ?? []).map((stage, index) => `<div class="import-record"><h3>${esc(label(stage.code))}</h3>${render(stageFields, stage, `stages.${index}.`)}</div>`).join('');
  const records = Object.keys(recordFields).map(kind => {
    const rows = (payload.records ?? []).map((record, index) => ({record,index})).filter(({record}) => record.kind === kind);
    return group(kindNames[kind], rows.map(({record,index}) => {
      const targets = ((item.target?.records as RecordValue[]) ?? []).filter(row => row.kind === kind);
      const mapping = editing && record.targetId === undefined && (current.mode ?? item.mode) === 'existing' ? `<div class="field"><label for="record-target-${item.id}-${index}">这条记录如何采用</label><select id="record-target-${item.id}-${index}-source" data-reference="true" data-item="${item.id}" data-value-path="records.${index}.targetId" data-value-type="record-target"><option value="">请选择新增或对应</option><option value="__new"${record.targetId === null ? ' selected' : ''}>作为新记录加入</option>${targets.map(row => `<option value="${esc(row.targetId)}"${row.targetId === record.targetId ? ' selected' : ''}>${esc(row.values.title ?? row.values.content ?? row.values.reason ?? kindNames[kind])}（#${esc(row.targetId)}）</option>`).join('')}</select></div>` : '';
      return `<div class="import-record"><div class="import-record-head"><h3>${esc(record.values.title ?? record.values.content ?? (kindNames[kind] + ' ' + (index + 1)))}</h3>${record.targetId ? '<span class="import-badge">对应线上记录</span>' : '<span class="import-badge">来源记录</span>'}</div>${mapping}${render(recordFields[kind], record.values, `records.${index}.values.`)}</div>`;
    }).join(''),editing);
  }).join('');
  const history = sourceHistory(payload) + originalSource(item);
  const adoptions = adoptionHistory(item);
  const sections:Record<string,[string,string]>={
    basic:['基本信息与项目分工',render(basicFields)+`<h3>项目分工</h3>${peopleHtml}`],
    status:['最新状态说明与导出备注',(Array.isArray(payload.tasks)?`<h3>任务</h3>${editing?differenceControl(item,{key:'tasks'} as Difference,payload.tasks):`<p class="import-pre">${esc(readable(payload.tasks,'tasks'))}</p>`}`:'')+render([{key:'statusDesc',title:'最新状态说明',type:'textarea',wide:true},{key:'summaryNote',title:'备注',type:'textarea'},{key:'chipstatNote',title:'芯片备注',type:'textarea'}])],
    stages:['阶段',stages],
    other:['灯色与其他历史事实',render([{key:'signal',title:'灯色',type:'select',options:['green','yellow','red']},{key:'signalNote',title:'灯色说明',type:'textarea'},...extraFields])],
  };

  return Object.values(sections).map(([title,html])=>group(title,html)).join('')+records+group('本地原有记录',history)+adoptions;
}
function itemName(item: Item) { return String(item.payload.fields?.name ?? item.payload.name ?? item.payload.fullName ?? item.name ?? item.sourceName ?? kindNames[item.kind] ?? '来源项目'); }
function catalogProblem(item:Item) {
  const current=card(item),payload=current.payload??item.payload,mode=current.mode??item.mode;
  const affected=data!.items.filter(project=>!project.previousResult&&project.unresolvedReferences?.some(ref=>ref.itemIds.includes(item.id)));
  const values=catalogue[catalogKinds[item.kind]??item.kind]??[];
  const nameKey=(value:unknown)=>String(value??'').normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en-US');
  const candidates:Values[]=(item.candidates?.length?item.candidates:values).filter(value=>nameKey(value.name)===nameKey(payload.name??payload.fullName));
  const candidateActions=candidates.map(candidate=>`<button class="head-btn" data-action="${candidate.enabled===false||candidate.enabled===0?'restore-deleted-catalog':'use-catalog'}" data-item="${item.id}" data-target-id="${esc(candidate.id)}">${candidate.enabled===false||candidate.enabled===0?'恢复并使用':'使用线上'}「${esc(candidate.name)}」</button>`).join('');
  return `<article class="import-card import-catalog-problem" id="import-item-${item.id}" data-card="${item.id}"><header class="import-heading"><h2>${esc(kindNames[item.kind])}：${esc(payload.name??payload.fullName??itemName(item))}</h2><span class="import-badge">${item.ignored?'本批次不使用':itemState(item)==='attention'?'需要处理':mode==='existing'?'使用线上资料':'新增资料'}</span></header>
    ${item.ignored?`<p>只移除待导入引用，已入库资料保持不变。</p>${button('恢复使用','restore-catalog',item.id)}`:`${impact(item,current)}${affected.length?`<p class="import-muted">关联 ${affected.length} 个待导入项目：${affected.map(project=>esc(itemName(project))).join('、')}。</p>`:''}
    ${candidateActions?`<div class="import-actions">${candidateActions}</div>`:''}
    ${mode==='existing'?`<p class="import-muted">默认保留线上内容。采用备份会修改这份共享资料。</p>${differences(item,{...current,full:true})}`:!current.editing?fieldControl(item,{key:'name',title:'资料名称'},payload,'',true):''}
    <div class="import-actions">${button('修正信息','edit',item.id)}${button('不使用这条资料','ignore-catalog',item.id)}${button('选择其他已有资料','map',item.id)}</div>${current.mapping?mapping(item,current):''}${current.editing?fullInformation(item,true)+button('完成修正','finish-edit',item.id):''}`}
    <div class="import-feedback" data-tone="${esc(current.tone)}" role="status">${esc(readableError(current.feedback??''))}${diagnosticMarkup(current.diagnostic)}</div>${current.pending?button('查询保存结果','query',item.id)+button('继续本次操作','retry-item',item.id):''}</article>`;
}
function renderCard(item:Item,catalog=false) {
  if(catalog&&item.kind!=='company')return catalogProblem(item);
  const current=card(item),prior=item.previousResult,active=!prior||current.continuing||item.targetDeleted,status=itemState(item),newItem=(current.mode??item.mode)==='new';
  const heading=item.targetDeleted?'曾被删除':current.included===false?'本次跳过':status==='processed'?'已导入':item.unchanged?'与线上一致':item.restricted?'尚未加入':newItem?'新增项目':'更新已有项目';
  const managerChoices=(item.managers??[]).filter(value=>value.candidates.length>1).map(value=>`<div class="field"><label>${esc(value.name)}对应哪个账号</label><select data-manager="${esc(value.name)}" data-item="${item.id}"><option value="">暂不邀请</option>${value.candidates.map(account=>`<option value="${esc(account.id)}"${(current.managerMatches?.[value.name]??value.targetId)===account.id?' selected':''}>${esc(account.name)}（账号 ${esc(account.id)}）</option>`).join('')}</select></div>`).join('');
  const details=active&&!item.unchanged&&!item.targetDeleted&&!item.restricted&&current.included!==false?`${current.mapping||item.needsMapping?mapping(item,{...current,mapping:true}):''}${impact(item,current)}<div class="import-actions">${current.editing?button('完成修正','finish-edit',item.id)+button('撤销修正','cancel-edit',item.id):button('修正信息','edit',item.id)}${button(catalog?'更改对应资料':'更改对应项目','map',item.id)}</div><details class="import-changes"${!newItem||current.editing||itemIssues(item).length?' open':''}><summary>${newItem?'预览新增项目':'查看前后变化'}</summary>${differences(item,current)}${current.editing?group('其他信息',fullInformation(item,true)):''}</details>`:'';
  return `<article class="import-card" id="import-item-${item.id}" data-card="${item.id}"><header class="import-heading"><h2>${catalog?esc(kindNames[item.kind])+ '：':''}${esc(itemName(item))}</h2><span class="import-badge" data-state="${status}">${heading}</span>${active&&!catalog?button(current.included===false?'纳入本次导入':'跳过项目','toggle-project',item.id):''}</header>
  ${item.targetDeleted?`<div class="import-impact"><h3>这是已删除的项目</h3><p>同名项目保留在历史项目中，恢复后再核对备份变化。</p>${account?.isMaintenance?button('恢复原项目','restore-project',item.id):'<p>请管理员恢复原项目；你可以先导入其他项目。</p>'}</div>`:prior?`<p class="import-result">此前已保存。${prior.projectId?`<a href="/project-detail.html?id=${encodeURIComponent(prior.projectId)}">进入项目</a>`:''}${!current.continuing?button('继续核对差异','continue',item.id):''}</p>`:''}
  ${item.restricted&&!item.targetDeleted?`<p class="import-muted">已有同名项目。加入后可继续导入修改。</p>${account?.isProjectManager?button('加入项目','apply',item.id):'<p>当前账号没有项目经理资格，只能查看。</p>'}`:''}${details}
  ${active&&current.included!==false&&item.pendingInvitations?.length?`<p class="import-muted">导入后向 ${item.pendingInvitations.map(esc).join('、')} 发送归属请求。</p>`:''}
  ${active&&managerChoices?group('同名账号',`<div class="import-grid">${managerChoices}</div>`):''}
  ${current.stale?`<p class="import-error">线上信息已更新，输入已保留。${button('重新核对','refresh-item',item.id)}</p>`:''}
  ${current.localCopy?group('保留的输入',`<p>${esc(readable(current.localCopy,'',false))}</p>`):''}
  <div class="import-feedback" data-tone="${esc(current.tone)}" role="status">${esc(readableError(current.feedback??''))}${diagnosticMarkup(current.diagnostic)}</div>${current.pending?button('查询保存结果','query',item.id)+(['restoreProject','restoreCatalog'].includes(current.pending.action)?button('继续本次操作','retry-item',item.id):''):''}</article>`;
}
function render() {
  renderEntry();content.hidden=!data;savebar.hidden=!data;document.getElementById('imports-back')!.hidden=!data;
  if(!data){document.getElementById('imports-title')!.textContent='导入项目';document.getElementById('imports-subtitle')!.textContent='上传本地备份，先保存资料，再确认项目变化。';return;}
  const {batch,counts}=data;
  document.getElementById('imports-title')!.textContent='导入项目';
  document.getElementById('imports-subtitle')!.textContent=`${batch.name} · 文件中 ${counts.total} 个项目 · 本批已保存 ${counts.processed} 个项目`;
  content.innerHTML=`<nav class="import-steps" aria-label="导入步骤"><button class="head-btn" data-action="step-catalogs" aria-current="${step()==='catalogs'?'step':'false'}">1 资料</button><span aria-hidden="true">→</span><button class="head-btn" data-action="step-projects" aria-current="${step()==='projects'?'step':'false'}">2 项目</button></nav>
    ${batch.canTakeover?`<section class="import-panel"><p>当前处理人已停用，可接管未完成内容。</p><div class="field"><label for="takeover-reason">接管原因</label><textarea id="takeover-reason" rows="2"></textarea></div>${button('接管','takeover')}</section>`:''}
    ${state.pendingBatch?`<section class="import-panel"><p>上次操作结果尚未确认，输入已保留。</p>${button('查询保存结果','batch-query')}${button('继续本次操作','batch-retry')}</section>`:''}
    <div id="import-execution-recovery"></div><section id="import-catalog-cards" aria-label="基础资料"></section>
    <section id="import-project-step"${step()!=='projects'?' hidden':''}><div class="import-toolbar"><h2>项目变化</h2><div class="field"><label for="import-search">查找项目</label><input id="import-search" type="search" value="${esc(state.search)}" placeholder="输入项目名称"></div><a href="/">进入本人项目</a></div><section id="import-project-cards" aria-label="本次项目信息"></section></section>`;
  filterCards();controls();
}
function filterCards() {
  const root=document.getElementById('import-project-cards');if(!root||!data)return;
  root.innerHTML=data.items.filter(item=>!state.search||itemName(item).includes(state.search)).sort((a,b)=>Number(itemState(b)==='attention')-Number(itemState(a)==='attention')).map(item=>renderCard(item)).join('')||'<p class="import-empty">没有匹配的项目。</p>';
  const catalogs=document.getElementById('import-catalog-cards')!;
  const attention=data.catalogRows.filter(item=>!item.ignored&&(itemState(item)==='attention'||(!item.previousResult||card(item).continuing)&&item.kind==='company'||card(item).editing||card(item).mapping));
  const normal=data.catalogRows.filter(item=>!item.ignored&&!attention.includes(item));
  catalogs.hidden=step()!=='catalogs'&&!state.catalogItemId;
  catalogs.innerHTML=`<div class="import-heading"><h2>基础资料</h2>${state.activeItemId?button('返回项目位置','back-project'):''}</div><p class="import-muted">${attention.length} 条需要处理，${normal.length} 条可用或已保存。问题只影响引用它的项目。</p>${attention.map(item=>renderCard(item,true)).join('')}${normal.length?group(`正常资料（${normal.length}）`,normal.map(item=>`<div class="import-catalog-summary" id="import-item-${item.id}"><strong>${esc(kindNames[item.kind])} · ${esc(itemName(item))}</strong><span>${item.previousResult?'已保存':item.targetId?'使用线上内容':'新增资料'}</span>${button('查看或修改','open-catalog',item.id)}</div>`).join('')):''}`;
  const ignored=data.catalogRows.filter(item=>item.ignored);if(ignored.length)catalogs.insertAdjacentHTML('beforeend',group(`本批次不使用（${ignored.length}）`,ignored.map(item=>catalogProblem(item)).join('')));
  if(state.catalogItemId){const item=findItem(state.catalogItemId);if(item){const row=document.getElementById('import-item-'+item.id);if(row)row.outerHTML=renderCard(item,true);else catalogs.insertAdjacentHTML('beforeend',renderCard(item,true));}}
  for(const region of [root,catalogs]){mountReferencePickers(region);bindValues(region);}controls();
}

function renderOne(item: Item) {
  const previous=document.getElementById('import-item-'+item.id);
  if(!previous){controls();return;}
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
  const chosen=selectedItems(),catalogStage=step()==='catalogs';
  const checking=(catalogStage?data?.catalogRows??[]:data?.items??[]).some(item=>card(item).included!==false&&previews.get(item.id)?.pending);
  saveButton.textContent=busy||executionActive?'正在保存…':checking?'正在核对修改…':catalogStage?(chosen.length?`保存资料并查看项目（${chosen.length}条）`:'查看项目'):`确认导入项目（${chosen.length}个）`;
  saveButton.disabled=frozen||busy||executionActive||checking||!catalogStage&&!chosen.length||!!state.pendingBatch;
  const explanation=frozen?'账号已变化，请重新登录后继续。':state.pendingBatch?'先查询上次操作结果。':pausedRequests().length?'部分结果待核对，其余无关项目可继续。':checking?'正在核对刚才的修改，请稍候。':!catalogStage&&!chosen.length?'当前没有可导入项目。可处理上方问题，或取消跳过。':catalogStage?'先保存可用资料。少数异常不会阻止其他项目。':'展示的变化将一起保存；保留线上和跳过的内容不修改。';
  document.getElementById('imports-save-status')!.textContent=executionFeedback?executionFeedback+' '+explanation:explanation;
  const recovery=document.getElementById('import-execution-recovery');
  if(recovery)recovery.innerHTML=pausedRequests().map(request=>`<div class="import-impact"><p>有 ${request.items.length} 项结果待核对，已保存的内容保留。其他无关项目可继续。</p><button class="head-btn" data-action="execution-query" data-operation="${request.operationId}">查询保存结果</button>${request.canResume?`<button class="head-btn" data-action="execution-resume" data-operation="${request.operationId}">${request.resumeLabel}</button>`:'<p>由原提交者继续本次操作。</p>'}</div>`).join('')+(executionReadFailed?`<div class="import-impact"><p>${esc(executionFeedback)}</p>${button('重新读取结果','execution-query')}</div>`:'');

  document.getElementById('imports-reload')!.toggleAttribute('disabled', frozen || busy || loading);
  document.querySelectorAll<HTMLButtonElement|HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('#imports-entry button,#imports-entry input,#imports-entry select,#imports-batch button,#imports-batch input,#imports-batch select,#imports-batch textarea').forEach(control => {
    const item = findItem(control.dataset.item ?? control.closest<HTMLElement>('[data-card]')?.dataset.card ?? '');
    if (!defaultDisabled.has(control)) defaultDisabled.set(control,control.disabled);
    const readOnlyControl=!!control.dataset.view||control.id==='import-search'||['open-project','full','view-adoption','view-source','back-project','open-catalog','execution-query','execution-resume','step-catalogs','step-projects'].includes(control.dataset.action??'');
    const matching = !!(control.dataset.mode || control.dataset.target || control.closest('.field')?.querySelector('select[data-target]'));
    control.disabled = !!(defaultDisabled.get(control) || frozen || busy || executionActive&&!readOnlyControl || item && inFlight.has(item.id)
      || state.pendingBatch && !['batch-query','batch-retry','full','view-adoption','view-source'].includes(control.dataset.action ?? '')
      || item && card(item).pending && !['query','retry-item','full','view-adoption','view-source'].includes(control.dataset.action ?? '')
      || item && itemAwaitingResult(item) && !readOnlyControl
      || item && !item.canEdit && !['query','retry-item','full','continue','refresh-item','map','view-adoption','view-source','apply','restore-project','toggle-project','open-catalog'].includes(control.dataset.action ?? '') && !matching);
  });
}
function setPath(payload: Payload, path: string, value: unknown) {
  const parts = path.split('.'); let target: Values = payload;
  for (const part of parts.slice(0,-1)) { if (target[part] == null) target[part] = {}; target = target[part] as Values; }
  target[parts.at(-1)!] = value;
}
function bindValues(root: ParentNode = content) {
  const picker=document.getElementById('chip-picker');const item=picker?.dataset.item?findItem(picker.dataset.item):undefined;
  if(item)bindChipPicker(()=>((card(item).payload??item.payload).fields?.chipSelections??[]) as ChipSelection[],value=>{
    const current=card(item);if(locked(item)||!current.editing)return;current.payload??=structuredClone(item.payload);setPath(current.payload,'fields.chipSelections',value);
    if(current.choices)delete current.choices[editedKey(item,'fields.chipSelections')];current.editedPaths=[...new Set([...(current.editedPaths??[]),'fields.chipSelections'])];current.selected=[];previews.delete(item.id);persist();schedulePreview(item);
  },()=>catalogue as unknown as Catalog,loadOptions);

  root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('[data-value-path]').forEach(input => {
    const write = () => { const item = findItem(input.dataset.item!)!, current = card(item); if (locked(item) || !current.editing&&(isProject(item)||input.dataset.valuePath!=='name')) return; current.payload ??= structuredClone(item.payload);if(item.previousResult)current.continuing=true;
      let value: unknown = input.value;
      if (input instanceof HTMLSelectElement && input.multiple) value = [...input.selectedOptions].map(o => o.value).filter(Boolean);
      else if (input.dataset.valueType === 'record-target') value = input.value === '__new' ? null : input.value || undefined;
      else if (input.dataset.valueType === 'number') value = input.value === '' ? null : Number(input.value);
      else if (input.dataset.valueType === 'boolean') value = input.value === '' ? null : input.value === 'true';
      else if (input.dataset.valueType === 'date' || input instanceof HTMLSelectElement) value = input.value || null;
      setPath(current.payload, input.dataset.valuePath!, value);if(current.choices)delete current.choices[editedKey(item,input.dataset.valuePath!)];if(!current.stale){current.tone='';current.feedback='';} current.editedPaths=[...new Set([...(current.editedPaths ?? []),input.dataset.valuePath!])]; if(current.fieldErrors)delete current.fieldErrors[input.dataset.valuePath!]; current.selected = []; previews.delete(item.id); persist(); schedulePreview(item);
    };
    input.addEventListener(input instanceof HTMLSelectElement ? 'change' : 'input', write);
  });
}
function command(item: Item): Command {
  const current = card(item),mode=current.mode ?? (isProject(item)&&!item.targetId&&!item.needsMapping?'new':undefined);
  return { expectedBatchVersion: data!.batch.version, expectedReviewVersion: item.reviewVersion, expectedVersion: current.expectedVersion === undefined ? item.expectedVersion ?? null : current.expectedVersion, ...(item.basis ? {basis:item.basis} : {}), selected: [...current.selected], keepOnline:keepOnline(item), ...(current.managerMatches?{managerMatches:current.managerMatches}:{}), ...(current.payload ? { payload: correction(item) } : {}), ...(mode?{mode,targetId:mode==='new'?null:current.targetId ?? item.targetId ?? null}:{}), ...(current.intent?.kind ? { intent: structuredClone(current.intent) } : {}), idempotencyKey: crypto.randomUUID() };
}
let loadingOptions:Promise<void>|undefined;
function loadOptions():Promise<void> {
  if(loadingOptions)return loadingOptions;
  loadingOptions=(async()=>{
    try {
      const response=await get<Record<string,Values[]>>('/api/project-options');
      catalogue={...response,productLines:response.product_lines,groups:response.project_groups};
    }catch(error){notice(explain(error)+' 候选资料尚未读到，原输入保留。',true,error);}
  })().finally(()=>{loadingOptions=undefined;});
  return loadingOptions;
}
async function loadProjectOptions() {
  const options: Values[] = []; let page = 1;
  while (true) {
    const result = await get<List>(`/api/project-space?pageSize=100&page=${page}`);
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
    const result=await get<{batches:BatchBrief[]}>('/api/imports');
    batches=result.batches;

    render();
  } catch (error) { notice(explain(error) + ' 请重试读取，当前文件和输入保留。', true,error); }
  finally { loading = false; controls(); }
}
async function readBatch(id: string, replaceItem?: string, acceptFresh = false, ownExecutionRefresh = false) {
  const ticket = ++generation;
  loading = true; controls();
  try {
    const next = await get<BatchData>('/api/imports/' + encodeURIComponent(id));
    if (ticket !== generation || frozen) return false;
    next.items ??= []; next.catalogRows ??= [];
    const previousId = data?.batch.id ?? state.batchId;
    const previousItems=new Map(allItems().map(item=>[item.id,item]));
    data = next; state.batchId = id;
    const candidates:Item[]=[];
    for (const item of allItems()) {
      item.diffs ??= []; item.issues ??= [];
      const current = card(item), nextBasis = basis(item);
      if(current.expectedVersion&&!/^[1-9][0-9]*$/.test(current.expectedVersion))current.expectedVersion=item.expectedVersion??null;
      const nextReferences=referenceBasis(item),serverReferences=current.serverReferenceBasis ?? current.referenceBasis;
      const referencesChanged=!!serverReferences&&serverReferences!==nextReferences;
      const previousReferences=serverReferences?JSON.parse(serverReferences) as unknown[]:[];
      if(!current.pending && previousReferences.length && (previousReferences[0]!==data.batch.sourceNamespace || previousReferences[1]!==item.targetId||item.needsMapping&&referencesChanged)){current.mode=undefined;current.targetId=undefined;current.expectedVersion=undefined;current.intent=undefined;if(previousReferences[1]!==item.targetId)current.choices=undefined;}
      const hadSelection=current.selected.length>0;
      if(referencesChanged && !current.pending)resetReferenceEdits(item);
      if(current.payload && !current.pending)current.payload=correctedPayload(item.payload,correction(item));
      current.referenceBasis=nextReferences;current.serverReferenceBasis=nextReferences;
      const previous=previousItems.get(item.id);
      const ownReferenceRefresh=ownExecutionRefresh&&!current.stale&&previous&&previous.reviewVersion===item.reviewVersion&&previous.expectedVersion===item.expectedVersion&&previous.targetId===item.targetId;
      if (current.basis !== nextBasis) {
        if (hadSelection || current.reviewing || current.editing || current.pending || referencesChanged && current.payload) {
          current.selected = [];
          if (!current.pending) current.feedback = referencesChanged ? '对应信息已更新，人写内容保留；资料与节点对应已按最新内容重新读取，请核对后选择。' : '对应信息已更新，原输入保留。请核对后重新选择。';
          current.stale = !!(current.editing||current.reviewing) && !(replaceItem === item.id && acceptFresh) && !ownReferenceRefresh;
        }
        current.basis = nextBasis; previews.delete(item.id);
      }
      if (acceptFresh && (!replaceItem || replaceItem === item.id)) current.stale = false;
      if(!current.pending&&!current.stale&&(current.mode||current.editedPaths?.length||current.intent?.kind)){previews.set(item.id,{issues:[],effects:[],pending:true});candidates.push(item);}else applySelection(item);
    }
    if(previousId!==id){state.view='catalogs';state.activeItemId=undefined;state.catalogItemId=undefined;serverExecutions=[];activeOperation=undefined;}
    if (previousId !== id) history.replaceState(null, '', '/imports.html?id=' + encodeURIComponent(id));
    persist();render();
    for(const item of candidates)await preview(item);
    return true;
  } catch (error) { notice(explain(error) + ' 原内容保留，读取失败不代表保存失败。', true,error); return false; }
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
  const signature = JSON.stringify([current.selected,current.choices,current.intent,current.basis,current.mode,current.targetId,current.payload,current.managerMatches]);
  const submittedSelection=JSON.stringify([current.selected,keepOnline(item)]);
  previews.set(item.id, { issues: [], effects: [], pending: true });
  try {
    const result = await send<{ item?: Item; diffs?: Difference[]; issues?: Issue[]; effects?: Effect[]; canEdit?: boolean; canAdopt?: boolean; unchanged?: boolean; expectedVersion?: string | null }>(itemPath(item.id) + '/preview', 'POST', command(item), false);
    if (signature !== JSON.stringify([current.selected,current.choices,current.intent,current.basis,current.mode,current.targetId,current.payload,current.managerMatches]) || frozen) return;
    if (result.item) {
      const chosenTarget=current.mode==='new'?null:current.targetId ?? item.targetId;
      const choosingTarget=current.mode!==undefined && chosenTarget!==item.targetId;
      if (!choosingTarget && current.referenceBasis !== referenceBasis(result.item)) {
        current.selected=[];current.stale=true;
        feedback(item,'资料或节点对应已变化，输入保留。请重新核对这一项后再保存。');
        previews.delete(item.id);renderOne(item);
        return;
      }
      if (!choosingTarget && (item.expectedVersion !== result.item.expectedVersion || item.reviewVersion !== result.item.reviewVersion)) {
        current.selected=[];current.stale=true;feedback(item,'线上内容或待审信息已变化，输入保留。请重新核对后再保存。');
        previews.delete(item.id);renderOne(item);return;
      }
      Object.assign(item, result.item); current.basis = basis(item);current.referenceBasis=referenceBasis(item);
      if(current.payload)current.payload=correctedPayload(item.payload,correction(item));
    }
    if (result.diffs) item.diffs = result.diffs;
    if (result.canEdit !== undefined) item.canEdit = result.canEdit;
    if (result.canAdopt !== undefined) item.canAdopt = result.canAdopt;
    if (result.unchanged !== undefined) item.unchanged = result.unchanged;
    if (result.expectedVersion !== undefined && current.mode === 'existing') current.expectedVersion = result.expectedVersion;
    applySelection(item);if(current.tone==='error'){current.feedback='';current.diagnostic=undefined;}current.tone='';current.fieldErrors=undefined;
    previews.set(item.id, { issues: result.issues ?? [], effects: result.effects ?? [] });
    persist();
    if(submittedSelection!==JSON.stringify([current.selected,keepOnline(item)]))return preview(item);
  } catch (error) {
    if (signature !== JSON.stringify([current.selected,current.choices,current.intent,current.basis,current.mode,current.targetId,current.payload,current.managerMatches])) return;
    previews.set(item.id, { issues: [explain(error)], effects: [] });
    current.feedback = explain(error); current.tone = 'error';current.diagnostic=diagnostic(error);
  }
  renderOne(item);
}
async function restoreOperation(item:Item,pending:Pending,query=false) {
  if(frozen||inFlight.has(item.id))return;
  const current=card(item);current.pending=pending;persist();inFlight.add(item.id);controls();let saved=false;
  try {
    const result=await send<Outcome>(query?pending.queryPath:pending.path,'POST',pending.body,!query);
    if(result.outcome!=='committed'){feedback(item,'恢复结果尚未确认。可查询结果，或继续这一次恢复；不会另建项目或资料。');return;}
    saved=true;current.pending=undefined;current.continuing=true;persist();await loadOptions();
    if(!await readBatch(data!.batch.id,item.id,true,true)){feedback(item,'已经恢复，预览暂未读到。请重新读取，勿再次新建。','success');return;}
    const next=findItem(item.id)!;const restored=card(next);restored.continuing=true;
    if(pending.action==='restoreCatalog'){
      const detail=await get<{item:Values}>(`/api/catalog/${catalogKinds[item.kind]??item.kind}/${(pending.body as Values).id}`);
      restored.mode='existing';restored.targetId=String(detail.item.id);restored.expectedVersion=String(detail.item.version);restored.choices=undefined;
    }
    feedback(next,pending.action==='restoreProject'?'原项目已恢复。核对变化后，再确认导入。':'原资料已恢复。默认使用线上内容。','success');await preview(next);
  }catch(error){
    if(error instanceof SaveError&&error.outcome==='not_committed'&&error.code!=='OPERATION_KEY_REUSED')current.pending=undefined;
    feedback(item,saved?'已经恢复，最新预览读取失败，请重新读取。':explain(error),saved?'success':'error',error);
  }finally{inFlight.delete(item.id);renderOne(findItem(item.id)??item);}
}
async function recoverLegacyItem(item:Item) {
  const current=card(item),pending=current.pending;if(!pending||inFlight.has(item.id))return;
  if(['restoreProject','restoreCatalog'].includes(pending.action))return restoreOperation(item,pending,true);
  inFlight.add(item.id);
  try {
    const result=await send<Outcome>(pending.queryPath,'POST',pending.body,false);
    if(result.outcome==='committed'){
      current.pending=nextRequest(pending);persist();await readBatch(data!.batch.id,item.id,true);
      feedback(item,'原保存已经完成。','success');
    }else if(result.outcome==='not_committed'){
      current.pending=nextRequest(pending);persist();
      feedback(item,'原保存没有入库，原输入保留。核对后点击确认导入。');
    }else feedback(item,'原任务仍在处理，原输入保留。系统会继续查询结果。');
  }catch(error){feedback(item,explain(error),'error',error);}
  finally{inFlight.delete(item.id);renderOne(item);}
}
async function submitExecution(items:Item[]) {
  if(!data||executionActive||frozen||state.executions?.[data.batch.id])return;
  const unique=[...new Map(items.flatMap(item=>step()==='catalogs'?[...referenceDependencies(item).filter(row=>!isProject(row)),item]:[item]).map(item=>[item.id,item])).values()];
  const request:ExecutionRequest={body:{formatVersion:2,stage:step(),idempotencyKey:crypto.randomUUID(),items:unique.map(item=>({id:item.id,command:command(item),resolveReferences:true}))}};
  (state.executions??={})[data.batch.id]=request;
  for(const item of request.body.items)ownOperations.add(item.command.idempotencyKey);
  persist();activeOperation=request.body.idempotencyKey;executionActive=true;controls();
  await pollExecution();
}
async function pollExecution(operation?:string) {
  if(!data||polling||frozen)return;
  polling=true;const batchId=data.batch.id;let requestKey=operation?batchId+':'+operation:batchId,request=state.executions?.[requestKey],submitted=false;
  const path=`/api/imports/${encodeURIComponent(batchId)}/executions`;
  try {
    const queryOperation=operation??activeOperation??request?.body.idempotencyKey;
    let result=await get<Execution|null>(path+(queryOperation?'?operation='+encodeURIComponent(queryOperation):''));
    if(result?.unfinished)serverExecutions=result.unfinished;
    if(!result?.id&&request){if(request.body.formatVersion!==2){delete state.executions![requestKey];persist();notice('旧页面的请求未被接收，输入已保留，请按当前内容重新选择。');return;}submitted=true;result=await send<Execution>(path,'POST',request.body);}
    if(data?.batch.id!==batchId)return;
    if(!result?.id){executionActive=false;activeOperation=undefined;return;}
    if(!request&&state.executions?.[batchId+':'+result.operationId]){requestKey=batchId+':'+result.operationId;request=state.executions[requestKey];}
    result.operationIds.forEach(id=>ownOperations.add(id));
    pausedExecution=result.status==='paused'?result.operationId:undefined;
    const running=['accepted','running'].includes(result.status)?result:serverExecutions.find(value=>['accepted','running'].includes(value.status));
    executionActive=!!running;activeOperation=running?.operationId;executionReadFailed=false;
    const projects=result.items.filter(item=>item.kind==='project'),done=projects.filter(item=>item.status==='committed').length;
    const failed=result.items.filter(item=>item.status==='failed').length;
    const catalogs=result.items.filter(item=>item.kind!=='project'&&item.status==='committed').length;
    executionFeedback=projects.length?`本次计划 ${projects.length} 个项目，已保存 ${done} 个，${failed} 项未保存。`:`本次已保存 ${catalogs} 条资料${failed?`，${failed} 项未保存`:''}。`;
    if(executionActive)executionFeedback+='其余正在处理。';
    if(pausedExecution)executionFeedback+='部分结果仍在核对，已成功内容保留。';
    const signature=JSON.stringify(result.items.map(item=>[item.id,item.status]));
    const changed=seenExecutions.get(result.id)!==signature;
    if(changed){
      for(const outcome of result.items){
        const item=findItem(outcome.id);if(!item)continue;
        const current=card(item);
        if(outcome.status==='committed'&&request?.body.items.some(value=>value.id===item.id)){
          Object.assign(current,{pending:undefined,selected:[],reviewing:false,skipped:false,editing:false,choices:undefined,mapping:false,payload:undefined,editedPaths:undefined,intent:undefined,mode:undefined,targetId:undefined,expectedVersion:undefined,stale:false,continuing:false,fieldErrors:undefined,tone:'success',feedback:'已保存到正式数据。'});
        }
        if(outcome.status==='committed'&&current.executionFeedbackId===result.operationId){current.executionFeedbackId=undefined;feedback(item,'原操作已确认保存。','success');}
        if(outcome.status==='confirming'||outcome.status==='waiting'){current.executionFeedbackId=result.operationId;feedback(item,outcome.message??(outcome.status==='confirming'?'这项保存结果尚未确认，请查询原结果。':'引用的资料尚未处理，请先处理对应资料。'),'error');}
        if(outcome.status==='failed'){current.fieldErrors=outcome.fields;feedback(item,(errors[outcome.code??'']??outcome.message??'这项尚未保存，请查询原操作结果')+(outcome.fields?'：'+Object.values(outcome.fields).join('；'):''),'error');if(outcome.code)current.diagnostic={code:outcome.code};}
      }
      persist();
      if(await readBatch(batchId,undefined,false,!!request))seenExecutions.set(result.id,signature);
      else {executionReadFailed=true;executionFeedback+='已保存结果保留，请重新读取预览。';return;}
      await loadOptions();
    }
    if(result.status==='paused'&&request){
      const uncertain=new Set(result.items.filter(item=>item.status!=='committed'&&item.status!=='failed').map(item=>item.id));
      request.waitingIds=[...uncertain];
      (state.executions??={})[batchId+':'+result.operationId]=request;
      if(requestKey===batchId)delete state.executions![batchId];
      persist();
    }
    if(result.status==='finished'){
      serverExecutions=serverExecutions.filter(value=>value.operationId!==result.operationId);
      if(request){delete state.executions![requestKey];delete state.executions![batchId+':'+result.operationId];if(request.body.stage==='catalogs'){const target=state.activeItemId;state.view='projects';state.catalogItemId=undefined;state.activeItemId=undefined;render();if(target)document.getElementById('import-item-'+target)?.scrollIntoView({block:'center'});}persist();}
    }
    if(changed||request||executionActive)notice(executionFeedback,failed>0);controls();
  }catch(error){
    if(submitted&&error instanceof SaveError&&error.outcome==='not_committed'&&error.code!=='OPERATION_KEY_REUSED'&&error.code!=='IMPORT_EXECUTION_ACTIVE'){
      if(request){delete state.executions![requestKey];persist();}executionActive=false;
    }
    executionReadFailed=true;executionFeedback=explain(error)+' 输入和已有保存结果保留。';notice(executionFeedback,true,error);
  }finally{polling=false;controls();}
}
async function saveSelected(){
  if(saveButton.disabled||busy||frozen||executionActive||state.pendingBatch)return;
  const items=selectedItems();if(items.length)await submitExecution(items);else if(step()==='catalogs'){state.view='projects';state.catalogItemId=undefined;persist();render();}
}

async function batchOperation(operation: Pending, query = false) {
  if (frozen) return;
  state.pendingBatch = operation; persist(); busy = true; controls();
  try {
    if (!query) await preference.flush();
    const response = await send<Outcome>(query ? operation.queryPath : operation.path, 'POST', operation.body, !query);
    if (response.outcome !== 'committed') { notice('原操作结果尚未确认，请继续核对，输入保持。'); return; }
    state.pendingBatch = nextRequest(operation);
    await loadOptions();
    persist(); notice(operation.action === 'takeover' ? '已保存接管，请核对剩余项目。' : '已保存。');
    if(data)await readBatch(data.batch.id,undefined,false,operation.action==='ignore');else await loadList();
    return response;
  } catch (error) {
    if (error instanceof SaveError && error.outcome === 'not_committed' && error.code !== 'OPERATION_KEY_REUSED') state.pendingBatch = nextRequest(operation);
    notice(explain(error), true,error); persist();
  } finally { busy = false; render(); }
}
async function upload(query = false, allowDuplicate = false) {
  if (busy || frozen) return;
  if (state.pendingBatch) { notice('请先核对原批次操作结果。', true); return; }
  let operation = state.pendingUpload;
  if (!operation) {
    if (!file) { notice('请选择备份文件。', true); return; }

    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(n => n.toString(16).padStart(2,'0')).join('');
    operation=state.pendingUpload={idempotencyKey:crypto.randomUUID(),name:file.name,hash,size:file.size,allowDuplicate};

    persist();
  }
  if (!query && (!file || file.size !== operation.size || [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(n => n.toString(16).padStart(2,'0')).join('') !== operation.hash)) { notice('请重新选择原备份文件，再重试原读取。不能用另一个文件替换待确认操作。', true); return; }
  busy = true; notice(query ? '正在核对原读取结果…' : '正在读取并登记备份…'); controls();
  try {
    if (!query) await preference.flush();
    const response = query ? await send<Outcome>('/api/imports/results/query','POST',{idempotencyKey:operation.idempotencyKey},false) : await sendFile<Outcome>('/api/imports/upload?' + new URLSearchParams({ ...(operation.sourceNamespace?{source:operation.sourceNamespace}:{}), name: operation.name, operation: operation.idempotencyKey, ...(operation.allowDuplicate ? {new:'1'} : {}) }), file!);
    if (response.outcome !== 'committed' || !response.result?.batchId) { notice('登记结果尚未确认，请核对原结果。原文件未被修改。'); return; }
    state.pendingUpload = nextRequest(operation); persist();
    file = undefined; state.batchId=response.result.batchId;persist();
    history.replaceState(null,'','/imports.html?id='+encodeURIComponent(response.result.batchId));
    if(await readBatch(response.result.batchId))notice('');
    else {await loadList();notice('文件已登记，项目内容暂未读回。可从下方原批次继续，不需要重新上传。',true);}
  } catch (error) {
    if (error instanceof SaveError && error.outcome === 'not_committed' && error.code !== 'OPERATION_KEY_REUSED') state.pendingUpload = nextRequest(operation);
    notice(explain(error), true,error); persist();
  } finally { busy = false; render(); }
}

document.addEventListener('change', event => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  if (frozen || busy || executionActive) return;
  const id = target.dataset.item ?? target.dataset.mode ?? target.dataset.target;
  const item = id ? findItem(id) : undefined;
  if (!item) return;
  const current = card(item);
  if (current.pending) return;
  if(target.dataset.manager){
    for(const related of allItems().filter(row=>row.managers?.some(manager=>manager.name===target.dataset.manager))){
      const matches=card(related).managerMatches??={};
      if(target.value)matches[target.dataset.manager]=target.value;else delete matches[target.dataset.manager];
      schedulePreview(related);
    }
    persist();
  } else if (target.dataset.mode || target.dataset.target) {
    current.mapping = true; current.selected = [];current.choices=undefined; previews.delete(item.id);
    resetReferenceEdits(item);
    if (target.dataset.mode) { current.mode = target.value ? target.value as 'new' | 'existing' : undefined; current.targetId = null; current.expectedVersion = null; }
    else {
      current.mode = 'existing'; current.targetId = target.value || null;
      const option = (isProject(item) ? projectOptions : catalogue[catalogKinds[item.kind] ?? item.kind] ?? []).find(o => String(o.id) === target.value);
      current.expectedVersion = option?.version&&/^[1-9][0-9]*$/.test(String(option.version)) ? String(option.version) : null;
    }
    persist(); renderOne(item);
    if (isProject(item) && current.mode === 'existing' && !projectOptions.length) void loadProjectOptions().then(() => renderOne(item)).catch(error => { feedback(item,explain(error),'error',error); renderOne(item); });
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
  const control = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action],button[data-view]');
  if (!control || control.disabled || frozen) return;
  if (control.dataset.view) { state.view = control.dataset.view; persist(); render(); return; }
  const action = control.dataset.action!, item = control.dataset.item ? findItem(control.dataset.item) : undefined;
  void (async () => {
    if(action==='step-catalogs'||action==='step-projects'){state.view=action==='step-catalogs'?'catalogs':'projects';state.catalogItemId=undefined;state.activeItemId=undefined;persist();render();return;}
    if(action==='back-project'){const target=state.activeItemId;state.catalogItemId=undefined;state.activeItemId=undefined;state.view='projects';persist();render();if(target)document.getElementById('import-item-'+target)?.scrollIntoView({block:'center'});return;}
    if(action==='execution-query'){executionReadFailed=false;await pollExecution(control.dataset.operation);return;}
    if(action==='execution-resume'&&data&&control.dataset.operation){await send(`/api/imports/${data.batch.id}/executions/${control.dataset.operation}/resume`,'POST',{});activeOperation=control.dataset.operation;executionActive=true;executionReadFailed=false;await pollExecution(control.dataset.operation);return;}
    if (action === 'upload') return upload();
    if (action === 'upload-query') return upload(true);
    if (action === 'upload-retry') return upload(false);
    if (action === 'upload-new') return upload(false,true);
    if (action === 'batch-query' || action === 'batch-retry') { if (state.pendingBatch) await batchOperation(state.pendingBatch,action === 'batch-query'); return; }
    if (action === 'takeover' && data) {
      const reason = (document.getElementById('takeover-reason') as HTMLTextAreaElement).value.trim();
      if (!reason) return notice('请填写接管原因。', true);
      return batchOperation({ path: `/api/imports/${data.batch.id}/takeover`, queryPath: `/api/imports/${data.batch.id}/takeover/results/query`, action: 'takeover', body: {expectedVersion:data.batch.version,reason,idempotencyKey:crypto.randomUUID()} });
    }
    if (!item) return;
    const current = card(item);
    if(action==='apply'&&item.targetId){const result=await saveMembership(item.targetId,{action:'join'});if(result.outcome==='committed'){await readBatch(data!.batch.id,item.id,true);feedback(item,'已加入项目，可以核对并导入修改。');}else feedback(item,'加入结果尚未确认，请核对后继续。');renderOne(item);return;}
    if (action === 'query') return recoverLegacyItem(item);
    if(action==='retry-item'&&current.pending)return restoreOperation(item,current.pending);
    if (action === 'full') { current.full = !current.full; persist(); renderOne(item); return; }
    if (action === 'view-source') { sourceSnapshots.set(item.id,await get<{source:Values;issues:Issue[]}>(itemPath(item.id) + '/source')); renderOne(item); return; }
    if (action === 'view-adoption') { const id = control.dataset.adoption!; adoptionSnapshots.set(item.id+':'+id,await get<{adoption:Values;histories:Payload['histories']}>(itemPath(item.id) + '/adoptions/' + encodeURIComponent(id))); renderOne(item); return; }
    if(action==='open-catalog'){state.activeItemId=control.dataset.project??state.activeItemId;state.catalogItemId=item.id;state.view='catalogs';persist();render();const row=document.getElementById('import-item-'+item.id);let parent=row?.parentElement;while(parent){if(parent instanceof HTMLDetailsElement)parent.open=true;parent=parent.parentElement;}row?.scrollIntoView({block:'start'});return;}
    if (locked(item)) return;
    if(action==='stage-ready'||action==='stage-active'){current.payload??=structuredClone(item.payload);const index=current.payload.stages?.findIndex(stage=>stage.code===control.dataset.stage)??-1;if(index<0)return;const path=`stages.${index}.state`;setPath(current.payload,path,action==='stage-ready'?'ready':'active');current.editedPaths=[...new Set([...(current.editedPaths??[]),path])];current.continuing=!!item.previousResult;persist();schedulePreview(item);return;}
    if(action==='toggle-project'){current.included=current.included===false;persist();renderOne(item);return;}
    if(action==='toggle-difference'){
      if(item.previousResult)current.continuing=true;
      const diff=leaves(item).find(diff=>diff.key===control.dataset.difference);if(!diff?.selectable)return;
      (current.choices??={})[diff.key]={value:current.selected.includes(diff.key)?'online':'source',basis:choiceBasis(diff)};
      applySelection(item);persist();renderOne(item);schedulePreview(item);return;
    }
    if(action==='restore-project'&&item.targetId&&item.deletedVersion&&account?.isMaintenance){
      await restoreOperation(item,{action:'restoreProject',itemId:item.id,path:`/api/projects/${item.targetId}/restore`,queryPath:`/api/projects/${item.targetId}/restore-results/query`,body:{expectedVersion:item.deletedVersion,idempotencyKey:crypto.randomUUID()}});return;
    }
    if(action==='restore-deleted-catalog'&&control.dataset.targetId){
      const kind=catalogKinds[item.kind]??item.kind,detail=await get<{item:Values}>(`/api/catalog/${kind}/${control.dataset.targetId}`);
      const body={id:String(detail.item.id),expectedVersion:String(detail.item.version),idempotencyKey:crypto.randomUUID(),changes:{enabled:true}};
      const check=await send<{impactToken:string}>(`/api/catalog/${kind}/preview`,'POST',body,false);
      await restoreOperation(item,{action:'restoreCatalog',itemId:item.id,path:`/api/catalog/${kind}/save`,queryPath:`/api/catalog/${kind}/results/query`,body:{...body,impactToken:check.impactToken}});return;
    }
    if(action==='ignore-catalog'||action==='restore-catalog')return batchOperation({action:'ignore',path:itemPath(item.id)+'/ignore',queryPath:itemPath(item.id)+'/ignore/results/query',body:{ignored:action==='ignore-catalog',expectedBatchVersion:data!.batch.version,expectedReviewVersion:item.reviewVersion,idempotencyKey:crypto.randomUUID()}});
    if(action==='use-catalog'){
      const option=(catalogue[catalogKinds[item.kind]??item.kind]??[]).find(value=>String(value.id)===control.dataset.targetId)??item.candidates?.find(value=>value.id===control.dataset.targetId);if(!option)return;
      const latest=await get<{item:Values}>(`/api/catalog/${catalogKinds[item.kind]??item.kind}/${option.id}`);
      if(!latest.item.enabled){feedback(item,'这条资料已删除，请选择恢复并使用。','error');await loadOptions();renderOne(item);return;}
      option.version=latest.item.version;
      current.mode='existing';current.targetId=String(option.id);current.expectedVersion=String(option.version);current.mapping=false;current.choices=undefined;current.selected=[];if(item.previousResult)current.continuing=true;current.feedback='使用线上内容；点击保存资料并查看项目后生效。';resetReferenceEdits(item);persist();schedulePreview(item);renderOne(item);return;
    }

    if (action === 'edit') { current.payload ??= structuredClone(item.payload); current.editedPaths ??= []; current.editing = true;if(item.previousResult)current.continuing=true;applySelection(item);await loadOptions(); persist(); renderOne(item);schedulePreview(item); }
    if (action === 'cancel-edit') { current.editing = false; current.payload = undefined; current.editedPaths=undefined; persist(); await readBatch(data!.batch.id,item.id,true); }
    if(action==='finish-edit'){current.editing=false;persist();await preview(item);return;}
    if(action==='new-catalog'){current.mode='new';current.targetId=null;current.expectedVersion=null;current.mapping=false;persist();await preview(item);return;}
    if(action==='existing-catalog'){current.mode='existing';current.targetId=null;current.mapping=true;await loadOptions();persist();renderOne(item);return;}
    if (action === 'map') { if (isProject(item) && !projectOptions.length) await loadProjectOptions(); else if (!isProject(item)) await loadOptions(); current.mapping = true;if(item.previousResult)current.continuing=true; if(!item.needsMapping&&(item.targetId||isProject(item)))current.mode = item.mode; current.targetId = item.targetId; current.expectedVersion = item.expectedVersion; renderOne(item); }
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
  })().catch(error => { if (item) { feedback(item,explain(error),'error',error); renderOne(item); } else notice(explain(error),true,error); });
});

saveButton.onclick = () => { void saveSelected(); };
document.getElementById('imports-reload')!.onclick = () => { void (data ? readBatch(data.batch.id) : loadList()); };
window.addEventListener('beforeunload', event => { if (state.pendingUpload || state.pendingBatch || Object.values(state.cards ?? {}).some(card => !!card.editedPaths?.length || card.pending)) { event.preventDefault(); event.returnValue = ''; } });
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
    state.executions={...local.executions,...state.executions};
  }
  await Promise.all([loadList(),loadOptions()]);
  const id = new URLSearchParams(location.search).get('id');
  if (id) await readBatch(id);
  if (state.pendingUpload && !data) await upload(true);
  if (data) for (const item of allItems()) if (card(item).pending) await recoverLegacyItem(item);
  await pollExecution();
  setInterval(()=>{if(executionActive&&!executionReadFailed)void pollExecution();},2000);
  new ProjectNotifications(event => {
    if (!data || frozen) return;
    if (ownOperations.has(event.operationId) || executionActive) return;
    for (const item of data.items.filter(item => item.targetId === event.projectId && item.expectedVersion !== event.version)) {
      const current = card(item); current.stale = true; current.selected = []; feedback(item,'项目已被他人更新，请重新核对导入信息。'); renderOne(item);
    }
  }, () => {}, text => { if (text) notice(text); }, undefined, undefined, event => {
    if (event.resource !== 'catalog' || !data || frozen) return;
    if (ownOperations.has(event.operationId) || executionActive) return;
    void loadOptions();
    for (const item of allItems()) { const current = card(item); if (current.selected.length || current.editing) { current.stale = true; current.selected = []; feedback(item,'共享资料已更新，请核对当前对应后重新选择。'); renderOne(item); } }
  });
}).catch(error => { notice(explain(error),true,error); });
