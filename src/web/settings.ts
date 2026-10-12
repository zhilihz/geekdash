import './shared/detail.css';
import './shared/read.css';
import { get, send, requireIdentity, account, esc, SaveError, setupTheme, setupDateZone, type CheckRuleContext } from './shared/api';

setupTheme(); setupDateZone();
type RuleCommand = { action: 'initializeCheckRule' | 'modifyCheckRule'; deadlineWeekday: number; expectedVersion: string; previewWeek: string; idempotencyKey: string };
let context: CheckRuleContext | undefined, pending: RuleCommand | undefined, busy = false, frozen = false, weekday = 5;
const panel = document.getElementById('settings')!, message = document.getElementById('message')!;
const key = () => 'geekdash_check_rule_operation:' + account!.id;
function persist() {
  try { if (pending) sessionStorage.setItem(key(), JSON.stringify(pending)); else sessionStorage.removeItem(key()); }
  catch { message.textContent = '本标签恢复存储不可用，请保留页面，完成原结果确认。'; }
}
function render() {
  if (!context) return;
  panel.innerHTML = `<h2>周检查截止</h2><p>本周：${esc(context.weekStart)} · 业务今天：${esc(context.businessDate)} · 设置版本：${esc(context.configVersion ?? '配置未建立')}</p>${context.rule ? `<p>已保存：星期${context.rule.deadlineWeekday} · 本周截止日 ${esc(context.deadlineDate)}（全天有效） · 规则版本 ${esc(context.rule.version)}</p>` : '<p>检查规则未初始化；周五仅是尚未保存的建议。</p>'}${context.canMaintain && context.configVersion ? `<form id="rule-form"><label for="weekday">截止星期</label><select id="weekday">${['一', '二', '三', '四', '五', '六', '日'].map((day, index) => `<option value="${index + 1}"${index + 1 === weekday ? ' selected' : ''}>星期${day}</option>`).join('')}</select><p>保存后本周立即生效，以后每周沿用。保存不修改项目版本、首次义务或原检查时间。</p><button class="head-btn" type="submit">保存检查规则</button></form>` : `<p>仅专用维护账号可以修改共同规则。</p>`}${pending ? '<p>原操作结果待确认，请保留原编号及正文。</p><button class="back-btn" id="confirm">确认原设置结果</button><button class="back-btn" id="retry">重试原设置操作</button>' : '<button class="back-btn" id="reload">重新读取规则</button>'}`;
  const select = document.getElementById('weekday') as HTMLSelectElement | null; if (select) select.onchange = () => { weekday = Number(select.value); };
  const form = document.getElementById('rule-form') as HTMLFormElement | null;
  if (form) form.onsubmit = async event => { event.preventDefault(); if (busy || pending || frozen) return; const selected = Number((document.getElementById('weekday') as HTMLSelectElement).value); if (!window.confirm('截止从' + (context!.rule ? '星期' + context!.rule.deadlineWeekday : '未初始化') + '改为星期' + selected + '，本周立即生效，以后每周沿用。是否明确保存？')) return; pending = { action: context!.rule ? 'modifyCheckRule' : 'initializeCheckRule', deadlineWeekday: Number((document.getElementById('weekday') as HTMLSelectElement).value), expectedVersion: context!.configVersion!, previewWeek: context!.weekStart, idempotencyKey: crypto.randomUUID() }; persist(); await save(false); };
  for (const [name, confirm] of [['confirm', true], ['retry', false]] as const) { const button = document.getElementById(name); if (button) button.onclick = () => { void save(confirm); }; }
  const reload = document.getElementById('reload'); if (reload) reload.onclick = () => { void load(); };
  panel.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button,select').forEach(element => { element.disabled = busy || frozen || !!pending && !['confirm', 'retry'].includes(element.id); });
}
async function load() {
  if (busy || pending || frozen) return;
  busy = true; render();
  try { context = await get<CheckRuleContext>('/api/settings/check-rule'); weekday = context.rule?.deadlineWeekday ?? 5; message.textContent = ''; }
  catch (error) { message.textContent = (error as Error).message + ' 当前规则展示保留，点击重新读取恢复。'; }
  finally { busy = false; render(); }
}
async function save(confirm: boolean) {
  if (!pending || busy || frozen) return;
  const body = pending; busy = true; render();
  try {
    const response = await send<{ outcome: string; result?: { operationId: string; savedVersion: string; changed?: boolean } }>(confirm ? '/api/settings/check-rule/results/query' : '/api/settings/check-rule', 'POST', body, !confirm);
    if (response.outcome !== 'committed' || response.result?.operationId !== body.idempotencyKey) { message.textContent = '未查到原回执，结果仍待确认，请重试原设置操作。'; return; }
    pending = undefined; persist(); message.textContent = (response.result.changed === false ? '设置一致，无变化；设置版本' : '公共检查规则已确认保存，设置版本') + response.result.savedVersion + '。';
    try { context = await get<CheckRuleContext>('/api/settings/check-rule'); weekday = context.rule?.deadlineWeekday ?? 5; }
    catch { frozen = true; message.textContent += ' 后续读取失败，重新打开本页查看，不能重复初始化。'; }
  } catch (error) {
    const failure = error instanceof SaveError ? error : new SaveError('TRANSPORT_UNKNOWN', 'unknown');
    if (['AUTH_REQUIRED', 'AUTH_CONTEXT_CHANGED', 'CSRF_INVALID', 'PASSWORD_CHANGE_REQUIRED'].includes(failure.code)) frozen = true;
    if (failure.outcome === 'not_committed' && failure.code !== 'OPERATION_KEY_REUSED') { pending = undefined; persist(); }
    message.textContent = failure.message + ' 原输入：星期' + body.deadlineWeekday + '，进入设置版本' + body.expectedVersion + '。';
  } finally { busy = false; render(); }
}
document.addEventListener('geekdash-identity-changed', () => { frozen = true; message.textContent = '账号已变化，请重新登录原账号后读取和确认。'; render(); });
void requireIdentity().then(async () => {
  try { pending = JSON.parse(sessionStorage.getItem(key()) ?? 'null') ?? undefined; } catch { message.textContent = '恢复信息无法读取，请保留原页面并核对规则。'; }
  context = await get<CheckRuleContext>('/api/settings/check-rule'); weekday = pending?.deadlineWeekday ?? context.rule?.deadlineWeekday ?? 5; render();
  if (pending) await save(true);
}).catch(error => { message.textContent = (error as Error).message; const link = document.createElement('a'); link.href = '/login.html'; link.textContent = '登录 GeekDash'; message.append(' ', link); });
