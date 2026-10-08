# 新加坡测试机首次工程基底部署

日期：2026-10-08；环境：现有新加坡 Lighthouse / Ubuntu 24.04，共享主机；当前服务 https://geekdash.zhiluan.cool ，免登录工程首页。

## 实际运行版本

- 代码：c5606688d9cdf73716b0fdecba53a789f319a9fa，dirty=false，构建时间 UTC 2026-10-08T09:40:34.667Z。
- app 镜像：sha256:6f793ee97dff1ea2790f0b960bc20ac4f8c72efc3f5af0bbfb0768aa49a5e9c6；平台 linux/amd64。
- MySQL 8.4.11，既定固定摘要；两库 0001-foundation，完整结构见[验收](../../testing/reports/2026-10-08-cloud-foundation.md)。未导入业务数据。
- 公网回读 UTC 2026-10-08T09:51:41Z（北京时间 17:51:41）：home/live/ready 200，实际代码版本一致；TLS 域名/链有效，证书到期 UTC 2027-01-06T08:37:05Z（北京时间 16:37:05）。证书续期 dry-run 与 reload hook 已执行通过。

## 环境落位与接续

Compose 项目 geekdash；current 指向 /opt/geekdash/releases/c5606688d9cdf73716b0fdecba53a789f319a9fa。数据 /var/lib/geekdash/mysql，技术配置 /opt/geekdash/config/secrets。日常命令及实际参数唯一归[发布维护](../release-maintenance.md#linux-服务器实际运行入口)，此处不复制流程。

入口接现有宿主机 Nginx，仅新增 geekdash 站点，A 记录由用户在阿里云配置；代理至 127.0.0.1:41860，MySQL 内部 3306。本站 TLS 只启用已验收 IPv4 监听，不宣称 IPv6/HTTP2 验收。正常 reload 后仅保留一个发布前已有的其他站点协议警告。

固定产物在本机生成，镜像经私有 GitHub 预发布资产传输，以整包摘要和镜像 ID 验证后加载。临时 SFTP 仅传小包，密钥已撤销、私钥已删除、自身上传暂存已清理。服务器无 GitHub 长期登录凭据；公开文档不含签名下载链接、IP/实例 ID、业务数据或秘密。

## 已验证的回退与边界

已真实切回兼容的 56a054f71f18b780088559a71c14cdecd58301f8 镜像并 HTTPS 回读，再恢复最终版；当前仍最终版，两者同 0001。切换未重启 MySQL 或恢复备份，原数据目录保留。首次基底恢复与版本回退证据见[脱敏产物](../../evidence/2026-10-08-cloud-foundation-check.json)。后续有新迁移时须重新验证兼容，不能套用本次空库结果。

备份暂存目录已建立但未运行完整备份/异地副本/隔离恢复；E11 与 Q-016 仍待实施。业务、身份、四人使用验收尚未完成。Git 合并/推送另行记录，云运行不自动随 Git 更新。
