# E04-B08节点A～C测试部署

2026-10-10；固定实现196405e1a6d6cf1bbeaaa99367289ee4fed01c02已合并回读远端main。41860及新加坡[geekdash.zhiluan.cool](https://geekdash.zhiluan.cool)同干净project-nodes/0002，后续文档及0003候选SHA不是运行镜像。仅合成数据，原生B09及D/E/0003/需求变更仍后续。

## 固定产物与运行

| 项目 | 实测 |
|---|---|
| 镜像ID | sha256:e611bd5b63363023753a4d2cd6b487ef53042042cb5c512b0f05e8e641809cff |
| image归档SHA256 | a25635ec6cbed7780cedffc93b87d8da9ebaeb814ff0287ea43952ee306fce39 |
| release归档SHA256 | 11c7ba2e489474e2a80dd2d1b6b9106f9af2b1032a2c7bd11cf75363b3402d55 |
| 发布标签 | project-nodes-196405e1a6d6 |
| 云固定目录 | /opt/geekdash/releases/196405e1a6d6cf1bbeaaa99367289ee4fed01c02 |

从风险5ae7ecc核对19容器，固定非root镜像/摘要/14项测试清单；云内串行回归及500混合全部通过后短停自身app、备份两库并核对dev字节指纹，更新/current切换。无迁移/初始化/种子/改密，两库34/314/55及原0001/0002保持；test计数/MySQL ID和启动时间/其他17容器保持，无OOM。[部署证据](../../evidence/2026-10-10-project-nodes-deployment-check.json)、[本机运行](../../evidence/2026-10-10-project-nodes-local-runtime-check.json)。

助手尾部读取旧风险容量文件名失败时，应用和current已切换。重新核对现场，使用实际节点报告补证据，未重复安装；原失败回执保持在私有test-results。发布包初次创建422是目标尚未推送，确认远端main后同产物创建成功；PE-008及PE-005分别记录顺序/模板漂移。

两端节点五组164真实HTTP/SQL新读/审计/写点回滚/COMMIT未知恢复通过。500项目/3500阶段/2000节点（1500真实新增）/1000风险/580风险纠错/1580检查/500检查纠错，四会话十类各80共800测量零错误、第501可读；工具256MiB/堆96MiB，本机节点预览/保存P95=35/76ms，云=45/74ms。云列表2290ms仍超200ms，继续B09实际SQL诊断。[固定验证](../../evidence/2026-10-10-project-nodes-fixed-check.json)、[云容量](../../evidence/2026-10-10-project-nodes-cloud-capacity-check.json)。节点操作没有自动改变灯色/阶段/计划/检查；环回不代表公司公网浏览器。

## 备份与恢复

- 本机 D:\geekwon\geekdash-data\backups\pre-project-nodes-196405e1a6d6.sql.gz，12723字节，SHA256 a69c57e382681ce2dd286258f03d4cd99d34d250fff669b9109ff7ab6f8ac729，[核对](../../evidence/2026-10-10-project-nodes-local-backup-check.json)。
- 云 /var/backups/geekdash/pre-project-nodes-196405e1a6d6.sql.gz，49652字节，SHA256 a32abe40fe1504beed1aa4474c4b3e044f9284ef94352bdc7203bb7f7a97aab8。
- 完整逻辑备份含两库全表/routines/events/triggers，已核对；隔离恢复和服务器外副本仍未执行。凭据/原备份不入Git。
- 当前无结构变化，可回退风险5ae7ecc，节点记录和原回执仍保留，旧版没有新操作入口。后续0003登记后旧0002启动即不兼容，按AD-015先形成兼容固定版再D/E，不能继续以本批无过滤镜像作为删后回退。

## 公网和真实进程恢复

公网新合成项目16由两负责人贯通普通文字/风险/四节点同次新增，前置拒绝/同次完成链、名称成果纠错/位置、明确依赖取消完成、重新完成、换前置清旧线和下游日期、同值、旧预览409/新读保存。最终v13/提案/0%，五节点/一风险/30审计，原成果、客户完成日及当前新关系保持；新详情/历史/看板及16资源逐字节一致，[公网](../../evidence/2026-10-10-project-nodes-public-check.json)。其他项目7～15未用于本轮写入。

实际云app停止/启动，[进程证据](../../evidence/2026-10-10-project-nodes-restart-check.json)确认持久计数、MySQL及其他17容器保持；2原会话/14原创建、责任与普通保存结果、完整节点/风险/详情/历史/规则新读保持，[原会话恢复](../../evidence/2026-10-10-project-nodes-restart-public-check.json)。云当时app34.41MiB/256MiB、MySQL590.2MiB/768MiB，无OOM/异常重启；本项目未发现Node溢出，不全局杀进程或删卷。原生页面既有工具URL策略拒绝仍沿AD-007，不绕过，公司实际体验/完整备份恢复/E04后续未完成。
