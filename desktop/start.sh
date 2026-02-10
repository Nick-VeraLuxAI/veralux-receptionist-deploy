#!/bin/bash
# VeraLux Desktop Control Center — Launcher
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")"
exec npx electron --no-sandbox . "$@"
