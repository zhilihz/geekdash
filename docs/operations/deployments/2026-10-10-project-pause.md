# E04-B05暂缓恢复测试部署

2026-10-10；固定实现2880b6ebbd723fd9ba59e4e634ff9596f8cd362c已合并并回读远端main。本机41860与新加坡[geekdash.zhiluan.cool](https://geekdash.zhiluan.cool)同一干净project-pause / 0002-trial-save。只使用合成数据，原始真实备份未接入；后续文档SHA不代表镜像变化。

## 固定产物

| 项目 | 实测值 |
|---|---|
| 镜像ID | sha256:5f26fa337bc21eec427815c203c6d20d6118231827d788a6d4f0a9bb22591484 |
| image归档SHA256 | 895d61cc156e241e9f60de3fbb38f71c3585efbc5e7919c3c245ed55c146cf65 |
| release归档SHA256 | ecd449f119100c2abf7105376e02984d225e919c9cbb245bdea2cc7342470b94 |
| 发布标签 | project-pause-2880b6ebbd72 |
| 云固定目录 | /opt/geekdash/releases/2880b6ebbd723fd9ba59e4e634ff9596f8cd362c |

## 升级和数据保持

云新预检为a7d281d/B04、19容器。归档白名单、摘要、固定Linux非root镜像核对，两库实际结构核验及十类隔离回归通过后才短停自身app，备份两库并逐表比对dev指纹，再启动固定app/live/ready和提升current。没有迁移、初始化、种子或改密；0001/0002原摘要保持，两库34表/314列/55外键。

[部署证据](../../evidence/2026-10-10-project-pause-deployment-check.json)确认dev数据字节指纹保持，test计数恢复，MySQL ID/启动时间与其他17容器保持。云应用约33.73MiB/256MiB、MySQL552.9MiB/768MiB，available659MiB，app OOM=false/restart=0；是当时采样，未全局清理其他Node或数据卷。[本机运行](../../evidence/2026-10-10-project-pause-local-runtime-check.json)另核对live/ready及OOM，没有把Windows进程工作集大小当溢出。

云内B05五组124及既有九类回归通过，500项目四会话320请求零错误、第501可创建。列表/详情/保存/历史P95=194/100/113/49ms，[容量](../../evidence/2026-10-10-project-pause-cloud-capacity-check.json)。环回结果不证明公司公网稳定200ms。已验证代码能力/原生页面缺口归[报告](../../testing/reports/2026-10-10-project-pause.md)，B09页面要求保持。

## 备份与回退入口

- 本机D:\geekwon\geekdash-data\backups\pre-project-pause-2880b6ebbd72.sql.gz，12719字节、SHA256 5281be478b5e332afd551184f6f6aeca5dd5ff0d83dc7480011b31773da38579，短停本项目app，MySQL保持；[核对](../../evidence/2026-10-10-project-pause-local-backup-check.json)。
- 云/var/backups/geekdash/pre-project-pause-2880b6ebbd72.sql.gz，28304字节、SHA256 ce038276659ddcf583e257621c8a9451b0dbcc5b5e17d7cd374b63592ec8974a。
- 两份含dev/test所有表及routines/events/triggers；仅生成/摘要/内容核对，尚未隔离恢复、外部副本或定时备份，原数据不进Git/归档。
- 无结构变化，回退可使用原a7d281d固定release。先读取当前事实/原结果，不删除项目、覆盖数据库、重跑初始化或改密。B05新事实、审计与回执必须保持。

## 公网与运行恢复

两名可信负责人在公网新合成项目12完成提案/进行中暂缓恢复、普通信息保留、说明更正/清空/无变化、真实S1启动S2和暂停中阶段日期纠错、恢复同次明确改计划及旧版本拒绝，当前v17/进行中/S2进行中。当前计划比原始向后5天，原首次应检周保持；没有制造检查。新详情/历史/看板范围统计和16项资源逐字节核对通过，[公网证据](../../evidence/2026-10-10-project-pause-public-check.json)。API和资源核对不代表原生页面实点。

实际云app于03:17 UTC停止/启动，MySQL和其他17容器保持，数据行数保持，OOM=false/restart=0；[进程恢复](../../evidence/2026-10-10-project-pause-restart-check.json)。原会话/完整详情v17/17条历史/公共规则及14个原动作结果的重启后新请求核对通过，见[公网恢复](../../evidence/2026-10-10-project-pause-restart-public-check.json)。整个E04仍进行中，B06～B09、公司实际使用和隔离恢复尚未完成。
