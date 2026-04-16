# ─────────────────────────────────────────────────────────────────────────────
# generate-certs.ps1  (Windows PowerShell 5.1 / PowerShell Core 7+)
# Generates a self-signed TLS certificate for local HTTPS development.
# Certificates land in <project-root>\certs\ and are mounted read-only by
# the nginx container (TLS termination).
#
# Usage (from project root):
#   powershell -ExecutionPolicy Bypass -File backend\scripts\generate-certs.ps1
# Requires OpenSSL on PATH (ships with Git for Windows).
# ─────────────────────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"
# Project root is two levels up from backend\scripts\
$CertDir = Join-Path $PSScriptRoot "..\..\certs"
New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

$KeyFile  = Join-Path $CertDir "server.key"
$CertFile = Join-Path $CertDir "server.crt"

Write-Host "Generating self-signed SSL certificate (RSA 4096-bit, 10 years)..." -ForegroundColor Cyan

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
        -newkey rsa:4096 `
        -keyout $KeyFile `
        -out    $CertFile `
        -days   3650 `
        -nodes `
        -subj   "/C=ES/ST=Madrid/L=Madrid/O=CMDB Enterprise/OU=DevSecOps/CN=localhost" `
        -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

    Write-Host ""
    Write-Host "Certificates generated in: $CertDir\" -ForegroundColor Green
    Write-Host "   server.key — private key (RSA 4096-bit, keep secret, never commit)" -ForegroundColor Yellow
    Write-Host "   server.crt — self-signed certificate (valid 10 years)" -ForegroundColor Green
} else {
    # ── Fallback: .NET New-SelfSignedCertificate (PFX export) ───────────────
    Write-Host "   OpenSSL not found on PATH. Using .NET New-SelfSignedCertificate..." -ForegroundColor Yellow
    $cert = New-SelfSignedCertificate `
        -DnsName "localhost" `
        -CertStoreLocation "Cert:\CurrentUser\My" `
        -NotAfter (Get-Date).AddDays(3650) `
        -KeyAlgorithm RSA `
        -KeyLength 4096

    $PfxFile = Join-Path $CertDir "server.pfx"
    $PfxPw   = ConvertTo-SecureString -String "cmdb-dev" -Force -AsPlainText
    Export-PfxCertificate -Cert $cert -FilePath $PfxFile -Password $PfxPw | Out-Null

    Write-Host ""
    Write-Host "PFX certificate generated: $PfxFile" -ForegroundColor Green
    Write-Host "To convert to PEM (requires OpenSSL):" -ForegroundColor Yellow
    Write-Host "    openssl pkcs12 -in server.pfx -nocerts -nodes -passin pass:cmdb-dev -out server.key" -ForegroundColor White
    Write-Host "    openssl pkcs12 -in server.pfx -nokeys  -nodes -passin pass:cmdb-dev -out server.crt" -ForegroundColor White
}

Write-Host ""
Write-Host "Next step: restart nginx to pick up the new certificate:" -ForegroundColor Cyan
Write-Host "  docker compose restart nginx" -ForegroundColor White
