# PTY-Based Event Parsing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers-extended-cc:subagent-driven-development (if subagents available) or superpowers-extended-cc:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hook-based activity detection with PTY output parsing for both Claude and Copilot agents, removing the `kanna-hook` crate and `HookEvent` protocol type entirely.

**Architecture:** Per-session text buffer in `daemon.rs` accumulates ANSI-stripped PTY fragments, flushes on a 150ms idle timer or known delimiters, and emits state-transition events (`ClaudeWorking`/`ClaudeIdle`/`Interrupted`/`WaitingForInput`) to the frontend. The existing Copilot patterns remain inline. All hook infrastructure is removed.

**Tech Stack:** Rust (Tauri commands, daemon protocol), TypeScript (Vue/Pinia store)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/daemon/src/protocol.rs` | Modify | Remove `HookEvent` from `Command` and `Event` enums |
| `crates/daemon/src/main.rs` | Modify | Remove `Command::HookEvent` handler, rename `hook_tx` → `broadcast_tx` |
| `apps/desktop/src-tauri/src/commands/daemon.rs` | Modify | Add per-session buffer with timer, Claude spinner detection |
| `apps/desktop/src/stores/kanna.ts` | Modify | Remove hook config/resolution, simplify event listener |
| `apps/desktop/src-tauri/tauri.conf.json` | Modify | Remove `kanna-hook` from `externalBin` |
| `apps/desktop/package.json` | Modify | Remove `kanna-hook` from `build:daemon` script |
| `scripts/stage-sidecars.sh` | Modify | Remove `kanna-hook` from sidecar staging loop |
| `scripts/ship.sh` | Modify | Remove `kanna-hook` build step |
| `crates/kanna-hook/` | Delete | Entire crate removed |
| `tests/cli-contract/tests/hooks.test.ts` | Delete | Hook contract test no longer applicable |

---

### Task 1: Remove HookEvent from daemon protocol

**Goal:** Remove the `HookEvent` variant from both `Command` and `Event` enums and the handler in `main.rs`.

**Files:**
- Modify: `crates/daemon/src/protocol.rs:43-47` (Command::HookEvent), `crates/daemon/src/protocol.rs:81-85` (Event::HookEvent)
- Modify: `crates/daemon/src/main.rs:694-708` (Command::HookEvent handler)
- Modify: `crates/daemon/src/main.rs:112` (rename `hook_tx` → `broadcast_tx` throughout)

**Acceptance Criteria:**
- [ ] `HookEvent` variant removed from `Command` enum
- [ ] `HookEvent` variant removed from `Event` enum
- [ ] `Command::HookEvent` handler removed from `handle_command`
- [ ] `hook_tx`/`hook_rx` renamed to `broadcast_tx`/`broadcast_rx` throughout `main.rs`
- [ ] All HookEvent-related tests removed from `protocol.rs`
- [ ] `cargo build -p kanna-daemon` succeeds
- [ ] `cargo test -p kanna-daemon` passes
- [ ] `cargo clippy -p kanna-daemon` has no warnings

**Verify:** `cd crates/daemon && cargo clippy && cargo test` → all clean

**Steps:**

- [ ] **Step 1: Remove HookEvent from protocol.rs**

In `crates/daemon/src/protocol.rs`, remove the `HookEvent` variant from `Command`:

```rust
// DELETE these lines from the Command enum (lines 43-47):
    HookEvent {
        session_id: String,
        event: String,
        data: Option<serde_json::Value>,
    },
```

Remove the `HookEvent` variant from `Event`:

```rust
// DELETE these lines from the Event enum (lines 81-85):
    HookEvent {
        session_id: String,
        event: String,
        data: Option<serde_json::Value>,
    },
```

Remove the two HookEvent roundtrip tests (`test_command_hook_event_roundtrip` at line 270 and `test_event_hook_event_roundtrip` at line 293).

- [ ] **Step 2: Remove Command::HookEvent handler from main.rs**

In `crates/daemon/src/main.rs`, remove the `Command::HookEvent` match arm (lines 694-708):

```rust
// DELETE this entire match arm:
        Command::HookEvent {
            session_id,
            event,
            data,
        } => {
            let evt = Event::HookEvent {
                session_id,
                event,
                data,
            };
            if let Ok(json) = serde_json::to_string(&evt) {
                let _ = hook_tx.send(json);
            }
            let _ = write_event(&mut *writer.lock().await, &Event::Ok).await;
        }
```

- [ ] **Step 3: Rename hook_tx → broadcast_tx**

The broadcast channel still carries `ShuttingDown` events and is used by `Subscribe`. Rename for clarity. In `crates/daemon/src/main.rs`, rename all occurrences:
- `hook_tx` → `broadcast_tx`
- `hook_rx` → `broadcast_rx`
- `hook_tx_clone` → `broadcast_tx_clone`
- `writer_hook` → `writer_broadcast`

This is a mechanical find-and-replace across `main.rs`.

- [ ] **Step 4: Remove hook_tx parameter from handle_command**

After removing the HookEvent handler, `handle_command` no longer uses the broadcast channel. Remove the `hook_tx` parameter from:
- `handle_command` function signature (line 379)
- All call sites passing `&hook_tx` / `&broadcast_tx` to `handle_command` (line 364)

Verify `handle_command` body has no remaining references. If `handle_handoff` still needs it (line 724), keep it there — only remove from `handle_command`.

- [ ] **Step 5: Build and test**

Run: `cd crates/daemon && cargo clippy && cargo test`
Expected: All clean, no warnings, all tests pass.

```bash
git add crates/daemon/src/protocol.rs crates/daemon/src/main.rs
git commit -m "refactor: remove HookEvent from daemon protocol

The broadcast channel is now only used for ShuttingDown during
handoff. Rename hook_tx → broadcast_tx for clarity."
```

---

### Task 2: Add per-session buffer and Claude spinner detection

**Goal:** Add a per-session text buffer in `daemon.rs` that accumulates ANSI-stripped fragments and detects Claude's spinner (working) and idle prompt patterns, emitting state-transition events. Thread the agent provider through `attach_session` so patterns are provider-specific.

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/daemon.rs:200-356` (attach_session_inner, attach_session)
- Modify: `apps/desktop/src/composables/useTerminal.ts:190,222` (pass agentProvider to attach_session)
- Modify: `apps/desktop/src/stores/kanna.ts:829` (pass agentProvider to teardown attach)
- Modify: `apps/desktop/src/tauri-mock.ts:195` (update mock)

**Acceptance Criteria:**
- [x] `attach_session` Tauri command accepts optional `agent_provider` parameter
- [x] `SessionScanState` struct holds buffer, last_data_at, current state, and provider per session
- [x] Stripped text fragments accumulate in the buffer
- [x] Buffer flushes on 150ms idle timer or when `❯` is detected
- [x] Claude spinner chars (`✻✽✶✳✢⏺`) trigger `ClaudeWorking` event on state transition
- [x] `❯\u{a0}` without spinner triggers `ClaudeIdle` on state transition
- [x] `Interrupted` and `WaitingForInput` patterns still detected
- [x] Existing Copilot patterns (`CopilotThinking`, `CopilotIdle`) still work
- [x] Buffer capped at 4KB, truncates front on overflow
- [x] `cargo build -p kanna-desktop` succeeds
- [x] `cargo clippy -p kanna-desktop` has no warnings

**Verify:** `cd apps/desktop/src-tauri && cargo clippy` → no warnings

**Steps:**

- [x] **Step 1: Add SessionScanState and helpers above attach_session_inner**

Add these types and constants near the top of `daemon.rs` (after the existing imports/types):

```rust
use std::time::Instant;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

const CLAUDE_SPINNERS: &[char] = &['✻', '✽', '✶', '✳', '✢', '⏺'];
const SCAN_BUFFER_CAP: usize = 4096;
const SCAN_FLUSH_MS: u64 = 150;

#[derive(Clone, Debug, PartialEq)]
enum AgentProvider {
    Claude,
    Copilot,
}

#[derive(Clone, Debug, PartialEq)]
enum AgentState {
    Idle,
    Working,
}

struct SessionScanState {
    buffer: String,
    last_data_at: Instant,
    state: AgentState,
    provider: AgentProvider,
}

impl SessionScanState {
    fn new(provider: AgentProvider) -> Self {
        Self {
            buffer: String::new(),
            last_data_at: Instant::now(),
            state: AgentState::Idle,
            provider,
        }
    }

    fn append(&mut self, text: &str) {
        self.buffer.push_str(text);
        self.last_data_at = Instant::now();
        // Cap buffer size — keep the tail (most recent data)
        if self.buffer.len() > SCAN_BUFFER_CAP {
            let drain_to = self.buffer.len() - SCAN_BUFFER_CAP;
            self.buffer.drain(..drain_to);
        }
    }

    fn flush(&mut self) -> Vec<&'static str> {
        let mut events = Vec::new();
        let buf = &self.buffer;

        let has_idle_prompt = buf.contains('\u{276F}'); // ❯

        match self.provider {
            AgentProvider::Claude => {
                let has_spinner = buf.chars().any(|c| CLAUDE_SPINNERS.contains(&c));
                if has_spinner && self.state != AgentState::Working {
                    self.state = AgentState::Working;
                    events.push("ClaudeWorking");
                } else if has_idle_prompt && !has_spinner && self.state != AgentState::Idle {
                    self.state = AgentState::Idle;
                    events.push("ClaudeIdle");
                }
                if buf.contains("Do you want to allow") {
                    events.push("WaitingForInput");
                }
            }
            AgentProvider::Copilot => {
                if buf.contains("Thinking") {
                    if self.state != AgentState::Working {
                        self.state = AgentState::Working;
                    }
                    events.push("CopilotThinking");
                }
                if has_idle_prompt && !buf.contains("Thinking") {
                    if self.state != AgentState::Idle {
                        self.state = AgentState::Idle;
                    }
                    events.push("CopilotIdle");
                }
                if buf.contains("Operation cancelled") {
                    events.push("Interrupted");
                }
            }
        }

        // Shared patterns
        if buf.contains("Interrupted") {
            self.state = AgentState::Idle;
            events.push("Interrupted");
        }

        self.buffer.clear();
        events
    }
}
```

- [x] **Step 2: Add agent_provider parameter to attach_session**

Update `attach_session_inner` signature to accept provider:

```rust
pub async fn attach_session_inner(
    app: &tauri::AppHandle,
    session_id: String,
    attached: &AttachedSessions,
    agent_provider: Option<String>,  // "claude" or "copilot"
) -> Result<(), String> {
```

Update the `attach_session` Tauri command:

```rust
#[tauri::command]
pub async fn attach_session(
    app: tauri::AppHandle,
    attached: tauri::State<'_, AttachedSessions>,
    session_id: String,
    agent_provider: Option<String>,
) -> Result<(), String> {
    attach_session_inner(&app, session_id, &attached, agent_provider).await
}
```

Update all internal callers of `attach_session_inner` (e.g., the re-attach coordinator) to pass `None` for provider (will check all patterns — safe fallback).

Update frontend callers to pass `agentProvider`:

In `useTerminal.ts`, the `connect` function has access to the pipeline item. Pass provider:
```typescript
await invoke("attach_session", { sessionId, agentProvider: item?.agent_provider })
```

In `kanna.ts` teardown attach (line 829):
```typescript
await invoke("attach_session", { sessionId: tdSessionId, agentProvider: "claude" });
```

In `tauri-mock.ts`, update the mock to accept the new parameter.

- [x] **Step 3: Refactor the attach output loop to use the buffer**

Replace the existing pattern matching block in `attach_session_inner` (lines 260-338) with buffer-based scanning. The key change: instead of matching patterns on each individual fragment, append to the buffer and flush on timer or delimiter.

Determine the provider for the scan state:

```rust
let provider = match agent_provider.as_deref() {
    Some("copilot") => AgentProvider::Copilot,
    _ => AgentProvider::Claude, // default to Claude
};
```

```rust
// Inside the spawned async move block, before the while loop:
let scan_state = Arc::new(TokioMutex::new(SessionScanState::new(provider)));

// Spawn a flush timer task
let scan_state_timer = scan_state.clone();
let app_timer = app.clone();
let sid_timer = sid.clone();
let flush_handle = tauri::async_runtime::spawn(async move {
    loop {
        tokio::time::sleep(tokio::time::Duration::from_millis(SCAN_FLUSH_MS)).await;
        let mut state = scan_state_timer.lock().await;
        if state.buffer.is_empty() {
            continue;
        }
        if state.last_data_at.elapsed() >= std::time::Duration::from_millis(SCAN_FLUSH_MS) {
            let events = state.flush();
            for event_name in events {
                let hook = serde_json::json!({
                    "session_id": &sid_timer,
                    "event": event_name,
                });
                let _ = app_timer.emit("hook_event", &hook);
            }
        }
    }
});
```

Then in the `Some("Output")` arm, after emitting `terminal_output` and stripping ANSI, replace all the pattern matching (lines 296-338) with:

```rust
if !text.is_empty() {
    eprintln!("[pty-scan] sid={} {:?}", sid, text);

    let mut state = scan_state.lock().await;
    state.append(text);

    // Immediate flush on idle prompt delimiter
    if text.contains('\u{276F}') {
        let events = state.flush();
        for event_name in events {
            let hook = serde_json::json!({
                "session_id": event.get("session_id"),
                "event": event_name,
            });
            let _ = app.emit("hook_event", &hook);
        }
    }
}
```

And in the `Some("Exit")` arm, abort the flush timer:

```rust
Some("Exit") => {
    flush_handle.abort();
    attached_clone.lock().await.remove(&sid);
    let _ = app.emit("session_exit", &event);
    break;
}
```

- [x] **Step 4: Build and verify**

Run: `cd apps/desktop/src-tauri && cargo clippy`
Expected: No warnings.

```bash
git add apps/desktop/src-tauri/src/commands/daemon.rs
git commit -m "feat: add per-session buffer for Claude PTY event parsing

Accumulates ANSI-stripped terminal fragments per session,
flushes on 150ms idle timer or idle prompt delimiter.
Detects Claude spinner chars for working state, ❯ prompt
for idle state. Emits state-transition events only."
```

---

### Task 3: Remove hook infrastructure from spawn and frontend

**Goal:** Remove all kanna-hook configuration from `spawnPtySession` and simplify the `hook_event` listener to handle only PTY-derived events.

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts:517-556` (hook resolution + Claude hookSettings)
- Modify: `apps/desktop/src/stores/kanna.ts:597-622` (Copilot hook config write)
- Modify: `apps/desktop/src/stores/kanna.ts:661` (--settings flag in Claude command)
- Modify: `apps/desktop/src/stores/kanna.ts:1374-1450` (Copilot idle timer + hook_event listener)

**Acceptance Criteria:**
- [ ] `resolveKannaHookPath` and `_kannaHookPathCache` removed
- [ ] `hookSettings` JSON construction removed
- [ ] Copilot hook config file write removed
- [ ] `--settings` flag removed from Claude command
- [ ] `hook_event` listener simplified to handle `ClaudeWorking`, `ClaudeIdle`, `CopilotThinking`, `CopilotIdle`, `Interrupted`, `WaitingForInput`
- [ ] Copilot idle timer (`_resetCopilotIdleTimer`, `_clearCopilotIdleTimer`, `COPILOT_IDLE_TIMEOUT_MS`) removed
- [ ] `Stop`/`StopFailure`/`PostToolUse`/`UserPromptSubmit` event handling removed
- [ ] `bun tsc --noEmit` passes (from `apps/desktop`)

**Verify:** `cd apps/desktop && bun tsc --noEmit` → no errors

**Steps:**

- [ ] **Step 1: Remove hook resolution**

Delete `_kannaHookPathCache` and `resolveKannaHookPath` (lines 517-522):

```typescript
// DELETE these lines:
  let _kannaHookPathCache: string | null = null;
  async function resolveKannaHookPath(): Promise<string> {
    if (_kannaHookPathCache) return _kannaHookPathCache;
    _kannaHookPathCache = await invoke<string>("which_binary", { name: "kanna-hook" });
    return _kannaHookPathCache;
  }
```

- [ ] **Step 2: Remove hook setup from spawnPtySession**

Remove the `kannaHookPath` resolution at the top of `spawnPtySession` (lines 525-530):

```typescript
// DELETE these lines:
    let kannaHookPath: string;
    try {
      kannaHookPath = await resolveKannaHookPath();
    } catch {
      throw new Error("kanna-hook binary not found. Ensure it is built (cargo build -p kanna-hook).");
    }
```

Remove the `hookSettings` construction (lines 532-556):

```typescript
// DELETE these lines:
    const hookSettings = JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `${kannaHookPath} SessionStart ${sessionId}` }] },
        ],
        // ... all hook entries ...
      },
    });
```

Remove the Copilot hook config file write (lines 597-622):

```typescript
// DELETE these lines inside if (provider === "copilot") {:
      // Write hook config file to worktree for Copilot to discover
      const copilotHookConfig = JSON.stringify({
        // ... all copilot hook config ...
      }, null, 2);
      await invoke("write_text_file", {
        path: `${cwd}/.github/hooks/kanna-hooks.json`,
        content: copilotHookConfig,
      });
```

- [ ] **Step 3: Remove --settings flag from Claude command**

Change line 661 from:

```typescript
      agentCmd = `claude ${flags.join(" ")} --settings '${hookSettings}' '${escapedPrompt}'`;
```

to:

```typescript
      agentCmd = `claude ${flags.join(" ")} '${escapedPrompt}'`;
```

- [ ] **Step 4: Replace hook_event listener and remove Copilot idle timer**

Delete the Copilot idle timer infrastructure (lines 1374-1403):

```typescript
// DELETE: COPILOT_IDLE_TIMEOUT_MS, _copilotIdleTimers, _resetCopilotIdleTimer, _clearCopilotIdleTimer
```

Replace the `hook_event` listener (lines 1406-1450) with:

```typescript
    listen("hook_event", async (event: any) => {
      const payload = event.payload || event;
      const sessionId = payload.session_id;
      const hookEvent = payload.event;
      if (!sessionId) return;

      const item = items.value.find((i) => i.id === sessionId);
      if (!item) return;

      if (hookEvent === "ClaudeWorking" || hookEvent === "CopilotThinking") {
        if (item.activity !== "working") {
          await updatePipelineItemActivity(_db, item.id, "working");
          bump();
        }
      } else if (hookEvent === "ClaudeIdle" || hookEvent === "CopilotIdle") {
        if (item.activity === "working") {
          if (selectedItemId.value === sessionId) {
            await updatePipelineItemActivity(_db, item.id, "idle");
          } else {
            await updatePipelineItemActivity(_db, item.id, "unread");
          }
          bump();
        }
      } else if (hookEvent === "Interrupted") {
        if (item.activity === "working") {
          await updatePipelineItemActivity(_db, item.id, "idle");
          bump();
        }
      } else if (hookEvent === "WaitingForInput") {
        if (item.activity !== "unread" && selectedItemId.value !== sessionId) {
          await updatePipelineItemActivity(_db, item.id, "unread");
          bump();
        }
      }
    });
```

- [ ] **Step 5: Type check**

Run: `cd apps/desktop && bun tsc --noEmit`
Expected: No errors.

```bash
git add apps/desktop/src/stores/kanna.ts
git commit -m "refactor: remove hook infrastructure from spawn and frontend

Remove kanna-hook resolution, hook settings for Claude, hook
config file write for Copilot, and Copilot idle timer. Simplify
hook_event listener to handle PTY-derived events only."
```

---

### Task 4: Remove kanna-hook crate and references

**Goal:** Delete the `kanna-hook` crate and remove all references from build scripts, Tauri config, and tests.

**Files:**
- Delete: `crates/kanna-hook/` (entire directory)
- Delete: `tests/cli-contract/tests/hooks.test.ts`
- Modify: `apps/desktop/src-tauri/tauri.conf.json:33` (remove `kanna-hook` from externalBin)
- Modify: `apps/desktop/package.json:8` (remove `kanna-hook` from build:daemon)
- Modify: `scripts/stage-sidecars.sh:2,40` (remove `kanna-hook` from comment and loop)
- Modify: `scripts/ship.sh:227,235` (remove `kanna-hook` build step)

**Acceptance Criteria:**
- [ ] `crates/kanna-hook/` directory deleted
- [ ] `tests/cli-contract/tests/hooks.test.ts` deleted
- [ ] `tauri.conf.json` externalBin only lists `kanna-daemon`
- [ ] `package.json` build:daemon only builds daemon
- [ ] `stage-sidecars.sh` only stages daemon binary
- [ ] `ship.sh` only builds daemon sidecar
- [ ] `cargo build -p kanna-desktop` succeeds (no missing sidecar errors)

**Verify:** `cd apps/desktop/src-tauri && cargo build` → succeeds

**Steps:**

- [ ] **Step 1: Delete kanna-hook crate**

```bash
rm -rf crates/kanna-hook
```

- [ ] **Step 2: Delete hooks contract test**

```bash
rm tests/cli-contract/tests/hooks.test.ts
```

- [ ] **Step 3: Update tauri.conf.json**

Change the `externalBin` array from:

```json
    "externalBin": [
      "binaries/kanna-daemon",
      "binaries/kanna-hook"
    ],
```

to:

```json
    "externalBin": [
      "binaries/kanna-daemon"
    ],
```

- [ ] **Step 4: Update package.json build:daemon**

Change line 8 from:

```json
    "build:daemon": "cd ../../crates/daemon && cargo build && cd ../../crates/kanna-hook && cargo build && ../../scripts/stage-sidecars.sh",
```

to:

```json
    "build:daemon": "cd ../../crates/daemon && cargo build && ../../scripts/stage-sidecars.sh",
```

- [ ] **Step 5: Update stage-sidecars.sh**

Change the comment on line 2 from:

```bash
# Stage kanna-daemon and kanna-hook binaries for Tauri's externalBin bundling.
```

to:

```bash
# Stage kanna-daemon binary for Tauri's externalBin bundling.
```

Change the loop on line 40 from:

```bash
for BIN in kanna-daemon kanna-hook; do
```

to:

```bash
for BIN in kanna-daemon; do
```

- [ ] **Step 6: Update ship.sh**

Change the comment on line 227 from:

```bash
    echo "    Building sidecars ($LABEL)..."
```

Keep this line (it's still accurate for the daemon). Remove the kanna-hook build line (235):

```bash
# DELETE this line:
        cargo build --release --target "$ARCH" --manifest-path crates/kanna-hook/Cargo.toml
```

- [ ] **Step 7: Build and verify**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: Succeeds without missing sidecar errors.

```bash
git add -A
git commit -m "chore: remove kanna-hook crate and all references

Delete the kanna-hook sidecar binary, hook contract tests,
and references in tauri.conf.json, package.json, stage-sidecars.sh,
and ship.sh. Activity detection is now fully PTY-based."
```

---

### Task 5: Update documentation

**Goal:** Update CLAUDE.md and daemon docs to reflect hook removal and PTY-based activity detection.

**Files:**
- Modify: `CLAUDE.md` (remove kanna-hook references, update data flow, update crate list)
- Modify: `crates/daemon/SPEC.md` (remove HookEvent references if present)
- Modify: `crates/daemon/DESIGN.md` (remove HookEvent references if present)

**Acceptance Criteria:**
- [ ] CLAUDE.md no longer mentions `kanna-hook` as a crate or binary
- [ ] CLAUDE.md data flow section updated (no hook mention in flow)
- [ ] CLAUDE.md scripts table updated (stage-sidecars description)
- [ ] Daemon docs updated to reflect protocol changes

**Verify:** `grep -r 'kanna-hook' CLAUDE.md` → no matches

**Steps:**

- [ ] **Step 1: Update CLAUDE.md**

In the Rust Crates section, remove the `kanna-hook` entry:

```markdown
<!-- DELETE this line: -->
- **`kanna-hook`** — Lightweight binary that signals task completion to the daemon.
```

In the Data flow section, update to remove hook references. Change:

```
Claude finishes → kanna-hook fires Stop → daemon broadcasts → app updates task activity
```

to:

```
Claude finishes → PTY shows ❯ idle prompt → Tauri detects ClaudeIdle → app updates task activity
```

In the Scripts table, update `stage-sidecars.sh` description from:

```
| `stage-sidecars.sh` | Stage daemon + hook binaries to Tauri's externalBin with target triples |
```

to:

```
| `stage-sidecars.sh` | Stage daemon binary to Tauri's externalBin with target triples |
```

- [ ] **Step 2: Update daemon docs**

Check `crates/daemon/SPEC.md` and `crates/daemon/DESIGN.md` for `HookEvent` references and update or remove them.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md crates/daemon/SPEC.md crates/daemon/DESIGN.md
git commit -m "docs: update for PTY-based activity detection

Remove kanna-hook references from CLAUDE.md and daemon docs.
Update data flow to reflect PTY parsing as the activity signal
source."
```

---

### Task 6: Integration test with dev server

**Goal:** Verify the full pipeline works end-to-end: spawn a Claude session, observe PTY events, confirm activity transitions.

**Files:**
- No new files — manual verification against running dev server

**Acceptance Criteria:**
- [ ] Dev server starts without kanna-hook errors
- [ ] Claude session spawns without --settings flag
- [ ] `[pty-scan]` logs show stripped text in dev server output
- [ ] `ClaudeWorking` event emitted when Claude shows spinner
- [ ] `ClaudeIdle` event emitted when Claude shows `❯` prompt
- [ ] Sidebar shows italic (working) → normal (idle) transitions
- [ ] Copilot session (if available) still detects thinking/idle correctly

**Verify:** `./scripts/dev.sh start && ./scripts/dev.sh log` → observe events after running a task

**Steps:**

- [ ] **Step 1: Start dev server and create a task**

```bash
./scripts/dev.sh start
```

Create a simple task in the UI (e.g., "say hello"). Observe the dev server logs.

- [ ] **Step 2: Check pty-scan logs**

```bash
./scripts/dev.sh log
```

Verify:
- No errors about `kanna-hook` binary not found
- `[pty-scan]` lines show Claude's spinner characters and text
- Events emitted: look for `ClaudeWorking` and `ClaudeIdle` in logs (or add temporary `eprintln!` for event emission)

- [ ] **Step 3: Verify sidebar behavior**

- Task title should go italic when Claude is working (spinner visible)
- Task title should return to normal when Claude finishes (idle prompt visible)
- If task is not selected when it goes idle, it should show bold (unread)
