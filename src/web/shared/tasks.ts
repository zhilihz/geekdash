import { esc,type ProjectTask,type TaskOperation } from './api';
import './tasks.css';
import { bulkTaskOperations, taskRows } from './task-text';

export function taskCopy(tasks:ProjectTask[],ops:TaskOperation[]) {
  const result=structuredClone(tasks);
  for(const op of ops){
    if(op.op==='add'){result.push({id:op.id,text:op.text,createdAt:'',updatedAt:'',completedAt:'',deletedAt:''});continue;}
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
export function taskPanel(tasks:ProjectTask[],ops:TaskOperation[]=[],editable=false,bulk?:string) {
  const current=taskCopy(tasks,ops).filter(t=>!t.deletedAt),complete=current.filter(t=>t.completedAt),pending=current.filter(t=>!t.completedAt);
  const displayDate=(value:string)=>{const date=new Date(value);return /^\d{4}-\d\d-\d\dT/.test(value)&&!Number.isNaN(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(date):value;};
  const row=(task:ProjectTask,index:number)=>`<div class="task-row${task.completedAt?' task-complete':''}" data-task-row="${esc(task.id)}"><span class="task-number">${index+1}</span><div class="task-body">${editable&&bulk===undefined&&!task.completedAt?`<textarea data-task-text data-edit data-scope="status" rows="2" aria-label="任务内容" placeholder="填写需要同步的进展、问题或下一步">${esc(task.text)}</textarea>`:`<div class="task-text">${esc(task.text)}</div>`}${task.updatedAt?`<small class="task-date">${esc(displayDate(task.updatedAt))}</small>`:''}</div>${editable&&bulk===undefined?`<div class="task-actions"><button type="button" data-task-action="${task.completedAt?'reopen':'complete'}">${task.completedAt?'改为未完成':'完成'}</button><button type="button" data-task-action="delete" aria-label="删除这条任务">删除</button></div>`:''}</div>`;
  let issue='';if(bulk!==undefined)try{taskRows(current,bulk);}catch(error){issue=(error as Error).message;}
  return `<div class="task-panel">${complete.length?`<details class="task-completed"><summary>已完成（${complete.length}）</summary>${complete.map(row).join('')}</details>`:''}${editable?`<div class="task-toolbar"><button type="button" data-task-mode="${bulk===undefined?'bulk':'rows'}">${bulk===undefined?'整栏编辑':'逐条编辑'}</button>${bulk!==undefined?'<span>每行一条任务；仍用页面保存按钮保存。</span>':''}</div>`:''}${bulk!==undefined?`<textarea data-task-bulk data-edit rows="7" aria-label="整栏任务内容" ${editable?'':'readonly'}>${esc(bulk)}</textarea><p class="task-issue" role="status">${esc(issue)}</p>${issue?'<button type="button" data-task-mode="copy">复制整栏输入</button><button type="button" data-task-mode="discard">保留原任务，返回逐条编辑</button>':''}`:`<div class="task-list">${pending.length?pending.map(row).join(''):'<p class="task-empty">暂无待完成任务</p>'}</div>${editable?'<button class="back-btn" type="button" data-task-action="add">＋ 添加一条</button>':''}`}</div>`;
}
