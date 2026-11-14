# Dot-sourced by dev.ps1 and build_portable.ps1.

function Move-LockedExe {
    # A running Sidearm restore process (`--restore-live-maps`, maybe waiting
    # for a sleeping mouse) holds its exe, which a build must replace. Windows
    # lets a running exe be renamed, not deleted or overwritten: move it to
    # `<name>.old-<n>` so the restorer keeps running, and delete the old copies
    # nothing runs from any more.
    param([Parameter(Mandatory)][string]$Path)
    $dir = [System.IO.Path]::GetDirectoryName($Path)
    $name = [System.IO.Path]::GetFileName($Path)
    Get-ChildItem -LiteralPath $dir -Filter "$name.old-*" -Force -ErrorAction SilentlyContinue |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        # No sharing: fails while any process runs from the file.
        [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None').Dispose()
        return
    } catch { }
    $n = 1
    while (Test-Path -LiteralPath (Join-Path $dir "$name.old-$n")) { $n++ }
    Rename-Item -LiteralPath $Path -NewName "$name.old-$n"
    Write-Host "  $name is in use (a restore process): moved to $name.old-$n" -ForegroundColor Yellow
}
