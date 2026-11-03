import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';

const {JSDOM,VirtualConsole}=createRequire(import.meta.url)(process.env.GEEKDASH_JSDOM_PATH);
const css=await Promise.all(['board','detail','tasks','read','design'].map(name=>readFile(`src/web/shared/${name}.css`,'utf8')));
const dom=new JSDOM('<!doctype html><html><head></head><body><main class="page"></main></body></html>',{virtualConsole:new VirtualConsole()});
const {document,getComputedStyle}=dom.window;
for(const source of css){const style=document.createElement('style');style.textContent=source;document.head.append(style);}
const page=document.querySelector('.page');

// 共享布局不能把行为代码隐藏的控件显示出来；恢复可见后仍能正常布局。
for(const className of ['save-btn','back-btn','head-btn','board-primary','task-actions','edit-actions']){
  const item=document.createElement('button');item.className=className;item.hidden=true;page.append(item);
  assert.equal(getComputedStyle(item).display,'none',className+' 必须遵守hidden');
  item.hidden=false;assert.notEqual(getComputedStyle(item).display,'none',className+' 解除隐藏后可见');item.remove();
}
for(const id of ['risk-edit','change-edit']){
  const form=document.createElement('form');form.id=id;form.innerHTML='<button type="submit" class="save-btn">保存</button><button class="save-btn" hidden>确认并保存</button>';page.append(form);
  assert.notEqual(getComputedStyle(form.children[0]).display,'none',id+' 真正提交按钮可见');
  assert.equal(getComputedStyle(form.children[1]).display,'none',id+' 未启用的确认按钮隐藏');form.remove();
}
for(const selector of ['.space-delete-dialog','.task-delete-dialog','.draft-dialog','.action-dialog','#editor-dialog','#draft-dialog']){
  const dialog=document.createElement('dialog');
  if(selector[0]==='#')dialog.id=selector.slice(1);else dialog.className=selector.slice(1);
  document.body.append(dialog);assert.equal(getComputedStyle(dialog).display,'none',selector+' 关闭时不可见');
  dialog.open=true;const style=getComputedStyle(dialog);
  assert.equal(style.position,'fixed',selector+' 以视口定位');assert.equal(style.inset,'0',selector+' 四侧同一定位');assert.equal(style.margin,'auto',selector+' 共用居中规则');
  dialog.remove();
}
page.innerHTML='<div class="task-row"><span class="task-number">10</span><div class="task-body"><div class="task-text">第一行\n第二行</div></div><div class="task-actions"><button>编辑</button></div></div>';
assert.equal(getComputedStyle(page.firstChild).alignItems,'flex-start');
assert.equal(getComputedStyle(page.querySelector('.task-number')).lineHeight,getComputedStyle(page.querySelector('.task-text')).lineHeight);
assert.equal(getComputedStyle(page.querySelector('.task-number')).flexBasis,'2ch');
dom.window.close();
console.log(JSON.stringify({status:'passed',scope:'实际共享CSS的隐藏状态、原位按钮、六类dialog定位及任务行程序检查；不代表浏览器几何或用户视觉验收'}));
