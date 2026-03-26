#!/usr/bin/env bash
# =============================================================================
# Veralux Receptionist - Redis Backup Script
# =============================================================================
# Creates a copy of the Redis AOF/RDB data from the Docker volume.
#
# Usage:
#   ./scripts/backup-redis.sh                  # Backup to ./backups/
#   ./scripts/backup-redis.sh /path/to/dir     # Backup to custom directory
#
# Automated (cron - daily at 2:15am):
#   15 2 * * * /path/to/veralux/scripts/backup-redis.sh 2>&1 | logger -t veralux-redis-backup
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

CONTAINER_NAME="veralux-redis"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
BACKUP_DIR="${1:-$PROJECT_ROOT/backups}"
BACKUP_FILENAME="veralux_redis_${TIMESTAMP}.rdb.gz"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[REDIS-BACKUP]${NC} $*"; }
success() { echo -e "${GREEN}[REDIS-BACKUP]${NC} $*"; }
error()   { echo -e "${RED}[REDIS-BACKUP]${NC} $*" >&2; }

# Check container is running
if ! docker inspect "$CONTAINER_NAME" &>/dev/null; then
    error "Container '$CONTAINER_NAME' not found. Is Redis running?"
    exit 1
fi

# Trigger a background save
info "Triggering BGSAVE..."
docker exec "$CONTAINER_NAME" redis-cli BGSAVE >/dev/null 2>&1

# Wait for save to complete (up to 30s)
for i in $(seq 1 30); do
    LAST_SAVE=$(docker exec "$CONTAINER_NAME" redis-cli LASTSAVE 2>/dev/null)
    BG_STATUS=$(docker exec "$CONTAINER_NAME" redis-cli INFO persistence 2>/dev/null | grep rdb_bgsave_in_progress | tr -d '\r')
    if [[ "$BG_STATUS" == *"0"* ]]; then
        break
    fi
    sleep 1
done

# Copy the dump file
mkdir -p "$BACKUP_DIR"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILENAME"

info "Copying Redis dump..."
docker exec "$CONTAINER_NAME" cat /data/dump.rdb 2>/dev/null | gzip > "$BACKUP_PATH" || true

# Also copy the AOF if it exists
AOF_FILENAME="veralux_redis_${TIMESTAMP}.aof.gz"
AOF_PATH="$BACKUP_DIR/$AOF_FILENAME"
docker exec "$CONTAINER_NAME" sh -c 'cat /data/appendonly.aof 2>/dev/null' | gzip > "$AOF_PATH" 2>/dev/null || true

# Verify
BACKUP_SIZE=$(stat -c%s "$BACKUP_PATH" 2>/dev/null || stat -f%z "$BACKUP_PATH" 2>/dev/null || echo "0")
if [[ "$BACKUP_SIZE" -lt 50 ]]; then
    error "Redis backup is suspiciously small (${BACKUP_SIZE} bytes)."
    rm -f "$BACKUP_PATH"
    exit 1
fi

HUMAN_SIZE=$(du -h "$BACKUP_PATH" | cut -f1)
success "Redis backup complete: $BACKUP_PATH ($HUMAN_SIZE)"

# Clean up old backups
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
    OLD_COUNT=$(find "$BACKUP_DIR" -name "veralux_redis_*" -mtime +"$RETENTION_DAYS" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$OLD_COUNT" -gt 0 ]]; then
        info "Removing $OLD_COUNT old Redis backup(s)..."
        find "$BACKUP_DIR" -name "veralux_redis_*" -mtime +"$RETENTION_DAYS" -delete
    fi
fi

success "Done."
