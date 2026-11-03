-- Docker 测试版 0015→0016。仅在已建表的目标库执行，仅查询；升级前后各用一个新连接执行一次。
-- 任一查询报错即停止。库名、UUID 与备份不符，或出现 STOP 时，不执行升级。
SET NAMES utf8mb4;
SELECT DATABASE() AS target_database, @@server_uuid AS server_uuid, VERSION() AS mysql_version;

-- 与本次镜像 dist/migrations 原始字节的 SHA-256 比较，保留实际值供排查。
WITH expected (version, sha256) AS (VALUES
  ROW('0001-foundation', '1934EFD766256A898718E1114B4D763ED30CD62EF6E08D1A3F4D0FDEB6E63101'),
  ROW('0002-trial-save', '51BA9DD2943F8E27B226074B2C1C6053E876F009563017D17B107D3B7DE6A695'),
  ROW('0003-node-recovery', '4A5B38BD7C84EA230D9D2B1B0B7F93C575107F20C5DF9968109901C09296E578'),
  ROW('0004-project-compatibility', '98EA64154F89C74CA08274F0D74BE2998616D9B4AE4749FC9F544FB80F160E8A'),
  ROW('0005-check-facts', '1B70D74C3FF84FDCC8F5587E2AB2007D20801E33B8E9F8720894A43458E40FB8'),
  ROW('0006-imports', '08E1941425E3F57B5586B0C01F7B124F24074CD9C064B413109CA8345B837811'),
  ROW('0007-import-executions', '6C0C71CCF5C0744A7E21E7AD5B3937592570DEADDF3DDEF193734A86AA780B6A'),
  ROW('0008-import-name-bindings', '3BD4B83963CD35418A14D209B4D15DC69F603C391D89A488562352F9B5DD52A6'),
  ROW('0009-project-space', '2CFF897DD8ADE0BFCFDD43EF2F54050443C39740EB55082EC17DC6B772A68D45'),
  ROW('0010-project-editing', '89201582D29696FEE578F7923929CB721384971437D55CC30BA693C83441158E'),
  ROW('0011-accounts-check-settings', '52400EF47ADABD3EED96A62F15B82354B0B3F3A1730278E06561B69D6D6A81D2'),
  ROW('0012-account-management', '34BD7C1C319A1E4A1311C41BB91A42F60043C7361A58CD890D7C4B93C86EBAAC'),
  ROW('0013-account-capabilities', 'E19A0E0FD521DCCD643BE9E930FEAE346885AA7150E51E04508A3B774960EF1D'),
  ROW('0014-project-tasks', 'EA8AB833AA7044DC346C4BB1ADC08D8A1A0315822238CFD7E6FE43E1F8FDD191'),
  ROW('0015-project-deletion', '24285C65D6B6B1997FE06378BC949A29C82B254E09BEC8F17F7DF165660C7D52'),
  ROW('0016-project-name-reservation', '75B7FB62880535546B78A0F8484EF968F7BA5A3A7FCA71656DBFECAAE5F7B9EF')
)
SELECT CONVERT(e.version USING ascii) COLLATE ascii_bin AS version, HEX(m.checksum) AS actual_sha256, e.sha256 AS docker_sha256,
  CASE WHEN m.version IS NULL AND e.version='0016-project-name-reservation' THEN 'PENDING_0016'
       WHEN m.version IS NULL THEN 'STOP_MISSING'
       WHEN e.version='0009-project-space' AND HEX(m.checksum)='AE13B1B36FADACEA3F46542B4033D2B181E0732E8DC09BBDB62D10D0DE670A43' THEN 'MATCH_RELEASED_LF'
       WHEN HEX(m.checksum)<>e.sha256 THEN 'STOP_CHECKSUM'
       ELSE 'MATCH' END AS ledger_result
FROM expected e LEFT JOIN schema_migrations m ON m.version=CAST(e.version AS BINARY)
UNION ALL
SELECT m.version, HEX(m.checksum), NULL, 'STOP_UNKNOWN'
FROM schema_migrations m LEFT JOIN expected e ON m.version=CAST(e.version AS BINARY)
WHERE e.version IS NULL ORDER BY version;

SELECT (SELECT COUNT(*) FROM projects) AS projects_total,
       (SELECT COUNT(*) FROM projects WHERE deleted_at IS NOT NULL) AS deleted_projects,
       (SELECT COUNT(*) FROM projects WHERE name_key IS NULL) AS null_name_keys,
       (SELECT COUNT(*) FROM users) AS accounts,
       (SELECT COUNT(*) FROM system_configuration WHERE id=1) AS configuration_rows,
       (SELECT COUNT(*) FROM import_executions WHERE status<>'finished') AS unfinished_imports,
       EXISTS(SELECT 1 FROM audit_log WHERE action='identity.harbor.initialize'
              AND request_id='harbor-cc4a34b') AS docker_initialized;

-- 与项目名称的 String.trim() 对齐，使用 ECMAScript 空白/换行码点和 UTF-8 字节比较。
-- 每条冲突记录只返回项目 ID；历史项目与现存项目一起预检。0015 的缺失键由迁移器回填。
SET @gd_whitespace = CONVERT(UNHEX('090A0B0C0D20C2A0E19A80E28080E28081E28082E28083E28084E28085E28086E28087E28088E28089E2808AE280A8E280A9E280AFE2819FE38080EFBBBF') USING utf8mb4);
SET @gd_edges = CONCAT('^[', @gd_whitespace, ']+|[', @gd_whitespace, ']+$');
WITH names_trimmed AS (
  SELECT id, name_key, REGEXP_REPLACE(name COLLATE utf8mb4_bin, @gd_edges, '') AS trimmed
  FROM projects
), project_keys AS (
  SELECT id, CHAR_LENGTH(trimmed) AS key_length,
         COUNT(*) OVER (PARTITION BY CAST(trimmed AS BINARY)) AS same_name_count,
         NOT (name_key <=> CAST(trimmed AS BINARY)) AS key_needs_fill
  FROM names_trimmed
)
SELECT id, key_length, same_name_count, key_needs_fill FROM project_keys
WHERE key_length NOT BETWEEN 1 AND 255 OR same_name_count>1 OR key_needs_fill=1
ORDER BY id;

SELECT COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='projects' AND COLUMN_NAME='name_key';
SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='projects' AND INDEX_NAME='uk_projects_name_key'
ORDER BY SEQ_IN_INDEX;
