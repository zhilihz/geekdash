#!/usr/bin/env bash
set -Eeuo pipefail
if (( $# )) && [[ $# != 1 || $1 != upgrade ]]; then
  echo '用法：默认启动应用；upgrade 仅升级已停服的原数据卷。' >&2
  exit 2
fi
if [[ ${1-} == upgrade && ! -d /var/lib/mysql/mysql-data/mysql ]]; then
  echo '原数据卷缺少 MySQL 数据目录；空卷请用默认入口初始化。' >&2
  exit 1
fi
mysql_pid=''
app_pid=''
shutdown() {
  local code=$?
  trap - EXIT TERM INT
  if [[ -n "$app_pid" ]]; then kill -TERM "$app_pid" 2>/dev/null || true; wait "$app_pid" || true; fi
  if [[ -n "$mysql_pid" ]]; then kill -TERM "$mysql_pid" 2>/dev/null || true; wait "$mysql_pid" || true; fi
  exit "$code"
}
trap shutdown EXIT
trap 'exit 0' TERM INT
if [[ ${1-} == upgrade ]]; then trap 'exit 143' TERM; trap 'exit 130' INT; fi
node /app/initialize.mjs prepare
mkdir -p /run/secrets
for name in mysql_root mysql_health.cnf bootstrap.sql dev_app.json dev_migrator.json admin-account.json; do
  cp -p "/var/lib/mysql/config/$name" "/run/secrets/$name"
done
mv /run/secrets/dev_app.json /run/secrets/dev_app
mv /run/secrets/dev_migrator.json /run/secrets/dev_migrator
mv /run/secrets/admin-account.json /run/secrets/admin_account
ln -sf /run/secrets/bootstrap.sql /docker-entrypoint-initdb.d/01-geekdash.sql
export MYSQL_ROOT_PASSWORD_FILE=/run/secrets/mysql_root MYSQL_INITDB_SKIP_TZINFO=1
/usr/local/bin/docker-entrypoint.sh mysqld --datadir=/var/lib/mysql/mysql-data \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_0900_ai_ci \
  --default-time-zone=+00:00 --bind-address=127.0.0.1 --mysqlx=OFF \
  --innodb-buffer-pool-size=134217728 --max-connections=32 &
mysql_pid=$!
ready=0
for ((attempt=0; attempt<180; attempt++)); do
  kill -0 "$mysql_pid" 2>/dev/null || { echo 'MySQL 启动失败。' >&2; exit 1; }
  # 临时初始化数据库不监听 TCP；必须等正式服务启动后再执行迁移。
  if mysql --defaults-extra-file=/run/secrets/mysql_health.cnf --protocol=TCP -h127.0.0.1 -Nse 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo 'MySQL 就绪检查超时。' >&2; exit 1; }
if [[ ${1-} == upgrade ]]; then
  mysql_args=(--defaults-extra-file=/run/secrets/mysql_health.cnf --protocol=TCP -h127.0.0.1 -Ns geekdash_dev)
  eligible=$(mysql "${mysql_args[@]}" -e "SELECT MAX(version) IN ('0015-project-deletion','0016-project-name-reservation')
    AND EXISTS (SELECT 1 FROM audit_log WHERE action='identity.harbor.initialize' AND request_id='harbor-cc4a34b')
    AND NOT EXISTS (SELECT 1 FROM import_executions WHERE status<>'finished') FROM schema_migrations")
  [[ $eligible == 1 ]] || { echo '升级停止：请核对初始化标记、0015/0016 迁移记录和未结束导入。' >&2; exit 1; }
  node /app/dist/server/commands/database.js migrate dev_migrator
  node /app/dist/server/commands/database.js verify dev_migrator
  exit 0
fi
node /app/initialize.mjs seed
rm -f /run/secrets/dev_migrator /run/secrets/admin_account
gosu 1000:1000 node /app/dist/server/start.js &
app_pid=$!
# 任一关键进程退出时终止另一进程，让容器的重启策略接管。
wait -n "$mysql_pid" "$app_pid" || true
echo '应用或数据库进程退出，停止容器。' >&2
exit 1
