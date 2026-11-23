# Dot-sourced by dev.ps1 and build_portable.ps1.

function Move-LockedExe {
    # A running Sidearm restore process (`--restore-live-maps`, maybe waiting
    # for a sleeping mouse) holds its exe, which a build must replace. Windows
    # lets a running exe be renamed, not deleted or overwritten: move it to
    # `<name>.old-<n>` so the restorer keeps running, and delete the old copies
    # nothing runs from any more. Every name of the file goes: cargo hard-links
    # `target\<profile>\sidearm.exe` to `deps\sidearm.exe` and the linker writes
    # the latter, so moving one name left LNK1104 "cannot open file" (2026-11-15).
    param([Parameter(Mandatory)][string]$Path)
    $dir = [System.IO.Path]::GetDirectoryName($Path)
    $name = [System.IO.Path]::GetFileName($Path)
    Remove-OldExeCopies $dir $name
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        # No sharing: fails while any process runs from the file.
        [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None').Dispose()
        return
    } catch { }
    # fsutil lists every name of the file, drive-relative (no admin needed).
    $drive = [System.IO.Path]::GetPathRoot($Path).TrimEnd('\')
    $names = @(& fsutil hardlink list $Path 2>$null | Where-Object { $_ } | ForEach-Object { $drive + $_.Trim() })
    if ($names.Count -eq 0) { $names = @($Path) }
    foreach ($link in $names) {
        $linkDir = [System.IO.Path]::GetDirectoryName($link)
        $linkName = [System.IO.Path]::GetFileName($link)
        Remove-OldExeCopies $linkDir $linkName
        $n = 1
        while (Test-Path -LiteralPath (Join-Path $linkDir "$linkName.old-$n")) { $n++ }
        Rename-Item -LiteralPath $link -NewName "$linkName.old-$n"
        Write-Host "  $link is in use (a restore process): moved to $linkName.old-$n" -ForegroundColor Yellow
    }
}

function Stop-SidearmApps {
    # Asks each running Sidearm app to quit (`<its exe> --quit`: the running one
    # gets it and exits as from the tray — releases its keys, restores its mice)
    # and kills only the ones still running after $TimeoutSec. A plain kill
    # mid-shortcut left Ctrl down for every app (2026-11-15).
    param([Parameter(Mandatory)][int[]]$Ids, [int]$TimeoutSec = 30)
    $exes = @($Ids | ForEach-Object { (Get-CimInstance Win32_Process -Filter "ProcessId = $_" -ErrorAction SilentlyContinue).ExecutablePath } |
        Where-Object { $_ } | Sort-Object -Unique)
    $quitProcs = @()
    foreach ($exe in $exes) {
        try {
            $q = Start-Process -FilePath $exe -ArgumentList '--quit' -WindowStyle Hidden -PassThru -ErrorAction Stop
            if ($q) { $quitProcs += $q }
        } catch {
            Write-Host "  Could not ask $exe to quit: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
    try {
        Wait-Process -Id $Ids -Timeout $TimeoutSec -ErrorAction SilentlyContinue
        $left = @($Ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($left.Count -gt 0) {
            Write-Host "  Sidearm did not quit within $TimeoutSec s: stopping PID $($left -join ', ')" -ForegroundColor Yellow
            Stop-Process -Id $left -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $left -Timeout 10 -ErrorAction SilentlyContinue
        }
    } finally {
        # Never leave a `--quit` helper alive (e.g. if UIPI prevented it from
        # reaching an elevated instance): a lingering helper could block mouse restore.
        foreach ($q in $quitProcs) {
            if ($q -and -not $q.HasExited) {
                Wait-Process -Id $q.Id -Timeout 3 -ErrorAction SilentlyContinue
                if (-not $q.HasExited) {
                    Stop-Process -Id $q.Id -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
}

function Remove-OldExeCopies {
    # The `<name>.old-<n>` copies nothing runs from any more (a running one stays).
    param([string]$Dir, [string]$Name)
    Get-ChildItem -LiteralPath $Dir -Filter "$Name.old-*" -Force -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}
