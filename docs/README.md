# 文档中心

文档基线：D0.58；更新日期：2026-10-09。E01-F02/F03 的独立本地 MySQL、初始迁移及真实结构核验已完成，结果见[报告](testing/reports/2026-10-08-e01-f02-f03.md)。F04 应用受限连接、启动/恢复、真实就绪及关闭已实现，见[执行文档](implementation/execution-plan.md#f04-单功能操作链路2026-10-08)和[验收报告](testing/reports/2026-10-08-e01-f04.md)。分支交付流程归[代码管理](operations/release-maintenance.md#2-代码管理)，实际 refs 归系统真相。当前公网已接入项目只读看板及详情，见[项目查询验收](testing/reports/2026-10-08-project-reads.md)和[本次部署](operations/deployments/2026-10-08-project-reads.md)；trial四项保存本地验收见[保存报告](testing/reports/2026-10-09-project-save.md)及[接口](specifications/api/project-save.md)；认证、真实导入及四人业务体验待接续。未变更的单篇文档保留原版本号。

当前目标任务与六阶段计划：[GD-GOAL-001](implementation/execution-plan.md#11-目标任务详细计划先行六大阶段交付)；当前四项保存按 E03-W00～W05 执行，验收设计见 [TEST-037](testing/testing.md#test-037-当前测试项目四项保存整链未执行)。用户暂时不在期间的推荐方案选择、选项和理由统一见[明日复核汇总](decisions/decisions.md#代决汇总2026-10-08供明日复核)。计划和测试设计不代表功能已实现。

项目事实及施工准备状态以[当前系统真相](status/current-system-truth.md)为入口。原应用源码在本地核查副本；新工程已接入看板和详情的服务器读取，原六页的完整业务仍在逐单元迁移。运行命令见[本地工程运行](operations/release-maintenance.md#本地工程运行e01-f01)，结果见[验收报告](testing/reports/2026-10-08-e01-f01.md)；Git 推送与服务器部署分别记录。

项目仓库：https://github.com/zhilihz/geekdash 。全部项目文档集中于本目录；协作与文档分类规则只在根目录 [AGENTS.md](../AGENTS.md) 维护。

当前部署逐功能入口：[D01～D07](implementation/execution-plan.md#e12-d01d07首个公网基底的逐功能施工方案)，[Linux 参数与新域名流程](operations/release-maintenance.md#当前首个公网部署单元dec-071)；部署实测入口为系统真相第 26 节，运行命令归运维；未实施业务仍明确为讨论建议。

当前优先级：按 DEC-071 保持免登录，E02 全部后置增强；只读首批已上线，下一单元的测试项目共享编辑范围按 DEC-073 确认，本地已实现0002增量和四项明确保存，当前云版本见系统真相。范围归规格、施工归执行文档、实际部署事实归系统真相与部署记录。

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
