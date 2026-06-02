# Remote Task Action Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reachable local, LAN, and cloud workspace tasks share one action surface for lifecycle actions, diffing, file browsing, shell access, and IDE review snapshots.

**Architecture:** The selected `WorkspaceTask` resolves an owner route, then the frontend calls a single task action gateway. Local actions call existing store/Tauri paths; remote actions travel through LAN or cloud transport to owner `kanna-server`, which remains authoritative for DB, daemon, git, and filesystem effects. UI components consume task-scoped providers instead of branching on local versus remote source.

**Tech Stack:** Vue 3, Pinia, Vitest, Tauri commands, Rust `kanna-server` with axum, Rust `task-transfer`, Kanna daemon protocol, SQLite, git CLI/libgit paths already used by Kanna, WebDriver E2E.

---

## File Structure

- Create `apps/desktop/src/workspace/taskActions.ts`: frontend action gateway interfaces, route selection, and local/cloud/LAN client adapters.
- Create `apps/desktop/src/workspace/taskActions.test.ts`: gateway route selection and action dispatch tests.
- Modify `apps/desktop/src/workspace/types.ts`: add owner-advertised route action capabilities and provider-specific capability flags.
- Modify `apps/desktop/src/workspace/buildWorkspace.ts`: merge advertised capabilities from local, LAN, and cloud sources.
- Modify `apps/desktop/src/workspace/buildWorkspace.test.ts`: verify local, LAN, cloud, and offline capability merging.
- Modify `apps/desktop/src/services/desktopCloudTaskIndex.ts`: carry owner action capabilities from cloud snapshots into workspace terminal refs.
- Modify `apps/desktop/src/services/desktopLanTaskIndex.ts`: carry owner action capabilities from LAN task snapshots into workspace terminal refs.
- Modify `apps/desktop/src/utils/cloudTaskSnapshot.ts`: publish owner action capabilities for local tasks.
- Modify `apps/desktop/src/utils/cloudTaskSnapshot.test.ts`: verify published snapshot actions.
- Modify `apps/desktop/src/services/desktopRelayTerminal.ts`: expose generic remote task actions and provider requests over relay invoke.
- Modify `apps/desktop/src/services/desktopRelayTerminal.test.ts`: verify relay request shapes for actions, diff, files, shell, and snapshot.
- Modify `apps/desktop/src/services/desktopLanTerminal.ts`: expose the same generic action/provider methods through Tauri transfer commands.
- Modify `apps/desktop/src/services/desktopLanTerminal.test.ts`: verify LAN action/provider Tauri invokes.
- Modify `crates/task-transfer/src/protocol.rs`: add generic task action and owner HTTP request protocol messages.
- Modify `crates/task-transfer/src/runtime.rs`: forward generic LAN task actions to owner `kanna-server` and return HTTP-like responses.
- Modify `crates/task-transfer/src/main.rs`: handle generic control requests.
- Modify `crates/task-transfer/tests/runtime.rs`: prove generic LAN forwarding reaches owner `kanna-server`.
- Modify `apps/desktop/src-tauri/src/transfer_sidecar.rs`: add generic sidecar client methods.
- Modify `apps/desktop/src-tauri/src/commands/transfer.rs`: expose generic Tauri commands for LAN action/provider requests.
- Modify `apps/desktop/src-tauri/src/lib.rs`: register new transfer commands.
- Modify `crates/kanna-server/src/http_api.rs`: add owner routes for generic actions, diff, files, shell sessions, and snapshots.
- Modify `crates/kanna-server/src/mobile_api.rs`: add response types for task diff, file listing, file content, shell creation, and snapshot creation.
- Add `crates/kanna-server/src/task_files.rs`: owner-side file listing, containment checks, and file content reading.
- Add `crates/kanna-server/src/task_diff.rs`: owner-side task diff response assembly.
- Add `crates/kanna-server/src/task_snapshot.rs`: owner-side filtered archive creation for IDE review snapshots.
- Modify `crates/kanna-server/Cargo.toml`: add `tar` and `flate2` if the crate does not already have archive helpers available through existing dependencies.
- Modify `apps/desktop/src/components/DiffModal.vue`: accept a task diff provider or diff data in addition to local repo path.
- Modify `apps/desktop/src/components/FilePickerModal.vue`: accept a task file provider.
- Modify `apps/desktop/src/components/FilePreviewModal.vue`: accept remote file content metadata.
- Modify `apps/desktop/src/components/TreeExplorerModal.vue`: accept a task file provider.
- Modify `apps/desktop/src/components/ShellModal.vue`: accept local or remote shell session routes.
- Modify `apps/desktop/src/App.vue`: route keyboard actions through `taskActions`.
- Modify `apps/desktop/src/App.test.ts`: cover remote `Cmd+D`, `Cmd+P`, `Cmd+J`, and `Cmd+O` routing.
- Add `apps/desktop/src/workspace/remoteSnapshot.ts`: unpack remote IDE review snapshots, write marker files, retain snapshots, and invoke the IDE.
- Add `apps/desktop/src/workspace/remoteSnapshot.test.ts`: verify marker content, retention, size failure handling, and IDE invocation.
- Modify `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`: add LAN remote diff/file/shell/snapshot smoke coverage.
- Modify `apps/desktop/tests/e2e/mock/keyboard-shortcuts.test.ts`: assert remote shortcuts use remote providers when available.

---

### Task 1: Publish And Merge Route Action Capabilities

**Files:**
- Modify: `apps/desktop/src/workspace/types.ts`
- Modify: `apps/desktop/src/workspace/buildWorkspace.ts`
- Test: `apps/desktop/src/workspace/buildWorkspace.test.ts`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Modify: `apps/desktop/src/services/desktopLanTaskIndex.ts`
- Modify: `apps/desktop/src/utils/cloudTaskSnapshot.ts`
- Test: `apps/desktop/src/utils/cloudTaskSnapshot.test.ts`

- [ ] **Step 1: Write failing snapshot capability tests**

Add this test to `apps/desktop/src/utils/cloudTaskSnapshot.test.ts`:

```ts
function repoFixture(overrides = {}) {
  return {
    id: "repo-1",
    name: "kanna",
    path: "/tmp/repo",
    default_branch: "main",
    remote_url: "git@example.com:kanna.git",
    ...overrides,
  };
}

function itemFixture(overrides = {}) {
  return {
    id: "task-1",
    repo_id: "repo-1",
    prompt: "Remote parity",
    stage: "in progress",
    activity: "working",
    branch: "task-1",
    base_ref: "origin/main",
    pr_number: null,
    pr_url: null,
    display_name: "Remote parity",
    agent_provider: "claude",
    agent_type: "pty",
    created_at: "2026-06-02T00:00:00.000Z",
    updated_at: "2026-06-02T00:01:00.000Z",
    closed_at: null,
    ...overrides,
  };
}

it("publishes owner action capabilities for local task snapshots", async () => {
  const snapshot = await buildCloudTaskSnapshot({
    desktopId: "desktop-local",
    repo: repoFixture({ id: "repo-1", path: "/tmp/repo" }),
    item: itemFixture({ id: "task-1", repo_id: "repo-1" }),
    blockedByTaskIds: [],
  });

  expect(snapshot.actions).toEqual({
    terminal: true,
    sendInput: true,
    resizeTerminal: true,
    close: true,
    advanceStage: true,
    makePr: true,
    mergePr: true,
    diff: true,
    listFiles: true,
    readFile: true,
    openShell: true,
    ideSnapshot: true,
    pullToMachine: true,
  });
});
```

Add this test to `apps/desktop/src/workspace/buildWorkspace.test.ts`:

```ts
function snapshotWithTask(input: {
  taskId: string;
  ownerDesktopId: string;
  ownerLocalTaskId: string;
  actions: Record<string, boolean>;
}) {
  return {
    repos: [repo({ id: "repo-1", path: "remote", name: "kanna" })],
    items: [item({
      id: input.taskId,
      repo_id: "repo-1",
      display_name: "Remote task",
      updated_at: "2026-06-02T00:00:00.000Z",
    })],
    terminalRefs: {
      [input.taskId]: {
        ownerDesktopId: input.ownerDesktopId,
        ownerLocalTaskId: input.ownerLocalTaskId,
        transport: "lan",
        actions: input.actions,
      },
    },
  };
}

it("merges owner-advertised remote capabilities into the workspace task", () => {
  const result = buildWorkspace({
    localRepos: [],
    localItems: [],
    cloudSnapshot: emptySnapshot(),
    lanSnapshot: snapshotWithTask({
      taskId: "lan:peer-1:repo-1:task-1",
      ownerDesktopId: "peer-1",
      ownerLocalTaskId: "task-1",
      actions: {
        terminal: true,
        diff: true,
        readFile: true,
        ideSnapshot: true,
        advanceStage: true,
      },
    }),
  });

  expect(result.tasks[0]?.capabilities).toMatchObject({
    canOpenTerminal: true,
    canOpenDiff: true,
    canOpenInIde: true,
    canAdvanceStage: true,
  });
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/utils/cloudTaskSnapshot.test.ts src/workspace/buildWorkspace.test.ts
```

Expected: FAIL because snapshots do not publish `actions` and `buildWorkspace()` does not merge advertised action capabilities.

- [ ] **Step 3: Add action types and snapshot publishing**

Add to `apps/desktop/src/workspace/types.ts`:

```ts
export type WorkspaceTaskActionName =
  | "terminal"
  | "sendInput"
  | "resizeTerminal"
  | "close"
  | "advanceStage"
  | "makePr"
  | "mergePr"
  | "diff"
  | "listFiles"
  | "readFile"
  | "openShell"
  | "ideSnapshot"
  | "pullToMachine";

export type WorkspaceTaskActionCapabilities = Partial<Record<WorkspaceTaskActionName, boolean>>;
```

Add `actions?: WorkspaceTaskActionCapabilities` to `WorkspaceTaskSource` and `WorkspaceTerminalRoute`.

In `apps/desktop/src/utils/cloudTaskSnapshot.ts`, add the default action map:

```ts
const DEFAULT_OWNER_ACTIONS = {
  terminal: true,
  sendInput: true,
  resizeTerminal: true,
  close: true,
  advanceStage: true,
  makePr: true,
  mergePr: true,
  diff: true,
  listFiles: true,
  readFile: true,
  openShell: true,
  ideSnapshot: true,
  pullToMachine: true,
} as const;
```

Include `actions: DEFAULT_OWNER_ACTIONS` in the returned snapshot object.

- [ ] **Step 4: Carry actions through cloud and LAN task indexes**

In `apps/desktop/src/services/desktopCloudTaskIndex.ts`, add `actions?: WorkspaceTaskActionCapabilities` to `DesktopCloudTaskSnapshot` and `DesktopCloudTerminalRef`.

When building `terminalRefs[itemId]`, copy:

```ts
actions: snapshot.actions ?? {},
```

In `apps/desktop/src/services/desktopLanTaskIndex.ts`, preserve `actions` when mapping peer snapshots:

```ts
tasks.push({
  ...task,
  cloudTaskId: `lan:${peerId}:${task.cloudTaskId}`,
  ownerDesktopId: peerId,
  actions: task.actions ?? {},
});
```

- [ ] **Step 5: Merge route actions into UI capabilities**

In `apps/desktop/src/workspace/buildWorkspace.ts`, compute capabilities from all sources:

```ts
function hasAction(
  sources: WorkspaceTaskSource[],
  action: WorkspaceTaskActionName,
): boolean {
  return sources.some((source) => source.kind === "local" || source.actions?.[action]);
}
```

Update `capabilitiesForSources()`:

```ts
return {
  canOpenTerminal: hasAction(sources, "terminal"),
  canSendInput: hasAction(sources, "sendInput"),
  canResizeTerminal: hasAction(sources, "resizeTerminal"),
  canClose: hasAction(sources, "close"),
  canCreateSiblingTask: true,
  canPushToMachine: isLocal,
  canPullFromMachine: !isLocal && hasAction(sources, "pullToMachine"),
  canOpenDiff: hasAction(sources, "diff"),
  canOpenInIde: isLocal || hasAction(sources, "ideSnapshot"),
  canOpenShell: hasAction(sources, "openShell"),
  canAdvanceStage: hasAction(sources, "advanceStage"),
  canEditMetadata: isReachable,
};
```

- [ ] **Step 6: Verify tests pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/utils/cloudTaskSnapshot.test.ts src/workspace/buildWorkspace.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/workspace/types.ts apps/desktop/src/workspace/buildWorkspace.ts apps/desktop/src/workspace/buildWorkspace.test.ts apps/desktop/src/services/desktopCloudTaskIndex.ts apps/desktop/src/services/desktopLanTaskIndex.ts apps/desktop/src/utils/cloudTaskSnapshot.ts apps/desktop/src/utils/cloudTaskSnapshot.test.ts
git commit -m "feat: advertise remote task action capabilities"
```

---

### Task 2: Introduce Workspace Task Action Gateway

**Files:**
- Create: `apps/desktop/src/workspace/taskActions.ts`
- Test: `apps/desktop/src/workspace/taskActions.test.ts`
- Modify: `apps/desktop/src/App.vue`
- Test: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write failing gateway route tests**

Create `apps/desktop/src/workspace/taskActions.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceTaskActions } from "./taskActions";
import type { WorkspaceTask } from "./types";

function fakeLocalClient() {
  return {
    advanceStage: vi.fn(async () => {}),
    closeTask: vi.fn(async () => {}),
    getDiff: vi.fn(async () => ({ scope: "working", patch: "" })),
    listFiles: vi.fn(async () => []),
    readFile: vi.fn(async () => ({ path: "", text: "", binary: false, size: 0 })),
    openShell: vi.fn(async () => ({ sessionId: "shell-local" })),
    openInIde: vi.fn(async () => {}),
  };
}

function fakeRemoteClient() {
  return {
    runAction: vi.fn(async () => ({})),
    getDiff: vi.fn(async () => ({ scope: "working", patch: "" })),
    listFiles: vi.fn(async () => []),
    readFile: vi.fn(async () => ({ path: "", text: "", binary: false, size: 0 })),
    openShell: vi.fn(async () => ({ sessionId: "shell-remote" })),
    createSnapshot: vi.fn(async () => ({
      archiveBase64: "",
      sizeBytes: 0,
      repoName: "kanna",
      branch: "task-1",
    })),
  };
}

function taskWithRoute(kind: "local" | "lan" | "cloud"): WorkspaceTask {
  return {
    id: `${kind}:task-1`,
    logicalTaskKey: "repo:owner-local:task-1",
    localTaskId: kind === "local" ? "task-1" : null,
    remoteTaskIds: kind === "local" ? [] : [`${kind}:task-1`],
    repoKey: "repo-1",
    item: { id: "task-1", repo_id: "repo-1" } as WorkspaceTask["item"],
    owner: kind === "local" ? { kind: "local", id: "local" } : { kind: "remote", id: "owner-1" },
    sources: [],
    reachability: kind === "local" ? "local" : "reachable",
    capabilities: {
      canOpenTerminal: true,
      canSendInput: true,
      canResizeTerminal: true,
      canClose: true,
      canCreateSiblingTask: true,
      canPushToMachine: kind === "local",
      canPullFromMachine: kind !== "local",
      canOpenDiff: true,
      canOpenInIde: true,
      canOpenShell: true,
      canAdvanceStage: true,
      canEditMetadata: true,
    },
    terminal: kind === "local"
      ? { kind: "local", localSessionId: "task-1" }
      : {
          kind,
          remoteRef: {
            ownerDesktopId: "owner-1",
            ownerLocalTaskId: "task-1",
            transport: kind,
          },
        },
  };
}

describe("createWorkspaceTaskActions", () => {
  it("routes lifecycle actions to the selected owner client", async () => {
    const local = { advanceStage: vi.fn(async () => {}) };
    const lan = { runAction: vi.fn(async () => ({})) };
    const cloud = { runAction: vi.fn(async () => ({})) };

    const actions = createWorkspaceTaskActions({ local, lan, cloud });

    await actions.advanceStage(taskWithRoute("lan"));
    await actions.advanceStage(taskWithRoute("cloud"));
    await actions.advanceStage(taskWithRoute("local"));

    expect(lan.runAction).toHaveBeenCalledWith("owner-1", "task-1", "advance-stage", {});
    expect(cloud.runAction).toHaveBeenCalledWith("owner-1", "task-1", "advance-stage", {});
    expect(local.advanceStage).toHaveBeenCalledWith("task-1");
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/workspace/taskActions.test.ts
```

Expected: FAIL because `taskActions.ts` does not exist.

- [ ] **Step 3: Implement the gateway**

Create `apps/desktop/src/workspace/taskActions.ts`:

```ts
import type { WorkspaceTask } from "./types";

export interface LocalTaskActionClient {
  advanceStage(taskId: string): Promise<void>;
  closeTask(taskId?: string): Promise<void>;
}

export interface RemoteTaskActionClient {
  runAction(
    desktopId: string,
    taskId: string,
    action: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface WorkspaceTaskActionsDeps {
  local: LocalTaskActionClient;
  lan: RemoteTaskActionClient;
  cloud: RemoteTaskActionClient;
}

function requireTaskRoute(task: WorkspaceTask) {
  if (task.localTaskId) {
    return { kind: "local" as const, taskId: task.localTaskId };
  }
  const remoteRef = task.terminal.remoteRef;
  if ((task.terminal.kind === "lan" || task.terminal.kind === "cloud") && remoteRef) {
    return {
      kind: task.terminal.kind,
      desktopId: remoteRef.ownerDesktopId,
      taskId: remoteRef.ownerLocalTaskId,
    };
  }
  throw new Error("Task owner is not reachable.");
}

export function createWorkspaceTaskActions(deps: WorkspaceTaskActionsDeps) {
  async function runRemoteOrLocal(
    task: WorkspaceTask,
    action: string,
    args: Record<string, unknown> = {},
  ) {
    const route = requireTaskRoute(task);
    if (route.kind === "local") {
      if (action === "advance-stage") return deps.local.advanceStage(route.taskId);
      if (action === "close") return deps.local.closeTask(route.taskId);
      throw new Error(`Unsupported local task action: ${action}`);
    }
    const client = route.kind === "lan" ? deps.lan : deps.cloud;
    return client.runAction(route.desktopId, route.taskId, action, args);
  }

  return {
    advanceStage(task: WorkspaceTask) {
      return runRemoteOrLocal(task, "advance-stage");
    },
    close(task: WorkspaceTask) {
      return runRemoteOrLocal(task, "close");
    },
    runAction: runRemoteOrLocal,
  };
}
```

- [ ] **Step 4: Route App lifecycle shortcuts through the gateway**

In `apps/desktop/src/App.vue`, create the gateway after store/client imports:

```ts
const taskActions = createWorkspaceTaskActions({
  local: {
    advanceStage: (taskId) => store.advanceStage(taskId),
    closeTask: (taskId) => taskId ? store.closeTask(taskId) : store.closeTask(),
  },
  lan: createLanActionClient(),
  cloud: createCloudActionClient(),
});
```

Replace direct `store.advanceStage` and remote helper calls in `keyboardActions.advanceStage` with:

```ts
if (workspaceTask) {
  if (!workspaceTask.capabilities.canAdvanceStage) return;
  void taskActions.advanceStage(workspaceTask).catch((error) =>
    toast.error(error instanceof Error ? error.message : String(error)),
  );
  return;
}
```

- [ ] **Step 5: Verify gateway and App tests pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/workspace/taskActions.test.ts src/App.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/workspace/taskActions.ts apps/desktop/src/workspace/taskActions.test.ts apps/desktop/src/App.vue apps/desktop/src/App.test.ts
git commit -m "feat: route task lifecycle actions through workspace gateway"
```

---

### Task 3: Replace Per-Action LAN Commands With Generic Task Action Transport

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Test: `crates/task-transfer/tests/runtime.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`
- Test: `apps/desktop/src/services/desktopLanTerminal.test.ts`

- [ ] **Step 1: Write failing Rust LAN forwarding test**

Add to `crates/task-transfer/tests/runtime.rs`:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lan_generic_task_action_forwards_to_owner_server() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let owner_port = listener.local_addr().unwrap().port();

    let http_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();
        assert_eq!(
            request_line.trim_end(),
            "POST /v1/tasks/task-owner/actions/advance-stage HTTP/1.1"
        );
        let mut body = String::new();
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).await.unwrap();
            if header == "\r\n" || header.is_empty() {
                break;
            }
        }
        reader.read_to_string(&mut body).await.unwrap();
        assert_eq!(body, "{}");
        let mut stream = reader.into_inner();
        stream
            .write_all(b"HTTP/1.1 204 No Content\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
            .await
            .unwrap();
    });

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_local_server_port(owner_port),
    )
    .await
    .unwrap();
    let viewer = TransferRuntime::spawn(RuntimeConfig::for_tests(
        "peer-viewer",
        "Viewer",
        temp.path(),
        0,
    ))
    .await
    .unwrap();

    pair_peers(&viewer, &owner, "peer-owner").await;
    consume_pairing_completed(&owner).await;

    viewer
        .run_peer_task_action("peer-owner", "task-owner", "advance-stage", serde_json::json!({}))
        .await
        .unwrap();

    http_server.await.unwrap();
}
```

- [ ] **Step 2: Run Rust test and confirm failure**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml lan_generic_task_action_forwards_to_owner_server -- --nocapture
```

Expected: FAIL because `run_peer_task_action` and protocol variants do not exist.

- [ ] **Step 3: Add protocol variants**

In `crates/task-transfer/src/protocol.rs`, add:

```rust
RunPeerTaskAction {
    request_id: String,
    target_peer_id: String,
    task_id: String,
    action: String,
    args: serde_json::Value,
},
```

to `ControlRequest`, add:

```rust
RunPeerTaskAction {
    request_id: String,
    status: u16,
    body: serde_json::Value,
},
```

to `ControlResponse`, add:

```rust
RunTaskAction {
    request_id: String,
    requester_peer_id: String,
    task_id: String,
    action: String,
    args: serde_json::Value,
},
```

to `PeerRequest`, and add:

```rust
RunTaskAction {
    request_id: String,
    status: u16,
    body: serde_json::Value,
},
```

to `PeerResponse`.

- [ ] **Step 4: Implement runtime forwarding**

In `crates/task-transfer/src/runtime.rs`, add:

```rust
pub async fn run_peer_task_action(
    &self,
    target_peer_id: &str,
    task_id: &str,
    action: &str,
    args: serde_json::Value,
) -> Result<(u16, serde_json::Value), RuntimeError> {
    let target_peer = self.find_peer(target_peer_id).await?;
    self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
    let request_id = self.next_request_id("task-action");
    let response = self
        .send_peer_request(
            &target_peer,
            PeerRequest::RunTaskAction {
                request_id: request_id.clone(),
                requester_peer_id: self.config.peer_id.clone(),
                task_id: task_id.to_owned(),
                action: action.to_owned(),
                args,
            },
        )
        .await?;
    match response {
        PeerResponse::RunTaskAction { request_id: response_request_id, status, body }
            if response_request_id == request_id => Ok((status, body)),
        PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(unexpected_peer_response("task-action", &other)),
    }
}
```

Add owner handling:

```rust
Ok(PeerRequest::RunTaskAction {
    request_id,
    requester_peer_id,
    task_id,
    action,
    args,
}) => match run_owner_task_action(&context, &requester_peer_id, &task_id, &action, args).await {
    Ok((status, body)) => PeerResponse::RunTaskAction { request_id, status, body },
    Err(error) => PeerResponse::Error { request_id, message: error.to_string() },
},
```

Implement `run_owner_task_action()` by reusing the HTTP request helper used for stage advance, with path:

```rust
format!(
    "/v1/tasks/{}/actions/{}",
    percent_encode_path_segment(task_id),
    percent_encode_path_segment(action),
)
```

- [ ] **Step 5: Wire sidecar and TypeScript LAN client**

In `apps/desktop/src-tauri/src/transfer_sidecar.rs`, add:

```rust
pub async fn run_peer_task_action(
    &mut self,
    peer_id: String,
    task_id: String,
    action: String,
    args: Value,
) -> Result<Value, String> {
    let request_id = self.next_request_id("task-action");
    self.send_request(
        json!({
            "type": "run_peer_task_action",
            "request_id": request_id,
            "target_peer_id": peer_id,
            "task_id": task_id,
            "action": action,
            "args": args,
        }),
        &request_id,
    ).await
}
```

Expose `run_transfer_peer_task_action` in `apps/desktop/src-tauri/src/commands/transfer.rs` and register it in `apps/desktop/src-tauri/src/lib.rs`.

In `apps/desktop/src/services/desktopLanTerminal.ts`, implement:

```ts
async runAction(desktopId, taskId, action, args) {
  return invoke("run_transfer_peer_task_action", {
    peerId: desktopId,
    taskId,
    action,
    args,
  });
}
```

- [ ] **Step 6: Verify LAN tests pass**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml lan_generic_task_action_forwards_to_owner_server -- --nocapture
pnpm --dir apps/desktop exec vitest run src/services/desktopLanTerminal.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/task-transfer/src/protocol.rs crates/task-transfer/src/runtime.rs crates/task-transfer/src/main.rs crates/task-transfer/tests/runtime.rs apps/desktop/src-tauri/src/transfer_sidecar.rs apps/desktop/src-tauri/src/commands/transfer.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/services/desktopLanTerminal.ts apps/desktop/src/services/desktopLanTerminal.test.ts
git commit -m "feat: add generic LAN task action transport"
```

---

### Task 4: Add Owner Server Diff And File Routes

**Files:**
- Add: `crates/kanna-server/src/task_files.rs`
- Add: `crates/kanna-server/src/task_diff.rs`
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/http_api.rs`

- [ ] **Step 1: Write failing HTTP route tests**

Add tests to `crates/kanna-server/src/http_api.rs` near existing route tests:

```rust
#[tokio::test]
async fn task_files_route_requires_existing_task_worktree() {
    let app = test_router("desktop-1", "Desktop");

    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1/files")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn task_file_read_rejects_path_escape() {
    let app = test_router("desktop-1", "Desktop");
    let response = app
        .oneshot(
            Request::get("/v1/tasks/task-1/files?path=../Cargo.toml")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 2: Run server tests and confirm failure**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml task_files_route_lists_worktree_files task_file_read_rejects_path_escape -- --nocapture
```

Expected: FAIL because routes and helper functions do not exist.

- [ ] **Step 3: Add response types**

In `crates/kanna-server/src/mobile_api.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskFileEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskFileContent {
    pub path: String,
    pub text: Option<String>,
    pub binary: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDiffResponse {
    pub scope: String,
    pub patch: String,
}
```

- [ ] **Step 4: Implement owner file helpers**

Create `crates/kanna-server/src/task_files.rs`:

```rust
use std::path::{Component, Path, PathBuf};

pub fn contained_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains('\0') {
        return Err("path contains NUL".into());
    }
    let relative_path = Path::new(relative);
    for component in relative_path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("path escapes task worktree".into());
            }
        }
    }
    Ok(root.join(relative_path))
}
```

Use existing gitignore-aware file listing from desktop commands as the model.

- [ ] **Step 5: Implement owner diff helper**

Create `crates/kanna-server/src/task_diff.rs`:

```rust
use std::process::Command;

pub fn task_diff(worktree_path: &str, scope: &str) -> Result<String, String> {
    let args: &[&str] = match scope {
        "working" => &["diff", "--no-ext-diff"],
        "staged" => &["diff", "--cached", "--no-ext-diff"],
        "last-commit" => &["show", "--format=", "--no-ext-diff", "HEAD"],
        _ => &["diff", "--no-ext-diff", "HEAD"],
    };
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .output()
        .map_err(|error| format!("failed to run git diff: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
```

- [ ] **Step 6: Add routes**

In `crates/kanna-server/src/http_api.rs`, add:

```rust
async fn task_files(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<Vec<crate::mobile_api::TaskFileEntry>>, (axum::http::StatusCode, String)> {
    let worktree = state.db.worktree_for_task(&task_id)
        .map_err(|error| db_read_error("failed to load task worktree", error))?;
    crate::task_files::list_files(&worktree.path)
        .map(Json)
        .map_err(|message| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, message))
}
```

Register:

```rust
.route("/v1/tasks/{task_id}/files", get(task_files))
.route("/v1/tasks/{task_id}/diff", get(task_diff))
```

- [ ] **Step 7: Verify server tests pass**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml task_files_route_lists_worktree_files task_file_read_rejects_path_escape -- --nocapture
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add crates/kanna-server/src/task_files.rs crates/kanna-server/src/task_diff.rs crates/kanna-server/src/mobile_api.rs crates/kanna-server/src/http_api.rs crates/kanna-server/Cargo.toml
git commit -m "feat: expose owner task diff and file routes"
```

---

### Task 5: Add Diff And File Providers In The Frontend

**Files:**
- Modify: `apps/desktop/src/workspace/taskActions.ts`
- Test: `apps/desktop/src/workspace/taskActions.test.ts`
- Modify: `apps/desktop/src/components/DiffModal.vue`
- Modify: `apps/desktop/src/components/FilePickerModal.vue`
- Modify: `apps/desktop/src/components/FilePreviewModal.vue`
- Modify: `apps/desktop/src/components/TreeExplorerModal.vue`
- Modify: `apps/desktop/src/App.vue`
- Test: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write failing provider tests**

Add to `apps/desktop/src/workspace/taskActions.test.ts`:

```ts
it("returns remote diff and file providers for a LAN task", async () => {
  const lan = {
    runAction: vi.fn(async () => ({})),
    getDiff: vi.fn(async () => ({ scope: "working", patch: "diff --git a/a b/a\n" })),
    listFiles: vi.fn(async () => [{ path: "src/App.vue", isDir: false, size: 100 }]),
    readFile: vi.fn(async () => ({ path: "src/App.vue", text: "<template />", binary: false, size: 12 })),
  };
  const actions = createWorkspaceTaskActions({
    local: fakeLocalClient(),
    lan,
    cloud: fakeRemoteClient(),
  });
  const task = taskWithRoute("lan");

  await expect(actions.getDiff(task, { scope: "working" })).resolves.toMatchObject({
    patch: expect.stringContaining("diff --git"),
  });
  await expect(actions.listFiles(task, {})).resolves.toEqual([
    { path: "src/App.vue", isDir: false, size: 100 },
  ]);
  await expect(actions.readFile(task, "src/App.vue")).resolves.toMatchObject({
    text: "<template />",
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/workspace/taskActions.test.ts src/App.test.ts
```

Expected: FAIL because provider methods are missing.

- [ ] **Step 3: Add provider methods to action clients**

Extend `RemoteTaskActionClient`:

```ts
getDiff(desktopId: string, taskId: string, options: { scope: string }): Promise<{ scope: string; patch: string }>;
listFiles(desktopId: string, taskId: string, options: Record<string, unknown>): Promise<Array<{ path: string; isDir: boolean; size?: number }>>;
readFile(desktopId: string, taskId: string, path: string): Promise<{ path: string; text: string | null; binary: boolean; size: number }>;
```

Add gateway methods:

```ts
getDiff(task: WorkspaceTask, options: { scope: string }) {
  const route = requireTaskRoute(task);
  if (route.kind === "local") return deps.local.getDiff(route.taskId, options);
  return (route.kind === "lan" ? deps.lan : deps.cloud).getDiff(route.desktopId, route.taskId, options);
}
```

Implement equivalent `listFiles()` and `readFile()`.

- [ ] **Step 4: Convert components to accept providers**

Update `DiffModal.vue` props:

```ts
const props = defineProps<{
  repoPath?: string;
  item?: PipelineItem | null;
  diffProvider?: {
    getDiff(options: { scope: string; stagedOnly?: boolean }): Promise<{ patch: string; scope: string }>;
  };
}>();
```

When `diffProvider` exists, use it instead of local `invoke("git_diff")`.

Update file and tree components to accept:

```ts
type TaskFileProvider = {
  listFiles(options: Record<string, unknown>): Promise<Array<{ path: string; isDir: boolean; size?: number }>>;
  readFile(path: string): Promise<{ path: string; text: string | null; binary: boolean; size: number }>;
};
```

- [ ] **Step 5: Wire App selected task providers**

In `App.vue`, derive providers from `selectedWorkspaceTask`:

```ts
const selectedTaskFileProvider = computed(() => {
  const task = selectedWorkspaceTask.value;
  if (!task || !task.capabilities.canOpenDiff) return null;
  return {
    getDiff: (options) => taskActions.getDiff(task, options),
    listFiles: (options) => taskActions.listFiles(task, options),
    readFile: (path) => taskActions.readFile(task, path),
  };
});
```

Pass `selectedTaskFileProvider` to diff, picker, preview, and tree components.

- [ ] **Step 6: Verify frontend tests pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/workspace/taskActions.test.ts src/App.test.ts
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/workspace/taskActions.ts apps/desktop/src/workspace/taskActions.test.ts apps/desktop/src/components/DiffModal.vue apps/desktop/src/components/FilePickerModal.vue apps/desktop/src/components/FilePreviewModal.vue apps/desktop/src/components/TreeExplorerModal.vue apps/desktop/src/App.vue apps/desktop/src/App.test.ts
git commit -m "feat: route diff and file browsing through task providers"
```

---

### Task 6: Add Remote Shell Session Creation

**Files:**
- Modify: `crates/kanna-server/src/http_api.rs`
- Modify: `crates/kanna-server/src/daemon_client.rs`
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `apps/desktop/src/workspace/taskActions.ts`
- Modify: `apps/desktop/src/components/ShellModal.vue`
- Modify: `apps/desktop/src/App.vue`
- Test: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write failing shell routing test**

Add to `apps/desktop/src/App.test.ts`:

```ts
function mountRemoteLanTask(input: {
  capabilities: Record<string, boolean>;
  terminalRef: { ownerDesktopId: string; ownerLocalTaskId: string; transport: "lan" };
}) {
  lanTasksMock.mockResolvedValue({
    repos: [{ id: "repo-1", path: "lan", name: "kanna", default_branch: "main" }],
    items: [remoteItem({ id: "lan:peer-owner:repo-1:task-remote", repo_id: "repo-1" })],
    terminalRefs: {
      "lan:peer-owner:repo-1:task-remote": {
        ...input.terminalRef,
        actions: input.capabilities,
      },
    },
  });
}

it("opens a remote shell for a reachable LAN workspace task", async () => {
  mountRemoteLanTask({
    capabilities: { openShell: true },
    terminalRef: {
      ownerDesktopId: "peer-owner",
      ownerLocalTaskId: "task-remote",
      transport: "lan",
    },
  });

  capturedKeyboardActions?.openShell();
  await flushPromises();

  expect(lanOpenShellMock).toHaveBeenCalledWith({
    desktopId: "peer-owner",
    taskId: "task-remote",
    cwd: "worktree",
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/App.test.ts -t "remote shell"
```

Expected: FAIL because `openShell` still checks local worktree state.

- [ ] **Step 3: Add owner server shell route**

In `crates/kanna-server/src/mobile_api.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateShellResponse {
    pub session_id: String,
}
```

In `crates/kanna-server/src/http_api.rs`, add:

```rust
async fn create_task_shell(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(task_id): axum::extract::Path<String>,
) -> Result<Json<crate::mobile_api::CreateShellResponse>, (axum::http::StatusCode, String)> {
    let session_id = format!("shell-wt-{task_id}");
    state.daemon.spawn_shell_for_task(&task_id, &session_id)
        .await
        .map_err(|message| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, message))?;
    Ok(Json(crate::mobile_api::CreateShellResponse { session_id }))
}
```

Register:

```rust
.route("/v1/tasks/{task_id}/shells", post(create_task_shell))
```

- [ ] **Step 4: Add frontend action and modal routing**

Add to `taskActions.ts`:

```ts
openShell(task: WorkspaceTask, cwd: "worktree" | "repoRoot") {
  const route = requireTaskRoute(task);
  if (route.kind === "local") return deps.local.openShell(route.taskId, cwd);
  return (route.kind === "lan" ? deps.lan : deps.cloud).openShell(route.desktopId, route.taskId, cwd);
}
```

In `App.vue`, replace the local-only `openShell` branch with:

```ts
if (workspaceTask) {
  if (!workspaceTask.capabilities.canOpenShell) {
    toast.error("Shell is not available for this task.");
    return;
  }
  void taskActions.openShell(workspaceTask, "worktree").catch((error) =>
    toast.error(error instanceof Error ? error.message : String(error)),
  );
  return;
}
```

- [ ] **Step 5: Verify shell tests pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/App.test.ts -t "remote shell"
cargo test --manifest-path crates/kanna-server/Cargo.toml create_task_shell -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/kanna-server/src/http_api.rs crates/kanna-server/src/daemon_client.rs crates/kanna-server/src/mobile_api.rs apps/desktop/src/workspace/taskActions.ts apps/desktop/src/components/ShellModal.vue apps/desktop/src/App.vue apps/desktop/src/App.test.ts
git commit -m "feat: open remote task shells through owner server"
```

---

### Task 7: Implement Remote IDE Review Snapshots

**Files:**
- Add: `crates/kanna-server/src/task_snapshot.rs`
- Modify: `crates/kanna-server/src/http_api.rs`
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/Cargo.toml`
- Add: `apps/desktop/src/workspace/remoteSnapshot.ts`
- Test: `apps/desktop/src/workspace/remoteSnapshot.test.ts`
- Modify: `apps/desktop/src/workspace/taskActions.ts`
- Modify: `apps/desktop/src/App.vue`
- Test: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write failing snapshot tests**

Create `apps/desktop/src/workspace/remoteSnapshot.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { openRemoteSnapshotInIde } from "./remoteSnapshot";

describe("openRemoteSnapshotInIde", () => {
  it("writes a marker file and opens the extracted snapshot directory", async () => {
    const deps = {
      appDataDir: "/tmp/kanna",
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      ensureDirectory: vi.fn(async () => {}),
      writeTextFile: vi.fn(async () => {}),
      unpackArchive: vi.fn(async () => {}),
      runScript: vi.fn(async () => {}),
      pruneSnapshots: vi.fn(async () => {}),
    };

    await openRemoteSnapshotInIde({
      ownerDesktopId: "peer-owner",
      taskId: "task-1",
      repoName: "kanna",
      branch: "task-1",
      archiveBytes: new Uint8Array([1, 2, 3]),
      ideCommand: "code",
    }, deps);

    expect(deps.writeTextFile).toHaveBeenCalledWith(
      expect.stringContaining("Kanna Remote Snapshot.md"),
      expect.stringContaining("edits in this directory do not affect the remote task"),
    );
    expect(deps.runScript).toHaveBeenCalledWith(expect.stringContaining('code "'));
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/workspace/remoteSnapshot.test.ts
```

Expected: FAIL because `remoteSnapshot.ts` does not exist.

- [ ] **Step 3: Add owner snapshot route**

In `crates/kanna-server/src/mobile_api.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSnapshotResponse {
    pub archive_base64: String,
    pub size_bytes: u64,
    pub repo_name: String,
    pub branch: String,
}
```

Create `crates/kanna-server/src/task_snapshot.rs` with:

```rust
pub const SNAPSHOT_PROMPT_BYTES: u64 = 250 * 1024 * 1024;
pub const SNAPSHOT_REFUSE_BYTES: u64 = 1024 * 1024 * 1024;

pub fn should_include_path(path: &str) -> bool {
    !path.starts_with(".git/")
        && !path.contains("/node_modules/")
        && !path.contains("/.build/")
        && !path.contains("/dist/")
        && !path.contains("/target/")
}
```

Implement archive creation using a gzipped tar stream and only vendored Cargo dependencies.

- [ ] **Step 4: Add local snapshot opener**

Create `apps/desktop/src/workspace/remoteSnapshot.ts`:

```ts
export interface RemoteSnapshotOpenOptions {
  ownerDesktopId: string;
  taskId: string;
  repoName: string;
  branch: string;
  archiveBytes: Uint8Array;
  ideCommand: string;
}

export async function openRemoteSnapshotInIde(
  options: RemoteSnapshotOpenOptions,
  deps: {
    appDataDir: string;
    now: () => Date;
    ensureDirectory(path: string): Promise<void>;
    writeTextFile(path: string, content: string): Promise<void>;
    unpackArchive(bytes: Uint8Array, destination: string): Promise<void>;
    runScript(script: string): Promise<void>;
    pruneSnapshots(root: string, keepLatest: number, maxAgeDays: number): Promise<void>;
  },
) {
  const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
  const root = `${deps.appDataDir}/Remote Workspaces/${options.ownerDesktopId}/${options.taskId}`;
  const destination = `${root}/${stamp}`;
  await deps.ensureDirectory(destination);
  await deps.unpackArchive(options.archiveBytes, destination);
  await deps.writeTextFile(
    `${destination}/Kanna Remote Snapshot.md`,
    [
      "# Kanna Remote Snapshot",
      "",
      `Source desktop: ${options.ownerDesktopId}`,
      `Task id: ${options.taskId}`,
      `Repository: ${options.repoName}`,
      `Branch: ${options.branch}`,
      `Snapshot time: ${deps.now().toISOString()}`,
      "",
      "Edits in this directory do not affect the remote task.",
      "Use Pull from Machine or task transfer for ownership and real local editing.",
      "",
    ].join("\n"),
  );
  await deps.pruneSnapshots(root, 5, 7);
  await deps.runScript(`${options.ideCommand} "${destination}"`);
}
```

- [ ] **Step 5: Wire remote `Cmd+O`**

In `taskActions.ts`, add:

```ts
openInIde(task: WorkspaceTask) {
  const route = requireTaskRoute(task);
  if (route.kind === "local") return deps.local.openInIde(route.taskId);
  return (route.kind === "lan" ? deps.lan : deps.cloud).createSnapshot(route.desktopId, route.taskId);
}
```

In `App.vue`, when `openInIDE` sees a remote `WorkspaceTask`, call `taskActions.openInIde(task)`, then `openRemoteSnapshotInIde()`.

- [ ] **Step 6: Verify tests pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/workspace/remoteSnapshot.test.ts src/App.test.ts -t "remote.*IDE|RemoteSnapshot"
cargo test --manifest-path crates/kanna-server/Cargo.toml snapshot -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/kanna-server/src/task_snapshot.rs crates/kanna-server/src/http_api.rs crates/kanna-server/src/mobile_api.rs crates/kanna-server/Cargo.toml apps/desktop/src/workspace/remoteSnapshot.ts apps/desktop/src/workspace/remoteSnapshot.test.ts apps/desktop/src/workspace/taskActions.ts apps/desktop/src/App.vue apps/desktop/src/App.test.ts
git commit -m "feat: open remote tasks as local IDE snapshots"
```

---

### Task 8: Convert Keyboard Shortcuts To Capability-Driven Providers

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Test: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src/composables/useShortcutContext.ts`
- Test: `apps/desktop/src/composables/useShortcutContext.test.ts`

- [ ] **Step 1: Write failing shortcut parity tests**

Add to `apps/desktop/src/App.test.ts`:

```ts
function mountReachableRemoteTaskWithCapabilities(capabilities: Record<string, boolean>) {
  lanTasksMock.mockResolvedValue({
    repos: [{ id: "repo-1", path: "lan", name: "kanna", default_branch: "main" }],
    items: [remoteItem({ id: "lan:peer-owner:repo-1:task-remote", repo_id: "repo-1" })],
    terminalRefs: {
      "lan:peer-owner:repo-1:task-remote": {
        ownerDesktopId: "peer-owner",
        ownerLocalTaskId: "task-remote",
        transport: "lan",
        actions: capabilities,
      },
    },
  });
}

it("uses remote providers for diff, file picker, shell, IDE, and stage shortcuts", async () => {
  mountReachableRemoteTaskWithCapabilities({
    diff: true,
    listFiles: true,
    readFile: true,
    openShell: true,
    ideSnapshot: true,
    advanceStage: true,
  });

  capturedKeyboardActions?.showDiff();
  capturedKeyboardActions?.openFile();
  capturedKeyboardActions?.openShell();
  await capturedKeyboardActions?.openInIDE();
  capturedKeyboardActions?.advanceStage();

  expect(remoteGetDiffMock).toHaveBeenCalled();
  expect(remoteListFilesMock).toHaveBeenCalled();
  expect(remoteOpenShellMock).toHaveBeenCalled();
  expect(remoteCreateSnapshotMock).toHaveBeenCalled();
  expect(remoteRunActionMock).toHaveBeenCalledWith(
    "peer-owner",
    "task-remote",
    "advance-stage",
    {},
  );
});
```

- [ ] **Step 2: Run test and confirm failure**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/App.test.ts -t "remote providers"
```

Expected: FAIL because several shortcuts still read `store.selectedRepo` or `store.currentItem`.

- [ ] **Step 3: Replace shortcut local checks with capability checks**

In `App.vue`, make each shortcut follow this pattern:

```ts
const workspaceTask = selectedWorkspaceTask.value;
if (workspaceTask) {
  if (!workspaceTask.capabilities.canOpenDiff) {
    toast.error("Diff is not available for this task.");
    return;
  }
  showDiffModal.value = true;
  return;
}
```

Apply equivalent capability checks for file picker, tree explorer, shell, IDE, and stage actions.

- [ ] **Step 4: Verify shortcut tests pass**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/App.test.ts src/composables/useShortcutContext.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.vue apps/desktop/src/App.test.ts apps/desktop/src/composables/useShortcutContext.ts apps/desktop/src/composables/useShortcutContext.test.ts
git commit -m "feat: make task shortcuts use workspace capabilities"
```

---

### Task 9: Add Integration And E2E Coverage

**Files:**
- Modify: `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`
- Modify: `apps/desktop/tests/e2e/mock/keyboard-shortcuts.test.ts`
- Modify: `crates/task-transfer/tests/runtime.rs`
- Modify: `crates/kanna-server/src/http_api.rs`

- [ ] **Step 1: Add LAN parity E2E assertions**

In `apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts`, add a test that:

```ts
async function seedTrustedLanRemoteTask(page, input) {
  await page.evaluate((task) => {
    window.__KANNA_TEST_REMOTE_TASK__ = task;
  }, input);
}

async function selectTask(page, taskId) {
  await page.getByTestId(`task-${taskId}`).click();
}

test("reachable LAN remote task supports diff, preview, shell, and IDE snapshot", async ({ page }) => {
  await seedTrustedLanRemoteTask(page, {
    taskId: "task-remote",
    files: { "src/example.ts": "export const value = 1;\n" },
    diff: "diff --git a/src/example.ts b/src/example.ts\n",
  });

  await selectTask(page, "task-remote");
  await page.keyboard.press("Meta+D");
  await expect(page.getByTestId("diff-modal")).toContainText("src/example.ts");

  await page.keyboard.press("Meta+P");
  await expect(page.getByTestId("file-picker")).toContainText("src/example.ts");

  await page.keyboard.press("Meta+J");
  await expect(page.getByTestId("shell-modal")).toBeVisible();

  await page.keyboard.press("Meta+O");
  await expect(page.getByTestId("toast")).toContainText("Opened remote snapshot");
});
```

- [ ] **Step 2: Add mock shortcut E2E assertions**

In `apps/desktop/tests/e2e/mock/keyboard-shortcuts.test.ts`, add a remote workspace fixture and assert that `Cmd+D`, `Cmd+P`, `Cmd+J`, `Cmd+O`, and `Cmd+S` do not fall back to a local task.

- [ ] **Step 3: Run E2E or document local blocker**

Run with a dev instance:

```bash
./kd dev up --seed
pnpm --dir apps/desktop test:e2e -- tests/e2e/mock/keyboard-shortcuts.test.ts
pnpm --dir apps/desktop test:e2e -- tests/e2e/real/local-transfer-task-sync.test.ts
```

Expected: PASS.

If a relay-backed cloud E2E cannot run locally, add a note to the PR summary:

```text
Cloud relay parity is covered by relay contract tests. Full cloud E2E requires a signed-in relay environment and is not available in this local worktree.
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/e2e/real/local-transfer-task-sync.test.ts apps/desktop/tests/e2e/mock/keyboard-shortcuts.test.ts crates/task-transfer/tests/runtime.rs crates/kanna-server/src/http_api.rs
git commit -m "test: cover remote task action parity"
```

---

### Task 10: Final Verification And Cleanup

**Files:**
- Review all changed files from previous tasks.

- [ ] **Step 1: Run frontend unit and type checks**

Run:

```bash
pnpm --dir apps/desktop exec vitest run src/App.test.ts src/workspace/buildWorkspace.test.ts src/workspace/taskActions.test.ts src/workspace/remoteSnapshot.test.ts src/services/desktopRelayTerminal.test.ts src/services/desktopLanTerminal.test.ts
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: PASS.

- [ ] **Step 2: Run Rust test suites**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml
cargo test --manifest-path crates/kanna-server/Cargo.toml
./kd build sidecars
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml transfer_sidecar_env_includes_stable_peer_id_and_display_name
```

Expected: PASS.

- [ ] **Step 3: Check diff hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows only intended files if final commits have not been made, and no output after final commits.

- [ ] **Step 4: Commit remaining scoped changes**

If `git status --short` shows scoped parity files, commit them:

```bash
git add apps/desktop crates docs
git commit -m "chore: finalize remote task parity wiring"
```

Run `git status --short` again.
Expected: no output.
