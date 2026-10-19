import { account, get, send, SaveError, esc, type SaveScope } from './api';

export type DraftRef = { clientDraftId: string; draftVersion: string };
export type DraftData = { values?: Record<string, unknown>; intent?: Record<string, unknown>; record?: Record<string, unknown>; command?: Record<string, unknown>; submission?: Record<string, unknown> };
export type PersonalDraft = DraftRef & { projectId: string | null; formKind: SaveScope | 'create' | 'action'; baseVersion: string | null; clientSequence: string; state: string; updatedAt: string; payload: DraftData & { schemaVersion: 1; instanceId: string; target?: string } };
type Write = Omit<PersonalDraft,'draftVersion'|'state'|'updatedAt'> & { expectedDraftVersion: string; rebaseOperationId?: string };
type Slot = { desired: Write; confirmed?: PersonalDraft; pending?: Write; firstAt: number; timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; blocked?: boolean };
const ordered = (value:unknown):unknown => Array.isArray(value)?value.map(ordered):value && typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,ordered(item)])):value;
const equal = (a: unknown,b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const names: Record<string,string> = {basic:'基本信息与分工',status:'最新状态说明',tags:'项目标签',signal:'灯色与说明',stage:'阶段工期与评述',risk:'风险',change:'需求变更',customerNode:'客户节点',projectNodes:'项目节点与Flow',create:'新建项目',action:'项目动作',summaryNote:'状态简要备注',chipstatNote:'芯片备注'};
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
    this.global=['appearance','summary-layout'].includes(scope);
    let device=crypto.randomUUID();
    try{const saved=localStorage.getItem('geekdash_device');if(saved && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved))device=saved as typeof device;else localStorage.setItem('geekdash_device',device);}catch{}
    this.deviceKey=this.global?'account':device;this.cacheKey=`geekdash_preference:${account!.id}:${scope}`;
    document.addEventListener('geekdash-identity-changed',()=>{this.stopped=true;clearTimeout(this.timer);});
  }
  private cache(){if(this.stopped)return;try{(this.global?localStorage:sessionStorage).setItem(this.cacheKey,JSON.stringify(this.value));}catch{this.feedback('本机页面状态无法保留，当前操作仍可继续。');}}
  private read(){return get<PreferenceRow>('/api/personal/preferences?'+new URLSearchParams({deviceKey:this.deviceKey,scope:this.scope}),undefined,false);}
  current(){return structuredClone(this.value);}
  async load():Promise<PreferenceValue>{
    const generation=this.generation;let cached:PreferenceValue|undefined;
    try{const parsed=JSON.parse((this.global?localStorage:sessionStorage).getItem(this.cacheKey) ?? 'null');if(parsed?.schemaVersion===1)cached=parsed;}catch{}
    try{const row=await this.read();if(this.stopped)return {schemaVersion:1};this.version=row.version;this.serverValue=row.value ?? {schemaVersion:1};if(generation===this.generation)this.value=(!this.global && cached?cached:row.value ?? cached) ?? {schemaVersion:1};}
    catch{if(generation===this.generation && cached)this.value=cached;this.feedback('页面偏好暂未同步，当前页面仍可使用。');}
    this.cache();return structuredClone(this.value);
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
      if(this.stopped)return;this.version=row.version;this.serverValue=row.value ?? {schemaVersion:1};for(const key of Object.keys(changes))if(equal(changes[key],this.changes[key]))delete this.changes[key];this.handledGeneration=generation;saved=true;
    }catch(error){
      if(this.stopped)return;
      this.handledGeneration=this.generation;this.changes={};clearTimeout(this.timer);
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
    if(options.button!==false)(document.querySelector('.head-actions') ?? document.body).append(this.button);
    this.dialog=document.createElement('dialog');this.dialog.className='draft-dialog';this.dialog.setAttribute('aria-label','个人草稿');document.body.append(this.dialog);
    this.button.onclick=()=>{void this.open();};
    document.addEventListener('geekdash-identity-changed',()=>{this.stopped=true;for(const slot of this.slots.values())clearTimeout(slot.timer);this.status='账号已变化，自动同步已停止';this.updateStatus();});
  }
  private key(kind:string,target?:string) {return kind+':'+(target ?? '');}
  private localKey(id:string) {return `geekdash_draft:${this.actor}:${id}`;}
  private store(slot:Slot) {
    if(this.stopped)return;
    try {localStorage.setItem(this.localKey(slot.desired.clientDraftId),JSON.stringify({desired:slot.desired,confirmed:slot.confirmed,pending:slot.pending,savedAt:new Date().toISOString()}));}
    catch {this.status='本机底稿存储不可用，请复制未保存内容';this.updateStatus();}
  }
  private updateStatus(){this.button.title=this.status;this.button.setAttribute('aria-label','个人草稿：'+this.status);const node=this.dialog.querySelector('[data-draft-status]');if(node)node.textContent=this.status;}
  capture(kind:PersonalDraft['formKind'],target:string|undefined,baseVersion:string|null,data:DraftData) {
    if(this.stopped || !this.context().editable)return;
    const key=this.key(kind,target), old=this.slots.get(key);
    const payload={schemaVersion:1 as const,instanceId:this.instanceId,...target?{target}:{},...structuredClone(data)};
    if(old && equal(old.desired.payload,payload) && old.desired.baseVersion===baseVersion)return;
    const slot:Slot=old ?? {desired:{clientDraftId:crypto.randomUUID(),projectId:this.projectId,formKind:kind,baseVersion,expectedDraftVersion:'0',clientSequence:'1',payload},firstAt:Date.now()};
    // 不用新读到的版本替换旧底稿；advance只接受本页已确认的提交依据。
    if(old && old.desired.baseVersion!==baseVersion){this.status='旧草稿基线保留，请在草稿列表核对';this.updateStatus();return;}
    slot.desired.payload=payload;this.slots.set(key,slot);this.store(slot);
    this.status='输入已留在本机，等待同步';this.updateStatus();
    clearTimeout(slot.timer);slot.timer=setTimeout(()=>{void this.flush(key);},Math.max(0,Math.min(1000,5000-(Date.now()-slot.firstAt))));
  }
  private async flush(key:string):Promise<void>{
    const slot=this.slots.get(key);if(!slot || this.stopped || slot.blocked)return;
    clearTimeout(slot.timer);if(slot.running){await slot.running;return this.flush(key);}
    if(!slot.pending && slot.confirmed && equal(slot.confirmed.payload,slot.desired.payload) && slot.confirmed.baseVersion===slot.desired.baseVersion)return;
    slot.pending ??= {...structuredClone(slot.desired),expectedDraftVersion:slot.confirmed?.draftVersion ?? '0',clientSequence:slot.confirmed ? String(BigInt(slot.confirmed.clientSequence)+1n) : '1'};
    this.store(slot);
    let synchronized=false;
    slot.running=(async()=>{
      try {
        const row=await send<PersonalDraft>('/api/personal/drafts/save','POST',slot.pending,false);
        if(this.stopped)return;
        slot.confirmed=row;slot.pending=undefined;slot.firstAt=Date.now();synchronized=true;this.store(slot);
        this.status=equal(row.payload,slot.desired.payload)?'草稿已同步；正式项目仍需点击保存':'后续输入等待同步';
      }catch(error){
        const code=error instanceof SaveError?error.code:'';
        slot.blocked=['DRAFT_VERSION_CONFLICT','DRAFT_TERMINAL','DRAFT_BASE_CHANGED','PROJECT_READ_ONLY','AUTH_REQUIRED','AUTH_CONTEXT_CHANGED','PASSWORD_CHANGE_REQUIRED','CSRF_INVALID'].includes(code);
        // 明确拒绝可用新输入重新同步，未知结果必须先重放同一序号。
        if(error instanceof SaveError && error.outcome==='not_committed' && !slot.blocked)slot.pending=undefined;
        this.status=messages[code] ?? '草稿未同步，仅保留在当前设备；可重试、复制或导出';this.store(slot);
      }finally{slot.running=undefined;this.updateStatus();}
    })();
    await slot.running;
    if(synchronized && !slot.pending && slot.confirmed && !equal(slot.confirmed.payload,slot.desired.payload) && !slot.blocked)await this.flush(key);
  }
  async prepare(kind:PersonalDraft['formKind'],target?:string):Promise<DraftRef|undefined>{
    const key=this.key(kind,target);await this.flush(key);const slot=this.slots.get(key);
    return slot?.confirmed && !slot.pending && equal(slot.confirmed.payload,slot.desired.payload)?{clientDraftId:slot.confirmed.clientDraftId,draftVersion:slot.confirmed.draftVersion}:undefined;
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
          if(!slot.pending && !slot.blocked){slot.desired.baseVersion=result.savedVersion;slot.desired.rebaseOperationId=result.operationId;this.store(slot);continue;}
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
    const local=JSON.parse(localStorage.getItem(localKey) ?? 'null');
    if(row.state==='local'){
      if(local && !equal(local.desired?.payload,row.payload))throw new Error('本机副本已有新输入，请重新查看再决定丢弃。');
      if(entry)this.slots.delete(entry[0]);localStorage.removeItem(localKey);return;
    }
    await send('/api/personal/drafts/discard','POST',{clientDraftId:row.clientDraftId,draftVersion:row.draftVersion});
    if(local && !equal(local.desired?.payload,row.payload)){
      // 仅丢弃选中的云稿；尚未同步的不同本机输入继续以新编号保护。
      if(slot){const next:Slot={desired:{...slot.desired,clientDraftId:crypto.randomUUID(),expectedDraftVersion:'0',clientSequence:'1'},firstAt:Date.now()};delete next.desired.rebaseOperationId;this.slots.set(entry![0],next);this.store(next);if(localStorage.getItem(this.localKey(next.desired.clientDraftId)))localStorage.removeItem(localKey);}
    }else{if(entry)this.slots.delete(entry[0]);localStorage.removeItem(localKey);}
  }
  async open(){
    this.dialog.innerHTML='<div class="draft-dialog-head"><h2>个人草稿</h2><button type="button" class="back-btn" data-close>关闭</button></div><p data-draft-status></p><button class="back-btn" data-sync>重试同步</button><div data-draft-list>正在读取…</div>';
    this.dialog.querySelector<HTMLButtonElement>('[data-close]')!.onclick=()=>this.dialog.close();
    this.dialog.querySelector<HTMLButtonElement>('[data-sync]')!.onclick=()=>{void this.sync().then(()=>this.open());};
    if(!this.dialog.open)this.dialog.showModal();this.updateStatus();
    const list=this.dialog.querySelector<HTMLElement>('[data-draft-list]')!;
    let rows:PersonalDraft[]=[], cloudUnavailable=false;
    try {rows=(await get<{items:PersonalDraft[]}>('/api/personal/drafts?projectId='+(this.projectId ?? 'new'),undefined,false)).items;}
    catch {cloudUnavailable=true;}
    // 云端与本地分别列出；不能按设备时间猜测覆盖顺序。
    const local:PersonalDraft[]=[];
    try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i)!;if(!key.startsWith(`geekdash_draft:${this.actor}:`))continue;const item=JSON.parse(localStorage.getItem(key)!);if(item.desired?.projectId!==this.projectId || item.desired.payload?.schemaVersion!==1)continue;
      if(!rows.some(row=>row.clientDraftId===item.desired.clientDraftId && equal(row.payload,item.desired.payload)))local.push({...item.desired,draftVersion:item.confirmed?.draftVersion ?? '0',state:'local',updatedAt:item.savedAt ?? ''});}}
    catch{this.status='部分本机底稿无法读取，请保留原页面内容';this.updateStatus();}
    const candidates=[...rows,...local].filter(row=>!this.options.kinds || this.options.kinds.includes(row.formKind));list.textContent=cloudUnavailable?'服务器草稿暂时无法读取。以下仅为当前设备保留的输入。':candidates.length?'':'没有未提交的个人草稿。';
    candidates.forEach(row=>{
      const box=document.createElement('section');box.className='project-info';
      box.dataset.draftId=row.clientDraftId;box.dataset.source=row.state;
      const usable=this.context().editable && row.baseVersion===this.context().version;
      const preview=Object.values(row.payload.values ?? row.payload.record ?? row.payload.command ?? {}).filter(value=>typeof value==='string').join(' · ').slice(0,180);
      box.innerHTML=`<h3>${esc(names[row.formKind] ?? row.formKind)}${row.payload.target?' · '+esc(row.payload.target):''}</h3><p>${row.state==='local'?'当前设备副本':'服务器底稿'}${row.updatedAt?' · '+esc(new Date(row.updatedAt).toLocaleString('zh-CN')):''}${usable?'':' · 仅供复制核对'}</p>${preview?`<p>${esc(preview)}</p>`:''}<div class="entry-actions"><button class="back-btn" data-restore ${usable?'':'disabled'}>恢复为新副本</button><button class="back-btn" data-copy>复制</button><button class="back-btn" data-export>导出</button><button class="back-btn" data-discard>丢弃</button></div><pre hidden></pre>`;
      box.querySelector<HTMLButtonElement>('[data-restore]')!.onclick=()=>{void(async()=>{
        if(!this.context().editable || row.baseVersion!==this.context().version)return;
        const key=this.key(row.formKind,row.payload.target),slot=this.slots.get(key);
        if(slot){clearTimeout(slot.timer);if(slot.running)await slot.running;this.slots.delete(key);}
        this.dialog.close();
        if(!await this.restore(row) && slot){this.slots.set(key,slot);this.store(slot);slot.timer=setTimeout(()=>{void this.flush(key);},1000);}
      })();};
      const content=JSON.stringify(row.payload,null,2);
      box.querySelector<HTMLButtonElement>('[data-copy]')!.onclick=()=>{void(async()=>{try{await navigator.clipboard.writeText(content);}catch{const pre=box.querySelector('pre')!;pre.hidden=false;pre.textContent=content;}})();};
      box.querySelector<HTMLButtonElement>('[data-export]')!.onclick=()=>{const url=URL.createObjectURL(new Blob([content],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='GeekDash-个人草稿.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
      box.querySelector<HTMLButtonElement>('[data-discard]')!.onclick=()=>{void(async()=>{if(!confirm('仅丢弃所选草稿？当前表单输入和正式项目信息保持。'))return;try{await this.discardListed(row);await this.open();}catch(error){this.status=(error as Error).message;this.updateStatus();}})();};
      list.append(box);
    });
  }
}
