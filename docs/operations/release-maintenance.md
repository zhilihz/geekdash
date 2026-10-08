# 更新、发布与长期维护

版本：D0.36；日期：2026-10-08；状态：本地工程与独立数据库运行入口已实现；应用就绪接入及服务器发布待接续。

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
pwsh -NoProfile -File scripts/docker.ps1 up --wait --wait-timeout 60 app
```

逐条检查退出码，前一步失败不执行后续。构建在候选目录完成类型检查、编译、资源核对和真实 HTTP 检查后才提升为 dist；dist.previous 保留上一产物。候选目录和上一产物不能自动当作已验收发布版本。

入口为 http://127.0.0.1:41860 ，仅绑定本机。端口占用时先核查；可用进程环境 GEEKDASH_PORT 指定另一端口，变更后重新创建本项目 app。当前页面是工程验收页，尚无项目/账号业务。容器健康检查使用 live，**healthy 只表示基础进程存活；ready 当前始终 503，应用数据库接入尚未实现**。协议见 [API 说明](../specifications/api/foundation.md)。

```powershell
pwsh -NoProfile -File scripts/docker.ps1 ps app
pwsh -NoProfile -File scripts/docker.ps1 logs --tail 50 app
pwsh -NoProfile -File scripts/docker.ps1 stop app
pwsh -NoProfile -File scripts/docker.ps1 up --wait --wait-timeout 60 app
```

实际配置通过 Compose/进程环境注入，当前应用只需 HOST/PORT，未挂载数据库凭据；F04 再接入受控应用身份。F02/F03 的独立数据库工具入口见下节。不要执行带 -v 的清理命令删除卷。这里的命令不连接新加坡服务器，也不部署 geekdash.zhiluan.cool。

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

离线 scripts/generate-initial-schema.mjs 曾用于生成首版 JSON，禁止为改字段而删除并重新生成已应用资源。该文件 LF 由 .gitattributes 固定；完整资源字节 SHA-256 包含 SQL 和期望结构。当前执行器只支持 0001-foundation；新增版本必须在实施分支增加资源/版本路径与含数据升级验证。

错误与接续：

| 情况 | 反馈与接手动作 |
|---|---|
| 配置缺失/目标或权限不符 | 非零退出；核对受控文件和实际身份，不删除已有数据目录重试初始化 |
| MySQL 不健康/文件挂载类型不符 | 读取仅本项目 mysql 日志；用 stat/test -f 核对容器内文件，禁止 cat 密钥或打印完整配置 |
| DB_MIGRATION_BUSY | 同库锁等待 5 秒超时，尚未执行此轮 DDL；核对正在执行的迁移，结束后重试 |
| DB_MIGRATION_CHECKSUM_MISMATCH / DB_SCHEMA_VERSION_UNSUPPORTED | 保留已有资源/数据；恢复对应代码版本或增加受控新迁移，不改登记绕过 |
| DB_SCHEMA_MISMATCH / DDL 中断 | 输出失败步骤或实际差异；已有 DDL 可能生效。无登记版本时仅完全一致的已建对象可续跑；已登记却缺约束则停止，不自动补修 |

健康或连接检查不能当备份恢复。停止仅本项目 mysql：database.ps1 stop mysql；数据目录保留。禁止 down -v、删目录、全局 prune 或操作其他项目容器。

故障演练脚本 test:migrations 会在 geekdash_test 中临时删除版本登记/外键并注入子进程死亡，仅可在没有人工使用的专用测试库运行；失败后先 db:verify 定位，按输出核对恢复，不在 geekdash_dev 或试用库演练。F02-A 的读写/重启验证采用 npm run test:db、重启 mysql 后 npm run test:db:resume，夹具范围与恢复以脚本回执为准。已执行范围见[报告](../testing/reports/2026-10-08-e01-f02-f03.md)。应用仍未加载数据库凭据，F04 前 ready 503。

## 2. 代码管理

- 2026-10-08 用户确认：工程实施在独立分支进行，已完成成果最终合并回远端 main。开始施工先 fetch 核对 main，处理并保留已有未提交内容，再从最新 main 创建 codex/ 短期分支；不在 main 直接编写功能代码。
- 一次变更围绕明确需求及验收，避免夹带无关整理。
- 一个可理解的工作单元完成后推送施工分支；相关验收、差异审查与文档同步通过后，合并并推送远端 main，再回读远端提交确认完整包含施工成果。存在冲突时先解决并验证受影响链路，不强制覆盖历史；未完成或验证失败的成果留在施工分支。PR 可用于审查，仓库保护要求 PR 时按其流程完成。
- 代码、规格、测试和必要的使用说明同一变更更新。
- 软件采用语义版本标识；0.1.0 当前仅标记工程基底，尚无业务发布。D0.x 是文档版本，与原本地版 V1.050 分开记录。
- 原始压缩包、核查副本、凭据、真实业务备份不默认进入 Git。

首次空仓库可以直接提交文档基线；若发现远程已有内容，必须先整合，禁止强制覆盖已有历史。

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

### 测试环境首次初始化（DEC-051）

1. 创建本项目独立 MySQL 实例和持久卷；建立人工试用库、自动测试库及独立授权，不连接其他系统业务库。运行账号只访问自身库，迁移/备份凭据受控保存。
2. 运行版本化迁移，按 SPEC-001 开通四个业务测试账号与一个维护测试账号，临时凭据受控交付。
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

测试首版备份策略已按 DEC-056 确认：每天一份完整备份，保留 14 天；每次发布/迁移前额外备份，并保存加密的服务器外副本。完整来源和一致性边界按 SPEC-016，不能只备份项目表。执行时间在部署配置及受控环境记录中登记；尚未建立定时任务或生成真实备份。

首次真实导入前完成一次隔离恢复，核对业务、关联、历史、私人状态及产物再验证页面/报告消费。服务器外存放位置、访问凭据、完整备份下载/恢复操作者，以及最大允许丢失时间（RPO）和恢复时间（RTO）仍待 Q-011/016 落实；每天备份不等于已经满足恢复目标。备份失败必须可见，不能仅凭文件存在认定成功。

恢复演练在隔离库完成，读取项目、关联、审计和报告后核对，不仅检查备份文件存在。

运行关注：错误率、延迟、磁盘空间、数据库连接、慢查询、备份状态、任务积压、证书到期。定期评估依赖升级，使用固定版本与锁文件，不盲目追随 latest。

## 8. 发布记录模板

每次软件发布记录：版本、提交、构建摘要、数据库迁移版本、需求范围、测试结果、目标环境、备份/回退方式、执行人、时间、运行版本回读和业务验收结果。

软件发布及文档变化统一记录在[更新记录](../changelog/CHANGELOG.md)，当前实现状态见系统真相。
