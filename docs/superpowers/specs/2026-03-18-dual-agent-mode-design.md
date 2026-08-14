# Dual Agent Mode + CLI Contract Tests — Design Spec

**Date:** 2026-03-18
**Status:** Draft
**Author:** Jeremy Hale + Claude

## Overview

Two features:

1. **CLI contract tests** — a test suite that validates our assumptions about how `claude` CLI actually behaves. Runs against the real binary. Catches behavioral changes before they break the app (like the `dont-ask` → `dontAsk` flag change).

2. **Dual agent mode** — support running Claude in two modes:
   - **PTY mode** (default for user tasks): Claude runs in a real terminal via the daemon. User sees Claude's native interactive UI. State tracked via `--settings` hooks.
   - **SDK mode** (for agent personas): Claude runs headless with structured NDJSON. Programmatic control via the agent SDK.

The CLI contract tests are a prerequisite — we validate assumptions before building on them.

## Part 1: CLI Contract Tests

### Purpose

Document and verify Claude CLI's actual behavior as a contract. When Claude updates and changes behavior, these tests fail first.

### Location

```
tests/cli-contract/
├── package.json           # bun test runner
├── bunfig.toml            # timeout config
├── helpers/
│   └── claude.ts          # spawn Claude CLI, capture output
└── tests/
    ├── flags.test.ts      # CLI flag behavior
    ├── settings.test.ts   # --settings merge/override behavior
    ├── hooks.test.ts      # hook execution and timing
    ├── output.test.ts     # output format validation
    └── worktree.test.ts   # worktree permission scoping
```

### Helper

`helpers/claude.ts` — thin wrapper to spawn Claude CLI and capture results:

```typescript
interface ClaudeResult {
  stdout: string
  stderr: string
  exitCode: number
  lines: Array<{ type: string; [key: string]: unknown }>  // parsed NDJSON
  duration: number
}

async function runClaude(opts: {
  prompt: string
  flags?: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}): Promise<ClaudeResult>

function findClaudeBinary(): string
```

### Tests

#### flags.test.ts
- `--output-format stream-json` produces valid NDJSON (each line parses as JSON)
- `--output-format stream-json` output includes `system`, `assistant`, and `result` type messages
- `--max-turns 1` limits Claude to a single turn
- `-p "prompt"` with no stdin produces output and exits
- `--verbose` doesn't change the JSON output format (still valid NDJSON)
- `--permission-mode dontAsk` is accepted (not `dont-ask`)
- `--permission-mode acceptEdits` is accepted (not `accept-edits`)
- Exit code is 0 on successful completion

#### settings.test.ts
- `--settings '{"hooks":{}}'` is accepted without error
- `--settings` merges with (does not replace) project `.claude/settings.json`
- `--settings` with hook config causes hooks to fire
- `--settings` with invalid JSON produces a clear error
- Multiple `--settings` flags — does the last one win or do they merge?

#### hooks.test.ts
- `Stop` hook fires when Claude finishes
- Hook command receives expected env vars (`CLAUDE_SESSION_ID` etc.)
- Hook command's stdout is captured (for `SessionStart` hook responses)
- Hook fires even with `--max-turns 1`
- Hook command timeout behavior — does Claude wait or continue?
- **The exact Kanna hook JSON format works**: `--settings '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"..."}]}],"PostToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"..."}]}]}}'` — this is the single highest-value test

#### output.test.ts
- `result` message contains `session_id`, `num_turns`, `duration_ms`
- `result` message `subtype` is `"success"` on normal completion
- `assistant` message contains `content` array with `text` and/or `tool_use` blocks
- `system` messages appear before `assistant` messages
- `system` subtype `"init"` message contains `session_id` and `cwd`

#### worktree.test.ts
- Claude running in a worktree can read files
- Permissions from the main checkout's `.claude/settings.local.json` apply in worktrees
- `--settings` hooks work in worktree context
- Worktree `cwd` is reported correctly in the `init` system message

### Running

```bash
cd tests/cli-contract
bun test                    # all contract tests
bun test tests/flags.test.ts  # specific file
```

Requires `claude` in PATH with valid auth. Tests use `--max-turns 1`, `--model haiku`, and simple prompts to minimize cost and time (~1-2s per test).

## Part 2: Dual Agent Mode

### Agent Types

| | PTY Mode | SDK Mode |
|---|---|---|
| Default for | User-created tasks | Agent personas (future) |
| UI | xterm.js (TerminalView) | Structured (AgentView) |
| Claude runs as | Interactive terminal process | Headless `--output-format stream-json` |
| State tracking | `--settings` hooks → daemon | NDJSON message parsing |
| Process management | Daemon (PTY, persists across restarts) | Agent SDK (in-process, dies with app) |
| User interaction | Full terminal — can type, scroll, etc. | Read-only message stream |

### Data Model

`pipeline_item.agent_type` column values:
- `"pty"` — PTY mode (default for user tasks)
- `"sdk"` — SDK mode (for agent personas)

### PTY Mode Flow

1. **App startup**: Check for daemon (PID file at `~/Library/Application Support/Kanna/daemon.pid` + socket probe at `daemon.sock`). Spawn if not found.
2. **Task creation**: User creates task → git worktree created → the Tauri backend builds the Claude command with the session UUID interpolated into the hook settings, then sends `Spawn` to the daemon:
   ```typescript
   // In useWorkflow.ts — build the claude command with hooks
   const hookSettings = JSON.stringify({
     hooks: {
       Stop: [{ hooks: [{ type: "command", command: `kanna-hook stop ${sessionId}` }] }],
       PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `kanna-hook tool ${sessionId}` }] }],
     }
   });
   const claudeCmd = `claude --dangerously-skip-permissions --settings '${hookSettings}'`;

   await invoke("spawn_session", {
     sessionId, cwd: worktreePath,
     executable: "/bin/zsh", args: ["--login", "-c", claudeCmd],
     env: {}, cols: 80, rows: 24,
   });
   ```
   The `spawn_session` Tauri command should read back the daemon's `SessionCreated` or `Error` response before returning, so the frontend knows if the spawn succeeded.
3. **Terminal streaming**: Daemon reads PTY output → sends `Output` events over Unix socket → Tauri backend receives → emits `terminal_output` Tauri event → xterm.js renders.
4. **Hook notifications**: When Claude fires a hook, the hook command (`kanna-hook`) writes a JSON message to the daemon socket:
   ```json
   {"type":"HookEvent","session_id":"SESSION_ID","event":"Stop","data":{}}
   ```
   Daemon relays → Tauri event `hook_event` → frontend updates workflow state.
5. **Completion**: Process exit → daemon sends `Exit` event → task marked complete.

### Hook Notification Binary

`kanna-hook` — a compiled Rust binary in the workspace (`crates/kanna-hook/`). Must be compiled, not a shell script — `nc -U` is unreliable for fire-and-forget socket writes on macOS (buffering, no flush guarantee, silent drops on early exit).

```rust
// crates/kanna-hook/src/main.rs
// Usage: kanna-hook <event> <session_id> [data_json]
// Connects to daemon socket, writes HookEvent, flushes, exits.
fn main() {
    let event = std::env::args().nth(1).expect("event arg");
    let session_id = std::env::args().nth(2).expect("session_id arg");
    let socket_path = format!("{}/Library/Application Support/Kanna/daemon.sock",
        std::env::var("HOME").unwrap());
    let mut stream = std::os::unix::net::UnixStream::connect(socket_path).unwrap();
    let msg = format!("{{\"type\":\"HookEvent\",\"session_id\":\"{}\",\"event\":\"{}\"}}\n",
        session_id, event);
    std::io::Write::write_all(&mut stream, msg.as_bytes()).unwrap();
    std::io::Write::flush(&mut stream).unwrap();
}
```

Bundled alongside the daemon as a Tauri sidecar or installed to a known path.

### Daemon Protocol Changes

Add to `crates/daemon/src/protocol.rs`:

```rust
// New command type (hook scripts → daemon)
Command::HookEvent { session_id: String, event: String, data: Option<serde_json::Value> }

// New event type (daemon → app)
Event::HookEvent { session_id: String, event: String, data: Option<serde_json::Value> }
```

### Daemon Broadcast Relay

The daemon currently processes each connection independently — there's no cross-connection messaging. Hook scripts connect on a separate socket to send `HookEvent`, but that event needs to reach the Tauri app's connection.

**Fix:** Add a `tokio::sync::broadcast` channel to the daemon.

```rust
// In main.rs, before the accept loop:
let (hook_tx, _) = tokio::sync::broadcast::channel::<String>(256);

// When a HookEvent command arrives on any connection:
Command::HookEvent { .. } => {
    let json = serde_json::to_string(&Event::HookEvent { .. }).unwrap();
    let _ = hook_tx.send(json);  // broadcast to all subscribers
}

// Each Tauri-connected client subscribes:
let mut hook_rx = hook_tx.subscribe();
tokio::spawn(async move {
    while let Ok(msg) = hook_rx.recv().await {
        writer.write_all(msg.as_bytes()).await;
        writer.write_all(b"\n").await;
    }
});
```

This way hook events from any connection (hook scripts, other clients) are relayed to all connected clients (the Tauri app).

### Daemon Lifecycle (Tauri Backend)

In `lib.rs` on app startup:

1. Read PID file → check if process is alive (`kill -0`)
2. If alive, try connecting to socket
3. If not alive or socket fails, spawn daemon sidecar binary
4. Retry connection with exponential backoff (50ms → 3.2s, ~12s total timeout)
5. Store connected `DaemonClient` in Tauri state

The daemon binary is built from `crates/daemon/` and bundled as a Tauri sidecar via `tauri.conf.json` `bundle.externalBin`. The `kanna-hook` binary is bundled the same way.

### Tauri Event Bridge

The Tauri backend needs **two daemon connections**:
- **Command connection** — for sending commands (`Spawn`, `Attach`, `Input`, etc.) and reading their responses. Protected by `Arc<Mutex<>>`.
- **Event connection** — dedicated read-only connection for receiving streamed events (`Output`, `Exit`, `HookEvent`). Runs in a background task, no lock contention.

```rust
// After daemon connection established:
let event_client = DaemonClient::connect(&socket_path).await?;
let cmd_client = DaemonClient::connect(&socket_path).await?;

// Background reader on the event connection — no Mutex needed
tokio::spawn(async move {
    loop {
        match event_client.read_event().await {
            Ok(line) => {
                let event: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
                match event.get("type").and_then(|t| t.as_str()) {
                    Some("Output") => { app.emit("terminal_output", &event).ok(); }
                    Some("Exit") => { app.emit("session_exit", &event).ok(); }
                    Some("HookEvent") => { app.emit("hook_event", &event).ok(); }
                    _ => {}
                }
            }
            Err(_) => break, // Connection lost
        }
    }
});

// cmd_client stored in DaemonState for Tauri commands
```

The event connection subscribes to the daemon's broadcast channel so it receives all `HookEvent` messages relayed from hook scripts.

### Frontend Changes

**useWorkflow.ts** — `createItem`:
- Default `agent_type: "pty"` for user tasks
- PTY mode: call `invoke("spawn_session", { sessionId, cwd, executable: "/bin/zsh", args: ["--login", "-c", claudeCmd], ... })`
- SDK mode: call `invoke("create_agent_session", { ... })` (existing)

**TerminalTabs.vue**:
- If `agent_type === "pty"`: show TerminalView connected to daemon session (existing component)
- If `agent_type === "sdk"`: show AgentView (existing component)
- Diff tab available in both modes

**useTerminal.ts** — already connects to daemon via `listen("terminal_output")` and `invoke("attach_session")`. Should work as-is once the event bridge is wired.

**Hook event handling** — new composable or listener:
```typescript
listen("hook_event", (event) => {
  if (event.payload.event === "Stop") {
    // Claude finished — refresh diff, enable Make PR
  }
})
```

### Implementation Order

1. CLI contract tests (validate assumptions about `--settings`, hooks, flags)
2. Daemon protocol: add `HookEvent` message type + broadcast channel
3. `kanna-hook` binary (compiled Rust, `crates/kanna-hook/`)
4. Daemon event bridge in Tauri backend (two connections: command + event)
5. Daemon sidecar: bundling + startup in Tauri
6. End-to-end hook delivery test (hook script → daemon → Tauri event)
7. PTY task creation flow in `useWorkflow`
8. Frontend: conditional TerminalView/AgentView rendering
9. Hook event handling (Stop → enable PR)
10. E2E test: create PTY task, verify terminal output, verify hook events

## Success Criteria

- CLI contract tests pass and document Claude's actual behavior
- User creates a task → sees Claude's real terminal UI in xterm.js
- Hook notifications arrive when Claude stops, uses tools, etc.
- Session persists if the app restarts (daemon keeps PTY alive)
- SDK mode continues to work unchanged for programmatic use
- E2E test verifies the full PTY flow
