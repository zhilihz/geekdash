# GeekDash 部署。

> 旧Compose合一包说明。新目标已改为阿里云K3s+RDS，此包不适用于该新环境；当前目标见[新部署说明](../k3s-rds/GeekDash部署交接.md)。

## 部署步骤

镜像：以随包 `.env.example` 中的 `GEEKDASH_IMAGE` 为准。

当前为 Linux amd64 单镜像，包含应用和 MySQL 8.4，Nginx 单独配置。首次启动自动建表，仅初始化 `admin`，沿用原密码，不带旧业务数据。

服务器将 `.env.example` 复制为 `.env`，填写 `GEEKDASH_ORIGIN=https://实际域名`，末尾不加 `/`，再执行：

```bash
docker login harbor.geekwontek.com
docker compose pull
docker compose up -d --wait --wait-timeout 300
```

## 特殊要求

- **代理：**宿主 Nginx 转到 `127.0.0.1:41860`，传递 Host 和转发来源、协议头；上传上限 `32m`。
- **实时通知：**`/api/events` 使用 HTTP/1.1，清空 Connection 头，关闭代理缓冲和缓存，读取超时 `60s`。
- **数据：**保留 Compose 的 `data` 卷和项目名 `geekdash-harbor`，不执行 `down -v`。备份包含数据库、导入原文件和配置。
- **运行：**保持一个应用实例。
