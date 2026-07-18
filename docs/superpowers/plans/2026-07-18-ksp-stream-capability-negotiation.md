# KSP Stream Capability Negotiation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep PTY and agent tasks usable when a new mobile client connects to a desktop server that predates visual companions, and add an E2E gate for the shipped server protocol.

**Architecture:** Extend the existing KSP `auth_ok` handshake with an optional list of supported stream kinds. The shared TypeScript client negotiates support per connection and suppresses companion wire frames against old servers, while a desktop real E2E connects to the app-managed sidecar and proves the packaged server advertises and accepts the companion stream.

**Tech Stack:** Rust, serde, ts-rs, TypeScript, Vitest, WebSocket, Tauri desktop E2E

---

## File Structure

- `crates/kanna-agent-protocol/src/frames.rs` owns the KSP wire schema and protocol round-trip coverage.
- `crates/kanna-server/src/ksp.rs` owns server authentication responses and advertises the streams implemented by that binary.
- `packages/agent-protocol/src/generated/ServerFrame.ts` is regenerated from the Rust source of truth.
- `packages/stream-client/src/index.ts` owns per-connection capability state and companion frame gating.
- `packages/stream-client/src/stream-client.test.ts` proves mixed-version behavior and reconnect activation.
- `apps/desktop/tests/e2e/real/mobile-server-ksp-capabilities.test.ts` verifies the app-launched sidecar at the real WebSocket boundary.

### Task 1: Add backward-compatible stream negotiation to KSP

**Files:**
- Modify: `crates/kanna-agent-protocol/src/frames.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Regenerate: `packages/agent-protocol/src/generated/ServerFrame.ts`

- [ ] **Step 1: Write failing protocol tests**

Add tests that deserialize an old handshake and serialize the new handshake:

```rust
#[test]
fn auth_ok_stream_kinds_are_backward_compatible() {
    let old: ServerFrame = serde_json::from_value(serde_json::json!({
        "type": "auth_ok"
    }))
    .unwrap();
    assert_eq!(old, ServerFrame::AuthOk { stream_kinds: Vec::new() });

    let current = ServerFrame::AuthOk {
        stream_kinds: vec![
            StreamKind::Agent,
            StreamKind::Terminal,
            StreamKind::Companion,
        ],
    };
    assert_eq!(
        serde_json::to_value(current).unwrap(),
        serde_json::json!({
            "type": "auth_ok",
            "stream_kinds": ["agent", "terminal", "companion"]
        })
    );
}
```

- [ ] **Step 2: Run the protocol test and verify RED**

Run:

```bash
cargo test -p kanna-agent-protocol auth_ok_stream_kinds_are_backward_compatible -- --nocapture
```

Expected: compilation fails because `AuthOk` does not yet contain `stream_kinds`.

- [ ] **Step 3: Implement the optional handshake field and server advertisement**

Change the protocol variant to:

```rust
AuthOk {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    stream_kinds: Vec<StreamKind>,
},
```

Add a single server helper and use it for initial and repeated auth responses:

```rust
fn auth_ok_frame() -> ServerFrame {
    ServerFrame::AuthOk {
        stream_kinds: vec![
            StreamKind::Agent,
            StreamKind::Terminal,
            StreamKind::Companion,
        ],
    }
}
```

Update KSP tests to compare against `auth_ok_frame()` so they verify the same advertised contract as production.

- [ ] **Step 4: Regenerate TypeScript bindings**

Run:

```bash
./scripts/generate-agent-protocol-types.sh
```

Expected: `ServerFrame.ts` imports `StreamKind` and represents `auth_ok` with optional `stream_kinds`.

- [ ] **Step 5: Run protocol/server checks and verify GREEN**

Run:

```bash
cargo test -p kanna-agent-protocol auth_ok_stream_kinds_are_backward_compatible -- --nocapture
cargo test -p kanna-server ksp::tests --no-fail-fast
./scripts/check-agent-protocol-types.sh
```

Expected: all commands pass.

- [ ] **Step 6: Commit protocol negotiation**

```bash
git add crates/kanna-agent-protocol/src/frames.rs crates/kanna-server/src/ksp.rs packages/agent-protocol/src/generated/ServerFrame.ts
git commit -m "feat(protocol): negotiate supported KSP streams"
```

### Task 2: Suppress unsupported companion frames in StreamClient

**Files:**
- Modify: `packages/stream-client/src/stream-client.test.ts`
- Modify: `packages/stream-client/src/index.ts`

- [ ] **Step 1: Write a failing mixed-version regression test**

Add one test that attaches terminal and companion handlers, authenticates with an old-style handshake, and proves only terminal traffic reaches the wire:

```typescript
it("keeps terminal streams healthy when an old server does not support companions", () => {
  const terminalErrors: string[] = [];
  const unavailable: string[] = [];
  const client = new StreamClient({
    url: "ws://test/v1/stream",
    webSocketFactory: factory,
  });
  client.attachTerminal("task-1", {
    onOutput: () => {},
    onError: (_code, message) => terminalErrors.push(message),
  });
  client.attachCompanion("task-1", {
    onSnapshot: () => {},
    onUnavailable: () => unavailable.push("unavailable"),
    onEventResult: () => {},
  });

  const socket = sockets[0];
  socket.open();
  socket.receive({ type: "auth_ok" });

  expect(socket.sent).toEqual([
    { type: "auth" },
    { type: "attach", task_id: "task-1", kind: "terminal", from_seq: 0 },
  ]);
  expect(unavailable).toEqual(["unavailable"]);
  expect(terminalErrors).toEqual([]);
  client.close();
});
```

Extend the test or add a second focused test proving companion detach/events are not sent while unsupported and the same logical attachment becomes active after reconnecting to `auth_ok` with `stream_kinds: ["agent", "terminal", "companion"]`.

- [ ] **Step 2: Run the focused client test and verify RED**

Run:

```bash
pnpm --filter @kanna/stream-client test
```

Expected: the old-style handshake sends `kind: "companion"`, failing the wire-frame assertion.

- [ ] **Step 3: Implement per-connection negotiation**

Add a connection-scoped set and helper:

```typescript
private supportedStreamKinds = new Set<StreamKind>();

private supports(kind: StreamKind): boolean {
  return this.supportedStreamKinds.has(kind);
}
```

Clear it whenever connecting/disconnecting. On `auth_ok`, populate it from
`frame.stream_kinds ?? ["agent", "terminal"]`, then restore attachments. Skip
companion restore and call `onUnavailable` if `companion` is absent. Gate live
companion attach, detach, and event frames with `supports("companion")` while
retaining local attachment state.

- [ ] **Step 4: Update current-protocol fixtures**

Change tests that expect companion frames to authenticate with:

```typescript
{
  type: "auth_ok",
  stream_kinds: ["agent", "terminal", "companion"],
}
```

Leave non-companion tests on old-style `auth_ok` so backward compatibility stays covered.

- [ ] **Step 5: Run stream-client and mobile transport tests and verify GREEN**

Run:

```bash
pnpm --filter @kanna/stream-client test
pnpm --dir apps/mobile test -- src/lib/transports/lanTransport.test.ts src/lib/transports/relayClient.test.ts src/state/mobileController.test.ts
```

Expected: all focused tests pass with no unhandled errors.

- [ ] **Step 6: Commit client compatibility**

```bash
git add packages/stream-client/src/index.ts packages/stream-client/src/stream-client.test.ts apps/mobile/src
git commit -m "fix(mobile): preserve terminals across companion version skew"
```

### Task 3: Add a real app-sidecar KSP E2E gate

**Files:**
- Create: `apps/desktop/tests/e2e/real/mobile-server-ksp-capabilities.test.ts`

- [ ] **Step 1: Write the failing E2E test against the current app sidecar**

The test creates a WebDriver session, calls `resolveAppKannaServer(client)`, opens
`${baseUrl}/v1/stream`, sends `{ type: "auth" }`, and waits for `auth_ok`. It
asserts `stream_kinds` contains all three current kinds, then sends:

```typescript
{
  type: "attach",
  task_id: "missing-e2e-task",
  kind: "companion",
  from_seq: 0,
}
```

The response may be `companion_unavailable` or a task-scoped availability error,
but the test fails immediately if it sees `code: "bad_frame"` or a message
containing `unparseable frame`.

- [ ] **Step 2: Run E2E against a pre-change/stale sidecar and verify RED**

Run:

```bash
pnpm --dir apps/desktop test:e2e -- real/mobile-server-ksp-capabilities.test.ts
```

Expected before rebuilding the sidecar: FAIL because `auth_ok.stream_kinds` is absent, which demonstrates the E2E detects client/server binary skew.

- [ ] **Step 3: Build and stage the current server through the canonical workflow**

Run:

```bash
./kd build sidecars
```

Expected: the task-private staged `kanna-server-<host-target>` is refreshed.

- [ ] **Step 4: Re-run E2E and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test:e2e -- real/mobile-server-ksp-capabilities.test.ts
```

Expected: PASS; the app-launched sidecar advertises companion support and parses the attach frame without `bad_frame`.

- [ ] **Step 5: Commit the E2E gate**

```bash
git add apps/desktop/tests/e2e/real/mobile-server-ksp-capabilities.test.ts
git commit -m "test(e2e): verify shipped KSP companion capability"
```

### Task 4: Final verification

**Files:**
- Verify all files changed in Tasks 1-3.

- [ ] **Step 1: Run canonical focused verification**

```bash
pnpm test
./kd test rust
```

Expected: both canonical suites pass.

- [ ] **Step 2: Check generated bindings and diff hygiene**

```bash
./scripts/check-agent-protocol-types.sh
git diff --check HEAD~3
git status --short
```

Expected: generated bindings are current, no whitespace errors exist, and only expected generated/staged artifacts remain.

- [ ] **Step 3: Review the final commit range**

```bash
git log --oneline --decorate -5
git diff --stat 45a9bf03^..HEAD
```

Expected: the range contains the design, protocol negotiation, client compatibility, and E2E gate with no unrelated changes.
