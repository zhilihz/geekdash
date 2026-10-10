# E04 项目动作 API

来源：`src/server/routes/projects.ts`、`modules/project-actions.ts`、`modules/project-plans.ts`、`modules/project-lifecycle.ts`、`modules/project-closures.ts`；2026-10-10，E04-B06。行为正文引用SPEC-002/003/004/014；实际部署版本归系统真相及部署记录。身份、CSRF及可信账号头沿[项目主干](project-core.md)，所有ID/版本使用十进制字符串。

## E04-B04 日期与计划命令

复用下方三个深接口，统一必填expectedVersion、idempotencyKey；不得提供actor、项目最终版本或派生状态。原因/措施UTF-8最多65535字节，日期为YYYY-MM-DD或明确允许的null。

| action | 额外输入 |
|---|---|
| setPlan | dueDate必填，仅当前计划未定时可用 |
| reschedulePlan | dueDate、reason必填；measures省略等价空字符串 |
| notePlan | reason必填可空、measures选填；二者至少一项非空 |
| correctProjectDates | reason、changes必填；changes仅proposalDate/filingDate/startDate/dueDate/originalDueDate，值为日期或null |
| correctScheduleRecord | recordId、reason、changes必填；changes仅oldDate/newDate/reason/measures；currentDueDate可另外明确提供日期或null |
| voidScheduleRecord | recordId、reason必填；currentDueDate可另外明确提供日期或null |

未提供的字段保持。历史note不能改日期；记录kind、原操作人和时间不可更改。correctProjectDates与历史changes至少选择一项；显式null只用于日期，不能用空字符串代替。新预览返回changed、beforeValues、afterValues、beforeDeadline、afterDeadline；改期另含direction（earlier/same/later）、有符号adjustmentDays、拟新增scheduleRecord；涉及启动日期另含startupBasis及未知提示。

保存成功沿outcome=committed，result含projectId/operationId/action/savedVersion及同次预览事实。新增业务行真实ID在afterValues.scheduleRecord.id；记录原编号恢复时结果不重新计算。changed=false时保存回执但不推进版本、不写审计/改期；页面保留原因，可明确转成独立notePlan预览保存。原阶段/启动命令请求指纹兼容保持。

错误：400 INVALID_PLAN_COMMAND；422 PLAN_REASON_REQUIRED / PLAN_NOTE_REQUIRED / PLAN_ALREADY_SET / PLAN_REQUIRED / INVALID_PROJECT_DATE / SCHEDULE_RECORD_KIND_MISMATCH；404 SCHEDULE_RECORD_NOT_FOUND（含非本项目记录）。身份、负责范围、版本409、原编号冲突及提交未知503沿第2节，不允许通过换编号覆盖新版本。fields指明原表单问题。规则正文引用SPEC-003/004，预览与保存同模块重算，预览不是提交。

## 1. 明确保存与原结果确认

| 方法与路径 | 用途 |
|---|---|
| `POST /api/projects/:id/actions` | 当前负责人明确保存项目动作 |
| `POST /api/projects/:id/action-results/query` | 当前账号用完整原正文与编号查询原结果；查不到不代表未提交 |
| `POST /api/projects/:id/actions/preview` | 阶段纠错/回退、日期/计划及暂缓/恢复的服务器影响预览，不写业务事实或动作回执 |

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

阶段页复用原面板卡片与静态阶段定义；开始/完成表单在卡片内，明确保存后新GET。B03工期/评述接普通保存，纠错/回退沿第5节；结案仍待后续批次。审计含stageChanges前后状态/有效日期，完成另含completionNote；创建的beforeValues可以为null。

## 4. E04-B02 人工启动

同一动作/原结果路径接受 `action=startProject`，必填 actualDate、dueDate、expectedVersion、idempotencyKey、configVersion、ruleVersion、previewWeek、previewFirstCheckWeek；planReason选填，修改已有当前计划时必须填写。日期均为YYYY-MM-DD，三个版本为十进制字符串，编号UUIDv4，说明UTF-8至多65535字节。不得添加阶段、负责人或应检计算结果。

先GET详情/公共规则取得预览，同次事务核对其设置版本、当前业务周与首次应检周。成功result含projectId/operationId/action/savedVersion及status/startDate/dueDate/originalDueDate/firstCheckWeek/firstCheckRuleVersion。后续新GET显示进行中，S2保持待开始；保存周建立检查义务，规则正文引用SPEC-003/004/005/019。

- 409 CHECK_PREVIEW_CHANGED：跨周、跨截止或设置变化；保留日期输入，重新打开启动表单核对预览，再明确保存。
- 422 CHECK_RULE_REQUIRED：维护账号先初始化规则，重新进入项目。
- 422 PROJECT_S1_REQUIRED / PROJECT_START_BLOCKED / PROJECT_START_HISTORY_REVIEW_REQUIRED：前置或既有事实不允许启动；先核对/纠正，禁止自动补事实。
- 422 INVALID_PROJECT_DATE：fields.actualDate/dueDate指明错误，原输入可恢复。
- 422 PLAN_REASON_REQUIRED：补充同次改期原因。

详情增加startBlocked、checkRule以及project.firstCheckWeek/firstCheckRuleVersion；未知依据返回null，不猜测。checkRule协议见[公共设置](public-settings.md)。原阶段回执请求指纹保持兼容。已确认后GET失败只提示重新进入，不再次生成动作；未确认请求保留原编号/正文。

## 5. E04-B03 阶段纠错、误操作撤销与真实回退

预览、保存和原结果确认使用同一个完整命令。实际日期纠错示例：

```json
{
  "action": "correctStageFacts",
  "changes": [{"code":"S3","completedOn":"2026-10-08"},{"code":"S4","startedOn":null}],
  "reason": "核对原记录后纠正",
  "expectedVersion": "12",
  "idempotencyKey": "12345678-1234-4123-8123-123456789abc"
}
```

changes为1～7个不同阶段补丁，仅接受code/startedOn/completedOn；至少指定一个日期字段。省略不改，null明确未知；已完成且日期未知仍保持已完成。所有补丁合并成最终候选后检查状态与相邻阶段已知日期，不要求阶段日期晚于项目启动日。

误操作/真实返工示例：

```json
{"action":"undoStageComplete","stageCode":"S3","undoStart":false,"reason":"完成误录","expectedVersion":"12","idempotencyKey":"12345678-1234-4123-8123-123456789abc"}
```

action为undoStageStart/undoStageComplete/rollbackStage；undoStart仅undoStageComplete允许，默认false。目标S1～S7；原因必填有效文字，UTF-8最多65535字节。撤销误开始要求目标active；撤销误完成及真实回退要求目标当前completed。具体联动归SPEC-003；保存返回影响阶段及原/新进度。项目计划、总体状态、检查义务、节点成果、风险和责任保持。结案必须先重开才能撤销/回退；暂缓项目真实回退须先恢复。

预览HTTP200直接返回projectId/expectedVersion/changed/beforeStages/stageChanges/progressBefore/progressAfter/reason，无outcome封装。预览绑定进入版本，保存仍在事务内重新计算；不接受客户端提供的最终阶段集合或进度。预览后改输入需重新预览，别人已保存则409。预览不写业务事实、审计或command_receipts；正常会话活动记录仍沿身份入口执行。

保存HTTP200沿outcome=committed/result，result含projectId/operationId/action/savedVersion及上述影响字段。实际无变化时changed=false，版本/updated_at/审计保持，仍保存确定回执。新动作作用域沿账号/项目/actions，旧startStage/completeStage/startProject指纹不改。

补充错误：422 CORRECTION_REASON_REQUIRED填写原因；INVALID_PROJECT_DATE校验日期格式；INVALID_STAGE_DATE指明最终状态/日期冲突；PROJECT_REOPEN_REQUIRED先重开；PROJECT_RESUME_REQUIRED先恢复。既有阶段顺序矛盾返回STAGE_SEQUENCE_REVIEW_REQUIRED，未知开始不可直接撤销完成后假造开始事实。403/409/503恢复沿第2节，旧副本及未知提交沿原编号保留。

## 6. E04-B05 暂缓、恢复与说明纠错

复用同组三个接口；统一必填expectedVersion、idempotencyKey（UUIDv4），仅可信负责人写入。输入白名单如下，文字UTF-8最多65535字节；行为正文归SPEC-003/005，查询协议见[读取API](projects-read.md)。

| action | 额外输入 |
|---|---|
| pauseProject | reason必填且非空 |
| resumeProject | note选填，省略为空；dueDate可明确提供有效日期，planReason只可随dueDate提供 |
| correctLifecycleNote | auditId、note、reason必填；note为更正后完整文字，reason非空 |

恢复按服务端resume_status，客户端不能提供目标状态。未提供dueDate时计划保持；同时改已有计划需planReason非空，日期与计划历史复用B04深模块，在同事务保存。未知暂缓前状态拒绝，不猜测、不还原暂停前整份数据。correctLifecycleNote只关联本项目原project.pause/project.resume审计，恢复说明可明确清空，暂缓原因仍须非空；原行、人、时间保持，新增更正表达有效文字。

预览HTTP200直接返回projectId/expectedVersion/changed/beforeValues/afterValues/beforeCheck/afterCheck；恢复同时改计划另有plan（B04预览形状）。检查提示使用同次服务器时钟和当前规则；不要求恢复命令携带旧截止，保存后再新GET。预览不写项目/审计/回执/检查。保存沿committed/result，包含上述影响、action/operationId/savedVersion；无实际变化只写原结果回执。project.pause/project.resume/project.lifecycle.note.correct是新增审计动作名。失败后原编号/正文恢复沿第2节，阶段/启动及B04旧指纹保持。

补充错误：400 INVALID_LIFECYCLE_COMMAND；422 LIFECYCLE_REASON_REQUIRED / LIFECYCLE_NOTE_REQUIRED / PROJECT_PAUSE_BLOCKED / PROJECT_RESUME_BLOCKED / PROJECT_RESUME_BASIS_UNKNOWN；404 LIFECYCLE_NOTE_NOT_FOUND（含跨项目、其他审计类型）。同次计划错误沿B04，fields.reason/note/planReason/dueDate指向需要纠正的输入。身份/权限/409/503沿共同协议，禁止通过换编号覆盖旧视图。

## 7. E04-B06 结案、重开、维护及当前结案纠错

沿同组三个动作/预览/原结果接口，统一expectedVersion和UUIDv4 idempotencyKey；可信负责人才能写。规则正文归SPEC-003/004，来源绑定方法归AD-009，源为project-closures.ts。

| action | 额外输入 |
|---|---|
| closeProject | closureType为normal/terminated；closedOn为有效日期；closureNote非空；remainingWorkNote省略为空，有遗留时非空 |
| reopenProject | closureAuditId必填为详情currentClosure.auditId（旧来源明确null）；reason非空 |
| setMaintenance | enabled为boolean；reason非空 |
| correctClosure | closureAuditId同上；reason非空；changes为非空选定补丁 |

changes只接受closedOn、closureDueDate、closureType、closureNote、remainingWorkNote；前两项日期可明确null，closedOn表示实际日未知、closureDueDate表示当时计划未定。closureType只能normal/terminated，closureNote仍非空；省略不修改。文字按UTF-8最多65535字节；拒绝额外status/actor/阶段数组等字段。只检查本次日期纠错涉及的关系，无关旧日期问题不阻止文字纠错。旧来源没有可信结案事件时不补造原人/时间。

预览直接HTTP200返回projectId/expectedVersion/changed/beforeValues/afterValues/remaining/progress/beforeDeadline/afterDeadline/beforeCheck/afterCheck。beforeValues.closure和afterValues.closure为当前结案投影（总体状态、结案前状态、日期、类型、两项说明、维护开关）；remaining含未完成/未配置阶段、未完成节点和未解除风险。进度始终来自真实有效阶段，服务端保存时重新计算遗留和资格，不信客户端“无遗留”断言。预览不写业务，输入变化或项目版本变化须重新核对。

保存返回committed/result及上述影响、action/operationId/savedVersion。结案捕获当前计划和原总体状态；重开清空已消费结案投影、关闭维护，保留当前计划/阶段/普通修改/暂停来源/首次义务。维护同值和纠错同值changed=false，只保存原结果回执；不增加历史。project.close/project.reopen/project.maintenance/project.closure.correct为新审计名，原结案事件及原回执不可改写；历史通过已有audit分页读取。

补充错误：400 INVALID_CLOSURE_COMMAND；422 CLOSURE_NOTE_REQUIRED/CLOSURE_REASON_REQUIRED/CLOSURE_REMAINING_REQUIRED/INVALID_CLOSURE_DATE/PROJECT_CLOSE_BLOCKED/PROJECT_CLOSED_REQUIRED/PROJECT_REOPEN_BASIS_UNKNOWN；409 CLOSURE_CHANGED（旧或跨项目结案ID不能纠正/重开当前周期）。日期格式错误沿INVALID_PROJECT_DATE；身份/只读/版本/503及原编号恢复沿共同协议。数据库已回滚返回not_committed；COMMIT未知返回unknown，不能因后续GET失败再发新结案。

## 8. E04-B07 明确检查与文字纠错

沿本文件的动作、只读预览与原结果接口，统一 expectedVersion 和 UUIDv4 idempotencyKey；项目负责人写入，所有可信账号可读。行为正文归 SPEC-005/019，纠错来源取舍归 AD-010。实际源为 project-actions.ts / project-checks.ts。

| action | 额外必填输入 |
|---|---|
| saveCheck | conclusion、note、ruleVersion、previewWeek |
| correctCheck | checkId、conclusion、note、reason |

conclusion 为 checked / follow_up；note 可以为空，纠错时空字符串表示明确清空。文字为合法 Unicode、UTF-8 最多 65535 字节；reason 非空；版本和 checkId 为字符串 ID，previewWeek 为服务器提供的周一日期。拒绝额外操作者、时间、历史周、状态或整条撤销字段。correctCheck 不携带截止规则，目标必须属于本项目。

预览 HTTP200 返回 changed / beforeValues / afterValues；saveCheck 另有 deadlineDate / onTime，拟检查包含 checkedAt / weekStart / ruleVersion / observedVersion / resultVersion，实际人、时间与周在保存时重新确认。correctCheck 另有原人、时间、周、原版本及 original 文字；只读预览不写入。输入变化、项目变版或检查规则变化后重新核对。

保存返回 committed/result，包含 action / operationId / projectId / checkId / changed / savedVersion 及预览影响。实际保存检查在身份→配置共享锁→项目锁取得后取一次时钟，检查、项目版本、project.check.save 审计及原回执同事务。纠错只追加 project.check.correct 审计，原 project_checks 行保持；有效文字按原检查 ID 的最新更正投影。审计 entity_type=project_check、entity_id=原检查 ID，project_id 仍供项目历史分页。无变化纠错只写回执。

补充错误：400 INVALID_CHECK_COMMAND；422 CHECK_REASON_REQUIRED / CHECK_RULE_REQUIRED；404 PROJECT_CHECK_NOT_FOUND；409 CHECK_PREVIEW_CHANGED。身份、负责人、项目版本、编号重复及数据库失败沿第2节恢复；COMMIT 未知只能先确认原编号正文，不能换编号补一条检查。跨周或后来规则改变不影响原回执重放。检查列表协议见[项目读取](projects-read.md)。
