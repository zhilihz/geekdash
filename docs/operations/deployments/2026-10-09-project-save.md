# P03-A 测试项目保存部署

执行日期2026-10-09；测试环境新加坡共享主机；公网 https://geekdash.zhiluan.cool ，独立Compose geekdash。实施范围SPEC-002当前trial四项；不是正式数据上线或整个E03交付。实际证据见[云端结果](../../evidence/2026-10-09-project-save-cloud-check.json)及[保存报告](../../testing/reports/2026-10-09-project-save.md)。

## 固定构建与落位

- 源码a22504d769d3be822ee23f8e6ee451e3f246494a，已合并远端main、干净构建；stage=project-save，schemaVersion=0002-trial-save。
- 镜像sha256:1f1825ac2f3c7e32e2669b659b8bff1ff21d36c5049013fb3c39016edcb3e019；linux/amd64、node、运行根只读；常驻app只挂dev_app。
- 归档SHA256=8cb81659ae152a8aab2d233ca449944147627cb031d896bdfe456e43eb7eda7c；发布包SHA256=f910bf3dd45d6fabd33dd48bb1dc97082f31103ff49c81c72f65883be0cc6c37，逐项校验后装载。
- 发布目录/opt/geekdash/releases/a22504d769d3be822ee23f8e6ee451e3f246494a，current指向该目录；数据仍/var/lib/geekdash/mysql。入口仅宿主127.0.0.1:41860，现有Nginx/TLS转发，未修改其他站点。

## 升级及恢复边界

1. 核对旧版本dfd9f0c/0001、两库逐表业务计数0；检查自身容器和共享主机余量。
2. 仅GeekDash MySQL在线从512升768MiB，保留128MiB缓冲池及32连接；停止自身app，备份两库，再使用候选镜像依序迁移/完整核验。
3. 0001资源字节保持；0002目标34表/314列/55外键、两条登记。云内真实500项目/4并发、保存及只读回归通过，test夹具清理为0。
4. 建3持久合成trial项目，启动候选app，实际HTTPS健康/列表/版本通过后提升current。外部保存、回执、旧版本拒绝、新GET/审计/列表回读随后通过。

旧0001镜像拒绝0002结构，本轮未做不兼容旧镜像直接回退；异常优先保留数据、停写、用0002兼容修复产物恢复。恢复发布前备份需明确评估发布后修改，不能自动覆盖。常规方法归[运维](../release-maintenance.md#p03-a-保存单元运行入口)。

发布前备份/var/backups/geekdash/pre-project-save-a22504d769d3.sql.gz，10351字节，SHA256=55691beab4ec2906742532e48ad9124a586743573c87e9e4a32f2008d73434c3；gzip及结构核对完成，仅两库逻辑备份，不等于完整隔离恢复或服务器外备份。

## 运行观察与实际限制

UTC02:24:51应用healthy、自动重启计数0、OOM=false；MySQL容器ID/StartedAt及其他17容器StartedAt均保持。MySQL上限768MiB/观测494.2MiB，app上限256MiB/观测34.02MiB，主机available739MiB、swap已用1987MiB。无MySQL宿主端口，未修改其他项目。

云内500项目四并发P95：列表152、详情60、保存39、历史18ms，0错误。公网新TLS保存2309ms；复用连接保存484ms、回读525ms；公网四并发仍有2.76～4.44秒P95波动。全部按测试来源记录，公司实际网络和实名体验未验收。当前常驻3合成项目，500验收夹具已清理，无真实导入。

本机同一镜像已运行在41860，MySQL继续D盘。此记录只对应上述代码构建；后续纯文档main提交不会自动改变运行版本。

## 实际应用进程重启补充

UTC02:39:53明确停止/启动本项目app，实际StartedAt变化、真实进程已重启；新进程读取保存值和版本，原操作只读确认/回放保持原结果，无新增重复审计。公网ready/版本/项目新GET正常，MySQL ID/StartedAt及其他17容器启动时间仍不变，app OOM=false、自动重启计数0。该验证区别于单元脚本在同一进程重建app/连接池；见[重启证据](../../evidence/2026-10-09-project-save-restart-check.json)。
