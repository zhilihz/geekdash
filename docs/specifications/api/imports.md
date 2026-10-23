# 导入接口

对应代码：`src/server/routes/imports.ts`、`modules/imports.ts`、`modules/project-import.ts`。本文件描述P05施工中的实际协议；固定发布版本及通过范围查系统真相和P05报告。业务规则只维护于[SPEC-009](../specification.md#spec-009-导入迁移与删除恢复)。

## 身份与文件

所有接口沿用登录、账号上下文和写入CSRF校验。上传正文为`application/octet-stream`，最大32MiB；反向代理与应用限制一致。服务器保留原字节及SHA-256，文件名仅用于展示，不用作磁盘路径或对象身份。凭据与原文件不进入Git。

| 方法与路径 | 输入 | 返回用途 |
|---|---|---|
| `GET /api/imports` | 无 | `sources`和`batches`，每批明确返回`total/processed`，继续原批次 |
| `POST /api/imports/sources` | `name,idempotencyKey` | 登记逻辑来源，返回`sourceNamespace` |
| `POST /api/imports/upload` | 查询`source,name,operation`；可选`new=1`；文件正文 | 返回`batchId,reused`。重复内容默认继续既有批次；明确另开才建立另一批 |
| `POST /api/imports/results/query` | `idempotencyKey` | 查询原上传或来源登记结果，不重复执行 |
| `GET /api/imports/:batchId` | 批次ID | 同快照的批次、资料行、项目卡、差异、权限、版本和计数 |

`GET /api/imports/:batchId/items/:itemId`返回同快照的`item,batchVersion`，结构与整批读取的单项一致，复用身份与来源校验。资料保存后可据此核对该项；依赖项目仍须重新读取并校验，不能沿用旧basis。

## 项目卡与共享资料行

公共正文：`expectedBatchVersion,expectedReviewVersion,expectedVersion,idempotencyKey`；写入还带服务端返回的`basis`。`selected`是明确选择的差异键；`payload`仅表达本次纠正，未提供的内容保持。目标选择使用`mode`及`targetId`；有关生命周期的必要意图使用`intent`。账号、来源、资料和项目实际权限均由服务端重新核验。

DEC-151收敛后的候选还返回`classification=ready|needs_attention|unchanged`、`defaultSelected`、`conflictKeys`、`keptOnline`及`needsMapping`。每条差异的`status=normal|conflict|needs_choice|keep_online`说明处理类别，阶段或子记录用`members`保留同一事项的字段差异；默认采用键只含正常更新的实际成员，不携带同对象未选字段。只读候选校验通过才列入`ready`，保存时仍重新核验。

`unresolvedReferences`列出未解引用的路径及本批次对应资料卡`itemIds`。客户端可将依赖已确认资料或DEC-153明确新资料的项目列为等待资料的候选；资料保存后必须重新读取和校验项目，不复用旧`basis`或猜测正式ID。没有依赖该资料的正常项目可独立继续。

`keepOnline`为本次明确保留线上内容的差异键，与`selected`不能重叠；全部保留时允许`selected=[]`，在同一事务记录决定及原回执，项目无实际修改时不推进业务版本。`payload`可以直接随`adopt`修正入库，无需先调用`review`；旧`review`保留兼容及待审记录接续，不是页面入库的前置步骤。没有对应的项目默认拟新增，未知共享资料仍需显式选择`mode/targetId`，不按同名自动配对。

读取与预览中的`referenceBasis`表示来源自动解析所得的引用依据，未叠加本次人工修改。客户端用它区分本人修改与外部对应改变；它只用于页面重新核对，不能替代写入时的`basis`、实际版本或权限校验。

| 方法与路径 | 行为 |
|---|---|
| `POST /api/imports/:batchId/items/:itemId/preview` | 只读合并候选；返回实际差异、问题及`cause/consequence/requiredKeys`因果信息，不自动扩选 |
| `POST /api/imports/:batchId/items/:itemId/review` | 保存待审纠正与对应选择，只推进待审修订，不改正式项目 |
| `POST /api/imports/:batchId/items/:itemId/adopt` | 保存所选正式信息、来源对应和采用事实。同一项目全部成功或回滚 |
| `POST /api/imports/:batchId/items/:itemId/results/query` | 以原正文及原操作键查询结果；不接受换正文重试 |
| `GET /api/imports/:batchId/items/:itemId/source` | 按需查看该条目的完整来源和解析问题 |
| `GET /api/imports/:batchId/items/:itemId/adoptions/:adoptionId` | 按需查看当次采用及来源历史，不从当前待审副本重建过去结果 |

差异键由响应提供，例如`fields.name`、`people.hardware_owner`、`stage.S2`、`record.<来源条目键>`、`history.mixed`。客户端不能自行推导另一个项目的正式ID。同一风险/需求变更作为一个事项，普通字段和不同事项分别选择。

成功返回`outcome=committed`及`result`。正式结果包含项目或资料ID、版本、采用与未采用计数、来源、操作号、采用ID和保存时间。短期回执清理后，正式采用通过不可改写的`import_adoptions`恢复原结果；`review`与`adopt`动作不能共用同一操作键。跨项目批量由页面逐项调用，单项冲突不撤销其他已成功项目。

## 批次接续与正式项目读取

`POST /api/imports/:batchId/source`使用`expectedVersion,sourceNamespace,idempotencyKey`；`POST /api/imports/:batchId/takeover`使用`expectedVersion,reason,idempotencyKey`。各自追加`/results/query`查询原操作。接管只在当前处理人停用时按SPEC-009处理；原上传者和过去采用不变。

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

部署恢复环境`GEEKDASH_IMPORT_WRITES=disabled`禁止导入写入，仍允许原结果查询、来源读取和预览；普通项目能力沿原协议。实际恢复验证属于运维与测试记录，不由本协议宣称完成。
