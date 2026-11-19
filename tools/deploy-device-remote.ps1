# Runs ON a device (through ssh, elevated, -EncodedCommand; ASCII only): puts the staged
# Sidearm.exe into the device's portable folder, re-pins the elevated autostart task to it
# and restarts Sidearm in the user's desktop session. The device's data\ is never touched.
# deploy-devices.ps1 prepends $Portable (the device's portable folder) and $Stage (the
# folder holding the new exe; the same as $Portable when the exe is already in place).
$ErrorActionPreference = 'Stop'
$exe = Join-Path $Portable 'Sidearm.exe'
$new = Join-Path $Stage 'Sidearm.exe'
$newHash = (Get-FileHash $new).Hash.ToLower()

# Stop the app (its watchdog then restores the mice's live maps).
Get-CimInstance Win32_Process -Filter "name='Sidearm.exe'" |
  Where-Object { $_.CommandLine -notmatch '--(capture-helper|restore-live-maps|spawn-watchdog)' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped app $($_.ProcessId)" }
Start-Sleep -Seconds 8

if (-not (Test-Path $exe) -or (Get-FileHash $exe).Hash.ToLower() -ne $newHash) {
    # A restorer may still run from Sidearm.exe: a running exe can be renamed, not overwritten.
    $old = Join-Path $Portable 'Sidearm.old.exe'
    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
    if (Test-Path $exe) { Move-Item $exe $old -Force }
    Copy-Item $new $exe
}
"exe $((Get-FileHash $exe).Hash.ToLower())"

# The elevated logon task pins the exe's SHA-256: re-pin it (what the app's "Confirm" button does).
$admin = Get-ScheduledTask -TaskName 'SidearmAutostartAdmin' -ErrorAction SilentlyContinue
if ($admin) {
    $pin = Start-Process -FilePath $exe -ArgumentList '--admin-autostart', 'enable' -Wait -PassThru
    $xml = (Export-ScheduledTask -TaskName 'SidearmAutostartAdmin') -join ''
    "autostart re-pinned: exit=$($pin.ExitCode) hash-in-task=$($xml.ToLower().Contains($newHash))"
}

# Start in the interactive desktop session (an ssh-started process would live in no desktop):
# elevated through the admin task when there is one, or Windows drops its keys in elevated windows.
if ($admin) {
    schtasks /run /tn 'SidearmAutostartAdmin' | Out-Null
} else {
    $task = 'SidearmStartNow'
    schtasks /create /tn $task /tr "`"$exe`"" /sc once /st 23:59 /it /rl LIMITED /f | Out-Null
    schtasks /run /tn $task | Out-Null
}
Start-Sleep -Seconds 12
if (-not $admin) { schtasks /delete /tn 'SidearmStartNow' /f | Out-Null }
$running = @(Get-CimInstance Win32_Process -Filter "name='Sidearm.exe'" |
  Where-Object { $_.CommandLine -notmatch '--(capture-helper|restore-live-maps|spawn-watchdog)' -and $_.SessionId -ne 0 })
"running $($running.Count)"
Get-Content (Join-Path $Portable 'data\logs\Sidearm.log') -Tail 400 -ErrorAction SilentlyContinue |
  Select-String 'Capture started' | Select-Object -Last 1 | ForEach-Object { $_.Line }
