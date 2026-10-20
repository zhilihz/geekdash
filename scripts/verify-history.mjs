import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const context = vm.createContext({ document: { addEventListener() {} }, BroadcastChannel: class {}, Intl });
async function module(path, dependencies) {
  const code = ts.transpileModule(await readFile(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} };
  vm.runInContext('(function(require,exports,module){' + code + '\n})', context)(name => dependencies[name] ?? {}, loaded.exports, loaded);
  return loaded.exports;
}
const api = await module('src/web/shared/api.ts', {});
const { auditHistory, statusDescriptionHistory } = await module('src/web/shared/history.ts', { './api': api });
const at = '2026-10-20T04:05:06.000Z';
const audit = (id, action, beforeValues, afterValues, extra = {}) => ({ id, action, beforeValues, afterValues, actorDisplayName: '李工', actorKind: 'user', versionBefore: '1', versionAfter: '2', createdAt: at, ...extra });
let passed = 0;
function check(name, fn) { fn(); passed++; }
check('默认时间线且对比表折叠', () => {
  const html = auditHistory([audit('1', 'project.ordinary.save', { name: '旧名称', priority: 'high' }, { name: '新名称', priority: 'high' })]);
  assert.match(html, /audit-timeline-entry/); assert.match(html, /<time[^>]*>.*<\/time> · 李工/);
  assert.match(html, /项目名称：新名称/); assert(!html.includes('优先级'));
  assert.match(html, /<details class="audit-comparison"><summary>查看修改前后<\/summary>/);
  assert(!/<details[^>]*\bopen\b/.test(html));
  assert(html.indexOf('<table') > html.indexOf('<details')); assert.match(html, /旧名称/);
});
check('同一需求变更只形成一组含业务决定理由', () => {
  const original = { id: '41', content: '更换外壳', source: 'customer', decision: 'reject', reason: '交期不足' };
  const middle = { ...original, decision: 'accept', reason: '确认产能' }, latest = { ...middle, source: 'business' };
  const html = auditHistory([audit('3', 'project.change.correct', { change: middle }, { change: latest }), audit('2', 'project.change.correct', { change: original }, { change: middle })]);
  assert.equal((html.match(/class="audit-change"/g) ?? []).length, 1);
  assert.equal((html.match(/<tr><th scope="row">/g) ?? []).length, 1);
  assert.match(html, /决定理由：确认产能/); assert.match(html, /决定：接受/);
});
check('完全相同与单纯协议版本变化不显示', () => {
  assert.equal(auditHistory([audit('4', 'project.ordinary.save', { name: '一样', note: '' }, { name: '一样', note: null, reason: '不应制造修改' })]), '');
  assert.equal(auditHistory([audit('5', 'project.check.correct', { check: { observedVersion: '1', resultVersion: '2' } }, { check: { observedVersion: '2', resultVersion: '3' } })]), '');
});
check('检查事实仅显示谁何时检查', () => {
  const html = auditHistory([audit('6', 'project.check.save', null, { check: { id: '9', conclusion: 'checked', note: '', observedVersion: '2', resultVersion: '3', ruleVersion: null } })]);
  assert.match(html, /检查项目/); assert.match(html, /李工/);
  assert(!html.includes('table') && !html.includes('observedVersion') && !html.includes('检查结论'));
});
check('正文与操作者必须转义', () => {
  const html = auditHistory([audit('7', 'project.ordinary.save', { statusDesc: '旧' }, { statusDesc: '<script>alert(1)</script>' }, { actorDisplayName: '<img onerror=1>' })]);
  assert(!html.includes('<script>') && !html.includes('<img')); assert.match(html, /&lt;script&gt;/);
});
check('状态说明只读快照并注明已读取范围', () => {
  const html = statusDescriptionHistory([
    audit('11', 'project.ordinary.save', { statusDesc: '<b>正文</b>' }, { statusDesc: '' }),
    audit('10', 'project.ordinary.save', { statusDesc: '旧' }, { statusDesc: '<b>正文</b>' }),
    audit('9', 'project.ordinary.save', { name: '旧名' }, { name: '新名' }),
    audit('8', 'project.ordinary.save', { statusDesc: '一样' }, { statusDesc: '一样' }),
  ]);
  assert.match(html, /仅显示已读取记录/); assert.equal((html.match(/audit-timeline-entry/g) ?? []).length, 2);
  assert.match(html, /已清空状态说明/); assert.match(html, /&lt;b&gt;正文&lt;\/b&gt;/);
  assert(!html.includes('新名') && !html.includes('一样') && !html.includes('<table'));
  assert.match(statusDescriptionHistory([audit('12', 'project.create', null, { statusDesc: '' })]), /暂无状态说明变更/);
});
check('仅填写计划说明的有效记录不能隐藏或重复', () => {
  const html = auditHistory([audit('13', 'project.plan.notePlan', {}, { scheduleRecord: { id: '8', kind: 'note', oldDate: null, newDate: null, reason: '等待客户确定交期', measures: '' }, reason: '等待客户确定交期' })]);
  assert.match(html, /计划说明：等待客户确定交期/);
  assert.equal((html.split('<details')[0].match(/等待客户确定交期/g) ?? []).length, 1, '外层相同原因不重复展示');
});
check('纠正计划说明保留真实原新值', () => {
  const before = { id: '8', kind: 'note', oldDate: null, newDate: null, reason: '等待客户确定交期', measures: '' };
  const html = auditHistory([audit('14', 'project.plan.correctScheduleRecord', { scheduleRecord: before }, { scheduleRecord: { ...before, reason: '客户确认交期为周五' }, correctionReason: '' })]);
  assert.match(html, /计划说明：等待客户确定交期/); assert.match(html, /计划说明：客户确认交期为周五/);
  assert(!html.split('<details')[0].includes('等待客户确定交期'));
});
console.log(JSON.stringify({ status: 'passed', cases: passed, databaseAccess: false, checks: ['timeline_default', 'comparison_collapsed', 'same_record_grouped', 'no_change_hidden', 'check_fact_only', 'html_escaped', 'raw_status_snapshots', 'loaded_range_explicit', 'plan_reason_only_preserved', 'corrected_plan_reason_before_after'] }));
