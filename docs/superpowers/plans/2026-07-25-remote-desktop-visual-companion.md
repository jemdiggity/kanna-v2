# Remote Desktop Visual Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user click a visual-companion localhost link in a remote desktop task terminal and use that companion in their ordinary local browser over either LAN or relay, with no remote-specific UX.

**Architecture:** Extend the existing bounded companion document/event protocol with validated source-origin and asset data. Extract shared Rust and TypeScript companion cores, carry the same model over KSP and paired LAN, and add a Tauri loopback HTTP/WebSocket bridge whose URL is substituted only for the active remote companion link. Mobile keeps its existing WebView adapter on top of the same shared core.

**Tech Stack:** Rust 2021, Tauri v2, Tokio, Axum WebSockets, Vue 3, TypeScript, React Native WebView, KSP, `kanna-task-transfer`, Vitest, Cargo tests, WebdriverIO.

---

## File and Responsibility Map

### Shared protocol and source

- `crates/kanna-agent-protocol/src/frames.rs` — wire-source definitions for companion assets and enriched snapshots.
- `packages/agent-protocol/src/generated/*` — generated TypeScript mirrors; never edit manually.
- `crates/visual-companion/src/lib.rs` — public filesystem-source and event-sink API.
- `crates/visual-companion/src/discovery.rs` — secure active-session, origin, document, and asset discovery.
- `crates/visual-companion/src/event.rs` — bounded revision-checked event validation and append.
- `crates/visual-companion/src/tests.rs` — filesystem, origin, asset, and event security tests.
- `crates/kanna-server/src/visual_companion.rs` — thin DB-to-workspace adapter only.
- `crates/kanna-server/src/ksp.rs` — KSP companion bundle publication and event handling.

### Shared TypeScript companion core

- `packages/visual-companion/src/types.ts` — platform-neutral snapshot, state, and adapter types.
- `packages/visual-companion/src/state.ts` — companion lifecycle reducer and event-result state.
- `packages/visual-companion/src/document.ts` — shared fragment frame and adapter-driven event bridge.
- `packages/visual-companion/src/event.ts` — strict event parsing, byte limits, and event IDs.
- `packages/visual-companion/src/*.test.ts` — shared behavior tests.
- `apps/mobile/src/screens/VisualCompanionModal.tsx` — mobile-only modal and WebView adapter.
- `apps/mobile/src/screens/buildVisualCompanionDocument.ts` — compatibility re-export during migration.
- `apps/mobile/src/state/sessionStore.ts` — mobile store delegates companion transitions to shared reducer.

### Remote transports

- `packages/stream-client/src/index.ts` — enriched companion snapshots over KSP.
- `apps/desktop/src/services/desktopRemoteTaskClient.ts` — common desktop terminal/companion/action interface.
- `apps/desktop/src/services/desktopRelayTerminal.ts` — relay implementation of the common interface.
- `apps/desktop/src/services/desktopLanTerminal.ts` — paired-LAN implementation of the common interface.
- `crates/task-transfer/src/protocol.rs` — LAN companion observe/event protocol using `kanna-agent-protocol` payloads.
- `crates/task-transfer/src/runtime/companion.rs` — owner/viewer LAN companion stream lifecycle.
- `apps/desktop/src-tauri/src/transfer_sidecar.rs` — sidecar request methods and companion event forwarding.
- `apps/desktop/src-tauri/src/commands/transfer.rs` — Tauri LAN companion commands.

### Desktop browser adapter

- `apps/desktop/src-tauri/src/companion_bridge.rs` — loopback listener, capability cookie, HTTP assets, WebSocket reload/events, entry lifecycle.
- `apps/desktop/src-tauri/src/commands/companion.rs` — narrow bridge upsert/state/event-result commands.
- `apps/desktop/src/services/desktopCompanionBridge.ts` — frontend bridge manager and Tauri event adapter.
- `apps/desktop/src/services/remoteCompanionLink.ts` — exact-origin link resolution.
- `apps/desktop/src/components/CloudTerminalView.vue` — remote terminal companion attachment and link activation.
- `apps/desktop/src/i18n/locales/{en,ja,ko}.json` — starting/error toast strings.

### End-to-end coverage

- `apps/desktop/tests/e2e/helpers/remoteCompanion.ts` — scripted remote companion fixture and browser-bridge probes.
- `apps/desktop/tests/e2e/real/remote-visual-companion.test.ts` — relay/LAN-neutral desktop journey.

## Task 1: Extend the generated companion protocol

**Files:**
- Modify: `crates/kanna-agent-protocol/src/frames.rs`
- Modify: `crates/kanna-agent-protocol/src/lib.rs`
- Generate: `packages/agent-protocol/src/generated/CompanionAsset.ts`
- Generate: `packages/agent-protocol/src/generated/ServerFrame.ts`
- Modify: `packages/agent-protocol/src/index.ts`

- [ ] **Step 1: Write the failing Rust round-trip test**

Add to the existing companion protocol test in `frames.rs`:

```rust
let asset = CompanionAsset {
    name: "layout.png".into(),
    content_type: "image/png".into(),
    digest: "asset-digest".into(),
    data_b64: "aGVsbG8=".into(),
};
let snapshot = ServerFrame::CompanionSnapshot {
    task_id: "task-1".into(),
    session_id: "session-1".into(),
    revision: "revision-1".into(),
    document_kind: CompanionDocumentKind::Fragment,
    html: "<h2>Hello</h2>".into(),
    source_origin: Some("http://localhost:52341".into()),
    assets: vec![asset.clone()],
};
let json = serde_json::to_value(&snapshot).unwrap();
assert_eq!(json["source_origin"], "http://localhost:52341");
assert_eq!(json["assets"][0]["name"], "layout.png");
assert_eq!(serde_json::from_value::<ServerFrame>(json).unwrap(), snapshot);
```

- [ ] **Step 2: Run the test and verify the new type is missing**

Run:

```bash
cargo test -p kanna-agent-protocol companion_frames_round_trip_and_preserve_wire_names
```

Expected: compilation fails because `CompanionAsset`, `source_origin`, and `assets` do not exist.

- [ ] **Step 3: Add the protocol type and fields**

Add beside `CompanionEvent`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct CompanionAsset {
    pub name: String,
    pub content_type: String,
    pub digest: String,
    pub data_b64: String,
}
```

Extend `ServerFrame::CompanionSnapshot`:

```rust
CompanionSnapshot {
    task_id: String,
    session_id: String,
    revision: String,
    document_kind: CompanionDocumentKind,
    html: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_origin: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    assets: Vec<CompanionAsset>,
},
```

Re-export `CompanionAsset` from `crates/kanna-agent-protocol/src/lib.rs`.

- [ ] **Step 4: Regenerate TypeScript and verify drift**

Run:

```bash
./scripts/generate-agent-protocol-types.sh
./scripts/check-agent-protocol-types.sh
cargo test -p kanna-agent-protocol companion_frames_round_trip_and_preserve_wire_names
pnpm --dir packages/agent-protocol typecheck
```

Expected: generation reports updated companion files; checks and test pass.

- [ ] **Step 5: Commit**

```bash
git add crates/kanna-agent-protocol packages/agent-protocol
git commit -m "feat(protocol): describe companion origins and assets"
```

## Task 2: Extract the secure Rust companion core without behavior changes

**Files:**
- Create: `crates/visual-companion/Cargo.toml`
- Create: `crates/visual-companion/BUILD.bazel`
- Create: `crates/visual-companion/src/lib.rs`
- Create: `crates/visual-companion/src/discovery.rs`
- Create: `crates/visual-companion/src/event.rs`
- Create: `crates/visual-companion/src/tests.rs`
- Modify: `Cargo.toml`
- Modify: `crates/kanna-server/Cargo.toml`
- Modify: `crates/kanna-server/BUILD.bazel`
- Modify: `crates/kanna-server/src/visual_companion.rs`
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Add an API-level extraction test**

Create `crates/visual-companion/src/tests.rs` with a fixture that receives a
workspace path directly:

```rust
#[test]
fn discovers_current_document_from_explicit_workspace() {
    let fixture = Fixture::new();
    fixture.active_session("session-a", "screen.html", "<h2>A</h2>");

    let document = current_bundle(fixture.worktree()).unwrap().unwrap();

    assert_eq!(document.session_id, "session-a");
    assert_eq!(document.html, "<h2>A</h2>");
    assert_eq!(document.document_kind, CompanionDocumentKind::Fragment);
}
```

Move the existing `visual_companion.rs` fixture helpers into this test module,
changing DB/task setup to pass `fixture.worktree()` into the shared API.

- [ ] **Step 2: Create the crate skeleton and verify the test fails**

`Cargo.toml`:

```toml
[package]
name = "kanna-visual-companion"
version = "0.1.0"
edition = "2021"

[dependencies]
base64 = "0.22"
libc = "0.2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
kanna-agent-protocol = { path = "../kanna-agent-protocol" }

[dev-dependencies]
tempfile = "3"
```

Add `"crates/visual-companion"` to the root Cargo workspace and run:

```bash
cargo test -p kanna-visual-companion
```

Expected: failure because `current_bundle` and `Fixture` are not implemented.

- [ ] **Step 3: Move the filesystem and event code**

Expose this exact API from `src/lib.rs`:

```rust
mod discovery;
mod event;

pub use discovery::{
    current_bundle, CompanionBundle, CompanionError, MAX_COMPANION_HTML_BYTES,
};
pub use event::append_event;

#[cfg(test)]
mod tests;
```

`current_bundle(workspace: &Path)` and:

```rust
append_event(
    workspace: &Path,
    session_id: &str,
    revision: &str,
    event: &CompanionEvent,
) -> Result<(), CompanionError>
```

must contain the existing descriptor-relative/no-follow logic. Leave only DB
resolution in Kanna Server:

```rust
pub fn current_bundle(
    db_path: &str,
    task_id: &str,
) -> Result<Option<kanna_visual_companion::CompanionBundle>, CompanionError> {
    let workspace = current_workspace(db_path, task_id)?;
    kanna_visual_companion::current_bundle(&workspace)
}
```

Map `kanna_visual_companion::CompanionError` directly in `ksp.rs`.

- [ ] **Step 4: Add Bazel targets for both consumers**

Define `kanna_visual_companion_for_server` and
`kanna_visual_companion_for_task_transfer` in `BUILD.bazel`, following the
multi-universe pattern in `crates/kanna-agent-protocol/BUILD.bazel`. Add the
server target to `crates/kanna-server/BUILD.bazel`.

- [ ] **Step 5: Run extraction verification**

```bash
cargo test -p kanna-visual-companion
cargo test -p kanna-server visual_companion
```

Expected: all moved tests pass with no behavior changes.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml Cargo.lock crates/visual-companion crates/kanna-server
git commit -m "refactor: share visual companion filesystem core"
```

## Task 3: Add validated origins and bounded asset bundles

**Files:**
- Modify: `crates/visual-companion/src/discovery.rs`
- Modify: `crates/visual-companion/src/tests.rs`

- [ ] **Step 1: Write origin-validation tests**

Add table-driven tests:

```rust
for (raw, expected) in [
    (r#"{"url":"http://localhost:52341"}"#, Some("http://localhost:52341")),
    (r#"{"url":"http://127.0.0.1:52341/"}"#, Some("http://127.0.0.1:52341")),
    (r#"{"url":"http://[::1]:52341"}"#, Some("http://[::1]:52341")),
    (r#"{"url":"https://localhost:52341"}"#, None),
    (r#"{"url":"http://example.com:52341"}"#, None),
    (r#"{"url":"http://user@localhost:52341"}"#, None),
    (r#"{"url":"http://localhost:52341/?secret=1"}"#, None),
] {
    fixture.write_server_info(raw);
    assert_eq!(
        current_bundle(fixture.worktree()).unwrap().unwrap().source_origin.as_deref(),
        expected
    );
}
```

- [ ] **Step 2: Write asset security and bounds tests**

Cover:

```rust
assert_eq!(bundle.assets[0].name, "layout.png");
assert_eq!(bundle.assets[0].content_type, "image/png");
assert_eq!(STANDARD.decode(&bundle.assets[0].data_b64).unwrap(), b"PNG");
assert!(!bundle.assets.iter().any(|asset| asset.name == "screen.html"));
assert!(!bundle.assets.iter().any(|asset| asset.name == "linked.png"));
assert_eq!(bundle.assets.len(), MAX_COMPANION_ASSET_COUNT);
let total_bytes = bundle.assets.iter()
    .map(|asset| STANDARD.decode(&asset.data_b64).unwrap().len())
    .sum::<usize>();
assert!(total_bytes <= MAX_COMPANION_ASSET_TOTAL_BYTES as usize);
```

Fixtures must include a symlink, a 4 MiB + 1 byte file, 33 small assets, an
unknown extension, and a document replacement that changes one asset digest.

- [ ] **Step 3: Run focused tests and confirm failure**

```bash
cargo test -p kanna-visual-companion origin
cargo test -p kanna-visual-companion asset
```

Expected: failures because bundles do not yet include origin or assets.

- [ ] **Step 4: Implement the bundle model and limits**

Add:

```rust
pub const MAX_COMPANION_ASSET_COUNT: usize = 32;
pub const MAX_COMPANION_ASSET_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_COMPANION_ASSET_TOTAL_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompanionBundle {
    pub session_id: String,
    pub revision: String,
    pub document_kind: CompanionDocumentKind,
    pub html: String,
    pub source_origin: Option<String>,
    pub assets: Vec<CompanionAsset>,
}
```

Parse `state/server-info` as JSON, normalize only allowed loopback HTTP origins,
and enumerate direct regular files in deterministic bytewise filename order.
Use `openat` plus `O_NOFOLLOW`; never reopen by a joined absolute path. Compute
the revision over document bytes plus ordered asset name/digest pairs.

- [ ] **Step 5: Verify limits and server compatibility**

```bash
cargo test -p kanna-visual-companion
cargo test -p kanna-server companion
```

Expected: all source and existing KSP tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/visual-companion
git commit -m "feat(companion): discover loopback origins and assets"
```

## Task 4: Carry enriched snapshots through KSP and StreamClient

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `packages/stream-client/src/index.ts`
- Modify: `packages/stream-client/src/stream-client.test.ts`

- [ ] **Step 1: Write failing server and client tests**

In the KSP attach test, assert:

```rust
match frame {
    ServerFrame::CompanionSnapshot {
        source_origin,
        assets,
        ..
    } => {
        assert_eq!(source_origin.as_deref(), Some("http://localhost:52341"));
        assert_eq!(assets[0].name, "layout.png");
    }
    other => panic!("expected companion snapshot, got {other:?}"),
}
```

In `stream-client.test.ts`:

```ts
socket.receive({
  type: "companion_snapshot",
  task_id: "task-1",
  session_id: "session-1",
  revision: "revision-2",
  document_kind: "fragment",
  html: "<h2>Updated</h2>",
  source_origin: "http://localhost:52341",
  assets: [{
    name: "layout.png",
    content_type: "image/png",
    digest: "asset-1",
    data_b64: "UE5H",
  }],
});
expect(snapshots.at(-1)).toMatchObject({
  sourceOrigin: "http://localhost:52341",
  assets: [{ name: "layout.png", contentType: "image/png" }],
});
```

- [ ] **Step 2: Run the focused tests and see the missing mapping**

```bash
cargo test -p kanna-server companion_attach_streams_latest_transitions_and_detaches
pnpm --dir packages/stream-client test -- stream-client.test.ts
```

Expected: server construction or client assertion fails.

- [ ] **Step 3: Publish and map complete bundles**

Construct:

```rust
ServerFrame::CompanionSnapshot {
    task_id,
    session_id: bundle.session_id,
    revision: bundle.revision,
    document_kind: bundle.document_kind,
    html: bundle.html,
    source_origin: bundle.source_origin,
    assets: bundle.assets,
}
```

Extend `CompanionSnapshot` in `packages/stream-client`:

```ts
export interface CompanionAssetSnapshot {
  name: string;
  contentType: string;
  digest: string;
  dataB64: string;
}

export interface CompanionSnapshot {
  sessionId: string;
  revision: string;
  documentKind: CompanionDocumentKind;
  html: string;
  sourceOrigin?: string;
  assets: CompanionAssetSnapshot[];
}
```

Map absent arrays to `[]` so mobile and older fixtures remain compatible.

- [ ] **Step 4: Verify coalescing and latency**

```bash
cargo test -p kanna-server companion
pnpm --dir packages/stream-client test
```

Expected: companion coalescing, reconnect, UTF-8, and starvation tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/kanna-server packages/stream-client
git commit -m "feat(stream-client): carry complete companion bundles"
```

## Task 5: Extract the shared TypeScript companion package and preserve mobile

**Files:**
- Create: `packages/visual-companion/package.json`
- Create: `packages/visual-companion/tsconfig.json`
- Create: `packages/visual-companion/BUILD.bazel`
- Create: `packages/visual-companion/src/types.ts`
- Create: `packages/visual-companion/src/state.ts`
- Create: `packages/visual-companion/src/document.ts`
- Create: `packages/visual-companion/src/event.ts`
- Create: `packages/visual-companion/src/index.ts`
- Create: `packages/visual-companion/src/document.test.ts`
- Create: `packages/visual-companion/src/event.test.ts`
- Create: `packages/visual-companion/src/state.test.ts`
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/src/screens/buildVisualCompanionDocument.ts`
- Modify: `apps/mobile/src/screens/VisualCompanionModal.tsx`
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Move shared tests first**

Move document-builder cases and strict event parsing cases from the mobile tests
into the new package. Add reducer coverage:

```ts
expect(reduceCompanionState(initialCompanionState(), {
  type: "snapshot",
  snapshot,
})).toMatchObject({
  status: "available",
  snapshot,
  eventStatus: "idle",
});
expect(reduceCompanionState(available, {
  type: "connection",
  connected: false,
})).toMatchObject({
  status: "reconnecting",
  snapshot,
});
```

- [ ] **Step 2: Create package metadata and verify tests fail**

`package.json`:

```json
{
  "name": "@kanna/visual-companion",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run --maxWorkers=2",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@kanna/agent-protocol": "workspace:*",
    "@kanna/stream-client": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5",
    "vitest": "^4.1.4"
  }
}
```

Run:

```bash
pnpm install --lockfile-only
pnpm --dir packages/visual-companion test
```

Expected: failures because shared exports are missing.

- [ ] **Step 3: Implement the platform-neutral API**

Export:

```ts
export type CompanionDeliveryTarget =
  | { kind: "react-native" }
  | {
      kind: "websocket";
      path: string;
      sessionId: string;
      revision: string;
    };

export function buildCompanionDocument(input: {
  documentKind: CompanionDocumentKind;
  html: string;
  target: CompanionDeliveryTarget;
}): string;

export function parseCompanionBridgeEvent(data: string): CompanionEvent | null;
export function nextCompanionEventId(prefix: string, now: number, counter: number): string;
export function reduceCompanionState(
  state: CompanionState,
  action: CompanionAction,
): CompanionState;
```

Preserve mobile's existing CSP and native-message adapter. The WebSocket adapter
connects to the same origin and presents the rendered session/revision as a
percent-encoded document-identity query. It sends bounded events with generated
IDs, receives `event_result` and `status` messages, and reloads on `reload`.
Reject WebSocket base paths that already contain a query or fragment.

- [ ] **Step 4: Adapt mobile without changing behavior**

Make `buildVisualCompanionDocument.ts` a compatibility wrapper:

```ts
import { buildCompanionDocument } from "@kanna/visual-companion";

export function buildVisualCompanionDocument(input: {
  documentKind: CompanionDocumentKind;
  html: string;
}): string {
  return buildCompanionDocument({
    ...input,
    target: { kind: "react-native" },
  });
}
```

Keep the modal call signature unchanged and delegate companion lifecycle
transitions in `sessionStore.ts` to the reducer while retaining mobile field
names at the store boundary.

- [ ] **Step 5: Run shared and mobile suites**

```bash
pnpm --dir packages/visual-companion test
pnpm --dir packages/visual-companion typecheck
pnpm --dir apps/mobile test -- buildVisualCompanionDocument.test.ts VisualCompanionModal.test.tsx TaskScreen.test.tsx sessionStore.test.ts
pnpm --dir apps/mobile typecheck
```

Expected: shared tests pass and mobile snapshots/behavior remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/visual-companion apps/mobile pnpm-lock.yaml
git commit -m "refactor(mobile): share visual companion core"
```

## Task 6: Add companion observation to the desktop relay client

**Files:**
- Create: `apps/desktop/src/services/desktopRemoteTaskClient.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.test.ts`

- [ ] **Step 1: Write the common-interface contract test**

Add:

```ts
const events: DesktopRemoteCompanionEvent[] = [];
const subscription = client.observeCompanion({
  desktopId: "desktop-1",
  taskId: "task-1",
  listener: (event) => events.push(event),
});
socket.open();
socket.receive(companionSnapshotFrame);
expect(events.at(-1)).toMatchObject({
  type: "snapshot",
  taskId: "task-1",
  snapshot: { sourceOrigin: "http://localhost:52341" },
});
expect(subscription.sendEvent("session-1", "revision-1", choice)).toBe(true);
expect(socket.sent.at(-1)).toMatchObject({ type: "companion_event" });
```

- [ ] **Step 2: Run the test and confirm the method is absent**

```bash
pnpm --dir apps/desktop test -- desktopRelayTerminal.test.ts
```

Expected: TypeScript or assertion failure for `observeCompanion`.

- [ ] **Step 3: Define the transport-neutral desktop interface**

`desktopRemoteTaskClient.ts` exports:

```ts
export interface DesktopRemoteCompanionSubscription {
  close(): void;
  sendEvent(sessionId: string, revision: string, event: CompanionEvent): boolean;
}

export interface DesktopRemoteTaskClient {
  close(): void;
  observeTerminal(options: ObserveDesktopRemoteTerminalOptions): DesktopRemoteTerminalSubscription;
  observeCompanion(options: ObserveDesktopRemoteCompanionOptions): DesktopRemoteCompanionSubscription;
  sendInput(options: SendRemoteTerminalInputOptions): Promise<void>;
  resize(options: ResizeRemoteTerminalOptions): Promise<void>;
  closeTask(options: RemoteTaskActionOptions): Promise<void>;
  advanceStage(options: RemoteTaskActionOptions): Promise<void>;
}
```

Move shared terminal types out of the relay implementation and leave
compatibility type re-exports there.

- [ ] **Step 4: Implement relay attachment**

Use the existing per-desktop `StreamClient`:

```ts
observeCompanion(options) {
  const client = clientForDesktop(options.desktopId);
  client.attachCompanion(options.taskId, {
    onSnapshot: (snapshot) =>
      options.listener({ type: "snapshot", taskId: options.taskId, snapshot }),
    onUnavailable: () =>
      options.listener({ type: "unavailable", taskId: options.taskId }),
    onEventResult: (result) =>
      options.listener({ type: "event_result", taskId: options.taskId, result }),
    onConnectionChange: (connected) =>
      options.listener({ type: "connection", taskId: options.taskId, connected }),
    onError: (code, message) =>
      options.listener({ type: "error", taskId: options.taskId, code, message }),
  });
  return {
    close: () => client.detach(options.taskId, "companion"),
    sendEvent: (sessionId, revision, event) =>
      client.sendCompanionEvent(options.taskId, sessionId, revision, event),
  };
}
```

- [ ] **Step 5: Verify**

```bash
pnpm --dir apps/desktop test -- desktopRelayTerminal.test.ts
```

Expected: relay terminal, actions, and companion tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/services/desktopRemoteTaskClient.ts apps/desktop/src/services/desktopRelayTerminal*
git commit -m "feat(desktop): observe relay visual companions"
```

## Task 7: Carry the shared companion model over paired LAN

**Files:**
- Modify: `crates/task-transfer/Cargo.toml`
- Modify: `crates/task-transfer/BUILD.bazel`
- Modify: `crates/task-transfer/src/protocol.rs`
- Create: `crates/task-transfer/src/runtime/companion.rs`
- Modify: `crates/task-transfer/src/runtime/mod.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/events.rs`
- Modify: `crates/task-transfer/src/runtime/tests.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.test.ts`

- [ ] **Step 1: Write protocol round-trip tests**

Add requests and events:

```rust
let observe = PeerRequest::ObserveCompanion {
    request_id: "r1".into(),
    requester_peer_id: "viewer".into(),
    task_id: "task-1".into(),
};
let event = PeerCompanionEvent::Frame(ServerFrame::CompanionUnavailable {
    task_id: "task-1".into(),
});
assert_eq!(round_trip(observe.clone()), observe);
assert_eq!(round_trip(event.clone()), event);
```

Also cover `SendCompanionEvent` with the generated `CompanionEvent`.

- [ ] **Step 2: Run task-transfer tests and confirm variants are missing**

```bash
cargo test -p kanna-task-transfer protocol
```

Expected: compilation fails for missing companion variants.

- [ ] **Step 3: Add protocol variants and dependencies**

Add `kanna-agent-protocol` and `kanna-visual-companion` Cargo/Bazel dependencies.
Define:

```rust
ObserveCompanion { request_id: String, requester_peer_id: String, task_id: String },
SendCompanionEvent {
    request_id: String,
    requester_peer_id: String,
    task_id: String,
    session_id: String,
    revision: String,
    event: CompanionEvent,
},
```

Add matching control requests/responses and:

```rust
pub enum SidecarEvent {
    CompanionEvent {
        peer_id: String,
        task_id: String,
        frame: ServerFrame,
    },
}
```

- [ ] **Step 4: Implement owner and viewer lifecycle**

`runtime/companion.rs` resolves the owner task workspace from `RuntimeConfig.db_path`,
calls `kanna_visual_companion::current_bundle`, polls only while observed, emits
latest-value `ServerFrame` values, and calls `append_event` for selections.
Use an observer map keyed by `peer_id:task_id`, abort old observers on reattach,
and remove handles on unobserve or disconnect.

- [ ] **Step 5: Expose Tauri sidecar commands and frontend events**

Add narrow methods:

```rust
observe_peer_companion(peer_id, task_id)
unobserve_peer_companion(peer_id, task_id)
send_peer_companion_event(peer_id, task_id, session_id, revision, event)
```

Forward sidecar notifications as `transfer-companion-event`, retaining
`peer_id`, `task_id`, and the shared `ServerFrame`.

- [ ] **Step 6: Implement the LAN desktop adapter**

`desktopLanTerminal.ts` listens once for `transfer-companion-event`, normalizes
the embedded shared frame to `DesktopRemoteCompanionEvent`, and returns a
subscription whose `sendEvent` invokes `send_transfer_peer_companion_event`.

- [ ] **Step 7: Verify LAN behavior**

```bash
cargo test -p kanna-task-transfer companion
cd apps/desktop/src-tauri && cargo test transfer_sidecar::tests::companion
cd ../../..
pnpm --dir apps/desktop test -- desktopLanTerminal.test.ts
```

Expected: trusted observation, bundle updates, event results, unobserve, and
disconnect cleanup pass.

- [ ] **Step 8: Commit**

```bash
git add crates/task-transfer apps/desktop/src-tauri apps/desktop/src/services/desktopLanTerminal*
git commit -m "feat(lan): stream paired visual companions"
```

## Task 8: Build the Tauri loopback companion bridge

**Files:**
- Create: `apps/desktop/src-tauri/src/companion_bridge.rs`
- Create: `apps/desktop/src-tauri/src/commands/companion.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `Cargo.desktop.lock`
- Modify: `MODULE.bazel.lock`
- Verify: `apps/desktop/src-tauri/BUILD.bazel`

- [ ] **Step 1: Write bridge HTTP and WebSocket tests**

Using an in-process bridge manager, assert:

```rust
let entry = manager.upsert(bundle("session-1", "revision-1")).await.unwrap();
let unauthorized = reqwest::get(format!("{}/", entry.base_url)).await.unwrap();
assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

let authorized = client
    .get(format!("{}/?cap={}", entry.base_url, entry.capability))
    .send().await.unwrap();
assert!(authorized.status().is_redirection());

let document = client.get(format!("{}/", entry.base_url)).send().await.unwrap();
assert!(document.text().await.unwrap().contains("Choose a layout"));

let asset = client.get(format!("{}/files/layout.png", entry.base_url))
    .send().await.unwrap();
assert_eq!(asset.bytes().await.unwrap().as_ref(), b"PNG");
```

Add separate tests for wrong Origin, missing cookie, reload after atomic bundle
replacement, bounded event forwarding, two isolated entries, grace cleanup,
unavailable state, and shutdown.

- [ ] **Step 2: Add dependencies and confirm tests fail**

Add to desktop Cargo:

```toml
axum = { version = "0.8", features = ["ws"] }
futures-util = "0.3"
getrandom = "0.3"
http = "1"
```

Run:

```bash
cd apps/desktop/src-tauri
cargo test companion_bridge
```

Expected: missing bridge module/API failures.

- [ ] **Step 3: Implement focused bridge state**

Define:

```rust
pub struct CompanionBridgeManager {
    entries: Mutex<HashMap<CompanionBridgeKey, Arc<CompanionBridgeEntry>>>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
pub struct CompanionBridgeKey {
    pub owner_desktop_id: String,
    pub owner_task_id: String,
    pub session_id: String,
}
```

Each entry owns one `TcpListener` bound to `127.0.0.1:0`, a cryptographically
random host-only `<token>.localhost:<port>` advertised origin, an atomically
swapped bundle, a bundle-identity reload watch, a payload-free lifecycle
wakeup channel, a separate 128-bit capability from `getrandom`, and a shutdown
token. A browser handles each wakeup by re-reading the authoritative lifecycle
and document identity under the entry lock, so concurrent calls cannot publish
captured states out of commit order. The random localhost hostname, not the
ephemeral port, is the cookie-isolation boundary because cookies do not honor
ports.

- [ ] **Step 4: Implement the narrow HTTP contract**

Routes:

```text
GET /?cap=<hex>        -> Set-Cookie + 303 /
GET /                  -> current document or lifecycle page
GET /files/<basename>  -> current bounded asset
GET /ws?sessionId=<id>&revision=<revision>
                       -> authenticated, identity-bound same-origin WebSocket
```

Reject all other methods/paths and every request whose `Host` is not the exact
advertised random localhost hostname and port. Parse cookies without reflecting
them. Use a host-only `HttpOnly; SameSite=Strict; Path=/` cookie; validate exact
`Origin` against the advertised base URL before WebSocket upgrade. Tests must
prove a real cookie jar does not send the token to `127.0.0.1` or a sibling
random localhost hostname. Never log content, event bodies, or capabilities.

- [ ] **Step 5: Register commands and managed state**

Commands:

```rust
upsert_remote_companion_bridge(input) -> { entry_url, bridge_id }
set_remote_companion_bridge_state(input) -> ()
set_remote_companion_event_result(input) -> ()
close_remote_companion_bridge(input) -> ()
```

Browser events emit `remote-companion-browser-event` with `bridge_id`,
session/revision, and the already validated `CompanionEvent`.

- [ ] **Step 6: Verify Rust and release boundaries**

```bash
cd apps/desktop/src-tauri
cargo test companion_bridge
cargo test commands::companion
cd ../../..
./kd build sidecars
```

Expected: tests pass and the bridge links from vendored Cargo/Bazel inputs only.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri
git commit -m "feat(desktop): serve loopback companion mirrors"
```

## Task 9: Add the desktop bridge manager and exact-origin resolver

**Files:**
- Create: `apps/desktop/src/services/desktopCompanionBridge.ts`
- Create: `apps/desktop/src/services/desktopCompanionBridge.test.ts`
- Create: `apps/desktop/src/services/remoteCompanionLink.ts`
- Create: `apps/desktop/src/services/remoteCompanionLink.test.ts`
- Modify: `apps/desktop/src/env.d.ts`

- [ ] **Step 1: Write resolver tests**

```ts
expect(resolveRemoteCompanionLink({
  clickedUrl: "http://localhost:52341",
  sourceOrigin: "http://localhost:52341",
})).toEqual({ kind: "companion" });
expect(resolveRemoteCompanionLink({
  clickedUrl: "http://localhost:52342",
  sourceOrigin: "http://localhost:52341",
})).toEqual({ kind: "ordinary", url: "http://localhost:52342" });
expect(resolveRemoteCompanionLink({
  clickedUrl: "https://example.com",
  sourceOrigin: "http://localhost:52341",
})).toEqual({ kind: "ordinary", url: "https://example.com/" });
```

Also reject credentials, malformed URLs, and source origins without an explicit
port.

- [ ] **Step 2: Write bridge-manager tests**

Mock Tauri invoke/listen and a parent `DesktopRemoteTaskClient`. The manager
must install `observeCompanion` itself after inserting the canonical remote
entry, so synchronous snapshot/unavailable/error callbacks cannot be lost:

```ts
const transport = createRemoteTaskClientMock(subscription, {
  onObserve(listener) {
    listener({ type: "snapshot", taskId: "task-1", snapshot });
  },
});
manager.adoptRemote({
  remoteKey,
  ownerDesktopId: "desktop-1",
  ownerTaskId: "task-1",
  transport,
});
const opened = await manager.openForClickedLink(remoteKey, "http://localhost:52341");
expect(invoke).toHaveBeenCalledWith("upsert_remote_companion_bridge",
  expect.objectContaining({ ownerTaskId: "task-1" }));
expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:61234/?cap=secret");

emitBrowserEvent(choice);
expect(subscription.sendEvent).toHaveBeenCalledWith(
  "session-1", "revision-1", choice,
);
```

Assert that the upsert's `documentHtml` is built with:

```ts
buildCompanionDocument({
  documentKind: snapshot.documentKind,
  html: snapshot.documentHtml,
  target: {
    kind: "websocket",
    path: "/ws",
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
  },
});
```

Cover event results, reconnect/unavailable/error state, task selection changes,
multiple entries, close-after-grace, and bounded concurrent publication. Each
remote uses one fair actor: one active IPC bundle plus one replaceable latest
complete pending bundle, coalesced authoritative lifecycle state, one
deduplicated same-session/source-origin activation, and correlated browser
results bounded to 64 per bridge and 1,024 globally within Rust's 64-event and
16-bridge resource envelope. Pending browser events expire after a configurable
30-second default deadline, publish a stable `event_timeout` failure while the
bridge is live, and release both bounds even when the browser disappeared before
the result IPC. Reliable disconnect/error event failures take the actor's
priority lane before the corresponding lifecycle transition; a successful
bundle swap instead drops prior pending identities because Rust clears them
atomically. New companion results carry exact session and revision identity;
legacy identity-less results become a sanitized incompatibility error and are
never routed heuristically by event ID. Every transient lifecycle IPC failure
uses one bounded, coalesced backoff timer that merely marks lifecycle dirty, so
the actor retries the latest status and selection rather than a captured stale
payload. Repeated `selected: false` probes rely on Rust's non-renewing grace
anchor, while a failed reselect retries soon enough to cancel that anchor.
Transport observations have their own generation gate, revoked before adapter
close, so queued callbacks from replaced ownership cannot mutate current state.
Activation publishing is derived from live bridge/session entries rather than a
separate session-membership cache. The OS opener runs outside terminal actor
cleanup so a terminal close can cancel the activation and close all ownership
even if the opener stalls; synchronous and asynchronous opener failures expose
only the stable `companion_open_failed` error and never the capability URL.
Unavailable publication is followed by an exact non-renewing existence probe;
stale browserless entries retire immediately while selected observation remains
alive. The generated document identity must always come from the exact snapshot
whose HTML is rendered, never from a later cached snapshot.

- [ ] **Step 3: Run tests and confirm modules are absent**

```bash
pnpm --dir apps/desktop test -- remoteCompanionLink.test.ts desktopCompanionBridge.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 4: Implement resolver and manager**

The resolver compares `new URL(clickedUrl).origin` to the validated
`sourceOrigin`. The manager:

- stores latest snapshots by remote key in a bounded per-remote actor;
- invokes bridge upsert only on a matching explicit click;
- renders each upsert through the shared WebSocket adapter with that snapshot's
  session and revision;
- records returned `bridgeId`;
- listens once for browser events;
- routes results/status back into the Rust bridge;
- owns `observeCompanion`, its returned subscription, and the transferred
  parent remote client while a browser is open;
  and
- exposes `dispose()` for app shutdown.

Add a development-only E2E hook that keeps the last resolved entry URL,
including its single-use capability exchange token, only in process memory.
Rust may return the same URL again while that token remains unconsumed and
returns a fresh token after consumption. The manager strictly validates and
opens either usable response but never logs or persists it. The hook is absent
from production builds.

- [ ] **Step 5: Verify frontend services**

```bash
pnpm --dir apps/desktop test -- remoteCompanionLink.test.ts desktopCompanionBridge.test.ts
pnpm --dir apps/desktop build
```

Expected: service tests and Vue typecheck pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/services/desktopCompanionBridge* apps/desktop/src/services/remoteCompanionLink* apps/desktop/src/env.d.ts
git commit -m "feat(desktop): resolve remote companion links locally"
```

## Task 10: Integrate companion links into the remote terminal

**Files:**
- Modify: `apps/desktop/src/components/CloudTerminalView.vue`
- Modify: `apps/desktop/src/components/__tests__/CloudTerminalView.test.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`

- [ ] **Step 1: Write component tests**

Mock the remote client and bridge manager:

```ts
expect(remoteClient.observeTerminal).toHaveBeenCalledWith(
  expect.objectContaining({ taskId: "task-1" }),
);
expect(remoteClient.observeCompanion).toHaveBeenCalledWith(
  expect.objectContaining({ taskId: "task-1" }),
);

webLinkHandler.activate(new MouseEvent("click"), "http://localhost:52341");
await flushPromises();
expect(companionBridge.openForClickedLink).toHaveBeenCalledWith(
  desktopCompanionRemoteKey("desktop-1", "task-1"),
  "http://localhost:52341",
);
```

Add cases for ordinary HTTPS links, click-before-snapshot toast, relay and LAN
factories, component unmount while browser ownership remains, theme, input, and
resize regression.

- [ ] **Step 2: Run the test and confirm companion attachment is absent**

```bash
pnpm --dir apps/desktop test -- CloudTerminalView.test.ts
```

Expected: failing companion observation/link assertions.

- [ ] **Step 3: Load the xterm web-link addon and attach companion state**

In `CloudTerminalView.vue`:

```ts
const companionBridge = getDesktopCompanionBridgeManager();
const remoteKey = desktopCompanionRemoteKey(
  props.ownerDesktopId,
  props.ownerTaskId,
);
terminal.loadAddon(new WebLinksAddon(handleRemoteLinkActivate));
companionOwnership = companionBridge.adoptRemote({
  remoteKey,
  ownerDesktopId: props.ownerDesktopId,
  ownerTaskId: props.ownerTaskId,
  transport: remoteClient,
});
```

Route ordinary links to the existing Tauri opener. Route exact active companion
origins to `openForClickedLink`. If no matching snapshot is ready, show the
localized starting toast and do not open the original URL.

During adoption the app-level bridge manager inserts the canonical owner/task
entry, calls `remoteClient.observeCompanion` with its own listener, and owns
both the returned companion subscription and parent remote client. Component
re-adoption with that same parent client reuses the installed observation;
replacement clients are observed transactionally, with bounded synchronous
callbacks staged until installation succeeds and the old ownership left
untouched if observation throws. Component
teardown closes only terminal-specific observers and calls
`companionOwnership.release()`; it must not close the manager-owned companion
subscription or parent client while an external browser may still be
connected.

- [ ] **Step 4: Add translations**

Add semantic keys:

```json
"remoteCompanionStarting": "Visual companion is still starting. Try again.",
"remoteCompanionOpenFailed": "Could not open the visual companion."
```

Provide equivalent Japanese and Korean strings following existing locale style.

- [ ] **Step 5: Run desktop component and build verification**

```bash
pnpm --dir apps/desktop test -- CloudTerminalView.test.ts MainPanel.test.ts
pnpm --dir apps/desktop build
```

Expected: remote terminal and main-panel suites pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/CloudTerminalView.vue apps/desktop/src/components/__tests__/CloudTerminalView.test.ts apps/desktop/src/i18n/locales
git commit -m "feat(desktop): open remote visual companion links"
```

## Task 11: Add the remote desktop end-to-end journey

**Files:**
- Create: `apps/desktop/tests/e2e/helpers/remoteCompanion.ts`
- Create: `apps/desktop/tests/e2e/real/remote-visual-companion.test.ts`
- Modify: `apps/desktop/src/e2eAppMetrics.ts`
- Modify: `apps/mobile/e2e/terminal-streaming-coverage.md`

- [ ] **Step 1: Add a failing scripted journey**

The fixture creates a real active session with:

```text
content/screen.html
content/layout.png
state/server-info
```

The E2E test:

```ts
await remoteTask.open();
await remoteTask.clickTerminalLink(fixture.sourceUrl);
const entryUrl = await app.waitForLatestCompanionEntryUrl();
const browser = await openCompanionProbe(entryUrl);
await expect(browser.text()).resolves.toContain(fixture.initialMarker);
await expect(browser.asset("layout.png")).resolves.toEqual(fixture.assetBytes);

await fixture.publishUpdatedScreen();
await browser.waitForText(fixture.updatedMarker);
await browser.clickChoice("a");
await expect.poll(() => fixture.events()).toContainEqual(
  expect.objectContaining({ choice: "a" }),
);

await remoteTask.disconnect();
await browser.waitForStatus("reconnecting");
await remoteTask.reconnect();
await browser.waitForText(fixture.updatedMarker);
await fixture.stop();
await browser.waitForStatus("ended");
```

- [ ] **Step 2: Run the E2E and verify the missing hooks**

```bash
pnpm --dir apps/desktop test:e2e:real -- remote-visual-companion.test.ts
```

Expected: failure because the E2E fixture/probe and metric hook are absent.

- [ ] **Step 3: Implement test-only observation hooks**

Expose only in development/E2E builds:

- the last issued bridge entry URL so the probe can perform the real
  single-use capability exchange (the URL may be reissued until consumed);
- bridge status by owner/task/session; and
- no document, asset, event, or cookie content.

The probe uses normal HTTP and WebSocket calls against the real Tauri listener;
it does not bypass the bridge manager or write owner events directly.

- [ ] **Step 4: Run relay and LAN variants**

```bash
pnpm --dir apps/desktop test:e2e:real -- remote-visual-companion.test.ts
pnpm --dir apps/mobile test:e2e:relay
```

Expected: desktop journey passes on both transport fixtures and the existing
mobile relay companion journey remains green.

- [ ] **Step 5: Update coverage documentation and commit**

Document that desktop external-browser behavior now has a real bridge journey
while physical-browser launch remains an OS integration smoke check.

```bash
git add apps/desktop/tests/e2e apps/desktop/src/e2eAppMetrics.ts apps/mobile/e2e/terminal-streaming-coverage.md
git commit -m "test(desktop): cover remote visual companions end to end"
```

## Task 12: Full verification and release-boundary audit

**Files:**
- Modify only if verification exposes a defect in files already listed above.

- [ ] **Step 1: Run generated-source and package checks**

```bash
./scripts/check-agent-protocol-types.sh
pnpm --dir packages/visual-companion test
pnpm --dir packages/visual-companion typecheck
pnpm --dir packages/stream-client test
```

Expected: all pass.

- [ ] **Step 2: Run focused Rust checks**

```bash
cargo test -p kanna-agent-protocol
cargo test -p kanna-visual-companion
cargo test -p kanna-server companion
cargo test -p kanna-task-transfer companion
cd apps/desktop/src-tauri && cargo test companion_bridge && cd ../../..
```

Expected: all pass without ignored failures.

- [ ] **Step 3: Run product suites**

```bash
pnpm --dir apps/mobile test
pnpm --dir apps/mobile typecheck
pnpm --dir apps/desktop test
pnpm --dir apps/desktop build
pnpm test
./kd test rust
```

Expected: all canonical suites pass.

- [ ] **Step 4: Audit resource and release boundaries**

Verify with targeted searches:

```bash
rg -n "companion.*(html|asset|event|capab)" apps/desktop/src-tauri crates/kanna-server crates/task-transfer
otool -L .build/debug/kanna-desktop
git diff --check
git status --short
```

Expected:

- no companion content/capability logging;
- no Homebrew or non-system dynamic-library dependency;
- no uncommitted generated protocol drift;
- no whitespace errors; and
- only intentional task changes remain.

If verification exposes a defect, return to the task that owns that component,
add a focused failing regression test, fix it, rerun that task's checks, and
commit the test and fix together before repeating Task 12.
