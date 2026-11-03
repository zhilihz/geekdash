# 导入与面板修复：本地用户测试入口

## 2026-11-03 驾驶舱与项目卡片本地更新

41874 本轮从 16daf52 经 b5ffc17、d051677 更新到 `d93dbcbb001ebdeee899e4b935de27c2a0bfb963`。最终使用该提交的 Git 归档在容器 Linux 目录中洁净构建，时间 2026-11-03T06:33:22.568Z。镜像 `geekdash:local-repair-d93dbcb`，ID `sha256:e09d01a3af4d87dbf79c8654bf501e2e549fa578fbbd99faac8264695a67b47c`。

仅替换本地应用。宿主 health/live 返回该提交且 dirty=false，ready 就绪，容器 healthy；实际返回的14个页面、37份页面直接引用资源和10个图标的 SVG 与该构建一致。数据库 UUID 仍为 222bfde8-d6b3-11f1-83c3-c223ed5403e0，更新前后都是35项目、1账号、1系统配置，schema 0016。未执行迁移或写入用户项目。上个应用配置是本机启动目录下的 `compose-before-d93dbcb.yaml`，回退只需恢复配置并重建应用。未更新原41873、Harbor或公网。

## 2026-11-03共享交互反馈更新

41874由d928b1a更新为`16daf527e6f936b09960efbe7337ef5e7826e980`，clean构建`2026-11-03T02:29:28.115Z`，仍为0016。本次只更新应用，不涉及数据库迁移。

| 核对项 | 实际结果 |
|---|---|
| 镜像 | `geekdash:local-repair-16daf52`；ID `sha256:55f70ad19159983f14eec7c4174529026df052f3f2cd630c5c6e907fa76c826e` |
| 容器/配置 | 仍为`geekdash-uat-8a43e33`、localhost:41874；Compose只改image，旧配置保存在原目录`compose-before-16daf52.yaml` |
| 数据 | 同一state绑定；更新前后UUID `222bfde8-d6b3-11f1-83c3-c223ed5403e0`，项目35、账号1、系统配置1；只读核查，不重置密码或运行合成夹具 |
| 回读 | healthy；宿主live为16daf52/dirty=false/0016，ready；容器HTTP14页37资源成功，14页最终样式含共享dialog/hidden规则且最后加载 |
| 范围 | 卡片切换、任务操作、所有同类dialog、风险/变更原处保存；程序证据归报告第7节，真实浏览器由用户验收 |
| 交付 | 本地提交和更新；未推送/合并main，未上传Harbor或操作服务器 |

如需回退本次应用，恢复旧Compose镜像并`docker compose up -d --no-build`；保留state、账号文件和0016结构。无需重建库，不能使用初始化脚本覆盖用户已录入项目。以下是旧版本的历史记录。

## 21:24反馈版本更新

本地41874已从8a43e33更新为`d928b1a604b323346cc823a50c269e61e5d6c934`，clean构建时间`2026-11-02T13:21:27.832Z`，仍为0016。本次只替换应用构建，没有新增迁移、账号重置或用户业务写入。以下19:49为空白实例首次启动时的历史记录，不代表现在数据量。

| 核对项 | 本次结果 |
|---|---|
| 镜像 | `geekdash:local-repair-d928b1a`，ID `sha256:3ff3ab1a034ed164d372065fca38a7c59b1c3ee7eeb76acc6e3ee97be86acef5` |
| Compose与数据 | 原容器名、端口、state绑定和初始化文件不变，仅替换镜像引用；旧Compose保存在同目录`compose-before-d928b1a.yaml` |
| 数据保留 | 更新前后UUID `222bfde8-d6b3-11f1-83c3-c223ed5403e0`相同，项目35、账号1、系统配置1；只读SQL核对，未执行夹具 |
| 运行回读 | Docker healthy；宿主机live返回d928b1a/dirty=false/0016，ready正常；5个相关页面及23个直接关联资源HTTP200 |
| 测试边界 | 程序验证归报告第6节；三主题视觉、真实中文输入、真实业务操作由用户测试，未冒充已通过 |
| 交付 | 本地产品已提交；未推送/合并main，未上传Harbor，未更新公共服务器 |

若仅回退此次应用，在同目录恢复旧Compose镜像引用后执行`docker compose up -d --no-build`；保留现有state和账号文件，不重新初始化数据库。本次未改变数据库结构。

## 19:49首次部署记录

2026-11-02 19:49（北京时间），按用户“部署让我测试一下”启动独立本地实例。只交付本机测试入口，未上传 Harbor、未更新公共服务器、未操作线上数据库。真实页面及备份操作由用户验收。

| 项目 | 实际运行值 |
|---|---|
| 访问地址 | `http://localhost:41874`；使用 localhost，避免与旧 127.0.0.1 实例共用登录 Cookie |
| 产品提交 | `8a43e33dc2388d00b9dc0e2a0b9e2cb01c69565e`，clean 构建 |
| 构建时间 | `2026-11-02T11:41:04.390Z` |
| 数据结构 | `0016-project-name-reservation` |
| 镜像 | `geekdash:local-repair-8a43e33` |
| 本机镜像 ID | `sha256:83d7d5222388851ed3d04e9322b951416a7d1df301fdd76087b6b116d8a96693` |
| 容器 | `geekdash-uat-8a43e33`，自动重启 `unless-stopped` |
| Compose | `D:/geekwon/geekdash-data/uat-8a43e33/compose.yaml` |
| 数据目录 | `D:/geekwon/geekdash-data/uat-8a43e33/state`，挂载 `/var/lib/mysql` |
| 独立数据库 UUID | `222bfde8-d6b3-11f1-83c3-c223ed5403e0` |
| 初始化 | 仅 `admin`：管理员兼任项目经理；项目 0，账号 1，系统配置 1 |
| 凭据 | 仓库外受控 `D:/geekwon/geekdash-data/uat-8a43e33/test-access.json`，不进入 Git |

本地镜像以既有单容器 Docker 镜像 `V0.1.1-cc4a34b` 为基础，替换 `/app/dist` 为本次 clean 构建，复用原初始化入口；不是 K3s 发布包。应用与 MySQL 在此独立容器内运行，数据库端口不向宿主机开放。旧 41873 容器和数据未改动。

## 已执行核对

- 容器 healthy，宿主机 `/api/health/live` 回读产品提交和 0016；`/api/health/ready` 为 ready。
- 新管理员实际登录成功，后续请求确认管理员及项目经理资格；项目列表、历史项目、客户资料、企业配置、账号列表读取成功。核对会话随后退出成功。
- 首页、登录、导入、项目空间、详情、账号页面均 HTTP 200。
- 独立 SQL 连接回读上述 UUID、初始计数；应用 UID 1000 可读写导入目录。
- 未导入业务备份、未创建合成项目、未代用户执行真实页面测试。既有程序验证范围见[修复报告](../../testing/reports/2026-11-02-import-panel-repair.md)。

## 接手边界

用户从此入口开始录入后，本目录就是用户测试数据，不得再运行清库或合成验收脚本。需要恢复启动时，在该目录运行 `docker compose up -d --no-build`；不得使用其他项目的初始化目录覆盖这里。公网部署及 Harbor 上传仍交同事，后续先收集用户实际操作反馈。
