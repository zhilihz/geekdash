# 2026-10-29 K3s 与 RDS 交付技术核验

范围对应[执行计划1.4](../../implementation/execution-plan.md#k3s-delivery-plan)和TEST-014/032。本报告分开记录源码检查、隔离数据库、双镜像、本地K3s及目标环境；真实页面和业务体验由用户验收。本地测试不得作为阿里云K3s/RDS已经部署的证明。

## 1. 版本与隔离边界

- 施工仓库`D:/geekwon/geekdash`，分支`codex/k3s-rds-delivery`，基线main `460bc7e`；执行计划提交`e13ef7d`，本轮首个产品提交`4a92ca7b8b79f6c9c6a31d0ebd425af09449dc42`。
- 双镜像构建来自同一次clean构建，`2026-10-29T10:01:14.212Z`，目标schema `0015-project-deletion`。本次不新增业务迁移。
- 后续修复提交`f55d9500918eb11436da03677282536373d2d1af`，同次clean构建时间`2026-10-29T10:32:21.679Z`；用于实际升级验证。它补齐解除维护后失败恢复、未知开放状态的显式复核入口，以及Linux上传正式目录项同步；不宣称突然断电已经实测。
- 发布工具补充提交`a1f94b9`统一上传tag与部署digest的仓库路径校验，避免合法下划线路径被两端区别对待；仅发布端脚本变更，不改变f55d950两镜像内容或构建标记。
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
| `verify-k3s-release.mjs` | 最终118项断言通过：原74项资源/参数/备份门禁，加20项开放失败恢复，以及24项上传/部署仓库路径一致性；含实际render新请求回读及非法目标在调用Docker前拒绝 | 纯脚本检查，不替代真实迁移Job、Harbor上传或恢复演练 |

上述最小版本门槛为MySQL8.0.16，因为现有结构要求实际执行CHECK约束；8.0+不等于只支持8.0.x，也不等于所有未来版本已经验证。

## 3. 双镜像验证

入口：`node scripts/verify-split-build.mjs --web-image geekdash-k3s-web:4a92ca7 --api-image geekdash-k3s-api:4a92ca7`。

71次HTTP检查通过：14页、37个资源、HTML及时更新、摘要资源长缓存、旧页面兼容跳转；错误API路由返回JSON；API容器的首页/HTML/build-info静态路径均404。维护页返回503且健康/构建读取可用。两容器均以非root、只读根文件系统运行；API镜像没有web目录、static插件、TypeScript/Vite、源码、文档、Git或mysqld。

| 镜像 | 本机内容摘要 | Docker内容大小 | Docker磁盘显示 |
|---|---|---:|---:|
| `geekdash-k3s-web:4a92ca7` | `sha256:ae0cd19560f64ee7cab111611428e206b7d050fa9ff37fca4d80ff8499ad9e44` | 66.5 MB | 251 MB |
| `geekdash-k3s-api:4a92ca7` | `sha256:400eb096c62310ecbc4ba0b58c7e024333814edaf04a352a22487f1576d39e09` | 83.6 MB | 354 MB |

内容大小、展开占用、共享层和实际上传流量是不同口径，不能相加磁盘显示作为下载量。仓库digest须由实际上传后回读产生，本机摘要不是已经推送Harbor的证据。完整构建信息和检查结果见[双镜像结果](../../evidence/k3s-rds/split-images.json)。

修复后的`f55d950`双镜像重新通过同一71请求检查，14页/37资源不变：[最终双镜像结果](../../evidence/k3s-rds/split-images-final.json)。前端本机摘要`sha256:0ade24ea7ebd6b33d1398bb385efa203db5af6cfe796eb05287a4fb84d42a3d8`，后端`sha256:2b6012434f67f1a37e8506c365858aa9f7678a74e975fdd7baaa876add4d0741`；内容大小仍约66.5/83.6MB。未把旧镜像原tag覆盖成新内容。

前端首次构建遇Docker Hub匿名认证超时，本机已有完全相同官方RepoDigest；补齐固定版本标签后缓存构建通过，没有改变基础镜像内容、Dockerfile或TLS要求。Linux可选依赖首次缺失按原锁完整性摘要补齐，根锁未变；原始缺失原因未确认。

## 4. 本地 K3s 运行检查

独立集群`geekdash-verify2-20261029`使用K3s1.35.5、containerd2.2.3、Traefik及local-path；专用kubeconfig未修改用户默认context。入口仅映射本机127.0.0.1:443，使用独立测试CA和域名SAN，客户端加载该CA而非跳过TLS验证。应用镜像预载到本地containerd，**没有验证真实Harbor拉取**。

| 操作 | 实际结果 | 证据 |
|---|---|---|
| preflight → init | 两类数据库身份TLS连接和构建核对通过；全新验证库初始化/核验Job完成，首次发布返回released | 本机preflight.log、init.log；业务验收字段仍为待用户 |
| 维护期间入口 | 首页503并带维护头，业务API503，health200且maintenance=true；完成后HTTPS200 | 真实入口请求，未用组件模拟 |
| HTTPS业务链 | 22次请求验证首次改密、会话/CSRF、旧构建拒绝、项目创建/保存/新GET、幂等/版本冲突、SSE事件、合成备份上传并入库 | [HTTP结果](../../evidence/k3s-rds/cluster-http.json) |
| API Pod重建 | PVC UID保持；原会话、两个项目、导入回执可新读；重放不重复，原文件尺寸/摘要核查通过 | [PVC重建](../../evidence/k3s-rds/cluster-pvc-restart.json) |
| 上传边界 | 实际Traefik HTTPS接收32MiB合成JSON，32MiB+1返回413 IMPORT_FILE_TOO_LARGE | [上传边界](../../evidence/k3s-rds/cluster-upload-limit.json) |
| 维护升级与备份门禁 | update确认旧API为0且首页503；不提供备份证据时resume被拒绝，未执行迁移 | 汇总第6项，原update/paused/resume日志保留 |
| 配对备份及恢复 | 停止应用后归档数据库、PVC原文件及配置；恢复到另一全新验证库，48表行数和校验值一致，两个原文件摘要一致 | 汇总第7项；仅隔离MySQL归档恢复，不是RDS PITR验收 |
| 实际迁移失败及接续 | 专用连接持有schema锁，迁移Job以DB_MIGRATION_BUSY失败，API为0且维护保持；核对48表/415字段/84外键零差异，释放锁后显式retry新attempt成功，原Failed Job保留 | 汇总第8项；未清库或删除失败现场 |
| 新版本与新写入 | f55d950前后端配对开放；原会话/项目/回执可读，新备份上传→执行→入库→新GET通过，原文件检查3份无缺失或损坏 | 汇总第9项 |
| 数据库短暂不可用 | 暂停隔离MySQL后ready503/live200，Ingress移除故障端点；恢复后ready200、入口短暂传播后200，项目新GET成功，Pod UID及重启数不变 | 汇总第10项；没有对用户库执行故障注入 |
| 强制终止API | 空闲API进程实际SIGKILL，Kubelet约8.5秒恢复；原会话、项目、回执及3个原文件读取正常，PVC保持 | [强杀结果](../../evidence/k3s-rds/cluster-api-kill.json)；不是写入中断电测试 |
| 应用数据库密码轮换 | 改独立数据库密码及Secret，旧密码新连接拒绝；显式重载API后新连接及原业务回读通过；再恢复原密码/Secret并重载验证 | [轮换及最终状态](../../evidence/k3s-rds/cluster-resilience.json)；未轮换CA，凭据摘要不进入Git |
| 部分DDL中断后继续 | 另一新库首Job子进程SIGKILL，Failed/137；回读2表、0版本记录，原镜像新Job明确续跑后15版本/48表/415列/84外键，差异0；重复迁移不改变历史 | [DDL及运行预算](../../evidence/k3s-rds/cluster-ddl-recovery.json)；故障注入仅复制到临时目录的验证产物，产品镜像未改 |
| 池耗尽与慢复核 | 独立Job占满其8连接，1ms返回database_busy，释放恢复；完整复核加入实际SELECT SLEEP(4)，20并发请求只启动1次复核，4091ms成功，历史不变 | 同上；证明预算/单次复核契约，不是吞吐性能验收 |

本地集群最终[十项验收汇总](../../evidence/k3s-rds/cluster-acceptance.json)于`2026-10-29T10:46:59.551Z`记录。web/API均1/1、PVC Bound，隔离MySQL已经恢复运行；最终运行版本f55d950，schema0015。原始日志名仅作仓库外定位，证据中不包含凭据或原始备份。

短断库脚本首次漏传既有账号上下文头，并在Pod就绪后未等待Ingress端点传播，得到503/409；原失败日志保留。修正测试脚本后重跑通过，入口恢复观测为503、503、200，未因此修改业务代码。用户真实页面未代测；没有实施节点突然断电或跨节点故障。

补验最后在`2026-10-29T11:02:32.385Z`确认发布phase=complete、maintenance=false、发布锁无残留，web/API各1/1；实际凭据、数据库目标及PVC与发布记录相符。隔离集群、卷及失败Job保留，用户41873未变。部分DDL首轮直接终止Job主进程的注入未中断，不计通过且保留现场；第二轮复用既有迁移检查的子进程注入方式后取得上述真实中断结果。

## 5. 尚未验证及交付边界

- 实际阿里云K3s、RDS精确补丁版本/授权/私网白名单/CA、Harbor节点拉取、正式域名TLS、CSI及真实代理来源未提供，均未部署或验收。
- 当前本地单节点local-path只用于隔离验收，不证明跨节点恢复、云盘重挂或高可用。
- 本轮未执行OOM、写入期间突然断电、CA/入口证书轮换；密码Secret轮换不替代证书链更换。目标设施备份失败告警及送达、节点维护、跨节点卷恢复仍待实际环境验证，不以本地相邻场景代替。
- 正式备份服务、保留期、告警送达和恢复目标按DEC-175待同事提供能力和成本；不把本地归档门禁称为RDS恢复演练通过。
- 用户真实页面操作未代执行。施工分支提交、Git推送、main合并、镜像上传和服务器部署必须分别核对。

仓库外原始日志入口：`D:/geekwon/geekdash-data/k3s-verification/`；其下含独立测试凭据，不整体打包或提交。仓库内只保存本报告及脱敏结果摘要。
