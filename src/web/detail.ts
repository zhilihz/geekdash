import './shared/detail.css';
import './shared/read.css';
import { get, esc, label, projectTags, setupTheme, type Detail, type Entry } from './shared/api';

const element = (id: string) => document.getElementById(id)!;
const id = new URLSearchParams(location.search).get('id') ?? '';
let snapshot: Detail | undefined;
let tab = 'info';
let generation = 0;
setupTheme();
try {
  const saved = JSON.parse(sessionStorage.getItem('geekdash_board_return') ?? 'null');
  if (typeof saved?.url === 'string') {
    const url = new URL(saved.url);
    if (url.origin === location.origin && ['/', '/GeekDash.html'].includes(url.pathname)) (element('back') as HTMLAnchorElement).href = url.href;
  }
} catch { /* 无返回上下文时使用普通列表入口。 */ }
function table(items: Entry[], fields: [string, string][]) {
  if (!items.length) return '<p class="read-message">暂无记录。</p>';
  return `<div class="read-table-wrap"><table class="read-table"><thead><tr>${fields.map(([, title]) => `<th scope="col">${title}</th>`).join('')}</tr></thead><tbody>${items.map(item => `<tr>${fields.map(([key]) => `<td>${esc(['code', 'state', 'stage', 'level', 'decision'].includes(key) ? label(item[key]) : item[key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function render() {
  if (!snapshot) return;
  const p = snapshot.project;
  element('d-title').textContent = p.name;
  element('d-tags').innerHTML = projectTags(p);
  element('d-meta').textContent = `客户：${p.customer ?? '—'} · 产品线：${p.productLine ?? '—'} · 核心芯片：${p.chips.map(chip => chip.name).join(' / ') || '—'} · 项目版本：${p.version}`;
  let content = '';
  if (tab === 'info') {
    const values: [string, unknown][] = [['项目名称', p.name], ['客户', p.customer], ['产品线', p.productLine], ['ODM 工厂', p.odmFactory], ['APP', p.app], ['分组', p.projectGroup], ['项目标签', p.tags.map(tag => tag.name).join(' / ')], ['项目状态', label(p.status)], ['优先级', label(p.priority)], ['信号灯', label(p.signal)], ['灯色说明', p.signalNote], ['提案日期', p.proposalDate], ['立案日期', p.filingDate], ['启动日期', p.startDate], ['原计划结案日期', p.originalDueDate], ['当前计划结案日期', p.dueDate], ['结案日期', p.closedOn], ['结案类型', p.closureType ? label(p.closureType) : '—'], ['市场预期', p.marketExpectation], ['最新状态', p.statusDesc], ['项目备注', p.detailNote], ['汇总备注', p.summaryNote], ['芯片统计备注', p.chipstatNote], ['结案说明', p.closureNote], ['剩余工作', p.remainingWorkNote], ['阶段进度', `${p.progress}%`]];
    values.push(['更新时间（UTC）', p.updatedAt]);
    for (const role of ['hardware_owner', 'software_owner', 'pm', 'participant']) values.push([label(role), p.people.filter(person => person.role === role).map(person => person.name).join(' / ')]);
    content = `<div class="field-grid">${values.map(([title, value]) => `<div class="field"><span class="read-label">${title}</span><div class="read-value">${esc(value === '' || value == null ? '—' : value)}</div></div>`).join('')}</div>`;
  } else if (tab === 'stages') content = table(snapshot.stages, [['code', '阶段'], ['state', '状态'], ['plannedDays', '计划天数'], ['startedOn', '实际开始'], ['completedOn', '实际完成'], ['expectedEndOn', '预期完成'], ['note', '说明']]);
  else if (tab === 'nodes' || tab === 'custnodes') content = table(snapshot.nodes.filter(node => node.kind === (tab === 'nodes' ? 'project' : 'customer')), [['title', '节点'], ['stage', '阶段'], ['targetDate', '目标日期'], ['completedOn', '完成日期'], ['output', '成果'], ['note', '说明']]);
  else if (tab === 'history') content = '<p class="read-message">以下为项目已有来源历史。服务器新增修改历史将在保存功能接入时联验。</p>' + table(snapshot.history.slice().reverse(), [['date', '来源时间'], ['text', '更新内容']]);
  else if (tab === 'risk') content = '<h2>风险</h2>' + table(snapshot.risks.map(risk => ({ ...risk, resolved: risk.resolved ? '已解决' : '未解决' })), [['content', '风险内容'], ['level', '级别'], ['resolved', '状态'], ['resolution', '解决说明']]) + '<h2>需求变更</h2>' + table(snapshot.changes, [['source', '来源'], ['content', '内容'], ['decision', '结论'], ['reason', '原因']]) + '<h2>改期与说明</h2>' + table(snapshot.delays, [['oldDate', '原日期'], ['newDate', '新日期'], ['reason', '原因'], ['measures', '措施']]);
  element('detail-body').innerHTML = content;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
}
async function load() {
  const current = ++generation;
  element('message').classList.remove('error');
  element('message').textContent = '正在读取项目…';
  if (!/^[1-9][0-9]{0,19}$/.test(id)) { element('message').textContent = '项目编号无效，请从列表选择项目。'; return; }
  try {
    const data = await get<Detail>('/api/projects/' + id);
    if (current !== generation) return;
    snapshot = data;
    element('detail-panel').hidden = false;
    render();
    element('message').textContent = '';
  } catch (error) {
    if (current !== generation) return;
    element('message').classList.add('error');
    element('message').textContent = (error as Error).message + (snapshot ? ' 当前仍显示上次进入的项目版本。' : '');
  }
}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.onclick = () => { tab = button.dataset.tab!; render(); });
element('reload').onclick = () => { void load(); };
void load();
