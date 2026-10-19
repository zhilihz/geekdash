import { label, type Project, type Company } from './api';

export type SummaryProject=Omit<Project,'checkStatus'> & {summary:string;detailNote:string;summaryNote:string;chipstatNote:string;statusOwners:string[];pendingNodes:{id:string;title:string;targetDate:string|null}[];canEdit:boolean};
export type SummarySnapshot={items:SummaryProject[];businessDate:string;capturedAt:string;company:Company|null;ownerOptions:string[]};
export const summaryColumns={customer:'客户',group:'分组',name:'项目名称',chips:'核心芯片',status:'项目最新状态',engineers:'负责人',note:'备注',chipNote:'芯片备注',stage:'当前阶段',node:'关键节点',dueDate:'预计结案日期',delay:'是否延期'};
export type SummaryColumn=keyof typeof summaryColumns;
export const defaultColumns=Object.keys(summaryColumns).filter(key=>key!=='chipNote') as SummaryColumn[];
export type SummaryFilters={group:string[];status:string[];owner:string[];chip:string[]};
export type SummarySort='customer'|'group'|'chip'|'stage'|'dueDate';
export function summaryValue(project:SummaryProject,column:SummaryColumn):string {
  switch(column){
    case 'customer':return project.customer || '未指定客户';
    case 'group':return project.projectGroup || '未分组';
    case 'name':return project.name;
    case 'chips':return project.chips.map(chip=>chip.name).join('、');
    case 'status':return project.statusDesc;
    case 'engineers':return project.statusOwners.join('、');
    case 'note':return project.summaryNote;
    case 'chipNote':return project.chipstatNote;
    case 'stage':return project.status==='closed' ? '整体结案' : label(project.stage);
    case 'node':return project.pendingNodes.map(node=>node.title+(node.targetDate?'（'+node.targetDate+'）':'（待确定）')).join('\n');
    case 'dueDate':return project.dueDate ?? '待确定';
    case 'delay':return project.deadline.label;
  }
}
const compare=(a:string|null|undefined,b:string|null|undefined)=>String(a ?? '').localeCompare(String(b ?? ''),'zh-CN',{numeric:true});
export function summaryRows(items:SummaryProject[],filters:SummaryFilters,sort:SummarySort,order:string[]=[],hidden:string[]=[],quickIds?:string[]) {
  const omitted=new Set(hidden),scope=quickIds ? new Set(quickIds) : null,positions=new Map(order.map((id,index)=>[id,index]));
  const result=items.filter(project=>!omitted.has(project.id) && (!scope || scope.has(project.id))
    && (!filters.group.length || filters.group.includes(project.projectGroup || '未分组'))
    && (!filters.status.length || filters.status.includes(project.status))
    && (!filters.owner.length || project.statusOwners.some(name=>filters.owner.includes(name)))
    && (!filters.chip.length || project.chips.some(chip=>filters.chip.includes(chip.id))));
  return result.sort((a,b)=>{
    if(positions.has(a.id) || positions.has(b.id)){const rank=(positions.get(a.id) ?? Number.MAX_SAFE_INTEGER)-(positions.get(b.id) ?? Number.MAX_SAFE_INTEGER);if(rank)return rank;}
    const first=sort==='chip' ? compare(a.chips[0]?.name || '\uffff',b.chips[0]?.name || '\uffff') : sort==='dueDate' ? compare(a.dueDate || '9999-12-31',b.dueDate || '9999-12-31') : sort==='stage' ? compare(a.stage,b.stage) : sort==='group' ? compare(a.projectGroup,b.projectGroup) : compare(a.customer,b.customer);
    return first || (sort==='chip' ? compare(a.dueDate || '9999-12-31',b.dueDate || '9999-12-31') : 0) || compare(a.name,b.name) || compare(a.id,b.id);
  });
}
export function selectedSummary(rows:SummaryProject[],selected:ReadonlySet<string>) {
  const result=rows.filter(row=>selected.has(row.id));
  if(!result.length)throw new Error('请先选择要导出的项目。');
  return structuredClone(result);
}
export function visibleColumns(order:unknown,hidden:unknown):SummaryColumn[]{
  const source=Array.isArray(order)?order.filter((key):key is SummaryColumn=>typeof key==='string' && Object.hasOwn(summaryColumns,key)):Object.keys(summaryColumns) as SummaryColumn[];
  const columns=[...new Set([...source,...Object.keys(summaryColumns) as SummaryColumn[]])];
  const excluded=new Set(Array.isArray(hidden)?hidden:['chipNote']);
  return columns.filter(key=>key==='name' || !excluded.has(key));
}
function csvCell(value:string){
  // 表格软件不得把用户说明当公式执行；内容换行和引号保持在同一单元格。
  const text=value.replace(/\r\n?/g,'\n'),safe=/^[\s]*[=+@-]/u.test(text)?"'"+text:text;
  return '"'+safe.replace(/"/g,'""')+'"';
}
export function summaryCsv(projects:SummaryProject[],columns:SummaryColumn[],chipFormat=false){
  if(!projects.length)throw new Error('请先选择要导出的项目。');
  const headers=chipFormat?['核心芯片','客户','项目名称','量产维护','项目最新状态','备注','当前阶段','关键节点','预计结案日期','是否延期']:columns.map(key=>summaryColumns[key]);
  const rows=projects.map(project=>chipFormat?[summaryValue(project,'chips'),summaryValue(project,'customer'),project.name,project.maintenanceEnabled?'是':'否',project.statusDesc,project.chipstatNote,summaryValue(project,'stage'),summaryValue(project,'node'),summaryValue(project,'dueDate'),summaryValue(project,'delay')]:columns.map(key=>summaryValue(project,key)));
  return '\ufeff'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');
}
export function primaryOwner(project:SummaryProject){
  const manager=project.managers.find(person=>person.enabled);
  if(manager)return {name:manager.name,role:'项目经理'};
  // 旧PM仅作为资料展示来源，不据其授予项目写权限。
  for(const role of ['pm','software_owner','hardware_owner']){const person=project.people.find(person=>person.role===role && person.name);if(person)return {name:person.name,role:label(role)};}
  return {name:'未指定',role:'未指定'};
}
export function presentationStatus(project:SummaryProject){
  if(project.deadline.kind==='overdue')return {label:'已延期',reason:'超过当前预计结案日期',color:'红色',hex:'#DC2626'};
  if(project.status==='closed' && project.maintenanceEnabled)return {label:'量产维护',reason:'已结案且量产维护',color:'紫色',hex:'#9333EA'};
  const colors:Record<string,[string,string]>={ongoing:['绿色','#16A34A'],proposal:['橙色','#F97316'],closed:['蓝色','#2563EB'],paused:['灰色','#6B7280']};
  const [color,hex]=colors[project.status] ?? ['灰色','#6B7280'];return {label:label(project.status),reason:'原始项目状态',color,hex};
}
const markdown=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g,'\\$&').replace(/\r\n?|\n/g,'<br>') || '—';
export function summaryMarkdown(projects:SummaryProject[],columns:SummaryColumn[],title:string,snapshot:Pick<SummarySnapshot,'capturedAt'|'businessDate'|'company'>){
  if(!projects.length)throw new Error('请先选择要导出的项目。');
  const ordered=[...projects].sort((a,b)=>compare(a.customer || '未指定客户',b.customer || '未指定客户') || compare(primaryOwner(a).name,primaryOwner(b).name) || compare(a.name,b.name));
  const lines=[`# ${markdown(title || '项目状态简要')}（${snapshot.businessDate}）`,'',`数据读取时间：${snapshot.capturedAt}`,`范围：已选 ${projects.length} 个项目，仅包含已保存信息。`,snapshot.company?.fullName?'企业：'+markdown(snapshot.company.fullName):'',''];
  let customer='',owner='';
  for(const project of ordered){
    const nextCustomer=project.customer || '未指定客户',responsible=primaryOwner(project);
    if(customer!==nextCustomer){customer=nextCustomer;owner='';lines.push('## '+markdown(customer),'');}
    if(owner!==responsible.name){owner=responsible.name;lines.push('### '+markdown(owner),'');}
    lines.push('#### '+markdown(project.name),'');
    for(const key of columns){
      if(key==='name')continue;
      if(key==='status'){const status=presentationStatus(project);lines.push('- 原始项目状态：'+markdown(label(project.status)),'- 量产维护：'+(project.maintenanceEnabled?'是':'否'),'- 网页展示状态：'+markdown(status.label),'- 网页色彩标识：'+status.color+'（'+status.hex+'）','- 展示状态依据：'+markdown(status.reason));}
      lines.push('- '+summaryColumns[key]+'：'+markdown(summaryValue(project,key)));
    }
    lines.push('');
  }
  return '\ufeff'+lines.join('\r\n');
}
export const pngColumns:SummaryColumn[]=['name','customer','status','engineers','dueDate','delay'];
