# Sidearm Dev Server (auto-restart on crash)
# Usage: .\dev.ps1 [-Clean] [-NoWatch] or double-click dev.bat (it passes the same switches)
#   -NoWatch  no restart on each saved file (cargo tauri dev --no-watch): a restart kills
#             the app mid-run and can leave the mice with Sidearm's signals

param(
    [switch]$Clean,   # Force full recompile
    [switch]$NoWatch  # Build once; do not rebuild/restart on file changes
)

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
$host.UI.RawUI.WindowTitle = "Sidearm Dev (auto-restart)"

# No QuickEdit in this console: a click into it starts a text selection, and
# while one lasts Windows blocks every write to the console. The app logs to
# stdout on each press, so its capture thread froze on the first log line and
# every mouse button went silent (measured 2026-11-14: stacks stuck in
# write_fmt<StdoutLock>). The app inherits this console, so this covers it.
try {
    Add-Type -Namespace SidearmDev -Name Console -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int handle);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr handle, uint mode);
'@
    $stdin = [SidearmDev.Console]::GetStdHandle(-10)
    $mode = 0
    if ([SidearmDev.Console]::GetConsoleMode($stdin, [ref]$mode)) {
        # ENABLE_EXTENDED_FLAGS (0x80) on, ENABLE_QUICK_EDIT_MODE (0x40) off.
        [void][SidearmDev.Console]::SetConsoleMode($stdin, ($mode -bor 0x80) -band (-bnot 0x40))
    }
} catch {
    Write-Host "  QuickEdit not turned off: $($_.Exception.Message)" -ForegroundColor Yellow
}

# Shared console UI + helpers (banner glyphs, Write-Banner, Write-Ok/Fail/Warn/
# Info, Get-AppVersion). Vendored at the repo root.
$kit = Join-Path $PSScriptRoot 'ScriptKit.ps1'
if (Test-Path $kit) { . $kit }
. (Join-Path $PSScriptRoot 'tools\locked-exe.ps1')

$PROJECT_DIR = $PSScriptRoot
$TAURI_DIR   = Join-Path $PROJECT_DIR 'src-tauri'
$VITE_PORT   = 45173

# The dev app uses the portable app's data (debug builds read
# SIDEARM_DATA_DIR, src-tauri/src/paths.rs): one config drives the mice.
$env:SIDEARM_DATA_DIR = Join-Path (Split-Path $PROJECT_DIR -Parent) 'portable\data'

$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# App version (for banner) -- read from package.json, best-effort.
$APP_VERSION = Get-AppVersion $PROJECT_DIR

# Box glyphs and Write-Ok/Fail/Warn/Info come from ScriptKit.ps1 (dot-sourced
# above).

function Stop-StaleProcesses {
    # Only the dev build's Sidearm processes: they hold target\debug\sidearm.exe,
    # which the next build must replace. The app and its capture helper stop; a
    # restore process (`--restore-live-maps`: the watchdog of a killed app, or
    # one its helper started) keeps running — it may be waiting for a sleeping
    # mouse — and its exe is moved out of the way instead.
    $target = Join-Path $TAURI_DIR 'target'
    Get-CimInstance Win32_Process -Filter "Name = 'sidearm.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($target, [StringComparison]::OrdinalIgnoreCase) } |
        Where-Object { $_.CommandLine -notmatch '--restore-live-maps' } |
        ForEach-Object {
            Write-Host "  Stopping PID $($_.ProcessId)" -ForegroundColor Yellow
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    # Both names cargo gives the exe: the linker writes the deps one.
    Move-LockedExe (Join-Path $target 'debug\sidearm.exe')
    Move-LockedExe (Join-Path $target 'debug\deps\sidearm.exe')

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

    $devArgs = @('tauri', 'dev') + @(if ($NoWatch) { '--no-watch' })
    Write-Ok "Starting cargo $($devArgs -join ' ')"
    Set-Location $PROJECT_DIR
    & cargo @devArgs

    Write-Host ""
    Write-Warn "Dev server exited. Restarting in 5s... (Ctrl+C to stop)"
    Start-Sleep -Seconds 5
}
