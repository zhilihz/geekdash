# 导入与面板修复：本地用户测试入口

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
