# E03-W08：普通编辑与关联保存部署

执行日期：2026-10-09；新加坡共享测试机；入口 https://geekdash.zhiluan.cool ，独立Compose geekdash。本次交付E03-W06～W08的DEC-089匿名trial范围，完整E03和身份责任后置。[验收报告](../../testing/reports/2026-10-09-project-ordinary.md)记录功能及性能边界。

## 1. 固定构建与落位

- 源码 31012c8cc1b52d9848e010b815ba55321c4ba935 已合并远端main；dirty=false、stage=project-ordinary、schemaVersion=0002-trial-save；构建时间 2026-10-09T03:29:32.235Z。
- 镜像 sha256:d18c857870820a2c76d5e658465a95fdaf8c78813623a57b8a67dbfb4a0d3097；linux/amd64、node、根只读、app上限256MiB、仅挂dev_app。
- 镜像归档SHA-256=c7b49e67769640b15f4da65b9e3ad87e371b9d58b5e40dbefad38f8d0b154225；发布包SHA-256=b60389b538f2a5948715c46fd859180b2ea84a78380122d6eb10cd6f2931077d。私有prerelease project-ordinary-31012c8cc1b5含固定镜像、部署及合成验证脚本，不含长期凭据或真实数据。
- /opt/geekdash/releases/31012c8cc1b52d9848e010b815ba55321c4ba935 为发布目录，current已指向它；宿主入口127.0.0.1:41860经原Nginx/TLS。MySQL仍/var/lib/geekdash/mysql、无宿主SQL端口。本地同构建运行41860，MySQL仍D盘。

## 2. 升级链路与数据保留

1. 核对旧a22504d/0002、摘要、两库真实结构、容器及主机资源。0001/0002原字节保持，本轮无增量迁移、不重建库。
2. 旧app运行期间，固定候选仅接test身份执行普通/容量/四项/读取回归，通过且测试库逐表计数恢复。
3. 仅停止自己app，完整逻辑备份两库、记录非资料表字节指纹；七类资料各加两条合成候选。三个既有项目及阶段、关联、审计、回执等全部非资料表指纹保持。
4. 启动新app，就绪、版本和3trial查询通过后提升current。随后公网保存、关联消费、回执、冲突及资源摘要通过。
5. UTC 2026-10-09T03:41:34.253985+00:00 明确停止/启动app，新进程完整详情和公网、原回执回读通过，无重复审计。

首次停止后脚本二进制解码失败，已恢复旧app再按停点接续，详见报告GD-ORDINARY-003。最终MySQL ID/StartedAt及其他17容器StartedAt保持，未更新其他站点。

## 3. 备份与恢复边界

/var/backups/geekdash/pre-project-ordinary-31012c8cc1b5.sql.gz，12512字节，SHA-256=7620ea99d46a2df9c5c21d79e039e3924822ad7ab425147ed06ec51cac181256；含两库全部表、事件、触发器与例程，gzip/结构核对完成。未完成隔离恢复、定时任务及服务器外副本，文件存在不当恢复验收。

新旧应用同0002；新构建实测兼容旧四项请求/回执和format=1副本。新format=2关联副本不能假定旧UI能恢复；出现问题保留回执与数据，优先兼容前向修复，不自动回退UI或恢复旧备份覆盖后续保存。

## 4. 运行观察

UTC 2026-10-09T03:38:01.677075+00:00 app healthy、OOM=false、自动重启计数0；app33.65MiB/256MiB、MySQL500.1MiB/768MiB，available710MiB、swap已用1987MiB、磁盘可用约17.2GB。单次观察不是余量保证。

500规模与公网波动详见报告；功能通过不等于列表稳定200ms。常驻3合成trial，规模夹具清理；无真实导入、身份、阶段写入或服务器个人底稿。[云端证据](../../evidence/2026-10-09-project-ordinary-cloud-check.json)、[重启](../../evidence/2026-10-09-project-ordinary-restart-check.json)、[公网](../../evidence/2026-10-09-project-ordinary-public-check.json)。后续纯文档main不自动改变本运行构建。
