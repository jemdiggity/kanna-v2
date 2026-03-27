# PTY-Based Event Parsing Design

Replace hook-based activity detection with PTY output parsing for both Claude and Copilot agents. Remove the `kanna-hook` crate and `HookEvent` protocol type entirely.

## Motivation

Claude CLI shows a spinner (`✻✽✶✳✢⏺`) followed by a verb (e.g., "Deliberating…") in its TUI. Copilot shows "Thinking" with per-character color shimmer. Both show `❯` as their idle prompt. Currently we use a mix of CLI hooks (`kanna-hook` binary) and PTY output parsing — the hooks are unreliable and add complexity. PTY parsing alone is sufficient and more immediate.

## Observed Claude CLI Output Patterns

From daemon pty-scan logs:

- **Spinner characters:** `✻` (U+273B), `✽` (U+273D), `✶` (U+2736), `✳` (U+2733), `✢` (U+2722), `⏺` (U+23FA)
- **Verb format:** `<spinner> <Verb>ing…` — e.g., `✻ Deliberating…`, `✽ Julienning…`
- **Idle prompt:** `❯\u{a0}` (U+276F followed by non-breaking space)
- **Fragmented output:** Spinner and verb text arrive across many small PTY writes due to animation frames. Sometimes a full frame arrives (`"✽ Julienning…"`), sometimes character-by-character (`"✻"`, `"De"`, `"l"`, `"ib"`, etc.)
- **Other patterns:** `"Interrupted"`, `"Do you want to allow"`, `"(running stop hooks…)"` (ignored)

## Architecture

### Per-Session Ring Buffer (Rust, `daemon.rs`)

Add a `HashMap<String, SessionScanState>` in the attach output loop:

```rust
struct SessionScanState {
    buffer: String,
    last_data_at: Instant,
    state: AgentState, // Idle | Working
}

enum AgentState {
    Idle,
    Working,
}
```

**Buffer lifecycle:**
1. Each ANSI-stripped fragment appends to `buffer`, updates `last_data_at`
2. A 150ms timer fires after the last fragment — scans the buffer, emits events, clears it
3. Immediate flush on known delimiters: `❯` (idle prompt) triggers early scan
4. Buffer cap at ~4KB to prevent unbounded growth; truncate front on overflow

### Pattern Detection

On each buffer flush, scan accumulated text:

| Pattern | Event emitted | Condition |
|---|---|---|
| Spinner char (`✻✽✶✳✢⏺`) | `ClaudeWorking` | Only on state transition (idle→working) |
| `❯\u{a0}` without spinner | `ClaudeIdle` | Only on state transition (working→idle) |
| `"Thinking"` | `CopilotThinking` | Existing behavior, unchanged |
| `❯` without `"Thinking"` | `CopilotIdle` | Existing behavior, unchanged |
| `"Interrupted"` | `Interrupted` | Both providers |
| `"Do you want to allow"` | `WaitingForInput` | Claude only |

Events emit only on state transitions to avoid flooding.

### Event Emission

Events are emitted as Tauri events on the existing `hook_event` channel name. This is a Tauri `app.emit()` channel, separate from the `HookEvent` protocol type being removed. The PTY parsing code in `daemon.rs` already emits on this channel — we're just removing the daemon-protocol source while keeping the PTY-parsing source:

```json
{"session_id": "abc123", "event": "ClaudeWorking"}
{"session_id": "abc123", "event": "ClaudeIdle"}
```

## Removals

### Hook configuration (`kanna.ts`)

- Remove `resolveKannaHookPath()` and `_kannaHookPathCache`
- Remove `hookSettings` JSON construction for Claude (lines 532-556)
- Remove Copilot hook config file write to `.github/hooks/kanna-hooks.json` (lines 598-622)
- Remove `--hook-settings` flag from Claude CLI command construction

### `kanna-hook` crate

- Remove `crates/kanna-hook/` entirely
- Remove from workspace `Cargo.toml`
- Remove from `scripts/stage-sidecars.sh` (no longer needs to stage the binary)

### `HookEvent` protocol type

- Remove `HookEvent` variant from `Command` enum in `crates/daemon/src/protocol.rs`
- Remove `HookEvent` variant from `Event` enum
- Remove associated handler in the daemon's command processing
- Remove associated tests

## Frontend Changes

### `hook_event` listener (`kanna.ts`)

Replace the current handler (lines 1406-1450) to handle the new PTY-derived events:

| Event | Action |
|---|---|
| `ClaudeWorking` / `CopilotThinking` | Set activity to `working` (if not already) |
| `ClaudeIdle` / `CopilotIdle` | Set activity to `idle` (selected) or `unread` (not selected) |
| `Interrupted` | Set activity to `idle` |
| `WaitingForInput` | Set activity to `unread` (if not selected) |

Remove:
- `Stop` / `StopFailure` handling (replaced by `ClaudeIdle`)
- `PostToolUse` / `UserPromptSubmit` handling (replaced by `ClaudeWorking`)
- Copilot idle timer (`_resetCopilotIdleTimer`, `_clearCopilotIdleTimer`, `COPILOT_IDLE_TIMEOUT_MS`) — `CopilotIdle` from PTY parsing is sufficient

### `session_exit` listener

Unchanged — still handles process termination.

## What's NOT Changing

- Sidebar UI — activity still surfaces as `working`/`idle`/`unread` with same styling
- Verb text is not surfaced in UI — just working/idle detection
- `session_exit` handling — unchanged
- Hook-related terminal output (`"(running stop hooks…)"`) — ignored, passes through to terminal
- Copilot PTY patterns (`CopilotThinking`, `CopilotIdle`) — already working, kept as-is
