# E04-B01 阶段开始与完成固定测试部署

日期：2026-10-09；既有新加坡测试机，入口 https://geekdash.zhiluan.cool 。本批为F01-A/B，原面板卡片复用；准确功能、验证及限制归[阶段报告](../../testing/reports/2026-10-09-stage-actions.md)。真实备份未接入。

## 1. 固定产物与代码

- revision `3ec251d79076ed9a64640e5068c98e11439e373a`，dirty=false，stage=stage-actions，schema=0002-trial-save，builtAt=2026-10-09T10:38:12.241Z。该实现已推送并回读远端main；文档收尾提交不改变运行镜像。
- 镜像ID `sha256:186ffc93e48e711f7eaaffc72a7cb3c15cec172ed03cb817fde53c6896d04f40`，linux/amd64，常驻非root node；沿用app256MiB、MySQL768MiB。
- GitHub私有预发布tag `stage-actions-3ec251d79076`；镜像归档85,417,843字节，SHA256 `fbd1539d3b5cb3bcd77d9fe0110b00dc6782adbee4e8fd32e0dd83495eb63bf1`；部署包24,932字节，SHA256 `b52ea690bbd5cab242aabdb1b48aa0322ff2ed8691fb2fe035dc005eebf94862`。
- 云端`/opt/geekdash/releases/3ec251d79076ed9a64640e5068c98e11439e373a`，current已提升；仅本项目app通过既有Nginx/TLS。宿主SQL端口仍未开放。
- 本机41860已更新相同镜像，MySQL继续使用D盘目录。两库仍34表/314列/55外键；0001/0002资源摘要保持，无初始化、种子或迁移操作。

## 2. 实际升级与恢复

1. 干净构建及归档校验，云端预加载；两库真实结构和六类隔离验证通过。夹具逐表计数恢复，业务库未作为测试库。
2. 首次升级在停自己app后，旧辅助脚本把BINARY回执哈希解码为UTF-8而失败。立即启动旧6aee827服务并核对ready/真实镜像；存在一次应用中断，不能记录成无停机升级。随后接续脚本在停应用之前遇到已有验证目录及查询报告无顶层status的检查错误；均停在切换前，未重复写库。
3. 核对既有验证结果、release、current、MySQL状态，字节读取先在旧app在线时验证；再短暂停自己app、完整备份两库。所有业务表原字节指纹及资料计数保持；没有重放迁移、账号初始化或改密。
4. 只更新app，确认固定构建/ready/匿名业务401，提升current；MySQL及其他17容器ID/启动时间保持。失败停点与复用方式见[PE-20261009-005](../../evidence/codex-runtime-errors.md#pe-20261009-005-二进制数据指纹与升级接续)。
5. 用原有两测试账号创建新的合成项目8，公网实际开始、加入、旧版拒绝、完成与新请求消费通过；未操作既有项目7。随后实际停止/启动app，原会话、阶段事实、回执及4条审计保持。

[固定部署证据](../../evidence/2026-10-09-stage-deployment-check.json)、[公网](../../evidence/2026-10-09-stage-public-check.json)、[进程恢复](../../evidence/2026-10-09-stage-restart-check.json)、[恢复后公网](../../evidence/2026-10-09-stage-restart-public-check.json)。

## 3. 备份、数据和凭据

- 云端发布前完整两库逻辑备份`/var/backups/geekdash/pre-stage-actions-3ec251d79076.sql.gz`，16,435字节，SHA256 `59a1b28e68b9a9693e8f40acb6a04b73ea7f17377614a0ba130827ec5aa4abed`；包括表、routines/events/triggers。gzip/表结构校验通过，尚未隔离恢复。
- 本机备份使用既有受控目录`D:/geekwon/geekdash-data/secrets/pre-stage-actions-3ec251d79076.sql.gz`，12,702字节，SHA256 `a2e739346fc96e1a12aa9f603d8efc6b4f296060dac8f5638977bc2ac0765936`；完整单事务快照核对通过，未改变目录权限。[本机证据](../../evidence/2026-10-09-stage-local-backup-check.json)
- 备份均在本轮后续公网验收之前。禁止用发布前备份覆盖随后保存事实；新旧同0002，故障先保留库/回执，诊断并做兼容前向修复，必要时按既有固定镜像流程回退应用。没有自动恢复数据库。
- 沿用E03已开通账号及原当前密码，本机/云端独立；具体交付归[E03部署](2026-10-09-project-core.md)。本批不重新生成账号或凭据，Cookie/操作恢复正文/备份未进Git或镜像。
- 原三个trial与E03验收项目7保持，新增合成项目8为business01/02共同负责、提案/S1完成/S2待开始/v4。它可能被人工试用，后续核验先读当前值，不强行重置。真实业务备份未导入。

## 4. 运行观察与边界

UTC10:53:31采样：app32.76MiB/256MiB，MySQL542.5MiB/768MiB，available689MiB、swap已用1987MiB，freeDisk约16.8GB；OOM=false、自动重启计数0。这些是采样，未证明长期资源余量。

UTC10:56:05实际app重启后，ready及构建正确；原持久会话、项目v4、原开始v2/完成v4回执与4条审计保持，其他17容器及MySQL启动时间保持。公网13项资源与固定构建逐字节相同，[摘要](../../evidence/2026-10-09-stage-assets-check.json)。页面交互已用本地合成库实际核验，公网浏览器完整联验未执行。

云内500项目四会话320请求0错误，但列表P95=1862ms，稳定200ms未通过。下一性能工作先定位实际SQL与共享主机波动；本批不增加Redis或项目硬上限。公司公网四人真实使用、SSE、服务器私人稿、B02人工启动及B03～B09能力仍后续。
