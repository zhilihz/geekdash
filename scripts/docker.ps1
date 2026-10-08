$ComposeArgs = $args
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskOldRevision = $env:GEEKDASH_SOURCE_REVISION
$taskOldDirty = $env:GEEKDASH_SOURCE_DIRTY
$taskOldIgnoreOrphans = $env:COMPOSE_IGNORE_ORPHANS
Push-Location $taskRoot
try {
    $taskRevision = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw '无法读取源码版本' }
    $taskChanges = & git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw '无法读取未提交状态' }
    $env:GEEKDASH_SOURCE_REVISION = $taskRevision.Trim()
    $env:GEEKDASH_SOURCE_DIRTY = if ($taskChanges) { 'true' } else { 'false' }
    # MySQL 由补充 Compose 管理，基础命令不将它视为待清理容器。
    $env:COMPOSE_IGNORE_ORPHANS = 'true'
    & docker compose -p geekdash-dev -f deploy/compose.dev.yml @ComposeArgs
    $taskExit = $LASTEXITCODE
} finally {
    $env:GEEKDASH_SOURCE_REVISION = $taskOldRevision
    $env:GEEKDASH_SOURCE_DIRTY = $taskOldDirty
    $env:COMPOSE_IGNORE_ORPHANS = $taskOldIgnoreOrphans
    Pop-Location
}
exit $taskExit
