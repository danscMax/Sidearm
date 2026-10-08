# ============================================================================
# ScriptKit v2 -- shared console UI + helpers for build / run / setup scripts
# ============================================================================
# VENDORED helper. Copy this file into a repo and dot-source it near the top of
# a script:
#     . (Join-Path $PSScriptRoot 'ScriptKit.ps1')
#
# CANON: E:\Scripts\Castellyn\tools\ScriptKit.ps1 is the source of
# truth. Edit it there, bump $script:SK_Version, then roll out to every vendored
# copy with: Castellyn\tools\Sync-ScriptKit.ps1 -Apply
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

$script:SK_Version = 4   # drift marker -- Sync-ScriptKit.ps1 compares this

# --- UTF-8 console (box glyphs + check marks render instead of mojibake) ----
# Non-intrusive: merely dot-sourcing this helper must NOT permanently flip the
# caller's console code page. Only run `chcp` when the active code page isn't
# already 65001 (UTF-8); skipping the call avoids mutating a host that's already
# UTF-8, and the console encoding objects below are idempotent.
try {
    $sk_cp = try { [System.Console]::OutputEncoding.CodePage } catch { -1 }
    if ($sk_cp -ne 65001) { chcp 65001 | Out-Null }
    Remove-Variable sk_cp -ErrorAction SilentlyContinue
} catch {
    # Cosmetic only: a host with no attached console (service, redirected stdio) has no code page
    # to set. Mojibake in that host beats refusing to dot-source, so degrade quietly.
    Write-Verbose "ScriptKit: chcp unavailable, keeping the host code page: $_"
}
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding  = [System.Text.Encoding]::UTF8
} catch {
    # Same reason: InputEncoding in particular throws when stdin is a pipe rather than a console.
    Write-Verbose "ScriptKit: console encoding not settable in this host: $_"
}

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
    # Completed-work semantics so the bar reaches 100% on the final step (was ($Step-1)/$Total, which
    # capped at (Total-1)/Total and never hit 100). Clamped in case Step ever exceeds Total.
    $pct = if ($Total -gt 0) { [math]::Min(100, [math]::Floor($Step / $Total * 100)) } else { 0 }
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
    } catch {
        # A tray balloon is a nicety, never the job: WinForms/Drawing are absent on a headless or
        # non-Windows host, and Server Core has no shell to show it. Silently skip the notification.
        Write-Verbose "Show-Notification: tray balloon unavailable: $_"
    }
}

# ============================================================================
# Process / command helpers
# ============================================================================

# The body both timed-command helpers run in their background job. ONE named scriptblock instead of
# two identical inline copies that could drift. $exe/$a arrive via -ArgumentList, and the (, $ArgList)
# wrapper at each call site stops PowerShell unrolling the array into separate arguments.
$script:SK_JobRunner = {
    param($exe, $a)
    $out = & $exe @a 2>&1 | Out-String
    [pscustomobject]@{ Code = $LASTEXITCODE; Out = $out }
}

# Run an external command in a background job with a hard timeout. Returns
# @{ Ok; Code; Out }. Code -2 == killed on timeout. No process ever hangs.
function Invoke-TimedCommand {
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgList = @(), [int]$TimeoutSec = 120)
    if ($TimeoutSec -lt 1) { $TimeoutSec = 60 }
    $job = Start-Job -ScriptBlock $script:SK_JobRunner -ArgumentList $FilePath, (, $ArgList)
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
    $job = Start-Job -ScriptBlock $script:SK_JobRunner -ArgumentList $FilePath, (, $ArgList)
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
    # SupportsShouldProcess makes -WhatIf real for a genuinely destructive call. ConfirmImpact stays
    # at the default (Medium < the default $ConfirmPreference of High), so an unattended run never
    # prompts; the Stop-Process below is called with -Confirm:$false for the same reason.
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$ProcessName)
    $running = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    if (-not $running) { return $true }
    if (-not $PSCmdlet.ShouldProcess($ProcessName, 'Stop-Process -Force')) { return $true }
    try {
        $running | Stop-Process -Force -Confirm:$false -ErrorAction Stop
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
    # Use the built-in cmdlet (ships in Windows PowerShell 5.1+/PS 7) instead of hand-rolling SHA-256.
    # Get-FileHash returns uppercase hex, same shape as the old ByteConverter output.
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# App version, best-effort: package.json -> Cargo.toml -> 'src-tauri\Cargo.toml' -> '?'.
function Get-AppVersion {
    param([string]$Root = $PSScriptRoot)
    $pkg = Join-Path $Root 'package.json'
    if (Test-Path -LiteralPath $pkg) {
        try { $j = Get-Content -LiteralPath $pkg -Raw -ErrorAction Stop | ConvertFrom-Json; if ($j.version) { return [string]$j.version } }
        catch {
            # An unreadable/malformed package.json must not abort version discovery — fall through
            # to the Cargo.toml sources below, which is exactly what the '?' contract promises.
            Write-Verbose "Get-AppVersion: package.json unusable ($pkg): $_"
        }
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
# Status JSON (unified component status envelope for Castellyn)
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
    # Initialized BEFORE the try: the catch below cleans up $tmp, and PowerShell's dynamic scoping
    # would otherwise resolve an unassigned $tmp to the CALLER's variable of that name — deleting a
    # file the calling script still owns whenever the try fails before the assignment (e.g. on an
    # unwritable -Root). ScriptKit deliberately runs without Set-StrictMode, so this is silent.
    $tmp = $null
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
        # -Extra adds component-specific fields, but must NOT clobber the contract:
        # skip any key that collides with a reserved envelope key (case-insensitive).
        if ($Extra) {
            $reserved = @('schemaVersion','component','status','timestamp','mode','durationSec','counts','summary')
            foreach ($k in $Extra.Keys) {
                if ($reserved -contains $k) {
                    try { Write-Log ("Write-StatusJson: ignoring -Extra key '{0}' (reserved envelope key)" -f $k) -Level 'WARN' -Color 'Yellow' }
                    catch { Write-Verbose "Write-StatusJson: could not report the ignored -Extra key '$k': $_" }
                    continue
                }
                $payload[$k] = $Extra[$k]
            }
        }
        # NOT New-Item: it has no -LiteralPath (verified on pwsh 7.6), so the old call threw
        # "A parameter cannot be found that matches parameter name 'LiteralPath'" on EVERY run where
        # -Root did not already exist — the envelope was then silently never written. CreateDirectory
        # also takes the path literally (a '[' in it is not a wildcard) and no-ops when it exists.
        [System.IO.Directory]::CreateDirectory($Root) | Out-Null
        $path = Join-Path $Root ("{0}.last.json" -f $Component)
        # Atomic write: full-content temp then a rename, so a crash/power-loss mid-write can't leave a
        # TORN <id>.last.json (the Rust reader would then show `corrupt:` with no .bak to recover from).
        # File.Move(...,$true) is MoveFileEx REPLACE_EXISTING under pwsh 7 → an atomic same-volume swap.
        # UNIQUE temp per writer (PID + random): a fixed "<comp>.last.json.tmp" let a scheduled check
        # and a manual run for the same component collide — one moved the temp while the other was still
        # writing it, so a writer threw or published the other run's envelope (Codex LOW-01). Each writer
        # now owns its temp; Move (REPLACE_EXISTING) stays a clean last-writer-wins on the destination.
        $tmp = "$path.$PID.$([System.IO.Path]::GetRandomFileName()).tmp"
        [System.IO.File]::WriteAllText($tmp, ($payload | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::Move($tmp, $path, $true)
        return $path
    } catch {
        # Don't fail the caller, but don't fail silently either — a swallowed write means the
        # dashboard would keep showing a stale status.
        if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        try { Write-Log ("Write-StatusJson failed: {0}" -f $_.Exception.Message) -Level 'WARN' -Color 'Yellow' }
        catch { Write-Verbose "Write-StatusJson: could not report its own failure: $_" }
        return $null
    }
}

# ----------------------------------------------------------------------------
# Update-hold guard. A component listed in <Root>\update-holds.json is locally
# patched and must NOT be auto-updated (its fix isn't upstream yet). This is the
# single DRY guard every direct-run Update-*.ps1 calls right after sourcing
# ScriptKit: it prints the hold notice AND refreshes the component's envelope to
# 'held', so the dashboard reflects reality instead of the last non-held run's
# stale status (e.g. an old 'install failed'). Returns $true when held -> the
# caller should `exit 0`. Callers gate on Get-Command, so if ScriptKit itself is
# absent (never in practice — it's vendored beside every script) the guard is
# simply skipped rather than crashing.
function Invoke-UpdateHoldGuard {
    param(
        [Parameter(Mandatory)][string]$Root,       # dir holding update-holds.json (usually $PSScriptRoot)
        [Parameter(Mandatory)][string]$HoldKey,     # key in update-holds.json (e.g. 'RTK')
        [Parameter(Mandatory)][string]$Component,   # envelope component name (e.g. 'rtk')
        [string]$Mode = 'check'
    )
    $holds = Join-Path $Root 'update-holds.json'
    if (-not (Test-Path -LiteralPath $holds)) { return $false }
    try {
        $entry = (Get-Content -Raw -LiteralPath $holds | ConvertFrom-Json).PSObject.Properties[$HoldKey]
    } catch {
        # An existing-but-unreadable holds file must not silently un-hold a patched build:
        # fail CLOSED (treat as held) so a corrupt file blocks updates instead of clobbering.
        Write-Host ("[HELD] {0}: update-holds.json unreadable, holding to be safe -- {1}" -f $HoldKey, $_.Exception.Message) -ForegroundColor Yellow
        return $true
    }
    if (-not $entry) { return $false }
    Write-Host ("[HELD] {0}: {1}" -f $HoldKey, $entry.Value.reason) -ForegroundColor Yellow
    Write-Host ("  (to update anyway: delete the '{0}' entry from update-holds.json)" -f $HoldKey) -ForegroundColor DarkGray
    Write-StatusJson -Root $Root -Component $Component -Status 'held' `
        -Mode $Mode -Summary ("held: " + $entry.Value.reason) | Out-Null
    return $true
}

# ============================================================================
# Logging (file + console)
# ============================================================================

# Start a timestamped log under <Root>\logs, keep newest $Keep files.
function Initialize-Logging {
    param([string]$Root, [string]$Prefix = 'script', [int]$Keep = 15)
    $logDir = Join-Path $Root 'logs'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    # $PID in the name: the timestamp has one-second granularity, so two runs of the same component
    # started in the same second otherwise share one log file and fight over the append handle.
    $script:SK_LogFile = Join-Path $logDir ("{0}_{1}_{2}.log" -f $Prefix, (Get-Date -Format 'yyyyMMdd_HHmmss'), $PID)
    Get-ChildItem -LiteralPath $logDir -Filter "$Prefix*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    return $script:SK_LogFile
}

# PSAvoidOverwritingBuiltInCmdlets flags this name, but there is no built-in `Write-Log` to shadow:
# `Get-Command Write-Log` is empty in a clean pwsh 7.6.2 session, and Microsoft.PowerShell.Utility
# ships only Write-Debug/Error/Host/Information/Output/Progress/Verbose/Warning. The rule fires from
# an inventory baked into PSScriptAnalyzer, not from the live runtime — hence the documented
# exclusion in PSScriptAnalyzerSettings.psd1. Renaming it would break 40 call sites in three
# repositories that vendor this file via Sync-ScriptKit.ps1, to fix nothing.
function Write-Log {
    param([string]$Msg, [string]$Level = 'INFO', [switch]$NoConsole, [string]$Color = 'Gray')
    if ($script:SK_LogFile) {
        # Logging must never kill the caller's real job. Two runs of the same component started in the
        # same second share a log path (the name has one-second granularity), and the second writer
        # then hits a sharing violation — which used to propagate out of Write-Status mid-run.
        try {
            Add-Content -LiteralPath $script:SK_LogFile -Value ("[{0}] [{1}] {2}" -f (Get-Date -Format 'HH:mm:ss'), $Level, $Msg) -Encoding UTF8 -ErrorAction Stop
        } catch {
            Write-Verbose "Write-Log: could not append to $($script:SK_LogFile): $_"
        }
    }
    if (-not $NoConsole) { Write-Host $Msg -ForegroundColor $Color }
}
