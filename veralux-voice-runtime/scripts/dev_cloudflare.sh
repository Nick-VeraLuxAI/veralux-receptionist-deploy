#!/usr/bin/env bash
set -euo pipefail

# Cloudflare Tunnel helper for local development
# Usage:
#   ./scripts/dev_cloudflare.sh          # Start tunnel and print URLs
#   ./scripts/dev_cloudflare.sh --urls   # Just print URLs if tunnel already running

PORT="${PORT:-3000}"
TUNNEL_URL_FILE="${TUNNEL_URL_FILE:-/tmp/cloudflare_tunnel_url.txt}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is required. Install with:" >&2
  echo "  brew install cloudflared       # macOS" >&2
  echo "  sudo apt install cloudflared   # Debian/Ubuntu" >&2
  exit 1
fi

print_urls() {
  local base="$1"
  base="${base%/}"
  
  echo ""
  echo "=== Cloudflare Tunnel URLs ==="
  echo ""
  printf 'PUBLIC_BASE_URL=%s\n' "$base"
  printf 'AUDIO_PUBLIC_BASE_URL=%s/audio\n' "$base"
  echo ""
  printf 'WEBHOOK_URL=%s/v1/telnyx/webhook\n' "$base"
  printf 'MEDIA_WS_URL=%s/v1/telnyx/media/{callControlId}?token=MEDIA_STREAM_TOKEN\n' "$base" | sed 's|^https://|wss://|'
  echo ""
  echo "Add these to your Telnyx webhook configuration."
  echo ""
}

# If --urls flag, just read from file and print
if [[ "${1:-}" == "--urls" ]]; then
  if [[ -f "$TUNNEL_URL_FILE" ]]; then
    url="$(cat "$TUNNEL_URL_FILE")"
    print_urls "$url"
  else
    echo "No tunnel URL found. Start the tunnel first with: ./scripts/dev_cloudflare.sh" >&2
    exit 1
  fi
  exit 0
fi

echo "Starting Cloudflare Tunnel on port $PORT..."
echo "Press Ctrl+C to stop the tunnel."
echo ""

# Start cloudflared and capture the URL
# cloudflared outputs the URL to stderr in format: "... https://xxx.trycloudflare.com ..."
cloudflared tunnel --url "http://localhost:$PORT" 2>&1 | while read -r line; do
  echo "$line"
  
  # Look for the trycloudflare.com URL
  if [[ "$line" =~ (https://[a-zA-Z0-9-]+\.trycloudflare\.com) ]]; then
    url="${BASH_REMATCH[1]}"
    echo "$url" > "$TUNNEL_URL_FILE"
    print_urls "$url"
  fi
done
