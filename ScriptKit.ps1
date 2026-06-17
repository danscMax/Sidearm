# ============================================================================
# ScriptKit v2 -- shared console UI + helpers for build / run / setup scripts
# ============================================================================
# VENDORED helper. Copy this file into a repo and dot-source it near the top of
# a script:
#     . (Join-Path $PSScriptRoot 'ScriptKit.ps1')
#
# CANON: E:\Scripts\AgentHub\tools\ScriptKit.ps1 is the source of
# truth. Edit it there, bump $script:SK_Version, then roll out to every vendored
# copy with: AgentHub\tools\Sync-ScriptKit.ps1 -Apply
#
# Design rules (keep them when editing):
#   * Pure presentation / small utilities -- NO Set-StrictMode (this dot-sources
#     into foreign scripts and must not change their strictness).
#   * English-only, no Cyrillic in code -- so Windows PowerShell 5.1 parses the
#     file cleanly even without a BOM.
#   * Box glyphs are built at runtime ([char]0x....) -- renders in PS 5.1.
#   * Keep this file IDENTICAL across repos. Bump the version below on change so
#     drift between copies is visible (Sync-ScriptKit.ps1 -Check).
# ============================================================================

$script:SK_Version = 2   # drift marker -- Sync-ScriptKit.ps1 compares this

# --- UTF-8 console (box glyphs + check marks render instead of mojibake) ----
try { chcp 65001 | Out-Null } catch { }
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding  = [System.Text.Encoding]::UTF8
} catch { }

# --- Box-drawing glyphs (script scope -> visible to callers after dot-source) -
$script:SK_H       = ([char]0x2500).ToString()  # horizontal
$script:SK_TL      = ([char]0x250C).ToString()  # top-left
$script:SK_TR      = ([char]0x2510).ToString()  # top-right
$script:SK_BL      = ([char]0x2514).ToString()  # bottom-left
$script:SK_BR      = ([char]0x2518).ToString()  # bottom-right
$script:SK_V       = ([char]0x2502).ToString()  # vertical
$script:SK_TM      = ([char]0x251C).ToString()  # left tee (summary dividers)
$script:SK_BLOCK_F = ([char]0x2588).ToString()  # full block (progress)
$script:SK_BLOCK_E = ([char]0x2591).ToString()  # light shade (progress empty)
$script:SK_LogFile = $null

# ============================================================================
# Console UI
# ============================================================================

# Two-line framed banner. Line2 is an optional dimmed subtitle.
function Write-Banner {
    param([string]$Line1, [string]$Line2 = '', [string]$Color = 'Cyan', [int]$Width = 58)
    $bar = $script:SK_H * $Width
    Write-Host ""
    Write-Host ("  " + $script:SK_TL + $bar + $script:SK_TR) -ForegroundColor $Color
    Write-Host ("  " + $script:SK_V + "  " + $Line1) -ForegroundColor $Color
    if ($Line2) { Write-Host ("  " + $script:SK_V + "  " + $Line2) -ForegroundColor DarkGray }
    Write-Host ("  " + $script:SK_BL + $bar + $script:SK_BR) -ForegroundColor $Color
}

# Phase separator + progress bar + [step/total] heading.
function Write-Step {
    param([int]$Step, [int]$Total, [string]$Msg)
    Write-Host ""
    Write-Host ("  " + $script:SK_H * 60) -ForegroundColor DarkGray
    $pct = if ($Total -gt 0) { [math]::Floor(($Step - 1) / $Total * 100) } else { 0 }
    $filled = [math]::Floor($pct / 2); $empty = 50 - $filled
    if ($empty -lt 0) { $empty = 0 }
    $bar = ($script:SK_BLOCK_F * $filled) + ($script:SK_BLOCK_E * $empty)
    Write-Host "  $bar ${pct}%" -ForegroundColor Cyan
    Write-Host "  [$Step/$Total] $Msg" -ForegroundColor Yellow
    Write-Host ""
}

function Write-Ok   { param([string]$Msg) Write-Host "    $([char]0x2714) $Msg" -ForegroundColor Green }
function Write-Fail { param([string]$Msg) Write-Host "    $([char]0x2718) $Msg" -ForegroundColor Red }
function Write-Warn { param([string]$Msg) Write-Host "    $([char]0x26A0) $Msg" -ForegroundColor Yellow }
function Write-Info { param([string]$Msg) Write-Host "    $([char]0x2022) $Msg" -ForegroundColor DarkGray }

# Tagged status line: [OK]/[FAIL]/[WARN]/[SKIP]/[INFO]/... + message.
function Write-Status {
    param([string]$Text, [string]$Tag = 'OK')
    $map = @{ OK='Green'; FAIL='Red'; WARN='Yellow'; SKIP='DarkGray'; INFO='Cyan';
              DRY='Magenta'; MERGED='Green'; OPEN='Cyan'; CONFLICT='Red'; LOCAL='DarkGray' }
    $c = $map[$Tag]; if (-not $c) { $c = 'Gray' }
    Write-Host ("    [{0}] " -f $Tag) -ForegroundColor $c -NoNewline
    Write-Host $Text -ForegroundColor White
    if ($script:SK_LogFile) { Write-Log -Msg ("[{0}] {1}" -f $Tag, $Text) -Level $Tag -NoConsole }
}

# ============================================================================
# Notifications
# ============================================================================

# Windows tray balloon. On SUCCESS prefer the app's own icon (never the red
# system error glyph); fall back to a state-appropriate system icon. All wrapped
# in try/catch so a headless/missing WinForms API silently no-ops.
function Show-Notification {
    param([string]$Title, [string]$Body, [switch]$IsError, [string]$IconPath)
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        Add-Type -AssemblyName System.Drawing       -ErrorAction Stop
        $icon = $null
        if ($IconPath) {
            try {
                $full = (Resolve-Path -LiteralPath $IconPath -ErrorAction Stop).Path
                $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($full)
            } catch { $icon = $null }
        }
        if (-not $icon) {
            $icon = if ($IsError) { [System.Drawing.SystemIcons]::Error } else { [System.Drawing.SystemIcons]::Asterisk }
        }
        $tray = New-Object System.Windows.Forms.NotifyIcon
        $tray.Icon            = $icon
        $tray.BalloonTipIcon  = if ($IsError) { 'Error' } else { 'Info' }
        $tray.BalloonTipTitle = $Title
        $tray.BalloonTipText  = $Body
        $tray.Visible         = $true
        $tray.ShowBalloonTip(8000)
        Start-Sleep -Milliseconds 1200   # let Windows capture the icon + render
        $tray.Visible = $false
        $tray.Dispose()
    } catch { }
}

# ============================================================================
# Process / command helpers
# ============================================================================

# Run an external command in a background job with a hard timeout. Returns
# @{ Ok; Code; Out }. Code -2 == killed on timeout. No process ever hangs.
function Invoke-TimedCommand {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgList = @(), [int]$TimeoutSec = 120)
    if ($TimeoutSec -lt 1) { $TimeoutSec = 60 }
    $job = Start-Job -ScriptBlock {
        param($exe, $a)
        $out = & $exe @a 2>&1 | Out-String
        [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
    } -ArgumentList $FilePath, (, $ArgList)
    if (Wait-Job $job -Timeout $TimeoutSec) {
        $res = Receive-Job $job; Remove-Job $job -Force -ErrorAction SilentlyContinue
        $code = if ($res -and $null -ne $res.Code) { [int]$res.Code } else { 1 }
        return @{ Ok = ($code -eq 0); Code = $code; Out = ([string]$res.Out).Trim() }
    }
    Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue
    return @{ Ok = $false; Code = -2; Out = "TIMEOUT after ${TimeoutSec}s (killed)" }
}

# Same as above but shows a live [|/-\] spinner with elapsed seconds.
function Invoke-TimedCommandWithSpinner {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgList = @(), [int]$TimeoutSec = 120, [string]$Activity = 'Working')
    if ($TimeoutSec -lt 1) { $TimeoutSec = 60 }
    $job = Start-Job -ScriptBlock {
        param($exe, $a)
        $out = & $exe @a 2>&1 | Out-String
        [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
    } -ArgumentList $FilePath, (, $ArgList)
    $spin = '|/-\'; $k = 0; $t0 = Get-Date
    while ($null -eq (Wait-Job $job -Timeout 1)) {
        $el = [int]((Get-Date) - $t0).TotalSeconds
        Write-Host ("`r    [{0}] {1}  ({2}s)        " -f $spin[$k % 4], $Activity, $el) -NoNewline -ForegroundColor Cyan
        $k++
        if ($el -ge $TimeoutSec) {
            Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue
            Write-Host ("`r" + (' ' * 70) + "`r") -NoNewline
            return @{ Ok = $false; Code = -2; Out = "TIMEOUT after ${TimeoutSec}s (killed)" }
        }
    }
    Write-Host ("`r" + (' ' * 70) + "`r") -NoNewline
    $res = Receive-Job $job; Remove-Job $job -Force -ErrorAction SilentlyContinue
    $code = if ($res -and $null -ne $res.Code) { [int]$res.Code } else { 1 }
    return @{ Ok = ($code -eq 0); Code = $code; Out = ([string]$res.Out).Trim() }
}

# Stop a running process by name (frees a locked exe before replacing it).
function Stop-NamedProcess {
    param([Parameter(Mandatory)][string]$ProcessName)
    $running = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if (-not $running) { return $true }
    try {
        $running | Stop-Process -Force -ErrorAction Stop
        Start-Sleep -Seconds 1
        return $true
    } catch {
        Write-Warn ("Could not stop {0}: {1}" -f $ProcessName, $_.Exception.Message)
        return $false
    }
}

# ============================================================================
# Utilities
# ============================================================================

function Get-FileHashSHA256 {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path).Path)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '')
    } finally { $sha.Dispose() }
}

# App version, best-effort: package.json -> Cargo.toml -> 'src-tauri\Cargo.toml' -> '?'.
function Get-AppVersion {
    param([string]$Root = $PSScriptRoot)
    $pkg = Join-Path $Root 'package.json'
    if (Test-Path -LiteralPath $pkg) {
        try { $j = Get-Content -LiteralPath $pkg -Raw -ErrorAction Stop | ConvertFrom-Json; if ($j.version) { return [string]$j.version } } catch { }
    }
    foreach ($rel in @('Cargo.toml', 'src-tauri\Cargo.toml')) {
        $c = Join-Path $Root $rel
        if (Test-Path -LiteralPath $c) {
            $m = Select-String -LiteralPath $c -Pattern '(?m)^\s*version\s*=\s*"([^"]+)"' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($m) { return $m.Matches[0].Groups[1].Value }
        }
    }
    return '?'
}

# ============================================================================
# Status JSON (unified component status envelope for AgentHub)
# ============================================================================

# Write a unified "<component>.last.json" envelope under <Root>. This is the
# single DRY entry point every maintenance script uses to report its result to
# the dashboard. Self-guarded (try/catch) so a status-write failure can never
# break the caller's real job -- still, call it inside the caller's own try too.
#
# Status values: ok | changes | error | held.
# Counts: changed = items updated, failed = items that errored, total = scanned.
# -Extra merges component-specific fields into the envelope (e.g. log path).
function Write-StatusJson {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Component,
        [ValidateSet('ok','changes','error','held')][string]$Status = 'ok',
        [int]$Changed = 0,
        [int]$Failed = 0,
        [int]$Total = 0,
        [double]$DurationSec = 0,
        [string]$Mode = 'check',
        [string]$Summary = '',
        [hashtable]$Extra
    )
    try {
        $payload = [ordered]@{
            schemaVersion = 1
            component     = $Component
            status        = $Status
            timestamp     = (Get-Date -Format 'o')
            mode          = $Mode
            durationSec   = [math]::Round([double]$DurationSec, 1)
            counts        = [ordered]@{ changed = [int]$Changed; failed = [int]$Failed; total = [int]$Total }
            summary       = $Summary
        }
        if ($Extra) { foreach ($k in $Extra.Keys) { $payload[$k] = $Extra[$k] } }
        if (-not (Test-Path -LiteralPath $Root)) { New-Item -ItemType Directory -Path $Root -Force | Out-Null }
        $path = Join-Path $Root ("{0}.last.json" -f $Component)
        [System.IO.File]::WriteAllText($path, ($payload | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
        return $path
    } catch {
        # Don't fail the caller, but don't fail silently either — a swallowed write means the
        # dashboard would keep showing a stale status.
        try { Write-Log ("Write-StatusJson failed: {0}" -f $_.Exception.Message) -Level 'WARN' -Color 'Yellow' } catch { }
        return $null
    }
}

# ============================================================================
# Logging (file + console)
# ============================================================================

# Start a timestamped log under <Root>\logs, keep newest $Keep files.
function Initialize-Logging {
    param([string]$Root, [string]$Prefix = 'script', [int]$Keep = 15)
    $logDir = Join-Path $Root 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $script:SK_LogFile = Join-Path $logDir ("{0}_{1}.log" -f $Prefix, (Get-Date -Format 'yyyyMMdd_HHmmss'))
    Get-ChildItem -LiteralPath $logDir -Filter "$Prefix*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    return $script:SK_LogFile
}

function Write-Log {
    param([string]$Msg, [string]$Level = 'INFO', [switch]$NoConsole, [string]$Color = 'Gray')
    if ($script:SK_LogFile) {
        Add-Content -LiteralPath $script:SK_LogFile -Value ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Level, $Msg) -Encoding UTF8
    }
    if (-not $NoConsole) { Write-Host $Msg -ForegroundColor $Color }
}
