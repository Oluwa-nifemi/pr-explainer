#!/usr/bin/env bash
# Starts everything PR Explainer needs on this machine: the Claude Code bridge when Claude Code
# is installed and signed in, then the containers.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="${HOME}/.cache/pr-explainer"
PIDFILE="${STATE}/bridge.pid"
LOG="${STATE}/bridge.log"
PLIST_SRC="${REPO}/bridge/com.nifemi.pr-explainer-claude-bridge.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/com.nifemi.pr-explainer-claude-bridge.plist"
PORT="${BRIDGE_PORT:-5191}"

build=1
install_service=0
stop_only=0

usage() {
  cat <<'TXT'
Usage: ./start.sh [options]

  (no options)        Start the bridge if Claude Code is signed in, then the containers
  --no-build          Skip rebuilding the images
  --install-service   Also start the bridge at login (macOS)
  --stop              Stop the bridge and the containers
  -h, --help          This text
TXT
}

for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    --install-service) install_service=1 ;;
    --stop) stop_only=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

have() { command -v "$1" >/dev/null 2>&1; }
say() { printf '%s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }

bridge_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && printf '%s' "$pid"
}

bridge_healthy() {
  curl -fsS -m 3 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

stop_bridge() {
  local pid
  if pid="$(bridge_pid)"; then
    kill "$pid" 2>/dev/null || true
    say "stopped the bridge (pid ${pid})"
  fi
  rm -f "$PIDFILE"
}

start_bridge() {
  mkdir -p "$STATE"
  local pid
  if pid="$(bridge_pid)"; then
    if [ "${REPO}/bridge/claude-bridge.js" -nt "$PIDFILE" ]; then
      say "restarting the bridge, its code changed"
      stop_bridge
    else
      say "bridge already running (pid ${pid})"
      return 0
    fi
  fi
  BRIDGE_PORT="$PORT" nohup node "${REPO}/bridge/claude-bridge.js" >>"$LOG" 2>&1 &
  printf '%s' "$!" >"$PIDFILE"
  for _ in $(seq 1 40); do
    bridge_healthy && { say "bridge on http://127.0.0.1:${PORT} (log ${LOG})"; return 0; }
    sleep 0.25
  done
  warn "the bridge did not answer on port ${PORT}. Look at ${LOG}"
  return 1
}

install_launchd() {
  if [ "$(uname -s)" != "Darwin" ]; then
    warn "--install-service only works on macOS"
    return 0
  fi
  mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"
  sed -e "s#__NODE__#$(command -v node)#" \
      -e "s#__REPO__#${REPO}#" \
      -e "s#__HOME__#${HOME}#g" \
      "$PLIST_SRC" >"$PLIST_DST"
  launchctl unload "$PLIST_DST" >/dev/null 2>&1 || true
  launchctl load "$PLIST_DST"
  say "the bridge now starts at login (${PLIST_DST})"
}

claude_state() {
  have claude || { printf 'missing'; return; }
  if claude auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
    printf 'ready'
  else
    printf 'signed-out'
  fi
}

if [ "$stop_only" = 1 ]; then
  stop_bridge
  if have docker; then docker compose -f "${REPO}/docker-compose.yml" down; fi
  exit 0
fi

have docker || { warn "docker is not installed. Install Docker Desktop, then run this again."; exit 1; }
docker info >/dev/null 2>&1 || { warn "Docker is not running. Start Docker Desktop, then run this again."; exit 1; }
have node || { warn "node is not installed. Install Node 22 or newer."; exit 1; }

case "$(claude_state)" in
  ready)
    start_bridge
    [ "$install_service" = 1 ] && install_launchd
    ;;
  signed-out)
    warn "Claude Code is installed but not signed in, so the bridge is not started."
    warn "Run: claude auth login    (or pick LiteLLM on the Connections screen)"
    ;;
  missing)
    warn "Claude Code is not installed, so the bridge is not started."
    warn "Install it to write stories with your subscription, or pick LiteLLM in the app."
    ;;
esac

if [ "$build" = 1 ]; then
  docker compose -f "${REPO}/docker-compose.yml" up -d --build
else
  docker compose -f "${REPO}/docker-compose.yml" up -d
fi

say ""
say "PR Explainer is up: http://127.0.0.1:5180"
say "Settings → Connections shows what it can reach."
