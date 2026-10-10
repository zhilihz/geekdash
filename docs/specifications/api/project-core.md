# E03 项目主干与最小身份 API

日期：2026-10-09；对应 E03-W09～W12 源码，部署构建版本见验收报告与系统真相。行为权威为 SPEC-001/002/014，字段字典为 ERD；本文记录实际协议。

## 身份入口

所有响应 no-store。公网 Cookie 为 __Host-geekdash（HttpOnly/Secure/Path=/）与独立 CSRF Cookie；本地 HTTP 使用 geekdash_dev 前缀。POST 带同源 Origin、X-GeekDash-Request: 1；已认证请求再带 X-GeekDash-Account 和 X-GeekDash-CSRF。账号上下文只供核对，身份来自服务器会话。X-GeekDash-Active: 1 仅由本人前台操作发出，后台确认/自动刷新不续期。

| 方法/路径 | 输入 | 成功及后续消费 |
|---|---|---|
| POST /api/auth/login | loginName、password | authenticated、accountId；设置 Cookie 后 GET me 核对同一 ID |
| GET /api/auth/me | 实际 Cookie | account 的 id/name/mustChangePassword；强制改密账号仍不可读业务 |
| POST /api/auth/password | currentPassword、newPassword、confirmPassword | changed；全部旧会话撤销，重新登录；密码不入持久回执 |
| POST /api/auth/logout | 空对象 | logged_out；撤销当前会话并清 Cookie，其他设备保持有效 |
| POST /api/auth/activity | 空对象及前台活动标记 | active；活动不推进项目或账号版本 |

密码原样按码点计数及完整 Unicode 校验，哈希复用 Node 24 异步 Argon2id，19 MiB/2/1；最多两项计算、四项等待、等待最多两秒。来源：[Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoargon2algorithm-parameters-callback)与[OWASP 密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。登录按账号 20/15 分钟、来源 IP 100/15 分钟限速，内存表最多 1024 项；重启清限速统计，持久会话仍由 MySQL 校验。

## 创建与本人责任

| 方法/路径 | 输入 | 成功 |
|---|---|---|
| POST /api/projects | idempotencyKey、fields（name 必填，marketExpectation/detailNote/summaryNote 可选） | committed；result 包含 projectId/savedVersion/operationId/changed/responsible；新建测试项目、七阶段、创建者责任、审计及回执同事务 |
| POST /api/projects/create-results/query | 原创建正文 | committed 或 not_found；只读确认 |
| POST /api/projects/:id/responsibility | expectedVersion、idempotencyKey、action（join/leave） | committed；只修改当前本人关系，变化共用项目版本 |
| POST /api/projects/:id/responsibility-results/query | 原责任变更正文 | committed 或 not_found；只读确认 |

项目 ID/版本均为十进制字符串，幂等编号为小写 UUID v4；不同账号的回执作用域独立。普通字段协议沿 project-save.md，新增服务器可信账号和事务内负责资格校验；旧 trial 匿名结果只可确认，不能匿名重放。详情增加 createdBy、responsible 与 join/leave/editOrdinary 能力，名单与项目在同一短快照中读取；创建后从提案视图消费。

## 失败

401 AUTH_REQUIRED：重新认证；403 PASSWORD_CHANGE_REQUIRED/CSRF_INVALID/INVALID_REQUEST_SOURCE/PROJECT_READ_ONLY：完成相应身份或负责前置；409 AUTH_CONTEXT_CHANGED/PROJECT_VERSION_CONFLICT/OPERATION_KEY_REUSED：保留旧输入并重新核对；422 LAST_RESPONSIBLE：先由另一启用账号加入；字段及密码错误保留表单修正。503 DATABASE_UNAVAILABLE 或 COMMIT_UNKNOWN：区分未提交与结果未知；项目命令沿原编号确认/重试，改密用新密码重新认证核对。创建和责任接口不接受客户端身份或他人负责 ID。

## 0003节点读取兼容补充

E04-B08兼容候选增加节点响应deletedAt可空字段；正常详情/普通保存候选仅返回deleted_at为NULL的有效节点，结案遗留沿同一条件。既有节点ID/来源/字段与原保存回执不改写；旧结果查询仍返回当次原JSON。此批没有删除/恢复写意图，固定运行状态归系统真相，结构归ERD5.8。
