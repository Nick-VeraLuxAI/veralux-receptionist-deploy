#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Installer
# =============================================================================
# Launches the web-based setup wizard.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

error()   { echo -e "${RED}✗${NC} $*" >&2; }
success() { echo -e "${GREEN}✓${NC} $*"; }
info()    { echo -e "${BLUE}▶${NC} $*"; }

# Check Docker
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
}

# Main
main() {
    echo ""
    echo -e "${BLUE}${BOLD}"
    echo "  ╔═══════════════════════════════════════════════════════════╗"
    echo "  ║                                                           ║"
    echo "  ║            VERALUX RECEPTIONIST INSTALLER                 ║"
    echo "  ║                                                           ║"
    echo "  ╚═══════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    
    info "Checking Docker..."
    check_docker
    success "Docker is running"
    echo ""
    
    # Launch Python wizard
    if command -v python3 &> /dev/null; then
        python3 "$SCRIPT_DIR/setup-wizard.py"
    elif command -v python &> /dev/null; then
        python "$SCRIPT_DIR/setup-wizard.py"
    else
        error "Python 3 is required but not found."
        echo ""
        echo "  Please install Python 3, or run the manual setup:"
        echo "    cp .env.example .env"
        echo "    nano .env"
        echo "    ./deploy.sh up"
        echo ""
        exit 1
    fi
}

main "$@"
