# GeekDash 单镜像部署核验

用户指定 Harbor 项目 `geek-dash`，以本地 41870 截图确认产品版本，并将保留账号纠正为 `admin`。用户进一步明确镜像本身合一，不能仅合并压缩包。当前交付已替换为一个镜像、一个运行容器、一个上传脚本入口；旧双镜像上传配置已移出交付区。

## 产物

- 产品版本：`cc4a34bac3458984d0a462aa593e89bedad94a44`，schema `0015-project-deletion`。当前分支尚未合并 main；不称为已验收主干版本。
- 固定运行目录与 dist 的 111 个文件逐个 SHA-256 相同；合并镜像直接复制该应用产物，没有修改业务代码。
- 当前交付镜像：`geekdash:V0.1.1-cc4a34b`，包含应用、Node 24.21.0、MySQL 8.4.11、自动配置/迁移/账号初始化及进程监督程序；旧镜像保留，不再是上传入口。
- 已验证镜像标识：`sha256:87c653894be0f325484df41df092e8f27d29fbc2a50741e7c3e33e773398f408`。
- 唯一 Harbor 目标：`harbor.geekwontek.com/geek-dash/geekdash:V0.1.1-cc4a34b`。
- 唯一上传入口：[push.bat](../../../deploy/harbor/push.bat)，只执行一次 docker push；没有第二个 PowerShell 或服务器启动脚本入口。构建源与初始化实现保存在 deploy/harbor，作为镜像内部实现。
- 交付目录：`D:/geekwon/geekdash-data/harbor-cc4a34b/package`；统一压缩包为其同级 `geekdash-harbor-cc4a34b.zip`，SHA-256 为 `0e6cd4abc44123b9e52c156847575b851b8fe31e89b8acd853096f3d11807e0a`。
- 包内仅有 `push.bat`、`compose.yaml`、`.env.example`、`admin-account.json` 四个文件。账号文件与其余配置同级，已比对受控原件。镜像保存在本机 Docker，压缩包提供上传/部署所需文件。
- 包内包含 admin 的密码哈希和既有权限，不含明文密码。账号文件不写入镜像、Harbor 或 Git。原业务数据、历史、其他账号以及 Agent 文档均未包含。

## 2026-10-29精简与交付切换

用户要求参照线程 `01a085fd-5d7a-74d3-8ae5-c43165dc87e0`，仅精简不需要的镜像内容，保留全部项目功能及必需依赖；历史的镜像、容器、数据卷清理仍暂停。接续该线程已构建但未验证的 V0.1.1 候选，本轮完成隔离核验及交付切换，没有修改业务代码、用户库或部署远端。

| 指标 | V0.1.0 | V0.1.1 |
|---|---:|---:|
| Docker CONTENT SIZE（压缩内容） | 289,698,642 字节，约 276.28 MiB | 146,124,347 字节，约 139.35 MiB |
| Docker DISK USAGE（界面显示） | 1.32 GB | 559 MB |
| 应用目录对应镜像层 | 31.4 MB | 17.5 MB |

压缩内容减少约 49.6%。移除 mysql-shell、用于镜像构建的软件包管理工具及相关依赖、依赖包内的测试/示例/类型声明与非运行文档。清理后复制文件系统生成最终层，避免删除的内容仍留在下层。保留 Node、MySQL 服务和普通客户端、mysqldump、官方初始化脚本、数据库迁移、TLS 根证书、ICU/时区数据及许可证。

本轮仅使用 `slim-check` / `geekdash-slim-check` 隔离环境，数据库 UUID `8035a869-d346-11f1-8052-5ae062503b5a`。验证入口复用 `scripts/verify-harbor.mjs`，增加产物完整性和 SQL 恢复检查；验证脚本的首次恢复核对使用了仅限业务库的迁移账号，权限正确拒绝跨库读取，已改为只在隔离库中使用 root 客户端核对，没有扩大业务账号权限，随后完整检查通过。

| 检查 | 本轮实际结果 |
|---|---|
| 业务产物 | 111 个文件与打包基线逐个 SHA-256 相同，包含全部页面、后端和迁移 |
| 运行依赖 | Fastify、静态服务、mysql2、完整应用入口加载成功；Node 时区与证书保留 |
| 全新数据库 | 自动建立 49 张表、15 条迁移，仅 admin 和必要初始化记录；无旧项目或资料 |
| SQL 备份恢复 | 用 mysqldump 导出并经普通 mysql 恢复到隔离临时库，迁移数、账号数、项目数及密码哈希对账通过，临时恢复库随后移除 |
| 重复启动及保护 | 幂等初始化、非空库拒绝、容器重建后 UUID/账号/表计数一致 |
| 文件及进程 | 导入文件重建后可读；应用进程异常后自动恢复；应用 UID 1000、MySQL UID 999 |
| HTTP | live/ready/首页均 200，产品版本仍 cc4a34b、schema0015 |
| 上传入口 | 原 package、仓库脚本、Compose、环境示例及 ZIP 已指向新标签/ID；CheckOnly 实际退出 0 |

脱敏证据：[slim-verification.json](../../evidence/harbor-cc4a34b/slim-verification.json)。原 admin 账号文件保持一致；未获取或输出明文密码。真实页面验收未执行，也没有把文件一致性说成全部业务操作已重测。本轮未上传精简版 Harbor、未合并 main、未部署服务器。关联线程曾读取原版远端镜像，本轮没有重新查询其当前状态。旧镜像和原隔离卷未清理。

### 本地运行及排错证据

用户随后要求实际运行精简项目并检查问题追踪能力。已保留 `geekdash-slim-check-geekdash-1` 运行，入口 `http://127.0.0.1:41873`，使用上述独立空白库和 admin 原密码哈希。宿主机新请求读取14个HTML和37个静态资源均200，ready正常；未登录身份请求返回401，响应requestId能在容器日志中对应。证据：[local-runtime.json](../../evidence/harbor-cc4a34b/local-runtime.json)。不要在用户开始使用后重跑会改验证数据或重建容器的verify-harbor脚本。

应用请求、响应状态、数据库错误和进程退出写入 Docker 日志；Compose已有每文件10 MB、最多3个文件轮转。定位命令为 `docker logs --timestamps --tail 200 geekdash-slim-check-geekdash-1`，重建容器前先导出。live提供产品提交/schema，健康状态及重启次数可用docker inspect查看；业务历史/保存回执在MySQL。现有部分500错误只记录错误码，没有完整堆栈；日志轮转或删除重建容器会丢旧日志，因此不声称已经具备完整、长期的错误追踪系统，本轮没有借镜像精简改写业务日志。

## 首次单镜像运行与验证（V0.1.0历史）

Compose 只声明一个 geekdash 服务。容器自动生成独立数据库技术凭据、启动内部 MySQL、等待 TCP 就绪、执行迁移与 admin 初始化，随后以 UID 1000 启动应用。MySQL 使用 UID 999，只监听容器内 127.0.0.1；数据库与导入文件存放在独立持久卷。任一关键进程退出会结束整个容器，交由 Docker 的重启策略恢复。启动后移除应用不需要的运行时迁移凭据；持久凭据目录仅 root 可访问。

本次只操作 `geekdash-single-check` 隔离容器，数据库 UUID `f1283e97-d2bc-11f1-b524-029b11c2e2e3`。未修改用户 41870 数据库。隔离容器验证后停止，保留验证卷；原应用回读仍为 ready。

| 检查 | 实际结果 |
|---|---|
| 上传脚本 | Windows 实际执行 CheckOnly 退出 0；核验一个 linux/amd64 镜像，未联网上传 |
| 自动初始化 | 无需独立 start.sh 或 dbtool 服务，一个容器直接启动至 ready |
| 初始账号 | 仅 admin；原密码哈希与 enabled、must_change_password、is_admin、is_project_manager 全部匹配 |
| 初始数据 | 49 张表中仅 users 1、system_configuration 1、schema_migrations 15、audit_log 1；其余全部 0 |
| 审计记录 | 唯一记录是本次初始化，没有旧历史 |
| 重复初始化 | 复用现有状态，不重置密码、不增加账号 |
| 非空库保护 | 没有本次初始化标记的非空库明确拒绝，既有账号保持原值 |
| 容器重建 | force-recreate 后数据库 UUID、账号及全部表计数保持一致 |
| 文件持久化 | 以应用 UID 写入导入目录，重建后可读，验证文件随后移除 |
| 异常恢复 | 仅在隔离容器强制结束应用进程，容器重启计数增加并恢复 healthy；数据库及密码不变 |
| 实际身份 | 应用 UID 1000，MySQL UID 999 |
| 应用回读 | 首页 HTTP 200，ready；live 为 cc4a34b/schema0015 |

执行入口：`node scripts/verify-harbor.mjs D:/geekwon/geekdash-data/harbor-cc4a34b/single-check`，仅限本次隔离项目；该检查含容器重建和进程终止，不得对用户环境运行。脱敏结果见 [verification.json](../../evidence/harbor-cc4a34b/verification.json)。

本机镜像启动、初始化、持久化和异常恢复已实际验证。未获取明文密码，未模拟原密码登录；没有执行本轮浏览器视觉验收、Harbor 上传或目标服务器部署。新服务器网址仍需填写到 .env，外部 HTTPS 入口由部署环境配置。压缩包中没有 README 或其他 Agent 产物。

## 上传前故障修正与回读

2026-10-29，旧脚本卡在本地 image inspect；Docker Desktop 显示运行，但 image inspect/version 超时，内部连接报 no route to host。随后核实 D 盘剩余 0 字节、containerd 崩溃；普通重启未立即恢复。将旧 Dify 离线归档 platform-images 临时移至 C:/Users/Administrator/AppData/Local/DockerRecovery-geekdash-20261029/platform-images，80 个文件逐个 SHA-256 一致，释放约 2.357 GiB 后用户重新打开 Docker，引擎恢复。该归档保留，未删除；原 D 盘归档位置暂不可使用。

push.bat 将两次查询合为一次，先显示进度，30 秒无响应则终止本次查询；Docker 原始错误保留，查询失败与镜像版本/平台不符分别提示。实际 CheckOnly 退出 0；不存在的 Docker context 退出 1 且显示原始错误；本地无响应端点模拟在 30.64 秒退出 1，未执行上传。工作区、交付目录和四文件压缩包中的脚本一致，保持 UTF-8 无 BOM、CRLF。

恢复后引擎 29.6.1，镜像 ID 与本报告一致、linux/amd64；Harbor 使用既有 admin 凭据登录成功。目标 geekdash:V0.1.0-cc4a34b 查询返回 not found，表示本次版本尚无可读远端产物，尚未实际 push 验证。用户明确要求全部暂停清理：没有删除镜像、容器或数据卷。检查时 D 盘仅约 1.4 GiB 可用，不能把引擎恢复称为磁盘容量问题已彻底解决。
