#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-certs.sh
# Generates a self-signed TLS certificate for local HTTPS development.
# Usage (from project root): bash backend/scripts/generate-certs.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

CERT_DIR="$(dirname "$0")/../certs"
mkdir -p "$CERT_DIR"

echo "🔐 Generating self-signed SSL certificate (2048-bit RSA, 365 days)…"

openssl req -x509 \
  -newkey rsa:2048 \
  -keyout "${CERT_DIR}/server.key" \
  -out    "${CERT_DIR}/server.crt" \
  -days   365 \
  -nodes \
  -subj   "/C=ES/ST=Madrid/L=Madrid/O=CMDB Enterprise/OU=DevSecOps/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 600 "${CERT_DIR}/server.key"
chmod 644 "${CERT_DIR}/server.crt"

echo ""
echo "✅ Certificates generated in backend/certs/"
echo "   server.key — private key (keep secret, never commit)"
echo "   server.crt — self-signed certificate (valid 365 days)"
echo ""
echo "Next step: set HTTPS_ENABLED=true in backend/.env and restart the server."
