#!/bin/bash
# Start (or restart) the Kanna dev environment in a tmux session.
#
# Usage:
#   ./scripts/dev.sh              # start or reattach
#   ./scripts/dev.sh stop         # stop the session
#   ./scripts/dev.sh stop -k      # stop the session and kill the daemon
#   ./scripts/dev.sh restart      # stop + start
#   ./scripts/dev.sh restart -k   # stop (kill daemon) + start
#   ./scripts/dev.sh log          # print recent output
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

start() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Session '$SESSION' already running. Use 'restart' or 'stop'."
    exit 1
  fi
  tmux new-session -d -s "$SESSION" -c "$ROOT"
  # Forward all KANNA_* env vars into the tmux session
  EXPORTS="$(env | grep '^KANNA_' | sed 's/^/export /' | tr '\n' ' ')"

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
    tmux send-keys -t "$SESSION" "$EXPORTS&& $DEV_CMD" Enter
  else
    tmux send-keys -t "$SESSION" "$DEV_CMD" Enter
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
    tmux send-keys -t "$SESSION" C-c
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
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux capture-pane -t "$SESSION" -p -S -50
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
for arg in "$@"; do
  case "$arg" in
    --attach|-a) ATTACH=true ;;
    --kill-daemon|-k) KILL_DAEMON=true ;;
    --seed|-s) SEED=true ;;
  esac
done

CMD="${1:-start}"
case "$CMD" in
  start)   start; $SEED && seed; $ATTACH && tmux attach -t "$SESSION" ;;
  stop)    stop ;;
  restart) stop; sleep 1; start; $SEED && seed; $ATTACH && tmux attach -t "$SESSION" ;;
  log)     log ;;
  seed)    seed ;;
  *)       echo "Usage: $0 {start|stop|restart|log|seed} [--attach] [--kill-daemon] [--seed]" ;;
esac
