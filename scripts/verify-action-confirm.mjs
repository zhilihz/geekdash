import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const {JSDOM}=await import(process.env.GEEKDASH_DOM_LIBRARY??'../test-results/ui-dom-tools/node_modules/jsdom/lib/api.js');
const next=()=>new Promise(done=>setTimeout(done,0));
async function until(check){for(let i=0;i<40;i++){if(check())return;await next();}assert(check(),'未出现预期页面状态');}

function page(file,api,stubs={}){
  const dom=new JSDOM(readFileSync('src/web/'+file+'.html','utf8'),{url:'http://localhost/'+file+'.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window,doc=w.document,modules=new Map();
  w.structuredClone=structuredClone;w.scrollTo=()=>{};w.confirm=()=>assert.fail('不应调用原生确认框');
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;this.returnValue='';};
  w.HTMLDialogElement.prototype.close=function(value=''){this.open=false;this.returnValue=value;this.dispatchEvent(new w.Event('close'));};
  const mocks={api:{account:{id:'1'},requireIdentity:async()=>true,setupTheme(){},esc:value=>String(value??''),...api},notifications:{ProjectNotifications:class{}},...stubs};
  function load(path){
    if(path.endsWith('.css'))return {};
    const name=path.split(/[\\/]/).at(-1);if(mocks[name])return mocks[name];
    if(!path.endsWith('.ts'))path+='.ts';path=resolve(path);
    if(modules.has(path))return modules.get(path).exports;
    const mod={exports:{}};modules.set(path,mod);
    const js=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
    vm.runInContext('(function(require,exports,module){'+js+'\n})',dom.getInternalVMContext(),{filename:path})(n=>load(resolve(dirname(path),n)),mod.exports,mod);return mod.exports;
  }
  load('src/web/'+file+'.ts');
  const el=s=>doc.querySelector(s),click=s=>{const node=el(s);assert(node,s);assert(!node.disabled,s);node.focus();node.click();return node;};
  const type=(s,value)=>{el(s).value=value;el(s).dispatchEvent(new w.Event('input',{bubbles:true}));};
  async function answer(choice){
    const selector='dialog[data-action-confirm][open]';
    await until(()=>el(selector));assert.equal(doc.activeElement,el(selector+' button[value=keep]'));
    if(choice==='escape')el(selector).dispatchEvent(new w.Event('cancel',{cancelable:true}));
    else click(selector+' button[value='+choice+']');
    await until(()=>!el(selector));await next();
  }
  return {dom,doc,el,click,type,answer};
}

const catalog=page('data-manage',{get:async()=>({items:[],canMaintain:true}),send:()=>assert.fail('切换分类不应保存资料')});
try{
  await until(()=>catalog.el('[data-kind=chips]')&&!catalog.el('#catalog-new').disabled);
  catalog.click('#catalog-new');await until(()=>catalog.el('[data-field=name]'));catalog.type('[data-field=name]','尚未保存的客户');
  const trigger=catalog.click('[data-kind=chips]');await catalog.answer('keep');
  assert.equal(catalog.doc.activeElement,trigger);assert.equal(catalog.el('[data-field=name]').value,'尚未保存的客户');
  catalog.click('[data-kind=chips]');await catalog.answer('escape');
  assert.equal(catalog.el('[data-field=name]').value,'尚未保存的客户');
  catalog.click('[data-kind=chips]');await catalog.answer('confirm');
  await until(()=>catalog.el('[data-kind=chips]').getAttribute('aria-current')==='true');
  assert(!catalog.el('[data-field=name]'));
}finally{catalog.dom.window.close();}

const seed=id=>({clientDraftId:id,state:'active',formKind:'summaryNote',baseVersion:'1',draftVersion:'1',projectId:'7',payload:{schemaVersion:1,values:{summaryNote:'草稿 '+id}}});
let drafts=[seed('a'),seed('b')];const discarded=[];
const project={id:'7',version:'1',name:'合成项目',canEdit:true,summaryNote:'正式备注'};
const summary=page('project-status-summary',{
  async get(path){
    if(path==='/api/project-summary')return {items:[project],capturedAt:new Date().toISOString()};
    if(path.startsWith('/api/personal/drafts?'))return {items:drafts};
    if(path.startsWith('/api/personal/preferences?'))return {value:{},version:'0'};
    assert.fail(path);
  },
  async send(path,method,body){assert.equal(path,'/api/personal/drafts/discard');assert.equal(method,'POST');discarded.push(body.clientDraftId);drafts=drafts.filter(d=>d.clientDraftId!==body.clientDraftId);return {};}
},{summary:{summaryColumns:{note:'备注'},summaryFilterTitles:{},summaryFilterOptions:()=>({}),summaryRows:rows=>rows,visibleColumns:()=>['note']}});
try{
  const note='[data-note=summaryNote] textarea',cloud=id=>'[data-draft-id="'+id+'"]';
  await until(()=>summary.el('[data-edit=summaryNote]'));summary.click('[data-edit=summaryNote]');summary.type(note,'我正在编辑');
  const openDrafts=async()=>{summary.click('[data-note-action=drafts]');await until(()=>summary.el('.draft-dialog[open] '+cloud('a')));};
  await openDrafts();
  const restore=summary.click(cloud('a')+' [data-restore]');await summary.answer('keep');
  assert.equal(summary.doc.activeElement,restore);assert.equal(summary.el(note).value,'我正在编辑');assert(summary.el('.draft-dialog[open]'));
  summary.click(cloud('a')+' [data-restore]');await summary.answer('confirm');await until(()=>summary.el(note).value==='草稿 a');assert(!summary.el('.draft-dialog[open]'));
  await openDrafts();const discard=summary.click(cloud('b')+' [data-discard]');await summary.answer('escape');
  assert.equal(summary.doc.activeElement,discard);assert.deepEqual(discarded,[]);
  summary.click(cloud('b')+' [data-discard]');await summary.answer('confirm');await until(()=>!summary.el(cloud('b')));
  assert.deepEqual(discarded,['b']);assert(summary.el(cloud('a')));assert.equal(summary.el(note).value,'草稿 a');assert.equal(project.summaryNote,'正式备注');
  assert.equal(summary.doc.activeElement,summary.el('.draft-dialog [data-close]'));
}finally{summary.dom.window.close();}
console.log(JSON.stringify({status:'passed',checks:['资料分类取消/Esc/放弃','草稿替换保留/确认','单份丢弃取消/确认','焦点/原输入/另一草稿保留'],database:false}));
