# 技术栈基线

日期：2026-10-29；本文维护技术路线和部署边界，实际实现、测试及环境版本统一查[系统真相](../status/current-system-truth.md)。早期工程验证记录保留在第3节，不表示当前认证或业务仍未实施。

## 1. 已确定的方向

**2026-10-29部署目标更新（DEC-172）：**新环境采用阿里云服务器上的K3s和阿里云RDS MySQL。用户明确版本范围为“8.0+”，即MySQL 8.0及以上，不限定为8.0.x系列；按实际部署版本验证兼容性，不将版本范围视为所有版本已经验证通过。地域不是当前设计的阻塞条件，实际私网连通和白名单在部署前验证。下方本地容器与旧测试机说明保留其原环境范围。

用户明确采用：保留现有页面与操作习惯、抽出共享模块后调用 API；Node.js + TypeScript 常驻后端；MySQL 持久化业务、会话和审计；SSE 通知变更。正式部署已由Compose调整为K3s，并在DEC-173确认前后端独立Deployment、同域访问、首版同版本发布。Docker可继续用于本机构建OCI镜像，Compose仅归原本地/旧测试环境，不再作为新服务器发布入口。本文中的具体库是据此收敛的工程选型，不代表已安装或验证兼容性。

| 层次 | 首版选型 | 使用边界 |
|---|---|---|
| 页面 | 现有多页面 HTML、CSS、原生 DOM及TypeScript共享模块；当前构建入口14页 | 保留入口、布局和操作习惯；页面清单由Vite构建配置维护，不引入单页重写 |
| 前端构建 | Vite 8 多页面构建 | 编译共享模块、处理静态资源；不引入 Vue、React、Pinia 或前端路由框架 |
| 后端 | Node.js 24 LTS + TypeScript + Fastify 5 | 一个常驻应用进程，内部按业务划分深模块；REST JSON API，JSON Schema 校验输入 |
| 数据访问 | mysql2 连接池、参数化 SQL、版本化 SQL 迁移 | 事务在业务模块内统一控制，SQL 封装在模块内部；首版不叠加 ORM |
| 数据库 | 新环境为阿里云RDS MySQL 8.0+；最低8.0.16以执行现有CHECK约束，实际目标版本仍须验证 | 独立数据库，运行/迁移账号分开，TLS校验CA和主机名；本地及既有腾讯云环境仍为MySQL 8.4，不据目标修改已运行的库 |
| 身份认证 | 服务端会话 + HttpOnly / Secure / SameSite Cookie；密码采用 Argon2id 哈希 | MySQL 保存会话校验信息、期限和撤销状态；写请求增加 CSRF 防护；期限与恢复采用 SPEC-001 已确认契约 |
| 多人通知 | SSE + 浏览器 EventSource | 提交后推送资源 ID、版本和变更类型，浏览器按需重新查询 |
| 部署 | 阿里云K3s：前端Nginx与后端Node独立镜像及Deployment，RDS独立；原生资源JSON由Node标准库生成 | 同域按页面与/api分流；首版同版本、后端单副本、维护窗口发布，迁移Job复用后端镜像。入口控制器、存储及升级窗口按实际集群核对；原Compose环境不自动迁移或停用 |
| 测试 | TypeScript检查、Node断言脚本、真实隔离MySQL/API及K3s技术验证 | 核心写入持久化后以新请求回读；用户负责真实浏览器操作，助手不以接口结果替代业务体验验收；不为本轮新增测试框架 |
| 依赖与代码管理 | npm、package-lock.json、GitHub | 首次工程初始化生成锁文件，CI 用 npm ci；本文不是已生成锁文件的证明 |

Node.js 24 当前属于 LTS，采用该版本线有明确支持周期，见 [Node.js 官方发布表](https://nodejs.org/en/about/previous-releases)。后端框架遵循 [Fastify 支持策略](https://fastify.dev/docs/latest/Reference/LTS/)。Vite 用作[多页面构建](https://vite.dev/guide/build.html#multi-page-app)，不会强制改变现有页面形态。

## 2. 选型边界

- 首版不部署 Redis，普通业务保存直接使用 MySQL 事务。若确认存在需后台持续执行和重试的耗时任务，再按实际需求决定队列。
- 原页面按功能迁移，前后端只共享必要的接口类型与纯计算，业务写入约束由后端负责。模块及数据流见[架构](architecture.md)。
- SSE 只负责单向变更通知，客户端收到资源标识后重新读取数据。不能将其当成持久消息队列，见 [MDN SSE 文档](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)。可靠性和编辑中刷新行为由架构与规格定义。
- 现有页面组件先复用，不为迁移额外引入 UI 库、图表库或流程图框架。
- 业务账号不设固定数量上限；多人实际使用的并发规模按需求和测量确定。新加坡网络下的实际性能需测量，选型本身不能证明容量或性能达标；目标与测法见 SPEC-012 和测试策略。

## 3. 版本固定方式

固定技术路线与主要版本线。E01-F01 已生成 [package-lock.json](../../package-lock.json)，当前安装范围的前后端编译与本地运行已验证；精确包版本归锁文件，Node 24 镜像摘要固定在 Dockerfile/Compose。初选静态插件的告警已按官方兼容范围和实际审计修复，记录见[验收报告](../testing/reports/2026-10-08-e01-f01.md)。F02/F03 已安装 mysql2 3.24.5 并验证独立迁移连接、真实 SQL 与结构核验；MySQL 8.4 的实际镜像摘要固定于 compose.mysql.yml。F04 已复用 mysql2 建立运行连接池、就绪与关闭，结果见[F04 报告](../testing/reports/2026-10-08-e01-f04.md)；认证、Vitest/Playwright 等在对应功能产生时再安装，不将技术选型表当作全部依赖已安装。实际范围见[F02/F03 实际报告](../testing/reports/2026-10-08-e01-f02-f03.md)。

补丁升级经检查后发布，框架或数据库大版本升级需要更新此文与决策记录。数据库实例归属和共享服务器例外见架构，迁移、发布及恢复步骤唯一维护于[发布维护](../operations/release-maintenance.md)。

协作、技能触发和文档规则见根目录 AGENTS.md；业务自动化不会因技术选型而获准，规则正文维护于规格书。
