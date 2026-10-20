import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createApp } from '../dist/server/app.js';
import { connectDatabase } from '../dist/server/infrastructure/db.js';
import { openRuntimeDatabase } from '../dist/server/infrastructure/runtime-database.js';
import { hashPassword } from '../dist/server/modules/identity.js';

// 执行真实页面源码和身份API；捕获导航目标，不替代原生浏览器导航验收。
const { JSDOM, CookieJar } = await import(process.env.GEEKDASH_DOM_LIBRARY ?? '../test-results/ui-dom-tools/node_modules/jsdom/lib/api.js');
assert.equal(process.env.GEEKDASH_MIGRATION_PROBE, '1');
const { connection: c } = await connectDatabase('test_migrator');
assert.equal((await c.query('SELECT @@server_uuid uuid'))[0][0].uuid, process.env.GEEKDASH_MIGRATION_PROBE_SERVER_UUID);
const prefix = 'auth_return_' + randomUUID().slice(0, 8), password = '身份返回验收 password 2026', newPassword = '身份返回验收 new password 2026';
const users = [], views = [], checks = [], requests = [], errors = [];
let app, origin;
const reject = error => errors.push(error); process.on('unhandledRejection', reject);
async function waitFor(predicate, message) { for (let i = 0; i < 500; i++) { if (errors.length) throw errors[0]; if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error(message); }
function client() {
  const jar = new CookieJar();
  return { jar, async fetch(path, options = {}) {
    const url = new URL(path, origin).href, headers = new Headers(options.headers);
    headers.set('Cookie', jar.getCookieStringSync(url)); headers.set('Origin', 'http://localhost');
    const response = await fetch(url, { ...options, headers });
    for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, url);
    requests.push({ path, method: options.method ?? 'GET', status: response.status }); return response;
  }, async api(path, body) {
    const csrf = jar.getCookiesSync(origin).find(cookie => cookie.key === 'geekdash_dev_csrf')?.value;
    const response = await this.fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-GeekDash-Request': '1', ...(csrf ? { 'X-GeekDash-CSRF': csrf } : {}) }, ...body ? { body: JSON.stringify(body) } : {} });
    const data = await response.json(); assert.equal(response.status, 200, data.code); return data;
  } };
}
function page(user, path, login = false) {
  let url = new URL(path, origin); const navigations = [];
  const dom = new JSDOM(login ? readFileSync('src/web/login.html', 'utf8') : '<div class="head-actions"></div><textarea id="input">尚未保存的业务输入</textarea><a id="login" href="/login.html" hidden>登录</a>', { url: url.href, cookieJar: user.jar });
  views.push(dom); const w = dom.window, location = { replace(target) { navigations.push(target); } };
  for (const key of ['origin', 'pathname', 'search', 'href']) Object.defineProperty(location, key, { get: () => url[key] });
  const context = vm.createContext({ document: w.document, window: w, location, history: { replaceState(_state, _title, target) { url = new URL(target, origin); dom.reconfigure({ url: url.href }); } }, navigator: { locks: { request: async (_name, work) => work() } }, localStorage: w.localStorage, sessionStorage: w.sessionStorage, FormData: w.FormData, HTMLElement: w.HTMLElement, Event: w.Event, CustomEvent: w.CustomEvent, BroadcastChannel: class { postMessage() {} }, URL, URLSearchParams, crypto, AbortSignal, structuredClone, setTimeout, clearTimeout, fetch: user.fetch.bind(user) });
  const modules = new Map();
  function load(path) {
    if (path.endsWith('.css')) return {};
    path = resolve(path.endsWith('.ts') ? path : path + '.ts'); if (modules.has(path)) return modules.get(path).exports;
    const module = { exports: {} }; modules.set(path, module);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInContext('(function(require,exports,module){' + code + '\n})', context, { filename: path })(name => load(resolve(dirname(path), name)), module.exports, module); return module.exports;
  }
  if (login) load('src/web/login.ts');
  return { dom, location, navigations, load, get api() { return load('src/web/shared/api.ts'); }, async submit(id, fields) {
    const form = w.document.getElementById(id); for (const [key, value] of Object.entries(fields)) form.querySelector(`[name="${key}"]`).value = value;
    form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await waitFor(() => !form.querySelector('button').disabled, id + ' 请求未结束');
  } };
}
try {
  const hash = await hashPassword(password);
  for (let i = 0; i < 3; i++) { await c.execute('INSERT INTO users (login_name,password_hash,display_name,must_change_password,created_at,updated_at) VALUES (?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))', [prefix + i, hash, '返回验收' + i, i === 2 ? 1 : 0]); users.push({ id: (await c.query('SELECT CAST(LAST_INSERT_ID() AS CHAR) id'))[0][0].id, loginName: prefix + i }); }
  app = await createApp(await openRuntimeDatabase('test_app'), { origin: 'http://localhost', secure: false }); origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const target = '/project-detail.html?id=51&tab=risk&returnTo=%2Fproject-checks.html%3Fview%3Dactive%26checkToday%3Dunchecked', a = client(), work = page(a, target), helper = work.load('src/web/shared/auth-return.ts');
  for (const invalid of ['https://outside.invalid/', '//outside.invalid/', '/api/auth/logout', '/login.html?returnTo=/', 'javascript:alert(1)', 'data:text/html,test', origin.replace('://', '://other:secret@') + '/']) assert.equal(helper.workTarget(invalid), undefined);
  assert.equal(helper.workTarget('/?view=active&password=secret&token=secret'), '/?view=active');
  assert.equal(helper.workTarget('/project-status-summary.html?quick=sample&ids=51,52'), '/project-status-summary.html?quick=sample&ids=51%2C52');
  assert.equal(helper.workTarget('/project-detail.html?id=51&returnTo=https%3A%2F%2Foutside.invalid%2F'), '/project-detail.html?id=51');
  checks.push('同源业务页及工作参数白名单；外站、认证/API路径、URL凭据及非工作参数不进入返回目标');
  await assert.rejects(work.api.requireIdentity(), error => error.code === 'AUTH_REQUIRED');
  assert.equal(work.navigations.length, 0); assert.equal(work.dom.window.document.getElementById('input').value, '尚未保存的业务输入');
  await a.api('/api/auth/login', { loginName: users[0].loginName, password }); await work.api.requireIdentity();
  await work.api.send('/api/auth/logout', 'POST', {}); await assert.rejects(work.api.get('/api/auth/me'), error => error.code === 'AUTH_REQUIRED');
  const loginHref = work.dom.window.document.getElementById('login').getAttribute('href'); assert.equal(new URL(loginHref, origin).searchParams.get('returnAccount'), users[0].id);
  let recoveryLeaves = 0; work.dom.window.document.addEventListener('geekdash-login-leave', () => recoveryLeaves++);
  work.dom.window.document.addEventListener('click', event => event.preventDefault()); work.dom.window.document.getElementById('login').click(); assert.equal(recoveryLeaves, 1);
  const login = page(a, loginHref, true); await waitFor(() => requests.at(-1)?.path === '/api/auth/me', '登录页读取身份');
  await login.submit('login', { loginName: users[0].loginName, password }); assert.equal(login.navigations.at(-1), helper.workTarget(target));
  const returned = page(a, login.navigations.at(-1)); assert.equal((await returned.api.requireIdentity()).id, users[0].id);
  let normalLeaves = 0; returned.dom.window.document.addEventListener('geekdash-login-leave', () => normalLeaves++);
  returned.dom.window.document.addEventListener('click', event => event.preventDefault()); returned.dom.window.document.querySelector('#account-menu a').click(); assert.equal(normalLeaves, 0);
  checks.push('真实会话失效只显示登录入口、保留输入；同账号页面登录后回原项目/页签/检查来源，新请求确认身份');
  const b = client(), wrong = page(b, loginHref, true); await wrong.submit('login', { loginName: users[1].loginName, password }); assert.equal(wrong.navigations.at(-1), '/');
  const invalid = page(client(), '/login.html?returnTo=https%3A%2F%2Foutside.invalid%2F', true); await invalid.submit('login', { loginName: users[0].loginName, password }); assert.equal(invalid.navigations.at(-1), '/');
  checks.push('不同账号不消费原任务上下文，非法目标登录成功后回首页');
  const first = page(client(), helper.loginTarget('/project-new.html'), true);
  await first.submit('login', { loginName: users[2].loginName, password }); assert.equal(first.navigations.length, 0); assert.equal(first.dom.window.document.getElementById('password').hidden, false); assert.equal(new URLSearchParams(first.location.search).get('returnAccount'), users[2].id);
  await first.submit('password', { currentPassword: password, newPassword, confirmPassword: newPassword }); assert.equal(first.navigations.length, 0);
  await first.submit('login', { loginName: users[2].loginName, password: newPassword }); assert.equal(first.navigations.at(-1), '/project-new.html');
  const changed = (await c.query('SELECT must_change_password,version FROM users WHERE id=?', [users[2].id]))[0][0]; assert.equal(Number(changed.must_change_password), 0); assert.equal(String(changed.version), '2');
  for (const storage of [first.dom.window.localStorage, first.dom.window.sessionStorage]) assert.equal(Object.values(storage).some(value => value.includes(password) || value.includes(newPassword)), false);
  checks.push('首次临时密码认证→实际改密→重新登录保持原新建目标，独立SQL核对改密事实，密码不进入本机草稿');
  const already = page(a, loginHref, true); await waitFor(() => already.navigations.length, '已有有效会话返回原任务'); assert.equal(already.navigations.at(-1), helper.workTarget(target));
  const settings = page(a, loginHref + '&change=1', true); await waitFor(() => !settings.dom.window.document.getElementById('password').hidden, '账号设置页'); assert.equal(settings.navigations.length, 0); assert.equal(settings.dom.window.document.getElementById('back').getAttribute('href'), helper.workTarget(target));
  assert.equal(requests.some(item => item.path.startsWith('/api/projects')), false);
  checks.push('已有有效会话直接回工作；主动打开改密仍留设置并提供原页返回；整条身份恢复不发送任何业务保存');
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/auth-return.json', JSON.stringify({ status: 'passed', checks, requests: requests.length, realBrowserNavigation: false }, null, 2)); console.log(JSON.stringify({ status: 'passed', groups: checks.length, requests: requests.length }));
} finally {
  for (const view of views) view.window.close(); if (app) await app.close();
  const ids = users.map(user => user.id); if (ids.length) { for (const table of ['project_drafts', 'user_preferences', 'sessions']) await c.query(`DELETE FROM ${table} WHERE user_id IN (?)`, [ids]); await c.query('DELETE FROM audit_log WHERE actor_id IN (?)', [ids]); await c.query('DELETE FROM users WHERE id IN (?)', [ids]); }
  await c.end(); process.off('unhandledRejection', reject);
}
