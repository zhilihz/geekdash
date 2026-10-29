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

## 阿里云 K3s 与 RDS MySQL 发布和维护

本节对应当前 `deploy/k3s/` 与 `scripts/k3s-release.mjs` 的操作契约。用户已确认独立前后端部署、同域同版本发布、后端单副本、维护窗口，以及首次使用空白新库（DEC-173/174/176）。旧 Harbor Compose 合一包、现有本地库和腾讯云环境保留，不能用本节的空库初始化覆盖它们。施工范围归[执行计划 1.4](../implementation/execution-plan.md#k3s-delivery-plan)；实际验证结果归[本轮技术报告](../testing/reports/2026-10-29-k3s-rds-delivery.md)，实际部署归[部署记录目录](deployments/)，不以本节存在表示目标云环境已经通过验收。

```text
同一源码提交、同一次构建
   ├─ web 镜像：静态页面 / 资源 / 前端构建信息
   └─ api 镜像：API / SSE / 导入执行器 / 迁移与初始化命令
                    ↓ 两份不可变 digest + 一份 release.json
HTTPS 域名 → 实际 Ingress → /api 原路径 → geekdash-api:80 → API:3000 → RDS
                         └→ 其他路径 → geekdash-web:80 → Nginx:8080
                                                           API → 导入原文件 PVC
```

前端镜像中的 Nginx 只托管页面，不代理 API；独立 Ingress 负责路由。新环境不包含 MySQL 容器，不要求宿主 Nginx、Compose 或 Docker socket。应用 ServiceAccount 不挂 Kubernetes API token；运维的 kubectl 身份与应用身份分开。现有账号、邀请码、角色、基础资料和 CHECK 等产品功能仍由应用提供，不在业务后台增加集群控制功能。

### 1. 环境输入与责任边界

正式域名、Harbor 目标、集群连接及 RDS 参数由服务器同事提供，文档与脚本不推断原腾讯云配置。仓库示例中的 `REPLACE_*` 必须填写，不能作为可执行部署配置。

| 输入 | 必须核实的内容 |
|---|---|
| 集群 | 明确 kubeconfig context、独立 namespace、K3s 版本和节点架构；运行命令始终指定 context，不靠当前默认 context |
| 入口 | 实际 ingressClass、域名、匹配的 TLS Secret；`/api` 保留原路径，不做前缀剥离；控制器实际支持 32 MiB 上传、SSE 不缓存/不缓冲及时转发，连接超时与应用心跳相容 |
| 代理信任 | `trustProxy` 填实际可信代理 IP/CIDR。不能填 `true`、全网 `/0` 或任意猜测的网段；同事核对该入口实际来源及转发头，不能用放宽信任解决登录问题 |
| Harbor | 两个仓库地址与本次独立 tag、节点对仓库 CA 的信任、namespace 拉取 Secret；开发机 Docker 登录成功不代表 K3s 的 containerd 能拉取 |
| RDS | 精确 MySQL 版本、私网 DNS 地址/端口、独立空库、两个数据库账号、实际白名单来源和 CA；应用使用证书对应的 DNS 地址，不使用 IP 绕过主机名校验 |
| 持久文件 | 已提供的 CSI StorageClass、容量和回收策略；UID 1000 可写，支持现有 POSIX 文件写入、fsync、硬链接。默认 local-path 不等于跨节点恢复或高可用 |
| 资源及维护 | 按实际节点容量填写 requests/limits；示例数值是配置起点。确认维护时间和执行人，后端单副本会有明确不可用窗口 |
| 备份与日志 | 受控归档位置、恢复操作者、集群日志保留和告警接收人。正式备份周期、保留、RPO/RTO 按 DEC-175 待同事反馈能力与成本后确定 |

脚本不安装或升级 Ingress、CSI、K3s、RDS，不修改 DNS，不删除 namespace/PVC。当前清单不生成一份假定通用的 NetworkPolicy；实际 CNI 下的入口、DNS、RDS 网络边界由同事配置并验证。应用的 kubeconfig 发布身份需要目标 namespace 的 Deployment/Service/Ingress/ConfigMap/Job/PVC 操作、Secret 读取、Pod 状态/日志/exec 权限，以及 ingressClass、StorageClass、namespace 的必要读取权限；无需给常驻应用这些权限。

### 2. 构建双镜像与上传发行

从已核对的完整源码提交构建。以下构建示例使用 PowerShell；发行标识、平台由本次交付确定，不能把演示值当正式版本。

```powershell
$release = '填写本次小写发行标识'
$platform = 'linux/amd64'
$revision = (git rev-parse HEAD).Trim()
if (git status --porcelain) { throw '请先收口源码，不能伪装成干净发行' }
npm ci
npm run check
npm run build:split
$build = Get-Content dist/build-info.json -Raw | ConvertFrom-Json
if ($build.dirty -or $build.revision -ne $revision) { throw '构建记录与发行提交不一致' }
docker build --platform $platform --build-arg "GEEKDASH_REVISION=$revision" -f deploy/k3s/Dockerfile.web -t "geekdash-web:$release" .
docker build --platform $platform --build-arg "GEEKDASH_REVISION=$revision" -f deploy/k3s/Dockerfile.api -t "geekdash-api:$release" .
node scripts/verify-split-build.mjs --web-image "geekdash-web:$release" --api-image "geekdash-api:$release"
node scripts/verify-k3s-release.mjs
```

两份 Dockerfile 使用各自构建白名单；前端只带页面产物，后端只带编译代码、迁移、构建信息与生产依赖，不携带桌面安装包、本地业务数据、备份、凭据和开发依赖。不要单独重建其中一份前端代码后沿用旧后端构建记录。`verify-split-build` 的隔离检查不能替代目标 RDS、Ingress、CSI 或用户真实页面验收。

在仓库外复制并填写 [push.example.json](../../deploy/k3s/push.example.json)：

| 字段 | 内容 |
|---|---|
| `release` | 本次唯一发行标识，1～36 位小写字母、数字和连字符，不以连字符开头或结尾 |
| `revision`、`schemaVersion` | 直接取本次 `dist/build-info.json`，提交为完整 40 位，不手填旧版本 |
| `platform` | 与实际节点相符的 `linux/amd64` 或 `linux/arm64` |
| `webSource`、`apiSource` | 本机已构建的两个镜像名 |
| `webTarget`、`apiTarget` | 同事确认的完整 Harbor 仓库及独立 tag，不是仓库占位名称 |

完成相应 Harbor 登录后运行，`release.json` 必须是尚不存在的新文件：

```text
node scripts/k3s-release.mjs push /受控交付目录/push.json /受控交付目录/release.json
```

入口先读取两镜像内部的 build-info，核对 clean、revision、schema、平台及完整构建信息一致，再上传并回读远端 digest 和内容。同一 tag 若已存在且内容相同可接续部分上传；内容不同则拒绝覆盖。只有两份镜像都确认后才写发行清单，不覆盖既有清单。该清单记录 `release/revision/schemaVersion/platform/webImage/apiImage`，部署使用完整 `仓库@sha256:...`，不以可变 tag 或 `latest` 运行。上传不等于已部署。

交给服务器同事的是发行清单、无凭据环境配置、此操作说明及本仓库发布脚本/资源模块；Secret 材料另走受控渠道。执行端需要 Node.js 24 和 kubectl，并保留 `scripts/k3s-release.mjs` 与 `deploy/k3s/resources.mjs` 的相对目录；只有构建/上传端需要 Docker，K3s 服务器不用安装 Docker。下列 `node scripts/...` 均从交付仓库根目录执行。旧合一包的 `push.bat` 不用于这次双镜像发行。

### 3. RDS、初始管理员与 Secret

RDS 运行版本门槛为 **MySQL 8.0.16 及以上**，因为更早版本不能满足本项目实际执行 CHECK 约束的要求；“8.0+”不是限定为 8.0.x，也不是所有未来版本无条件兼容。MariaDB、系统库和本地 dev/test 库不能作为 RDS 目标。技术验证分别使用真实 MySQL 8.0、8.4 数据库，精确补丁版本、验证范围和结果以测试报告为准；这些隔离数据库不等于阿里云 RDS 服务已经验收。目标 RDS 仍须实际核对 TLS、权限、命名锁、DDL、完整结构和恢复行为。

同事预先创建本项目独立空库，采用 InnoDB、utf8mb4 与迁移要求的排序规则。初始化 Job 建表及开管理员，不能替代云数据库建实例、建库和授权。应用每次建立连接核对实际库、账号、版本、UTC 会话、TLS 密文及授权。

| 数据库身份 | 精确本库权限 | 使用位置 |
|---|---|---|
| 运行账号 `rds_app` | SELECT、INSERT、UPDATE、DELETE | 常驻 API、只读预检 |
| 迁移账号 `rds_migrator` | 上述四项，加 CREATE、DROP、ALTER、INDEX、REFERENCES | 预检/初始化/迁移/结构核验 Job |

不要使用 root、全局权限、`ALL PRIVILEGES`、`GRANT OPTION` 或跨库授权。`SHOW GRANTS` 输出会实际验证。特别注意：`partial_revokes=OFF` 时，数据库级授权中的 `_` 和 `%` 是通配符；库名含下划线时，即使有反引号也要按 MySQL 规则转义，例如精确授权到 `geekdash_prod` 的范围写作 `` ON `geekdash\_prod`.* ``。`partial_revokes=ON` 时按字面库名处理。由同事依据实际参数建立精确授权，不能为了让预检通过而关闭权限核验。

在仓库外受控目录分别准备以下 JSON/PEM 文件。两份数据库 JSON 的 host、port、database 必须相同，user 必须不同；password 不写进命令行参数、日志、Git 或发行清单。

```json
{
  "host": "REPLACE_RDS_PRIVATE_DNS",
  "port": 3306,
  "database": "REPLACE_DATABASE",
  "user": "REPLACE_APP_USER",
  "password": "REPLACE_CONTROLLED_PASSWORD",
  "ssl": { "caFile": "/run/secrets/rds-ca.pem" }
}
```

将其保存为 `rds_app.json`；`rds_migrator.json` 使用迁移账号和该账号密码。`ca.pem` 保存实际 RDS 服务端证书的受信 CA 链。运行时不允许关闭证书验证，最低 TLS 1.2，并校验服务端 DNS 身份。

初始管理员的 `admin_account.json`：

```json
{
  "loginName": "REPLACE_INITIAL_LOGIN",
  "name": "REPLACE_INITIAL_NAME",
  "password": "REPLACE_CONTROLLED_INITIAL_PASSWORD",
  "isProjectManager": false
}
```

这是本次空库初始化的受控明文初始密码文件，不是旧 Harbor 合一包中的密码哈希文件。登录名为 3～64 位小写字母、数字、下划线或连字符，首位为小写字母或数字；姓名非空且不超过 128 字符；密码遵守现行账号规格。`isProjectManager` 可选，默认 false；是否兼任由实际配置决定，不在初始化时替用户选择。首次初始化写入管理员并要求首次改密，之后重复初始化只核验既有提交标记，不重置已经改过的密码；非空的未识别业务库会拒绝初始化。

以下部署准备示例使用 Bash。先填实际值；Secret 名称要与环境 JSON 对应，凭据文件使用受控 ACL/权限。

```bash
CONTEXT='填写实际context'
NAMESPACE='填写独立namespace'
CONTROLLED='/填写受控目录'
kubectl --context "$CONTEXT" get namespace "$NAMESPACE"
# 仅在确认该namespace尚不存在时创建：
kubectl --context "$CONTEXT" create namespace "$NAMESPACE"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic geekdash-rds-app --from-file=rds_app="$CONTROLLED/rds_app.json"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic geekdash-rds-migrator --from-file=rds_migrator="$CONTROLLED/rds_migrator.json"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic geekdash-rds-ca --from-file=ca.pem="$CONTROLLED/ca.pem"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic geekdash-bootstrap-admin --from-file=admin_account="$CONTROLLED/admin_account.json"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret tls geekdash-tls --cert="$CONTROLLED/tls.crt" --key="$CONTROLLED/tls.key"
kubectl --context "$CONTEXT" -n "$NAMESPACE" create secret generic geekdash-harbor --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson="$CONTROLLED/harbor-config.json"
```

`harbor-config.json` 必须含对应仓库可用的认证材料，不能只复制一个依赖开发机凭据助手的 `credsStore` 配置。已有 namespace/Secret 不重复 create；轮换按下方流程更新既有资源，不删除环境后重建。初始化完成后的管理员凭据撤销/归档按受控流程处理；常驻 API 从来不挂管理员和迁移凭据，普通升级不需要再挂初始化账号文件。

### 4. 环境配置、渲染和集群预检

复制 [environment.example.json](../../deploy/k3s/environment.example.json) 到受控交付目录，填写实际 context、namespace、domain、ingressClass、Secret 名称、trustProxy、StorageClass、容量和资源配额。`releaseFile` 相对于环境 JSON 所在目录解析，指向本次上传生成的发行清单。`ingressAnnotations` 只能填写实际控制器支持的配置；不把 Nginx 专有参数塞给其他控制器。只有核对该入口的上传和 SSE 配置后，才将 `ingressStreamingConfirmed` 设为 true；这项确认本身不是技术验收结果。

```text
node scripts/k3s-release.mjs render /受控交付目录/environment.json /尚不存在的审阅目录
node scripts/k3s-release.mjs preflight /受控交付目录/environment.json
node scripts/k3s-release.mjs status /受控交付目录/environment.json
```

`render` 输出原生 `resources.json` 及初始化、迁移、核验、两类预检 Job JSON，用于审阅，不包含 Secret 内容。不要用一次递归 apply 替代发布入口的顺序。脚本固定 API 单副本、Recreate，web/API 分别使用 UID 101/1000、只读根文件系统和 `/tmp` 临时目录，导入目录挂载 `geekdash-imports` PVC 到 `/var/lib/geekdash/imports`。PVC 创建后不随更新删除或重建；容量/StorageClass 与现有对象不同会停止，扩容/迁移由独立运维安排。

`preflight` 会创建短期只读预检 Job，实际验证目标集群拉取两镜像、两份构建信息一致，以及 RDS 两类账号的连接/TLS/权限；不会执行迁移、初始化或写业务数据。它同时检查所指 namespace、IngressClass、StorageClass、Secret 键、入口证书和已有 PVC 配置。预检 Job 留在集群供排错，不能把工作站成功拉镜像当作此步骤已完成。预检不代替真实入口 SSE/上传、业务页面或目标 CSI 验收。

### 5. 首次空库部署

```text
node scripts/k3s-release.mjs init /受控交付目录/environment.json
node scripts/k3s-release.mjs status /受控交付目录/environment.json
```

`init` 在持久发布状态中登记本次目标，设置维护，然后执行同镜像预检、初始化 Job 和独立 schema 核验 Job。数据库 Job 单并发、`restartPolicy=Never`、`backoffLimit=0`；迁移/初始化自身仍有数据库锁和幂等依据，不能只依赖 Job 恰好运行一次。发现已有发布状态或后端 Deployment 时不再 init，先 status，再选择 resume/update。

结构就绪后启动配对的 web/API。维护期间前端返回带 `X-GeekDash-Maintenance: on` 的 503 页面；API 除健康接口外返回维护结果，后台导入停止领取新条目。发布入口等待探针与真实 HTTPS 构建回读，运行原文件核验和存储探测，再解除维护并确认页面 200、API `maintenance=false`。新的空库不需要伪造旧数据备份，也不会搬入测试账号、旧项目或本地数据库；后续业务数据使用现有产品导入流程。

首次部署失败保留 Job/状态/卷。已开始的动作通过 `resume` 接续，失败 Job 按下一节显式 retry，不反复 init，不清库后假装首次成功。新管理员登录、首次改密及业务使用由用户验证；健康检查结果不代替这项验收。

### 6. 日常更新：先停写与备份，再继续迁移

本次使用新的发行标识、两份新 digest 和对应环境配置；同一次更新开始后，保持这些文件内容和 `releaseFile` 引用一致，不能在中途静默换库、换卷或换镜像。

```text
新镜像/数据库预检
 → 开启页面/API维护门禁，确认公网维护页
 → 旧后端缩为0，等待所有旧API Pod终止
 → 返回paused_for_backup，记录pausedAt
 → 同事完成数据库、原文件、受控配置的配对备份
 → resume验证证据，再执行迁移与独立schema核验
 → 新API和web就绪但仍处于维护
 → 核对构建、ready、原文件及存储能力
 → 解除维护，确认页面与API恢复，再登记发行完成
```

```text
node scripts/k3s-release.mjs update /受控交付目录/environment.json
node scripts/k3s-release.mjs status /受控交付目录/environment.json
```

`update` 正常返回 `paused_for_backup` 就停止在备份入口，并未完成发行。只有旧后端 Pod 全部消失后才记录暂停时间；维护提示、ready 撤流量或一个写入开关不能单独证明所有应用写入者已经停止。还需由同事确认该库没有此应用之外的写入者。

按 [backup-evidence.example.json](../../deploy/k3s/backup-evidence.example.json) 准备受控证据：

| 字段 | 必须对应的事实 |
|---|---|
| `context`、`namespace` | 本次目标环境 |
| `databaseTarget`、`volumeUid` | 从 status 中复制本次数据库目标摘要与 PVC UID，不能套用另一个库或卷的证据 |
| `recoveryPoint`、`completedAt` | ISO 时间；恢复点不早于 `pausedAt`，备份完成不早于恢复点，不能是未来时间 |
| `applicationConsistent` | 同事已经核对数据库、文件和配置是可配对的完整恢复点后才为 true |
| `database` | RDS 方案填 provider=`rds`、实际 backupId，并由同事核实可恢复到 recoveryPoint 后填写 `recoveryPointVerifiedByOperator=true`；或提供数据库受控归档的绝对 `path` 与 `sha256` |
| `files`、`configuration` | 受控归档绝对路径和 SHA-256。运行发布命令的机器必须能读取，用于存在性和内容摘要检查；原始密码或业务数据不附到公开报告 |

脚本不生成 RDS 备份，不把人工填写的 backupId 宣称为已经查询云平台核验；它验证环境/库/卷/时间及本机归档哈希，RDS 恢复点由同事实际核对。备份存放与加密方式沿实际受控设施确定，不能用空文件、复制日志或承诺“稍后备份”越过门禁。

```text
node scripts/k3s-release.mjs resume /受控交付目录/environment.json /受控交付目录/backup-evidence.json
node scripts/k3s-release.mjs status /受控交付目录/environment.json
```

正常更新都运行迁移命令及独立核验；没有新迁移时，迁移命令核对既有版本，不创建重复记录。API 启动时再次校验结构版本。发布恢复阶段运行：

```bash
kubectl --context "$CONTEXT" -n "$NAMESPACE" exec deployment/geekdash-api -- node dist/server/commands/import-files.js rds_app --probe-storage
```

该命令只在自己唯一命名的探测文件上测试写入、fsync、硬链接并清理自己的探测文件，随后核对所有 `import_batches` 的文件引用、范围、字节数和 SHA-256。缺失/损坏会使发布保持维护；未引用文件和 `.partial` 只统计，不顺便清理业务数据。历史绝对文件路径不匹配时先核对恢复映射，不能把文件复制到容器临时层掩盖缺口。

### 7. 中断、失败 Job、凭据纠正和残留锁

每次先 `status`，看实际 phase、Job、Pod、镜像与锁；不能把上次终端退出码当作数据库一定未提交。ConfigMap `geekdash-release-state` 保存发布状态，`geekdash-release-lock` 串行化本工具的发布；它们不阻止其他人在工具之外直接操作集群，所以同事仍须遵守同一维护入口。

| 情况 | 操作 |
|---|---|
| 终端中断，原 Job 还在运行或已完成 | 使用相同配置 `resume`；沿原 Job 读取结果，不新建一次初始化/迁移 |
| `opening` / `opening_failed`，解除维护期间结果不确定 | `resume` 先重新设置维护并回读页面/API，恢复后停在 `maintenance_restored_review_required`，不会自动再次开放。核对可能开放期间的业务写入和当前状态，再在 retry 证据中额外填写 `openingReviewed=true` 明确继续 |
| Job 明确 Failed | 保留日志和实际结构，处理根因；填写 `retry.json`，核过 schema 后显式创建新 attempt。旧 Failed Job 不删除 |
| 同一目标库的密码或 CA 配置纠正 | 目标库/PVC 不变时，在 retry 明确 `acceptCredentialChanges=true`；重新做连接预检，记录恢复原因，API 凭据摘要变化使消费者重建 |
| 数据库目标或 PVC UID 变化 | 普通 resume/retry 拒绝。按完整恢复/迁移重新评估，不能拿旧备份证据继续迁移另一个库 |
| 进程被强杀留下锁 | 确认没有发布进程且没有未结束 Job，准确指定 status 中的 lock owner，再执行 unlock；不按超时自动偷锁 |
| 新镜像自身错误或需要恢复数据 | 保留失败现场及当前业务变化，按下方回退边界处理；不能改一份正在执行的发行文件后继续冒充同一版本 |

复制 [retry.example.json](../../deploy/k3s/retry.example.json)，填写实际 `reason`、`schemaReviewed=true`；仅在凭据确实变更并经核对时才设 `acceptCredentialChanges=true`。尚未登记备份的更新同时通过 `backupEvidenceFile` 指向该受控证据文件，该路径相对于 retry JSON 解析。

```text
node scripts/k3s-release.mjs retry /受控交付目录/environment.json /受控交付目录/retry.json
```

解除维护前先持久记录 `opening`；解除命令、页面/API确认或 `complete` 写入任一失败，都尝试恢复维护并回读，保留原错误和恢复错误。ConfigMap、HTTP 回读与发布状态不是一个原子事务，不能承诺失败时必然从未开放；若完成写入返回未知但维护恢复成功，也先核对实际状态，不自动宣布交付。无法确认维护已经恢复时，立即由运维停止本项目后端并核对 Pod，再排查入口/集群通信；不要因为终端已退出就假定服务已关闭：

```bash
kubectl --context "$CONTEXT" -n "$NAMESPACE" scale deployment/geekdash-api --replicas=0
kubectl --context "$CONTEXT" -n "$NAMESPACE" get pods -l app.kubernetes.io/name=geekdash,app.kubernetes.io/component=api
```

仍有未结束 Job 时不能创建下一 attempt；若旧 Job 正在等待镜像或网络，先修复依赖并等待实际终态，或按受控故障处置结束该 Job，不能仅为解锁强删仍可能写库的 Pod。

复制 [unlock.example.json](../../deploy/k3s/unlock.example.json)，填写 `lockOwner`、`noPublisherRunning=true` 和原因。解锁记录最后一次原因；删除使用原锁 UID 和 resourceVersion 作为原子前提，锁已变化则拒绝删除。

```text
node scripts/k3s-release.mjs unlock /受控交付目录/environment.json /受控交付目录/unlock.json
node scripts/k3s-release.mjs status /受控交付目录/environment.json
```

unlock 只解除已确认失去发布进程的锁，不重跑任务、不完成发布，也不删除 PVC。之后依据实际阶段 resume/retry。

### 8. 排错与版本回读

下面命令不打印 Secret 内容。Job 名称使用 status 返回的实际名称，不能猜一个新 Job 然后重复执行。

```bash
kubectl --context "$CONTEXT" -n "$NAMESPACE" get deploy,pods,svc,ingress,pvc,jobs -l app.kubernetes.io/name=geekdash
kubectl --context "$CONTEXT" -n "$NAMESPACE" logs deployment/geekdash-api --timestamps --tail=200
kubectl --context "$CONTEXT" -n "$NAMESPACE" logs deployment/geekdash-web --timestamps --tail=100
kubectl --context "$CONTEXT" -n "$NAMESPACE" logs job/填写实际Job名称 --timestamps --tail=200
kubectl --context "$CONTEXT" -n "$NAMESPACE" describe pod 填写实际Pod名称
kubectl --context "$CONTEXT" -n "$NAMESPACE" get events --sort-by=.metadata.creationTimestamp
curl -fsS "https://填写实际域名/build-info.json"
curl -fsS "https://填写实际域名/api/health/live"
curl -fsS "https://填写实际域名/api/health/ready"
```

前端 build-info 与 API live 中的 `build` 应属于同一发行；ready 反映数据库就绪，不与 live 响应结构混用。维护时页面 503 是预期结果，不能因 `curl -f` 失败就把它当随机网关故障。保留错误时间、发行 ID、两份 digest、Pod/Job、迁移步骤、响应 requestId 和脱敏日志。Job 失败时工具给出具体日志入口；命令失败保留操作类别/资源和退出信息，不回显 Secret 内容。`kubectl logs` 不是永久日志归档，Pod 删除或日志轮转前按既有日志设施保留必要证据。

### 9. 回退与持续运行边界

- **应用回退：**只有旧 API 与当前 schema 兼容才可退镜像。当前启动精确核对结构；`rollout undo` 不回退数据库，也不能恢复原文件。两份镜像必须按同一发行配对回退，保持维护直到核对完成。
- **数据恢复：**由已确认操作者选择恢复点，先保留失败现场，再成对恢复数据库、原文件和必要受控配置；核对账号、项目、历史与所有文件引用。恢复会影响该恢复点之后的数据，不能由发布脚本自动覆盖。
- **RDS 短断：**ready 撤流量，live 保留进程存活语义；恢复做完整结构/依赖复核。请求结果未知时复用原操作号和持久回执查结果，不另建一次写操作。
- **正常终止：**应用退出预算 55 秒、Pod 宽限 70 秒是当前配置起点；停止新请求/导入领取，关闭 SSE，等待当前操作，最后关闭池。强杀和节点故障仍依赖持久回执及导入租约，不保证每个在途请求都完成。
- **PVC 与节点：**持久卷保留，节点排空及跨节点挂载由实际 CSI 能力决定；单副本和节点本地卷不构成高可用。实际 CSI 的 fsync/硬链接、重建挂载与恢复必须验收，不能用本地测试卷代替。

<a id="k3s-maintenance-coverage"></a>

### 10. 持续维护的已接入口与待落实项

| 维护事项 | 当前操作入口与边界 |
|---|---|
| 发布与中断接续 | 本节 CLI、持久发布状态、同镜像 Job、维护文件门禁和显式 retry/unlock；真实环境验证结果另记报告 |
| 凭据/证书轮换 | 域名证书、RDS CA/账号密码、Harbor 凭据、kubeconfig 分开管理。先验证新材料，再更新引用、明确重载消费者、回读健康，最后撤销旧材料；已有连接池不会因 Secret 内容变化自行换密码 |
| 定时备份及演练 | 复用同事现有 RDS 数据/日志备份、文件卷备份和受控配置备份。优先既有调度；只有确有任务才配置 Job/CronJob，不另建备份平台。发布前仍按本节等待停写后的配对证据 |
| 日常备份是否停服 | 不把每天停服当固定要求。现有已发布导入原文件不可变，具备可靠 RDS 恢复点、覆盖该点引用的文件副本及完整清单时可设计在线配对备份；实际设施未证明一致性前，不宣称在线备份已经成立 |
| 告警和责任 | 复用既有集群/云平台，落实公网/API、OOM/重启、RDS连接与容量、卷空间、备份失败/久未成功、证书到期的接收人和恢复通知；渠道、阈值及送达验证待同事落实 |
| 清理与保留 | 原文件、个人草稿、审计、回执、会话及备份的保留规则不能相互套用。当前发布工具不自动清理业务历史、无引用原文件、旧镜像、容器或 PVC；不沿本轮操作解除原有暂停清理要求 |
| 管理员紧急恢复 | 正常改密和账号管理继续使用现有产品入口；受控恢复目标沿已确认的 SPEC-001 F07，命令入口尚未实现，具体运行环境与操作者仍需落实。初始化命令不是找回密码后门，不重跑 seed 或清库恢复登录 |
| 集群/RDS升级 | 同事安排基础设施维护窗口，核对支持版本、备份、节点排空、卷和RDS切换；本项目脚本不升级共享集群、云实例或付费资源 |

正式备份周期、保留、允许数据丢失时间及恢复时间仍按 DEC-175 待定；此前测试环境的策略不自动变为阿里云正式承诺。同事需提供实际可恢复区间、文件/配置备份方式、存放与权限、恢复耗时依据、现有调度/告警和成本，再确定服务目标。RDS 备份不覆盖导入文件；K3s 控制面备份不替代业务备份，反之亦然。

目标域名、Harbor、实际 Ingress/CSI、RDS 版本与连接仍以同事提供并现场验证为准。隔离的本机 K3s、MySQL 8.0/8.4、Docker 或脚本检查只证明对应测试范围，不自动成为阿里云上线、完整恢复演练或用户业务验收的结论。
