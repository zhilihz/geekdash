# P05 持久导入修正部署记录

日期：2026-10-23。范围：DEC-154/155，同服务持久执行、旧写入口清退、已确认资料名称对应承接。真实业务批次不自动采用。

## 1. 固定产物与环境

- 代码：`154e34cfdcd725ccbbae6d4aef8d04070d53e460`，从`codex/p05-durable-import`快进合并远端main，已回读引用。
- 构建：`2026-10-23T09:12:34.092Z`，dirty=false，结构`0008-import-name-bindings`。
- 镜像：`sha256:744dd2b6152aa4ee2f021c135cc3a1760d36e24df6196468ff7bbb6e06b6bdc3`；运行入口 [GeekDash](https://geekdash.zhiluan.cool/imports.html)。
- 安装完成：`2026-10-23T09:21:49.962433+00:00`；前版`1c0e1d228814591fa1cdc24d92861fcfdab84f04`，仅GeekDash应用及本项目迁移。独立双库从37表/6迁移升为38表/8迁移，运行结构验证通过。

## 2. 备份及保留证明

| 内容 | 受控服务器位置 | SHA-256 |
|---|---|---|
| 两个完整数据库，含触发器/事件/例程和二进制列 | `/var/backups/geekdash/pre-p05-durable-154e34cfdcd7.sql.gz` | `ecef968b01d69b364bf9a800bf8ba43bb0c2d225d9932bd32277647889eaec89` |
| 原导入文件、运行配置、原清单和nginx配置 | `/var/backups/geekdash/pre-p05-durable-154e34cfdcd7-files.tar.gz` | `154b02766c3f1a121be1aa87e08ece0f87713832c14db0f3bc48f081bef9d2b6` |

备份时应用已停止写入，压缩流及双库完成标识通过，部署后独立回读核文件摘要。原37表结构、原行字节与6条原迁移登记保持；dev仅补4条可靠名称绑定，test未补绑定。MySQL容器身份和启动时间保持，119个其他容器状态/镜像/重启次数保持。nginx继续普通JSON压缩与独立SSE位置。

本轮没有重做0008完整备份恢复演练；不能将此前0006恢复记录写成0008恢复证据。

## 3. 公网验证及数据范围

批5/6、项目34/35为明确命名且简介注明无真实业务数据的合成验收，保留供复核，实际dataKind沿正常业务导入。一次命令、重复请求、SSE、新请求下游、独立SQL、原文件哈希及同来源重复导入通过。原用户批3仍2已处理/33待处理，仅只读核查。Edge9页26资源匹配；暖色批次→已处理→正式详情接续通过。

准确检查及边界见[导入链报告第9节](../../testing/reports/2026-10-23-p05-import-chain.md#9-固定发布与公网回验2026-10-23)，脱敏摘要见[证据](../../evidence/2026-10-23-p05-durable-import.json)。

## 4. 恢复与接手

现0008应用严格检查结构，不启动只理解0006的旧应用。若需暂停导入，沿既有server.sh/manifest.env将当前兼容镜像的`GEEKDASH_IMPORT_WRITES=disabled`生效，仅阻止新导入与后续执行，已有项目读取/保存和结果查询保留。先保存当前数据和日志，确定原执行状态；恢复时按原命令续接，不重新生成操作编号，不自动用旧备份覆盖新增数据。

服务器发布事实：`/opt/geekdash/incoming/154e34cfdcd725ccbbae6d4aef8d04070d53e460/p05-durable-deployment-facts.json`。下载及安装调用已有确定成功，不能重复运行安装模板。源码文档的后续提交不改变本次已验镜像。
