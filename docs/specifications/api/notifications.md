# 项目通知与编辑名单协议

对应SPEC-002/015、PRD9.17、P04-13；2026-10-17工作区候选，尚未公网发布。短期名单不写项目或审计，正式项目版本和原请求回执负责保存结果。

## 连接与消息

`GET /api/events?accountId=<当前账号>&instanceId=<本页UUIDv4>&projectId=<可选项目ID>`返回SSE。仍使用HttpOnly会话Cookie鉴权；仅本GET用非秘密accountId上下文参数代替账号请求头，其他接口不放宽。不得传密码、令牌或草稿正文。

| event | data | 消费 |
| --- | --- | --- |
| connected | epoch | 新连接/重连，补查正式项目并重新登记实际编辑 |
| project | projectId、version、operationId | 列表重新查询；固定详情比较版本，本页匹配操作不误冻，同账号其他标签仍为外部更新 |
| editors | projectId、users（id/name） | 同账号多标签按人显示；不显示字段或实时文字 |
| heartbeat | 空对象 | 连接保活，不是用户活动 |
| identity | 空对象 | 停止流，冻结旧身份操作并重新登录 |
| unavailable | 空对象 | 状态未知，先核对身份并有界重连，不冒充无人编辑 |

断流不提供持久消息重放，重连读取正式状态补偿。通知来自路由已确认提交结果；查询原回执也可能重复通知同版本，消费者按版本去重。返回头包含`X-Accel-Buffering:no`；代理配置沿运维文件，是否实际发布以部署证据为准。

## 编辑登记

`POST /api/editing`正文仅允许`projectId`、`instanceId`、`editing:boolean`，沿既有同源/CSRF/账号头校验。`editing:true`检查当前项目负责关系；查看和只读用户不登记编辑。false结束当前会话/页面实例登记。成功返回`{status:"editing"|"ended"}`。退出负责或退出会话移除对应名单，异常离开按执行计划时限清理。

身份、项目不存在、只读和格式错误分别返回既有401/403/404/400结果；输入保留，通知失败不能撤销已提交业务。服务端设置慢连接积压保护；断流后按上述补查恢复，不强行重放业务保存。
