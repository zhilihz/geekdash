# E04-B08需求变更A/B固定测试部署

日期：2026-10-12；本机41860与新加坡 https://geekdash.zhiluan.cool 同干净 `29ed3d900cadf4140ad9ff149e8b98e23f487e31` / project-changes /0003-node-recovery。构建时间2026-10-12T01:36:28.599Z，实现提交已合并并回读远端main；后续文档提交不改变运行镜像。

## 产物、结构与原数据

镜像 `sha256:49b6efc145004e6fd6070c11171f6be91cb9d2fc86ad77990a85620359e5c425`，Linux/amd64、node用户；GitHub测试预发布project-changes-29ed3d900cad。镜像归档SHA256=`7468f79562deef113593c229ca71385d004a1caf141599db70654face3b7ed33`，发布小包SHA256=`57e5a440314097abb82579021d4b9e3fef08f472eef202c2fea74a6f40c40b49`，严格16脚本清单。

本批无DDL，两端两库34表/315列/55外键，三份迁移的原字节/登记历史保持。升级前后全部业务字节指纹及test自身夹具保持；MySQL ID/启动时间、云其他17容器保持。准确来源为[本机](../../evidence/2026-10-12-project-changes-local-deployment-check.json)、[云部署](../../evidence/2026-10-12-project-changes-cloud-deployment-check.json)。

## 固定验证与实际资源

[固定验证](../../evidence/2026-10-12-project-changes-fixed-check.json)：284需求变更专项、217节点恢复、1360混合容量及工程/两库verify通过。云16条独立脚本与额外混合容量共17条退出0，需求变更/真实旧D/E导出服务同测试库回退、原回执及升级恢复成立；常驻公网本批没有执行回退。

500项目/3500阶段/2000物理节点/1000风险/1580检查/1000变更，四会话1360测量零错误，第501允许。云列表/详情/变更预览/保存P95=200/96/46/115ms，普通容量列表281ms。历史波动仍归B09，不能称公司公网或稳定200ms达标。工具256MiB/旧堆96MiB，常驻app约35.84MiB/256MiB，无OOM。

## 公网输入、持久保存与真实恢复

合成项目18/v8：客户接受、业务拒绝→另一负责人纠正四字段及误选决定→再核对接受→临时副本新增并纠正→文字/风险/节点/需求同次保存→同值无新版本→旧版本409。原ID/创建人姓名时间/来源元数据保持，不自动改变灯色、计划、阶段或检查。共4条需求、1风险、1节点及14审计，9原结果可确认，固定16项HTML/JS/CSS与公网字节一致；见[公网](../../evidence/2026-10-12-project-changes-public-check.json)。

实际app停止/启动，新启动时刻2026-10-12T01:59:40.577241442Z，同镜像ready；两原会话、新项目详情/历史和全部原结果保持，[重启](../../evidence/2026-10-12-project-changes-restart-check.json)、[公网新读](../../evidence/2026-10-12-project-changes-restart-public-check.json)。旧项目16/v13、17/v11，四原会话/25旧结果及原历史保持；跨周日期派生提示单独核对，持久事实不被旧日历快照误判，[原项目](../../evidence/2026-10-12-project-changes-original-public-check.json)。

## 备份、回退与接续

- `D:\geekwon\geekdash-data\backups\pre-changes-29ed3d900cad.sql.gz`：15234字节，SHA256=`242571461b5b2a94b98ccd177004f9986385081efb680a0fd593e341ae3a9955`。
- `/var/backups/geekdash/pre-changes-29ed3d900cad.sql.gz`：58944字节，SHA256=`fb2f39193fe2270149e6fea4db699ecd38c9b469c59c1958acb90d303c981493`。
- `/var/backups/geekdash/pre-dev-changes-29ed3d900cad.sql.gz`：58949字节，SHA256=`b99e7be0cd4bfb6fbe357d430bf6112a62b83875d4a6d09e22cd6a7fd1928bff`。

两库完整逻辑备份含routines/events/triggers，未执行隔离恢复或服务器外副本，不称完整恢复验收。真实用户备份未接入。回退使用0003兼容固定2a342d6；旧版不认识新changeOps，应保留原编号正文，再升级确认，不运行0002旧应用、清卷或覆盖后续数据。

current最终指向 `/opt/geekdash/releases/29ed3d900cadf4140ad9ff149e8b98e23f487e31`。TAT安装SUCCESS/exit0，完整事实文件压缩只读取回验长度，下载链接失效只重新下载同摘要文件，没有重复安装/初始化/改密。辅助与凭据仅在受控仓库外或忽略test-results。

B08代码/API/固定测试部署完成；原生控件/图交互沿AD-007仍待B09，HTTP和资源摘要不能代替页面验收。E04保持active，接续B09跨功能/性能与原生联验。
