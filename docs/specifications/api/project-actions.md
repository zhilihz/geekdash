# E04 项目动作 API

来源：`src/server/routes/projects.ts`、`modules/project-actions.ts`；2026-10-09。当前实现startStage/completeStage/startProject，行为正文引用SPEC-002/003/014；部署事实归系统真相及部署记录。身份、CSRF及可信账号头沿[项目主干](project-core.md)，所有ID/版本使用十进制字符串。

## 1. 明确保存与原结果确认

| 方法与路径 | 用途 |
|---|---|
| `POST /api/projects/:id/actions` | 当前负责人明确保存开始或完成 |
| `POST /api/projects/:id/action-results/query` | 当前账号用完整原正文与编号查询原结果；查不到不代表未提交 |

两入口使用同一正文：

```json
{
  "action": "completeStage",
  "stageCode": "S1",
  "actualDate": "2026-10-09",
  "expectedVersion": "2",
  "idempotencyKey": "12345678-1234-4123-8123-123456789abc",
  "completionNote": "负责人核对里程碑完成"
}
```

必填action、stageCode、actualDate、expectedVersion、idempotencyKey；动作仅startStage/completeStage，阶段仅S1～S7，日期为有效YYYY-MM-DD，操作编号UUIDv4。completionNote仅完成允许，选填；UTF-8最多65535字节，省略等价空字符串。不接受负责人、目标百分比、阶段最终集合或额外字段。完成说明进入本次审计，原阶段评述保持。

确认成功HTTP200：

```json
{
  "outcome": "committed",
  "result": {
    "projectId": "123",
    "operationId": "12345678-1234-4123-8123-123456789abc",
    "action": "completeStage",
    "stageCode": "S1",
    "actualDate": "2026-10-09",
    "savedVersion": "3",
    "stages": [
      {"code":"S1","state":"completed","startedOn":"2026-10-09","completedOn":"2026-10-09"},
      {"code":"S2","state":"ready","startedOn":null,"completedOn":null}
    ]
  }
}
```

stages只列本次影响的阶段。确认入口未发现回执返回HTTP200 `{"outcome":"not_found"}`；原编号原正文可重试。作用域包含真实账号及项目，另一账号查不到该回执；同编号不同正文409。已提交原操作在后来项目更新后仍返回原结果，不能将旧结果当当前项目版本。

## 2. 失败协议

沿已有保存错误结构，code/outcome可机器判断。事务没有提交时outcome=not_committed；提交确认丢失时503/outcome=unknown，保留原编号，确认或重试原操作。

| HTTP/code | 使用者反馈与恢复 |
|---|---|
| 400 INVALID_STAGE_COMMAND | 请求白名单/编号/阶段/正文不合法，核对表单 |
| 401 AUTH_REQUIRED / 403身份类错误 | 停止编辑，保留输入，重新认证原账号 |
| 403 PROJECT_READ_ONLY | 先明确加入本人负责范围 |
| 404 PROJECT_NOT_FOUND | 返回列表核对项目 |
| 409 PROJECT_VERSION_CONFLICT | 项目已被他人更新；输入供复制，重新进入 |
| 409 OPERATION_KEY_REUSED | 原编号正文不一致，保留原请求并核对，不能另造编号猜测 |
| 422 INVALID_STAGE_DATE | fields.actualDate说明日期/相邻顺序错误，未保存输入保留 |
| 422 STAGE_SEQUENCE_REVIEW_REQUIRED / STAGE_DATE_REVIEW_REQUIRED | 既有阶段事实不完整或矛盾，先核对/纠正，不静默补造 |
| 422 PROJECT_START_REQUIRED | S1完成后须先明确保存启动项目 |
| 422 STAGE_PREDECESSOR_INCOMPLETE / STAGE_STATE_CHANGED / PROJECT_STAGE_ACTION_BLOCKED | 当前前置/状态不允许推进，重新核对当前事实 |
| 422 PROJECT_VERSION_EXHAUSTED | 版本无法继续增加，交维护处理 |
| 503 COMMIT_UNKNOWN / 客户端响应丢失 | 结果待确认，沿原编号原正文恢复 |

## 3. 查询增量与页面消费

列表及详情project增加stageState：首个未完成阶段的真实状态；全部完成为completed，没有阶段为unconfigured。原stage/progress继续派生，开始不会把进度推进到下一完成值。

详情增加businessDate（Asia/Shanghai业务日）及stageActions：每阶段code/startBlocked/completeBlocked，null表示本次快照条件允许。它是页面可用性提示，保存仍在事务内校验。项目日期未知、旧事实、资料、灯色/优先级及周检查事实不被此动作自动重写。

阶段页复用原面板卡片与静态阶段定义；开始/完成表单在卡片内，明确保存后新GET。阶段工期/评述仍只读；结案、回退等后续功能不可用，不触发原浏览器数据库脚本。审计含stageChanges前后状态/有效日期，完成另含completionNote；创建的beforeValues可以为null。

## 4. E04-B02 人工启动

同一动作/原结果路径接受 `action=startProject`，必填 actualDate、dueDate、expectedVersion、idempotencyKey、configVersion、ruleVersion、previewWeek、previewFirstCheckWeek；planReason选填，修改已有当前计划时必须填写。日期均为YYYY-MM-DD，三个版本为十进制字符串，编号UUIDv4，说明UTF-8至多65535字节。不得添加阶段、负责人或应检计算结果。

先GET详情/公共规则取得预览，同次事务核对其设置版本、当前业务周与首次应检周。成功result含projectId/operationId/action/savedVersion及status/startDate/dueDate/originalDueDate/firstCheckWeek/firstCheckRuleVersion。后续新GET显示进行中，S2保持待开始；保存周建立检查义务，规则正文引用SPEC-003/004/005/019。

- 409 CHECK_PREVIEW_CHANGED：跨周、跨截止或设置变化；保留日期输入，重新打开启动表单核对预览，再明确保存。
- 422 CHECK_RULE_REQUIRED：维护账号先初始化规则，重新进入项目。
- 422 PROJECT_S1_REQUIRED / PROJECT_START_BLOCKED / PROJECT_START_HISTORY_REVIEW_REQUIRED：前置或既有事实不允许启动；先核对/纠正，禁止自动补事实。
- 422 INVALID_PROJECT_DATE：fields.actualDate/dueDate指明错误，原输入可恢复。
- 422 PLAN_REASON_REQUIRED：补充同次改期原因。

详情增加startBlocked、checkRule以及project.firstCheckWeek/firstCheckRuleVersion；未知依据返回null，不猜测。checkRule协议见[公共设置](public-settings.md)。原阶段回执请求指纹保持兼容。已确认后GET失败只提示重新进入，不再次生成动作；未确认请求保留原编号/正文。
