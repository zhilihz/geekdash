# 新加坡项目只读首批部署记录

日期：2026-10-08；环境：现有新加坡测试机，独立 Compose 项目 geekdash。公网入口：https://geekdash.zhiluan.cool 。本次仅开放项目看板和详情读取，免登录；正式库为空，真实备份未导入。

## 固定构建与实际运行

- 源码：dfd9f0cc837ff98c10c61541dee2a8b3a057b057，施工分支 codex/project-read；已快进合并并推送远端 main，ls-remote 回读一致。后续纯文档提交不改变该运行镜像。
- 构建时间：UTC 2026-10-08T11:20:06.268Z；dirty=false，stage=project-read，linux/amd64。
- 镜像 ID：sha256:fe24cf856805d3302e383cc77dd605d9e73163116de23e71a47a5113575dfd28。镜像及非秘密发布包从本机固定构建交付，下载后分别核对摘要，服务器未取得 GitHub 长期凭据。
- current：/opt/geekdash/releases/dfd9f0cc837ff98c10c61541dee2a8b3a057b057。沿用受控 secrets、Nginx、证书和 MySQL 数据目录；本次没有变更 DNS、站点、数据库结构或重启 MySQL。
- 两库实际新连接核验：0001-foundation，34 表、313 列、55 外键、差异 0；测试清理后每库业务行数 0，迁移登记各一条。

## 验证与实际回退

发布前在云端 test_app 专用库运行固定脚本，实际插入 30 条夹具、HTTP 消费及并发提交快照、连接池耗尽/恢复均通过；使用一次性只读根文件系统容器，无公开端口，结束删除自建行。使用脚本来自同一发布包，不在正式库灌测试数据。

UTC 11:28:03 完成升级 → 兼容前版 c560668 → 恢复本次新版，三个阶段均通过真实 HTTPS live/ready 回读。只更新 app；MySQL ID 与 StartedAt 不变，原 17 个其他容器仍运行，app healthy、RestartCount=0、OOMKilled=false。没有从备份恢复数据库；这项回退仅适用于同一 0001 结构。

本机独立 HTTPS 请求核验首页、旧 GeekDash.html 别名、详情入口、全部首页引用资产、no-store、空列表、非法参数 400、项目不存在 404、无写路由和服务端私有路径 404。实际浏览器读取公网空态并保存[截图](../../evidence/2026-10-08-project-read-public.jpg)；后续多动作交互受到工具超时影响，不能计作公网交互全验收。详情已有集合在本地浏览器/云端 HTTP 测试库验证，公网没有真实项目可点击。

四并发短测分别为：云内 30 条夹具 20 次列表 P95=59ms；本机到公网空库 20 次列表 P95=3531.6ms，全 200。两者范围不同，均不能代替四人真实浏览器体验；网络与首屏体验仍需后续实测。

## 备份与容量边界

切换前生成两库的逻辑备份 /var/backups/geekdash/pre-project-read-dfd9f0cc837f.sql.gz，模式 0600，10349 字节；gzip 可读且包含表结构，摘要归证据。没有完成完整配置/文件备份、隔离恢复、定时任务或加密服务器外副本；不把此文件称 E11 完成。

UTC 11:37:17 收尾采样：app 33.4/256MiB，MySQL 491.7/512MiB；切换后宿主 available 754MiB、swap 已用 1987MiB、磁盘可用约 17.22GB。MySQL 当前接近限额，真实数据接入前要结合宿主余量调整并重新验收容量；本次无 OOM 只说明已执行的范围。自身服务器下载归档已清理，固定版本及前版镜像保留用于回退；真实业务备份仍留在受控原位置。

全部脱敏事实见[云端证据](../../evidence/2026-10-08-project-read-cloud-check.json)，执行范围见[验收报告](../../testing/reports/2026-10-08-project-reads.md)。日常与升级方法唯一归[发布维护](../release-maintenance.md#linux-服务器实际运行入口)。
