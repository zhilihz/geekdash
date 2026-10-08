# 未完成任务交接

更新时间：2026-10-08；当前单元：E01-F04 已实现、验证，正在完成 Git 与干净镜像交付；下一单元 E02 身份基础。

## 1. 工作位置与目标

仓库 https://github.com/zhilihz/geekdash.git ，本地 D:\geekwon\geekdash；施工分支 codex/e01-app-readiness，基线 main / 141e440060f6a60c3ac1179f66a21959143680be。电脑重启后五份讨论文档保留，F04 在此接续；实际状态读[系统真相第 21 节](../status/current-system-truth.md#21-重启恢复与-e01-f04-实际实施2026-10-08)。写代码使用 ponytail full，纯讨论/文档不延续。

## 2. 已完成与证据

- F01～F03 历史交付已在远端 main，F04 已通过构建、F01 回归、专用测试库故障检查以及真实 Docker 断库/恢复/停止应用，见[F04 报告](../testing/reports/2026-10-08-e01-f04.md)。
- 数据 D:\geekwon\geekdash-data\mysql、密钥同总目录 secrets；不打印或提交。两库业务数据为空，没有五个登录账号，没有导入真实备份。镜像保留原 Docker 数据盘；其他项目容器保持原停止状态。
- 运行只能用组合入口 database.ps1，app 只挂 dev_app；构建用 docker.ps1。命令与测试范围归[发布维护](../operations/release-maintenance.md)，协议归[API](../specifications/api/foundation.md)。
- 本单元尚未提交的代码/文档用 git status 核对；忽略的 test-results 保留原始日志和收尾脚本。验收记录已经产生，提交与镜像 SHA 待完成后写真相和证据。不可删除现有修改。

## 3. 接手步骤

1. git status、fetch main，核对当前分支、容器、D 盘挂载；旧交接不是实时证据。
2. F04 收尾：审查差异/文档链接/密钥扫描，提交；从干净代码重建本地 app，读取 live 构建 SHA、dirty=false 及 ready=200；推送施工分支、合并远端 main 并回读，登记实际事实。
3. E02 按 SPEC-001/019 继续逐功能展开：先受控五账号初始化及首次改密，再可信登录会话；不把数据库技术身份当使用者账号。逐步验证真实 MySQL 持久化、新请求、旧会话失效及错误反馈。
4. E03 按 SPEC-002/014 贯通负责范围、版本、事务/审计和新请求消费；后续按执行文档接能力，测试后审查真实备份，最后才公网交付。

## 4. 未完成与恢复边界

身份、业务、六页面接入、四人业务负载、含数据升级、全量备份恢复、新加坡 DNS/TLS/部署均未实施或验收，不因 E01 通过宣称可用。用户已确认规则按规格/决策引用，不重问已有选择；尚未批准自动化须先完整讲解该块规则。剩余业务和运维待决按 decisions 的 Q 索引接续。

故障脚本仅在无人使用的 geekdash_test 改登记/外键；失败后先 db:verify，不清开发数据。0001-foundation 已应用，字节校验和禁止回改；新版本新增迁移和含数据演练。轻量 ready 不是全量结构巡检，也不是备份恢复。原始 source-review、test-results、dist、真实备份和凭据不得进入 Git。服务器未更新，Git 推送不代表部署。
