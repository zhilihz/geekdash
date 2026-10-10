# E04-B08节点0003兼容测试部署

2026-10-10；固定实现2dfb17c463972def4f8aaea6a9d1c4079bd9effa已合并、推送并回读远端main。41860及新加坡[geekdash.zhiluan.cool](https://geekdash.zhiluan.cool)同干净project-nodes-compatible/0003；后续文档SHA不是运行镜像。此批仅加列/有效过滤，删除恢复写入仍D/E，真实备份未接。

## 固定产物与迁移

| 项目 | 实测 |
|---|---|
| 构建时间 | 2026-10-10T08:30:47.475Z |
| 镜像ID | sha256:5d0b0cfe90da94aaae5ca585adacb77622f1542ac1f1a25d0e23d30a8f1de2d3 |
| image归档 | 85464670字节；SHA256 81cc1f1efc1c52f5084fac8965301a0b6d9d10d94f648fe3309db6036500f7bb |
| release归档 | 59456字节；SHA256 2d76d683637bce62c1904aee3ab107bda2d9b2e89c19dc2840d7aabb7caaf03a |
| 发布标签 | project-nodes-compatible-2dfb17c46397 |
| 云固定目录 | /opt/geekdash/releases/2dfb17c463972def4f8aaea6a9d1c4079bd9effa |
| 新迁移SHA256 | 4a5b38bd7c84ea230d9d2b1b0b7f93c575107f20c5df9968109901c09296e578 |

两端原0001/0002字节和迁移登记时刻保持；分别备份后将test/dev迁移为34表315列55FK及三历史。原业务全表字节指纹按旧列读取、新列默认NULL，来源ID/前后关系/项目版本/二进制回执不改。只短停自己app；MySQL及其他17云容器ID和启动时间保持，应用无OOM。证据：[固定](../../evidence/2026-10-10-node-compatible-fixed-check.json)、[本机](../../evidence/2026-10-10-node-compatible-local-deployment-check.json)、[云端](../../evidence/2026-10-10-node-compatible-cloud-deployment-check.json)。

固定含数据升级四组、节点五组164/检查十组253和工程通过，云14类回归完整退出0。先独立新库/含数据/真实死亡续跑/旧0002拒绝新结构，后常驻两库备份与迁移，破坏演练未在常驻库执行。[候选与复测门槛](../../testing/reports/2026-10-10-node-migration.md)。

云安装迁移/切换/current已成功后，尾部读取旧报告根status发生KeyError；只读reconcile验证版本/原指纹/两旧历史/备份/14报告及容器保持后补归档，未重复安装。初次资产618重取同资产链接后SHA核对成功；本机旧结果目录EACCES只改本批自有输出目录，dev迁移后PowerShell执行策略拒绝辅助脚本，直接使用原Compose参数启动，未改系统策略/应用用户或迁移回退。PE-003/005/010只记录辅助恢复，不能当业务失败重初始化。

## 容量与公网恢复

500项目3500阶段、2000节点（1500实际新增）、1000风险/580风险纠错、1580检查/500检查纠错，四真实会话十类各80共800测量零错误、第501允许。云混合列表/详情/节点预览/保存P95=196/88/43/81ms；另一普通容量列表P95=1929ms。旧2290ms原证据保留，波动与稳定200ms仍B09，环回不能证明公司公网浏览器体验。[云两组容量](../../evidence/2026-10-10-node-compatible-cloud-capacity-check.json)。工具256MiB/V8旧堆96MiB，无OOM。

公网三HTML路由、十个JS/CSS与固定产物逐字节一致，[资源读取](../../evidence/2026-10-10-node-compatible-public-check.json)。真实云app停止/启动，启动时间实际变化、同镜像、MySQL/其他17容器保持，[重启](../../evidence/2026-10-10-node-compatible-restart-check.json)。重启后两原会话、14原创建/责任/普通保存结果及项目16/v13/五节点/一风险/30审计/公共规则通过新请求核对，[原会话与原结果](../../evidence/2026-10-10-node-compatible-original-public-check.json)；本批公网不新建业务、不改密、不改其他项目7～15。

## 完整逻辑备份与恢复边界

- `D:\geekwon\geekdash-data\backups\pre-node-compatible-2dfb17c46397.sql.gz`：12724字节，SHA256 `3063bddcf90b5ecfcf3304555fe38a4eaf4409c69a65a21544bceaf8e8e246cb`。
- `/var/backups/geekdash/pre-node-compatible-2dfb17c46397.sql.gz`：55104字节，SHA256 `36ada8b9484497c670e64399d087536ea5464e2bac7f97ec689a0c211a333cb7`。
- `/var/backups/geekdash/pre-dev-node-compatible-2dfb17c46397.sql.gz`：55180字节，SHA256 `a9dd03030a292ac4bdc19bfbb9d00087168e4ec3bdc910ddfb577a4ce1724059`。

上述均完整导出dev/test全部表及routines/events/triggers，包含会话/审计/回执；云第一份在test首次DDL前，第二份在dev DDL前。只记录元数据，原SQL及凭据受控不入Git。隔离恢复、服务器外副本和真实备份导入未执行，不能宣称完整灾难恢复已验。

0003从加列起旧0002固定196405e即不兼容，不能以旧镜像启动撤销DDL。DDL前失败可维持原服务，精确目标列存在但未登记时沿原增量续跑；未知额外对象保留现场。后续D/E应用可回退当前固定2dfb17c，必须保留有效过滤和删除标记；含正式删除数据的实际兼容回退/再升级仍须D/E验证，未在本批冒充执行。

本轮独立临时MySQL在验证自身夹具为空后移除容器/内部网络，释放512MiB上限，D盘数据保留；Node采样未发现溢出，未全局终止、prune或删现有卷，[清理](../../evidence/2026-10-10-node-compatible-cleanup-check.json)。原生新表单沿AD-007/B09未验，原工具明确URL策略拒绝未绕过；资源/API不替代页面验收。E04仍进行中，后续只归[handoff](../../handoff/handoff.md)。
