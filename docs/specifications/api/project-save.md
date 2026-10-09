# 测试项目普通保存 API

日期：2026-10-09；代码版本31012c8，实际代码 src/server/routes/projects.ts 与 modules/project-save.ts，结构0002-trial-save；[固定构建](../../operations/deployments/2026-10-09-project-ordinary.md)。行为唯一归 [SPEC-002](../specification.md#spec-002-保存事务并发与审计)；本文件只说明协议。全部响应 Cache-Control: no-store；大整数均为十进制字符串，当前没有登录身份。

## PATCH /api/projects/:id

输入示例：

```json
{"expectedVersion":"1","idempotencyKey":"089dd49e-343f-4464-bdca-32c74a1a9b94","changes":{"name":"合成测试项目","summaryNote":"明确保存后生效"}}
```

id/expectedVersion 范围为1至UINT64_MAX；操作编号为小写 UUID v4。同编号重试需沿用同版本和同内容。changes 非空，白名单如下；名称规则与字段容量见规格。不接受客户端身份、dataKind、生命周期、日期或责任字段。

| 字段 | JSON 类型/编码 |
|---|---|
| name/marketExpectation/detailNote/summaryNote/statusDesc/signalNote/chipstatNote | 字符串；说明可明确空字符串 |
| signal | green/yellow/red |
| priority | high/mid/low |
| customerId/odmCustomerId/productLineId/appId/groupId | 十进制 ID 字符串或 null |
| chipIds/tagIds | 有序、无重复的 ID 字符串数组，[] 清除 |
| people | 有序 {id,role} 数组；role 为 pm/hardware_owner/software_owner/participant，同 ID/role 不重复 |

遗漏字段/集合不修改。资料不存在或新增已停用引用返回 422，fields 指出对应字段；原停用引用可保留或移除。人员字段不产生账号权限。

200：outcome=committed，result 包含 projectId/operationId/changed/savedVersion/values/savedAt。仅原四项字段的请求保持旧协议，values 为四项固定值；含扩展字段的请求 values 为全部普通字段及关联，实际变更时 display 附当时关联名称/角色/ID，供页面和历史消费。savedAt 为UTC或无变化时 null；另有本次 requestId。同编号回放 result 保持原值，本次 requestId 可不同。原文字请求的作用域/指纹保留兼容，扩展请求作用域为 anonymous:project:<id>:ordinary。

| HTTP/代码 | 处理 |
|---|---|
| 400 INVALID_SAVE_REQUEST / INVALID_PROJECT_ID | 修正请求，未提交 |
| 422 INVALID_PROJECT_FIELDS | fields 给对应字段错误，原输入保留 |
| 403 PROJECT_READ_ONLY | 当前仅 trial 可改 |
| 404 PROJECT_NOT_FOUND | 项目不存在 |
| 409 PROJECT_VERSION_CONFLICT | currentVersion 提示新版，旧文字保留，重新进入 |
| 409 OPERATION_KEY_REUSED | 编号与原内容不一致，停止覆盖 |
| 500 SAVE_ROLLED_BACK | 已确认未提交，输入保留 |
| 503 DATABASE_UNAVAILABLE | 提交前失败时 not_committed；恢复后再保存 |
| 503 COMMIT_UNKNOWN | outcome=unknown；只读对账或原请求重试 |

422 PROJECT_VERSION_EXHAUSTED 不能再推进版本。网络超时/应答不可读同样为结果未知，不能把未知当未提交。

## POST /api/projects/:id/save-results/query

提交原 PATCH 的完全相同输入。只读，不新建回执、不补写项目。200 outcome=committed 带原 result；outcome=not_found 不证明原事务失败，稍后确认或沿原请求重试。非法输入/只读范围/编号摘要冲突同上；读取不可用时 outcome=unknown。

## GET /api/projects/:id/audit

pageSize 默认20，范围1～100；before 为上一页 nextCursor，采用严格小于该数字 ID 的逆序读取。返回 items/nextCursor/pageSize；nextCursor=null 表示本次没有更早页。items 含 id/actorDisplayName/actorKind/action/versionBefore/versionAfter/beforeValues/afterValues/createdAt。当前 actorKind=anonymous、显示“未认证操作”。历史总量无限制，与整个面板500项目规模独立。未知 query 拒绝，非法参数400；缺项目404、读取不可用503。

文字动作 action=project.text.save，扩展动作 action=project.ordinary.save。beforeValues/afterValues 为实际变化项；关联值保留当时 {id,name} 或人员 {id,name,role}，清除为 null/[]。

## GET /api/project-options

只读候选入口，返回 apps/chips/customers/engineers/product_lines/project_groups/tags 分类数组。项目 ID 与资料 ID 均为字符串，每项含 id/name/enabled；芯片另含 originalModel/manufacturer/firmwareVersion。包括停用项供原引用识别，服务器保存时独立核验新增引用资格。读取失败503，不把失败返回为空数组。此入口没有资料新增/改名/停用能力。

项目详情增加 customerId/odmCustomerId/productLineId/appId/groupId；已有关联集合的稳定 ID 保持。trial 的 capabilities.editOrdinary=true；business 为 false。协议实现对应 project-ordinary，实际固定构建见部署记录。
