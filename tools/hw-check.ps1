# ============================================================================
# Sidearm -- hardware check of a release build
# ============================================================================
# Run after testing ..\portable\Sidearm.exe (the signed release build) on the
# real mice. Asks each check, then writes plans\release\hw-check-vX.Y.Z.json
# with the exe's SHA-256: `release.ps1 -Publish` publishes only that very exe,
# and only when every check passed.
#
# Usage: pwsh -File tools\hw-check.ps1 -Version 0.13.0
# ============================================================================
param([Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path (Split-Path $root -Parent) 'portable\Sidearm.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "No release build at ${exe}: run release.ps1 -Version $Version first." }

# One line each: what to do on the mice, what must happen.
$checks = [ordered]@{
    trayBattery  = 'Tray battery: with the V2 asleep, the badge keeps its last reading'
    macroCancel  = 'A long macro stops on pause, on a manual profile switch and on "Stop macros"'
    popups       = 'Menu, HyperShift 2 cheat sheet and OSD open; releasing HS2 as the sheet appears freezes nothing'
    autostart    = 'Start as administrator: the reconfirm after the update works'
    sleepingExit = 'Quit with a mouse asleep: the offline profile is written once it wakes'
    twoMice      = 'Both mice at once: each runs its own assignments'
}
$results = [ordered]@{}
foreach ($check in $checks.GetEnumerator()) {
    do { $answer = (Read-Host "$($check.Value)? [y/n]").Trim().ToLowerInvariant() } until ($answer -in 'y', 'n')
    $results[$check.Key] = $answer -eq 'y'
}

$record = [ordered]@{
    version   = $Version
    exeSha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    checkedAt = (Get-Date).ToString('s')
    checks    = $results
}
$out = Join-Path $root "plans\release\hw-check-v$Version.json"
New-Item -ItemType Directory -Path (Split-Path $out) -Force | Out-Null
$record | ConvertTo-Json | Set-Content -LiteralPath $out -Encoding utf8
$failed = @($results.GetEnumerator() | Where-Object Value -ne $true | ForEach-Object Key)
if ($failed.Count) {
    Write-Host "Recorded with failures: $($failed -join ', ') -- release.ps1 -Publish will refuse." -ForegroundColor Yellow
    exit 1
}
Write-Host "Recorded: $out" -ForegroundColor Green
