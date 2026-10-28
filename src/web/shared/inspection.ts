import { esc, label, type Detail } from './api';

export function inspectionContent(detail: Detail) {
  const p = detail.project;
  const facts = (items: [string, unknown][]) => `<dl class="check-card-facts">${items.filter(([,value]) => value != null && value !== '').map(([title, value]) => `<div><dt>${title}</dt><dd>${esc(value == null || value === '' ? '—' : value)}</dd></div>`).join('')}</dl>`;
  const people = (role: string) => p.people.filter(person => person.role === role).map(person => person.name).join('、');
  const table = (items: Record<string, unknown>[], fields: [string, string][]) => items.length ? `<div class="read-table-wrap"><table class="read-table"><thead><tr>${fields.map(([,title])=>`<th>${title}</th>`).join('')}</tr></thead><tbody>${items.map(item=>`<tr>${fields.map(([key])=>`<td>${esc(['state','stage','level','decision','code'].includes(key) ? label(item[key]) : item[key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '<p class="read-message">暂无记录</p>';
  const section = (title: string, count: number, content: string, overview = '') => !count ? '' : `<details class="inspection-section" data-inspection="${title}"><summary>${title}（${count}）${overview ? ' · ' + esc(overview) : ''}</summary>${content}</details>`;
  const nodes = (kind: string) => detail.nodes.filter(item => item.kind === kind).map(item => ({ ...item, previous: detail.nodes.find(row => row.id === item.previousNodeId)?.title ?? (item.previousNodeId ? '原关联待核对' : '无'), next: detail.nodes.find(row => row.id === item.nextNodeId)?.title ?? (item.nextNodeId ? '原关联待核对' : '无') }));
  const projectNodes = nodes('project'), customerNodes = nodes('customer');
  return facts([['客户',p.customer],['分组',p.projectGroup],['产品线',p.productLine],['ODM 工厂',p.odmFactory],['APP',p.app],['芯片',p.chips.map(item=>item.name).join('、')]])
    + facts([['立案日期',p.filingDate],['实际启动',p.startDate],['预计结案',p.dueDate],['实际结案',p.closedOn],['简介',p.summary]])
    + facts([['硬件负责人',people('hardware_owner')],['软件负责人',people('software_owner')],['参与人员',people('participant')]])
    + (p.statusDesc ? `<div class="check-latest"><h3>任务清单</h3><p>${esc(p.statusDesc)}</p></div>` : '')
    + section('当前阶段',detail.stages.filter(s=>s.code===p.stage).length,table(detail.stages.filter(s=>s.code===p.stage),[['code','阶段'],['state','状态'],['expectedEndOn','预计完成'],['undatedNodeCount','缺目标日期节点'],['startedOn','实际开始'],['completedOn','实际完成'],['plannedDays','工期'],['note','评述']]),`${label(p.stage)} · ${label(p.stageState)}`)
    + section('项目节点',projectNodes.length,table(projectNodes,[['title','名称'],['stage','阶段'],['targetDate','目标日期'],['completedOn','实际完成'],['output','成果'],['previous','前置节点'],['next','后续节点']]),projectNodes.length ? `${projectNodes.filter(node=>!node.completedOn).length} 项未完成` : '')
    + section('客户节点',customerNodes.length,table(customerNodes,[['title','名称'],['targetDate','目标日期'],['completedOn','实际完成'],['note','备注']]),customerNodes.length ? `${customerNodes.filter(node=>!node.completedOn).length} 项未完成` : '')
    + section('风险',detail.risks.length,table(detail.risks.map(item=>({...item,status:item.resolved ? '已解除' : '预警中'})),[['content','风险'],['level','等级'],['status','状态'],['resolution','解除说明']]),detail.risks.length ? `${detail.risks.filter(item=>!item.resolved).length} 项预警中` : '')
    + section('需求变更',detail.changes.length,table(detail.changes,[['source','来源'],['content','需求'],['decision','决定'],['reason','理由']]),detail.changes.length ? `${detail.changes.filter(item=>item.decision==='accept').length} 项已接受，${detail.changes.filter(item=>item.decision==='reject').length} 项已拒绝` : '')
    + section('其他说明与日期', [p.proposalDate,p.originalDueDate,p.marketExpectation,p.detailNote,p.signalNote].filter(Boolean).length,
      facts([['提案日期',p.proposalDate],['原计划结案',p.originalDueDate],['市场预期',p.marketExpectation],['详细说明',p.detailNote],['灯色说明',p.signalNote]]));
}
