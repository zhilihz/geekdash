# P04详情编辑与直接检查测试部署（2026-10-19）

## 1. 实际版本与范围

- 环境：既有新加坡测试机，公网 https://geekdash.zhiluan.cool 。
- 施工分支 `codex/p04-flow-convergence`，产品提交 `1d822c98bca233eff3c7a2dac4a2a656dc730c4d`，已推送并远端回读一致。main仍为 `b96712a8d7e48a14663b553f54903b7ccb157f6e`，本次未合并，完整P04仍未验收。
- 构建 `2026-10-19T09:18:11.600Z`、dirty=false、结构 `0004-project-compatibility`；本地41865也已重启到此构建。
- 安装完成：`2026-10-19T09:22:01.054065+00:00`（北京时间17:22）；本次仅切换应用，部署配置和数据库结构未变。MySQL容器及启动时间保持，其他17个容器保持原运行。
- 镜像 `sha256:ab7c14a54228f1a8d90d5c62665cfb8504eadce445613de49f515ae408782a2a`；发布资产 [p04-detail-check-candidate-1d822c98bca2](https://github.com/zhilihz/geekdash/releases/tag/p04-detail-check-candidate-1d822c98bca2)。
- 新源码只改默认编辑、区域底部保存、人工说明显示、标题标记及普通检查入口。此前共享资料、经理选择和通知成果一起保留。

## 2. 切换与数据证据

切换前通过TAT核对旧6de87d2、健康、可用资源和代理；校验已推送构建及镜像包摘要。短暂维护期间停止旧app，生成两库完整备份，然后启动新app并核对健康/版本；逐表按主键顺序查询输出摘要、行数和迁移登记与切换前一致。SQL查询及mysqldump显式使用utf8mb4。原nginx内容恢复，current指向新release。

备份 `/var/backups/geekdash/pre-detail-simple-1d822c98bca2.sql.gz`，大小 78793 字节，SHA256 `a524da773fb245548d9640ac35d80184a5d680404138da0e6bf3da6d8de7cba5`；范围为geekdash_dev和geekdash_test全部表及routines/events/triggers。gzip流和DDL存在已核，本次没有另做恢复演练。摘要比较证明本次所查数据库内容在app切换期间保持，不替代未来灾难恢复演练。

服务器保留安装事实、私有日志、原nginx和切换前snapshot；仓库只保存[脱敏回读](../../evidence/2026-10-19-detail-simplification/remote-readback.json)。其中deployment.publicReadback=pending是安装完成瞬间的观察值，随后的公网结果见下节，不能据该旧字段误判后续未执行。

## 3. 公网回读

| 链路 | 实际结果 |
|---|---|
| 双经理创建→第二经理接续 | 测试项目25“智能门锁主控板 A1”，创建者及所选经理都有编辑资格；第二经理保存自然业务说明至v2 |
| 直接检查→其他页面消费 | 无预览直接保存检查至v3；双方新GET、首页今日标记、检查记录、回执和三条审计一致，两次HTTPS SSE均收到 |
| 检查不修改业务内容 | 名称、说明、状态、优先级、灯色和计划保持；仅一条检查，真实操作者、时间及v2→v3被独立utf8mb4 SQL确认 |
| 真实Edge读取 | 项目24显示标题右侧未查按钮、默认编辑、无修改标签；项目25人工说明原文可读、今日已查按钮隐藏，五个标记28px等高，无横向溢出 |
| 固定前端产物 | Edge禁缓存逐项核对8页、21份JS/CSS的SHA256与dist一致，健康构建前后一致，匿名项目请求401 |

证据：[公网业务](../../evidence/2026-10-19-detail-simplification/public-smoke.json)、[独立SQL](../../evidence/2026-10-19-detail-simplification/remote-readback.json)、[资源](../../evidence/2026-10-19-detail-simplification/public-resources.json)、[真实页面](../../evidence/2026-10-19-detail-simplification/public-detail.png)。本轮公网业务由独立HTTP会话执行，原生页面为读取和视觉核对；实际按钮操作在本地Edge完成，不能冒充公网原生写入。脚本会话退出，自建浏览器标签关闭，用户原标签保留。

顺序Python资源读取发生TLS握手超时，保留失败结果；沿已知错误卡改用Edge同源回读完成，没有关闭TLS验证或改系统代理。浏览器验证首轮把静态资源防缓存参数也加到了严格API查询上，匿名断言未通过；改用合法无附加参数请求后401通过，资源摘要结果保持。

## 4. 回退及剩余边界

前版为6de87d25d0aca6935c635699ad28de2b8db3a392、镜像 `sha256:48e15b0a8d675510901800c1a4b16ac3e47195dabde5a4b476b5a9e05ef89c15`，其schema同为0004。出现应用故障时按既有运维步骤保留当前数据、切回该应用并重验；不能用本次备份覆盖已开放后的新增写入，也不能换回0003应用。

尚未完成身份登录后返回原任务、全部草稿/结案交互收敛和完整P04验收。本次发布供用户测试上述修正，不代表全站、规模性能或真实数据导入准备完成。
