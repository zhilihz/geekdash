# 未完成任务交接

更新时间：2026-10-09。E03-W00～W12项目主干与最小身份已完成代码、真实MySQL/API、公网及实际app进程恢复并部署；浏览器完整联验仍有工具缺口。[系统真相31](../status/current-system-truth.md#31-e03-完整项目主干与最小身份2026-10-09)是当前事实入口，[报告](../testing/reports/2026-10-09-project-core.md)是准确验证入口。本轮不接真实备份。E04-B01本地代码与页面/真实MySQL验证见[系统真相34](../status/current-system-truth.md#34-e04-b01-阶段开始与完成2026-10-09本地验证)。

## 1. 位置、基线与授权

- D:/geekwon/geekdash；施工codex/project-core，计划49ad5a9，应用4dca725，夹具修复6aee827238912f2f202bc14ab8d0f5739af83048已合并回读远端main。文档收尾同分支合并main，接手须重新fetch/status核验最终refs及未提交文件。
- 用户DEC-090明确恢复最小登录/首次改密/会话完成E03，邀请码与完整账号后台后置；CLI/Git/test部署授权有效。不是重新开发替换原系统，也没有批准导入真实备份。
- 500为整体性能规模、不设创建硬上限；推荐方案取舍只归[决策](../decisions/decisions.md)。阶段提交、main合并与发布分别按[代码管理](../operations/release-maintenance.md#2-代码管理)。代码用ponytail full，纯文档/讨论不延续。

## 2. 运行与恢复入口

本机41860/新加坡https://geekdash.zhiluan.cool 同6aee827 / project-core /0002；两库34表/314列/55外键，无本轮迁移。MySQL本机D盘、云/var/lib/geekdash/mysql；凭据仓库外，本机和云测试账号独立。路径、五账号交付、备份及容器保持事实只归[部署](../operations/deployments/2026-10-09-project-core.md)。前两云账号已由验收改密，分发必须用currentPassword；后三仍首次改密。不能打印凭据或覆盖生成。

深模块：identity.ts校验可信actor，project-core.ts创建/本人责任，project-save.ts普通保存，projects.ts一致快照。写事务取身份→资料→项目锁序，版本/审计/账号回执原子；创建先锁账号避免共享锁升级死锁。未知项目动作沿原正文/编号确认，改密未知走正常重新认证。详细方法只归执行计划，准确协议归api/project-core.md。

新加坡现有3trial保留加本轮验收项目7，当前v4、原保存回执v3；唯一当前负责人business02。不要重置合成项目，它也可能被人工试用修改。MySQL及其他17容器未重启。最新发布没有未完成服务器写操作。忽略test-results保留私有TAT/日志，长期证据已脱敏归evidence；浏览器夹具停止、其自有项目清理。

## 3. E04-B01本轮施工与接手

- 目标：F01-A开始/F01-B完成及查询/历史/原结果恢复。分支codex/e04-b01-stage-actions，main基线f5bf84d；前置讨论6c88ea0已随f5bf84d合并回读远端main，独立1051成果保留。当前实现、实际证据与限制只引用系统真相34/阶段报告；Git与运行版本须重新核查。
- 代码位置：project-actions.ts深模块；现有projects路由/查询；detail.ts复用原renderStages卡片及样式。vite.config.ts构建时只提取原STAGES定义。新增verify-stage-actions.mjs真实隔离库检查，无迁移。src/web/shared/api.ts创建审计空beforeValues修正；原本地1051未修改。
- 已执行：阶段7组57请求；读/普通/核心/旧保存/基础回归；原卡片实际浏览器主链、日期/冲突/复制、先存普通字段、丢回执确认及已确认后GET超时恢复。截图与源摘要归evidence。浏览器脚本命令被自动审批拒绝，改用原生cua_repl完成上述范围；Edge连接不可用，独立自建IAB仅使用合成库，已关闭/清理。第一次只读检查遇到自有浏览器夹具而拒绝，清理自有夹具后已重跑通过，没有清库。
- 提交/发布：本轮代码/必要文档与新证据尚待提交；候选仍标dirty。运行41860/公网仍6aee827，固定构建/备份/服务器升级与公网回读尚待本轮交付。凭据及原始备份仍在仓库外。

接手顺序：

1. 核查Git/当前容器与源摘要；保留已有工作。按阶段提交/推送施工分支，干净固定构建；核对0001/0002摘要和真实两库结构，无迁移不得重跑初始化、重置账号或真实数据。
2. 固定测试发布只更新本项目app，先核验/完整备份两库；不重启MySQL/其他服务。用新增合成项目核验公网真实账号→开始/完成→新请求/历史/原结果，区分S2手动启动尚未实施；固定运行版本与实际app恢复分别留证。最终main合并/推送/远端回读按发布维护执行。
3. 本批按报告已验证范围收口，整个E04仍九批。[执行计划F01](../implementation/execution-plan.md#e04-f01阶段开始与完成的施工链路2026-10-09讨论计划)与[跨功能/九批](../implementation/execution-plan.md#e04跨功能一致性与施工批次2026-10-09讨论计划)为后续方法。下一B02先F08-A最小公共规则与日期依赖，再F02人工启动；不把S1完成偷换成总体自动进行中，也不把旧文字表格当迁移界面基底。
4. B03～B09按已确认规则继续；风险/节点/变更方法见14.9，TEST-038/039仅部分阶段主干实测。Q-025导入历史矛盾仍待，真实备份不接入。节点deleted_at、旧manual_delayed退出、SSE、服务器私人稿/页面状态、邀请码/后台、其他页/审查导入/输出/备份恢复依原单元实施。
5. 性能500项目四会话0错误，但本机列表P95=345ms仍未达稳定200ms；下一性能改动先实际SQL诊断。公司公网/四人真实体验及E03完整身份切换/责任页面联验保持独立未验收项，不用API通过替代。

## 4. 临时材料与清理边界

test-results里的部署脚本是本轮受控辅助材料，不作为新的发布系统；接续必须先读实际状态，不能盲重跑初始化。首次发布包装/夹具、Compose挂载与ready协议错误处理归报告GD-CORE-001～004。

不删卷、不全局prune、不操作其他项目容器。之前独立空库目录D:/geekwon/geekdash-data/fresh-save-check清理被自动审批拒绝仍保留，不能当主库；旧浏览器41861大整数地址也不是当前公网项目。原始备份与source-review始终受控且忽略。

## 5. 本轮独立本地版 V1.051

目标与范围：附件1050本地修正，用户十项及所有最新状态折叠、1049兼容；规则归SPEC-L1051。施工`codex/local-v1051`，基线`a587ecac627bd2f85591fa7823e8e209430231f3`；managed worktree为`C:/Users/Administrator/.codex/worktrees/local-v1051/geekdash`。不修改主工作区原有服务器讨论稿。

代码与本地发布包已完成，验证归[报告](../testing/reports/2026-10-09-local-v1051.md)。交付`D:/geekwon/geekdash-local-releases/GeekDash1051.zip`；源为`geekdashdesktop/`，忽略test-results只保留生成辅助/合成数据。当前本地版本没有服务器部署任务；真人首次OS文件授权仍由实际使用完成，不是代码阻塞。实现提交`2f5cf2a`、集成提交`7f5c46e35603cb78cfef878849da60d585dfce96`已推送远端main并以ls-remote回读一致。该本地单元无未完成代码或发布任务；服务器第3节接续不变。
