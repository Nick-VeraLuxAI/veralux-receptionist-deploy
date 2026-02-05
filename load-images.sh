#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Offline Image Loader
# =============================================================================
# Loads pre-packaged Docker images for airgapped/offline installations.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
IMAGES_ARCHIVE="images.tar.zst"

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

check_zstd() {
    if ! command -v zstd &> /dev/null; then
        error "zstd is not installed."
        echo ""
        echo "  Install zstd:"
        echo ""
        echo "    Ubuntu/Debian:"
        echo "      sudo apt update && sudo apt install -y zstd"
        echo ""
        echo "    macOS (Homebrew):"
        echo "      brew install zstd"
        echo ""
        echo "    macOS (MacPorts):"
        echo "      sudo port install zstd"
        echo ""
        exit 1
    fi
    
    success "zstd is available."
}

check_archive() {
    if [[ ! -f "$IMAGES_ARCHIVE" ]]; then
        error "Image archive not found: $IMAGES_ARCHIVE"
        echo ""
        echo "  This script is for offline installations only."
        echo "  The images.tar.zst file should be included in the offline bundle."
        echo ""
        echo "  For online installations, run:"
        echo "    ./deploy.sh up"
        echo ""
        exit 1
    fi
    
    success "Image archive found: $IMAGES_ARCHIVE"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    echo "=========================================="
    echo "  Veralux Receptionist - Image Loader"
    echo "=========================================="
    echo ""
    
    # Check dependencies
    check_docker
    check_zstd
    check_archive
    
    echo ""
    info "Loading Docker images from $IMAGES_ARCHIVE..."
    info "This may take several minutes depending on archive size."
    echo ""
    
    # Decompress and load images
    # Using pv for progress if available, otherwise just pipe directly
    if command -v pv &> /dev/null; then
        pv "$IMAGES_ARCHIVE" | zstd -d | docker load
    else
        zstd -d "$IMAGES_ARCHIVE" | docker load
    fi
    
    echo ""
    success "All images loaded successfully!"
    echo ""
    echo "=========================================="
    echo "  Next Steps"
    echo "=========================================="
    echo ""
    echo "  1. Configure environment (if not already done):"
    echo "     cp .env.example .env"
    echo "     # Edit .env with your settings"
    echo ""
    echo "  2. Start the application:"
    echo "     ./deploy.sh up"
    echo ""
    echo "  3. Check status:"
    echo "     ./deploy.sh status"
    echo ""
}

main "$@"
