# Terminal Restore Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kanna terminal reconnect restore behave like the `tests/pty-restore-test` prototype by delivering and applying terminal snapshots before any live output reaches xterm.

**Architecture:** Split Kanna attach into two phases. Phase 1 returns restore metadata and snapshot only. Phase 2 starts the session output stream after the frontend has reset xterm and applied the snapshot. Remove reconnect redraw hacks from this path and align warm-attach behavior with the prototype’s single ordered restore contract.

**Tech Stack:** Rust daemon, Tauri commands, Vue, xterm.js, vt100

---

### Task 1: Lock in the attach contract with failing tests

**Files:**
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `apps/desktop/src/composables/terminalSessionRecovery.test.ts`

- [ ] **Step 1: Write a daemon protocol round-trip test for restore metadata**

Add a test alongside the existing `Attached` event test that asserts the attached payload can carry snapshot text plus restore metadata fields:

```rust
#[test]
fn test_event_attached_restore_roundtrip() {
    let evt = Event::Attached {
        session_id: "sid".to_string(),
        snapshot: Some("\u{1b}[Hhello".to_string()),
        cols: Some(120),
        rows: Some(36),
    };

    let json = serde_json::to_string(&evt).unwrap();
    let decoded: Event = serde_json::from_str(&json).unwrap();

    match decoded {
        Event::Attached {
            session_id,
            snapshot,
            cols,
            rows,
        } => {
            assert_eq!(session_id, "sid");
            assert_eq!(snapshot.as_deref(), Some("\u{1b}[Hhello"));
            assert_eq!(cols, Some(120));
            assert_eq!(rows, Some(36));
        }
        other => panic!("unexpected event: {:?}", other),
    }
}
```

- [ ] **Step 2: Run the daemon protocol test to verify it fails**

Run: `cargo test --manifest-path crates/daemon/Cargo.toml protocol::tests::test_event_attached_restore_roundtrip`

Expected: FAIL because `Event::Attached` does not yet include `cols` and `rows`.

- [ ] **Step 3: Write a frontend unit test for reconnect-only restore policy**

In `apps/desktop/src/composables/terminalSessionRecovery.test.ts`, add a focused assertion that reconnect behavior stays attach-only and does not depend on redraw hacks:

```ts
it("keeps task sessions on attach-only recovery", () => {
  expect(
    getTerminalRecoveryMode({
      hasSpawnOptions: true,
      worktreePath: "/tmp/worktree",
      agentProvider: "codex",
    }),
  ).toBe("attach-only")
})
```

- [ ] **Step 4: Run the frontend test to verify the current baseline still passes**

Run: `bun test apps/desktop/src/composables/terminalSessionRecovery.test.ts`

Expected: PASS. This locks in the reconnect policy while the attach contract changes underneath it.

- [ ] **Step 5: Commit the test-only changes**

```bash
git add crates/daemon/src/protocol.rs apps/desktop/src/composables/terminalSessionRecovery.test.ts
git commit -m "test: lock terminal restore contract"
```

### Task 2: Split attach into restore and stream phases

**Files:**
- Modify: `crates/daemon/src/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/commands/daemon.rs`

- [ ] **Step 1: Extend the attached event shape**

Update `Event::Attached` in `crates/daemon/src/protocol.rs` to carry restore metadata:

```rust
Attached {
    session_id: String,
    snapshot: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}
```

- [ ] **Step 2: Make the daemon command bridge return structured attach data**

In `apps/desktop/src-tauri/src/commands/daemon.rs`, introduce a serializable struct:

```rust
#[derive(Clone, Debug, serde::Serialize)]
pub struct AttachSessionResult {
    pub snapshot: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}
```

Change `attach_session_inner()` and `attach_session()` to return `Result<AttachSessionResult, String>`.

- [ ] **Step 3: Stop starting the background output reader in `attach_session_inner()`**

Refactor the existing stream-reader spawn into a new helper:

```rust
async fn start_session_output_stream(
    app: tauri::AppHandle,
    attached: AttachedSessions,
    session_id: String,
    agent_provider: Option<String>,
) -> Result<(), String>
```

`attach_session_inner()` should only:
- create the dedicated socket
- send `Attach`
- parse the `Attached` response into `AttachSessionResult`
- store enough state for the stream helper to use next

- [ ] **Step 4: Add a new Tauri command to start live streaming after restore**

Expose:

```rust
#[tauri::command]
pub async fn start_attached_session_stream(
    app: tauri::AppHandle,
    attached: tauri::State<'_, AttachedSessions>,
    session_id: String,
    agent_provider: Option<String>,
) -> Result<(), String>
```

This command should start the dedicated output reader and emit `terminal_output` exactly as the current attach path does now.

- [ ] **Step 5: Run the daemon protocol test and Tauri build**

Run:
- `cargo test --manifest-path crates/daemon/Cargo.toml protocol::tests::test_event_attached_restore_roundtrip`
- `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`

Expected: PASS.

- [ ] **Step 6: Commit the bridge split**

```bash
git add crates/daemon/src/protocol.rs apps/desktop/src-tauri/src/commands/daemon.rs
git commit -m "refactor: split terminal attach restore from streaming"
```

### Task 3: Make the daemon restore payload match the prototype

**Files:**
- Modify: `crates/daemon/src/main.rs`
- Test: `tests/pty-restore-test/src/main.rs`

- [ ] **Step 1: Attach should return the current parser snapshot and size metadata**

In `crates/daemon/src/main.rs`, update the `Command::Attach` path so `Event::Attached` includes:
- `snapshot`
- `cols`
- `rows`

Use the current parser dimensions for `cols` and `rows`.

- [ ] **Step 2: Stop flushing pre-attach raw output after sending `Attached`**

Remove the pre-attach flush from the attach handler:

```rust
// delete the Output write-back of buffered bytes after Event::Attached
```

The restore model should rely on the snapshot, not replay buffered bytes on attach.

- [ ] **Step 3: Preserve any startup buffering only until the snapshot is authoritative**

Keep parser updates from PTY output, but once a client attaches, clear any obsolete pre-attach buffer state instead of sending it.

- [ ] **Step 4: Mirror the same snapshot strategy in the restore prototype if needed**

If `tests/pty-restore-test/src/main.rs` has diverged, keep its `snapshot_from_parser()` behavior aligned with the daemon implementation.

- [ ] **Step 5: Run daemon tests and the prototype build**

Run:
- `cargo test --manifest-path crates/daemon/Cargo.toml`
- `cargo test --manifest-path tests/pty-restore-test/Cargo.toml`

Expected: PASS.

- [ ] **Step 6: Commit the daemon restore alignment**

```bash
git add crates/daemon/src/main.rs tests/pty-restore-test/src/main.rs crates/daemon/Cargo.toml crates/daemon/Cargo.lock
git commit -m "feat: restore terminals from daemon snapshots"
```

### Task 4: Apply restore before any live output reaches xterm

**Files:**
- Modify: `apps/desktop/src/composables/useTerminal.ts`
- Modify: `apps/desktop/src/components/TerminalView.vue`

- [ ] **Step 1: Update the frontend attach call to use the structured result**

In `apps/desktop/src/composables/useTerminal.ts`, replace:

```ts
const snapshot = await invoke<string | null>("attach_session", ...)
```

with:

```ts
type AttachSessionResult = {
  snapshot: string | null
  cols: number | null
  rows: number | null
}

const restore = await invoke<AttachSessionResult>("attach_session", ...)
```

- [ ] **Step 2: Reset xterm, apply snapshot, then start stream**

In `connectSession()`:
- `terminal.value.reset()`
- if `restore.snapshot`, `terminal.value.write(restore.snapshot)`
- await a microtask/paint boundary so xterm applies the restore
- then call:

```ts
await invoke("start_attached_session_stream", { sessionId, agentProvider: options?.agentProvider })
```

- [ ] **Step 3: Remove reconnect redraw hacks from the attach path**

Delete any attach-time logic for:
- local clear sequences
- resize wiggle
- reconnect wake input

The restore path should now be snapshot + live stream only.

- [ ] **Step 4: Keep listener registration idempotent**

`listen("terminal_output", ...)` should still register once per terminal instance, but it should only see bytes after `start_attached_session_stream()` runs.

- [ ] **Step 5: Run the frontend checks**

Run:
- `bun test apps/desktop/src/composables/terminalSessionRecovery.test.ts`
- `cd apps/desktop && bun x tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit the frontend parity change**

```bash
git add apps/desktop/src/composables/useTerminal.ts apps/desktop/src/components/TerminalView.vue
git commit -m "feat: restore terminal snapshot before live stream"
```

### Task 5: Verify Kanna against the prototype

**Files:**
- Modify: `apps/desktop/src/composables/useTerminal.ts`
- Modify: `apps/desktop/src-tauri/src/commands/daemon.rs`
- Modify: `crates/daemon/src/main.rs`

- [ ] **Step 1: Remove temporary snapshot/debug logging once behavior is verified**

Delete temporary `append_log`, `eprintln!`, and snapshot byte-count logging that was only added for this debugging effort.

- [ ] **Step 2: Start the dev app and run the warm-reattach check**

Run: `./scripts/dev.sh restart`

Manual verification:
- create a Codex task
- wait for the terminal to settle
- restart or reload the app
- confirm the reattached terminal shows restored screen state immediately
- confirm input works without manual `Ctrl+L`

- [ ] **Step 3: Re-run the standalone prototype for comparison**

Run:
- `cd tests/pty-restore-test && cargo run`

Manual verification:
- spawn Codex
- detach client
- attach fresh client
- compare the initial restored screen with Kanna’s reconnect behavior

- [ ] **Step 4: Run final automated checks**

Run:
- `cargo test --manifest-path crates/daemon/Cargo.toml`
- `cargo test --manifest-path tests/pty-restore-test/Cargo.toml`
- `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `cd apps/desktop && bun x tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit the cleanup and verification pass**

```bash
git add crates/daemon/src/main.rs apps/desktop/src-tauri/src/commands/daemon.rs apps/desktop/src/composables/useTerminal.ts
git commit -m "chore: clean terminal restore debugging"
```
