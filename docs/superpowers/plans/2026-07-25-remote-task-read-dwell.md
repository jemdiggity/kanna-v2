# Remote Task Read Dwell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark an unread remote desktop task read on its owner after the same one-second selection dwell used for local tasks.

**Architecture:** Add `markTaskRead` to the existing remote task action client, using the owner's HTTP route over relay and the task-transfer protocol over LAN. A focused Vue composable observes the remote presentation selection, applies the existing dwell and activity-age guards, and asks `useAppCloudWorkspace` to route the owner-side action without mutating synchronized snapshots locally.

**Tech Stack:** Vue 3, TypeScript, VueUse `watchDebounced`, Vitest, Tauri v2, Rust, Tokio, Serde.

---

## File Structure

- Create `apps/desktop/src/composables/useRemoteTaskReadDwell.ts` for the remote-only dwell rule.
- Create `apps/desktop/src/composables/useRemoteTaskReadDwell.test.ts` for timing and stale-activity regression coverage.
- Modify `apps/desktop/src/services/desktopRelayTerminal.ts` and its test to expose and verify relay mark-read.
- Modify `apps/desktop/src/services/desktopLanTerminal.ts` and its test to expose and verify LAN mark-read.
- Modify `apps/desktop/src/composables/useAppCloudWorkspace.ts` to connect the dwell watcher to the correct owner transport.
- Modify `apps/desktop/src/App.test.ts` so its remote client doubles implement the expanded client contract.
- Modify the task-transfer protocol, runtime, sidecar bridge, and Tauri command registration to carry LAN mark-read to the owner server.

### Task 1: Add mark-read to the desktop remote action clients

**Files:**
- Modify: `apps/desktop/src/services/desktopRelayTerminal.test.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.test.ts`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts`
- Modify: `apps/desktop/src/services/desktopLanTerminal.ts`

- [ ] **Step 1: Write failing relay and LAN client tests**

In `desktopRelayTerminal.test.ts`, extend the existing task-action test:

```ts
const markReadPromise = client.markTaskRead({
  desktopId: "desktop-owner",
  taskId: "task/read",
});

const markReadRequest = sent.find(
  (entry) => entry.path === "/v1/tasks/task%2Fread/actions/mark-read",
);
expect(markReadRequest).toMatchObject({
  type: "request",
  method: "POST",
  body: null,
});

socket.onmessage?.({
  data: JSON.stringify({
    type: "response",
    id: markReadRequest.id,
    status: 200,
    body: { taskId: "task/read", activity: "idle" },
  }),
});
await expect(markReadPromise).resolves.toBeUndefined();
```

In `desktopLanTerminal.test.ts`, invoke and assert the Tauri bridge:

```ts
await client.markTaskRead({
  desktopId: "peer-primary",
  taskId: "task-1",
});

expect(invoke).toHaveBeenCalledWith("mark_transfer_peer_task_read", {
  peerId: "peer-primary",
  taskId: "task-1",
});
```

- [ ] **Step 2: Run the client tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/services/desktopRelayTerminal.test.ts \
  src/services/desktopLanTerminal.test.ts
```

Expected: FAIL because `DesktopRelayTerminalClient` has no `markTaskRead` method.

- [ ] **Step 3: Add the minimal remote client method**

Add the method to `DesktopRelayTerminalClient`:

```ts
export interface DesktopRelayTerminalClient {
  close(): void;
  observeTerminal(options: ObserveDesktopRelayTerminalOptions): DesktopRelayTerminalSubscription;
  sendInput(options: SendRemoteTerminalInputOptions): Promise<void>;
  resize(options: ResizeRemoteTerminalOptions): Promise<void>;
  markTaskRead(options: RemoteTerminalActionOptions): Promise<void>;
  closeTask(options: RemoteTerminalActionOptions): Promise<void>;
  advanceStage(options: RemoteTerminalActionOptions): Promise<void>;
}
```

Add the relay implementation beside the existing task actions:

```ts
async markTaskRead(options) {
  await clientForDesktop(options.desktopId).request(
    "POST",
    `/v1/tasks/${encodeURIComponent(options.taskId)}/actions/mark-read`,
    null,
  );
},
```

Keep the legacy client object type-complete with the matching RPC action:

```ts
async markTaskRead(options) {
  await sendInvoke(options.desktopId, {
    command: "mark_task_read",
    args: { task_id: options.taskId },
  });
},
```

Add the LAN implementation:

```ts
async markTaskRead(options) {
  await invoke("mark_transfer_peer_task_read", {
    peerId: options.desktopId,
    taskId: options.taskId,
  });
},
```

- [ ] **Step 4: Run the client tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/services/desktopRelayTerminal.test.ts \
  src/services/desktopLanTerminal.test.ts
```

Expected: both test files PASS.

- [ ] **Step 5: Commit the remote client surface**

```bash
git add \
  apps/desktop/src/services/desktopRelayTerminal.ts \
  apps/desktop/src/services/desktopRelayTerminal.test.ts \
  apps/desktop/src/services/desktopLanTerminal.ts \
  apps/desktop/src/services/desktopLanTerminal.test.ts
git commit -m "feat(desktop): route remote task mark-read actions"
```

### Task 2: Forward LAN mark-read to the owner server

**Files:**
- Modify: `crates/task-transfer/tests/protocol.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/daemon.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing LAN protocol and owner-routing tests**

Add this protocol test:

```rs
#[test]
fn remote_task_mark_read_messages_use_expected_wire_names() {
    let control_request = ControlRequest::MarkPeerTaskRead {
        request_id: "req-mark-read-control".into(),
        target_peer_id: "peer-owner".into(),
        task_id: "task-owner".into(),
    };
    assert_eq!(
        serde_json::to_value(&control_request).unwrap(),
        json!({
            "type": "mark_peer_task_read",
            "request_id": "req-mark-read-control",
            "target_peer_id": "peer-owner",
            "task_id": "task-owner",
        })
    );
    assert_roundtrip(control_request);
    assert_roundtrip(ControlResponse::MarkPeerTaskRead {
        request_id: "req-mark-read-control".into(),
    });

    let peer_request = PeerRequest::MarkTaskRead {
        request_id: "req-mark-read-peer".into(),
        requester_peer_id: "peer-secondary".into(),
        task_id: "task-owner".into(),
    };
    assert_eq!(
        serde_json::to_value(&peer_request).unwrap(),
        json!({
            "type": "mark_task_read",
            "request_id": "req-mark-read-peer",
            "requester_peer_id": "peer-secondary",
            "task_id": "task-owner",
        })
    );
    assert_roundtrip(peer_request);
    assert_roundtrip(PeerResponse::MarkTaskRead {
        request_id: "req-mark-read-peer".into(),
    });
}
```

In `crates/task-transfer/tests/runtime.rs`, add a test following
`trusted_peer_advance_stage_posts_to_owner_kanna_server`:

```rs
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trusted_peer_mark_read_posts_to_owner_kanna_server() {
    let temp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (request_tx, request_rx) = oneshot::channel();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).await.unwrap();
        let mut content_length = 0usize;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).await.unwrap();
            if header == "\r\n" {
                break;
            }
            if let Some(value) = header.strip_prefix("Content-Length:") {
                content_length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; content_length];
        reader.read_exact(&mut body).await.unwrap();
        request_tx
            .send((request_line, String::from_utf8(body).unwrap()))
            .unwrap();
        reader.get_mut().write_all(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        ).await.unwrap();
    });

    let owner = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-owner", "Owner", temp.path(), 0)
            .with_kanna_server_port(port),
    ).await.unwrap();
    let secondary = TransferRuntime::spawn(
        RuntimeConfig::for_tests("peer-secondary", "Secondary", temp.path(), 0),
    ).await.unwrap();
    pair_peers(&secondary, &owner, "peer-owner").await;

    secondary
        .mark_peer_task_read("peer-owner", "owner-task-1")
        .await
        .unwrap();

    let (request_line, body) = request_rx.await.unwrap();
    assert_eq!(
        request_line,
        "POST /v1/tasks/owner-task-1/actions/mark-read HTTP/1.1\r\n"
    );
    assert_eq!(body, "{}");
    server.await.unwrap();
}
```

- [ ] **Step 2: Run both LAN tests and verify RED**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml \
  --test protocol remote_task_mark_read_messages_use_expected_wire_names -- --exact
cargo test --manifest-path crates/task-transfer/Cargo.toml \
  --test runtime trusted_peer_mark_read_posts_to_owner_kanna_server -- --exact
```

Expected: compilation FAIL because the protocol variants and
`mark_peer_task_read` method do not exist.

- [ ] **Step 3: Add the mark-read protocol variants and control dispatch**

Add these variants in `protocol.rs`:

```rs
// ControlRequest
MarkPeerTaskRead {
    request_id: String,
    target_peer_id: String,
    task_id: String,
},

// ControlResponse
MarkPeerTaskRead {
    request_id: String,
},

// PeerRequest
MarkTaskRead {
    request_id: String,
    requester_peer_id: String,
    task_id: String,
},

// PeerResponse
MarkTaskRead {
    request_id: String,
},
```

Add the control dispatch in `crates/task-transfer/src/main.rs`:

```rs
ControlRequest::MarkPeerTaskRead {
    request_id,
    target_peer_id,
    task_id,
} => match runtime.mark_peer_task_read(&target_peer_id, &task_id).await {
    Ok(()) => ControlResponse::MarkPeerTaskRead { request_id },
    Err(error) => control_error(request_id, error),
},
```

- [ ] **Step 4: Add the runtime forwarding method and owner action**

Add `TransferRuntime::mark_peer_task_read` beside the other task actions:

```rs
pub async fn mark_peer_task_read(
    &self,
    target_peer_id: &str,
    task_id: &str,
) -> Result<(), RuntimeError> {
    let target_peer = self.find_peer(target_peer_id).await?;
    self.ensure_peer_is_trusted(&target_peer.peer_id, &target_peer.public_key)?;
    let request_id = self.next_request_id("mark-read");
    let response = self
        .send_peer_request(
            &target_peer,
            PeerRequest::MarkTaskRead {
                request_id: request_id.clone(),
                requester_peer_id: self.config.peer_id.clone(),
                task_id: task_id.to_owned(),
            },
        )
        .await?;
    match response {
        PeerResponse::MarkTaskRead {
            request_id: response_request_id,
        } if response_request_id == request_id => Ok(()),
        PeerResponse::Error { message, .. } => Err(RuntimeError::Protocol(message)),
        other => Err(unexpected_peer_response("mark-read", &other)),
    }
}
```

In `runtime/daemon.rs`, reuse the existing authenticated owner action helper:

```rs
pub(super) async fn mark_owner_task_read(
    context: &ListenerContext,
    requester_peer_id: &str,
    task_id: &str,
) -> Result<(), RuntimeError> {
    ensure_requester_peer_trusted(context, requester_peer_id).await?;
    let port = context
        .kanna_server_port
        .ok_or_else(|| RuntimeError::Protocol("Kanna server port is not configured".into()))?;
    post_local_kanna_task_action(port, task_id, "mark-read").await
}
```

Import and dispatch it in `runtime/listener.rs`:

```rs
Ok(PeerRequest::MarkTaskRead {
    request_id,
    requester_peer_id,
    task_id,
}) => match mark_owner_task_read(&context, &requester_peer_id, &task_id).await {
    Ok(()) => PeerResponse::MarkTaskRead { request_id },
    Err(error) => PeerResponse::Error {
        request_id,
        message: error.to_string(),
    },
},
```

- [ ] **Step 5: Run both LAN tests and verify GREEN**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml \
  --test protocol remote_task_mark_read_messages_use_expected_wire_names -- --exact
cargo test --manifest-path crates/task-transfer/Cargo.toml \
  --test runtime trusted_peer_mark_read_posts_to_owner_kanna_server -- --exact
```

Expected: both tests PASS, proving the wire contract and owner HTTP route.

- [ ] **Step 6: Add the sidecar and Tauri bridge**

Add `TransferSidecarClient::mark_peer_task_read`:

```rs
pub async fn mark_peer_task_read(
    &mut self,
    peer_id: String,
    task_id: String,
) -> Result<Value, String> {
    let request_id = self.next_request_id("mark-read");
    self.send_request(
        json!({
            "type": "mark_peer_task_read",
            "request_id": request_id,
            "target_peer_id": peer_id,
            "task_id": task_id,
        }),
        &request_id,
    )
    .await
}
```

Add the Tauri command in `commands/transfer.rs`:

```rs
#[tauri::command]
pub async fn mark_transfer_peer_task_read(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    peer_id: String,
    task_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let (result, dead) = {
        let client = guard
            .as_mut()
            .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
        let result = client.mark_peer_task_read(peer_id, task_id).await;
        (result, client.is_dead())
    };
    if dead {
        *guard = None;
    }
    result
}
```

Register it in the Tauri invoke handler in `apps/desktop/src-tauri/src/lib.rs`:

```rs
commands::transfer::mark_transfer_peer_task_read,
```

- [ ] **Step 7: Compile-check the full LAN bridge**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: all task-transfer tests PASS and the Tauri crate finishes successfully.

- [ ] **Step 8: Commit the LAN forwarding path**

```bash
git add \
  crates/task-transfer/src/protocol.rs \
  crates/task-transfer/src/runtime/lifecycle.rs \
  crates/task-transfer/src/runtime/listener.rs \
  crates/task-transfer/src/runtime/daemon.rs \
  crates/task-transfer/src/main.rs \
  crates/task-transfer/tests/protocol.rs \
  crates/task-transfer/tests/runtime.rs \
  apps/desktop/src-tauri/src/transfer_sidecar.rs \
  apps/desktop/src-tauri/src/commands/transfer.rs \
  apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(transfer): forward remote task mark-read"
```

### Task 3: Apply the one-second dwell rule to remote selections

**Files:**
- Create: `apps/desktop/src/composables/useRemoteTaskReadDwell.ts`
- Create: `apps/desktop/src/composables/useRemoteTaskReadDwell.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/App.test.ts`

- [ ] **Step 1: Write the failing dwell regression tests**

Create `useRemoteTaskReadDwell.test.ts` with a real reactive task map:

```ts
import { computed, effectScope, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTask } from "../workspace/types";
import { useRemoteTaskReadDwell } from "./useRemoteTaskReadDwell";

function remoteTask(activityChangedAt = "2026-07-25T00:00:00.000Z"): WorkspaceTask {
  return {
    id: "workspace-task",
    logicalTaskKey: "logical-task",
    localTaskId: null,
    remoteTaskIds: ["cloud-task"],
    repoKey: "cloud:repo",
    item: {
      id: "cloud-task",
      activity: "unread",
      activity_changed_at: activityChangedAt,
    },
    owner: { kind: "remote", id: "desktop-owner" },
    terminal: {
      kind: "cloud",
      remoteRef: {
        ownerDesktopId: "desktop-owner",
        ownerLocalTaskId: "owner-task",
      },
    },
  } as WorkspaceTask;
}

describe("useRemoteTaskReadDwell", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks an unread remote task read after one second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const selectedItemId = ref<string | null>(null);
    const task = remoteTask();
    const tasks = computed(() => new Map([["slot:remote", task]]));
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();
    scope.run(() => useRemoteTaskReadDwell({
      selectedItemId,
      workspaceTasksByItemId: tasks,
      markTaskRead,
    }));

    selectedItemId.value = "slot:remote";
    await vi.advanceTimersByTimeAsync(1000);

    expect(markTaskRead).toHaveBeenCalledWith(task);
    scope.stop();
  });

  it("cancels mark-read when selection changes before one second", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const selectedItemId = ref<string | null>(null);
    const tasks = computed(() => new Map([["slot:remote", remoteTask()]]));
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();
    scope.run(() => useRemoteTaskReadDwell({
      selectedItemId,
      workspaceTasksByItemId: tasks,
      markTaskRead,
    }));

    selectedItemId.value = "slot:remote";
    await vi.advanceTimersByTimeAsync(999);
    selectedItemId.value = null;
    await vi.advanceTimersByTimeAsync(1000);

    expect(markTaskRead).not.toHaveBeenCalled();
    scope.stop();
  });

  it("does not overwrite activity newer than the selection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T01:00:00.000Z"));
    const selectedItemId = ref<string | null>(null);
    const task = remoteTask("2026-07-25T01:00:00.500Z");
    const tasks = computed(() => new Map([["slot:remote", task]]));
    const markTaskRead = vi.fn(async () => {});
    const scope = effectScope();
    scope.run(() => useRemoteTaskReadDwell({
      selectedItemId,
      workspaceTasksByItemId: tasks,
      markTaskRead,
    }));

    selectedItemId.value = "slot:remote";
    await vi.advanceTimersByTimeAsync(1000);

    expect(markTaskRead).not.toHaveBeenCalled();
    scope.stop();
  });
});
```

- [ ] **Step 2: Run the dwell test and verify RED**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/composables/useRemoteTaskReadDwell.test.ts
```

Expected: FAIL because `useRemoteTaskReadDwell.ts` does not exist.

- [ ] **Step 3: Implement the minimal dwell composable**

Create `useRemoteTaskReadDwell.ts`:

```ts
import { watchDebounced } from "@vueuse/core";
import type { ComputedRef, Ref } from "vue";
import type { WorkspaceTask } from "../workspace/types";

interface UseRemoteTaskReadDwellOptions {
  selectedItemId: Ref<string | null>;
  workspaceTasksByItemId: ComputedRef<Map<string, WorkspaceTask>>;
  markTaskRead: (task: WorkspaceTask) => Promise<void>;
}

export function useRemoteTaskReadDwell({
  selectedItemId,
  workspaceTasksByItemId,
  markTaskRead,
}: UseRemoteTaskReadDwellOptions): void {
  watchDebounced(
    selectedItemId,
    async (itemId) => {
      if (!itemId) return;
      const selectionTime = Date.now() - 1000;
      const task = workspaceTasksByItemId.value.get(itemId);
      if (!task || task.owner.kind === "local" || task.item.activity !== "unread") return;
      if (
        task.item.activity_changed_at
        && new Date(task.item.activity_changed_at).getTime() > selectionTime
      ) {
        return;
      }
      await markTaskRead(task);
    },
    { debounce: 1000 },
  );
}
```

- [ ] **Step 4: Run the dwell tests and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/composables/useRemoteTaskReadDwell.test.ts
```

Expected: all three tests PASS.

- [ ] **Step 5: Wire the dwell action to the owner transport**

Import and register the composable in `useAppCloudWorkspace.ts` after
`selectedWorkspaceTask` is created. Derive the watched ID from both explicit
cloud selection and restored workspace selection:

```ts
const selectedRemoteItemId = computed(() =>
  selectedWorkspaceTask.value?.owner.kind === "remote"
    ? selectedCloudItemId.value ?? store.selectedItemId
    : null,
);

useRemoteTaskReadDwell({
  selectedItemId: selectedRemoteItemId,
  workspaceTasksByItemId,
  markTaskRead: markRemoteWorkspaceTaskRead,
});
```

Add the remote action function:

```ts
async function markRemoteWorkspaceTaskRead(workspaceTask: WorkspaceTask): Promise<void> {
  const remoteRef = workspaceTask.terminal.remoteRef;
  if (!remoteRef || workspaceTask.terminal.kind === "none") return;
  const client = workspaceTask.terminal.kind === "lan"
    ? await createConfiguredDesktopLanTerminalClient()
    : await createConfiguredDesktopRelayTerminalClient();
  if (!client) {
    console.warn("[App] remote task owner is unavailable for mark-read");
    return;
  }

  try {
    await client.markTaskRead({
      desktopId: remoteRef.ownerDesktopId,
      taskId: remoteRef.ownerLocalTaskId,
    });
  } catch (error) {
    console.warn("[App] failed to mark remote task read:", error);
  } finally {
    client.close();
  }
}
```

Add `markTaskRead: vi.fn(async () => {})` to each existing remote client mock
in `App.test.ts`, preserving its shared close and advance spies:

```ts
createConfiguredDesktopRelayTerminalClient: vi.fn(async () => ({
  advanceStage: relayAdvanceStageMock,
  closeTask: relayCloseTaskMock,
  close: relayCloseMock,
  markTaskRead: vi.fn(async () => {}),
})),
```

Apply the same added property to the existing LAN client mock.

- [ ] **Step 6: Run focused desktop tests and typecheck**

Run:

```bash
pnpm --dir apps/desktop exec vitest run --maxWorkers=2 \
  src/composables/useRemoteTaskReadDwell.test.ts \
  src/services/desktopRelayTerminal.test.ts \
  src/services/desktopLanTerminal.test.ts \
  src/App.test.ts
pnpm --dir apps/desktop exec vue-tsc --noEmit
```

Expected: all tests PASS and typecheck exits successfully.

- [ ] **Step 7: Commit the dwell behavior**

```bash
git add \
  apps/desktop/src/composables/useRemoteTaskReadDwell.ts \
  apps/desktop/src/composables/useRemoteTaskReadDwell.test.ts \
  apps/desktop/src/composables/useAppCloudWorkspace.ts \
  apps/desktop/src/App.test.ts
git commit -m "fix(desktop): mark remote tasks read after dwell"
```

### Task 4: Verify the integrated change

**Files:**
- Verify only; no planned file changes.

- [ ] **Step 1: Run formatting and diff checks**

Run:

```bash
cargo fmt --all -- --check
git diff --check HEAD~3
```

Expected: both commands exit successfully with no formatting or whitespace errors.

- [ ] **Step 2: Run canonical TypeScript verification**

Run:

```bash
pnpm test
```

Expected: all repository TypeScript tests PASS.

- [ ] **Step 3: Run canonical Rust verification**

Run:

```bash
./kd test rust
```

Expected: all canonical Rust tests PASS.

- [ ] **Step 4: Inspect final scope**

Run:

```bash
git status --short
git log --oneline --decorate -4
git diff --stat HEAD~3
```

Expected: the worktree is clean, the three implementation commits follow the
design commit, and the diff is limited to the remote read-dwell files described
above.

## 2026-07-25 Revision: Owner Activity-Revision CAS

Review found that the original activity timestamp cutoff was unsafe across
machines and could not distinguish multiple transitions within SQLite's
one-second timestamp resolution. Preserve the transport and dwell structure
above, but replace the timestamp guard with an owner-issued monotonic revision:

- add durable `pipeline_item.activity_revision INTEGER NOT NULL DEFAULT 0` in
  migration `029_pipeline_item_activity_revision`;
- increment the revision atomically whenever production code changes activity;
- publish optional `activityRevision` through cloud and LAN snapshots so older
  snapshots remain readable, while missing or invalid revisions disable remote
  automatic mark-read;
- synchronously capture the exact unread revision when selection begins, then
  require the same selection, unread activity, and revision after the dwell;
- send `expectedActivityRevision` through relay and the sealed LAN payload; and
- make the owner update conditional on exact revision and unread state,
  incrementing the revision in the successful update so delayed and replayed
  requests are harmless.

Verification must cover same-second transitions, delayed/replayed requests,
restored selection, missing revisions, cloud/LAN projection, legacy empty-body
owner calls, and forged sealed callers in addition to the original plan's
transport and cancellation coverage.
