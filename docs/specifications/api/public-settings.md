# 公共检查规则 API

来源：src/server/routes/settings.ts、modules/public-settings.ts；2026-10-10 E04-B07/F08。行为仅引用SPEC-019；初始化及本周立即生效的修改已编码，实际运行/验收归系统真相。身份与CSRF沿[项目主干](project-core.md)。

- GET `/api/settings/check-rule`：可信账号读取configVersion、canMaintain、rule、businessDate、weekStart、deadlineDate、firstCheckWeek。配置/规则未建返回null，不能把周五建议当已保存规则。
- POST `/api/settings/check-rule`：`{action:"initializeCheckRule",deadlineWeekday:5,expectedVersion:"1",previewWeek:"2026-10-05",idempotencyKey:"UUIDv4"}`；修改时仅把action改为modifyCheckRule；星期为整数1～7，其余版本/日期/编号沿严格白名单。仅配置中的专用维护账号保存。
- POST `/api/settings/check-rule/results/query`：原完整正文/编号确认，committed/result或not_found。原账号作用域，原编号正文变化409；后来配置改变也不改原回执。

成功200/result包含operationId、savedVersion、ruleVersion、deadlineWeekday/effectiveWeek；实际代码协议为准。配置版本、规则修订、设置审计和回执同一事务。403 MAINTENANCE_REQUIRED、409 SETTINGS_VERSION_CONFLICT/CHECK_PREVIEW_CHANGED、422 SYSTEM_CONFIGURATION_REQUIRED/CHECK_RULE_ALREADY_INITIALIZED；所有未提交错误保持原规则。503 unknown沿原请求确认；设置不增加项目版本或自动生成检查。

modifyCheckRule 要求规则已初始化，缺失返回422 CHECK_RULE_REQUIRED；本周保存成功后立即生效、以后沿用，历史周冻结。配置版本和规则版本分开，项目版本不批量增长。维护页保存前展示旧、新星期与本周影响供明确确认；服务端取配置独占锁后检查 expectedVersion / previewWeek，和启动/检查共享锁形成一致次序。

修改有变化时 result.changed=true，追加修订并增加配置版本、设置审计与回执；同星期 result.changed=false，只有回执，savedVersion/ruleVersion 保持。初始化原返回形状不变。原编号正文恢复不受后来规则/周变化影响；四个写点故障回滚和真实提交丢确认恢复已验证，来源见检查报告。
