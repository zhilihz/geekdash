# E04-B04 日期与计划测试部署

2026-10-10；环境为独立本地GeekDash与现有新加坡共享测试机，公网[geekdash.zhiluan.cool](https://geekdash.zhiluan.cool)。固定实现a7d281d8b7966e60ec50aa7685007ce26dc47a7a包含日期施工5d44610及远端1051更新，已回读远端main；后续纯文档提交不代表镜像改变。只使用合成数据，真实备份未接入。

## 固定产物与更新

| 项目 | 已核对值 |
|---|---|
| build | project-dates / dirty=false / 0002-trial-save |
| image ID | sha256:d665803d39caef088bd20bc5866410ec1c5705ac1611fe79d5d30a3ea3076066 |
| image归档SHA256 | 2a5cc99143a60cfe0cdbed23469c9a01bd25def2fa5bac1c395b55faee9e01e2 |
| release归档SHA256 | 89a21a716c324380715b205bfb1ea38cecd1749d7b72cbaffd112fe25dfa951f |
| 发布标签 | project-dates-a7d281d8b796 |
| 本机入口 | http://127.0.0.1:41860 |
| 云固定目录 | /opt/geekdash/releases/a7d281d8b7966e60ec50aa7685007ce26dc47a7a |

重新读取云前置为B03/af5de71、19容器。验证归档白名单/摘要、固定非root Linux镜像，执行两库真实结构核验与九类隔离测试后，仅停止自己的app、生成两库备份并核对dev逐表指纹，启动新固定app/live/ready，再提升current。没有迁移、种子、初始化或改密；0001/0002原摘要保持，两库34表/314列/55外键。

[部署证据](../../evidence/2026-10-10-project-dates-deployment-check.json)确认dev既有字节指纹保持、test逐表计数恢复、MySQL ID/启动时间及其他17容器保持。更新后app33.62MiB/256MiB、MySQL543.9MiB/768MiB、宿主available699MiB；没有OOM或额外重启。此为当时采样。

## 备份与恢复入口

- 本机D:/geekwon/geekdash-data/backups/pre-project-dates-a7d281d8b796.sql.gz，12716字节，SHA256 b8343c2f77dd7f678d29e841969288c465edd96a29e76adfd044cc22ad93a6d5；[本机核对](../../evidence/2026-10-10-project-dates-local-backup-check.json)。只短停本项目app，MySQL保持。
- 云/var/backups/geekdash/pre-project-dates-a7d281d8b796.sql.gz，24332字节，SHA256 bb5da27171652a732c1c35acd45d94f980b407fad489d521adf96b292baf2a59。
- 两份均含dev/test所有表及routines/events/triggers；仅完成生成、摘要和内容核对，尚未隔离恢复、外部副本或定时备份。备份不进Git或发布归档。
- 无结构变化，app回退可使用原af5de71固定release；先读取当前事实及原操作回执，不能删除项目、覆盖数据库或重跑初始化解决页面问题。新写事实、审计和原回执必须保留。

## 已验证与待验

固定本机五组287日期请求通过。云内日期5组287、纠错6组87、启动6组76、阶段7组57、核心8组66及普通/旧保存/读取/容量共九类通过；500项目四会话320请求零错误，第501可创建，列表/详情/保存/历史P95=180/89/105/34ms。这是云内环回，不能替代公司公网体感或长期200ms目标。

公网新合成项目11由两名负责人贯通首次/同值/说明/提前与向后/历史更正撤销/未定补充/日期纠错/旧版409，当前v13/提案/S1待开始/进度0%；原始日期保持未知，未知改期单列。新详情/历史/看板/原回执身份隔离与16项固定资源通过，[公网证据](../../evidence/2026-10-10-project-dates-public-check.json)。旧项目与真实备份未更改。

实际app进程于02:34 UTC停止/启动，持久业务行数、MySQL ID/启动及其他17容器保持，无OOM/restart。[进程证据](../../evidence/2026-10-10-project-dates-restart-check.json)；重启后用原会话确认完整项目v13/公共规则/13条历史及11个原动作结果保持，[公网回读](../../evidence/2026-10-10-project-dates-restart-public-check.json)。重启前首次只读TLS连接EOF中断，未执行服务器写操作，原路径重读成功后才重启；没有降低TLS校验或重复新业务动作。

原生页面实点受工具明确拒绝未通过，B09仍需联验。B04测试更新不代表完整E04交付。
