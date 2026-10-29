// 仅在新建的 geekdash_k3s_verify_* 数据库运行，全部输入为合成数据。
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../dist/server/app.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { readHttpConfig, readShutdownTimeout } from '../dist/server/infrastructure/config.js';
import { verifyImportFiles } from '../dist/server/commands/import-files.js';

assert.equal(process.env.GEEKDASH_SERVE_STATIC, 'disabled');
assert.equal(process.env.GEEKDASH_MAINTENANCE_FILE, '/run/geekdash-maintenance/enabled');
const build = JSON.parse(await readFile('dist/build-info.json', 'utf8'));
const { connection: c, fact } = await connectDatabase('rds_migrator');
assert.match(fact.database, /^geekdash_k3s_verify_[a-z0-9_]+$/);
const prefix = 'runtime_' + randomUUID().slice(0, 8), password = 'Verify-runtime-84!';
const { hashPassword } = await import('../dist/server/modules/identity.js');
await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,is_admin,is_project_manager,created_at,updated_at) VALUES (?,?,?,0,1,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix, await hashPassword(password), 'K3s合成验证']);
await c.end();
const checks = [], authOrigin = 'https://geekdash.verify.test';
let app, runtime, origin, cookie = '', csrf = '', account = '', requests = 0, stream, reader;
async function start() {
  runtime = await openRuntimeDatabase('rds_app');
  app = await createApp(runtime, { origin: authOrigin, secure: true });
  origin = await app.listen({ host: '0.0.0.0', port: 0 });
}
const headers = () => ({ Cookie: cookie, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-Release': build.revision, 'X-GeekDash-CSRF': csrf, 'X-GeekDash-Account': account });
async function api(path, method = 'GET', body, status = 200, override = {}) {
  const r = await fetch(origin + path, { method, headers: { ...headers(), ...override }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) }); requests++;
  for (const value of r.headers.getSetCookie()) {
    assert.match(value, /; Secure/); assert.match(value, /; SameSite=Lax/);
    const part = value.split(';')[0];
    if (part.startsWith('__Host-geekdash=')) { assert.match(value, /; HttpOnly/); cookie = part; }
    if (part.startsWith('__Host-geekdash_csrf=')) csrf = part.split('=')[1];
  }
  const data = await r.json(); assert.equal(r.status, status, path + ': ' + JSON.stringify(data)); return data;
}
async function until(check) {
  const limit = Date.now() + 60000;
  while (!await check()) { assert(Date.now() < limit, '验证等待超时'); await delay(150); }
}
try {
  for (const value of ['true', '*', '0.0.0.0/0', '10.42.0.0/999', '::/0']) assert.throws(() => readHttpConfig({ GEEKDASH_TRUST_PROXY: value }));
  assert.deepEqual(readHttpConfig({ GEEKDASH_TRUST_PROXY: '127.0.0.1,10.42.0.0/16' }).trustProxy, ['127.0.0.1', '10.42.0.0/16']);
  for (const value of ['0', 'abc', '120001']) assert.throws(() => readShutdownTimeout({ GEEKDASH_SHUTDOWN_TIMEOUT_MS: value }));
  checks.push('受信代理和停止预算拒绝危险/无效配置');
  await mkdir(process.env.GEEKDASH_IMPORT_DIR, { recursive: true });
  await start();
  assert.equal((await fetch(origin + '/')).status, 404);
  await api('/api/auth/login', 'POST', { loginName: prefix, password });
  account = (await api('/api/auth/me')).account.id;
  await api('/api/auth/activity', 'POST', {}, 403, { Origin: 'https://other.test' });
  await api('/api/auth/activity', 'POST', {}, 403, { 'X-GeekDash-CSRF': 'invalid' });
  const old = await api('/api/auth/activity', 'POST', {}, 409, { 'X-GeekDash-Release': '0'.repeat(40) });
  assert.equal(old.code, 'FRONTEND_RELEASE_MISMATCH');
  checks.push('独立API无页面；HTTPS Cookie/同源/CSRF与旧构建拒绝');
  const created = await api('/api/projects', 'POST', { idempotencyKey: randomUUID(), fields: { name: prefix + ' 项目' } });
  const id = created.result.projectId;
  const before = await api('/api/projects/' + id);
  stream = await fetch(origin + '/api/events?accountId=' + account + '&instanceId=' + randomUUID() + '&projectId=' + id, { headers: headers() });
  assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  reader = stream.body.getReader(); let events = '';
  const consumption = (async () => { for (;;) { const part = await reader.read(); if (part.done) break; events += new TextDecoder().decode(part.value); } })();
  const save = { scope: 'project', expectedVersion: before.project.version, idempotencyKey: randomUUID(), changes: { name: prefix + ' 已保存' } };
  const saved = await api('/api/projects/' + id, 'PATCH', save);
  assert.equal(saved.outcome, 'committed');
  assert.equal((await api('/api/projects/' + id)).project.name, prefix + ' 已保存');
  await until(() => events.includes('event: project'));
  assert.equal((await api('/api/projects/' + id, 'PATCH', save)).result.savedVersion, saved.result.savedVersion);
  await api('/api/projects/' + id, 'PATCH', { ...save, idempotencyKey: randomUUID(), changes: { name: prefix + ' 不应覆盖' } }, 409);
  checks.push('真实项目创建/保存/新请求回读/幂等/冲突及SSE通知');
  await writeFile(process.env.GEEKDASH_MAINTENANCE_FILE, 'on');
  assert.equal((await api('/api/health/live')).maintenance, true);
  await api('/api/health/ready');
  await api('/api/auth/login', 'POST', { loginName: prefix, password }, 503);
  await api('/api/projects', 'GET', undefined, 503);
  await unlink(process.env.GEEKDASH_MAINTENANCE_FILE);
  checks.push('维护期间认证及业务请求暂停，探针可用，移除维护后恢复');
  const raw = JSON.stringify({ projects: [{ id: 1, name: prefix + ' 导入', status: '提案中' }] });
  const upload = await fetch(origin + '/api/imports/upload?' + new URLSearchParams({ name: '合成.json', operation: randomUUID() }), { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/octet-stream' }, body: raw }); requests++;
  assert.equal(upload.status, 200); const batchId = (await upload.json()).result.batchId;
  const batch = await api('/api/imports/' + batchId);
  const items = batch.items.map(item => ({ id: item.id, command: { expectedBatchVersion: batch.batch.version, expectedReviewVersion: item.reviewVersion, expectedVersion: item.expectedVersion, idempotencyKey: randomUUID(), basis: item.basis, selected: item.defaultSelected }, resolveReferences: true }));
  const command = { formatVersion: 2, idempotencyKey: randomUUID(), items };
  // 正常接收后立即关闭，重启读取同一持久结果。
  await api('/api/imports/' + batchId + '/executions', 'POST', command, 202);
  const closingAt = Date.now(); await app.close(); app = undefined;
  await consumption; assert(Date.now() - closingAt < 55000, 'SSE/当前导入未及时退出'); reader = undefined;
  await start();
  assert.equal((await api('/api/projects/' + id)).project.name, prefix + ' 已保存');
  let result;
  await until(async () => { result = await api('/api/imports/' + batchId + '/executions?operation=' + command.idempotencyKey); return result.status === 'finished'; });
  assert(result.items.every(item => item.status === 'committed'), JSON.stringify(result));
  assert.deepEqual(await api('/api/imports/' + batchId + '/executions', 'POST', command, 202), result);
  for (const item of result.items) assert.equal((await api('/api/projects/' + item.result.projectId)).project.name, prefix + ' 导入');
  checks.push('原始备份上传、后台执行、关闭排空及重启接续；原回执重放不重复建项目');
  const files = await verifyImportFiles('rds_app'); assert.equal(files.status, 'verified'); assert(files.checked >= 1);
  const { connection: inspect } = await connectDatabase('rds_app');
  const [refs] = await inspect.query('SELECT source_file_ref file FROM import_batches WHERE id=?', [batchId]); await inspect.end();
  const original = await readFile(refs[0].file); await writeFile(refs[0].file, 'tampered');
  try { assert.equal((await verifyImportFiles('rds_app')).status, 'failed'); } finally { await writeFile(refs[0].file, original); }
  assert.equal((await verifyImportFiles('rds_app')).status, 'verified');
  checks.push('持久卷原文件尺寸/摘要回读及损坏拒绝');
  console.log(JSON.stringify({ status: 'verified', scope: 'isolated-mysql-https-contract-and-api', serverVersion: fact.serverVersion, requests, checks, build }));
} finally {
  if (app) await app.close();
  if (reader) await reader.cancel().catch(() => {});
  await unlink(process.env.GEEKDASH_MAINTENANCE_FILE).catch(() => {});
}
