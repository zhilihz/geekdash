import { account, SaveError, send } from './api';

export type MembershipCommand = { action:'claim'|'apply'|'invite'|'accept'|'reject'|'withdraw'|'leave'; targetUserId?:string; requestId?:string; expectedVersion?:string; idempotencyKey?:string };
type Result = {outcome:string;result?:{projectId:string;status:string;changed:boolean;savedVersion:string;operationId:string}};
const active=new Set<string>();
const storageKey=(projectId:string)=>`geekdash_membership:${account!.id}:${projectId}`;
export function hasPendingMembership(projectId:string){try{return !!localStorage.getItem(storageKey(projectId));}catch{return false;}}

// 保留原命令直到结果明确；切页或失去响应后先查询，不生成第二次请求。
export async function saveMembership(projectId:string,command?:MembershipCommand):Promise<Result> {
  if(active.has(projectId))throw new Error('正在处理，请稍候。');
  active.add(projectId);
  const key=storageKey(projectId),path=`/api/projects/${encodeURIComponent(projectId)}`;
  try {
    const cached=localStorage.getItem(key);
    let body:MembershipCommand|undefined=cached?JSON.parse(cached):undefined;
    if(body){
      const previous=await send<Result>(path+'/membership-results/query','POST',body,false);
      const {idempotencyKey,...original}=body;
      const same=JSON.stringify(original)===JSON.stringify(command);
      if(previous.outcome==='committed'){localStorage.removeItem(key);if(!command||same)return previous;body=undefined;}
      else {
        if(!['not_committed','not_found'].includes(previous.outcome)||!command)return previous;
        if(!same)body=undefined;
      }
    }
    if(!command)return {outcome:'not_committed'};
    body??={...command,idempotencyKey:crypto.randomUUID()};
    localStorage.setItem(key,JSON.stringify(body));
    const result=await send<Result>(path+'/membership','POST',body);
    if(result.outcome==='committed')localStorage.removeItem(key);
    return result;
  }catch(error){
    if(error instanceof SaveError&&error.outcome==='not_committed'&&error.code!=='OPERATION_KEY_REUSED')localStorage.removeItem(key);
    throw error;
  }finally{active.delete(projectId);}
}
