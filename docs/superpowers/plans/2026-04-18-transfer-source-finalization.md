# Transfer Source Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finalize LAN transfers only after destination approval by stopping the source agent, refreshing transferable session state, and returning the freshest payload before import.

**Architecture:** Extend the task-transfer protocol with a destination-triggered `finalize_outgoing_transfer` round-trip. The source runtime will emit a sidecar event and wait for the desktop store to perform source-local finalization, then return the refreshed payload to the destination so import can proceed with the best available session metadata.

**Tech Stack:** Rust, Tauri v2, Vue 3, Pinia, Vitest, cargo tests, serde_json

---

### Task 1: Add The Finalization Handshake To The Transfer Protocol

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Test: `crates/task-transfer/tests/protocol.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [ ] **Step 1: Write the failing protocol and runtime tests**

Add protocol coverage for the new control request, peer request, peer response, and sidecar event:

```rust
assert_roundtrip(ControlRequest::FinalizeOutgoingTransfer {
    request_id: "req-finalize".into(),
    transfer_id: "transfer-1".into(),
});

assert_roundtrip(ControlRequest::CompleteOutgoingTransferFinalization {
    request_id: "req-complete-finalize".into(),
    transfer_id: "transfer-1".into(),
    payload: Some(json!({
        "task": { "source_task_id": "task-source" }
    })),
    finalized_cleanly: true,
    error: None,
});

assert_roundtrip(PeerRequest::FinalizeTransfer {
    request_id: "req-peer-finalize".into(),
    transfer_id: "transfer-1".into(),
    requester_peer_id: "peer-destination".into(),
});

assert_roundtrip(PeerResponse::FinalizeTransfer {
    request_id: "req-peer-finalize".into(),
    transfer_id: "transfer-1".into(),
    payload: json!({ "task": { "source_task_id": "task-source" } }),
    finalized_cleanly: false,
});

assert_roundtrip(SidecarEvent::OutgoingTransferFinalizationRequested {
    transfer_id: "transfer-1".into(),
});
```

Add a runtime test that proves the source peer blocks for desktop finalization and the destination receives the refreshed payload:

```rust
let preflight = primary
    .prepare_transfer_preflight("peer-secondary", "task-source")
    .await
    .unwrap();

primary
    .prepare_transfer_commit(
        &preflight.transfer_id,
        json!({
            "target_peer_id": "peer-secondary",
            "task": { "source_task_id": "task-source" }
        }),
    )
    .await
    .unwrap();

let finalize = secondary.finalize_outgoing_transfer(&preflight.transfer_id);
let event = primary.next_event().await.unwrap();
let RuntimeEvent::OutgoingTransferFinalizationRequested(event) = event else {
    panic!("expected finalization request event");
};
assert_eq!(event.transfer_id, preflight.transfer_id);

primary
    .complete_outgoing_transfer_finalization(
        &preflight.transfer_id,
        Ok(FinalizedOutgoingTransfer {
            payload: json!({
                "task": {
                    "source_task_id": "task-source",
                    "resume_session_id": "019d-final",
                }
            }),
            finalized_cleanly: true,
        }),
    )
    .await
    .unwrap();

let finalized = finalize.await.unwrap();
assert_eq!(
    finalized.payload["task"]["resume_session_id"],
    json!("019d-final")
);
assert!(finalized.finalized_cleanly);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd crates/task-transfer && cargo test --test protocol --test runtime
```

Expected: FAIL because the finalize protocol variants and runtime methods do not exist yet.

- [ ] **Step 3: Write the minimal runtime implementation**

In `crates/task-transfer/src/protocol.rs`, add the new variants:

```rust
ControlRequest::FinalizeOutgoingTransfer {
    request_id: String,
    transfer_id: String,
}

ControlRequest::CompleteOutgoingTransferFinalization {
    request_id: String,
    transfer_id: String,
    payload: Option<serde_json::Value>,
    finalized_cleanly: bool,
    error: Option<String>,
}

PeerRequest::FinalizeTransfer {
    request_id: String,
    transfer_id: String,
    requester_peer_id: String,
}

PeerResponse::FinalizeTransfer {
    request_id: String,
    transfer_id: String,
    payload: serde_json::Value,
    finalized_cleanly: bool,
}

SidecarEvent::OutgoingTransferFinalizationRequested {
    transfer_id: String,
}
```

In `crates/task-transfer/src/runtime.rs`, add:

```rust
pub struct FinalizedOutgoingTransfer {
    pub payload: Value,
    pub finalized_cleanly: bool,
}

pub struct OutgoingTransferFinalizationRequestedEvent {
    pub transfer_id: String,
}

pub enum RuntimeEvent {
    PairingCompleted(PairingCompletedEvent),
    IncomingTransferRequest(IncomingTransferEvent),
    OutgoingTransferCommitted(OutgoingTransferCommittedEvent),
    OutgoingTransferFinalizationRequested(OutgoingTransferFinalizationRequestedEvent),
}
```

Extend runtime state with a pending finalization map and implement:

```rust
pub async fn finalize_outgoing_transfer(
    &self,
    transfer_id: &str,
) -> Result<FinalizedOutgoingTransfer, RuntimeError> { /* send PeerRequest::FinalizeTransfer */ }

pub async fn complete_outgoing_transfer_finalization(
    &self,
    transfer_id: &str,
    result: Result<FinalizedOutgoingTransfer, RuntimeError>,
) -> Result<(), RuntimeError> { /* resolve pending request */ }
```

In `handle_connection`, validate the requester against the reserved target peer, emit `RuntimeEvent::OutgoingTransferFinalizationRequested`, wait for the desktop-completed result, and answer with `PeerResponse::FinalizeTransfer`.

In `crates/task-transfer/src/main.rs`, wire:

```rust
ControlRequest::FinalizeOutgoingTransfer { request_id, transfer_id } => {
    match runtime.finalize_outgoing_transfer(&transfer_id).await {
        Ok(result) => ControlResponse::FinalizeOutgoingTransfer {
            request_id,
            transfer_id,
            payload: result.payload,
            finalized_cleanly: result.finalized_cleanly,
        },
        Err(error) => control_error(request_id, error),
    }
}

ControlRequest::CompleteOutgoingTransferFinalization {
    request_id,
    transfer_id,
    payload,
    finalized_cleanly,
    error,
} => match runtime
    .complete_outgoing_transfer_finalization(
        &transfer_id,
        match error {
            Some(message) => Err(RuntimeError::Protocol(message)),
            None => Ok(FinalizedOutgoingTransfer {
                payload: payload.ok_or_else(|| RuntimeError::Protocol("missing finalized payload".into()))?,
                finalized_cleanly,
            }),
        },
    )
    .await
{
    Ok(()) => ControlResponse::AcknowledgeImportCommitted { request_id, transfer_id },
    Err(error) => control_error(request_id, error),
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd crates/task-transfer && cargo test --test protocol --test runtime
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add crates/task-transfer/src/protocol.rs crates/task-transfer/src/runtime.rs crates/task-transfer/src/main.rs crates/task-transfer/tests/protocol.rs crates/task-transfer/tests/runtime.rs
git commit -m "Add transfer source finalization handshake"
```

### Task 2: Bridge The New Handshake Through The Tauri Sidecar Client

**Files:**
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/src-tauri/src/transfer_sidecar.rs`

- [ ] **Step 1: Write the failing sidecar tests**

Add response-parsing coverage for the new finalize command:

```rust
#[test]
fn finalize_outgoing_transfer_response_requires_payload() {
    let response = json!({
        "transferId": "transfer-1",
        "finalizedCleanly": true
    });
    let error = parse_finalize_outgoing_transfer_response(&response).unwrap_err();
    assert!(error.contains("payload"));
}
```

Add event-routing coverage for the new sidecar event:

```rust
#[test]
fn finalization_request_events_emit_expected_tauri_topic() {
    let value = json!({
        "type": "outgoing_transfer_finalization_requested",
        "transfer_id": "transfer-1",
    });
    assert_eq!(
        forwarded_event_name(&value),
        Some("outgoing-transfer-finalization-requested")
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd apps/desktop/src-tauri && cargo test transfer_sidecar --lib
```

Expected: FAIL because the finalize request helpers do not exist.

- [ ] **Step 3: Write the minimal Tauri bridge**

In `apps/desktop/src-tauri/src/transfer_sidecar.rs`, add:

```rust
pub async fn finalize_outgoing_transfer(
    &mut self,
    transfer_id: String,
) -> Result<Value, String> {
    let request_id = self.next_request_id("finalize");
    let response = self
        .send_request(
            json!({
                "type": "finalize_outgoing_transfer",
                "request_id": request_id,
                "transfer_id": transfer_id,
            }),
            &request_id,
        )
        .await?;

    Ok(json!({
        "transferId": required_string(&response, &["transfer_id", "transferId"])?,
        "payload": response.get("payload").cloned().ok_or_else(|| "finalize_outgoing_transfer response missing payload".to_string())?,
        "finalizedCleanly": required_bool(&response, &["finalized_cleanly", "finalizedCleanly"])?,
    }))
}
```

Add the source-side completion callback:

```rust
pub async fn complete_outgoing_transfer_finalization(
    &mut self,
    transfer_id: String,
    payload: Option<Value>,
    finalized_cleanly: bool,
    error: Option<String>,
) -> Result<Value, String> {
    let request_id = self.next_request_id("complete-finalize");
    self
        .send_request(
            json!({
                "type": "complete_outgoing_transfer_finalization",
                "request_id": request_id,
                "transfer_id": transfer_id,
                "payload": payload,
                "finalized_cleanly": finalized_cleanly,
                "error": error,
            }),
            &request_id,
        )
        .await
}
```

Route the event in `spawn_reader`:

```rust
if value.get("type").and_then(Value::as_str) == Some("outgoing_transfer_finalization_requested") {
    let _ = app.emit("outgoing-transfer-finalization-requested", &value);
    continue;
}
```

Expose a Tauri command in `apps/desktop/src-tauri/src/commands/transfer.rs`:

```rust
#[tauri::command]
pub async fn finalize_outgoing_transfer(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let client = guard
        .as_mut()
        .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
    client.finalize_outgoing_transfer(transfer_id).await
}
```

Also expose:

```rust
#[tauri::command]
pub async fn complete_outgoing_transfer_finalization(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::TransferServiceState>,
    transfer_id: String,
    payload: Option<Value>,
    finalized_cleanly: bool,
    error: Option<String>,
) -> Result<Value, String> {
    let mut guard = state.lock().await;
    ensure_client(&app, &mut guard).await?;
    let client = guard
        .as_mut()
        .ok_or_else(|| "transfer sidecar client unavailable".to_string())?;
    client
        .complete_outgoing_transfer_finalization(
            transfer_id,
            payload,
            finalized_cleanly,
            error,
        )
        .await
}
```

Register the command in `apps/desktop/src-tauri/src/lib.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd apps/desktop/src-tauri && cargo test transfer_sidecar --lib
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/transfer_sidecar.rs apps/desktop/src-tauri/src/commands/transfer.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "Bridge transfer finalization through Tauri sidecar"
```

### Task 3: Finalize The Source Task In The Desktop Store Before Import

**Files:**
- Modify: `apps/desktop/src/stores/kanna.ts`
- Modify: `apps/desktop/src/utils/taskTransfer.ts`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src/stores/kannaTransfer.test.ts`
- Modify: `apps/desktop/src/tauri-mock.ts`

- [ ] **Step 1: Write the failing store and app tests**

Add a store test proving approval finalizes the source before import:

```ts
it("requests source finalization before importing an approved transfer", async () => {
  invokeMock.mockImplementation(async (cmd) => {
    if (cmd === "finalize_outgoing_transfer") {
      return {
        transferId: "transfer-123",
        payload: {
          target_peer_id: "peer-target",
          task: {
            source_peer_id: "peer-source",
            source_task_id: "task-source",
            resume_session_id: "019d-final",
            agent_provider: "codex",
            stage: "in progress",
            workflow: "default",
          },
          repo: { mode: "reuse-local", remote_url: null, path: "/tmp/repo-1", name: "repo-1", default_branch: "main", bundle: null },
          recovery: null,
          artifacts: [],
        },
        finalizedCleanly: true,
      };
    }
    return null;
  });

  await store.approveIncomingTransfer("transfer-123");

  expect(invokeMock).toHaveBeenCalledWith("finalize_outgoing_transfer", {
    transferId: "transfer-123",
  });
});
```

Add a store test proving rejection does not finalize:

```ts
it("does not finalize the source when an incoming transfer is rejected", async () => {
  await store.rejectIncomingTransfer("transfer-123");
  expect(invokeMock).not.toHaveBeenCalledWith("finalize_outgoing_transfer", expect.anything());
});
```

Add a store test for bounded best-effort finalization on the source:

```ts
it("best-effort finalizes a codex source transfer after signaling the session", async () => {
  vi.useFakeTimers();
  invokeMock.mockImplementation(async (cmd) => {
    if (cmd === "signal_session") return null;
    if (cmd === "stage_transfer_artifact") return { transferId: "transfer-123", artifactId: "transfer-123-codex-rollout" };
    return null;
  });

  const finalizePromise = store.finalizeOutgoingTransfer("transfer-123");
  await vi.advanceTimersByTimeAsync(1500);
  const result = await finalizePromise;

  expect(invokeMock).toHaveBeenCalledWith("signal_session", {
    sessionId: "task-source",
    signal: "SIGINT",
  });
  expect(result.transferId).toBe("transfer-123");
});
```

Add an app test proving the new sidecar event is forwarded:

```ts
it("forwards outgoing transfer finalization requests to the store", async () => {
  const handler = listenHandlers.get("outgoing-transfer-finalization-requested");
  await handler?.({
    type: "outgoing_transfer_finalization_requested",
    transfer_id: "transfer-1",
  });
  expect(store.finalizeOutgoingTransfer).toHaveBeenCalledWith("transfer-1");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd apps/desktop && pnpm exec vitest run src/stores/kannaTransfer.test.ts src/App.test.ts
```

Expected: FAIL because approval imports directly and there is no source finalization path.

- [ ] **Step 3: Write the minimal desktop implementation**

In `apps/desktop/src/utils/taskTransfer.ts`, add parsers:

```ts
export interface FinalizedOutgoingTransferResult {
  transferId: string;
  payload: OutgoingTransferPayload;
  finalizedCleanly: boolean;
}

export function parseFinalizedOutgoingTransferResult(value: unknown): FinalizedOutgoingTransferResult {
  const record = asRecord(value);
  if (!record) throw new Error("finalize_outgoing_transfer returned an invalid payload");
  return {
    transferId: readRequiredString(record, ["transferId", "transfer_id"], "finalize_outgoing_transfer response missing transfer id"),
    payload: parsePersistedOutgoingTransferPayload(record.payload),
    finalizedCleanly: readRequiredBoolean(record, ["finalizedCleanly", "finalized_cleanly"], "finalize_outgoing_transfer response missing finalized flag"),
  };
}
```

In `apps/desktop/src/stores/kanna.ts`, add:

```ts
const TRANSFER_SOURCE_FINALIZATION_WAIT_MS = 1500;

async function waitForSessionExitWithin(sessionId: string, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    waitForSessionExit(sessionId).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
```

Add a source-side finalizer:

```ts
async function finalizeOutgoingTransfer(transferId: string): Promise<FinalizedOutgoingTransferResult> {
  const transfer = await getTaskTransfer(_db, transferId);
  if (!transfer || transfer.direction !== "outgoing") {
    throw new Error(`outgoing transfer not found: ${transferId}`);
  }

  const item = items.value.find((candidate) => candidate.id === transfer.local_task_id);
  const repo = item ? repos.value.find((candidate) => candidate.id === item.repo_id) : null;
  if (!item || !repo) {
    throw new Error(`source task missing for outgoing transfer: ${transferId}`);
  }

  await invoke("signal_session", { sessionId: item.id, signal: "SIGINT" }).catch((error: unknown) =>
    console.error("[store] transfer finalization signal failed:", error)
  );
  const exited = await waitForSessionExitWithin(item.id, TRANSFER_SOURCE_FINALIZATION_WAIT_MS);
  const refreshedItem = await getPipelineItem(_db, item.id) ?? item;
  const artifacts = await stageTransferredSessionArtifacts(transferId, refreshedItem, repo.path);
  const payload = buildOutgoingTransferPayload({
    sourcePeerId: transfer.source_peer_id,
    sourceTaskId: transfer.source_task_id,
    targetPeerId: transfer.target_peer_id ?? "",
    item: refreshedItem,
    repoPath: repo.path,
    repoName: repo.name,
    repoDefaultBranch: repo.default_branch,
    repoRemoteUrl: refreshedRepoRemoteUrl,
    recovery: await loadSessionRecoveryState(item.id),
    artifacts,
    targetHasRepo: parsedExistingPayload.repo.mode === "reuse-local",
    bundle: parsedExistingPayload.repo.bundle ? { artifactId: parsedExistingPayload.repo.bundle.artifact_id, filename: parsedExistingPayload.repo.bundle.filename, refName: parsedExistingPayload.repo.bundle.ref_name } : null,
  });
  await _db.execute("UPDATE task_transfer SET payload_json = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(payload), transferId]);
  return { transferId, payload, finalizedCleanly: exited };
}
```

Update approval to finalize first:

```ts
const finalized = parseFinalizedOutgoingTransferResult(await invoke("finalize_outgoing_transfer", {
  transferId,
}));
const payload = finalized.payload;
```

In `apps/desktop/src/App.vue`, listen for the new event and forward it:

```ts
const unlistenOutgoingTransferFinalizationRequested = await listen("outgoing-transfer-finalization-requested", async (event: unknown) => {
  const payload = (event as { payload?: unknown })?.payload ?? event;
  const transferId = readRequiredString(payload as Record<string, unknown>, ["transfer_id", "transferId"], "outgoing transfer finalization request missing transfer id");
  try {
    const result = await store.finalizeOutgoingTransfer(transferId);
    await invoke("complete_outgoing_transfer_finalization", {
      transferId,
      payload: result.payload,
      finalizedCleanly: result.finalizedCleanly,
      error: null,
    });
  } catch (error: unknown) {
    await invoke("complete_outgoing_transfer_finalization", {
      transferId,
      payload: null,
      finalizedCleanly: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
```

In `apps/desktop/src/tauri-mock.ts`, add:

```ts
finalize_outgoing_transfer: (args: { transferId?: string }) => ({
  transferId: args.transferId ?? "mock-transfer-1",
  payload: {
    target_peer_id: "peer-target",
    task: {
      source_peer_id: "peer-source",
      source_task_id: "task-source",
      resume_session_id: null,
      prompt: "Mock transfer",
      stage: "in progress",
      branch: "task-source",
      workflow: "default",
      display_name: null,
      base_ref: "main",
      agent_type: "pty",
      agent_provider: "claude",
    },
    repo: {
      mode: "reuse-local",
      remote_url: null,
      path: "/tmp/mock-repo",
      name: "mock-repo",
      default_branch: "main",
      bundle: null,
    },
    recovery: null,
    artifacts: [],
  },
  finalizedCleanly: true,
}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd apps/desktop && pnpm exec vitest run src/stores/kannaTransfer.test.ts src/App.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/stores/kanna.ts apps/desktop/src/utils/taskTransfer.ts apps/desktop/src/App.vue apps/desktop/src/App.test.ts apps/desktop/src/stores/kannaTransfer.test.ts apps/desktop/src/tauri-mock.ts
git commit -m "Finalize source tasks before transfer import"
```

### Task 4: Verify The Full Slice

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src/stores/kanna.ts`

- [ ] **Step 1: Run transfer runtime tests**

Run:

```bash
cd crates/task-transfer && cargo test --test protocol --test runtime
```

Expected: PASS

- [ ] **Step 2: Run Tauri-side focused tests**

Run:

```bash
cd apps/desktop/src-tauri && cargo test transfer_sidecar --lib
```

Expected: PASS

- [ ] **Step 3: Run desktop transfer tests**

Run:

```bash
cd apps/desktop && pnpm exec vitest run src/stores/kannaTransfer.test.ts src/App.test.ts
```

Expected: PASS

- [ ] **Step 4: Run desktop typecheck**

Run:

```bash
cd apps/desktop && pnpm exec vue-tsc --noEmit
```

Expected: PASS

- [ ] **Step 5: Run targeted Rust formatting checks**

Run:

```bash
cd crates/task-transfer && cargo fmt --check
cd apps/desktop/src-tauri && rustfmt --edition 2021 --check src/transfer_sidecar.rs src/commands/transfer.rs src/lib.rs
```

Expected: PASS, or only pre-existing unrelated formatting drift outside these touched files.

- [ ] **Step 6: Commit**

```bash
git add crates/task-transfer/src/protocol.rs crates/task-transfer/src/runtime.rs crates/task-transfer/src/main.rs crates/task-transfer/tests/protocol.rs crates/task-transfer/tests/runtime.rs apps/desktop/src-tauri/src/transfer_sidecar.rs apps/desktop/src-tauri/src/commands/transfer.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/stores/kanna.ts apps/desktop/src/utils/taskTransfer.ts apps/desktop/src/App.vue apps/desktop/src/App.test.ts apps/desktop/src/stores/kannaTransfer.test.ts apps/desktop/src/tauri-mock.ts
git commit -m "Add transfer source finalization flow"
```
