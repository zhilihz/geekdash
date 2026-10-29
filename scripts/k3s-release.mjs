import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { validate, fingerprint, resources, selector } from '../deploy/k3s/resources.mjs';

const fail = message => { throw new Error(message); };
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const output = value => console.log(JSON.stringify(value, null, 2));
const list = items => ({apiVersion:'v1',kind:'List',items});
const sleep = ms => new Promise(done => setTimeout(done, ms));
const run = (program, args, input, timeout = 120000) => {
  try { return execFileSync(program, args, {encoding:'utf8',input,timeout,maxBuffer:16*1024*1024,windowsHide:true,stdio:['pipe','pipe','pipe']}).trim(); }
  catch(error) { const operation=program==='kubectl'?args.slice(4,7).filter(arg=>arg!=='-'):args.slice(0,2);fail(`${program} ${operation.join(' ')} 失败（exit=${error.status??'unknown'}, code=${error.code??'none'}）；请检查对应资源/Job日志，未自动重试写入`); }
};
async function until(test, message, milliseconds = 300000) {
  const end = Date.now() + milliseconds;
  do { if (await test()) return; await sleep(2000); } while (Date.now() < end);
  fail(message);
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function restoreMaintenance(maintenance, verifyClosed) {
  const errors=[];
  try { await maintenance(true); } catch(error) { errors.push(`恢复维护命令失败：${error.message}`); }
  let verified=false;
  try { await verifyClosed(); verified=true; } catch(error) { errors.push(`维护回读失败：${error.message}`); }
  return {verified,errors};
}

export async function openRelease(state, {saveState,maintenance,verifyOpen,verifyClosed}) {
  const opening={...state,phase:'opening',openingAt:new Date().toISOString()};
  try {
    await saveState(opening);
    await maintenance(false);
    await verifyOpen();
    await saveState({...state,phase:'complete',completedAt:new Date().toISOString()});
  } catch(error) {
    const restored=await restoreMaintenance(maintenance,verifyClosed);
    try { await saveState({...opening,phase:'opening_failed',openingError:error.message,maintenanceRestored:restored.verified,recoveryErrors:[...restored.errors]}); }
    catch(stateError) { restored.errors.push(`失败状态写入失败：${stateError.message}`); }
    const message=`解除维护未完成：${error.message}；${restored.verified?'已回读确认恢复维护，须status核对后显式retry':'无法确认维护已恢复，立即由运维停止geekdash-api并核对Pod，禁止自动续接'}${restored.errors.length?'；'+restored.errors.join('；'):''}`;
    throw Object.assign(new Error(message,{cause:error}),{maintenanceRestored:restored.verified,recoveryErrors:restored.errors});
  }
}

export async function verifyBackup(evidence, state, config) {
  const paused = Date.parse(state.pausedAt), point = Date.parse(evidence.recoveryPoint), completed = Date.parse(evidence.completedAt);
  if (evidence.context !== config.context || evidence.namespace !== config.namespace || evidence.databaseTarget!==state.databaseTarget || evidence.volumeUid!==state.volumeUid || !state.databaseTarget || !state.volumeUid || !Number.isFinite(paused)
      || !Number.isFinite(point) || !Number.isFinite(completed) || point < paused || completed < point || completed > Date.now()
      || evidence.applicationConsistent !== true) fail('备份证据必须对应本环境，并覆盖后端完全停止之后的完整恢复点');
  for (const kind of ['files','configuration', ...(evidence.database?.path ? ['database'] : [])]) {
    const artifact = evidence[kind];
    if (!artifact || !isAbsolute(artifact.path ?? '') || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '')
        || !(await stat(artifact.path)).isFile() || await hashFile(artifact.path) !== artifact.sha256) fail(`备份${kind}归档缺失或校验失败`);
  }
  if (!evidence.database?.path && (evidence.database?.provider !== 'rds' || typeof evidence.database.backupId!=='string' || !evidence.database.backupId.trim() || /REPLACE|CHANGE_ME|[<>]/i.test(evidence.database.backupId)
      || evidence.database.recoveryPointVerifiedByOperator !== true)) fail('请提供数据库备份归档，或经运维核对可恢复点的RDS备份编号');
  return {recoveryPoint:evidence.recoveryPoint,completedAt:evidence.completedAt,database:evidence.database.path ? {sha256:evidence.database.sha256} : {provider:'rds',backupId:evidence.database.backupId,verifiedBy:'operator'},filesSha256:evidence.files.sha256,configurationSha256:evidence.configuration.sha256};
}

async function load(file) {
  const config = await readJson(file);
  if (typeof config.releaseFile !== 'string' || !config.releaseFile) fail('配置缺少releaseFile');
  const release = await readJson(resolve(dirname(file), config.releaseFile));
  validate(config, release);
  return {config,release,manifest:resources(config,release)};
}

function cluster(config, release) {
  const prefix = ['--context',config.context,'--namespace',config.namespace];
  const kubectl = (args, object, timeout) => run('kubectl',[...prefix,...args],object ? JSON.stringify(object) : undefined,timeout);
  const get = (kind, name) => { const result=kubectl(['get',kind,name,'--ignore-not-found','-o','json']); return result ? JSON.parse(result) : undefined; };
  const apply = object => kubectl(['apply','-f','-'],object);
  const create = object => kubectl(['create','-f','-'],object);
  const deleteLock = lock => kubectl(['delete','--raw',`/api/v1/namespaces/${config.namespace}/configmaps/geekdash-release-lock`,'-f','-'],{apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:lock.metadata.uid,resourceVersion:lock.metadata.resourceVersion}});
  const map = (name,data) => ({apiVersion:'v1',kind:'ConfigMap',metadata:{name,namespace:config.namespace},data});
  const readState = () => { const raw=get('configmap','geekdash-release-state')?.data?.state; return raw ? JSON.parse(raw) : undefined; };
  const saveState = state => apply(map('geekdash-release-state',{state:JSON.stringify({...state,updatedAt:new Date().toISOString()})}));
  const pods = () => JSON.parse(kubectl(['get','pods','-l',selector('api'),'-o','json'])).items;
  const maintenance = enabled => apply(map('geekdash-maintenance',enabled?{enabled:'on'}:{}));
  const recoverJob = (object, state) => {if(state.attempt)object.metadata.name+=`-a${state.attempt}`;return object;};
  async function request(path) {
    try { return await fetch(`https://${config.domain}${path}`,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Cache-Control':'no-cache'}}); }
    catch { return undefined; }
  }
  async function pageMaintenance(enabled) {
    await until(async()=> { const r=await request('/'); if(!r)return false; const valid=enabled ? r.status===503&&r.headers.get('x-geekdash-maintenance')==='on' : r.status===200; await r.body?.cancel(); return valid; },enabled?'公网未确认GeekDash维护页，未继续停服':'公网页面仍未恢复，保留发布状态以便续接');
  }
  async function preflight(initial = false) {
    for (const [kind,name] of [['namespace',config.namespace],['ingressclass',config.ingressClass],['storageclass',config.storageClass]]) if(!get(kind,name))fail(`${kind}/${name}不存在`);
    const expected=[[config.pullSecret,['.dockerconfigjson']],[config.tlsSecret,['tls.crt','tls.key']],[config.databaseSecret,['rds_app']],[config.migrationSecret,['rds_migrator']],[config.databaseCaSecret,['ca.pem']],...(initial?[[config.adminSecret,['admin_account']]]:[])];
    const secrets=new Map();
    for(const [name,keys] of expected){const secret=get('secret',name);if(!secret||keys.some(key=>!secret.data?.[key]))fail(`Secret/${name}缺少指定键`);secrets.set(name,secret);}
    const decode=(name,key)=>Buffer.from(secrets.get(name).data[key],'base64').toString('utf8');
    const parseSecret=(name,key)=>{try{return JSON.parse(decode(name,key));}catch{fail(`Secret/${name}格式无效`);}};
    const app=parseSecret(config.databaseSecret,'rds_app'),migrator=parseSecret(config.migrationSecret,'rds_migrator');
    if(['host','port','database'].some(key=>app[key]!==migrator[key])||!app.user||app.user===migrator.user||!app.password||!migrator.password
      ||app.ssl?.caFile!=='/run/secrets/rds-ca.pem'||migrator.ssl?.caFile!=='/run/secrets/rds-ca.pem')fail('应用与迁移数据库Secret须指向同库、不同账号，并引用/run/secrets/rds-ca.pem');
    const ca=decode(config.databaseCaSecret,'ca.pem').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if(!ca?.length||ca.some(pem=>!new X509Certificate(pem).ca))fail('RDS CA证书无效');
    const cert=new X509Certificate(decode(config.tlsSecret,'tls.crt'));
    if(!cert.checkHost(config.domain)||Date.parse(cert.validTo)<=Date.now())fail('入口TLS证书域名或有效期不正确');
    const pvc=get('pvc','geekdash-imports');
    if(pvc&&(pvc.spec.storageClassName!==config.storageClass||pvc.spec.resources.requests.storage!==config.storageSize))fail('现有PVC与输入不一致；发布不会修改或删除持久卷');
    const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return {status:'preflight_passed',context:config.context,namespace:config.namespace,release:release.release,databaseTarget:digest([app.host,app.port,app.database]),credentials:digest([secrets.get(config.databaseSecret).data,secrets.get(config.migrationSecret).data,secrets.get(config.databaseCaSecret).data]),volumeUid:pvc?.metadata.uid??null,databaseConnectivity:'由同镜像Job和后端启动实测，不以Secret存在代替'};
  }
  async function lock(action) {
    const owner=randomUUID();
    create(map('geekdash-release-lock',{owner,release:release.release,createdAt:new Date().toISOString()}));
    let original;
    try{return await action();}catch(error){original=error;throw error;}finally{
      try{const current=get('configmap','geekdash-release-lock');if(current?.data?.owner===owner)deleteLock(current);}
      catch(error){if(original)throw new Error(`${original.message}；发布锁清理另失败：${error.message}`,{cause:original});throw error;}
    }
  }
  async function databaseJob(object) {
    const name=object.metadata.name, prior=get('job',name);
    if(prior&&(prior.spec.template.metadata.annotations?.['geekdash/config-fingerprint']!==fingerprint(config,release)||prior.spec.template.spec.containers[0].image!==object.spec.template.spec.containers[0].image||JSON.stringify(prior.spec.template.spec.containers[0].command)!==JSON.stringify(object.spec.template.spec.containers[0].command)))fail(`Job/${name}与本次发行不符`);
    if(!prior)create(object);
    await until(()=>{
      const job=get('job',name);
      if(job?.status?.conditions?.some(c=>c.type==='Failed'&&c.status==='True'))fail(`Job/${name}失败；使用 kubectl --context ${config.context} -n ${config.namespace} logs job/${name} 查看。先核对真实schema，再使用显式retry入口，旧Job保留`);
      return job?.status?.conditions?.some(c=>c.type==='Complete'&&c.status==='True');
    },`Job/${name}未在期限内完成，保留现场`,920000);
  }
  async function checkImages(manifest) {
    apply(manifest.infra.find(item=>item.kind==='ServiceAccount'));
    const suffix=randomUUID().replaceAll('-','').slice(0,8), builds=[];
    for(const component of ['web','api']){
      const job=manifest.preflightJob(component,suffix);await databaseJob(job);
      let result;try{result=JSON.parse(kubectl(['logs',`job/${job.metadata.name}`,'--tail=50']));}catch{fail(`${component}预检Job未返回有效构建记录`);}
      const build=result.build??result;
      if(build.revision!==release.revision||build.schemaVersion!==release.schemaVersion||build.dirty!==false)fail(`${component}实际拉取镜像与发行源码/schema不符，未停旧后端`);
      builds.push(build);
    }
    if(JSON.stringify(builds[0])!==JSON.stringify(builds[1]))fail('两镜像构建记录不一致，未停旧后端');
  }
  async function unlock(evidence) {
    const current=get('configmap','geekdash-release-lock');
    if(!current||current.data.owner!==evidence.lockOwner||evidence.noPublisherRunning!==true||typeof evidence.reason!=='string'||!evidence.reason.trim())fail('解锁须准确提供owner、核实没有发布进程并说明原因');
    const jobs=JSON.parse(kubectl(['get','jobs','-l','app.kubernetes.io/name=geekdash','-o','json'])).items;
    if(jobs.some(j=>!j.status?.conditions?.some(c=>['Complete','Failed'].includes(c.type)&&c.status==='True')))fail('仍有未结束的Job，不能清除发布锁');
    const record={action:'unlock',owner:current.data.owner,reason:evidence.reason,at:new Date().toISOString()};
    apply(map('geekdash-release-recovery',{last:JSON.stringify(record)}));
    deleteLock(current);return {status:'unlocked',...record};
  }
  async function pause(state) {
    maintenance(true);
    await pageMaintenance(true);
    const response=await request('/build-info.json');
    if(!response?.ok||(await response.json()).revision!==state.previousRelease.revision)fail('维护入口版本不对应上一发行，未继续停后端');
    kubectl(['scale','deployment/geekdash-api','--replicas=0']);
    await until(()=>pods().length===0,'后端Pod未全部停止，未允许迁移',120000);
    state={...state,phase:'paused',pausedAt:new Date().toISOString()};saveState(state);return state;
  }
  async function verifyClosed() {
    await pageMaintenance(true);
    if(get('deployment','geekdash-api')?.spec.replicas===0&&pods().length===0)return;
    await until(async()=>{const r=await request('/api/health/live');return r?.ok&&(await r.json()).maintenance===true;},'API维护状态无法确认');
  }
  async function verifyOpen() {
    await pageMaintenance(false);
    await until(async()=>{const r=await request('/api/health/live');return r?.ok&&(await r.json()).maintenance===false;},'API仍在维护中，未标记发行完成');
  }
  async function finish(state, manifest) {
    state={...state,phase:'starting'};saveState(state);
    maintenance(true);
    manifest.api.spec.template.metadata.annotations['geekdash/credentials']=state.credentials;
    apply(manifest.web);apply(manifest.api);
    for(const name of ['web','api'])kubectl(['rollout','status',`deployment/geekdash-${name}`,'--timeout=300s'],undefined,320000);
    await pageMaintenance(true);
    await until(async()=>{
      const web=await request('/build-info.json'),api=await request('/api/health/live'),ready=await request('/api/health/ready');
      if(!web?.ok||!api?.ok||!ready?.ok){await Promise.all([web?.body?.cancel(),api?.body?.cancel(),ready?.body?.cancel()]);return false;}
      const [w,a]=await Promise.all([web.json(),api.json()]);await ready.body?.cancel();
      return a.maintenance===true&&[w,a.build].every(v=>v?.revision===release.revision&&v?.schemaVersion===release.schemaVersion&&v?.dirty===false);
    },'真实入口前后端构建/schema未一致或数据库未就绪，维护保持');
    const files=JSON.parse(kubectl(['exec','deployment/geekdash-api','--','node','dist/server/commands/import-files.js','rds_app','--probe-storage']));
    if(files.status!=='verified')fail('导入文件与数据库引用核验未通过，维护保持');
    await openRelease({...state,volumeUid:get('pvc','geekdash-imports')?.metadata.uid,files},{saveState,maintenance,verifyClosed,verifyOpen});
    return {status:'released',release:release.release,revision:release.revision,url:`https://${config.domain}`,businessAcceptance:'待用户实际业务验收'};
  }
  function applyInfra(manifest) {
    for(const item of manifest.infra){if(item.kind==='Namespace')continue;if(item.kind==='PersistentVolumeClaim'&&get('pvc',item.metadata.name))continue;apply(item);}
  }
  return {kubectl,get,preflight,lock,readState,saveState,maintenance,verifyClosed,verifyOpen,databaseJob,recoverJob,checkImages,unlock,pause,finish,applyInfra,pods};
}

async function push(file, destination) {
  if(!destination)fail('push需要指定新的发行清单路径');
  try { await stat(destination); fail('发行清单已存在，不覆盖'); } catch(error) { if(error.code!=='ENOENT')throw error; }
  const input=await readJson(file);
  const release={release:input.release,revision:input.revision,schemaVersion:input.schemaVersion,platform:input.platform};
  if(!/^[a-f0-9]{40}$/.test(release.revision??'')||!/^linux\/(amd64|arm64)$/.test(release.platform??'')||!/^\d{4}-[a-z0-9-]+$/.test(release.schemaVersion??'')||!/^[-a-z0-9]{1,36}$/.test(release.release??'')||!/^\w(?:.*\w)?$/.test(release.release??''))fail('发行版本、源码或平台无效');
  const builds=[], locals=new Map();
  for(const part of ['web','api']){
    const source=input[`${part}Source`],target=input[`${part}Target`];
    if(typeof source!=='string'||!/^[a-z0-9][a-z0-9.:/_-]+$/.test(source)||typeof target!=='string'||!target.includes('/')||!/^[a-z0-9][a-z0-9.:/_-]+:[a-zA-Z0-9_.-]+$/.test(target)||/REPLACE|CHANGE_ME|example\./i.test(target))fail(`${part}镜像源或明确上传目标无效`);
    const [local]=JSON.parse(run('docker',['image','inspect',source]));
    if(`${local.Os}/${local.Architecture}`!==release.platform||local.Config.Labels?.['org.opencontainers.image.revision']!==release.revision)fail(`${part}本地镜像平台或源码标记不符`);
    const path=part==='web'?'/usr/share/nginx/html/build-info.json':'/app/dist/build-info.json';
    const build=JSON.parse(run('docker',['run','--rm','--network','none','--read-only','--cap-drop=ALL','--entrypoint','cat',source,path]));
    if(build.revision!==release.revision||build.schemaVersion!==release.schemaVersion||build.dirty!==false)fail(`${part}镜像内构建记录不符合干净发行要求`);
    builds.push(build);if(builds.length===2&&JSON.stringify(builds[0])!==JSON.stringify(builds[1]))fail('双镜像构建记录不同');
    locals.set(part,local);
  }
  if(input.webTarget===input.apiTarget)fail('前后端必须使用不同上传目标');
  for(const part of ['web','api']){
    const source=input[`${part}Source`],target=input[`${part}Target`],local=locals.get(part);
    const prior=spawnSync('docker',['buildx','imagetools','inspect',target],{encoding:'utf8',timeout:120000,windowsHide:true});
    if(prior.status!==0&&!/manifest unknown|not found|no such manifest/i.test(prior.stderr??''))fail(`${part}远端tag状态无法确认，请检查Harbor权限和连接`);
    let pushed;
    if(prior.status!==0){run('docker',['tag',source,target]);pushed=run('docker',['push',target],undefined,1800000);}
    const remote=prior.status===0?prior.stdout:run('docker',['buildx','imagetools','inspect',target]);
    const digest=/^Digest:\s+(sha256:[a-f0-9]{64})$/m.exec(remote)?.[1];
    if(!digest||pushed&&!pushed.includes(`digest: ${digest}`))fail(`${part}上传结果与远端digest不一致，不生成发行清单`);
    release[`${part}Image`]=target.slice(0,target.lastIndexOf(':'))+'@'+digest;
    run('docker',['pull',release[`${part}Image`]],undefined,1800000);
    const [readback]=JSON.parse(run('docker',['image','inspect',release[`${part}Image`]]));
    if(readback.Id!==local.Id)fail(`${part}远端tag内容与本地镜像不一致，请使用新tag；未覆盖旧镜像，不生成发行清单`);
  }
  if(release.webImage===release.apiImage)fail('前后端不能使用同一镜像');
  await writeFile(destination,JSON.stringify(release,null,2)+'\n',{flag:'wx'});
  return {status:'pushed',releaseFile:resolve(destination),...release};
}

export async function main(args=process.argv.slice(2)) {
  const [command,file,extra]=args;
  if(!['render','preflight','status','init','update','resume','retry','unlock','push'].includes(command)||!file||args.length>3)fail('用法：k3s-release.mjs render|preflight|status|init|update|resume|retry|unlock|push 配置.json [输出目录/备份或恢复证据.json]');
  if(command==='push')return output(await push(file,extra));
  const {config,release,manifest}=await load(resolve(file));
  if(command==='render'){
    if(!extra)fail('render需要提供新目录，用于保存原生JSON清单');
    await mkdir(extra,{recursive:false});
    for(const [name,value] of Object.entries({'resources.json':list([...manifest.infra,manifest.maintenance,manifest.web,manifest.api]),'initialize-job.json':manifest.job('initialize'),'migrate-job.json':manifest.job('migrate'),'verify-job.json':manifest.job('verify'),'preflight-web-job.json':manifest.preflightJob('web','00000000'),'preflight-api-job.json':manifest.preflightJob('api','00000000')}))await writeFile(resolve(extra,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
    return output({status:'rendered',directory:resolve(extra),note:'清单用于审阅；发布使用init/update/resume保证维护与迁移顺序'});
  }
  const c=cluster(config,release),key=fingerprint(config,release);
  if(command==='status')return output({state:c.readState()??null,maintenance:c.get('configmap','geekdash-maintenance')?.data??null,lock:c.get('configmap','geekdash-release-lock')?.data??null,recovery:c.get('configmap','geekdash-release-recovery')?.data??null,deployments:['web','api'].map(part=>{const d=c.get('deployment',`geekdash-${part}`);return {part,image:d?.spec.template.spec.containers[0].image,replicas:d?.spec.replicas,ready:d?.status?.readyReplicas??0};}),jobs:JSON.parse(c.kubectl(['get','jobs','-l','app.kubernetes.io/name=geekdash','-o','json'])).items.map(j=>({name:j.metadata.name,conditions:j.status?.conditions??[]})),recoveryEntry:'opening/opening_failed先resume恢复维护并核对，再显式retry并提供openingReviewed；其他中断用resume；Failed Job核schema后retry；残留lock核实无发布进程/未结束Job后unlock'});
  if(command==='unlock'){if(!extra)fail('unlock需要恢复证据.json');return output(await c.unlock(await readJson(extra)));}
  const recovery=command==='retry'?(extra?await readJson(extra):fail('retry需要恢复证据.json')):undefined;
  if(command==='preflight')return output(await c.lock(async()=>{const result=await c.preflight();await c.checkImages(manifest);return {...result,imagePullAndDatabaseConnections:'verified_in_cluster'};}));
  return output(await c.lock(async()=>{
    let state=c.readState();
    if(['resume','retry'].includes(command)&&state&&(['opening','opening_failed'].includes(state.phase)||state.phase==='complete'&&c.get('configmap','geekdash-maintenance')?.data?.enabled)){
      if(state.fingerprint!==key)fail('解除维护结果未核实；请使用原发行配置恢复维护，不能直接换版本续接');
      const restored=await restoreMaintenance(c.maintenance,c.verifyClosed);
      state={...state,phase:'opening_failed',maintenanceRestored:restored.verified,recoveryErrors:restored.errors};
      try{c.saveState(state);}catch(error){fail(`未继续开闸；${restored.verified?'已确认维护':'无法确认维护，立即由运维停止geekdash-api并核对Pod'}；${restored.errors.join('；')}；失败状态写入失败：${error.message}`);}
      if(!restored.verified)fail(`无法确认维护恢复，立即由运维停止geekdash-api并核对Pod，禁止自动续接；${restored.errors.join('；')}`);
      if(command==='resume')return {status:'maintenance_restored_review_required',phase:state.phase,note:'先核对可能开放期间的业务写入及当前状态，再retry并明确openingReviewed=true；没有自动重新开放'};
      if(recovery?.openingReviewed!==true)fail('维护已恢复；需先核对可能开放期间的业务写入及当前状态，再在retry证据中明确openingReviewed=true');
      state={...state,phase:'starting'};
    }
    const preflight=await c.preflight(command==='init'||state?.mode==='init'&&state.phase==='initializing');
    if(command==='init'){
      if(state||c.get('deployment','geekdash-api'))fail('已有发布状态或后端部署；请先status核对，使用resume/update，不能再次初始化');
      state={mode:'init',phase:'initializing',fingerprint:key,release,databaseTarget:preflight.databaseTarget,credentials:preflight.credentials,startedAt:new Date().toISOString()};c.saveState(state);c.maintenance(true);c.applyInfra(manifest);
    }else if(command==='update'){
      if(state?.phase!=='complete'||!c.get('deployment','geekdash-api'))fail('更新要求已有完整发行；未完成操作请先status后resume');
      if(state.release.release===release.release)fail('本发行已完成，请使用新的发行标识');
      if(state.databaseTarget!==preflight.databaseTarget||state.volumeUid!==preflight.volumeUid)fail('数据库目标或持久卷已漂移，不能按普通更新继续');
      for(const part of ['web','api'])if(c.get('deployment',`geekdash-${part}`)?.spec.template.spec.containers[0].image!==state.release[`${part}Image`])fail(`${part}实际镜像与上一发行不符，先核对手动变更`);
      await c.checkImages(manifest);
      state={mode:'update',phase:'pausing',fingerprint:key,release,previousRelease:state.release,databaseTarget:preflight.databaseTarget,credentials:preflight.credentials,volumeUid:preflight.volumeUid,startedAt:new Date().toISOString()};c.saveState(state);
      state=await c.pause(state);
      return {status:'paused_for_backup',pausedAt:state.pausedAt,note:'后端已停止。完成数据库、导入文件及配置的可恢复备份后，使用resume和备份证据续接'};
    }else{
      if(!state||state.fingerprint!==key)fail('没有与本次配置和发行一致的可续接状态，先status核对');
      if(state.phase==='complete'){await c.verifyOpen();return {status:'already_released',release:release.release};}
      if(state.databaseTarget!==preflight.databaseTarget||state.volumeUid&&state.volumeUid!==preflight.volumeUid)fail('数据库目标或持久卷发生变化，保留维护，不能自动续接');
      if(recovery){
        if(recovery.schemaReviewed!==true||typeof recovery.reason!=='string'||!recovery.reason.trim())fail('retry必须先核对Job日志/实际schema并填写恢复原因');
        if(state.credentials!==preflight.credentials&&recovery.acceptCredentialChanges!==true)fail('凭据已变化，需明确acceptCredentialChanges并重新预检');
        const jobs=JSON.parse(c.kubectl(['get','jobs','-l','app.kubernetes.io/name=geekdash','-o','json'])).items;
        if(jobs.some(j=>!j.status?.conditions?.some(v=>['Complete','Failed'].includes(v.type)&&v.status==='True')))fail('仍有未结束Job，不能创建新的attempt');
        if(state.phase!=='starting'&&state.phase!=='pausing'&&c.pods().length)fail('后端尚未停止，不能重试数据库动作');
        const attempt=(state.attempt??0)+1;if(attempt>9999)fail('恢复次数超出资源名称范围，请人工处理');
        state={...state,attempt,credentials:preflight.credentials,recoveries:[...(state.recoveries??[]),{at:new Date().toISOString(),reason:recovery.reason,attempt,credentialChangeAccepted:recovery.acceptCredentialChanges===true,reviewedFailedJobs:jobs.filter(j=>j.status?.conditions?.some(v=>v.type==='Failed'&&v.status==='True')).map(j=>j.metadata.name)}]};c.saveState(state);
      }else if(state.credentials!==preflight.credentials)fail('暂停后数据库Secret发生变化，保留维护；核对后用retry明确接受凭据变化');
      if(state.phase==='pausing'){await c.checkImages(manifest);state=await c.pause(state);return {status:'paused_for_backup',pausedAt:state.pausedAt};}
    }
    await c.checkImages(manifest);
    if(state.mode==='update'&&['paused','migrating'].includes(state.phase)){
      if(c.pods().length)fail('仍有后端Pod存在，不能迁移；先核对发布中断状态');
      if(!state.backup){const backupFile=recovery?recovery.backupEvidenceFile&&resolve(dirname(extra),recovery.backupEvidenceFile):extra;if(!backupFile)fail('resume/retry必须提供暂停后备份证据.json');state={...state,backup:await verifyBackup(await readJson(backupFile),state,config)};}
      state={...state,phase:'migrating'};c.saveState(state);c.applyInfra(manifest);
      await c.databaseJob(c.recoverJob(manifest.job('migrate'),state));await c.databaseJob(c.recoverJob(manifest.job('verify'),state));
    }else if(state.mode==='init'&&state.phase==='initializing'){
      c.maintenance(true);c.applyInfra(manifest);await c.databaseJob(c.recoverJob(manifest.job('initialize'),state));await c.databaseJob(c.recoverJob(manifest.job('verify'),state));
    }else if(state.phase!=='starting')fail('发布状态不支持自动续接；先检查Job/schema和部署事实');
    return c.finish(state,manifest);
  }));
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({status:'failed',message:error.message}));process.exitCode=1;});
