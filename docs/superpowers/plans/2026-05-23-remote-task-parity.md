# Remote Task Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reachable remote tasks feel like local tasks for the first interactive parity slice: users can watch, type into, resize, and close cloud or trusted-LAN tasks from the current desktop without pulling them first.

**Architecture:** Keep task ownership where the task already runs. The UI routes terminal and task-control actions through the workspace route: local actions stay in the existing store/daemon path, cloud actions invoke the owner desktop through the relay, and LAN actions invoke the trusted peer through the transfer sidecar. LAN and cloud expose the same TypeScript terminal client interface so `CloudTerminalView` and App-level actions do not need transport-specific branching beyond client selection.

**Tech Stack:** Vue 3, Pinia, Vitest, Tauri commands, Rust `kanna-server`, Rust `task-transfer`, Kanna daemon protocol, WebDriver E2E.

---

## File Structure

- Modify `apps/desktop/src/workspace/types.ts`: add explicit remote-control capabilities.
- Modify `apps/desktop/src/workspace/buildWorkspace.ts`: compute terminal/action capabilities from the selected route.
- Modify `apps/desktop/src/workspace/buildWorkspace.test.ts`: lock route preference and remote capability semantics.
- Modify `apps/desktop/src/services/desktopRelayTerminal.ts`: add cloud `sendInput`, `resize`, and `closeTask` methods to the relay terminal client.
- Modify `apps/desktop/src/services/desktopRelayTerminal.test.ts`: verify cloud action commands and payloads.
- Modify `crates/kanna-server/src/commands.rs`: add `resize_session` command for cloud relay clients.
- Modify `crates/task-transfer/src/protocol.rs`: add LAN control and peer protocol variants for input, resize, and close.
- Modify `crates/task-transfer/src/runtime.rs`: route LAN input/resize/close to the owner daemon and DB.
- Modify `crates/task-transfer/src/main.rs`: handle new sidecar control requests.
- Modify `apps/desktop/src-tauri/src/transfer_sidecar.rs`: add sidecar client methods for LAN input, resize, and close.
- Modify `apps/desktop/src-tauri/src/commands/transfer.rs`: expose Tauri commands for LAN input, resize, and close.
- Modify `apps/desktop/src/services/desktopLanTerminal.ts`: implement the shared terminal client action methods via Tauri commands.
- Modify `apps/desktop/src/components/CloudTerminalView.vue`: enable stdin and send resize events through the selected remote client.
- Modify `apps/desktop/src/App.vue`: route close through the selected workspace task, using local store close for local tasks and remote client close for remote tasks.
- Modify `apps/desktop/src/App.test.ts`: cover remote close routing.
- Modify `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`: prove LAN remote input and close work without cloud sign-in.
- Modify `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`: prove cloud remote input and close work through relay.

---

### Task 1: Workspace Capabilities

**Files:**
- Modify: `apps/desktop/src/workspace/types.ts`
- Modify: `apps/desktop/src/workspace/buildWorkspace.ts`
- Test: `apps/desktop/src/workspace/buildWorkspace.test.ts`

- [ ] **Step 1: Write failing capability tests**

Add tests that assert reachable remote tasks can be controlled, cannot open IDE directly, and prefer LAN terminal routes when the same task exists in both LAN and cloud snapshots:

```ts
it("marks reachable LAN and cloud tasks as remotely controllable without IDE access", () => {
  const result = buildWorkspace({
    localRepos: [],
    localItems: [],
    cloudSnapshot: cloudSnapshotWithTask({
      id: "cloud:task-1",
      repoId: "repo-cloud",
      ownerDesktopId: "desktop-owner",
      ownerLocalTaskId: "task-1",
    }),
    lanSnapshot: emptySnapshot(),
  });

  expect(result.tasks[0]?.capabilities).toMatchObject({
    canOpenTerminal: true,
    canSendInput: true,
    canResizeTerminal: true,
    canClose: true,
    canOpenDiff: false,
    canOpenInIde: false,
    canOpenShell: false,
    canAdvanceStage: false,
    canEditMetadata: true,
  });
});

it("prefers LAN over cloud when both remote routes are available", () => {
  const cloud = cloudSnapshotWithTask({
    id: "cloud:task-1",
    repoId: "repo-cloud",
    ownerDesktopId: "desktop-owner",
    ownerLocalTaskId: "task-1",
  });
  const lan = cloudSnapshotWithTask({
    id: "lan:task-1",
    repoId: "repo-cloud",
    ownerDesktopId: "peer-owner",
    ownerLocalTaskId: "task-1",
    transport: "lan",
  });

  const result = buildWorkspace({
    localRepos: [],
    localItems: [],
    cloudSnapshot: cloud,
    lanSnapshot: lan,
  });

  expect(result.tasks).toHaveLength(1);
  expect(result.tasks[0]?.terminal.kind).toBe("lan");
  expect(result.tasks[0]?.terminal.remoteRef).toMatchObject({
    ownerDesktopId: "peer-owner",
    ownerLocalTaskId: "task-1",
    transport: "lan",
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts
```

Expected: FAIL because `WorkspaceCapabilities` does not include `canResizeTerminal`, `canOpenShell`, `canAdvanceStage`, or `canEditMetadata`.

- [ ] **Step 3: Implement capabilities**

Extend `WorkspaceCapabilities`:

```ts
export interface WorkspaceCapabilities {
  canOpenTerminal: boolean;
  canSendInput: boolean;
  canResizeTerminal: boolean;
  canClose: boolean;
  canCreateSiblingTask: boolean;
  canPushToMachine: boolean;
  canPullFromMachine: boolean;
  canOpenDiff: boolean;
  canOpenInIde: boolean;
  canOpenShell: boolean;
  canAdvanceStage: boolean;
  canEditMetadata: boolean;
}
```

Update `capabilitiesFor`:

```ts
function capabilitiesFor(candidate: Candidate): WorkspaceCapabilities {
  const isLocal = candidate.source.kind === "local";
  const hasTerminal = isLocal || Boolean(candidate.source.terminalRef);
  return {
    canOpenTerminal: hasTerminal,
    canSendInput: hasTerminal,
    canResizeTerminal: hasTerminal,
    canClose: isLocal || hasTerminal,
    canCreateSiblingTask: true,
    canPushToMachine: isLocal,
    canPullFromMachine: !isLocal,
    canOpenDiff: isLocal,
    canOpenInIde: isLocal,
    canOpenShell: isLocal,
    canAdvanceStage: isLocal,
    canEditMetadata: true,
  };
}
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/workspace/types.ts apps/desktop/src/workspace/buildWorkspace.ts apps/desktop/src/workspace/buildWorkspace.test.ts
git commit -m "feat: define remote task control capabilities"
```

---

### Task 2: Cloud Relay Terminal Actions

**Files:**
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts`
- Test: `apps/desktop/src/services/desktopRelayTerminal.test.ts`

- [ ] **Step 1: Write failing relay client tests**

Add tests that authenticate once and assert the new action methods send command-style relay invokes:

```ts
it("sends terminal input through the relay", async () => {
  const socket = new FakeSocket();
  const client = createDesktopRelayTerminalClient({
    createSocket: () => socket,
    getIdToken: vi.fn(async () => "id-token"),
    relayUrl: "ws://relay.test",
  });

  const promise = client.sendInput({
    desktopId: "desktop-owner",
    taskId: "task-1",
    data: "hello\n",
  });
  socket.onopen?.();
  await Promise.resolve();
  socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
  await Promise.resolve();

  const sent = socket.sent.map((entry) => JSON.parse(entry));
  expect(sent).toContainEqual(expect.objectContaining({
    type: "invoke",
    desktopId: "desktop-owner",
    command: "send_input",
    args: { session_id: "task-1", data: "hello\n" },
  }));
  const invokeId = sent.find((entry) => entry.command === "send_input").id;
  socket.onmessage?.({ data: JSON.stringify({ type: "response", id: invokeId, data: null }) });
  await expect(promise).resolves.toBeUndefined();
});

it("sends terminal resize and close task through the relay", async () => {
  const socket = new FakeSocket();
  const client = createDesktopRelayTerminalClient({
    createSocket: () => socket,
    getIdToken: vi.fn(async () => "id-token"),
    relayUrl: "ws://relay.test",
  });

  const resizePromise = client.resize({
    desktopId: "desktop-owner",
    taskId: "task-1",
    cols: 100,
    rows: 32,
  });
  const closePromise = client.closeTask({
    desktopId: "desktop-owner",
    taskId: "task-1",
  });

  socket.onopen?.();
  await Promise.resolve();
  socket.onmessage?.({ data: JSON.stringify({ type: "auth_ok", userId: "user-1" }) });
  await Promise.resolve();

  const sent = socket.sent.map((entry) => JSON.parse(entry));
  expect(sent).toContainEqual(expect.objectContaining({
    type: "invoke",
    desktopId: "desktop-owner",
    command: "resize_session",
    args: { session_id: "task-1", cols: 100, rows: 32 },
  }));
  expect(sent).toContainEqual(expect.objectContaining({
    type: "invoke",
    desktopId: "desktop-owner",
    command: "close_task",
    args: { task_id: "task-1" },
  }));

  for (const command of ["resize_session", "close_task"]) {
    const invokeId = sent.find((entry) => entry.command === command).id;
    socket.onmessage?.({ data: JSON.stringify({ type: "response", id: invokeId, data: null }) });
  }

  await expect(resizePromise).resolves.toBeUndefined();
  await expect(closePromise).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
pnpm --dir apps/desktop test -- desktopRelayTerminal.test.ts
```

Expected: FAIL because `sendInput`, `resize`, and `closeTask` are not defined on `DesktopRelayTerminalClient`.

- [ ] **Step 3: Implement cloud action methods**

Extend `DesktopRelayTerminalClient`:

```ts
export interface RemoteTerminalActionOptions {
  desktopId: string;
  taskId: string;
}

export interface SendRemoteTerminalInputOptions extends RemoteTerminalActionOptions {
  data: string;
}

export interface ResizeRemoteTerminalOptions extends RemoteTerminalActionOptions {
  cols: number;
  rows: number;
}

export interface DesktopRelayTerminalClient {
  close(): void;
  observeTerminal(options: ObserveDesktopRelayTerminalOptions): DesktopRelayTerminalSubscription;
  sendInput(options: SendRemoteTerminalInputOptions): Promise<void>;
  resize(options: ResizeRemoteTerminalOptions): Promise<void>;
  closeTask(options: RemoteTerminalActionOptions): Promise<void>;
}
```

Add methods to the returned client:

```ts
async sendInput(options) {
  await sendInvoke(options.desktopId, {
    command: "send_input",
    args: { session_id: options.taskId, data: options.data },
  });
},
async resize(options) {
  await sendInvoke(options.desktopId, {
    command: "resize_session",
    args: { session_id: options.taskId, cols: options.cols, rows: options.rows },
  });
},
async closeTask(options) {
  await sendInvoke(options.desktopId, {
    command: "close_task",
    args: { task_id: options.taskId },
  });
},
```

- [ ] **Step 4: Verify tests pass**

Run:

```bash
pnpm --dir apps/desktop test -- desktopRelayTerminal.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/services/desktopRelayTerminal.ts apps/desktop/src/services/desktopRelayTerminal.test.ts
git commit -m "feat: send cloud terminal actions through relay"
```

---

### Task 3: Cloud Server Resize Command

**Files:**
- Modify: `crates/kanna-server/src/commands.rs`

- [ ] **Step 1: Add resize command coverage through existing cloud E2E**

The E2E in Task 8 will exercise this command through a real relay route. Before implementation, the relay client unit test from Task 2 passes but cloud resize fails at runtime with `unknown command: resize_session`.

- [ ] **Step 2: Implement `resize_session` in `handle_invoke`**

Add this match arm next to `"send_input"`:

```rust
"resize_session" => {
    let session_id = args
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "missing required arg: session_id".to_string())?;
    let cols = args
        .get("cols")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "missing required arg: cols".to_string())?;
    let rows = args
        .get("rows")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "missing required arg: rows".to_string())?;
    let event = daemon
        .send_command(&DaemonCommand::Resize {
            session_id: session_id.to_string(),
            cols: cols.min(u16::MAX as u64) as u16,
            rows: rows.min(u16::MAX as u64) as u16,
        })
        .await
        .map_err(|e| format!("daemon error: {}", e))?;
    match event {
        DaemonEvent::Ok => Ok(Value::Null),
        DaemonEvent::Error { message, .. } => Err(format!("daemon error: {}", message)),
        other => Err(format!("unexpected daemon response: {:?}", other)),
    }
}
```

- [ ] **Step 3: Verify server crate builds**

Run:

```bash
cargo check -p kanna-server
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/kanna-server/src/commands.rs
git commit -m "feat: support cloud terminal resize command"
```

---

### Task 4: LAN Transfer Terminal Actions

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`

- [ ] **Step 1: Write failing runtime tests**

Add runtime tests that start two transfer runtimes with daemon-backed test sessions, call `send_peer_session_input`, `resize_peer_session`, and `close_peer_task`, then assert owner-side daemon and DB state changes. Use the same fixture helpers as the existing observe-session runtime tests in `crates/task-transfer/tests/runtime.rs`.

```rust
#[tokio::test]
async fn trusted_peer_can_send_input_to_observed_session() {
    let fixture = RuntimeFixture::new().await;
    fixture.pair_peers().await;
    let session_id = fixture.spawn_owner_shell("read line; printf 'input:%s\\n' \"$line\"; sleep 2").await;

    fixture
        .secondary
        .send_peer_session_input("peer-primary", &session_id, b"hello\n".to_vec())
        .await
        .expect("send input");

    let output = fixture.wait_for_owner_output(&session_id, "input:hello").await;
    assert!(output.contains("input:hello"));
}

#[tokio::test]
async fn trusted_peer_can_resize_and_close_owner_task() {
    let fixture = RuntimeFixture::new().await;
    fixture.pair_peers().await;
    let session_id = fixture.spawn_owner_shell("sleep 60").await;
    fixture.insert_owner_task(&session_id).await;

    fixture
        .secondary
        .resize_peer_session("peer-primary", &session_id, 100, 32)
        .await
        .expect("resize session");
    fixture
        .secondary
        .close_peer_task("peer-primary", &session_id)
        .await
        .expect("close task");

    assert!(fixture.owner_task_is_closed(&session_id).await);
}
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
cargo test -p task-transfer --test runtime trusted_peer_can_send_input_to_observed_session trusted_peer_can_resize_and_close_owner_task -- --test-threads=1
```

Expected: FAIL because the runtime methods and protocol variants are missing.

- [ ] **Step 3: Add protocol variants**

Add to `ControlRequest` and `ControlResponse`:

```rust
SendPeerSessionInput {
    request_id: String,
    target_peer_id: String,
    session_id: String,
    data: Vec<u8>,
},
ResizePeerSession {
    request_id: String,
    target_peer_id: String,
    session_id: String,
    cols: u16,
    rows: u16,
},
ClosePeerTask {
    request_id: String,
    target_peer_id: String,
    task_id: String,
},
```

Add to `PeerRequest` and `PeerResponse`:

```rust
SendSessionInput {
    request_id: String,
    requester_peer_id: String,
    session_id: String,
    data: Vec<u8>,
},
ResizeSession {
    request_id: String,
    requester_peer_id: String,
    session_id: String,
    cols: u16,
    rows: u16,
},
CloseTask {
    request_id: String,
    requester_peer_id: String,
    task_id: String,
},
```

- [ ] **Step 4: Implement runtime requester methods**

Add public methods on `TransferRuntime`:

```rust
pub async fn send_peer_session_input(
    &self,
    target_peer_id: &str,
    session_id: &str,
    data: Vec<u8>,
) -> Result<(), RuntimeError> {
    let target_peer = self.find_peer(target_peer_id).await?;
    self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
    let request_id = self.next_request_id("send-input");
    match self.send_peer_request(&target_peer, PeerRequest::SendSessionInput {
        request_id: request_id.clone(),
        requester_peer_id: self.config.peer_id.clone(),
        session_id: session_id.to_owned(),
        data,
    }).await? {
        PeerResponse::SendSessionInput { request_id: response_request_id } if response_request_id == request_id => Ok(()),
        PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(unexpected_peer_response("send-session-input", &other)),
    }
}
```

Add equivalent methods for `resize_peer_session` and `close_peer_task`, using `PeerRequest::ResizeSession` and `PeerRequest::CloseTask`.

- [ ] **Step 5: Implement owner-side peer request handlers**

In `handle_peer_connection`, add match arms that validate trust with the same `ensure_peer_is_trusted_for` path used by `GetTaskSnapshot`, then call daemon commands:

```rust
Ok(PeerRequest::SendSessionInput { request_id, requester_peer_id, session_id, data }) => {
    match send_daemon_input(&context, &requester_peer_id, &session_id, data).await {
        Ok(()) => PeerResponse::SendSessionInput { request_id },
        Err(error) => PeerResponse::Error { request_id, message: error.to_string() },
    }
}
Ok(PeerRequest::ResizeSession { request_id, requester_peer_id, session_id, cols, rows }) => {
    match resize_daemon_session(&context, &requester_peer_id, &session_id, cols, rows).await {
        Ok(()) => PeerResponse::ResizeSession { request_id },
        Err(error) => PeerResponse::Error { request_id, message: error.to_string() },
    }
}
Ok(PeerRequest::CloseTask { request_id, requester_peer_id, task_id }) => {
    match close_owner_task(&context, &requester_peer_id, &task_id).await {
        Ok(()) => PeerResponse::CloseTask { request_id },
        Err(error) => PeerResponse::Error { request_id, message: error.to_string() },
    }
}
```

Use daemon commands:

```rust
DaemonCommand::Input { session_id, data }
DaemonCommand::Resize { session_id, cols, rows }
DaemonCommand::Kill { session_id }
```

For `CloseTask`, kill `task_id`, `shell-wt-{task_id}`, and `td-{task_id}`. If DB path access is available in the sidecar context, mark the task closed through the same SQLite update used by desktop close; if not, update this task to return a clear protocol error and leave the E2E close assertion as the required acceptance gate before completion.

- [ ] **Step 6: Wire sidecar control requests**

In `crates/task-transfer/src/main.rs`, map control requests to the runtime:

```rust
ControlRequest::SendPeerSessionInput { request_id, target_peer_id, session_id, data } => runtime
    .send_peer_session_input(&target_peer_id, &session_id, data)
    .await
    .map(|_| ControlResponse::SendPeerSessionInput { request_id }),
ControlRequest::ResizePeerSession { request_id, target_peer_id, session_id, cols, rows } => runtime
    .resize_peer_session(&target_peer_id, &session_id, cols, rows)
    .await
    .map(|_| ControlResponse::ResizePeerSession { request_id }),
ControlRequest::ClosePeerTask { request_id, target_peer_id, task_id } => runtime
    .close_peer_task(&target_peer_id, &task_id)
    .await
    .map(|_| ControlResponse::ClosePeerTask { request_id }),
```

- [ ] **Step 7: Verify task-transfer tests pass**

Run:

```bash
cargo test -p task-transfer --test runtime -- --test-threads=1
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/task-transfer/src/protocol.rs crates/task-transfer/src/runtime.rs crates/task-transfer/src/main.rs crates/task-transfer/tests/runtime.rs
git commit -m "feat: control LAN peer terminal sessions"
```

---

### Task 5: Desktop LAN Client Actions

**Files:**
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`

- [ ] **Step 1: Add TypeScript LAN client test coverage**

Create `apps/desktop/src/services/desktopLanTerminal.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../invoke", () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock("../listen", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { invoke } from "../invoke";
import { createDesktopLanTerminalClient } from "./desktopLanTerminal";

describe("createDesktopLanTerminalClient", () => {
  it("sends LAN terminal control actions through Tauri commands", async () => {
    const client = createDesktopLanTerminalClient();

    await client.sendInput({ desktopId: "peer-primary", taskId: "task-1", data: "hello\n" });
    await client.resize({ desktopId: "peer-primary", taskId: "task-1", cols: 100, rows: 32 });
    await client.closeTask({ desktopId: "peer-primary", taskId: "task-1" });

    expect(invoke).toHaveBeenCalledWith("send_transfer_peer_session_input", {
      peerId: "peer-primary",
      sessionId: "task-1",
      data: "hello\n",
    });
    expect(invoke).toHaveBeenCalledWith("resize_transfer_peer_session", {
      peerId: "peer-primary",
      sessionId: "task-1",
      cols: 100,
      rows: 32,
    });
    expect(invoke).toHaveBeenCalledWith("close_transfer_peer_task", {
      peerId: "peer-primary",
      taskId: "task-1",
    });
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
pnpm --dir apps/desktop test -- desktopLanTerminal.test.ts
```

Expected: FAIL because LAN action methods are missing.

- [ ] **Step 3: Add sidecar client methods**

Add methods to `TransferSidecarClient`:

```rust
pub async fn send_peer_session_input(
    &mut self,
    peer_id: String,
    session_id: String,
    data: String,
) -> Result<Value, String> {
    let request_id = self.next_request_id("send-input");
    self.send_request(json!({
        "type": "send_peer_session_input",
        "request_id": request_id,
        "target_peer_id": peer_id,
        "session_id": session_id,
        "data": data.as_bytes().to_vec(),
    }), &request_id).await
}
```

Add equivalent `resize_peer_session` and `close_peer_task` methods.

- [ ] **Step 4: Add Tauri commands**

Add commands in `apps/desktop/src-tauri/src/commands/transfer.rs`:

```rust
#[tauri::command]
pub async fn send_transfer_peer_session_input(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    session_id: String,
    data: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard.as_mut().ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.send_peer_session_input(peer_id, session_id, data).await;
        (result, client.is_dead())
    };
    if dead { *guard = None; }
    result
}
```

Add equivalent `resize_transfer_peer_session` and `close_transfer_peer_task` commands, then register them in the Tauri invoke handler in `apps/desktop/src-tauri/src/lib.rs`.

- [ ] **Step 5: Implement TypeScript LAN action methods**

Add methods in `createDesktopLanTerminalClient`:

```ts
async sendInput(options) {
  await invoke("send_transfer_peer_session_input", {
    peerId: options.desktopId,
    sessionId: options.taskId,
    data: options.data,
  });
},
async resize(options) {
  await invoke("resize_transfer_peer_session", {
    peerId: options.desktopId,
    sessionId: options.taskId,
    cols: options.cols,
    rows: options.rows,
  });
},
async closeTask(options) {
  await invoke("close_transfer_peer_task", {
    peerId: options.desktopId,
    taskId: options.taskId,
  });
},
```

- [ ] **Step 6: Verify tests and Rust check pass**

Run:

```bash
pnpm --dir apps/desktop test -- desktopLanTerminal.test.ts
cargo check -p kanna-desktop
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/services/desktopLanTerminal.ts apps/desktop/src/services/desktopLanTerminal.test.ts apps/desktop/src-tauri/src/transfer_sidecar.rs apps/desktop/src-tauri/src/commands/transfer.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat: expose LAN terminal actions to desktop"
```

---

### Task 6: Interactive Remote Terminal UI

**Files:**
- Modify: `apps/desktop/src/components/CloudTerminalView.vue`

- [ ] **Step 1: Write a failing component-level behavior test**

If the existing component test harness can mock xterm cleanly, add `apps/desktop/src/components/CloudTerminalView.test.ts` that stubs `Terminal.onData` and verifies `sendInput` receives typed bytes. If xterm mocking blocks this, rely on the E2E tests in Tasks 8 and 9 as the executable acceptance tests for this UI path.

- [ ] **Step 2: Enable stdin and send typed data**

Change xterm options:

```ts
terminal = new Terminal({
  allowProposedApi: true,
  convertEol: true,
  cursorBlink: true,
  disableStdin: false,
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 12,
  theme: {
    background: "#1a1a1a",
    foreground: "#d4d4d4",
  },
});
```

After terminal creation, register input forwarding:

```ts
terminal.onData((data) => {
  const client = relayClient;
  if (!client || status.value !== "live") return;
  void client.sendInput({
    desktopId: props.ownerDesktopId,
    taskId: props.ownerTaskId,
    data,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Failed to send remote input.";
    status.value = "error";
    errorMessage.value = message;
    terminal?.write(`\r\n[Remote terminal error: ${message}]\r\n`);
  });
});
```

- [ ] **Step 3: Send remote resize after fit**

Add helper:

```ts
function fitAndResizeRemote() {
  fitAddon?.fit();
  const dimensions = fitAddon?.proposeDimensions();
  if (!dimensions || !relayClient || status.value !== "live") return;
  void relayClient.resize({
    desktopId: props.ownerDesktopId,
    taskId: props.ownerTaskId,
    cols: dimensions.cols,
    rows: dimensions.rows,
  }).catch(() => undefined);
}
```

Use it for the initial open and `ResizeObserver` callback.

- [ ] **Step 4: Verify desktop tests**

Run:

```bash
pnpm --dir apps/desktop test -- desktopRelayTerminal.test.ts desktopLanTerminal.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/CloudTerminalView.vue
git commit -m "feat: make remote terminal interactive"
```

---

### Task 7: App-Level Remote Close Routing

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write failing App tests**

Add tests that mount `App.vue` with a selected remote task and assert the close action calls the matching remote client instead of `store.closeTask`:

```ts
it("routes close task to the LAN owner for selected LAN tasks", async () => {
  const closeTask = vi.fn(async () => undefined);
  vi.mocked(createConfiguredDesktopLanTerminalClient).mockResolvedValue({
    close: vi.fn(),
    observeTerminal: vi.fn(),
    sendInput: vi.fn(),
    resize: vi.fn(),
    closeTask,
  });

  const wrapper = mountAppWithWorkspaceTask({
    id: "lan:peer-primary:task-1",
    terminal: {
      kind: "lan",
      remoteRef: {
        ownerDesktopId: "peer-primary",
        ownerLocalTaskId: "task-1",
        transport: "lan",
      },
    },
  });

  await wrapper.vm.keyboardActions.closeTask();

  expect(closeTask).toHaveBeenCalledWith({
    desktopId: "peer-primary",
    taskId: "task-1",
  });
  expect(mockStore.closeTask).not.toHaveBeenCalled();
});
```

Add the same test for `terminal.kind === "cloud"` using `createConfiguredDesktopRelayTerminalClient`.

- [ ] **Step 2: Run the focused App tests and confirm failure**

Run:

```bash
pnpm --dir apps/desktop test -- App.test.ts -t "routes close task"
```

Expected: FAIL because `keyboardActions.closeTask` always calls `store.closeTask`.

- [ ] **Step 3: Implement close routing**

Import the remote client factories and add:

```ts
async function closeSelectedWorkspaceTask() {
  const workspaceTask = selectedWorkspaceTask.value;
  if (!workspaceTask || workspaceTask.terminal.kind === "local") {
    await store.closeTask();
    return;
  }

  const remoteRef = workspaceTask.terminal.remoteRef;
  if (!remoteRef || !workspaceTask.capabilities.canClose) {
    toast.error("Remote task is not reachable.");
    return;
  }

  const client = workspaceTask.terminal.kind === "lan"
    ? await createConfiguredDesktopLanTerminalClient()
    : await createConfiguredDesktopRelayTerminalClient();
  if (!client) {
    toast.error("Remote task owner is unavailable.");
    return;
  }
  try {
    await client.closeTask({
      desktopId: remoteRef.ownerDesktopId,
      taskId: remoteRef.ownerLocalTaskId,
    });
  } finally {
    client.close();
  }
}
```

Update:

```ts
closeTask: () => closeSelectedWorkspaceTask(),
```

and:

```vue
@close-task="closeSelectedWorkspaceTask"
```

- [ ] **Step 4: Verify App tests**

Run:

```bash
pnpm --dir apps/desktop test -- App.test.ts -t "routes close task"
pnpm --dir apps/desktop test -- App.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.vue apps/desktop/src/App.test.ts
git commit -m "feat: route remote task close to owner"
```

---

### Task 8: LAN E2E Remote Input And Close

**Files:**
- Modify: `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`

- [ ] **Step 1: Update LAN E2E to require interactive control**

Change the spawned shell to wait for input:

```ts
args: [
  "--login",
  "-c",
  "printf 'LAN terminal ready from primary\\n'; read line; printf 'LAN terminal input:%s\\n' \"$line\"; sleep 60",
],
```

After selecting the remote task, type into the terminal:

```ts
await waitForBodyText("LAN terminal ready from primary");
const terminalTextarea = await secondary.waitForElement(".xterm-helper-textarea");
await secondary.sendKeys(terminalTextarea, "hello from secondary\n");
await waitForBodyText("LAN terminal input:hello from secondary");
```

Then close the remote task from the secondary app:

```ts
const closeResult = await callVueMethod(secondary, "closeSelectedWorkspaceTask");
if (isVueCallError(closeResult)) throw new Error(closeResult.__error);
await waitForSidebarTaskToDisappear(secondary, "LAN visible task");
```

Add `waitForSidebarTaskToDisappear` mirroring the cloud E2E helper.

- [ ] **Step 2: Run LAN E2E and confirm it passes**

Run with an already running two-instance dev environment:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/local-transfer-task-sync.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts
git commit -m "test: cover LAN remote task input and close"
```

---

### Task 9: Cloud E2E Remote Input And Close

**Files:**
- Modify: `apps/desktop/tests/e2e/real/cloud-task-sync.test.ts`

- [ ] **Step 1: Update cloud E2E to spawn and control a real owner session**

After creating the primary task, spawn a shell session:

```ts
await tauriInvoke(primary, "spawn_session", {
  sessionId: result,
  cwd: testRepoPath,
  executable: "/bin/zsh",
  args: [
    "--login",
    "-c",
    "printf 'Cloud terminal ready from primary\\n'; read line; printf 'Cloud terminal input:%s\\n' \"$line\"; sleep 60",
  ],
  env: {},
  cols: 80,
  rows: 24,
  agentProvider: "codex",
});
```

Select the remote task on the secondary app:

```ts
await callVueMethod(secondary, "handleSelectItem", synced.item.id);
await waitForBodyText(secondary, "Cloud terminal ready from primary");
const terminalTextarea = await secondary.waitForElement(".xterm-helper-textarea");
await secondary.sendKeys(terminalTextarea, "hello through cloud\n");
await waitForBodyText(secondary, "Cloud terminal input:hello through cloud");
```

Close from the secondary app:

```ts
const closeResult = await callVueMethod(secondary, "closeSelectedWorkspaceTask");
if (closeResult && typeof closeResult === "object" && "__error" in closeResult) {
  throw new Error(String((closeResult as { __error: string }).__error));
}
await waitForSidebarTaskToDisappear(secondary, "Cloud sync visible task");
```

- [ ] **Step 2: Run cloud E2E and confirm it passes**

Run with dev emulators and relay up:

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-task-sync.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/tests/e2e/real/cloud-task-sync.test.ts
git commit -m "test: cover cloud remote task input and close"
```

---

### Task 10: Full Verification

**Files:**
- No code files.

- [ ] **Step 1: Run focused TypeScript tests**

```bash
pnpm --dir apps/desktop test -- buildWorkspace.test.ts desktopRelayTerminal.test.ts desktopLanTerminal.test.ts App.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run Rust checks and tests**

```bash
cargo check -p kanna-server
cargo check -p kanna-desktop
cargo test -p task-transfer --test runtime -- --test-threads=1
```

Expected: PASS.

- [ ] **Step 3: Run E2E parity tests**

```bash
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/local-transfer-task-sync.test.ts
pnpm --dir apps/desktop exec tsx tests/e2e/run.ts real/cloud-task-sync.test.ts
```

Expected: PASS.

- [ ] **Step 4: Build desktop frontend**

```bash
pnpm --dir apps/desktop build
```

Expected: PASS.

- [ ] **Step 5: Final diff check**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; status only contains intentional branch work.

