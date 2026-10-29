# 更新、发布与长期维护

版本：D0.59；日期：2026-10-09；状态：本地工程及免登录公网基底已有交付；详细计划先行、每大阶段的 Git 完成流程及提交阶段标识已明确，完整恢复待接续。

## 1. 区分三种动作

代码推送把变更写入 GitHub；服务器部署替换运行版本；浏览器更新使使用者切换页面资源。这三步分别记录、验证和选择时机。

项目地址见[文档入口](../README.md)。用户已允许命令行操作；文档推送不代表批准未来每次合并后自动部署。

本轮用户要求先上线，已确认测试部署目标见架构；首版按已确认功能和旧版复用范围推进。DEC-057 已确认首版人工择时发布，不将每次推送直接部署到运行环境。

### 本地工程运行（E01-F01）

前置：Docker Linux 引擎和 Compose 可连接，仓库有已生成的依赖锁；在仓库根目录执行。Windows 入口脚本每次从 Git 获取版本/未提交状态，透传命令后恢复进程环境变量；不修改全局 Node/npm。Node 工具和运行镜像使用已固定摘要，Linux 依赖在独立卷中。

```powershell
Set-Location D:\geekwon\geekdash
pwsh -NoProfile -File scripts/docker.ps1 run --rm --no-deps tool npm ci
pwsh -NoProfile -File scripts/docker.ps1 run --rm --no-deps tool npm run check
pwsh -NoProfile -File scripts/docker.ps1 run --rm --no-deps tool npm run build
pwsh -NoProfile -File scripts/docker.ps1 run --rm --no-deps tool npm test
pwsh -NoProfile -File scripts/docker.ps1 build app
```

以上只构建，不启动应用，也不读取数据库凭据。首次运行先完成下一节的配置初始化、数据库启动和迁移，再用组合入口启动应用。逐条检查退出码，前一步失败不执行后续。构建在候选目录完成类型检查、编译、资源核对和真实 HTTP 检查后才提升为 dist；dist.previous 保留上一产物。候选目录和上一产物不能自动当作已验收发布版本。

若绕过入口直接在精简Node镜像执行构建，出现`spawnSync git ENOENT`，改用上面的`scripts/docker.ps1`：它在主机读取版本并传入构建，不需要向工具镜像安装Git。排错只打印字段是否存在，不输出凭据或整个进程环境。

入口为 http://127.0.0.1:41860 ，仅绑定本机。端口占用时先核查；可用进程环境 GEEKDASH_PORT 指定另一端口，变更后重新创建本项目 app。当前为登录/新建/看板/详情；最小账号会话及负责授权已接入，准确上线范围以实际构建和系统真相为准。组合 Compose 的容器健康检查使用 ready；healthy 表示基础数据库依赖就绪，尚不能代表登录或项目业务已完成。协议见 [API 说明](../specifications/api/foundation.md)。

```powershell
pwsh -NoProfile -File scripts/database.ps1 up --wait --wait-timeout 60 app
pwsh -NoProfile -File scripts/database.ps1 ps app
pwsh -NoProfile -File scripts/database.ps1 logs --tail 50 app
pwsh -NoProfile -File scripts/database.ps1 stop app
pwsh -NoProfile -File scripts/database.ps1 up --wait --wait-timeout 60 app
```

实际配置通过 Compose/进程环境注入：HOST、PORT、GEEKDASH_DB_PROFILE；仅接受 dev_app/test_app，组合 Compose 默认 dev_app，并仅挂载该运行身份文件。app 加入私有数据库网络、配置 unless-stopped；root、迁移和测试身份不挂入常驻 app。启动完整核验失败则退出，运行中故障保留 live，通过有界检查恢复。F02/F03 的独立数据库工具入口见下节。不要执行带 -v 的清理命令删除卷。这里的命令不连接新加坡服务器，也不部署 geekdash.zhiluan.cool。

### 本地数据库运行（E01-F02/F03）

当前入口为 scripts/database.ps1，组合基础和 MySQL Compose；固定项目名 geekdash-dev。本地数据目录为 D:\geekwon\geekdash-data\mysql，配置为同目录下 secrets，均在仓库之外。用户已选择只将本项目 MySQL 数据放 D 盘，镜像保留现有 Docker 数据盘。初始化脚本从仓库父目录解析路径，仅当前 Windows 用户与 SYSTEM 获得配置目录权限；不得提交密钥或把它们打包进镜像。

先完成本地工程的 npm ci/build，再依次执行，每一步检查退出码：

```powershell
pwsh -NoProfile -File scripts/database.ps1 init-config
pwsh -NoProfile -File scripts/database.ps1 up --wait --wait-timeout 60 mysql
pwsh -NoProfile -File scripts/database.ps1 run --rm --no-deps dbtool npm run db:check
pwsh -NoProfile -File scripts/database.ps1 run --rm --no-deps dbtool npm run db:migrate
pwsh -NoProfile -File scripts/database.ps1 run --rm --no-deps dbtool npm run db:verify
pwsh -NoProfile -File scripts/database.ps1 run --rm --no-deps dbtool npm run db:migrate -- test_migrator
pwsh -NoProfile -File scripts/database.ps1 run --rm --no-deps dbtool npm run db:verify -- test_migrator
```

db:check 只证明四个技术目标/授权，不证明业务结构。migrate/verify 默认 dev_migrator，测试库显式指定 test_migrator；CLI 不接受任意库名/上传 SQL。首次空数据目录由官方镜像初始化两套空库及其各两个技术身份；已有数据目录不重新执行初始化或自动轮换密码。已有完整配置不覆盖，部分配置停止并要求受控修复。

离线 scripts/generate-initial-schema.mjs 曾用于生成首版 JSON，禁止为改字段而删除并重新生成已应用资源。该文件 LF 由 .gitattributes 固定；完整资源字节 SHA-256 包含 SQL 和期望结构。已交付链为0001-foundation、0002-trial-save、0003-node-recovery；P04候选另支持0004-project-compatibility，实际环境版本查系统真相。已登记资源不可改写，新增版本在实施分支增加资源及含数据升级验证。 0010～0014在首次提交前已按CRLF字节执行，现用.gitattributes逐文件-text固定其已登记字节，禁止Git自动转行尾导致摘要漂移；其他新增迁移仍按LF创建，首次应用前先核Git暂存字节与构建资源完全一致。

P04增量的只读核对入口为`npm run db:compatibility -- <dev_migrator或test_migrator>`，需在相应网络和只读凭据挂载的数据库工具容器内运行；输出旧备注来源待核对、旧阶段计划与节点投影差异、旧pm引用，不输出备注原文，也不改数据。结构未达到候选0004时拒绝执行。该工具不代替备份和入库审查。

`npm run test:project-compatibility`仅限独立空实例：设置`GEEKDASH_MIGRATION_PROBE=1`、实测`GEEKDASH_MIGRATION_PROBE_SERVER_UUID`及`GEEKDASH_P04_OLD_SCHEMA`（固定0003构建的schema.js）。脚本核验旧文件摘要、实例UUID和空库前置；它会创建合成数据及故障注入，禁止指向常驻实例。0003文件可从f07450e基线按固定工具链独立构建获取，不能用当前0004文件冒充；摘要及执行证据见[P04-02报告](../testing/reports/2026-10-16-p04-02-compatibility.md)。失败后保留日志，重新建独立空实例再跑，不清空原业务库。

MySQL将TEXT的固定空串默认值标记为`DEFAULT_GENERATED`；候选核验器只接受已验证的utf8mb4空串字面量，不放行动态默认值或计算列。修改默认值的演练恢复应在utf8mb4连接内使用`MODIFY COLUMN summary text NOT NULL DEFAULT ('')`；不要用`ALTER COLUMN ... SET DEFAULT ('')`，MySQL会报`ER_BLOB_CANT_HAVE_DEFAULT`。这属于测试故障恢复，不是日常运维修改字段的入口。0003构建会拒绝0004结构；正式回退必须使用已固定并验证兼容的构建，不能删除新增列或清卷退回。

错误与接续：

| 情况 | 反馈与接手动作 |
|---|---|
| 配置缺失/目标或权限不符 | 非零退出；核对受控文件和实际身份，不删除已有数据目录重试初始化 |
| MySQL 不健康/文件挂载类型不符 | 读取仅本项目 mysql 日志；用 stat/test -f 核对容器内文件，禁止 cat 密钥或打印完整配置 |
| DB_MIGRATION_BUSY | 同库锁等待 5 秒超时，尚未执行此轮 DDL；核对正在执行的迁移，结束后重试 |
| DB_MIGRATION_CHECKSUM_MISMATCH / DB_SCHEMA_VERSION_UNSUPPORTED | 保留已有资源/数据；恢复对应代码版本或增加受控新迁移，不改登记绕过 |
| DB_SCHEMA_MISMATCH / DDL 中断 | 输出失败步骤或实际差异；已有 DDL 可能生效。无登记版本时仅完全一致的已建对象可续跑；已登记却缺约束则停止，不自动补修 |

健康或连接检查不能当备份恢复。停止仅本项目 mysql：database.ps1 stop mysql；数据目录保留。禁止 down -v、删目录、全局 prune 或操作其他项目容器。

故障演练脚本 test:migrations 会在 geekdash_test 中临时删除版本登记/外键并注入子进程死亡，仅可在没有人工使用的专用测试库运行；失败后先 db:verify 定位，按输出核对恢复，不在 geekdash_dev 或试用库演练。F02-A 的读写/重启验证采用 npm run test:db、重启 mysql 后 npm run test:db:resume，夹具范围与恢复以脚本回执为准。已执行范围见[报告](../testing/reports/2026-10-08-e01-f02-f03.md)。应用已接通运行凭据；F04 验证与恢复证据见[报告](../testing/reports/2026-10-08-e01-f04.md)。

F04 的专用测试命令：

```powershell
pwsh -NoProfile -File scripts/database.ps1 run --rm --no-deps dbtool npm run test:readiness
```

该脚本只在 geekdash_test 临时改登记/删除外键并复原，验证错误结构、超时、连接耗尽和真实进程关闭；无人使用测试范围才可执行。数据库仍健康时，停止 app 只关闭应用，MySQL 和数据保留；停止 mysql 会使运行中的 app 就绪及业务入口返回 503，恢复后重新完整核验，无需重启 app。当前业务读取/写入同时依赖真实就绪和可信会话；就绪故障不能被误报为密码错误。

维护账号命令行恢复的目标契约已按 DEC-070 确认，归 SPEC-001 F07，施工方法归[执行文档](../implementation/execution-plan.md#e02-f07维护账号无法登录时的受控恢复dec-070-已确认尚未实施)。当前没有恢复命令；实际实现后才在此补充固定环境入口、仅 GeekDash app 暂停/恢复及受控文件交接步骤，不能直接手改 SQL 冒充已验收流程。

## 2. 代码管理

- 2026-10-08 用户确认：工程实施在独立分支进行，已完成成果最终合并回远端 main。开始施工先 fetch 核对 main，处理并保留已有未提交内容，再从最新 main 创建 codex/ 短期分支；不在 main 直接编写功能代码。
- 一次变更围绕明确需求及验收，避免夹带无关整理。
- 2026-10-09 用户要求提交带具体工作阶段。提交标题写出阶段、功能单元和实际动作，例如「E03-W06～W07：实现普通编辑与关联保存」「E03-W08：记录公网部署及恢复验收」。未完成单元注明检查点，不写整阶段完成；提交正文列出已完成、验证及剩余项，准确进度仍归系统真相和交接。
- 一个可理解的工作单元完成后推送施工分支；相关验收、差异审查与文档同步通过后，合并并推送远端 main，再回读远端提交确认完整包含施工成果。存在冲突时先解决并验证受影响链路，不强制覆盖历史；未完成或验证失败的成果留在施工分支。PR 可用于审查，仓库保护要求 PR 时按其流程完成。
- 代码、规格、测试和必要的使用说明同一变更更新。
- 软件采用语义版本标识；0.1.0 当前仅标记工程基底，尚无业务发布。D0.x 是文档版本，与原本地版 V1.050 分开记录。
- 原始压缩包、核查副本、凭据、真实业务备份不默认进入 Git。

### 大阶段完成后的固定交付链（DEC-078）

用户于 2026-10-08 要求先写详细实施计划，再按步骤施工，每个大阶段完成后提交合并到远端 main。以下是唯一 Git 交付流程；六阶段及功能实施方法归执行文档 1.1。当前纯计划整理也形成独立文档交付，不能称 P03 代码验收完成。

1. 开始前 fetch 并核对 origin/main，检查并保留未提交工作；在 codex/ 分支施工。已有文档改动先整体保留到该分支，远端更新时正常整合，不能 reset 覆盖。
2. 阶段内允许围绕完整功能提交检查点。阶段验收须覆盖声明的功能范围、构建及受影响检查、真实业务链路和必要故障恢复；纯文档阶段只做文档检查。不满足验收时保留分支/交接，不把部分通过标成整阶段完成。
3. 同步该阶段涉及的规格/API、测试报告、系统真相、更新记录和交接，按 AGENTS 各自职责维护。准确记录测试版本；文档补记后的最终候选检查需与测试后的源码一致。
4. 检查 diff 与已暂存文件，提交已完成成果并推送施工分支。分支推送成功只完成这一步，不能报告已经交付 main。
5. 再 fetch 最新 origin/main；正常合并或变基到施工分支解决冲突，代码变动后重跑受影响验证。main 能快进则快进，否则正常合并；按实际仓库保护规则走 PR，禁止 force push main。
6. 将验收成果合并到 main 并推送 origin/main。若推送被新的远端更新拒绝，重新整合、检查、提交后再推，不能绕过竞态。PR 创建后按项目工具附到当前任务。
7. 用 ls-remote 回读远端 main，核对与本地交付提交一致；fetch 后核对施工成果确实属于 origin/main 历史。两项均成立才记录“已合并远端 main”。不能只凭 push 输出或本地 main 指针判断完成。
8. 接手入口记录实际提交、阶段已测范围/未完成项及下一功能。若最终交接补记需再提交，同样进入远端 main，并核对最后提交；不无限追加“刚推送成功”的文档提交。

大阶段可以分若干完整子单元先交付，但阶段关闭必须覆盖计划中本阶段全部有效范围；依身份后置或未决事实受限的项保持公开未完成状态。每次 Git 交付不默认部署服务器，人工择时部署和公网运行回读按本文件既有流程记录。

首次空仓库可以直接提交文档基线；若发现远程已有内容，必须先整合，禁止强制覆盖已有历史。

### 当前首个公网部署单元（DEC-071）

先部署免登录工程基底，流程以执行文档“当前执行优先级覆盖”和 SPEC 当前范围为准。部署不运行用户初始化/邀请码注册，不新增代理密码登录；数据库技术身份、受控配置、HTTPS 和隔离运行仍按已有工程边界实施。以下原身份/业务首版流程为后续完整目标，不能据其要求继续阻塞当前基底部署。Linux 入口已形成，实际命令见本节后文，结果以部署记录为准。

#### Linux 测试部署起始参数与实际差异

采用现有宿主机 Nginx 承接 HTTPS，Compose 项目名建议为 geekdash。拓扑归架构；逐功能工程处理归执行文档 E12-D01～D07。下表保留讨论起始值；已采用的配置和差异归后文实际运行入口，真实版本归 deployments。

| 项目 | 建议落位/参数 | 用途及边界 |
|---|---|---|
| 版本目录 | /opt/geekdash/releases/<revision>/ | Compose、专用站点配置、manifest；每版独立，不存凭据 |
| 当前版本 | /opt/geekdash/current → 已验收版本目录 | 验收后提升；真实容器镜像仍单独读回 |
| 公共运行配置 | /opt/geekdash/config/runtime.env | 非秘密路径/镜像标识/环境参数 |
| 凭据 | /opt/geekdash/config/secrets/ | 新数据库技术密码，受控权限、仅按服务挂载 |
| MySQL 数据 | /var/lib/geekdash/mysql/ | 独立持久 bind mount，更新镜像不清目录 |
| 备份暂存 | /var/backups/geekdash/ | E11 产生内容后使用；异地位置及执行权限仍按 Q-016 落实 |
| ACME 验证目录 | /opt/geekdash/acme-webroot/ | Nginx 的 /.well-known/acme-challenge/ 文件验证入口 |
| 专用站点 | /etc/nginx/sites-available/geekdash；sites-enabled 同名链接 | 只新增自身配置，server_name 为 geekdash.zhiluan.cool |
| app 端口 | 127.0.0.1:41860 → 容器 3000 | 启动前重新核对占用；只经宿主机 Nginx 访问 |
| mysql 端口 | Docker 私有网络内 3306 | 无 ports、不使用 host network |
| 初始资源 | app mem_limit=256m；mysql mem_limit=512m | 按当前余量给出的起始值，必须测初始化峰值/OOM及运行余量，未经验证不是性能保证 |
| MySQL 起始设置 | InnoDB buffer pool 128 MiB；max_connections=32 | app 池沿用 8，保留迁移/维护余量；不足时按实际观测调整 |
| 容器日志 | json-file，max-size=10m，max-file=3 | 每个常驻服务独立轮转，避免无界占用共享磁盘 |

app/mysql 常驻、restart=unless-stopped；dbtool 一次性退出。MySQL 使用现有 Compose 固定的 8.4 摘要，app 使用提交号和镜像 ID 清单，不使用浮动 latest。Compose 健康依赖要等待 service_healthy，进程 Running 本身不代表数据库可用；应用还执行实际 schema 核验。[Docker 启动顺序说明](https://docs.docker.com/compose/how-tos/startup-order/)

文件权限以实际容器身份验证：app 的 node 用户当前 UID/GID 应核对为 1000，运行 secret 叶文件可按 root:1000 0640 只读授权，父目录 root 0700；只有挂载的叶文件对 app 可见。迁移工具同样只挂所需身份文件。root/MySQL 初始化文件按官方镜像实际执行身份确定权限；数据目录 owner 也按该镜像核对。文件型 Compose secrets 使用宿主机文件挂载，不能靠 uid/gid 标签覆盖不正确的源文件权限。[Docker secrets 说明](https://docs.docker.com/compose/how-tos/use-secrets/)

#### 新域名参数与证书接续（DEC-072）

用户确认父域名在阿里云 DNS 管理；在该父域已有解析区内新增普通子域记录，无需另购域名或新建独立委派区。[阿里云子域记录说明](https://www.alibabacloud.com/help/en/dns/pubz-set-domain-name-subdomain-name-related-faq)

| 阿里云 DNS 字段 | 本次建议值 |
|---|---|
| 域名 | zhiluan.cool |
| 主机记录 | geekdash |
| 类型 | A |
| 线路 | 默认 |
| 记录值 | 当前已核对的新加坡测试机公网 IPv4；仅在受控执行回执中保存 |
| TTL | 建议 600 秒；以该解析区允许值为准 |
| AAAA | 本次不新增；有实际 IPv6 连通验收后再另行配置 |

实施时先核对阿里云当前登录/权限和 geekdash 的现有 A/AAAA/CNAME 状态，按真实值处理，不因用户说新建就盲目重复。先验新站点 HTTP 的挑战文件公网可读，再用已安装 certbot 的 certonly/webroot 模式申请该域名证书；HTTP-01 需要 80 端口，不能为独占端口停掉共享 Nginx。[Let’s Encrypt 验证机制](https://letsencrypt.org/docs/challenge-types/)

签发后新站点配置 443 证书与本机代理，80 除挑战路径外跳转 HTTPS；站点参数须适配当前 Nginx 1.24 和共享监听选项。配置/链接保存前版备份，只在 nginx -t 成功后 reload。新证书做一次限定该证书的 renew dry-run，并验证实际续期后的 nginx -t/reload 机制，不能仅凭已有 certbot.timer active 判通过。未来 SSE 实现时只对实际事件路由关闭代理缓冲，当前没有事件路由，不提前写虚构 endpoint。

#### 本单元操作顺序与恢复边界

1. 重新采样容量/端口/现有服务，完成小文件传输验证；确认固定版本与构建清单。
2. 传输并校验/加载镜像，建立专属目录/配置；只启动新 mysql。
3. 一次性迁移/新连接核验两库，再启动 app；本机 home/live/ready 与版本通过。
4. 阿里云新增解析、新站点 HTTP 挑战回读、证书签发、HTTPS 验证；每次 nginx -t 后才 reload。
5. 仅本项目断库恢复/应用恢复、持久结构回读、新证书续期演练，检查既有服务基线。
6. 通过后提升 current，记录实际部署；没有实际执行时 deployments 目录保持原状。

具体 Linux 脚本/命令在代码施工与验证后补入本节，不将建议文件名冒充已经可运行的工具。TAT 调用成功下发不能当执行成功；必须读终态、退出码和完整业务回执。返回内容截断则分小项重新查询，不由部分输出推断其余项正常。发布失败只处理自身站点/容器；首次无旧 GeekDash 运行版本时保留 MySQL 数据并修复或撤回候选入口，后续兼容回退使用已验证的上一镜像。不要删除持久目录、全局 prune 或重启整台共享主机。

Docker unhealthy 状态本身不会触发 restart 策略，restart=unless-stopped 处理进程退出；ready 持续失败应可见并人工定位。后续自动告警在有实际通知渠道时再落实，不虚构监控已经存在。本次不做完整业务备份或真实数据导入，E11 和 Q-016 仍按原门槛接续。

#### Linux 服务器实际运行入口

本单元已执行，实际版本/时间归[部署记录](deployments/2026-10-08-foundation.md)，实际结果归[验收报告](../testing/reports/2026-10-08-cloud-foundation.md)。后续建议目录与实际落位有差异时以本节为准，不能凭建议表重建当前数据。

服务器上使用受控维护身份，通过 tccli 下发短命令并回读终态。以下命令已对应真实入口；每步成功才继续：

```sh
release=/opt/geekdash/current
"$release/deploy/server.sh" ps
"$release/deploy/server.sh" logs --tail 50 app mysql
"$release/deploy/server.sh" run --rm --no-deps dbtool verify dev_migrator
"$release/deploy/server.sh" run --rm --no-deps dbtool verify test_migrator
```

只停止/恢复本项目：

```sh
"$release/deploy/server.sh" stop app
"$release/deploy/server.sh" up --wait --wait-timeout 180 app
"$release/deploy/server.sh" stop mysql
"$release/deploy/server.sh" up --wait --wait-timeout 180 mysql
```

断库时 live 保持 200、ready 为 503；恢复库后等待 app 自行重新核验并回到 ready=200。停止 mysql 会中断本项目正在运行的请求，人工择时；不使用 down -v。全部业务空库，不将上述恢复当真实数据恢复。

配置参数实际归 deploy/compose.server.yml：app 256m/mysql 512m、池 8/数据库连接上限 32、buffer pool 128 MiB、日志 10m×3、unless-stopped。配置文件以 /opt/geekdash/releases/<revision>/manifest.env 指定固定 app 镜像；建议表中的 config/runtime.env 尚未生成，当前不用它启动。server.sh 从自身版本目录解析 Compose 和 manifest.env；不依赖调用者工作目录。

配置生成器的固定回归入口为 scripts/verify-server-config.py，仅在一次性 Linux 容器中运行，不在服务器直接执行；仓库只读挂载，数据库/凭据目录不挂入：

```powershell
$taskTestImage = docker image inspect python:3.12-slim --format '{{.Id}}'
docker run --rm --network none -e GEEKDASH_DISPOSABLE_CONFIG_TEST=1 --mount 'type=bind,source=D:/geekwon/geekdash/deploy,target=/work/deploy,readonly' --mount 'type=bind,source=D:/geekwon/geekdash/scripts,target=/work/scripts,readonly' $taskTestImage python3 /work/scripts/verify-server-config.py
```

本次使用已安装镜像的不可变 ID，证据记录该 ID；它只是隔离验收工具，不是新应用运行依赖。脚本覆盖并发创建、重复复用、权限、部分配置和已有数据缺配置的保留边界；不会修改本地或云端 MySQL 数据。

首次技术配置命令为 python3 /opt/geekdash/current/deploy/init-server.py --mysql-gid 999；只在已确认 Linux 镜像实际身份下调用，完整配置幂等复用，部分配置/已有数据缺配置拒绝覆盖。实际 app node UID/GID=1000；运行/迁移 JSON root:1000 0640，MySQL 配置 root:999 0640，密钥父目录 root 0700。维护者不得 cat/打印其值。现有配置不要重新生成或轮换。

产物交付采用本机构建/导出 gzip 镜像、版本清单和非秘密发布包→项目私有 GitHub 预发布资产→本机获得该单文件限时下载链接→tccli 在服务器下载→整包 SHA-256 与镜像 ID 核对→load。GitHub 登录凭据只供本机授权，不传到服务器；限时链接只存受控执行资料、不进 Git/文档。SFTP 小包传输须验证 TAT 读回的主机公钥；本轮大文件中断/慢传后已改走发布资产，不能以小探针成功认定大文件可靠。临时传输身份没有 sudo，完成后撤销唯一自身公钥、锁定登录并删除本机私钥/自身上传暂存；今后需要时新建临时密钥，不复活旧凭据。

升级先确认 main 已含已验收代码，再本机按既有构建链生成固定产物；预加载镜像和配置，核对迁移兼容/备份门槛，只更新 app。兼容旧镜像回退时以本次子进程的 GEEKDASH_APP_IMAGE 指定旧固定镜像，使用 server.sh up --no-deps --wait --wait-timeout 180 app；从公网核对旧版本/ready 后再决定保持或恢复目标版本。核验后更新 current 到相应配置目录；当前指针与真实容器镜像分别回读。不自动恢复旧数据库，也不自动部署每次 Git 推送。

Nginx 站点为 /etc/nginx/sites-available/geekdash 及同名 enabled 链接。修改只涉及自身站点，nginx -t 成功后 systemctl reload nginx。本轮 IPv4 TLS listener 使用 ssl，适配已有网关；不添加与其他监听不一致的 http2 选项。证书续期 hook 为 /opt/geekdash/config/renew-nginx.sh，执行 nginx -t 再 reload；本机 Certbot 保存选项名 renew_hook。限定演练命令已通过：certbot renew --cert-name geekdash.zhiluan.cool --dry-run --run-deploy-hooks --no-random-sleep-on-renew。既有 timer active；失败查看本域续期结果，不修改其他证书。

/var/backups/geekdash 已有本次只读发布前的两库逻辑备份，实际路径/摘要归[部署记录](deployments/2026-10-08-project-reads.md)；仍没有完整备份任务、隔离恢复或服务器外副本结果。真实导入前完成 E11 和 Q-016 资源落实。MySQL 空库内存观测已接近起始上限，业务/真实数据接入前按实际增长和宿主余量复核配置；业务并发规模与资源预算按实际需求和测量确定，不沿用短测宣称多人实际使用的性能已通过。

项目只读回归入口为 npm run test:projects，使用独立 test_app 及真实 HTTP/MySQL，须在专用库无项目夹具时运行。不要与就绪/结构故障测试或保留夹具的浏览器服务同时运行。云端使用固定发布包 verification/verify-project-reads.mjs 挂入一次性 app 容器 /app/scripts、连接自己的 database 网络，并以 GEEKDASH_TEST_RESULT_DIR=/tmp/test-results 写临时结果；只挂 test_app，不挂正式配置，结束核对逐表清理。公开免登录只读入口不提供数据库初始化或夹具灌入按钮。接口协议见[项目读取](../specifications/api/projects-read.md)。

### P03-A 保存单元运行入口

结构升级先暂停本项目 app、记录两库版本及业务计数并备份，再使用候选构建 dbtool 执行 migrate/verify；当前版本为0002-trial-save。0001 构建拒绝0002结构，不能直接用旧镜像回退；异常先保留数据、停止写入，以兼容0002的修复构建恢复。恢复旧备份必须单独评估发布后数据，禁止自动覆盖。

```powershell
pwsh -NoProfile -File scripts/database.ps1 run --rm --no-deps dbtool npm run db:trials
pwsh -NoProfile -File scripts/database.ps1 run --rm --no-deps dbtool npm run test:saves
pwsh -NoProfile -File scripts/database.ps1 run --rm --no-deps dbtool npm run test:capacity
```

db:trials 仅在 dev 建三个稳定来源合成样本，重复保留实际编辑。后两项在专用 test 使用并清理自己的来源，含真实事务及故障注入，不能在人工试用时并发跑结构/就绪故障测试。容量500项目不限制正式总数。云端一次性验证容器只挂 test_app/test_migrator、固定验证脚本及临时结果目录；结束核对夹具清理，不提供公网灌入按钮。

服务器 Compose 将本项目 MySQL 上限设为768MiB，理由见 DEC-088；原容器可用 docker update 在线改上限，发布时记录其 ID/StartedAt 是否保持。仅 up --no-deps app 不重建 MySQL。上限不是常态用量，持续实测仍需关注共享主机余量。

## 3. 首版发布流程（人工择时已确认，DEC-057）

需求与规格 → 施工分支开发 → 模块测试 → 差异审查（需要时使用 PR）→ 合并并推送 main → 构建固定镜像/包 → 测试部署 → 业务验收 → 同一构建物推广正式 → 运行回读。

| 事件 | 建议时机 | 必要证据 |
|---|---|---|
| 开发分支推送 | 工作单元完成，便于备份与审查 | diff、相关需求和检查结果 |
| 测试部署 | 自动检查通过后；共享试用期间安排合适时段 | 构建标识、迁移演练、受影响链路检查 |
| 正式部署 | 测试验收通过，在约定维护窗口 | 用户验收、备份、回退方案、发布负责人 |
| 紧急修复 | 针对性回归与核心冒烟完成后 | 问题影响、修复证据、恢复方案 |

首版检查通过后人工择时发布；Git 推送后保留构建/验证结果，另行安排部署，不创建推送即自动部署任务。服务器在新加坡，不影响按公司工作时区安排维护。

首版执行（DEC-057）：测试环境人工择时发布，通过相关检查后选择无人编辑的时段。若有人正在使用，发布前提示保存并退出编辑，发布后执行登录、写入回读和版本核对；处理失败提供回退/修复入口。具体正式维护窗口、负责人及可接受中断时间仍待 Q-008，不从择时原则补造时长。

## 4. 数据库迁移

### 完整业务测试环境首次初始化（后续目标，DEC-051；当前范围按 DEC-071）

1. 创建本项目独立 MySQL 实例和持久卷；建立人工试用库、自动测试库及独立授权，不连接其他系统业务库。运行账号只访问自身库，迁移/备份凭据受控保存。
2. 运行版本化迁移，按 SPEC-001 受控初始化首个维护测试账号，再生成邀请码并注册首批业务测试账号；临时初始化/重置凭据受控交付，注册者自设正式密码。身份开通链路尚未实现，不能沿用固定五账号统一发临时密码方案。
3. 在专用自动测试库验证登录、项目保存、新请求回读、审计、同项目冲突、重启和备份恢复。人工试用记录须明确标识，不能由测试脚本清空试用库。
4. 验证完成后，由业务账号将真实备份上传至持久审查区。未审数据不进入看板；字段映射及异常逐项可见，保留来源，按 SPEC-009 明确审查并提交。
5. 导入后以新请求逐项对账，核对原字段、关系、历史及看板/输出消费。原备份保持只读，不纳入 Git，不以临时测试数据冒充真实迁移成功。

### 后续迁移

1. 迁移前记录当前数据库版本，验证可恢复备份。
2. 优先增加兼容结构，再迁移数据和切换读写，最后在后续版本删除旧结构。
3. 已执行的迁移文件不回改；新增迁移修正错误。
4. 自动化和试用数据分库；在副本上演练有数据的升级，空库建表成功不足以通过。
5. 破坏性或不兼容迁移单独安排窗口；通知并处理仍在编辑的用户和后台任务。
6. 不在应用启动时无条件清空、重置或导入默认项目。

## 5. 发布过程与浏览器兼容

- 运行配置与业务数据不打进镜像。静态资源使用内容哈希，保留必要旧资源以支持发布期间的页面。
- 服务启动先完成健康与依赖检查；记录实际代码版本和 schema 版本。
- 单机资源不足以双版本并行时，接受有计划的短暂停机，不能未经验证承诺无停机。
- 保持至少发布窗口内旧页面/API 的兼容；不能兼容时明确提示用户保存草稿后刷新。
- 发布后从外部入口登录、写入测试记录、用新请求读取并核查历史，再删除或归档明确的测试记录。
- 验证其他既有服务仍健康。本项目不自行修改其端口、数据库或容器。

## 6. 回退与恢复

### P05导入的运行文件与0006恢复

P05部署增加`/var/lib/geekdash/imports`持久目录，应用的`GEEKDASH_IMPORT_DIR`指向同一路径；目录预先建立并授予容器node用户最小写权限，不能写在镜像层或发布版本目录。代理与应用上传上限均为32MiB。发布前除了双库完整逻辑备份，还须保存受控配置、原文件目录及数据库引用文件的路径/长度/摘要清单；缺失文件先查明，不能称完整备份。

0006升级须验证两库结构及旧34表原列的逐值保持。旧0005应用不兼容0006。若只需暂停导入写入，可在已经实测的0006构建设置`GEEKDASH_IMPORT_WRITES=disabled`，保留原操作查询及项目使用；必须先验原项目查询、保存和新请求读取。该方式复用同一构建，不等于另有一个独立兼容镜像；若该构建无法启动，应保持本项目维护入口并前向修复。不要回灌旧数据库覆盖后续记录，也不要停止共享主机的其他服务。

应用回退优先使用上一兼容构建物。数据库不能因为应用回退就随意恢复旧备份：那会丢失发布后的业务数据。

每次发布明确：旧应用能否读取新结构、迁移能否前向修复、是否必须暂停写入、恢复会损失哪些时间段的数据。不能保证时明确阻止发布。

后台任务发布时停止领取新任务，等待或安全中断在途任务；重启后按幂等规则恢复。不得靠内存队列承载必须保留的任务。

## 7. 备份和维护

### P05项目空间切换与0009兼容恢复

本节是候选产物的操作流程，不代表已在服务器执行。过渡产物、迁移和恢复的实际范围引用[2026-10-26验证报告](../testing/reports/2026-10-26-project-space.md)。旧0008应用不能读取0009，不能直接退回旧镜像或用旧SQL覆盖新成果。

| 配置 | disabled的作用 | 仍可使用 |
|---|---|---|
| `GEEKDASH_IMPORT_ACCEPTING` | 停止接收新上传、导入变更及执行命令 | 原已接受执行继续，结果查询可用 |
| `GEEKDASH_IMPORT_WRITES` | 停止导入接收及后台执行 | 原执行结果、来源读取及预览 |
| `GEEKDASH_BUSINESS_WRITES` | 暂停所有业务HTTP写入及导入后台任务 | 页面、授权读取、登录/改密/退出、原结果查询及只读预览 |

三个配置在`deploy/compose.server.yml`默认enabled，恢复开关写入该次受控部署环境文件并重建本项目app容器后核对；不在业务页面提供设置。全业务暂停返回503 `BUSINESS_WRITES_PAUSED`及`outcome:not_committed`，前端保留输入。非法全业务开关值拒绝启动，不能误当正常开放。

1. 从当前0008基线准备只增加接收关口的过渡产物，保持原worker协议；记录提交和构建摘要。关闭新接收，优雅退出原进程并回读所有原执行，等待全部终态。存在提交未知则先核原结果，不迁移。
2. 停本项目业务进程，备份两库、原上传文件和配置，核当前存量重名；没有其他同库写进程后执行0009。只读逐ID/原列摘要、原回执和文件清单对账，DDL中断按原迁移续跑，不能重置库。
3. 切已验证0009应用，原会话及原任务查询确认后再开放写入；运行验证使用合成项目，不替用户通过原真实批次。
4. 若新应用需要撤回，停止其进程，切回已验证的0009兼容固定产物，设置全业务只读。先核健康、登录、原项目/历史、原任务及原成功回执；确认一致后恢复对应写入。只读前已经接受的任务保留，恢复后按原操作接续，不改成失败或重复入库。
5. 演练或发布前检查连接同一数据库的所有GeekDash应用进程；只停止本次明确受控实例。单一测试进程的环境开关不能阻止另一仍在运行的worker领取任务。失败现场和业务结果保留，禁止以重跑初始化掩盖。

**受控执行入口。**不另建自动部署服务，沿用固定版本目录的`deploy/server.sh`与`dbtool`。下表是尚未执行的命令顺序；`drain_dir`、`next_dir`由本次核验过的归档在服务器解包后确定，不能直接取本机路径。开始前必须完成整阶段验收、核远端main包含候选、镜像/归档摘要及运行版本；每行核对成功后才执行下一行。

| 步骤 | 命令或已有入口 | 继续条件与失败恢复 |
|---|---|---|
| 过渡封口 | 过渡目录`manifest.env`持久写`GEEKDASH_IMPORT_ACCEPTING=disabled`、`GEEKDASH_IMPORT_WRITES=enabled`；执行`"$drain_dir/deploy/server.sh" up --no-deps --pull never --wait --wait-timeout 180 app` | 核容器镜像、环境、0008健康及原进程确已退出；逐项回读原执行，双库均无未终态任务。否则留在0008核原结果，不执行迁移 |
| 停写与备份 | `"$drain_dir/deploy/server.sh" stop app`；确认没有其他同库写进程。沿本节完整备份范围保存双库逻辑备份、原上传文件、配置与清单，记录原表原列摘要和迁移登记 | 备份命令终态、完整范围、摘要及受控服务器外副本按既有Q-016安排核实；不能凭文件存在继续。未尝试DDL时可恢复同一0008过渡应用 |
| 增量迁移 | 分别对`dev_migrator`、`test_migrator`执行`"$next_dir/deploy/server.sh" run --rm --no-deps --pull never dbtool migrate <profile>`，随后以相同入口执行`verify <profile>` | 两库0009验证通过，原表原列/原回执和上传文件摘要一致；中断保留进度，使用同一迁移续跑，不启动0008应用 |
| 只读切新 | 新版目录`manifest.env`保持`GEEKDASH_BUSINESS_WRITES=disabled`，执行`"$next_dir/deploy/server.sh" up --no-deps --pull never --wait --wait-timeout 180 app` | 容器镜像与build一致，live/ready、原会话、原项目和原成功结果新读通过；此时尚未完成发布，不开放写入 |
| 开放与回读 | 在相同`manifest.env`中明确改为`GEEKDASH_BUSINESS_WRITES=enabled`后重建本项目app；其余接收/执行开关按候选配置启用 | 用合成项目完成公网操作及下游新读，再核current指针、容器与公开资源版本；不替用户通过真实未完成批次。失败恢复为已验证0009镜像的全业务只读，保留发布后写入 |

本次测试发布按DEC-166在本机`D:/geekwon/geekdash-data/backups`保存加密完整副本，解密凭据单独受控、不入Git，迁移前核对解密内容与服务器原备份摘要。正式长期服务器外备份资源、恢复目标及窗口的未决部分仍查决策Q-008/011/016；本表不代为确认目的地、权限或可接受数据损失。实际命令、路径、备份和回读结果只在执行后记入部署记录，不能把本表或本机候选清单当作已部署。

完整性按 SPEC-016 验收。部署前后维护持久数据与文件清单、schema/软件版本和恢复依赖；已实施的新实体或文件产物须进入清单。每次恢复演练记录缺失项及可用性，不能用备份文件存在代替完整性核对。

测试首版备份策略已按 DEC-056 确认：每天一份完整备份，保留 14 天；每次发布/迁移前额外备份，并保存加密的服务器外副本。完整来源和一致性边界按 SPEC-016，不能只备份项目表。执行时间在部署配置及受控环境记录中登记；策略确认不表示已经运行，实际备份、定时任务和恢复状态归系统真相与部署记录。

首次真实导入前完成一次隔离恢复，核对业务、关联、历史、私人状态及产物再验证页面/报告消费。服务器外存放位置、访问凭据、完整备份下载/恢复操作者，以及最大允许丢失时间（RPO）和恢复时间（RTO）仍待 Q-011/016 落实；每天备份不等于已经满足恢复目标。备份失败必须可见，不能仅凭文件存在认定成功。

恢复演练在隔离库完成，读取项目、关联、审计和报告后核对，不仅检查备份文件存在。

运行关注：错误率、延迟、磁盘空间、数据库连接、慢查询、备份状态、任务积压、证书到期。定期评估依赖升级，使用固定版本与锁文件，不盲目追随 latest。

## 8. 发布记录模板

每次软件发布记录：版本、提交、构建摘要、数据库迁移版本、需求范围、测试结果、目标环境、备份/回退方式、执行人、时间、运行版本回读和业务验收结果。

软件发布及文档变化统一记录在[更新记录](../changelog/CHANGELOG.md)，当前实现状态见系统真相。


### E03-W06～W08 普通保存扩展验证入口

复用P03-A构建/数据库/发布入口，无新迁移，不改已登记资源。使用scripts/database.ps1 run --rm --no-deps dbtool分别运行npm run test:ordinary、test:saves、test:projects、test:capacity；各脚本仅操作自己的合成来源。失败先核对夹具与受控结果，不在dev清空重跑。

发布核对两库结构与固定镜像，专用库回归完成后才短暂停自己app，完整备份、保留已有数据并补合成候选，再启动固定构建和回读公网。含二进制回执的数据指纹按bytes比较；未知执行结果先对账，不无条件重解包/覆盖/切换。实际版本与停点见[部署](deployments/2026-10-09-project-ordinary.md)，不复制运行事实到流程。

## 最小身份测试开通与运行核对（E03-W09～W12）

当前命令npm run db:test-accounts对应dist/server/commands/test-accounts.js，仅受控测试初始化，参数为dev_migrator或test_migrator、容器内受控文件绝对路径、明确环境名。文件与实际库/环境/初始化操作绑定；既有凭据/账号不匹配停止，重跑不重置已改密码账号。首次固定business01～04和maint01只是测试种子，不是业务人数限制，也不是公开注册。

本机只读挂载仓库外受控文件；Compose run使用--volume，普通docker run使用--mount。Linux mode600文件仅受控bootstrap root临时读取；常驻app仍node且只挂运行数据库身份。具体已执行初始化/路径/凭据分发归部署记录，不在文档粘贴密码、密码哈希或Cookie。

GEEKDASH_ORIGIN固定应用真实Origin，公网https://geekdash.zhiluan.cool，本机HTTP只允许环回；修改端口须同时更新Origin，不能任意信任代理来源。服务器Cookie必须Secure，业务401由正常登录恢复、首次改密403由改密后重新登录恢复；数据库503保留上下文不能清成退出。live读取build版本，ready读取status与真实依赖，两响应结构不同。

没有邀请码/完整账号维护或F07维护恢复命令，不能手改SQL当成已验收恢复。发布前备份仍按原流程，实际进程会话恢复不替代隔离数据库恢复。

## Harbor 独立交付与云数据库选项（2026-10-29）

**环境边界：**下列Compose合一包属于此前独立交付。用户随后确认新环境为阿里云K3s+RDS，新环境改用本文末尾目标交付流程，不能直接套用此包。

本节适用于产品构建 `cc4a34b`、结构 `0015-project-deletion` 的独立空白部署。既有新加坡实例的发布流程仍按前文；本节不表示已经部署到目标服务器。

### 交付版本与执行顺序

- 当前镜像：`harbor.geekwontek.com/geek-dash/geekdash:V0.1.1-cc4a34b`，平台 `linux/amd64`，包含应用、MySQL 8.4 和初始化程序；Nginx 在镜像外。
- 交付目录：`D:\geekwon\geekdash-data\harbor-cc4a34b\package`。上传者在此运行 `push.bat`，上传成功后再通知服务器拉取；`-CheckOnly` 只检查，不上传。
- 给服务器的文件：`compose.yaml`、`.env.example`、`admin-account.json`。账号文件包含受控密码哈希，单独安全传递，不放进镜像或代码仓库。
- 本次包初始化空白环境：仅保留 `admin` 及原密码、既有权限，不携带原项目、资料、其他账号或旧历史。不要把本次初始化用于覆盖已有业务库。

在服务器的本次独立部署目录执行：

```bash
cp .env.example .env
```

填写 `.env`，其中 `GEEKDASH_ORIGIN` 必须是使用者实际访问的网址，不带末尾斜线。示例域名需替换为此次实际域名：

```dotenv
GEEKDASH_IMAGE=harbor.geekwontek.com/geek-dash/geekdash:V0.1.1-cc4a34b
GEEKDASH_ORIGIN=https://实际域名
GEEKDASH_BIND=127.0.0.1
GEEKDASH_PORT=41860
```

```bash
docker login harbor.geekwontek.com
docker compose pull
docker compose up -d --wait --wait-timeout 300
```

容器自动生成数据库技术账号、建库、执行迁移并初始化管理员；不需要服务器安装 Node 或手工导入建表 SQL。端口冲突时调整 `GEEKDASH_PORT`，同步修改反向代理上游；外部域名不变则 Origin 不变。

### 此项目的特殊配置

| 项目 | 本次要求 |
|---|---|
| HTTPS 反向代理 | 同机宿主 Nginx 转到 `127.0.0.1:41860`，传递 `Host`、`X-Real-IP`、`X-Forwarded-For`、`X-Forwarded-Proto`。Nginx 若运行在另一个容器，需要配置到应用的实际网络地址，不能使用其自身的 127.0.0.1。 |
| 更新通知 SSE | `/api/events` 使用 HTTP/1.1，清空 `Connection` 请求头，关闭 `proxy_buffering` 和 `proxy_cache`，`proxy_read_timeout 60s`。 |
| 备份上传 | 代理上传上限 `client_max_body_size 32m`，与应用一致。 |
| 数据存储 | Compose 的 `data` 卷挂载到 `/var/lib/mysql`，同时存数据库、运行配置和导入原文件。保持 Compose 项目名 `geekdash-harbor` 和原卷，不执行 `down -v`。内置 MySQL 不对外暴露端口。 |
| 备份与更新 | 数据库逻辑备份、导入原文件、受控配置需一起保留；运行中的数据库目录不能简单复制当完整备份。更换应用前留备份和旧镜像，数据库回退另行核对，不能用旧备份覆盖更新后的业务记录。 |
| 实例数量 | 当前只启动一个应用实例。编辑在线状态、SSE 连接等保存在进程内，不直接横向扩多个副本。 |
| 日志 | Docker 日志每文件 10 MB、最多 3 个；重建前导出所需旧日志。现有部分 500 错误只记错误码，没有完整堆栈。 |

启动后核对：

```bash
docker compose ps
curl -fsS http://127.0.0.1:41860/api/health/ready
curl -fsS http://127.0.0.1:41860/api/health/live
docker compose logs --timestamps --tail 200 geekdash
```

预期：容器 healthy，ready 正常；live 的产品版本为 `cc4a34b`、schema 为 `0015-project-deletion`。镜像标签是 `V0.1.1`，产品构建仍是 `cc4a34b`，二者不同不是部署错误。随后从实际 HTTPS 域名读取同样的健康接口；页面与业务操作由使用者验收。排错时保留报错时间、页面、响应 `requestId`、对应日志和上述版本信息。

### 早期云MySQL建议（新环境由下方K3s与RDS方案替代）

建议拓扑：

```text
浏览器 → HTTPS / Nginx → GeekDash 应用容器（单实例）→ 云 MySQL
                             └→ 导入原文件持久目录
```

服务器只拉取应用镜像，MySQL 服务及数据由云数据库承载。应用镜像可以继续减小，但目标镜像尚未制作，不能把当前 146 MB 压缩内容的合一镜像当成云库版本。适配后另出构建与镜像标签，不能沿用本次“111 个业务文件哈希不变”的验证结论。

| 部分 | 需要落实的变化 |
|---|---|
| 镜像与启动 | 另交付应用镜像、云库 Compose 和一次性初始化入口；移除启动内置 MySQL 的流程及 `mysql:127.0.0.1` 映射。当前 `push.bat` 仍只上传合一版。 |
| 连接与版本 | 当前代码固定主机、端口、库名、账号及 `@%` 身份，且只接受 MySQL `8.4.x`。改为读取明确的部署目标并核验身份，保留开发/测试隔离。目标若是 8.0 或厂商兼容内核，先做兼容适配，不能只跳过版本检查。 |
| 网络与 TLS | 建议应用与数据库同地域、通过可达的私有网络连接；只放行应用来源。接入厂商 CA 并验证服务端证书及主机名，不能关闭验证来绕过连接失败。当前 Node 连接配置尚未接入 TLS。 |
| 数据库与账号 | 使用独立数据库，InnoDB、`utf8mb4_0900_ai_ci`，会话 UTC。运行账号仅需本库 SELECT/INSERT/UPDATE/DELETE；迁移账号另需 CREATE/DROP/ALTER/INDEX/REFERENCES，只在初始化或升级时挂载。目标平台的授权输出、information_schema 和命名锁能力要实测适配，不能照搬当前“SHOW GRANTS 恰两行”的校验。 |
| 初始化 | 新空库由一次性任务执行迁移和 admin 初始化，成功后应用只挂运行凭据。若承接已有数据，使用受控完整备份恢复并核对，不能执行空库初始化覆盖。 |
| 文件与备份 | 保留独立持久目录，设置 `GEEKDASH_IMPORT_DIR` 并允许应用 UID 1000 写入。云库备份不包含导入原文件及应用配置，仍需另行备份。 |

MySQL 官方区分“连接加密”和“验证服务端身份”；部署时应同时检查证书与目标主机名。依据：[MySQL 加密连接说明](https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html)。

云库交付顺序：确认厂商/地域/版本和私网连通 → 提供库名、运行及迁移账号、CA → 适配并构建应用镜像 → 隔离验证迁移、读写回读、断线恢复及完整备份恢复 → 初始化目标库 → 启动应用并核对公网入口。凭据另行传递，不填写进本说明。

**需要服务器同事反馈的云库信息只有：厂商与引擎版本、地域与连接方式、地址端口及库名、账号授权方式、TLS/CA 要求。** 在这些信息和适配完成前，可执行交付仍是上面的内置 MySQL 方案；本轮仅整理文档，未切库、未上传或部署。

<a id="k3s-production-delivery"></a>

## 阿里云K3s与RDS MySQL目标交付（2026-10-29）

用户已确定新环境使用阿里云服务器上的K3s与阿里云RDS MySQL，版本范围为“8.0+”，即8.0及以上，不限定8.0.x；DEC-173确认前后端独立Deployment、同域、首版同版本发布，DEC-174确认后端单副本与维护窗口发布。本节是详细讨论方案，不是已经可执行的清单；具体维护时段/时长、存储及恢复目标仍待确认。具体代码落位和八项施工粒度归[执行计划1.4](../implementation/execution-plan.md#k3s-delivery-plan)。新环境不使用旧Compose合一包，现有腾讯云和本地环境保留。

| 交付部分 | 目标内容 |
|---|---|
| 镜像 | 前端静态镜像与后端服务镜像，版本配对；迁移Job复用后端镜像，不含MySQL服务。发行清单固定两份仓库digest、提交和schema；不上传桌面安装包、本地数据及凭据 |
| K3s配置 | 独立namespace、两组Deployment/Service、实际Ingress、ConfigMap、Secret引用、应用ServiceAccount和导入文件PVC。后端单副本，不自动横向扩展，维护窗口发布；不新增宿主Nginx |
| 数据库初始化 | DEC-176已确认首次空白新库；同事预先建本项目独立空库和授权，Job创建结构并初始化管理员。正常升级不重复seed，运行Pod只挂运行凭据，迁移凭据只给Job |
| RDS适配 | 连接目标可配置，接入TLS/CA；针对实际部署的MySQL 8.0+版本核对DDL/约束、迁移、身份授权及命名锁，不仅放宽版本字符串。保留独立业务库、InnoDB、utf8mb4及UTC |
| 文件与备份 | 导入原文件仍用持久目录，设置GEEKDASH_IMPORT_DIR并允许UID 1000写入；RDS备份不覆盖原文件和部署配置 |
| 入口 | 同域/api原路径转后端，其余页面资源转前端；准确GEEKDASH_ORIGIN、可信代理链和Cookie，支持32MiB上传/SSE及时转发。采用实际Ingress配置，不直接照抄Nginx专有参数 |

部署前由同事核实RDS精确版本、Pod私网连通与白名单实际来源、端点/库名/授权/CA；K3s版本、架构、Ingress/域名证书、StorageClass/回收策略、Harbor节点信任和日志保留。地域不是当前设计阻塞，“应该能连”不算验证。K3s节点使用的containerd拉取与开发机Docker登录分别核验；namespace拉取凭据不替代节点对自签CA的信任。

用户2026-10-29明确域名之后提供。构建产物不写死正式域名；前端沿用相对API路径，部署时统一配置Ingress主机、证书及后端GEEKDASH_ORIGIN。域名未给不阻止构建和隔离技术验证，但正式HTTPS入口、Cookie/Origin和真实域名验收须在域名及证书到位后完成。不默认复用或修改原腾讯云域名，也不在未确认时更改DNS。

### 首次部署流程（空白新库已确认，待环境就绪）

1. 在构建端产出并核验两份镜像，推送Harbor，回读仓库digest；提供发行清单及无凭据的环境配置。Docker仅承担本机构建/上传，服务器运行操作统一走K3s，不依赖Compose或Docker socket。
2. 核对kubectl context及namespace，建立持久资源、Secret引用和Service；预检目标节点拉取、RDS及实际存储。未知占位值不允许直接apply。集群级组件和付费资源由同事既有管理流程处理。
3. 按DEC-176核实目标为本项目空白新库，运行一次性迁移/初始化Job，创建结构并初始化管理员。后续业务数据通过现有备份导入入口处理，不自动搬旧库或写入测试项目。若发现非预期旧数据则停止核查，不清库覆盖；已登记的本次迁移中间态按原迁移能力接续，已完成初始化的重试只核验结果，不重复建账号或重置密码。建议Job单并发、Never、backoffLimit为0，失败保留现场；命名锁和幂等仍必需，因为控制器可能重复启动任务。
4. 等Job明确成功并核验schema，启动后端，再启动配对的前端，等待各自探针通过。创建资源并不代表发布完成，不能用一个递归apply隐含依赖顺序。
5. 从真实HTTPS入口核对两个构建版本、API就绪、Cookie、SSE、上传与持久回读；开通用户真实验收。记录准确未验项和恢复入口。

### 日常更新流程（维护窗口方式已确认，具体安排待定）

```text
预检配置 / 两镜像与节点拉取
  → 进入维护窗口，停止接收新写入并排空当前请求
  → 停止后台任务领取、等待当前条目安全点并停止旧后端
  → 确认没有其他写入者，获得数据库与原文件可配对的恢复点
  → 如有结构变化，运行本发行的迁移Job并核验
  → 启动新后端并等待ready
  → 发布配对前端，核对页面资源和旧页面兼容
  → 从域名回读版本与业务结果
  → 解除维护并记录发布
```

维护应提供明确反馈，不能长期留下随机502。具体维护入口随实际Ingress实现，不通过删除PVC或改生产数据模拟。当前业务写入开关不阻止全部认证写入，也不能单独证明后台导入已停止；发布备份须将任务领取、当前条目、全部应用写入者及数据库/文件恢复点一起核对。无迁移的更新跳过Job；前后端两个Deployment不是原子更新，发行清单和维护步骤负责防止半更新开放。HTML不长期缓存，摘要资源可缓存；已打开标签页保留未保存输入，不静默强刷。当前schema精确校验意味着变更后通常不能直接启动旧版本。

### 健康、终止与最小运维

- 前端探针验证静态服务；后端startup给正常启动足够预算，live不依赖RDS，ready不通过则不接业务。数据库短断不是进程故障，不以live错误重启整个应用。
- Pod终止沿摘流、禁止新写/领取条目、关闭SSE、等待请求/导入当前条目安全点、关闭池执行；K3s宽限大于应用退出预算。强杀仍需靠持久回执和租约恢复，不承诺所有请求必定完成。
- 设置合理requests/limits、非root、必要写目录和最小权限；ServiceAccount默认不挂API token。网络策略仅允许需要的入口、DNS和RDS路径，按实际插件与网络条件核验，不能配置后未测即称隔离有效。
- RDS、导入原文件、受控配置分别备份并建立可配对恢复点；旧库绝对文件引用须兼容。PVC不随版本更新删除，默认local-path卷不等于跨节点恢复。备份周期/保留、允许丢失时间与恢复时间待确认。
- 使用现有集群日志保留/告警设施，确认Pod删除后日志仍可追溯；保留release、Pod、requestId、迁移步骤及脱敏错误。仅`kubectl logs`不是永久日志归档。RDS备份、K3s控制面备份、业务文件备份不可互相替代。

<a id="k3s-maintenance-coverage"></a>

### 正式使用的维护覆盖（2026-10-29补充讨论，未实施）

维护分为产品管理和基础设施运维。原账号/邀请码/角色/资料/CHECK管理按已确认SPEC承接并验证，不能因K3s拆分丢失；发布、备份、证书、节点和RDS维护交由受权运维入口，不在业务后台增加集群控制功能。下表是本轮发现必须补齐的操作设计，责任划分是建议，具体执行人/频次/保留期仍需确认。

| 维护项 | 实际链路与完成依据 | 建议责任与待补输入 |
|---|---|---|
| 维护停写与恢复使用 | 维护提示→停止新请求/新导入条目→排空现有请求和当前条目→确认全部应用写入者停止→建立恢复点；发布核验后恢复。不把业务开关、静态提示页或ready变化单独当作全部写入停止 | 应用侧落实排空/回执，发布人执行维护；窗口仍待用户确认 |
| 定时备份和恢复演练 | 确认RDS可用备份策略；原文件与受控配置独立备份并记录恢复点、摘要、最后成功时间和失败状态。恢复到隔离库/卷后核对项目、账号、历史及原文件引用，再记录实际耗时；不能以“生成了备份”替代“恢复成功” | 同事管理存放、权限和定时设施；用户确认RPO/RTO/保留期。优先已有设施，缺少时再使用CronJob，避免两套任务重复跑 |
| 告警与故障响应 | 至少覆盖公网不可达/API错误持续增加、Pod反复重启/OOM、RDS连接或容量异常、卷空间不足、备份失败/长期无成功、证书即将过期。告警附版本、时间、受影响环节和恢复入口；明确接收人/替补/恢复通知并做一次告警送达验证 | 复用集群/云已有平台；阈值、接收渠道、值守责任待落实，不新增未获批准的消息发送或监控平台 |
| HTTPS证书及凭据更换 | 分清域名证书、RDS CA/密码、Harbor凭据及kubeconfig。先验证新材料→更新引用→明确重载/重启消费者→健康及业务回读→撤销旧材料；失败保留受控回退。Secret内容变化不等于进程连接池自动切换；使用集群实际Secret保护/RBAC，base64不是加密 | 同事负责证书/云账号及到期；应用侧落实受控重启/连接验证。轮换周期与旧材料撤销条件待确认 |
| 磁盘和保留管理 | 区分上传临时片段、被项目/批次引用的原文件、个人草稿、审计/回执、过期会话与备份。只能按确认过的规则清理可证明无活跃任务且无引用的临时内容；先预览统计并留执行结果。身份是否过期仍实时判定，不依赖清理任务才能拒绝登录 | 业务历史/草稿/原文件保留期是待决；当前不自动清理旧镜像/容器/卷，也不把本轮方案当作解除此前暂停清理的授权 |
| 管理员无法登录的恢复 | 保留正常改密和账号管理链路；紧急情况下建议受权运维用一次性受控命令恢复明确账号、撤销其旧会话并审计，保留账号ID及项目关系；不重跑seed、不清库、不设置通用后门 | 紧急恢复资格、凭据交付和触发边界待用户确认；属于待设计能力，不宣称现有后台已提供 |
| 节点/集群/RDS维护 | 同事在维护前核对K3s版本支持、节点排空条件、卷挂载及备份。应用容忍RDS短断并回读未知结果。节点本地卷失效按独立恢复方案处理，RDS切换/节点重建都要实际演练，不能用Pod自动重建代替可用性保证 | 同事负责基础设施版本/窗口，应用侧给兼容范围和验证；不由项目发布脚本自动升级共享集群或RDS |
| 运行任务归属 | 实时通知/编辑心跳留在后端；现有导入执行器继续用持久进度和租约恢复。低频备份/已批准清理使用既有调度或独立Job/CronJob，不绑在某个常驻Pod的内存定时器上；记录幂等键/锁、最后成功、并发和失败恢复，维护/恢复时可暂停 | 不为此引入Redis或重复队列；只有产生实际任务才生成相应CronJob，不建立空壳定时功能 |
| 依赖和发行维护 | 前后端、Node/静态服务器/依赖和清单按固定版本维护；安全更新先隔离核验再安排发布。保留当前及可用回退发行的digest和变更记录；上传、Git合并、部署分别有结果，不自动以推送触发生产更新 | 应用开发与发布人维护；Harbor保留策略须保护运行/回退镜像，实际清理仍需既定授权 |

完整恢复的范围包含RDS业务数据、导入文件及必要受控配置；集群控制面恢复归同事管理，并核对部署声明和Secret的可恢复性。任何自动化保留/删除、管理员紧急恢复等新增行为只列为方案，未经确认不实施。

DEC-175明确正式RPO/RTO及保留策略先不定值，待同事提供备份能力和成本后讨论。需提供RDS可用数据/日志备份与实际可恢复区间、文件卷备份方式和存放位置、恢复步骤与耗时依据、现有调度/告警及预计费用。此前建议的1小时/4小时/14天不是已确认正式目标；原测试首版策略仍只适用于原范围。

参考：[Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)、[Secret](https://kubernetes.io/docs/concepts/configuration/secret/)、[K3s升级](https://docs.k3s.io/upgrades/manual)。这些机制不替代任务幂等、应用恢复与人工责任落实。

### 故障与回退边界

| 故障 | 处理与恢复 |
|---|---|
| 镜像拉取失败/架构不符 | 预检阶段停止，不进入维护；核对节点containerd、凭据和CA，不关闭TLS校验 |
| RDS不可达/权限证书不符 | 不执行迁移或写入；报告具体连接阶段；运行中暂断由ready撤流量并受控复核恢复 |
| PVC挂载或文件语义不支持 | 不落到容器临时层；修正实际存储并重做能力预检，已有文件不删除 |
| 迁移中断/DDL部分生效 | 保留Job日志与结构，按版本/摘要/中间态核对后接续；不清库、不盲目自动重跑 |
| 新后端/前端不就绪 | 保持维护，核对配置/产物；兼容当前schema才可退应用镜像，不将rollout undo当数据库回退 |
| 数据恢复必要 | 明确恢复点和业务影响，数据库与文件成对恢复并核对引用；先保留失败现场，不能自动覆盖上线后新写入 |
| 写请求结果未知 | 复用原操作号及持久回执查结果，不显示“确定没保存”或另建操作重复执行 |
| Pod强杀/节点故障 | 卷能力范围内恢复；导入可能等待租约到期再接续；节点本地卷失败需独立备份恢复，不宣称HA |

首次空白新库已由DEC-176确认；完整方案收口仍需确定维护时段/时长、存储方案及恢复目标。当前未生成可执行清单、未新建云资源、未制作双镜像、未连接RDS或部署K3s。

参考：[RDS连接](https://www.alibabacloud.com/help/en/rds/apsaradb-rds-for-mysql/how-do-i-connect-to-an-apsaradb-rds-instance)、[K3s入口](https://docs.k3s.io/networking/networking-services)、[K3s私有仓库](https://docs.k3s.io/installation/private-registry)、[探针语义](https://kubernetes.io/docs/concepts/workloads/pods/probes/)、[Job重复执行边界](https://kubernetes.io/docs/concepts/workloads/controllers/job/)、[持久卷](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)。默认组件不代表该集群实际配置。
