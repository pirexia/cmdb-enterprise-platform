#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# generate-certs.sh
# Generates a self-signed TLS certificate for local HTTPS development.
# Certificates land in <project-root>/certs/ and are mounted read-only by
# the nginx container (TLS termination).
#
# Usage (from project root): bash backend/scripts/generate-certs.sh
# ─────────────────────────────────────────────────────────────────────────────
set -e

# Project root is two levels up from backend/scripts/
CERT_DIR="$(cd "$(dirname "$0")/../.." && pwd)/certs"
mkdir -p "$CERT_DIR"

echo "Generating self-signed SSL certificate (RSA 4096-bit, 10 years)..."

openssl req -x509 \
  -newkey rsa:4096 \
  -keyout "${CERT_DIR}/server.key" \
  -out    "${CERT_DIR}/server.crt" \
  -days   3650 \
  -nodes \
  -subj   "/C=ES/ST=Madrid/L=Madrid/O=CMDB Enterprise/OU=DevSecOps/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 600 "${CERT_DIR}/server.key"
chmod 644 "${CERT_DIR}/server.crt"

echo ""
echo "Certificates generated in: ${CERT_DIR}/"
echo "   server.key — private key (RSA 4096-bit, keep secret, never commit)"
echo "   server.crt — self-signed certificate (valid 10 years)"
echo ""
echo "Next step: restart nginx to pick up the new certificate:"
echo "  docker compose restart nginx"
