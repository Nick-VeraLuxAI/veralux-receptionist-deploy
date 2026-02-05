#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Interactive Installer
# =============================================================================
# One script to rule them all. Run this and answer the prompts.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# -----------------------------------------------------------------------------
# Colors
# -----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

print_banner() {
    echo ""
    echo -e "${BLUE}${BOLD}"
    echo "  ╔═══════════════════════════════════════════════════════════╗"
    echo "  ║                                                           ║"
    echo "  ║            VERALUX RECEPTIONIST INSTALLER                 ║"
    echo "  ║                                                           ║"
    echo "  ╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
}

info()    { echo -e "${BLUE}▶${NC} $*"; }
success() { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}!${NC} $*"; }
error()   { echo -e "${RED}✗${NC} $*" >&2; }

prompt() {
    local var_name="$1"
    local prompt_text="$2"
    local default_value="${3:-}"
    local is_secret="${4:-false}"
    
    if [[ -n "$default_value" ]]; then
        echo -e -n "${BOLD}$prompt_text${NC} [${default_value}]: "
    else
        echo -e -n "${BOLD}$prompt_text${NC}: "
    fi
    
    if [[ "$is_secret" == "true" ]]; then
        read -s value
        echo ""
    else
        read value
    fi
    
    if [[ -z "$value" && -n "$default_value" ]]; then
        value="$default_value"
    fi
    
    eval "$var_name=\"$value\""
}

generate_secret() {
    openssl rand -base64 32 2>/dev/null || cat /dev/urandom | head -c 32 | base64
}

# -----------------------------------------------------------------------------
# Checks
# -----------------------------------------------------------------------------
check_docker() {
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed."
        echo ""
        echo "  Please install Docker first:"
        echo "    https://docs.docker.com/get-docker/"
        echo ""
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        error "Docker is not running."
        echo ""
        echo "  Please start Docker and run this installer again."
        echo ""
        exit 1
    fi
    
    success "Docker is running"
}

check_compose() {
    if docker compose version &> /dev/null; then
        success "Docker Compose is available"
    elif command -v docker-compose &> /dev/null; then
        success "Docker Compose is available (legacy)"
    else
        error "Docker Compose is not installed."
        echo ""
        echo "  Please install Docker Compose:"
        echo "    https://docs.docker.com/compose/install/"
        echo ""
        exit 1
    fi
}

# -----------------------------------------------------------------------------
# Main Installation
# -----------------------------------------------------------------------------
main() {
    print_banner
    
    # Check prerequisites
    info "Checking prerequisites..."
    echo ""
    check_docker
    check_compose
    echo ""
    
    # Check for offline images
    if [[ -f "images.tar.zst" ]]; then
        info "Offline bundle detected. Loading Docker images..."
        echo ""
        ./load-images.sh
        echo ""
    fi
    
    # Check if already configured
    if [[ -f ".env" ]]; then
        echo ""
        warn "Existing configuration found (.env file)"
        echo ""
        prompt RECONFIGURE "Do you want to reconfigure? (yes/no)" "no"
        if [[ "$RECONFIGURE" != "yes" ]]; then
            info "Keeping existing configuration."
            echo ""
            info "Starting services..."
            ./deploy.sh up
            exit 0
        fi
        echo ""
    fi
    
    # Start configuration
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}                      CONFIGURATION                            ${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    # Telnyx Configuration
    echo -e "${YELLOW}TELNYX SETTINGS${NC} (get these from portal.telnyx.com)"
    echo ""
    prompt TELNYX_API_KEY "  Telnyx API Key" "" 
    prompt TELNYX_PUBLIC_KEY "  Telnyx Public Key" ""
    echo ""
    
    # Domain Configuration
    echo -e "${YELLOW}DOMAIN SETTINGS${NC}"
    echo ""
    prompt DOMAIN "  Your domain (e.g., receptionist.yourcompany.com)" ""
    
    # Build URLs from domain
    if [[ "$DOMAIN" == http* ]]; then
        PUBLIC_BASE_URL="$DOMAIN"
    else
        PUBLIC_BASE_URL="https://$DOMAIN"
    fi
    AUDIO_PUBLIC_BASE_URL="${PUBLIC_BASE_URL}/audio"
    echo ""
    
    # Generate secrets automatically
    echo -e "${YELLOW}GENERATING SECURE SECRETS...${NC}"
    echo ""
    POSTGRES_PASSWORD=$(generate_secret)
    JWT_SECRET=$(generate_secret)
    MEDIA_STREAM_TOKEN=$(generate_secret)
    success "Generated database password"
    success "Generated JWT secret"
    success "Generated media stream token"
    echo ""
    
    # Write .env file
    info "Saving configuration..."
    cat > .env << ENVFILE
# =============================================================================
# Veralux Receptionist - Configuration
# Generated by installer on $(date)
# =============================================================================

# Version & Registry
VERSION=latest
REGISTRY=ghcr.io/nick-veraluxai

# Database
POSTGRES_USER=veralux
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=veralux

# Security
JWT_SECRET=${JWT_SECRET}

# URLs
BASE_URL=${PUBLIC_BASE_URL}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
AUDIO_PUBLIC_BASE_URL=${AUDIO_PUBLIC_BASE_URL}

# Ports
CONTROL_PORT=4000
RUNTIME_PORT=4001

# Telnyx
TELNYX_API_KEY=${TELNYX_API_KEY}
TELNYX_PUBLIC_KEY=${TELNYX_PUBLIC_KEY}

# Media
MEDIA_STREAM_TOKEN=${MEDIA_STREAM_TOKEN}
AUDIO_STORAGE_DIR=/app/audio

# Logging
LOG_LEVEL=info

# Speech-to-Text
STT_CHUNK_MS=100
STT_SILENCE_MS=700
DEAD_AIR_MS=10000

# Rate Limiting
GLOBAL_CONCURRENCY_CAP=100
TENANT_CONCURRENCY_CAP_DEFAULT=10
TENANT_CALLS_PER_MIN_CAP_DEFAULT=60
CAPACITY_TTL_SECONDS=3600

# GPU Services (optional)
WHISPER_PORT=9000
WHISPER_MODEL_SIZE=base
KOKORO_PORT=7001
KOKORO_VOICE_ID=default
XTTS_PORT=7002
XTTS_LANGUAGE=en
ENVFILE

    success "Configuration saved!"
    echo ""
    
    # Start services
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}                    STARTING SERVICES                          ${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    ./deploy.sh up
    
    # Final message
    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}${BOLD}                    INSTALLATION COMPLETE!                      ${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  Your Veralux Receptionist is now running!"
    echo ""
    echo "  Control Panel:  ${PUBLIC_BASE_URL}"
    echo ""
    echo "  Useful commands:"
    echo "    ./deploy.sh status    - Check service status"
    echo "    ./deploy.sh logs      - View logs"
    echo "    ./deploy.sh restart   - Restart services"
    echo "    ./deploy.sh down      - Stop services"
    echo ""
    echo "  Configuration saved to: .env"
    echo ""
}

main "$@"
