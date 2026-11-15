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

function Remove-OldExeCopies {
    # The `<name>.old-<n>` copies nothing runs from any more (a running one stays).
    param([string]$Dir, [string]$Name)
    Get-ChildItem -LiteralPath $Dir -Filter "$Name.old-*" -Force -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}
