# 首页卡片与每日检查测试部署

## 1. 版本与范围

- 环境：既有新加坡GeekDash独立Docker应用，入口 `https://geekdash.zhiluan.cool`。
- 施工分支：`codex/p04-flow-convergence`；产品`cc0bc73efe0f95b647e8662646c69a391c1fd3a5`已推送。main仍`b96712a8d7e48a14663b553f54903b7ccb157f6e`，完整P04未验收，本轮未合并。
- 构建：`2026-10-20T09:08:00.763Z`，dirty=false，结构`0005-check-facts`。实际安装完成于`2026-10-20T09:12:31.909571Z`。
- 本轮只替换app，补卡片资料/日期/分工、原阶段里程碑、整卡进入、详情同款色块与分区，以及实际检查时间和全项目每日检查统计。没有依赖或数据库迁移。
- 上一运行版本：`250af541ced5edf14659683d65c787618e7e96bd`。较早打包的`3c8c9b6`未安装，已由本轮色块及分组补充取代。

## 2. 运行与数据核对

运行镜像为`sha256:2482982568516e4d0789bdd4459334ca2a0277cfef1948e83e1ea588346c103c`；current指向本次固定发布目录，live/ready通过。完整两库备份包含过程、事件、触发器及二进制列：

- 服务器文件：`/var/backups/geekdash/pre-p04-board-cards-cc0bc73efe0f.sql.gz`
- 大小：85,823字节；SHA256：`e2a4755268319415b5793034b61b763b763f14f5ab92b577d509b74037cf3c58`

安装前后，`geekdash_dev`和`geekdash_test`各34表的行数、NULL/HEX逐格字节、结构和迁移登记一致；MySQL容器ID与启动时间保持，其他既有容器状态保持，nginx恢复原配置。本次没有重复恢复演练。

独立运行回读及备份哈希证据：[deployment-runtime.json](../../evidence/2026-10-20-board-cards/deployment-runtime.json)。该安装时点回执里的公网核验为pending；之后已完成的公网资源、实际页面和SQL结果统一见[本轮报告第3节](../../testing/reports/2026-10-20-board-cards.md#3-发布状态与未验范围)，不能将两个时点混为一条记录。

## 3. 回退与交接

必要时只恢复上一兼容0005的应用版本`250af541`，保留当前两库；按[维护流程](../release-maintenance.md)核对当前写入、应用与健康状态。不要回灌安装前备份覆盖后来保存的信息。

本轮验证详情及完整P04未验内容见报告，接手位置见[handoff](../../handoff/handoff.md)。后续文档提交不改变本次运行镜像。
