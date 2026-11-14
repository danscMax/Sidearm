# ============================================================================
# Sidearm -- Release Script
# ============================================================================
# Prepares (and with -Publish, publishes) a GitHub release of the portable build:
#   1. The version is the same in package.json, package-lock.json,
#      src-tauri/tauri.conf.json, src-tauri/Cargo.toml and src-tauri/Cargo.lock
#   2. CHANGELOG.md has a "## [x.y.z]" section -> the release notes
#   3. The working tree is clean and the tag does not exist yet
#   4. npm run verify (tsc, knip, clippy, cargo test, vitest, tool tests, e2e)
#      once per commit: a pass is remembered in plans\release\verified-<commit>
#   5. build_portable.ps1 (audit + build + assemble)
#   6. Authenticode-signs portable\Sidearm.exe with the GlobalSign code signing
#      certificate on the Rutoken plugged into MiniPC (SweetWhisper's
#      scripts\sign-windows.ps1, jsign over PKCS#11; over ssh: copy there, sign,
#      copy back) and checks the signature is valid, timestamped and ours
#      Both embedded versions must match -Version before signing and zipping.
#      An exe already signed with our certificate is not signed again (its hash
#      is what the hardware check below was recorded for).
#   7. plans\release\out\Sidearm-Portable-vX.Y.Z.zip from ..\portable without
#      data/ + SHA-256 (the folder is recreated, so only this release is there);
#      a changed settings format (SCHEMA_VERSION since the last tag) heads the notes
#   8. -Publish only: requires the hardware check of this very exe
#      (tools\hw-check.ps1 -> plans\release\hw-check-vX.Y.Z.json), asks to type
#      the version, then tags, pushes the branch and the tag, creates the GitHub
#      release with the zip, deletes plans\release\out
#
# Usage:
#   .\release.ps1 -Version 0.11.0              - Checks, build, zip, notes (no publish)
#   .\release.ps1 -Version 0.11.0 -SkipBuild   - Same, reusing the current portable build
#   then test that build on the mice and run tools\hw-check.ps1 -Version 0.11.0
#   .\release.ps1 -Version 0.11.0 -SkipBuild -Publish
#                                              - Publish exactly that tested build
#                                                (a rebuild would change its hash)
#
# The title is ASCII ("vX.Y.Z"): a non-ASCII --title arg is mangled by the
# console codepage; the notes go through --notes-file (read as UTF-8).
# ============================================================================

param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [switch]$SkipBuild,
    [switch]$Publish,
    # Leave Sidearm.exe unsigned (no token at hand). A published release is always signed.
    [switch]$NoSign,
    # Skip npm run verify (a local try only: a published release is always verified).
    [switch]$SkipVerify,
    # The publish confirmation, given up front (a run without a console: Read-Host
    # cannot read piped input). Must equal -Version, like the typed answer.
    [string]$ConfirmVersion
)

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'ScriptKit.ps1')

$root = $PSScriptRoot
$portable = Join-Path (Split-Path $root -Parent) 'portable'
$tag = "v$Version"
# Gitignored scratch dir: holds only the current release, emptied once published.
$outDir = Join-Path $root 'plans\release\out'
$zip = Join-Path $outDir "Sidearm-Portable-$tag.zip"
$notesFile = Join-Path $outDir "release-notes-$tag.md"

function Stop-Release([string]$Message) {
    Write-Fail $Message
    exit 1
}

function Assert-ReleaseExecutableVersion([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Stop-Release "No build in $portable." }
    $info = (Get-Item -LiteralPath $Path).VersionInfo
    if ($info.ProductVersion -ne $Version -or $info.FileVersion -ne $Version) {
        Stop-Release "Sidearm.exe version mismatch: ProductVersion '$($info.ProductVersion)', FileVersion '$($info.FileVersion)'; expected '$Version'. Rebuild the portable package."
    }
}

# 1. One version everywhere.
Write-Step 1 7 "Version $Version in every manifest"
# The lockfile's root package has an empty name: only a hashtable can hold it.
$lock = Get-Content -LiteralPath "$root\package-lock.json" -Raw | ConvertFrom-Json -AsHashtable
$found = [ordered]@{
    'package.json'              = (Get-Content -LiteralPath "$root\package.json" -Raw | ConvertFrom-Json).version
    'package-lock.json'         = $lock['version']
    'package-lock.json (root)'  = $lock['packages']['']['version']
    'src-tauri/tauri.conf.json' = (Get-Content -LiteralPath "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
    'src-tauri/Cargo.toml'      = [regex]::Match((Get-Content -LiteralPath "$root\src-tauri\Cargo.toml" -Raw), '(?ms)^\[package\].*?^version\s*=\s*"([^"]+)"').Groups[1].Value
    'src-tauri/Cargo.lock'      = [regex]::Match((Get-Content -LiteralPath "$root\src-tauri\Cargo.lock" -Raw), '(?m)^name = "sidearm"\r?\nversion = "([^"]+)"').Groups[1].Value
}
$wrong = $found.GetEnumerator() | Where-Object { $_.Value -ne $Version }
if ($wrong) {
    $wrong | ForEach-Object { Write-Fail ("{0}: {1}" -f $_.Key, $_.Value) }
    Stop-Release "Bump every file above to $Version first."
}
Write-Ok "all six say $Version"

# 2. Release notes from the CHANGELOG section.
Write-Step 2 7 "CHANGELOG section [$Version]"
$changelog = Get-Content -LiteralPath "$root\CHANGELOG.md" -Raw
$section = [regex]::Match($changelog, "(?ms)^## \[$([regex]::Escape($Version))\][^\r\n]*\r?\n(.*?)(?=^## \[|\z)")
if (-not $section.Success) { Stop-Release "CHANGELOG.md has no '## [$Version]' section (rename [Unreleased])." }
$notes = $section.Groups[1].Value.Trim()

# 3. Clean tree, new tag.
Write-Step 3 7 "Git state"
Push-Location $root
try {
    if (git status --porcelain --untracked-files=no) { Stop-Release "The working tree has uncommitted changes." }
    if (git tag --list $tag) { Stop-Release "Tag $tag already exists." }
    $branch = git rev-parse --abbrev-ref HEAD
    $commit = git rev-parse HEAD
    $lastTag = git describe --tags --abbrev=0 HEAD 2>$null
    $schemaNow = [regex]::Match((Get-Content -LiteralPath "$root\src-tauri\src\config.rs" -Raw), 'SCHEMA_VERSION: i32 = (\d+);').Groups[1].Value
    $schemaThen = if ($lastTag) { [regex]::Match(((git show "${lastTag}:src-tauri/src/config.rs") -join "`n"), 'SCHEMA_VERSION: i32 = (\d+);').Groups[1].Value } else { '' }
} finally { Pop-Location }
Write-Ok "clean, branch $branch, $tag is new"

# A release publishes the build its hardware check tested: never a fresh one.
if ($Publish -and -not $SkipBuild) {
    Stop-Release "Publish the tested build: run release.ps1 -Version $Version, test it, run tools\hw-check.ps1 -Version $Version, then release.ps1 -Version $Version -SkipBuild -Publish."
}

# 4. The whole local check, once per commit.
if ($SkipVerify -and $Publish) { Stop-Release "A published release is verified: drop -SkipVerify." }
$verifiedMark = Join-Path $root "plans\release\verified-$commit"
if ($SkipVerify) {
    Write-Warn "npm run verify skipped (-SkipVerify)."
} elseif (Test-Path -LiteralPath $verifiedMark) {
    Write-Ok "npm run verify already passed on $($commit.Substring(0, 8))"
} else {
    Write-Step 4 7 "npm run verify"
    Push-Location $root
    try { npm run verify } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Stop-Release "npm run verify failed ($LASTEXITCODE): fix it before a release." }
    New-Item -ItemType File -Path $verifiedMark -Force | Out-Null
    Write-Ok "verified $($commit.Substring(0, 8))"
}

# 4. Build.
if (-not $SkipBuild) {
    Write-Step 5 7 "Portable build"
    & pwsh -NoProfile -File (Join-Path $root 'build_portable.ps1') -NoOpen -StrictAudit
    if ($LASTEXITCODE -ne 0) { Stop-Release "build_portable.ps1 failed ($LASTEXITCODE)." }
}

# 5. Code signing on MiniPC, where the token is.
$exe = Join-Path $portable 'Sidearm.exe'
Assert-ReleaseExecutableVersion $exe
$certFile = Join-Path (Split-Path (Split-Path $root -Parent) -Parent) 'SweetWhisper\app\src-tauri\codesign\sweetwhisper-codesign.cer'
if ($NoSign -and $Publish) { Stop-Release "A published release is signed: drop -NoSign." }
$signed = $false
if (-not $NoSign) {
    # Already ours (an earlier run, then the hardware check): signing again would change its hash.
    $existing = Get-AuthenticodeSignature -LiteralPath $exe
    if (Test-Path -LiteralPath $certFile) {
        $ours = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certFile).Thumbprint
        $signed = $existing.Status -eq 'Valid' -and $existing.SignerCertificate.Thumbprint -eq $ours -and [bool]$existing.TimeStamperCertificate
    }
    if ($signed) { Write-Ok "already signed with our certificate: kept (its hash is what was tested)" }
}
if (-not $NoSign -and -not $signed) {
    Write-Step 6 7 "Code signing (MiniPC token)"
    if (-not (Test-Path -LiteralPath $certFile)) { Stop-Release "Certificate file missing: $certFile" }
    $thumbprint = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certFile).Thumbprint
    $remoteExe = 'C:\Users\dansc\sidearm-sign\Sidearm.exe'
    ssh -o BatchMode=yes minipc 'cmd /c if not exist C:\Users\dansc\sidearm-sign mkdir C:\Users\dansc\sidearm-sign' 2>$null
    scp -o BatchMode=yes $exe 'minipc:C:/Users/dansc/sidearm-sign/Sidearm.exe' 2>$null
    if ($LASTEXITCODE -ne 0) { Stop-Release "Could not copy Sidearm.exe to MiniPC." }
    ssh -o BatchMode=yes minipc "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Scripts\SweetWhisper\app\scripts\sign-windows.ps1 $remoteExe" 2>$null
    if ($LASTEXITCODE -ne 0) { Stop-Release "Signing on MiniPC failed (token, PIN or jsign: run sign-windows.ps1 -Check there)." }
    scp -o BatchMode=yes 'minipc:C:/Users/dansc/sidearm-sign/Sidearm.exe' $exe 2>$null
    if ($LASTEXITCODE -ne 0) { Stop-Release "Could not copy the signed Sidearm.exe back." }
    $sig = Get-AuthenticodeSignature -LiteralPath $exe
    if ($sig.Status -ne 'Valid') { Stop-Release "Sidearm.exe signature is $($sig.Status)." }
    if ($sig.SignerCertificate.Thumbprint -ne $thumbprint) { Stop-Release "Sidearm.exe is signed by $($sig.SignerCertificate.Subject), not our certificate." }
    if (-not $sig.TimeStamperCertificate) { Stop-Release "Sidearm.exe signature has no timestamp." }
    Write-Ok "signed: $($sig.SignerCertificate.Subject.Split(',')[0]), timestamped"
}

# 6. Zip without the per-user data/ folder.
Write-Step 7 7 "Zip"
Assert-ReleaseExecutableVersion $exe
$notices = Join-Path $portable 'THIRD-PARTY-NOTICES.txt'
if (-not (Test-Path -LiteralPath $notices) -or (Get-Item -LiteralPath $notices).Length -eq 0) {
    Stop-Release 'THIRD-PARTY-NOTICES.txt is missing or empty; rebuild the portable package.'
}
if (-not (Test-Path -LiteralPath (Join-Path $portable 'resources\MicrosoftEdgeWebview2Setup.exe'))) {
    Write-Warn "resources\MicrosoftEdgeWebview2Setup.exe is missing from the build (see build_portable.ps1)."
}
if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir | Out-Null
$items = Get-ChildItem -LiteralPath $portable -Force -Exclude 'data'
Compress-Archive -Path $items.FullName -DestinationPath $zip
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$sizeMb = (Get-Item -LiteralPath $zip).Length / 1MB
Write-Ok ("{0} ({1:N2} MB)" -f (Split-Path $zip -Leaf), $sizeMb)
Write-Info "SHA-256 $hash"

if ($schemaThen -and $schemaNow -and $schemaThen -ne $schemaNow) {
    $formatNote = @"
> **The settings format changed (v$schemaThen -> v$schemaNow).** An older Sidearm will not open settings saved by this one: before the first start, keep a copy of ``data\`` if you may go back.
>
> **Формат настроек изменился (v$schemaThen -> v$schemaNow).** Прежний Sidearm не откроет настройки, сохранённые этим: перед первым запуском сохраните копию папки ``data\``, если можете вернуться.

"@
    $notes = $formatNote + $notes
    Write-Warn "settings format v$schemaThen -> v$schemaNow since ${lastTag}: noted at the top of the release notes"
}

$footer = @"

---
Portable: unzip anywhere and run ``Sidearm.exe``. Settings live in ``data/`` next to it (not shipped in the zip).

SHA-256 ``$(Split-Path $zip -Leaf)``: ``$hash``
"@
[System.IO.File]::WriteAllText($notesFile, $notes + "`n" + $footer, [System.Text.UTF8Encoding]::new($false))
Write-Ok "notes: $notesFile"

if (-not $Publish) {
    Write-Info "Not published. Re-run with -Publish to tag, push and create the release."
    exit 0
}

# 8. Publish — the hardware check of this very exe, then an explicit
# confirmation (it is public and hard to undo).
$hwCheck = Join-Path $root "plans\release\hw-check-$tag.json"
$exeHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$recorded = if (Test-Path -LiteralPath $hwCheck) { Get-Content -LiteralPath $hwCheck -Raw | ConvertFrom-Json } else { $null }
if (-not $recorded -or $recorded.exeSha256 -ne $exeHash) {
    Stop-Release "No hardware check of this Sidearm.exe ($($exeHash.Substring(0, 12))...): test it on the mice, then run tools\hw-check.ps1 -Version $Version."
}
$failedChecks = @($recorded.checks.PSObject.Properties | Where-Object Value -ne $true | ForEach-Object Name)
if ($failedChecks.Count) { Stop-Release "Hardware check not passed: $($failedChecks -join ', ')." }
Write-Ok "hardware check of this exe passed"
$answer = if ($ConfirmVersion) { $ConfirmVersion } else { Read-Host "Publish $tag (tag, push $branch + tag, GitHub release)? Type the version to confirm" }
if ($answer -ne $Version) { Stop-Release "Not confirmed." }
Push-Location $root
try {
    git tag -a $tag -m "Sidearm $tag"
    if ($LASTEXITCODE -ne 0) { Stop-Release "git tag failed." }
    git push origin $branch $tag
    if ($LASTEXITCODE -ne 0) { Stop-Release "git push failed (tag $tag exists locally)." }
    gh release create $tag $zip --title $tag --notes-file $notesFile --latest
    if ($LASTEXITCODE -ne 0) { Stop-Release "gh release create failed (tag $tag is pushed)." }
} finally { Pop-Location }
Remove-Item -LiteralPath $outDir -Recurse -Force
Write-Ok "published $tag"
