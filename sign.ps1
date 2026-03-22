# ============================================================================
# Sidearm -- Code Signing Script (Self-Signed Certificate)
# ============================================================================
# Generates a self-signed code signing certificate and signs the built EXE.
# The certificate enables uiAccess="true" in the Windows manifest, which
# allows SendInput to reach elevated (admin) windows without running Sidearm
# itself as administrator.
#
# Requirements:
#   - Windows 10/11 with PowerShell 5.1+
#   - signtool.exe (from Windows SDK or Build Tools)
#   - Must run as Administrator (for cert store operations)
#
# Usage:
#   .\sign.ps1                    - Generate cert + sign release EXE
#   .\sign.ps1 -SignOnly          - Sign with existing cert (skip generation)
#   .\sign.ps1 -ExportCert        - Export root CA .cer for distribution
#   .\sign.ps1 -InstallCert       - Install exported .cer to Trusted Root
#   .\sign.ps1 -Clean             - Remove cert from store + delete .pfx
#
# Flow for distribution:
#   1. Developer runs .\sign.ps1 (once) to create cert + sign EXE
#   2. NSIS installer runs certutil to install .cer on user's machine
#   3. Signed EXE with uiAccess="true" works against elevated windows
# ============================================================================

param(
    [switch]$SignOnly,
    [switch]$ExportCert,
    [switch]$InstallCert,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---- Configuration ----
$CERT_SUBJECT    = "CN=Sidearm Open Source, O=Sidearm"
$CERT_FRIENDLY   = "Sidearm Code Signing"
$CERT_YEARS      = 10
$PFX_PASSWORD    = "sidearm-dev"  # Dev-only; production should use a vault
$PROJECT_ROOT    = $PSScriptRoot
$CERTS_DIR       = Join-Path $PROJECT_ROOT "certs"
$PFX_PATH        = Join-Path $CERTS_DIR "sidearm-signing.pfx"
$CER_PATH        = Join-Path $CERTS_DIR "sidearm-ca.cer"
$RESOURCES_DIR   = Join-Path $PROJECT_ROOT "resources"
$CER_RESOURCE    = Join-Path $RESOURCES_DIR "sidearm-ca.cer"

# Detect target-dir from .cargo/config.toml
$TAURI_TARGET_DIR = Join-Path $PROJECT_ROOT "src-tauri\target"
$cargoConfig = Join-Path $PROJECT_ROOT ".cargo\config.toml"
if (Test-Path -LiteralPath $cargoConfig) {
    $match = Select-String -LiteralPath $cargoConfig -Pattern 'target-dir\s*=\s*"(.+?)"'
    if ($match) {
        $TAURI_TARGET_DIR = $match.Matches[0].Groups[1].Value.Replace('/', '\')
    }
}
$RELEASE_EXE = Join-Path $TAURI_TARGET_DIR "release\sidearm.exe"

# ---- Helpers ----
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  [FAIL] $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  [..] $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Fail "This script must run as Administrator."
        Write-Host "  Right-click PowerShell -> 'Run as administrator', then re-run." -ForegroundColor Gray
        exit 1
    }
}

function Find-SignTool {
    # Check PATH first
    $inPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($inPath) { return $inPath.Source }

    # Search Windows SDK locations
    $sdkPaths = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "${env:ProgramFiles}\Windows Kits\10\bin"
    )
    foreach ($sdk in $sdkPaths) {
        if (-not (Test-Path -LiteralPath $sdk)) { continue }
        $found = Get-ChildItem -Path $sdk -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'x64' } |
            Sort-Object { $_.Directory.Name } -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }

    return $null
}

# ============================================================================
# -Clean: remove certificate and files
# ============================================================================
if ($Clean) {
    Assert-Admin
    Write-Host ""
    Write-Info "Cleaning certificate and signing artifacts..."

    # Remove from CurrentUser\My
    $certs = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $CERT_SUBJECT }
    foreach ($cert in $certs) {
        Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
        Write-Ok "Removed cert from CurrentUser\My: $($cert.Thumbprint)"
    }

    # Remove from LocalMachine\Root
    $roots = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -eq $CERT_SUBJECT }
    foreach ($root in $roots) {
        Remove-Item -Path "Cert:\LocalMachine\Root\$($root.Thumbprint)" -Force
        Write-Ok "Removed cert from LocalMachine\Root: $($root.Thumbprint)"
    }

    # Remove files
    if (Test-Path -LiteralPath $PFX_PATH) {
        Remove-Item -LiteralPath $PFX_PATH -Force
        Write-Ok "Removed $PFX_PATH"
    }
    if (Test-Path -LiteralPath $CER_PATH) {
        Remove-Item -LiteralPath $CER_PATH -Force
        Write-Ok "Removed $CER_PATH"
    }
    if (Test-Path -LiteralPath $CER_RESOURCE) {
        Remove-Item -LiteralPath $CER_RESOURCE -Force
        Write-Ok "Removed $CER_RESOURCE"
    }

    Write-Host "  Done." -ForegroundColor Green
    exit 0
}

# ============================================================================
# -InstallCert: install .cer to Trusted Root (for testing locally)
# ============================================================================
if ($InstallCert) {
    Assert-Admin
    if (-not (Test-Path -LiteralPath $CER_PATH)) {
        Write-Fail "Certificate not found: $CER_PATH"
        Write-Host "  Run .\sign.ps1 first to generate it." -ForegroundColor Gray
        exit 1
    }
    & certutil -addstore -f "Root" $CER_PATH
    if ($LASTEXITCODE -eq 0) {
        Write-Ok "Certificate installed to Trusted Root CAs"
    } else {
        Write-Fail "certutil failed (exit code $LASTEXITCODE)"
        exit 1
    }
    exit 0
}

# ============================================================================
# -ExportCert: export .cer from store
# ============================================================================
if ($ExportCert) {
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $CERT_SUBJECT } | Select-Object -First 1
    if (-not $cert) {
        Write-Fail "Certificate not found in store. Run .\sign.ps1 first."
        exit 1
    }
    if (-not (Test-Path -LiteralPath $CERTS_DIR)) {
        New-Item -ItemType Directory -Path $CERTS_DIR -Force | Out-Null
    }
    Export-Certificate -Cert $cert -FilePath $CER_PATH -Type CERT | Out-Null
    Copy-Item -LiteralPath $CER_PATH -Destination $CER_RESOURCE -Force
    Write-Ok "Exported to $CER_PATH"
    Write-Ok "Copied to $CER_RESOURCE (for NSIS installer)"
    exit 0
}

# ============================================================================
# Main: Generate cert (if needed) + Sign EXE
# ============================================================================
Assert-Admin

$signtool = Find-SignTool
if (-not $signtool) {
    Write-Fail "signtool.exe not found."
    Write-Host "  Install Windows SDK or Visual Studio Build Tools." -ForegroundColor Gray
    Write-Host "  https://developer.microsoft.com/en-us/windows/downloads/windows-sdk/" -ForegroundColor Gray
    exit 1
}
Write-Info "Using signtool: $signtool"

# ---- Generate certificate ----
if (-not $SignOnly) {
    $existing = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $CERT_SUBJECT }
    if ($existing) {
        Write-Warn "Certificate already exists (thumbprint: $($existing[0].Thumbprint))"
        Write-Info "Use -SignOnly to sign with existing cert, or -Clean to remove it first."
    } else {
        Write-Info "Generating self-signed code signing certificate..."

        $cert = New-SelfSignedCertificate `
            -Type CodeSigningCert `
            -Subject $CERT_SUBJECT `
            -FriendlyName $CERT_FRIENDLY `
            -CertStoreLocation Cert:\CurrentUser\My `
            -NotAfter (Get-Date).AddYears($CERT_YEARS) `
            -KeyUsage DigitalSignature `
            -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")

        Write-Ok "Certificate created: $($cert.Thumbprint)"

        # Export .pfx for CI/archive
        if (-not (Test-Path -LiteralPath $CERTS_DIR)) {
            New-Item -ItemType Directory -Path $CERTS_DIR -Force | Out-Null
        }
        $securePass = ConvertTo-SecureString -String $PFX_PASSWORD -Force -AsPlainText
        Export-PfxCertificate -Cert $cert -FilePath $PFX_PATH -Password $securePass | Out-Null
        Write-Ok "Exported PFX to $PFX_PATH"

        # Export .cer (public key only, for distribution)
        Export-Certificate -Cert $cert -FilePath $CER_PATH -Type CERT | Out-Null
        Copy-Item -LiteralPath $CER_PATH -Destination $CER_RESOURCE -Force
        Write-Ok "Exported CA cert to $CER_PATH"
        Write-Ok "Copied CA cert to $CER_RESOURCE"

        # Install root cert to LocalMachine\Root (for local dev testing)
        Write-Info "Installing root cert to Trusted Root CAs (local machine)..."
        & certutil -addstore -f "Root" $CER_PATH
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "Root cert installed (uiAccess will work on this machine)"
        } else {
            Write-Warn "certutil failed — uiAccess may not work until cert is trusted"
        }
    }
}

# ---- Sign EXE ----
if (-not (Test-Path -LiteralPath $RELEASE_EXE)) {
    Write-Fail "Release EXE not found: $RELEASE_EXE"
    Write-Host "  Run build_portable.ps1 first, then sign." -ForegroundColor Gray
    exit 1
}

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $CERT_SUBJECT } | Select-Object -First 1
if (-not $cert) {
    Write-Fail "No signing certificate found in store."
    exit 1
}

Write-Info "Signing $RELEASE_EXE..."
& $signtool sign /fd SHA256 /sha1 $cert.Thumbprint /t http://timestamp.digicert.com $RELEASE_EXE
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Signing failed (exit code $LASTEXITCODE)"
    exit 1
}
Write-Ok "Signed successfully"

# Verify
Write-Info "Verifying signature..."
& $signtool verify /pa $RELEASE_EXE 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Signature verified"
} else {
    Write-Warn "Signature verification failed (cert may not be in Trusted Root yet)"
    Write-Info "Run .\sign.ps1 -InstallCert to trust the certificate"
}

Write-Host ""
Write-Host "  Done. The signed EXE supports uiAccess (input to admin windows)." -ForegroundColor Green
Write-Host ""
