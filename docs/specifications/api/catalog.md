# 共享资料候选 API

对应代码：`src/server/modules/catalog.ts`、`src/server/routes/catalog.ts`，2026-10-17 P04 工作树候选。行为权威为[SPEC-006](../specification.md#spec-006-基础资料与引用)，页面结果为[PRD9.18](../../product/PRD.md#918-共享资料选择与维护)。协议存在不表示已部署。

## 入口

全部入口要求有效登录、已完成首次改密、可信账号上下文；写入沿现有来源与 CSRF 检查。业务账号可读取；预览和新维护写入只允许当前唯一维护账号。

| 方法及路径 | 输入 | 返回 |
|---|---|---|
| GET `/api/catalog/:kind` | 资料分类 | `canMaintain, items`；完整资料字段及十进制字符串 ID/version |
| GET `/api/catalog/:kind/:id` | 稳定资料 ID | `canMaintain, item, projects, customers`；项目含 ID/名称/版本，标签另列引用客户 |
| POST `/api/catalog/:kind/preview` | 下述命令 | `before, after, changed, projects, customers, impactToken`；只读，不写正式资料 |
| POST `/api/catalog/:kind/save` | 同一命令，更新带预览 token | `{outcome:'committed',result}`，仅事务提交后返回 |
| POST `/api/catalog/:kind/results/query` | 原命令原正文 | 原回执或 `{outcome:'not_found'}`；未查到不能据此推定未提交 |

## 分类及命令

分类 `customers/engineers/productLines/apps/tags/company/groups/chips` 对应已有实体。字段归[ERD](../../data/ERD.md)，本协议采用 camelCase：客户 `name/contact/background/tagIds`，工程师 `name/role`，产品线/标签/分组 `name`，APP `name/appVersion/description`，芯片 `name/originalModel/manufacturer/firmwareVersion`，企业 `fullName/shortName/managerText/namePrefix`。除企业外可改 `enabled`；企业固定 ID `1`，本接口不创建维护账号配置。

```json
{
  "id": "12",
  "expectedVersion": "3",
  "idempotencyKey": "00000000-0000-4000-8000-000000000001",
  "changes": { "name": "纠正后的芯片名称" },
  "impactToken": "预览返回的64位十六进制摘要"
}
```

新增用 `id:null, expectedVersion:'0'`；其余字段按需提供，空文本是明确清空。名称不能为空；未知字段、非法 ID/布尔值、超数据库容量文本及无效 Unicode 拒绝。客户标签为去重 ID 数组，不另设业务数量上限。

更新保留未提供字段。更新公司及无实际变化不要求影响 token；其余实际更新核对 token。前端内部获取预览，普通元资料直接保存；改名/启停且有引用时在原区域显示影响并确认，不为每个文字编辑新增人工审核步骤。

## 提交、冲突及恢复

- 同一维护账号的资料写入由配置行串行化，资源自身版本防覆盖。名称按 NFKC、空白和大小写归一化识别冲突，返回问题，不合并实体；已存在的同名资料仍可纠正其他字段。
- 原资料、实际引用项目、版本、审计和回执同事务提交。客户标签变更包括客户所引用项目；标签变更先按资料锁序锁住引用客户，再锁标签及项目，避免遗漏间接新增引用。
- 预览依据包含变更正文及实际引用版本。引用变动或项目版本变化后要求重新核对，原资料不部分写入。仅企业资料更新不推进项目版本。
- 回执作用域为当前账号及分类。成功 `result` 包含 `id/savedVersion/changed/operationId/affectedProjects`，受影响项目为 `{projectId,version}`。原请求重试返回原结果；同键不同正文返回 `OPERATION_KEY_REUSED`。
- `CATALOG_NAME_CONFLICT`、`CATALOG_VERSION_CONFLICT`、`CATALOG_IMPACT_CHANGED` 为409；权限403、非法输入400、名称空或引用不可用422、资料不存在404。未知提交沿现有 `COMMIT_UNKNOWN/outcome:unknown`，页面保留原命令，核对或重试原操作。
- 提交后通知沿[SSE协议](notifications.md)仅发布受影响项目编号、版本、操作号，不发送资料正文。项目历史增加对应资料的真实变更，稳定名称快照保留。

新入口及后端、DOM→HTTP/MySQL验证见[阶段内报告](../../testing/reports/2026-10-16-p04-scoped-save.md)。资料页面真实浏览器、全部分类交互、通知消费、企业标题及统一输出仍须继续验收。
