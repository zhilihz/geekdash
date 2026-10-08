# 项目只读 API

日期：2026-10-08；对应代码：`dfd9f0cc837ff98c10c61541dee2a8b3a057b057` 的项目读取模块；运行事实归[部署记录](../../operations/deployments/2026-10-08-project-reads.md)。以下是实际代码协议，部署状态不能由本文推导。业务语义引用 SPEC-002/014；本单元免登录，只提供 GET，不开放写入。

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
| stage | S1～S7/completed/unconfigured |
| progress | 字符串 0/5/10/20/60/80/90/100 |
| page/pageSize | 整数；page 1～1000000，pageSize 1～100，默认 1/24 |

非法枚举、超长输入、未知参数返回 400。稳定按项目 ID 降序，超出最后一页时返回实际最后一页；没有结果仍为第 1/1 页。

返回 `items`（当前页项目摘要及批量关联芯片/人员/标签）、`pagination`、`stats`、`options`、`stageCounts`、`readOnly=true`。项目 ID/version 及关联 ID 均为字符串，避免 bigint 精度丢失；progress 可为 SQL 返回的数字字符串。空引用为 null，空关联为数组。

`stats/options/stageCounts` 对应当前 view 的全部项目，其他筛选仅影响 items 与 pagination.total，沿原版统计条视图范围；页面明确注明。列表与统计/选项处于同一短读事务。空查询返回 200 和空数组/零计数；不可用不能伪装成空查询。

## 2. 固定详情

`GET /api/projects/{id}`

id 为正十进制 bigint 字符串，不超过 unsigned bigint；格式/越界返回 400，项目不存在返回 404/PROJECT_NOT_FOUND。

返回 `project/stages/nodes/risks/changes/delays/history/readOnly`；project 含普通详情及已接入关联，history 当前为 legacy_project_history 来源记录。未来新增审计历史消费随保存单元接入，不能将当前来源历史称全部修改历史。节点包含业务归属与旧位置/连线引用，但当前未提供 Flow 页面编排。

同一连接以 REPEATABLE READ + WITH CONSISTENT SNAPSHOT、READ ONLY 组装项目和子集合；请求结束提交并释放，不随浏览器停留持锁。日期为 YYYY-MM-DD；时间为 UTC ISO 字符串。页面重新进入前保持本次取得的数据与版本。

## 3. 可用性与边界

正常返回 no-store；项目查询过程失败返回 503/PROJECT_READ_UNAVAILABLE，不泄露 SQL、账号或凭据。全局数据库未就绪时沿工程健康协议返回 503/reason；无运行数据库的构建探测实例返回 503/DATABASE_UNAVAILABLE。

POST/PATCH/DELETE 不存在业务写接口；GET 不创建账号、责任、检查、业务历史或草稿，不触发阶段/灯色变化。当前没有本人负责授权、服务器个人状态或 SSE；浏览器只保存主题、列表 URL/位置等本机浏览偏好。

验证方法归 TEST-036，执行结果归 [报告](../../testing/reports/2026-10-08-project-reads.md)。
