-- 仅用于已经过本镜像 verify 的数据库，且确实缺失 system_configuration.id=1。
-- 在停写窗口使用同一新连接执行整份脚本，勿使用 --force。任一步报错立即 ROLLBACK 并断开。
SET NAMES utf8mb4;
SELECT DATABASE() AS target_database, @@server_uuid AS server_uuid;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
START TRANSACTION;
SET @gd_admin = NULL;
SET @gd_request = UUID();
SELECT id INTO @gd_admin FROM users
WHERE login_name='admin' AND enabled=1 AND is_admin=1 AND deleted_at IS NULL
FOR UPDATE;

SET @gd_verified_target = DATABASE()='geekdash_dev' AND
  (SELECT MAX(version)='0016-project-name-reservation' AND COUNT(*)=16 FROM schema_migrations) AND
  EXISTS(SELECT 1 FROM schema_migrations WHERE version='0016-project-name-reservation' AND
    checksum=UNHEX('75B7FB62880535546B78A0F8484EF968F7BA5A3A7FCA71656DBFECAAE5F7B9EF'));
INSERT INTO system_configuration
  (id, maintenance_user_id, full_name, short_name, manager_text, name_prefix, updated_by, updated_at)
SELECT 1, @gd_admin, '', '', '', '', @gd_admin, UTC_TIMESTAMP(3)
WHERE @gd_verified_target AND @gd_admin IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM system_configuration WHERE id=1);
SET @gd_inserted = ROW_COUNT();
INSERT INTO audit_log
  (actor_kind, actor_display_name, action, entity_type, entity_id, before_json, after_json, request_id, created_at)
SELECT 'system', '系统配置修复', 'system.configuration.repair', 'system_configuration', 1, 'null',
       JSON_OBJECT('maintenanceUserId', CAST(@gd_admin AS CHAR)), @gd_request, UTC_TIMESTAMP(3)
WHERE @gd_inserted=1;
COMMIT;

SELECT @gd_inserted AS inserted_rows, CASE
  WHEN NOT @gd_verified_target THEN 'STOP_WRONG_TARGET'
  WHEN @gd_inserted=1 THEN 'ADDED'
  WHEN EXISTS (SELECT 1 FROM system_configuration WHERE id=1) THEN 'ALREADY_PRESENT'
  ELSE 'STOP_NO_ENABLED_ADMIN' END AS result;
SELECT id, maintenance_user_id, version, updated_by, updated_at FROM system_configuration WHERE id=1;
