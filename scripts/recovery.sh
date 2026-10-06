#!/usr/bin/env bash
# =============================================================================
# VeraLux Receptionist — Service Recovery Script
# =============================================================================
# Kills any processes squatting on required ports, tears down all containers,
# and brings them back up cleanly.
#
# Usage:
#   ./scripts/recovery.sh            # Full recovery
#   ./scripts/recovery.sh --dry-run  # Show what would be killed (no changes)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_PROJECT="veralux"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()    { echo -e "${BLUE}[recovery]${NC} $*"; }
success() { echo -e "${GREEN}[recovery]${NC} $*"; }
warn()    { echo -e "${YELLOW}[recovery]${NC} $*"; }
error()   { echo -e "${RED}[recovery]${NC} $*" >&2; }

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  warn "Dry-run mode — no changes will be made"
fi

# ── Ports used by VeraLux services (host-mapped) ─────────────────────────────
REQUIRED_PORTS=(4000 4001 80 443 4040)

# ── Step 1: Identify & kill port squatters ────────────────────────────────────
info "Scanning for processes on required ports..."

killed=0
for port in "${REQUIRED_PORTS[@]}"; do
  # Find PIDs listening on this port (exclude Docker proxy — those are ours)
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [[ -z "$pids" ]]; then
    continue
  fi

  for pid in $pids; do
    proc_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
    # Skip Docker's own proxy — that's managed by docker compose
    if [[ "$proc_name" == "docker-proxy" || "$proc_name" == "docker" || "$proc_name" == "dockerd" || "$proc_name" == "containerd" ]]; then
      continue
    fi
    warn "Port $port occupied by PID $pid ($proc_name)"
    if [[ "$DRY_RUN" == "false" ]]; then
      kill -9 "$pid" 2>/dev/null && success "  Killed PID $pid" || warn "  Could not kill PID $pid (may need sudo)"
      ((killed++))
    else
      info "  [dry-run] Would kill PID $pid ($proc_name)"
    fi
  done
done

if [[ $killed -eq 0 && "$DRY_RUN" == "false" ]]; then
  info "No rogue processes found on required ports"
fi

if [[ "$DRY_RUN" == "true" ]]; then
  info "Dry run complete."
  exit 0
fi

# ── Step 2: Tear down all containers ──────────────────────────────────────────
info "Stopping all VeraLux containers..."
cd "$PROJECT_ROOT"
docker compose -p "$COMPOSE_PROJECT" down --remove-orphans 2>&1 || warn "docker compose down had warnings (continuing)"

# ── Step 3: Wait for ports to free up ────────────────────────────────────────
info "Waiting for ports to clear..."
sleep 2

# Double-check that ports are free
blocked=()
for port in "${REQUIRED_PORTS[@]}"; do
  if lsof -ti :"$port" >/dev/null 2>&1; then
    blocked+=("$port")
  fi
done

if [[ ${#blocked[@]} -gt 0 ]]; then
  warn "Ports still occupied after cleanup: ${blocked[*]}"
  warn "Attempting force kill..."
  for port in "${blocked[@]}"; do
    pids=$(lsof -ti :"$port" 2>/dev/null || true)
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
  done
  sleep 1
fi

# ── Step 4: Bring services back up ───────────────────────────────────────────
info "Starting all VeraLux services..."
docker compose -p "$COMPOSE_PROJECT" up -d 2>&1

# ── Step 5: Wait and verify ──────────────────────────────────────────────────
info "Waiting for services to initialize (10s)..."
sleep 10

info "Checking service health..."
running=$(docker compose -p "$COMPOSE_PROJECT" ps --status running --format '{{.Name}}' 2>/dev/null | wc -l)
total=$(docker compose -p "$COMPOSE_PROJECT" ps --format '{{.Name}}' 2>/dev/null | wc -l)

if [[ "$running" -eq "$total" && "$total" -gt 0 ]]; then
  success "Recovery complete — $running/$total services running"
else
  warn "Recovery completed with issues — $running/$total services running"
  docker compose -p "$COMPOSE_PROJECT" ps 2>/dev/null
fi
