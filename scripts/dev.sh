#!/bin/bash
# Start (or restart) the Kanna dev environment in a tmux session.
#
# Usage:
#   ./scripts/dev.sh              # start desktop only
#   ./scripts/dev.sh --mobile     # start desktop + mobile pipeline
#   ./scripts/dev.sh stop         # stop the session
#   ./scripts/dev.sh stop -k      # stop the session and kill the daemon
#   ./scripts/dev.sh restart      # stop + start
#   ./scripts/dev.sh restart -k   # stop (kill daemon) + start
#   ./scripts/dev.sh log          # print desktop log
#   ./scripts/dev.sh log relay    # print relay log (--mobile)
#   ./scripts/dev.sh log server   # print kanna-server log (--mobile)
#   ./scripts/dev.sh log mobile   # print tauri ios dev log (--mobile)
#   ./scripts/dev.sh seed         # seed the DB with test data (no server start)
#   ./scripts/dev.sh start --seed # start + seed
set -e
ROOT="$(git rev-parse --show-toplevel)"

# Auto-detect worktree by checking if we're inside .kanna-worktrees/
if [ -n "$KANNA_WORKTREE" ] || echo "$ROOT" | grep -q '\.kanna-worktrees/'; then
  export KANNA_WORKTREE=1
  WORKTREE_NAME="$(basename "$ROOT")"
  SESSION="kanna-${WORKTREE_NAME}"
else
  SESSION="kanna"
fi

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

start_mobile() {
  local RELAY_PORT
  RELAY_PORT="$(read_port KANNA_RELAY_PORT 9080)"
  local MOBILE_PORT
  MOBILE_PORT="$(read_port KANNA_MOBILE_PORT 1421)"
  local CONFIG_DIR="$ROOT/.kanna-mobile"
  local SERVER_CONFIG="$CONFIG_DIR/server.toml"
  local DAEMON_DIR="$ROOT/.kanna-daemon"
  # Use the worktree's DB, matching the logic in stores/db.ts
  local WT_NAME
  WT_NAME="$(basename "$ROOT")"
  local DB_PATH="$HOME/Library/Application Support/com.kanna.app/kanna-wt-${WT_NAME}.db"

  # Install relay deps if needed
  if [ ! -d "$ROOT/services/relay/node_modules" ]; then
    echo "Installing relay dependencies..."
    (cd "$ROOT/services/relay" && bun install)
  fi

  # Generate kanna-server config
  mkdir -p "$CONFIG_DIR"
  cat > "$SERVER_CONFIG" <<EOF
relay_url = "ws://localhost:${RELAY_PORT}"
device_token = "local-dev-token"
daemon_dir = "${DAEMON_DIR}"
db_path = "${DB_PATH}"
EOF

  echo "  Relay:   localhost:${RELAY_PORT}"
  echo "  Server:  ${SERVER_CONFIG}"
  echo "  Mobile:  tauri ios dev (port ${MOBILE_PORT})"

  # Write mobile tauri.conf.local.json with the isolated port
  local MOBILE_LOCAL_CONF="$ROOT/apps/mobile/src-tauri/tauri.conf.local.json"
  cat > "$MOBILE_LOCAL_CONF" <<MEOF
{
  "build": {
    "devUrl": "http://localhost:${MOBILE_PORT}"
  }
}
MEOF

  # Window: relay broker
  tmux new-window -t "$SESSION" -n relay -c "$ROOT/services/relay"
  tmux send-keys -t "$SESSION:relay" \
    "PORT=${RELAY_PORT} SKIP_AUTH=true bun run dev" Enter

  # Wait for relay to start
  sleep 2

  # Window: kanna-server
  tmux new-window -t "$SESSION" -n server -c "$ROOT"
  tmux send-keys -t "$SESSION:server" \
    "KANNA_SERVER_CONFIG=${SERVER_CONFIG} RUST_LOG=info cargo run --manifest-path crates/kanna-server/Cargo.toml" Enter

  # Write mobile tauri.conf.local.json with the isolated port
  local MOBILE_LOCAL_CONF="$ROOT/apps/mobile/src-tauri/tauri.conf.local.json"
  cat > "$MOBILE_LOCAL_CONF" <<MEOF
{
  "build": {
    "devUrl": "http://localhost:${MOBILE_PORT}"
  }
}
MEOF

  # Window: tauri ios dev
  tmux new-window -t "$SESSION" -n mobile -c "$ROOT/apps/mobile"
  tmux send-keys -t "$SESSION:mobile" \
    "KANNA_DEV_PORT=${MOBILE_PORT} KANNA_RELAY_PORT=${RELAY_PORT} bunx tauri ios dev" Enter
}

start() {
  # SAFETY: never run the dev server against the production database
  local _db="${KANNA_DB_NAME:-kanna-v2.db}"
  if [ -n "$KANNA_WORKTREE" ]; then
    _db="kanna-wt-$(basename "$ROOT").db"
  fi
  if [ "$_db" = "kanna-v2.db" ]; then
    echo "REFUSED: dev.sh will not start against the production database (kanna-v2.db)."
    echo "Run from a worktree, or set KANNA_DB_NAME to a non-production name."
    exit 1
  fi

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session '$SESSION' already running. Use 'restart' or 'stop'."
    exit 1
  fi
  tmux new-session -d -s "$SESSION" -n desktop -c "$ROOT"
  # Forward all KANNA_* env vars into the tmux session
  EXPORTS="$(env | grep '^KANNA_' | sed "s/^\([^=]*\)=\(.*\)/export \1='\2'/" | tr '\n' ' ')"

  # In worktrees, write a local Tauri config override with the isolated port
  # (must exist before tauri dev parses --config)
  DEV_CMD="bun dev"
  LOCAL_CONF="$ROOT/apps/desktop/src-tauri/tauri.conf.local.json"
  if [ -n "$KANNA_WORKTREE" ] && [ -n "$KANNA_DEV_PORT" ]; then
    cat > "$LOCAL_CONF" <<LOCALEOF
{
  "build": {
    "devUrl": "http://localhost:$KANNA_DEV_PORT"
  }
}
LOCALEOF
    DEV_CMD="bun dev -- --config $LOCAL_CONF"
  fi

  if [ -n "$EXPORTS" ]; then
    tmux send-keys -t "$SESSION:desktop" "$EXPORTS&& $DEV_CMD" Enter
  else
    tmux send-keys -t "$SESSION:desktop" "$DEV_CMD" Enter
  fi

  if $MOBILE; then
    start_mobile
  fi

  echo "Started tmux session '$SESSION'. Attach with: tmux attach -t $SESSION"
}

kill_daemon() {
  local pid_file="$ROOT/.kanna-daemon/daemon.pid"
  if [ -f "$pid_file" ]; then
    local pid
    pid="$(cat "$pid_file")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "Killed daemon (pid=$pid)."
    else
      echo "Daemon not running (stale pid=$pid)."
      rm -f "$pid_file"
    fi
  else
    echo "No daemon pid file found."
  fi
}

stop() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    # Send Ctrl-C to all windows
    for win in $(tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null); do
      tmux send-keys -t "$SESSION:$win" C-c 2>/dev/null || true
    done
    sleep 1
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    echo "Stopped."
  else
    echo "No session running."
  fi
  if $KILL_DAEMON; then
    kill_daemon
  fi
}

log() {
  local window="${1:-desktop}"
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux capture-pane -t "$SESSION:$window" -p -S -50
  else
    echo "No session running."
  fi
}

seed() {
  local APP_DATA_DIR="$HOME/Library/Application Support/com.kanna.app"

  # Resolve DB name using the same logic as the app (db.ts)
  local DB_NAME="${KANNA_DB_NAME:-kanna-v2.db}"
  if [ -n "$KANNA_WORKTREE" ]; then
    DB_NAME="kanna-wt-$(basename "$ROOT").db"
  fi

  # SAFETY: never seed the production database
  if [ "$DB_NAME" = "kanna-v2.db" ]; then
    echo "REFUSED: will not seed production database (kanna-v2.db)."
    echo "Run from a worktree, or set KANNA_DB_NAME to a non-production name."
    exit 1
  fi

  local DB_PATH="$APP_DATA_DIR/$DB_NAME"
  local SEED_SQL="$ROOT/apps/desktop/tests/e2e/seed.sql"

  if [ ! -f "$SEED_SQL" ]; then
    echo "Seed file not found: $SEED_SQL"
    exit 1
  fi

  mkdir -p "$APP_DATA_DIR"
  sqlite3 "$DB_PATH" < "$SEED_SQL"
  echo "Seeded $DB_PATH"
}

ATTACH=false
KILL_DAEMON=false
SEED=false
MOBILE=false
for arg in "$@"; do
  case "$arg" in
    --attach|-a) ATTACH=true ;;
    --kill-daemon|-k) KILL_DAEMON=true ;;
    --seed|-s) SEED=true ;;
    --mobile|-m) MOBILE=true ;;
  esac
done

CMD="${1:-start}"
# Don't treat flags as the command
case "$CMD" in
  --*|-*) CMD="start" ;;
esac

case "$CMD" in
  start)   start; $SEED && seed; $ATTACH && tmux attach -t "$SESSION" ;;
  stop)    stop ;;
  restart) stop; sleep 1; start; $SEED && seed; $ATTACH && tmux attach -t "$SESSION" ;;
  log)     log "$2" ;;
  seed)    seed ;;
  *)       echo "Usage: $0 {start|stop|restart|log [window]|seed} [--mobile] [--seed] [--attach] [--kill-daemon]" ;;
esac
