#!/bin/bash
# Start (or restart) the Kanna dev environment in a tmux session.
#
# Usage:
#   ./scripts/dev.sh          # start or reattach
#   ./scripts/dev.sh stop     # stop the session
#   ./scripts/dev.sh restart  # stop + start
#   ./scripts/dev.sh log      # print recent output
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

stop() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux send-keys -t "$SESSION" C-c
    sleep 1
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    echo "Stopped."
  else
    echo "No session running."
  fi
}

log() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    tmux capture-pane -t "$SESSION" -p -S -50
  else
    echo "No session running."
  fi
}

ATTACH=false
for arg in "$@"; do
  case "$arg" in --attach|-a) ATTACH=true ;; esac
done

CMD="${1:-start}"
case "$CMD" in
  start)   start; $ATTACH && tmux attach -t "$SESSION" ;;
  stop)    stop ;;
  restart) stop; sleep 1; start; $ATTACH && tmux attach -t "$SESSION" ;;
  log)     log ;;
  *)       echo "Usage: $0 {start|stop|restart|log} [--attach]" ;;
esac
