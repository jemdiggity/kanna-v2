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
SESSION="kanna"

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

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  log)     log ;;
  *)       echo "Usage: $0 {start|stop|restart|log}" ;;
esac
