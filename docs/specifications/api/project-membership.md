# 项目归属与最小账号维护接口

2026-10-26候选代码，schema `0009-project-space`，未部署。来源为`routes/membership.ts`、`routes/projects.ts`、`routes/identity.ts`及对应深模块；业务唯一权威为SPEC-014，页面行为为PRD9.23/9.24。

所有ID/版本是十进制字符串，操作号为UUID v4。沿用会话、同源、CSRF和账号上下文；客户端传账号ID不等于取得该身份。

| 方法/路径 | 输入 | 返回和后续使用 |
|---|---|---|
| `GET /api/project-space` | `search,page,pageSize`，每页最多100 | 全项目基础投影、本人关系及可操作入口；不返回完整正文、历史或节点 |
| `GET /api/membership-requests` | 可选`before` | 本人发出/收到及有资格处理的请求，每页50项、`next`和`pendingCount` |
| `POST /api/projects/:id/membership` | 下表命令、`idempotencyKey` | `outcome:committed`及`projectId,requestId,targetUserId,status,changed,savedVersion,operationId` |
| `POST /api/projects/:id/membership-results/query` | 原完整命令 | `committed`或`not_found`，不重做业务 |
| `GET /api/accounts` | 仅维护账号 | 账号及启用状态，不返回密码或会话凭据 |
| `GET /api/accounts/:id/impact` | 仅维护账号 | 当前版本、影响标识、尚未交接项目和受影响请求 |
| `POST /api/accounts/:id/state` | `enabled,expectedVersion,impactToken,idempotencyKey` | 同事务校验当前影响并启停；成功撤销相关会话/请求并通知 |
| `POST /api/accounts/:id/state-results/query` | 原完整启停命令 | 查询原成功结果，未知结果不能改操作号重做 |

归属命令的`action`与专有参数如下；额外字段拒绝，具体资格和联动不在此重复定义。

| action | 专有参数 | 含义 |
|---|---|---|
| `claim` / `apply` | 无 | 无负责人认领／向已有负责人申请 |
| `invite` | `targetUserId` | 当前成员邀请启用业务账号 |
| `accept` / `reject` / `withdraw` | `requestId` | 对当前请求作明确决定或撤回 |
| `leave` | `expectedVersion` | 本人退出，共用项目版本保护 |

只有实际成员加入/退出推进项目版本；发出或处理请求仍记录历史及回执。同键不同正文409；最后有效成员不能退出。停用影响变化返回409 `ACCOUNT_IMPACT_CHANGED`，必须重新读取当前影响；未交接422，不能停用自己或专用维护账号。账号重新启用不复活旧请求、旧会话或被接管批次。

原`/responsibility`直接加入/退出写接口410；原`/responsibility-results/query`只查旧成功回执。旧创建`managerIds`写请求409 `CREATE_PROTOCOL_CHANGED`；当前新建使用`inviteeIds`，创建人先负责，受邀者接受后加入。创建结果查询仍允许旧完整正文核对原成功事实。

401恢复登录；403资格变化时保留输入、停止读取受保护正文；409保留原输入并重读实际关系/版本；422在原位置显示具体原因。503的`outcome=unknown`沿原操作查询，`not_committed`才允许明确重试；查询不返回密码、私人草稿或无权项目快照。
