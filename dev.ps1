# Sidearm Dev Server (auto-restart on crash)
# Usage: .\dev.ps1 or double-click dev.bat

param(
    [switch]$Clean  # Force full recompile
)

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$host.UI.RawUI.WindowTitle = "Sidearm Dev (auto-restart)"

$PROJECT_DIR = $PSScriptRoot
$TAURI_DIR   = Join-Path $PROJECT_DIR 'src-tauri'
$VITE_PORT   = 45173

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

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
    Write-Host "  Cleaning build cache..." -ForegroundColor Cyan
    Set-Location $TAURI_DIR
    & cargo clean 2>$null
    Write-Host "  Done." -ForegroundColor Green
}

while ($true) {
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host "  Sidearm Dev" -ForegroundColor Cyan
    Write-Host "  (auto-restarts on crash, Ctrl+C to quit)" -ForegroundColor DarkGray
    Write-Host "  ============================================" -ForegroundColor Cyan
    Write-Host ""

    Stop-StaleProcesses

    # Touch lib.rs to force cargo to re-check dependencies.
    # Prevents stale cache after external file edits or killed builds.
    $libRs = Join-Path $TAURI_DIR 'src\lib.rs'
    (Get-Item $libRs).LastWriteTime = Get-Date

    Write-Host "  Waiting for cleanup..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 3

    Set-Location $PROJECT_DIR
    & cargo tauri dev

    Write-Host ""
    Write-Host "  !! Exited. Restarting in 5s... (Ctrl+C to stop)" -ForegroundColor Red
    Start-Sleep -Seconds 5
}
