import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1');
const { connection: c } = await connectDatabase('test_migrator');
const serverUuid = (await c.query('SELECT @@server_uuid uuid'))[0][0].uuid;
assert.equal(serverUuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'p05_extra_' + randomUUID().slice(0, 8), secret = 'P05 新事务合成验收 password 2026';
const checks = [], users = [], projectIds = [];
let app, origin, requests = 0, loseCommit = false, companyOriginal, companyChanged = false, apiB;
const fresh = async (sql, values = []) => { const { connection } = await connectDatabase('test_app'); try { return (await connection.query(sql, values))[0]; } finally { await connection.end(); } };
const itemPath = (data, item, action = 'adopt') => `/api/imports/${data.batch.id}/items/${item.id}/${action}`;
const command = (data, item, selected = item.diffs.map(row => row.key)) => ({ expectedBatchVersion: data.batch.version, expectedReviewVersion: item.reviewVersion, expectedVersion: item.expectedVersion, basis: item.basis, mode: item.mode, targetId: item.targetId, selected, idempotencyKey: randomUUID() });
function client() {
  let cookie = '', csrf = '', account = '';
  return {
    async api(path, method = 'GET', body, expected = 200, raw = false) {
      const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, 'X-GeekDash-Account': account }, ...body === undefined ? {} : { body: raw ? body : JSON.stringify(body) } }); requests++;
      for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
      const result = await response.json(); assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), path + ': ' + response.status + ' ' + JSON.stringify(result));
      if (path === '/api/auth/me') account = result.account.id;
      return result;
    },
    async login(index) { await this.api('/api/auth/login', 'POST', { loginName: users[index].loginName, password: secret }); await this.api('/api/auth/me'); },
    async upload(source, file) { const result = await this.api('/api/imports/upload?' + new URLSearchParams({ source, name: prefix + '.bak', operation: randomUUID() }), 'POST', JSON.stringify(file), 200, true); return this.api('/api/imports/' + result.result.batchId); },
  };
}
async function restoreCompany() {
  if (!companyChanged) return;
  const now = (await apiB.api('/api/catalog/company')).items[0];
  const changes = Object.fromEntries(['fullName', 'shortName', 'managerText', 'namePrefix'].map(key => [key, companyOriginal[key]]));
  await apiB.api('/api/catalog/company/save', 'POST', { id: '1', expectedVersion: now.version, idempotencyKey: randomUUID(), changes });
  const restored = (await apiB.api('/api/catalog/company')).items[0];
  for (const key of Object.keys(changes)) assert.equal(restored[key], companyOriginal[key]);
  companyChanged = false;
}
try {
  const hash = await hashPassword(secret);
  for (let index = 0; index < 2; index++) {
    const loginName = prefix + '_' + index;
    await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [loginName, hash, 'P05补充合成账号' + index]);
    users.push({ id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id, loginName });
  }
  const runtime = await openRuntimeDatabase('test_app'), write = runtime.writeTransaction;
  runtime.writeTransaction = work => write(async lease => {
    const commit = lease.commit;
    if (loseCommit) lease.commit = async function () { await commit.call(this); throw Object.assign(new Error('lost takeover acknowledgement'), { code: 'PROTOCOL_CONNECTION_LOST' }); };
    try { return await work(lease); } finally { if (!loseCommit) lease.commit = commit; }
  });
  app = await createApp(runtime, { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '0.0.0.0', port: 0 });
  const a = client(), b = client(); apiB = b; await a.login(0); await b.login(1);
  const source = (await a.api('/api/imports/sources', 'POST', { name: prefix, idempotencyKey: randomUUID() })).result.sourceNamespace;

  companyOriginal = (await b.api('/api/catalog/company')).items[0];
  const maintenanceBefore = (await fresh('SELECT maintenance_user_id id FROM system_configuration WHERE id=1'))[0].id;
  const company = { fullName: prefix + ' 企业', shortName: prefix, manager: '仅展示姓名', namePrefix: '合成前缀' };
  let data = await a.upload(source, { version: 2, company, projects: [{ id: 7101, name: '' }] });
  const companyItem = data.catalogRows.find(row => row.kind === 'company'), companyBody = command(data, companyItem);
  const companySaved = await a.api(itemPath(data, companyItem), 'POST', companyBody); companyChanged = true;
  assert.equal(companySaved.result.id, '1');
  const companyRow = (await fresh('SELECT full_name,short_name,manager_text,name_prefix,maintenance_user_id FROM system_configuration WHERE id=1'))[0];
  assert.deepEqual(companyRow, { full_name: company.fullName, short_name: company.shortName, manager_text: company.manager, name_prefix: company.namePrefix, maintenance_user_id: maintenanceBefore });
  assert.equal((await fresh('SELECT COUNT(*) n FROM system_configuration'))[0].n, '1');
  data = await a.api('/api/imports/' + data.batch.id);
  await a.api(itemPath(data, data.items[0]), 'POST', command(data, data.items[0]), 422);
  assert.equal((await b.api('/api/catalog/company')).items[0].fullName, company.fullName);
  assert.deepEqual(await a.api(itemPath(data, companyItem, 'results/query'), 'POST', companyBody), companySaved);
  assert.deepEqual(await a.api(itemPath(data, companyItem), 'POST', companyBody), companySaved);
  assert.equal((await fresh('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?', [companyItem.id]))[0].n, '1');
  await restoreCompany();
  checks.push('企业四字段沿单例独立采用，新账号读取与SQL一致；项目随后失败不撤销资料；原键查询/重放只一份采用，维护身份不改变；测试后正常API还原展示字段');

  const names = { chips: ['A', 'B', 'C'].map(v => prefix + '芯片' + v), engineers: ['甲', '乙', '丙'].map(v => prefix + v), tags: ['T1', 'T2'].map(v => prefix + v) };
  const file = { version: 2, chips: names.chips.map((name, i) => ({ id: 7201 + i, name })), engineers: names.engineers.map((name, i) => ({ id: 7301 + i, name, role: '研发' })), tags: names.tags.map((name, i) => ({ id: 7401 + i, name })), projects: [{ id: 7501, name: prefix + ' 名单替换项目', status: '提案中', chips: names.chips.slice(0, 2), tags: names.tags, pm: names.engineers[0], hwOwner: names.engineers[0], swOwner: names.engineers[1], participants: names.engineers.slice(0, 2) }] };
  data = await a.upload(source, file);
  for (const row of data.catalogRows) { const current = await a.api('/api/imports/' + data.batch.id), item = current.catalogRows.find(v => v.id === row.id); await a.api(itemPath(current, item), 'POST', command(current, item)); }
  data = await a.api('/api/imports/' + data.batch.id);
  const saved = await a.api(itemPath(data, data.items[0]), 'POST', command(data, data.items[0])); const projectId = saved.result.projectId; projectIds.push(projectId);
  const ids = {};
  for (const [kind, list] of Object.entries(names)) ids[kind] = (await a.api('/api/catalog/' + kind)).items.filter(v => list.includes(v.name));
  const id = (kind, name) => ids[kind].find(v => v.name === name).id;
  const people = async () => (await fresh('SELECT CAST(engineer_id AS CHAR) id,role FROM project_people WHERE project_id=? ORDER BY role,sort_order,engineer_id', [projectId]));
  const beforePeople = await people(), ownerBefore = await fresh('SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=? ORDER BY user_id', [projectId]);
  data = await a.upload(source, { ...file, projects: [{ id: 7501, chips: [names.chips[0], names.chips[2]], tags: [], hwOwner: names.engineers[2], participants: [names.engineers[1], names.engineers[2]] }] });
  assert.equal(data.items[0].issues.length, 0, JSON.stringify(data.items[0].issues));
  await a.api(itemPath(data, data.items[0]), 'POST', command(data, data.items[0], ['fields.chipIds', 'people.hardware_owner']));
  const afterFirst = await people();
  assert.deepEqual(afterFirst.filter(v => v.role !== 'hardware_owner'), beforePeople.filter(v => v.role !== 'hardware_owner'));
  assert.deepEqual(afterFirst.filter(v => v.role === 'hardware_owner').map(v => v.id), [id('engineers', names.engineers[2])]);
  assert.deepEqual((await fresh('SELECT CAST(chip_id AS CHAR) id FROM project_chips WHERE project_id=? ORDER BY sort_order', [projectId])).map(v => v.id), [id('chips', names.chips[0]), id('chips', names.chips[2])]);
  assert.equal((await fresh('SELECT COUNT(*) n FROM project_tags WHERE project_id=?', [projectId]))[0].n, '2');
  data = await a.api('/api/imports/' + data.batch.id);
  await a.api(itemPath(data, data.items[0]), 'POST', command(data, data.items[0], ['fields.tagIds', 'people.participant']));
  const afterSecond = await people();
  assert.deepEqual(afterSecond.filter(v => v.role !== 'participant'), afterFirst.filter(v => v.role !== 'participant'));
  assert.deepEqual(afterSecond.filter(v => v.role === 'participant').map(v => v.id), [id('engineers', names.engineers[1]), id('engineers', names.engineers[2])]);
  assert.equal((await fresh('SELECT COUNT(*) n FROM project_tags WHERE project_id=?', [projectId]))[0].n, '0');
  assert.deepEqual(await fresh('SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=? ORDER BY user_id', [projectId]), ownerBefore);
  for (const [kind, list] of Object.entries(names)) assert.equal((await a.api('/api/catalog/' + kind)).items.filter(v => list.includes(v.name)).length, list.length);
  const detail = await a.api('/api/projects/' + projectId); assert.deepEqual(detail.project.chips.map(v => v.name), [names.chips[0], names.chips[2]]); assert.equal(detail.project.tags.length, 0);
  assert((await a.api('/api/project-summary')).items.some(v => v.id === projectId));
  checks.push('芯片A/B→A/C及硬件角色整组替换；未选标签/参与人及缺失软件/本地PM保持；第二轮标签明确清空、参与人A/B→B/C；基础资料与账号负责人不删除不转移，详情/简要新读可消费');

  const race = await a.upload(source, { version: 2, projects: [{ id: 7601, name: prefix + ' 接管采用竞争' }] });
  const lost = await a.upload(source, { version: 2, projects: [{ id: 7602, name: prefix + ' 接管丢回包' }] });
  await c.execute('UPDATE users SET enabled=0,version=version+1 WHERE id=?', [users[0].id]);
  const takeoverBody = { expectedVersion: race.batch.version, reason: '合成竞态接续', idempotencyKey: randomUUID() };
  const results = await Promise.all([
    b.api('/api/imports/' + race.batch.id + '/takeover', 'POST', takeoverBody),
    b.api(itemPath(race, race.items[0]), 'POST', command(race, race.items[0]), [403, 409]),
  ]);
  assert.equal(results[0].outcome, 'committed'); assert(['IMPORT_HANDLER_REQUIRED', 'IMPORT_BATCH_VERSION_CONFLICT'].includes(results[1].code));
  assert.equal((await fresh('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?', [race.items[0].id]))[0].n, '0');
  const afterRace = await b.api('/api/imports/' + race.batch.id); assert.equal(afterRace.batch.handlerId, users[1].id); assert.equal(afterRace.batch.uploaderId, users[0].id);
  const raceSaved = await b.api(itemPath(afterRace, afterRace.items[0]), 'POST', command(afterRace, afterRace.items[0])); projectIds.push(raceSaved.result.projectId);
  assert.deepEqual((await fresh('SELECT CAST(user_id AS CHAR) id FROM project_responsibilities WHERE project_id=?', [raceSaved.result.projectId])).map(v => v.id), [users[1].id]);
  assert.equal((await fresh("SELECT COUNT(*) n FROM audit_log WHERE action='import.takeover' AND entity_id=?", [race.batch.id]))[0].n, '1');
  checks.push('接管和采用实际并发：接管成功，基于旧资格/批次的采用拒绝且无采用残留；重新读取后保存一次，上传者保持、新经理负责');

  const lostBody = { expectedVersion: lost.batch.version, reason: '合成接管提交丢回复', idempotencyKey: randomUUID() };
  loseCommit = true;
  const unknown = await b.api('/api/imports/' + lost.batch.id + '/takeover', 'POST', lostBody, 503); loseCommit = false; assert.equal(unknown.outcome, 'unknown');
  const confirmed = await b.api('/api/imports/' + lost.batch.id + '/takeover/results/query', 'POST', lostBody); assert.equal(confirmed.outcome, 'committed');
  assert.deepEqual(await b.api('/api/imports/' + lost.batch.id + '/takeover', 'POST', lostBody), confirmed);
  const lostReadback = await b.api('/api/imports/' + lost.batch.id);
  assert.equal(lostReadback.batch.handlerId, users[1].id); assert.equal(lostReadback.batch.version, String(BigInt(lost.batch.version) + 1n));
  assert.equal((await fresh("SELECT COUNT(*) n FROM audit_log WHERE action='import.takeover' AND entity_id=?", [lost.batch.id]))[0].n, '1');
  assert.equal((await fresh('SELECT COUNT(*) n FROM import_adoptions WHERE item_id=?', [lost.items[0].id]))[0].n, '0');
  checks.push('接管真实COMMIT后丢回复显示未知；原键查询和重放得到同一结果，批次仅增一版、审计一条、未自动采用项目');
  const result = { status: 'passed', verifiedAt: new Date().toISOString(), build: JSON.parse(await readFile('dist/build-info.json', 'utf8')), serverUuid, prefix, requests, checks, projectIds, raceRejection: results[1].code, companyRestored: !companyChanged };
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/import-extra.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { loseCommit = false; try { await restoreCompany(); } finally { if (app) await app.close(); await c.end(); } }
