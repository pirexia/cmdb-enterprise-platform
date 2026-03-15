# ─────────────────────────────────────────────────────────────────────────────
# generate-certs.ps1  (Windows PowerShell 5.1 / PowerShell Core 7+)
# Generates a self-signed TLS certificate for local HTTPS development.
# Usage (from project root):
#   powershell -ExecutionPolicy Bypass -File backend\scripts\generate-certs.ps1
# Requires OpenSSL on PATH (ships with Git for Windows).
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
$CertDir = Join-Path $PSScriptRoot "..\certs"
New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

$KeyFile  = Join-Path $CertDir "server.key"
$CertFile = Join-Path $CertDir "server.crt"

Write-Host "🔐 Generating self-signed SSL certificate (2048-bit RSA, 365 days)..." -ForegroundColor Cyan

# ── Locate openssl ─────────────────────────────────────────────────────────
$OpenSSLExe = $null

# 1. Check PATH
$found = Get-Command openssl -ErrorAction SilentlyContinue
if ($found) { $OpenSSLExe = $found.Source }

# 2. Try Git for Windows bundled location
if (-not $OpenSSLExe) {
    $gitSSL = "C:\Program Files\Git\usr\bin\openssl.exe"
    if (Test-Path $gitSSL) { $OpenSSLExe = $gitSSL }
}

if ($OpenSSLExe) {
    & $OpenSSLExe req -x509 `
        -newkey rsa:2048 `
        -keyout $KeyFile `
        -out    $CertFile `
        -days   365 `
        -nodes `
        -subj   "/C=ES/ST=Madrid/L=Madrid/O=CMDB Enterprise/OU=DevSecOps/CN=localhost"

    Write-Host ""
    Write-Host "✅ Certificates generated in backend\certs\" -ForegroundColor Green
    Write-Host "   server.key — private key (keep secret, never commit)" -ForegroundColor Yellow
    Write-Host "   server.crt — self-signed certificate (valid 365 days)" -ForegroundColor Green
} else {
    # ── Fallback: .NET New-SelfSignedCertificate (PFX export) ───────────────
    Write-Host "   OpenSSL not found on PATH. Using .NET New-SelfSignedCertificate..." -ForegroundColor Yellow
    $cert = New-SelfSignedCertificate `
        -DnsName "localhost" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -NotAfter (Get-Date).AddDays(365) `
        -KeyAlgorithm RSA `
        -KeyLength 2048

    $PfxFile = Join-Path $CertDir "server.pfx"
    $PfxPw   = ConvertTo-SecureString -String "cmdb-dev" -Force -AsPlainText
    Export-PfxCertificate -Cert $cert -FilePath $PfxFile -Password $PfxPw | Out-Null

    Write-Host ""
    Write-Host "✅ PFX certificate generated: $PfxFile" -ForegroundColor Green
    Write-Host "⚠️  To convert to PEM (requires OpenSSL):" -ForegroundColor Yellow
    Write-Host "    openssl pkcs12 -in server.pfx -nocerts -nodes -passin pass:cmdb-dev -out server.key" -ForegroundColor White
    Write-Host "    openssl pkcs12 -in server.pfx -nokeys  -nodes -passin pass:cmdb-dev -out server.crt" -ForegroundColor White
}

Write-Host ""
Write-Host "Next step: set HTTPS_ENABLED=true in backend/.env and restart the server." -ForegroundColor Cyan
