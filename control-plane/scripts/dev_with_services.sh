#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUDIO_REPO="${AUDIO_REPO:-$ROOT/../veralux-audio-stack}"
ENABLE_LEGACY_VOICE_LOOP="${ENABLE_LEGACY_VOICE_LOOP:-0}"

KOKORO_VENV="${KOKORO_VENV:-$ROOT/kokoro-env}"
WHISPER_VENV="${WHISPER_VENV:-$ROOT/whisper-env}"
XTTS_VENV="${XTTS_VENV:-$ROOT/xtts-env}"

KOKORO_CWD="${KOKORO_CWD:-$AUDIO_REPO}"
WHISPER_CWD="${WHISPER_CWD:-$AUDIO_REPO}"
XTTS_CWD="${XTTS_CWD:-$AUDIO_REPO}"

KOKORO_APP="${KOKORO_APP:-kokoro_server:app}"
WHISPER_APP="${WHISPER_APP:-whisper_server:app}"
XTTS_APP="${XTTS_APP:-xtts_server:app}"

KOKORO_HOST="${KOKORO_HOST:-0.0.0.0}"
WHISPER_HOST="${WHISPER_HOST:-0.0.0.0}"
XTTS_HOST="${XTTS_HOST:-0.0.0.0}"

KOKORO_PORT="${KOKORO_PORT:-7001}"
WHISPER_PORT="${WHISPER_PORT:-9000}"
XTTS_PORT="${XTTS_PORT:-7002}"

KOKORO_RELOAD="${KOKORO_RELOAD:-1}"
WHISPER_RELOAD="${WHISPER_RELOAD:-1}"
XTTS_RELOAD="${XTTS_RELOAD:-1}"

pids=()

cleanup() {
  if [ "${#pids[@]}" -eq 0 ]; then return; fi
  echo
  echo "[dev] Stopping background services…"
  for pid in "${pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  for pid in "${pids[@]}"; do
    wait "$pid" >/dev/null 2>&1 || true
  done
}

trap cleanup EXIT INT TERM

start_uvicorn() {
  local name="$1" venv="$2" cwd="$3" app="$4" host="$5" port="$6" reload="$7"

  if [ ! -d "$cwd" ]; then
    echo "[dev] WARN: Skipping $name (cwd not found: $cwd)"
    return
  fi

  local reload_flag=()
  case "$(printf '%s' "$reload" | tr '[:upper:]' '[:lower:]')" in
    0|false|no|off) reload_flag=() ;;
    *) reload_flag=(--reload) ;;
  esac

  if [ -x "$venv/bin/python" ]; then
    echo "[dev] Starting $name on $host:$port ($app)"
    (cd "$cwd" && "$venv/bin/python" -m uvicorn "$app" --host "$host" --port "$port" "${reload_flag[@]}") &
    pids+=("$!")
    return
  fi

  if command -v uvicorn >/dev/null 2>&1; then
    echo "[dev] Starting $name on $host:$port ($app) (system uvicorn)"
    (cd "$cwd" && uvicorn "$app" --host "$host" --port "$port" "${reload_flag[@]}") &
    pids+=("$!")
    return
  fi

  echo "[dev] WARN: Skipping $name (no venv python or uvicorn)"
}

if [ "$ENABLE_LEGACY_VOICE_LOOP" = "1" ]; then
  if [ "${SKIP_KOKORO:-0}" != "1" ]; then
    start_uvicorn "Kokoro" "$KOKORO_VENV" "$KOKORO_CWD" "$KOKORO_APP" "$KOKORO_HOST" "$KOKORO_PORT" "$KOKORO_RELOAD"
  fi

  if [ "${SKIP_XTTS:-0}" != "1" ]; then
    start_uvicorn "XTTS" "$XTTS_VENV" "$XTTS_CWD" "$XTTS_APP" "$XTTS_HOST" "$XTTS_PORT" "$XTTS_RELOAD"
  fi

  if [ "${SKIP_WHISPER:-0}" != "1" ]; then
    start_uvicorn "Whisper" "$WHISPER_VENV" "$WHISPER_CWD" "$WHISPER_APP" "$WHISPER_HOST" "$WHISPER_PORT" "$WHISPER_RELOAD"
  fi
else
  echo "[dev] Legacy STT/TTS services disabled (control plane mode)."
fi

echo "[dev] Starting Node server…"
npm run -s dev:server
