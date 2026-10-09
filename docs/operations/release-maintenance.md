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

离线 scripts/generate-initial-schema.mjs 曾用于生成首版 JSON，禁止为改字段而删除并重新生成已应用资源。该文件 LF 由 .gitattributes 固定；完整资源字节 SHA-256 包含 SQL 和期望结构。当前执行器依序支持 0001-foundation 和 0002-trial-save；已登记资源不可改写。新增版本在实施分支增加资源及含数据升级验证。

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

/var/backups/geekdash 已有本次只读发布前的两库逻辑备份，实际路径/摘要归[部署记录](deployments/2026-10-08-project-reads.md)；仍没有完整备份任务、隔离恢复或服务器外副本结果。真实导入前完成 E11 和 Q-016 资源落实。MySQL 空库内存观测已接近起始上限，业务/真实数据接入前按实际增长和宿主余量复核配置；不沿用短测当四人性能通过。

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

应用回退优先使用上一兼容构建物。数据库不能因为应用回退就随意恢复旧备份：那会丢失发布后的业务数据。

每次发布明确：旧应用能否读取新结构、迁移能否前向修复、是否必须暂停写入、恢复会损失哪些时间段的数据。不能保证时明确阻止发布。

后台任务发布时停止领取新任务，等待或安全中断在途任务；重启后按幂等规则恢复。不得靠内存队列承载必须保留的任务。

## 7. 备份和维护

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
