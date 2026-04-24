# ============================================================================
# Sidearm -- Portable Build Script
# ============================================================================
# Builds a portable release:
#   1. Builds Tauri frontend (npm build) + Rust backend (cargo tauri build)
#   2. Assembles portable folder with EXE + WebView2 bootstrapper
#   3. Verifies build integrity
#
# Usage:
#   .\build_portable.ps1                - Full build
#   .\build_portable.ps1 -SkipBuild     - Skip cargo build, just assemble
#   .\build_portable.ps1 -Verify        - Verify existing build only
#   .\build_portable.ps1 -Clean         - Clean build artifacts
#
# Output: ..\Sidearm-Portable\ folder ready for distribution
# ============================================================================

param(
    [switch]$Clean,
    [switch]$Verify,
    [switch]$SkipBuild
)

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

# ---- Paths ----
$PROJECT_ROOT = $PSScriptRoot
$TAURI_DIR    = Join-Path $PROJECT_ROOT 'src-tauri'
$PORTABLE_DIR = Join-Path $PROJECT_ROOT '..\Sidearm-Portable'

# Detect custom target-dir from .cargo/config.toml
$TAURI_TARGET_DIR = Join-Path $TAURI_DIR 'target'
$cargoConfig = Join-Path $PROJECT_ROOT '.cargo\config.toml'
if (Test-Path -LiteralPath $cargoConfig) {
    $match = Select-String -LiteralPath $cargoConfig -Pattern 'target-dir\s*=\s*"(.+?)"'
    if ($match) {
        $customTarget = $match.Matches[0].Groups[1].Value
        $TAURI_TARGET_DIR = $customTarget.Replace('/', '\')
    }
}

# The Tauri v2 build produces the EXE with the Cargo package name
$BUILD_EXE_NAME = 'sidearm.exe'
$EXE_NAME       = 'Sidearm.exe'
$TAURI_EXE      = Join-Path $TAURI_TARGET_DIR "release\$BUILD_EXE_NAME"

# WebView2
$RESOURCES_DIR = Join-Path $PROJECT_ROOT 'resources'
$WEBVIEW2_EXE  = Join-Path $RESOURCES_DIR 'MicrosoftEdgeWebview2Setup.exe'
$WEBVIEW2_URL  = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'

# Add Cargo to PATH
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"

# ============================================================================
# Progress bar helpers
# ============================================================================

$script:buildStartTime = $null
$script:lastProgressLine = ''

$script:BOX_H   = ([char]0x2500).ToString()
$script:BOX_TL  = ([char]0x250C).ToString()
$script:BOX_TR  = ([char]0x2510).ToString()
$script:BOX_BL  = ([char]0x2514).ToString()
$script:BOX_BR  = ([char]0x2518).ToString()
$script:BOX_V   = ([char]0x2502).ToString()
$script:BLOCK_F = ([char]0x2588).ToString()
$script:BLOCK_E = ([char]0x2591).ToString()

function Write-Step($step, $total, $msg) {
    Write-Host ""
    Write-Host ("  " + $script:BOX_H * 60) -ForegroundColor DarkGray
    $pct = [math]::Floor(($step - 1) / $total * 100)
    $filled = [math]::Floor($pct / 2)
    $empty = 50 - $filled
    $bar = $script:BLOCK_F * $filled + $script:BLOCK_E * $empty
    Write-Host "  $bar ${pct}%" -ForegroundColor Cyan
    Write-Host "  [$step/$total] $msg" -ForegroundColor Yellow
    Write-Host ""
}

function Write-Ok($msg)   { Write-Host "    $([char]0x2714) $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "    $([char]0x2718) $msg" -ForegroundColor Red }
function Write-Warn($msg) { Write-Host "    $([char]0x26A0) $msg" -ForegroundColor Yellow }
function Write-Info($msg) { Write-Host "    $([char]0x2022) $msg" -ForegroundColor DarkGray }

function Write-BuildProgress {
    param([string]$Line)
    if ($Line -match 'Compiling\s+(\S+)\s+v') {
        $crate = $Matches[1]
        $elapsed = ''
        if ($script:buildStartTime) {
            $secs = [math]::Round(((Get-Date) - $script:buildStartTime).TotalSeconds)
            $min = [math]::Floor($secs / 60)
            $sec = $secs % 60
            $elapsed = " [{0}:{1:D2}]" -f $min, $sec
        }
        $msg = "    Compiling: $crate$elapsed"
        if ($msg.Length -gt 80) { $msg = $msg.Substring(0, 77) + '...' }
        Write-Host "`r$($msg.PadRight(80))" -NoNewline -ForegroundColor DarkCyan
        $script:lastProgressLine = $msg
    }
    elseif ($Line -match 'Linking\s') {
        Write-Host "`r" -NoNewline
        Write-Host "    Linking...".PadRight(80) -ForegroundColor Magenta
    }
    elseif ($Line -match 'Finished|warning\[') {
        if ($script:lastProgressLine) {
            Write-Host "`r$(' ' * 80)`r" -NoNewline
        }
    }
    elseif ($Line -match 'error(\[E\d+\]|:)' -or $Line -match '^\s*-->') {
        if ($script:lastProgressLine) {
            Write-Host "`r$(' ' * 80)`r" -NoNewline
            $script:lastProgressLine = ''
        }
        Write-Host "    $Line" -ForegroundColor Red
    }
    elseif ($Line -match 'Building\s+\[.*\]\s+(\d+)/(\d+)') {
        $done = [int]$Matches[1]
        $total = [int]$Matches[2]
        $pct = [math]::Floor($done / $total * 100)
        $elapsed = ''
        if ($script:buildStartTime) {
            $secs = [math]::Round(((Get-Date) - $script:buildStartTime).TotalSeconds)
            $min = [math]::Floor($secs / 60)
            $sec = $secs % 60
            $elapsed = " [{0}:{1:D2}]" -f $min, $sec
        }
        $filled = [math]::Floor($pct / 4)
        $empty = 25 - $filled
        $bar = $script:BLOCK_F * $filled + $script:BLOCK_E * $empty
        $msg = "    $bar ${pct}% ($done/$total)$elapsed"
        Write-Host "`r$($msg.PadRight(80))" -NoNewline -ForegroundColor DarkCyan
    }
}

function Write-FrontendProgress {
    param([string]$Line)
    if ($Line -match 'vite.*build|transforming|modules transformed|built in') {
        $clean = $Line.Trim()
        if ($clean.Length -gt 76) { $clean = $clean.Substring(0, 73) + '...' }
        Write-Host "    $clean" -ForegroundColor DarkCyan
    }
}

function Stop-AppProcessIfRunning {
    $running = Get-Process -Name 'Sidearm' -ErrorAction SilentlyContinue
    if (-not $running) {
        # Try the dev build name too
        $running = Get-Process -Name 'sidearm' -ErrorAction SilentlyContinue
    }
    if (-not $running) { return }

    $pids = ($running | ForEach-Object { $_.Id }) -join ', '
    Write-Warn "Detected running Sidearm (PID: $pids). Stopping..."

    try {
        $running | Stop-Process -Force -ErrorAction Stop
        Start-Sleep -Seconds 1
        Write-Ok "Stopped running process(es)"
    } catch {
        Write-Fail "Could not stop process: $($_.Exception.Message)"
        exit 1
    }
}

# ============================================================================
# Banner
# ============================================================================

Write-Host ""
Write-Host ("  " + $BOX_TL + ($BOX_H * 58) + $BOX_TR) -ForegroundColor Cyan
Write-Host ("  " + $BOX_V + "  Sidearm  Portable Build                                 " + $BOX_V) -ForegroundColor Cyan
Write-Host ("  " + $BOX_BL + ($BOX_H * 58) + $BOX_BR) -ForegroundColor Cyan
Write-Host ""
Write-Host "    Target dir: $TAURI_TARGET_DIR" -ForegroundColor DarkGray
Write-Host "    Output:     $PORTABLE_DIR" -ForegroundColor DarkGray

# ============================================================================
# Handle -Clean
# ============================================================================
if ($Clean) {
    Write-Host ""
    Write-Host "  Cleaning build artifacts..." -ForegroundColor Yellow
    if (Test-Path -LiteralPath $PORTABLE_DIR) {
        Stop-AppProcessIfRunning
        Remove-Item -Recurse -Force -LiteralPath $PORTABLE_DIR
        Write-Ok "Removed $PORTABLE_DIR"
    } else {
        Write-Info "Nothing to clean"
    }
    Write-Host "  Done." -ForegroundColor Green
    exit 0
}

# ============================================================================
# Handle -Verify (jump to verification)
# ============================================================================
if ($Verify) {
    $SkipBuild = $true
}

# ============================================================================
# Step 1: Build Tauri application
# ============================================================================
$totalSteps = 3

if (-not $SkipBuild) {
    Write-Step 1 $totalSteps "Building Tauri application (Rust + React)"

    Write-Info "Started at $(Get-Date -Format 'HH:mm:ss')"
    Write-Host ""

    $script:buildStartTime = Get-Date

    $oldEAP = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'

    # --- Phase 1: Frontend (npm build) ---
    Write-Host "    $([char]0x25B6) Building frontend (npm)..." -ForegroundColor White
    Set-Location -LiteralPath $PROJECT_ROOT
    & npm run build 2>&1 | ForEach-Object { Write-FrontendProgress $_ }
    if ($LASTEXITCODE -ne 0) {
        $ErrorActionPreference = $oldEAP
        Write-Fail "Frontend build failed (exit code $LASTEXITCODE)"
        exit 1
    }
    Write-Ok "Frontend built"
    Write-Host ""

    # --- Phase 2: Rust backend ---
    # custom-protocol embeds the frontend dist/ into the EXE (without it,
    # the app tries to connect to localhost dev server and fails).
    Write-Host "    $([char]0x25B6) Compiling Rust backend..." -ForegroundColor White
    Set-Location -LiteralPath $TAURI_DIR

    # Use .NET Process to read stderr line-by-line in real time.
    # PowerShell's native 2>&1 pipe buffers ErrorRecords until process exit,
    # so cargo output appears all at once instead of progressively.
    # CARGO_TERM_PROGRESS_WHEN=never disables \r-based progress bar so
    # each "Compiling" line gets a proper \n that ReadLine() can process.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command cargo -ErrorAction SilentlyContinue).Source
    if (-not $psi.FileName) { $psi.FileName = 'cargo' }
    $psi.Arguments = 'build --release --features custom-protocol'
    $psi.WorkingDirectory = $TAURI_DIR
    $psi.UseShellExecute = $false
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardOutput = $true
    $psi.CreateNoWindow = $true
    $psi.EnvironmentVariables['CARGO_TERM_PROGRESS_WHEN'] = 'never'

    $proc = [System.Diagnostics.Process]::Start($psi)

    # Drain stdout in background (otherwise pipe buffer fills and deadlocks)
    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()

    $crateCount = 0
    while ($null -ne ($line = $proc.StandardError.ReadLine())) {
        if ($line -match 'Compiling\s+(\S+)\s+v') {
            $crate = $Matches[1]
            $crateCount++
            $elapsed = ''
            if ($script:buildStartTime) {
                $secs = [math]::Round(((Get-Date) - $script:buildStartTime).TotalSeconds)
                $min = [math]::Floor($secs / 60)
                $sec = $secs % 60
                $elapsed = " [{0}:{1:D2}]" -f $min, $sec
            }
            $msg = "    Compiling ($crateCount): $crate$elapsed"
            if ($msg.Length -gt 78) { $msg = $msg.Substring(0, 75) + '...' }
            Write-Host "`r$($msg.PadRight(80))" -NoNewline -ForegroundColor DarkCyan
        }
        elseif ($line -match 'Linking\s') {
            Write-Host "`r$(' ' * 80)`r" -NoNewline
            Write-Host "    Linking executable..." -ForegroundColor Magenta
        }
        elseif ($line -match 'error(\[E\d+\]|:)') {
            Write-Host "`r$(' ' * 80)`r" -NoNewline
            Write-Host "    $line" -ForegroundColor Red
        }
        elseif ($line -match 'Finished') {
            Write-Host "`r$(' ' * 80)`r" -NoNewline
        }
    }
    $proc.WaitForExit()
    $buildExitCode = $proc.ExitCode
    $proc.Dispose()
    [void]$stdoutTask.Result

    $ErrorActionPreference = $oldEAP

    # Clear leftover progress line
    Write-Host "`r$(' ' * 80)`r" -NoNewline

    $buildEnd = Get-Date
    $buildDuration = $buildEnd - $script:buildStartTime
    $durStr = "{0}:{1:D2}" -f [math]::Floor($buildDuration.TotalMinutes), $buildDuration.Seconds
    Write-Host ""

    if ($buildExitCode -ne 0) {
        Write-Fail "Rust build failed (exit code $buildExitCode) after $durStr"
        exit 1
    }

    # Verify EXE was produced
    if (-not (Test-Path -LiteralPath $TAURI_EXE)) {
        Write-Fail "Expected EXE not found: $TAURI_EXE"
        Write-Info "Checking what was actually produced..."
        Get-ChildItem (Join-Path $TAURI_TARGET_DIR 'release') -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Info "  Found: $($_.Name) ($([math]::Round($_.Length / 1MB, 1)) MB)"
        }
        exit 1
    }

    $exeSize = [math]::Round((Get-Item -LiteralPath $TAURI_EXE).Length / 1MB, 1)
    Write-Ok "$BUILD_EXE_NAME (${exeSize} MB) built in $durStr"
} else {
    Write-Host ""
    Write-Info "Skipping build (using existing artifacts)"
}

# ============================================================================
# Step 2: Assemble portable folder
# ============================================================================
$stepNum = if ($SkipBuild) { 1 } else { 2 }
Write-Step $stepNum $totalSteps "Assembling portable package"

if (Test-Path -LiteralPath $PORTABLE_DIR) {
    Stop-AppProcessIfRunning
    # Clean everything (no user data to preserve in this project)
    Remove-Item -Recurse -Force -LiteralPath $PORTABLE_DIR
}
New-Item -ItemType Directory -Path $PORTABLE_DIR -Force | Out-Null

# --- EXE (rename from cargo name to display name) ---
Copy-Item -LiteralPath $TAURI_EXE -Destination (Join-Path $PORTABLE_DIR $EXE_NAME)
Write-Ok "$EXE_NAME"

# --- Portable mode marker ---
# Presence of this empty file next to the exe tells Sidearm to store its
# config, logs, and snapshots in ./data/ instead of %APPDATA%.
$portableMarker = Join-Path $PORTABLE_DIR 'sidearm.portable'
New-Item -ItemType File -Path $portableMarker -Force | Out-Null
Write-Ok 'sidearm.portable (marker for portable mode)'

# --- WebView2 bootstrapper ---
$resOutDir = Join-Path $PORTABLE_DIR 'resources'
New-Item -ItemType Directory -Path $resOutDir -Force | Out-Null

if (Test-Path -LiteralPath $WEBVIEW2_EXE) {
    Copy-Item -LiteralPath $WEBVIEW2_EXE -Destination $resOutDir
    Write-Ok "resources/MicrosoftEdgeWebview2Setup.exe"
} else {
    Write-Warn "WebView2 bootstrapper not found at: $WEBVIEW2_EXE"
    Write-Info "Download from: $WEBVIEW2_URL"
    Write-Info "Save to: $WEBVIEW2_EXE"
}

# --- Install WebView2 helper script ---
$installBat = Join-Path $resOutDir 'install-webview2.bat'
$installBatContent = "@echo off`r`necho Installing Microsoft Edge WebView2 Runtime...`r`n""%~dp0MicrosoftEdgeWebview2Setup.exe"" /install`r`necho Done. You can now run Sidearm.`r`npause"
[System.IO.File]::WriteAllText($installBat, $installBatContent, [System.Text.Encoding]::ASCII)
Write-Ok "resources/install-webview2.bat"

# ============================================================================
# Step 3: Verification
# ============================================================================
$stepNum++
Write-Step $stepNum $totalSteps "Verifying build integrity"

$errors = 0
$warnings = 0

# Check EXE
$portableExe = Join-Path $PORTABLE_DIR $EXE_NAME
if (Test-Path -LiteralPath $portableExe) {
    $exeSize = [math]::Round((Get-Item -LiteralPath $portableExe).Length / 1MB, 1)
    Write-Ok "$EXE_NAME (${exeSize} MB)"
} else {
    Write-Fail "$EXE_NAME not found!"
    $errors++
}

# Check WebView2
$wv2 = Join-Path $PORTABLE_DIR 'resources\MicrosoftEdgeWebview2Setup.exe'
if (Test-Path -LiteralPath $wv2) {
    Write-Ok "resources/MicrosoftEdgeWebview2Setup.exe"
} else {
    Write-Warn "WebView2 bootstrapper missing (users without WebView2 won't be able to launch)"
    $warnings++
}

# Check portable marker
$portableMarker = Join-Path $PORTABLE_DIR 'sidearm.portable'
if (Test-Path -LiteralPath $portableMarker) {
    Write-Ok 'sidearm.portable marker present'
} else {
    Write-Fail 'sidearm.portable marker missing -- app will use %APPDATA% instead of ./data'
    $errors++
}

# Quick smoke: check EXE is not tiny (corrupt copy)
if (Test-Path -LiteralPath $portableExe) {
    $size = (Get-Item -LiteralPath $portableExe).Length
    if ($size -lt 1048576) {
        Write-Fail "$EXE_NAME is suspiciously small ($([math]::Round($size / 1KB)) KB) -- build may be broken"
        $errors++
    }
}

# ============================================================================
# Final summary
# ============================================================================

$totalSize = (Get-ChildItem -LiteralPath $PORTABLE_DIR -Recurse -File | Measure-Object -Property Length -Sum).Sum
$totalSizeMB = [math]::Round($totalSize / 1MB, 1)

Write-Host ""
Write-Host ("  " + $BOX_H * 60) -ForegroundColor DarkGray
$bar100 = $BLOCK_F * 50
Write-Host "  $bar100 100%" -ForegroundColor Green
Write-Host ""

if ($errors -gt 0) {
    Write-Host ("  " + $BOX_TL + ($BOX_H * 58) + $BOX_TR) -ForegroundColor Red
    $failLine = "  BUILD FAILED   $errors error(s), $warnings warning(s)"
    $fpad = 57 - $failLine.Length; if ($fpad -lt 0) { $fpad = 0 }
    Write-Host ("  " + $BOX_V + $failLine + (' ' * $fpad) + $BOX_V) -ForegroundColor Red
    Write-Host ("  " + $BOX_BL + ($BOX_H * 58) + $BOX_BR) -ForegroundColor Red
    exit 1
} else {
    Write-Host ("  " + $BOX_TL + ($BOX_H * 58) + $BOX_TR) -ForegroundColor Green
    $statusLine = "  READY   ${totalSizeMB} MB total"
    $pad = 57 - $statusLine.Length
    if ($pad -lt 0) { $pad = 0 }
    Write-Host ("  " + $BOX_V + $statusLine + (' ' * $pad) + $BOX_V) -ForegroundColor Green
    Write-Host ("  " + $BOX_BL + ($BOX_H * 58) + $BOX_BR) -ForegroundColor Green

    if ($warnings -gt 0) {
        Write-Host "    $warnings warning(s) - see above" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "    Output: $PORTABLE_DIR" -ForegroundColor White
}

Set-Location -LiteralPath $PROJECT_ROOT
