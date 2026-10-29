@echo off
chcp 65001 >nul
setlocal
set "HARBOR_HOST=harbor.geekwontek.com"
set "IMAGE_TARGET=harbor.geekwontek.com/geek-dash/geekdash:V0.1.1-cc4a34b"
set "SOURCE_IMAGE=geekdash:V0.1.1-cc4a34b"
set "EXPECTED_ID=sha256:87c653894be0f325484df41df092e8f27d29fbc2a50741e7c3e33e773398f408"
set "ACTUAL_ID="
set "PLATFORM="
set "CHECK_OUTPUT=%TEMP%\geekdash-image-%RANDOM%-%RANDOM%.txt"
echo 正在查询本地 Docker 镜像，最长等待 30 秒……
powershell -NoProfile -NonInteractive -Command ^
  "$ErrorActionPreference='Stop'; try { $p=New-Object System.Diagnostics.Process; $p.StartInfo.FileName='docker'; $p.StartInfo.Arguments='image inspect '+$env:SOURCE_IMAGE+' --format={{.Id}}/{{.Os}}/{{.Architecture}}'; $p.StartInfo.UseShellExecute=$false; $p.StartInfo.RedirectStandardOutput=$true; [void]$p.Start(); $output=$p.StandardOutput.ReadToEndAsync(); if(-not $p.WaitForExit(30000)) { $p.Kill(); Write-Host 'Docker 引擎查询超时，尚未开始上传。请检查 Docker Desktop。'; exit 124 }; [IO.File]::WriteAllText($env:CHECK_OUTPUT,$output.GetAwaiter().GetResult()); exit $p.ExitCode } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 goto query_failed
for /f "usebackq tokens=1,2,3 delims=/" %%I in ("%CHECK_OUTPUT%") do (
  set "ACTUAL_ID=%%I"
  set "PLATFORM=%%J/%%K"
)
del "%CHECK_OUTPUT%"
if not "%ACTUAL_ID%"=="%EXPECTED_ID%" goto invalid
if not "%PLATFORM%"=="linux/amd64" goto invalid
echo 已核验一个完整镜像：%SOURCE_IMAGE%
echo 上传位置：%IMAGE_TARGET%
if /I "%~1"=="-CheckOnly" goto checked
docker login %HARBOR_HOST%
if errorlevel 1 goto failed
docker tag %EXPECTED_ID% %IMAGE_TARGET%
if errorlevel 1 goto failed
docker push %IMAGE_TARGET%
if errorlevel 1 goto failed
docker buildx imagetools inspect %IMAGE_TARGET%
if errorlevel 1 goto failed
echo 完成：一个镜像已上传并回读，包含应用、MySQL 和自动初始化程序。
exit /b 0
:checked
echo 本地校验完成，没有执行上传。
exit /b 0
:invalid
echo 本地镜像版本或平台不符，停止上传。
echo 预期：%EXPECTED_ID% / linux/amd64
echo 实际：%ACTUAL_ID% / %PLATFORM%
exit /b 1
:query_failed
if exist "%CHECK_OUTPUT%" del "%CHECK_OUTPUT%"
echo Docker 本地镜像查询失败，原始错误见上方；尚未开始上传。
echo 请先确认 Docker 引擎能响应，再检查镜像是否存在，不能据此认定镜像丢失。
exit /b 1
:failed
echo 上传或回读失败，请处理上述错误后重跑，已上传的镜像层会复用。
exit /b 1
