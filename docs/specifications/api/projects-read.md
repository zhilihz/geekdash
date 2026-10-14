# 项目只读 API

日期：2026-10-14；来源src/server/modules/projects.ts及routes/projects.ts，E04-UI12。当前业务查询要求可信登录，身份协议归[项目主干](project-core.md)；以下是读取协议，部署状态归系统真相，不能由本文推导。业务语义引用SPEC-002/004/005/014/018。

## 1. 看板列表

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
| page/pageSize | 整数；page 1～1000000，pageSize 1～100，默认 1/24 |

非法枚举、超长输入、未知参数返回 400。稳定按项目 ID 降序，超出最后一页时返回实际最后一页；没有结果仍为第 1/1 页。

返回 `items`（当前页项目摘要及批量关联芯片/人员/标签）、`pagination`、`stats`、`options`、`stageCounts`、`readOnly=true`。项目 ID/version 及关联 ID 均为字符串，避免 bigint 精度丢失；progress 可为 SQL 返回的数字字符串。空引用为 null，空关联为数组。

dashboard=1在同一只读快照附加：items.summaryNote、dashboard.distributions（客户/产品线/状态/优先级/信号灯/阶段的value/count）、focusTotal及focus（当前完整匹配范围，优先级/进度排序，最多12项；已结案及量产维护看板同样展示）、latest（当前匹配按项目更新时间最近10项，非状态单项修改时间）、team。team按当前完整筛选集合的非结案项目计算：id/name/count，以及pmCount/hardwareCount/softwareCount；总数按工程师与项目去重，各岗位分别按项目去重，保留零负载工程师。UI12按统一展示范围替代旧team全局口径。数量均为实际计数；focus有限展示不构成创建上限，分页变化不改变汇总口径。统计失败整次读取失败，不返回假零值。

列表items增加checkedToday:boolean和capabilities.canCheck:boolean。前者根据checked_at位于上海当天00:00至次日00:00的UTC半开区间判断；同一天多条只算一个已检查项目。后者来自当前可信账号的project_responsibilities关系，不由业务人员姓名推断；写入仍会重新校验。只有列表使用ListProject类型，不能假定详情含这两个字段。

stats增加todayChecked/todayUnchecked，均为包含checkToday在内的当前过滤集合计数，二者相加等于total；在unchecked查询里todayChecked自然为0，不得当作另一个已检查标签的总数。首页不带日条件，消费完整当前范围的两项计数；检查页以实际查询分页总数展示。日标记不改变周检查义务和按时规则。

`stats/stageCounts`跟随完整筛选范围，options按view提供可选范围。列表与统计/选项处于同一短读事务，businessDate来自同次服务器Asia/Shanghai时钟。stats含九个deadline类别计数，当前范围合计等于total；项目deadline含kind/asOfDate/days/label。未定或未知days=null，不能解释为0；不返回manualDelayed。空查询返回200和空数组/零计数；不可用不能伪装成空查询。

## 2. 固定详情

`GET /api/projects/{id}`

id 为正十进制 bigint 字符串，不超过 unsigned bigint；格式/越界返回 400，项目不存在返回 404/PROJECT_NOT_FOUND。

返回project/stages/nodes/risks/changes/delays/planSummary/history/responsible/readOnly/capabilities及动作提示和公共规则。history仅旧来源记录，服务器完整审计按[保存API](project-save.md)独立分页。responsible是账号负责关系，与业务人员资料不同；当前身份与负责范围决定编辑能力，所有账号可读全部项目。

delays包含kind、有效oldDate/newDate/reason/measures/voided、原actorId/createdAt、original原值和corrections更正来源；读取全部关联更正，不受审计第一页20条限制。planSummary包含reschedules、laterAdjustments、unknownAdjustments及相对原始计划有符号netDays；缺日期netDays=null。note、撤销或同值记录不计真实改期，未知改期单列；不据历史数量判断当前超期。具体变更协议见[项目动作](project-actions.md)。

同一连接以 REPEATABLE READ + WITH CONSISTENT SNAPSHOT、READ ONLY 组装项目和子集合；请求结束提交并释放，不随浏览器停留持锁。日期为 YYYY-MM-DD；时间为 UTC ISO 字符串。页面重新进入前保持本次取得的数据与版本。

## 3. 可用性与边界

正常返回 no-store；项目查询过程失败返回 503/PROJECT_READ_UNAVAILABLE，不泄露 SQL、账号或凭据。全局数据库未就绪时沿工程健康协议返回 503/reason；无运行数据库的构建探测实例返回 503/DATABASE_UNAVAILABLE。

GET不创建账号、责任、检查、业务历史或草稿，不触发阶段/灯色变化。写入协议分别归项目主干/普通保存/项目动作；服务器个人状态与SSE仍后续。页面同版本聚焦/跨日只刷新派生日期提示，不覆盖未保存输入；不同版本冻结原编辑，需重新进入。

验证方法归 TEST-036，执行结果归 [报告](../../testing/reports/2026-10-08-project-reads.md)。

## E04-B05 周检查查询及暂缓说明

project增加resumeStatus（暂缓前proposal/ongoing或null）、firstCheckWeek与checkStatus；详情另返回lifecycleNotes。firstCheckWeek为YYYY-MM-DD或null。lifecycleNotes为原暂缓/恢复审计ID、action、originalNote/有效note、原人/UTC时间/版本及corrections（更正ID/人/时间/原因），不改写原历史。

checkStatus包含kind/label/required/weekStart/deadlineDate/onTime/updatedAfterCheck/latest。kind为excluded/not_due/basis_unknown/rule_unknown/pending/overdue/checked/checked_late；required只表示默认当周必查，已有主动检查可以required=false。onTime为首次检查对本周当前有效截止的判定，未知为null；updatedAfterCheck比较最新resultVersion。latest为本周最新id/actorId/actorName/checkedAt/conclusion/note/observedVersion/resultVersion，没有则null。时间为UTC，自然周/截止按服务器Asia/Shanghai；结论原值checked/follow_up。

stats增加checkRequired/checkPending/checkOverdue/checkDone/checkUpdated，沿完整筛选范围再应用默认必查范围；checkPending+checkOverdue+checkDone等于checkRequired，checkUpdated可以与已查计数重叠。暂缓移出必查不表示已查；恢复沿原首次义务立即查询。列表一次按当页项目批量读取周事实，详情相同投影；无定时业务写入或检查创建。B07已接明确检查和文字纠错；最新摘要采用有效文字，原检查事实及原规则保留。规则正文归SPEC-005/019，实际验收与运行范围见系统真相。

## E04-B06 当前结案来源

详情project补preCloseStatus、sourceImportItemId，既有closureDueDate/closureType/closedOn/closureNote/remainingWorkNote/maintenanceEnabled继续表达当前投影。currentClosure在非closed时为null；closed时返回auditId/sourceImportItemId/actorDisplayName/createdAt/original。auditId为本次最近可信project.close的十进制字符串；无可信事件为null，原人/时间及original也为null，来源保持未知。重开和当前纠错必须带该auditId及进入版本；不能用同日或100%猜周期。

original为原结案审计内容，仅在详情读取；每次纠正通过物理当前投影及追加审计表达，原人/时间/原文不变。旧周期和各次更正从既有audit游标读取，500列表不加载完整审计。结案维护沿既有closed/maintenance视图；S7与维护标识分别显示。

日期结果沿SPEC-004：旧来源缺少当时计划依据时归closed_unknown，不能取当前计划补造；服务器新结案已确认计划未定时归closed_unplanned。closurePlanKnown为内部查询计算值，日期模块显式数值化，不依字符串真假；筛选/统计与详情使用同一来源判断。没有新增表或迁移，完整真实导入仍后续。

### E04-B07 检查历史分页

GET `/api/projects/:id/checks?pageSize=20&before=字符串ID`；默认20、最大100，before为独立检查记录ID游标，总量无上限。可信账号可读，no-store；404项目不存在、400非法参数，数据库错误503。返回 projectVersion / items / nextCursor / pageSize / rule，同一数据库快照；项目版本不同于详情固定版本时客户端提示重入，不把新历史混入旧编辑基线。

items 按原检查 ID 降序，每项保留 id / projectId / actorId / actorName / checkedAt / weekStart / ruleVersion / observedVersion / resultVersion；conclusion / note 为有效文字，original 为原文字，correction 为最新更正 id / actorName / createdAt / reason 或 null。完整更正过程仍读取项目审计。保存检查时的原人名快照来自创建审计，不随账号后来改名重写。

deadlineDate / effectiveRuleVersion / onTime 为当前采用的截止判定，originalDeadlineDate / originalOnTime 为原规则判定。本周采用最新有效设置；历史周取该周结束前有效的最后修订，以后的调整不重算过去。列表首查采用 MIN(id)、最新采用 MAX(id)，同毫秒和时钟回拨不会改成按最小时间选首查。列表只批量读取当页周摘要与有效文字，详情和历史复用同一投影。

### E04-B08 已删除节点分页

GET `/api/projects/:id/deleted-nodes?pageSize=20&before=字符串ID`；默认20、单次最多100，before按原数字ID严格小于，ID倒序，总量不限。当前启用身份可查看所有项目；未知参数/非法游标400，缺项目404 PROJECT_NOT_FOUND，数据库错误503。返回no-store。

同一快照返回projectVersion/items/nextCursor/pageSize；items为完整原NodeRecord（deletedAt非空）和deletion。deletion有auditId/actorName/createdAt/beforeNode/operations/reason，来自当前页目标最后可信删除审计；无可信审计则null，页面显示来源未知。复用项目前缀索引及目标审计索引，不读取全项目全部历史。普通详情和结案遗留只消费有效节点。

客户端只在页projectVersion等于进入项目版本时接收；不同则冻结原编辑并提示重入，原副本保留供复制。恢复或删除明确保存后清旧分页缓存，再新请求读取；分页GET不产生恢复、历史、项目版本或回执。
