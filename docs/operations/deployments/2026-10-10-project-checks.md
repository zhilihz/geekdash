# E04-B07检查链路测试部署

2026-10-10；固定实现 4974e0f4cbc844321e1b7da6da7c0006428c0f32 已合并并回读远端main。本机41860和新加坡 [geekdash.zhiluan.cool](https://geekdash.zhiluan.cool) 同一干净 project-checks / 0002-trial-save。仅合成数据，真实备份未接入；后续文档SHA不代表运行镜像变化。

## 固定产物

| 项目 | 实测值 |
|---|---|
| 镜像ID | sha256:2029b8ba88825ac650bd703e0e92a30711a8cf25ada27be41e346134bd850bf0 |
| image归档SHA256 | c98173a4e76b37d66302aa9cd6fa7b1c211ec5b9ed69e79a1c24984409fb01e4 |
| release归档SHA256 | 63c638d165bc0f44a654fb3f409b2a2bdb73078ac411c037c81a107792650548 |
| 发布标签 | project-checks-4974e0f4cbc8 |
| 云固定目录 | /opt/geekdash/releases/4974e0f4cbc844321e1b7da6da7c0006428c0f32 |

## 升级和数据保持

预检为B06/21cdfb4、19容器。哈希、固定包12项验证脚本、Linux非root镜像及两库结构核对后，云内串行执行12类回归，再执行带检查历史的容量模式；全部通过才短停自身app、备份两库和核对dev各表字节指纹，更新固定app并提升current。没有迁移、初始化、种子或改密，两库34表314列55外键及0001/0002原摘要保持。

[部署证据](../../evidence/2026-10-10-project-checks-deployment-check.json)确认dev指纹、test初始行数、MySQL ID/启动时间及其他17容器保持。云应用34.61MiB/256MiB、MySQL569.6MiB/768MiB，available671MiB，OOM=false/restart=0，均为当时采样；[本机运行](../../evidence/2026-10-10-project-checks-local-runtime-check.json)固定live/ready通过。本轮Windows采样14个Node进程合计165.5MiB、最高24.9MiB，未发现溢出，未全局终止/删卷/prune。

本机固定和云内专项均9组251次HTTP通过，含原SQL毫秒对照及40次并发历史读；[固定核对](../../evidence/2026-10-10-project-checks-fixed-check.json)。工具容器256MiB、V8旧堆96MiB下，500项目1580检查/500文字纠错、四真实会话480测量请求零错误，第501项目允许；云结束RSS222.4MiB。列表/详情/普通保存/审计/检查保存/检查历史P95=295/103/79/38/77/52ms，[带检查历史容量](../../evidence/2026-10-10-project-checks-cloud-capacity-check.json)。旧基线列表P95=190ms；稳定200ms与公司公网体验仍未验收，B09需实测SQL定位。

固定本机首次复测曾出现一次未复现的毫秒边界断言失败，五轮及增强本机/云验通过，根因仍未确认，保留PE-20261010-004/AD-011，不称已修复。辅助包名称替换漏旧结案测试在安装前修复，固定新小包及12项清单均校验；旧小包留仓库外，镜像及数据库未因此重建，见[打包错误卡](../../evidence/codex-runtime-errors.md#pe-20261010-005-阶段包清单替换)。

## 备份和回退

- 本机 D:/geekwon/geekdash-data/backups/pre-project-checks-4974e0f4cbc8.sql.gz，12723字节、SHA256 43893b6cac1d4e61cb9550759d076471515bfa37e437acf5a1e15679c2e3f437；[核对](../../evidence/2026-10-10-project-checks-local-backup-check.json)。
- 云 /var/backups/geekdash/pre-project-checks-4974e0f4cbc8.sql.gz，41112字节、SHA256 dde7163ff90dd66bd76e529dd39e135b06507695d46c4db42063e5f7813c9dbd。
- 两库完整逻辑备份含全部表及routines/events/triggers；字节/内容核对完成，隔离恢复、外部副本及定时备份尚未执行。原备份、凭据及Cookie不入Git。
- 无结构变化，可用原21cdfb4固定release回退应用；新检查、设置修订、纠错、审计及原回执保持，先读实际状态，不重跑初始化/改密或覆盖库。旧构建不能显示本批有效检查纠错/修改入口，需恢复到本批固定镜像后继续使用。

## 公网和真实应用恢复

公网新合成项目14由business01/02贯通提案检查→S1开始/完成→人工启动→另一人检查→原/最新文字纠错/同值→普通更新与旧版409→再次核对→暂缓/终止结案/维护主动检查。共同截止周五→周日→恢复周五，本周立即重算，旧规则表单409，项目版本和首次义务保持；最终规则周五。

最终v17/已结案维护/实际5%，6条检查、17条项目审计；原文/有效备注、原人/时间/周/规则和版本保持。新详情/分页/审计/维护看板与统计、16项HTML/JS/CSS逐字节通过，[公网证据](../../evidence/2026-10-10-project-checks-public-check.json)。验证脚本用原编号/正文检查点，读请求按有限重试恢复，不反复创建项目。

实际云app于06:08 UTC停止/启动，[进程恢复](../../evidence/2026-10-10-project-checks-restart-check.json)确认持久行数、MySQL及其他17容器保持、无OOM。三个原会话、完整详情/检查/审计/设置和21个原创建/普通/责任/检查/生命周期/设置结果重启后新请求保持，[公网恢复](../../evidence/2026-10-10-project-checks-restart-public-check.json)。原生页面实点因既有工具URL协议拒绝仍未通过，AD-007保留B09；完整E04仍接B08/B09，公司实际体验及完整备份恢复未完成。
