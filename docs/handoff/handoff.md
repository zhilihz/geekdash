# 未完成任务交接

更新时间：2026-10-09。E03-W00～W12项目主干与最小身份已完成代码、真实MySQL/API、公网及实际app进程恢复并部署；浏览器完整联验仍有工具缺口。[系统真相31](../status/current-system-truth.md#31-e03-完整项目主干与最小身份2026-10-09)是当前事实入口，[报告](../testing/reports/2026-10-09-project-core.md)是准确验证入口。本轮不接真实备份。

## 1. 位置、基线与授权

- D:/geekwon/geekdash；施工codex/project-core，计划49ad5a9，应用4dca725，夹具修复6aee827238912f2f202bc14ab8d0f5739af83048已合并回读远端main。文档收尾同分支合并main，接手须重新fetch/status核验最终refs及未提交文件。
- 用户DEC-090明确恢复最小登录/首次改密/会话完成E03，邀请码与完整账号后台后置；CLI/Git/test部署授权有效。不是重新开发替换原系统，也没有批准导入真实备份。
- 500为整体性能规模、不设创建硬上限；推荐方案取舍只归[决策](../decisions/decisions.md)。阶段提交、main合并与发布分别按[代码管理](../operations/release-maintenance.md#2-代码管理)。代码用ponytail full，纯文档/讨论不延续。

## 2. 运行与恢复入口

本机41860/新加坡https://geekdash.zhiluan.cool 同6aee827 / project-core /0002；两库34表/314列/55外键，无本轮迁移。MySQL本机D盘、云/var/lib/geekdash/mysql；凭据仓库外，本机和云测试账号独立。路径、五账号交付、备份及容器保持事实只归[部署](../operations/deployments/2026-10-09-project-core.md)。前两云账号已由验收改密，分发必须用currentPassword；后三仍首次改密。不能打印凭据或覆盖生成。

深模块：identity.ts校验可信actor，project-core.ts创建/本人责任，project-save.ts普通保存，projects.ts一致快照。写事务取身份→资料→项目锁序，版本/审计/账号回执原子；创建先锁账号避免共享锁升级死锁。未知项目动作沿原正文/编号确认，改密未知走正常重新认证。详细方法只归执行计划，准确协议归api/project-core.md。

新加坡现有3trial保留加本轮验收项目7，当前v4、原保存回执v3；唯一当前负责人business02。不要重置合成项目，它也可能被人工试用修改。MySQL及其他17容器未重启。最新发布没有未完成服务器写操作。忽略test-results保留私有TAT/日志，长期证据已脱敏归evidence；浏览器夹具停止、其自有项目清理。

## 3. 尚未完成与接手顺序

本轮续谈：2026-10-09，分支codex/e04-stage-planning，基线main/a587ecac627bd2f85591fa7823e8e209430231f3。F01～F08及14.9收敛为九批：B08原版子记录、B09最终联验。DEC-091～106保留；用户“都按你建议来”确认DEC-107/108节点保存后恢复/实际日期明确未知，Q-026～030均关闭。14.9按十一子记录功能展开原面板基础/事务/成功错误/回读，取舍归PROP-009～020，TEST-038/039仅设计。原GeekDash是迁移基底，问题先讲原代码逻辑、缺口、建议改动及影响/纠错，不把服务器未接入的能力当从零设计。

历史已知日期矛盾入库门槛Q-025待决；编号修正证据[PE-20261009-001](../evidence/codex-runtime-errors.md#pe-20261009-001-待决编号复用)保留。新原节点关系问题归[PE-20261009-002](../evidence/codex-runtime-errors.md#pe-20261009-002-节点双向连线残留)，仅原函数孤立复现/定位，尚未修代码。未提交共13份文档/证据：decisions/decisions.md、specifications/specification.md、implementation/execution-plan.md、data/ERD.md、testing/testing.md、changelog/CHANGELOG.md、requirements/requirements.md、product/PRD.md、usage/user-guide.md、status/current-system-truth.md、本handoff及evidence/codex-runtime-errors.md、新增evidence/2026-10-09-risk-node-source-review.json；保留此前未提交成果，没有阶段代码或数据库变更，业务测试未执行。

F08-A公共规则初始化是F02启动依赖；F03/F04历史结构化消费、F05恢复依据/检查查询、F06结案快照/恢复来源、F07日期动作/派生查询及F08检查/设置写入仍需实施。源码中的manual_delayed读取/旧标签仍存在，退出及独立兼容迁移未执行；普通写白名单仍无日期/旧标记。不能把表存在、规则确认或执行计划形成当已上线。

本轮文档静态检查通过：139个本地链接、32个锚点，DEC/PROP编号唯一，8项仍待决；14.9含13个小节/11个原版基础功能，E04九批，TEST-038/039分别12/11个验收场景。原来源文件和0001迁移摘要保持；6个实际DATE列可空、节点删除标记尚无迁移，仅静态核验。受控凭据值扫描0命中，git diff --check通过。13个未提交文件均归docs，业务代码/迁移无变更。原源码孤立函数复现与业务测试区分：前者已执行，后者未执行；运行未重启/部署，文档未提交/推送。

1. 重新核验Git/构建/ready、数据库与活动容器。保留用户修改、密码、负责名单和已登记0001/0002，不把旧交接当实时事实。
2. 浏览器工具恢复后补W11：真实页面另一账号加入/退出、退出confirm、跨标签身份切换及未保存输入隔离、公网页面联验。工具已出现CDP输入/焦点及新标签超时，既有登录/新建/保存/最后退出拒绝已观察；API完全通过不能替代尚缺页面场景。不要为避开工具超时修改产品交互。
3. E04详细方法已写入[执行计划F01](../implementation/execution-plan.md#e04-f01阶段开始与完成的施工链路2026-10-09讨论计划)、[人工启动F02](../implementation/execution-plan.md#e04-f02启动项目的施工链路2026-10-09讨论计划)、[纠错F03](../implementation/execution-plan.md#e04-f03阶段信息纠错的施工链路2026-10-09讨论计划)、[真实回退F04](../implementation/execution-plan.md#e04-f04真实返工回退的施工链路2026-10-09讨论计划)、[暂缓恢复F05](../implementation/execution-plan.md#e04-f05暂缓与恢复的施工链路2026-10-09讨论计划)、[结案重开F06](../implementation/execution-plan.md#e04-f06结案重新打开与维护标识的施工链路2026-10-09讨论计划)、[日期计划F07](../implementation/execution-plan.md#e04-f07日期计划与派生判断的施工链路2026-10-09讨论计划)及[明确检查F08](../implementation/execution-plan.md#e04-f08明确检查与共同截止的施工链路2026-10-09讨论计划)。依赖、共同链路和九批准确范围见[跨功能与批次](../implementation/execution-plan.md#e04跨功能一致性与施工批次2026-10-09讨论计划)，联验见[TEST-038](../testing/testing.md#test-038e04跨功能完整链路联验设计未执行)。原版风险/节点/变更已完成源码核对及DEC-102～108收敛，接续14.9施工；Q-026～030已关闭，不能据项目外待决Q-012增补审批或自动解除。导入旧完结的已知矛盾门槛Q-025在导入映射整块说明时确定，跨结案周期纠错仍待对应输入范围，实际日期未知清空沿DEC-108明确意图执行。若转施工，先保留/整合当前文档，从最新main实施B01阶段基础；B02先有公共规则/最小日期依赖再启动，后续逐批闭环。严格沿SPEC，不将阶段/结案/检查塞进普通PATCH，不把本轮F01～F08细化当风险/子记录或六页迁移已完成。
4. 列表容量继续保留波动问题：本机P95=228ms、云内189ms，之前云2116→218ms根因未确认；下一有性能变更时用专用500夹具和实际SQL诊断。公司公网及四人真实使用另验，不盲加Redis或归因主机。

5. 邀请码/账号维护/维护恢复、SSE、服务器私人稿/页面状态、六页、审查导入/报告、隔离恢复/定时/外部备份按原计划逐功能补齐；真实导入先具备经验证恢复，当前仍不得接入真实备份。
6. 每个明确单元按具体阶段提交，文档职责保持唯一，合并推送main并回读；固定部署后核验公网与恢复。文档推送不自动改变运行镜像。

接续施工：[14.9逐功能](../implementation/execution-plan.md#149-风险节点变更与图节点统一保存)，节点D删除/E恢复与F03-A/F06-D/F07-F未知纠错已按DEC-107/108定稿，无本阶段Q-029/030阻塞。ERD5.8计划节点原表加deleted_at、独立34/315/55，实际仍34/314/55；先兼容增量及有效过滤，再开放删除/恢复，旧构建缺过滤不能直接回退。日期复用NULL、状态保持、结案结果待核对，不能套到节点完成日或伪造操作时间。原source及合成复现[证据](../evidence/2026-10-09-risk-node-source-review.json)保持。下一从最新main按B01单功能实施，保留当前未提交文档；跨周期历史更正/导入矛盾/项目外权限归后续输入阶段，个人稿终态及其他对象恢复仍待Q-017，不能把节点恢复扩大成全局删除系统。

## 4. 临时材料与清理边界

test-results里的部署脚本是本轮受控辅助材料，不作为新的发布系统；接续必须先读实际状态，不能盲重跑初始化。首次发布包装/夹具、Compose挂载与ready协议错误处理归报告GD-CORE-001～004。

不删卷、不全局prune、不操作其他项目容器。之前独立空库目录D:/geekwon/geekdash-data/fresh-save-check清理被自动审批拒绝仍保留，不能当主库；旧浏览器41861大整数地址也不是当前公网项目。原始备份与source-review始终受控且忽略。
