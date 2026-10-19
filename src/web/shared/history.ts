import { esc, label, actionLabels, dateTitles, closureTitles, type AuditPage } from './api';

const names: Record<string, string> = { ...dateTitles, ...closureTitles, name: '项目名称', summary: '项目简介', marketExpectation: '市场预期', detailNote: '详细说明', summaryNote: '状态简要备注', chipstatNote: '芯片备注', statusDesc: '最新状态说明', signal: '信号灯', signalNote: '灯色说明', priority: '优先级', customerId: '客户', odmCustomerId: 'ODM 工厂', productLineId: '产品线', appId: 'APP', groupId: '分组', chipIds: '芯片', tagIds: '标签', people: '项目分工', managers: '项目经理', status: '项目状态', progress: '进度', startedOn: '实际开始日期', completedOn: '实际完成日期', plannedDays: '计划工期', note: '说明', state: '阶段状态', completionNote: '完成说明', content: '内容', level: '等级', resolved: '风险状态', resolution: '解除说明', source: '来源', decision: '决定', title: '节点名称', stage: '所属阶段', targetDate: '目标完成日期', output: '成果', previousNodeId: '前置节点', nextNodeId: '后续节点', x: '横向位置', y: '纵向位置', deletedAt: '记录状态', enabled: '是否启用', maintenanceEnabled: '结案后维护', oldDate: '调整前日期', newDate: '调整后日期', measures: '应对措施', conclusion: '检查结论', responsible: '本人负责资格' };
const metadata = new Set(['id','createdBy','actorId','actorName','createdByName','createdAt','updatedAt','sourceKey','sourceImportItemId','sortOrder','resolvedAt','resolvedByName','operations','closureSource','firstCheckWeek','firstCheckRuleVersion','resumeStatus','preCloseStatus','responsibleUserId','ruleVersion','observedVersion','resultVersion','weekStart','checkedAt','kind','code']);
type Facts = Record<string, unknown>;
export function historyTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(date);
}
const object = (v: unknown): v is Facts => !!v && typeof v === 'object' && !Array.isArray(v);
function show(key: string, value: unknown): string {
  if (value === undefined) return '—';
  if (key === 'conclusion' && value === 'checked') return '已核对';
  if (key === 'conclusion' && value === 'follow_up') return '需跟进';
  if (key === 'deletedAt') return value ? '已删除' : '有效';
  if (key === 'resolved') return Number(value) ? '已解除' : '预警中';
  if (key === 'responsible') return value ? '已负责' : '未负责';
  if (key === 'maintenanceEnabled' || key === 'enabled') return Number(value) ? '开启' : '关闭';
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.map(item => object(item) ? `${item.name ?? item.id ?? ''}${item.role ? '（' + label(item.role) + '）' : ''}` : String(item)).join('、') || '—';
  if (object(value)) return String(value.name ?? value.id ?? '—');
  return ['status','priority','signal','state','stage','level','decision','closureType','conclusion'].includes(key) ? label(value) : String(value);
}
const catalogNames: Record<string,string> = {name:'资料名称',contact:'联系方式',background:'客户背景',role:'业务角色',appVersion:'APP版本',description:'描述',originalModel:'原始型号',manufacturer:'厂商',firmwareVersion:'资料固件版本',fullName:'企业全称',shortName:'企业简称',managerText:'负责人信息',namePrefix:'名称前缀'};
const catalogKinds: Record<string,string> = {customers:'客户',engineers:'工程师',productLines:'产品线',apps:'APP',tags:'标签',groups:'分组',chips:'芯片',company:'企业信息'};
function changes(before: Facts, after: Facts, catalog = false): { before: string[]; after: string[] } {
  const left: string[] = [], right: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (metadata.has(key) || ['reason','correctionReason','remaining','stageFacts','catalogName'].includes(key)) continue;
    const a = before[key], b = after[key];
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (a == null || a === '') && (b == null || b === '')) continue;
    if (key === 'stageChanges' || key === 'stagePlans') {
      const old = (Array.isArray(a) ? a : []) as Facts[], next = (Array.isArray(b) ? b : []) as Facts[];
      for (const row of next) { const diff = changes(old.find(item => item.code === row.code) ?? {}, row); if (diff.after.length) { left.push(label(row.code) + '\n' + diff.before.join('\n')); right.push(label(row.code) + '\n' + diff.after.join('\n')); } }
    } else if (object(a) && !('name' in a) || object(b) && !('name' in b)) {
      const diff = changes(object(a) ? a : {}, object(b) ? b : {}); left.push(...diff.before); right.push(...diff.after);
    } else { const title=(catalog ? catalogNames[key] : undefined) ?? names[key] ?? key;left.push(`${title}：${show(key, a)}`); right.push(`${title}：${show(key, b)}`); }
  }
  return { before: left, after: right };
}
export function auditHistory(items: AuditPage['items']) {
  const groups = new Map<string, AuditPage['items']>();
  for (const item of items) { const key = JSON.stringify([item.versionBefore,item.versionAfter,item.actorDisplayName,item.createdAt]); groups.set(key,[...groups.get(key) ?? [],item]); }
  return [...groups.values()].map(group => {
    const entries = new Map<string, { title: string; before: Facts; after: Facts; reasons: string[]; catalog:boolean }>();
    for (const item of [...group].reverse()) {
      const before = item.beforeValues ?? {}, after = item.afterValues ?? {};
      const kind = ['risk','change','node','check'].find(key => object(after[key]) || object(before[key]));
      const record = kind ? (after[kind] ?? before[kind]) as Facts : undefined;
      const key = kind ? kind + ':' + (record?.id ?? item.id) : item.action;
      const prior = entries.get(key);
      const cause = after.correctionReason ?? after.reason;
      const catalog=item.action.startsWith('catalog.');
      const recordTitle=kind==='node' ? `${record?.kind==='customer'?'客户节点':'项目节点'}：${record?.title ?? '#'+record?.id}` : kind==='risk' ? `风险：${record?.content ?? '#'+record?.id}` : kind==='change' ? `需求变更：${record?.content ?? '#'+record?.id}` : kind==='check' ? '项目检查' : undefined;
      entries.set(key, { title:catalog ? `${catalogKinds[item.action.split('.')[1]] ?? '共享资料'}：${after.catalogName ?? before.catalogName ?? ''}` : recordTitle ?? actionLabels[item.action] ?? '项目信息', catalog,before: prior?.before ?? before, after: prior ? { ...prior.after, ...after } : after, reasons: [...prior?.reasons ?? [], ...typeof cause === 'string' && cause ? [cause] : []] });
    }
    const rows = [...entries.values()].map(entry => {
      const diff = changes(entry.before, entry.after,entry.catalog);
      if (!diff.after.length && !entry.reasons.length) return '';
      return `<tr><th scope="row">${esc(entry.title)}</th><td>${esc(Object.keys(entry.before).length ? diff.before.join('\n') || '—' : '无记录')}</td><td>${esc(diff.after.join('\n') || '说明已更新')}${entry.reasons.length ? `<p class="history-reason">原因：${esc([...new Set(entry.reasons)].join('；'))}</p>` : ''}</td></tr>`;
    }).join('');
    if (!rows) return '';
    const first = group[0], time = historyTime(first.createdAt);
    return `<article class="audit-entry" data-audit-version="${esc(first.versionAfter)}"><h3>${esc(first.actorDisplayName)} · ${esc(time)}</h3><div class="read-table-wrap"><table class="read-table comparison-table"><thead><tr><th>修改事项</th><th>修改前</th><th>修改后</th></tr></thead><tbody>${rows}</tbody></table></div></article>`;
  }).join('');
}
