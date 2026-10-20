import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { loadConfigFromFile } from 'vite';

// 不访问数据库：核查 HTML 首屏执行时序、慢偏好读取和三主题切换。
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' });
const plugin = config.plugins.find(item => item.name === 'geekdash-initial-theme');
const [tag] = plugin.transformIndexHtml.handler();
assert.equal(tag.tag, 'script'); assert.equal(tag.injectTo, 'head-prepend'); assert.equal(tag.attrs.type, undefined);
assert.equal(tag.children, await readFile('src/web/shared/theme-init.js', 'utf8'));
const pages = config.build.rollupOptions.input; assert.equal(pages.length, 8);
const apiCode = ts.transpileModule(await readFile('src/web/shared/api.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
function browser(saved, blocked = false) {
  const reads = [], writes = [], events = new Map(), buttons = ['dark', 'light', 'warm'].map(theme => ({ dataset: { theme }, classList: { toggle(_name, active) { this.active = active; } } }));
  const document = { documentElement: { dataset: {}, style: {} }, cookie: '', addEventListener(name, fn) { events.set(name, fn); }, querySelectorAll(selector) { return selector === 'button[data-theme]' ? buttons : []; }, querySelector() { return null; } };
  let resolvePreference, preferenceRead = false;
  const preference = new Promise(resolve => { resolvePreference = resolve; });
  const context = vm.createContext({ document, localStorage: { getItem(key) { reads.push(key); if (blocked) throw Error('blocked'); return saved; }, setItem(key, value) { if (blocked) throw Error('blocked'); writes.push([key, value]); } }, BroadcastChannel: class {}, location: { pathname: '/', search: '', origin: 'http://localhost' }, URL, AbortSignal, Event, CustomEvent: class {}, fetch: async () => ({ ok: true, json: async () => ({ account: { id: '1', name: '主题验收', mustChangePassword: false } }) }) });
  vm.runInContext(tag.children, context);
  const module = { exports: {} };
  vm.runInContext('(function(require,exports,module){' + apiCode + '\n})', context)(name => name === './personal-state' ? { PersonalPreference: class { load() { preferenceRead = true; return preference; } update() {} } } : { loginTarget: () => '/login.html' }, module.exports, module);
  return { document, reads, writes, buttons, api: module.exports, resolvePreference, get preferenceRead() { return preferenceRead; } };
}
for (const input of ['dark', 'light', 'warm', null, 'unexpected', '<script>']) {
  const page = browser(input); const expected = ['dark', 'light', 'warm'].includes(input) ? input : 'dark';
  assert.equal(page.document.documentElement.dataset.theme, expected);
  assert.deepEqual(page.reads, ['geekdash_theme'], '首屏只读取颜色枚举，不读取账号或偏好记录');
  page.api.setupTheme(); assert.equal(page.document.documentElement.dataset.theme, expected, '应用初始化不能重置首屏主题');
  assert.equal(page.document.documentElement.style.colorScheme, expected === 'dark' ? 'dark' : 'light');
  assert(page.buttons.find(button => button.dataset.theme === expected).classList.active);
}
const blocked = browser('warm', true); blocked.api.setupTheme(); blocked.api.applyTheme('warm');
assert.equal(blocked.document.documentElement.dataset.theme, 'warm', '禁用存储仍能在本页切换');
const slow = browser('warm'); slow.api.setupTheme(); const identity = slow.api.requireIdentity();
for (let step = 0; !slow.preferenceRead && step < 20; step++) await Promise.resolve();
assert(slow.preferenceRead); assert.equal(slow.document.documentElement.dataset.theme, 'warm', '等待认证和服务器偏好期间保持首屏颜色');
slow.resolvePreference({ schemaVersion: 1, theme: 'light' }); await identity;
assert.equal(slow.document.documentElement.dataset.theme, 'light', '认证后的本人服务器偏好仍生效');
for (const theme of ['warm', 'dark', 'light']) {
  slow.buttons.find(button => button.dataset.theme === theme).onclick();
  const stored = slow.writes.at(-1); assert.deepEqual(stored, ['geekdash_theme', theme]);
  assert.equal(browser(stored[1]).document.documentElement.dataset.theme, theme, '下一页首屏沿用选择');
}
const preferenceCode = ts.transpileModule(await readFile('src/web/shared/personal-state.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
const local = new Map(), cacheKey = 'geekdash_preference:1:appearance', saves = [];
let cloud = { version: '1', value: { schemaVersion: 1, theme: 'dark' } }, rejectSave = false;
class SaveError extends Error { constructor(code) { super(code); this.code = code; } }
function preferences(actor = '1') {
  const events = new Map(), timers = new Map(), messages = [];
  const storage = { getItem: key => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) };
  const api = { account: { id: actor }, SaveError, async get() { return structuredClone(cloud); }, async send(_path, _method, body) {
    saves.push(structuredClone(body));
    assert.equal(Object.hasOwn(body.value, 'pendingTheme') || Object.hasOwn(body.value, 'pendingThemeVersion'), false, '本机待同步标记不能写入服务器偏好');
    if (rejectSave || body.expectedVersion !== cloud.version) throw new SaveError('PREFERENCE_VERSION_CONFLICT');
    cloud = { version: String(Number(cloud.version) + 1), value: structuredClone(body.value) }; return structuredClone(cloud);
  } };
  const context = vm.createContext({ localStorage: storage, sessionStorage: storage, crypto: { randomUUID }, structuredClone, URLSearchParams, document: { addEventListener: (name, fn) => events.set(name, fn) }, setTimeout: fn => { const id = randomUUID(); timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  const module = { exports: {} };
  vm.runInContext('(function(require,exports,module){' + preferenceCode + '\n})', context)(name => name === './api' ? api : {}, module.exports, module);
  return { instance: new module.exports.PersonalPreference('appearance', message => messages.push(message)), events, messages };
}
const first = preferences(); await first.instance.load(); first.instance.update({ theme: 'warm' });
assert.equal(JSON.parse(local.get(cacheKey)).pendingTheme, 'warm', '点击暖色时立即留下本人待同步标记');
assert.equal(JSON.parse(local.get(cacheKey)).pendingThemeVersion, '1', '缓存原始云端版本，不能在下一页换成别人的新版本');
assert.equal(saves.length, 0, '模拟在原有防抖保存前换页');
first.events.get('geekdash-identity-changed')();
const next = preferences(); assert.equal((await next.instance.load()).theme, 'warm', '旧云端深色不能覆盖刚选择的暖色');
await next.instance.flush(); assert.equal(saves.length, 1); assert.equal(cloud.value.theme, 'warm');
assert.equal(Object.hasOwn(JSON.parse(local.get(cacheKey)), 'pendingTheme'), false, '确认保存后清除待同步标记');
local.set(cacheKey, JSON.stringify({ schemaVersion: 1, theme: 'warm', pendingTheme: 'warm' }));
const already = preferences(); await already.instance.load(); await already.instance.flush();
assert.equal(saves.length, 1, '云端已经相同则无需再写'); assert.equal(Object.hasOwn(JSON.parse(local.get(cacheKey)), 'pendingTheme'), false);
already.instance.update({ theme: 'light' }); rejectSave = true; await already.instance.flush(); rejectSave = false;
assert.equal(saves.length, 2); assert.equal(Object.hasOwn(JSON.parse(local.get(cacheKey)), 'pendingTheme'), false, '明确冲突不能保留自动重放标记');
const afterConflict = preferences(); assert.equal((await afterConflict.instance.load()).theme, 'warm'); await afterConflict.instance.flush();
assert.equal(saves.length, 2, '下一页不盲目重放冲突的旧选择');
local.set(cacheKey, JSON.stringify({ schemaVersion: 1, theme: 'light', pendingTheme: 'light' }));
const otherAccount = preferences('2'); assert.equal((await otherAccount.instance.load()).theme, 'warm'); await otherAccount.instance.flush();
assert.equal(saves.length, 2, '其他账号不会接管前一账号待同步的颜色');
local.set(cacheKey, JSON.stringify({ schemaVersion: 1, theme: 'light', pendingTheme: 'light', pendingThemeVersion: '1' }));
const changedElsewhere = preferences(); assert.equal((await changedElsewhere.instance.load()).theme, 'light');
await changedElsewhere.instance.flush(); assert.equal(saves.length, 2, '其他设备已保存新版时，旧选择不能借新版本覆盖');
assert.equal(cloud.value.theme, 'warm'); assert.equal(changedElsewhere.messages.length, 1);
assert.equal(Object.hasOwn(JSON.parse(local.get(cacheKey)), 'pendingTheme'), false);
changedElsewhere.instance.update({ theme: 'light' }); await changedElsewhere.instance.flush();
assert.equal(saves.length, 3); assert.equal(cloud.value.theme, 'light', '明确重新选择后允许按新版本同步');
cloud = { version: '0', value: null };
local.set(cacheKey, JSON.stringify({ schemaVersion: 1, theme: 'warm', pendingTheme: 'warm' }));
const unknownBaseline = preferences(); assert.equal((await unknownBaseline.instance.load()).theme, 'warm');
await unknownBaseline.instance.flush(); assert.equal(saves.length, 3, '缺少原基线不能把初始版本0当作原基线重放');
local.set(cacheKey, JSON.stringify({ schemaVersion: 1, theme: 'warm', pendingTheme: 'warm', pendingThemeVersion: '0' }));
const knownZero = preferences(); await knownZero.instance.load(); await knownZero.instance.flush();
assert.equal(saves.length, 4); assert.equal(cloud.value.theme, 'warm', '已实际读取的原基线0仍可正常同步');
if (process.argv.includes('--built')) for (const page of pages) {
  const html = await readFile('dist/web/' + basename(page), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert(scripts.length && scripts[0][1].includes('data-theme-init'), basename(page) + ' 的第一段脚本必须同步恢复主题');
  assert.equal(scripts.filter(item => item[1].includes('data-theme-init')).length, 1);
  assert(scripts[0].index < html.indexOf('<body') && !/type=|src=|async|defer/.test(scripts[0][1]));
  const actual = { document: { documentElement: { dataset: {}, style: {} } }, localStorage: { getItem: () => 'warm' } };
  vm.runInNewContext(scripts[0][2], actual); assert.equal(actual.document.documentElement.dataset.theme, 'warm');
}
console.log(JSON.stringify({ status: 'passed', themes: 3, pages: pages.map(path => basename(path)), builtHtmlVerified: process.argv.includes('--built'), databaseAccess: false, checks: ['parser_blocking_head_bootstrap', 'theme_only_cache', 'invalid_and_blocked_storage', 'setup_preserves_first_theme', 'slow_server_preference_keeps_theme', 'authenticated_preference_applies', 'selection_reaches_next_page', 'immediate_navigation_syncs_existing_pending_preference', 'confirmed_save_clears_pending', 'same_cloud_value_skips_write', 'conflict_does_not_replay', 'pending_preference_is_account_bound', 'other_device_update_not_overwritten', 'explicit_selection_after_conflict', 'unknown_baseline_not_assumed_zero'] }));
