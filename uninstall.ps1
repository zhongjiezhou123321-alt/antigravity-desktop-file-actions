$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error '未检测到 Node.js，请先安装 Node.js 18+ 后重试。'
    exit 1
}

$cliPath = Join-Path $PSScriptRoot 'cli.js'
Write-Host '正在关闭 Antigravity 桌面端并卸载文件右键补丁...' -ForegroundColor Cyan
& node $cliPath uninstall --kill
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$exePath = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity\Antigravity.exe'
if (Test-Path $exePath) {
    Write-Host '正在重新启动 Antigravity 桌面端...' -ForegroundColor Green
    Start-Process -FilePath $exePath
}
