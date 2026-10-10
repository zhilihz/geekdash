# 项目只读 API

日期：2026-10-10；来源src/server/modules/projects.ts及routes/projects.ts，E04-B04。当前业务查询要求可信登录，身份协议归[项目主干](project-core.md)；以下是读取协议，部署状态归系统真相，不能由本文推导。业务语义引用SPEC-002/004/014。

## 1. 看板列表

`GET /api/projects`

| 参数 | 类型与范围 |
|---|---|
| view | active/proposal/closed/maintenance/all；默认 active |
| search | 最多 255 字符；在原版名称、客户、产品线、ODM、APP、芯片、软硬件业务负责人、市场预期和状态描述范围内作包含匹配；%/_/! 按文字处理 |
| customer/productLine/odmFactory/app/group/chip/tags/owner | 最多 255 字符；名称完全匹配，owner 对应业务人员资料而非账号授权 |
| status | proposal/ongoing/paused/closed |
| priority | high/mid/low |
| signal | green/yellow/red |
| deadline | upcoming/due/overdue/unset/closed_on_time/closed_late/closed_unplanned/closed_unknown/terminated |
| stage | S1～S7/completed/unconfigured |
| progress | 字符串 0/5/10/20/60/80/90/100 |
| page/pageSize | 整数；page 1～1000000，pageSize 1～100，默认 1/24 |

非法枚举、超长输入、未知参数返回 400。稳定按项目 ID 降序，超出最后一页时返回实际最后一页；没有结果仍为第 1/1 页。

返回 `items`（当前页项目摘要及批量关联芯片/人员/标签）、`pagination`、`stats`、`options`、`stageCounts`、`readOnly=true`。项目 ID/version 及关联 ID 均为字符串，避免 bigint 精度丢失；progress 可为 SQL 返回的数字字符串。空引用为 null，空关联为数组。

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

stats增加checkRequired/checkPending/checkOverdue/checkDone/checkUpdated，沿完整筛选范围再应用默认必查范围；checkPending+checkOverdue+checkDone等于checkRequired，checkUpdated可以与已查计数重叠。暂缓移出必查不表示已查；恢复沿原首次义务立即查询。列表一次按当页项目批量读取周事实，详情相同投影；无定时业务写入或检查创建。B05只接读取，明确检查/纠错写入口仍属B07；规则正文归SPEC-005/019，不据现有表或夹具称写入口已交付。
