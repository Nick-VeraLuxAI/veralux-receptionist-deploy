#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Build Online Bundle
# =============================================================================
# Creates a distributable ZIP for online installations (no images included).
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
get_version() {
    if [[ -f ".env" ]]; then
        VERSION=$(grep -E '^VERSION=' .env | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "")
    fi
    
    if [[ -z "${VERSION:-}" ]] && [[ -f ".env.example" ]]; then
        VERSION=$(grep -E '^VERSION=' .env.example | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "")
    fi
    
    if [[ -z "${VERSION:-}" ]]; then
        VERSION="0.1.0"
        warn "Could not determine VERSION, using default: $VERSION"
    fi
    
    echo "$VERSION"
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
main() {
    echo "=========================================="
    echo "  Building Online Bundle"
    echo "=========================================="
    echo ""
    
    VERSION=$(get_version)
    BUNDLE_NAME="veralux-receptionist-${VERSION}"
    BUILD_DIR="build/${BUNDLE_NAME}"
    DIST_DIR="dist"
    OUTPUT_FILE="${DIST_DIR}/${BUNDLE_NAME}-online.zip"
    
    info "Version: $VERSION"
    info "Output: $OUTPUT_FILE"
    echo ""
    
    # Clean and create directories
    info "Preparing build directory..."
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    mkdir -p "$DIST_DIR"
    
    # Copy files
    info "Copying files..."
    
    # Required files
    cp docker-compose.yml "$BUILD_DIR/"
    cp .env.example "$BUILD_DIR/"
    cp deploy.sh "$BUILD_DIR/"
    cp install.sh "$BUILD_DIR/"
    cp README.md "$BUILD_DIR/"
    
    # Optional: nginx directory
    if [[ -d "nginx" ]]; then
        cp -r nginx "$BUILD_DIR/"
        success "Included nginx/ directory"
    fi
    
    # Ensure scripts are executable
    chmod +x "$BUILD_DIR/deploy.sh"
    chmod +x "$BUILD_DIR/install.sh"
    
    # Create ZIP
    info "Creating ZIP archive..."
    cd build
    rm -f "../$OUTPUT_FILE"
    zip -r "../$OUTPUT_FILE" "$BUNDLE_NAME"
    cd "$PROJECT_ROOT"
    
    # Report
    echo ""
    success "Online bundle created successfully!"
    echo ""
    echo "  Output: $OUTPUT_FILE"
    echo "  Size: $(du -h "$OUTPUT_FILE" | cut -f1)"
    echo ""
    echo "  Contents:"
    unzip -l "$OUTPUT_FILE" | tail -n +4 | grep -v "^-" | grep -v "files$" | sed 's/^/    /'
    echo ""
}

main "$@"
