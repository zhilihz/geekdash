# 本地数据库入口；使用普通参数数组，保留下游命令的 -e 等选项。
$taskArgs = $args
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSecrets = Join-Path (Split-Path -Parent $taskRoot) 'geekdash-data/secrets'
$taskData = Join-Path (Split-Path -Parent $taskRoot) 'geekdash-data/mysql'
$taskFiles = @('root.password', 'root-client.cnf', 'bootstrap.sql', 'dev_app.json', 'dev_migrator.json', 'test_app.json', 'test_migrator.json')

if ($taskArgs.Count -eq 1 -and $taskArgs[0] -eq 'init-config') {
    New-Item -ItemType Directory -Path $taskData -Force | Out-Null
    $taskPresent = @($taskFiles | Where-Object { Test-Path -LiteralPath (Join-Path $taskSecrets $_) -PathType Leaf })
    if ($taskPresent.Count -eq $taskFiles.Count) {
        Write-Output '本地数据库配置已存在；未覆盖凭据。请继续真实连接核验。'
        exit 0
    }
    if ($taskPresent.Count -ne 0) { throw '配置不完整；保留已有文件，核对后受控修复，禁止重新生成覆盖。' }
    New-Item -ItemType Directory -Path $taskSecrets -Force | Out-Null
    $taskAcl = [System.Security.AccessControl.DirectorySecurity]::new()
    $taskAcl.SetAccessRuleProtection($true, $false)
    foreach ($taskSid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $taskRule = [System.Security.AccessControl.FileSystemAccessRule]::new($taskSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $taskAcl.AddAccessRule($taskRule)
    }
    Set-Acl -LiteralPath $taskSecrets -AclObject $taskAcl
    $taskUtf8 = [System.Text.UTF8Encoding]::new($false)
    $taskRootPassword = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    [System.IO.File]::WriteAllText((Join-Path $taskSecrets 'root.password'), $taskRootPassword, $taskUtf8)
    [System.IO.File]::WriteAllText((Join-Path $taskSecrets 'root-client.cnf'), "[client]`nuser=root`npassword=$taskRootPassword`n", $taskUtf8)
    $taskSql = "CREATE DATABASE geekdash_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`nCREATE DATABASE geekdash_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;`n"
    foreach ($taskScope in @('dev', 'test')) {
        foreach ($taskRole in @('app', 'migrator')) {
            $taskProfile = "${taskScope}_${taskRole}"
            $taskUser = "gd_$taskProfile"
            $taskDatabase = "geekdash_$taskScope"
            $taskPassword = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
            $taskConfig = @{ host = 'mysql'; port = 3306; database = $taskDatabase; user = $taskUser; password = $taskPassword } | ConvertTo-Json
            [System.IO.File]::WriteAllText((Join-Path $taskSecrets "$taskProfile.json"), $taskConfig.Replace("`r`n", "`n") + "`n", $taskUtf8)
            $taskPrivileges = if ($taskRole -eq 'app') { 'SELECT, INSERT, UPDATE, DELETE' } else { 'SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES' }
            $taskSql += "CREATE USER '$taskUser'@'%' IDENTIFIED BY '$taskPassword';`nGRANT $taskPrivileges ON $taskDatabase.* TO '$taskUser'@'%';`n"
        }
    }
    [System.IO.File]::WriteAllText((Join-Path $taskSecrets 'bootstrap.sql'), $taskSql, $taskUtf8)
    Write-Output '本地数据库配置已建立于仓库外，仅当前 Windows 用户与 SYSTEM 授权；未创建数据库。'
    exit 0
}

if ($taskArgs.Count -eq 0) { throw '用法：database.ps1 init-config 或 database.ps1 <docker compose 参数>' }
foreach ($taskFile in $taskFiles) {
    if (!(Test-Path -LiteralPath (Join-Path $taskSecrets $taskFile) -PathType Leaf)) { throw '缺少受控配置文件，请先执行 database.ps1 init-config；已有配置不要覆盖。' }
}
$taskOldConfigDir = $env:GEEKDASH_DB_CONFIG_DIR
$taskOldDataDir = $env:GEEKDASH_DB_DATA_DIR
if (!(Test-Path -LiteralPath $taskData -PathType Container)) { throw '缺少独立数据目录，请先执行 init-config。' }
Push-Location $taskRoot
try {
    $env:GEEKDASH_DB_CONFIG_DIR = $taskSecrets.Replace('\', '/')
    $env:GEEKDASH_DB_DATA_DIR = $taskData.Replace('\', '/')
    & docker compose -p geekdash-dev -f deploy/compose.dev.yml -f deploy/compose.mysql.yml @taskArgs
    $taskExit = $LASTEXITCODE
} finally {
    $env:GEEKDASH_DB_CONFIG_DIR = $taskOldConfigDir
    $env:GEEKDASH_DB_DATA_DIR = $taskOldDataDir
    Pop-Location
}
exit $taskExit
