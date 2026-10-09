# 公共检查规则 API

来源：src/server/routes/settings.ts、modules/public-settings.ts；2026-10-09 E04-B02/F08-A。行为仅引用SPEC-019；现阶段初始化，后续调整依B07。身份与CSRF沿[项目主干](project-core.md)。

- GET `/api/settings/check-rule`：可信账号读取configVersion、canMaintain、rule、businessDate、weekStart、deadlineDate、firstCheckWeek。配置/规则未建返回null，不能把周五建议当已保存规则。
- POST `/api/settings/check-rule`：`{action:"initializeCheckRule",deadlineWeekday:5,expectedVersion:"1",previewWeek:"2026-10-05",idempotencyKey:"UUIDv4"}`；星期为整数1～7，其余版本/日期/编号沿严格白名单。仅配置中的专用维护账号保存。
- POST `/api/settings/check-rule/results/query`：原完整正文/编号确认，committed/result或not_found。原账号作用域，原编号正文变化409；后来配置改变也不改原回执。

成功200/result包含operationId、savedVersion、ruleVersion、deadlineWeekday/effectiveWeek；实际代码协议为准。配置版本、规则修订、设置审计和回执同一事务。403 MAINTENANCE_REQUIRED、409 SETTINGS_VERSION_CONFLICT/CHECK_PREVIEW_CHANGED、422 SYSTEM_CONFIGURATION_REQUIRED/CHECK_RULE_ALREADY_INITIALIZED；所有未提交错误保持原规则。503 unknown沿原请求确认；设置不增加项目版本或自动生成检查。
