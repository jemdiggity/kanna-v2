# Mobile Visual Companion Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream the current Superpowers visual-companion HTML screen to Kanna mobile over the existing KSP relay tunnel and return mobile selection events to the agent session.

**Architecture:** Extend the generated KSP contract with a latest-value `companion` attachment and structured companion events. Kanna Server securely discovers the active companion inside the task's current worktree, mobile routes the stream through its existing LAN/cloud task ownership layer, and an isolated WebView renders a Kanna-owned companion document without adding relay HTTP proxy behavior.

**Tech Stack:** Rust/Tokio/KSP/SQLite filesystem lookup, generated `ts-rs` TypeScript contracts, `@kanna/stream-client`, React Native/Expo/`react-native-webview`, Vitest, Cargo tests, Appium relay harness.

---

## File structure

- `crates/kanna-agent-protocol/src/frames.rs` remains the single KSP schema source of truth.
- `crates/kanna-server/src/visual_companion.rs` owns secure session discovery, document snapshots, revisions, and event appends. It has no WebSocket or mobile UI knowledge.
- `crates/kanna-server/src/ksp.rs` owns companion attachment lifetime and converts source results into protocol frames.
- `packages/stream-client/src/index.ts` owns client-side attachment/reconnect behavior.
- Mobile transport files expose and route one provider-neutral companion subscription in the same way as terminal subscriptions.
- `apps/mobile/src/screens/buildVisualCompanionDocument.ts` owns HTML framing, CSP, and the narrow WebView bridge.
- `apps/mobile/src/screens/VisualCompanionModal.tsx` owns presentation and event acknowledgement; `TaskScreen.tsx` only owns whether the modal is open.
- `sessionStore.ts` and `mobileController.ts` own task-scoped companion stream state and lifecycle.
- The relay service is intentionally unchanged.

### Task 1: Add the generated KSP companion contract

**Files:**
- Modify: `crates/kanna-agent-protocol/src/frames.rs`
- Modify: `crates/kanna-agent-protocol/src/lib.rs`
- Regenerate: `packages/agent-protocol/src/generated/ClientFrame.ts`
- Regenerate: `packages/agent-protocol/src/generated/ServerFrame.ts`
- Regenerate: `packages/agent-protocol/src/generated/StreamKind.ts`
- Create through generation: `packages/agent-protocol/src/generated/CompanionDocumentKind.ts`
- Create through generation: `packages/agent-protocol/src/generated/CompanionEvent.ts`
- Modify: `packages/agent-protocol/src/index.ts`

- [ ] **Step 1: Write failing Rust round-trip tests**

Add tests that construct and JSON-round-trip these exact values:

```rust
let event = CompanionEvent {
    event_id: "event-1".into(),
    event_type: "click".into(),
    choice: "a".into(),
    text: "Option A".into(),
    element_id: None,
    timestamp: 1_784_268_000_000,
};
let client = ClientFrame::CompanionEvent {
    task_id: "task-1".into(),
    session_id: "123-456".into(),
    revision: "sha256:abc".into(),
    event: event.clone(),
};
let snapshot = ServerFrame::CompanionSnapshot {
    task_id: "task-1".into(),
    session_id: "123-456".into(),
    revision: "sha256:abc".into(),
    document_kind: CompanionDocumentKind::Fragment,
    html: "<h2>Choose</h2>".into(),
};
assert_eq!(serde_json::from_value::<ClientFrame>(serde_json::to_value(&client).unwrap()).unwrap(), client);
assert_eq!(serde_json::from_value::<ServerFrame>(serde_json::to_value(&snapshot).unwrap()).unwrap(), snapshot);
assert_eq!(serde_json::to_value(StreamKind::Companion).unwrap(), "companion");
```

Also assert `CompanionUnavailable { task_id }` serializes as `type: "companion_unavailable"` and the event's Rust `event_type`/`element_id` fields serialize as JSON `type`/`id`.
Assert `CompanionEventResult` carries `event_id`, `accepted`, and optional
`code`/`message`, while `CompanionError` carries only task-scoped source errors.

- [ ] **Step 2: Run the protocol tests and confirm they fail**

Run:

```bash
cargo test -p kanna-agent-protocol frames::tests -- --nocapture
```

Expected: compilation fails because the companion types and variants do not exist.

- [ ] **Step 3: Implement the Rust source-of-truth types**

Add exported types and variants with these shapes:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub enum CompanionDocumentKind { Fragment, FullDocument }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "typescript", derive(TS), ts(export))]
pub struct CompanionEvent {
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub choice: String,
    pub text: String,
    #[serde(rename = "id")]
    pub element_id: Option<String>,
    #[cfg_attr(feature = "typescript", ts(type = "number"))]
    pub timestamp: u64,
}
```

Add `Companion` to `StreamKind`, `CompanionEvent` to `ClientFrame`, and
`CompanionSnapshot`, `CompanionUnavailable`, `CompanionEventResult`, and
`CompanionError` to `ServerFrame`. Re-export the new public types from `lib.rs`.

- [ ] **Step 4: Generate and export TypeScript bindings**

Run:

```bash
./scripts/generate-agent-protocol-types.sh
```

Then add `CompanionDocumentKind` and `CompanionEvent` exports to `packages/agent-protocol/src/index.ts`. Do not hand-edit generated files.

- [ ] **Step 5: Verify generated contracts and commit**

Run:

```bash
cargo test -p kanna-agent-protocol frames::tests -- --nocapture
pnpm --dir packages/agent-protocol test
./scripts/check-agent-protocol-types.sh
```

Expected: all pass and the generated union types contain the new frames.

Commit:

```bash
git add crates/kanna-agent-protocol packages/agent-protocol
git commit -m "feat(protocol): define visual companion stream"
```

### Task 2: Build the secure filesystem companion source

**Files:**
- Create: `crates/kanna-server/src/visual_companion.rs`
- Modify: `crates/kanna-server/src/main.rs`

- [ ] **Step 1: Write a task-worktree fixture and failing discovery tests**

Create a fixture using `Db::open_for_tests`, `insert_test_repo_with_path`, `insert_test_pipeline_item`, and `upsert_worktree`. Add helpers that create:

```text
.superpowers/brainstorm/123-456/content/layout.html
.superpowers/brainstorm/123-456/state/server-info
```

Test this public contract:

```rust
pub const MAX_COMPANION_HTML_BYTES: u64 = 1024 * 1024;

pub struct CompanionDocument {
    pub session_id: String,
    pub revision: String,
    pub document_kind: CompanionDocumentKind,
    pub html: String,
}

pub fn current_document(db_path: &str, task_id: &str)
    -> Result<Option<CompanionDocument>, CompanionError>;

pub fn append_event(
    db_path: &str,
    task_id: &str,
    session_id: &str,
    revision: &str,
    event: &CompanionEvent,
) -> Result<(), CompanionError>;
```

Cover: no directory, active fragment, full document detection, newest HTML in one session, newest of two active sessions, `server-stopped`, missing `server-info`, invalid UTF-8, a document above 1 MiB, task without worktree, a content symlink to an outside secret, a session-directory symlink, and a worktree replacement that makes the old session unavailable.

- [ ] **Step 2: Run the focused source tests and confirm failure**

Run:

```bash
cargo test -p kanna-server visual_companion::tests -- --nocapture
```

Expected: compilation fails because `visual_companion` does not exist.

- [ ] **Step 3: Implement bounded discovery and reading**

Implement `current_document` so it:

```rust
let db = Db::open(db_path)?;
let task_id = db.resolve_pipeline_item_id(task_id)?.ok_or(CompanionError::TaskNotFound)?;
let worktree = db.get_task_worktree_path(&task_id)?.ok_or(CompanionError::WorkspaceUnavailable)?;
// Open the absolute worktree with O_DIRECTORY | O_NOFOLLOW, descend through
// .superpowers/brainstorm without following links, enumerate real session
// directories, select active markers, then read only a regular .html file.
```

Keep session names to one normal path component, reject NUL/`..`, cap reads
before allocation, classify a trimmed document starting with `<!doctype` or
`<html` as `FullDocument`, and compute a deterministic opaque revision from the
exact byte length plus two independently seeded FNV-1a 64-bit passes. Perform no
HTTP requests and add no digest dependency.

- [ ] **Step 4: Write failing event-validation and append tests**

Test successful JSONL output plus these exact rejections:

- stale session or revision;
- `event_type != "click"`;
- empty `choice`;
- serialized event above 8 KiB;
- `choice`/`id` above 256 bytes, `text` above 4 KiB, `event_id` above 128 bytes;
- a symlinked `state/events` target.

- [ ] **Step 5: Implement safe event append**

Validate against the current authoritative document immediately before opening
`state/events`. Open it descriptor-relatively with `O_APPEND | O_CREAT |
O_NOFOLLOW | O_CLOEXEC`, write one serialized event plus `\n` in one guarded
operation, and return `StaleRevision`, `InvalidEvent`, or `Internal` without
including HTML/local paths in display messages.

- [ ] **Step 6: Run source tests and commit**

Run:

```bash
cargo test -p kanna-server visual_companion::tests -- --nocapture
```

Expected: all source and event tests pass.

Commit:

```bash
git add crates/kanna-server/src/visual_companion.rs crates/kanna-server/src/main.rs
git commit -m "feat(server): read task visual companions"
```

### Task 3: Attach companion state to KSP

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Add failing KSP attachment tests**

Using the existing test WebSocket helpers, create a task/worktree companion fixture and prove:

```rust
send_frame(&mut socket, &ClientFrame::Attach {
    task_id: "task-1".into(),
    kind: StreamKind::Companion,
    from_seq: 0,
}).await;
```

immediately yields `CompanionSnapshot`; no active session yields
`CompanionUnavailable`; writing a new HTML file yields one new snapshot;
unchanged bytes yield no duplicate; detaching stops updates; replacing the
worktree yields unavailable; and reconnect/reattach returns the newest screen.

- [ ] **Step 2: Run focused KSP tests and confirm failure**

Run:

```bash
cargo test -p kanna-server ksp::tests::companion -- --nocapture
```

Expected: tests fail because companion attach is not handled.

- [ ] **Step 3: Implement latest-value companion attachment**

Extend `StreamConn::attach` with `StreamKind::Companion`. Spawn one attachment
task that calls `visual_companion::current_document` through
`tokio::task::spawn_blocking`, scans every 500 ms, and tracks:

```rust
enum SentCompanionState {
    Never,
    Unavailable,
    Snapshot { session_id: String, revision: String },
}
```

Send only transitions. Keep a single pending newest snapshot in the attachment
task rather than queueing obsolete revisions, and abort the task through the
existing attachment map on detach/connection shutdown.

- [ ] **Step 4: Add failing event-frame tests**

Send `ClientFrame::CompanionEvent` after attach and assert the expected JSONL
line followed by an accepted `CompanionEventResult`. Send stale, invalid, and
rate-limited events and assert rejected results with stable codes:
`companion_stale_revision`, `companion_invalid_event`,
`companion_rate_limited`, and `companion_event_failed`. Assert a source read
failure emits `CompanionError` and does not emit the generic KSP error frame.
For rate limiting, send 31 otherwise-valid events for the same task/session
within ten seconds and assert the first 30 are accepted while the last is
rejected.

- [ ] **Step 5: Implement companion event handling off the async hot path**

Track accepted event timestamps in `StreamConn` by `(task_id, session_id)`,
pruning timestamps outside a rolling ten-second window before enforcing the
30-event limit. This makes the throttle local to the authenticated connection
instead of shared filesystem state. Call `visual_companion::append_event`
inside `spawn_blocking`; record the timestamp only after a successful append,
and return exactly one `CompanionEventResult` for its `event_id` after the
operation completes. Map source failures to `CompanionError`. Do not add relay
messages or invoke routes.

- [ ] **Step 6: Prove terminal traffic remains responsive and commit**

Add a test that attaches both terminal and companion streams, writes a maximum
size companion update, sends terminal output during the scan, and asserts the
terminal frame is delivered without waiting for another 500 ms scan interval.

Run:

```bash
cargo test -p kanna-server ksp::tests -- --nocapture
```

Commit:

```bash
git add crates/kanna-server/src/ksp.rs
git commit -m "feat(server): stream visual companions over KSP"
```

### Task 4: Add companion support to the shared stream client

**Files:**
- Modify: `packages/stream-client/src/index.ts`
- Modify: `packages/stream-client/src/stream-client.test.ts`

- [ ] **Step 1: Write failing stream-client tests**

Define the intended public surface in the tests:

```ts
interface CompanionStreamHandlers {
  onSnapshot(snapshot: {
    sessionId: string;
    revision: string;
    documentKind: CompanionDocumentKind;
    html: string;
  }): void;
  onUnavailable(): void;
  onEventResult(result: { eventId: string; accepted: boolean; code?: string; message?: string }): void;
  onError?(code: string, message: string): void;
}

client.attachCompanion("task-1", handlers);
client.sendCompanionEvent("task-1", "session-1", "rev-1", event);
```

Assert attach/detach frames, snapshot mapping, unavailable mapping, event frame
shape, accepted/rejected event-result mapping, reconnect reattachment,
task-scoped source errors, and that a companion error does not call terminal
handlers.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --dir packages/stream-client test -- stream-client.test.ts
```

Expected: TypeScript compilation fails on the missing API.

- [ ] **Step 3: Implement companion attachment and dispatch**

Add a third attachment variant:

```ts
interface CompanionAttachment {
  kind: "companion";
  handlers: CompanionStreamHandlers;
}
type Attachment = AgentAttachment | TerminalAttachment | CompanionAttachment;
```

Implement `attachCompanion`, `sendCompanionEvent`, a type-safe
`companionAttachment(taskId)` lookup, snapshot/unavailable/event-result/error
dispatch, and reconnect attachment with `from_seq: 0`.

- [ ] **Step 4: Run tests, typecheck, and commit**

Run:

```bash
pnpm --dir packages/stream-client test
pnpm --dir packages/stream-client typecheck
```

Commit:

```bash
git add packages/stream-client
git commit -m "feat(stream): attach visual companions"
```

### Task 5: Route companion streams through every mobile transport

**Files:**
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Modify: `apps/mobile/src/lib/transports/relayClient.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Modify tests adjacent to each file
- Modify: `apps/mobile/src/appModel.ts`

- [ ] **Step 1: Define failing client contract tests**

Add these provider-neutral types to `client.ts` tests:

```ts
export type TaskCompanionStreamEvent =
  | { type: "snapshot"; taskId: string; sessionId: string; revision: string; documentKind: CompanionDocumentKind; html: string }
  | { type: "unavailable"; taskId: string }
  | { type: "event_result"; taskId: string; eventId: string; accepted: boolean; code?: string; message?: string }
  | { type: "error"; taskId: string; code: string; message: string };

export interface TaskCompanionSubscription {
  close(): void;
  sendEvent(sessionId: string, revision: string, event: CompanionEvent): void;
}
```

Require both `KannaTransport` and `KannaClient` to expose
`observeTaskCompanion(taskId, listener)`.

- [ ] **Step 2: Run the focused mobile tests and confirm failure**

Run:

```bash
pnpm --dir apps/mobile test -- client.test.ts lanTransport.test.ts remoteTransport.test.ts relayClient.test.ts cloudLanClient.test.ts
```

Expected: the new transport method is absent.

- [ ] **Step 3: Implement LAN and relay observers**

LAN uses a `StreamClient` pointed at `/v1/stream`, maps companion handlers to
`TaskCompanionStreamEvent`, and detaches on close. Relay reuses
`streamClientForDesktop(desktopId)`, proving that its existing
`createRelayTunnelWebSocketFactory` carries the new frames without relay service
changes. `sendEvent` calls `StreamClient.sendCompanionEvent`.

- [ ] **Step 4: Implement remote and hybrid ownership routing**

Add `RemoteTaskCompanionObserver` beside terminal/agent observers. Resolve the
cloud task's owning desktop/local task id before subscribing, translate emitted
task ids back to the displayed canonical id, and queue `sendEvent` calls until
an asynchronous route subscription is active. In `cloudLanClient`, route the
subscription using the same `routeForTask` result as terminal attachment and
preserve the selected LAN/cloud source for the subscription lifetime.

- [ ] **Step 5: Wire app-model construction and disconnected behavior**

Thread `observeTaskCompanion` through `RelayDesktopClient`,
`createRemoteTransport`, trusted-LAN resolving clients, composite clients, and
the disconnected client. The disconnected subscription emits one
`{ type: "error", code: "desktop_unavailable" }` and has no-op close/send.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
pnpm --dir apps/mobile test -- client.test.ts lanTransport.test.ts remoteTransport.test.ts relayClient.test.ts cloudLanClient.test.ts appModel.cloudFallback.test.ts
pnpm --dir apps/mobile typecheck
```

Commit:

```bash
git add apps/mobile/src/lib apps/mobile/src/appModel.ts apps/mobile/src/appModel.cloudFallback.test.ts
git commit -m "feat(mobile): route visual companion streams"
```

### Task 6: Own companion lifecycle in the mobile controller and store

**Files:**
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/sessionStore.test.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/App.component.test.tsx`

- [ ] **Step 1: Write failing store transition tests**

Add state fields:

```ts
taskCompanionTaskId: string | null;
taskCompanionStatus: "idle" | "connecting" | "available" | "unavailable" | "error";
taskCompanionSnapshot: {
  sessionId: string;
  revision: string;
  documentKind: CompanionDocumentKind;
  html: string;
} | null;
taskCompanionUnread: boolean;
taskCompanionErrorMessage: string | null;
```

Test begin, first snapshot, replacement snapshot marking unread only while the
modal is closed, mark viewed, unavailable clearing stale content, error, task
retagging, and clear.

- [ ] **Step 2: Run store tests and confirm failure**

Run:

```bash
pnpm --dir apps/mobile test -- sessionStore.test.ts
```

- [ ] **Step 3: Implement focused store mutations**

Add `beginTaskCompanion`, `applyTaskCompanionStreamEvent(taskId, event,
isOpen)`, `markTaskCompanionViewed`, and `clearTaskCompanion`. Guard every
mutation by `taskCompanionTaskId`, as terminal/agent mutations already do.

- [ ] **Step 4: Write failing controller lifecycle tests**

Assert opening either a PTY or themed-agent task starts companion observation
in parallel with its primary stream; reopening the same route does not duplicate
it; switching tasks, changing desktop, refresh, close, missing-task cleanup, and
controller disposal close it; canonical task retagging preserves it when route
identity is unchanged; and `sendCompanionEvent` reaches only the active matching
subscription.

- [ ] **Step 5: Implement controller lifecycle and App props**

Track `activeTaskCompanion`, its route identity, generation, subscription, and
retag function beside terminal/agent state. `startTaskView` always starts it;
`stopTaskSession` always stops it. Expose controller methods to mark viewed and
send an event, then pass companion state/callbacks from `App.tsx` to
`TaskScreen`.

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
pnpm --dir apps/mobile test -- sessionStore.test.ts mobileController.test.ts App.component.test.tsx
pnpm --dir apps/mobile typecheck
```

Commit:

```bash
git add apps/mobile/src/state apps/mobile/src/App.tsx apps/mobile/src/App.component.test.tsx
git commit -m "feat(mobile): manage visual companion sessions"
```

### Task 7: Render the constrained companion WebView and task action

**Files:**
- Create: `apps/mobile/src/screens/buildVisualCompanionDocument.ts`
- Create: `apps/mobile/src/screens/buildVisualCompanionDocument.test.ts`
- Create: `apps/mobile/src/screens/VisualCompanionModal.tsx`
- Create: `apps/mobile/src/screens/VisualCompanionModal.test.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/e2eTestIds.ts`
- Modify: `apps/mobile/src/e2eTestIds.test.ts`

- [ ] **Step 1: Write failing pure document-builder tests**

Require `buildVisualCompanionDocument({ documentKind, html })` to:

- wrap fragments in a complete responsive Kanna companion frame;
- preserve full-document body content;
- inject a CSP with `default-src 'none'`, inline style/script, HTTPS/data images,
  and blocked `connect-src`, forms, frames, objects, and base navigation;
- define compatible `toggleSelect` single/multiselect behavior;
- capture `[data-choice]` clicks and post only
  `{ type: "companion-event", event: { event_id, type: "click", choice, text, id, timestamp } }`;
- safely embed HTML containing backticks, `${...}`, and `</script>` without
  interpolating it inside executable JavaScript.

- [ ] **Step 2: Run builder tests and confirm failure**

Run:

```bash
pnpm --dir apps/mobile test -- buildVisualCompanionDocument.test.ts
```

- [ ] **Step 3: Implement the pure builder**

Build the document with ordinary string composition and inject a constant
bridge script, never by placing agent HTML inside a JavaScript string. For a
full document, insert CSP in `<head>` (or create a head) and the bridge before
`</body>` (or append it). For a fragment, place the raw fragment only inside a
known content container.

- [ ] **Step 4: Write failing modal and task-screen tests**

Test a `Visual companion ready` button, unread badge, full-screen modal,
close/back focus, snapshot replacement keyed by revision, unavailable ended
state, local selection rendering, valid bridge event forwarding, malformed or
oversized bridge rejection, send failure state, and navigation rejection.

- [ ] **Step 5: Implement the modal with a narrow WebView surface**

Configure `react-native-webview` with:

```tsx
<WebView
  allowFileAccess={false}
  allowFileAccessFromFileURLs={false}
  allowUniversalAccessFromFileURLs={false}
  domStorageEnabled={false}
  javaScriptCanOpenWindowsAutomatically={false}
  mixedContentMode="never"
  originWhitelist={["about:blank"]}
  setSupportMultipleWindows={false}
  sharedCookiesEnabled={false}
  thirdPartyCookiesEnabled={false}
  onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
  source={{ html: document }}
/>
```

Parse `onMessage` defensively, require the current session/revision, cap the
serialized event at 8 KiB, and call the controller callback. Add stable test
IDs for the ready action, modal, close button, status, and WebView inspection.

- [ ] **Step 6: Run UI tests and commit**

Run:

```bash
pnpm --dir apps/mobile test -- buildVisualCompanionDocument.test.ts VisualCompanionModal.test.tsx TaskScreen.test.tsx e2eTestIds.test.ts
pnpm --dir apps/mobile typecheck
```

Commit:

```bash
git add apps/mobile/src/screens apps/mobile/src/e2eTestIds.ts apps/mobile/src/e2eTestIds.test.ts
git commit -m "feat(mobile): render visual companions in app"
```

### Task 8: Verify the transparent relay flow end to end

**Files:**
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts`
- Modify: `apps/mobile/e2e/helpers/relay-harness.test.ts`
- Modify: `apps/mobile/e2e/helpers/selectors.ts`
- Modify: `apps/mobile/e2e/helpers/selectors.test.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`
- Modify: `apps/mobile/e2e/terminal-streaming-coverage.md`

- [ ] **Step 1: Add failing relay fixture and contract tests**

Extend the scripted fixture worktree with an active
`.superpowers/brainstorm/<session>` tree and a selectable fragment. Add harness
operations that replace the HTML, read `state/events`, and stop the session.
Assert these helpers never add a relay companion message type or HTTP preview
route.

- [ ] **Step 2: Add the failing Appium relay scenario**

Through the existing authenticated relay task flow:

1. wait for the visual-ready action;
2. open it and inspect the real WebView document;
3. tap a real `data-choice` element;
4. wait until the desktop fixture sees the JSONL event;
5. replace the HTML and observe the new revision;
6. stop the session and observe ended/unavailable state;
7. reconnect and prove the newest snapshot is restored when active.

- [ ] **Step 3: Run static/harness tests and confirm failure**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/helpers/relay-harness.test.ts e2e/helpers/selectors.test.ts e2e/specs/relay/relay-task-flow.test.ts
```

- [ ] **Step 4: Implement the fixture, selectors, and scenario**

Keep physical-device automation out of scope. Update the coverage document to
name the companion snapshot/update/event/stop/reconnect path and its simulator
test command.

- [ ] **Step 5: Run focused and canonical verification**

Run:

```bash
./scripts/check-agent-protocol-types.sh
cargo test -p kanna-agent-protocol
cargo test -p kanna-server visual_companion -- --nocapture
cargo test -p kanna-server ksp::tests -- --nocapture
pnpm --dir packages/stream-client test
pnpm --dir apps/mobile test -- --runInBand
pnpm --dir apps/mobile typecheck
pnpm test
./kd test rust
```

When the simulator/emulator relay environment is already available, also run:

```bash
pnpm --dir apps/mobile run test:e2e:relay
```

Report an environment-only skip precisely if Firebase emulators, Appium, or an
iOS simulator are unavailable. Do not install, launch, or automate a physical
iPhone.

- [ ] **Step 6: Audit scope and commit final coverage**

Run:

```bash
git diff --check
rg -n "preview_domain|wildcard|launch_ticket|preview_gateway|cloudflared|vercel" \
  crates/kanna-server packages/stream-client apps/mobile services/relay
git diff -- services/relay
```

Expected: no new generic preview infrastructure and no relay-service diff.

Commit:

```bash
git add apps/mobile/e2e
git commit -m "test(mobile): cover relay visual companions"
```

## Completion criteria

- A selected task automatically attaches to a companion stream over LAN or the
  existing authenticated relay tunnel.
- An active Superpowers session in the current worktree produces an in-app
  visual companion action and live latest-value screen updates.
- A mobile `data-choice` click reaches the exact session's `state/events` file
  only when session and revision are current.
- Reconnect, task switch, workspace transition, stop, and task close do not
  retain stale documents or subscriptions.
- Companion HTML cannot access Kanna credentials, local files, arbitrary
  navigation, WebSockets, forms, or a general native bridge.
- The relay service, cloud deployment, DNS, and public web surface remain
  unchanged.
