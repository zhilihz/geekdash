
const p=await figma.getNodeByIdAsync('142:3499');await figma.setCurrentPageAsync(p);
const created=[], changed=new Set();const mark=n=>{changed.add(n.id);return n};const createdTree=n=>{created.push(n.id);if('findAll' in n)created.push(...n.findAll(()=>true).map(c=>c.id));return n};
const frames=['144:3499','146:3642','155:4508'].map(id=>p.children.find(n=>n.id===id));
const fonts=new Map();for(const f of frames)for(const t of f.findAllWithCriteria({types:['TEXT']}))for(const s of t.getStyledTextSegments(['fontName']))fonts.set(JSON.stringify(s.fontName),s.fontName);for(const f of fonts.values())await figma.loadFontAsync(f);
const vars={};for(const id of ['VariableID:2:11','VariableID:2:25','VariableID:2:40','VariableID:2:50','VariableID:2:69','VariableID:2:64','VariableID:41:1566','VariableID:41:1556','VariableID:41:1536'])vars[id]=await figma.variables.getVariableByIdAsync(id);
const paint=(id,opacity=1)=>figma.variables.setBoundVariableForPaint({type:'SOLID',color:{r:0,g:0,b:0},opacity},'color',vars[id]);
const template=await figma.getNodeByIdAsync('144:3564');const badgeComp=await figma.getNodeByIdAsync('2:117');const normal=await figma.getNodeByIdAsync('2:107');
function text(parent,value,name){const n=template.clone();createdTree(n);parent.appendChild(n);n.name=name||value;n.setBoundVariable('characters',null);n.characters=value;n.textAutoResize='HEIGHT';n.resize(Math.max(50,parent.width-24),n.height);n.layoutSizingHorizontal='FILL';return n;}
function group(parent,name,direction='VERTICAL'){const n=createdTree(figma.createAutoLayout(direction));parent.appendChild(n);n.name=name;n.fills=[];n.primaryAxisSizingMode='AUTO';n.counterAxisSizingMode='FIXED';n.itemSpacing=10;n.layoutSizingHorizontal='FILL';return n;}
function badge(parent,value,color,fill){const n=createdTree(badgeComp.createInstance());parent.appendChild(n);n.setProperties({'文字#2:6':value});n.fills=[paint(fill)];n.strokes=[];n.cornerRadius=14;n.paddingLeft=10;n.paddingRight=10;n.paddingTop=5;n.paddingBottom=5;for(const t of n.findAllWithCriteria({types:['TEXT']})){t.fills=[paint(color)];mark(t);}return n;}
function divider(parent){const n=createdTree(figma.createRectangle());parent.appendChild(n);n.name='信息分隔线';n.fills=[paint('VariableID:2:25')];n.resize(parent.width,1);n.layoutSizingHorizontal='FILL';return n;}
for(const [fi,rowId] of [['144:3499','144:3517'],['146:3642','146:3660'],['155:4508','155:4526']]){
const row=await figma.getNodeByIdAsync(rowId);const buttons=row.children.filter(n=>n.type==='INSTANCE');row.name='项目范围与展示方式';row.primaryAxisSizingMode='FIXED';row.counterAxisSizingMode='AUTO';row.counterAxisAlignItems='CENTER';row.itemSpacing=24;mark(row);
const left=group(row,'项目范围');left.itemSpacing=8;text(left,'项目范围');const scope=group(left,'范围选项','HORIZONTAL');scope.counterAxisSizingMode='AUTO';scope.layoutSizingHorizontal='HUG';for(const n of buttons.slice(0,5)){scope.appendChild(n);mark(n);}
const line=createdTree(figma.createRectangle());row.appendChild(line);line.name='两组分隔';line.fills=[paint('VariableID:2:25')];line.resize(1,42);
const right=group(row,'展示方式');right.resize(165,70);right.layoutSizingHorizontal='FIXED';right.itemSpacing=8;text(right,'展示方式');const display=group(right,'展示分段','HORIZONTAL');display.counterAxisSizingMode='AUTO';display.layoutSizingHorizontal='HUG';display.itemSpacing=3;display.paddingTop=3;display.paddingBottom=3;display.paddingLeft=3;display.paddingRight=3;display.fills=[paint('VariableID:2:11')];display.strokes=[paint('VariableID:2:25')];display.cornerRadius=8;
for(const n of buttons.slice(5)){display.appendChild(n);mark(n);}
if(buttons.length===5){for(const [id,value] of [['144:3528','卡片'],['144:3530','驾驶舱']]){const source=await figma.getNodeByIdAsync(id);const n=createdTree(source.clone());display.appendChild(n);}}
}
for(const id of ['168:4436','144:3550']){const n=await figma.getNodeByIdAsync(id);n.setBoundVariable('characters',null);n.characters=id==='168:4436'?'全部项目 18 项 · 今日已检查 15 项 · 今日未检查 3 项':'当前范围 18 个项目     需关注 3';mark(n);}
const board=frames[0];const cards=board.findAllWithCriteria({types:['FRAME']}).filter(n=>n.name==='项目卡片');
for(let i=0;i<cards.length;i++){
 const card=cards[i];const original=[...card.children];mark(card);card.primaryAxisSizingMode='AUTO';card.itemSpacing=14;
 const title=original[0],facts=original[1],oldDate=original[2],progress=original[3],assignment=original[4],statusLabel=original[5],status=original[6],check=original[7];
 const badges=group(card,'灯色、优先级和状态','HORIZONTAL');badges.counterAxisSizingMode='AUTO';badges.layoutSizingHorizontal='HUG';badges.itemSpacing=8;badge(badges,'● 绿灯','VariableID:2:69','VariableID:41:1566');badge(badges,'中优先级','VariableID:2:64','VariableID:41:1556');badge(badges,'进行中','VariableID:2:50','VariableID:41:1536');
 card.insertChild(0,badges);card.insertChild(1,title);
 const brief=text(card,'公寓场景低功耗主控与无线连接方案','项目简介');card.insertChild(2,brief);
 const info=group(card,'基本资料');divider(info);info.appendChild(facts);mark(facts);facts.setBoundVariable('characters',null);facts.characters='客户：演示客户  ·  分组：消费电子\n产品线：智能家居  ·  ODM：演示工厂\nAPP：Home Connect\n芯片：STM32H7、BLE 模组';facts.textAutoResize='HEIGHT';facts.layoutSizingHorizontal='FILL';
 const work=group(card,'项目分工');divider(work);work.appendChild(assignment);mark(assignment);assignment.setBoundVariable('characters',null);assignment.characters='项目经理：张三、李四\n硬件：李四  ·  软件：王五\n参与人员：陈工、周工';assignment.textAutoResize='HEIGHT';assignment.layoutSizingHorizontal='FILL';
 const stage=group(card,'当前阶段与里程碑');stage.fills=[paint('VariableID:2:11')];stage.paddingLeft=12;stage.paddingRight=12;stage.paddingTop=12;stage.paddingBottom=12;stage.cornerRadius=6;text(stage,'EVT 集成验证');stage.appendChild(progress);mark(progress);progress.layoutSizingHorizontal='FILL';text(stage,'完成硬件配套软件全功能实现，整机功能完整可用，顺利完成 EVT 送样，硬件正式封样定型。','原版阶段里程碑');
 oldDate.setBoundVariable('visible',null);oldDate.visible=false;mark(oldDate);
 const latest=group(card,'最新状态说明');latest.appendChild(statusLabel);latest.appendChild(status);mark(statusLabel);mark(status);status.textAutoResize='HEIGHT';status.layoutSizingHorizontal='FILL';
 const btn=createdTree(normal.createInstance());latest.appendChild(btn);btn.name='操作 / 更新状态';btn.setProperties({'文字#2:1':'更新状态'});btn.reactions=[{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:'146:3771',navigation:'NAVIGATE',transition:null,preserveScrollPosition:false}]}];
 const footer=group(card,'检查记录');divider(footer);footer.appendChild(check);mark(check);for(const t of check.findAllWithCriteria({types:['TEXT']})){t.setBoundVariable('characters',null);t.characters=i===1?'○ 尚未检查':i===0?'○ 已 2 天未检查':i===3?'○ 已 1 天未检查':'✓ 今日已检查';mark(t);}
 if(i!==1)text(footer,i===0?'最近检查：张三 · 10-19 09:20':i===3?'最近检查：李四 · 10-20 16:30':'最近检查：张三 · 今天 09:20');
 if(i===0){const e=badge(badges,'● 李四正在编辑','VariableID:2:50','VariableID:41:1536');e.name='当前编辑者';}
 card.reactions=[{trigger:{type:'ON_CLICK'},actions:[{type:'NODE',destinationId:'144:3668',navigation:'NAVIGATE',transition:null,preserveScrollPosition:false}]}];
}
for(const f of frames){const body=f.children.find(n=>n.name==='页面内容');mark(body);f.resize(f.width,body.height);mark(f);}
return {createdNodeIds:created,mutatedNodeIds:[...changed],frames:frames.map(f=>({id:f.id,width:f.width,height:f.height})),scope:'原位同步首页卡片、项目范围与展示方式；保留原筛选交互'};
