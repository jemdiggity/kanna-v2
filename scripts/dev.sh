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
if [ -n "$KANNA_WORKTREE" ]; then
  # Derive a short name from the worktree path (e.g., task-abc123)
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
  tmux send-keys -t "$SESSION" "bun dev" Enter
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
