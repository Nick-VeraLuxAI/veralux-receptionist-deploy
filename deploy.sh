#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Deployment Script
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
COMPOSE_FILE="docker-compose.yml"
ENV_FILE=".env"
ENV_EXAMPLE=".env.example"
PROJECT_NAME="veralux"

# -----------------------------------------------------------------------------
# Colors & Output Helpers
# -----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# -----------------------------------------------------------------------------
# Dependency Checks
# -----------------------------------------------------------------------------
check_docker() {
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed or not in PATH."
        echo "  Install Docker: https://docs.docker.com/get-docker/"
        exit 1
    fi
    
    if ! docker info &> /dev/null; then
        error "Docker daemon is not running or you don't have permission."
        echo "  Try: sudo systemctl start docker"
        echo "  Or ensure your user is in the docker group."
        exit 1
    fi
    
    success "Docker is available."
}

check_compose() {
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
    elif command -v docker-compose &> /dev/null; then
        COMPOSE_CMD="docker-compose"
        warn "Using legacy docker-compose. Consider upgrading to Docker Compose V2."
    else
        error "Docker Compose is not installed."
        echo "  Install: https://docs.docker.com/compose/install/"
        exit 1
    fi
    
    success "Docker Compose is available."
}

check_env() {
    if [[ ! -f "$ENV_FILE" ]]; then
        warn ".env file not found."
        if [[ -f "$ENV_EXAMPLE" ]]; then
            info "Creating .env from .env.example..."
            cp "$ENV_EXAMPLE" "$ENV_FILE"
            echo ""
            warn "Please edit .env with your configuration, then run this script again."
            echo "  Required changes:"
            echo "    - POSTGRES_PASSWORD: Set a strong password"
            echo "    - JWT_SECRET: Generate with 'openssl rand -base64 32'"
            echo "    - REGISTRY: Set to your container registry"
            echo ""
            exit 0
        else
            error ".env.example not found. Cannot create .env file."
            exit 1
        fi
    fi
    
    success ".env file found."
}

# Helper: detect audio profile based on TTS_MODE and hardware
detect_audio_profile() {
    local tts_mode
    tts_mode=$(grep "^TTS_MODE=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2)
    if [[ "$tts_mode" == "coqui_xtts" || "$tts_mode" == "kokoro_http" ]]; then
        if docker info 2>/dev/null | grep -qi nvidia || command -v nvidia-smi &>/dev/null; then
            echo "--profile gpu"
            return
        else
            echo "--profile cpu"
            return
        fi
    fi
    echo ""
}

# -----------------------------------------------------------------------------
# Commands
# -----------------------------------------------------------------------------
cmd_up() {
    info "Starting Veralux Receptionist..."
    
    local audio_profile
    audio_profile=$(detect_audio_profile)
    if [[ "$audio_profile" == *gpu* ]]; then
        info "NVIDIA GPU detected — running audio services with GPU acceleration"
    elif [[ -n "$audio_profile" ]]; then
        info "No NVIDIA GPU detected — running audio services in CPU mode (slower but functional)"
    fi
    
    # Remove any leftover containers to avoid name conflicts
    docker rm -f veralux-control veralux-runtime veralux-redis veralux-postgres \
        veralux-cloudflared veralux-whisper veralux-kokoro veralux-xtts veralux-ngrok 2>/dev/null || true
    
    # Best-effort pull (don't fail if offline)
    info "Pulling latest images (if available)..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" $audio_profile pull --ignore-pull-failures 2>/dev/null || true
    
    # Start services
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" $audio_profile up -d "$@"
    
    echo ""
    success "Services started!"
    echo ""
    info "Useful commands:"
    echo "  View status:  ./deploy.sh status"
    echo "  View logs:    ./deploy.sh logs"
    echo "  Stop:         ./deploy.sh down"
}

cmd_down() {
    info "Stopping Veralux Receptionist..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" down "$@"
    success "Services stopped."
}

cmd_restart() {
    info "Restarting Veralux Receptionist..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" restart "$@"
    success "Services restarted."
}

cmd_status() {
    info "Service Status:"
    echo ""
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" ps
}

cmd_logs() {
    if [[ $# -gt 0 ]]; then
        $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" logs -f "$@"
    else
        $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" logs -f
    fi
}

cmd_build() {
    info "Building Veralux Receptionist from source..."
    
    local audio_profile
    audio_profile=$(detect_audio_profile)

    # Tag images with git SHA for reproducible builds and easy rollback
    local git_sha
    git_sha=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
    local version_tag="${VERSION:-$git_sha}"

    info "Tagging images with VERSION=$version_tag (git: $git_sha)"
    export VERSION="$version_tag"

    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" $audio_profile build "$@"
    
    # Also tag as :latest for convenience
    if [[ "$version_tag" != "latest" ]]; then
        info "Also tagging as :latest..."
        local registry="${REGISTRY:-ghcr.io/nick-veraluxai}"
        for img in veralux-control-plane veralux-voice-runtime veralux-brain; do
            docker tag "$registry/$img:$version_tag" "$registry/$img:latest" 2>/dev/null || true
        done
    fi

    success "Build complete! Images tagged: $version_tag"
}

cmd_update() {
    info "Updating Veralux Receptionist (rolling restart)..."
    
    local audio_profile
    audio_profile=$(detect_audio_profile)
    
    # 1. Pull latest images
    info "Pulling latest images..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" $audio_profile pull
    
    # 2. Backup database before updating
    if [[ -x "scripts/backup.sh" ]]; then
        info "Creating pre-update database backup..."
        bash scripts/backup.sh || warn "Backup failed — continuing with update."
    fi
    
    # 3. Rolling restart: infrastructure first, then services one at a time
    # Infrastructure (Redis/Postgres) — these hold state, restart only if image changed
    info "Updating infrastructure services..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up -d --no-deps redis postgres
    
    # Wait for infrastructure to be healthy
    info "Waiting for infrastructure health checks..."
    local retries=30
    while [[ $retries -gt 0 ]]; do
        local pg_healthy redis_healthy
        pg_healthy=$(docker inspect --format='{{.State.Health.Status}}' veralux-postgres 2>/dev/null || echo "unknown")
        redis_healthy=$(docker inspect --format='{{.State.Health.Status}}' veralux-redis 2>/dev/null || echo "unknown")
        if [[ "$pg_healthy" == "healthy" && "$redis_healthy" == "healthy" ]]; then
            break
        fi
        sleep 2
        retries=$((retries - 1))
    done
    
    if [[ $retries -eq 0 ]]; then
        warn "Infrastructure health check timed out — proceeding anyway."
    else
        success "Infrastructure healthy."
    fi
    
    # 4. Update control plane (runtime depends on it)
    info "Updating control plane..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up -d --no-deps control
    
    # Wait for control plane to be healthy before updating runtime
    info "Waiting for control plane health check..."
    retries=30
    while [[ $retries -gt 0 ]]; do
        local ctrl_healthy
        ctrl_healthy=$(docker inspect --format='{{.State.Health.Status}}' veralux-control 2>/dev/null || echo "unknown")
        if [[ "$ctrl_healthy" == "healthy" ]]; then
            break
        fi
        sleep 3
        retries=$((retries - 1))
    done
    
    if [[ $retries -eq 0 ]]; then
        warn "Control plane health check timed out — proceeding anyway."
    else
        success "Control plane healthy."
    fi
    
    # 5. Update voice runtime
    info "Updating voice runtime..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up -d --no-deps runtime
    
    # 6. Update audio services (if active)
    local audio_services
    audio_services=$(docker ps --filter "name=veralux-whisper" --filter "name=veralux-kokoro" --filter "name=veralux-xtts" --format '{{.Names}}' 2>/dev/null || echo "")
    if [[ -n "$audio_services" ]]; then
        info "Updating audio services..."
        for svc in $audio_services; do
            local short_name="${svc#veralux-}"
            info "  Updating $short_name..."
            # Determine which compose service name to use (gpu or cpu variant)
            local compose_svc
            if docker inspect "$svc" --format='{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q "CUDA_VISIBLE_DEVICES="; then
                compose_svc="${short_name}-cpu"
            else
                compose_svc="${short_name}-gpu"
            fi
            $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up -d --no-deps "$compose_svc" 2>/dev/null || \
                warn "  Could not update $short_name (may need profile flag)."
        done
    fi
    
    # 7. Update tunnel if active
    if docker ps --filter "name=veralux-cloudflared" --format '{{.Names}}' 2>/dev/null | grep -q cloudflared; then
        info "Updating Cloudflare Tunnel..."
        $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up -d --no-deps cloudflared
    fi
    
    echo ""
    success "Rolling update complete!"
    echo ""
    cmd_status
}

cmd_backup() {
    if [[ ! -x "scripts/backup.sh" ]]; then
        error "Backup script not found at scripts/backup.sh"
        exit 1
    fi
    bash scripts/backup.sh "$@"
}

cmd_retention() {
    local days="${1:-90}"
    if [[ ! -x "scripts/db-retention.sh" ]]; then
        error "Retention script not found at scripts/db-retention.sh"
        exit 1
    fi
    bash scripts/db-retention.sh "$days"
}

cmd_tunnel() {
    local tunnel_type="${1:-cloudflare}"
    
    local audio_profile
    audio_profile=$(detect_audio_profile)
    if [[ "$audio_profile" == *gpu* ]]; then
        info "NVIDIA GPU detected — running audio services with GPU acceleration"
    elif [[ -n "$audio_profile" ]]; then
        info "No NVIDIA GPU detected — running audio services in CPU mode (slower but functional)"
    fi
    
    case "$tunnel_type" in
        cloudflare|cf)
            if [[ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]] && ! grep -q "CLOUDFLARE_TUNNEL_TOKEN=." "$ENV_FILE" 2>/dev/null; then
                error "CLOUDFLARE_TUNNEL_TOKEN not set in .env"
                echo ""
                echo "  To get a token:"
                echo "    1. Go to Cloudflare Zero Trust dashboard"
                echo "    2. Networks → Tunnels → Create tunnel"
                echo "    3. Copy the token and add to .env:"
                echo "       CLOUDFLARE_TUNNEL_TOKEN=your_token_here"
                exit 1
            fi
            info "Starting with Cloudflare Tunnel..."
            # Remove any leftover containers to avoid name conflicts
            docker rm -f veralux-control veralux-runtime veralux-redis veralux-postgres \
                veralux-cloudflared veralux-whisper veralux-kokoro veralux-xtts veralux-ngrok 2>/dev/null || true
            $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" $audio_profile --profile cloudflare up -d
            success "Cloudflare Tunnel started!"
            echo ""
            info "Your public URL is configured in the Cloudflare dashboard."
            ;;
        ngrok)
            if [[ -z "${NGROK_AUTHTOKEN:-}" ]] && ! grep -q "NGROK_AUTHTOKEN=." "$ENV_FILE" 2>/dev/null; then
                error "NGROK_AUTHTOKEN not set in .env"
                echo "  Get your token at: https://dashboard.ngrok.com"
                exit 1
            fi
            info "Starting with ngrok tunnel..."
            $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" $audio_profile --profile ngrok up -d
            success "ngrok started!"
            echo ""
            info "View your public URL at: http://localhost:4040"
            ;;
        *)
            error "Unknown tunnel type: $tunnel_type"
            echo "  Use: cloudflare (or cf) | ngrok"
            exit 1
            ;;
    esac
}

cmd_version() {
    local git_sha
    git_sha=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    local git_branch
    git_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    local env_version="${VERSION:-latest}"
    echo "Veralux Receptionist"
    echo "  Git:     $git_sha ($git_branch)"
    echo "  VERSION: $env_version"
    echo ""
    echo "Running images:"
    docker ps --filter "name=veralux-" --format '  {{.Names}}: {{.Image}}' 2>/dev/null || echo "  (no containers running)"
}

cmd_help() {
    echo "Veralux Receptionist - Deployment Script"
    echo ""
    echo "Usage: ./deploy.sh <command> [options]"
    echo ""
    echo "Commands:"
    echo "  up [services...]     Start services (pulls images first)"
    echo "  down                 Stop and remove containers"
    echo "  restart [services...] Restart services"
    echo "  status               Show service status"
    echo "  logs [service]       Follow service logs"
    echo "  build [services...]  Build images from local source (tagged with git SHA)"
    echo "  update               Rolling update (pull + restart one at a time)"
    echo "  backup [dir] [opts]  Backup the database"
    echo "  retention [days]     Clean up records older than N days (default: 90)"
    echo "  tunnel [type]        Start with tunnel (cloudflare or ngrok)"
    echo "  version              Show version info and running images"
    echo "  help                 Show this help message"
    echo ""
    echo "Tunnel Options:"
    echo "  ./deploy.sh tunnel cloudflare   # Start with Cloudflare Tunnel (recommended)"
    echo "  ./deploy.sh tunnel ngrok        # Start with ngrok (for testing)"
    echo ""
    echo "Build & Update:"
    echo "  ./deploy.sh build                 # Build all images from source"
    echo "  ./deploy.sh build control         # Build just the control plane"
    echo "  ./deploy.sh update                # Rolling update (zero-downtime)"
    echo ""
    echo "Backup & Maintenance:"
    echo "  ./deploy.sh backup                # Backup to ./backups/"
    echo "  ./deploy.sh backup --s3 s3://b    # Backup + upload to S3"
    echo "  ./deploy.sh retention             # Clean up records older than 90 days"
    echo "  ./deploy.sh retention 30          # Clean up records older than 30 days"
    echo ""
    echo "Monitoring:"
    echo "  docker compose --profile monitoring up -d   # Start Prometheus + Grafana"
    echo "  Open http://localhost:3000 for Grafana (admin/veralux)"
    echo ""
    echo "Examples:"
    echo "  ./deploy.sh up                    # Start all core services"
    echo "  ./deploy.sh build && ./deploy.sh up  # Build from source, then start"
    echo "  ./deploy.sh tunnel cloudflare     # Start with Cloudflare Tunnel"
    echo "  ./deploy.sh logs control          # Follow control service logs"
    echo "  ./deploy.sh restart runtime       # Restart only the runtime service"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    # Always check dependencies first
    check_docker
    check_compose
    check_env
    
    echo ""
    
    case "${1:-help}" in
        up)
            shift
            cmd_up "$@"
            ;;
        down)
            shift
            cmd_down "$@"
            ;;
        restart)
            shift
            cmd_restart "$@"
            ;;
        status)
            cmd_status
            ;;
        logs)
            shift
            cmd_logs "$@"
            ;;
        build)
            shift
            cmd_build "$@"
            ;;
        update)
            cmd_update
            ;;
        backup)
            shift
            cmd_backup "$@"
            ;;
        retention)
            shift
            cmd_retention "$@"
            ;;
        tunnel)
            shift
            cmd_tunnel "$@"
            ;;
        version|--version|-v)
            cmd_version
            ;;
        help|--help|-h)
            cmd_help
            ;;
        *)
            error "Unknown command: $1"
            echo ""
            cmd_help
            exit 1
            ;;
    esac
}

main "$@"
