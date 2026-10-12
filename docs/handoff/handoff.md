# 未完成任务交接

更新时间：2026-10-12。E03项目主干与最小身份、E04-B01～B08已固定部署，完整公网浏览器与公司实际使用仍未验收。[系统真相](../status/current-system-truth.md#46-e04-b08需求变更ab固定部署2026-10-12)为当前能力入口，详细验证归各批报告。本轮不接真实备份。

## 0. 当前活动：继续E04，再逐阶段完整规划/实施/提交

用户DEC-109授权离开期间持续施工，范围不限E04：规划完整阶段→实施/验收→提交合并远端main→下一阶段，当前E04仍未完成。方法归[GD-GOAL-001](../implementation/execution-plan.md#11-目标任务详细计划先行六大阶段交付)，代决只归[autonomous-decisions](../decisions/autonomous-decisions.md)；先核对1051及已确认SPEC，缺口推荐选择记录理由/选项/影响。工具目标保持E04 active，不能将B07完成称整个E04完成。

当前main含实现29ed3d9，codex/e04-b08-project-changes同实现；计划22d6d8a/14.9.18和AD-019先行。需求变更A/B完成具名提交、远端main回读、干净固定构建/两端部署及公网原结果/实际app恢复，详见[真相46](../status/current-system-truth.md#46-e04-b08需求变更ab固定部署2026-10-12)、[报告](../testing/reports/2026-10-12-project-changes.md)与[部署](../operations/deployments/2026-10-12-project-changes.md)。本记录随发布收尾具名提交；接手重新核对最终refs，文档SHA不是运行镜像。

两端实际运行29ed3d9/project-changes/0003。公网合成项目18/v8、4需求/1风险/1节点/14审计，两原会话及9原结果保存在D:/geekwon/geekdash-data/secrets/changes-public-sessions.json；原项目16/17四会话/25结果保持。只读核对先用原编号正文，不重造命令、初始化或改密；本批install已SUCCESS且release存在，禁止盲重跑。

当前codex/e04-b09-list-performance从main/611ea1e施工。B09基线和工具8ee8baf已合并回读；候选14.9.20.1/AD-022保留原分页、原关联与类型，只合并11选项查询。旧固定29ed3d9实际模块52组全JSON、四人保存新读、本机9条命令/169整链及正常500三轮/完整混合通过，准确范围归[真相48](../status/current-system-truth.md#48-e04-b09选项读取候选2026-10-12)/[B09报告](../testing/reports/2026-10-12-e04-b09.md)。本记录待具名提交，接手重核refs；运行仍29ed3d9。

下一步：先本记录/候选具名提交main并干净固定构建；固定等价/整链及两库verify，精确发布包含18个原/新验证脚本，云普通三轮/混合一轮与原公共项目/会话/原结果回读，实际app恢复。部署前只读list-preflight已通过，尚未发送部署TAT；test-results/list-*是本批待执行辅助，不能盲重跑旧changes/b09-cloud。Node未见溢出，只处理自己产生的工具。

原生本轮inventory仍Edge fetch失败，AD-007 URL策略限制保留；不能换表面/脚本绕过，也不以API替代。完整原生联验完成前E04继续active，完成后才进入下一阶段完整规划→实施→main循环。

新完整两库备份/指纹/回退入口归本批部署；长云SQL只用/run/secrets/mysql_health，不共享健康cp临时目标。原0003兼容历史及PE-011/002仍可查询旧报告。真实备份不接、隔离恢复/外部副本未验。Node未见溢出，自有/tmp/geekdash-changes-root.cnf已删除；未全局kill/prune/删卷，云MySQL及其他17容器未重启，无未完成TAT写任务。

专项仍必须从实际固定镜像导出两个不同fallbackDir：node-recovery-fallback对应2dfb17c，changes-fallback对应2a342d6；分别传GEEKDASH_NODE_RECOVERY_FALLBACK_DIR/GEEKDASH_CHANGES_FALLBACK_DIR，不能把同一旧产物误充两种兼容证明。本机test-results和云本批verification-results均已有实际导出，接手先读build-info核验。

B08风险私有install已成功结束，目标5ae7ecc目录已存在、旧预期4974e0f，不盲重跑。公网合成项目15/v11、3风险/13历史及2原会话/12原结果受控保存，原项目7～14保持；准确产物/备份/恢复归[风险部署](../operations/deployments/2026-10-10-project-risks.md)。没有迁移；云13项验证/混合容量及实际app恢复通过，云列表2843ms仍需B09实际SQL定位。验证工具256MiB/旧堆96MiB结束正常，本项目未发现Node溢出，未全局杀进程/删卷。

B07私有install目标4974目录已存在、旧预期21cdfb4，禁止盲重跑；所有TAT写任务已成功结束。公网项目14/v17及3原会话/21原结果受控存于仓库外，原项目7～13保持；完整数据/备份及恢复入口只归检查部署。验证工具256MiB/旧堆96MiB验收通过，本机/云结束RSS约222MiB，不改常驻配置，不并行在同一测试库跑夹具。Node采样无溢出，仅自有临时工具正常退出，未全局终止或删卷/prune。

固定首次有一次未复现毫秒边界失败，原失败SQL未捕获；五轮与增强本机/云端9组251 HTTP通过，PE-20261010-004/AD-011保留待排查，不能称修复。阶段包广泛替换漏旧结案测试已在安装前修复，12项包清单/哈希及云回归通过，PE-20261010-005记录。云带检查历史列表P95=295ms高于200ms；原生页面既有CUA URL协议明确拒绝、Edge fetch失败，不换表面/脚本绕过，B09原生联验未执行。真实备份仍不导入。

## 1. 位置、基线与授权

- D:/geekwon/geekdash；当前分支/基线见第0节；常驻B08需求变更固定29ed3d9。后续文档SHA不是运行镜像，E03/B01～B03历史归系统真相31/34/35/36。
- 用户DEC-090明确恢复最小登录/首次改密/会话完成E03，邀请码与完整账号后台后置；CLI/Git/test部署授权有效。不是重新开发替换原系统，也没有批准导入真实备份。
- 500为整体性能规模、不设创建硬上限；推荐方案取舍只归[决策](../decisions/decisions.md)。阶段提交、main合并与发布分别按[代码管理](../operations/release-maintenance.md#2-代码管理)。代码用ponytail full，纯文档/讨论不延续。

## 2. 运行与恢复入口

本机41860/新加坡https://geekdash.zhiluan.cool同29ed3d9 / project-changes /0003；两库34表/315列/55外键，三迁移历史保持。本批准确产物/备份/恢复归需求变更部署。MySQL本机D盘、云/var/lib/geekdash/mysql；凭据仓库外，两端账号独立，不能重置或打印凭据。云business01/02及maint01已改密，分发使用currentPassword，business03/04仍需首次改密。

深模块：identity.ts校验可信actor，project-core.ts创建/本人责任，project-save.ts普通保存，project-actions.ts阶段命令，projects.ts一致快照。事务、结果恢复方法只归执行计划；实际协议归api/project-core.md与api/project-actions.md。

新加坡原trial及项目7/8/9保持，周五规则已初始化；B03新合成项目10当前v15/进行中/S1待开始/进度0%、business01/02负责，工期评述/计划/首次义务保持。真实app重启后原会话/详情/15条历史/11个动作原回执新读保持。不要重置试用项目，复核先新读。云MySQL及其他17容器未重启，无未完成服务器写操作。忽略test-results保留私有TAT/日志，长期证据归evidence。

B04新合成项目11当前v13/提案/S1待开始/0%，business01/02负责，当前计划已知、原始未知；13条历史和11个原动作结果在实际app重启后保持。原项目不动，没有未完成云命令。日期深模块新增project-plans.ts，有限命令与投影复用原事务/回执；verify-project-dates.mjs真实隔离验证。B04私有dates-install/public/restart脚本只作受控辅助材料，接手先读取当前事实。

B05新合成公网项目12当前v17/进行中/S2进行中，当前计划+15天、原始+10天，原首次应检依据保持；暂停中最新普通字段和S2实际日期纠错保持，未制造检查。project-lifecycle.ts处理暂缓/恢复/说明投影，project-checks.ts最小只读查询，verify-project-pause.mjs隔离库真实验证。public/restart原会话与14个原动作结果受控存于仓库外，不能打印凭据或重复生成新编号。B05部署辅助脚本在忽略test-results，接手先读取实际状态，不能盲重跑install（旧预期a7d281d）。

B06新合成公网项目13及原动作/原会话受控材料见结案部署；project-closures.ts封装当前结案来源与候选，不加表。原before/after快照和回执不可改写；当前结案来源由currentClosure.auditId核对，历史分页保留多次周期。B07按F08接续，不能把闭案主动检查自动执行。

## 3. E04-B01历史上下文

- 目标：F01-A开始/F01-B完成及查询/历史/原结果恢复。分支codex/e04-b01-stage-actions，main基线f5bf84d；前置讨论6c88ea0已随f5bf84d合并回读远端main，独立1051成果保留。当前实现、实际证据与限制只引用系统真相34/阶段报告；Git与运行版本须重新核查。
- 代码位置：project-actions.ts深模块；现有projects路由/查询；detail.ts复用原renderStages卡片及样式。vite.config.ts构建时只提取原STAGES定义。新增verify-stage-actions.mjs真实隔离库检查，无迁移。src/web/shared/api.ts创建审计空beforeValues修正；原本地1051未修改。
- 已执行：阶段7组57请求；读/普通/核心/旧保存/基础回归；原卡片实际浏览器主链、日期/冲突/复制、先存普通字段、丢回执确认及已确认后GET超时恢复。截图与源摘要归evidence。浏览器脚本命令被自动审批拒绝，改用原生cua_repl完成上述范围；Edge连接不可用，独立自建IAB仅使用合成库，已关闭/清理。第一次只读检查遇到自有浏览器夹具而拒绝，清理自有夹具后已重跑通过，没有清库。
- 提交/发布：实现0d72575、换行规范检查点ab37851及保留远端1051追加的固定集成3ec251d已推送并合并回读main。运行41860/公网同干净3ec251d；云内六类回归、公网保存/原结果/历史、实际app恢复和13项资源摘要均完成。首次服务器指纹解码失败已恢复并按停点接续，无未完成远程写任务。凭据及原始备份仍在仓库外。本交接随同分支文档收尾提交，接手重新核对最终refs；不将后续文档SHA当运行镜像。

下列为B01收口时历史接手顺序；当前入口及下一动作以第0节为准：

1. 核查Git/当前容器、干净构建3ec251d及源摘要；本批已完成代码/固定测试部署/main交付，保留后续已有工作。两库仍0001/0002，无迁移不得重跑初始化、改密或覆盖业务。
2. 本批公网项目8及进程恢复证据归阶段部署，原项目7保持；复核时先读取当前版本，不能盲重放新动作。合成试用尚未接真实备份，公网浏览器完整联验和公司四人体验仍未完成。
3. 本批按报告已验证范围收口，整个E04仍九批。[执行计划F01](../implementation/execution-plan.md#e04-f01阶段开始与完成的施工链路2026-10-09讨论计划)与[跨功能/九批](../implementation/execution-plan.md#e04跨功能一致性与施工批次2026-10-09讨论计划)为后续方法。下一B02先F08-A最小公共规则与日期依赖，再F02人工启动；不把S1完成偷换成总体自动进行中，也不把旧文字表格当迁移界面基底。
4. B03～B09按已确认规则继续；风险/节点/变更方法见14.9，TEST-038/039仅部分阶段主干实测。Q-025导入历史矛盾仍待，真实备份不接入。节点deleted_at、旧manual_delayed退出、SSE、服务器私人稿/页面状态、邀请码/后台、其他页/审查导入/输出/备份恢复依原单元实施。
5. 性能500项目四会话0错误，但本机列表P95=345ms、云内1862ms仍未达稳定200ms；下一性能改动先实际SQL诊断。公司公网/四人真实体验及E03完整身份切换/责任页面联验保持独立未验收项，不用API通过替代。

## 4. 临时材料与清理边界

test-results里的部署脚本是本轮受控辅助材料，不作为新的发布系统；接续必须先读实际状态，不能盲重跑初始化。首次发布包装/夹具、Compose挂载与ready协议错误处理归报告GD-CORE-001～004。

不删卷、不全局prune、不操作其他项目容器。之前独立空库目录D:/geekwon/geekdash-data/fresh-save-check清理被自动审批拒绝仍保留，不能当主库；旧浏览器41861大整数地址也不是当前公网项目。原始备份与source-review始终受控且忽略。

## 5. 本轮独立本地版 V1.051

目标与范围：附件1050本地修正，用户十项及所有最新状态折叠、1049兼容；规则归SPEC-L1051。施工`codex/local-v1051`，基线`a587ecac627bd2f85591fa7823e8e209430231f3`；managed worktree为`C:/Users/Administrator/.codex/worktrees/local-v1051/geekdash`。不修改主工作区原有服务器讨论稿。

代码与本地发布包已完成，验证归[报告](../testing/reports/2026-10-09-local-v1051.md)。交付`D:/geekwon/geekdash-local-releases/GeekDash1051.zip`；源为`geekdashdesktop/`，忽略test-results只保留生成辅助/合成数据。当前本地版本没有服务器部署任务；真人首次OS文件授权仍由实际使用完成，不是代码阻塞。实现提交`2f5cf2a`、集成提交`7f5c46e35603cb78cfef878849da60d585dfce96`已推送远端main并以ls-remote回读一致。该本地单元无未完成代码或发布任务；服务器第3节接续不变。

### 5.1 1051追加修正

用户明确三项追加修正及保持1051，分支codex/local-v1051-followup，基线eddee0a00993d995fe6e6f4cd06b499c5372a34c。同一工作副本施工，原主工作区未提交文档保留。代码/测试及发布包更新完成，证据归追加报告，原ZIP已留首次交付副本。实现f6ae99a及集成88632871c690ff384d55fbe194cd57082287eecb已回读远端main一致，本地追加单元完成，无云部署任务。

### 5.2 结案入口与专区补充

用户新增两项：去掉外部风险/变更独立专区，基本信息直接结案100%、阶段中途结案按当时进度。仍1051，同工作副本codex/local-close-progress，从最新main/5c8cdd1施工；代码、文档及本地包更新完成，验证归[本轮报告](../testing/reports/2026-10-09-local-v1051-closure.md)。全部专项/原13项/1049、1050、首次1051兼容已执行通过。实现c5fa2f6、集成a582893c956f97444a9aa5a9709cf9851112e00a已推送并回读远端main，10月9日自有41870验证服务已关闭；该单元完成。临时合成材料在忽略test-results，不使用服务器部署脚本。

### 5.3 直接HTML与原数据库恢复

2026-10-10用户要求首次选择后记原文件、本地HTML不依赖启动脚本，保持1051。分支codex/local-startup，从最新main/af5de712beccdb0da2726a400b7063c5a90d8393施工；同工作副本，保留服务器已有工作。代码已完成，真实Windows磁盘file://五组、原13项及旧文件兼容通过；准确范围和产物入口归[启动报告](../testing/reports/2026-10-10-local-v1051-startup.md)。交付包已替换且源码/目录/ZIP逐字节一致；实现53412ab、集成7d6d832350d9aa7f5847c36a6800a2758c73f1b3已推送并回读远端main，自有41870验证服务已停止。该本地单元无剩余任务；首次OS选择/授权由使用者完成，不作为代码阻塞。用户最后明确卡片有简介即可，详情备注不展示。本轮没有云部署，服务器活动项继续保持独立。

### 5.4 独立发布1052、保留1051

分支codex/local-v1052，从最新main/b172df95de2dc3cc5fd2fa501ee4ad85771ef860开始。用户确认1052更新记录只列启动读取与HTML运行，1051既有功能保留。新包/目录和版本/真实磁盘验证已完成，1051 ZIP及9个解压文件摘要保持；证据归[1052报告](../testing/reports/2026-10-10-local-v1052.md)。实现26ca944与集成df5a7851abf48240a1994cc90d48729418bbcf22已推送并回读远端main，合并后源/包与1051保留复核通过。该单元无未完成任务；没有新增服务或云部署，服务器活动项独立保留。
