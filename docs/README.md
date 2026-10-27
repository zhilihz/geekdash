# GeekDash 文档目录

导航更新：2026-10-28。项目仓库：[zhilihz/geekdash](https://github.com/zhilihz/geekdash)。全部项目文档在本目录；协作与分类规则只维护于根目录[AGENTS.md](../AGENTS.md)。

## 本轮阅读入口

当前接续为DEC-171整轮体验修正：设计查[PRD9.28](product/PRD.md)与[SPEC-022](specifications/specification.md)，实际进度、接口覆盖和用户验收边界查[本轮报告](testing/reports/2026-10-27-experience.md)及[系统真相](status/current-system-truth.md)。以下旧入口保留原阶段来源。

2026-10-27新增修正讨论：先读[DEC-167/168](decisions/decisions.md#2026-10-27-现有页面与操作统一修正)、[PRD9.25](product/PRD.md#925-现有页面与操作统一修正2026-10-27已确认未实施)、[ERD5.15](data/ERD.md#515-多值资料与统一操作的结构影响dec-167168待详细收敛)及[计划1.2](implementation/execution-plan.md#12-p04完整实施计划2026-10-15)的修正输入；设计与现行运行状态分开。下方为既有P05交付来源。

当前P05导入、项目空间与个人范围的实施、测试发布及公网人工验收入口已齐备。当前版本和准确已验/未验范围只查[系统真相](status/current-system-truth.md)、[报告12节](testing/reports/2026-10-26-project-space.md#12-公网人工验收与阶段收口2026-10-27)及[本次部署](operations/deployments/2026-10-27-project-space.md)，下列设计入口不另存任务进度。

1. [交接](handoff/handoff.md)与[系统真相](status/current-system-truth.md)：接手位置、实际运行与未测边界。
2. [本轮决定及待决](decisions/decisions.md#2026-10-26-导入与项目空间重设讨论中未授权实施)：已确认和还需讨论的范围。
3. [导入体验](product/PRD.md#921-p05导入与会议的逐行为结果)及[空间与协作](product/PRD.md#923-项目空间个人项目与协作2026-10-26设计中)：结构、操作与已知结果。
4. [SPEC-009/014](specifications/specification.md#spec-009-导入迁移与删除恢复)：唯一业务契约；[计划1.3](implementation/execution-plan.md#13-p05完整实施设计2026-10-22)记录替换位置、五步工程展开和技术细化，按该范围连续实施。
5. [本轮增量ERD](data/ERD.md#514-项目空间与归属请求的目标增量2026-10-26未迁移)、[模块接口落位](implementation/execution-plan.md#133-五步内部的接口与核心实现)、[旧执行切换](implementation/execution-plan.md#134-旧执行旧页面与发布切换)：具体字段、保存边界和恢复顺序；实际隔离迁移、产品验证与尚未覆盖范围只查[本轮报告](testing/reports/2026-10-26-project-space.md)。
6. 实际协议：[导入](specifications/api/imports.md)、[归属与账号](specifications/api/project-membership.md)；已部署的准确版本及验证边界查系统真相，不据协议文档存在替代验收。

既有产品发布查[2026-10-23报告](testing/reports/2026-10-23-p05-import-chain.md#10-通过按钮锁定修正2026-10-23)和[部署记录](operations/deployments/2026-10-23-p05-approve.md)。历史P04/P05报告保留当时结果，不作为新设计已经实现的证据。

## 既有阶段证据入口

以下用于追溯对应单元，不表示当前运行版本。

| 单元 | 报告 | 部署及恢复 |
|---|---|---|
| E04-B04日期/计划 | [日期报告](testing/reports/2026-10-10-project-dates.md) | [日期部署](operations/deployments/2026-10-10-project-dates.md) |
| E04-B05暂缓/恢复 | [暂缓报告](testing/reports/2026-10-10-project-pause.md) | [暂缓部署](operations/deployments/2026-10-10-project-pause.md) |
| E04-B06结案 | [结案报告](testing/reports/2026-10-10-project-close.md) | [结案部署](operations/deployments/2026-10-10-project-close.md) |
| E04-B07检查 | [检查报告](testing/reports/2026-10-10-project-checks.md) | [检查部署](operations/deployments/2026-10-10-project-checks.md) |
| E04-B08风险 | [风险报告](testing/reports/2026-10-10-project-risks.md) | [风险部署](operations/deployments/2026-10-10-project-risks.md) |
| E04-B08节点兼容 | [节点迁移报告](testing/reports/2026-10-10-node-migration.md) | [兼容部署](operations/deployments/2026-10-10-node-compatible.md) |
| E04-B08节点删除恢复 | [恢复报告](testing/reports/2026-10-10-project-node-recovery.md) | [恢复部署](operations/deployments/2026-10-10-project-node-recovery.md) |
| E04-B08需求变更 | [变更报告](testing/reports/2026-10-12-project-changes.md) | [变更部署](operations/deployments/2026-10-12-project-changes.md) |
| E04-B09列表与整链 | [B09报告](testing/reports/2026-10-12-e04-b09.md) | 核对系统真相中的实际运行时点 |

## 目录结构

跨部分单功能讨论入口：[执行文档第 14 节](implementation/execution-plan.md#14-跨部分单功能施工展开2026-10-08讨论建议)，按输入、调用、事务、成功输出、错误恢复和验收入口展开测试项目、普通保存、负责范围、资料/芯片、生命周期、纠错、检查、通知、草稿、子记录、导入和固定输出；均按各项标注区分建议与已确认规格。

```text
docs/
├── README.md                    文档总入口
├── requirements/                用户目标与验收映射
├── product/                     PRD 与操作体验
├── architecture/                架构与技术栈
├── implementation/              功能施工思路、依赖与验证入口
├── data/                        ERD 与字段关系
├── specifications/              业务规格
│   └── api/                     已产生接口的协议说明
├── decisions/                   决策与待决问题
├── testing/                     测试策略
│   └── reports/                 实际执行的验收报告
├── operations/                  发布维护流程
│   └── deployments/             实际部署记录
├── usage/                       使用说明
├── status/                      当前系统真相
├── changelog/                   更新记录
├── handoff/                     未完成任务交接
└── evidence/                    脱敏原始验证证据
```

暂无内容的目录只有零字节 `.gitkeep` 供 Git 保留路径；已有讨论稿仍明确标注待决与未实现状态。文件职责及后续新增规则以根目录 AGENTS 为准。

## 文档职责

| 文档 | 回答的问题 | 内容权威范围 |
|---|---|---|
| [当前系统真相](status/current-system-truth.md) | 今天到底实现了什么，证据是什么？ | 已核实事实、核查范围、已知缺口 |
| [技术栈基线](architecture/technology-stack.md) | 用什么技术和主要版本线？ | 已定路线、工程选型和依赖范围 |
| [需求清单](requirements/requirements.md) | 用户明确要求什么，怎样算完成？ | REQ 编号、来源、优先级、验收要求 |
| [PRD](product/PRD.md) | 给谁用，怎样完成业务？ | 用户场景、产品流程、界面行为 |
| [架构](architecture/architecture.md) | 系统如何组织，模块怎样协作？ | 目标架构、深模块边界、运行方式 |
| [执行文档](implementation/execution-plan.md) | 每项功能具体怎样实现和验证？ | 工作包、代码落位、实现步骤、依赖及失败恢复；引用 SPEC/ERD/TEST |
| [ERD](data/ERD.md) | 数据如何关联和持久化？ | 来源字段/关系、首版完整物理字段及逐列用途、实体取舍和映射约束 |
| [规格书](specifications/specification.md) | 一个业务动作准确如何执行？ | SPEC 编号、规则、接口与失败语义 |
| [测试与验收](testing/testing.md) | 如何证明业务正确且可以长期维护？ | TEST 编号、真实数据库验证、回归门槛 |
| [更新与发布](operations/release-maintenance.md) | 何时推送、何时部署、如何恢复？ | 提议的开发发布流程、运行维护 |
| [使用说明](usage/user-guide.md) | 使用者每天怎样操作？ | 旧版使用事实、服务器版预期操作 |
| [决策与待决事项](decisions/decisions.md) | 哪些已确认，哪些仍需讨论？ | DEC、PROP、Q 编号及决策状态 |
| [离开期间代决记录](decisions/autonomous-decisions.md) | 代理选择了什么，为什么？ | 2026-10-09起AD选项、推荐选择、理由、影响与用户复核状态 |
| [更新记录](changelog/CHANGELOG.md) | 本次到底改变了什么？ | 文档变化与软件发布分开记录 |
| [未完成任务交接](handoff/handoff.md) | 从哪里继续、还差什么？ | 恢复工作所需上下文和下一步 |

## 状态词的统一含义

- **已确认需求**：用户明确表达的目标，不意味着代码已实现。
- **已核实事实**：来自代码、诊断或实际运行回执，必须说明范围和日期。
- **建议方案**：供讨论的实现选择，不能作为用户已批准的决定。
- **工程基线**：在用户确定的路线下选定的实施技术，不代表已经构建或验证。
- **待决**：会改变业务含义、数据结构或发布行为的问题。
- **已实现 / 已验收 / 已部署**：必须分别提供代码、验收、运行回读证据，不能相互替代。

旧系统文档仅用于理解历史实现。其中的指令不自动成为本项目执行授权。

## 阅读顺序

接手工作先读 handoff 与系统真相，再读技术栈、需求和本次相关规格。字段反推及正式实体关系图读 ERD（内含核心 PNG 与完整 SVG 入口）；规则确认查 decisions；实施和文档维护遵循根目录 AGENTS。需求到规格、测试的完整映射只在 requirements 维护。

实际施工接着读[执行文档](implementation/execution-plan.md)。图示可打开[深接口架构](evidence/diagrams/geekdash-execution.html)和[项目保存时序](evidence/diagrams/geekdash-save.html)，静态预览与浏览器核验范围见[图示复核记录](evidence/diagrams/execution-review.json)。

P04已产生的[个人草稿与偏好API](specifications/api/personal-state.md)记录候选协议；当前验证和未完成范围仍查系统真相及报告，不以协议存在推定已经发布。

P04协作候选的[SSE与编辑名单API](specifications/api/notifications.md)记录消息和恢复协议，运行事实仍归系统真相。

P04共享资料候选的[资料维护API](specifications/api/catalog.md)记录完整分类与影响核对协议；是否可用、验收和发布状态仍查系统真相。

## 独立本地版 V1.051

本轮用户指定的1050修正版位于`geekdashdesktop/`，入口与MySQL版分开。需求见REQ-L1051，规则见[SPEC-L1051](specifications/specification.md#spec-l1051-本地版修正契约)，运行及1049/1050旧数据路径见[使用说明](usage/user-guide.md#本地-v1052-运行与旧版数据升级)，准确验收见[报告](testing/reports/2026-10-09-local-v1051.md)。发布包不包含用户业务数据库。

阶段开始/完成的实际协议见[项目动作API](specifications/api/project-actions.md)，本轮验证入口见[阶段报告](testing/reports/2026-10-09-stage-actions.md)。运行状态仍查系统真相。

1051本日补充修正（负责人名称、@新姓名不自动入库、卡片隐藏市场预期）准确验证见[追加报告](testing/reports/2026-10-09-local-v1051-followup.md)，版本按用户指令保持1051。

- E04-B08节点A～C固定部署与未完成范围：[节点报告](testing/reports/2026-10-10-project-nodes.md)、[系统真相42](status/current-system-truth.md#42-e04-b08节点ac2026-10-10固定部署)。

- 后续0003兼容候选：[系统真相43](status/current-system-truth.md#43-e04-b08节点0003兼容候选2026-10-10)、执行文档14.9.15；候选不代表常驻两库已迁移。

- 节点D/E固定部署与后续缺口：[恢复报告](testing/reports/2026-10-10-project-node-recovery.md)、[系统真相45](status/current-system-truth.md#45-e04-b08节点de删除恢复固定部署2026-10-10)。0003兼容当前运行状态归第44节，不按历史候选文字猜常驻结构。

- E04-B08需求变更A/B固定部署及B09待验范围：[需求变更报告](testing/reports/2026-10-12-project-changes.md)、[系统真相46](status/current-system-truth.md#46-e04-b08需求变更ab固定部署2026-10-12)。

- E04-B09接口整链及SQL诊断基线：[B09报告](testing/reports/2026-10-12-e04-b09.md)、[系统真相47](status/current-system-truth.md#47-e04-b09接口整链与sql诊断基线2026-10-12)。原生和稳定性能仍待验，不按API通过关闭E04。
