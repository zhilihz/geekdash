import { type ProjectTask, type TaskOperation } from './api';
import { applyTaskText, putTaskOp, taskCopy, taskList, taskText } from './tasks';
import { bulkTaskOperations } from './task-text';
import { attachStatusMentions } from './status-mentions';

type State={tasks:ProjectTask[];ops:TaskOperation[];bulk?:string;editable:boolean;showActions?:boolean};
const bindings=new WeakMap<HTMLElement,AbortController>();
const strip=(line:string)=>line.replace(/^\s*\d+[、.．)）]\s*/,'');
function fit(input:HTMLTextAreaElement){input.style.height='0px';input.style.height=Math.max(input.scrollHeight, input.hasAttribute('data-task-bulk')?160:64)+'px';}

// 卡片和详情共用输入、预览、逐条动作；原文未通过匹配时不改变正式任务操作。
export function bindTaskEditor(root:HTMLElement,read:()=>State,write:(ops:TaskOperation[],bulk?:string)=>void,people:()=>{name:string}[],saveOne?:(op:TaskOperation)=>void) {
  bindings.get(root)?.abort();const controller=new AbortController();bindings.set(root,controller);const options={signal:controller.signal};
  const input=root.querySelector<HTMLTextAreaElement>('[data-task-bulk]');
  const panel=input?.closest<HTMLElement>('.task-panel');let previewOps=read().ops,issue='';
  function preview(){
    const state=read();previewOps=state.ops;issue='';
    try{if(state.bulk!==undefined)previewOps=applyTaskText(state.tasks,state.ops,state.bulk);}catch(error){issue=(error as Error).message;}
    const list=panel?.querySelector('.task-list');if(list)list.innerHTML=taskList(taskCopy(state.tasks,previewOps),state.showActions??state.editable);
    const message=panel?.querySelector('.task-issue');if(message)message.textContent=issue;
    const discard=panel?.querySelector<HTMLElement>('[data-task-discard]');if(discard)discard.hidden=!issue;
  }
  function resetText(){if(input){input.value=taskText(taskCopy(read().tasks,read().ops));fit(input);}preview();}
  if(input){
    attachStatusMentions(input,people);fit(input);requestAnimationFrame(()=>{if(input.isConnected)fit(input);});
    input.addEventListener('input',event=>{
      if(!read().editable || (event as InputEvent).isComposing)return;
      fit(input);const state=read();let raw:string|undefined=input.value;
      try{if(!bulkTaskOperations(taskCopy(state.tasks,state.ops),raw).length)raw=undefined;}catch{/* 有歧义的实际输入仍保留，供修正或复制。 */}
      write(state.ops,raw);preview();
    },options);
    input.addEventListener('compositionend',()=>input.dispatchEvent(new Event('input',{bubbles:true})),options);
    input.addEventListener('keydown',event=>{
      if(event.key!=='Enter'||event.defaultPrevented||event.isComposing||event.ctrlKey||event.metaKey||!read().editable)return;
      event.preventDefault();const before=input.value.slice(0,input.selectionStart),lineStart=before.lastIndexOf('\n')+1;
      if(input.selectionStart===input.selectionEnd&&/^\s*\d+[、.．)）]\s*$/.test(before.slice(lineStart))&&(input.selectionStart===input.value.length||input.value[input.selectionStart]==='\n'))input.setRangeText('',lineStart,input.selectionEnd,'end');
      else input.setRangeText('\n'+(before.split('\n').filter(line=>strip(line).trim()).length+1)+'、',input.selectionStart,input.selectionEnd,'end');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    },options);
  }
  root.addEventListener('click',event=>{
    const target=event.target as HTMLElement,state=read();if(!state.editable)return;
    if(target.closest('[data-task-discard]')){write(state.ops,undefined);resetText();return;}
    const button=target.closest<HTMLButtonElement>('[data-task-action]');if(!button||button.disabled)return;
    if(issue){panel?.querySelector<HTMLElement>('.task-issue')?.scrollIntoView({block:'nearest'});input?.focus();return;}
    const row=button.closest<HTMLElement>('[data-task-row]')!,id=row.dataset.taskRow!,action=button.dataset.taskAction!;
    if(action==='edit'){
      const task=taskCopy(state.tasks,previewOps).find(task=>task.id===id);if(!task)return;
      const previousOps=structuredClone(previewOps.filter(op=>op.id===id));
      write(previewOps,undefined);if(input){input.value=taskText(taskCopy(read().tasks,read().ops));fit(input);}
      const text=document.createElement('textarea');text.value=task.text;text.setAttribute('aria-label','编辑这条任务');text.dataset.taskText='true';text.dataset.edit='true';
      row.querySelector('.task-text')?.replaceWith(text);button.hidden=true;attachStatusMentions(text,people);fit(text);text.focus();
      if(saveOne){
        const actions=row.querySelector('.task-actions')!;
        actions.querySelectorAll<HTMLButtonElement>('[data-task-action]').forEach(action=>{if(action!==button){action.disabled=true;action.title='请先保存或取消本条文字修改';}});
        const save=document.createElement('button'),cancel=document.createElement('button');save.type=cancel.type='button';save.textContent='保存';cancel.textContent='取消';
        save.onclick=()=>{if(read().editable)saveOne({op:'edit',id,text:text.value});};
        cancel.onclick=()=>{
          write([...read().ops.filter(op=>op.id!==id),...previousOps],undefined);previewOps=read().ops;
          if(input){input.value=taskText(taskCopy(read().tasks,read().ops));fit(input);}
          const restored=document.createElement('div');restored.innerHTML=taskList(taskCopy(read().tasks,read().ops).filter(task=>task.id===id),read().editable);
          restored.querySelector('.task-number')!.textContent=row.querySelector('.task-number')!.textContent;row.replaceWith(restored.firstElementChild!);
        };
        actions.prepend(save,cancel);
      }
      text.addEventListener('input',()=>{if(!read().editable)return;write(putTaskOp(read().ops,{op:'edit',id,text:text.value}),undefined);previewOps=read().ops;if(input){input.value=taskText(taskCopy(read().tasks,read().ops));fit(input);}fit(text);},options);
      return;
    }
    if(saveOne){write(previewOps,undefined);saveOne({op:action as 'complete'|'reopen'|'delete',id});return;}
    write(putTaskOp(previewOps,{op:action as 'complete'|'reopen'|'delete',id}),undefined);resetText();
    const complete=root.querySelector('.task-history-list');if(complete)complete.innerHTML=taskList(taskCopy(read().tasks,read().ops),read().editable,true);
  },options);
  preview();
}
