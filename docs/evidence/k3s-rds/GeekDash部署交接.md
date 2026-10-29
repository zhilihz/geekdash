# GeekDash：阿里云 K3s + RDS 部署交接

2026-10-29 · 本文是[发布运维](../../operations/release-maintenance.md#k3s-production-delivery)的转发摘要；具体参数和恢复流程以该章节为准。当前交付为本地技术验证候选，阿里云目标尚未接入，域名由用户后续提供。

```text
同一HTTPS域名 → 实际Ingress
                 ├─ /api → 后端Service → Node API（单副本）→ RDS MySQL
                 │                              └→ 导入原文件PVC
                 └─ 页面/资源 → 前端Service → Nginx
后端同一镜像 → 一次性初始化/迁移/核验Job → RDS
```

**交付物：**配对的 web/API 镜像；上传后产生的 release.json；环境配置；scripts/k3s-release.mjs 与 deploy/k3s/resources.mjs 及该目录示例。执行端使用Node.js24与kubectl；保留脚本相对目录。旧Harbor合一镜像、push.bat和Compose包不用于新集群。

**操作顺序：**

1. 同事确认目标环境，准备独立空库、运行/迁移账号、RDS CA、TLS及仓库拉取Secret、StorageClass。应用账号只有本库读写，迁移账号只供Job使用；具体字段和权限见运维第3节。
2. 开发侧同一次clean构建生成两镜像，用发布CLI的 push 上传到实际Harbor并回读digest，生成 release.json；没有实际上传结果时不能凭本地tag编造正式发行。
3. 填写 environment.json，执行 render 审阅，再 preflight。它实际运行只读预检Job，检查两镜像构建和数据库连接，不写业务。
4. 首次执行 init：创建schema并初始化一个受控管理员。发现非预期业务数据即停止，不清库、不迁移旧环境。健康、版本和文件核查后才开放，再由用户登录改密及使用验收。
5. 日后 update 先维护并停止后端，在 paused_for_backup 等待数据库、原文件和配置的配对备份；resume 通过备份门禁后迁移及更新。失败先 status，按实际阶段 resume/retry，不能直接反复init或删除卷。

| 同事需要提供 | 特殊约束 |
|---|---|
| K3s context、版本、节点架构、Harbor仓库 | 应用不挂集群管理权限；目标节点必须能拉取配对digest；本地预载镜像验收不代表Harbor已通 |
| 正式域名、证书、实际Ingress | 同域，保留/api路径，支持32MiB上传和SSE；信任实际入口代理来源，不猜CIDR |
| RDS私网DNS/端口、库名、两类身份、CA、精确版本 | MySQL8.0+，最低8.0.16；真实版本需验证TLS/授权/结构。首次为空库，不搬入测试账号和数据 |
| 持久卷及备份/日志设施 | 固定导入路径、UID1000可写、fsync/硬链接；RDS备份不包含原文件。local-path不证明跨节点恢复 |
| 维护窗口、备份能力及成本 | 单副本更新有维护时间；正式备份周期/保留/RPO/RTO尚未确定，不预先承诺 |

真实密码、证书私钥及kubeconfig走受控渠道，不写入此文、Git、镜像或普通发行ZIP。现有本地41873和腾讯云入口不随本次改变。源码、镜像与本地集群的准确验证结果见[技术报告](../../testing/reports/2026-10-29-k3s-rds-delivery.md)；正式上传/部署需要另留回读证据。
