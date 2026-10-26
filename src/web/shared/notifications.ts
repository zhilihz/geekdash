import { account, get, send, SaveError, esc } from './api';

export type ProjectNotification={projectId:string;version:string;operationId:string};
export type ResourceNotification={resource:'catalog';kind:string;operationId:string}|{resource:'check-rule';version:string;operationId:string};
export type EditingPresence={projectId:string;users:{id:string;name:string}[]};
export function editorBadges(users:EditingPresence['users']){
  return users.length ? `<span class="editing-badge"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m14 5 5 5M4 20l4-1 12-12a2 2 0 0 0-5-5L3 14l-1 6Z"/><path d="M12 20h10"/></svg><span>正在编辑 <b>${users.map(user=>esc(user.name)).join('、')}</b></span></span>` : '';
}
const ownOperations=new Set<string>();
document.addEventListener('geekdash-operation',event=>{ownOperations.add((event as CustomEvent<string>).detail);if(ownOperations.size>128)ownOperations.delete(ownOperations.values().next().value!);});

export class ProjectNotifications {
  private source:EventSource|undefined;
  private stopped=false;
  private suspended=false;
  private generation=0;
  private accountId=account!.id;
  private retry:ReturnType<typeof setTimeout>|undefined;
  private delay=1000;
  private editing=false;
  private editingProjectId:string|undefined;
  private connected=false;
  private pulse:ReturnType<typeof setInterval>;
  private changing=false;
  private dirty=false;
  private onIdentity=()=>this.close();
  private onPageHide=()=>{this.suspended=true;this.disconnect();};
  private onPageShow=(event:PageTransitionEvent)=>{if(event.persisted && !this.stopped && this.suspended){this.suspended=false;void this.restore();}};
  constructor(private receive:(event:ProjectNotification,own:boolean)=>void,private reconnect:()=>void,private state:(text:string)=>void,private projectId?:string,private instanceId:string=crypto.randomUUID(),private resource?:(event:ResourceNotification)=>void,private editors?:(event:EditingPresence)=>void){
    this.editingProjectId=projectId;
    this.connect();
    this.pulse=setInterval(()=>{if(this.editing && this.connected)void this.presence();},25000);
    document.addEventListener('geekdash-identity-changed',this.onIdentity);
    window.addEventListener('pagehide',this.onPageHide);
    window.addEventListener('pageshow',this.onPageShow);
  }
  private connect(){
    if(this.stopped || this.suspended || this.source)return;
    if(typeof EventSource==='undefined'){this.state('协作连接不可用，请重新进入核对项目更新。');return;}
    const query=new URLSearchParams({accountId:this.accountId,instanceId:this.instanceId});if(this.projectId)query.set('projectId',this.projectId);
    const source=this.source=new EventSource('/api/events?'+query);
    const current=()=>!this.stopped && !this.suspended && source===this.source;
    source.addEventListener('connected',()=>{if(!current())return;this.connected=true;this.delay=1000;this.state('');this.reconnect();if(this.editing)void this.presence();});
    source.addEventListener('project',event=>{if(!current())return;try{const value=JSON.parse((event as MessageEvent).data);if(typeof value.projectId==='string' && /^[1-9][0-9]*$/.test(value.version) && typeof value.operationId==='string')this.receive(value,ownOperations.has(value.operationId));}catch{this.reconnect();}});
    source.addEventListener('resource',event=>{if(!current())return;try{const value=JSON.parse((event as MessageEvent).data);if(typeof value.operationId==='string' && (value.resource==='catalog' && typeof value.kind==='string' || value.resource==='check-rule' && /^[1-9][0-9]*$/.test(value.version)))this.resource?.(value);}catch{this.reconnect();}});
    source.addEventListener('editors',event=>{if(!current())return;try{const value=JSON.parse((event as MessageEvent).data);if(typeof value.projectId!=='string' || !/^[1-9][0-9]*$/.test(value.projectId) || !Array.isArray(value.users) || value.users.some((item:{id?:unknown;name?:unknown})=>!item || typeof item.id!=='string' || typeof item.name!=='string'))return;if(this.projectId && value.projectId!==this.projectId)return;if(this.editors)this.editors(value);else if(value.projectId===this.projectId)this.state(value.users.length?'正在编辑：'+value.users.map((item:{name:string})=>item.name).join('、'):'');}catch{this.state('编辑名单待重新核对');}});
    source.addEventListener('identity',()=>{if(!current())return;this.close();document.dispatchEvent(new Event('geekdash-identity-changed'));});
    source.addEventListener('membership',()=>{if(current())document.dispatchEvent(new Event('geekdash-membership'));});
    source.addEventListener('unavailable',()=>{if(current())void this.disconnected();});
    source.onerror=()=>{if(current())void this.disconnected();};
  }
  private disconnect(){
    this.generation++;clearTimeout(this.retry);this.retry=undefined;
    this.source?.close();this.source=undefined;this.connected=false;
  }
  private disconnected(){
    if(this.stopped || this.suspended || this.retry)return;
    this.disconnect();this.state('协作连接中断，编辑名单待确认');
    this.retry=setTimeout(()=>{this.retry=undefined;void this.restore();},this.delay);this.delay=Math.min(this.delay*2,30000);
  }
  private async restore(){
    const generation=this.generation;
    try{
      const value=await get<{account:{id:string;mustChangePassword:boolean}}>('/api/auth/me',undefined,false);
      if(this.stopped || this.suspended || generation!==this.generation)return;
      if(value.account.id!==this.accountId || value.account.mustChangePassword)throw new SaveError('AUTH_CONTEXT_CHANGED','not_committed');
      this.connect();
    }catch(error){
      if(this.stopped || this.suspended || generation!==this.generation)return;
      if(error instanceof SaveError && ['AUTH_REQUIRED','AUTH_CONTEXT_CHANGED','PASSWORD_CHANGE_REQUIRED','CSRF_INVALID'].includes(error.code)){this.close();document.dispatchEvent(new Event('geekdash-identity-changed'));}
      else this.disconnected();
    }
  }
  setEditing(editing:boolean,projectId=this.editingProjectId){if(this.stopped || !projectId || this.editing===editing && this.editingProjectId===projectId)return;this.editing=editing;this.editingProjectId=projectId;this.dirty=true;void this.presence();}
  private async presence(){
    if(this.stopped || this.suspended || !this.connected || !this.editingProjectId)return;if(this.changing){this.dirty=true;return;}
    const generation=this.generation;
    this.changing=true;this.dirty=false;
    try{await send('/api/editing','POST',{projectId:this.editingProjectId,instanceId:this.instanceId,editing:this.editing},false);}
    catch(error){if(generation===this.generation && !this.stopped && !this.suspended){this.state('编辑名单尚未同步');if(error instanceof SaveError && error.code==='PROJECT_READ_ONLY')this.editing=false;}}
    finally{this.changing=false;if(this.dirty)void this.presence();}
  }
  close(){
    this.stopped=true;this.disconnect();clearInterval(this.pulse);
    document.removeEventListener('geekdash-identity-changed',this.onIdentity);
    window.removeEventListener('pagehide',this.onPageHide);window.removeEventListener('pageshow',this.onPageShow);
  }
}
