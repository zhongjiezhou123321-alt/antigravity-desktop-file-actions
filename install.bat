@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18+ 后重试。
  pause
  exit /b 1
)

echo 正在关闭 Antigravity 桌面端并安装补丁...
echo.
node cli.js install --kill
if %errorlevel% neq 0 (
  echo.
  echo [失败] 安装失败，请检查上方错误信息。
  pause
  exit /b %errorlevel%
)

if exist "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" (
  echo 正在重新启动 Antigravity 桌面端...
  start "" "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe"
)
echo.
echo [完成] 安装成功！
pause
