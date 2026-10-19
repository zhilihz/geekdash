# 个人草稿与偏好接口

状态：2026-10-16，`codex/p04-plan-reassessment`、基线`f07450e`加工作区候选代码，MySQL结构0004。接口已经产生，尚未随完整P04发布。行为规则唯一归[SPEC-007](../specification.md#spec-007-工作状态与草稿)，验证范围归[阶段内报告](../../testing/reports/2026-10-16-p04-scoped-save.md)。

## 认证与调用

所有接口使用现有会话、CSRF和账号上下文校验。后台自动同步不发送`X-GeekDash-Active: 1`，不延长无人操作的会话。客户端请求及响应类型在`src/web/shared/personal-state.ts`，服务端白名单在`src/server/modules/personal-state.ts`；本协议不另维护字段字典。

| 方法与路径 | 输入 | 成功结果 |
| --- | --- | --- |
| GET `/api/personal/drafts` | 可选`projectId`（项目十进制ID或`new`）、`clientDraftId`（UUIDv4） | `items`只含本人；默认列active，指定草稿ID可读其终态 |
| POST `/api/personal/drafts/save` | 下述同步请求 | 已持久化草稿，含`draftVersion`、`clientSequence`、`payload`、`state` |
| POST `/api/personal/drafts/discard` | `{clientDraftId,draftVersion}` | `{state:"discarded"}`；同修订重复丢弃返回原结果 |
| GET `/api/personal/preferences` | `deviceKey`、`scope` | `{version,value}`；尚未建立返回`{version:"0",value:null}` |
| POST `/api/personal/preferences/save` | `{deviceKey,scope,expectedVersion,value}` | 确认后的`version`及`value` |

## 草稿同步请求

```json
{
  "clientDraftId": "a711d67d-cef1-4097-a4a3-0dcd93c054aa",
  "projectId": "123",
  "formKind": "status",
  "baseVersion": "5",
  "expectedDraftVersion": "0",
  "clientSequence": "1",
  "payload": {
    "schemaVersion": 1,
    "instanceId": "da664513-1599-441b-9596-68e027a2202b",
    "values": {"statusDesc": "等待客户确认"},
    "submission": {"scope": "status", "changes": {"statusDesc": "等待客户确认"}}
  }
}
```

- ID及版本使用十进制字符串；首次草稿修订预期为`0`，客户端序号从`1`开始。`create`的`projectId/baseVersion`为null。
- `formKind`为已实现保存范围，另含`create/action`。范围字段只放`values`；尚未完成的基本区动作意图放`intent`，子记录编辑放`record`，动作放`command`。`submission`表达用户此时准备提交的准确业务内容，不含正式请求编号或版本包装。
- `payload`只允许约定键，带`schemaVersion:1`与独立页面`instanceId`，目标记录/阶段可带`target`。1MiB按规范UTF-8正文计算；HTTP请求包装上限1100000字节。
- 同序号、同基线、同正文重放返回已确认修订。其他更新必须满足草稿修订与序号检查；项目过期不自动改草稿基线。
- 仅本页自己的已确认正式回执可为其他范围草稿提交`rebaseOperationId`；服务端核对账号、项目、页面实例、前后版本以及当前项目版本。其他标签不得借同账号回执改基线。

## 正式保存携带草稿

范围保存、新建及阶段/生命周期动作可附带`draft:{clientDraftId,draftVersion}`。原请求指纹包含该引用，查询结果或重试仍须使用原正文。

结果可带`draft:{clientDraftId,draftVersion,instanceId,state}`，其中`state`为`committed`或`preserved`。只有同范围、同基线、同修订且规范化提交正文匹配的草稿才在正式事务内标记committed；新输入或不匹配稿保留。这个结果不等于其他区域已经保存。没有草稿引用的旧请求继续按既有指纹处理。

## 偏好地址

账号共用scope为`appearance`、`summary-layout`，`deviceKey`固定`account`。设备阅读上下文scope为`board/checks/summary/detail`，`deviceKey`为独立UUIDv4。`value`必须带`schemaVersion:1`且只含对应scope白名单键。版本冲突不自动合并或重放旧值，客户端重新读回后等待明确新操作。

当前页面协议：`appearance.theme`为`dark/light/warm`，`layout`为`cards/progress`，对应既有卡片和进度布局。`page`为正安全整数，`scrollY`为非负有限数；显示开关必须是布尔值；`view`沿项目列表五种范围。客户端只把本次明确改变的偏好键叠加到已读取的服务器版本，不能因改主题覆盖并发更新的布局。返回位置缓存按账号隔离。

## 可恢复结果

| 结果码 | HTTP | 客户端处理 |
| --- | --- | --- |
| `INVALID_PERSONAL_STATE` / `INVALID_DRAFT_REFERENCE` / `DRAFT_SCOPE_MISMATCH` | 400 | 保留输入，核对范围和结构，不截断或改写为正式数据 |
| `DRAFT_NOT_FOUND` | 404 | 只表示本人范围内未找到，不能据此查询其他账号 |
| `DRAFT_VERSION_CONFLICT` / `DRAFT_BASE_CHANGED` / `DRAFT_TERMINAL` | 409 | 停止该旧稿自动覆盖，保留本机输入，提供核对/新副本入口 |
| `DRAFT_TOO_LARGE` | 413 | 已有远端稿保持；保留输入供复制、导出或精简 |
| `DRAFT_CAPACITY_REACHED` / `DRAFT_VERSION_EXHAUSTED` | 422 | 不自动删稿；用户明确整理或联系维护人员 |
| `PREFERENCE_VERSION_CONFLICT` | 409 | 重新读取该scope；当前页面不被迟到偏好强行重排 |
| `PROJECT_READ_ONLY` / 身份失效 | 403 / 401 | 停止新同步，启用中的原作者仍可读取自己的旧稿 |
| 断网、超时、结果未知 | 以实际响应为准 | 不宣称同步成功；保留原序号和正文核对/重放。正式保存未知继续走原业务回执 |

前端接入与全部失败路径尚在施工，不能把此协议存在当作所有页面已验收。
