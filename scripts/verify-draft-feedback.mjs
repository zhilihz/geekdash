import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const context=vm.createContext({document:{addEventListener(){}},BroadcastChannel:class{},Intl,structuredClone,crypto:{randomUUID}});
async function load(path,dependencies={}){
  const code=ts.transpileModule(await readFile(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.CommonJS}}).outputText;
  const output={exports:{}};
  vm.runInContext('(function(require,exports,module){'+code+'\n})',context)(name=>dependencies[name]??{},output.exports,output);
  return output.exports;
}
const api=await load('src/web/shared/api.ts');
const history=await load('src/web/shared/history.ts',{'./api':api});
const personal=await load('src/web/shared/personal-state.ts',{'./api':api,'./history':history});
const taskTextModule=await load('src/web/shared/task-text.ts');
const tasks=await load('src/web/shared/tasks.ts',{'./api':api,'./task-text':taskTextModule});
const scopes=await load('src/web/shared/scoped-editor.ts');
const detail=await readFile('src/web/detail.ts','utf8');
const source=ts.createSourceFile('detail.ts',detail,ts.ScriptTarget.ES2023,true);
const names=['taskInputChanged','currentDraftData','describeDraft','currentDraftText','bufferPreview','unsavedText','canRestoreDraft'];
const functions=source.statements.filter(item=>ts.isFunctionDeclaration(item)&&names.includes(item.name?.text)).map(item=>item.getText(source)).join('\n');
Object.assign(context,personal,tasks,scopes,{
  baseline:()=>structuredClone(context.base),basicIntent:()=>context.basicBase,
  basicIntentChanged:(_snapshot,value)=>JSON.stringify(value)!==JSON.stringify(context.basicBase),
  snapshot:{project:{version:'5',tasks:[],people:[],chips:[],tags:[]},nodes:[],capabilities:{editText:true}},
  base:{name:'原项目',summary:'项目进展',statusDesc:'',customerIds:['10'],chipSelections:[],people:[],taskOps:[],stagePlans:[{code:'S1',plannedDays:4,note:''},{code:'S2',plannedDays:7,note:'原评述'}]},
  basicBase:{status:'active'},editBaseVersion:'5',
  catalog:{customers:[{id:'10',name:'甲客户'},{id:'11',name:'乙客户'}]},
  referenceFields:{customerIds:'customers',chipSelections:'chips',people:'engineers'},
  values:undefined,taskBulk:undefined,basicDraft:undefined,riskDraft:undefined,changeDraft:undefined,nodeDraft:undefined,nodeRestoreExtras:[],
  stageDraft:undefined,correctionDraft:undefined,planDraft:undefined,lifecycleDraft:undefined,closureDraft:undefined,queuedCommands:[],stagePending:undefined,checkDraft:undefined,
  candidate:undefined,legacyCopy:undefined,stale:false,authFrozen:false,pending:undefined,responsibilityPending:undefined,inFlight:false,loading:false,
});
vm.runInContext(ts.transpileModule(functions,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.None}}).outputText,context);
const clean=value=>JSON.parse(JSON.stringify(value));
assert.deepEqual(clean(personal.draftDifference(context.base,context.base)),{},'完全未修改不产生草稿事项');
assert.deepEqual(clean(personal.draftDifference({name:'未知原值'})),{},'缺基线不猜测改动');
assert.deepEqual(clean(personal.draftDifference({stagePlans:[{code:'S1',plannedDays:4,note:'新评述'},context.base.stagePlans[1]]},context.base)),{stagePlans:[{code:'S1',note:'新评述'}]},'阶段只展示实际改动的评述');
const buffer={format:2,baseVersion:'5',values:{...structuredClone(context.base),summary:'芯片已到货'}};
assert.equal(context.bufferPreview(buffer),'修改项目状态：芯片已到货','旧整页副本与同版本基线比较，不列无关字段');
assert.equal(context.bufferPreview({...buffer,values:context.base}),'','无差异副本不输出空修改');
const references=context.bufferPreview({...buffer,values:{...context.base,customerIds:['11']}});
assert.equal(references,'修改客户：乙客户','关联资料展示名称而非 ID');
assert.equal(context.bufferPreview({...buffer,baseVersion:'4'}),undefined,'旧版本缺基线仅保留原件，不编造差异');
assert.equal(context.bufferPreview({...buffer,baseVersion:'4',preview:'修改客户：乙客户'}),'修改客户：乙客户','新副本在基线失效后仍保留捕获时的真实差异与资料名称');
context.candidate={...buffer,baseVersion:'4'};
assert.match(context.unsavedText(),/缺少原版本.*无法准确列出修改/);
assert.doesNotMatch(context.unsavedText(),/原项目|芯片已到货|客户：10/,'缺基线不把整页快照当修改');
context.candidate=undefined;
context.snapshot.project.tasks=[{id:'31',text:'原有任务',createdAt:'',updatedAt:'',completedAt:'',deletedAt:''}];
context.values=structuredClone(context.base);context.taskBulk='1、原有任务\n2、新增待办';
const taskChanges=context.currentDraftText();
assert.match(taskChanges,/新增待办任务：新增待办/);
assert.doesNotMatch(taskChanges,/原有任务|原项目|项目进展/,'整栏输入只列出实际新增任务');
context.taskBulk='1、原有任务';
assert.equal(context.currentDraftText(),'','无变化任务输入不伪造任务改动');
context.taskBulk='1、原有任务\n2、';
assert.equal(context.currentDraftData().editors.task,undefined,'只多空编号不触发任务草稿自动保存');
assert.equal(context.currentDraftText(),'','空编号不是新增任务');
context.taskBulk=undefined;
context.values.summary='新状态';
const current=context.currentDraftText();
assert.equal(current,'修改项目状态：新状态');
context.candidate={...buffer,preview:current};
assert.equal(context.unsavedText(),current,'当前输入与保留副本相同只展示一次');
assert.equal(context.canRestoreDraft('5'),true);
context.stale=true;
assert.equal(context.canRestoreDraft('5'),false,'他人更新后不允许旧草稿覆盖');
context.stale=false;
assert.equal(context.canRestoreDraft('4'),false,'旧版本草稿仍只供核对');
const html=await readFile('src/web/project-detail.html','utf8');
assert.equal((html.match(/id="drafts"/g)??[]).length,1);
assert.ok(html.indexOf('id="back"')<html.indexOf('id="drafts"')&&html.indexOf('id="drafts"')<html.indexOf('id="save-project"'),'个人草稿位于标题返回与保存之间');
assert.doesNotMatch(html,/class="project-toolbar"/,'删除 tab 下的重复整栏入口');
assert.ok(html.indexOf('id="reload"')>html.indexOf('id="draft-dialog"'),'版本恢复入口留在个人草稿中');
console.log('个人草稿差异、旧副本保护、名称显示、任务差异与入口检查通过。未访问数据库。');
