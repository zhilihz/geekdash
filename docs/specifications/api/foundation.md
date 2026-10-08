# 工程基础接口

日期：2026-10-08；对应 package 0.1.0 / E01-F01～F04。手工对照实际代码与 HTTP 核查，结果见[F04 报告](../../testing/reports/2026-10-08-e01-f04.md)及[脱敏证据](../../evidence/2026-10-08-readiness-check.json)。业务/运行边界引用 SPEC-011；此文只记录当前协议。

## GET /api/health/live

当前仅本机入口。进程可响应返回 200，响应 Cache-Control: no-store：

```json
{ "status": "alive", "stage": "foundation", "build": { "revision": "源码完整 SHA", "dirty": false, "builtAt": "UTC ISO 时间", "stage": "foundation", "schemaVersion": "0001-foundation" } }
```

dirty 是构建时源码状态。schemaVersion 是构建所需结构版本；不代表此接口已检查实际库。该入口不证明数据库、认证或业务可用，不含库地址、账号、口令及项目数据。

## GET /api/health/ready

启动已核验身份、授权、实际结构和版本/校验和；运行时有界真实查询及登记核验成功后返回 200，响应 Cache-Control: no-store：

```json
{ "status": "ready" }
```

不可用返回 503 和同样的 no-store：

```json
{ "status": "unavailable", "reason": "database_unavailable" }
```

| reason | 含义 |
|---|---|
| database_unavailable | 连接/查询失败或检查超时 |
| schema_incompatible | 结构、登记、校验和或受限身份不兼容 |
| database_busy | 当前应用的 8 条池连接已占满，不无限排队 |
| closing | 应用正在关闭 |
| database_not_configured | 仅离线构建测试调用 createApp() 时未注入数据库；真实 start 入口不会跳过数据库而监听 |

成功探测最多复用 2 秒，并发探测共用一轮；失败后重新探测。启动完整检查上限 15 秒，日常及恢复检查总预算 3 秒，超时销毁实际连接。断连恢复必须重新核验完整结构才 ready；受控发布仍须 db:verify。轻量探测不能发现运行中任意人工改表，缓存窗口也不能替代后续业务查询的错误处理。ready 只表示基础依赖，不表示完整面板可使用。

## 静态资源与其他路径

GET / 返回工程验收页，仅提供 dist/web；未实现 API 在就绪时返回 404，数据库不可用时 /api/ 业务入口先返回 503，保留 live/ready 与静态资源。隐藏文件路径返回 403；源码、文档和配置不作为静态根目录。

HOST、PORT 或 GEEKDASH_DB_PROFILE 无效时启动非零退出并仅输出受控错误码和配置项名；缺凭据、数据库失联或不兼容也在监听前失败，不执行迁移。默认 HOST=127.0.0.1、PORT=3000、GEEKDASH_DB_PROFILE=dev_app；容器监听 0.0.0.0，组合 Compose 仅绑定宿主回环 41860。SIGTERM/SIGINT 关闭预算 5 秒，不停止 MySQL。运行命令归[发布维护](../../operations/release-maintenance.md)。
