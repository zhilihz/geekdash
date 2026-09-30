# 技术栈基线

版本：D0.30；日期：2026-09-30；状态：服务器版实施基线，尚未构建。

## 1. 已确定的方向

用户本轮明确采用：保留现有页面与操作习惯、抽出共享模块后调用 API；Node.js + TypeScript 常驻后端；MySQL 持久化业务、会话和审计；Docker Compose 管理部署；SSE 通知变更。本文中的具体库是据此收敛的工程选型，不代表用户逐一指定了这些库，也不代表已安装或验证兼容性。

| 层次 | 首版选型 | 使用边界 |
|---|---|---|
| 页面 | 现有六个 HTML 页面、CSS、原生 DOM，新增共享模块使用 TypeScript | 保留入口、布局和操作习惯，逐页迁移；是否合并单页应用由实际切页体验决定 |
| 前端构建 | Vite 8 多页面构建 | 编译共享模块、处理静态资源；不引入 Vue、React、Pinia 或前端路由框架 |
| 后端 | Node.js 24 LTS + TypeScript + Fastify 5 | 一个常驻应用进程，内部按业务划分深模块；REST JSON API，JSON Schema 校验输入 |
| 数据访问 | mysql2 连接池、参数化 SQL、版本化 SQL 迁移 | 事务在业务模块内统一控制，SQL 封装在模块内部；首版不叠加 ORM |
| 数据库 | 独立 MySQL 8.4 LTS 容器、InnoDB、utf8mb4 | 业务数据、独立用户、会话、操作历史、页面偏好；应用重启后仍可恢复；不复用其他系统数据库实例 |
| 身份认证 | 服务端会话 + HttpOnly / Secure / SameSite Cookie；密码采用 Argon2id 哈希 | MySQL 保存会话校验信息、期限和撤销状态；写请求增加 CSRF 防护；期限与恢复采用 SPEC-001 已确认契约 |
| 多人通知 | SSE + 浏览器 EventSource | 提交后推送资源 ID、版本和变更类型，浏览器按需重新查询 |
| 部署 | Docker Compose + Nginx HTTPS 入口 | 现有新加坡测试机上的独立工程，入口 geekdash.zhiluan.cool；应用与数据库独立生命周期，自动重启、健康检查、独立持久卷；数据库端口只对内部开放 |
| 测试 | Vitest + 真实 MySQL 集成测试 + Playwright 浏览器测试 | 核心业务通过真实写入、新请求回读与第二个用户查看验证 |
| 依赖与代码管理 | npm、package-lock.json、GitHub | 首次工程初始化生成锁文件，CI 用 npm ci；本文不是已生成锁文件的证明 |

Node.js 24 当前属于 LTS，采用该版本线有明确支持周期，见 [Node.js 官方发布表](https://nodejs.org/en/about/previous-releases)。后端框架遵循 [Fastify 支持策略](https://fastify.dev/docs/latest/Reference/LTS/)。Vite 用作[多页面构建](https://vite.dev/guide/build.html#multi-page-app)，不会强制改变现有页面形态。

## 2. 选型边界

- 首版不部署 Redis，普通业务保存直接使用 MySQL 事务。若确认存在需后台持续执行和重试的耗时任务，再按实际需求决定队列。
- 原页面按功能迁移，前后端只共享必要的接口类型与纯计算，业务写入约束由后端负责。模块及数据流见[架构](architecture.md)。
- SSE 只负责单向变更通知，客户端收到资源标识后重新读取数据。不能将其当成持久消息队列，见 [MDN SSE 文档](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)。可靠性和编辑中刷新行为由架构与规格定义。
- 现有页面组件先复用，不为迁移额外引入 UI 库、图表库或流程图框架。
- 新加坡网络下的实际性能需测量，选型本身不能证明四人性能达标；目标与测法见 SPEC-012 和测试策略。

## 3. 版本固定方式

固定技术路线与主要版本线。精确依赖版本及容器镜像摘要在首次可运行构建验证后锁定；当前没有 package-lock.json，不宣称依赖兼容性已通过。

补丁升级经检查后发布，框架或数据库大版本升级需要更新此文与决策记录。数据库实例归属和共享服务器例外见架构，迁移、发布及恢复步骤唯一维护于[发布维护](../operations/release-maintenance.md)。

协作、技能触发和文档规则见根目录 AGENTS.md；业务自动化不会因技术选型而获准，规则正文维护于规格书。
