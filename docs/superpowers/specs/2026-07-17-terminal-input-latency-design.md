# Terminal Input Latency Design

## Problem

Desktop terminal keystrokes already travel over the shared KSP WebSocket, but
the server still handles every `term_input` frame as a synchronous request. It
opens SQLite to resolve the task's daemon session, opens a new daemon Unix
socket, sends one command, and waits for the daemon reply before reading the
next WebSocket frame. KSP API requests are awaited in that same reader loop.
Because terminal echo must return through the PTY, daemon output attachment,
KSP, WebSocket, and xterm, either delay becomes visible typing latency.

The existing 8 ms frontend batching is desirable. It reduces per-keystroke
overhead and preserves opaque byte sequences, but it cannot compensate for
server-side scheduler stalls or request head-of-line blocking.

## Architecture

Each KSP connection owns a map of terminal control handles keyed by task id.
A handle has a bounded command channel, an explicit cancellation signal, and a
worker task. The worker caches the resolved daemon session id, owns one
persistent daemon socket, and writes input and resize commands in FIFO order.
These commands are explicitly one-way: the daemon sends no success
acknowledgement, but may send an asynchronous error. Terminal output remains on
its existing, independent attach connection.

Successful terminal attachment supplies the authoritative route to the
control map. A route change cancels and joins the old worker before starting
the replacement, which prevents queued stale input from reaching the previous
task-stage session and releases the old socket's daemon-side resize ownership.
A command received before attachment creates a worker that resolves its route
once on a blocking worker. Terminal detach and WebSocket shutdown cancel both
the output attachment and control worker.

The WebSocket reader validates and decodes terminal frames, then enqueues them
without waiting for SQLite, a socket connection, or a daemon reply. Queue
overflow reports an explicit error instead of growing memory without bound.
The worker reconnects after transport loss, with bounded backoff, before taking
the next queued command. A command whose socket write fails is never replayed:
the write may already have reached the daemon, so retrying could duplicate a
paste or execute a shell command twice. This gives terminal input explicit
at-most-once semantics across ambiguous disconnects while allowing later input
to recover on a replacement daemon.

KSP API request dispatch uses a bounded queue and a CPU-aware concurrency cap
that leaves at least one logical CPU outside KSP request work when the machine
has more than one. Each job drives Axum dispatch from `spawn_blocking`, because
the current handlers contain synchronous SQLite, filesystem, and process work.
Bounding those outer jobs also leaves blocking-pool capacity for nested handler
`spawn_blocking` work. Responses retain their request ids and may complete out
of order; queue overflow returns an ID-addressed 503. Agent commands use a
separate bounded FIFO worker. Task/session route resolution also runs through
`spawn_blocking`.

## Protocol Correctness

The server treats terminal input as opaque bytes after base64 decoding. The
single ordered control queue and one-way daemon socket preserve Kitty
sequences, bracketed paste payloads, ordinary typing, and resize ordering. A
missing success acknowledgement cannot stall later commands because successful
one-way commands have no acknowledgement. The frontend continues to batch
normal input for 8 ms and flushes queued bytes before immediate control
responses. No local echo is introduced.

Output attachment reconnect remains independent and unchanged. On terminal
reattach, the route is re-resolved; if a task stage now points to a replacement
daemon session, both the output task and control worker are replaced. On daemon
socket loss, output reattaches from a fresh snapshot while control reconnects
before processing subsequent commands. Cancellation is observed during route
lookup, connection, socket I/O, and reconnect backoff. If a control socket
disappears without an explicit detach, daemon connection cleanup reapplies the
remaining clients' effective terminal size so another window is not left at
the stale dimensions.

## Failure Handling

- Bad base64 remains a synchronous `bad_frame` protocol error.
- Missing routes produce `no_session` from the control worker or attach path.
- Daemon-side one-way failures and ambiguous transport writes produce
  asynchronous task-addressed `daemon` errors; ambiguous commands are dropped.
- A full terminal control queue produces a `terminal_busy` error and leaves the
  WebSocket reader responsive.
- Worker and attachment tasks are cancelled and joined when their route or KSP
  connection shuts down.

## Tests and Latency Budget

Focused Rust KSP tests use a fake daemon and a locked SQLite write to prove:

- input reaches the daemon while an earlier same-WebSocket request is blocked;
- repeated input and resize frames reuse one control socket and preserve order;
- the worker reconnects after its daemon connection is replaced;
- reattachment replaces a cached route when the task's daemon session changes;
- a consumed input followed by socket close is not replayed;
- withheld success acknowledgements cannot stall later input or resize;
- cancellation during reconnect/backoff discards stale queued input;
- bounded request saturation leaves terminal input responsive;
- detach releases control-socket resize ownership and daemon cleanup restores
  the remaining client's effective size after an abrupt disconnect.

Focused TypeScript tests exercise the 8 ms queue directly, including rapid
keypress coalescing, opaque Kitty/paste bytes, immediate-flush ordering, and
recovery after a client-acquisition failure. Existing `useTerminal` coverage
continues to prove xterm wiring and resize behavior.

The real PTY E2E starts a deterministic echo shell, launches bounded CPU work
over the same shared KSP WebSocket, sends terminal input through xterm, and
measures until echoed bytes appear in the xterm buffer. Echo must render in
under 500 ms while the server job is still active. The old sequential KSP loop
cannot satisfy this bound; the new isolated control path can.

The real-PTY suite also sends input through xterm/KSP before and after daemon
handoff, and before and after a durable task's terminal-session route changes.
Those cases exercise the WebSocket/control/daemon/PTY path rather than direct
Tauri `send_input`.
