import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword, digest, identities } from '../dist/server/modules/identity.js';
import { projectSaves } from '../dist/server/modules/project-save.js';

const { connection: c } = await connectDatabase('test_migrator');
const prefix = '__core_' + randomUUID().slice(0, 8);
const password = ' 核心验收 长短语 password 2026 ';
const temporary = '临时密码 long phrase 2026';
const users = [], projects = [], checks = [], durations = [];
let app, runtime, origin, fault = '';
const serve = process.argv.includes('--serve');
const authOrigin = serve ? 'http://127.0.0.1:41862' : 'http://localhost';
async function start() {
  runtime = await openRuntimeDatabase('test_app');
  const write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const execute = lease.execute, commit = lease.commit;
    lease.execute = function(sql, params) {
      if (fault === 'audit' && sql.startsWith('INSERT INTO audit_log')) return execute.call(this, 'INSERT INTO __missing_core_table VALUES (1)');
      return execute.call(this, sql, params);
    };
    lease.commit = async function() { await commit.call(this); if (fault === 'ack') throw Object.assign(new Error('lost acknowledgement'), { code: 'PROTOCOL_CONNECTION_LOST' }); };
    try { return await work(lease); } finally { lease.execute = execute; if (fault !== 'ack') lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: authOrigin, secure: false }); origin = await app.listen({ host: serve ? '0.0.0.0' : '127.0.0.1', port: serve ? 3000 : 0 });
}
function client() {
  let cookie = '', csrf = '', account;
  return {
    get cookie() { return cookie; }, get account() { return account; },
    async api(path, method = 'GET', body, status = 200, extra = {}) {
      const start = performance.now();
      const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: authOrigin, 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, ...(account ? { 'X-GeekDash-Account': account.id } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const value of response.headers.getSetCookie()) {
        const part = value.split(';')[0];
        if (part.startsWith('geekdash_dev=')) cookie = part;
        if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1];
        assert(!value.includes('Domain=')); assert(value.includes('SameSite=Lax'));
      }
      const data = await response.json(); assert.equal(response.status, status, path + ':' + JSON.stringify(data));
      if (path === '/api/auth/me' && status === 200) account = data.account;
      durations.push({ path, ms: performance.now() - start }); return data;
    },
    async login(index, secret = password) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password: secret }); return this.api('/api/auth/me'); },
  };
}
const operation = (version, changes) => ({ expectedVersion: version, idempotencyKey: randomUUID(), changes });
const responsibility = (version, action) => ({ expectedVersion: version, idempotencyKey: randomUUID(), action });
const creation = () => ({ idempotencyKey: randomUUID(), fields: { name: prefix, marketExpectation: '测试输入', detailNote: '原输入', summaryNote: '摘要' } });
async function fresh(id) {
  const { connection } = await connectDatabase('test_app');
  try { return (await connection.query('SELECT CAST(p.id AS CHAR) id,CAST(p.version AS CHAR) version,p.name,CAST(p.created_by AS CHAR) createdBy,(SELECT COUNT(*) FROM project_stages s WHERE s.project_id=p.id) stages,(SELECT COUNT(*) FROM project_responsibilities r WHERE r.project_id=p.id) members,(SELECT COUNT(*) FROM audit_log a WHERE a.project_id=p.id) audits FROM projects p WHERE p.id=?', [id]))[0][0]; }
  finally { await connection.end(); }
}
try {
  const hashes = await Promise.all([hashPassword(temporary), hashPassword(password)]);
  for (let index = 0; index < 5; index++) {
    const loginName = 'core_' + prefix.slice(7) + '_' + index;
    await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hashes[index === 0 ? 0 : 1], '合成账号' + index, index === 0 ? 1 : 0]);
    users.push({ loginName, id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id });
  }
  await start();
  const a = client(), b = client(), others = [client(), client(), client()];
  await a.api('/api/projects', 'GET', undefined, 401);
  await a.api('/api/auth/login', 'POST', { loginName: 'core_missing', password }, 401);
  await a.login(0, temporary); await a.api('/api/projects', 'GET', undefined, 403);
  await a.api('/api/auth/password', 'POST', { currentPassword: 'incorrect', newPassword: password, confirmPassword: password }, 422);
  await a.api('/api/auth/password', 'POST', { currentPassword: temporary, newPassword: password, confirmPassword: password }, 403, { 'X-GeekDash-CSRF': 'incorrect' });
  const old = a.cookie;
  await a.api('/api/auth/password', 'POST', { currentPassword: temporary, newPassword: password, confirmPassword: password });
  await a.api('/api/auth/me', 'GET', undefined, 401, { Cookie: old }); await a.login(0); await b.login(1);
  await a.api('/api/auth/login', 'POST', { loginName: users[0].loginName, password }, 403, { Origin: 'https://wrong.example' });
  const device = client(); await device.login(0);
  const oldAuthenticated = a.cookie; await a.login(0);
  await a.api('/api/auth/me', 'GET', undefined, 401, { Cookie: oldAuthenticated }); await device.api('/api/auth/me');
  fault = 'audit'; await a.api('/api/auth/password', 'POST', { currentPassword: password, newPassword: '新密码 transaction rollback 2026', confirmPassword: '新密码 transaction rollback 2026' }, 503); fault = '';
  await a.api('/api/auth/me'); await device.api('/api/auth/me');
  checks.push('真实临时登录、强制改密、CSRF、改密后重新登录和旧会话撤销');
  const make = creation();
  const created = await a.api('/api/projects', 'POST', make); const id = created.result.projectId; projects.push(id);
  assert.deepEqual((await a.api('/api/projects', 'POST', make)).result, created.result);
  await a.api('/api/projects', 'POST', { ...make, fields: { ...make.fields, name: '换内容' } }, 409);
  let detail = await a.api('/api/projects/' + id);
  assert.equal(detail.project.createdBy, users[0].id); assert.equal(detail.stages.length, 7); assert.equal(detail.stages[0].state, 'ready'); assert.equal(detail.project.status, 'proposal');
  assert.equal(detail.capabilities.editOrdinary, true); assert.equal((await b.api('/api/projects/' + id)).readOnly, true);
  assert.equal((await fresh(id)).members, '1');
  await b.api('/api/projects/' + id, 'PATCH', operation('1', { name: '无权' }), 403);
  await a.api('/api/projects/' + id, 'PATCH', operation('1', { name: '错上下文' }), 409, { 'X-GeekDash-Account': users[1].id });
  await a.api('/api/projects/' + id + '/responsibility', 'POST', responsibility('1', 'leave'), 422);
  checks.push('创建项目及七阶段、真实创建者、自动负责、重复创建对账、非负责人只读和最后退出拒绝');
  const join = responsibility('1', 'join'); await b.api('/api/projects/' + id + '/responsibility', 'POST', join);
  assert.equal((await a.api('/api/projects/' + id)).project.version, '2');
  const body = operation('2', { detailNote: '新账号保存', signal: 'yellow', priority: 'high' });
  await b.api('/api/projects/' + id, 'PATCH', body); assert.equal((await fresh(id)).version, '3');
  assert.equal((await b.api('/api/projects/' + id + '/save-results/query', 'POST', body)).outcome, 'committed');
  assert.equal((await a.api('/api/projects/' + id + '/save-results/query', 'POST', body)).outcome, 'not_found');
  const history = await b.api('/api/projects/' + id + '/audit'); assert.equal(history.items[0].actorKind, 'user'); assert.equal(history.items[0].actorDisplayName, '合成账号1');
  await a.api('/api/projects/' + id, 'PATCH', operation('2', { name: '过期输入' }), 409);
  checks.push('本人加入、实名普通保存及新连接回读、回执账号隔离、统一版本冲突及实名历史');
  const before = await fresh(id);
  fault = 'audit'; await a.api('/api/projects/' + id, 'PATCH', operation('3', { name: '回滚' }), 500); fault = '';
  assert.deepEqual(await fresh(id), before);
  const faultyCreate = creation(); fault = 'audit'; await a.api('/api/projects', 'POST', faultyCreate, 503); fault = '';
  assert.equal((await a.api('/api/projects/create-results/query', 'POST', faultyCreate)).outcome, 'not_found');
  assert.equal((await c.query("SELECT COUNT(*) n FROM projects WHERE source_namespace='geekdash-manual-v1' AND source_key=?", [users[0].id + ':' + faultyCreate.idempotencyKey]))[0][0].n, '0');
  checks.push('保存及创建审计故障：项目、七阶段、关系、版本和回执整体回滚');
  const leaveA = responsibility('3', 'leave'), leaveB = responsibility('3', 'leave');
  const leaves = await Promise.allSettled([a.api('/api/projects/' + id + '/responsibility', 'POST', leaveA), b.api('/api/projects/' + id + '/responsibility', 'POST', leaveB)]);
  assert.equal(leaves.filter(item => item.status === 'fulfilled').length, 1); assert.equal((await fresh(id)).members, '1');
  const remained = (await c.query('SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=?', [id]))[0][0].id;
  const keeper = remained === users[0].id ? a : b;
  const lostAck = responsibility('4', 'join'); const newcomer = remained === users[0].id ? b : a;
  fault = 'ack'; await newcomer.api('/api/projects/' + id + '/responsibility', 'POST', lostAck, 503); fault = '';
  await app.close(); await start();
  assert.equal((await newcomer.api('/api/projects/' + id + '/responsibility-results/query', 'POST', lostAck)).outcome, 'committed');
  assert.equal((await newcomer.api('/api/projects/' + id + '/responsibility', 'POST', lostAck)).result.savedVersion, '5');
  assert.equal((await fresh(id)).members, '2');
  await keeper.api('/api/projects/' + id); checks.push('同时退出仅一个成功，提交后丢失响应、应用重建后原责任回执与持久会话接续');
  await Promise.all(others.map((user, i) => user.login(i + 2)));
  for (const user of others) { const version = (await user.api('/api/projects/' + id)).project.version; await user.api('/api/projects/' + id + '/responsibility', 'POST', responsibility(version, 'join')); }
  const current = (await keeper.api('/api/projects/' + id)).project.version;
  const contenders = [keeper, ...others];
  const races = await Promise.allSettled(contenders.map((user, index) => user.api('/api/projects/' + id, 'PATCH', operation(current, { name: prefix + index }))));
  assert.equal(races.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await fresh(id)).version, String(BigInt(current) + 1n));
  checks.push('四个真实账号同版本并发保存仅一个成功，其他冲突可恢复');
  const actor = await identities(runtime).resolve(keeper.cookie.split('=')[1]);
  const unchanged = await fresh(id);
  await c.execute('UPDATE users SET enabled=0 WHERE id=?', [actor.id]);
  await assert.rejects(projectSaves(runtime).save(id, operation(unchanged.version, { name: '已停用快照越权' }), randomUUID(), actor), error => error.code === 'AUTH_REQUIRED');
  assert.deepEqual(await fresh(id), unchanged);
  await c.execute('UPDATE users SET enabled=1 WHERE id=?', [actor.id]);
  const legacy = operation(unchanged.version, { summaryNote: '原匿名版本遗留结果' });
  await projectSaves(runtime).save(id, legacy, randomUUID());
  assert.equal((await keeper.api('/api/projects/' + id + '/save-results/query', 'POST', legacy)).outcome, 'committed');
  assert.equal((await keeper.api('/api/projects/' + id + '/audit')).items[0].actorKind, 'anonymous');
  checks.push('事务内拒绝已停用身份快照；旧匿名历史保留且只读确认，不伪造实名');
  const backgroundToken = keeper.cookie.split('=')[1];
  await c.execute('UPDATE sessions SET last_seen_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE token_hash=?', [digest(backgroundToken)]);
  const lastSeen = (await c.query('SELECT last_seen_at FROM sessions WHERE token_hash=?', [digest(backgroundToken)]))[0][0].last_seen_at.getTime();
  await keeper.api('/api/projects/' + id); assert.equal((await c.query('SELECT last_seen_at FROM sessions WHERE token_hash=?', [digest(backgroundToken)]))[0][0].last_seen_at.getTime(), lastSeen);
  await keeper.api('/api/auth/activity', 'POST', {}, 200, { 'X-GeekDash-Active': '1' });
  assert.notEqual((await c.query('SELECT last_seen_at FROM sessions WHERE token_hash=?', [digest(backgroundToken)]))[0][0].last_seen_at.getTime(), lastSeen);
  const clock = identities(runtime, () => new Date(Date.now() + 31 * 86400000));
  await assert.rejects(clock.resolve(backgroundToken), error => error.code === 'AUTH_REQUIRED');
  await keeper.api('/api/auth/logout', 'POST', {}); await keeper.api('/api/auth/me', 'GET', undefined, 401);
  checks.push('后台请求不续期、真实前台活动续期、到期不可复活、明确退出撤销当前会话');
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/project-core-report.json', JSON.stringify({ status: 'passed', checks, requests: durations.length, maxRequestMs: Math.max(...durations.map(item => item.ms)), build: (await (await fetch(origin + '/api/health/live')).json()).build }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, requests: durations.length }));
  if (serve) { console.log(JSON.stringify({ status: 'browser_fixture', loginName: users[2].loginName, projectId: id, passwordSource: 'synthetic test constant in this script' })); await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); }
} finally {
  if (app) await app.close();
  if (serve && users.length) { const additional = (await c.query('SELECT CAST(id AS CHAR) id FROM projects WHERE source_namespace=? AND created_by IN (' + users.map(() => '?').join(',') + ')', ['geekdash-manual-v1', ...users.map(user => user.id)]))[0]; for (const item of additional) if (!projects.includes(item.id)) projects.push(item.id); }
  for (const id of projects) { await c.execute('DELETE FROM command_receipts WHERE command_scope LIKE ?', ['user:%:project:' + id + ':%']); await c.execute('DELETE FROM audit_log WHERE project_id=?', [id]); await c.execute('DELETE FROM project_responsibilities WHERE project_id=?', [id]); await c.execute('DELETE FROM project_stages WHERE project_id=?', [id]); await c.execute('DELETE FROM projects WHERE id=?', [id]); }
  for (const user of users) { await c.execute('DELETE FROM command_receipts WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM audit_log WHERE actor_id=?', [user.id]); await c.execute('DELETE FROM sessions WHERE user_id=?', [user.id]); await c.execute('DELETE FROM users WHERE id=?', [user.id]); }
  await c.end();
}
