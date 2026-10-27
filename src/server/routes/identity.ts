import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RuntimeDatabase } from '../infrastructure/runtime-database.js';
import type { Notifications } from '../infrastructure/notifications.js';
import { identities, digest, type Actor } from '../modules/identity.js';
import { failure } from '../modules/project-save.js';
declare module 'fastify' { interface FastifyRequest { actor?: Actor } }
export type AuthConfig = { origin: string; secure: boolean };
export function readAuthConfig(): AuthConfig {
  const origin = process.env.GEEKDASH_ORIGIN ?? 'http://127.0.0.1:41860';
  const url = new URL(origin);
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.origin !== origin || (!local && url.protocol !== 'https:')) throw Object.assign(new Error('AUTH_CONFIG_INVALID'), { code: 'AUTH_CONFIG_INVALID' });
  return { origin, secure: url.protocol === 'https:' };
}
export function registerIdentity(app: FastifyInstance, database: RuntimeDatabase, config: AuthConfig, notifications?: Notifications) {
  const identity = identities(database);
  const cookieName = config.secure ? '__Host-geekdash' : 'geekdash_dev';
  const csrfName = config.secure ? '__Host-geekdash_csrf' : 'geekdash_dev_csrf';
  function cookie(request: FastifyRequest, name: string) {
    const value = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(name + '='))?.slice(name.length + 1);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
  }
  function cookies(reply: FastifyReply, token: string, csrf: string) {
    const suffix = `; Path=/; SameSite=Lax${config.secure ? '; Secure' : ''}; Max-Age=${token ? 30 * 86400 : 0}`;
    reply.header('Set-Cookie', [`${cookieName}=${token}${suffix}; HttpOnly`, `${csrfName}=${csrf}${suffix}`]);
  }
  function source(request: FastifyRequest) { if (request.headers.origin !== config.origin || request.headers['x-geekdash-request'] !== '1') failure('INVALID_REQUEST_SOURCE', 403); }
  const attempts = new Map<string, { count: number; until: number }>();
  function limit(key: string, maximum: number) {
    const time = Date.now();
    for (const [key, value] of attempts) if (value.until <= time) attempts.delete(key);
    if (!attempts.has(key) && attempts.size >= 1024) failure('AUTH_BUSY', 503);
    const item = attempts.get(key) ?? { count: 0, until: time + 15 * 60000 };
    attempts.set(key, item); if (++item.count > maximum) failure('AUTH_RATE_LIMITED', 429);
  }
  app.setErrorHandler((error, request, reply) => {
    const known = error as { status?: number; code?: string; statusCode?: number; fields?: Record<string, string>; currentVersion?: string };
    const status = known.status ?? (known.statusCode && known.statusCode < 500 ? known.statusCode : 503);
    if (status >= 500) app.log.warn({ code: known.code }, '请求未完成');
    reply.code(status).send({ code: known.status ? known.code : status < 500 ? 'INVALID_REQUEST' : known.code === 'COMMIT_UNKNOWN' ? 'COMMIT_UNKNOWN' : 'DATABASE_UNAVAILABLE', outcome: known.code === 'COMMIT_UNKNOWN' ? 'unknown' : 'not_committed', fields: known.status ? known.fields : undefined, currentVersion: known.status ? known.currentVersion : undefined, requestId: request.id });
  });
  app.addHook('preHandler', async request => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/') || path.startsWith('/api/health/') || ['/api/auth/login','/api/auth/register'].includes(path)) return;
    const token = cookie(request, cookieName);
    if (!token) failure('AUTH_REQUIRED', 401);
    const active = request.headers['x-geekdash-active'] === '1';
    request.actor = await identity.resolve(token, active);
    if (!path.startsWith('/api/auth/')) {
      if (request.actor.mustChangePassword) failure('PASSWORD_CHANGE_REQUIRED', 403);
      const expectedAccount=path==='/api/events' && request.method==='GET'?(request.query as {accountId?:string}).accountId:request.headers['x-geekdash-account'];
      if (expectedAccount !== request.actor.id) failure('AUTH_CONTEXT_CHANGED', 409);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      source(request);
      const csrf = request.headers['x-geekdash-csrf'];
      if (typeof csrf !== 'string' || !digest(csrf).equals(request.actor.csrfHash)) failure('CSRF_INVALID', 403);
      if (request.headers['x-geekdash-account'] !== request.actor.id) failure('AUTH_CONTEXT_CHANGED', 409);
    }
  });
  const schema = (properties: Record<string, unknown>) => ({ body: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } });
  const password = { type: 'string', maxLength: 128, minLength: 1 };
  app.post<{ Body: { loginName: string; password: string } }>('/api/auth/login', { bodyLimit: 4096, schema: schema({ loginName: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{2,63}$' }, password }) }, async (request, reply) => {
    source(request); limit('ip:' + request.ip, 100); limit('login:' + request.body.loginName, 20);
    const value = await identity.login(request.body.loginName, request.body.password, request.id, cookie(request, cookieName));
    cookies(reply, value.token, value.csrf); return { status: 'authenticated', accountId: value.accountId };
  });
  app.post<{Body:{loginName:string;name:string;password:string;inviteCode:string}}>('/api/auth/register',{bodyLimit:4096,schema:schema({loginName:{type:'string',pattern:'^[a-z0-9][a-z0-9_-]{2,63}$'},name:{type:'string',minLength:1,maxLength:128},password,inviteCode:{type:'string',pattern:'^(?:[A-Za-z0-9]{10}|[A-Za-z0-9_-]{32})$'}})},async (request,reply)=>{
    source(request);limit('register:'+request.ip,20);const value=await identity.register(request.body,request.id,cookie(request,cookieName));cookies(reply,value.token,value.csrf);return {status:value.status,accountId:value.accountId};
  });
  app.get('/api/accounts/invites',request=>identity.invites(request.actor!));
  app.post<{Body:{role:'business'|'admin';idempotencyKey:string}}>('/api/accounts/invites',{bodyLimit:2048,schema:schema({role:{type:'string',enum:['business','admin']},idempotencyKey:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'}})},request=>identity.createInvite(request.actor!,request.body.role,request.body.idempotencyKey,request.id));
  app.post<{Params:{id:string}}>('/api/accounts/invites/:id/revoke',{schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',pattern:'^[1-9][0-9]{0,19}$'}}}}},request=>identity.revokeInvite(request.actor!,request.params.id,request.id));
  app.get('/api/auth/me', async request => ({ account: { id: request.actor!.id, name: request.actor!.name, mustChangePassword: request.actor!.mustChangePassword,...await identity.accountRole(request.actor!) } }));
  app.get('/api/profile',request=>identity.profile(request.actor!));
  for (const confirm of [false,true]) app.post<{Body:{name:string;expectedVersion:string;idempotencyKey:string}}>(confirm?'/api/profile/results/query':'/api/profile', {bodyLimit:4096}, async request=>{
    const result=await identity.profileSave(request.actor!,request.body,request.id,confirm);
    if(result.outcome==='committed')notifications?.profileChanged(result.result.accountId,result.result.name,result.result.savedVersion);
    return {...result,requestId:request.id};
  });
  app.get('/api/accounts',request=>identity.accounts(request.actor!));
  const accountParams={type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',pattern:'^[1-9][0-9]{0,19}$'}}};
  for(const confirm of [false,true])app.post<{Params:{id:string};Body:{loginName:string;name:string;isProjectManager:boolean;expectedVersion:string;idempotencyKey:string}}>(confirm?'/api/accounts/:id/edit-results/query':'/api/accounts/:id/edit',{
    bodyLimit:4096,schema:{params:accountParams,...schema({loginName:{type:'string',pattern:'^[a-z0-9][a-z0-9_-]{2,63}$'},name:{type:'string',minLength:1,maxLength:128},isProjectManager:{type:'boolean'},expectedVersion:{type:'string',pattern:'^[1-9][0-9]{0,19}$'},idempotencyKey:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'}})},
  },async request=>{const result=await identity.accountEdit(request.actor!,request.params.id,request.body,request.id,confirm);if(result.outcome==='committed'&&result.result.changed)notifications?.accountChanged(result.result.accountId);return {...result,requestId:request.id};});
  app.get<{Params:{id:string}}>('/api/accounts/:id/impact',{schema:{params:accountParams}},request=>identity.accountImpact(request.actor!,request.params.id));
  for(const deleting of [false,true])for(const confirm of [false,true])app.post<{Params:{id:string};Body:{enabled:boolean;expectedVersion:string;impactToken:string;idempotencyKey:string}}>(deleting?(confirm?'/api/accounts/:id/delete-results/query':'/api/accounts/:id/delete'):(confirm?'/api/accounts/:id/state-results/query':'/api/accounts/:id/state'),{
    bodyLimit:4096,schema:{params:accountParams,...schema({enabled:{type:'boolean'},expectedVersion:{type:'string',pattern:'^[1-9][0-9]{0,19}$'},impactToken:{type:'string',pattern:'^[a-f0-9]{64}$'},idempotencyKey:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'}})},
  },async request=>{
    const result=await identity.accountState(request.actor!,request.params.id,{...request.body,...deleting?{enabled:false,deleted:true}:{}},request.id,confirm);
    if(result.outcome==='committed'&&result.result.changed)notifications?.accountChanged(result.result.accountId);
    return {...result,requestId:request.id};
  });
  app.post<{ Body: { currentPassword: string; newPassword: string; confirmPassword: string } }>('/api/auth/password', { bodyLimit: 4096, schema: schema({ currentPassword: password, newPassword: password, confirmPassword: password }) }, async (request, reply) => {
    if (request.body.newPassword !== request.body.confirmPassword) failure('PASSWORD_CONFIRM_MISMATCH', 422);
    limit('password:' + request.actor!.id, 20);
    await identity.changePassword(request.actor!, request.body.currentPassword, request.body.newPassword, request.id);
    notifications?.identityChanged(request.actor!, true);
    cookies(reply, '', ''); return { status: 'changed', next: 'login' };
  });
  app.post('/api/auth/logout', { schema: schema({}) }, async (request, reply) => { await identity.logout(request.actor!, request.id); notifications?.identityChanged(request.actor!); cookies(reply, '', ''); return { status: 'logged_out' }; });
  app.post('/api/auth/activity', { schema: schema({}) }, request => ({ status: 'active', accountId: request.actor!.id }));
}
