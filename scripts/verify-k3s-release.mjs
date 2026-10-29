import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { validate, resources, fingerprint } from '../deploy/k3s/resources.mjs';
import { verifyBackup } from './k3s-release.mjs';

const config={context:'geekdash-k3s',namespace:'geekdash',domain:'geekdash.zhiluan.cool',ingressClass:'traefik',ingressAnnotations:{},ingressStreamingConfirmed:true,tlsSecret:'geekdash-tls',pullSecret:'geekdash-harbor',databaseSecret:'geekdash-rds-app',migrationSecret:'geekdash-rds-migrator',databaseCaSecret:'geekdash-rds-ca',adminSecret:'geekdash-bootstrap-admin',trustProxy:['10.42.0.0/16'],storageClass:'csi-disk',storageSize:'10Gi',resources:{web:{requests:{cpu:'50m',memory:'64Mi'},limits:{cpu:'500m',memory:'128Mi'}},api:{requests:{cpu:'250m',memory:'256Mi'},limits:{cpu:'1000m',memory:'768Mi'}}},releaseFile:'release.json'};
const release={release:'k3s-verify',revision:'a'.repeat(40),schemaVersion:'0015-project-deletion',platform:'linux/amd64',webImage:'registry.zhiluan.cool/geekdash/web@sha256:'+'b'.repeat(64),apiImage:'registry.zhiluan.cool/geekdash/api@sha256:'+'c'.repeat(64)};
let assertions=0;
function check(condition){assert.ok(condition);assertions++;}
function rejectsConfig(change){const altered=structuredClone(config);change(altered);assert.throws(()=>validate(altered,release));assertions++;}
validate(config,release);
for(const key of ['context','namespace','domain','ingressClass','tlsSecret','pullSecret','databaseSecret','migrationSecret','databaseCaSecret','adminSecret','storageClass'])rejectsConfig(c=>{c[key]='REPLACE_THIS';});
for(const proxy of [[],['true'],['0.0.0.0/0'],['::/0'],['10.0.0.1/0'],['10.0.0.1/33'],['10.0.0.1/no'],['dns.internal'],['::/129']])rejectsConfig(c=>{c.trustProxy=proxy;});
rejectsConfig(c=>{c.ingressStreamingConfirmed=false;});rejectsConfig(c=>{c.resources.api.limits.memory='';});rejectsConfig(c=>{c.storageSize='not-set';});
for(const change of [r=>{r.apiImage='geekdash:latest';},r=>{r.apiImage=r.webImage;},r=>{r.revision='abc';},r=>{r.platform='windows/amd64';},r=>{r.release='BAD_NAME';},r=>{r.schemaVersion='latest';}]){const altered=structuredClone(release);change(altered);assert.throws(()=>validate(config,altered));assertions++;}
const rendered=resources(config,release), ingress=rendered.infra.find(r=>r.kind==='Ingress');
check(ingress.spec.rules[0].http.paths[0].path==='/api'&&ingress.spec.rules[0].http.paths[0].backend.service.name==='geekdash-api');
check(ingress.spec.rules[0].http.paths[1].backend.service.name==='geekdash-web');
check(Object.keys(ingress.metadata.annotations).length===0);
for(const component of ['web','api']){
  const d=rendered[component],pod=d.spec.template.spec;
  check(d.spec.replicas===1&&d.spec.strategy.type==='Recreate');
  check(pod.automountServiceAccountToken===false&&pod.securityContext.runAsNonRoot===true&&pod.containers[0].securityContext.readOnlyRootFilesystem===true);
  check(pod.nodeSelector['kubernetes.io/arch']==='amd64');
}
check(rendered.api.spec.template.spec.terminationGracePeriodSeconds===70);
check(rendered.web.spec.template.spec.containers[0].volumeMounts.some(m=>m.mountPath==='/run/geekdash-maintenance'&&!m.subPath));
check(rendered.api.spec.template.spec.volumes.some(v=>v.persistentVolumeClaim?.claimName==='geekdash-imports'));
check(rendered.api.spec.template.spec.containers[0].volumeMounts.some(m=>m.mountPath==='/run/geekdash-maintenance'&&!m.subPath));
check(!rendered.api.spec.template.spec.volumes.find(v=>v.name==='credentials').projected.sources.some(s=>s.secret.name===config.adminSecret));
for(const mode of ['initialize','migrate','verify']){
  const j=rendered.job(mode),p=j.spec.template.spec;
  check(j.spec.backoffLimit===0&&j.spec.parallelism===1&&j.spec.completions===1&&p.restartPolicy==='Never');
  check(p.containers[0].image===release.apiImage&&p.automountServiceAccountToken===false);
  check(p.volumes.find(v=>v.name==='credentials').projected.sources.some(s=>s.secret.name===config.adminSecret)===(mode==='initialize'));
}
assert.throws(()=>rendered.job('seed'));assertions++;
for(const part of ['web','api']){const j=rendered.preflightJob(part,'12345678');check(j.spec.template.spec.containers[0].image===release[`${part}Image`]&&j.spec.backoffLimit===0);check(!j.spec.template.spec.containers[0].command.join(' ').includes('initialize.js'));}
check(fingerprint(config,release)!==fingerprint({...config,domain:'new.zhiluan.cool'},release));
const directory=await mkdtemp(resolve(tmpdir(),'geekdash-k3s-check-'));
try{
  const content='synthetic encrypted archive evidence',archive=resolve(directory,'archive.enc'),sha=createHash('sha256').update(content).digest('hex');
  await writeFile(archive,content);await writeFile(resolve(directory,'environment.json'),JSON.stringify(config));await writeFile(resolve(directory,'release.json'),JSON.stringify(release));
  const state={pausedAt:new Date(Date.now()-60000).toISOString(),databaseTarget:'e'.repeat(64),volumeUid:'synthetic-volume'}, evidence={context:config.context,namespace:config.namespace,databaseTarget:state.databaseTarget,volumeUid:state.volumeUid,recoveryPoint:new Date(Date.now()-30000).toISOString(),completedAt:new Date(Date.now()-10000).toISOString(),applicationConsistent:true,database:{provider:'rds',backupId:'synthetic-backup',recoveryPointVerifiedByOperator:true},files:{path:archive,sha256:sha},configuration:{path:archive,sha256:sha}};
  const verified=await verifyBackup(evidence,state,config);check(verified.database.verifiedBy==='operator');
  for(const change of [e=>{e.context='other';},e=>{e.namespace='other';},e=>{e.databaseTarget='other';},e=>{e.volumeUid='other';},e=>{e.recoveryPoint=new Date(Date.now()-120000).toISOString();},e=>{e.completedAt=new Date(Date.now()+120000).toISOString();},e=>{e.applicationConsistent=false;},e=>{e.files.sha256='0'.repeat(64);},e=>{e.database.recoveryPointVerifiedByOperator=false;},e=>{e.files.path='relative.enc';}]){
    const altered=structuredClone(evidence);change(altered);await assert.rejects(verifyBackup(altered,state,config));assertions++;
  }
  const command=resolve('scripts/k3s-release.mjs');
  const out=resolve(directory,'render');
  const result=execFileSync(process.execPath,[command,'render',resolve(directory,'environment.json'),out],{encoding:'utf8'});
  check(JSON.parse(result).status==='rendered');
  check(JSON.parse(await readFile(resolve(out,'resources.json'),'utf8')).kind==='List');
  check(JSON.parse(await readFile(resolve(out,'initialize-job.json'),'utf8')).kind==='Job');
  const overwrite=spawnSync(process.execPath,[command,'render',resolve(directory,'environment.json'),out],{encoding:'utf8'});check(overwrite.status===1);
  const invalid=spawnSync(process.execPath,[command,'preflight',resolve('deploy/k3s/environment.example.json')],{encoding:'utf8'});check(invalid.status===1);
  console.log(JSON.stringify({status:'passed',assertions,scope:'纯资源渲染、拒绝无效参数、备份文件hash门禁；未连接K3s/Harbor/RDS，不代表发布验收'}));
}finally{
  // 本脚本仅删除自己在系统临时目录创建的唯一测试目录。
  if(!directory.startsWith(resolve(tmpdir())+ (process.platform==='win32'?'\\':'/')))throw new Error('临时路径超出范围');
  await rm(directory,{recursive:true,force:true});
}
