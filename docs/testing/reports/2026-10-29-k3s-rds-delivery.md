# 2026-10-29 K3s 与 RDS 交付技术核验

范围对应[执行计划1.4](../../implementation/execution-plan.md#k3s-delivery-plan)和TEST-014/032。本报告分开记录源码检查、隔离数据库、双镜像、本地K3s及目标环境；真实页面和业务体验由用户验收。本地测试不得作为阿里云K3s/RDS已经部署的证明。

## 1. 版本与隔离边界

- 施工仓库`D:/geekwon/geekdash`，分支`codex/k3s-rds-delivery`，基线main `460bc7e`；执行计划提交`e13ef7d`，本轮首个产品提交`4a92ca7b8b79f6c9c6a31d0ebd425af09449dc42`。
- 双镜像构建来自同一次clean构建，`2026-10-29T10:01:14.212Z`，目标schema `0015-project-deletion`。本次不新增业务迁移。
- 两个MySQL验证库、合成账号及项目、本地K3s验证集群均新建且隔离；没有在用户41873、腾讯云或阿里云真实业务库写测试数据，没有清理原镜像或卷。
- 前期API验证在`e13ef7d + 工作树改动`构建上执行，最终结果保留原dirty事实；后续双镜像及集群结果绑定clean产品提交，不能把前期构建标识改写成clean。

## 2. 已执行的源码、数据库和API验证

| 入口 | 预期及实际结果 | 证据与边界 |
|---|---|---|
| TypeScript、组合构建及`verify-foundation.mjs` | 原本地静态托管/旧入口保留，新构建失败不覆盖原产物；类型和构建通过 | 组合构建日志保留在仓库外验证目录；不是用户页面验收 |
| `verify-rds-config.mjs` | 48项配置/版本/授权/TLS负例通过；运行和迁移身份分离，危险目标或宽权限拒绝 | 不将纯断言当成云服务连接证明 |
| `verify-rds-config.mjs --empty-database` | 真实MySQL **8.0.46**与**8.4.11**各自从空库完成0015结构、非空库拒绝、首次账号、重复初始化密码不变、运行账号DDL拒绝 | [8.0结果](../../evidence/k3s-rds/mysql80.json)、[8.4结果](../../evidence/k3s-rds/mysql84.json)；均为本地MySQL，实际RDS未验 |
| 同矩阵的增量验证 | 数据库级授权按`partial_revokes`语义校验；每库迁移锁隔离，重复迁移无新增步骤；错误CA、错误主机名、无TLS连接实际拒绝 | 原始日志在受控本地验证目录；不含真实RDS白名单或备份能力测试 |
| `verify-k3s-runtime.mjs` | 213次HTTP请求通过：登录/同源/CSRF、旧前端拒绝、项目写入与新GET回读、回执重放、版本冲突、SSE、维护暂停、上传及导入执行中断接续 | [结构化结果](../../evidence/k3s-rds/runtime.json)。本组HTTPS Cookie/Origin是接口契约测试，尚不是真实Ingress TLS链 |
| 同脚本原文件核查 | 上传原文尺寸/摘要正确，破坏后拒绝，恢复后回读一致 | 本组目录挂在临时文件系统，验证应用重启与文件核查；**不证明Pod重建后PVC持久化**，该项单列集群验收 |
| `verify-k3s-release.mjs` | 74项原生资源、危险参数拒绝、备份文件摘要和时间门禁断言通过 | 纯脚本检查，不替代真实迁移Job、Harbor上传或恢复演练 |

上述最小版本门槛为MySQL8.0.16，因为现有结构要求实际执行CHECK约束；8.0+不等于只支持8.0.x，也不等于所有未来版本已经验证。

## 3. 双镜像验证

入口：`node scripts/verify-split-build.mjs --web-image geekdash-k3s-web:4a92ca7 --api-image geekdash-k3s-api:4a92ca7`。

71次HTTP检查通过：14页、37个资源、HTML及时更新、摘要资源长缓存、旧页面兼容跳转；错误API路由返回JSON；API容器的首页/HTML/build-info静态路径均404。维护页返回503且健康/构建读取可用。两容器均以非root、只读根文件系统运行；API镜像没有web目录、static插件、TypeScript/Vite、源码、文档、Git或mysqld。

| 镜像 | 本机内容摘要 | Docker内容大小 | Docker磁盘显示 |
|---|---|---:|---:|
| `geekdash-k3s-web:4a92ca7` | `sha256:ae0cd19560f64ee7cab111611428e206b7d050fa9ff37fca4d80ff8499ad9e44` | 66.5 MB | 251 MB |
| `geekdash-k3s-api:4a92ca7` | `sha256:400eb096c62310ecbc4ba0b58c7e024333814edaf04a352a22487f1576d39e09` | 83.6 MB | 354 MB |

内容大小、展开占用、共享层和实际上传流量是不同口径，不能相加磁盘显示作为下载量。仓库digest须由实际上传后回读产生，本机摘要不是已经推送Harbor的证据。完整构建信息和检查结果见[双镜像结果](../../evidence/k3s-rds/split-images.json)。

前端首次构建遇Docker Hub匿名认证超时，本机已有完全相同官方RepoDigest；补齐固定版本标签后缓存构建通过，没有改变基础镜像内容、Dockerfile或TLS要求。Linux可选依赖首次缺失按原锁完整性摘要补齐，根锁未变；原始缺失原因未确认。

## 4. 本地 K3s 运行检查

独立集群`geekdash-verify2-20261029`（K3s1.35.5、containerd2.2.3）已经具备Traefik、DNS、local-path存储；业务部署技术验证正在执行。此段将在实际回读后补充结果，不提前标记首次部署、PVC重建、维护升级或失败接续通过。

## 5. 尚未验证及交付边界

- 实际阿里云K3s、RDS精确补丁版本/授权/私网白名单/CA、Harbor节点拉取、正式域名TLS、CSI及真实代理来源未提供，均未部署或验收。
- 当前本地单节点local-path只用于隔离验收，不证明跨节点恢复、云盘重挂或高可用。
- 正式备份服务、保留期、告警送达和恢复目标按DEC-175待同事提供能力和成本；不把本地归档门禁称为RDS恢复演练通过。
- 用户真实页面操作未代执行。施工分支提交、Git推送、main合并、镜像上传和服务器部署必须分别核对。

仓库外原始日志入口：`D:/geekwon/geekdash-data/k3s-verification/`；其下含独立测试凭据，不整体打包或提交。仓库内只保存本报告及脱敏结果摘要。
