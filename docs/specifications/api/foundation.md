# 工程基础接口

日期：2026-10-08；对应 package 0.1.0 / E01-F01。手工对照实际代码与 HTTP 核查，源码版本及哈希见[验收证据](../../evidence/2026-10-08-foundation-check.json)。业务/运行边界引用 SPEC-011；此文只记录当前协议。

## GET /api/health/live

当前仅本机入口。进程可响应返回 200：

```json
{
  "status": "alive",
  "stage": "foundation",
  "build": {
    "revision": "源码提交的完整 SHA",
    "dirty": true,
    "builtAt": "UTC ISO 时间",
    "stage": "foundation",
    "schemaVersion": null
  }
}
```

dirty 是构建时源码状态，不是请求时 Git 状态。schemaVersion 为 null 表示未建立迁移版本。此接口不证明业务或数据库可用，不含库地址、账号、口令或真实项目数据。

## GET /api/health/ready

当前返回 503：

```json
{ "status": "unavailable", "reason": "database_not_implemented" }
```

该反馈是 F01 的真实范围说明。F04 实现数据库连接/兼容性后再修订协议与测试，不提前返回成功。

## 静态资源与其他路径

GET / 返回工程验收页；仅提供 dist/web 的构建资源。未实现业务 API 返回 404，隐藏文件路径返回 403；源码、文档和配置不作为静态根目录。HOST/PORT 无效时启动退出非零；默认 HOST 为 127.0.0.1、PORT 为 3000，容器内部监听 0.0.0.0 并由 Compose 限定宿主机回环绑定。
