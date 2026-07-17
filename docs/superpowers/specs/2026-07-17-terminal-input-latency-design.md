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
A handle has a bounded command channel and a worker task. The worker caches the
resolved daemon session id, owns one persistent `DaemonClient`, and processes
input and resize commands in order. Terminal output remains on its existing,
independent attach connection so a control acknowledgement can never delay PTY
output forwarding.

Successful terminal attachment supplies the authoritative route to the
control map. A route change gracefully detaches and replaces the old worker,
which preserves task-stage session replacement and releases its daemon-side
resize ownership. A command received before attachment creates a worker that
resolves its route once on a blocking worker. Terminal detach and WebSocket
shutdown retire both the output attachment and the control worker.

The WebSocket reader validates and decodes terminal frames, then enqueues them
without waiting for SQLite, a socket connection, or a daemon reply. Queue
overflow reports an explicit error instead of growing memory without bound.
The worker reconnects its daemon client after a transport failure, with bounded
backoff, so daemon handoff does not permanently strand input.

KSP API request dispatch runs concurrently with frame reading. The request's
Axum dispatch is driven from `spawn_blocking`, because the current handlers
contain synchronous SQLite, filesystem, and process work. Responses retain
their request ids and may complete out of order, as the protocol already
supports. Agent commands use a separate bounded FIFO worker, preserving their
wire order without blocking terminal frames. Task/session route resolution also
runs through `spawn_blocking`.

## Protocol Correctness

The server treats terminal input as opaque bytes after base64 decoding. The
single ordered control queue preserves Kitty sequences, bracketed paste
payloads, ordinary typing, and resize ordering. The frontend continues to batch
normal input for 8 ms and flushes queued bytes before immediate control
responses. No local echo is introduced.

Output attachment reconnect remains independent and unchanged. On terminal
reattach, the route is re-resolved; if a task stage now points to a replacement
daemon session, both the output task and control worker are replaced. On daemon
socket loss, output reattaches from a fresh snapshot while control reconnects
before processing subsequent commands. If a control socket disappears without
an explicit detach, daemon connection cleanup reapplies the remaining clients'
effective terminal size so another window is not left at the stale dimensions.

## Failure Handling

- Bad base64 remains a synchronous `bad_frame` protocol error.
- Missing routes produce `no_session` from the control worker or attach path.
- Unexpected daemon replies and transport failures produce asynchronous
  task-addressed `daemon` errors.
- A full terminal control queue produces a `terminal_busy` error and leaves the
  WebSocket reader responsive.
- Worker and attachment tasks are aborted when the KSP connection shuts down.

## Tests and Latency Budget

Focused Rust KSP tests use a fake daemon and a locked SQLite write to prove:

- input reaches the daemon while an earlier same-WebSocket request is blocked;
- repeated input and resize frames reuse one control socket and preserve order;
- the worker reconnects after its daemon connection is replaced;
- reattachment replaces a cached route when the task's daemon session changes;
- detach releases control-socket resize ownership and daemon cleanup restores
  the remaining client's effective size after an abrupt disconnect.

Focused TypeScript tests exercise the 8 ms queue directly, including rapid
keypress coalescing, opaque Kitty/paste bytes, immediate-flush ordering, and
recovery after a client-acquisition failure. Existing `useTerminal` coverage
continues to prove xterm wiring and resize behavior.

The real PTY E2E starts a deterministic echo shell, launches a 750 ms server
job over the same shared KSP WebSocket, sends terminal input through xterm, and
measures until echoed bytes appear in the xterm buffer. Echo must render in
under 500 ms while the server job is still active. The old sequential KSP loop
cannot satisfy this bound; the new isolated control path can.
