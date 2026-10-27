# 2026-10-27 GeekDash 数据清理（非代码部署）

用户明确确认本地和线上均清理、保留maint01与当前密码。先停止本项目应用，完整备份数据库/导入文件/配置；服务器外加密副本认证解密并核对归档成员后，执行清理，再逐条检查外键、剩余计数和恢复服务。其他Docker服务、数据库容器和已有备份未删除。

| 环境 | 操作目标 | 实际结果 |
|---|---|---|
| 本地41870 | geekdash-editing-20261027-ui/mysql，geekdash_test | 原63个项目及本轮合成数据已清理；只保留maint01，项目/导入/基础资料为0；当前0012 |
| 新加坡lhins-d3hgdloj | geekdash-app-1/mysql-1，geekdash_dev/test | 线上原43个项目清理；dev只留maint01，项目/导入/资料为0；test保持无业务数据；仍原0009代码 |

维护账号密码摘要清理前后相同（仅校验，不录入本文），全部旧会话撤销。schema_migrations保留；现行配置及最新CHECK规则保留，维护引用归maint01。常规账号删除保留历史，本次全环境重置是用户单独授权，不能混为一个接口。

恢复入口：本地D:/geekwon/geekdash-data/backups/reset-20261027-local/full.aes256gcm；线上D:/geekwon/geekdash-data/backups/reset-20261027-remote/full.aes256gcm，对应服务器/var/backups/geekdash/reset-20261027-remote。密钥分别存放D:/geekwon/geekdash-data/secrets/reset-20261027-{local,remote}-backup-key.json并限制ACL；本地明文备份副本已删除。恢复必须先停应用并核当前迁移版本，不直接用旧库覆盖0012。

两边ready均200；本地login/register/password/accounts/imports页面HTTP200。原生使用未代验，线上未发布本轮代码。完整脱敏计数见[证据](../../evidence/2026-10-27-account-cleanup.json)。执行脚本及私有回执留在忽略的test-results/cleanup-*，其中一次性清理脚本不随产品运行，也不提供网页重置入口。
