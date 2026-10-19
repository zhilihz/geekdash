import { account, get, send, SaveError } from './api';

export type ProjectNotification={projectId:string;version:string;operationId:string};
const ownOperations=new Set<string>();
document.addEventListener('geekdash-operation',event=>{ownOperations.add((event as CustomEvent<string>).detail);if(ownOperations.size>128)ownOperations.delete(ownOperations.values().next().value!);});

export class ProjectNotifications {
  private source:EventSource|undefined;
  private stopped=false;
  private retry:ReturnType<typeof setTimeout>|undefined;
  private delay=1000;
  private editing=false;
  private connected=false;
  private pulse:ReturnType<typeof setInterval>;
  private changing=false;
  private dirty=false;
  constructor(private receive:(event:ProjectNotification,own:boolean)=>void,private reconnect:()=>void,private state:(text:string)=>void,private projectId?:string,private instanceId:string=crypto.randomUUID()){
    this.connect();
    this.pulse=setInterval(()=>{if(this.editing && this.connected)void this.presence();},25000);
    document.addEventListener('geekdash-identity-changed',()=>this.close());
    window.addEventListener('pagehide',()=>this.close());
  }
  private connect(){
    if(this.stopped)return;
    if(typeof EventSource==='undefined'){this.state('协作连接不可用，请重新进入核对项目更新。');return;}
    const query=new URLSearchParams({accountId:account!.id,instanceId:this.instanceId});if(this.projectId)query.set('projectId',this.projectId);
    const source=this.source=new EventSource('/api/events?'+query);
    const current=()=>!this.stopped && source===this.source;
    source.addEventListener('connected',()=>{if(!current())return;this.connected=true;this.delay=1000;this.state('');this.reconnect();if(this.editing)void this.presence();});
    source.addEventListener('project',event=>{if(!current())return;try{const value=JSON.parse((event as MessageEvent).data);if(typeof value.projectId==='string' && /^[1-9][0-9]*$/.test(value.version) && typeof value.operationId==='string')this.receive(value,ownOperations.has(value.operationId));}catch{this.reconnect();}});
    source.addEventListener('editors',event=>{if(!current())return;try{const value=JSON.parse((event as MessageEvent).data);if(value.projectId===this.projectId && Array.isArray(value.users))this.state(value.users.length?'正在编辑：'+value.users.map((item:{name:string})=>item.name).join('、'):'');}catch{this.state('编辑名单待重新核对');}});
    source.addEventListener('identity',()=>{if(!current())return;this.close();document.dispatchEvent(new Event('geekdash-identity-changed'));});
    source.addEventListener('unavailable',()=>{if(current())void this.disconnected();});
    source.onerror=()=>{if(current())void this.disconnected();};
  }
  private async disconnected(){
    this.source?.close();this.source=undefined;this.connected=false;this.state('协作连接中断，编辑名单待确认');
    if(this.stopped || this.retry)return;
    this.retry=setTimeout(()=>{this.retry=undefined;void(async()=>{
      try{const value=await get<{account:{id:string;mustChangePassword:boolean}}>('/api/auth/me',undefined,false);if(value.account.id!==account?.id || value.account.mustChangePassword)throw new SaveError('AUTH_CONTEXT_CHANGED','not_committed');this.connect();}
      catch(error){if(error instanceof SaveError){this.close();document.dispatchEvent(new Event('geekdash-identity-changed'));}else if(!this.stopped)void this.disconnected();}
    })();},this.delay);this.delay=Math.min(this.delay*2,30000);
  }
  setEditing(editing:boolean){if(this.stopped || !this.projectId || this.editing===editing)return;this.editing=editing;this.dirty=true;void this.presence();}
  private async presence(){
    if(this.stopped || !this.projectId)return;if(this.changing){this.dirty=true;return;}
    this.changing=true;this.dirty=false;
    try{await send('/api/editing','POST',{projectId:this.projectId,instanceId:this.instanceId,editing:this.editing},false);}
    catch(error){this.state('编辑名单尚未同步');if(error instanceof SaveError && error.code==='PROJECT_READ_ONLY')this.editing=false;}
    finally{this.changing=false;if(this.dirty && !this.stopped)void this.presence();}
  }
  close(){this.stopped=true;clearTimeout(this.retry);clearInterval(this.pulse);this.source?.close();this.source=undefined;this.connected=false;}
}
