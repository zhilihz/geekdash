# E04-B02 人工启动测试部署

日期：2026-10-09。代码9185d67与独立1051追加集成，固定运行5aae00f07428151df57d098eba873ddb2feaa067；已合并并回读远端main。后续纯文档提交不改变本镜像。验收范围只归[报告](../../testing/reports/2026-10-09-project-start.md)。

## 产物与环境

- 本机41860和新加坡https://geekdash.zhiluan.cool：干净project-start，schema0002。现有0001/0002未改，无增量迁移，两库34表/314列/55外键。
- Linux/amd64镜像sha256:88476868ca1fd4ead9186a9c970b9e6ef00518679f81a5b6d710d1c35d9415d6；镜像归档85420210字节，SHA256954529ecb40e2369179d02a0463435ff15264c9b72d002745a824c49baa0a85f。
- 运行包27489字节，SHA256c379b9f1e42b8d398404a177c109dd6359f95970fca83138cfbd44a60ab6306b；GitHub预发布project-start-5aae00f07428。
- 升级前新读旧服务/资源，校验镜像和归档、Linux配置及逐文件摘要；新镜像七类回归完成后只停止本项目app，核对两库备份/字节指纹再更新。MySQL与其他17容器启动时间保持，已有数据与配置不清空。实际[部署证据](../../evidence/2026-10-09-project-start-deployment-check.json)。

## 数据与凭据

- 云发布前备份/var/backups/geekdash/pre-project-start-5aae00f07428.sql.gz，17775字节，SHA256ddf1327f78f3cc55ccce62fb4ca6d1f3202af8152171b248adb65879a7347d4f，权限600。两库含routines/events/triggers；尚未隔离恢复。
- 本机D:/geekwon/geekdash-data/secrets/pre-project-start-5aae00f07428.sql.gz，12710字节，SHA256f41db0770ac8de31433389d3159098deab68c09fa5366f63aa5ac1f82494e58d；[备份核对](../../evidence/2026-10-09-project-start-local-backup-check.json)。受控文件不入Git。
- 云maint01由实际验收首次改密；business01/02及maint01分发须使用仓库外交付文件currentPassword，business03/04仍需首次改密。不得重置已试用账号或打印凭据。
- 公网合成项目9由business01/02负责，当前v6/S1完成/S2进行中；原启动回执v5。原项目7/8及trial保留，后续复核先新读，不重放新编号动作。

## 恢复与边界

实际app重启后原会话、项目/规则/历史与原回执一致，见[重启回读](../../evidence/2026-10-09-project-start-restart-public-check.json)。本批schema兼容，必要时回到上一固定3ec251d应用镜像并新读验证；恢复不能清空MySQL或撤销已发生启动事实。完整流程归[发布维护](../release-maintenance.md)。

收尾云available679MiB，swap已用1987MiB，app34.17/256MiB、MySQL542.1/768MiB，无OOM；仍需持续观测。云内500四会话0错误，列表P95=165ms，不等同公司公网体验。真实备份导入、完整隔离恢复、公网全部页面联验及其余E04功能未因本批完成。
