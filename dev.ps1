# Sidearm Dev Server (auto-restart on crash)
# Usage: .\dev.ps1 or double-click dev.bat

param(
    [switch]$Clean  # Force full recompile
)

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$host.UI.RawUI.WindowTitle = "Sidearm Dev (auto-restart)"

# Shared console UI + helpers (banner glyphs, Write-Banner, Write-Ok/Fail/Warn/
# Info, Get-AppVersion). Vendored at the repo root.
$kit = Join-Path $PSScriptRoot 'ScriptKit.ps1'
if (Test-Path $kit) { . $kit }

$PROJECT_DIR = $PSScriptRoot
$TAURI_DIR   = Join-Path $PROJECT_DIR 'src-tauri'
$VITE_PORT   = 45173

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# App version (for banner) -- read from package.json, best-effort.
$APP_VERSION = Get-AppVersion $PROJECT_DIR

# Box glyphs and Write-Ok/Fail/Warn/Info come from ScriptKit.ps1 (dot-sourced
# above).

function Stop-StaleProcesses {
    # Kill only Sidearm processes from our project directory
    Get-Process -Name 'sidearm','naga-workflow-studio' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -like "*Razer Naga Studio*" } |
        ForEach-Object {
            Write-Host "  Stopping PID $($_.Id)" -ForegroundColor Yellow
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }

    # Kill Vite/node holding our port
    $portPids = netstat -ano 2>$null | Select-String ":${VITE_PORT}.*LISTENING" |
        ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
    foreach ($procId in $portPids) {
        if ($procId -and $procId -ne '0') {
            Write-Host "  Freeing port $VITE_PORT (PID $procId)" -ForegroundColor Yellow
            Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($Clean) {
    Write-Host ""
    Write-Host "  Cleaning build cache..." -ForegroundColor Cyan
    Set-Location $TAURI_DIR
    & cargo clean 2>$null
    Write-Ok "Build cache cleaned"
}

# ============================================================================
# Banner (printed once, before the auto-restart loop)
# ============================================================================
Write-Banner "Sidearm  Dev   v$APP_VERSION" "cargo tauri dev -- auto-restarts on crash, Ctrl+C to quit"

$restartNum = 0

while ($true) {
    $restartNum++
    $stamp = Get-Date -Format 'HH:mm:ss'
    Write-Banner "Restart #$restartNum   $stamp" -Width 40
    Write-Host ""

    Write-Info "Stopping stale processes..."
    Stop-StaleProcesses

    # Touch lib.rs to force cargo to re-check dependencies.
    # Prevents stale cache after external file edits or killed builds.
    $libRs = Join-Path $TAURI_DIR 'src\lib.rs'
    (Get-Item $libRs).LastWriteTime = Get-Date

    Write-Info "Waiting for cleanup..."
    Start-Sleep -Seconds 3

    Write-Ok "Starting cargo tauri dev"
    Set-Location $PROJECT_DIR
    & cargo tauri dev

    Write-Host ""
    Write-Warn "Dev server exited. Restarting in 5s... (Ctrl+C to stop)"
    Start-Sleep -Seconds 5
}
