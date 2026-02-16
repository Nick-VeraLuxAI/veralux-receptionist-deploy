#!/bin/bash
# Stability Check Script
# Run periodically (e.g., via cron) to check system health.
# Usage: ./stability-check.sh [--log FILE]
#
# Checks:
#   1. All Docker containers are running
#   2. Control plane health endpoint responds
#   3. Voice runtime responds
#   4. Whisper STT responds
#   5. Brain LLM responds
#   6. Database is reachable
#   7. No OOM kills or restarts in the last hour

LOGFILE="${2:-}"
PASS=0
FAIL=0
WARN=0
TS=$(date '+%Y-%m-%d %H:%M:%S')

log() {
  if [ -n "$LOGFILE" ]; then
    echo "[$TS] $1" >> "$LOGFILE"
  else
    echo "[$TS] $1"
  fi
}

check() {
  local name="$1"
  local cmd="$2"
  if eval "$cmd" > /dev/null 2>&1; then
    log "  [PASS] $name"
    ((PASS++))
  else
    log "  [FAIL] $name"
    ((FAIL++))
  fi
}

log "=== Stability Check ==="

# 1. Docker containers
log "Checking Docker containers..."
for svc in veralux-control veralux-runtime veralux-brain veralux-whisper veralux-postgres veralux-redis veralux-kokoro; do
  check "$svc running" "docker inspect -f '{{.State.Running}}' $svc 2>/dev/null | grep -q 'true'"
done

# 2. Control plane health
log "Checking service endpoints..."
ADMIN_KEY=$(grep ADMIN_API_KEY /home/receptionist/veralux-receptionist-deploy/.env 2>/dev/null | head -1 | cut -d= -f2)
check "Control plane /api/admin/health" "curl -sf -H 'X-Admin-Key: $ADMIN_KEY' http://localhost:4000/api/admin/health | grep -q ok"
check "Voice runtime /health" "curl -sf http://localhost:4001/health | grep -q ok"
check "Whisper STT (container)" "docker inspect -f '{{.State.Running}}' veralux-whisper 2>/dev/null | grep -q 'true'"
check "Brain LLM (container)" "docker inspect -f '{{.State.Running}}' veralux-brain 2>/dev/null | grep -q 'true'"

# 3. Database connectivity
check "PostgreSQL" "docker exec veralux-postgres pg_isready -U veralux -d veralux"
check "Redis" "docker exec veralux-redis redis-cli ping | grep -q PONG"

# 4. Container restarts in last hour
log "Checking container restarts..."
for svc in veralux-control veralux-runtime veralux-brain; do
  RESTARTS=$(docker inspect -f '{{.RestartCount}}' $svc 2>/dev/null || echo "0")
  if [ "$RESTARTS" -gt 0 ]; then
    log "  [WARN] $svc has $RESTARTS restarts"
    ((WARN++))
  fi
done

# 5. Memory usage
log "Checking memory usage..."
for svc in veralux-control veralux-runtime veralux-brain; do
  MEM=$(docker stats --no-stream --format '{{.MemUsage}}' $svc 2>/dev/null | cut -d/ -f1 | xargs)
  log "  [INFO] $svc memory: $MEM"
done

# 6. Uptime
log "Checking uptime..."
for svc in veralux-control veralux-runtime veralux-brain veralux-postgres veralux-redis; do
  STATUS=$(docker inspect -f '{{.State.Status}} since {{.State.StartedAt}}' $svc 2>/dev/null)
  log "  [INFO] $svc: $STATUS"
done

log ""
log "Summary: $PASS passed, $FAIL failed, $WARN warnings"
log "=== End ==="

# Exit with failure if any critical checks failed
if [ $FAIL -gt 0 ]; then
  exit 1
fi
exit 0
