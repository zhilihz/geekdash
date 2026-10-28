# 项目只读 API

2026-10-26 P05候选（0009，未部署）：列表、检查统计、筛选候选、驾驶舱、简要、详情、历史及项目通知均按当前启用业务账号的正式成员关系读取；无关项目只通过基础项目空间投影查看。维护账号无业务读取特权，详情无资格403。下述历史“全部正式项目”现指本人有权范围，不再指全库；空间及请求协议见[项目归属](project-membership.md)。

日期：2026-10-20核对检查事实投影；来源src/server/modules/projects.ts、project-checks.ts及routes/projects.ts。当前业务查询要求可信登录，身份协议归[项目主干](project-core.md)；以下是读取协议，部署状态归系统真相，不能由本文推导。业务语义引用SPEC-002/004/005/014/018。

2026-10-16 P04-02本地候选补充（基线f07450e+未提交改动，结构0004，未部署）：dashboard=1的items另含独立summary，既有summaryNote保留；详情project同样新增summary。stages.expectedEndOn由有效项目节点的最晚target_date投影，nodeCount及undatedNodeCount分别为有效项目节点总数及无目标日数量；无可用日期返回null，不回退旧独立阶段计划。risks及结案剩余风险排除deleted_at非空行。验证与旧值保留范围见[P04-02报告](../../testing/reports/2026-10-16-p04-02-compatibility.md)；前端消费仍待后续步骤。

## 统一状态简要读取（2026-10-17本地候选）

`GET /api/project-summary`，需要可信登录，不接受查询参数。返回`items`、`businessDate`、`capturedAt`、`company`、`ownerOptions`；同次一致读取全部正式项目，无500条硬限制。筛选、行列整理和选择由统一页面维护，含义引用SPEC-020，不另设芯片视图。

- `items`复用项目查询投影与关联，额外提供`summary`、`detailNote`、`summaryNote`、`chipstatNote`，分别保存独立含义。
- `statusOwners`由已保存状态说明提取并去重；`ownerOptions`合并基础工程师姓名和当前说明中姓名。两者不授予权限。
- `pendingNodes`只含有效未完成项目节点的`id/title/targetDate`，排除客户节点。
- `canEdit`按当前账号与项目负责关系读取；备注写入继续用项目范围保存协议，scope分别为`summaryNote`/`chipstatNote`，不新增自动正式写入。
- `company`可能为空；正式输出使用本次`capturedAt`对应快照，不拼接生成期间后来数据。真实运行及格式验证范围见P04阶段内报告。

## 1. 看板列表

2026-10-17本地P04候选新增`company`，包含企业全称、简称、负责人资料文字、名称前缀及资料版本；与项目列表同次快照读取。首页标题消费名称前缀/简称，负责人资料文字不用于账号授权。

`dashboard=1`另返回`quickRanges`，键与`stats`相同，每项为当前看板及全部筛选命中该统计条件的项目ID字符串数组。与统计在同一数据库读取快照，范围不限于当前分页；不包含项目正文或未保存输入。前端将选中统计范围保存在账号隔离的标签页上下文，再进入统一摘要；缺少该上下文时提示重新选择，不能回退为全部项目。语义归SPEC-020。

2026-10-20卡片补充（对应产品`cc0bc73`）：`dashboard=1`另返回`globalChecks: { total, todayChecked, todayUnchecked }`，均为数字，在同次快照中统计全部项目，不使用view、search、筛选或分页条件。首页独立“项目检查”消费这一组；它不替换`stats`和`quickRanges`的当前筛选口径。准确语义归SPEC-005/018。

列表项目补`filingDate/startDate`，与既有`dueDate/closedOn`均为日期字符串或null；与详情使用同一字段投影。另有`riskSummary: { unresolvedCount, highestLevel }`，只计未删除且未解除风险，最高等级为`high/mid/low`，没有风险为`0/null`。当前阶段的静态里程碑仍复用前端既有阶段定义，不新增API字段或业务输入。

`GET /api/projects`

| 参数 | 类型与范围 |
|---|---|
| view | active/proposal/closed/maintenance/all；默认 active |
| search | 最多 255 字符；名称、客户、产品线、ODM、APP、芯片、软硬件负责人及项目经理、市场预期和状态描述的包含匹配；%/_/! 按文字处理 |
| customer/productLine/odmFactory/app/group/chip/tags/owner | 最多 255 字符；名称完全匹配，owner 对应业务人员资料而非账号授权 |
| status | proposal/ongoing/paused/closed |
| priority | high/mid/low |
| signal | green/yellow/red |
| deadline | upcoming/due/overdue/unset/closed_on_time/closed_late/closed_unplanned/closed_unknown/terminated |
| checkToday | 可选unchecked/checked；按服务器上海业务日是否存在检查事实筛选，先筛选再统计和分页 |
| stage | S1～S7/completed/unconfigured |
| progress | 字符串 0/5/10/20/60/80/90/100 |
| dashboard | 可选字符串1；请求看板完整筛选投影和卡片简介，普通模式保持原字段 |
| details | 可选字符串checks；给当前页项目附加检查所需的详情快照inspection |
| page/pageSize | 整数；page 1～1000000，pageSize 1～100，默认 1/24 |

非法枚举、超长输入、未知参数返回 400。稳定按项目 ID 降序，超出最后一页时返回实际最后一页；没有结果仍为第 1/1 页。

返回 `items`（当前页项目摘要及批量关联芯片/人员/标签）、`pagination`、`stats`、`options`、`stageCounts`、`readOnly=true`。项目 ID/version 及关联 ID 均为字符串，避免 bigint 精度丢失；progress 可为 SQL 返回的数字字符串。空引用为 null，空关联为数组。

dashboard=1在同一只读快照附加items.summaryNote、dashboard.distributions、focusTotal、focus、latest及managers。2026-10-28接续修正：focus只含当前完整筛选范围的非结案项目，按优先级/进度排序，不截取12条；latest为说明/任务历史事件，每项{projectId,name,date,text,kind:'online'|'source'}，最多20条，时间及来源语义引用SPEC-022；managers为当前可见范围每账号负责项目去重计数{id,name,count}，已替代旧team业务岗位统计。统计失败整次读取失败，不返回假零值；分页变化不改变汇总范围。

列表items包含checkedToday:boolean和capabilities.canCheck:boolean。前者根据checked_at位于上海当天00:00至次日00:00的UTC半开区间判断；同一天多条只算一个已检查项目。后者来自当前可信账号的project_responsibilities关系，不由业务人员姓名推断；写入仍会重新校验。详情的project同样返回checkedToday，检查操作权限沿详情readOnly与capabilities读取。

stats包含todayChecked/todayUnchecked，均为包含checkToday在内的当前过滤集合计数，二者相加等于total；在unchecked查询里todayChecked自然为0，不得当作另一个已检查标签的总数。首页独立检查模块使用上方`globalChecks`，进入时固定`view=all&checkToday=unchecked`；检查页以实际查询分页总数展示。今日未查是事实标记，不表示每日强制任务；周义务、截止、按时和逾期检查判定已退出。

`details=checks`时，当前页每项的`inspection`复用同一数据库快照中的详情读取，包括基本资料、分工、阶段、有效节点、风险、需求变更和说明。为避免批量列表加载整段历史，`inspection.history`与`inspection.lifecycleNotes`为空；需要历史时进入详情并使用相应分页入口。它不另取较新项目版本，也不创建检查。

`stats/stageCounts`跟随完整筛选范围，options按view提供可选范围。列表与统计/选项处于同一短读事务，businessDate来自同次服务器Asia/Shanghai时钟。stats含九个deadline类别计数，当前范围合计等于total；项目deadline含kind/asOfDate/days/label。未定或未知days=null，不能解释为0；不返回manualDelayed。空查询返回200和空数组/零计数；不可用不能伪装成空查询。

## 2. 固定详情

`GET /api/projects/{id}`

id 为正十进制 bigint 字符串，不超过 unsigned bigint；格式/越界返回 400，项目不存在返回 404/PROJECT_NOT_FOUND。

返回project/stages/nodes/risks/changes/delays/planSummary/history/responsible/readOnly/capabilities及动作提示、businessDate；不再返回checkRule。history仅旧来源记录，服务器完整审计按[保存API](project-save.md)独立分页。responsible是账号负责关系，与业务人员资料不同；当前身份与负责范围决定编辑能力，所有账号可读全部项目。

delays包含kind、有效oldDate/newDate/reason/measures/voided、原actorId/createdAt、original原值和corrections更正来源；读取全部关联更正，不受审计第一页20条限制。planSummary包含reschedules、laterAdjustments、unknownAdjustments及相对原始计划有符号netDays；缺日期netDays=null。note、撤销或同值记录不计真实改期，未知改期单列；不据历史数量判断当前超期。具体变更协议见[项目动作](project-actions.md)。

同一连接以 REPEATABLE READ + WITH CONSISTENT SNAPSHOT、READ ONLY 组装项目和子集合；请求结束提交并释放，不随浏览器停留持锁。日期为 YYYY-MM-DD；时间为 UTC ISO 字符串。页面重新进入前保持本次取得的数据与版本。

## 3. 可用性与边界

正常返回 no-store；项目查询过程失败返回 503/PROJECT_READ_UNAVAILABLE，不泄露 SQL、账号或凭据。全局数据库未就绪时沿工程健康协议返回 503/reason；无运行数据库的构建探测实例返回 503/DATABASE_UNAVAILABLE。

GET不创建账号、责任、检查、业务历史或草稿，不触发阶段/灯色变化。写入协议分别归项目主干/普通保存/项目动作；服务器个人状态与SSE仍后续。页面同版本聚焦/跨日只刷新派生日期提示，不覆盖未保存输入；不同版本冻结原编辑，需重新进入。

验证方法归 TEST-036，执行结果归 [报告](../../testing/reports/2026-10-08-project-reads.md)。

## 检查事实查询及暂缓说明

project包含resumeStatus（暂缓前proposal/ongoing或null）、firstCheckWeek与checkStatus；详情另保留firstCheckRuleVersion及lifecycleNotes。firstCheckWeek/firstCheckRuleVersion仅为旧来源值，可为null，不作为新启动、检查或统计的前置。lifecycleNotes为原暂缓/恢复审计ID、action、originalNote/有效note、原人/UTC时间/版本及corrections（更正ID/人/时间/原因），不改写原历史。

checkStatus只包含kind/label/updatedAfterCheck/latest。kind为unchecked或checked，label为今日未检查或今日已检查，与checkedToday一致。updatedAfterCheck比较当前项目版本和最近检查resultVersion，不再限定自然周；没有检查时为false。latest为按原检查ID选取的最近记录，包含id/actorId/actorName/checkedAt/conclusion/note/observedVersion/resultVersion，没有则null；conclusion/note采用有效更正。时间为UTC，今日按服务器Asia/Shanghai；结论原值checked/follow_up。

stats保留checkUpdated，表示当前完整筛选范围中最近检查后有版本更新的项目数，可与todayChecked或todayUnchecked重叠；不再返回checkRequired/checkPending/checkOverdue/checkDone。列表批量读取当页检查事实，详情与统一状态简要使用同一投影。暂缓、恢复、结案及重新打开不会重建检查义务或清除原检查；读取本身不写业务数据。旧检查和旧规则来源保留，准确规则归SPEC-005/019，实际验收与运行范围见系统真相。

## E04-B06 当前结案来源

详情project补preCloseStatus、sourceImportItemId，既有closureDueDate/closureType/closedOn/closureNote/remainingWorkNote/maintenanceEnabled继续表达当前投影。currentClosure在非closed时为null；closed时返回auditId/sourceImportItemId/actorDisplayName/createdAt/original。auditId为本次最近可信project.close的十进制字符串；无可信事件为null，原人/时间及original也为null，来源保持未知。重开和当前纠错必须带该auditId及进入版本；不能用同日或100%猜周期。

original为原结案审计内容，仅在详情读取；每次纠正通过物理当前投影及追加审计表达，原人/时间/原文不变。旧周期和各次更正从既有audit游标读取，500列表不加载完整审计。结案维护沿既有closed/maintenance视图；S7与维护标识分别显示。

日期结果沿SPEC-004：旧来源缺少当时计划依据时归closed_unknown，不能取当前计划补造；服务器新结案已确认计划未定时归closed_unplanned。closurePlanKnown为内部查询计算值，日期模块显式数值化，不依字符串真假；筛选/统计与详情使用同一来源判断。没有新增表或迁移，完整真实导入仍后续。

### E04-B07 检查历史分页

GET `/api/projects/:id/checks?pageSize=20&before=字符串ID`；默认20、最大100，before为独立检查记录ID游标，总量无上限。可信账号可读，no-store；404项目不存在、400非法参数，数据库错误503。返回 projectVersion / items / nextCursor / pageSize / businessDate，同一数据库快照，不再返回rule；项目版本不同于详情固定版本时客户端提示重入，不把新历史混入旧编辑基线。

items 按原检查 ID 降序，每项保留 id / projectId / actorId / actorName / checkedAt / weekStart / ruleVersion / observedVersion / resultVersion；新检查weekStart与ruleVersion为null，旧记录仍返回原值。conclusion / note 为有效文字，original 为原文字，correction 为最新更正 id / actorName / createdAt及原请求可选reason，或null；新纠正不强制附加原因。完整更正过程仍读取项目审计。保存检查时的原人名快照来自创建审计，不随账号后来改名重写。

不再返回deadlineDate / effectiveRuleVersion / onTime / originalDeadlineDate / originalOnTime，也不据旧规则重新计算历史按时情况。最近记录使用MAX(id)，同毫秒或时钟回拨不改变登记顺序；今日标记独立根据checkedAt所在业务日判断。纠正结论/备注保留原人、检查时间及核对版本，不新增检查记录。

### E04-B08 已删除节点分页

GET `/api/projects/:id/deleted-nodes?pageSize=20&before=字符串ID`；默认20、单次最多100，before按原数字ID严格小于，ID倒序，总量不限。当前启用身份可查看所有项目；未知参数/非法游标400，缺项目404 PROJECT_NOT_FOUND，数据库错误503。返回no-store。

同一快照返回projectVersion/items/nextCursor/pageSize；items为完整原NodeRecord（deletedAt非空）和deletion。deletion有auditId/actorName/createdAt/beforeNode/operations/reason，来自当前页目标最后可信删除审计；无可信审计则null，页面显示来源未知。复用项目前缀索引及目标审计索引，不读取全项目全部历史。普通详情和结案遗留只消费有效节点。

客户端只在页projectVersion等于进入项目版本时接收；不同则冻结原编辑并提示重入，原副本保留供复制。恢复或删除明确保存后清旧分页缓存，再新请求读取；分页GET不产生恢复、历史、项目版本或回执。

2026-10-28（92ecbc4）追加：GET /api/projects接受perspective=responsible|management，可与view/dashboard/details=checks叠加；responsible按本人负责关系筛选，management仍核服务器管理员身份，普通账号不能扩大范围。个人看板在可信身份加载后为兼任账号默认传responsible。所有读取排除deleted_at非空项目。行为归SPEC-022。

2026-10-28统一设计接续：`manager`接受账号ID字符串或数组，选项在options.manager及optionLabels.manager；options.owner只列业务分工资料（engineer:ID）。旧owner=user:ID读取兼容保留。GET /api/project-space的items新增version字符串，空间管理员删除沿既有删除事务/回执，不另设删除接口。
