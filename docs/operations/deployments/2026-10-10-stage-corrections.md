# E04-B03 阶段纠错与回退测试部署

日期：2026-10-10。固定运行 `af5de712beccdb0da2726a400b7063c5a90d8393` 已合并并回读远端 main；后续文档提交不改变镜像。准确验证范围归[验收报告](../../testing/reports/2026-10-10-stage-corrections.md)。

## 产物与环境

- 本机 41860 和新加坡 https://geekdash.zhiluan.cool 同一干净 `stage-corrections` 构建，schema `0002-trial-save`。0001/0002 字节保持，无新增迁移；两库仍 34 表、314 列、55 外键。
- Linux/amd64 镜像 `sha256:1f1645728cfcd762f1135ec37ff9d84c7dc340a5bab0c30d13175d7fd08d982a`；镜像归档 SHA256 `9da4fd70a36414b3d33a76be77d8a3423f623c77c5f54e618964b133eac66f40`，运行包 SHA256 `82858cede8192b3ee89796671c3e53e835f3dbadf86d43fc4c033ef7db347308`。
- GitHub 预发布 `stage-corrections-af5de712becc`；云端校验归档、文件摘要、镜像身份和结构后，八类真实测试通过，再暂停本项目 app、备份并替换应用。
- 两库测试行数恢复；既有 dev 表字节指纹保持，无新增公共资料。MySQL ID/启动时间及其他 17 容器启动时间保持。[部署核对](../../evidence/2026-10-10-stage-corrections-deployment-check.json)。

## 数据与凭据

- 云备份 `/var/backups/geekdash/pre-stage-corrections-af5de712becc.sql.gz`，20802 字节，SHA256 `04c337e07b442dcae399765452afb3be3700ed148be7fedffd6c78f45f09b587`。
- 本机备份 `D:/geekwon/geekdash-data/backups/pre-stage-corrections-af5de712becc.sql.gz`，12716 字节，SHA256 `665a8f214b5822b7dd31ea4d65754703f094e903c2714ffda55708ca9f8b58f6`。[核对证据](../../evidence/2026-10-10-stage-corrections-local-backup-check.json)。两端均完整逻辑备份两库及 routines/events/triggers，未做隔离恢复。
- 公网新合成项目 10：business01/02 负责，当前版本 15、总体进行中、S1 待开始、S2 及以后未解锁、进度 0%。工期 7 天/评述、当前计划及首次应检依据在真实回退后保持。原项目 7/8/9 和 trial 保留。
- 本批没有初始化账号、重置密码或导入真实备份。交付仍用仓库外受控账号文件的当前密码；原会话值及操作正文只在受控材料保存，不进入 Git。

## 实际回读与恢复

公网真实保存、预览后他人修改的 409、完成日期明确未知、误开始/误完成撤销、真实返工回退、新详情/历史/看板及原回执隔离通过。16 项 HTML/JS/CSS 与固定产物逐字节一致。[公网证据](../../evidence/2026-10-10-stage-corrections-public-check.json)。本地原生浏览器验证见报告；公网完整原生页面联验仍待 B09。

实际停止/启动本项目 app 后，重启前的会话仍有效，项目版本 15、完整详情、15 条历史、公共规则和 11 个原动作结果保持；没有追加重复历史。MySQL 与其他容器保持，app OOMKilled=false、RestartCount=0。[进程核对](../../evidence/2026-10-10-stage-corrections-restart-check.json)、[公网重启后回读](../../evidence/2026-10-10-stage-corrections-restart-public-check.json)。

本批无结构变化，必要时按[发布维护](../release-maintenance.md)切回 B02 固定 `5aae00f` 应用，再新读验证；不能删除 MySQL、撤销既有纠错事实或换编号盲重放。收尾 available 693 MiB，swap 已用 1987 MiB，app 34.44/256 MiB、MySQL 551.6/768 MiB；本次没有观察到 OOM，需持续观测，不能据此承诺无资源波动。

B04～B09、服务器私人草稿/SSE、其他页面、真实导入、完整备份恢复和公司实际使用继续按对应工作包实施。
