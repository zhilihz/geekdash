import { esc,type ProjectTask,type TaskOperation } from './api';
import './tasks.css';
import { bulkTaskOperations } from './task-text';

type DisplayTask=ProjectTask & {pendingCreation?:boolean};
export function taskCopy(tasks:ProjectTask[],ops:TaskOperation[]) {
  const result:DisplayTask[]=structuredClone(tasks);
  for(const op of ops){
    if(op.op==='add'){result.push({id:op.id,text:op.text,createdAt:'',updatedAt:'',completedAt:'',deletedAt:'',pendingCreation:true});continue;}
    const task=result.find(t=>t.id===op.id);if(!task)continue;
    if(op.op==='edit')task.text=op.text;
    else if(op.op==='complete')task.completedAt='待保存';
    else if(op.op==='reopen')task.completedAt='';
    else task.deletedAt='待保存';
  }
  return result;
}
export function putTaskOp(ops:TaskOperation[],op:TaskOperation) {
  const next=structuredClone(ops),add=next.find(item=>item.id===op.id&&item.op==='add');
  if(add&&op.op==='delete')return next.filter(item=>item.id!==op.id);
  if(add?.op==='add'&&op.op==='edit'){add.text=op.text;return next;}
  if(op.op==='edit')return [...next.filter(item=>item.id!==op.id||item.op!=='edit'),op];
  return [...next,op];
}
export const taskText=(tasks:ProjectTask[])=>tasks.filter(t=>!t.deletedAt&&!t.completedAt).map((t,i)=>`${i+1}、${t.text}`).join('\n');
export function changedTaskOps(tasks:ProjectTask[],ops:TaskOperation[]) {
  const changed=new Set(taskCopy(tasks,ops).filter(task=>{
    const old=tasks.find(item=>item.id===task.id);
    return old?old.text!==task.text || !!old.completedAt!==!!task.completedAt || !!old.deletedAt!==!!task.deletedAt:!!task.text.trim()&&!task.deletedAt;
  }).map(task=>task.id));
  return ops.filter(op=>changed.has(op.id));
}
export function applyTaskText(tasks:ProjectTask[],ops:TaskOperation[],text:string) {
  return bulkTaskOperations(taskCopy(tasks,ops),text).reduce((result,op)=>putTaskOp(result,op),ops);
}
export async function confirmTaskDeletes(tasks:ProjectTask[],ops:TaskOperation[]) {
  const deleted=tasks.filter(task=>!task.deletedAt&&ops.some(op=>op.id===task.id&&op.op==='delete'));
  if(!deleted.length)return true;
  const dialog=document.createElement('dialog');dialog.className='task-delete-dialog';
  dialog.innerHTML=`<h2>删除 ${deleted.length} 条任务</h2><p>以下任务将从当前说明移除，原记录仍保留在更新历史中。</p><ul>${deleted.map(task=>`<li>${esc(task.text)}</li>`).join('')}</ul><form method="dialog"><button value="cancel" autofocus>继续编辑</button><button value="delete">确认删除并保存</button></form>`;
  document.body.append(dialog);
  return new Promise<boolean>(resolve=>{dialog.onclose=()=>{const accepted=dialog.returnValue==='delete';dialog.remove();resolve(accepted);};dialog.showModal();});
}
const taskClock=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function taskTime(value:string) {
  if(!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))return value;
  const timestamp=Date.parse(value);
  return Number.isFinite(timestamp)?taskClock.format(timestamp):value;
}
function taskDates(task:DisplayTask) {
  const dates:string[]=[];
  if(task.createdAt)dates.push('创建 '+taskTime(task.createdAt));
  if(task.updatedAt&&task.updatedAt!==task.createdAt)dates.push('正文更新 '+taskTime(task.updatedAt));
  if(!dates.length)dates.push(task.pendingCreation?'待保存':'正文时间未记录');
  if(task.completedAt)dates.push(task.completedAt==='待保存'?'完成待保存':'完成 '+taskTime(task.completedAt));
  return dates.join(' · ');
}
export function taskList(tasks:DisplayTask[],editable=false,completed=false) {
  const rows=tasks.filter(task=>!task.deletedAt&&!!task.completedAt===completed);
  if(completed)rows.sort((a,b)=>b.completedAt.localeCompare(a.completedAt));
  return rows.map((task,index)=>`<div class="task-row${completed?' task-complete':''}" data-task-row="${esc(task.id)}"><div class="task-body"><span class="task-number">${index+1}</span>、<span class="task-text">${esc(task.text)}</span> <small class="task-date">${esc(taskDates(task))}</small></div>${editable?`<div class="task-actions"><button type="button" data-task-action="edit">编辑</button><button type="button" data-task-action="${completed?'reopen':'complete'}">${completed?'改为未完成':'完成'}</button><button type="button" data-task-action="delete">删除</button></div>`:''}</div>`).join('')||`<p class="task-empty">暂无${completed?'已完成':'待办'}任务</p>`;
}
export function taskPanel(tasks:ProjectTask[],ops:TaskOperation[]=[],editable=false,bulk?:string,layout:'detail'|'card'='detail') {
  const current=taskCopy(tasks,ops);
  const list=`<div class="task-list">${taskList(current,editable)}</div>`;
  const editor=editable?`<label class="task-input-label">${layout==='card'?'任务清单':'每行一条任务'}<textarea data-task-bulk data-edit data-scope="status" rows="${layout==='card'?3:5}" aria-label="任务清单" placeholder="每行一条任务，可用 @ 选择人员">${esc(bulk??taskText(current))}</textarea></label><p class="task-issue" role="status"></p><button type="button" data-task-discard hidden>保留原任务，放弃这段输入</button>`:bulk!==undefined?`<textarea data-task-bulk rows="3" aria-label="保留的任务输入" readonly>${esc(bulk)}</textarea>`:'';
  return `<div class="task-panel${layout==='card'?' card-tasks':''}">${layout==='card'?list+editor:editor+list}</div>`;
}
