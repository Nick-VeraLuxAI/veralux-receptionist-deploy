#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Database Backup Script
# =============================================================================
# Creates a compressed pg_dump of the Postgres database.
#
# Usage:
#   ./scripts/backup.sh                    # Backup to local ./backups/ directory
#   ./scripts/backup.sh /path/to/dir       # Backup to custom directory
#   ./scripts/backup.sh --s3 s3://bucket   # Backup locally then upload to S3
#
# Automated (cron example - daily at 2am, keep last 30 days):
#   0 2 * * * /path/to/veralux/scripts/backup.sh 2>&1 | logger -t veralux-backup
#
# Restore:
#   gunzip -c backups/veralux_2026-02-07_020000.sql.gz | \
#     docker exec -i veralux-postgres psql -U veralux -d veralux
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------
CONTAINER_NAME="veralux-postgres"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")

# Load .env for DB credentials
if [[ -f ".env" ]]; then
    # shellcheck disable=SC2046
    export $(grep -E '^(POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB)=' .env | xargs)
fi

DB_USER="${POSTGRES_USER:-veralux}"
DB_NAME="${POSTGRES_DB:-veralux}"
BACKUP_FILENAME="veralux_${TIMESTAMP}.sql.gz"

# -----------------------------------------------------------------------------
# Colors
# -----------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[BACKUP]${NC} $*"; }
success() { echo -e "${GREEN}[BACKUP]${NC} $*"; }
warn()    { echo -e "${YELLOW}[BACKUP]${NC} $*"; }
error()   { echo -e "${RED}[BACKUP]${NC} $*" >&2; }

# -----------------------------------------------------------------------------
# Parse arguments
# -----------------------------------------------------------------------------
BACKUP_DIR="$PROJECT_ROOT/backups"
S3_DEST=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --s3)
            S3_DEST="$2"
            shift 2
            ;;
        --retention)
            RETENTION_DAYS="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [backup_dir] [--s3 s3://bucket/path] [--retention days]"
            echo ""
            echo "Options:"
            echo "  backup_dir          Directory for local backups (default: ./backups/)"
            echo "  --s3 URI            Upload backup to S3 after local save"
            echo "  --retention DAYS    Delete local backups older than N days (default: 30)"
            echo "  --help              Show this help"
            exit 0
            ;;
        *)
            BACKUP_DIR="$1"
            shift
            ;;
    esac
done

# -----------------------------------------------------------------------------
# Checks
# -----------------------------------------------------------------------------
if ! docker inspect "$CONTAINER_NAME" &>/dev/null; then
    error "Container '$CONTAINER_NAME' not found. Is Postgres running?"
    echo "  Start with: ./deploy.sh up"
    exit 1
fi

if ! docker exec "$CONTAINER_NAME" pg_isready -U "$DB_USER" -d "$DB_NAME" &>/dev/null; then
    error "Postgres is not ready in container '$CONTAINER_NAME'."
    exit 1
fi

# -----------------------------------------------------------------------------
# Create backup
# -----------------------------------------------------------------------------
mkdir -p "$BACKUP_DIR"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILENAME"

info "Backing up database '$DB_NAME' from container '$CONTAINER_NAME'..."
info "Output: $BACKUP_PATH"

# pg_dump with custom format options for a clean, restorable dump
docker exec "$CONTAINER_NAME" \
    pg_dump -U "$DB_USER" -d "$DB_NAME" \
        --no-owner \
        --no-privileges \
        --clean \
        --if-exists \
    | gzip > "$BACKUP_PATH"

# Verify the backup isn't empty
BACKUP_SIZE=$(stat -f%z "$BACKUP_PATH" 2>/dev/null || stat -c%s "$BACKUP_PATH" 2>/dev/null || echo "0")
if [[ "$BACKUP_SIZE" -lt 100 ]]; then
    error "Backup file is suspiciously small (${BACKUP_SIZE} bytes). Something went wrong."
    rm -f "$BACKUP_PATH"
    exit 1
fi

HUMAN_SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
success "Backup complete: $BACKUP_PATH ($HUMAN_SIZE)"

# -----------------------------------------------------------------------------
# Upload to S3 (optional)
# -----------------------------------------------------------------------------
if [[ -n "$S3_DEST" ]]; then
    if ! command -v aws &>/dev/null; then
        warn "AWS CLI not found. Skipping S3 upload."
        warn "Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    else
        S3_PATH="${S3_DEST%/}/$BACKUP_FILENAME"
        info "Uploading to $S3_PATH..."
        aws s3 cp "$BACKUP_PATH" "$S3_PATH" --quiet
        success "Uploaded to S3: $S3_PATH"
    fi
fi

# -----------------------------------------------------------------------------
# Clean up old backups
# -----------------------------------------------------------------------------
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
    OLD_COUNT=$(find "$BACKUP_DIR" -name "veralux_*.sql.gz" -mtime +"$RETENTION_DAYS" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$OLD_COUNT" -gt 0 ]]; then
        info "Removing $OLD_COUNT backup(s) older than $RETENTION_DAYS days..."
        find "$BACKUP_DIR" -name "veralux_*.sql.gz" -mtime +"$RETENTION_DAYS" -delete
        success "Old backups cleaned."
    fi
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
TOTAL_BACKUPS=$(find "$BACKUP_DIR" -name "veralux_*.sql.gz" 2>/dev/null | wc -l | tr -d ' ')
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)

echo ""
success "Backup complete!"
echo "  File:      $BACKUP_PATH"
echo "  Size:      $HUMAN_SIZE"
echo "  Backups:   $TOTAL_BACKUPS total ($TOTAL_SIZE)"
echo "  Retention: $RETENTION_DAYS days"
if [[ -n "$S3_DEST" ]]; then
    echo "  S3:        $S3_PATH"
fi
echo ""
echo "  Restore with:"
echo "    gunzip -c $BACKUP_PATH | docker exec -i $CONTAINER_NAME psql -U $DB_USER -d $DB_NAME"
echo ""
