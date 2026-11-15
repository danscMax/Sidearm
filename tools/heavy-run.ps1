# Runs a heavy command (the verify gate, the full Rust suite, e2e) inside the
# machine's heavy-run guard (E:\Scripts\ops\heavy-run.ps1, owner's rule 2026-11-15):
# BelowNormal, a kill-on-close job, a leash to the launching shell, and one heavy
# run per machine across all projects. A nested call (verify -> e2e) reuses the
# outer slot. Without the guard (another machine, CI) the command runs as is.
#   pwsh -NoProfile -File tools/heavy-run.ps1 <command> [args...]
# Dot-sourced without arguments (release.ps1, build_portable.ps1) it only takes
# the slot for the calling script.
$guard = 'E:\Scripts\ops\heavy-run.ps1', 'C:\Scripts\ops\heavy-run.ps1' | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($guard) {
    . $guard
    if ($args.Count) { Enter-HeavyRun -Project 'sidearm' -Command ($args -join ' ') } else { Enter-HeavyRun -Project 'sidearm' }
} else {
    Write-Host '[heavy-run] guard not found: running without it' -ForegroundColor Yellow
}
if (-not $args.Count) { return }
$command = $args[0]
$rest = @($args | Select-Object -Skip 1)
try {
    & $command @rest
} catch [System.Management.Automation.CommandNotFoundException] {
    Write-Error $_
    exit 127
}
exit $LASTEXITCODE
