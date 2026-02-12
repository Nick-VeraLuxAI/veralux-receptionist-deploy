#!/usr/bin/env bash
# =============================================================================
# VeraLux Receptionist — SSL Certificate Initialization
# =============================================================================
# Two modes:
#   1) Self-signed (dev/on-prem): generates a self-signed cert for local use
#   2) Let's Encrypt (production SaaS): uses certbot for auto-cert
#
# Usage:
#   ./scripts/init-ssl.sh self-signed              # Generate self-signed cert
#   ./scripts/init-ssl.sh letsencrypt example.com   # Get Let's Encrypt cert
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$PROJECT_ROOT/nginx/certs"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()    { echo -e "${BLUE}[SSL]${NC} $*"; }
success() { echo -e "${GREEN}[SSL]${NC} $*"; }
warn()    { echo -e "${YELLOW}[SSL]${NC} $*"; }
error()   { echo -e "${RED}[SSL]${NC} $*" >&2; }

MODE="${1:-self-signed}"
DOMAIN="${2:-localhost}"

mkdir -p "$CERT_DIR"

case "$MODE" in
  self-signed)
    info "Generating self-signed certificate for: $DOMAIN"

    openssl req -x509 -nodes -days 365 \
      -newkey rsa:2048 \
      -keyout "$CERT_DIR/privkey.pem" \
      -out "$CERT_DIR/fullchain.pem" \
      -subj "/CN=$DOMAIN/O=VeraLux AI/C=US" \
      -addext "subjectAltName=DNS:$DOMAIN,DNS:*.${DOMAIN},IP:127.0.0.1"

    success "Self-signed certificate created:"
    echo "  Certificate: $CERT_DIR/fullchain.pem"
    echo "  Private Key: $CERT_DIR/privkey.pem"
    warn "Note: Browsers will show a security warning for self-signed certs."
    ;;

  letsencrypt)
    if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "localhost" ]; then
      error "Usage: $0 letsencrypt <domain>"
      error "Example: $0 letsencrypt api.veraluxclients.com"
      exit 1
    fi

    info "Requesting Let's Encrypt certificate for: $DOMAIN"

    # Check if certbot is available in Docker
    if ! docker compose -p veralux exec nginx which certbot &>/dev/null; then
      error "Certbot not found in nginx container. Make sure the nginx service is running."
      exit 1
    fi

    # Create webroot directory
    docker compose -p veralux exec nginx mkdir -p /var/www/certbot

    # Request certificate
    docker compose -p veralux exec nginx certbot certonly \
      --webroot \
      --webroot-path=/var/www/certbot \
      --email "admin@veralux.ai" \
      --agree-tos \
      --no-eff-email \
      -d "$DOMAIN"

    # Update nginx config to use Let's Encrypt certs
    info "Updating nginx configuration..."
    CONF_FILE="$PROJECT_ROOT/nginx/conf.d/default.conf"

    # Comment out self-signed and uncomment Let's Encrypt
    sed -i "s|ssl_certificate /etc/nginx/certs/fullchain.pem;|# ssl_certificate /etc/nginx/certs/fullchain.pem;|" "$CONF_FILE"
    sed -i "s|ssl_certificate_key /etc/nginx/certs/privkey.pem;|# ssl_certificate_key /etc/nginx/certs/privkey.pem;|" "$CONF_FILE"
    sed -i "s|#   ssl_certificate /etc/letsencrypt/live/\${VERALUX_DOMAIN}/fullchain.pem;|    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;|" "$CONF_FILE"
    sed -i "s|#   ssl_certificate_key /etc/letsencrypt/live/\${VERALUX_DOMAIN}/privkey.pem;|    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;|" "$CONF_FILE"

    # Reload nginx
    docker compose -p veralux exec nginx nginx -s reload

    success "Let's Encrypt certificate installed for: $DOMAIN"

    # Set up auto-renewal cron
    CRON_LINE="0 3 * * * docker compose -p veralux exec -T nginx certbot renew --quiet && docker compose -p veralux exec -T nginx nginx -s reload"
    if ! crontab -l 2>/dev/null | grep -q "certbot renew"; then
      (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
      info "Auto-renewal cron job added (daily at 3am)"
    fi
    ;;

  *)
    error "Unknown mode: $MODE"
    echo "Usage: $0 [self-signed|letsencrypt] [domain]"
    exit 1
    ;;
esac

success "Done."
