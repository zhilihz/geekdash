# P04资料权限与操作收敛测试部署（2026-10-20）

## 1. 实际版本与范围

- 环境：既有新加坡测试服务器，公网 https://geekdash.zhiluan.cool 。
- 产品提交 `60a1c7f356db0639cc816f387ede3f70d98b11f6`，已推送并远端回读施工分支 `codex/p04-flow-convergence`；main仍为 `b96712a8d7e48a14663b553f54903b7ccb157f6e`。完整P04未验收，本次未合并main。
- 本地41865与公网运行相同干净构建 `2026-10-20T02:54:29.584Z`、结构 `0005-check-facts`。
- 安装完成 `2026-10-20T02:59:44.739387+00:00`；仅GeekDash应用切换及两库0004→0005迁移。MySQL实例与启动时间保持，其余被核对的119个已有容器（含停止的历史工具容器）状态保持；没有停止其他业务容器。
- 镜像 `sha256:2e739df5fb2b14fe4c88cfbf30d11fc5c8fcd0644f737710e723f31c2bf656da`；[固定发布资产](https://github.com/zhilihz/geekdash/releases/tag/p04-fact-simplification-candidate-60a1c7f356db)。
- 范围：DEC-132～134，资料向启用业务账号开放、取消周检查规则并保留事实、普通纠错和阶段等操作减少重复表单。完整行为归SPEC/PRD，[本轮验证](../../testing/reports/2026-10-20-operation-simplification.md)记录范围。

## 2. 迁移与数据保持

先核旧版本1d822c9、资源、代理及镜像包摘要，再将本项目短暂设为维护、停止app。完成两库备份，随后分别迁移和verify；两库都通过数据比较后才启动新app，恢复原nginx及current链接。

备份 `/var/backups/geekdash/pre-fact-simplification-60a1c7f356db.sql.gz`，80740字节，SHA256 `5d845391c46dc500b3a6c4fa9e803344c9bd688f38baebcaeb772b9f6746e259`。覆盖geekdash_dev和geekdash_test完整表及routines/events/triggers，显式utf8mb4与二进制列；gzip可读、两库及完成标记已核。本轮没有另做恢复演练，不能把备份读取代替恢复验证。

34表逐格用NULL标志或HEX值编码，按主键排序比较；行数、列名/顺序、主键与业务值摘要保持，旧四次迁移登记（含应用时间）保持，仅新增0005登记。检查week_start/rule_version可空及旧规则外键已核。没有删除旧检查、规则或回执，也没有导入真实备份。

[独立回读及部署事实](../../evidence/2026-10-20-operation-simplification/remote-readback.json)包含数据证据。deployment.publicReadback=pending是安装完成瞬间的旧状态，后续公网已验如下。

## 3. 公网实际验证

| 用户链路 | 结果 |
|---|---|
| 创建并选另一经理→另一经理接续 | 合成项目26，由business01创建并选business02；后者正式保存状态说明至v2，双方均有编辑资格 |
| 直接检查→下一处消费 | 一次检查至v3；双方详情、首页今日标记、检查记录、审计及原请求回执一致，两个HTTPS SSE均实际收到 |
| 事实保持 | 新检查week/rule为NULL，真实人/时刻/v2→v3记录；业务说明和其他普通字段保持，独立utf8mb4 SQL及三份持久回执确认 |
| 基础资料权限 | 启用普通业务账号的资料canMaintain与新建候选businessDate可读；资料写入完整链已在隔离库验证，本轮公网未修改公共资料 |
| 固定前端及真实页面 | Edge禁缓存核对8页21资源SHA与dist一致、匿名项目401；项目26默认可编辑、人工说明保持、无周规则提示/设置链接、无横向溢出 |

证据：[公网业务](../../evidence/2026-10-20-operation-simplification/public-smoke.json)、[资源](../../evidence/2026-10-20-operation-simplification/public-resources.json)、[真实页面观察](../../evidence/2026-10-20-operation-simplification/public-native.json)、[截图](../../evidence/2026-10-20-operation-simplification/public-native.png)。公网业务由独立HTTP会话执行，原生页面为导航/读取；本地Edge实际按钮链另见报告。脚本会话已退出，自建浏览器标签随后关闭，用户原页保持。

## 4. 失败恢复与未完成范围

0004应用不兼容0005库，不能直接切回旧镜像或恢复迁移前备份覆盖后续写入。若出现故障，保留当前数据及备份，使用兼容0005的构建修复；迁移后的安装失败路径保持维护和停app，不自动降级。实际本次安装已成功。

完整P04、所有Figma画板对照、实际PDF输出、全部身份返回/草稿跨页组合及长时并发仍未全验。本次已交付限定修正供测试，不代表全阶段完成。
