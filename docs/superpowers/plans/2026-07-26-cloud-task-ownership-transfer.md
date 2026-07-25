# Cloud Task Ownership Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let signed-in Kanna desktops automatically push and pull task ownership over the cloud relay without manual machine pairing.

**Architecture:** Extend the existing relay tunnel with a fixed `task-transfer` service that bridges opaque binary frames to the destination's loopback transfer sidecar. Publish each desktop's transfer public identity in its authenticated cloud presence, inject same-account desktops into the sidecar as session-trusted external peers, and keep the existing encrypted preflight/import/finalization/acknowledgment state machine authoritative. Pull is a new authenticated request that asks the remote owner to start the existing push flow back to the requester.

**Tech Stack:** Vue 3/TypeScript/Vitest, Tauri v2/Rust/Tokio, Rust task-transfer sidecar, kanna-server KSP/relay client, Node `ws` relay, Firebase emulator task index, SQLite.

---

## File Structure

- `crates/task-transfer/src/runtime/external_peers.rs` owns session-scoped cloud peer registration and route lookup.
- `crates/task-transfer/src/runtime/pull.rs` owns the authenticated pull-request protocol.
- `apps/desktop/src-tauri/src/cloud_transfer_proxy.rs` owns loopback TCP-to-relay WebSocket bridging.
- `apps/desktop/src/services/desktopTransferMachines.ts` maps and merges signed-in desktop presence with LAN peers.
- `apps/desktop/src/composables/useAppTaskTransfer.ts` owns push/pull UI state and delegates transfer execution.
- Existing relay, cloud publisher, transfer store, and workspace modules receive narrow extensions only.

### Task 1: Persist a Stable Cloud Task Identity Through Transfer

**Files:**
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/snapshot.rs`
- Modify: `crates/kanna-server/src/db/pipeline_items.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/transfers.rs`
- Modify: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/desktop/src/types/kanna.ts`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/services/desktopServerClient.test.ts`

- [ ] **Step 1: Write failing migration and API tests**

Add `030_pipeline_item_cloud_task_id` to `CURRENT_SCHEMA_MIGRATIONS`. In
`crates/kanna-server/src/db/tests.rs`, open a migrated database, insert a task,
and assert the new identity defaults to the local UUID:

```rust
#[test]
fn migration_backfills_cloud_task_identity_from_local_task_id() {
    let db = migrated_test_db("cloud-task-id");
    db.connection().execute(
        "INSERT INTO pipeline_item (id, repo_id, pipeline, stage) VALUES ('task-1', 'repo-1', 'default', 'in progress')",
        [],
    ).unwrap();
    let cloud_task_id: String = db.connection().query_row(
        "SELECT COALESCE(cloud_task_id, id) FROM pipeline_item WHERE id = 'task-1'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(cloud_task_id, "task-1");
}
```

Add a route test for:

```text
PUT /v1/tasks/task-destination/actions/cloud-task-identity
{"cloudTaskId":"task-source-stable"}
```

Assert `pipeline_item.cloud_task_id` becomes `task-source-stable`, and assert a
second request with a different value returns `409` rather than silently
changing an established identity.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml migration_backfills_cloud_task_identity_from_local_task_id
cargo test --manifest-path crates/kanna-server/Cargo.toml cloud_task_identity
```

Expected: FAIL because the migration, column, and route do not exist.

- [ ] **Step 3: Add the migration, snapshot field, and write-once API**

Add:

```rust
run_migration(conn, "030_pipeline_item_cloud_task_id", |conn| {
    add_column(conn, "pipeline_item", "cloud_task_id", "TEXT")?;
    conn.execute(
        "UPDATE pipeline_item SET cloud_task_id = id WHERE cloud_task_id IS NULL",
        [],
    )?;
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_item_open_cloud_task_id
         ON pipeline_item(cloud_task_id) WHERE closed_at IS NULL",
        [],
    )?;
    Ok(())
})?;
```

Expose `cloud_task_id` on `PipelineItem`, `SnapshotPipelineItem`, the snapshot
query, and both TypeScript `PipelineItem` interfaces. Add:

```rust
pub fn set_cloud_task_identity(
    &self,
    task_id: &str,
    cloud_task_id: &str,
) -> Result<CloudTaskIdentityWrite, rusqlite::Error>
```

where `CloudTaskIdentityWrite` is `Updated`, `Unchanged`, `Conflict`, or
`TaskNotFound`. The route maps those states to `200`, `200`, `409`, and `404`.
`Conflict` covers changing an established identity and colliding with another
open local task; closed historical rows may retain the same durable identity.
Reject blank or control-character identities with `400`.

Add the matching desktop client:

```ts
export async function setDesktopTaskCloudIdentity(
  taskId: string,
  cloudTaskId: string,
): Promise<void> {
  await requestJson(`/v1/tasks/${encodeURIComponent(taskId)}/actions/cloud-task-identity`, {
    method: "PUT",
    body: { cloudTaskId },
  });
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml cloud_task_identity
pnpm --dir apps/desktop test -- src/services/desktopServerClient.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kanna-server packages/db/src/schema.ts apps/desktop/src/types/kanna.ts apps/desktop/src/services/desktopServerClient.ts apps/desktop/src/services/desktopServerClient.test.ts
git commit -m "feat(cloud): persist stable task ownership identity"
```

### Task 2: Carry Stable Identity and Transfer State in Cloud Snapshots

**Files:**
- Modify: `apps/desktop/src/utils/taskTransfer.ts`
- Modify: `apps/desktop/src/utils/taskTransfer.test.ts`
- Modify: `apps/desktop/src/stores/transfer.ts`
- Modify: `apps/desktop/src/stores/kannaTransfer.test.ts`
- Modify: `crates/kanna-server/src/cloud_task_publisher.rs`
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/snapshot.rs`
- Modify: `crates/kanna-server/src/db/transfers.rs`
- Modify: `crates/kanna-server/src/db/test_support.rs`
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/desktop/src/types/kanna.ts`
- Modify: `services/relay/src/cloudTaskPublication.ts`
- Modify: `services/relay/test/cloudTaskPublication.test.ts`
- Modify: `services/firebase-functions/src/types.ts`

- [ ] **Step 1: Write failing payload and publisher tests**

Add a transfer payload test asserting:

```ts
expect(buildOutgoingTransferPayload({
  sourcePeerId: "peer-a",
  sourceTaskId: "local-a",
  targetPeerId: "peer-b",
  item: { ...item, cloud_task_id: "cloud-stable" },
  repoRemoteUrl: null,
  recovery: null,
  targetHasRepo: true,
  bundle: null,
}).task.cloud_task_id).toBe("cloud-stable");
```

Add a store import test asserting
`setDesktopTaskCloudIdentity(destinationTaskId, "cloud-stable")` runs before
the destination acknowledges import.

Add Rust mapping tests for:

```json
{
  "cloudTaskId": "cloud-stable",
  "transfer": {
    "state": "outgoing",
    "transferId": "transfer-1",
    "sourceDesktopId": "desktop-a",
    "destinationDesktopId": "desktop-b"
  }
}
```

Add relay validator tests accepting `none`, `outgoing`, `incoming`, and
`finalization_pending`, and rejecting an `outgoing` state with a null
`transferId` or destination.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/utils/taskTransfer.test.ts src/stores/kannaTransfer.test.ts
cargo test --manifest-path crates/kanna-server/Cargo.toml cloud_task_publisher
pnpm --dir services/relay test -- cloudTaskPublication.test.ts
```

Expected: FAIL on missing `cloud_task_id` and the relay's current
`transfer.state must be none` guard.

- [ ] **Step 3: Extend the payload, import order, and snapshot projection**

Extend the portable task payload:

```ts
task: {
  cloud_task_id: string;
  source_peer_id: string;
  source_desktop_id: string | null;
  source_task_id: string;
  // existing fields remain unchanged
};
target_desktop_id: string | null;
```

Use `item.cloud_task_id ?? item.id` when building it. During import:

```ts
const localTaskId = await tasks.createItem(/* existing arguments */);
await setDesktopTaskCloudIdentity(localTaskId, payload.task.cloud_task_id);
await completeDesktopTaskTransfer(transferId, localTaskId);
```

Add `031_task_transfer_cloud_desktop_ids`, with nullable
`source_desktop_id` and `target_desktop_id` columns on `task_transfer`.
Extend `NewTaskTransfer`, `TaskTransferRecord`, their TypeScript mirrors, and
the insert/select/test-support SQL. LAN-only transfers leave both columns null;
cloud transfers record both authenticated desktop ids.

Extend the snapshot SQL with the most recent relevant transfer for the task,
including a completed incoming row awaiting source finalization, and expose:

```rust
pub cloud_task_id: String,
pub transfer_id: Option<String>,
pub transfer_direction: Option<String>,
pub transfer_status: Option<String>,
pub transfer_source_peer_id: Option<String>,
pub transfer_target_peer_id: Option<String>,
pub transfer_source_desktop_id: Option<String>,
pub transfer_target_desktop_id: Option<String>,
```

Map local transfer rows as:

```rust
let transfer = match (
    item.transfer_direction.as_deref(),
    item.transfer_status.as_deref(),
) {
    (Some("outgoing"), Some("pending" | "streaming")) => ("outgoing", source, destination),
    (Some("incoming"), Some("pending" | "streaming")) => ("incoming", source, destination),
    (Some("incoming"), Some("completed")) if item.closed_at.is_none() =>
        ("finalization_pending", source, destination),
    _ => ("none", None, None),
};
```

Project cloud transfer state only when both desktop-id columns are present.
Update relay validation so each non-`none` state requires a transfer id,
source desktop id, and destination desktop id. Preserve the authenticated owner
desktop check.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the four commands from Step 2. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/utils apps/desktop/src/stores apps/desktop/src/types/kanna.ts packages/db/src/schema.ts crates/kanna-server/src services/relay services/firebase-functions/src/types.ts
git commit -m "feat(transfer): publish portable cloud ownership state"
```

### Task 3: Publish Transfer Peer Identity in Authenticated Desktop Presence

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/tests/protocol.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/services/desktopServerClient.test.ts`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/settings.rs`
- Modify: `crates/kanna-server/src/cloud_task_publisher.rs`
- Modify: `services/relay/src/cloudTaskPublication.ts`
- Modify: `services/relay/test/cloudTaskPublication.test.ts`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.test.ts`

- [ ] **Step 1: Write failing identity round-trip tests**

Add protocol serialization coverage for:

```json
{"type":"get_local_identity","request_id":"identity-1"}
```

and:

```json
{
  "type":"get_local_identity",
  "request_id":"identity-1",
  "peer_id":"peer-a",
  "display_name":"Studio Mac",
  "public_key":"base64-key",
  "protocol_version":1,
  "accepting_transfers":true
}
```

Add relay publication validation asserting the desktop document contains:

```ts
transfer: {
  peerId: "peer-a",
  publicKey: "base64-key",
  protocolVersion: 1,
  acceptingTransfers: true,
}
```

Add cloud index mapping coverage asserting the desktop metadata is returned as
`DesktopCloudTransferMachine`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml --test protocol get_local_identity
pnpm --dir services/relay test -- cloudTaskPublication.test.ts
pnpm --dir apps/desktop test -- src/services/desktopCloudTaskIndex.test.ts
```

Expected: FAIL because identity is not exposed or published.

- [ ] **Step 3: Expose and publish non-secret identity**

Add `ControlRequest::GetLocalIdentity` and
`ControlResponse::GetLocalIdentity`, backed by:

```rust
pub fn local_identity(&self) -> LocalTransferIdentity {
    LocalTransferIdentity {
        peer_id: self.config.peer_id.clone(),
        display_name: self.config.display_name.clone(),
        public_key: public_key_to_string(&self.identity.public_key),
        protocol_version: 1,
        accepting_transfers: true,
    }
}
```

Expose Tauri command `get_transfer_identity`. Add a loopback HTTP endpoint
and matching `putDesktopCloudTransferIdentity` client helper:

```text
PUT /v1/settings/cloud-transfer-identity
```

that stores one JSON setting under `cloud_transfer_identity_v1`. Publisher and
client tests seed/read that setting here; Task 9 invokes the helper after
sign-in and sidecar warmup.

Extend `CloudTaskSnapshotEnvelope.desktop` and relay reconciliation so the
desktop document receives `transfer`. Update
`DesktopCloudSnapshot` with:

```ts
export interface DesktopCloudTransferMachine {
  desktopId: string;
  displayName: string;
  online: boolean;
  peerId: string;
  publicKey: string;
  protocolVersion: number;
  acceptingTransfers: boolean;
}
```

The Firestore subscription must derive these records from the same desktop
documents already used to subscribe to nested tasks.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the three commands from Step 2 plus:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml cloud_transfer_identity
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/task-transfer apps/desktop/src-tauri apps/desktop/src/services crates/kanna-server/src services/relay
git commit -m "feat(cloud): publish desktop transfer identity"
```

### Task 4: Add a Service-Scoped Relay Tunnel

**Files:**
- Modify: `services/relay/src/router.ts`
- Modify: `services/relay/src/index.ts`
- Modify: `services/relay/test/integration.test.ts`
- Modify: `packages/stream-client/src/index.ts`
- Modify: `packages/stream-client/src/stream-client.test.ts`
- Modify: `crates/kanna-server/src/relay_client.rs`
- Modify: `crates/kanna-server/src/relay.rs`
- Modify: `crates/kanna-server/src/config.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mobile/config.rs`

- [ ] **Step 1: Write failing service routing tests**

In relay integration tests, authenticate two desktops under one user and assert:

```ts
client.send(JSON.stringify({
  type: "tunnel_request",
  id: "transfer-tunnel-1",
  desktopId: "desktop-b",
  service: "task-transfer",
}));
expect(await nextJson(desktopB)).toMatchObject({
  type: "tunnel_establish",
  desktopId: "desktop-b",
  service: "task-transfer",
});
```

Assert missing `service` resolves to `ksp`; assert `"ssh"` returns an error.
Use separate Firebase users and assert a client cannot address the other
user's desktop.

In Rust, deserialize `TunnelEstablish` with `service: TaskTransfer` and assert
the config parser requires a loopback `transfer_port`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --dir services/relay test -- integration.test.ts
cargo test --manifest-path crates/kanna-server/Cargo.toml relay_client
```

Expected: FAIL because service is ignored/unknown.

- [ ] **Step 3: Implement the fixed service discriminator**

Add:

```ts
type TunnelService = "ksp" | "task-transfer";
interface PendingTunnel {
  client: WebSocket;
  desktopId: string;
  service: TunnelService;
}
```

Normalize an absent service to `ksp`; reject every other value before creating
a pending tunnel. Include `service` in `tunnel_establish` and `tunnel_ready`.
The pending tunnel remains scoped inside the authenticated user's
`ConnectionPair`, which preserves cross-user isolation.

Add Rust:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunnelService {
    Ksp,
    TaskTransfer,
}
```

Add `transfer_port: u16` to `Config`, write it from
`KANNA_TRANSFER_PORT`, and reject zero/non-loopback forwarding targets.
Keep the current KSP path unchanged for an absent/default service.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the two commands from Step 2 plus:

```bash
pnpm --dir packages/stream-client test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add services/relay packages/stream-client crates/kanna-server apps/desktop/src-tauri/src/commands/mobile/config.rs
git commit -m "feat(relay): route service-scoped desktop tunnels"
```

### Task 5: Bridge Task-Transfer Tunnels to the Destination Sidecar

**Files:**
- Create: `crates/kanna-server/src/task_transfer_tunnel.rs`
- Modify: `crates/kanna-server/src/main.rs`
- Modify: `crates/kanna-server/src/relay.rs`
- Modify: `crates/kanna-server/src/lib.rs`
- Modify: `crates/kanna-server/Cargo.toml`

- [ ] **Step 1: Write a failing bridge integration test**

Start a loopback `TcpListener`, create an in-memory WebSocket pair, and assert
bytes pass in both directions:

```rust
#[tokio::test]
async fn task_transfer_tunnel_bridges_binary_frames_and_tcp_bytes() {
    let (transfer_listener, transfer_port) = loopback_listener().await;
    let (client_ws, desktop_ws) = websocket_pair().await;
    let bridge = tokio::spawn(bridge_task_transfer_tunnel(
        desktop_ws,
        transfer_port,
    ));

    let (mut sidecar_socket, _) = transfer_listener.accept().await.unwrap();
    client_ws.send(Message::Binary(b"source\n".to_vec().into())).await.unwrap();
    assert_eq!(read_line(&mut sidecar_socket).await, "source\n");

    sidecar_socket.write_all(b"destination\n").await.unwrap();
    assert_eq!(
        client_ws.next().await.unwrap().unwrap().into_data(),
        b"destination\n",
    );
    client_ws.close(None).await.unwrap();
    bridge.await.unwrap().unwrap();
}
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml task_transfer_tunnel_bridges
```

Expected: FAIL because the bridge module does not exist.

- [ ] **Step 3: Implement bounded bidirectional forwarding**

Before opening the sidecar bridge, consume and validate the relay's
`tunnel_ready` text control frame for the expected tunnel id and
`service: "task-transfer"`. Do not forward that control frame to the TCP
sidecar. Then implement `bridge_task_transfer_tunnel` with one 64 KiB TCP
buffer and a `tokio::select!` loop:

```rust
loop {
    tokio::select! {
        read = tcp.read(&mut buffer) => {
            let count = read?;
            if count == 0 { break; }
            ws.send(Message::Binary(buffer[..count].to_vec().into())).await?;
        }
        frame = ws.next() => match frame.transpose()? {
            Some(Message::Binary(bytes)) => tcp.write_all(&bytes).await?,
            Some(Message::Close(_)) | None => break,
            Some(Message::Ping(bytes)) => ws.send(Message::Pong(bytes)).await?,
            Some(_) => return Err(TunnelError::UnexpectedTextFrame),
        }
    }
}
```

Because each send/write is awaited, there is no unbounded queue. In
`relay.rs`, dispatch `TunnelService::Ksp` to the existing KSP handler and
`TunnelService::TaskTransfer` to this bridge using only
`127.0.0.1:config.transfer_port`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml task_transfer_tunnel
cargo test --manifest-path crates/kanna-server/Cargo.toml relay
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/kanna-server
git commit -m "feat(server): bridge relay tunnels to task transfer"
```

### Task 6: Add the Initiating Tauri Cloud Transfer Proxy

**Files:**
- Create: `apps/desktop/src-tauri/src/cloud_transfer_proxy.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `apps/desktop/src/tauri-mock.ts`

- [ ] **Step 1: Write failing proxy handshake and cleanup tests**

Use a local `tokio_tungstenite` test relay and assert:

1. the proxy sends `auth` with the supplied ID token;
2. after `auth_ok`, it requests `service: "task-transfer"` for the exact
   destination desktop;
3. after `tunnel_ready`, TCP bytes are forwarded as binary frames;
4. `clear_cloud_transfer_proxies` closes listeners and active sockets.

The expected request is:

```json
{
  "type":"tunnel_request",
  "id":"cloud-transfer-peer-b-1",
  "desktopId":"desktop-b",
  "service":"task-transfer"
}
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml cloud_transfer_proxy
```

Expected: FAIL because the module and commands are absent.

- [ ] **Step 3: Implement proxy state and Tauri commands**

Add `tokio-tungstenite` and `futures-util` using the same vendored versions as
`kanna-server`. Create managed state:

```rust
pub type CloudTransferProxyState =
    Arc<Mutex<HashMap<String, CloudTransferProxyHandle>>>;
```

Add commands:

```rust
ensure_cloud_transfer_proxy(
    peer_id: String,
    desktop_id: String,
    relay_url: String,
    id_token: String,
) -> Result<CloudTransferProxyEndpoint, String>

remove_cloud_transfer_proxy(peer_id: String) -> Result<(), String>

clear_cloud_transfer_proxies() -> Result<(), String>
```

Validate `ws://` or `wss://`, nonblank IDs/token, bind only `127.0.0.1:0`, and
return the resulting endpoint. Reuse an existing proxy only when desktop id,
relay URL, and auth generation match. Implement the same awaited 64 KiB binary
bridge as the destination.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all proxy tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri Cargo.lock apps/desktop/src/tauri-mock.ts
git commit -m "feat(desktop): proxy cloud transfer peers through relay"
```

### Task 7: Inject Same-Account External Peers Into the Transfer Runtime

**Files:**
- Create: `crates/task-transfer/src/runtime/external_peers.rs`
- Modify: `crates/task-transfer/src/runtime/mod.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/peer.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/tests/protocol.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Write failing external-peer tests**

Add runtime coverage:

```rust
runtime.upsert_external_peer(ExternalPeer {
    peer_id: "peer-cloud".into(),
    display_name: "Cloud Mac".into(),
    endpoint: proxy_endpoint,
    public_key: peer_public_key,
    protocol_version: 1,
    accepting_transfers: true,
}).await.unwrap();

let peer = runtime.list_peers().await.unwrap()
    .into_iter().find(|peer| peer.peer_id == "peer-cloud").unwrap();
assert!(peer.trusted);
assert_eq!(peer.endpoint, proxy_endpoint);

runtime.remove_external_peer("peer-cloud").await.unwrap();
assert!(runtime.find_peer("peer-cloud").await.is_err());
```

Add a key-rotation assertion: replacing the same peer id with a new public key
immediately invalidates the previous key. Assert no record is written under
`trusted-peers`. Add route-selection coverage showing that a peer may retain
both a LAN endpoint and a cloud-proxy endpoint and that an outgoing reservation
pins the requested route for its lifetime.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml external_peer
```

Expected: FAIL because the API does not exist.

- [ ] **Step 3: Add the in-memory peer registry and control commands**

Define:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalPeer {
    pub peer_id: String,
    pub display_name: String,
    pub endpoint: String,
    pub public_key: String,
    pub protocol_version: u32,
    pub accepting_transfers: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerRoutes {
    pub lan_endpoint: Option<String>,
    pub cloud_endpoint: Option<String>,
}

pub enum TransferTransport {
    Auto,
    Lan,
    Cloud,
}
```

Store it in `Arc<std::sync::RwLock<HashMap<String, ExternalPeer>>>` so listener
trust checks remain synchronous. Merge local discovery and external peers by
peer id without discarding either route, returning `PeerRoutes`. A matching
external key makes the peer trusted for the current runtime; durable LAN trust
remains unchanged.

Extend `PrepareTransferPreflight` with
`transport: "auto" | "lan" | "cloud"`. Resolve `auto` LAN-first, then pin the
selected endpoint in the outgoing reservation so a later discovery update
cannot switch transport mid-transfer.

Add control/Tauri commands:

```text
upsert_external_transfer_peer
remove_external_transfer_peer
clear_external_transfer_peers
```

Validate loopback endpoints, protocol version `1`, nonblank identity fields,
and a parseable X25519 public key.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml external_peer
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml transfer_sidecar
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/task-transfer apps/desktop/src-tauri
git commit -m "feat(transfer): trust session-scoped cloud peers"
```

### Task 8: Add Authenticated Pull Requests to the Existing Transfer Protocol

**Files:**
- Create: `crates/task-transfer/src/runtime/pull.rs`
- Modify: `crates/task-transfer/src/runtime/mod.rs`
- Modify: `crates/task-transfer/src/runtime/events.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/main.rs`
- Modify: `crates/task-transfer/tests/protocol.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/utils/taskTransfer.ts`
- Modify: `apps/desktop/src/utils/taskTransfer.test.ts`

- [ ] **Step 1: Write failing pull request protocol tests**

Pair or externally trust two runtimes, then:

```rust
destination.request_task_pull(
    "peer-source",
    "task-source",
    TransferTransport::Cloud,
).await.unwrap();
let RuntimeEvent::TaskPullRequested(event) = source.next_event().await.unwrap() else {
    panic!("expected task pull request");
};
assert_eq!(event.source_task_id, "task-source");
assert_eq!(event.requester_peer_id, "peer-destination");
```

Repeat the request and assert the same request id is returned while pending and
only one event is emitted. Add rejection tests for unknown peer, mismatched
public key, blank/control-character task id, and self-request.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml task_pull
```

Expected: FAIL because pull protocol variants do not exist.

- [ ] **Step 3: Implement sealed, idempotent pull initiation**

Add `PeerRequest::RequestTaskPull` carrying requester id and sealed:

```json
{"source_task_id":"task-source"}
```

Add `PeerResponse::RequestTaskPull { request_id }`,
`ControlRequest::RequestTaskPull`, and
`SidecarEvent::TaskPullRequested`. Validate trust before decrypting and emit:

```rust
pub struct TaskPullRequestedEvent {
    pub request_id: String,
    pub requester_peer_id: String,
    pub source_task_id: String,
}
```

`ControlRequest::RequestTaskPull` includes
`transport: "auto" | "lan" | "cloud"` and selects the route through the same
resolver used by preflight. Keep an expiring map keyed by
`(requester_peer_id, source_task_id)` for five
minutes so duplicates return the original request id without emitting a second
event. Expose Tauri command `request_task_pull`.

Add TypeScript parser:

```ts
export interface TaskPullRequestedEvent {
  requestId: string;
  requesterPeerId: string;
  sourceTaskId: string;
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2 plus:

```bash
pnpm --dir apps/desktop test -- src/utils/taskTransfer.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/task-transfer apps/desktop/src-tauri apps/desktop/src/utils
git commit -m "feat(transfer): request remote task ownership pull"
```

### Task 9: Synchronize Automatic Cloud Machines Into the Sidecar

**Files:**
- Create: `apps/desktop/src/services/desktopTransferMachines.ts`
- Create: `apps/desktop/src/services/desktopTransferMachines.test.ts`
- Modify: `apps/desktop/src/services/desktopCloudTaskIndex.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.test.ts`
- Modify: `apps/desktop/src/App.vue`

- [ ] **Step 1: Write failing machine merge and auth-lifecycle tests**

Test:

```ts
expect(mergeTransferMachines({
  currentDesktopId: "desktop-a",
  lanPeers: [{
    id: "peer-b",
    name: "Mac B",
    publicKey: "key-b",
    endpoint: "192.168.1.2:4455",
    trusted: false,
  }],
  cloudMachines: [{
    desktopId: "desktop-b",
    displayName: "Mac B",
    online: true,
    peerId: "peer-b",
    publicKey: "key-b",
    protocolVersion: 1,
    acceptingTransfers: true,
  }],
})).toEqual([expect.objectContaining({
  peerId: "peer-b",
  trustSource: "same-account-cloud",
  preferredTransport: "lan",
  relayDesktopId: "desktop-b",
})]);
```

Also assert current/offline/incompatible desktops are excluded, a cloud-only
peer prefers `cloud`, and mismatched keys are not merged.

In the composable test, sign in and assert the sequence:

```text
get_transfer_identity
PUT local cloud-transfer-identity
ensure_cloud_transfer_proxy
upsert_external_transfer_peer
```

On sign-out, assert:

```text
clear_external_transfer_peers
clear_cloud_transfer_proxies
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/services/desktopTransferMachines.test.ts src/composables/useAppCloudWorkspace.test.ts
```

Expected: FAIL because the machine catalog and synchronization do not exist.

- [ ] **Step 3: Implement cloud machine synchronization**

Define:

```ts
export interface TransferMachine {
  peerId: string;
  desktopId: string | null;
  name: string;
  publicKey: string;
  lanEndpoint: string | null;
  relayDesktopId: string | null;
  trustSource: "paired-lan" | "same-account-cloud";
  preferredTransport: "lan" | "cloud";
  cloudFallback: boolean;
}
```

After sign-in and sidecar warmup, `useAppCloudWorkspace` invokes
`get_transfer_identity` and immediately persists that non-secret identity with
`putDesktopCloudTransferIdentity`.

It then watches signed-in cloud transfer machines. For each eligible cloud
machine it fetches a current ID token, resolves the relay URL, ensures a proxy,
and upserts an external sidecar peer using the proxy endpoint.
Use a monotonically increasing auth/subscription generation; discard async
results from older generations. Remove peers and proxies absent from the latest
snapshot.

Expose `transferMachines` to `App.vue` and pass it into
`useAppTaskTransfer`. Do not add cloud machines to `Pair Machine`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/services apps/desktop/src/composables/useAppCloudWorkspace.ts apps/desktop/src/composables/useAppCloudWorkspace.test.ts apps/desktop/src/App.vue
git commit -m "feat(cloud): auto-register signed-in transfer machines"
```

### Task 10: Wire Push and Pull Actions to Workspace Capabilities

**Files:**
- Modify: `apps/desktop/src/composables/useAppTaskTransfer.ts`
- Modify: `apps/desktop/src/composables/useAppTaskTransfer.test.ts`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.ts`
- Modify: `apps/desktop/src/composables/useAppTaskNavigation.test.ts`
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`
- Modify: `apps/desktop/src/App.vue`
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src/components/AppModalLayer.vue`
- Modify: `apps/desktop/src/components/PeerPickerModal.vue`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/ja.json`
- Modify: `apps/desktop/src/i18n/locales/ko.json`
- Modify: `apps/desktop/src/stores/transfer.ts`
- Modify: `apps/desktop/src/stores/kannaTransfer.test.ts`

- [ ] **Step 1: Write failing push/pull behavior tests**

Add navigation tests asserting:

- a local workspace task with `canPushToMachine` gets `Push to Machine`;
- a remote task with `canPullFromMachine` gets `Pull to This Machine`;
- a legacy remote task without `transferPeerId` cannot pull;
- an offline remote task gets neither executable pull action nor an enabled
  action;
- `Pair Machine` remains independent and LAN-only.

Add transfer composable tests asserting cloud machines need no pairing,
duplicate push/pull clicks are ignored, and pull invokes:

```ts
invoke("request_task_pull", {
  targetPeerId: "peer-source",
  sourceTaskId: "task-source",
  transport: "cloud",
});
```

Add lifecycle coverage asserting `task-pull-requested` validates local
ownership and calls:

```ts
store.pushTaskToPeer("task-source", "peer-requester");
```

Reject closed, missing, remote-only, or already-transferring source tasks
without starting push.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/composables/useAppTaskTransfer.test.ts src/composables/useAppTaskNavigation.test.ts src/App.test.ts src/stores/kannaTransfer.test.ts
```

Expected: FAIL because pull UI/event handling is absent and push only lists
sidecar LAN peers.

- [ ] **Step 3: Implement unified actions and single-flight behavior**

Change the picker to consume `TransferMachine[]`; cloud machines have
`trusted: true` and subtitles `Cloud` or `Nearby · Cloud`. On push, pass the
stable `peerId` to the existing store transfer.

Add:

```ts
async function pullSelectedWorkspaceTask(task: WorkspaceTask): Promise<void> {
  if (transferPeerActionPending.value) return;
  const owner = task.terminal.remoteRef;
  if (!owner || !task.capabilities.canPullFromMachine) {
    toast.error("Remote task owner is offline.");
    return;
  }
  transferPeerActionPending.value = true;
  try {
    await invoke("request_task_pull", {
      targetPeerId: owner.transferPeerId,
      sourceTaskId: owner.ownerLocalTaskId,
      transport: owner.preferredTransferTransport,
    });
  } finally {
    transferPeerActionPending.value = false;
  }
}
```

Extend `DesktopCloudTerminalRef` with `transferPeerId` and
`preferredTransferTransport`. `canPullFromMachine` requires a reachable remote
owner and a nonblank transfer peer id. Add the pull command only when the
selected workspace task satisfies that capability. Add the sidecar-event
listener that validates the source item before starting push.

For LAN-first cloud peers, invoke preflight with `transport: "lan"` and catch
only preflight connection failure. If the machine has `cloudFallback`, retry
once with `transport: "cloud"` before inserting a transfer row. Pass the cloud
source/destination desktop ids into the transfer row and portable payload.
Never retry after a row exists or commit/finalization has begun.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src
git commit -m "feat(desktop): push and pull task ownership across machines"
```

### Task 11: Prove Cloud Push/Pull End to End

**Files:**
- Create: `apps/desktop/tests/e2e/real/cloud-task-transfer.test.ts`
- Modify: `apps/desktop/tests/e2e/helpers/transferFlow.ts`
- Modify: `apps/desktop/tests/e2e/run.ts`
- Modify: `apps/desktop/tests/e2e/helpers/twoInstance.ts`
- Modify: `services/relay/test/integration.test.ts`

- [ ] **Step 1: Write the end-to-end scenarios**

Run two desktop instances signed into the same Firebase emulator user with
`KANNA_TRANSFER_DISCOVERY=registry`, but separate transfer registry
directories so no direct LAN peer is discoverable. Assert:

```ts
expect(await listTransferPickerRows(primary)).toContain("Secondary");
expect(await listPairMachineRows(primary)).not.toContain("Secondary");
```

Create a task on primary, push to Secondary, and verify:

- secondary incoming transfer is `completed`;
- destination task has the original `cloud_task_id`;
- source task is closed only after acknowledgment;
- the cloud task index changes owner to secondary.

Select that remote task on primary and execute `Pull to This Machine`. Verify
the same invariants in reverse and that only the final destination task remains
open.

Add cases that fail destination import before acknowledgment and interrupt
acknowledgment after import. The former keeps source open; the latter retries
without creating another destination task.

- [ ] **Step 2: Run E2E and verify RED**

Run:

```bash
pnpm --dir apps/desktop test:e2e -- real/cloud-task-transfer.test.ts
```

Expected: FAIL at automatic machine discovery or the first cloud transfer.

- [ ] **Step 3: Add only the harness wiring required by the test**

Teach `run.ts` that this test needs two app instances, Firebase emulators, and
the relay. Give each instance:

- a distinct desktop id, DB, daemon, transfer root, and transfer port;
- the same emulator user;
- no shared transfer discovery registry;
- the shared relay URL.

Extend `transferFlow.ts` with `pullSelectedTaskToThisMachineThroughUi` and
picker-row helpers. Do not bypass the product UI for push/pull actions.

- [ ] **Step 4: Run E2E and verify GREEN**

Run:

```bash
pnpm --dir apps/desktop test:e2e -- real/cloud-task-transfer.test.ts
pnpm --dir apps/desktop test:e2e -- real/local-transfer-accept-import.test.ts
pnpm --dir apps/desktop test:e2e -- real/local-transfer-repo-acquisition.test.ts
```

Expected: cloud push/pull and existing LAN transfer tests all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/tests/e2e services/relay/test/integration.test.ts
git commit -m "test(e2e): prove cloud task ownership transfer"
```

### Task 12: Full Verification and Documentation Reconciliation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-25-cloud-task-ownership-transfer-design.md` only if implementation names differ
- Modify: `docs/superpowers/plans/2026-07-26-cloud-task-ownership-transfer.md` to mark completed checkboxes

- [ ] **Step 1: Run focused subsystem suites**

```bash
cargo test --manifest-path crates/task-transfer/Cargo.toml
cargo test --manifest-path crates/kanna-server/Cargo.toml
pnpm --dir services/relay test
pnpm --dir packages/stream-client test
pnpm --dir apps/desktop test -- src
```

Expected: all PASS.

- [ ] **Step 2: Run canonical repository verification**

```bash
pnpm test
./kd test rust
```

Expected: all PASS.

- [ ] **Step 3: Run final transfer E2E matrix**

```bash
pnpm --dir apps/desktop test:e2e -- real/cloud-task-transfer.test.ts
pnpm --dir apps/desktop test:e2e -- real/local-transfer-accept-import.test.ts
pnpm --dir apps/desktop test:e2e -- real/local-transfer-repo-acquisition.test.ts
pnpm --dir apps/desktop test:e2e -- real/local-transfer-source-handoff-failure.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Reconcile docs and inspect the final diff**

```bash
rg -n "T[B]D|T[O]DO|implement lat[e]r" docs/superpowers/specs/2026-07-25-cloud-task-ownership-transfer-design.md docs/superpowers/plans/2026-07-26-cloud-task-ownership-transfer.md
git diff --check
git status --short
git diff --stat "$(git merge-base HEAD origin/main)"..HEAD
```

Expected: no placeholders, no whitespace errors, and only in-scope files.

- [ ] **Step 5: Commit plan completion markers if needed**

```bash
git add docs/superpowers/specs/2026-07-25-cloud-task-ownership-transfer-design.md docs/superpowers/plans/2026-07-26-cloud-task-ownership-transfer.md
git commit -m "docs: reconcile cloud transfer implementation"
```
