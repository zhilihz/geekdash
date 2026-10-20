# 公共检查设置兼容 API

来源：`src/server/routes/settings.ts`、`src/server/modules/public-settings.ts`；2026-10-20按SPEC-005/019、DEC-133核对当前代码。周检查设置已退出，新检查不再依赖规则配置。本页只记录旧接口兼容与回执读取协议；部署及实际验收状态归[系统真相](../../status/current-system-truth.md)，身份与CSRF沿[项目主干](project-core.md)。

## 1. 读取退役状态

`GET /api/settings/check-rule`，要求可信登录。返回：

```json
{"retired":true,"code":"CHECK_RULE_RETIRED","businessDate":"2026-10-20"}
```

`businessDate`取服务器上海业务日；不再返回`configVersion`、`canMaintain`、`rule`、`weekStart`、`deadlineDate`或`firstCheckWeek`。不要求初始化公共规则，不创建配置、规则或检查记录。

## 2. 旧命令及原回执恢复

保留以下两个入口，供已有客户端确认旧操作的实际结果：

- POST `/api/settings/check-rule`
- POST `/api/settings/check-rule/results/query`

两者仍只接受原来的五个字段：

```json
{"action":"modifyCheckRule","deadlineWeekday":5,"expectedVersion":"1","previewWeek":"2026-10-05","idempotencyKey":"UUIDv4"}
```

`action`为`initializeCheckRule`或`modifyCheckRule`；星期为整数1～7，版本为正十进制ID字符串，`previewWeek`为有效`YYYY-MM-DD`，编号为小写UUIDv4。缺少、增加或误填字段返回400/`INVALID_CHECK_RULE_COMMAND`。这些字段用于核对旧请求，不会重新启用周规则。

| 实际结果 | POST旧保存入口 | POST结果查询入口 |
|---|---|---|
| 当前账号作用域中存在同编号、同正文的已提交回执 | 200，`{outcome:"committed",result:原回执结果}` | 同左 |
| 同编号已对应不同正文 | 409/`OPERATION_KEY_REUSED` | 同左 |
| 没有原回执 | 410/`CHECK_RULE_RETIRED` | 200，`{outcome:"not_found"}` |

作用域继续使用`user:{actorId}:settings:check-rule`；正文哈希仍按原顺序`[action,deadlineWeekday,expectedVersion,previewWeek]`计算。原回执中的`operationId`、`savedVersion`、`ruleVersion`等旧结果按原值返回，不受后来日期、账号维护资格或设置变化影响；读取时仍校验当前可信且有效的账号。

以上兼容入口只读取旧回执，不写配置、规则修订、项目、审计或新回执，也不发送规则变更通知。会话失效、CSRF不符及数据库不可用沿共用协议返回，不能把未能读取解释为`not_found`。原始规则及已存历史由数据库迁移保留；新项目检查协议见[项目动作](project-actions.md)。
