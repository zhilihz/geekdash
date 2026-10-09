# E03-W12 最小身份与完整项目主干部署

日期：2026-10-09；环境：既有新加坡测试机，HTTPS https://geekdash.zhiluan.cool 。CLI及测试部署已获授权，真实备份未接入。功能证据与限制归[报告](../../testing/reports/2026-10-09-project-core.md)。

## 1. 固定产物和入口

- revision 6aee827238912f2f202bc14ab8d0f5739af83048，dirty=false，stage=project-core，schema=0002-trial-save；主体应用4dca725，6aee827只修测试夹具清理。源码已合并回读远端main，文档收尾提交与运行版本分开。
- 镜像ID sha256:a67b261196994daa083d161a5f7b72b6e62004e2978bdc6dde41fa2883267473，linux/amd64、非root node、app只读/256MiB。仅受控一次账号初始化命令用root读取mode600输入，常驻app不获得迁移/维护文件。
- 私有release project-core-6aee82723891；镜像归档SHA256 23beedc8913fdb5ebaf4ead0e5fdcabd57004ef3ded0fbc765a66109b2706dc9；部署包SHA256 de55d3e6e04290170207466c4909c8048a3c92743115de44a976f5a0b70b1cf7。
- /opt/geekdash/releases/6aee827238912f2f202bc14ab8d0f5739af83048，current已提升；app127.0.0.1:41860经原Nginx/TLS。MySQL/var/lib/geekdash/mysql、私有网络、无宿主SQL端口；本机相同运行版本41860，数据仍D盘。

## 2. 实际升级链路

1. 固定候选与两库结构校验，无迁移增量，旧31012c8运行期间完成五个不同脚本，测试计数恢复。首次发布因自有匿名夹具遗漏停止在app切换前，准确诊断及清理归报告。
2. 只停本项目app，完整两库备份。Compose初始化挂载错误停在账号写入前，按已核对停点接续；没有重建MySQL、覆盖凭据或回放初始化重置。
3. 受控初始化五个独立测试账号：business01～04、maint01。账号ID保持独立，不把PM/硬件工程师资料当登录账号；维护资格唯一指定maint01，仍没有管理后台。
4. 初始化前后全部业务表字节指纹、旧审计保持；仅users/audit/system_configuration增加5/5/1。新apphealthy、正确构建与匿名业务401后提升current。
5. 公网登录/实际改密/新项目7/责任/实名关联保存及新请求回读；实际app停止/启动后持久会话、原回执v3、当前详情v4和4条审计保持。MySQLID/StartedAt及其他17容器启动时间保持。

## 3. 凭据交付与数据

临时及验收后当前密码保存在本机仓库外D:/geekwon/geekdash-data/secrets/test-accounts-server.json，仅当前Windows用户与SYSTEM。business01/02已由公网验收完成首次改密，文件currentPassword为其当前密码；business03/04、maint01仍使用temporaryPassword，首次登录须改密。原临时密码不可作为前两账号的当前密码。

服务器仅收到密码哈希输入/root mode600，不传输明文；文件/会话Cookie/操作体不进Git、镜像或公共发布资产。本机单独凭据test-accounts-local.json属于本机dev，不混同新加坡账号密码。当前总计原三个trial与一个本轮验收新trial，不导入真实备份；管理员本人负责后才能编辑。

## 4. 备份与恢复边界

/var/backups/geekdash/pre-project-core-6aee82723891.sql.gz，13421字节，SHA256 56128c39c8fae81569b3bf5056d8ac49cf44eac5ffb04ebe12af18bd882ef289；两库全部表、routines/events/triggers完整逻辑备份，gzip与结构核对通过。创建时间在账号初始化及公网后续保存之前。尚未隔离恢复、定时或服务器外副本；不能恢复该文件覆盖随后账号/保存，不能把文件存在当恢复能力完成。

新旧同0002，新增认证要求不能通过回退匿名镜像绕过。出现故障保留库/回执/受控凭据，按运维流程暂停本项目app并诊断、兼容前向修复；不自动恢复旧备份或重置账号。

## 5. 运行观察与未覆盖

部署观察UTC 2026-10-09T05:41:03.746094+00:00，app 34.04MiB / 256MiB；MySQL768MiB上限，available 643MiB、swap已用1987MiB。这是采样，不能保证长期余量；OOM=false、自动重启计数0。实际恢复前后StartedAt见[证据](../../evidence/2026-10-09-project-core-restart-check.json)。

云内500项目四会话列表P95=189ms，本机228ms；历史波动保留，公网/四人实际体感待验。浏览器完整联验缺口归报告第3节；邀请码、账号后台、生命周期/草稿/SSE/真实审查导入及备份恢复后续按单功能接续。
