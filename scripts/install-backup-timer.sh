#!/usr/bin/env bash
# Install the systemd timer for automated daily database backups.
# Usage: sudo ./scripts/install-backup-timer.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[INFO] Installing Veralux backup timer..."

sudo cp "$SCRIPT_DIR/veralux-backup.service" /etc/systemd/system/
sudo cp "$SCRIPT_DIR/veralux-backup.timer" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now veralux-backup.timer

echo "[OK] Backup timer installed. Runs daily at 2:00 AM (±5 min jitter)."
echo ""
echo "  Check status:   systemctl status veralux-backup.timer"
echo "  View next run:   systemctl list-timers veralux-backup.timer"
echo "  Run manually:    sudo systemctl start veralux-backup.service"
echo "  View logs:       journalctl -u veralux-backup.service"
