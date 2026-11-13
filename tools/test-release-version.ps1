# Run only the artifact guards; never execute a release, signing or packaging.
$ErrorActionPreference = 'Stop'
$releasePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'release.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($releasePath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }

foreach ($definition in $ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ne 'Stop-Release' }) {
    . ([scriptblock]::Create($definition.Extent.Text))
}
function Stop-Release([string]$Message) { throw "RELEASE-STOP: $Message" }
function Write-Step {}
function Write-Warn {}
function Test-Path { param($LiteralPath, $PathType) return $artifactExists }
function Get-Item {
    param($LiteralPath)
    if ($LiteralPath -ne (Join-Path $portable 'Sidearm.exe')) { throw "Unexpected artifact path: $LiteralPath" }
    return [pscustomobject]@{ VersionInfo = $metadata }
}

$statements = $ast.EndBlock.Statements
$exeAssignment = $statements | Where-Object { $_ -is [System.Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$exe' }
$signing = $statements | Where-Object { $_ -is [System.Management.Automation.Language.IfStatementAst] -and $_.Clauses[0].Item1.Extent.Text -eq '-not $NoSign' }
$cleanup = $statements | Where-Object { $_ -is [System.Management.Automation.Language.IfStatementAst] -and $_.Clauses[0].Item1.Extent.Text -eq 'Test-Path -LiteralPath $outDir' }
if (@($exeAssignment).Count -ne 1 -or @($signing).Count -ne 1 -or @($cleanup).Count -ne 1) {
    throw 'Cannot isolate release artifact guards safely.'
}
$phases = [ordered]@{
    'before signing' = @($statements | Where-Object { $_.Extent.StartOffset -ge $exeAssignment.Extent.StartOffset -and $_.Extent.EndOffset -le $signing.Extent.StartOffset })
    'after signing, before zip' = @($statements | Where-Object { $_.Extent.StartOffset -ge $signing.Extent.EndOffset -and $_.Extent.EndOffset -le $cleanup.Extent.StartOffset })
}

$root = Split-Path $PSScriptRoot -Parent
$portable = Join-Path $root 'plans/release/test-portable'
$exe = Join-Path $portable 'Sidearm.exe'
$Version = '0.12.3'
$NoSign = $true
$Publish = $false
$cases = @(
    @{ Name = 'matching versions'; Product = '0.12.3'; File = '0.12.3'; Exists = $true; Reject = $false }
    @{ Name = 'old portable exe'; Product = '0.12.2'; File = '0.12.2'; Exists = $true; Reject = $true }
    @{ Name = 'old product version'; Product = '0.12.2'; File = '0.12.3'; Exists = $true; Reject = $true }
    @{ Name = 'old file version'; Product = '0.12.3'; File = '0.12.2'; Exists = $true; Reject = $true }
    @{ Name = 'missing metadata'; Product = $null; File = $null; Exists = $true; Reject = $true }
    @{ Name = 'missing product version'; Product = ''; File = '0.12.3'; Exists = $true; Reject = $true }
    @{ Name = 'missing file version'; Product = '0.12.3'; File = ''; Exists = $true; Reject = $true }
    @{ Name = 'malformed version'; Product = 'invalid'; File = '0.12.3'; Exists = $true; Reject = $true }
    @{ Name = 'prerelease exe'; Product = '0.12.3-beta.1'; File = '0.12.3'; Exists = $true; Reject = $true }
    @{ Name = 'missing exe'; Product = $null; File = $null; Exists = $false; Reject = $true }
)
$failed = 0
foreach ($phase in $phases.GetEnumerator()) {
    $guard = [scriptblock]::Create(($phase.Value.Extent.Text -join "`n"))
    foreach ($case in $cases) {
        $artifactExists = $case.Exists
        $metadata = [pscustomobject]@{ ProductVersion = $case.Product; FileVersion = $case.File }
        $rejected = $false
        try { & $guard } catch {
            if ($_.Exception.Message -notlike 'RELEASE-STOP: *') { throw }
            $rejected = $true
        }
        if ($rejected -ne $case.Reject) {
            Write-Output "FAIL: $($phase.Key) / $($case.Name): rejected=$rejected, expected=$($case.Reject)"
            $failed++
        } else {
            Write-Output "PASS: $($phase.Key) / $($case.Name)"
        }
    }
}
Write-Output "Release version guards: $($cases.Count * $phases.Count) checks, $failed failures."
if ($failed) { exit 1 }
