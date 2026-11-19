# Puts the current portable build (..\..\portable\Sidearm.exe) on the owner's devices and
# restarts Sidearm there: Main (this machine, the build already in place: re-pin + restart,
# one UAC prompt) and the notebook (copied over ssh). Only the exe moves; each device keeps its data\ (Syncthing
# syncs the config). The device side is deploy-device-remote.ps1, run elevated through ssh.
# An unreachable device is skipped with a warning; exit 1 when any device failed.
#
# Usage: pwsh -File tools\deploy-devices.ps1 [-Device notebook]   (default: all)
# release.ps1 -Publish runs it after the release (-NoDeploy skips).
param([string[]]$Device)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\ScriptKit.ps1')

$exe = Join-Path $PSScriptRoot '..\..\portable\Sidearm.exe' | Resolve-Path | ForEach-Object Path
# ssh alias -> the device's portable folder; Stage: where the new exe lands ($null = already in place).
$devices = [ordered]@{
    main     = @{ Portable = 'E:\Scripts\Sidearm\portable'; Stage = $null; Local = $true }
    notebook = @{ Portable = 'C:\Scripts\Sidearm\portable'; Stage = 'sidearm-deploy' }
}
$unknown = @($Device | Where-Object { $_ -notin $devices.Keys })
if ($unknown) { Write-Fail "unknown device: $($unknown -join ', ') (known: $($devices.Keys -join ', '))"; exit 1 }

$hash = (Get-FileHash -LiteralPath $exe).Hash.ToLower()
$remote = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'deploy-device-remote.ps1') -Raw
$ssh = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR')
$failed = @()

foreach ($name in $devices.Keys) {
    if ($Device -and $name -notin $Device) { continue }
    $d = $devices[$name]
    Write-Info "$name -> $($d.Portable)"
    try {
        # Syncthing often brought the exe already (the portable folder syncs): nothing to copy then.
        $there = if ($d.Stage) {
            $probe = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("(Get-FileHash '$($d.Portable)\Sidearm.exe' -ErrorAction SilentlyContinue).Hash"))
            "$(& ssh @ssh $name "powershell -NoProfile -EncodedCommand $probe" 2>$null)".Trim().ToLower()
        }
        if ($d.Stage -and $there -eq $hash) {
            Write-Info "$name already has this exe (synced): restart only"
            $stage = "'$($d.Portable)'"
        } elseif ($d.Stage) {
            & ssh @ssh $name "cmd /c if not exist %USERPROFILE%\$($d.Stage) mkdir %USERPROFILE%\$($d.Stage)" | Out-Null
            & scp @ssh $exe "${name}:$($d.Stage)/Sidearm.exe"
            if ($LASTEXITCODE -ne 0) { throw "scp failed ($LASTEXITCODE)" }
            $stage = "Join-Path `$env:USERPROFILE '$($d.Stage)'"
        } else {
            $stage = "'$($d.Portable)'"
        }
        $script = "`$Portable = '$($d.Portable)'`n`$Stage = $stage`n" + $remote
        if ($d.Local) {
            # This machine: elevated (one UAC prompt unless already elevated) to re-pin the admin task.
            $tmp = Join-Path $env:TEMP "sidearm-deploy-$PID"
            Set-Content -LiteralPath "$tmp.ps1" -Value "& {`n$script`n} *> '$tmp.log'" -Encoding UTF8
            $run = @{ FilePath = 'powershell'; ArgumentList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$tmp.ps1"); Wait = $true; PassThru = $true; WindowStyle = 'Hidden' }
            if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { $run.Verb = 'RunAs' }
            $p = Start-Process @run
            $out = @(Get-Content -LiteralPath "$tmp.log" -ErrorAction SilentlyContinue | ForEach-Object { "$_".TrimEnd() })
            Remove-Item -LiteralPath "$tmp.ps1", "$tmp.log" -ErrorAction SilentlyContinue
            if ($p.ExitCode -ne 0) { throw "deploy script failed ($($p.ExitCode)): $($out -join ' | ')" }
        } else {
            $b64 = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
            $out = & ssh @ssh $name "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand $b64" 2>&1 | ForEach-Object { "$_".TrimEnd() }
            if ($LASTEXITCODE -ne 0) { throw "remote script failed ($LASTEXITCODE): $($out -join ' | ')" }
        }
        $out | Where-Object { $_ } | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        if (-not ($out -match "^exe $hash$")) { throw 'the exe on the device is not this build' }
        if (-not ($out -match '^running [1-9]')) { throw 'Sidearm did not start in the desktop session' }
        Write-Ok "$name runs this build ($($hash.Substring(0, 12)))"
    } catch {
        Write-Warn "${name}: $_"
        $failed += $name
    }
}
if ($failed) { Write-Fail "not deployed: $($failed -join ', ')"; exit 1 }
