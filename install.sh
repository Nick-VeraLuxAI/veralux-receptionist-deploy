#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Installer
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# API endpoint (TODO: update to your actual endpoint)
API_URL="https://api.veralux.ai/api/v1/installer/config"

# -----------------------------------------------------------------------------
# Gum Installation
# -----------------------------------------------------------------------------
GUM_VERSION="0.13.0"
GUM_BIN="$SCRIPT_DIR/.bin/gum"

install_gum() {
    local os arch url
    
    os="$(uname -s)"
    arch="$(uname -m)"
    
    # Gum uses these exact names in releases
    case "$arch" in
        x86_64) arch="x86_64" ;;
        aarch64) arch="arm64" ;;
        arm64) arch="arm64" ;;
        *) echo "Unsupported architecture: $arch"; exit 1 ;;
    esac
    
    case "$os" in
        Darwin) os="Darwin" ;;
        Linux) os="Linux" ;;
        *) echo "Unsupported OS: $os"; exit 1 ;;
    esac
    
    url="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}/gum_${GUM_VERSION}_${os}_${arch}.tar.gz"
    
    echo -e "${DIM}Downloading installer components...${NC}"
    echo -e "${DIM}URL: $url${NC}"
    mkdir -p "$SCRIPT_DIR/.bin"
    
    # Download to temp file first to check for errors
    local tmpfile=$(mktemp)
    if command -v curl &> /dev/null; then
        if ! curl -fsSL "$url" -o "$tmpfile"; then
            echo -e "${RED}Failed to download gum from $url${NC}"
            rm -f "$tmpfile"
            exit 1
        fi
    elif command -v wget &> /dev/null; then
        if ! wget -q "$url" -O "$tmpfile"; then
            echo -e "${RED}Failed to download gum from $url${NC}"
            rm -f "$tmpfile"
            exit 1
        fi
    else
        echo -e "${RED}Error: curl or wget required${NC}"
        exit 1
    fi
    
    # Extract
    if ! tar -xzf "$tmpfile" -C "$SCRIPT_DIR/.bin" gum 2>/dev/null; then
        echo -e "${RED}Failed to extract gum${NC}"
        rm -f "$tmpfile"
        exit 1
    fi
    
    rm -f "$tmpfile"
    
    chmod +x "$GUM_BIN"
}

ensure_gum() {
    if [[ -x "$GUM_BIN" ]]; then
        return 0
    fi
    
    if command -v gum &> /dev/null; then
        GUM_BIN="gum"
        return 0
    fi
    
    install_gum
}

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
generate_secret() {
    # Generate URL-safe secret (no +, /, = characters)
    openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p
}

install_docker() {
    echo -e "${BLUE}Installing Docker...${NC}"
    echo ""
    
    # Detect OS
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS=$ID
    elif [[ "$(uname)" == "Darwin" ]]; then
        OS="macos"
    else
        OS="unknown"
    fi
    
    case "$OS" in
        ubuntu|debian)
            echo "Detected: Ubuntu/Debian"
            echo ""
            # Install Docker using official script
            curl -fsSL https://get.docker.com | sudo sh
            # Add current user to docker group
            sudo usermod -aG docker "$USER"
            echo ""
            echo -e "${GREEN}✓ Docker installed${NC}"
            echo ""
            echo -e "${YELLOW}NOTE: You may need to log out and back in for group changes to take effect.${NC}"
            echo "      Or run: newgrp docker"
            echo ""
            ;;
        centos|rhel|fedora|rocky|almalinux)
            echo "Detected: RHEL-based system"
            echo ""
            curl -fsSL https://get.docker.com | sudo sh
            sudo systemctl start docker
            sudo systemctl enable docker
            sudo usermod -aG docker "$USER"
            echo ""
            echo -e "${GREEN}✓ Docker installed${NC}"
            ;;
        macos)
            echo -e "${RED}✗ Docker Desktop required for macOS${NC}"
            echo ""
            echo "  Please download and install Docker Desktop:"
            echo "  https://www.docker.com/products/docker-desktop/"
            exit 1
            ;;
        *)
            echo -e "${RED}✗ Unsupported OS: $OS${NC}"
            echo ""
            echo "  Please install Docker manually:"
            echo "  https://docs.docker.com/get-docker/"
            exit 1
            ;;
    esac
}

install_nvidia_docker() {
    echo -e "${BLUE}Installing NVIDIA Container Toolkit...${NC}"
    echo ""
    
    # Detect package manager
    if command -v apt-get &> /dev/null; then
        # Debian/Ubuntu
        echo "Detected: Debian/Ubuntu (apt)"
        
        # Remove any broken repo files first
        sudo rm -f /etc/apt/sources.list.d/nvidia-container-toolkit.list 2>/dev/null
        
        # Add GPG key (--yes to overwrite if exists)
        curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
            sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg --yes
        
        # Add repo using the official list file (this is the correct method)
        curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
            sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
            sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list > /dev/null
        
        sudo apt-get update
        sudo apt-get install -y nvidia-container-toolkit
        
    elif command -v dnf &> /dev/null; then
        # Fedora/RHEL 8+
        echo "Detected: Fedora/RHEL (dnf)"
        curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | \
            sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo > /dev/null
        sudo dnf install -y nvidia-container-toolkit
        
    elif command -v yum &> /dev/null; then
        # RHEL 7/CentOS
        echo "Detected: CentOS/RHEL (yum)"
        curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | \
            sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo > /dev/null
        sudo yum install -y nvidia-container-toolkit
    else
        echo -e "${RED}✗ Unsupported package manager${NC}"
        echo "  Please install nvidia-container-toolkit manually:"
        echo "  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
        return 1
    fi
    
    # Configure Docker to use NVIDIA runtime
    echo "Configuring Docker for NVIDIA..."
    sudo nvidia-ctk runtime configure --runtime=docker
    sudo systemctl restart docker
    
    echo ""
    echo -e "${GREEN}✓ NVIDIA Container Toolkit installed${NC}"
}

check_docker() {
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}✗ Docker is not installed${NC}"
        echo ""
        
        # Ask if we should install it
        read -p "Would you like to install Docker now? [y/N] " -n 1 -r
        echo ""
        
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            install_docker
            
            # Check if we need to use newgrp or re-run
            if ! docker info &> /dev/null 2>&1; then
                echo ""
                echo -e "${YELLOW}Docker installed but requires group reload.${NC}"
                echo ""
                echo "Please run one of the following, then re-run this installer:"
                echo "  Option 1: newgrp docker && ./install.sh"
                echo "  Option 2: Log out and log back in, then run ./install.sh"
                exit 0
            fi
        else
            echo ""
            echo "  Please install Docker first:"
            echo "  https://docs.docker.com/get-docker/"
            exit 1
        fi
    fi
    
    if ! docker info &> /dev/null; then
        echo -e "${YELLOW}⚠${NC} Docker permission issue detected"
        echo ""
        
        # Try to start Docker service first
        if command -v systemctl &> /dev/null; then
            echo "Attempting to start Docker service..."
            sudo systemctl start docker 2>/dev/null && sleep 2
        fi
        
        # Still no access? Likely a group issue
        if ! docker info &> /dev/null; then
            # Check if user is in docker group but group not loaded
            if groups 2>/dev/null | grep -q docker || id -nG 2>/dev/null | grep -q docker; then
                echo "You're in the docker group but it's not active in this shell."
                echo ""
                echo -e "${BLUE}Restarting installer with docker group...${NC}"
                echo ""
                exec sg docker -c "bash $0 $*"
            fi
            
            # User not in docker group - add them
            echo "Adding you to the docker group..."
            sudo usermod -aG docker "$USER"
            
            echo ""
            echo -e "${BLUE}Restarting installer with docker group...${NC}"
            echo ""
            exec sg docker -c "bash $0 $*"
        fi
    fi
    
    echo -e "${GREEN}✓${NC} Docker is running"
    
    # Check for NVIDIA GPU and toolkit (optional)
    if command -v nvidia-smi &> /dev/null; then
        # GPU exists, check if container toolkit is configured
        if docker info 2>/dev/null | grep -q "nvidia"; then
            echo -e "${GREEN}✓${NC} NVIDIA GPU support available"
        else
            echo -e "${YELLOW}⚠${NC} NVIDIA GPU detected but container toolkit not configured"
            echo ""
            read -p "Would you like to install NVIDIA Container Toolkit? [y/N] " -n 1 -r
            echo ""
            
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                install_nvidia_docker
                
                # Verify it worked
                if docker info 2>/dev/null | grep -q "nvidia"; then
                    echo -e "${GREEN}✓${NC} NVIDIA GPU support now available"
                else
                    echo -e "${YELLOW}⚠${NC} NVIDIA toolkit installed but may require logout/login"
                    echo "  You can continue, but GPU services may not work until you restart."
                fi
            fi
        fi
    fi
}

# -----------------------------------------------------------------------------
# API Functions
# -----------------------------------------------------------------------------
fetch_config() {
    local email="$1"
    local password="$2"
    local response
    
    response=$(curl -s -X POST "$API_URL" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"$email\", \"password\": \"$password\"}" \
        2>/dev/null) || {
        echo '{"success": false, "error": "Could not connect to server"}'
        return
    }
    
    echo "$response"
}

# -----------------------------------------------------------------------------
# Config Generation
# -----------------------------------------------------------------------------
write_env_file() {
    local api_key="${1:-}"
    local telnyx_number="${2:-}"
    local telnyx_api_key="${3:-}"
    local telnyx_public_key="${4:-}"
    local openai_api_key="${5:-}"
    local jwt_secret="${6:-}"
    local cloudflare_token="${7:-}"
    local llm_provider="${8:-openai}"
    local openai_model="${9:-qwen2.5:7b}"
    local local_llm_url="${10:-}"
    
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
POSTGRES_PASSWORD=$(generate_secret)
POSTGRES_DB=veralux

# Security
JWT_SECRET=${jwt_secret}
API_KEY=${api_key}
ADMIN_API_KEY=$(generate_secret)

# Telnyx
TELNYX_API_KEY=${telnyx_api_key}
TELNYX_PUBLIC_KEY=${telnyx_public_key}
TELNYX_PHONE_NUMBER=${telnyx_number}
TELNYX_VERIFY_SIGNATURES=true
TELNYX_ACCEPT_CODECS=PCMU,AMR-WB
TELNYX_AMRWB_DECODE=true
PLAYBACK_PSTN_SAMPLE_RATE=24000

# LLM Configuration
LLM_PROVIDER=${llm_provider}
OPENAI_API_KEY=${openai_api_key}
OPENAI_MODEL=${openai_model}
LOCAL_LLM_URL=${local_llm_url}

# Ports
CONTROL_PORT=4000
RUNTIME_PORT=4001

# Media
MEDIA_STREAM_TOKEN=$(generate_secret)
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

# GPU Services
WHISPER_PORT=9000
WHISPER_MODEL_SIZE=base
KOKORO_PORT=7001
KOKORO_VOICE_ID=default
XTTS_PORT=7002
XTTS_LANGUAGE=en

# Control Plane
SECRET_ENCRYPTION_KEY=$(generate_secret)
SECRET_MANAGER=db
ADMIN_ALLOWED_ORIGINS=http://localhost:4000,http://127.0.0.1:4000

# Runtime URLs
PUBLIC_BASE_URL=http://localhost:4001
AUDIO_PUBLIC_BASE_URL=http://localhost:4001
TTS_MODE=coqui_xtts
KOKORO_URL=http://kokoro:7001
XTTS_URL=http://xtts:7002
COQUI_XTTS_URL=http://xtts:7002/tts

# Cloudflare Tunnel (optional)
CLOUDFLARE_TUNNEL_TOKEN=${cloudflare_token}
ENVFILE
}

# -----------------------------------------------------------------------------
# Main Installer
# -----------------------------------------------------------------------------
main() {
    clear
    
    # Banner
    echo ""
    echo -e "${BLUE}${BOLD}"
    echo "  ╔═══════════════════════════════════════════════════════════╗"
    echo "  ║                                                           ║"
    echo "  ║            VERALUX RECEPTIONIST                           ║"
    echo "  ║                     Setup                                 ║"
    echo "  ║                                                           ║"
    echo "  ╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    
    # Check Docker
    echo -e "${DIM}Checking requirements...${NC}"
    check_docker
    echo -e "${GREEN}✓${NC} Docker is running"
    echo ""
    
    # Ensure gum is available
    ensure_gum
    
    # Check for existing config
    if [[ -f ".env" ]]; then
        echo -e "${YELLOW}Existing configuration found.${NC}"
        echo ""
        
        CHOICE=$("$GUM_BIN" choose --header "What would you like to do?" \
            "Start services (keep existing config)" \
            "Reconfigure (enter new credentials)" \
            "Exit")
        
        case "$CHOICE" in
            "Start services"*)
                echo ""
                # Use tunnel if Cloudflare token exists in .env
                if grep -q "CLOUDFLARE_TUNNEL_TOKEN=." .env 2>/dev/null; then
                    ./deploy.sh tunnel cloudflare
                else
                    ./deploy.sh up
                fi
                exit 0
                ;;
            "Exit")
                exit 0
                ;;
        esac
        echo ""
    fi
    
    # Load offline images if present
    if [[ -f "images.tar.zst" ]]; then
        echo -e "${BLUE}Offline bundle detected.${NC}"
        echo ""
        "$GUM_BIN" spin --spinner dot --title "Loading Docker images..." -- ./load-images.sh
        echo -e "${GREEN}✓${NC} Images loaded"
        echo ""
    fi
    
    # Main menu loop
    while true; do
        echo ""
        SETUP_METHOD=$("$GUM_BIN" choose --header "How would you like to set up?" \
            "Online Setup (log in with your account)" \
            "Offline Setup (enter setup code from email)" \
            "Admin Setup (Veralux staff only)" \
            "Exit")
        
        [[ "$SETUP_METHOD" == "Exit" ]] && exit 0
        
        echo ""
    
    if [[ "$SETUP_METHOD" == "Online"* ]]; then
        # =====================================================================
        # ONLINE SETUP
        # =====================================================================
        echo -e "${BOLD}Log in with your Veralux account${NC}"
        echo -e "${DIM}Enter the email and password from your signup.${NC}"
        echo -e "${DIM}(Leave blank and press Enter to go back)${NC}"
        echo ""
        
        EMAIL=$("$GUM_BIN" input --placeholder "Email address" --width 50)
        [[ -z "$EMAIL" ]] && continue
        
        PASSWORD=$("$GUM_BIN" input --placeholder "Password" --password --width 50)
        [[ -z "$PASSWORD" ]] && continue
        
        echo ""
        RESPONSE=$("$GUM_BIN" spin --spinner dot --title "Logging in..." -- \
            bash -c "curl -s -X POST '$API_URL' -H 'Content-Type: application/json' -d '{\"email\": \"$EMAIL\", \"password\": \"$PASSWORD\"}'")
        
        # Parse response
        SUCCESS=$(echo "$RESPONSE" | grep -o '"success":\s*true' || echo "")
        
        if [[ -z "$SUCCESS" ]]; then
            ERROR=$(echo "$RESPONSE" | grep -o '"error":\s*"[^"]*"' | cut -d'"' -f4 || echo "Login failed")
            echo -e "${RED}✗ $ERROR${NC}"
            echo ""
            echo "Please check your credentials and try again."
            echo "Don't have an account? Sign up at https://veralux.ai/signup"
            exit 1
        fi
        
        # Extract config from response
        API_KEY=$(echo "$RESPONSE" | grep -o '"api_key":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
        TELNYX_NUMBER=$(echo "$RESPONSE" | grep -o '"telnyx_number":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
        TELNYX_API_KEY=$(echo "$RESPONSE" | grep -o '"telnyx_api_key":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
        TELNYX_PUBLIC_KEY=$(echo "$RESPONSE" | grep -o '"telnyx_public_key":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
        OPENAI_API_KEY=$(echo "$RESPONSE" | grep -o '"openai_api_key":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
        JWT_SECRET=$(echo "$RESPONSE" | grep -o '"jwt_secret":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
        CLOUDFLARE_TOKEN=$(echo "$RESPONSE" | grep -o '"cloudflare_token":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
        
        echo -e "${GREEN}✓${NC} Logged in successfully"
        
    elif [[ "$SETUP_METHOD" == "Offline"* ]]; then
        # =====================================================================
        # OFFLINE SETUP
        # =====================================================================
        echo -e "${BOLD}Offline Setup${NC}"
        echo ""
        
        ENTRY_METHOD=$("$GUM_BIN" choose --header "How do you want to enter your credentials?" \
            "Paste setup code from email" \
            "Enter details manually" \
            "← Back")
        
        [[ "$ENTRY_METHOD" == "← Back" ]] && continue
        
        echo ""
        
        if [[ "$ENTRY_METHOD" == "Paste"* ]]; then
            echo -e "${DIM}Paste the setup code from your welcome email:${NC}"
            echo ""
            
            SETUP_CODE=$("$GUM_BIN" write --placeholder "Paste your setup code here..." --width 60 --height 5)
            
            # Decode base64
            DECODED=$(echo "$SETUP_CODE" | base64 -d 2>/dev/null) || {
                echo -e "${RED}✗ Invalid setup code${NC}"
                exit 1
            }
            
            # Extract values from JSON
            API_KEY=$(echo "$DECODED" | grep -o '"api_key":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
            TELNYX_NUMBER=$(echo "$DECODED" | grep -o '"telnyx_number":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
            TELNYX_API_KEY=$(echo "$DECODED" | grep -o '"telnyx_api_key":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
            TELNYX_PUBLIC_KEY=$(echo "$DECODED" | grep -o '"telnyx_public_key":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
            OPENAI_API_KEY=$(echo "$DECODED" | grep -o '"openai_api_key":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
            JWT_SECRET=$(echo "$DECODED" | grep -o '"jwt_secret":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
            CLOUDFLARE_TOKEN=$(echo "$DECODED" | grep -o '"cloudflare_token":\s*"[^"]*"' | cut -d'"' -f4 || echo "")
            
            echo -e "${GREEN}✓${NC} Setup code accepted"
            
        else
            echo -e "${DIM}Enter the details from your welcome email:${NC}"
            echo ""
            
            API_KEY=$("$GUM_BIN" input --placeholder "API Key (vx_...)" --width 50)
            TELNYX_NUMBER=$("$GUM_BIN" input --placeholder "Phone Number (+1...)" --width 50)
            TELNYX_API_KEY=$("$GUM_BIN" input --placeholder "Telnyx API Key" --password --width 50)
            TELNYX_PUBLIC_KEY=$("$GUM_BIN" input --placeholder "Telnyx Public Key" --width 50)
            OPENAI_API_KEY=$("$GUM_BIN" input --placeholder "OpenAI API Key (sk-...)" --password --width 50)
            # Auto-generate a strong JWT secret
            JWT_SECRET=$(openssl rand -hex 32)
            CLOUDFLARE_TOKEN=""  # Customers don't need to enter this manually
        fi
        
    elif [[ "$SETUP_METHOD" == "Admin"* ]]; then
        # Admin setup - no API_KEY needed
        API_KEY=""
        # =====================================================================
        # ADMIN SETUP
        # =====================================================================
        echo -e "${BOLD}${YELLOW}Admin Setup${NC}"
        echo -e "${DIM}This mode is for Veralux staff only.${NC}"
        echo ""
        
        # Admin authentication
        echo -e "${DIM}(Leave blank and press Enter to go back)${NC}"
        echo ""
        
        ADMIN_USER=$("$GUM_BIN" input --placeholder "Admin username" --width 50)
        [[ -z "$ADMIN_USER" ]] && continue
        
        ADMIN_PASS=$("$GUM_BIN" input --placeholder "Admin password" --password --width 50)
        [[ -z "$ADMIN_PASS" ]] && continue
        
        # Verify admin credentials via control plane API
        CONTROL_PLANE_URL="${CONTROL_PLANE_AUTH_URL:-https://panel.veraluxclients.com}"
        ADMIN_RESPONSE=$(curl -s -X POST "$CONTROL_PLANE_URL/admin-auth" \
            -H "Content-Type: application/json" \
            -d "{\"username\": \"$ADMIN_USER\", \"password\": \"$ADMIN_PASS\"}" \
            2>/dev/null) || ADMIN_RESPONSE=""
        
        ADMIN_OK=$(echo "$ADMIN_RESPONSE" | grep -o '"success":\s*true' || echo "")
        if [[ -z "$ADMIN_OK" ]]; then
            echo ""
            echo -e "${RED}✗ Invalid admin credentials${NC}"
            echo ""
            "$GUM_BIN" confirm "Try again?" && continue || exit 1
        fi
        
        echo ""
        echo -e "${GREEN}✓${NC} Admin authenticated"
        echo ""
        
        # ── LLM Mode Selection ──
        echo -e "${BOLD}LLM Configuration${NC}"
        echo ""
        LLM_MODE=$("$GUM_BIN" choose --header "How will this system handle AI?" \
            "Cloud API (OpenAI / ChatGPT) — requires internet + API key" \
            "Local LLM (Ollama) — fully offline, requires GPU" \
            "← Back")
        
        [[ "$LLM_MODE" == "← Back" ]] && continue
        
        echo ""
        LLM_PROVIDER=""
        OPENAI_API_KEY=""
        OPENAI_MODEL=""
        LOCAL_LLM_URL=""
        
        if [[ "$LLM_MODE" == "Cloud"* ]]; then
            LLM_PROVIDER="openai"
            OPENAI_API_KEY=$("$GUM_BIN" input --placeholder "OpenAI API Key (sk-...)" --password --width 50)
            if [[ -z "$OPENAI_API_KEY" ]]; then
                echo -e "${RED}✗ API key is required for Cloud mode${NC}"
                continue
            fi
            echo ""
            OPENAI_MODEL=$("$GUM_BIN" choose --header "Which model?" \
                "qwen2.5:7b (local Ollama — default, best balance)" \
                "llama3.1:8b (local Ollama — alternative)" \
                "gpt-4o-mini (OpenAI cloud — fast)" \
                "gpt-4o (OpenAI cloud — most capable)")
            # Extract just the model name
            OPENAI_MODEL=$(echo "$OPENAI_MODEL" | awk '{print $1}')
            echo -e "${GREEN}✓${NC} Cloud API mode: ${OPENAI_MODEL}"
        else
            LLM_PROVIDER="local"
            echo -e "${DIM}Local LLM requires Ollama running with a model loaded.${NC}"
            echo ""
            
            # Check if Ollama is running
            if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
                echo -e "${GREEN}✓${NC} Ollama detected"
                OLLAMA_MODELS=$(curl -s http://127.0.0.1:11434/api/tags 2>/dev/null | grep -o '"name":"[^"]*"' | cut -d'"' -f4)
                if [[ -n "$OLLAMA_MODELS" ]]; then
                    echo -e "${DIM}Available models:${NC}"
                    echo "$OLLAMA_MODELS" | while read -r m; do echo "  • $m"; done
                fi
            else
                echo -e "${YELLOW}⚠${NC} Ollama not detected at localhost:11434"
                echo -e "${DIM}Install Ollama: curl -fsSL https://ollama.com/install.sh | sh${NC}"
                echo -e "${DIM}Then: ollama pull llama3.1:8b-instruct-q4_K_M${NC}"
                echo ""
                if ! "$GUM_BIN" confirm "Continue anyway?"; then
                    continue
                fi
            fi
            echo ""
            LOCAL_LLM_URL=$("$GUM_BIN" input --placeholder "Ollama URL" --value "http://127.0.0.1:11434/api/generate" --width 60)
            echo -e "${GREEN}✓${NC} Local LLM mode: ${LOCAL_LLM_URL}"
        fi
        
        echo ""
        
        # ── Remaining configuration ──
        echo -e "${BOLD}Enter configuration:${NC}"
        echo ""
        
        TELNYX_API_KEY=$("$GUM_BIN" input --placeholder "Telnyx API Key" --password --width 50)
        TELNYX_PUBLIC_KEY=$("$GUM_BIN" input --placeholder "Telnyx Public Key" --width 50)
        TELNYX_NUMBER=$("$GUM_BIN" input --placeholder "Telnyx Phone Number (+1...)" --width 50)
        # Auto-generate a strong JWT secret (control plane rejects weak ones)
        JWT_SECRET=$(openssl rand -hex 32)
        
        echo ""
        echo -e "${DIM}Optional: Cloudflare Tunnel (leave blank to skip)${NC}"
        CLOUDFLARE_TOKEN=$("$GUM_BIN" input --placeholder "Cloudflare Tunnel Token (eyJ...)" --password --width 50)
        
        echo ""
        echo -e "${BOLD}Configuration Summary:${NC}"
        echo -e "  LLM:      ${LLM_PROVIDER} $([ "$LLM_PROVIDER" = "openai" ] && echo "($OPENAI_MODEL)" || echo "($LOCAL_LLM_URL)")"
        echo -e "  Telnyx #: ${TELNYX_NUMBER}"
        [[ -n "$CLOUDFLARE_TOKEN" ]] && echo -e "  Tunnel:   Cloudflare (configured)" || echo -e "  Tunnel:   None"
        echo ""
        
        "$GUM_BIN" confirm "Deploy with this configuration?" || continue
    fi
    
    # Break out of menu loop - configuration collected successfully
    break
    done
    
    # Write configuration
    echo ""
    # Default LLM vars if not set (Online/Offline paths default to openai)
    LLM_PROVIDER="${LLM_PROVIDER:-openai}"
    OPENAI_MODEL="${OPENAI_MODEL:-qwen2.5:7b}"
    LOCAL_LLM_URL="${LOCAL_LLM_URL:-}"
    
    "$GUM_BIN" spin --spinner dot --title "Saving configuration..." -- \
        bash -c "$(declare -f write_env_file generate_secret); write_env_file '$API_KEY' '$TELNYX_NUMBER' '$TELNYX_API_KEY' '$TELNYX_PUBLIC_KEY' '$OPENAI_API_KEY' '$JWT_SECRET' '$CLOUDFLARE_TOKEN' '$LLM_PROVIDER' '$OPENAI_MODEL' '$LOCAL_LLM_URL'"
    
    echo -e "${GREEN}✓${NC} Configuration saved"
    
    # Start services
    echo ""
    echo -e "${BOLD}Starting services...${NC}"
    echo ""
    
    # Start with Cloudflare tunnel if token is provided
    if [[ -n "$CLOUDFLARE_TOKEN" ]]; then
        echo -e "${DIM}Starting with Cloudflare Tunnel...${NC}"
        ./deploy.sh tunnel cloudflare
    else
        ./deploy.sh up
    fi
    
    # Success
    echo ""
    echo -e "${GREEN}${BOLD}"
    echo "  ╔═══════════════════════════════════════════════════════════╗"
    echo "  ║                                                           ║"
    echo "  ║                   SETUP COMPLETE! ✓                       ║"
    echo "  ║                                                           ║"
    echo "  ╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo "  Your Veralux Receptionist is now running!"
    echo ""
    # Read back the generated ADMIN_API_KEY from .env
    local admin_api_key
    admin_api_key=$(grep '^ADMIN_API_KEY=' .env | cut -d= -f2)

    echo -e "  ${BOLD}Your Credentials:${NC}"
    echo -e "  ────────────────────────────────────────────"
    echo -e "  Admin Panel:    ${GREEN}http://localhost:4000${NC}"
    echo -e "  Admin API Key:  ${DIM}${admin_api_key}${NC}"
    echo -e "  JWT Secret:     ${DIM}${JWT_SECRET}${NC}"
    if [[ -n "$TELNYX_NUMBER" ]]; then
        echo -e "  Phone Number:   ${GREEN}${TELNYX_NUMBER}${NC}"
    fi
    echo -e "  ────────────────────────────────────────────"
    echo ""
    echo -e "  ${YELLOW}Save your Admin API Key and JWT Secret somewhere safe!${NC}"
    echo ""
    echo -e "  ${DIM}Commands:${NC}"
    echo "    ./deploy.sh status   - Check service status"
    echo "    ./deploy.sh logs     - View logs"
    echo "    ./deploy.sh restart  - Restart services"
    echo "    ./deploy.sh down     - Stop services"
    echo ""
}

main "$@"
