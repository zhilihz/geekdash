import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const context=vm.createContext({AbortController,Event,structuredClone,crypto:{randomUUID},Intl,requestAnimationFrame:fn=>fn()});
async function load(path,dependencies={}) {
  const code=ts.transpileModule(await readFile(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
  const module={exports:{}};
  vm.runInContext('(function(require,exports,module){'+code+'\n})',context)(name=>dependencies[name]??{},module.exports,module);
  return module.exports;
}
const text=await load('src/web/shared/task-text.ts');
const tasks=await load('src/web/shared/tasks.ts',{'./task-text':text,'./api':{esc:value=>String(value)}});
const editor=await load('src/web/shared/task-editor.ts',{'./tasks':tasks,'./task-text':text,'./status-mentions':{attachStatusMentions(){}}});
const list={innerHTML:''},message={textContent:''},discard={hidden:true};
const panel={querySelector:selector=>({'.task-list':list,'.task-issue':message,'[data-task-discard]':discard})[selector]};
class Input extends EventTarget {
  value='';selectionStart=0;selectionEnd=0;style={};scrollHeight=160;isConnected=true;
  closest(){return panel;}
  hasAttribute(){return true;}
  setRangeText(value,start,end){this.value=this.value.slice(0,start)+value+this.value.slice(end);this.selectionStart=this.selectionEnd=start+value.length;}
}
const input=new Input(),root=new EventTarget();root.querySelector=()=>input;
const original={id:'saved',text:'PS5手柄',completedAt:'',deletedAt:'',createdAt:'',updatedAt:''};
const savedTimes={...original,createdAt:'2026-11-03T02:20:00Z',updatedAt:'2026-11-03T04:12:04Z'};
const dueRow=tasks.taskList([savedTimes],true);
assert.match(dueRow,/>1<\/span>、<span class="task-text">PS5手柄<\/span>\s*<small class="task-date">/);
assert.match(dueRow,/创建 [^<]+10:20:00 · 正文更新 [^<]+12:12:04/);
assert(tasks.taskPanel([savedTimes],[],true).includes(dueRow),'详情用同一任务行');
assert.match(tasks.taskList([{...savedTimes,completedAt:'2026-11-03T05:33:40Z'}],true,true),/正文更新 [^<]+12:12:04 · 完成 [^<]+13:33:40/);
assert.match(tasks.taskList([original]),/正文时间未记录/);
assert.match(tasks.taskPanel([],[{op:'add',id:'local',text:'未保存任务'}],true),/class="task-date">待保存</);
const state={tasks:[original],ops:[],editable:true};let writes=0;
editor.bindTaskEditor(root,()=>state,(ops,bulk)=>{state.ops=ops;state.bulk=bulk;writes++;},()=>[]);
function edit(value,caret=value.length,composing=false) {
  input.value=value;input.selectionStart=input.selectionEnd=caret;
  const event=new Event('input');Object.defineProperty(event,'isComposing',{value:composing});input.dispatchEvent(event);
  assert.equal(input.value,value,'输入处理不得补回被删除的编号或重写正文');
  assert.equal(input.selectionStart,caret,'输入处理不得移动光标');
}
function enter() {const event=new Event('keydown',{cancelable:true});Object.defineProperty(event,'key',{value:'Enter'});input.dispatchEvent(event);return event;}

edit('1、PS5手柄\n2'); // 删除编号末尾标点后，不能被改写为新的正文编号。
edit('1、PS5手柄\n');assert.equal(state.bulk,undefined,'空行不产生任务改动');
edit('PS5手柄',0);assert.equal(state.bulk,undefined,'删除编号本身不产生业务修改');
edit('');assert.equal(state.bulk,'');assert.equal(text.bulkTaskOperations(state.tasks,state.bulk)[0].op,'delete');
edit('样机发货\n等待芯片');assert.deepEqual(Array.from(text.taskRows([],state.bulk),row=>row.text),['样机发货','等待芯片']);
const beforeComposition=writes;edit('样机中文输入',6,true);assert.equal(writes,beforeComposition,'中文组合期间不提交中间输入');
input.dispatchEvent(new Event('compositionend'));assert.equal(state.bulk,'样机中文输入');assert.equal(input.selectionStart,6);
edit('1、PS5手柄');assert(enter().defaultPrevented);assert.equal(input.value,'1、PS5手柄\n2、','回车保留连续编号');
assert(enter().defaultPrevented);assert.equal(input.value,'1、PS5手柄\n','空编号行再次回车直接去掉编号');
edit('1、PS5手柄\n2、');edit('1、PS5手柄');assert.equal(state.bulk,undefined,'选中删除空编号行后不补回');
const beforeReadonly=writes;state.editable=false;edit('只读期间的外部事件');assert.equal(writes,beforeReadonly);
assert.equal(original.text,'PS5手柄','输入预览不修改正式任务');
console.log(JSON.stringify({status:'passed',scope:'共享任务输入事件和显示回归',checks:['delete_number','delete_blank_number_row','clear_all','multiline_order','composition','caret','enter_number','leave_empty_number','readonly','shared_task_date_labels']}));
