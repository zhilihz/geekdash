import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';
import { createApp } from '../dist/server/app.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE,'1');
const {connection:c}=await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid,process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix='import_names_'+randomUUID().slice(0,8),password='仅隔离验收 password 2026',checks=[],users=[];
const authOrigin='http://localhost';let app,origin,runtime,fault='',requests=0;
let barrier;
function pauseWrite(kind){let reached,release,timer;const resume=new Promise(resolve=>release=resolve),entered=new Promise((resolve,reject)=>{reached=()=>{clearTimeout(timer);resolve();};timer=setTimeout(()=>{barrier=undefined;release();reject(new Error('未到达并发验收点：'+kind));},15000);});barrier={kind,reached,resume};return{entered,release};}
const lastId=async()=>String((await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id);
async function fresh(sql,params=[]) {const {connection}=await connectDatabase('test_app');try{return (await connection.query(sql,params))[0];}finally{await connection.end();}}
async function start() {
  runtime=await openRuntimeDatabase('test_app');const write=runtime.writeTransaction;
  runtime.writeTransaction=work=>write(async lease=>{
    const execute=lease.execute,query=lease.query,commit=lease.commit;
    for(const [method,original] of [['execute',execute],['query',query]])lease[method]=async function(sql,params){const text=typeof sql==='string'?sql:sql.sql;if(fault==='audit'&&text.startsWith('INSERT INTO audit_log'))return original.call(this,'INSERT INTO __missing_membership_probe VALUES (1)');const value=await original.call(this,sql,params);const gate=barrier;if(gate&&(gate.kind==='lease'&&text.startsWith("UPDATE import_executions SET status='running'")||gate.kind==='project'&&text.startsWith('INSERT INTO projects '))){barrier=undefined;gate.reached();await gate.resume;}return value;};
    lease.commit=async function(){await commit.call(this);if(fault==='ack')throw Object.assign(new Error('lost ack'),{code:'PROTOCOL_CONNECTION_LOST'});};
    try{return await work(lease);}finally{lease.execute=execute;lease.query=query;if(fault!=='ack')lease.commit=commit;}
  });
  app=await createApp(runtime,{origin:authOrigin,secure:false});origin=await app.listen({host:'127.0.0.1',port:0});
}
function client(index) {
  let cookie='',csrf='',id;
  return {
    async api(path,method='GET',body,status=200) {
      const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:authOrigin,'Content-Type':'application/json','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,...id?{'X-GeekDash-Account':id}:{}},...body===undefined?{}:{body:JSON.stringify(body)}});requests++;
      for(const value of r.headers.getSetCookie()){const part=value.split(';')[0];if(part.startsWith('geekdash_dev='))cookie=part;if(part.startsWith('geekdash_dev_csrf='))csrf=part.split('=')[1];}
      const value=await r.json();if(Array.isArray(status))assert(status.includes(r.status),path+':'+JSON.stringify(value));else assert.equal(r.status,status,path+':'+JSON.stringify(value));
      if(path==='/api/auth/me'&&r.ok)id=value.account.id;return value;
    },
    async upload(bytes,newBatch=true) {
      const operation=randomUUID();const response=await fetch(origin+'/api/imports/upload?'+new URLSearchParams({name:'业务备份.json',operation,...newBatch?{new:'1'}:{}}),{method:'POST',headers:{Cookie:cookie,Origin:authOrigin,'Content-Type':'application/octet-stream','X-GeekDash-Request':'1','X-GeekDash-CSRF':csrf,'X-GeekDash-Account':id},body:bytes});requests++;const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result.result.batchId;
    },
    async login(status=200){await this.api('/api/auth/login','POST',{loginName:users[index].login,password},status);if(status===200)await this.api('/api/auth/me');},
    async stream(projectId) {
      const abort=new AbortController(),events=[],instanceId=randomUUID();
      const response=await fetch(origin+'/api/events?accountId='+id+'&instanceId='+instanceId+(projectId?'&projectId='+projectId:''),{headers:{Cookie:cookie},signal:abort.signal});requests++;assert.equal(response.status,200);
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',closed=false;
      const consuming=(async()=>{try{for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){const raw=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const event=raw.match(/^event: (.+)$/m)?.[1],data=raw.match(/^data: (.+)$/m)?.[1];if(event&&data)events.push({event,data:JSON.parse(data)});}}}catch(error){if(!abort.signal.aborted)throw error;}finally{closed=true;}})();
      return {events,instanceId,get closed(){return closed;},async wait(predicate){const end=Date.now()+5000;while(Date.now()<end){if(predicate(events))return;await new Promise(resolve=>setTimeout(resolve,20));}assert.fail('通知未返回预期结果');},async close(){abort.abort();await consuming;}};
    },
  };
}
const command=(action,extra={})=>({action,idempotencyKey:randomUUID(),...extra});
const route=id=>'/api/projects/'+id+'/membership';
const membership=async id=>(await fresh('SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=? ORDER BY user_id',[id])).map(v=>v.id);
const version=async id=>(await fresh('SELECT CAST(version AS CHAR) version FROM projects WHERE id=?',[id]))[0].version;
async function create(client,name,inviteeIds=[]) {return (await client.api('/api/projects','POST',{idempotencyKey:randomUUID(),fields:{name:prefix+' '+name,inviteeIds}})).result.projectId;}
const bodyFor=(batch,item,selected=item.defaultSelected)=>({expectedBatchVersion:batch.batch.version,expectedReviewVersion:item.reviewVersion,expectedVersion:item.expectedVersion,idempotencyKey:randomUUID(),basis:item.basis,selected});
async function execute(client,batch,items) {
  const body={formatVersion:2,idempotencyKey:randomUUID(),items};
  await client.api('/api/imports/'+batch.batch.id+'/executions','POST',body,202);
  let result;const end=Date.now()+60000;
  while(Date.now()<end){result=await client.api('/api/imports/'+batch.batch.id+'/executions?operation='+body.idempotencyKey);if(result.status==='finished')return result;await new Promise(resolve=>setTimeout(resolve,150));}
  assert.fail('持久导入未完成：'+JSON.stringify(result));
}
const readyItems=batch=>[...batch.items,...batch.catalogRows].filter(item=>item.canAdopt&&!item.targetId&&item.kind!=='company'&&!item.needsMapping&&item.issues.every(v=>v.code==='IMPORT_REFERENCE_REQUIRED')).map(item=>({id:item.id,command:bodyFor(batch,item),resolveReferences:true}));
try {
  const hash=await hashPassword(password);
  for(let i=0;i<8;i++){const login=prefix+'_'+i,name=prefix+' '+([3,4].includes(i)?'同名':i);await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,enabled,created_at,updated_at) VALUES (?,?,?,0,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))',[login,hash,name,i===5?0:1]);users.push({id:await lastId(),login,name});}
  await c.execute("INSERT INTO system_configuration(id,maintenance_user_id,full_name,short_name,manager_text,name_prefix,updated_by,updated_at) VALUES (1,?,'','','','',?,UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE maintenance_user_id=VALUES(maintenance_user_id)",[users[2].id,users[2].id]);
  await start();const [a,b,maint]=[0,1,2].map(client);await Promise.all([a.login(),b.login(),maint.login()]);
  await a.api('/api/imports/sources','POST',{name:'不再设置来源',idempotencyKey:randomUUID()},410);
  const filename={version:2,tags:[{id:1,name:prefix+' 客户标签'},{id:2,name:prefix+' 另一客户标签'}],customers:[{id:1,name:prefix+' 客户',tags:[prefix+' 客户标签',prefix+' 另一客户标签']}],chips:[{id:1,name:prefix+' 芯片'}],engineers:[{name:prefix+' 未被引用人员'},{id:2,name:users[1].name}],projects:[{id:1,name:prefix+' 项目一',status:'进行中',customer:prefix+' 客户',odmFactory:prefix+' 客户',chips:[prefix+' 芯片'],pm:[2,users[3].name,users[5].name,users[2].name,prefix+' 未注册'],summary:'最初简介',statusDesc:'人填写的项目说明',stages:Array.from({length:7},()=>({done:false}))},{id:2,name:prefix+' 项目二',status:'已结案',pm:users[1].name}]};
  const bytes=Buffer.from(JSON.stringify(filename));let batchId=await a.upload(bytes),batch=await a.api('/api/imports/'+batchId);
  assert.equal(batch.items.length,2);assert(batch.items.every(v=>v.mode==='new'));assert(!('sources' in batch));
  assert.equal(batch.items[0].payload.stages[0].state,'unknown');assert(!batch.items[0].issues.some(v=>v.code==='IMPORT_STAGE_STATE_REQUIRED'));
  assert.equal(batch.items[0].managers.find(v=>v.name===users[3].name).status,'ambiguous');
  assert.equal(batch.items[0].managers.find(v=>v.name===users[5].name).status,'unmatched');
  const result=await execute(a,batch,readyItems(batch));assert(result.items.every(v=>v.status==='committed'),JSON.stringify(result));
  const projects=result.items.filter(v=>v.kind==='project').map(v=>v.result.projectId);assert.equal(projects.length,2);
  for(const id of projects){assert.deepEqual(await membership(id),[users[0].id]);assert((await a.api('/api/projects?view=all')).items.some(v=>v.id===id));assert((await a.api('/api/project-space')).items.some(v=>v.id===id));await b.api('/api/projects/'+id,'GET',undefined,403);}
  const first=projects.find(id=>result.items.find(v=>v.result.projectId===id)?.id===batch.items[0].id);
  assert(first);const detail=(await a.api('/api/projects/'+first)).project;assert.equal(detail.stageState,'unknown');assert.equal(detail.statusDesc,'人填写的项目说明');
  const stored=await fresh('SELECT state FROM project_stages WHERE project_id=? ORDER BY stage_code',[first]);assert.equal(stored[0].state,'unknown');assert(stored.slice(1).every(v=>v.state==='locked'));
  assert.equal((await fresh('SELECT id FROM engineers WHERE name=?',[prefix+' 未被引用人员'])).length,1);
  const customer=(await fresh('SELECT id FROM customers WHERE name=?',[prefix+' 客户']))[0];
  assert.equal((await fresh('SELECT tag_id FROM customer_tags WHERE customer_id=?',[customer.id])).length,2);
  assert.equal(detail.customerId,String(customer.id));assert.equal(detail.odmCustomerId,String(customer.id));
  const invites=(await b.api('/api/membership-requests')).items.filter(v=>projects.includes(v.projectId));assert.equal(invites.length,2);assert(invites.every(v=>v.status==='pending'));
  const rejected=invites.find(v=>v.projectId===first),accepted=invites.find(v=>v.projectId!==first);
  await b.api(route(first),'POST',command('reject',{requestId:rejected.id}));
  await b.api(route(accepted.projectId),'POST',command('accept',{requestId:accepted.id}));
  assert((await b.api('/api/projects?view=all')).items.some(v=>v.id===accepted.projectId));
  await b.api('/api/projects/'+first,'GET',undefined,403);
  assert.equal((await fresh('SELECT id FROM project_membership_requests WHERE project_id IN (?) AND target_user_id IN (?)',[projects,[users[2].id,users[3].id,users[4].id,users[5].id]])).length,0);
  checks.push('无需来源设置，一次上传及确认后新项目、全部基础资料、初始负责关系入库；缺开始依据保留unknown，个人看板和空间新请求可用');

  batchId=await a.upload(bytes);batch=await a.api('/api/imports/'+batchId);assert(batch.items.every(v=>v.unchanged),JSON.stringify(batch.items.map(v=>({name:v.name,issues:v.issues,diffs:v.diffs}))));assert(batch.catalogRows.every(v=>v.unchanged));
  const updated=structuredClone(filename);updated.projects=[{id:88,name:filename.projects[0].name,summary:'本地改了简介',pm:users[1].name}];
  batchId=await a.upload(Buffer.from(JSON.stringify(updated)));batch=await a.api('/api/imports/'+batchId);const item=batch.items[0];assert.equal(item.targetId,first);assert.deepEqual(item.defaultSelected,[]);assert.deepEqual(item.diffs.map(v=>v.key),['fields.summary']);
  await execute(a,batch,[{id:item.id,command:bodyFor(batch,item,['fields.summary'])}]);
  const saved=(await a.api('/api/projects/'+first)).project;assert.equal(saved.summary,'本地改了简介');assert.equal(saved.statusDesc,'人填写的项目说明');
  assert.deepEqual((await fresh('SELECT status FROM project_membership_requests WHERE project_id=? AND target_user_id=?',[first,users[1].id])).map(v=>v.status),['rejected']);
  checks.push('重复备份一致无需处理；原编号改变仍按名称识别已有项目；差异默认不采用，明确选择简介后其他信息保持');
  checks.push('备份经理唯一匹配只产生持久邀请，接受后个人读取可用；拒绝后重传不重发；同名、停用、维护及未注册姓名不自动授予权限');

  const inviteOnlyProject=await create(a,'仅协作变化'),inviteOnlyVersion=await version(inviteOnlyProject),inviteOnlyBytes=Buffer.from(JSON.stringify({projects:[{name:prefix+' 仅协作变化',pm:users[1].name}]}));
  let inviteOnlyBatch=await a.upload(inviteOnlyBytes),inviteOnlyView=await a.api('/api/imports/'+inviteOnlyBatch),inviteOnlyItem=inviteOnlyView.items[0];
  assert(inviteOnlyItem.unchanged);assert(inviteOnlyItem.canAdopt);assert.deepEqual(inviteOnlyItem.pendingInvitations,[users[1].name]);
  const invitedOnly=await execute(a,inviteOnlyView,[{id:inviteOnlyItem.id,command:bodyFor(inviteOnlyView,inviteOnlyItem,[])}]);assert.equal(invitedOnly.items[0].status,'committed');assert.equal(await version(inviteOnlyProject),inviteOnlyVersion);assert.deepEqual(await membership(inviteOnlyProject),[users[0].id]);
  const pendingOnly=(await b.api('/api/membership-requests')).items.filter(v=>v.projectId===inviteOnlyProject);assert.equal(pendingOnly.length,1);
  inviteOnlyBatch=await a.upload(inviteOnlyBytes);inviteOnlyView=await a.api('/api/imports/'+inviteOnlyBatch);assert.deepEqual(inviteOnlyView.items[0].pendingInvitations,[]);assert.equal(inviteOnlyView.items[0].canAdopt,false);
  await b.api(route(inviteOnlyProject),'POST',command('accept',{requestId:pendingOnly[0].id}));assert.deepEqual(await membership(inviteOnlyProject),[users[0].id,users[1].id]);
  assert.equal((await fresh("SELECT id FROM audit_log WHERE project_id=? AND action='project.import'",[inviteOnlyProject])).length,0);
  checks.push('已有项目正文一致但新增经理匹配时，确认仅发协作邀请；不改项目版本或伪造业务修改历史，接受后加入，重传不重复邀请');

  const ambiguous={projects:[{id:1,name:prefix+' 同名选择一',pm:users[3].name},{id:2,name:prefix+' 同名选择二',pm:users[3].name}]};
  const ambiguousId=await a.upload(Buffer.from(JSON.stringify(ambiguous)));let review=await a.api('/api/imports/'+ambiguousId);
  const chosen=review.items[0];await execute(a,review,[{id:chosen.id,command:{...bodyFor(review,chosen),managerMatches:{[users[3].name]:users[3].id}}}]);
  review=await a.api('/api/imports/'+ambiguousId);assert.equal(review.items[1].managers[0].targetId,users[3].id);
  const continued=await execute(a,review,[{id:review.items[1].id,command:bodyFor(review,review.items[1])}]);assert(continued.items.every(v=>v.status==='committed'));
  const namedRequests=await fresh('SELECT target_user_id id FROM project_membership_requests WHERE project_id IN (SELECT id FROM projects WHERE name IN (?))',[ambiguous.projects.map(v=>v.name)]);
  assert.equal(namedRequests.length,2);assert(namedRequests.every(v=>String(v.id)===users[3].id));
  checks.push('经理同名只在原结果确认一次，同批后续项目复用已确认账号，另一同名账号未获得请求');

  const foreign=await b.upload(Buffer.from(JSON.stringify(updated)));const hidden=(await b.api('/api/imports/'+foreign)).items[0];assert.equal(hidden.restricted,true);assert.equal(hidden.target,null);assert.deepEqual(hidden.diffs,[]);assert(hidden.basic.name);assert.equal(hidden.canAdopt,false);
  await b.api('/api/imports/'+foreign+'/executions','POST',{formatVersion:2,idempotencyKey:randomUUID(),items:[{id:hidden.id,command:{expectedBatchVersion:'1',expectedReviewVersion:hidden.reviewVersion,expectedVersion:null,idempotencyKey:randomUUID(),basis:hidden.basis,selected:['fields.summary']}}]},403);
  checks.push('上传同名已有项目不授予权限，非成员只见基础信息且不能提交更新');

  const beforeRename=await version(first);await a.api('/api/projects/'+first,'PATCH',{scope:'basic',changes:{name:prefix+' 线上已改名'},expectedVersion:beforeRename,idempotencyKey:randomUUID()});
  batchId=await a.upload(Buffer.from(JSON.stringify(updated)));batch=await a.api('/api/imports/'+batchId);assert.equal(batch.items[0].targetId,null);assert(batch.items[0].candidates.some(v=>v.id===first));
  checks.push('曾用名只提示候选，不能自动合并到改名后的项目');

  const records={projects:[{id:1,name:prefix+' 记录联动',nodes:[{id:1,name:'节点甲',stage:1,nextId:2},{id:2,name:'节点乙',stage:1,prevId:1}],risks:[{id:1,content:'原风险',level:'中',resolved:false}],changes:[{id:1,source:'客户',content:'原需求',status:'接受',reason:''}]}]};
  const recordBatch=await a.upload(Buffer.from(JSON.stringify(records)));let recordView=await a.api('/api/imports/'+recordBatch);
  const recordSaved=await execute(a,recordView,readyItems(recordView));assert(recordSaved.items.every(v=>v.status==='committed'),JSON.stringify(recordSaved));const recordProject=recordSaved.items.find(v=>v.kind==='project').result.projectId;
  const originalRisk=(await fresh('SELECT CAST(id AS CHAR) id FROM project_risks WHERE project_id=?',[recordProject]))[0].id;
  records.projects[0].id=999;records.projects[0].risks[0].content='风险说明修正';
  const recordUpdate=await a.upload(Buffer.from(JSON.stringify(records)));recordView=await a.api('/api/imports/'+recordUpdate);
  assert.deepEqual(recordView.items[0].diffs.map(v=>v.key),['record.risk:1']);assert.equal(recordView.items[0].payload.records.find(v=>v.kind==='risk').targetId,originalRisk);
  await execute(a,recordView,[{id:recordView.items[0].id,command:bodyFor(recordView,recordView.items[0],['record.risk:1'])}]);
  assert.equal((await fresh('SELECT content FROM project_risks WHERE id=?',[originalRisk]))[0].content,'风险说明修正');
  records.projects[0].risks[0].content='另一条风险';const addBatch=await a.upload(Buffer.from(JSON.stringify(records)));recordView=await a.api('/api/imports/'+addBatch);
  const recordItem=recordView.items[0],changedBody={...bodyFor(recordView,recordItem,['record.risk:1']),payload:{records:[{key:'risk:1',targetId:null,values:{}}]}};
  const recordPreview=await a.api('/api/imports/'+addBatch+'/items/'+recordItem.id+'/preview','POST',changedBody);assert.equal(recordPreview.item.payload.records.find(v=>v.kind==='risk').targetId,null);
  const asNew=await execute(a,recordView,[{id:recordItem.id,command:{...changedBody,basis:recordPreview.item.basis}}]);assert(asNew.items.every(v=>v.status==='committed'),JSON.stringify(asNew));
  assert.equal((await fresh('SELECT id FROM project_risks WHERE project_id=?',[recordProject])).length,2);
  const ambiguousRecords=await a.upload(Buffer.from(JSON.stringify(records)));recordView=await a.api('/api/imports/'+ambiguousRecords);assert(recordView.items[0].issues.some(v=>v.code==='IMPORT_RECORD_TARGET_REQUIRED'&&v.path==='record.risk:1'));
  assert.equal(Number((await fresh('SELECT COUNT(*) n FROM project_nodes WHERE project_id=?',[recordProject]))[0].n),2);
  checks.push('子记录在同一项目按原编号提示候选，明确选择修正原记录；作为新增保留旧记录，原编号重用只在该行要求选择，不删除其他节点');

  const nodeName=prefix+' 节点因果验收',nodeSource=[{id:1,name:'前置甲',stage:1,prevId:null,nextId:2,doneDate:null},{id:2,name:'后续乙',stage:1,prevId:1,nextId:null,doneDate:null}];
  async function nodeBatch(nodes){const id=await a.upload(Buffer.from(JSON.stringify({projects:[{name:nodeName,nodes}]})));return a.api('/api/imports/'+id);}
  let nodeView=await nodeBatch(nodeSource),nodeResult=await execute(a,nodeView,readyItems(nodeView));assert(nodeResult.items.every(v=>v.status==='committed'));
  const nodeProject=nodeResult.items[0].result.projectId,nodeRows=()=>fresh('SELECT CAST(id AS CHAR) id,title,CAST(previous_node_id AS CHAR) previousId,CAST(next_node_id AS CHAR) nextId,completed_on completed FROM project_nodes WHERE project_id=? ORDER BY id',[nodeProject]);
  const initialNodes=await nodeRows();
  async function nodeChange(nodes,keys,extra={}){const batch=await nodeBatch(nodes),item=batch.items[0],body={...bodyFor(batch,item,keys),...extra};const preview=await a.api(`/api/imports/${batch.batch.id}/items/${item.id}/preview`,'POST',body);return{batch,item,preview,body:{...body,basis:preview.item.basis}};}
  async function rejectNodes(attempt,code,saveCode=code){assert(attempt.preview.issues.some(v=>v.code===code),JSON.stringify(attempt.preview.issues));const before=await nodeRows(),v=await version(nodeProject);const result=await execute(a,attempt.batch,[{id:attempt.item.id,command:attempt.body}]);assert.equal(result.items[0].status,'failed');assert.equal(result.items[0].code,saveCode);assert.deepEqual(await nodeRows(),before);assert.equal(await version(nodeProject),v);}
  const completed=nodeSource.map(v=>({...v,doneDate:'2026-10-01'})),allNodes=['record.project_node:1','record.project_node:2'];
  await rejectNodes(await nodeChange(completed,[allNodes[1]]),'NODE_PREDECESSOR_INCOMPLETE');
  let attempt=await nodeChange(completed,allNodes);assert.equal(attempt.preview.issues.length,0);nodeResult=await execute(a,attempt.batch,[{id:attempt.item.id,command:attempt.body}]);assert(nodeResult.items.every(v=>v.status==='committed'));assert((await nodeRows()).every(v=>v.completed));
  const reason={intent:{kind:'correction',reason:'两条完成日期为误录，明确撤销'}};
  attempt=await nodeChange(nodeSource,[allNodes[0]],reason);assert(attempt.preview.issues.find(v=>v.code==='NODE_PREDECESSOR_INCOMPLETE').requiredKeys.includes(allNodes[1]));await rejectNodes(attempt,'NODE_PREDECESSOR_INCOMPLETE');
  attempt=await nodeChange(nodeSource,allNodes,reason);nodeResult=await execute(a,attempt.batch,[{id:attempt.item.id,command:attempt.body}]);assert(nodeResult.items.every(v=>v.status==='committed'));assert((await nodeRows()).every(v=>v.completed===null));
  const cycle=nodeSource.map(v=>({...v,prevId:v.id===1?2:1,nextId:v.id===1?2:1}));await rejectNodes(await nodeChange(cycle,allNodes),'NODE_CYCLE');
  const asNewNodes={payload:{records:nodeSource.map(v=>({key:'project_node:'+v.id,targetId:null,values:{}}))}};
  await rejectNodes(await nodeChange(nodeSource,[allNodes[0]],asNewNodes),'IMPORT_NODE_REFERENCE_REQUIRED');
  attempt=await nodeChange(nodeSource,allNodes,asNewNodes);nodeResult=await execute(a,attempt.batch,[{id:attempt.item.id,command:attempt.body}]);assert(nodeResult.items.every(v=>v.status==='committed'),JSON.stringify(nodeResult));
  const cloned=await nodeRows(),newNodes=cloned.filter(v=>!initialNodes.some(old=>old.id===v.id));assert.equal(cloned.length,4);assert.equal(newNodes.length,2);assert.equal(newNodes[0].nextId,newNodes[1].id);assert.equal(newNodes[1].previousId,newNodes[0].id);assert.deepEqual(cloned.filter(v=>initialNodes.some(old=>old.id===v.id)),initialNodes);
  attempt=await nodeChange(nodeSource,allNodes,{payload:{records:nodeSource.map(v=>({key:'project_node:'+v.id,targetId:initialNodes[0].id,values:{}}))}});await rejectNodes(attempt,'IMPORT_DUPLICATE_TARGET');
  checks.push('节点只采用后续完成或只撤销前置时提示因果及需同次采用的节点，失败不改版本/数据；同时明确采用成功；新循环拒绝；改为新增重新解析两端，旧链保持且新链只连新ID，重复目标拒绝');

  attempt=await nodeChange(nodeSource,allNodes,{payload:{records:nodeSource.map((v,index)=>({key:'project_node:'+v.id,targetId:newNodes[1-index].id,values:{}}))}});
  assert.equal(attempt.preview.issues.length,0,JSON.stringify(attempt.preview.issues));
  nodeResult=await execute(a,attempt.batch,[{id:attempt.item.id,command:attempt.body}]);assert(nodeResult.items.every(v=>v.status==='committed'),JSON.stringify(nodeResult));
  let remapped=await nodeRows();assert.equal(remapped.find(v=>v.id===newNodes[1].id).nextId,newNodes[0].id);assert.equal(remapped.find(v=>v.id===newNodes[0].id).previousId,newNodes[1].id);assert.deepEqual(remapped.filter(v=>initialNodes.some(old=>old.id===v.id)),initialNodes);
  for(const duplicate of [false,true]){
    const records=initialNodes.map((v,index)=>({...duplicate?{id:1}:{},name:(duplicate?'重号':'无编号')+'修正'+index,stage:1})),keys=['record.project_node:@0','record.project_node:@1'];
    attempt=await nodeChange(records,keys);await rejectNodes(attempt,'IMPORT_RECORD_TARGET_REQUIRED','IMPORT_REVIEW_REQUIRED');
    attempt=await nodeChange(records,keys,{payload:{records:initialNodes.map((v,index)=>({key:'project_node:@'+index,targetId:v.id,values:{}}))}});
    assert.equal(attempt.preview.issues.length,0,JSON.stringify(attempt.preview.issues));nodeResult=await execute(a,attempt.batch,[{id:attempt.item.id,command:attempt.body}]);assert(nodeResult.items.every(v=>v.status==='committed'),JSON.stringify(nodeResult));
    const values=await nodeRows();assert.equal(values.length,4);for(let index=0;index<2;index++)assert.equal(values.find(v=>v.id===initialNodes[index].id).title,records[index].name);
  }
  const foreignNode=(await fresh('SELECT CAST(id AS CHAR) id FROM project_nodes WHERE project_id=? LIMIT 1',[recordProject]))[0].id;
  attempt=await nodeChange(nodeSource,[allNodes[0]],{payload:{records:[{key:'project_node:1',targetId:foreignNode,values:{}}]}});await rejectNodes(attempt,'IMPORT_RECORD_NOT_FOUND');
  checks.push('改选已有节点后按最终对应重接两端且原链保持；缺编号/重复编号只在原记录确认，明确对应后原ID更新；跨项目目标拒绝且无部分写入');

  const stageVersion=await version(recordProject),confirmState={action:'confirmStageState',stageCode:'S1',state:'active',expectedVersion:stageVersion,idempotencyKey:randomUUID()};
  await a.api('/api/projects/'+recordProject+'/actions','POST',confirmState);
  const stageDetail=(await a.api('/api/projects/'+recordProject)).project;assert.equal(stageDetail.stageState,'active');
  const stageDate=(await fresh('SELECT started_on started,completed_on completed FROM project_stages WHERE project_id=? AND stage_code=\'S1\'',[recordProject]))[0];assert.equal(stageDate.started,null);assert.equal(stageDate.completed,null);
  await a.api('/api/projects/'+recordProject+'/actions','POST',{...confirmState,state:'ready'},409);
  checks.push('旧当前阶段原位确认开始状态，保存后新请求读取active，未知日期保持未知，同一操作键不能改为另一个状态');

  const invitation=(await a.api('/api/projects/'+recordProject+'/membership','POST',{action:'invite',targetUserId:users[1].id,idempotencyKey:randomUUID()})).result.requestId;
  await b.api('/api/projects/'+recordProject+'/membership','POST',{action:'accept',requestId:invitation,idempotencyKey:randomUUID()});
  await a.api('/api/projects/'+recordProject+'/membership','POST',{action:'leave',expectedVersion:await version(recordProject),idempotencyKey:randomUUID()});
  const leftView=await a.api('/api/imports/'+recordBatch);assert(leftView.items[0].adoptions.every(value=>!Object.hasOwn(value,'adopted')));
  const adoption=leftView.items[0].adoptions[0];await a.api(`/api/imports/${recordBatch}/items/${leftView.items[0].id}/adoptions/${adoption.id}`,'GET',undefined,403);
  // 改名后名称不再命中，原采用结果仍不能借“新增候选”泄漏旧项目内容。
  await b.api('/api/projects/'+recordProject,'PATCH',{scope:'basic',changes:{name:prefix+' 记录改名'},expectedVersion:await version(recordProject),idempotencyKey:randomUUID()});
  const renamedView=(await a.api(`/api/imports/${recordBatch}/items/${leftView.items[0].id}/preview`,'POST',{...bodyFor(leftView,leftView.items[0],[]),mode:'new',targetId:null,expectedVersion:'0'})).item;assert.equal(renamedView.targetId,null);assert(renamedView.adoptions.every(value=>!Object.hasOwn(value,'adopted')));
  checks.push('退出后原导入采用详情收回；项目改名导致新候选也不能通过原采用历史读取无权的正式内容');

  const [stopping,winning]=[6,7].map(client);await Promise.all([stopping.login(),winning.login()]);
  const handed=await create(stopping,'接管前已交接项目',[users[1].id]);
  const handedRequest=(await b.api('/api/membership-requests')).items.find(row=>row.projectId===handed);
  await b.api('/api/projects/'+handed+'/membership','POST',{action:'accept',requestId:handedRequest.id,idempotencyKey:randomUUID()});
  const handoffBefore=await membership(handed),pausedBatch=await stopping.upload(Buffer.from(JSON.stringify({projects:[{name:prefix+' 停用后待接管'}]})));
  const pausedView=await stopping.api('/api/imports/'+pausedBatch),jobKey=randomUUID(),gate=pauseWrite('lease');
  await stopping.api('/api/imports/'+pausedBatch+'/executions','POST',{formatVersion:2,idempotencyKey:jobKey,items:readyItems(pausedView)},202);
  await gate.entered;
  const changeState=(impact,enabled)=>({enabled,expectedVersion:impact.account.version,impactToken:impact.impactToken,idempotencyKey:randomUUID()});
  try{const impact=await maint.api('/api/accounts/'+users[6].id+'/impact');assert.equal(impact.unhandedProjects.length,0);await maint.api('/api/accounts/'+users[6].id+'/state','POST',changeState(impact,false));}finally{gate.release();}
  await stopping.api('/api/auth/me','GET',undefined,401);
  let stoppedJob;const stoppedEnd=Date.now()+15000;
  while(Date.now()<stoppedEnd){stoppedJob=await a.api('/api/imports/'+pausedBatch+'/executions');if(stoppedJob.status==='finished')break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(stoppedJob.status,'finished');assert(stoppedJob.items.every(row=>row.status==='failed'));assert.equal((await fresh('SELECT id FROM projects WHERE name=?',[prefix+' 停用后待接管'])).length,0);
  let takeoverView=await a.api('/api/imports/'+pausedBatch);
  const takeover={expectedVersion:takeoverView.batch.version,reason:'原处理账号停用，接续剩余导入',idempotencyKey:randomUUID()};
  await maint.api('/api/imports/'+pausedBatch+'/takeover','POST',takeover,403);
  await a.api('/api/imports/'+pausedBatch+'/takeover','POST',takeover);
  takeoverView=await a.api('/api/imports/'+pausedBatch);const taken=await execute(a,takeoverView,readyItems(takeoverView));assert(taken.items.every(row=>row.status==='committed'));
  const takenProject=taken.items[0].result.projectId;assert.deepEqual(await membership(takenProject),[users[0].id]);assert.deepEqual(await membership(handed),handoffBefore);
  const disabledImpact=await maint.api('/api/accounts/'+users[6].id+'/impact');await maint.api('/api/accounts/'+users[6].id+'/state','POST',changeState(disabledImpact,true));await stopping.login();
  assert.equal((await stopping.api('/api/imports/'+pausedBatch)).batch.handlerId,users[0].id);await stopping.api('/api/projects/'+takenProject,'GET',undefined,403);
  checks.push('旧执行已接受但保存前账号停用：项目未写入；维护账号不能接管，业务账号一次接管后只负责后续新增，旧关系保持；原账号启用不夺回批次');

  const winningBatch=await winning.upload(Buffer.from(JSON.stringify({projects:[{name:prefix+' 导入先提交'}]}))),winningView=await winning.api('/api/imports/'+winningBatch);
  const impactBefore=await maint.api('/api/accounts/'+users[7].id+'/impact'),insertGate=pauseWrite('project');
  const running=execute(winning,winningView,readyItems(winningView));await insertGate.entered;
  const disableWhileSaving=maint.api('/api/accounts/'+users[7].id+'/state','POST',changeState(impactBefore,false),409);
  insertGate.release();const [won,refused]=await Promise.all([running,disableWhileSaving]);assert(won.items.every(row=>row.status==='committed'));assert.equal(refused.code,'ACCOUNT_IMPACT_CHANGED');
  const finalImpact=await maint.api('/api/accounts/'+users[7].id+'/impact');assert(finalImpact.unhandedProjects.some(row=>row.id===won.items[0].result.projectId));await winning.api('/api/auth/me');
  checks.push('项目保存事务先取得账号锁：新增与责任一起提交，旧停用确认被拒绝，必须重新核对并交接新项目');

  let realBackup=null;
  if(process.env.GEEKDASH_IMPORT_SYNTHETIC_ONLY!=='1') {
  const real=await readFile('/real-backup.json');batchId=await a.upload(real);batch=await a.api('/api/imports/'+batchId);
  assert.equal(batch.items.length,35);const stageBlocked=batch.items.filter(v=>v.issues.some(e=>e.code==='IMPORT_STAGE_STATE_REQUIRED'));assert.equal(stageBlocked.length,0);
  const realItems=readyItems(batch);const realResult=await execute(a,batch,realItems);
  const failed=realResult.items.filter(v=>v.status!=='committed');assert.equal(failed.length,0,JSON.stringify(failed));
  const adoptedProjects=realResult.items.filter(v=>v.kind==='project');assert.equal(adoptedProjects.length,35,'真实备份所有新项目须可通过当前已确认规则入库');
  for(const item of adoptedProjects){const value=await a.api('/api/projects/'+item.result.projectId);assert(value.project.id===item.result.projectId);assert.deepEqual(await membership(item.result.projectId),[users[0].id]);}
  const formal=await fresh('SELECT COUNT(*) n FROM projects WHERE source_import_item_id IN (?)',[batch.items.map(v=>v.id)]);assert.equal(Number(formal[0].n),35);
  checks.push('用户提供的真实备份只在隔离库完整采用35项目，逐项目新请求和独立SQL/责任关系回读');
  realBackup={projects:35,adopted:adoptedProjects.length,catalogs:realResult.items.filter(v=>v.kind!=='project').length};
  }
  const report={status:'passed',checkedAt:new Date().toISOString(),requests,checks,realBackup,scope:'真实HTTP与隔离MySQL；包含节点新增改对应/完成依赖/循环及账号停用竞争，未验证全部原生页面，不代表阶段交付'};
  await writeFile('test-results/import-project-space-check.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
} finally {await c.end();if(app)await app.close();}
