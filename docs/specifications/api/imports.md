# 导入接口

对应代码：`src/server/routes/imports.ts`、`modules/imports.ts`、`modules/project-import.ts`。本文件描述P05施工中的实际协议；固定发布版本及通过范围查系统真相和P05报告。业务规则只维护于[SPEC-009](../specification.md#spec-009-导入迁移与删除恢复)。

**协议版本**：本轮候选使用`0009-project-space`、执行命令`formatVersion:2`；尚未部署，准确版本以系统真相为准。旧来源设置及独立review/adopt写入口返回410，只保留原结果与来源读取。

## 身份与文件

所有接口沿用登录、账号上下文和写入CSRF校验。上传正文为`application/octet-stream`，最大32MiB；反向代理与应用限制一致。服务器保留原字节及SHA-256，文件名仅用于展示，不用作磁盘路径或对象身份。凭据与原文件不进入Git。

| 方法与路径 | 输入 | 返回用途 |
|---|---|---|
| `GET /api/imports` | 无 | `sources`和`batches`，每批明确返回`total/processed`，继续原批次 |
| `POST /api/imports/sources` | 旧协议 | 410 `IMPORT_CLIENT_OUTDATED`；不新建来源 |
| `POST /api/imports/upload` | 查询`name,operation`；可选`new=1`；文件正文 | 返回`batchId,reused`。无需填写来源；重复内容默认继续既有批次，明确另开才建立另一批 |
| `POST /api/imports/results/query` | `idempotencyKey` | 查询原上传或来源登记结果，不重复执行 |
| `GET /api/imports/:batchId` | 批次ID | 同快照的批次、资料行、项目卡、差异、权限、版本和计数 |

`GET /api/imports/:batchId/items/:itemId`返回同快照的`item,batchVersion`，结构与整批读取的单项一致，复用身份与来源校验。资料保存后可据此核对该项；依赖项目仍须重新读取并校验，不能沿用旧basis。

## 项目卡与共享资料行

公共正文：`expectedBatchVersion,expectedReviewVersion,expectedVersion,idempotencyKey`；写入还带服务端返回的`basis`。`selected`是明确选择的差异键；`payload`仅表达本次纠正，未提供的内容保持。目标选择使用`mode`及`targetId`；有关生命周期的必要意图使用`intent`。账号、来源、资料和项目实际权限均由服务端重新核验。

候选返回`classification=ready|needs_attention|unchanged`、`defaultSelected`、`conflictKeys`、`keptOnline`及`needsMapping`。本轮按SPEC-009名称规则识别目标：新增项目默认选择，已有项目实际差异默认不选择。每条差异的`status=normal|conflict|needs_choice|keep_online`说明处理类别，阶段或子记录用`members`保留同一事项的字段差异；不携带同对象未选字段。只读候选校验通过才列入`ready`，保存时仍重新核验。

`pendingInvitations`为候选仍需发出协作邀请的显示名称。正文一致但有待邀请对象时仍可确认该项目；`selected=[]`只创建邀请，不伪造正文修改或推进项目版本。`managerMatches`随单次执行集中确认存在歧义的备份经理；已加入或已有请求不自动重邀。准确身份和接受规则引用SPEC-014。

`unresolvedReferences`列出未解引用的路径及本批次对应资料卡`itemIds`。客户端可将依赖已确认资料或DEC-153明确新资料的项目列为等待资料的候选；服务器冻结依赖并在资料成功后重新校验，只对本次自身资料写入造成的变化更新依据，外部变化仍报冲突。没有依赖该资料的正常项目可独立继续。

`keepOnline`为本次明确保留线上内容的差异键，与`selected`不能重叠；全部保留时允许`selected=[]`，在同一事务记录决定及原回执，项目无实际修改时不推进业务版本。`payload`随执行命令一次修正入库，旧`review`不再接受写入；已有待审纠正仍可读取。没有对应的项目默认拟新增。共享资料按同类别、精确名称、唯一启用且已提供内容兼容复用，明确新资料自动建立；停用、多候选或内容冲突才原位确认，已有资料不自动覆盖。

读取与预览中的`referenceBasis`表示来源自动解析所得的引用依据，未叠加本次人工修改。客户端用它区分本人修改与外部对应改变；它只用于页面重新核对，不能替代写入时的`basis`、实际版本或权限校验。

| 方法与路径 | 行为 |
|---|---|
| `POST /api/imports/:batchId/items/:itemId/preview` | 只读合并候选；返回实际差异、问题及`cause/consequence/requiredKeys`因果信息，不自动扩选 |
| `POST /api/imports/:batchId/items/:itemId/review` | 已退役，410 `IMPORT_CLIENT_OUTDATED`，不写入 |
| `POST /api/imports/:batchId/items/:itemId/adopt` | 已退役，410 `IMPORT_CLIENT_OUTDATED`，不写入 |
| `POST /api/imports/:batchId/items/:itemId/results/query` | 以原正文及原操作键查询结果；不接受换正文重试 |
| `GET /api/imports/:batchId/items/:itemId/source` | 按需查看该条目的完整来源和解析问题 |
| `GET /api/imports/:batchId/items/:itemId/adoptions/:adoptionId` | 按需查看当次采用及来源历史，不从当前待审副本重建过去结果 |

差异键由响应提供，例如`fields.name`、`people.hardware_owner`、`stage.S2`、`record.<来源条目键>`、`history.mixed`。客户端不能自行推导另一个项目的正式ID。同一风险/需求变更作为一个事项，普通字段和不同事项分别选择。

成功返回`outcome=committed`及`result`。正式结果包含项目或资料ID、版本、采用与未采用计数、来源、操作号、采用ID和保存时间。短期回执清理后，正式采用通过不可改写的`import_adoptions`恢复原结果；`review`与`adopt`动作不能共用同一操作键。跨项目批量由服务器执行，单项冲突不撤销其他已成功项目。

## 一次提交与自动接续

`POST /api/imports/:batchId/executions`接收`{formatVersion:2,idempotencyKey,items:[{id,command,resolveReferences?}]}`，正文上限16MiB。`command`为上述原子项正文；`resolveReferences:true`明确允许完成本项目缺失但已明确的资料关联，未选择时不扩大所选范围。接收事务冻结依赖、输入、版本和原子操作号，返回202及执行记录；一次批次只能有一个未结束执行，同键同正文返回原执行，同键不同正文409。旧已完成命令可按原正文重放查询，未被接受的旧格式命令410。

`GET /api/imports/:batchId/executions`读取该批最新执行；`?operation=<UUID>`读取当前账号的指定执行。返回`id,batchId,actorId,operationId,status,items,operationIds`，不返回冻结命令或个人凭据。

| 层级 | 状态及客户端行为 |
|---|---|
| 整次执行 | `accepted/running/finished`；finished表示本次逐项结果均确定，不等于所有项目成功 |
| 每项 | `pending/saving/committed/failed/confirming`；成功含原result，失败含code/statusCode/fields，confirming由服务器按原键继续核实 |
| 接收响应未知 | 保留原批次、操作号和正文，先GET确认；不存在才重发相同接收命令，不生成替代操作 |
| 页面离开/服务重启 | MySQL保留范围及进度，执行器重新领取过期租约；业务提交后进度丢失优先读永久采用，不重复保存 |
| 账号变化 | 原已成功结果可回读；停用、改密、处理人或项目权限变化在后续写入前重新检查 |
| 老页面未知请求 | 原结果查询先锁项确认；有结果返回committed；仍有执行返回not_found；无执行无结果返回not_committed，保留输入后重新使用当前入口 |

页面只发送一次范围命令、读取进度和展示结果；正常资料依赖自动处理，业务冲突仍停在原项目直接修正。公司信息不自动加入依赖。

## 批次接续与正式项目读取

`POST /api/imports/:batchId/source`已退役410；原`/source/results/query`保留查询。`POST /api/imports/:batchId/takeover`使用`expectedVersion,reason,idempotencyKey`，追加`/results/query`查询原操作。接管只在当前处理人停用时由启用业务账号按SPEC-009处理，维护账号不具有业务接管资格；原上传者和过去采用不变，后续新增项目由当前处理人先负责。

正式采用正文须逐次核验其目标项目的当前读取资格；换候选目标不能获得原无权项目快照。退出后原操作可确认成功事实，项目正文和完整采用历史不再返回。

`GET /api/projects/:id/source-history`按`kind=mixed|status_description`、可选`source`、`adoption`、`before`读取正式项目的来源历史。每页最多50个版本，返回`nextCursor`；旧版本选择不修改当前默认版本。该接口沿用正式项目读取权限。

## 失败与恢复

| 结果 | 客户端处理 |
|---|---|
| `401` / 身份或CSRF错误 | 保留本账号原任务输入，重新登录后核对账号 |
| `403` 无处理/项目经理资格 | 只读显示，不能通过改目标声明获得原项目权限 |
| `409` 批次、待审、资料、项目或对应变化 | 原输入保留；重新读取并核对选择，禁止旧版本覆盖 |
| `422` 格式或业务依赖不成立 | 就地显示实际问题；有合法来源前提时由人选择一起采用 |
| `413` 文件超限 | 明确未上传成功，保留来源与文件选择，允许更换文件 |
| `outcome=unknown` | 保留原操作号及正文，查询原结果；不生成替代操作 |
| 成功后列表读取失败 | 保留成功结果与正式对象入口，单独重试读取 |

部署接收关口`GEEKDASH_IMPORT_ACCEPTING=disabled`禁止新导入变更和命令接收，不停止已接受执行；`GEEKDASH_IMPORT_WRITES=disabled`同时暂停导入执行。全业务只读恢复由`GEEKDASH_BUSINESS_WRITES=disabled`控制。三者用途与恢复顺序归运维；实际验证不由本协议宣称完成。
