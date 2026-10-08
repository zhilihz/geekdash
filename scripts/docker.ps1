$ComposeArgs = $args
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskOldRevision = $env:GEEKDASH_SOURCE_REVISION
$taskOldDirty = $env:GEEKDASH_SOURCE_DIRTY
Push-Location $taskRoot
try {
    $taskRevision = & git rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw '无法读取源码版本' }
    $taskChanges = & git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw '无法读取未提交状态' }
    $env:GEEKDASH_SOURCE_REVISION = $taskRevision.Trim()
    $env:GEEKDASH_SOURCE_DIRTY = if ($taskChanges) { 'true' } else { 'false' }
    & docker compose -p geekdash-dev -f deploy/compose.dev.yml @ComposeArgs
    $taskExit = $LASTEXITCODE
} finally {
    $env:GEEKDASH_SOURCE_REVISION = $taskOldRevision
    $env:GEEKDASH_SOURCE_DIRTY = $taskOldDirty
    Pop-Location
}
exit $taskExit
