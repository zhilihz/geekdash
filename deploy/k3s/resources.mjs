import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const name = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const image = /^[a-z0-9][a-z0-9.:/-]+@sha256:[a-f0-9]{64}$/;
const missing = value => typeof value !== 'string' || !value.trim() || /CHANGE_ME|REPLACE|<|>|\$\{|example\.(com|org)/i.test(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

export function validate(config, release) {
  requireValue(!missing(config.context) && !config.context.startsWith('-'), '必须提供实际kubectl context');
  for (const field of ['namespace','ingressClass','tlsSecret','pullSecret','databaseSecret','migrationSecret','databaseCaSecret','adminSecret','storageClass']) {
    requireValue(!missing(config[field]) && config[field].length <= 63 && name.test(config[field]), `部署配置${field}无效或未填写`);
  }
  requireValue(!missing(config.domain) && /^(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.)+[a-z]{2,}$/.test(config.domain), '必须提供实际HTTPS域名');
  requireValue(config.ingressStreamingConfirmed === true, '请先确认入口支持32MiB上传及SSE流式转发');
  requireValue(Array.isArray(config.trustProxy) && config.trustProxy.length > 0 && config.trustProxy.every(v => {
    if (typeof v !== 'string') return false;
    const [address, prefix, extra] = v.split('/'), family = isIP(address);
    return family && !extra && !['0.0.0.0','::'].includes(address) && (prefix === undefined || /^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (family === 4 ? 32 : 128));
  }), '必须明确受信代理IP/CIDR，不能信任所有来源');
  requireValue(/^\d+(?:Gi|Mi)$/.test(config.storageSize), '必须提供持久卷容量');
  requireValue(config.resources && ['web','api'].every(k => ['requests','limits'].every(t => ['cpu','memory'].every(r => typeof config.resources[k]?.[t]?.[r] === 'string' && /^[0-9]+(?:\.[0-9]+)?(?:m|Mi|Gi)?$/.test(config.resources[k][t][r])))), '必须明确前后端资源requests/limits');
  requireValue(config.ingressAnnotations && typeof config.ingressAnnotations==='object' && !Array.isArray(config.ingressAnnotations) && Object.entries(config.ingressAnnotations).every(([k,v]) => typeof v === 'string' && !missing(v) && !/[\r\n]/.test(k)), 'ingressAnnotations必须是字符串映射');
  requireValue(!missing(release.release) && name.test(release.release) && release.release.length <= 36, '发行标识须为1至36位小写字母、数字或连字符');
  requireValue(/^[a-f0-9]{40}$/.test(release.revision), '必须提供完整Git提交');
  requireValue(/^\d{4}-[a-z0-9-]+$/.test(release.schemaVersion), '数据库版本无效');
  requireValue([release.webImage,release.apiImage].every(value=>image.test(value)&&value.includes('/')&&/[.:]/.test(value.split('/')[0])) && release.webImage !== release.apiImage, '前后端必须提供不同的完整仓库镜像digest（含注册表域名）');
  requireValue(/^linux\/(amd64|arm64)$/.test(release.platform), '必须明确镜像平台linux/amd64或linux/arm64');
  return { config, release };
}

export const fingerprint = (config, release) => createHash('sha256').update(JSON.stringify({config,release})).digest('hex');
export const label = component => ({ 'app.kubernetes.io/name':'geekdash', 'app.kubernetes.io/component':component });
export const selector = component => Object.entries(label(component)).map(([k,v])=>`${k}=${v}`).join(',');

export function resources(config, release) {
  validate(config, release);
  const meta = (name, component) => ({name,namespace:config.namespace,labels:label(component)});
  const service = (component, port) => ({apiVersion:'v1',kind:'Service',metadata:meta(`geekdash-${component}`,component),spec:{type:'ClusterIP',selector:label(component),ports:[{name:'http',port:80,targetPort:port}]}});
  const secrets = profile => ({name:'credentials',projected:{defaultMode:0o440,sources:[
    {secret:{name:profile==='rds_app'?config.databaseSecret:config.migrationSecret,items:[{key:profile,path:profile}]}},
    {secret:{name:config.databaseCaSecret,items:[{key:'ca.pem',path:'rds-ca.pem'}]}},
  ]}});
  const pod = (component, container, volumes) => ({
    serviceAccountName:'geekdash',automountServiceAccountToken:false,
    nodeSelector:{'kubernetes.io/arch':release.platform.split('/')[1]},
    imagePullSecrets:[{name:config.pullSecret}],terminationGracePeriodSeconds:70,
    securityContext:{runAsNonRoot:true,runAsUser:component==='web'?101:1000,runAsGroup:component==='web'?101:1000,fsGroup:component==='web'?101:1000,seccompProfile:{type:'RuntimeDefault'}},
    containers:[{name:component,securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},...container}],
    volumes:[{name:'tmp',emptyDir:{sizeLimit:'128Mi'}},...volumes],
  });
  const deployment = (component, spec) => ({apiVersion:'apps/v1',kind:'Deployment',metadata:meta(`geekdash-${component}`,component),spec:{replicas:1,strategy:{type:'Recreate'},revisionHistoryLimit:3,progressDeadlineSeconds:300,selector:{matchLabels:label(component)},template:{metadata:{labels:label(component),annotations:{'geekdash/release':release.release}},spec}}});
  const probe = (path, port, extra={}) => ({httpGet:{path,port},periodSeconds:5,timeoutSeconds:3,failureThreshold:3,...extra});
  const web = deployment('web',pod('web',{
    image:release.webImage,ports:[{name:'http',containerPort:8080}],resources:config.resources.web,
    volumeMounts:[{name:'tmp',mountPath:'/tmp'},{name:'maintenance',mountPath:'/run/geekdash-maintenance',readOnly:true}],
    startupProbe:probe('/healthz',8080,{failureThreshold:18}),readinessProbe:probe('/healthz',8080),livenessProbe:probe('/healthz',8080,{periodSeconds:10}),
  },[{name:'maintenance',configMap:{name:'geekdash-maintenance'}}]));
  const api = deployment('api',pod('api',{
    image:release.apiImage,ports:[{name:'http',containerPort:3000}],resources:config.resources.api,
    envFrom:[{configMapRef:{name:'geekdash-runtime'}}],
    volumeMounts:[{name:'tmp',mountPath:'/tmp'},{name:'credentials',mountPath:'/run/secrets',readOnly:true},{name:'imports',mountPath:'/var/lib/geekdash/imports'},{name:'maintenance',mountPath:'/run/geekdash-maintenance',readOnly:true}],
    startupProbe:probe('/api/health/live',3000,{failureThreshold:24}),readinessProbe:probe('/api/health/ready',3000,{timeoutSeconds:5}),livenessProbe:probe('/api/health/live',3000,{periodSeconds:10}),
  },[secrets('rds_app'),{name:'imports',persistentVolumeClaim:{claimName:'geekdash-imports'}},{name:'maintenance',configMap:{name:'geekdash-maintenance'}}]));
  const job = mode => {
    requireValue(['initialize','migrate','verify'].includes(mode), '未知数据库作业');
    const volumes=[secrets('rds_migrator')];
    if(mode==='initialize')volumes[0].projected.sources.push({secret:{name:config.adminSecret,items:[{key:'admin_account',path:'admin_account'}]}});
    const command=mode==='initialize'?['node','dist/server/commands/initialize.js','rds_migrator','/run/secrets/admin_account']:['node','dist/server/commands/database.js',mode,'rds_migrator'];
    return {apiVersion:'batch/v1',kind:'Job',metadata:meta(`geekdash-${mode}-${release.release}`,'migration'),spec:{parallelism:1,completions:1,backoffLimit:0,activeDeadlineSeconds:900,template:{metadata:{labels:label('migration'),annotations:{'geekdash/release':release.release,'geekdash/config-fingerprint':fingerprint(config,release)}},spec:{...pod('migration',{image:release.apiImage,command,env:[{name:'GEEKDASH_DB_PROFILE',value:'rds_migrator'}],resources:config.resources.api,volumeMounts:[{name:'tmp',mountPath:'/tmp'},{name:'credentials',mountPath:'/run/secrets',readOnly:true}]},volumes),restartPolicy:'Never'}}}};
  };
  const preflightJob = (component, suffix) => {
    requireValue(['web','api'].includes(component) && /^[a-z0-9]{8}$/.test(suffix), '镜像预检参数无效');
    const volumes = component==='api' ? [secrets('rds_migrator')] : [];
    if(component==='api')volumes[0].projected.sources.push({secret:{name:config.databaseSecret,items:[{key:'rds_app',path:'rds_app'}]}});
    const command = component==='web' ? ['sh','-ec','cat /usr/share/nginx/html/build-info.json'] : ['node','--input-type=module','-e',"import{readFile}from'node:fs/promises';import{connectDatabase}from'./dist/server/infrastructure/db.js';try{const build=JSON.parse(await readFile('./dist/build-info.json','utf8'));for(const profile of ['rds_app','rds_migrator']){const{connection}=await connectDatabase(profile);await connection.end();}console.log(JSON.stringify({status:'verified',build}));}catch(error){console.error(JSON.stringify({status:'failed',code:error.code??'PREFLIGHT_FAILED'}));process.exitCode=1;}"];
    return {apiVersion:'batch/v1',kind:'Job',metadata:meta(`gd-preflight-${component}-${release.release}-${suffix}`,'preflight'),spec:{parallelism:1,completions:1,backoffLimit:0,activeDeadlineSeconds:180,template:{metadata:{labels:label('preflight'),annotations:{'geekdash/config-fingerprint':fingerprint(config,release)}},spec:{...pod(component,{image:release[`${component}Image`],command,resources:config.resources[component],volumeMounts:[{name:'tmp',mountPath:'/tmp'},...(component==='api'?[{name:'credentials',mountPath:'/run/secrets',readOnly:true}]:[])]},volumes),restartPolicy:'Never'}}}};
  };
  const infra=[
    {apiVersion:'v1',kind:'Namespace',metadata:{name:config.namespace}},
    {apiVersion:'v1',kind:'ServiceAccount',metadata:meta('geekdash','runtime'),automountServiceAccountToken:false},
    {apiVersion:'v1',kind:'ConfigMap',metadata:meta('geekdash-runtime','runtime'),data:{HOST:'0.0.0.0',PORT:'3000',GEEKDASH_DB_PROFILE:'rds_app',GEEKDASH_SERVE_STATIC:'disabled',GEEKDASH_ORIGIN:`https://${config.domain}`,GEEKDASH_IMPORT_DIR:'/var/lib/geekdash/imports',GEEKDASH_SHUTDOWN_TIMEOUT_MS:'55000',GEEKDASH_TRUST_PROXY:config.trustProxy.join(','),GEEKDASH_MAINTENANCE_FILE:'/run/geekdash-maintenance/enabled'}},
    {apiVersion:'v1',kind:'PersistentVolumeClaim',metadata:meta('geekdash-imports','storage'),spec:{accessModes:['ReadWriteOnce'],storageClassName:config.storageClass,resources:{requests:{storage:config.storageSize}}}},
    service('web',8080),service('api',3000),
    {apiVersion:'networking.k8s.io/v1',kind:'Ingress',metadata:{...meta('geekdash','entry'),annotations:config.ingressAnnotations},spec:{ingressClassName:config.ingressClass,tls:[{hosts:[config.domain],secretName:config.tlsSecret}],rules:[{host:config.domain,http:{paths:[{path:'/api',pathType:'Prefix',backend:{service:{name:'geekdash-api',port:{number:80}}}},{path:'/',pathType:'Prefix',backend:{service:{name:'geekdash-web',port:{number:80}}}}]}}]}},
  ];
  return {infra,web,api,job,preflightJob,maintenance:{apiVersion:'v1',kind:'ConfigMap',metadata:meta('geekdash-maintenance','maintenance'),data:{enabled:'on'}}};
}
