# E04-B08节点D/E固定测试部署

2026-10-10；本机41860及新加坡https://geekdash.zhiluan.cool运行干净2a342d66bee15248ad382d2c0050ebe01730a6e7 / project-nodes-recovery / 0003-node-recovery，构建2026-10-10T09:49:08.536Z。源已合并并回读远端main，后续文档提交不是运行镜像。

## 产物与结构

- 镜像：sha256:24c5c9704a61d0349ff2f1859001a2478e469daa9079790b02adea099e73102a；Linux/amd64，node用户；GitHub测试预发布project-nodes-recovery-2a342d66bee1。
- 镜像归档SHA256：ce09a8dbb723aabfef5a5b0aa22099a417afc8abf2c628dc2d2b7775b36e95f1；发布小包SHA256：e96c30bbeac5cb19920a292b453788d0143f3fbb14dadd92e9d93c809416285d，云包严格15脚本清单。
- 两端两库仍34表/315列/55外键、三份原迁移历史；本批无DDL，仅结构verify。0001/0002/0003原资源及登记时刻保持。
- 升级前后完整dev字节指纹/来源ID/当前连线/二进制回执、test自身夹具计数保持；MySQL ID/启动时间及云其他17容器保持。实际证据见[本机](../../evidence/2026-10-10-project-node-recovery-local-deployment-check.json)、[云部署](../../evidence/2026-10-10-project-node-recovery-cloud-deployment-check.json)。

## 验证与资源

固定本机及云端六组217请求/原节点164，实际旧2dfb17c镜像导出服务同测试库回退/再升级保持。云15条脚本含普通容量，另执行新混合容量；完整命令均退出0，准确范围见[固定](../../evidence/2026-10-10-project-node-recovery-fixed-check.json)、[云回归](../../evidence/2026-10-10-project-node-recovery-cloud-regression-check.json)。TAT输出Dropped=2394但原任务SUCCESS/exit0，完整36851字节事实文件只读压缩取回并验长度，未重复安装；PE-002记录。

500项目/3500阶段/2000物理节点（1500有效、500已删）/1000风险/1580检查，四会话1200测量零错误，第501可读。云列表/已删读取/恢复保存/删除保存P95=283/42/90/94ms，另一普通容量列表227ms；均环回，列表仍未稳定200ms。工具256MiB/旧堆96MiB结束RSS约228MiB，app约34.5MiB/256MiB，无OOM。Node主机采样23进程合计305.2MiB、最大45.2MiB，自身工具正常退出，无全局kill/prune/删卷，[资源](../../evidence/2026-10-10-project-node-recovery-memory-check.json)。

## 公网实际回退、恢复与重启

新合成项目17：A→B→C和客户节点完成→删除B及客户节点→另一负责人A→C新线，v8有效2、已删2。实际常驻app切换兼容2dfb17c后ready/两原会话/完整详情/审计保持，6旧结果可确认，2新D/E正文400明确未知；保留原编号/正文，[回退公网](../../evidence/2026-10-10-project-node-recovery-fallback-public-check.json)。

首次回退后全库指纹读取遇健康cp临时文件窗口推断，未完成对比，不能补称初次全库通过。独立自身空配置文件复现NO密码错误，实际健康文件/凭据不改；改辅助长读使用640稳定secret，先核对实际旧app/ready再同步current链接，按停点重新升级。重新升级两库全部字节/行数/三历史及MySQL/其他17容器保持，[再升级](../../evidence/2026-10-10-project-node-recovery-reupgrade-check.json)；PE-011记录来源、推断边界及恢复入口。

升级后原8结果恢复，再明确恢复原B及客户ID、再次删除B再恢复：v11有效4、已删0，原完成日/成果/客户备注保持，B无旧线，A→C后来新线保持；无自动阶段/计划/灯色/检查。[公网](../../evidence/2026-10-10-project-node-recovery-public-check.json)及16项HTML/JS/CSS固定字节一致，原生实点未验。

实际app stop/up，同镜像新启动时刻2026-10-10T10:18:41.098964927Z；原两会话/项目17详情/已删页/审计/公共规则及11原结果新请求保持。原项目16/v13/五节点/一风险/30历史及两原会话/14原结果也保持。MySQL及其他17容器未重启，无OOM，[重启](../../evidence/2026-10-10-project-node-recovery-restart-check.json)、[新项目原结果](../../evidence/2026-10-10-project-node-recovery-restart-public-check.json)、[原项目](../../evidence/2026-10-10-project-node-recovery-original-public-check.json)。

## 备份与回退入口

- 本机两库完整逻辑备份：D:\geekwon\geekdash-data\backups\pre-node-recovery-2a342d66bee1.sql.gz，15236字节，SHA256=fcca173335ea94cc5fb2a853ac4020006ecdceb08078611420d73b816013e33f。
- 云两库初次备份：/var/backups/geekdash/pre-node-recovery-2a342d66bee1.sql.gz，55246字节，SHA256=d9e3c9b9ab9c40bc672e85867becd83b305bd49312e712d52df9198a82ce8a8d。
- 云短停app前备份：/var/backups/geekdash/pre-dev-node-recovery-2a342d66bee1.sql.gz，55251字节，SHA256=0a81ac333e99e7b39d0d3b09aae7a3810ba70d3969a2c0337208ad5b4ff68ba7。

备份含routines/events/triggers，两库文件完整核对，隔离恢复与服务器外副本仍未执行；不能称完整恢复验收。真实用户备份不导入。应用回退使用0003过滤兼容固定2dfb17c；不能运行旧0002、清卷或覆盖发布后数据。回退不识别新D/E正文，应保留同一编号/原文，恢复新版本后确认。current最终指向/opt/geekdash/releases/2a342d66bee15248ad382d2c0050ebe01730a6e7；私有TAT及辅助文件仅用于停点恢复，不能盲重跑安装或初始化。

节点D/E固定部署与HTTP链路完成；需求变更及B09仍未完成。原生表单/图/拖动沿AD-007因工具URL策略待验，HTTP和资源摘要不代替页面验收。正式使用和真实导入仍按相应未完成范围执行。
