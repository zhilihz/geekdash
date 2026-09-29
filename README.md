# GeekDash 项目管理面板

面向公司 4 位使用者的项目管理系统。当前处于本地版核查和服务器版需求、架构设计阶段。

- 项目 GitHub 地址：<https://github.com/zhilihz/geekdash>
- Git 地址：`https://github.com/zhilihz/geekdash.git`
- 已核查的原系统：GeekDash V1.050，提交 `d40fac4a2cda429e8fc1129f9c2174d43b2fd74d`。
- 已确认目标：4 个独立管理员账号、4 人并发、常驻 MySQL、状态持久化、长期维护。
- 测试接入方式：公网连接；HTTPS 和服务端认证属于待实现的安全要求。
- 文档基线：`D0.2`，2026-09-29。设计草案不代表已经实现或验收；未变更的单篇设计文档保留 D0.1。

**仓库当前仅包含文档和诊断证据，尚不能从本仓库启动应用。** V1.050 原运行源码仍在本地核查副本中，服务器版未实现或部署。

## 从哪里开始

1. 阅读[当前系统真相](docs/current-system-truth.md)，了解已经核实的实现和缺口。
2. 阅读[需求清单](docs/requirements.md)和 [PRD](docs/PRD.md)，了解目标和使用流程。
3. 阅读[架构](docs/architecture.md)、[ERD](docs/ERD.md)和[规格书](docs/specification.md)，讨论实现边界。
4. 在[决策与待决事项](docs/decisions.md)中确认规则，再进入实施。

完整目录见[文档中心](docs/README.md)。变化记录见[更新记录](CHANGELOG.md)。

## 当前工作区与仓库边界

`source-review/` 是从用户提供的压缩包解出的原始核查副本，包含原 Git 历史及可能的业务资料，已加入忽略规则。它不等同于服务器版应用源码，不应直接整体提交。

2026-09-29 用户允许命令行操作后，Git 读取和文档推送均已成功，远程 main 提交已回读核实。首次读取时没有远程 refs 是建库前的历史状态；仓库目前已有文档提交。仓库公开/私有属性尚未核实。同步记录见[更新记录](CHANGELOG.md)，后续更新保留已有历史。
