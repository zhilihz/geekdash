import { account, get, send, SaveError, esc, label, actionLabels, type SaveScope } from './api';
import { readableFields } from './history';

export type DraftRef = { clientDraftId: string; draftVersion: string };
export type DraftData = { values?: Record<string, unknown>; intent?: Record<string, unknown>; record?: Record<string, unknown>; command?: Record<string, unknown>; submission?: Record<string, unknown>; editors?: Record<string,unknown> };
export type PersonalDraft = DraftRef & { projectId: string | null; formKind: SaveScope | 'create' | 'action'; baseVersion: string | null; clientSequence: string; state: string; updatedAt: string; payload: DraftData & { schemaVersion: 1; instanceId: string; target?: string } };
type Write = Omit<PersonalDraft,'draftVersion'|'state'|'updatedAt'> & { expectedDraftVersion: string; rebaseOperationId?: string };
type Slot = { desired: Write; confirmed?: PersonalDraft; pending?: Write; firstAt: number; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; blocked?: boolean; localStored?: boolean };
const ordered = (value:unknown):unknown => Array.isArray(value)?value.map(ordered):value && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,ordered(item)])):value;
const equal = (a: unknown,b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const emptyDraft = (data:DraftData) => !Object.keys(data.values??{}).length && !Object.keys(data.intent??{}).length && !Object.keys(data.record??{}).length && !Object.keys(data.command??{}).length && !Object.keys(data.editors??{}).length && !(data.submission?.commands as unknown[]|undefined)?.length;
const names: Record<string,string> = {project:'未保存的修改',basic:'基本信息与分工',status:'任务修改',tags:'项目标签',signal:'灯色与说明',stage:'阶段工期与评述',risk:'风险',change:'需求变更',customerNode:'客户节点',projectNodes:'项目节点与Flow',create:'新建项目',action:'未保存的操作',summaryNote:'状态简要备注',chipstatNote:'芯片备注'};
export function meaningfulEditor(value:Record<string,unknown>) {
  if(value.op==='correct')return Object.keys(value.changes as object??{}).length>0 || !!String(value.reason??value.correctionReason??'').trim();
  if(value.op==='add'){
    const fields=(value.fields??value) as Record<string,unknown>;
    return ['text','content','title','output','note','reason'].some(key=>!!String(fields[key]??'').trim()) || !!fields.targetDate || fields.level!==undefined&&fields.level!=='mid' || fields.decision!==undefined&&fields.decision!=='accept' || fields.source!==undefined&&fields.source!=='客户' || fields.stage!==undefined&&fields.stage!=='S1';
  }
  return true;
}
export function draftText(row:PersonalDraft) {
  const data=row.payload, lines:string[]=[], titles={reason:'原因',correctionReason:'纠正原因',actualDate:'实际日期',stageCode:'阶段',maintenance:'结案后维护',code:'阶段',text:'任务内容',state:row.formKind==='basic'?'项目状态':'阶段状态'};
  const operations:Record<string,string>={add:'新增',edit:'修改',correct:'修改',complete:'标记完成',reopen:'恢复为待办',delete:'删除',resolve:'解除',undoResolve:'撤销解除',uncomplete:'撤销完成',move:'移动',link:'连接',unlink:'断开连线',restore:'恢复'};
  const describe=(value:Record<string,unknown>,kind='')=>{
    const {op,action,id,tempId,expectedVersion,idempotencyKey,...fields}=value;
    if(kind==='任务')lines.push(`${operations[String(op)]??'修改'}${op==='add'?'待办任务':kind}${typeof fields.text==='string'?'：'+fields.text:''}`);
    else {
      const details=readableFields(fields,titles);
      lines.push([typeof action==='string'?actionLabels[action]??'修改项目状态':(operations[String(op)]??'修改')+kind,details].filter(Boolean).join('：'));
    }
  };
  for(const [key,value] of Object.entries(data.values??{})){
    if(['taskOps','riskOps','nodeOps','changeOps'].includes(key)&&Array.isArray(value))for(const operation of value)describe(operation,{taskOps:'任务',riskOps:'风险',nodeOps:'节点',changeOps:'需求变更'}[key]);
    else {const text=readableFields({[key]:value},titles);if(text)lines.push('修改'+text);}
  }
  if(data.intent){const text=readableFields(data.intent,titles);if(text)lines.push('修改项目状态与日期：'+text);}
  if(data.record)describe(data.record,names[row.formKind]);
  if(data.command)describe(data.command);
  for(const command of data.submission?.commands as Record<string,unknown>[]??[])describe(command);
  for(const [key,value] of Object.entries(data.editors??{})){
    if(key==='task')lines.push('修改待办任务：'+String((value as {text:string}).text));
    else if(key==='nodeExtras'&&Array.isArray(value))for(const operation of value)describe(operation,'关联节点');
    else if(value&&typeof value==='object')describe(value as Record<string,unknown>,{risk:'风险',change:'需求变更',node:'节点',action:'阶段与状态'}[key]);
  }
  return [...new Set(lines.filter(Boolean))].join('\n');
}

const messages: Record<string,string> = {DRAFT_CAPACITY_REACHED:'个人草稿已满，请在草稿列表明确丢弃不需要的内容。',DRAFT_TOO_LARGE:'本份草稿过大，请复制或导出后精简输入。',DRAFT_VERSION_CONFLICT:'这份草稿已有新修订，请先核对草稿列表。',DRAFT_TERMINAL:'这份草稿已提交或丢弃，请核对后继续。',DRAFT_BASE_CHANGED:'草稿基线需要重新核对，现有输入保留。',INVALID_PERSONAL_STATE:'这份草稿的格式需要核对，输入仍在本页。'};

type PreferenceValue = Record<string,unknown> & {schemaVersion:1};
type PreferenceRow = {version:string;value:PreferenceValue|null};
export class PersonalPreference {
  private version:string|undefined;
  private value:PreferenceValue={schemaVersion:1};
  private serverValue:PreferenceValue={schemaVersion:1};
  private changes:Record<string,unknown>={};
  private generation=0;
  private handledGeneration=0;
  private stopped=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private running:Promise<void>|undefined;
  private deviceKey:string;
  private cacheKey:string;
  private global:boolean;
  constructor(private scope:string,private feedback:(message:string)=>void=()=>{}){
    this.global=['appearance','summary-layout','imports'].includes(scope);
    let device=crypto.randomUUID();
    try{const saved=localStorage.getItem('geekdash_device');if(saved && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved))device=saved as typeof device;else localStorage.setItem('geekdash_device',device);}catch{}
    this.deviceKey=this.global?'account':device;this.cacheKey=`geekdash_preference:${account!.id}:${scope}`;
    document.addEventListener('geekdash-identity-changed',()=>{this.stopped=true;clearTimeout(this.timer);});
  }
  private cache(){if(this.stopped)return;try{(this.global?localStorage:sessionStorage).setItem(this.cacheKey,JSON.stringify({...this.value,...this.scope==='appearance' && this.changes.theme?{pendingTheme:this.changes.theme,pendingThemeVersion:this.version}:{}}));}catch{this.feedback('本机页面状态无法保留，当前操作仍可继续。');}}
  private read(){return get<PreferenceRow>('/api/personal/preferences?'+new URLSearchParams({deviceKey:this.deviceKey,scope:this.scope}),undefined,false);}
  current(){return structuredClone(this.value);}
  revision(){return this.version;}
  async load():Promise<PreferenceValue>{
    const generation=this.generation;let cached:PreferenceValue|undefined,pendingTheme:string|undefined,pendingVersion:string|undefined;
    try{const parsed=JSON.parse((this.global?localStorage:sessionStorage).getItem(this.cacheKey) ?? 'null');if(parsed?.schemaVersion===1){const {pendingTheme:pending,pendingThemeVersion:version,...value}=parsed;cached=value;if(this.scope==='appearance' && ['dark','light','warm'].includes(pending)){pendingTheme=pending;if(typeof version==='string' && /^(0|[1-9][0-9]*)$/.test(version))pendingVersion=version;}}}catch{}
    try{const row=await this.read();if(this.stopped)return {schemaVersion:1};this.version=row.version;this.serverValue=row.value ?? {schemaVersion:1};if(generation===this.generation)this.value=(!this.global && cached?cached:row.value ?? cached) ?? {schemaVersion:1};}
    catch{if(generation===this.generation && cached)this.value=cached;if(this.scope==='imports')this.stopped=true;this.feedback(this.scope==='imports'?'导入页状态暂未读回，当前输入保留在本机；刷新后再同步。':'页面偏好暂未同步，当前页面仍可使用。');}
    if(generation===this.generation && pendingTheme){
      if(this.version===undefined)return structuredClone(this.value); // 读取失败，保留原基线缓存供下次读取，不借未知版本重放。
      if(this.serverValue.theme!==pendingTheme){
        if(this.version===pendingVersion){this.update({theme:pendingTheme},0);return structuredClone(this.value);}
        this.value={...this.value,theme:pendingTheme};
        this.feedback('主题偏好已有新版本，本页颜色保持；再次选择颜色后才会同步。');
      }
    }
    this.cache();
    return structuredClone(this.value);
  }
  update(changes:Record<string,unknown>,delay=500){
    if(this.stopped)return;this.changes={...this.changes,...structuredClone(changes)};this.value={...this.value,...structuredClone(changes),schemaVersion:1};this.generation++;this.cache();
    clearTimeout(this.timer);this.timer=setTimeout(()=>{void this.flush();},delay);
  }
  async flush():Promise<void>{
    clearTimeout(this.timer);if(this.stopped || this.generation<=this.handledGeneration)return;if(this.running){await this.running;return this.flush();}
    const generation=this.generation;let saved=false;
    this.running=(async()=>{try{
      if(this.version===undefined){const current=await this.read();if(this.stopped)return;this.version=current.version;this.serverValue=current.value ?? {schemaVersion:1};}
      const changes=structuredClone(this.changes),submitted={...this.serverValue,...changes,schemaVersion:1};
      const row=await send<PreferenceRow>('/api/personal/preferences/save','POST',{deviceKey:this.deviceKey,scope:this.scope,expectedVersion:this.version,value:submitted},false);
      if(this.stopped)return;this.version=row.version;this.serverValue=row.value ?? {schemaVersion:1};for(const key of Object.keys(changes))if(equal(changes[key],this.changes[key]))delete this.changes[key];this.handledGeneration=generation;saved=true;this.cache();
    }catch(error){
      if(this.stopped)return;
      this.handledGeneration=this.generation;this.changes={};clearTimeout(this.timer);
      if(this.scope==='imports'){this.stopped=true;this.feedback('导入页状态尚未同步，输入和原操作保留在本机；刷新后核对服务器内容。');return;}
      this.cache();
      // 不自动重放冲突或未知写入；仅更新版本供下一次明确操作使用。
      try{const current=await this.read();if(!this.stopped){this.version=current.version;this.serverValue=current.value ?? {schemaVersion:1};}}catch{this.version=undefined;}
      this.feedback(error instanceof SaveError && error.code==='PREFERENCE_VERSION_CONFLICT'?'页面偏好已有新版本，当前布局保持；下次操作将重新同步。':'页面状态尚未同步，当前标签中的操作已保留。');
    }finally{this.running=undefined;}})();
    await this.running;if(saved && generation!==this.generation)await this.flush();
  }
}

// 同一页面共用一份同步器，各保存范围独立编号、修订和串行队列。
export class PersonalDrafts {
  readonly instanceId: string;
  private readonly actor = account!.id;
  private slots = new Map<string,Slot>();
  private stopped = false;
  private button: HTMLButtonElement;
  private dialog: HTMLDialogElement;
  private recovery: HTMLElement | undefined;
  private status = '查看和恢复个人草稿';
  constructor(private projectId: string | null,private context: () => {version:string|null;editable:boolean},private restore: (row:PersonalDraft)=>boolean|Promise<boolean>,private options:{button?:boolean;kinds?:PersonalDraft['formKind'][]}={}) {
    const key = `geekdash_page:${this.actor}:${projectId ?? 'new'}`;
    let instance: string = crypto.randomUUID();
    try {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (navigation?.type === 'reload') instance = sessionStorage.getItem(key) || instance;
      sessionStorage.setItem(key,instance);
    } catch { /* 写入失败时仍使用本页独立实例。 */ }
    this.instanceId=instance;
    this.button=document.createElement('button');this.button.className='back-btn';this.button.type='button';this.button.id='personal-drafts';this.button.textContent='个人草稿';
    if(options.button!==false)(document.querySelector('.head-actions') ?? document.querySelector('.topbar') ?? document.body).append(this.button);
    this.dialog=document.createElement('dialog');this.dialog.className='draft-dialog';this.dialog.setAttribute('aria-label','个人草稿');document.body.append(this.dialog);
    this.button.onclick=()=>{void this.open();};
    document.addEventListener('geekdash-identity-changed',()=>{this.stopped=true;this.recovery?.remove();this.dialog.close();for(const slot of this.slots.values())clearTimeout(slot.timer);this.status='账号已变化，自动同步已停止';this.updateStatus();});
  }
  private key(kind:string,target?:string) {return kind+':'+(target ?? '');}
  private localKey(id:string) {return `geekdash_draft:${this.actor}:${id}`;}
  private store(slot:Slot) {
    if(this.stopped)return false;
    try {localStorage.setItem(this.localKey(slot.desired.clientDraftId),JSON.stringify({desired:slot.desired,confirmed:slot.confirmed,pending:slot.pending,savedAt:new Date().toISOString()}));slot.localStored=true;}
    catch {slot.localStored=false;}
    return slot.localStored;
  }
  hasLocalCopy(){return [...this.slots.values()].every(slot=>slot.localStored===true);}
  private updateStatus(){this.button.title=this.status;this.button.setAttribute('aria-label','个人草稿：'+this.status);const node=this.dialog.querySelector('[data-draft-status]');if(node)node.textContent=this.status;}
  capture(kind:PersonalDraft['formKind'],target:string|undefined,baseVersion:string|null,data:DraftData) {
    if(this.stopped || !this.context().editable)return;
    const key=this.key(kind,target), old=this.slots.get(key);
    if(emptyDraft(data) && !old)return;
    this.recovery?.remove();
    const payload={schemaVersion:1 as const,instanceId:this.instanceId,...target?{target}:{},...structuredClone(data)};
    if(old && equal(old.desired.payload,payload) && old.desired.baseVersion===baseVersion)return;
    const slot:Slot=old ?? {desired:{clientDraftId:crypto.randomUUID(),projectId:this.projectId,formKind:kind,baseVersion,expectedDraftVersion:'0',clientSequence:'1',payload},firstAt:Date.now()};
    // 不用新读到的版本替换旧底稿；advance只接受本页已确认的提交依据。
    if(old && old.desired.baseVersion!==baseVersion){this.status='旧草稿基线保留，请在草稿列表核对';this.updateStatus();return;}
    slot.desired.payload=payload;this.slots.set(key,slot);
    this.status=this.store(slot)?'输入已留在本机，等待同步':'本机底稿存储不可用，输入仅在当前页；请等待同步或复制内容';this.updateStatus();
    clearTimeout(slot.timer);slot.timer=setTimeout(()=>{void this.flush(key);},Math.max(0,Math.min(1000,5000-(Date.now()-slot.firstAt))));
  }
  private async flush(key:string):Promise<void>{
    const slot=this.slots.get(key);if(!slot || this.stopped || slot.blocked)return;
    clearTimeout(slot.timer);if(slot.running){await slot.running;return this.flush(key);}
    if(emptyDraft(slot.desired.payload) && !slot.pending){
      const empty=structuredClone(slot.desired.payload);
      slot.running=(async()=>{
        try{
          if(slot.confirmed)await send('/api/personal/drafts/discard','POST',{clientDraftId:slot.confirmed.clientDraftId,draftVersion:slot.confirmed.draftVersion});
          this.slots.delete(key);try{localStorage.removeItem(this.localKey(slot.desired.clientDraftId));}catch{}
          this.status='没有未保存的修改';
          if(!equal(empty,slot.desired.payload)){
            const {schemaVersion,instanceId,target,...data}=slot.desired.payload;
            this.capture(slot.desired.formKind,target,slot.desired.baseVersion,data);
          }
        }catch{this.status='取消后的草稿清理尚未确认，可在个人草稿重试。';}
        finally{slot.running=undefined;this.updateStatus();}
      })();
      await slot.running;return;
    }
    if(!slot.pending && slot.confirmed && equal(slot.confirmed.payload,slot.desired.payload) && slot.confirmed.baseVersion===slot.desired.baseVersion)return;
    slot.pending ??= {...structuredClone(slot.desired),expectedDraftVersion:slot.confirmed?.draftVersion ?? '0',clientSequence:slot.confirmed ? String(BigInt(slot.confirmed.clientSequence)+1n) : '1'};
    this.store(slot);
    let synchronized=false;
    slot.running=(async()=>{
      try {
        const row=await send<PersonalDraft>('/api/personal/drafts/save','POST',slot.pending,false);
        if(this.stopped)return;
        slot.confirmed=row;slot.pending=undefined;slot.firstAt=Date.now();synchronized=true;this.store(slot);
        this.status=equal(row.payload,slot.desired.payload) && row.baseVersion===slot.desired.baseVersion?'草稿已同步；正式项目仍需点击保存':'后续输入等待同步';
      }catch(error){
        const code=error instanceof SaveError?error.code:'';
        slot.blocked=['DRAFT_VERSION_CONFLICT','DRAFT_TERMINAL','DRAFT_BASE_CHANGED','PROJECT_READ_ONLY','AUTH_REQUIRED','AUTH_CONTEXT_CHANGED','PASSWORD_CHANGE_REQUIRED','CSRF_INVALID'].includes(code);
        // 明确拒绝可用新输入重新同步，未知结果必须先重放同一序号。
        if(error instanceof SaveError && error.outcome==='not_committed' && !slot.blocked)slot.pending=undefined;
        const localStored=this.store(slot);
        this.status=messages[code] ?? (localStored?'草稿未同步，仅保留在当前设备；可重试、复制或导出':'草稿未同步，本机底稿也未保存；请保留页面并复制内容');
        if(!localStored && messages[code])this.status+=' 本机底稿也未保存，请保留页面并复制内容。';
      }finally{slot.running=undefined;this.updateStatus();}
    })();
    await slot.running;
    if(synchronized && !slot.pending && slot.confirmed && (!equal(slot.confirmed.payload,slot.desired.payload) || slot.confirmed.baseVersion!==slot.desired.baseVersion) && !slot.blocked)await this.flush(key);
  }
  async prepare(kind:PersonalDraft['formKind'],target?:string):Promise<DraftRef|undefined>{
    const key=this.key(kind,target);await this.flush(key);const slot=this.slots.get(key);
    return slot?.confirmed && !slot.pending && equal(slot.confirmed.payload,slot.desired.payload) && slot.confirmed.baseVersion===slot.desired.baseVersion?{clientDraftId:slot.confirmed.clientDraftId,draftVersion:slot.confirmed.draftVersion}:undefined;
  }
  async advance(result:{operationId:string;savedVersion:string;baseVersion?:string;draft?:DraftRef&{instanceId:string;state:string}},completed?:{kind:PersonalDraft['formKind'];target?:string}){
    for(const [key,slot] of this.slots){
      clearTimeout(slot.timer);if(slot.running)await slot.running;
      if(result.draft?.clientDraftId===slot.desired.clientDraftId){
        this.slots.delete(key);
        if(result.draft.state==='committed' && slot.confirmed && equal(slot.confirmed.payload,slot.desired.payload))try{localStorage.removeItem(this.localKey(slot.desired.clientDraftId));}catch{}
      }else if(completed && key===this.key(completed.kind,completed.target)){
        // 没有精确草稿回执时不删除旧本机/云稿；剩余新输入由页面重新capture。
        this.slots.delete(key);
      }else if(result.baseVersion===slot.desired.baseVersion){
        if(result.draft?.instanceId===this.instanceId){
          await this.flush(key);
          if(!slot.pending && !slot.blocked){slot.desired.baseVersion=result.savedVersion;slot.desired.rebaseOperationId=result.operationId;this.store(slot);slot.timer=setTimeout(()=>{void this.flush(key);},1000);continue;}
        }
        // 已确认本页正式提交并新读后才调用本入口。无云稿证明则另建副本，旧稿及未知同步请求继续保留供核对。
        this.store(slot);
        const next:Slot={desired:{...structuredClone(slot.desired),clientDraftId:crypto.randomUUID(),expectedDraftVersion:'0',clientSequence:'1',baseVersion:result.savedVersion},firstAt:Date.now()};
        delete next.desired.rebaseOperationId;this.slots.set(key,next);this.store(next);
        next.timer=setTimeout(()=>{void this.flush(key);},1000);
      }
    }
  }
  async discard(kind:PersonalDraft['formKind'],target?:string){
    const key=this.key(kind,target),slot=this.slots.get(key);if(!slot)return;
    clearTimeout(slot.timer);if(slot.running)await slot.running;
    if(slot.pending){await this.flush(key);if(slot.pending)throw new Error('草稿同步结果尚未确认，请先重试或复制内容。');}
    if(slot.confirmed)await send('/api/personal/drafts/discard','POST',{clientDraftId:slot.confirmed.clientDraftId,draftVersion:slot.confirmed.draftVersion});
    this.slots.delete(key);try{localStorage.removeItem(this.localKey(slot.desired.clientDraftId));}catch{}
  }
  async sync(){for(const key of this.slots.keys())await this.flush(key);return !this.stopped && [...this.slots.values()].every(slot=>slot.confirmed && !slot.pending && !slot.blocked && equal(slot.confirmed.payload,slot.desired.payload) && slot.confirmed.baseVersion===slot.desired.baseVersion);}
  async discardAll(){for(const key of [...this.slots.keys()]){const slot=this.slots.get(key);if(slot)await this.discard(slot.desired.formKind,slot.desired.payload.target);}}
  private async discardListed(row:PersonalDraft){
    const entry=[...this.slots].find(([,slot])=>slot.desired.clientDraftId===row.clientDraftId),slot=entry?.[1];
    if(slot){clearTimeout(slot.timer);if(slot.running)await slot.running;}
    const localKey=this.localKey(row.clientDraftId);
    let local:{desired?:Write}|null,localUnavailable=false;
    try{local=JSON.parse(localStorage.getItem(localKey) ?? 'null');}
    catch{localUnavailable=true;local=slot?{desired:slot.desired}:null;}
    if(row.state==='local'){
      if(localUnavailable)throw new Error('本机存储暂不可用，无法确认已丢弃本机副本；请保留当前输入，恢复存储后重试。');
      if(local && !equal(local.desired?.payload,row.payload))throw new Error('本机副本已有新输入，请重新查看再决定丢弃。');
      try{localStorage.removeItem(localKey);}catch{throw new Error('本机存储暂不可用，无法确认已丢弃本机副本；请保留当前输入，恢复存储后重试。');}
      if(entry)this.slots.delete(entry[0]);return;
    }
    await send('/api/personal/drafts/discard','POST',{clientDraftId:row.clientDraftId,draftVersion:row.draftVersion});
    if(local && !equal(local.desired?.payload,row.payload)){
      // 仅丢弃选中的云稿；尚未同步的不同本机输入继续以新编号保护。
      if(slot){const next:Slot={desired:{...slot.desired,clientDraftId:crypto.randomUUID(),expectedDraftVersion:'0',clientSequence:'1'},firstAt:Date.now()};delete next.desired.rebaseOperationId;this.slots.set(entry![0],next);if(this.store(next))try{localStorage.removeItem(localKey);}catch{localUnavailable=true;}else localUnavailable=true;}
    }else{if(entry)this.slots.delete(entry[0]);try{localStorage.removeItem(localKey);}catch{localUnavailable=true;}}
    if(localUnavailable)return '服务器草稿已丢弃；本机存储暂不可用，无法确认本机副本是否清除。';
  }
  private async available(){
    let rows:PersonalDraft[]=[], cloudUnavailable=false;
    try {rows=(await get<{items:PersonalDraft[]}>('/api/personal/drafts?projectId='+(this.projectId ?? 'new'),undefined,false)).items;}
    catch {cloudUnavailable=true;}
    // 云端与本地分别列出；不能按设备时间猜测覆盖顺序。
    const local:PersonalDraft[]=[];
    try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i)!;if(!key.startsWith(`geekdash_draft:${this.actor}:`))continue;const item=JSON.parse(localStorage.getItem(key)!);if(item.desired?.projectId!==this.projectId || item.desired.payload?.schemaVersion!==1)continue;
      if(!rows.some(row=>row.clientDraftId===item.desired.clientDraftId && row.baseVersion===item.desired.baseVersion && equal(row.payload,item.desired.payload)))local.push({...item.desired,draftVersion:item.confirmed?.draftVersion ?? '0',state:'local',updatedAt:item.savedAt ?? ''});}}
    catch{this.status='部分本机底稿无法读取，请保留原页面内容';this.updateStatus();}
    return {candidates:[...rows,...local].filter(row=>!this.options.kinds || this.options.kinds.includes(row.formKind)),cloudUnavailable};
  }
  private async continueDraft(row:PersonalDraft){
    if(this.stopped || !this.context().editable || row.baseVersion!==this.context().version)return;
    const key=this.key(row.formKind,row.payload.target),slot=this.slots.get(key);
    if(slot){clearTimeout(slot.timer);if(slot.running)await slot.running;if(this.stopped)return;this.slots.delete(key);}
    this.dialog.close();this.recovery?.remove();
    if(!await this.restore(row) && slot){this.slots.set(key,slot);this.store(slot);slot.timer=setTimeout(()=>{void this.flush(key);},1000);}
  }
  async offer(local?:{text:string;restore:()=>boolean|Promise<boolean>;discard:()=>void|Promise<void>}){
    if(this.stopped || this.slots.size)return;
    const {candidates,cloudUnavailable}=local?{candidates:[],cloudUnavailable:false}:await this.available();
    if(this.stopped || this.slots.size || this.dialog.open || cloudUnavailable || !local && !candidates.length)return;
    const current=candidates.filter(row=>row.baseVersion===this.context().version);
    const row=current.length===1?current[0]:candidates.length===1?candidates[0]:undefined;
    const usable=this.context().editable && (!!local || !!row && row.baseVersion===this.context().version);
    this.recovery?.remove();
    const box=this.recovery=document.createElement('aside');box.className='draft-recovery';box.setAttribute('aria-label','恢复未保存的输入');
    box.innerHTML=`<strong>${usable?'有未保存的'+(local?'输入':esc(names[row!.formKind])):'有个人草稿可查看'}</strong><p>${usable?esc((local?.text ?? draftText(row!)).slice(0,140)):'可查看内容；旧版本的输入仅供复制核对。'}</p><div class="entry-actions"><button type="button" class="back-btn" data-continue>${usable?'继续编辑':'查看草稿'}</button>${usable?'<button type="button" class="back-btn" data-discard>丢弃</button>':''}<button type="button" class="back-btn" data-later>稍后</button></div>`;
    box.querySelector<HTMLButtonElement>('[data-continue]')!.onclick=()=>{void(async()=>{try{if(local && usable){if(!this.stopped && this.context().editable && await local.restore())box.remove();else box.querySelector('p')!.textContent='页面内容已变化，请从个人草稿核对保留的输入。';}else await (usable?this.continueDraft(row!):this.open());}catch(error){box.querySelector('p')!.textContent=(error as Error).message;}})();};
    box.querySelector<HTMLButtonElement>('[data-later]')!.onclick=()=>box.remove();
    const discard=box.querySelector<HTMLButtonElement>('[data-discard]');if(discard)discard.onclick=()=>{void(async()=>{try{const warning=local?await local.discard():await this.discardListed(row!);if(warning){box.querySelector('strong')!.textContent='服务器草稿已丢弃';box.querySelector('p')!.textContent=warning;box.querySelector('[data-continue]')?.remove();discard.remove();box.querySelector('[data-later]')!.textContent='关闭';}else box.remove();}catch(error){box.querySelector('p')!.textContent=(error as Error).message;}})();};
    document.body.append(box);
  }
  async open(){
    if(this.stopped)return;this.recovery?.remove();
    this.dialog.innerHTML='<div class="draft-dialog-head"><h2>个人草稿</h2><button type="button" class="back-btn" data-close>关闭</button></div><p data-draft-status></p><button class="back-btn" data-sync>重试同步</button><div data-draft-list>正在读取…</div>';
    this.dialog.querySelector<HTMLButtonElement>('[data-close]')!.onclick=()=>this.dialog.close();
    this.dialog.querySelector<HTMLButtonElement>('[data-sync]')!.onclick=()=>{void this.sync().then(()=>this.open());};
    if(!this.dialog.open)this.dialog.showModal();this.updateStatus();
    const list=this.dialog.querySelector<HTMLElement>('[data-draft-list]')!;
    const {candidates,cloudUnavailable}=await this.available();if(this.stopped)return;
    list.textContent=cloudUnavailable?'服务器草稿暂时无法读取。以下仅为当前设备保留的输入。':candidates.length?'':'没有未提交的个人草稿。';
    candidates.forEach(row=>{
      const box=document.createElement('section');box.className='project-info';
      box.dataset.draftId=row.clientDraftId;box.dataset.source=row.state;
      const usable=this.context().editable && row.baseVersion===this.context().version;
      const preview=draftText(row);
      box.innerHTML=`<h3>${esc(names[row.formKind] ?? row.formKind)}</h3><p>${candidates.length>1?(row.state==='local'?'此设备保留':'已同步')+' · ':''}${row.updatedAt?esc(new Date(row.updatedAt).toLocaleString('zh-CN')):''}${usable?'':' · 项目已变化或当前只读，仅供复制核对'}</p>${preview?`<pre>${esc(preview)}</pre>`:''}<div class="entry-actions"><button class="back-btn" data-restore ${usable?'':'disabled'}>继续编辑</button><button class="back-btn" data-copy>复制内容</button><button class="back-btn" data-export>导出备份</button><button class="back-btn" data-discard>丢弃</button></div><pre data-copy-fallback hidden></pre>`;
      box.querySelector<HTMLButtonElement>('[data-restore]')!.onclick=()=>{void this.continueDraft(row);};
      const content=JSON.stringify(row.payload,null,2);
      box.querySelector<HTMLButtonElement>('[data-copy]')!.onclick=()=>{void(async()=>{try{await navigator.clipboard.writeText(preview);}catch{const pre=box.querySelector<HTMLElement>('[data-copy-fallback]')!;pre.hidden=false;pre.textContent=preview;}})();};
      box.querySelector<HTMLButtonElement>('[data-export]')!.onclick=()=>{const url=URL.createObjectURL(new Blob([content],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='GeekDash-个人草稿.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
      box.querySelector<HTMLButtonElement>('[data-discard]')!.onclick=()=>{void(async()=>{if(!confirm('仅丢弃所选草稿？当前表单输入和正式项目信息保持。'))return;try{const warning=await this.discardListed(row);await this.open();if(warning){this.status=warning;this.updateStatus();}}catch(error){this.status=(error as Error).message;this.updateStatus();}})();};
      list.append(box);
    });
  }
}
