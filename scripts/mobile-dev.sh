#!/bin/bash
# Start the full Kanna Mobile dev pipeline in isolation.
#
# Runs three services in a tmux session:
#   1. Relay broker   — local WebSocket router (SKIP_AUTH mode)
#   2. kanna-server   — bridges relay ↔ daemon + DB
#   3. tauri ios dev  — mobile app on device
#
# All state is isolated to this worktree:
#   - Relay on port from .kanna/config.json (KANNA_RELAY_PORT)
#   - kanna-server config in {worktree}/.kanna-mobile/server.toml
#   - Daemon dir at {worktree}/.kanna-daemon/
#   - DB from the worktree's desktop app instance
#
# Usage:
#   ./scripts/mobile-dev.sh              # start all services
#   ./scripts/mobile-dev.sh stop         # stop everything
#   ./scripts/mobile-dev.sh restart      # stop + start
#   ./scripts/mobile-dev.sh log [window] # show logs (relay|server|mobile)
#   ./scripts/mobile-dev.sh status       # check what's running
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="kanna-mobile-$(basename "$ROOT")"
MOBILE_DIR="$ROOT/apps/mobile"
RELAY_DIR="$ROOT/services/relay"
CONFIG_DIR="$ROOT/.kanna-mobile"
SERVER_CONFIG="$CONFIG_DIR/server.toml"
DAEMON_DIR="$ROOT/.kanna-daemon"

# Read ports from .kanna/config.json
read_port() {
  local key="$1"
  local default="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -r ".ports.${key} // ${default}" "$ROOT/.kanna/config.json" 2>/dev/null || echo "$default"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import json; d=json.load(open('$ROOT/.kanna/config.json')); print(d.get('ports',{}).get('$key',$default))" 2>/dev/null || echo "$default"
  else
    echo "$default"
  fi
}

RELAY_PORT="$(read_port KANNA_RELAY_PORT 9080)"
MOBILE_PORT="$(read_port KANNA_MOBILE_PORT 1421)"

# DB path — same as what the desktop Tauri app uses
# Use the worktree's DB, matching the logic in stores/db.ts
WT_NAME="$(basename "$ROOT")"
DB_PATH="$HOME/Library/Application Support/com.kanna.app/kanna-wt-${WT_NAME}.db"

generate_server_config() {
  mkdir -p "$CONFIG_DIR"
  cat > "$SERVER_CONFIG" <<EOF
relay_url = "ws://localhost:${RELAY_PORT}"
device_token = "local-dev-token"
daemon_dir = "${DAEMON_DIR}"
db_path = "${DB_PATH}"
EOF
  echo "Generated kanna-server config at $SERVER_CONFIG"
}

check_deps() {
  # Ensure relay deps are installed
  if [ ! -d "$RELAY_DIR/node_modules" ]; then
    echo "Installing relay dependencies..."
    (cd "$RELAY_DIR" && bun install)
  fi
}

start() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session '$SESSION' already running. Use 'restart' or 'stop'."
    exit 1
  fi

  check_deps
  generate_server_config

  # Check that the desktop daemon is running
  if [ ! -d "$DAEMON_DIR" ]; then
    echo "WARNING: No daemon dir at $DAEMON_DIR"
    echo "Start the desktop dev server first: ./scripts/dev.sh"
    echo ""
  fi

  # Check that the DB exists
  if [ ! -f "$DB_PATH" ]; then
    echo "WARNING: No database at $DB_PATH"
    echo "Start the desktop app and create a repo first."
    echo ""
  fi

  echo "Starting mobile dev pipeline..."
  echo "  Relay:   localhost:${RELAY_PORT}"
  echo "  Server:  config at ${SERVER_CONFIG}"
  echo "  Mobile:  tauri ios dev (port ${MOBILE_PORT})"
  echo ""

  # Create tmux session with relay broker
  tmux new-session -d -s "$SESSION" -n relay -c "$RELAY_DIR"
  tmux send-keys -t "$SESSION:relay" \
    "PORT=${RELAY_PORT} SKIP_AUTH=true bun run dev" Enter

  # Wait for relay to start
  sleep 2

  # Window: kanna-server
  tmux new-window -t "$SESSION" -n server -c "$ROOT"
  tmux send-keys -t "$SESSION:server" \
    "KANNA_SERVER_CONFIG=${SERVER_CONFIG} RUST_LOG=info cargo run --manifest-path crates/kanna-server/Cargo.toml" Enter

  # Window: tauri ios dev
  # --host makes Vite bind to LAN IP so the physical device can reach it.
  # Tauri sets TAURI_DEV_HOST which also updates __KANNA_RELAY_URL__ in vite.config.ts.
  # Auto-detect LAN IP for physical device connectivity.
  LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "localhost")
  echo "  LAN IP: ${LAN_IP}"
  tmux new-window -t "$SESSION" -n mobile -c "$MOBILE_DIR"
  tmux send-keys -t "$SESSION:mobile" \
    "KANNA_DEV_PORT=${MOBILE_PORT} KANNA_RELAY_PORT=${RELAY_PORT} bunx tauri ios dev --host ${LAN_IP}" Enter

  echo "Started tmux session '$SESSION' with 3 windows: relay, server, mobile"
  echo "Attach with: tmux attach -t $SESSION"
}

stop() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    # Send Ctrl-C to all windows first
    for win in relay server mobile; do
      tmux send-keys -t "$SESSION:$win" C-c 2>/dev/null || true
    done
    sleep 1
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    echo "Stopped."
  else
    echo "No session running."
  fi
}

log() {
  local window="${1:-relay}"
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux capture-pane -t "$SESSION:$window" -p -S -50
  else
    echo "No session running."
  fi
}

status() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session: $SESSION (running)"
    echo ""
    for win in relay server mobile; do
      echo "=== $win ==="
      tmux capture-pane -t "$SESSION:$win" -p -S -3 2>/dev/null || echo "  (not found)"
      echo ""
    done
  else
    echo "Session: $SESSION (not running)"
  fi
}

CMD="${1:-start}"
case "$CMD" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  log)     log "$2" ;;
  status)  status ;;
  *)       echo "Usage: $0 {start|stop|restart|log [relay|server|mobile]|status}" ;;
esac
