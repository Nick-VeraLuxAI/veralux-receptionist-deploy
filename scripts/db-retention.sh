#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Database Retention Cleanup
# =============================================================================
# Deletes records older than RETENTION_DAYS (default: 90) from transactional
# tables (calls, workflow_runs, audit_log, expired tokens).
#
# Usage:
#   ./scripts/db-retention.sh              # Default 90 days
#   ./scripts/db-retention.sh 30           # Custom retention period
#
# Automated (cron example - daily at 3am):
#   0 3 * * * /path/to/veralux/scripts/db-retention.sh 2>&1 | logger -t veralux-retention
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

RETENTION_DAYS="${1:-90}"
CONTAINER_NAME="veralux-postgres"

# Load .env for DB credentials
if [[ -f ".env" ]]; then
    export $(grep -E '^(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)=' .env | xargs)
fi

DB_USER="${POSTGRES_USER:-veralux}"
DB_NAME="${POSTGRES_DB:-veralux}"

if ! docker inspect "$CONTAINER_NAME" &>/dev/null; then
    echo "[ERROR] Container '$CONTAINER_NAME' not found."
    exit 1
fi

echo "[INFO] Running retention cleanup (keeping last $RETENTION_DAYS days)..."

docker exec "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -c \
    "SELECT * FROM cleanup_old_records($RETENTION_DAYS);" 2>&1

echo "[OK] Retention cleanup complete."
