import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const {JSDOM}=await import(process.env.GEEKDASH_DOM_LIBRARY??'../test-results/ui-dom-tools/node_modules/jsdom/lib/api.js');
const dom=new JSDOM(readFileSync('src/web/index.html','utf8'),{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window, doc=w.document;
function load(path,dependencies={}) {
  const source=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
  const module={exports:{}};
  vm.runInContext('(function(require,exports,module){'+source+'\n})',dom.getInternalVMContext(),{filename:path})(name=>dependencies[name]??{},module.exports,module);
  return module.exports;
}
try {
  let saves=0,visits=0,cardClicks=0;
  load('src/web/board.ts',{'./shared/api':{setupTheme(){},setupDateZone(){},requireIdentity:()=>new Promise(()=>{}),send(){saves++;}}});
  const {attachStatusMentions}=load('src/web/shared/status-mentions.ts');
  const people=()=>[{name:'张工'},{name:'李工'}];
  const grid=doc.getElementById('card-grid');
  grid.innerHTML='<article data-project-id="1"><a data-project-link href="/project-detail.html?id=1">详情</a><p>卡片空白</p><textarea></textarea></article>';
  const card=grid.firstElementChild, field=card.querySelector('textarea');
  card.querySelector('a').onclick=event=>{event.preventDefault();visits++;};
  card.addEventListener('click',()=>{cardClicks++;});
  function mouse(target,type) {
    const event=new w.MouseEvent(type,{button:0,bubbles:true,cancelable:true});
    target.dispatchEvent(event);
    return event;
  }
  function enter(input,value,caret=value.length) {
    input.focus();input.value=value;input.setSelectionRange(caret,caret);
    input.dispatchEvent(new w.Event('input',{bubbles:true}));
  }
  function press(input,key) {
    const event=new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
    input.dispatchEvent(event);return event;
  }
  attachStatusMentions(field,people);
  enter(field,'请 @ 跟进',3);
  const menu=card.querySelector('[role=listbox]'), option=menu.querySelector('[data-mention-name="张工"]');
  assert.equal(menu.hidden,false);
  assert(mouse(option,'mousedown').defaultPrevented,'按下候选时保留输入焦点');
  assert(!menu.hidden && option.isConnected,'鼠标抬起前候选仍须存在，避免点击落入下层卡片');
  assert.equal(field.value,'请 @ 跟进');
  mouse(option,'mouseup');mouse(option,'click');
  assert.deepEqual([field.value,field.selectionStart,field.selectionEnd,doc.activeElement,menu.hidden],['请 @张工  跟进',6,6,field,true]);
  field.setRangeText('确认',field.selectionStart,field.selectionEnd,'end');field.dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal(field.value,'请 @张工 确认 跟进');
  assert.deepEqual([cardClicks,visits,saves],[0,0,0]);
  mouse(card.querySelector('.status-mention-wrap'),'click');assert.equal(visits,0,'编辑区间隙不进入详情');
  mouse(card.querySelector('p'),'click');assert.equal(visits,1,'卡片普通区域继续打开详情');

  const detail=doc.createElement('form');detail.innerHTML='<textarea></textarea>';doc.body.append(detail);
  detail.onsubmit=event=>{event.preventDefault();saves++;};
  const text=detail.querySelector('textarea');attachStatusMentions(text,people);
  enter(text,'@');assert(press(text,'ArrowDown').defaultPrevented);assert(press(text,'Enter').defaultPrevented);
  assert.deepEqual([text.value,text.selectionStart,doc.activeElement],['@李工 ',4,text]);
  enter(text,'@');press(text,'Escape');assert(detail.querySelector('[role=listbox]').hidden);assert.equal(text.value,'@');
  enter(text,'@张');detail.querySelector('[data-mention-name="张工"]').click();
  assert.equal(text.value,'@张工 ');assert.equal(saves,0);
  await new Promise(resolve=>w.setTimeout(resolve,0));
  console.log(JSON.stringify({status:'passed',checks:['候选点击保留焦点和光标，可继续输入','候选点击不冒泡、不导航或保存','卡片空白继续进入详情','详情共用选人、键盘选择与关闭']}));
} finally {dom.window.close();}
