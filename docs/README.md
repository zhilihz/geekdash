E04-B08风险A～D固定部署及未完成范围：[风险报告](testing/reports/2026-10-10-project-risks.md)、[系统真相41](status/current-system-truth.md#41-e04-b08风险ad2026-10-10固定部署)；整包落位见[八步计划](implementation/execution-plan.md#14914-b08整包施工落位与验收顺序2026-10-10)。运行已固定5ae7ecc，结果与恢复归[风险部署](operations/deployments/2026-10-10-project-risks.md)；节点/0003/变更继续施工。

# GeekDash 文档目录

E04-B07检查代码与真实验证：[检查报告](testing/reports/2026-10-10-project-checks.md)、[系统真相40](status/current-system-truth.md#40-e04-b07检查与共同截止2026-10-10固定部署)。固定4974e0f已合并main并部署，本机/云内/公网/真实app恢复结果归[检查部署](operations/deployments/2026-10-10-project-checks.md)；原生页面保持B09待验。

E04-B06固定结案链路与验证：[结案报告](testing/reports/2026-10-10-project-close.md)、[系统真相39](status/current-system-truth.md#39-e04-b06结案链路2026-10-10固定部署)。固定部署与公网结果归[结案部署](operations/deployments/2026-10-10-project-close.md)，原生页面保持B09待验。

E04-B05固定代码及真实验证：[暂缓报告](testing/reports/2026-10-10-project-pause.md)、[动作协议](specifications/api/project-actions.md)和[系统真相38](status/current-system-truth.md#38-e04-b05暂缓恢复2026-10-10固定部署)。暂缓/恢复与最小查询已部署，检查写入仍B07，原生页面联验仍B09；实际运行版本须核对系统真相。

E04-B04日期/计划的实际代码协议归[项目动作](specifications/api/project-actions.md)与[读取](specifications/api/projects-read.md)，验收归[日期报告](testing/reports/2026-10-10-project-dates.md)，运行与恢复归[日期部署](operations/deployments/2026-10-10-project-dates.md)。整个E04及原生页面联验仍进行中；当前状态以系统真相41为准。

文档基线：D0.69；更新日期：2026-10-10。当前能力以[系统真相](status/current-system-truth.md)为唯一入口；阶段方法见[执行文档](implementation/execution-plan.md)，Git与测试实例分别按[代码管理](operations/release-maintenance.md#2-代码管理)和实际部署记录核对。

当前目标任务与六阶段计划：[GD-GOAL-001](implementation/execution-plan.md#11-目标任务详细计划先行六大阶段交付)；E03项目主干已实现并部署，E04-B01～B07已固定部署，继续剩余批次。用户离开期间按完整阶段规划→实施→验收→提交合并main循环，范围不限E04；本次推荐选择与理由见[代决记录](decisions/autonomous-decisions.md)，原2026-10-08汇总保留历史。计划和测试设计不代表功能已实现。

项目事实及施工准备状态以[当前系统真相](status/current-system-truth.md)为入口。原应用源码在本地核查副本；新工程已接入看板和详情的服务器读取，原六页的完整业务仍在逐单元迁移。运行命令见[本地工程运行](operations/release-maintenance.md#本地工程运行e01-f01)，结果见[验收报告](testing/reports/2026-10-08-e01-f01.md)；Git 推送与服务器部署分别记录。

项目仓库：https://github.com/zhilihz/geekdash 。全部项目文档集中于本目录；协作与文档分类规则只在根目录 [AGENTS.md](../AGENTS.md) 维护。

当前部署逐功能入口：[D01～D07](implementation/execution-plan.md#e12-d01d07首个公网基底的逐功能施工方案)，[Linux 参数与新域名流程](operations/release-maintenance.md#当前首个公网部署单元dec-071)；部署实测入口为系统真相第 26 节，运行命令归运维；未实施业务仍明确为讨论建议。

当前优先级：E03创建/本人负责/实名普通保存已接通，邀请码和完整账号后台后置；E04继续B08子记录及B09联验。[项目主干部署](operations/deployments/2026-10-09-project-core.md)记录E03发布，当前固定构建见[B07检查部署](operations/deployments/2026-10-10-project-checks.md)，准确能力及未验收范围见[系统真相40](status/current-system-truth.md#40-e04-b07检查与共同截止2026-10-10固定部署)。范围归规格、施工归执行文档、实际部署事实归系统真相与部署记录。

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

## 独立本地版 V1.051

本轮用户指定的1050修正版位于`geekdashdesktop/`，入口与MySQL版分开。需求见REQ-L1051，规则见[SPEC-L1051](specifications/specification.md#spec-l1051-本地版修正契约)，运行及1049/1050旧数据路径见[使用说明](usage/user-guide.md#本地-v1052-运行与旧版数据升级)，准确验收见[报告](testing/reports/2026-10-09-local-v1051.md)。发布包不包含用户业务数据库。

阶段开始/完成的实际协议见[项目动作API](specifications/api/project-actions.md)，本轮验证入口见[阶段报告](testing/reports/2026-10-09-stage-actions.md)。运行状态仍查系统真相。

1051本日补充修正（负责人名称、@新姓名不自动入库、卡片隐藏市场预期）准确验证见[追加报告](testing/reports/2026-10-09-local-v1051-followup.md)，版本按用户指令保持1051。
