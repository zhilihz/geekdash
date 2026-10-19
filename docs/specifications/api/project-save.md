# 项目普通保存 API

日期：2026-10-09；原普通编辑版本31012c8，本轮 E03-W09～W12 在相同协议上接入实名授权，结构仍0002-trial-save。身份请求头与新增入口见[项目主干 API](project-core.md)，实际构建版本见系统真相。行为唯一归 [SPEC-002](../specification.md#spec-002-保存事务并发与审计)；全部响应 Cache-Control: no-store，大整数均为十进制字符串。新写入要求已改密的真实账号及本人负责关系；匿名历史和旧 trial 回执只保留原来源及只读确认。

## PATCH /api/projects/:id

P04-02本地候选（f07450e基线+本轮改动，未部署）在原文字字段之外接受独立summary；缺省不写、空串明确清空，旧summaryNote不移动或覆盖。沿用原事务、版本和回执，旧请求摘要保持兼容；本补充不表示P04分区保存协议已实现。

输入示例：

```json
{"expectedVersion":"1","idempotencyKey":"089dd49e-343f-4464-bdca-32c74a1a9b94","changes":{"name":"合成测试项目","summaryNote":"明确保存后生效"}}
```

id/expectedVersion 范围为1至UINT64_MAX；操作编号为小写 UUID v4。同编号重试需沿用同版本和同内容。changes 非空，白名单如下；名称规则与字段容量见规格。不接受客户端身份、dataKind、生命周期、日期或责任字段。

| 字段 | JSON 类型/编码 |
|---|---|
| name/marketExpectation/detailNote/summaryNote/summary/statusDesc/signalNote/chipstatNote | 字符串；说明可明确空字符串；summary为上述P04候选新增 |
| signal | green/yellow/red |
| priority | high/mid/low |
| customerId/odmCustomerId/productLineId/appId/groupId | 十进制 ID 字符串或 null |
| chipIds/tagIds | 有序、无重复的 ID 字符串数组，[] 清除 |
| people | 有序 {id,role} 数组；role 为 pm/hardware_owner/software_owner/participant，同 ID/role 不重复 |
| stagePlans | E04-B03：1～7个不同阶段的 {code,plannedDays?,note?} 精确补丁 |
| nodeOps | E04-B08节点：有限操作数组，见节点协议；不是全量节点覆盖 |
| riskOps | E04-B08风险：非空的有限操作数组，详见下节；不是风险全量替换 |

遗漏字段/集合不修改。资料不存在或新增已停用引用返回 422，fields 指出对应字段；原停用引用可保留或移除。人员字段不产生账号权限。

200：outcome=committed，result 包含 projectId/operationId/changed/savedVersion/values/savedAt。仅原四项字段的请求保持旧协议，values 为四项固定值；含扩展字段的请求 values 为全部普通字段及关联，实际变更时 display 附当时关联名称/角色/ID，供页面和历史消费。savedAt 为UTC或无变化时 null；另有本次 requestId。同编号回放 result 保持原值，本次 requestId 可不同。实名作用域为user:<账号ID>:project:<项目ID>:text或ordinary；匿名历史回执保留原作用域，只读确认不伪造实名。

| HTTP/代码 | 处理 |
|---|---|
| 400 INVALID_SAVE_REQUEST / INVALID_PROJECT_ID | 修正请求，未提交 |
| 422 INVALID_PROJECT_FIELDS | fields 给对应字段错误，原输入保留 |
| 403 PROJECT_READ_ONLY | 本人尚未负责，先明确加入 |
| 404 PROJECT_NOT_FOUND | 项目不存在 |
| 409 PROJECT_VERSION_CONFLICT | currentVersion 提示新版，旧文字保留，重新进入 |
| 409 OPERATION_KEY_REUSED | 编号与原内容不一致，停止覆盖 |
| 500 SAVE_ROLLED_BACK | 已确认未提交，输入保留 |
| 503 DATABASE_UNAVAILABLE | 提交前失败时 not_committed；恢复后再保存 |
| 503 COMMIT_UNKNOWN | outcome=unknown；只读对账或原请求重试 |

422 PROJECT_VERSION_EXHAUSTED 不能再推进版本。网络超时/应答不可读同样为结果未知，不能把未知当未提交。

## POST /api/projects/:id/save-results/query

提交原 PATCH 的完全相同输入。只读，不新建回执、不补写项目。200 outcome=committed 带原 result；outcome=not_found 不证明原事务失败，稍后确认或沿原请求重试。非法输入/只读范围/编号摘要冲突同上；读取不可用时 outcome=unknown。

## GET /api/projects/:id/audit

pageSize 默认20，范围1～100；before 为上一页 nextCursor，采用严格小于该数字 ID 的逆序读取。返回 items/nextCursor/pageSize；nextCursor=null 表示本次没有更早页。items 含 id/actorDisplayName/actorKind/action/versionBefore/versionAfter/beforeValues/afterValues/createdAt。新实名动作actorKind=user；旧anonymous显示“未认证操作”，来源不改。历史总量无限制，与整个面板500项目规模独立。未知 query 拒绝，非法参数400；缺项目404、读取不可用503。

文字动作 action=project.text.save，扩展动作 action=project.ordinary.save。beforeValues/afterValues 为实际变化项；关联值保留当时 {id,name} 或人员 {id,name,role}，清除为 null/[]。

## GET /api/project-options

只读候选入口，返回 apps/chips/customers/engineers/product_lines/project_groups/tags 分类数组。项目 ID 与资料 ID 均为字符串，每项含 id/name/enabled；芯片另含 originalModel/manufacturer/firmwareVersion。包括停用项供原引用识别，服务器保存时独立核验新增引用资格。读取失败503，不把失败返回为空数组。此入口没有资料新增/改名/停用能力。

项目详情增加 customerId/odmCustomerId/productLineId/appId/groupId；已有关联集合的稳定 ID 保持。当前能力依据可信账号及本人负责范围，协议实际固定构建见部署记录。

## E04-B03 工期与评述统一保存

stagePlans补丁code仅S1～S7，plannedDays为null或0～65535整数天，note为有效字符串、UTF-8最多65535字节；每项至少一个字段，阶段不得重复。省略字段保持原值，null明确未定工期，note空字符串明确清空。state/startedOn/completedOn等额外字段400，实际事实必须使用[项目动作](project-actions.md#5-e04-b03-阶段纠错误操作撤销与真实回退)。

此字段与普通文字/资料关联同一个项目锁、版本、事务和审计。阶段状态/实际日期、节点成果、项目计划和检查事实保持；阶段事实有旧日期问题也不妨碍无关文字保存。非法工期/评述422 INVALID_PROJECT_FIELDS，fields.stagePlans提示，页面保留输入并返回原卡片。

请求包含stagePlans时，result.values.stagePlans返回最终七阶段工期/评述；没有请求时不新增此返回字段，旧正文指纹不变。审计以stagePlans保存本次前后七项有效值；无变化不推进项目版本。页面跨基本信息/阶段页签暂存编辑，统一点击“保存项目”。独立动作打开前先处理普通编辑，表单期间暂停普通输入，取消后恢复。

## E04-B08 风险统一保存

2026-10-10实际候选代码；行为沿[SPEC-005](../specification.md#spec-005-风险节点变更和检查)，准确运行版本归系统真相。riskOps按数组顺序应用到当前项目候选；对象仅允许下表字段。

| op | 精确输入 |
|---|---|
| add | op/tempId/content/level；tempId为小写UUIDv4，不重复 |
| correct | op/id/changes/reason；changes非空，仅content/level/resolution |
| resolve | op/id/resolution |
| undoResolve | op/id/reason |

content/resolution/纠错reason为有效非空文字、UTF-8最多65535字节；level仅high/mid/low。id是正式十进制字符串，或同数组此前add的tempId；不接受actor、createdAt、resolvedAt、resolved、sourceKey或delete。correct的解除说明仅限已解除风险；resolve必须预警中，undoResolve必须已解除。字段省略保持；不提供风险删除。实际时间/人由保存时服务器可信身份生成，创建事实和原来源不因纠错改变。

请求仍只携带expectedVersion/idempotencyKey/changes，可与普通字段、关联、stagePlans混合一次事务。风险实际操作分别追加project_risk目标审计，action为project.risk.add/correct/resolve/undoResolve；同次主字段摘要只记录主字段变化，全部共享项目前后版本和requestId。风险操作不自动修改灯色、阶段、计划或检查。riskOps不放入result.values，结果另外返回risks有效投影及riskIdMap（tempId→正式ID）；无实际风险差异且无普通字段差异时changed=false、savedAt=null，不推进版本/审计，但仍有原回执。

risks在详情和保存结果包含id/content/level/resolved/resolution/resolvedAt/actorId/createdAt/sourceKey/sortOrder/createdByName/resolvedByName；时间为UTC，resolved为0/1。新增/解除的人名消费当时审计快照，后续账号改名不改变事实；旧无审计来源的人保持null，不补造。原创建人actorId和时间不更改，撤销只清当前解除投影，全部原事实从项目审计分页读取。

额外失败：400 INVALID_RISK_OPERATIONS（有限格式/临时引用/重复键）；422 INVALID_PROJECT_FIELDS（fields.riskOps.<序号>.<字段>）；404 RISK_NOT_FOUND（当前项目找不到目标）；422 RISK_ALREADY_RESOLVED / RISK_NOT_RESOLVED / RISK_RESOLUTION_REQUIRES_RESOLVED / RISK_ORDER_EXHAUSTED。任一非法子记录使整次普通保存拒绝/回滚，旧版本/身份/结果未知沿原保存契约。原结果按原账号作用域恢复；他人使用同编号不成为该账号原操作。

### POST /api/projects/:id/save-preview

使用同一SaveRequest输入，当前必须含riskOps、nodeOps或changeOps；只读一致快照，检查启用身份/负责资格/进入版本，复用实际保存的风险候选。返回projectId/expectedVersion/events/risks及nodeEvents/nodes/requiredUncompleteIds/confirmed；risk events含op/id/before/after/reason，新增id仍为tempId。预览按实际包含的有限意图展示对应子记录候选，普通关联等在正式保存中独立统一核验；不写项目、正式ID、历史或回执，预览时刻不是正式事件时间。

页面预览后“确认加入未保存修改”只改变普通副本；最终点击“保存项目”重算候选、事务校验并正式保存。修改任何输入使预览失效。原生页面验收范围另归报告，不据接口存在称通过。

## E04-B08 节点A～C统一保存

2026-10-10候选实现；行为归SPEC-005，结构沿ERD5.8。nodeOps对象仅接受下列字段，操作按顺序应用，最后校验整份候选。原单前/后引用、项目节点阶段/成果、客户节点日期/备注保持；不加子节点或连线表。

| op | 精确输入 |
|---|---|
| add | op/tempId/kind/fields；kind为project或customer，小写UUIDv4临时ID不重复 |
| correct | op/id/changes/reason |
| complete | op/id/completedOn及可选reason；已有实际日纠正必须有reason |
| uncomplete | op/id/reason/affectedIds；明确撤销实际完成 |
| move | op/id/x/y；仅项目节点，DECIMAL(12,3)范围/精度 |
| link | op/from/to/replaceEdges/affectedIds/reason；明确替换旧线和受影响完成 |
| unlink | op/from/to；拆除现有线 |

项目add fields必须title/stage/output，可带targetDate；客户必须title，可带targetDate/note。correct changes非空，仅该类型对应字段；实际完成不能通过普通字段null清空。title非空/最多255码点，output非空，文字完整Unicode/UTF-8不超过65535字节；targetDate为有效日期或null。stage仅本项目S1～S7。正式ID为十进制字符串，或数组此前新增临时ID；关系只允许同项目的两个不同项目节点，客户节点不参与连线。

complete的实际日不能晚于中国业务今天；前置完成按最终候选判断，同次完成整条链可行，不额外要求日期按连线顺序递增，也不推进研发阶段。uncomplete/新前置导致已完成依赖不成立时，save-preview给出requiredUncompleteIds及confirmed=false；用户逐项核对后提供完全相同affectedIds和原因，重新预览为true后加入副本。遗漏/额外影响对象使正式保存422 NODE_IMPACT_CHANGED；系统不静默清下游完成。replaceEdges精确表示当前占用的旧线，不一致返回NODE_REPLACEMENT_CHANGED；双方和旧邻居同事务解除/设置；删除/恢复扩展见下节，运行状态归系统真相。

涉及完成/关系的候选检查双向一致及循环；NODE_CYCLE的fields.nodeOps显示具体循环。旧循环不妨碍无关文字/移动，可明确unlink纠正；不通过旧历史重复制造循环。移动/纠错同值不推进版本。节点操作不自动改变灯色、计划、阶段、检查或项目状态。

nodeOps不进入result.values；结果另附nodes和nodeIdMap，新ID先全部分配再设置关系。目标审计entity_type=project_node，action=project.node.add或project.node.save，before/after保存node及有限operations/reason；每个实际变更对象一条，统一项目版本、可信actor/时间和requestId，旧来源不改。save-preview不写正式ID/项目/历史/回执；正式保存仍在项目锁下重算。SQL任一写点失败整份回滚；原结果恢复包括稳定节点映射及当时投影，后来的变化不改旧回执。

其他失败：400 INVALID_NODE_OPERATIONS；404 NODE_NOT_FOUND；422 NODE_RELATION_INVALID/NODE_LINK_NOT_FOUND/NODE_STAGE_INVALID/NODE_PREDECESSOR_INCOMPLETE/NODE_CORRECTION_REASON_REQUIRED/NODE_NOT_COMPLETED/NODE_ORDER_EXHAUSTED及字段错误。版本/权限/停用/未知结果沿原普通保存协议。节点A～C不自行执行删除/恢复；0003兼容已部署，D/E扩展协议见下节。

## E04-B08 节点D/E删除恢复统一保存

2026-10-10实际固定协议；运行版本与验收分别归系统真相、报告。复用原nodeOps、save-preview及PATCH普通保存，不另加写路由，未保存副本不更改正式数据。

| op | 精确输入 |
|---|---|
| delete | op/id/removeEdges；id仅正式十进制字符串，removeEdges为去重的{from,to}数组 |
| restore | op/id/reason；id仅正式十进制字符串，reason有效非空文字、UTF-8最多65535字节 |

removeEdges必须精确覆盖当前目标的前后引用及有效邻居指向它的全部反向引用，包括旧单边关系；每条from/to可引用同份此前新增的临时节点。空集合仅在确实无旧线时通过。删除清目标和有效邻居引用、由服务器保存deletedAt，原字段/日期/成果/位置/sourceKey/ID保留，不桥接邻居、不删除或自动清空邻居完成日。客户节点同样可删，不能连线。

恢复要求目标当前已删除，清deletedAt及其前后引用、保持原ID和其余字段；可以同份恢复多个端点再明确link。恢复的项目节点须为本项目有效阶段，实际日不能在未来；需要纠正时同份restore后另列既有correct/complete/uncomplete操作，原因明确，不自动补造或清空。最终有效图继续原双向/循环/前置及完成影响校验；旧线保持在原审计，恢复默认不接回。

预览nodeEvents包含目标及实际受影响邻居的before/after/operations/reason；nodes仅返回有效候选。正式保存同一个项目事务/版本/审计/原回执；删除/恢复操作从目标审计operations和前后deletedAt识别，不增重复表或操作者列。结果仅含有效nodes，之后独立已删读取核对。原save-results按原正文/编号返回原结果，即使后来恢复或再次删除也不重写旧投影。

新增错误：422 NODE_DELETE_LINKS_CHANGED（必须重新核对全部旧线）、NODE_ALREADY_DELETED、NODE_NOT_DELETED；跨项目或无目标404 NODE_NOT_FOUND，非法额外字段/UUID正式目标400 INVALID_NODE_OPERATIONS，恢复原因/阶段/实际日及最终图错误沿既有字段/节点契约。任何子操作错误，整份普通文字和节点都不部分写；409冻结旧版并保留副本，SQL失败回滚，COMMIT未知沿原编号确认。

兼容回退2dfb17c能读取0003有效节点、保持原A～C结果和会话，但不理解新D/E正文。回退窗口内以新D/E正文确认会返回400/未知，不能据此宣布原保存失败或换编号；保留原正文，重新升级D/E版后再确认。本限制由实际旧镜像导出服务/同库验证，不以迁移兼容冒充协议兼容。

## E04-B08 需求变更A/B统一保存

2026-10-12候选代码协议；行为归SPEC-005，当前运行与验收只查系统真相。复用PATCH普通保存、save-preview及save-results/query；不新增表或独立写路由。

| op | 精确输入 |
|---|---|
| add | op/tempId/source/content/decision/reason；小写UUIDv4临时ID不可重复 |
| correct | op/id/changes/correctionReason；changes非空，只含明确选择的source/content/decision/reason |

新增及明确纠正source只客户/业务，decision只accept/reject，对应原面板接受/拒绝；content、业务reason、correctionReason为非空完整Unicode、UTF-8最多65535字节。正式ID为十进制字符串，或同数组此前add的tempId。未知字段、身份/时间/来源ID注入、delete或审批操作400；旧未触碰字段保留，不默认成业务/拒绝，不因空理由拦截无关文字保存。原创建actorId/createdAt/sourceKey/sortOrder不随纠正改写。

changeOps按顺序构建编辑候选，同份临时新增后可纠正；正式保存复用可信身份/负责资格/进入版本与项目锁，和文字、关联、阶段工期、风险及节点同一事务。实际目标事件为project_change的project.change.add/correct，beforeValues.change及afterValues.change/correctionReason记录原决定与新值、当时人名、同一前后版本/requestId；不自动更改计划、阶段、灯色、检查。任一写点失败整份回滚。

result另含changes和changeIdMap，不把意图放入result.values；changes含id/source/content/decision/reason/actorId/createdAt/sourceKey/sortOrder/createdByName，详情消费同一投影。createdByName取目标最早创建审计快照，不随账号改名变化；未知来源保持null。仅同值时不推进版本或审计，原回执仍存在。没有changeOps的旧请求正文指纹/结果格式保持。

save-preview另返回changeEvents/changes，每个事件含op/id/before/after/correctionReason；新id仍为tempId，预览不写正式数据、历史或回执。表单确认只加入副本，保存项目才写。修改输入使预览失效。

失败包括400 INVALID_CHANGE_OPERATIONS、422 INVALID_PROJECT_FIELDS（fields.changeOps.<序号>.<字段>）、404 CHANGE_NOT_FOUND、422 CHANGE_ORDER_EXHAUSTED；版本/身份/权限/结果未知沿原普通保存。真实COMMIT后失去确认须保留原编号正文查询结果。旧固定D/E版不识别changeOps，在回退窗口返回400不能据此认定原保存失败；再升级后确认原结果，不能另造替代记录。原生页面验收另记，接口通过不能代替。
