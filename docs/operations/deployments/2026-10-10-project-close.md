# E04-B06结案链路测试部署

2026-10-10；固定实现21cdfb4ecf2d448bf7c0a8a4452c1952f96f343f已合并并回读远端main。本机41860与新加坡[geekdash.zhiluan.cool](https://geekdash.zhiluan.cool)同一干净project-close / 0002-trial-save。仅合成数据，真实备份未接入；后续文档SHA不代表镜像变化。

## 固定产物

| 项目 | 实测值 |
|---|---|
| 镜像ID | sha256:9d33da0eb8918b09d15ada5a7686767bf8e32db20b7ef42e0ca0001b2fb342a3 |
| image归档SHA256 | 19f8c0161ab77be53a72a9990340388a61392704231c01f45d63274ed2b384a8 |
| release归档SHA256 | 6c58b5803187eea05d8d676b47ac0903ba262f009366f46f36bffdcc9496c03e |
| 发布标签 | project-close-21cdfb4ecf2d |
| 云固定目录 | /opt/geekdash/releases/21cdfb4ecf2d448bf7c0a8a4452c1952f96f343f |

## 升级和数据保持

云预检为B05/2880b6e、19容器。核对包白名单、哈希、Linux非root镜像及两库结构，串行完成11类隔离回归后才短停自身app，完整备份并核对dev各表字节指纹，再启动固定app并提升current。没有迁移、初始化、种子或改密；两库34表/314列/55外键及0001/0002原摘要保持。

[部署证据](../../evidence/2026-10-10-project-close-deployment-check.json)确认test计数恢复、dev指纹保持、MySQL ID/启动时间和其他17容器保持。云应用34.66MiB/256MiB、MySQL554MiB/768MiB，available681MiB，OOM=false/restart=0，均是当时采样；没有全局清理Node或数据卷。[本机运行](../../evidence/2026-10-10-project-close-local-runtime-check.json)核对live/ready、固定镜像及OOM。

固定本机和云内B06均七组299请求通过；云内原十类回归通过。500项目四真实会话320请求零错误，第501可创建；列表/详情/保存/历史P95=220/73/127/39ms，[云容量](../../evidence/2026-10-10-project-close-cloud-capacity-check.json)。列表仍高于200ms目标，环回结果不能证明公司公网体验。代码能力与页面缺口归[结案报告](../../testing/reports/2026-10-10-project-close.md)。

发布资源首次下载618，服务尚未切换；重新取得短期链接后原归档下载/哈希核对成功，沿原固定产物继续安装。脱敏诊断与接续方法归[错误库](../../evidence/codex-runtime-errors.md#pe-20261010-003-发布资源短期链接)，没有重建数据或重复部署未知结果。

## 备份与回退入口

- 本机D:/geekwon/geekdash-data/backups/pre-project-close-21cdfb4ecf2d.sql.gz，12721字节、SHA256 f355cdefb4059ffc885e38914441da3109f73b5d5ebe76dc8d1c1071ef182915；[核对](../../evidence/2026-10-10-project-close-local-backup-check.json)。
- 云/var/backups/geekdash/pre-project-close-21cdfb4ecf2d.sql.gz，33728字节、SHA256 6cbe1ab99839c85d7d96cfab7a0b12989f9cbc6b680f44f78614054e5be097d8。
- 两份包含dev/test全部表及routines/events/triggers；内容和摘要已核对，尚未隔离恢复、外部副本及定时备份。原数据不进Git/发布包。
- 无结构变化，可使用原2880b6e固定release回退；先读当前事实及原结果，不删项目、不覆盖数据库、不重跑初始化或改密。新结案、纠错、审计及回执须保持。

## 公网实际回读

公网新合成项目13由business01/02完成计划、提案结案、明确日期未知及计划快照纠错、维护/无变化、闭案期间他人普通保存和旧版本拒绝；真实S1→启动→S2→暂缓→终止结案→最新阶段日期纠错→先重开为暂缓→恢复→再次正常结案。三个结案周期来源独立，旧周期不能纠正当前；没有制造检查，原首次义务保持。

最终v21/已结案/量产维护，阶段实际进度5%，S2实际开始更正为2020-01-05；最新普通说明、红/高、当前及结案时计划保持。新详情/审计/维护视图及统计通过，16项固定HTML/JS/CSS逐字节核对，[公网证据](../../evidence/2026-10-10-project-close-public-check.json)。中途只读对账请求TLS EOF，沿原编号和已确认结果接续，没有重复创建或新编号状态保存。

实际云app于04:15 UTC停止/启动，[进程恢复](../../evidence/2026-10-10-project-close-restart-check.json)确认持久行数/MySQL及其他17容器保持、无OOM。原会话、v21完整详情、21条历史、公共设置及19个原动作回执在重启后新请求保持，[公网恢复](../../evidence/2026-10-10-project-close-restart-public-check.json)。固定API和资源核对不能替代原生页面实点及公司四人使用。完整E04继续B07～B09。
