---
name: verify
description: Drive a real kanna-daemon over its unix socket to verify protocol/session changes end-to-end.
---

# Verifying kanna-daemon changes against a live daemon

Build and launch an isolated daemon (never reuse the user's instances):

```bash
cargo build -p kanna-daemon                 # binary lands in .build/debug/ (repo-root .cargo config)
KANNA_DAEMON_DIR=$(mktemp -d) .build/debug/kanna-daemon > /tmp/daemon-stdout.log 2>&1 &
```

The daemon derives its socket from the dir hash and logs it at startup:
`grep -o 'socket="[^"]*"' $KANNA_DAEMON_DIR/kanna-daemon_*.log` → `/tmp/kanna-XXXXXXXX.sock`.

Protocol is line-delimited JSON over the unix socket, tagged with `"type"`
(see `crates/daemon/src/protocol.rs`). A minimal python client works well:
connect `AF_UNIX`, send one JSON object per line, read line-delimited events.
Async `Output`/`Exit` events interleave with command replies on the same
stream — skip them when waiting for a reply.

Useful command shapes:

```json
{"type":"Spawn","session_id":"v1","executable":"/bin/zsh","args":["-c","sleep 300"],"cwd":"/tmp","env":{},"cols":80,"rows":24}
{"type":"Kill","session_id":"v1"}
{"type":"List"}
```

Key flows worth driving: spawn → kill → more commands **on the same
connection** (each connection has one sequential command loop, so any
blocking command wedges everything queued behind it — this is how task
creation hung once); double-kill and kill-unknown for error paths; `ps -p
<child pid>` after kill to confirm the child was reaped (no zombie).

Cleanup: `kill $(cat $KANNA_DAEMON_DIR/daemon.pid)` and remove the socket.
