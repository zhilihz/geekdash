# 首页层级与检查天数测试部署

## 版本与范围

- 新加坡既有独立应用，入口：https://geekdash.zhiluan.cool。
- 施工分支`codex/p04-flow-convergence`，固定产品`364c63fe16ac286e6f16df6b38b3d60ebab6200e`；clean构建`2026-10-20T10:01:39.638Z`，结构`0005-check-facts`。
- 北京时间2026-10-20 18:06:59完成应用切换，18:07:34独立回读通过。上版为cc0bc73，仅变更首页3个前端文件，无数据库迁移和依赖变动。
- main仍b96712a，完整P04未验收，本轮没有合并。

## 运行和数据

- 镜像：`sha256:1ec766506cc2539f14575768d251dec919acc17823e5904698aecbde3ddb2e6c`。
- 双库完整备份：`/var/backups/geekdash/pre-p04-card-hierarchy-364c63fe16ac.sql.gz`，85,809字节，SHA256 `abfa5120a90878dd9ba75f43e391a686fdd5e0f299a12959a230e4072852be16`。备份包含过程、事件、触发器和二进制列，摘要已独立核对。
- 两库各34表，切换前后行数、NULL/HEX单元字节、结构和迁移登记保持；MySQL ID及启动时间、119个其他已有容器状态保持，nginx原配置恢复。本次未重复恢复演练。

[运行证据](../../evidence/2026-10-20-card-hierarchy/deployment-runtime.json)记录安装及独立回读；该安装事实的publicReadback=pending是当时时点，之后公网页面结果查[报告](../../testing/reports/2026-10-20-card-hierarchy.md)。

## 回退

需要时按[维护流程](../release-maintenance.md)只恢复兼容0005的旧应用cc0bc73，保留当前两库；不要回灌旧备份覆盖后续保存。文档收口提交不会改变运行镜像。
