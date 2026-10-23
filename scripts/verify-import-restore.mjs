import { executeImport } from './import-execution-test-helper.mjs';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { verifyDatabase, loadSchema } from '../dist/server/infrastructure/schema.js';
import { hashPassword } from '../dist/server/modules/identity.js';

// 仅合成隔离实例：fixture → snapshot → 原生 dump/restore → verify。
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1');
const mode = process.argv[2];
assert(['fixture', 'snapshot', 'verify'].includes(mode));
const { connection: c } = await connectDatabase('test_migrator');
const uuid = (await c.query('SELECT @@server_uuid uuid'))[0][0].uuid;
assert.equal(uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID, '实例 UUID 必须明确匹配');
const privateDir = '/restore-private', sha = data => createHash('sha256').update(data).digest('hex');
let app, origin, requests = 0;
const path = (data, item, action) => action === 'adopt' ? {batchId:data.batch.id,itemId:item.id} : `/api/imports/${data.batch.id}/items/${item.id}/${action}`;
const command = (data, item) => ({ expectedBatchVersion: data.batch.version, expectedReviewVersion: item.reviewVersion, expectedVersion: item.expectedVersion, basis: item.basis, mode: item.mode, targetId: item.targetId, selected: item.diffs.map(row => row.key), idempotencyKey: randomUUID() });
async function start() { app = await createApp(await openRuntimeDatabase('test_app'), { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '0.0.0.0', port: 0 }); }
function client() {
  let cookie = '', csrf = '', account = '';
  return {
    async api(route, method = 'GET', body, expected = 200, raw = false) {
      if(typeof route==='object')return executeImport(this.api.bind(this),route,body,expected);
      const response = await fetch(origin + route, { method, headers: { Cookie: cookie, Origin: 'http://localhost', 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'X-GeekDash-Request': '1', 'X-GeekDash-CSRF': csrf, 'X-GeekDash-Account': account }, ...body === undefined ? {} : { body: raw ? body : JSON.stringify(body) } }); requests++;
      for (const value of response.headers.getSetCookie()) { const part = value.split(';')[0]; if (part.startsWith('geekdash_dev=')) cookie = part; if (part.startsWith('geekdash_dev_csrf=')) csrf = part.split('=')[1]; }
      const result = await response.json(); assert.ok((Array.isArray(expected)?expected:[expected]).includes(response.status), route + ': ' + JSON.stringify(result));
      if (route === '/api/auth/me') account = result.account.id;
      return result;
    },
    async login(loginName, password) { await this.api('/api/auth/login', 'POST', { loginName, password }); await this.api('/api/auth/me'); },
    async upload(source, file) { const result = await this.api('/api/imports/upload?' + new URLSearchParams({ source, name: 'restore-synthetic.bak', operation: randomUUID() }), 'POST', JSON.stringify(file), 200, true); return this.api('/api/imports/' + result.result.batchId); },
  };
}
async function tableSnapshot() {
  const resource = await loadSchema(), tables = {};
  for (const table of resource.manifest.tables) {
    const columns = table.columns.map(column => '`' + column.name + '`').join(',');
    const pk = table.indexes.find(index => index.name === 'PRIMARY'); assert(pk, table.name);
    const rows = (await c.query(`SELECT ${columns} FROM \`${table.name}\` ORDER BY ${pk.columns.map(name => '`' + name + '`').join(',')}`))[0];
    tables[table.name] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
  }
  return { schema: resource.manifest.version, tables };
}
async function filesSnapshot() {
  const files = [], rows = (await c.query('SELECT id,source_file_ref path,source_bytes bytes,HEX(source_hash) sha FROM import_batches ORDER BY id'))[0];
  for (const row of rows) {
    const storedPath = row.path === 'probe/source.json' ? resolve('/imports', row.path) : resolve(row.path);
    const file = { batchId: row.id, path: row.path, storedPath, bytes: Number(row.bytes), sha256: row.sha.toLowerCase() };
    assert(storedPath.startsWith(resolve('/imports') + sep), '文件必须位于受控 imports 目录');
    const data = await readFile(storedPath); assert.equal(data.length, file.bytes); assert.equal(sha(data), file.sha256);
    files.push(file);
  }
  return { files };
}
async function fresh(sql, values = []) { const { connection } = await connectDatabase('test_app'); try { return (await connection.query(sql, values))[0]; } finally { await connection.end(); } }
try {
  await mkdir(privateDir, { recursive: true });
  if (mode === 'fixture') {
    const prefix = 'p05_restore_' + randomUUID().slice(0, 8), password = randomBytes(24).toString('base64url');
    await c.execute('INSERT INTO users(login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix, await hashPassword(password), 'P05隔离恢复合成账号']);
    await start(); const api = client(); await api.login(prefix, password);
    const source = (await api.api('/api/imports/sources', 'POST', { name: prefix, idempotencyKey: randomUUID() })).result.sourceNamespace;
    const file = { version: 2, appVersion: '1054', projects: [{ id: 9101, name: prefix + ' 正式来源项目', status: '提案中', summary: '合成简介', statusDesc: '来自原文件的说明', statusDescEntries: [{ text: '来自原文件的说明', updatedAt: '2026-09-01 09:00:00' }], detailNote: '完整来源资料', summary_note: '原简要备注', chipstat_note: '原芯片备注', nodes: [{ id: 9102, name: '来源项目节点', stageId: 1, stage: '需求立项', targetDate: '2026-11-20', output: '原成果', doneDate: '', prevId: null, nextId: null, x: 0, y: 0 }], risks: [{ id: 9103, content: '来源风险', level: '中', resolved: false }], statusHistory: [{ date: '旧未知时间', text: '完整旧历史' }, { date: '旧未知时间', text: '完整旧历史' }], statusDescHistory: [{ date: '', text: '' }], lastCheckAt: 1700000000000 }] };
    const first = await api.upload(source, file), item = first.items[0]; assert.equal(item.issues.length, 0, JSON.stringify(item.issues));
    const body = command(first, item), saved = await api.api(path(first, item, 'adopt'), 'POST', body);
    file.projects[0].summary = '待审原始简介';
    const pending = await api.upload(source, file), pendingItem = pending.items[0];
    const correctedSummary = '恢复后继续使用的人工修正简介';
    // 恢复验收保留升级前的待审内容，旧写接口不再可用。
    await c.execute('UPDATE import_items SET corrected_payload_json=? WHERE id=?',[JSON.stringify({fields:{summary:correctedSummary}}),pendingItem.id]);
    const reread = await api.api('/api/imports/' + pending.batch.id); assert.equal(reread.items[0].payload.fields.summary, correctedSummary);
    assert.equal((await api.api('/api/projects/' + saved.result.projectId)).project.summary, '合成简介');
    const fixture = { sourceUuid: uuid, loginName: prefix, password, source, firstBatch: first.batch.id, firstItem: item.id, body, saved, pendingBatch: pending.batch.id, pendingItem: pendingItem.id, projectId: saved.result.projectId, correctedSummary };
    await writeFile(privateDir + '/fixture.json', JSON.stringify(fixture), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ event: 'restore_fixture_ready', sourceUuid: uuid, firstBatch: first.batch.id, pendingBatch: pending.batch.id, projectId: fixture.projectId, requests }));
  } else if (mode === 'snapshot') {
    const state = { capturedAt: new Date().toISOString(), sourceUuid: uuid, ...await tableSnapshot(), ...await filesSnapshot() };
    await writeFile(privateDir + '/snapshot.json', JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ event: 'restore_snapshot_ready', sourceUuid: uuid, tables: Object.keys(state.tables).length, files: state.files.length }));
  } else {
    const before = JSON.parse(await readFile(privateDir + '/snapshot.json', 'utf8'));
    const fixture = JSON.parse(await readFile(privateDir + '/fixture.json', 'utf8'));
    assert.notEqual(uuid, before.sourceUuid, '禁止在原实例执行恢复后的接续写入');
    const structure = await verifyDatabase('test_migrator');
    const restored = await tableSnapshot(); assert.deepEqual(restored, { schema: before.schema, tables: before.tables }, '登录前核全部表逐行摘要，包含来源/绑定/采用/待审修正/历史/会话');
    const files = await filesSnapshot(); assert.deepEqual(files, { files: before.files });
    const checks = ['恢复实例 UUID 与原实例不同，当前增量结构校验通过', '登录前全部表行数与逐行内容SHA一致', '全部原文件长度与SHA一致；初迁移合成fixture按固定输入补齐的来源单列'];
    await start(); const api = client(); await api.login(fixture.loginName, fixture.password);
    const resultPath = `/api/imports/${fixture.firstBatch}/items/${fixture.firstItem}`;
    assert.deepEqual(await api.api(resultPath + '/results/query', 'POST', fixture.body), fixture.saved);
    const previous = (await fresh('SELECT version FROM projects WHERE id=?', [fixture.projectId]))[0].version;
    const adoptionsBefore = (await fresh('SELECT COUNT(*) n FROM import_adoptions WHERE target_kind=\'project\' AND target_id=?', [fixture.projectId]))[0].n;
    assert.deepEqual(await api.api({batchId:fixture.firstBatch,itemId:fixture.firstItem}, 'POST', fixture.body), fixture.saved);
    assert.equal((await fresh('SELECT version FROM projects WHERE id=?', [fixture.projectId]))[0].version, previous);
    assert.equal((await fresh('SELECT COUNT(*) n FROM import_adoptions WHERE target_kind=\'project\' AND target_id=?', [fixture.projectId]))[0].n, adoptionsBefore);
    checks.push('新登录查询原采用结果并按原键重放，返回相同结果，无重复版本或采用');
    const pending = await api.api('/api/imports/' + fixture.pendingBatch), item = pending.items.find(row => row.id === fixture.pendingItem);
    assert.equal(item.payload.fields.summary, fixture.correctedSummary); assert.equal(pending.counts.pending, 1);
    const detail = await api.api('/api/projects/' + fixture.projectId); assert.equal(detail.history.length, 2); assert.deepEqual(detail.history.map(row => row.text), ['完整旧历史', '完整旧历史']);
    assert.equal(detail.project.summaryNote, '原简要备注'); assert.equal(detail.project.chipstatNote, '原芯片备注'); assert.equal(detail.nodes[0].title, '来源项目节点');
    const sourceHistory = await api.api('/api/projects/' + fixture.projectId + '/source-history?kind=mixed'); assert(sourceHistory.versions.length);
    await api.api(path(pending, item, 'adopt'), 'POST', command(pending, item));
    assert.equal((await api.api('/api/projects/' + fixture.projectId)).project.summary, fixture.correctedSummary);
    assert.equal((await api.api('/api/imports/' + fixture.pendingBatch)).counts.pending, 0);
    assert.equal((await fresh('SELECT summary FROM projects WHERE id=?', [fixture.projectId]))[0].summary, fixture.correctedSummary);
    const summary = await api.api('/api/project-summary'); assert(summary.items.some(project => project.id === fixture.projectId));
    checks.push('恢复原卡人工修正，来源/子记录对应/完整历史新请求可读；继续采用后正式详情、简要及原卡自然接续');
    const result = { passed: true, verifiedAt: new Date().toISOString(), sourceUuid: before.sourceUuid, restoreUuid: uuid, schema: restored.schema, structure, tableCounts: Object.fromEntries(Object.entries(restored.tables).map(([name, value]) => [name, value.count])), tableFingerprints: restored.tables, allTableContentEqual: true, filesVerified: files.files.length, fileManifestSha256: sha(JSON.stringify(files.files)), fixtureRepair: '初迁移合成fixture原来未落文件，本次按脚本固定UTF8输入{}补齐并对既有bytes=2/SHA核验；未改原数据库', projectId: fixture.projectId, firstBatch: fixture.firstBatch, continuedBatch: fixture.pendingBatch, requests, checks };
    await mkdir('test-results', { recursive: true }); await writeFile('test-results/import-restore.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  }
} finally { if (app) await app.close(); await c.end(); }
