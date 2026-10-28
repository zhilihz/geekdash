# 数据模型与实体关系（ERD）

2026-10-27：已确认多值资料、项目芯片备注及ODM独立分类，设计增量归5.15。既有0009已发布事实归系统真相；下方历史“未迁移”只对应原设计时点。

日期：2026-10-26；本轮新增目标结构见5.14，尚未编写或执行迁移。历史结构基线为0001初始34表/313列/55条引用、0002的34/314/55及0003的34/315/55，0004增量归5.10/5.11，0005归5.12，0006～0008归5.13；各运行环境当前结构只归系统真相。E03身份、责任和会话复用原实体，DEC-108日期未知复用可空列；原约束验证范围见[F02/F03实际报告](../testing/reports/2026-10-08-e01-f02-f03.md)。

本文分清三类来源：**B** 是真实 V1.044 备份中观察到的结构，**C** 是 V1.050 源码的读写或归一化结构，**T** 是服务器目标表达。旧系统是 JSON 与浏览器存储，下面的实体名称不代表旧系统已有 MySQL 表。字段反推完成的范围是本次备份与七个运行文件；不证明备份覆盖全部业务数据，也不替代剩余业务规则确认或可执行 DDL。

脱敏字段清单、计数及来源哈希见[字段核查证据](../evidence/2026-09-30-field-inventory.json)。代码位置均相对忽略目录 `source-review/AIGeekDashCX/geekdash-system-builder/releases/GeekDash1050/`，方便本地复核；真实内容不上传。业务行为正文只维护于[规格书](../specifications/specification.md)，待决索引见[决策](../decisions/decisions.md)。

## 1. 现有数据：实际容器与关系

### 1.1 备份顶层

| 容器/字段 | B 实测 | C 来源和解释 |
|---|---|---|
| version、appVersion、exportedAt | schema 2、V1.044、导出时间文本 | `projects-data.js:707～722` 构造备份头部；导出时间不是任何项目的创建时间 |
| projects | 27 项，每项 29 字段 | 项目对象聚合阶段、节点、风险等数组，没有数据库外键 |
| customers、engineers、productLines、apps、tags | 各 0 项 | 空库不代表项目未引用这些名称，也不证明此版没有资料功能 |
| groups | 3 项，id/name | 本次项目没有 group 字段，不能按分组库存在替项目补分组 |
| chips | 13 项，id/name/originalModel/manufacturer/firmwareVersion | 项目 chips 数组全空；不能把资料库全部芯片自动分配给项目 |
| company | fullName/shortName/manager/namePrefix | manager 是展示文字，不是认证身份或维护权限 |
| preferences | 12 个字符串键值 | 部分字符串内含 JSON；不是全部都属于个人页面偏好 |

备份共 13 个顶层键。V1.050 `buildBackupData` 仍导出这些容器。`validateBackupData:740～787` 能为缺失集合给默认值；原数据未修改，本轮没有通过该函数重写备份。

```mermaid
erDiagram
    LEGACY_PROJECT ||--|{ STAGE_ARRAY_ENTRY : embeds_by_position
    LEGACY_PROJECT ||--o{ HISTORY_ARRAY_ENTRY : embeds
    LEGACY_PROJECT ||--o{ NODE_ARRAY_ENTRY : embeds
    LEGACY_PROJECT ||--o{ CUSTOMER_NODE_ARRAY_ENTRY : embeds
    LEGACY_PROJECT ||--o{ RISK_ARRAY_ENTRY : embeds
    LEGACY_PROJECT ||--o{ CHANGE_ARRAY_ENTRY : embeds
    LEGACY_PROJECT ||--o{ DELAY_ARRAY_ENTRY : embeds_if_present
    LEGACY_PROJECT ||--o| SUMMARY_NOTE_VALUE : keyed_by_project_id
    LEGACY_PROJECT ||--o| CHIPSTAT_NOTE_VALUE : keyed_by_project_id
```

图中节点/风险/变更/延期及芯片统计备注部分由 C 证明，B 样本为空或缺失；纪要备注则 B 已有 27 项。客户、人员、产品线、APP、芯片和标签以**名称**联系项目，无法画成已经成立的 ID 外键。

### 1.2 项目：B 中全部 29 字段

来源为 B 全部项目键，与 C `project-detail.html:3197～3364` 的保存/新建对照。下表目标字段是逻辑映射，空串或占位符须保留原值并在审查时识别，不能悄悄补造成事实。

| 旧字段 | B 类型/数量 | T 映射与迁移限制 |
|---|---|---|
| id | integer，27 | 来源 ID → import_items.source_key；正式 projects.id 另生成 |
| name | string，27 | projects.name，保留名称原文 |
| customer | string，27 | projects.customer_id；8 个不同来源名称，而客户库为空，需人工确认资料映射 |
| productLine | string，27 | projects.product_line_id；14 个不同来源名称，产品线库为空 |
| odmFactory | string，27 | projects.odm_customer_id；非空名称 4 种，来自客户库的 ODM 候选或自由输入，不是独立供应商库的证据 |
| app | string，27；全空 | projects.app_id；源码允许已有 APP 名称及自由输入 |
| proposalDate | string，27；全空 | projects.proposed_on；DATE 可空，不用导入日补造 |
| filingDate | string，27；5 个日期文本 | projects.filed_on；其余为空，须校验日期而非只匹配文本形式 |
| startDate | string，27；全空 | projects.started_on；项目启动日，不等于阶段实际开始日 |
| dueDate | string，27；15 个日期文本 | projects.current_due_date；original_due_date 是否相同需人工核对，不能证明原始计划 |
| priority | string，27 | projects.priority；按 SPEC-018 解释，不转为风险等级 |
| signal | string，27 | projects.signal；人工灯色，见 SPEC-017 |
| signalNote | string，27 | projects.signal_note；灯色说明 |
| status | string，27 | projects.status；状态和阶段完成分别核对，见 SPEC-003 |
| marketExpectation | string，27 | projects.market_expectation；业务文字 |
| statusDesc | string，27 | projects.status_description；多行原文；不伪造描述更新人/时间 |
| hwOwner | string，27 | project_people.role=hardware_owner；业务人员，不等于登录账号负责人 |
| swOwner | string，27 | project_people.role=software_owner；同上 |
| pm | string，27 | project_people.role=pm；同上 |
| participants | string[]，共 76 项 | project_people.role=participant；13 个不同名称，人员资料库为空；不自动授予系统权限 |
| chips | array，全部空 | project_chips；有值时按名称建立映射，不能按现有库推断引用 |
| tags | array，全部空 | project_tags；有值时按名称映射 |
| stages | object[]，共 189 项 | project_stages；每项目 7 项，数组位置映射 S1～S7，详见下节 |
| nodes | array，全部空 | project_nodes.kind=project；C 支持，不可声称用户没有节点能力 |
| customerNodes | array，全部空 | project_nodes.kind=customer；客户节点与项目节点保留区别 |
| risks | array，全部空 | project_risks；C 字段见下节，处理规则待 Q-012 |
| changes | array，全部空 | project_changes；业务需求变更，非本系统发布日志 |
| statusHistory | object[]，共 162 项 | legacy_project_history；混合操作与状态文字，保留来源及顺序，不冒充可信审计 |
| lastCheckAt | integer，27 | 受控来源记录保留 legacy 时间戳；不生成可信 project_checks，理由见 SPEC-005 |

项目客户库为空但存在 8 种客户名称，工程师库为空但硬件/软件/参与者等字段有姓名。匹配只产生候选；不能根据同名自动认定人员身份、把业务 PM 变成负责人，或合并未经确认的资料。

### 1.3 C 中增加的 10 个项目字段

B 中均缺失。保存与新建来源同上；closeReason 另见 `project-detail.html:2083`。这不是断言所有 V1.050 项目都具有这些字段。

| 旧字段 | C 结构/用途 | T 映射或保留方式 |
|---|---|---|
| group | string，分组名称 | projects.group_id；不因 B 分组库有值而补填项目 |
| isProductionMaintenance | boolean | projects.maintenance_enabled；与结案组合见 SPEC-003 |
| statusDescUpdatedAt | 本地时间文本 | 保存来源文字；可验证后映射描述业务更新时间，不能作为服务器审计时间 |
| detailNote | string | projects.detail_note，与纪要备注及芯片统计备注分别保存 |
| delays | object[] | schedule_changes；实际日期调整与说明记录分开，原始日期待核对 |
| isDelayed | boolean | 原始来源保留；曾映射projects.manual_delayed，现按DEC-098退出正式业务，兼容结构与移除见5.7 |
| createdAt | 本地时间文本 | 保存来源创建时间，不伪造可信 created_by；服务器入库时间另记 |
| closeReason | string | 历史结案说明；closure_type 未提供，不能只凭字段存在判为某种结案 |
| flowLinks | 新建从草稿透传数组 | 所读当前连线操作实际写 nodes.prevId/nextId；此数组保留受控来源，不能假设已确定元素契约 |
| milestones | 新建从草稿透传数组 | C 有兼容归一化结构，但未发现所读页面调用该归一化器处理实际节点操作；保留原内容，不自动转成返工子项目 |

#### 1.3.1 1051项目简介的独立来源（2026-10-15核对）

本机参考目录 `D:/geekwon/geekdash-local-releases/GeekDash1051/` 的 `project-detail.html:2408～2409、3344、3457` 分别读取、修改及新建 `p.summary`，用途是项目简介及项目卡片；它不是上表B/C已实测字段的补计，也不是浏览器 `summary_notes` 容器。目标映射为 `p.summary` → `projects.summary`，增量字段及兼容边界唯一见5.11。`statusDesc`、`detailNote`、`summary_notes`、`chipstat_notes` 继续各自映射，不能因都能填写文字而合并。

### 1.4 嵌套对象完整字段

C 来源：`projects-data.js:984～1105`。B 只有 stages 和 statusHistory 的对象可核对；其他数组为空，不能据源码声称存在真实样本。

| 结构 | B | C 字段及语义 | T 表达 |
|---|---|---|---|
| stages | 每项仅 days:string、done:boolean | days、done、note、doneDate、startDate、expectedEndDate；按七阶段位置对应，无对象 ID | planned_days、state、note、completed_on、started_on、expected_end_on；工期字符串先校验，不能无条件转数字；done=false 不证明已开始 |
| statusHistory | 每项 date/text，162 项 | date、text；归一化仅保留这两项，丢弃空 text 项 | legacy_project_history.source_date_text/body/source_sequence；保存原条目，不凭文字推断 actor |
| risks | 空 | id、content、level、createdAt、resolved、resolveMethod、resolvedAt | project_risks；解除标记与处理结果都保留，不从缺失解除时间反推未解除 |
| changes | 空 | id、source、content、status、reason、createdAt | project_changes；旧 status 原文映射目标 decision 的具体枚举待 Q-012 |
| delays | 缺失 | id、reason、newTargetDate、measures、createdAt | schedule_changes；无日期的说明仍保留，不制造改期次数或计划 |
| nodes | 空 | id、name、stage、stageId、targetDate、output、doneDate、prevId、nextId、x、y | 项目节点的阶段引用、成果、日期及位置；节点来源 ID 只在同项目映射 |
| customerNodes | 空 | id、name、targetDate、doneDate、note | 客户节点不强补阶段引用；note 不覆盖项目节点 output |
| milestones | 缺失 | id、stageId、name、startDate、expectedEndDate、actualEndDate、note、prevId、nextId、x、y、children | 兼容结构保留来源，映射和展示入口待核实 |
| milestones.children | 缺失 | id、name、startDate、expectedEndDate、actualEndDate、note | 源码支持这种兼容形状，不等于已确认增加子节点功能 |

连线实证：`project-detail.html:2532～2534/2648～2649` 渲染 nextId；`:2773～2809/2819～2820/2833～2839/2947～2951` 创建、删除和拖拽修改 prevId/nextId。目标保留同项目单前/单后节点引用，校验悬空/互不对应来源边；前置完成和禁止新循环由DEC-103/106确认，行为只归SPEC-005。节点不驱动阶段，不从数据模型增设分叉/层级或业务自动化。

七阶段 B 样本均缺少实际日期。导入已完成标记时保留完成事实和缺失日期说明，未完成部分的当前状态须人工核对；禁止用导入时间、自动计算工期或页面旧“进行中”文字补造实际开始/完成日期。

### 1.5 基础资料字典

来源：`data-manage.html:889～903/959～973/1046～1087/1213～1254/1282～1330/1449～1456`。id/name 在资料集合中使用正整数及名称校验，但项目使用名称，不是 ID 引用。

| 集合 | 字段（B/C） | T 关系与限制 |
|---|---|---|
| customers | C：id/name/tags/contact/background | customers + customer_tags；项目 customer 与 odmFactory 可分别引用同一客户库；ODM 候选为名称标签包含 ODM 的资料，也可自由输入；不是按 type 外键过滤 |
| engineers | C：id/name/role | engineers；role 是业务资料角色，不是账号权限；同一人可在 project_people 担任不同项目角色 |
| productLines | C：id/name | product_lines；项目多对一可空 |
| apps | C：id/name/version/desc | apps.app_version；旧 version 为 APP 资料版本，不是项目并发 version |
| tags | C：id/name | tags + project_tags/customer_tags；旧项目标签库与客户标签候选不是同一来源，迁移不得只按同名合并资料身份 |
| groups | B/C：id/name | project_groups；项目多对一可空 |
| chips | B/C：id/name/originalModel/manufacturer/firmwareVersion | chips + project_chips；名称不是天然唯一标识；NFKC/大小写/空白归一化只辅助匹配，不默认合并资料 |
| company | B/C：fullName/shortName/manager/namePrefix | system_configuration 单例企业信息；展示负责人不授予权限，namePrefix 是命名配置 |

`projects-data.js:514～522` 对旧 customer.type 转成 tags 后删除 type；这是兼容转换，不能据此为真实 B 备份补造字段。原始未知字段留在受控导入项，不直接采用旧归一化器丢弃字段。

2026-10-15补核1051 `data-manage.html:639～666`：客户标签候选来自预设`CUSTOMER_TAG_SUGGESTIONS`、各客户已有标签及当前草稿，允许输入后回车加入；不读取项目标签库。目标仍复用既有标签实体和各自关联表，但旧来源先分别映射并保留来源，不能仅凭相同文字认定是同一资料；选择器不能因此把客户标签全量混进项目标签候选。旧版删除标签跨客户移除的行为不覆盖服务器已确认的引用保护规则。

### 1.6 浏览器状态与业务内容

V1.050 的备份白名单共 25 键，见 `projects-data.js:22～31`。下表为完整分类，键名均省略公共前缀 `hw_project_board_`；完整键及 B 是否出现见证据 JSON。

| 类别 | C 键 | T 归属及边界 |
|---|---|---|
| 个人显示 | theme、display_mode、meeting_float、zone_settings、activity_settings、filter_settings、filter_collapsed_default、welcome_dismissed、kb_auto_sync | user_preferences；旧来源不证明属于哪个登录用户，分配/默认使用边界待 Q-017 |
| 检查显示/规则 | check_mode、check_rule | 原浏览器来源保留；DEC-133已取消服务器周截止规则，不能将旧check_rule导入为当前设置或重新创建义务。个人显示偏好与旧业务规则分别核对；SPEC-019 |
| 旧纪要布局 | summary_order、summary_hidden、summary_sort、summary_show_note、summary_show_node | 保留旧键来源，目标为user_preferences中统一状态简要的页面上下文；合并及冲突处理见SPEC-020 |
| 旧芯片统计布局 | chipstat_order、chipstat_hidden、chipstat_sort、chipstat_show_note、chipstat_show_node、chipstat_colvis | 保留旧键来源，与旧纪要布局收敛到同一个页面上下文，不创建第二份当前布局；迁移见SPEC-020 |
| 页面业务备注 | summary_notes、chipstat_notes | projects.summary_note / projects.chipstat_note；两者都按项目 ID 存储，并不是按芯片名称存储；同项目两份备注互不覆盖，服务器修改按项目负责范围 |
| Bug/建议 | feedback | C `settings.html:631～664`：id/type/author/date/content；author 是手填文字，不是可信用户；保留来源，服务器 feedback_entries 的处理流程待确认 |

B 中 summary_notes 的 27 个键全部能对应 27 个项目的来源 ID；C `project-status-summary.html:545/618～620` 和 `chip-statistics.html:562/634～636` 分别证明两类备注按项目索引。迁移时先改成正式项目 ID，不按对象遍历顺序配对。

**旧备份的覆盖缺口：** `GeekDash.html:3972～3985` 的会议运行态位于 `hw_project_board_meeting`，结构为 status/startTime/elapsed/resumeAt/endTime（计时 elapsed 为毫秒）；该键不在上述白名单。IndexedDB 存 JSON/会议目录的文件句柄，也未导出；句柄是本机访问能力，不能移成服务器文件路径。浏览器草稿、返回上下文及已输出文件也不能凭这份 .bak 证明覆盖。服务器版完整备份要求见 SPEC-016；若需迁移这些额外内容，应另取真实来源并核对，不能把 13 个 JSON 容器当作覆盖一切的证据。

## 2. 服务器目标关系（T）

实体框显示关键字段，完整字段、SQL 类型及约束见第 3～5 节。PK 为主键，FK 为外键，UK 为唯一键；同表多个 PK 行表示联合主键；联合唯一键只在字段字典中整组标明，不给其中单列标注独立 UK。图中类型为便于阅读的简称，以第 3 节物理字典为准。该图是首版施工设计，迁移执行与真实数据约束验证仍未完成。

[核心关系 PNG](../evidence/diagrams/geekdash-core-erd.png) · [完整目标 SVG](../evidence/diagrams/geekdash-target-erd.svg) · [完整目标 PNG](../evidence/diagrams/geekdash-target-erd.png)。图示由本节 Mermaid 实体/关系派生，用 Graphviz 的表格节点和乌鸦脚绘制；图源唯一维护于本节，派生产物不要手工改写。首版 34 张表，合并/撤除说明见第 4 节；jobs 不在首版图中。

![核心实体关系图](../evidence/diagrams/geekdash-core-erd.png)

```mermaid
erDiagram
    USERS ||--o{ SESSIONS : user
    USERS ||--o| SYSTEM_CONFIGURATION : maintenance_user
    USERS ||--o| SYSTEM_CONFIGURATION : updated_by
    USERS ||--o{ CHECK_RULE_REVISIONS : saved_by
    CUSTOMERS o|--o{ PROJECTS : customer
    CUSTOMERS o|--o{ PROJECTS : odm_customer
    PRODUCT_LINES o|--o{ PROJECTS : product_line
    APPS o|--o{ PROJECTS : app
    PROJECT_GROUPS o|--o{ PROJECTS : group
    CHECK_RULE_REVISIONS o|--o{ PROJECTS : first_check_rule_version
    USERS o|--o{ PROJECTS : created_by
    IMPORT_ITEMS o|--o{ PROJECTS : source_import_item
    PROJECTS ||--o{ PROJECT_RESPONSIBILITIES : project
    USERS ||--o{ PROJECT_RESPONSIBILITIES : user
    PROJECTS ||--o{ PROJECT_STAGES : project
    PROJECTS ||--o{ PROJECT_NODES : project
    PROJECT_STAGES o|--o{ PROJECT_NODES : stage
    PROJECT_NODES o|--o{ PROJECT_NODES : previous_node
    PROJECT_NODES o|--o{ PROJECT_NODES : next_node
    PROJECTS ||--o{ PROJECT_PEOPLE : project
    ENGINEERS ||--o{ PROJECT_PEOPLE : engineer
    PROJECTS ||--o{ PROJECT_CHIPS : project
    CHIPS ||--o{ PROJECT_CHIPS : chip
    PROJECTS ||--o{ PROJECT_TAGS : project
    TAGS ||--o{ PROJECT_TAGS : tag
    CUSTOMERS ||--o{ CUSTOMER_TAGS : customer
    TAGS ||--o{ CUSTOMER_TAGS : tag
    PROJECTS ||--o{ LEGACY_PROJECT_HISTORY : project
    IMPORT_ITEMS ||--o{ LEGACY_PROJECT_HISTORY : source_import_item
    PROJECTS ||--o{ PROJECT_RISKS : project
    USERS o|--o{ PROJECT_RISKS : actor
    PROJECTS ||--o{ PROJECT_CHANGES : project
    USERS o|--o{ PROJECT_CHANGES : actor
    PROJECTS ||--o{ SCHEDULE_CHANGES : project
    USERS o|--o{ SCHEDULE_CHANGES : actor
    PROJECTS ||--o{ PROJECT_CHECKS : project
    USERS ||--o{ PROJECT_CHECKS : actor
    CHECK_RULE_REVISIONS o|--o{ PROJECT_CHECKS : legacy_rule_version
    USERS o|--o{ AUDIT_LOG : actor
    PROJECTS o|--o{ AUDIT_LOG : project
    USERS ||--o{ USER_PREFERENCES : user
    USERS ||--o{ PROJECT_DRAFTS : user
    PROJECTS o|--o{ PROJECT_DRAFTS : project
    USERS ||--o{ MEETINGS : created_by
    USERS ||--o{ REPORTS : created_by
    MEETINGS o|--o{ REPORTS : meeting
    USERS ||--o{ IMPORT_BATCHES : created_by
    USERS ||--o{ IMPORT_BATCHES : current_handler
    IMPORT_BATCHES ||--o{ IMPORT_ITEMS : batch
    PROJECTS o|--o{ IMPORT_ITEMS : target_project
    USERS o|--o{ IMPORT_ITEMS : corrected_by
    USERS o|--o{ IMPORT_ITEMS : reviewed_by
    USERS o|--o{ FEEDBACK_ENTRIES : created_by
    IMPORT_ITEMS o|--o{ FEEDBACK_ENTRIES : source_import_item
    USERS ||--o{ COMMAND_RECEIPTS : actor
    USERS {
        ID id PK
        string login_name UK
        string password_hash
        boolean must_change_password
        number version
    }
    SESSIONS {
        string token_hash PK
        ID user_id FK
    }
    SYSTEM_CONFIGURATION {
        ID id PK
        ID maintenance_user_id FK
        string full_name
        number version
        ID updated_by FK
    }
    CHECK_RULE_REVISIONS {
        ID version PK
        number deadline_weekday
        date effective_week
        ID saved_by FK
    }
    PROJECTS {
        ID id PK
        string name
        ID customer_id FK
        ID odm_customer_id FK
        ID product_line_id FK
        ID app_id FK
        ID group_id FK
        ID created_by FK
        ID source_import_item_id FK
        ID first_check_rule_version FK
        number version
    }
    PROJECT_RESPONSIBILITIES {
        ID project_id PK, FK
        ID user_id PK, FK
        datetime joined_at
    }
    PROJECT_STAGES {
        ID id PK
        ID project_id FK
        string stage_code
        string state
    }
    PROJECT_NODES {
        ID id PK
        ID project_id FK
        string kind
        ID stage_id FK
        ID previous_node_id FK
        ID next_node_id FK
    }
    PROJECT_PEOPLE {
        ID project_id PK, FK
        ID engineer_id PK, FK
        string role PK
    }
    CUSTOMERS {
        ID id PK
        string name
        string contact
        number version
    }
    ENGINEERS {
        ID id PK
        string name
        string role
        number version
    }
    PRODUCT_LINES {
        ID id PK
        string name
        boolean enabled
        number version
    }
    APPS {
        ID id PK
        string name
        string app_version
        number version
    }
    PROJECT_GROUPS {
        ID id PK
        string name
        boolean enabled
        number version
    }
    TAGS {
        ID id PK
        string name
        boolean enabled
        number version
    }
    CHIPS {
        ID id PK
        string name
        string original_model
        number version
    }
    PROJECT_CHIPS {
        ID project_id PK, FK
        ID chip_id PK, FK
        number sort_order
    }
    PROJECT_TAGS {
        ID project_id PK, FK
        ID tag_id PK, FK
        number sort_order
    }
    CUSTOMER_TAGS {
        ID customer_id PK, FK
        ID tag_id PK, FK
        number sort_order
    }
    LEGACY_PROJECT_HISTORY {
        ID id PK
        ID project_id FK
        ID source_import_item_id FK
    }
    PROJECT_RISKS {
        ID id PK
        ID project_id FK
        string content
        ID actor_id FK
    }
    PROJECT_CHANGES {
        ID id PK
        ID project_id FK
        string source
        ID actor_id FK
    }
    SCHEDULE_CHANGES {
        ID id PK
        ID project_id FK
        string kind
        ID actor_id FK
    }
    PROJECT_CHECKS {
        ID id PK
        ID project_id FK
        ID actor_id FK
        ID rule_version FK
    }
    AUDIT_LOG {
        ID id PK
        ID actor_id FK
        string actor_display_name
        ID project_id FK
    }
    USER_PREFERENCES {
        ID user_id PK, FK
        string device_key PK
        string scope PK
        number version
    }
    PROJECT_DRAFTS {
        ID id PK
        ID user_id FK
        ID project_id FK
        string client_draft_id
        ID base_version
        number draft_version
        string state
    }
    MEETINGS {
        ID id PK
        string title
        string state
        ID created_by FK
        number version
    }
    REPORTS {
        ID id PK
        ID created_by FK
        ID meeting_id FK
    }
    IMPORT_BATCHES {
        ID id PK
        string source_hash
        string source_file_ref
        ID created_by FK
        ID current_handler_id FK
        number version
    }
    IMPORT_ITEMS {
        ID id PK
        ID batch_id FK
        string item_kind
        ID target_project_id FK
        ID corrected_by FK
        ID reviewed_by FK
    }
    FEEDBACK_ENTRIES {
        ID id PK
        string type
        string author_text
        ID created_by FK
        ID source_import_item_id FK
        number version
    }
    COMMAND_RECEIPTS {
        ID actor_id PK, FK
        string command_scope PK
        string idempotency_key PK
    }
    SCHEMA_MIGRATIONS {
        string version PK
        string checksum
        datetime applied_at
    }
```

图中列出全部首版实体，每个框只省略部分普通字段以保持可读；第 1 节定义旧数据的完整迁移范围。报告快照不依赖项目日后的存活或名称，因此不强制画成实时项目外键。

## 3. 首版完整物理字段字典（施工设计，未建表）

本节与图源共同构成当前唯一数据模型。原 37 实体中合并四个重复/单例结构、暂不建 jobs，再补两张必需技术表，收敛为 **34 张表**。表数不作为验收目标；每张表需证明职责、字段来源、读写路径及删除后损失的能力。不能声称每张表只有一种表达方式。

### 3.1 类型、空值与默认

- `I` = BIGINT UNSIGNED；作为独立 `id` 主键及 check_rule_revisions.version 时由 MySQL AUTO_INCREMENT 分配（system_configuration 单例除外）。外键符号/宽度一致，API ID 使用十进制字符串，避免 JavaScript 精度损失。
- `R` = BIGINT UNSIGNED，NOT NULL，初值 1；`N` = INT UNSIGNED，`S` = SMALLINT UNSIGNED；计数/序号非负。`D` = DATE；`T` = DATETIME(3)，连接与写入统一 UTC，业务日按 Asia/Shanghai 解释。
- `Vn` = VARCHAR(n)；`X` = TEXT；`J` = JSON；`H` = BINARY(32)（SHA-256 原始摘要）；`U` = CHAR(36) ASCII 精确比较的 UUID；`DEC` = DECIMAL(12,3)。
- 尾缀 `?` 表示允许 NULL，默认 NULL；其余 NOT NULL。缺失业务日期、未知创建人和未验证来源不补造。新建文本空值由服务明确填空串；JSON 写入方提供已验证对象/数组，不在数据库塞整套默认项目。
- `B` = TINYINT，CHECK 限制 0/1。enabled 首次为 1，must_change_password 为 1；manual_delayed/maintenance_enabled 新建为 0。新项目 status=proposal、priority=mid、signal=green；具体业务默认来源见 SPEC，不从通用默认推出业务通过。
- created_at/updated_at 是服务器入库/提交时间；旧时间文字保留导入原文。scope、枚举、幂等键、登录名使用 ASCII 精确比较；业务文字使用 utf8mb4。名称不能作为认证身份或资料合并键。
- 空串日期不是 DATE；未知时间不是 0000-00-00。校验拒绝或留待审，不截断超长字符串。TEXT 的 UTF-8 字节上界纳入输入校验；1 MiB 草稿容量已按 DEC-055 确认，不等同于允许任一 TEXT 超过其 SQL 容量。

### 3.2 每张表的全部首版字段与必要性

下表字段包括公共列；逗号分隔的是独立列。FK 的具体目标由第 2 节及本节约束说明给出。NULL/默认按上节，业务条件不能只靠这一字段表批准。

| 表 | 完整字段与类型 | 主键、唯一键、索引及约束 | 当前独立职责与不可省略的理由 |
|---|---|---|---|
| users | `id:I`、`login_name:V64`、`password_hash:V255`、`display_name:V128`、`enabled:B`、`must_change_password:B`、`version:R`、`created_at:T`、`updated_at:T` | PK(id)；UK(login_name)，登录名采用 ASCII 小写；enabled/must_change_password ∈ {0,1}。 | 独立身份与凭据；按登录名定位，负责关系不能替代账号。 |
| sessions | `user_id:I`、`token_hash:H`、`csrf_hash:H`、`created_at:T`、`last_seen_at:T`、`absolute_expires_at:T`、`revoked_at:T?` | PK(token_hash)；IDX(user_id,revoked_at)，IDX(absolute_expires_at)。 | 多设备会话、单独撤销及重启恢复，用户一行无法表达多个独立会话。 |
| system_configuration | `id:I`、`maintenance_user_id:I`、`full_name:V255`、`short_name:V128`、`manager_text:X`、`name_prefix:V128`、`version:R`、`updated_by:I`、`updated_at:T` | PK(id)，单例 id=1（不使用 AUTO_INCREMENT）；维护人与企业信息同一配置聚合。 | 一个公共配置入口；合并旧 company_profile，避免两个单例表互相同步。 |
| check_rule_revisions | `version:I`、`deadline_weekday:S`、`effective_week:D`、`saved_at:T`、`saved_by:I` | PK(version)，AUTO_INCREMENT修订号；CHECK(deadline_weekday BETWEEN 1 AND 7)；IDX(effective_week,version)。 | DEC-133后只保留旧检查/旧首次义务/报告的规则来源，不再追加现行截止规则，不用当前日期重算历史。 |
| projects | `id:I`、`name:V255`、`customer_id:I?`、`odm_customer_id:I?`、`product_line_id:I?`、`app_id:I?`、`group_id:I?`、`created_by:I?`、`source_import_item_id:I?`、`source_namespace:V64?`、`source_key:V128?`、`status:V16`、`version:R`、`proposed_on:D?`、`filed_on:D?`、`started_on:D?`、`original_due_date:D?`、`current_due_date:D?`、`manual_delayed:B`、`priority:V16`、`signal:V16`、`signal_note:X`、`market_expectation:X`、`status_description:X`、`status_description_updated_at:T?`、`detail_note:X`、`summary_note:X`、`chipstat_note:X`、`closure_due_date:D?`、`resume_status:V16?`、`pre_close_status:V16?`、`closure_type:V16?`、`closed_on:D?`、`closure_note:X`、`remaining_work_note:X`、`maintenance_enabled:B`、`first_check_week:D?`、`first_check_rule_version:I?`、`created_at:T`、`updated_at:T` | PK(id)；UK(source_namespace,source_key)，两个来源字段同时空或同时有值由模块校验；IDX(status,id)、IDX(customer_id,status,id)、IDX(current_due_date,id)。 | 项目聚合根、统一版本及筛选字段；两份固定页面备注并入项目；来源身份防止同库重复新增。 |
| project_responsibilities | `project_id:I`、`user_id:I`、`joined_at:T` | 联合 PK(project_id,user_id)；IDX(user_id,project_id)。 | 正式项目归属及读写授权；当前展示/邀请/退出目标按SPEC-014与5.14，不恢复项目经理填写字段，不赋予系统维护权限。与旧业务PM姓名区别，退出历史由审计承接，不复制另一份经理授权表。 |
| project_stages | `id:I`、`project_id:I`、`stage_code:V2`、`state:V16`、`planned_days:S?`、`note:X`、`started_on:D?`、`completed_on:D?`、`expected_end_on:D?` | PK(id)；UK(project_id,stage_code)，UK(project_id,id) 支持节点的同项目复合外键；七阶段完整性/前置状态在项目事务校验。 | 七阶段的独立状态、工期与实际日期；查询按 project_id 一次取七行，不把状态存在页面偏好中。 |
| project_nodes | `id:I`、`project_id:I`、`kind:V16`、`stage_id:I?`、`title:V255`、`target_date:D?`、`completed_on:D?`、`output:X`、`note:X`、`previous_node_id:I?`、`next_node_id:I?`、`x:DEC?`、`y:DEC?`、`sort_order:N`、`source_key:V128?` | PK(id)；UK(project_id,id)；IDX(project_id,kind,sort_order,id)。阶段、前后节点分别用(project_id,引用ID)复合 FK；来源 ID 非正式 PK。 | 此行是0001/0002既有列；合并两种节点，保留不同业务字段和布局，节点恢复新增列只定义于5.8，不另建连线/子节点实体。 |
| project_people | `project_id:I`、`engineer_id:I`、`role:V32`、`sort_order:N` | 联合 PK(project_id,engineer_id,role)；IDX(engineer_id,project_id)。既有DDL没有(project_id,role)单人唯一约束；旧本地pm/hwOwner/swOwner为单姓名，当前线上硬件/软件/参与人员使用多选，不能将旧字段形状当作线上人数限制。 | 业务人员角色与排序，不授予登录权限。旧pm数据保留来源、不按姓名自动授权；归属请求及正式关系分别使用5.14结构，不据本行改写已有数据或恢复旧经理填写入口。 |
| customers | `id:I`、`name:V255`、`contact:X`、`background:X`、`enabled:B`、`version:R`、`created_at:T`、`updated_at:T` | PK(id)；IDX(enabled,name,id)；名称不设未经确认的唯一约束，不按归一化名称自动合并。 | 客户背景/联系方式与 ODM 引用；不是账号或标签。 |
| engineers | `id:I`、`name:V255`、`role:V64`、`enabled:B`、`version:R`、`created_at:T`、`updated_at:T` | PK(id)；IDX(enabled,name,id)；名称不设未经确认的唯一约束，不按归一化名称自动合并。 | 业务工程师与登录账号不是同一集合，不能并入 users。 |
| product_lines | `id:I`、`name:V255`、`enabled:B`、`version:R`、`created_at:T`、`updated_at:T` | PK(id)；IDX(enabled,name,id)；名称不设未经确认的唯一约束，不按归一化名称自动合并。 | 产品线与 APP/分组具有不同选择与引用语义。 |
| apps | `id:I`、`name:V255`、`app_version:V64`、`description:X`、`enabled:B`、`version:R`、`created_at:T`、`updated_at:T` | PK(id)；IDX(enabled,name,id)；名称不设未经确认的唯一约束，不按归一化名称自动合并。 | APP 业务版本和描述；app_version 不承担并发保护。 |
| project_groups | `id:I`、`name:V255`、`enabled:B`、`version:R`、`created_at:T`、`updated_at:T` | PK(id)；IDX(enabled,name,id)；名称不设未经确认的唯一约束，不按归一化名称自动合并。 | 项目分组的独立选项与停用引用。 |
| tags | `id:I`、`name:V255`、`enabled:B`、`version:R`、`created_at:T`、`updated_at:T` | PK(id)；IDX(enabled,name,id)；名称不设未经确认的唯一约束，不按归一化名称自动合并。 | 标签身份同时供客户和项目复用。 |
| chips | `id:I`、`name:V255`、`original_model:V255`、`manufacturer:V255`、`firmware_version:V128`、`enabled:B`、`version:R`、`created_at:T`、`updated_at:T` | PK(id)；IDX(enabled,name,id)；名称不设未经确认的唯一约束，不按归一化名称自动合并。 | 芯片型号、厂商与固件资料；项目可选多颗芯片。 |
| project_chips | `project_id:I`、`chip_id:I`、`sort_order:N` | 联合 PK(project_id,chip_id)；IDX(chip_id,project_id)。 | 项目与芯片多对多，支持引用影响查询和 FK 保护。 |
| project_tags | `project_id:I`、`tag_id:I`、`sort_order:N` | 联合 PK(project_id,tag_id)；IDX(tag_id,project_id)。 | 项目标签引用；与客户标签不同目标，合成多态表会失去直接 FK。 |
| customer_tags | `customer_id:I`、`tag_id:I`、`sort_order:N` | 联合 PK(customer_id,tag_id)；IDX(tag_id,customer_id)。 | 客户标签（包含 ODM 来源标识）不能误作项目标签。 |
| legacy_project_history | `id:I`、`project_id:I`、`source_import_item_id:I`、`source_sequence:N`、`source_date_text:X`、`body:X` | PK(id)；UK(source_import_item_id,source_sequence)；IDX(project_id,source_import_item_id,source_sequence)。 | 旧混合文字历史没有可信账号/时间，独立保留来源及数组顺序；按来源分页，不能冒充新审计。 |
| project_risks | `id:I`、`project_id:I`、`content:X`、`level:V16`、`resolved:B`、`resolution:X`、`resolved_at:T?`、`actor_id:I?`、`created_at:T`、`source_key:V128?`、`sort_order:N` | PK(id)；IDX(project_id,resolved,sort_order,id)；level 与 priority 分开，旧不明日期留在原始导入项。 | 人工风险内容与解除结果，不能从灯色推导；保留原规则及人工纠正入口。 |
| project_changes | `id:I`、`project_id:I`、`source:V255`、`content:X`、`decision:V16`、`reason:X`、`actor_id:I?`、`created_at:T`、`source_key:V128?`、`sort_order:N` | PK(id)；IDX(project_id,sort_order,id)。decision 使用 accept/reject 对应原版接受/拒绝，不新增审批状态。 | 客户等业务需求变更，与系统发布日志、审计不同。 |
| schedule_changes | `id:I`、`project_id:I`、`kind:V16`、`old_date:D?`、`new_date:D?`、`reason:X`、`measures:X`、`actor_id:I?`、`created_at:T`、`source_key:V128?` | PK(id)；IDX(project_id,id)。有效改期与说明分开；未来日期可作计划，实际日期约束不套到计划。 | 计划变化的业务记录与说明；不能从项目一个当前日期还原历史。 |
| project_checks | `id:I`、`project_id:I`、`actor_id:I`、`checked_at:T`、`week_start:D?`、`conclusion:V16`、`note:X`、`rule_version:I?`、`observed_version:I`、`result_version:I` | PK(id)；既有IDX(project_id,week_start,id)、IDX(week_start,project_id,id)保留。不设project/week唯一；0005仅将两个旧依据列改可空，见5.12。 | 检查事实及核对版本；新检查不写周/规则，旧非空值保留来源，不能从浏览或普通保存推定检查。 |
| audit_log | `id:I`、`actor_id:I?`、`actor_display_name:V128`、`actor_kind:V16`、`action:V64`、`entity_type:V32`、`entity_id:I?`、`project_id:I?`、`version_before:I?`、`version_after:I?`、`before_json:J`、`after_json:J`、`request_id:V64`、`created_at:T` | PK(id)；IDX(project_id,id)、IDX(entity_type,entity_id,id)；actor_kind 区分可信 user 和受控 system，不写密码/会话哈希。 | 业务提交、纠错、回退和维护的追加证据；当前状态描述的修改历史直接由本表生成，撤掉重复 status_updates 表。 |
| user_preferences | `user_id:I`、`device_key:V36`、`scope:V96`、`value_json:J`、`version:R`、`updated_at:T` | 联合 PK(user_id,device_key,scope)；device_key=global 表示账号偏好，其余为随机设备标识；scope 白名单。 | 账号偏好、设备阅读位置及本人导入选择分别 scope，避免增加每页状态表和 selected_by 的共享选择列。 |
| project_drafts | `id:I`、`user_id:I`、`project_id:I?`、`client_draft_id:U`、`form_kind:V32`、`base_version:I?`、`draft_version:R`、`client_sequence:I`、`payload_json:J`、`state:V16`、`submitted_project_version:I?`、`created_at:T`、`updated_at:T` | PK(id)；UK(user_id,client_draft_id)；IDX(user_id,state,updated_at,id)、IDX(user_id,project_id,state,id)。 | 私人未提交输入、独立修订及迟到请求保护；不能并入正式项目或用偏好表承载业务底稿。 |
| meetings | `id:I`、`title:V255`、`state:V16`、`started_at:T`、`ended_at:T?`、`elapsed_ms:I`、`resumed_at:T?`、`minutes:X`、`project_ids_json:J`、`created_by:I`、`version:R`、`updated_at:T` | PK(id)；IDX(created_by,state,id)。state 沿用 running/paused/finished；project_ids_json 是有序去重 ID 数组，保存时验证项目存在。 | 会议计时/正文独立生命周期；有限项目范围留在本记录，不为当前无查询需求的会议成员另建表。 |
| reports | `id:I`、`created_by:I`、`meeting_id:I?`、`format:V16`、`scope_json:J`、`source_versions_json:J`、`snapshot_schema_version:S`、`snapshot_json:J`、`status:V16`、`artifact_ref:V512?`、`artifact_sha256:H?`、`artifact_bytes:I?`、`created_at:T` | PK(id)；IDX(created_by,id)、IDX(meeting_id,id)。快照创建后不改；ready 需可下载，文件字段同时齐备或为空。 | 所选范围/字段和当时事实的固定输出；不能用一个 data_version 冒充多个项目/设置版本。 |
| import_batches | `id:I`、`source_hash:H`、`source_file_ref:V512`、`source_bytes:I`、`source_schema_version:V32`、`source_app_version:V32?`、`exported_at_text:V128?`、`source_namespace:V64`、`mapping_json:J`、`created_by:I`、`current_handler_id:I`、`version:R`、`created_at:T` | PK(id)；IDX(source_hash,id)、IDX(current_handler_id,id)。原文件不可变；批次总体结果由 items 汇总，不再存可独立失真的 result_json/status。 | 文件来源、原上传人、当前处理权和映射，不能复制到每张卡片。 |
| import_items | `id:I`、`batch_id:I`、`item_kind:V32`、`source_sequence:N`、`source_key:V128?`、`target_project_id:I?`、`expected_project_version:I?`、`review_version:R`、`source_payload_json:J`、`corrected_payload_json:J?`、`validation_json:J`、`corrected_by:I?`、`corrected_at:T?`、`reviewed_by:I?`、`reviewed_at:T?`、`status:V16`、`result_json:J?` | PK(id)；UK(batch_id,item_kind,source_sequence)；IDX(batch_id,status,id)、IDX(target_project_id,status,id)。来源 ID 不唯一也须能保留待审，不能在上传时丢掉重复来源。 | 卡片原值、人工修正、版本和逐项结果；pending/committed，失败仍待审，个人选择归 preferences。 |
| feedback_entries | `id:I`、`type:V16`、`author_text:V128`、`reported_on:D?`、`content:X`、`created_by:I?`、`source_import_item_id:I?`、`created_at:T`、`version:R` | PK(id)。type 沿用 bug/suggestion；手填作者与可信创建身份分别保存。 | 原版 Bug/建议是系统级内容，不能放到某个项目风险中；不增处理审批流程。 |
| command_receipts | `actor_id:I`、`command_scope:V96`、`idempotency_key:V128`、`request_hash:H`、`response_code:S`、`response_json:J`、`committed_at:T` | 联合 PK(actor_id,command_scope,idempotency_key)。scope/key 使用 ASCII 精确比较；业务 ID 与版本保存在 response_json，不再重复列。 | 断线或响应丢失后确认真实提交、防止重试新建重复项目；回执与业务/审计同事务，登录和自动草稿不写本表。 |
| schema_migrations | `version:V64`、`checksum:H`、`applied_at:T` | PK(version)，version 精确比较；同版本 checksum 不同停止执行。 | 数据库结构版本及迁移校验；应用版本或 Git 提交不能替代 schema 执行事实。 |

### 3.3 字段来源和生命周期

- **B/C 业务字段**：第 1 节的旧字段反推是来源清单，逐字段映射到本节；源名称与最终列名可不同，原值完整保留于导入源文件/卡片。工程字典不是已存在数据的证明。
- **T 用户确认字段**：认证与会话、负责关系、统一版本、阶段独立状态/实际日期、计划历史、检查依据、审计、偏好、草稿、待审卡片等，对应 SPEC-001～009/014～019。不能增加未确认业务自动化。
- **T 工程字段**：主键、排序、版本、来源键、哈希、提交回执和迁移校验，分别为稳定关联、保留原数组顺序、阻止覆盖、导入对账、防重复和可恢复升级服务。每个新增工程字段必须能指向这里的一条真实用途；没有消费者不建。
- 普通保存不传原始来源、actor、created_at 或 version 新值；后端生成并限制可写列。app_version 是原 APP 资料的业务版本，apps.version 才是资料并发版本。
- sessions.last_seen_at 用于空闲期限，仅由服务器接受的有效活动推进；期限归 SPEC-001/DEC-054。旧每 5 分钟更新建议已在 F03 讨论中重新收敛，活动分类、精度和实现方式引用 SPEC-001/执行文档，不在 ERD 独立规定。SQL 字段存在不代表期限校验已实现。
- check_rule_revisions 不再同时保存 id 与相同含义的 version；以 version 为主键。project_checks.week_start、projects.first_check_week/first_check_rule_version 是可复核的业务周期及原始规则依据。首次正式启动事务依据服务器该次保存时间固定应检周与当时规则版本，与业务started_on分别保存；之后不能按最新截止反推，历史不明可空并待审。准确建立与生效行为只归SPEC-005/019、DEC-093。
- audit_log 保存变化所需的旧值/新值及涉及子记录快照，不在每次保存中复制未变的整项目；敏感凭据不进审计。来源旧历史独立分页，不混成可信审计。
- import_batches 只保存来源/权属/映射；批次状态与成功数由逐项结果汇总。import_items.source_payload_json 不可变，corrected_payload_json 只保存待审修正；原文件保留原始字节与哈希，涵盖未知字段和浏览器配置。

### 3.4 逐字段用途审查

下表逐列回答“删除会损失什么”；SQL 类型/空值只维护于第 3.2 节，读写模块见第 5.3 节和架构。已列明用途不等于已通过 MySQL 实测。逐列读写路径及未执行标记由本文派生到[设计核查证据](../evidence/2026-09-30-data-model-design-check.json)，不得独立修改证据以改变模型。表数和字段数是核查计数，不是不可变产品目标。

| 字段 | 当前保留用途 / 删除后损失 |
|---|---|
| users.id | 稳定对象标识；供关联、定位及游标使用 |
| users.login_name | 认证查找键；只改名称不改账号 ID |
| users.password_hash | 验证密码的单向摘要；不存明文、不进审计 |
| users.display_name | 显示操作人与编辑者；不作为授权键 |
| users.enabled | 停用开关；保留旧引用，同时禁止新选或登录 |
| users.must_change_password | 首次认证受限标志；重启不能绕过强制改密 |
| users.version | 聚合并发修订；旧页面不能覆盖新提交 |
| users.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| users.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| sessions.user_id | 归属账号；限定会话、授权或本人私有数据 |
| sessions.token_hash | 会话主键及验证摘要；数据库不存原始登录令牌 |
| sessions.csrf_hash | 写请求防伪校验摘要；与登录令牌区分 |
| sessions.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| sessions.last_seen_at | 空闲期限依据；活动记录节流，避免每次读请求写库 |
| sessions.absolute_expires_at | 绝对到期边界；活动不能无限延长会话 |
| sessions.revoked_at | 已撤销事实；退出/停用后旧令牌不能恢复 |
| system_configuration.id | 唯一公共配置行 id=1；不自动生成多公司配置 |
| system_configuration.maintenance_user_id | 唯一指定账号及系统维护账号；DEC-132后不是共享基础资料/企业信息维护的授权条件 |
| system_configuration.full_name | 企业完整名称；资料页面与历史输出消费 |
| system_configuration.short_name | 企业简称；页面和纪要展示 |
| system_configuration.manager_text | 负责人展示文字；原值保留，不当认证身份 |
| system_configuration.name_prefix | 原名称前缀；原版创建/展示字段消费 |
| system_configuration.version | 聚合并发修订；旧页面不能覆盖新提交 |
| system_configuration.updated_by | 配置最后提交人；维护页面与审计核对 |
| system_configuration.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| check_rule_revisions.version | 旧规则修订主键；保留与旧检查及旧首次义务的来源关联，不再追加现行修订 |
| check_rule_revisions.deadline_weekday | 旧截止星期来源；不参与现行判定或设置 |
| check_rule_revisions.effective_week | 旧修订所属自然周；保留历史，不重写旧检查或固定报告 |
| check_rule_revisions.saved_at | 设置保存事实；区分同周先后修改 |
| check_rule_revisions.saved_by | 可信设置提交人；追溯规则更改 |
| projects.id | 稳定对象标识；供关联、定位及游标使用 |
| projects.name | 业务显示名称；供选择、搜索、纠正与输出，不充当身份 |
| projects.customer_id | 客户资料引用；支撑筛选、标签或引用影响 |
| projects.odm_customer_id | ODM 客户引用；与项目客户分别选择及展示 |
| projects.product_line_id | 产品线引用；看板分类和筛选 |
| projects.app_id | APP 资料引用；详情与输出 |
| projects.group_id | 项目分组引用；保存分组及筛选 |
| projects.created_by | 创建操作身份；供归属和权限核对，旧身份未知可空 |
| projects.source_import_item_id | 原始待审来源；回溯导入原值和映射结果 |
| projects.source_namespace | 来源库身份；与 source_key 一起防重复导入 |
| projects.source_key | 原项目 ID；与来源库共同绑定正式项目 |
| projects.status | 提案/进行/暂缓/结案生命周期；限制允许动作 |
| projects.version | 聚合并发修订；旧页面不能覆盖新提交 |
| projects.proposed_on | 提案日期；DEC-108明确日期未知纠错复用NULL，规则归SPEC-003 |
| projects.filed_on | 立项日期；DEC-108明确日期未知纠错复用NULL，规则归SPEC-003 |
| projects.started_on | 实际启动日；日期未知用NULL，启动事实仍由status/原审计表达，校验归SPEC-003 |
| projects.original_due_date | 原始计划事实；与当前计划/改期次数分开。DEC-097明确误录纠正可置空，原值留审计；导入原始未知不能被新当前计划填成已知 |
| projects.current_due_date | 当前有效计划；全页面一致计算当前超期。DEC-097明确纠正为未定时置空，遗漏/补说明不清空；查询不从历史最后一条重算该列 |
| projects.manual_delayed | 0001既有旧人工延期列；DEC-098取消其目标业务用途，当前实际列尚在，退出次序见5.7；不再补新写入口或参与超期 |
| projects.priority | 人工紧急程度；排序与重点项目消费 |
| projects.signal | 人工红黄绿；展示与筛选，不由日期自动重写 |
| projects.signal_note | 人工灯色说明；解释选色 |
| projects.market_expectation | 市场预期原文；详情与纪要字段 |
| projects.status_description | 当前多行进展描述；历史由审计读取 |
| projects.status_description_updated_at | 描述最近业务更新时刻；旧值需可验证，不冒充服务器审计 |
| projects.detail_note | 项目详情备注；保留原版独立说明 |
| projects.summary（0004增量） | 1051独立项目简介；类型、来源与旧值保护见5.11；隔离库验证范围见P04-02报告，常驻及线上未升级 |
| projects.summary_note | 状态纪要中的项目共享备注；受同一项目版本保护 |
| projects.chipstat_note | 芯片统计中的项目共享备注；不覆盖纪要备注 |
| projects.closure_due_date | 当前有效结案的计划快照；普通改期不重写。按PROP-011建议重开后置空，旧结果从追加结案/更正审计读取；导入缺失快照保持未知，不能取今日计划补造 |
| projects.resume_status | 暂缓前状态；恢复时不能猜成进行中 |
| projects.pre_close_status | 当前有效结案前状态；本次重开消费后按PROP-011建议置空。来源暂缓时保留resume_status供后续恢复；旧来源未知不根据进度推断 |
| projects.closure_type | 当前有效的人工正常/终止类别；重开后建议置空，旧类别及更正留审计；导入无依据可未知，进度不代替类型 |
| projects.closed_on | 当前有效实际结案日；DEC-108明确未知纠错用NULL且保留结案事实，SPEC-004消费待核对结果；重开清空与未知纠错意图由审计区分。DEC-096保留原历史日期，入库时间不替代 |
| projects.closure_note | 当前有效结案说明；重开后建议空字符串（现有列NOT NULL），原文及更正保留审计，不覆盖普通项目备注 |
| projects.remaining_work_note | 当前结案遗留处置说明；重开后建议空字符串并保留历史，节点/风险等原记录继续存在，不因清除结案投影删除 |
| projects.maintenance_enabled | 量产维护开关；不误重启研发阶段 |
| projects.first_check_week | 旧首次应检周来源；DEC-133后不再创建或消费当前义务，既有值保留 |
| projects.first_check_rule_version | 旧首次义务规则引用；保留FK及旧值，不再参与现行启动/检查前置 |
| projects.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| projects.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| project_responsibilities.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_responsibilities.user_id | 归属账号；限定会话、授权或本人私有数据 |
| project_responsibilities.joined_at | 加入负责范围时间；用于责任呈现，不替代退出审计 |
| project_stages.id | 稳定对象标识；供关联、定位及游标使用 |
| project_stages.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_stages.stage_code | 固定七阶段身份；项目内唯一，不靠展示名称匹配 |
| project_stages.state | locked/ready/active/completed；串行推进真实依据 |
| project_stages.planned_days | 该阶段计划工期；计划展示与原版计划计算 |
| project_stages.note | 该对象的业务说明；供详情/检查阅读与明确保存 |
| project_stages.started_on | 实际开始日；DEC-108明确未知纠错用NULL，真实开始由state/审计保持，校验归SPEC-003 |
| project_stages.completed_on | 实际完成日；DEC-108明确未知纠错用NULL，完成事实/进度仍取state，不从日期非空推断阶段已完成 |
| project_stages.expected_end_on | 既有独立阶段计划列，原值保留供迁移核对；DEC-119目标中的当前预计完成日改为从project_nodes.target_date及stage_id关系派生，行为归SPEC-003，不再形成第二份可编辑计划。既有列尚未迁移，不能把当前结构描述为已实现新来源 |
| project_nodes.id | 稳定对象标识；供关联、定位及游标使用 |
| project_nodes.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_nodes.kind | 项目/客户节点类别；复用表并保留不同业务字段 |
| project_nodes.stage_id | 可选阶段归属；复合外键阻止跨项目引用 |
| project_nodes.title | 节点名称；详情流程图与输出 |
| project_nodes.target_date | 节点计划日；区别实际完成日 |
| project_nodes.completed_on | 当前实际完成日；NULL表示未完成，完成前置及明确依赖纠错规则引用SPEC-005/DEC-103/105，原完成由追加审计保留 |
| project_nodes.output | 节点成果原文；返工不丢既有成果 |
| project_nodes.note | 该对象的业务说明；供详情/检查阅读与明确保存 |
| project_nodes.previous_node_id | 直接前置节点引用；保留原双向链路，按SPEC-005参与完成前置校验，不由阶段或显示顺序代填 |
| project_nodes.next_node_id | 下一节点引用；渲染连线及双向校验 |
| project_nodes.x | 人工节点横坐标；刷新后布局不丢 |
| project_nodes.y | 人工节点纵坐标；与横坐标组成位置 |
| project_nodes.sort_order | 来源或人工排列顺序；读取不能依赖数据库返回顺序 |
| project_nodes.source_key | 旧数组类别/对象ID的来源定位，原始值在受控来源保持；项目/客户数组同为1不能合并为正式ID1，按项目+kind+来源映射，正式ID由MySQL分配 |
| project_people.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_people.engineer_id | 业务人员资料引用；支撑分工及改名影响 |
| project_people.role | PM/软硬件负责/参与分工；单人角色与多人参与分别校验 |
| project_people.sort_order | 来源或人工排列顺序；读取不能依赖数据库返回顺序 |
| customers.id | 稳定对象标识；供关联、定位及游标使用 |
| customers.name | 业务显示名称；供选择、搜索、纠正与输出，不充当身份 |
| customers.contact | 客户联系方式原文；资料维护与查看 |
| customers.background | 客户背景原文；资料维护与查看 |
| customers.enabled | 停用开关；保留旧引用，同时禁止新选或登录 |
| customers.version | 聚合并发修订；旧页面不能覆盖新提交 |
| customers.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| customers.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| engineers.id | 稳定对象标识；供关联、定位及游标使用 |
| engineers.name | 业务显示名称；供选择、搜索、纠正与输出，不充当身份 |
| engineers.role | 业务分工；供资料选择/人员呈现，不授予账号权限 |
| engineers.enabled | 停用开关；保留旧引用，同时禁止新选或登录 |
| engineers.version | 聚合并发修订；旧页面不能覆盖新提交 |
| engineers.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| engineers.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| product_lines.id | 稳定对象标识；供关联、定位及游标使用 |
| product_lines.name | 业务显示名称；供选择、搜索、纠正与输出，不充当身份 |
| product_lines.enabled | 停用开关；保留旧引用，同时禁止新选或登录 |
| product_lines.version | 聚合并发修订；旧页面不能覆盖新提交 |
| product_lines.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| product_lines.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| apps.id | 稳定对象标识；供关联、定位及游标使用 |
| apps.name | 业务显示名称；供选择、搜索、纠正与输出，不充当身份 |
| apps.app_version | APP 的业务版本号；不承担并发修订 |
| apps.description | APP 资料说明；保留原字段及展示 |
| apps.enabled | 停用开关；保留旧引用，同时禁止新选或登录 |
| apps.version | 聚合并发修订；旧页面不能覆盖新提交 |
| apps.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| apps.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| project_groups.id | 稳定对象标识；供关联、定位及游标使用 |
| project_groups.name | 业务显示名称；供选择、搜索、纠正与输出，不充当身份 |
| project_groups.enabled | 停用开关；保留旧引用，同时禁止新选或登录 |
| project_groups.version | 聚合并发修订；旧页面不能覆盖新提交 |
| project_groups.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| project_groups.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| tags.id | 稳定对象标识；供关联、定位及游标使用 |
| tags.name | 业务显示名称；供选择、搜索、纠正与输出，不充当身份 |
| tags.enabled | 停用开关；保留旧引用，同时禁止新选或登录 |
| tags.version | 聚合并发修订；旧页面不能覆盖新提交 |
| tags.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| tags.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| chips.id | 稳定对象标识；供关联、定位及游标使用 |
| chips.name | 业务显示名称；供选择、搜索、纠正与输出，不充当身份 |
| chips.original_model | 原始芯片型号；保留迁移和选芯资料 |
| chips.manufacturer | 芯片厂商；资料与统计字段 |
| chips.firmware_version | 固件版本；原资料与项目输出消费 |
| chips.enabled | 停用开关；保留旧引用，同时禁止新选或登录 |
| chips.version | 聚合并发修订；旧页面不能覆盖新提交 |
| chips.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| chips.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| project_chips.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_chips.chip_id | 芯片资料引用；供项目选芯与统计反查 |
| project_chips.sort_order | 来源或人工排列顺序；读取不能依赖数据库返回顺序 |
| project_tags.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_tags.tag_id | 标签资料引用；供项目/客户分类及引用保护 |
| project_tags.sort_order | 来源或人工排列顺序；读取不能依赖数据库返回顺序 |
| customer_tags.customer_id | 客户资料引用；支撑筛选、标签或引用影响 |
| customer_tags.tag_id | 标签资料引用；供项目/客户分类及引用保护 |
| customer_tags.sort_order | 来源或人工排列顺序；读取不能依赖数据库返回顺序 |
| legacy_project_history.id | 稳定对象标识；供关联、定位及游标使用 |
| legacy_project_history.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| legacy_project_history.source_import_item_id | 原始待审来源；回溯导入原值和映射结果 |
| legacy_project_history.source_sequence | 原数组或条目顺序；保留重复来源而不丢数据 |
| legacy_project_history.source_date_text | 旧历史日期原文；不造 UTC 或可信操作时间 |
| legacy_project_history.body | 旧历史正文；按原序展示、可核对原备份 |
| project_risks.id | 稳定对象标识；供关联、定位及游标使用 |
| project_risks.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_risks.content | 业务内容原文；供对应页面编辑与报告消费 |
| project_risks.level | 人工风险等级；供风险展示，与灯色和优先级分开 |
| project_risks.resolved | 人工解除状态；不由灯色自动关闭 |
| project_risks.resolution | 人工解除/处理说明；保留可纠正结果 |
| project_risks.resolved_at | 可信解除时刻；旧未知为空而不补造 |
| project_risks.actor_id | 新风险最初正式录入的可信账号，后续解除/纠错不覆盖；旧未知保持空。解除/撤销及更正实际人按PROP-017沿目标审计读取，不从业务姓名推断 |
| project_risks.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| project_risks.source_key | 旧对象 ID 原值；用于迁移定位及对子记录核对 |
| project_risks.sort_order | 来源或人工排列顺序；读取不能依赖数据库返回顺序 |
| project_changes.id | 稳定对象标识；供关联、定位及游标使用 |
| project_changes.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_changes.source | 需求变更来源文字；原版详情消费 |
| project_changes.content | 业务内容原文；供对应页面编辑与报告消费 |
| project_changes.decision | 原版接受/拒绝决定；不扩展审批状态 |
| project_changes.reason | 人工原因；供变更或计划历史的解释及纠错 |
| project_changes.actor_id | 最初正式录入变更的可信账号，纠正决定/文字不覆盖；旧未知保持空，更正实际人留目标审计 |
| project_changes.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| project_changes.source_key | 旧对象 ID 原值；用于迁移定位及对子记录核对 |
| project_changes.sort_order | 来源或人工排列顺序；读取不能依赖数据库返回顺序 |
| schedule_changes.id | 稳定对象标识；供关联、定位及游标使用 |
| schedule_changes.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| schedule_changes.kind | 调整日期或补充说明；补说明不能清空当前计划。沿PROP-012保留原业务类型，有效纠正/撤销从关联审计读取，不能按原行数统计实际改期 |
| schedule_changes.old_date | 调整前有效日期；历史对账 |
| schedule_changes.new_date | 调整后日期；解释提前/延期且允许未知 |
| schedule_changes.reason | 人工原因；供变更或计划历史的解释及纠错 |
| schedule_changes.measures | 计划调整的措施说明；原版延期记录消费 |
| schedule_changes.actor_id | 可信操作身份；历史未知保持空，不从业务姓名推断 |
| schedule_changes.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| schedule_changes.source_key | 旧对象 ID 原值；用于迁移定位及对子记录核对 |
| project_checks.id | 稳定对象标识；供关联、定位及游标使用 |
| project_checks.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_checks.actor_id | 实际保存检查的可信账号，现有列NOT NULL；旧检查人未知不生成本表记录，只保留来源，不从业务姓名推断 |
| project_checks.checked_at | 服务器实际检查时间；今日事实使用上海业务日边界，不能由客户端补录，不再判断按时/晚查 |
| project_checks.week_start | 0005后可空；新检查NULL，旧归属周仅保留来源，不新增本周检查义务 |
| project_checks.conclusion | 显式检查结论；不是普通保存自动生成 |
| project_checks.note | 该对象的业务说明；供详情/检查阅读与明确保存 |
| project_checks.rule_version | 0005后可空；新检查NULL，旧非空规则引用及FK保留来源 |
| project_checks.observed_version | 检查核对的项目版本；并发时拒绝过期事实 |
| project_checks.result_version | 检查保存后的版本；最近一次有效检查与当前项目版本比较是否后来有更新，不再限定本周，避免检查自己的提交误报 |
| audit_log.id | 稳定对象标识；供关联、定位及游标使用 |
| audit_log.actor_id | 可信操作身份；历史未知保持空，不从业务姓名推断 |
| audit_log.actor_display_name | 操作人姓名快照；改名后历史称谓保留 |
| audit_log.actor_kind | user/system 来源类型；受控恢复与人工操作区分 |
| audit_log.action | 明确动作类别；历史筛选与纠错解释 |
| audit_log.entity_type | 受影响实体类型；非项目公共维护也可追溯 |
| audit_log.entity_id | 受影响实体标识；与类型共同定位历史 |
| audit_log.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| audit_log.version_before | 提交前版本；并发和纠错证据 |
| audit_log.version_after | 提交后版本；回读及版本链证据 |
| audit_log.before_json | 本次变更旧值；不复制未变整项目、不记录凭据 |
| audit_log.after_json | 本次变更新值；形成准确变更对照 |
| audit_log.request_id | 服务请求关联号；定位异常与一次提交 |
| audit_log.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| user_preferences.user_id | 归属账号；限定会话、授权或本人私有数据 |
| user_preferences.device_key | 账号全局或随机设备身份；设备位置不能互相覆盖 |
| user_preferences.scope | 白名单页面/偏好范围；小粒度更新与隔离 |
| user_preferences.value_json | 当前范围的个人状态；禁止放正式共享业务或令牌 |
| user_preferences.version | 聚合并发修订；旧页面不能覆盖新提交 |
| user_preferences.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| project_drafts.id | 稳定对象标识；供关联、定位及游标使用 |
| project_drafts.user_id | 归属账号；限定会话、授权或本人私有数据 |
| project_drafts.project_id | 所属正式项目；供项目聚合读取、授权与外键隔离 |
| project_drafts.client_draft_id | 页面草稿实例 UUID；多标签/多设备不静默合并 |
| project_drafts.form_kind | 草稿表单类别；选择正确恢复/校验入口 |
| project_drafts.base_version | 草稿基于的正式项目版本；过期只能复制重核 |
| project_drafts.draft_version | 草稿自身 CAS 修订；两个请求不能相互覆盖 |
| project_drafts.client_sequence | 本页面输入序号；迟到同步不能覆盖更新输入 |
| project_drafts.payload_json | 本人未提交底稿；自动同步不改正式项目 |
| project_drafts.state | active/committed/discarded；拒绝终态后的迟到请求 |
| project_drafts.submitted_project_version | 该稿正式提交的项目版本；恢复列表区别已提交输入 |
| project_drafts.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| project_drafts.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| meetings.id | 稳定对象标识；供关联、定位及游标使用 |
| meetings.title | 会议标题；会议信息与报告来源 |
| meetings.state | 原版 running/paused/finished；计时恢复依据 |
| meetings.started_at | 会议初始启动时刻；展示来源 |
| meetings.ended_at | 明确结束时刻；未结束为空 |
| meetings.elapsed_ms | 已累计时长；暂停/继续不能由起止差推断 |
| meetings.resumed_at | 本次继续运行起点；重载后累计当前时间段 |
| meetings.minutes | 会议纪要正文；独立于项目当前进展 |
| meetings.project_ids_json | 有序参与项目范围；当前没有反向成员检索，保存校验存在性 |
| meetings.created_by | 创建操作身份；供归属和权限核对，旧身份未知可空 |
| meetings.version | 聚合并发修订；旧页面不能覆盖新提交 |
| meetings.updated_at | 最后成功提交时间；用于状态展示及恢复列表 |
| reports.id | 稳定对象标识；供关联、定位及游标使用 |
| reports.created_by | 创建操作身份；供归属和权限核对，旧身份未知可空 |
| reports.meeting_id | 可选会议来源；支持一场会议多份输出与历史定位 |
| reports.format | 输出格式；决定正确渲染/下载入口 |
| reports.scope_json | 本次所选范围及字段；历史结果按当时选择解释 |
| reports.source_versions_json | 多项目/公共设置来源版本集合；不能由单个总版本替代 |
| reports.snapshot_schema_version | 快照格式版本；升级后仍能读历史结构 |
| reports.snapshot_json | 生成时固定业务事实；改名/改项目不回写报告 |
| reports.status | 输出生成/失败/可取状态；恢复和结果入口 |
| reports.artifact_ref | 受控下载产物位置；认证后读取，禁止任意路径 |
| reports.artifact_bytes | 下载产物字节数；完整性及容量观察 |
| reports.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| import_batches.id | 稳定对象标识；供关联、定位及游标使用 |
| import_batches.source_hash | 原文件摘要；用于来源核对，不自动把重传视为已审核 |
| import_batches.source_file_ref | 受控原始文件位置；保留未知字段及原始字节 |
| import_batches.source_bytes | 原文件长度；上传完整性与备份核对 |
| import_batches.source_schema_version | 原导出结构版本；选择相应映射而不猜最新 |
| import_batches.source_app_version | 原应用版本；区分 V1.044 备份与 V1.050 源码 |
| import_batches.exported_at_text | 原导出时间文字；不替代任何项目创建时间 |
| import_batches.source_namespace | 人工明确的来源库身份；防止跨旧库同 ID 误覆盖 |
| import_batches.mapping_json | 维护确认的旧 ID/名称映射；待审项复用批次映射 |
| import_batches.created_by | 创建操作身份；供归属和权限核对，旧身份未知可空 |
| import_batches.current_handler_id | 当前批次处理人；显式接管后权限依据 |
| import_batches.version | 聚合并发修订；旧页面不能覆盖新提交 |
| import_batches.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| import_items.id | 稳定对象标识；供关联、定位及游标使用 |
| import_items.batch_id | 所属原文件批次；权限、分页与回溯 |
| import_items.item_kind | 来源实体类别；区分项目/资料/附加状态条目 |
| import_items.source_sequence | 原数组或条目顺序；保留重复来源而不丢数据 |
| import_items.source_key | 旧对象 ID 原值；用于迁移定位及对子记录核对 |
| import_items.target_project_id | 拟更新或已新增的正式项目；不按名称自动认定 |
| import_items.expected_project_version | 审查时正式版本；批量逐项拒绝旧版覆盖 |
| import_items.review_version | 待审卡片 CAS 修订；原值修正并发保护 |
| import_items.source_payload_json | 不可变解析原值；与原文件逐项对账 |
| import_items.corrected_payload_json | 候选修正副本；独立review只存候选，adopt可直接携带修正并与正式项目同次提交 |
| import_items.validation_json | 本修订预检问题及依据；不冒充正式审核通过 |
| import_items.corrected_by | 可信修正人；权限与追溯 |
| import_items.corrected_at | 修正保存时刻；恢复及核对 |
| import_items.reviewed_by | 实际入库保存人；新项目自动负责的身份依据 |
| import_items.reviewed_at | 逐项正式提交时刻；部分成功结果恢复 |
| import_items.status | pending/committed；未通过项继续待审 |
| import_items.result_json | 本项提交/冲突结果；断线重进逐项查询 |
| feedback_entries.id | 稳定对象标识；供关联、定位及游标使用 |
| feedback_entries.type | 原版 bug/suggestion；对应反馈入口 |
| feedback_entries.author_text | 手填作者原文；不冒充可信账号 |
| feedback_entries.reported_on | 原反馈日期；与服务器入库时间分开 |
| feedback_entries.content | 业务内容原文；供对应页面编辑与报告消费 |
| feedback_entries.created_by | 创建操作身份；供归属和权限核对，旧身份未知可空 |
| feedback_entries.source_import_item_id | 原始待审来源；回溯导入原值和映射结果 |
| feedback_entries.created_at | 服务器入库时间；区分来源旧日期并支撑查询排序 |
| feedback_entries.version | 聚合并发修订；旧页面不能覆盖新提交 |
| command_receipts.actor_id | 幂等回执身份键；其他账号不能读取结果 |
| command_receipts.command_scope | 动作范围键；同 UUID 不误匹配另一类动作 |
| command_receipts.idempotency_key | 同一次保存的重试标识；响应丢失不重复业务写入 |
| command_receipts.request_hash | 规范化提交摘要；同键不同输入被拒绝 |
| command_receipts.response_code | 已提交响应状态；重试返回确定结果 |
| command_receipts.response_json | 已提交结果，包括业务 ID/版本；不另存重复列 |
| command_receipts.committed_at | 真实事务提交记录时刻；回执查询与维护依据 |
| schema_migrations.version | 精确迁移版本键；与应用/Git版本分开登记 |
| schema_migrations.checksum | 已执行迁移内容摘要；发现同版本文件被回改 |
| schema_migrations.applied_at | 实际迁移执行时刻；源码存在不等于执行过 |

## 4. 实体收敛与替代方案审查

| 原候选 / 可能合并 | 首版结论 | 原因、代价及保留方式 |
|---|---|---|
| project_status_updates | 撤除 | 当前描述在 projects，可信修改在 audit_log，页面历史由审计生成；不再维护第三份同一描述 |
| project_view_notes | 合并入 projects | 只有 summary/chipstat 两个固定项目备注，且共享同一授权/version；使用 summary_note/chipstat_note，不做没有当前需求的通用视图备注实体 |
| company_profile | 合并入 system_configuration | 单公司单例，维护人和企业展示信息同一公共配置；历史输出仍快照保留 |
| meeting_projects | 撤除，范围并入 meetings.project_ids_json | 当前没有按项目统计会议成员的查询需求；范围是有限有序 ID 数组，保存校验存在性，输出范围另在 report.scope_json 冻结；此取舍放弃逐成员 SQL FK，需服务校验，若将来出现反向查询再以实测决定关联表 |
| jobs / Redis / outbox | 首版不建 | 当前普通保存、草稿和受控批次提交不需要异步任务；SSE 遗漏由版本复核补足，不伪造空任务体系 |
| users 与 engineers | 保持分开 | 登录身份、停用/改密与业务工程师资料生命周期不同，历史姓名不能授予权限 |
| responsibilities 与 people | 保持分开 | 自选修改范围是授权；PM/软硬件负责/参与人是业务分工，不能相互替代 |
| project_nodes 与 customer_nodes | 一张 project_nodes | kind 保留两种业务字段差异；项目连线/坐标与客户节点说明同属项目聚合；不另建兼容 milestones/flowLinks 表 |
| audit_log 与 legacy_project_history | 保持分开 | 新审计有可信服务器身份/版本，旧历史只有文本和来源顺序；合并会要求大量无语义空列或把旧内容误报为审计；独立表可按旧顺序分页，原始卡片仍保留完整来源 |
| 偏好、草稿与正式项目 | 三类持久结构 | 恢复位置、保护未提交文字、修改正式业务具有不同权限、版本和失败语义，不能共用“自动保存项目”入口 |
| seven reference libraries | 保留七张资料表 | 客户、工程师、芯片、APP 有实际专属字段，产品线/分组/标签有不同引用和维护语义；不采用含大量空列或任意 attributes_json 的多态资料表。简单名称表也需稳定 ID/停用/版本，三张简单表的代价是少量相同公共列 |
| project_chips/project_tags/customer_tags | 保留三张关联表 | 两种目标与两种资料均有明确多对多关系，联合唯一和 FK 直接保护引用；通用 link(entity_type,id) 将失去直接数据库外键 |
| reports 与 meetings | 保持分开 | 活动计时可更新，已生成输出依据不可更新；合并无法表达一场会议多份不同范围/格式输出及历史下载 |
| import_batches 与 import_items | 保持分开 | 上传来源/处理人是一批属性，纠正/冲突/结果是逐项属性；合并不利于持久审查和部分成功 |
| command_receipts 与 audit_log | 保持分开 | 回执唯一键供断线重试确定返回结果；审计供追加追溯。不能从审计文字猜幂等结果，也不为自动草稿写业务回执 |
| sessions.id、command_receipts.id | 撤除 | 会话按 token_hash 定位/撤销，回执按身份/动作/幂等键定位；没有独立数字 ID 的消费者，直接使用现有唯一标识作 PK |
| command_receipts.resource_type/resource_id/result_version | 撤除重复列 | 本次确认的结果只按幂等键回读，业务对象及版本已在 response_json；没有按这些列检索的需求，不维护第二份结果 |
| projects/feedback_entries.deleted_at | 首版不建 | 回收站仍未确认，首版不提供删除项目入口；恢复方案明确后再做兼容迁移，不能为了猜测需求预置字段 |
| schema_migrations 与 Git 版本 | 保留迁移登记 | Git 提交存在不等于对应 schema 已执行；迁移校验防止回改已执行文件 |

“不可替代性”在本项目指删除/合并是否损失当前确认的职责或使约束明显更弱，不指数据库只能有一种建模方式。若实际测量证明可合并且不损失能力，仍可再收敛；不能为固定表数保留结构。

## 5. 约束、事务与性能核验

### 5.1 SQL 与业务模块各自负责

- MySQL 负责 PK、联合唯一、真实 FK、类型范围、可确定的本行枚举/布尔 CHECK。外键默认阻止破坏引用，账号/资料不物理删除。FK 的父键必须是明确主键/唯一键，特别是同项目节点与阶段的复合键。
- 项目事务负责七行阶段完整性、前阶段完成、启用负责人数、来源映射正确、节点连线双向一致及完成前置/明确影响集合（SPEC-005）、资料类型与启用状态、实际日期不在未来及权限。以上跨行、身份或当前时间约束不能假装是普通 CHECK。
- 节点跨项目关系通过复合FK阻止；自连/双向修正及DEC-106循环检验由模块校验；客户节点不强加阶段和链路。DEC-107恢复目标表达见5.8，删除状态不是普通FK能检验的有效引用，模块须拒绝指向已删除节点；0003已按5.8仅新增可空列并接有效过滤，删除恢复固定两端沿5.8实际验证，运行状态归系统真相。不新增节点驱动阶段或自动消除风险。
- 项目状态 code：proposal/ongoing/paused/closed；priority 与风险 level：high/mid/low；灯色 green/yellow/red；阶段 locked/ready/active/completed；结案 normal/terminated；计划记录 reschedule/note；检查 checked/follow_up；草稿 active/committed/discarded。显示文案与旧值映射由已确认 SPEC/旧源码决定；不能把旧非法值静默当合法默认。
- 原版 changes 接受/拒绝、会议 running/paused/finished、feedback bug/suggestion 已由源码核查；首版不增审批队列。历史导入允许已完成阶段缺实际日期、旧创建身份未知；新动作的必填限制按 SPEC，不写一条会拒绝真实遗留数据的全表 CHECK。
- 项目软删除/回收站恢复列已从首版移除，会议修改权限、草稿清理等未确认体验不能由字段存在推定获准；开通前按规格标明候选并确认。首版不开物理删除项目/账号/被引用资料的入口。

### 5.2 完整保存和重试

1. 会话认证、输入白名单与格式校验；同用户/动作/幂等键先查已提交回执，同键不同规范化请求摘要拒绝。
2. 开始短事务，按稳定顺序锁定需要校验的账号/批次及项目聚合根；项目统一 expectedVersion 约束。负责范围变化、子记录与检查共用同一根版本，不能只锁某个子表。
3. 写入本次明确变更、必要子记录与根版本、审计及 command_receipts；对应草稿修订终态按 SPEC-007 同事务处理。任一步失败整体回滚。
4. 提交后通知 SSE，返回实际结果；响应丢失用原幂等键确认，不换键重新新建。普通详情快照读取使用短一致性事务，不持锁等待用户。
5. 导入按项目短事务部分成功，条目结果与正式写入同事务；批次状态从已提交项派生。无项目对应时默认拟新增，可明确改对应已有；未知共享资料仍须明确选择，不能按名称自动覆盖。
6. 空账号停用、最后负责人退出、批次接管等竞态按 SPEC 做真实两用户测试。锁顺序按账号 ID、批次 ID、项目 ID 的固定次序组织；死锁回滚只允许有界同键重试，不吞掉失败后显示成功。

### 5.3 查询与索引按实际链路收敛

| 路径 | 查询/载荷策略 | 初始索引及校验 |
|---|---|---|
| 看板/筛选/统计 | 显式选择摘要列，不返回长说明、全部子记录、审计或原始 JSON；统一过滤集合；进度由七阶段统一计算 | projects 状态/客户/交期索引；先用真实查询 EXPLAIN ANALYZE，再决定组合索引是否保留 |
| 项目详情 | 根记录、七阶段及所需子表按 project_id 批量读；历史按 ID/来源顺序游标分页；不每条子记录查人员 | 子表 project_id 前缀、人员/芯片反查索引；核查无 N+1 查询 |
| 资料改名影响 | 反查外键与关联表，准确计数；保留稳定 ID | project_chips/chip_id、各项目引用列及 tag 反查索引；无需扫描所有项目 JSON |
| 草稿/偏好 | 每次仅当前 scope 或一份草稿，按本人隔离；同步去抖/节流；草稿列表不含 payload | preferences 联合 PK、drafts 的 user/state/project 索引；按实际并发规模观察多人持续输入的写入量 |
| 导入卡片 | 按批次/状态游标分页，卡片按需读原值与修正；一次已选择提交限额以测量定 | items(batch_id,status,id)；混合冲突/成功和重复请求验证；不加载整批文件供每张卡片重复解析 |
| 幂等恢复 | 唯一键一次定位回执，再核对可信身份及实际结果 | command_receipts 联合 PK；不能靠轮询全部审计猜是否保存 |
| 周检查 | 以项目及自然周找真实记录，规则按生效周/修订查询 | checks(project_id,week_start,id)、rule(effective_week,version)；跨日/修改本周不全库重写派生状态 |
| 历史输出 | 从固定 snapshot 渲染/下载，显示源版本与规则；不实时拼接已变化项目 | reports 的用户/会议索引，认证和文件哈希/大小核对 |

只为明确查询加索引，不给所有布尔/长文本/JSON 字段机械建索引。普通数据不足以显出性能差异时，补代表性增长数据再测；增加的索引必须能解释收益及额外写入成本。

### 5.4 字段与表的“实践考验”如何成立

当前证据：B 备份结构、C 实际读写与函数诊断、T 已确认目标。**本地初始 MySQL 表与完整结构已核验，实际范围见 F02/F03 报告；含数据升级、逐字段业务消费、执行计划、读写性能和多人实际使用验收仍未执行。** 禁止把“使用常见 SQL 类型”写成“字段性能已通过”。

当前已逐列登记用途与模块读写路径，共 313 列；第 1/3.3 节区分 B/C/T 来源，第 3.2 节记录空值/类型/约束。施工生成迁移时须核对列级来源映射与真实调用，没有消费者则再移除。按完整业务链路验证字段，而不是每字段各写一个浅层测试：输入 → 同事务写入 → 新请求回读 → 页面/报告消费 → 纠错/失败/并发恢复。

数据库验收必须具备：34 表的可执行迁移及 INFORMATION_SCHEMA 实际结构对照；所有 FK/唯一/NULL 边界的反例；原备份全部字段及未知原值保留对账；27 项实际规模及代表性增长规模下真实 SQL 执行计划；多人混合读写/SSE/草稿同步的 p50/p95、错误率、连接/内存/磁盘观察，并发规模按实际需求和测量确定；备份与隔离恢复后重复上述关键读取。测试设计归 TEST-032，不产生虚构通过报告。

技术边界参照 [MySQL CHECK 限制](https://dev.mysql.com/doc/refman/8.4/en/create-table-check-constraints.html)、[外键与父索引要求](https://dev.mysql.com/doc/refman/8.4/en/create-table-foreign-keys.html)。跨表和 NOW 等非确定性判断不能放在 CHECK；自增 ID 不写进 CHECK 条件。

### 5.5 邀请码注册的目标增量模型（2026-10-08，DEC-064 已确认，未迁移）

已确认多人邀请码注册、7 天及业务人数不设固定配额的行为归 SPEC-001；下面仅给出所需实体表达。现有 MySQL 仍为 0001 的 34 表/313 列/55 外键，不能改其字节或写成新表已创建。目标新增一个 registration_invites，并在 users 添加一列 registration_invite_id；不再新建重复的使用明细表。

| 目标变化 | 字段/约束 | 必要性及消费者 |
|---|---|---|
| registration_invites | id:I、code_hash:H、created_by:I、created_at:T、expires_at:T、revoked_by:I?、revoked_at:T?；PK(id)、UK(code_hash)，created_by/revoked_by → users.id；撤销两列同时空或同时有值 | 持久验证邀请码、生成/撤销历史、后台分页；明文不能重建，状态由时间/撤销派生；不存重复 status、used_count、max_uses、角色或项目范围 |
| users.registration_invite_id | I?，FK → registration_invites.id；IDX(registration_invite_id,id)；初始化/历史账号可空，新注册由服务器写入 | 同一码多个新账号的稳定来源、后台注册结果/数量；密码重置、改名、停用不改变来源，不能靠日志猜注册关系 |

目标共 35 表/321 列/58 外键，属于目标设计计数，没有实际创建证据。新版本迁移需建邀请表、增加可空来源列后补 FK，避免与 users 创建者引用的循环依赖；旧 users 保留 null，不能伪造邀请码来源。新字段/表必要性及含数据升级由 TEST-032/034 验证。

局部目标 ERD，未合入旧 0001 的图示快照：

```mermaid
erDiagram
    users ||--o{ registration_invites : creates
    users o|--o{ registration_invites : revokes
    registration_invites o|--o{ users : registration_source
    registration_invites {
        bigint id PK
        binary code_hash UK
        bigint created_by FK
        datetime created_at
        datetime expires_at
        bigint revoked_by FK
        datetime revoked_at
    }
    users {
        bigint id PK
        bigint registration_invite_id FK
    }
```

用户行不物理删除，邀请码历史保留，统计注册来源不受停用影响。源图在本节，旧派生 SVG/PNG 仍只对应已执行初始模型；没有重新渲染或验证新图。审计复用 audit_log，原文不进入 before_json/after_json 或 command_receipts 的响应。

### 5.6 测试项目共享保存的目标增量（2026-10-08，已确认、未迁移）

本节标题保留讨论时的日期和锚点；当前实现版本为 0002-trial-save，运行范围见[系统真相](../status/current-system-truth.md)。DEC-073～075 已确认临时共享范围和四项文字保存主干，DEC-076 确认本节最小模型与 W00 接入方案。已撤回的额外 actor_key/历史搬迁不恢复，复用现有作用域和操作编号；以下为 0002 的增量定义，目标为 34 表/314 列/55 外键；0001 原始资源保持 34/313/55 不变；E02 邀请码目标 5.5 继续后置，不混入此次迁移。

目标只新增一列、调整现有来源/回执约束，不新增表：

| 目标对象 | 已确认字段及约束 | 不可替代的用途及旧行处理 |
|---|---|---|
| projects.data_kind | V16，ASCII 精确比较，非空、默认 business；CHECK ∈ {business,trial} | 服务端判定当前项目是否在匿名试用范围，页面显示测试标记；既有行取 business，避免把未知/真实来源自动当测试。与 source_namespace 的导入溯源职责不同，公共保存不可修改本列 |
| audit_log.actor_kind | 原列不变，CHECK 扩展 user/system/anonymous | 准确区分可信用户、系统任务和未认证人工操作。anonymous 的空 actor_id 与“未认证操作”显示名由保存模块统一生成，本轮不增加组合来源键/检查字段 |
| command_receipts.actor_id | 改为可空，保留 users 外键；保留/显式建立 actor_id 前缀索引 | anonymous 回执留空，未来可信账号仍关联真实 users；旧 ID 原样保留。独立索引是新主键不再以 actor_id 开头后维持外键的必要支持，先建立再切主键 |
| command_receipts 主键 | 改为 (command_scope,idempotency_key) | 当前由服务器生成 anonymous:project:<id>:text 或 anonymous:project:<id>:ordinary 作用域，随机操作编号只标识本次提交；同次重试沿用。未来可信账号可在作用域中加入实际账号 ID，再与 actor_id 核对归属，不增加一列复制账号范围。scope/key/hash/result/time 类型不变 |

接入 0002 前曾核实没有旧回执或业务行；该前提不能用于后续环境，实际增量见系统真相。后续升级保留已有行；不做历史回填框架。若发现已有待保留回执，先核对其作用域再处理，不丢弃或清空。不能把可空 actor_id 继续放在主键；服务端构造 command_scope，不信任客户端自报来源/账号。操作编号用于防止重复提交，不识别人，也不是登录凭证。

本单元独立目标计数为 **34 表/314 列/55 外键**，不是实际执行结果；索引与 CHECK 清单随固定目标资源核验。未来若再接 5.5 邀请码增量，两项均采用时才合并计算，不改写此前单独目标计数。没有新增匿名 users、每人测试账号、独立匿名审计表或回执表。

局部增量 ERD（结构实现对应 0002-trial-save；实际迁移范围见系统真相）：

```mermaid
erDiagram
    users o|--o{ audit_log : trusted_actor
    users o|--o{ command_receipts : trusted_actor
    projects o|--o{ audit_log : project_history
    projects {
        bigint id PK
        varchar data_kind
        bigint version
    }
    users {
        bigint id PK
    }
    audit_log {
        bigint id PK
        bigint actor_id FK
        varchar actor_kind
        bigint project_id FK
    }
    command_receipts {
        varchar command_scope PK
        varchar idempotency_key PK
        bigint actor_id FK
        binary request_hash
        json response_json
    }
```

图中 command_receipts 与 projects 没有直接外键，项目 ID/提交版本仍在既有结果 JSON；不能为画图补一条不存在的关系。当前正式图及派生图仍对应原 0001，本节未实际创建或渲染验收。

### 5.7 旧人工延期能力退出（2026-10-09，DEC-098，未迁移）

目标正式业务不再需要projects.manual_delayed，超期由SPEC-004日期事实派生。第3节0001字段清单及既有默认/CHECK仍描述实际基线，不能因取消功能修改已经登记的0001或声称当前少了一列。

- 先改查询、共享类型、看板及其他已接入消费者，移除人工延期标签/筛选/输出和后续写白名单计划；所有超期消费者使用F07-G日期结果。未经处理的旧客户端字段不得悄悄参与新判断。
- 旧文件isDelayed留在受控原文件和不可变import_items来源JSON；正式导入不把它映射为超期、风险或信号灯。现有列若有需要保留的值，移除前以受控完整备份核对，不能静默丢弃来源。
- 实际代码不再依赖旧列后，用后续独立兼容迁移退出列及对应CHECK；先验证旧构建的回退依赖，按运维流程保留兼容窗口，不直接改0001/0002。该迁移尚未编写或执行，0002基线为34表/314列/55外键；当前0003实际结构见5.8。
- 不新增replacement延期布尔列、超期状态表或人工预警实体。结构缩减后的最终计数须以真实迁移及新连接查询报告为准。

### 5.8 节点可恢复删除与实际日期未知（2026-10-09确认；0003兼容已固定迁移，删除恢复固定两端已验）

业务范围由DEC-107/108确认，规则正文归SPEC-003/004/005；本节只定义目标字段、约束和迁移边界。原节点保留稳定ID及原字段，按PROP-019增加以下一列，不另建节点回收表：

| 新增目标列 | 类型/默认 | 唯一用途及已有行处理 |
|---|---|---|
| project_nodes.deleted_at | T?，DATETIME(3)可空，默认NULL | NULL表示有效节点，非空表示服务器正式保存删除时刻；支撑有效读取/可恢复记录列表/端点资格。已有行全部NULL，未保存占位不产生删除行；删除/恢复实际人、原因及原关系复用追加审计，不加重复操作者/恢复时刻列 |

同项目FK及原ID保持；删除时清空有效邻居引用和目标自身前/后引用，原关系留审计。恢复将删除标记置NULL，旧线不从历史自动回填；明确选择的新线按SPEC-005复核。所有节点读取/统计/端点选择必须区分有效行；已删除列表按项目请求，复用现有项目前缀索引，是否追加过滤索引依据实际SQL/延迟，不预置全局扫描和清理任务。

仅此增量接在0002后、其他增量未采用时，独立目标为**34表/315列/55外键**；本机/云端常驻两库已验证为34/315/55。新建独立兼容迁移及目标清单，禁止修改0001/0002原始字节；既有行默认有效。先安装可空列，再接有效过滤及删除/恢复能力；旧0002构建严格校验结构，0003加列后即无法健康验证；不得直接回退到旧0002或缺有效过滤的构建。应用回退须保留过滤兼容性，不能为回退清卷、物理删节点或覆盖发布后数据。独立隔离实例新库/含数据升级/DDL死亡续跑及有效查询已执行，常驻两库已固定迁移并保留原业务/两历史，D/E固定两端真实删除/恢复及已删项目索引验证见[节点恢复报告](../testing/reports/2026-10-10-project-node-recovery.md)，备份隔离恢复未验；迁移证据归[兼容报告](../testing/reports/2026-10-10-node-migration.md)，5.5邀请码及5.7旧列退出不混算为此单元。

DEC-108复用projects.proposed_on/filed_on/started_on/closed_on及project_stages.started_on/completed_on现有可空DATE列。日期未知、字段省略、动作撤销分别由有限业务意图和审计区分，状态字段表达真实动作；不增加每日期未知标记，不用特殊日期。project_nodes.completed_on的NULL仍表示未完成，本列语义不改变。现有迁移文件已观察到上述日期可空，但目标保存/查询/派生消费仍未实施或验收。

## 6. 来源映射与迁移次序

**结构边界（2026-10-26）：**下文既有实体与0006～0008实测结构继续描述实际存储；当前没有执行结构变更。新设计需要表达项目名称唯一/曾用名和归属请求，存量业务取舍已由DEC-161/162确认；字段、索引及版本化迁移尚未定稿。不能用删旧规则指令删表、改已执行SQL或抹去历史。

1. 收到原文件后校验哈希并保存受控原始字节，解析生成批次/卡片；不可变文件与对应 JSON 原值纳入完整备份，未知字段不经旧归一化器丢弃。
2. 2026-10-26目标按SPEC-009以项目名称识别新旧，取消用户选择source_namespace和来源编号决定项目的要求。原文件、原ID、数组顺序和既有对应记录保留为来源；现有项目ID、内容、历史和正式责任保留；存量重名在原项目明确改名后才启用唯一约束，不自动合并。原绑定保留历史用途，具体结构承接由新迁移落实。
3. 基础资料匹配按SPEC-009/DEC-162：同类别、名称完全一致、文件已提供信息无冲突且唯一启用时复用；明确新资料建立关联；重名、多候选、停用和内容差异集中处理。保留旧明确对应及原值，不能改写采用历史；同名业务人员不授予账号权限。
4. 七阶段按位置/旧阶段码映射，缺日期留 NULL；非法连续性报告，不能自动补完成。dueDate/延期原文与原始计划不确定性保留；旧 lastCheckAt 不生成新检查；旧混合历史按 source_sequence 原样留存，不补 actor。
5. 先创建无循环依赖的账号/资料/配置/批次表，再创建 projects（来源 FK 暂后加）、import_items、项目子表、草稿/会议/输出及审计/回执；最后补 projects.source_import_item_id 与 import_items 的循环 FK。正式新项目入库顺序为已有待审项 → 项目 → 子记录/负责关系/历史 → 待审结果，均在该项目事务完成。
6. 旧基础资料重建 ID 映射后再迁移项目关联和节点前后引用；节点先插入全部对象，再设置连线。空资料、坏引用、重复来源不因 FK 建表顺序被忽略。
7. 首次建库、含数据升级、失败中断恢复和隔离备份恢复分别执行。DDL 可能隐式提交，不声称多文件建表能靠一次 ROLLBACK 撤回；迁移逐文件验证 checksum/实际结构及恢复入口，详见[MySQL 隐式提交](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html)。

本轮交付是可审查的完整施工设计与实体必要性审查。下一步生成并验证版本化 SQL 迁移；性能与实践通过必须以真实执行报告证明，不能在讨论阶段提前标记。

## 独立本地1051结案字段补充（2026-10-09）

仅描述`geekdashdesktop/projects-data.js`的本地JSON结构，行为归SPEC-L1051；不改变服务器ERD/迁移或导入审查规则。

| 项目字段 | 本地类型与旧数据映射 |
|---|---|
| closureType | 可选字符串，completed/early；旧文件缺失时不补写，兼容显示依据见SPEC-L1051 |
| closedProgress | 可选number，0～100；新中途结案进度快照，整体结案/重开删除；旧缺失仍可派生显示 |
| stageCloseBefore | 可选对象，status/isProductionMaintenance/closeReason；当前结案前状态快照，撤销时消费，不伪造旧缺失状态 |

三个字段由原项目扩展字段保留路径进入全数据JSON，schema仍为2；不改变原stages、risks、changes或历史结构。

### 5.9 需求变更现有实体的施工核对

需求变更A/B复用第3节project_changes的10列及既有FK/CHECK/项目排序索引，不新增表或列；actor_id/created_at/source_key/sort_order保留最初来源。有效文字和人工decision/理由可改，原值与纠错人归audit_log，command_receipts保留原操作结果，不把姓名再加列。创建姓名以目标最早创建审计和PK取回；真实500规模索引验证与无DDL范围归[需求变更报告](../testing/reports/2026-10-12-project-changes.md)。34/315/55结构仍为0003现有模型；固定两端无DDL验证与部署状态见报告和系统真相。

### 5.10 P04保存范围与风险删除的增量设计

行为只归SPEC-002/003/005/007与DEC-119～121。本节定义数据表达。0004在独立MySQL实例完成新建及含数据升级验证；常驻及线上库未升级，实测范围归[P04-02报告](../testing/reports/2026-10-16-p04-02-compatibility.md)。

| 对象 | 施工设计 | 必要性与兼容 |
| --- | --- | --- |
| project_risks.deleted_at | 0004增加DATETIME(3)可空、默认NULL；NULL为有效，非空为已明确保存删除 | 使误录风险从正常列表及统计排除，同时保留原记录；最初字段及稳定ID不变，操作者/原值复用audit_log，不另造风险回收表或重复删除人列。旧记录默认有效；本增量沿用项目索引，不预先增加索引；产品删除入口仍待后续步骤 |
| project_stages.expected_end_on | 保留既有旧计划来源列；当前阶段计划在读取中按SPEC-003从有效项目节点派生 | 不把派生值反复回写成另一份可编辑事实，不自动把旧计划复制成虚构节点。旧值与计算结果的迁移对照须可复核；没有节点仍按规则未知 |
| project_drafts.form_kind / payload_json | 复用既有表，按保存范围设置有限类别；记录类别的目标ID/临时ID及输入结构版本放在受校验的payload中 | 每个实际编辑范围使用自己的client_draft_id；form_kind不拼接长记录ID。新建使用一个创建稿；范围内未修改不创建空稿，不增加每区一张表 |
| project_responsibilities / project_people | 当前经理账号使用已确认负责关系；旧pm姓名/工程师引用保留来源 | 不按姓名自动授权，不新增第二份经理权限表；原业务人员字段与账号ID分别处理，筛选和展示必须辨认来源 |

本次使用0004-project-compatibility，0001～0003已应用文件不改写；同一发布的结构清单与代码必须相容。风险有效过滤要覆盖读取、候选、统计和删除资格，不能用页面隐藏代替落库。已启用删除后，缺过滤的旧构建不得作为直接回退目标；恢复点、数据库兼容及应用回退先在隔离库验证。终态草稿清理、风险保存后恢复和永久删除不因本节数据设计自动成为已实现功能。

### 5.11 项目简介与页面备注的独立映射

2026-10-15按1051实际字段补齐简介，仍属于projects，不新增实体。3.2的projects行保留0003列清单，本节与5.10合计定义0004的两列增量；候选结构为34表317列55外键，常驻0003实测仍为34表315列55外键。各环境事实见[P04-02报告](../testing/reports/2026-10-16-p04-02-compatibility.md)。页面消费契约见[SPEC-020](../specifications/specification.md#spec-020-项目状态简要与芯片信息导出)。

| 来源与逻辑字段 | 数据目标 | 必要性及迁移边界 |
| --- | --- | --- |
| 1051项目 `summary`；目标逻辑字段 `summary` | 0004增加 `projects.summary`，TEXT、NOT NULL、DEFAULT ('')，新写入空值明确为空串，不新增索引 | 独立的可选多行项目简介；详情与项目卡片应读取它，不从状态或页面备注拼接。空串默认值兼容省略新列的旧插入语句；旧项目初始为空串只表示尚无已确认简介写入，不证明旧简介本来为空 |
| 旧 `summary_notes[来源项目ID]`；现有 `summaryNote` | 保留 `projects.summary_note` | 状态简要页的项目共享备注；来源项目ID必须先映射到正式项目ID，不改列名或批量转作简介 |
| 旧 `chipstat_notes[来源项目ID]`；现有 `chipstatNote` | 保留 `projects.chipstat_note` | 统一状态简要中的芯片备注，来源为原芯片统计页；按项目保存，不按芯片名称分配，不与状态简要备注覆盖 |

来源区分：1051运行时分别把两种备注保存在localStorage的`hw_project_board_summary_notes`与`hw_project_board_chipstat_notes`，按来源项目ID索引；备份容器名才是上表的`summary_notes`、`chipstat_notes`。不能把它们误写成旧项目对象自带的`p.summaryNote`或`p.chipstatNote`。DEC-125合并页面后仍保留两列及各自来源，不拼接、不覆盖；页面合并不需要新增实体，格式与选择契约归SPEC-020。

现有 `src/web/detail.ts` 将 `summaryNote` 标为“项目简介”，`src/web/board.ts` 也把该字段用于卡片简介。这证明当前显示用途混用，不能证明每条已有 `summary_note` 的内容实际来自哪一种用途。结构升级保留其原值和既有历史，不执行从 `summary_note` 批量复制、移动或清空来填 `summary` 的迁移；只有可核对的原 `p.summary` 或明确人工纠正才能写入独立简介。来源无法确定的记录保留原值及“来源待核对”的迁移差异，不根据内容、页面标签或时间猜测后覆盖目标字段。

`status_description`、`detail_note`、`market_expectation` 的已有用途不变。原始备份仍按受控来源保存；本节不授权P04导入真实备份。增量与候选应用必须一起核对独立读写及旧值保留，实施步骤见[P04-02](../implementation/execution-plan.md#p04-02-数据增量旧值保留与升级兼容)。

### 5.12 检查事实与共享资料授权的兼容收敛

DEC-132/133取消共享资料的维护账号专属限制，并退出周检查规则。行为归SPEC-005/006/019；本节只记录结构契约。[0005-check-facts.json](../../migrations/0005-check-facts.json)已编写，本节不代表数据库升级已执行或验证。

| 对象 | 0005及当前目标 | 历史兼容边界 |
| --- | --- | --- |
| `project_checks.week_start` | `DATE NULL DEFAULT NULL`；新检查写NULL | 不回填、不清空旧记录已有周次；历史原值仍可读 |
| `project_checks.rule_version` | `BIGINT UNSIGNED NULL DEFAULT NULL`；新检查写NULL | 既有外键、索引和旧非空引用保留；不创建占位规则供新检查引用 |
| `check_rule_revisions`、项目首次应检依据 | 保留现有表及项目列，退出当前检查写入及派生 | 不因规则退役删除历史；旧设置命令回执仍可核对，不能把回执恢复视为创建新规则 |
| `system_configuration.maintenance_user_id`、资料审计 | 不增表或列；维护账号字段仍用于账号和系统维护；共享资料写入人复用既有审计及`updated_by` | 有效启用账号均可维护共享资料，不新增资料负责人、成员或权限表；项目自身修改资格不随资料授权改变 |

0005只改变两列的可空性和默认值，不增删表、列、外键或索引；0001～0004保持原始迁移内容。升级保留旧检查事实，新增检查的时间、操作人及观察版本继续使用既有字段。实际结构计数、含数据升级和新旧检查回读须由对应测试证据确认，不能据迁移文件存在宣称通过。回退需同时核对旧构建的结构校验及非空字段假设，按运维流程选用兼容应用或隔离恢复方案，不把DDL变化描述为事务自动回滚。

### 5.13 P05来源对应及多次采用的增量结构

#### 0007持久执行与0008名称对应承接

`0007-import-executions`仅增加导入专用的`import_executions`，记录一次已明确提交的完整范围及执行进度。原`import_batches`表示文件与来源，`import_items`表示候选，`import_adoptions`表示单项成功事实；它们都不能独立证明“哪些未执行项已由用户授权提交”。执行记录补这个缺口，不重复保存正式项目，也不建设通用任务表。字段对应实际迁移文件；环境是否升级查系统真相及部署记录，0001～0006内容保持原校验和。

| 字段组 | 用途及不可替代性 |
|---|---|
| `id:I`、`batch_id:I`、`actor_id:I` | 标识本次执行、所属批次与实际提交者；FK连接原批次和账号 |
| `operation_key:V128`、`request_hash:H` | 同次点击/传输重试只接收一次；UK(batch_id,actor_id,operation_key)，同键不同输入拒绝 |
| `command_json:J` | 不可变的已确认范围：项目/资料项、版本依据、修正/决定与各原子操作标识；不复制整份原备份，不在运行时默默扩选 |
| `progress_json:J` | 本次各项尚未执行、成功、业务问题或结果待确认及原结果引用；已成功必须能由adoption/receipt验证，不能靠此JSON制造成功事实 |
| `status:V16` | 接受、执行、等待恢复或本轮处理结束；本轮结束不等于全部项目已入库，业务结果由各项记录说明 |
| `lease_token:V64?`、`lease_until:T?` | 运行期间的执行权；重启或并存进程接续时防重复领取，进度写入须匹配当前token；不能替代原事务幂等 |
| `created_at:T`、`updated_at:T` | 接收时间与最近进度更新时间，用于恢复和“最后确认进度”展示 |

索引：主键id，幂等唯一索引`(batch_id,actor_id,operation_key)`兼作批次查找入口，`actor_id`支持外键，`(status,lease_until)`恢复未终结任务。单批接收以原batch行锁协调，当前执行未终结时不同时创建另一次相互覆盖的执行。索引性能未作规模基准测试，结构与业务验证见报告。

```mermaid
erDiagram
  import_batches ||--o{ import_executions : "拥有已提交执行"
  users ||--o{ import_executions : "明确提交"
  import_batches ||--o{ import_items : "包含候选"
  import_items ||--o{ import_adoptions : "记录成功采用"
  import_executions {
    bigint id PK
    bigint batch_id FK
    bigint actor_id FK
    varchar operation_key UK
    binary request_hash
    json command_json
    json progress_json
    varchar status
    varchar lease_token
    datetime lease_until
    datetime created_at
    datetime updated_at
  }
```

图中operation_key只是复合唯一键的一部分，准确约束见上表。执行与采用通过冻结的项ID/原操作键核对，不新增不真实的直接外键。业务提交后进度更新中断时，读取原回执/永久采用补齐进度；旧pending只能用于确认既有结果或恢复输入，不能批量改造成已授权执行。源文件、旧采用及正式数据保持，兼容/回退方案须在升级验证时覆盖新旧读取。

`0008-import-name-bindings`不增加字段或表，使用既有`import_bindings`，为无编号共享资料保留`source_scope=catalog-name`，`source_key=SHA-256(JSON.stringify(原名称))`的十六进制值。来源与类别仍在复合唯一键内；原名称留在不可变来源项，不用截断名称充当编号。新采用同事务写对应；升级只承接目标唯一的既有采用，已有对应不覆盖。批次出现重名时不自动使用名称对应。

#### 0006已经实现的来源、对应与采用结构

DEC-151的三方核对复用`import_adoptions.adopted_json`，不增加表或迁移步骤。受限属性`comparisonBase`按实际已采用或明确保留线上的事项键保存`{source,saved}`：分别为当时来源值和正式保存后值，键缺失表示没有可靠基准，不能等同明确空值；`keepOnline`记录本次明确保留线上内容的事项键。父绑定ID/版本及`comparisonRecords`内子记录绑定ID/版本/目标共同限定基准范围，改绑不能复用旧目标基准。待审对应选择在`validation_json.choiceBinding`保留选择时绑定依据，后续绑定改变须重新核对，不能由旧卡默认绑回。旧采用记录仅从不可变来源及已冻结采用事实恢复能够证明的值。准确判定规则归SPEC-009，旧记录缺少依据时不补造共同基准。

业务契约只归SPEC-009/DEC-142～149，DEC-148确认逻辑来源、当前对应、每次成功采用三类持久记录的结构方向。以下字段和约束对应`0006-imports`，在0005的34表上增加三表。迁移与结构实测证据见[P05实施报告](../testing/reports/2026-10-22-p05-imports.md)；本文不维护部署进度，也不将结构验证视为索引性能实测。对应施工计划归执行计划1.3，事务取锁归架构4.2，验收归TEST-009/028/032。

**原结构不足之处。**同一`import_item`可以继续选择并再次采用，单个可变`result_json`无法保留每轮实际选择；仅保存`review_version`不能恢复后来被改写的`corrected_payload_json`。`projects`的一组来源只描述原创建来源，不能承担多来源及可纠正的当前对应；批次映射也不能成为所有批次的当前权威。旧历史按item/序号唯一，不能区分同卡多次采用的历史版本。

| 已确认的实体方向 | 施工字段组与用途 | 约束与读取方向 |
|---|---|---|
| `import_sources`（新增） | `source_namespace:V64`稳定逻辑来源，沿用现有字段类型与`utf8mb4_0900_bin`精确比较；`name:V128`用户命名；`created_at:T`登记时间 | PK(source_namespace)；不再平行引入数字source_id。来源不由文件名、上传人或本机目录决定；名称不加唯一约束。当前没有来源改名/删除能力，不提前加无消费者的version；批次改选来源使用批次原version |
| `import_bindings`（新增） | `id:I`、`source_namespace:V64`、`object_kind:V32`、`source_scope:V128`、`source_key:V128`、`target_id:I`、`version:R`；只保存当前对象对应 | FK(source_namespace)；UK(source_namespace,object_kind,source_scope,source_key)，各键精确比较且scope非NULL。顶层项目/资料scope为空串，子记录使用`project:<父binding.id>:<父binding.version>`。version只在目标改绑时推进，同一对应再次采用或目标自身修改均不推进；固定类别白名单，目标存在/项目归属在同事务校验，多态target_id不伪造跨多表FK |
| `import_adoptions`（新增） | `id:I`、`item_id:I`、`source_namespace:V64`、`actor_id:I`、`review_version:R`、`target_kind:V32`、`target_id:I`、`version_before:I?`、`version_after:I`、`operation_key:V128`、`request_hash:H`、`adopted_json:J`、`history_manifest_json:J?`、`created_at:T` | 一次成功采用一行且不可修改；FK(item_id/source_namespace/actor_id)；UK(item_id,actor_id,operation_key)及UK(item_id,review_version)，分别防原操作重复及不同操作/账号对同一候选重复采用。IDX(item_id,id)、IDX(target_kind,target_id,source_namespace,id)。冻结实际来源，不能通过可修改批次反查；新增目标before为空、after为1，已有目标记录实际前后版本。保存选择/采用值、必要意图及对应依据，不复制未变化的全项目，不依赖可清理回执作为唯一业务历史 |

`adopted_json`限定已确认业务事项，保存实际采用内容及当时对应/版本；不能成为任意表写入入口。`history_manifest_json`明确哪些历史种类在本轮被采用及其完整内容摘要/条数，字段不存在表示未采用，明确空历史表示已采用零条；不能仅据明细零行猜测。历史完整正文只归关联明细，不再同时复制到adopted_json、审计和回执；回执引用采用ID及结果，审计记录本次实际业务变化。已绑定且全部内容及可见来源事实一致时只读显示无需处理，不新增adoption/audit或推进review_version；有其他实际采用内容或明确改对应的成功轮次仍保留来源事实，同内容历史仅合并展示、不删版本内重复。默认读取依据最近成功明确采用的类别，不能按摘要、上传时间或旧记录日期判定。

旧说明逐行`{text,date}`和本地`lastCheckAt`的采用值冻结在adopted_json的受限来源字段，之后的待审纠正不追改旧结果；不另建行时间表，也不把可变corrected_payload_json作为已采用事实。成功采用在同事务推进卡片review_version；原键重试先返回其既有结果，不因卡片已推进而误报旧版冲突。继续选择使用新修订，不解除UK(item_id,review_version)。

**精确类型与索引用途。**`I`为`BIGINT UNSIGNED`，新表id自增；`R`同型、非空且值至少1，binding.version初值1，adoption.review_version必须显式写所消费卡片版本；`T`为`DATETIME(3)`；`H`为`BINARY(32)`；`J`为MySQL JSON。三个新表除标注`?`外均非空，JSON使用原生值而非双重序列化文本。来源及source_key使用`utf8mb4_0900_bin`；object_kind/target_kind/source_scope/operation_key使用`ascii_bin`，其余名称沿现库字符集。operation_key复用现UUID操作键格式；source_scope只由服务端构造，不接受用户任意范围。所有FK使用现有RESTRICT策略。

- bindings的类别限定为现有项目、七类基础资料及项目节点/客户节点/风险/需求变更/计划记录；企业信息固定对应`system_configuration.id=1`，采用记录的target_kind可为company，不建立虚构的企业来源ID或binding。节点类别和所属项目共同限定对应，阶段按项目内S1～S7唯一键定位，不新增阶段binding。
- bindings的唯一键承担来源对象定位及并发创建冲突；不增加目标唯一键，因为不同来源可明确指向同一正式对象。缺失、零值、重复来源键不建永久binding，只冻结本次明确的条目对应。父项目改绑产生新的子scope，旧scope保留追溯；目标项目普通保存不推进binding.version。
- adoptions的`IDX(item_id,id)`用于原卡历次结果；`IDX(target_kind,target_id,source_namespace,id)`用于正式对象按来源读取版本；另设`IDX(actor_id)`、`IDX(source_namespace)`支持两个FK。item_id的FK复用已有前缀索引；bindings来源FK复用其唯一键前缀；batches新增`IDX(source_namespace)`支持来源FK。request_hash不唯一，不用内容相同否定不同的明确采用事实。
- `adopted_json`的受限内容包括所选业务组和值、目标子记录ID、本次意图、绑定id/版本、批次版本、实际变化摘要，以及采用的来源说明行时间、旧标记、原时间文字和有效结案依据。`history_manifest_json`仅以mixed/status_description为键，值含完整版本摘要及条数；摘要对规范化JSON键顺序后的种类、日期/正文、原条目顺序及全部重复次数计算，缺键与零条严格区分。恢复所需的正式ID、版本与采用计数从这些冻结值生成，不能读取已改写的卡片来补原结果。

| 复用/调整对象 | 施工改动 | 避免重复权威 |
|---|---|---|
| `import_batches` | 现source_namespace增加来源FK；原文件、处理资格与version沿用，mapping_json仅保留本批显示/解析上下文 | source_hash现为普通索引，无文件唯一约束，同文件明确另开批次不需改键。当前跨批对应只归bindings；采用来源不随批次改选变化 |
| `import_items` | 复用source_payload_json、corrected_payload_json、review_version、validation_json、status、result_json；保留UK(batch_id,item_kind,source_sequence) | pending/committed保存确定处理事实，committed不禁止再次采用。第二轮失败/未知不覆盖前次成功状态或adoption，本轮输入/原键及反馈沿本人状态恢复；result_json保存最新确定成功引用。已有可靠对应且全等价的未采用卡由当前比较结果排除待办，不能直接用status计数或自动写committed。现target_project_id有项目FK，只放项目；资料目标及预期版本存受校验候选上下文，成功冻结到adoption，不能将资料ID塞进项目列 |
| `legacy_project_history` | 新增`source_adoption_id:I?`（FK采用记录）、`history_kind:V32`、`legacy_source_namespace:V64?`（FK来源，仅无adoption存量使用）；沿用source_date_text、body、source_sequence存日期/正文/原序。UK(source_import_item_id,source_sequence)改为UK(source_adoption_id,history_kind,source_sequence)，另设IDX(legacy_source_namespace)支持兼容来源FK；CHECK两类来源引用恰有一个非空，history_kind只许mixed/status_description | 旧行按mixed承接，迁移冻结其原batch来源，避免后续批次改选连带改旧来源；不伪造adoption。新路径必须有adoption且兼容列为空，来源只读adoption。每种历史默认读最近明确采用者；显式空版本有版本头；不另造payload_json，不删内部重复 |
| `audit_log`与`command_receipts` | 复用改绑/资料/项目审计及提交确认；成功结果指向adoption。实际回执PK为(command_scope,idempotency_key)，导入scope含账号与item | 不另建映射历史表或失败事件表；原键先查回执/永久adoption并比较hash，再校验候选版本；回执清理后仍能恢复原成功结果 |
| 项目/关系/资料表 | 复用现有日期可空列、业务关联与资料版本；当前有效结案来源由采用事实及后续审计辨认 | projects仍有UK(source_namespace,source_key)，旧列只保留原创建来源；新路径由source_import_item_id及adoption留来源、bindings维护当前对应，不重复占用旧来源对，避免改绑后另建冲突。不新增第二套项目或人员表 |
| 旧子记录时间 | `project_risks.created_at`、`project_changes.created_at`、`schedule_changes.created_at`由非空DATETIME(3)调整为可空，其他属性保持；actor_id、resolved_at及日期列原本可空 | 1054三类createdAt可缺失。正常线上新增仍写真实保存时间，旧历史未知保留NULL；原文字随采用保留，不能用入库时刻或采用者补造旧发生时间/操作者。现有存量时间不回改 |

旧子记录时间的使用者是`project-records.ts`的riskRows/changeRows和`project-plans.ts`的scheduleRecords，其类型与前端格式化一并接受NULL；日期未知显示未知，可靠原文字作为来源时间展示，不把无时区文字补成UTC。`projects/catalog/import_batches`的created_at仍表示服务器登记，audit/adoption/receipt仍表示本次真实操作，不作可空改造。项目/阶段/节点的实际日继续使用DATE；risk.resolved_at未知不补造；旧历史source_date_text保留原文字。

```mermaid
erDiagram
  import_sources {
    varchar source_namespace PK
    varchar name
    datetime created_at
  }
  import_batches {
    bigint id PK
    varchar source_namespace FK
    bigint created_by FK
    bigint current_handler_id FK
    bigint version
  }
  import_items {
    bigint id PK
    bigint batch_id FK,UK
    bigint target_project_id FK
    bigint expected_project_version
    bigint review_version
    varchar item_kind UK "与batch_id及source_sequence组成唯一键"
    int source_sequence UK
  }
  import_bindings {
    bigint id PK
    varchar source_namespace FK,UK
    varchar object_kind UK
    varchar source_scope UK
    varchar source_key UK
    bigint target_id "由类别限定，非多表FK"
    bigint version
  }
  import_adoptions {
    bigint id PK
    bigint item_id FK,UK
    varchar source_namespace FK
    bigint actor_id FK,UK
    bigint review_version UK "与item_id唯一"
    varchar operation_key UK "与item_id及actor_id唯一"
    varchar target_kind
    bigint target_id
    bigint version_before
    bigint version_after
    binary request_hash
    json adopted_json
    json history_manifest_json
    datetime created_at
  }
  legacy_project_history {
    bigint id PK
    bigint project_id FK
    bigint source_import_item_id FK
    bigint source_adoption_id FK,UK "旧行可空"
    varchar legacy_source_namespace FK "仅存量原来源，新行为空"
    varchar history_kind UK
    int source_sequence UK
    text source_date_text
    text body
  }
  projects {
    bigint id PK
    bigint source_import_item_id FK
  }
  users {
    bigint id PK
  }
  import_sources ||--o{ import_batches : "当前选用来源"
  import_sources ||--o{ import_bindings : "当前对应"
  import_batches ||--o{ import_items : "原卡片"
  import_items ||--o{ import_adoptions : "历次成功采用"
  import_sources ||--o{ import_adoptions : "采用时来源"
  import_adoptions o|--o{ legacy_project_history : "完整历史明细"
  import_sources o|--o{ legacy_project_history : "无采用ID的存量原来源"
  users ||--o{ import_adoptions : "实际采用者"
  users ||--o{ import_batches : "上传及当前处理"
  projects o|--o{ import_items : "候选或正式目标"
  projects ||--o{ legacy_project_history : "项目来源记录"
  import_items ||--o{ legacy_project_history : "原卡片"
  import_items o|--o{ projects : "原创建来源"
```

该图表达已确认的增量实体方向，不替代前文全部项目实体关系，也不表示表已创建。存量旧历史允许没有采用ID；新写约束须由迁移和业务共同确保。

**取舍理由。**不采用一个来源整份映射JSON作为当前权威：修改一个芯片会与无关项目争用同一行，也难以给来源对象设置独立唯一约束。采用一条对应一行，只校验本次实际使用的对应；它们仍归一个导入深模块，不按表拆服务。相比只覆盖卡片结果，独立成功采用行能区分原操作重试与原卡新选择，并保留当时来源及历史内容；这是三类实体分别存在的理由。

#### 5.13.1 新增量与存量兼容次序

新增`0006-imports`（实际迁移文件名），不改0001～0005及其校验和。`infrastructure/schema.ts`按本次需要扩展有明确对象定义的create/alter、删除指定索引、数据补齐步骤。每个结构步骤保存可比较的前后manifest；只接受准确前态或准确后态，不用IF NOT EXISTS掩盖异构表，不引入任意迁移脚本执行平台。实际结构验证范围查P05测试报告，不据本节目标推断线上已升级。

| 顺序 | 确切变化及恢复依据 |
|---|---|
| 1 | 创建sources，按现import_batches的不同source_namespace补来源；同一namespace一行，显示名称先保留原namespace，created_at取其最早批次登记时间。只补缺行，不改已有来源、不按名称合并；仅projects中的manual/trial来源不自动变成导入库 |
| 2 | 创建bindings、adoptions及其明确FK/索引；不为存量伪造采用人、review_version或成功adoption，也不从旧名称/序号自动回填当前binding。原来源记录仍可读，后续按已有明确对应规则建立binding |
| 3 | 对账每个批次均有来源后增加import_batches来源FK；保留source_hash普通索引、原文件及batch/item全部数据。该补齐步骤可重做，失败不登记0006完成 |
| 4 | legacy历史先增加两个可空来源列和非空history_kind（存量默认mixed），按原item→batch冻结legacy_source_namespace并逐行对账，再补两类来源FK、索引及恰有一个来源的CHECK；同一个ALTER中替换旧唯一键。每个子步骤有前后manifest。旧NULL-adoption行保留原索引可读，后续改batch来源不改它；新应用写非空adoption且legacy_source_namespace为空 |
| 5 | 三类旧子记录created_at改可空；核对原行数、ID和非空时间逐值保持。检查全部目标结构/FK/索引、来源覆盖和历史完整性后才登记0006校验和 |

DDL可能已生效而版本尚未登记；续跑逐步骤识别前后态，数据补齐独立校验。遇额外列、孤儿或未知中间结构停止并报告具体差异，不删除数据猜修复。新建库走原foundation后顺序升级；旧库保留所有来源原值/未知事实。迁移期间沿运维流程暂停本应用写入；完整数据与受控原文件都在备份范围。

旧0005应用会因严格schemaVersion/结构校验拒绝0006，不能声称只回退fe4320f即可运行。发布前准备并验证理解0006结构与已导入事实、可暂关闭导入写入口的兼容应用恢复产物；只回退应用不回灌旧备份、不删除采用表。新建/含数据升级、每步骤中断续跑、旧历史读取、未知时间及后续正常新增、恢复产物启动均归TEST-032；实际结果查P05实施报告，不能据设计推断运行结果。

### 5.14 项目空间与归属请求的目标增量（2026-10-26，未迁移）

依据SPEC-009/014及DEC-157～164。以下为工程设计，未证明DDL、索引或数据升级已通过MySQL验证。只读基线为仓库`migrations/0001`～`0008`及`src/server/infrastructure/schema.ts`；不据本节推断服务器现状。

**实体收敛。**正式项目仍只有`projects`；本人项目用`project_responsibilities`筛选，项目空间用同表的基础字段投影。新增两张专用表：曾用名用于防止改名后的误新增，请求用于保存尚未成为成员的协作意愿。后者不能放进正式责任表，否则待接受者会提前获得权限。审计、回执、导入执行及原文件继续使用现有实体，不新建空间项目表、个人项目副本、消息平台或审批表。

| 对象 | 目标字段及约束 | 必要性与维护入口 |
|---|---|---|
| `projects.name_key`（新增） | `VARBINARY(1020) NOT NULL`；完整唯一索引`uk_projects_name_key` | 对既有最大255字符名称取`UTF-8(name.trim())`，作为精确比较键；不转大小写、不做Unicode归一化、不用摘要碰撞代替精确值。现有名称列及其默认排序不能直接承担此约束。新增、改名、导入共用一处键生成；同事务更新名称及键。存量只补键，不借迁移改写显示原文 |
| `project_name_aliases`（新增） | `project_id:I`、`name_key:VARBINARY(1020)`；联合PK(project_id,name_key)，IDX(name_key,project_id)，FK(project_id→projects) | 保留可确证的曾用名候选；同一曾用名允许对应多个历史项目，不能给别名加全局唯一。名称可从UTF-8键还原，时间/操作者已在审计，不复制列。改名在同事务补旧键；存量只从可确定项目ID及名称前后值的实名审计回填，不解析自由文字猜历史 |
| `project_membership_requests`（新增） | `id:I`自增PK、`project_id:I`、`kind:V16`、`initiator_id:I`、`target_user_id:I`、`status:V16`、`created_at:T`、`resolved_at:T?`、`resolved_by:I?`、`resolution_code:V32?` | kind区分邀请/申请；target始终为拟加入的人，申请时等于initiator。状态为pending/accepted/rejected/withdrawn/invalidated；终态不重新变pending，明确再发起使用新ID，防止旧页面误处理新请求。resolved_by只记实际决定人；自动失效可空，原因记稳定code。无默认到期日期、无用户必填说明列 |
| 请求约束及索引 | FK(project_id→projects)，三个账号列FK→users；IDX(project_id,status,id)、IDX(target_user_id,status,id)、IDX(initiator_id,id)、IDX(resolved_by)；kind/status采用ASCII精确值 | 项目锁内检查同项目同目标的pending请求，所有写入通过项目负责接口；不使用仅前端查重。待处理通知按target查询，经理处理列表按当前责任关联project查询。空终态字段/终态时间及申请target=initiator由CHECK与业务契约校验；实际CHECK表达式须随迁移验证 |
| `project_responsibilities`（复用） | 现有(project_id,user_id)主键及反向索引保持 | 创建者/上传入库者初始负责、接受/批准/认领成功后才增加；退出删除当前关系，历史仍归audit_log。请求不会替代此权限来源 |
| `project_stages.state`（扩展既有CHECK） | 保留`VARCHAR(16) NOT NULL`，在locked/ready/active/completed以外允许`unknown` | 落实SPEC-009已确认的旧阶段依据未知，不新增并行状态列。仅缺依据的历史事实使用unknown，普通新建保持原状态规则；更新时文件缺字段不覆盖已知状态。现0001检查约束不接受unknown，必须新增迁移替换约束，不得只删前端拦截或把未知默认为ready |

请求表不另外存“处理经理名单”“未读计数”“是否有权限”“项目名称快照”或第二个项目版本：处理资格每次查当前成员，名称读项目，通知数量读pending请求，正式责任变化沿`projects.version`。单纯发送/拒绝/撤回请求不改变项目业务版本；正式加入/退出在同事务推进一次。具体返回结果归SPEC-014。

```mermaid
erDiagram
  projects ||--o{ project_responsibilities : "正式归属"
  users ||--o{ project_responsibilities : "本人项目"
  projects ||--o{ project_name_aliases : "曾用名候选"
  projects ||--o{ project_membership_requests : "协作请求"
  users ||--o{ project_membership_requests : "发起人"
  users ||--o{ project_membership_requests : "拟加入者"
  users o|--o{ project_membership_requests : "实际决定人"
  projects {
    bigint id PK
    varchar name
    varbinary name_key UK "新增"
    bigint version
  }
  project_responsibilities {
    bigint project_id PK,FK
    bigint user_id PK,FK
    datetime joined_at
  }
  project_name_aliases {
    bigint project_id PK,FK
    varbinary name_key PK
  }
  project_membership_requests {
    bigint id PK
    bigint project_id FK
    varchar kind
    bigint initiator_id FK
    bigint target_user_id FK
    varchar status
    datetime created_at
    datetime resolved_at
    bigint resolved_by FK
    varchar resolution_code
  }
```

图只列本次关系子集，users及projects的其余列仍按原字典；三个users关系为不同外键角色。请求失效的业务条件只归SPEC-014，邀请发起人停用的边界已由DEC-163确认，不由字段设计代决。

#### 5.14.1 导入持久记录的复用边界

DEC-165最小账号启停复用`users.enabled/version/updated_at`、`sessions.revoked_at`、`system_configuration.maintenance_user_id`及现有审计/回执；请求失效使用本节请求表的终态字段。没有账号删除表、交接审批表或额外启停状态表。停用影响依据只属于短期读取及请求输入，不持久保存另一份项目责任名单；成功时冻结的结果进入原命令回执。真实表结构仍需迁移前回读，设计不代表已创建接口。

| 现有实体 | 新链用途与存量保护 |
|---|---|
| `import_batches` / `import_items` | 继续保存原文件、上传者/处理人、修正内容、候选版本。不新增“待入库项目库”；正式项目只在明确导入成功后出现。原始source_payload不覆写，线上值比较时重读；缺字段与明确空继续可区分 |
| `import_executions.command_json` | 新命令增加固定`formatVersion`，记录接收时的项目匹配结果、目标版本、明确选择、修正内容、请求账号及资料依赖；子记录同时冻结文件内定位、类别、明确选定的正式目标或新增意图、最终内容和关联。文件内定位只标识本次输入，不充当跨备份身份。沿既有request_hash冻结，不在执行时悄悄按新规则重算选择。无此标记的旧命令在升级前处理，不能按新结构直接解释 |
| `import_executions.progress_json` | 仍逐项记录实际结果与恢复编号，成功结果引用正式项目/资料及采用记录；不复制整份项目作为第二事实。每个项目成功事务先落回执/采用记录，执行进度稍后补写，中断先查已提交事实 |
| `import_adoptions` / `command_receipts` | 原成功、原操作键及请求摘要保持；新旧结果分别解码，只读恢复不回放业务。去掉来源管理页面不等于删除这些历史实体 |
| `import_sources` / `import_bindings` | 保留历史来源、已确认子记录对应及FK；新项目目标以名称及本次明确改选为准，不再由顶层binding决定。子记录旧对应及原编号只提供本项目同类别候选，按DEC-164冻结本次明确选择，不由旧绑定自动授权覆盖；实际成功对应随采用结果持久保存。旧采用记录仍可还原当次目标，不覆盖其历史含义 |

不为“用户无需设置来源”伪造所有备份来自同一数据库。文件名、同一上传人、同名项目或原编号均不能单独证明子记录身份；候选和本次明确选择的业务边界已由DEC-164确认。复用采用记录中的`comparisonRecords`及原输入留存每次实际对应，不为匹配分数或猜测身份另建实体；正式记录ID与所属项目/类别必须在保存时校验。跨备份候选查询的索引及旧绑定承接仍须在含真实存量的恢复副本验证，不能用空类别样本宣称已覆盖。

#### 5.14.2 增量与数据对账顺序

1. 在实施基线只读核实际结构及登记；按新名称键列出空名、重名、超长等阻断。重名由用户在原项目明确修正，不自动追加编号。记录原项目ID、负责关系和审计/采用数量及摘要，受控原文件保持完整。
2. 先在恢复副本新增可空name_key并补值；此时不切换用户流量。验证每行等于共享键函数的结果、非空且无重复，再改非空并建立完整唯一索引；中断按准确前后结构续跑。两张新表按目标FK/索引创建；迁移中不生成待接受邀请、不重建成员。
3. 从确证的改名审计补别名；不具备证据的旧名不补造。逐ID对账存量内容、责任、历史及原操作结果，缺证只限制曾用名提示，不改当前项目归属。
4. 旧执行先核实、再升级；具体顺序归实施计划1.3.4。已有成功及未提交修正分别承接，不能把旧页面的默认选择直接变成新授权。
5. 增量扩展阶段state约束以表达未知；只改变允许值，不批量改写存量阶段。解析、阶段读模型、校验、卡片/详情与动作入口共同理解unknown：不显示已开始/已完成，实际动作需要明确依据时才在原阶段处理。新增迁移文件与schema manifest必须一并验证，0001～0008原文件校验和不动。新版本字段类型和索引宽度、存量补值、中断续跑均须真实MySQL实测；本节不是已生成的SQL或测试通过记录。

### 5.15 多值资料与统一操作的目标结构（DEC-167/168）

本节为0010目标；是否已迁移以系统真相及验证报告为准。已发布0001～0009资源保持摘要不变。

| 实体 | 字段、键与不可替代用途 |
|---|---|
| project_customers | project_id→projects、customer_id→customers、sort_order；复合主键(project_id,customer_id)，反向索引(customer_id,project_id)。一个项目多个客户且不重复 |
| project_odm_factories | project_id→projects、customer_id→customers、sort_order；复合主键及反向索引同上，表达ODM角色，与客户关系独立 |
| project_product_lines | project_id、product_line_id→product_lines、sort_order；复合主键和资料反向索引 |
| project_apps | project_id、app_id→apps、sort_order；复合主键和资料反向索引 |
| project_group_links | project_id、group_id→project_groups、sort_order；复合主键和资料反向索引 |
| customers分类 | is_customer与is_odm布尔值；旧资料保留客户分类，旧ODM引用额外标记ODM。新建ODM只赋ODM分类。公司同时承担两种角色仍是同一个ID；不按名称自动合并 |
| project_chip_selections | project_id→projects、selection_id（项目内稳定选择键，varchar64）、chip_id→chips、note（TEXT项目备注）、sort_order；主键(project_id,selection_id)，索引(chip_id,project_id)。承接V1.055同型号多个选择，不用chip_id去重抹掉备注 |
| project_membership_requests | 原表保留历史；旧pending统一invalidated，resolution_code记录入口退役。已accepted不撤销正式责任，不再新增申请/邀请 |
| users | 复用display_name与version；姓名修改不改登录名或用户ID，审计原操作者快照不更新 |

```mermaid
erDiagram
 projects ||--o{ project_customers : "客户"
 customers ||--o{ project_customers : "稳定资料ID"
 projects ||--o{ project_odm_factories : "ODM"
 customers ||--o{ project_odm_factories : "同一公司可有两个角色"
 projects ||--o{ project_product_lines : "产品线"
 product_lines ||--o{ project_product_lines : "关联"
 projects ||--o{ project_apps : "APP"
 apps ||--o{ project_apps : "关联"
 projects ||--o{ project_group_links : "分组"
 project_groups ||--o{ project_group_links : "关联"
 projects ||--o{ project_chip_selections : "项目选择"
 chips ||--o{ project_chip_selections : "允许不同选择备注"
 project_chip_selections {
  bigint project_id PK,FK
  varchar selection_id PK
  bigint chip_id FK
  text note
  int sort_order
 }
```

关联分组的物理表命名为`project_group_links`，避免与既有资料表`project_groups`重名；图中分组目录及关系按该物理命名核对。五类旧单外键和project_chips保留为只读迁移来源；新运行使用关系表，不将多值压成首项。旧单选非空值逐项生成一个关联，空值保持空；旧芯片选择键用可重放的legacy前缀及chip_id，备注为空，不捏造本地备注。回填校验目标与来源集合一致后方可登记完成。

项目全页保存仍复用projects.version、audit_log、command_receipts及个人草稿；同次提交只推进一次版本，全部明细在同事务。临时子记录ID映射不另造常驻实体。旧请求和草稿保留原协议可核对，新全页范围使用独立请求摘要；没有迁移自动提交旧草稿。

### 5.16 多管理员与注册、CHECK增量（0011）

行为归SPEC-021。users新增is_admin（tinyint，默认0）及registration_invite_id（可空外键）；既有maintenance_user_id保留迁移来源，运行判权使用is_admin。registration_invites保存id、唯一code_hash（二进制SHA256）、role、created_by、created_at、expires_at、revoked_at；不存明文。check_rule_revisions新增frequency，保留原星期/生效周/保存人/时间；project_checks继续引用实际规则版本，不复制另一套周期状态表。

```mermaid
erDiagram
 users ||--o{ registration_invites : creates
 registration_invites o|--o{ users : registers
 users ||--o{ check_rule_revisions : saves
 check_rule_revisions o|--o{ project_checks : applied_rule
```

0011将既有维护账号标为管理员，并建立本次每周五默认规则修订；旧规则、原检查外键和时间保留。运行统计派生当前周期，不追加每个项目的重复周期表。


### 0012账号管理补充（DEC-170）

users.deleted_at（datetime(3)，可空）表示保留业务引用的删除；registration_invites.code_value（varchar(32)、ascii_bin，可空）供管理员列表回读完整码，旧摘要记录为空。实体/外键不新增，原唯一code_hash仍用于注册匹配。实际应用环境见系统真相。

### 5.17 账号业务资格与1056任务（0013、0014）

行为归SPEC-022；以下为迁移资源的结构说明，环境实测结果只查[本轮报告](../testing/reports/2026-10-27-experience.md)。

```mermaid
erDiagram
 users ||--o{ project_responsibilities : joins
 projects ||--o{ project_responsibilities : has
 projects ||--o{ project_tasks : contains
 users {
   bigint id PK
   tinyint is_maintenance
   tinyint is_project_manager
   varchar registration_name
 }
 project_tasks {
   bigint project_id PK,FK
   varchar task_key PK
   text content
   varchar created_at_text
   varchar updated_at_text
   varchar completed_at_text
   varchar deleted_at_text
   int sort_order
 }
```

| 字段 | 物理定义与用途 | 必要性与写入边界 |
|---|---|---|
| users.is_project_manager | tinyint，非空，默认1 | 与管理员资格独立；旧账号保留原业务资格，新管理员注册明确写0，管理员勾选兼任后写1 |
| users.registration_name | varchar(128)，可空 | 注册时固定显示姓名；日常改名不改变项目匹配依据，旧账号为空时不猜造第一次姓名 |
| projects.tasks_unified | tinyint，非空，默认0 | 区分尚未正式采用的旧说明与已统一任务，避免每次读取重复追加；首次明确任务保存/导入同事务置1 |
| project_tasks.project_id、task_key | bigint unsigned＋varchar(128)，联合主键；task_key用utf8mb4_bin | 项目内稳定身份，大小写不同的原任务ID不被数据库合并；project_id真实外键限制悬空引用 |
| content | text，非空 | 人工正文；不以文字去重，原文相同的两条任务仍独立 |
| 四个*_at_text | varchar(128)，非空，默认空串 | 兼容原文件只有日期、完整时间及未知值；不把旧日期伪造成精确时刻，新动作由服务器写ISO时间 |
| sort_order | int unsigned，非空 | 保留原显示次序；不依赖随机ID或文字排序 |

没有另建“当前任务”“任务回收站”“任务人员统计”等重复表。当前任务状态来自上述一行，完整修改历史复用audit_log，导入来源历史复用现有来源版本。任务人员由未完成正文提及派生。status_description只作现有消费者的未完成任务投影；旧正文写入口不得与任务操作同时写。

旧项目在首次读取时提供稳定ID的虚拟任务，读取本身不改业务数据。首次明确保存才持久化；原说明历史保持。新任务表不可被旧版应用理解，回退按版本匹配的备份恢复或向前修复，不能直接启动0012应用。


### 5.18 项目删除增量（0015）

结构来源为`migrations/0015-project-deletion.json`。在0014基础上增加`projects.deleted_at DATETIME(3) NULL`；`name_key VARBINARY(1020)`改为可空，原唯一索引保留。有效项目继续写完整名称键；删除时写删除时间并置名称键NULL。其余项目及外键记录不物理移除，原审计记录删除人、前后版本和名称，无重复的删除人列。实体关系不变，目标48表/415列/84外键；实际环境是否升级查系统真相与部署记录，不能据此推定上线。
