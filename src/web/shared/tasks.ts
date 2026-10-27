import { esc,type ProjectTask,type TaskOperation } from './api';
import './tasks.css';

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
  const next=[...ops],add=next.find(item=>item.id===op.id&&item.op==='add');
  if(add&&op.op==='delete')return next.filter(item=>item.id!==op.id);
  if(add?.op==='add'&&op.op==='edit'){add.text=op.text;return next;}
  if(op.op==='edit')return [...next.filter(item=>item.id!==op.id||item.op!=='edit'),op];
  return [...next,op];
}
export const taskText=(tasks:ProjectTask[])=>tasks.filter(t=>!t.deletedAt&&!t.completedAt).map((t,i)=>`${i+1}、${t.text}`).join('\n');
export function taskPanel(tasks:ProjectTask[],ops:TaskOperation[]=[],editable=false) {
  const current=taskCopy(tasks,ops).filter(t=>!t.deletedAt),complete=current.filter(t=>t.completedAt),pending=current.filter(t=>!t.completedAt);
  const displayDate=(value:string)=>{const date=new Date(value);return /^\d{4}-\d\d-\d\dT/.test(value)&&!Number.isNaN(date.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(date):value;};
  const row=(task:ProjectTask)=>`<div class="task-row${task.completedAt?' task-complete':''}" data-task-row="${esc(task.id)}"><div class="task-body">${editable&&!task.completedAt?`<textarea data-task-text data-edit data-scope="status" rows="2" aria-label="任务内容" placeholder="填写需要同步的进展、问题或下一步">${esc(task.text)}</textarea>`:`<div class="task-text">${esc(task.text)}</div>`}${task.updatedAt?`<small class="task-date">${esc(displayDate(task.updatedAt))}</small>`:''}</div>${editable?`<div class="task-actions"><button type="button" data-task-action="${task.completedAt?'reopen':'complete'}">${task.completedAt?'改为未完成':'完成'}</button><button type="button" data-task-action="delete" aria-label="删除这条任务">删除</button></div>`:''}</div>`;
  return `<div class="task-panel">${complete.length?`<details class="task-completed"><summary>已完成（${complete.length}）</summary>${complete.map(row).join('')}</details>`:''}<div class="task-list">${pending.length?pending.map(row).join(''):'<p class="task-empty">暂无待完成任务</p>'}</div>${editable?'<button class="back-btn" type="button" data-task-action="add">＋ 添加一条</button>':''}</div>`;
}
