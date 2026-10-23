# P05 导入链修正测试部署

## 1. 固定产物与范围

- 环境：新加坡既有测试机的GeekDash独立实例，入口`https://geekdash.zhiluan.cool`。
- 产品：`1c0e1d228814591fa1cdc24d92861fcfdab84f04`，已合并推送main；干净构建`2026-10-23T06:00:17.620Z`，结构`0006-imports`。14:44北京时间独立回读确认运行版本。
- 原版本：`13255f37ca8937584c709466fee5036739ab0203`。本次仅替换兼容应用及本站普通JSON压缩配置，未重复迁移；SSE独立位置保持。
- 镜像：`sha256:b3f9f227d42d5ad44595eb11583acacb6a33c05d2ce3eedc2da215fc19d16896`。

## 2. 备份与安装事实

| 备份 | 服务端位置 | SHA-256 |
|---|---|---|
| 双库完整SQL，包含例程、事件、触发器 | `/var/backups/geekdash/pre-p05-import-chain-1c0e1d228814.sql.gz` | `d50092f89003aed669b607f509a12516a6fdb1cd4b65b866c51420caab6643b2` |
| 导入原文件、配置与发布资料 | `/var/backups/geekdash/pre-p05-import-chain-1c0e1d228814-files.tar.gz` | `28bdb9906d9bacd5fdf01f0918286e31d573fb100878a46d02a76f0c4af12ccd` |

安装前后两库各37表的业务值、结构与6次迁移登记保持；MySQL及119个其他既有容器保持。备份哈希独立核对通过，本次没有重新执行恢复演练。

首次安装预检因现行nginx中`client_max_body_size 32m`的位置与旧模板不同而停止，发生在停应用、备份或迁移之前。核对原包及明确失败现场后，只允许该既有指令位置差异，沿同一包接续；原失败记录保留。成功记录为`/opt/geekdash/incoming/1c0e1d228814591fa1cdc24d92861fcfdab84f04/p05-import-chain-resume-deployment-facts.json`。

## 3. 运行结果与恢复

独立回读及哈希核对记录在忽略的`test-results/p05-import-chain-remote-readback.json`。9页26资源、合成项目正式保存与新请求下游消费的范围见[报告第6节](../../testing/reports/2026-10-23-p05-import-chain.md#6-固定发布与公网验证)。用户随后实际整批操作暴露未完成与恢复缺口，见同报告第7节；发布成功不等于导入整体通过验收。

需要回退时保留当前业务数据，使用兼容0006的原应用产物及对应nginx配置。不得回灌发布前数据库覆盖发布后已入库项目；不要重复执行本次安装或迁移。
