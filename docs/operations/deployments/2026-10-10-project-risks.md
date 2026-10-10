# E04-B08风险A～D测试部署

2026-10-10；固定实现5ae7eccc57d8d2a5f1cfb8e8c70a049c147fb802已合并并回读远端main。本机41860和新加坡[geekdash.zhiluan.cool](https://geekdash.zhiluan.cool)同干净project-risks/0002-trial-save；后续文档SHA不代表镜像变化。仅合成数据，节点/0003/变更仍施工，原生页面待B09。

## 固定产物

| 项目 | 实测值 |
|---|---|
| 镜像ID | sha256:ec0088ce6a221e7ebb95e6e38eb120f5b9527eb0dce7ed5fdbc7fb1a6999a6d4 |
| image归档SHA256 | cde0405cdcaf1ab28858ec90a5c3948a38a66351061fda2315558c3e3fbbd17b |
| release归档SHA256 | 6f409c63f9164abc0ef3e77b866def8c773b9733d57ff629b31767c47eb4a514 |
| 发布标签 | project-risks-5ae7eccc57d8 |
| 云固定目录 | /opt/geekdash/releases/5ae7eccc57d8d2a5f1cfb8e8c70a049c147fb802 |

## 升级与数据保持

从B07/4974e0f预检19容器，校验非root固定镜像、归档白名单13项脚本及摘要；云内串行13类验证与检查/风险混合500容量通过后，短停自己的app，完整备份两库、核对dev各表字节指纹后更新应用。没有迁移/初始化/种子/改密，两库34表314列55外键及0001/0002原摘要保持。[部署证据](../../evidence/2026-10-10-project-risks-deployment-check.json)确认test计数、MySQL ID/启动时间、其他17容器保持及无OOM。[本机运行](../../evidence/2026-10-10-project-risks-local-runtime-check.json)同固定版本ready。

本机及云风险专项均5组120 HTTP，SQL/新读/目标审计、混合同次保存、四会话竞争、写点回滚及真实COMMIT未知恢复通过。[固定核对](../../evidence/2026-10-10-project-risks-fixed-check.json)。500项目3500阶段/1000风险（500真实新增）/580风险纠错/1580检查/500检查纠错，四会话8类各80、共640测量请求零错误，第501可读。工具256MiB/旧堆96MiB通过；实际EXPLAIN断言风险原人查询使用实体范围索引/目标ID主键JOIN，外层eq_ref单行。

本机列表/详情/风险预览/风险保存P95=125/54/32/53ms；云分别=2843/90/50/80ms，[云混合容量](../../evidence/2026-10-10-project-risks-cloud-capacity-check.json)。列表明显超过200ms，继续B09实际SQL诊断，不把环回与公司公网体验等同。PE-20261010-006的风险全扫描已修正验证；旧检查边界未复现PE-20261010-004仍未确认根因。云应用33.59MiB/256MiB、MySQL582.3MiB/768MiB为当时采样，本项目未发现Node溢出；仅自己的临时工具退出，不全局杀进程/删卷/prune。

## 备份和回退

- 本机 D:\geekwon\geekdash-data\backups\pre-project-risks-5ae7eccc57d8.sql.gz，12725字节、SHA256 09bac2a95767c73efef94c35bd25432b16ebacb3520993e9810e4a6ce5c769d8，[核对](../../evidence/2026-10-10-project-risks-local-backup-check.json)。
- 云 /var/backups/geekdash/pre-project-risks-5ae7eccc57d8.sql.gz，46328字节、SHA256 64b037633315924d15343b23519a70b4fa227cfcbac48daf0b6a22c9820b8e63。
- 两库完整逻辑备份包括所有表/routines/events/triggers；已核对字节与内容，隔离恢复/服务器外副本尚未执行。口令、Cookie、原备份不入Git。
- 无结构变化，当前可回退原4974e0f应用，风险数据/原结果/历史保持；旧构建不具备新入口，恢复本批镜像后继续。后续节点0003/首次删除会改变该回退边界，届时需含有效过滤的兼容固定构建，不能沿用旧镜像直接读已删除节点。

## 公网与进程恢复

公网新合成项目15由两负责人贯通普通文字/风险同次新增→内容等级纠错→解除→解除说明纠错保持原人时→撤销误解除→真实另建风险→同次新增解除→同值→旧预览409→新读纠正。最终v11/提案/0%、三风险、13条项目审计；灯色yellow/紧急high由普通保存明确选择，风险操作没有自动变化。新详情/审计/提案看板、原结果账号隔离及16资源逐字节通过，[公网](../../evidence/2026-10-10-project-risks-public-check.json)。原项目7～14未用于本轮写入。

实际云app停止/启动，[进程恢复](../../evidence/2026-10-10-project-risks-restart-check.json)确认持久行数、MySQL及其他17容器保持、无OOM。两个原会话及完整项目/风险/历史/公共设置和12个原创建/责任/普通保存结果新请求保持，[公网恢复](../../evidence/2026-10-10-project-risks-restart-public-check.json)。公网HTTP验证未替代原生页面；AD-007记录既有工具URL策略拒绝，原生实点仍B09，公司四人真实体验/完整备份恢复/后续E04范围未完成。
