#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Build Offline Bundle
# =============================================================================
# Creates a distributable ZIP for airgapped/offline installations.
# Includes all Docker images compressed with zstd.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

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
# Configuration
# -----------------------------------------------------------------------------

# Services to include in offline bundle
# Edit this array to add/remove images
SERVICES=(
    # Core services (always included)
    "veralux-control-plane"
    "veralux-voice-runtime"
    
    # GPU/Audio services (optional - comment out if not needed)
    "whisper"
    "kokoro"
    "xtts"
)

# Infrastructure images (always included)
INFRA_IMAGES=(
    "redis:7-alpine"
    "postgres:16-alpine"
)

get_version() {
    local version=""
    
    if [[ -f ".env" ]]; then
        version=$(grep -E '^VERSION=' .env | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "")
    fi
    
    if [[ -z "$version" ]] && [[ -f ".env.example" ]]; then
        version=$(grep -E '^VERSION=' .env.example | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "")
    fi
    
    if [[ -z "$version" ]]; then
        version="0.1.0"
        warn "Could not determine VERSION, using default: $version"
    fi
    
    echo "$version"
}

get_registry() {
    local registry=""
    
    if [[ -f ".env" ]]; then
        registry=$(grep -E '^REGISTRY=' .env | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "")
    fi
    
    if [[ -z "$registry" ]] && [[ -f ".env.example" ]]; then
        registry=$(grep -E '^REGISTRY=' .env.example | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "")
    fi
    
    if [[ -z "$registry" ]]; then
        registry="ghcr.io/yourorg"
        warn "Could not determine REGISTRY, using default: $registry"
    fi
    
    echo "$registry"
}

# -----------------------------------------------------------------------------
# Dependency Checks
# -----------------------------------------------------------------------------
check_dependencies() {
    local missing=0
    
    if ! command -v docker &> /dev/null; then
        error "Docker is required but not installed."
        missing=1
    fi
    
    if ! command -v zstd &> /dev/null; then
        error "zstd is required but not installed."
        echo "  Ubuntu: sudo apt install zstd"
        echo "  macOS:  brew install zstd"
        missing=1
    fi
    
    if ! command -v zip &> /dev/null; then
        error "zip is required but not installed."
        echo "  Ubuntu: sudo apt install zip"
        echo "  macOS:  brew install zip"
        missing=1
    fi
    
    if [[ $missing -eq 1 ]]; then
        exit 1
    fi
    
    success "All dependencies available."
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    echo "=========================================="
    echo "  Building Offline Bundle"
    echo "=========================================="
    echo ""
    
    check_dependencies
    
    VERSION=$(get_version)
    REGISTRY=$(get_registry)
    BUNDLE_NAME="veralux-receptionist-${VERSION}"
    BUILD_DIR="build/${BUNDLE_NAME}"
    DIST_DIR="dist"
    OUTPUT_FILE="${DIST_DIR}/${BUNDLE_NAME}-offline.zip"
    IMAGES_ARCHIVE="${BUILD_DIR}/images.tar.zst"
    
    info "Version: $VERSION"
    info "Registry: $REGISTRY"
    info "Output: $OUTPUT_FILE"
    echo ""
    
    # Build list of full image references
    IMAGES=()
    for service in "${SERVICES[@]}"; do
        IMAGES+=("${REGISTRY}/${service}:${VERSION}")
    done
    for img in "${INFRA_IMAGES[@]}"; do
        IMAGES+=("$img")
    done
    
    info "Images to include:"
    for img in "${IMAGES[@]}"; do
        echo "    - $img"
    done
    echo ""
    
    # Pull all images
    info "Pulling images..."
    for img in "${IMAGES[@]}"; do
        info "  Pulling $img..."
        if ! docker pull "$img"; then
            error "Failed to pull $img"
            error "Make sure the image exists and you have access."
            exit 1
        fi
    done
    success "All images pulled."
    echo ""
    
    # Clean and create directories
    info "Preparing build directory..."
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    mkdir -p "$DIST_DIR"
    
    # Save and compress images
    info "Saving Docker images (this may take a while)..."
    docker save "${IMAGES[@]}" | zstd -19 -T0 > "$IMAGES_ARCHIVE"
    success "Images saved and compressed."
    echo "    Archive size: $(du -h "$IMAGES_ARCHIVE" | cut -f1)"
    echo ""
    
    # Copy files
    info "Copying deployment files..."
    
    # Required files
    cp docker-compose.yml "$BUILD_DIR/"
    cp .env.example "$BUILD_DIR/"
    cp deploy.sh "$BUILD_DIR/"
    cp install.sh "$BUILD_DIR/"
    cp load-images.sh "$BUILD_DIR/"
    cp README.md "$BUILD_DIR/"
    
    # Optional: nginx directory
    if [[ -d "nginx" ]]; then
        cp -r nginx "$BUILD_DIR/"
        success "Included nginx/ directory"
    fi
    
    # Ensure scripts are executable
    chmod +x "$BUILD_DIR/deploy.sh"
    chmod +x "$BUILD_DIR/install.sh"
    chmod +x "$BUILD_DIR/load-images.sh"
    
    # Create ZIP
    info "Creating ZIP archive..."
    cd build
    rm -f "../$OUTPUT_FILE"
    zip -r "../$OUTPUT_FILE" "$BUNDLE_NAME"
    cd "$PROJECT_ROOT"
    
    # Report
    echo ""
    success "Offline bundle created successfully!"
    echo ""
    echo "  Output: $OUTPUT_FILE"
    echo "  Size: $(du -h "$OUTPUT_FILE" | cut -f1)"
    echo ""
    echo "  Contents:"
    unzip -l "$OUTPUT_FILE" | tail -n +4 | grep -v "^-" | grep -v "files$" | sed 's/^/    /'
    echo ""
    echo "  Included images:"
    for img in "${IMAGES[@]}"; do
        echo "    - $img"
    done
    echo ""
}

main "$@"
