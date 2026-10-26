import { account, SaveError, send } from './api';

export type MembershipCommand = { action:'claim'|'apply'|'invite'|'accept'|'reject'|'withdraw'|'leave'; targetUserId?:string; requestId?:string; expectedVersion?:string; idempotencyKey?:string };
type Result = {outcome:string;result?:{projectId:string;status:string;changed:boolean;savedVersion:string;operationId:string}};
const active=new Set<string>();
function forget(key:string){try{localStorage.removeItem(key);}catch{/* 原成功可再次按同一操作核对；清理失败不改写成功结果。 */}}
const storageKey=(projectId:string)=>`geekdash_membership:${account!.id}:${projectId}`;
export function hasPendingMembership(projectId:string){try{return !!localStorage.getItem(storageKey(projectId));}catch{return false;}}

// 保留原命令直到结果明确；切页或失去响应后先查询，不生成第二次请求。
export async function saveMembership(projectId:string,command?:MembershipCommand):Promise<Result> {
  if(active.has(projectId))throw new Error('正在处理，请稍候。');
  active.add(projectId);
  const key=storageKey(projectId),path=`/api/projects/${encodeURIComponent(projectId)}`;
  try {
    let body:MembershipCommand|undefined;
    try{const cached=localStorage.getItem(key);body=cached?JSON.parse(cached):undefined;}catch{throw new Error('本机操作记录暂时无法读取，本次未发送修改。请恢复浏览器存储后重试。');}
    if(body){
      const previous=await send<Result>(path+'/membership-results/query','POST',body,false);
      const {idempotencyKey,...original}=body;
      const same=JSON.stringify(original)===JSON.stringify(command);
      if(previous.outcome==='committed'){forget(key);if(!command||same)return previous;body=undefined;}
      else {
        if(!['not_committed','not_found'].includes(previous.outcome)||!command)return previous;
        if(!same)body=undefined;
      }
    }
    if(!command)return {outcome:'not_committed'};
    body??={...command,idempotencyKey:crypto.randomUUID()};
    try{localStorage.setItem(key,JSON.stringify(body));}catch{throw new Error('本机无法保留原操作，本次未发送修改。请恢复浏览器存储后重试。');}
    const result=await send<Result>(path+'/membership','POST',body);
    if(result.outcome==='committed')forget(key);
    return result;
  }catch(error){
    if(error instanceof SaveError&&error.outcome==='not_committed'&&error.code!=='OPERATION_KEY_REUSED')forget(key);
    throw error;
  }finally{active.delete(projectId);}
}
