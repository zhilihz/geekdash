@echo off
chcp 65001 >nul
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo 未找到 Python。请安装 Python 3 并勾选 Add Python to PATH，或沿用现有的本地 HTTP 服务。
  pause
  exit /b 1
)
echo GeekDash V1.051 本地运行：http://127.0.0.1:41871/GeekDash.html
echo 使用期间保持本窗口打开，关闭窗口即可停止本地服务。
start "" "http://127.0.0.1:41871/GeekDash.html"
python -m http.server 41871 --bind 127.0.0.1 --directory "%~dp0."
pause
