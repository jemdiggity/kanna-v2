# Cloud Task Ownership Transfer Design

Date: 2026-07-25
Status: Approved
Scope: Online desktop-to-desktop task ownership transfer for desktops signed in to the same Kanna account

## Summary

Kanna already includes remote tasks from every signed-in desktop in the unified
workspace without requiring users to add or pair each machine. Task transfer
must follow the same product model.

A user can push a locally owned task to another online desktop or pull a
remote-owned task onto the current desktop. Both actions move ownership; they
never create a second active copy. The destination imports the task and
acknowledges it before the source closes its local task.

The cloud path extends the existing encrypted task-transfer protocol over an
authenticated relay tunnel. It does not create a second transfer state machine.
Direct LAN transport remains available and is preferred when the same desktop
is reachable locally.

## Goals

- Automatically include eligible same-account desktops in transfer actions.
- Require no manual machine addition or pairing for signed-in cloud desktops.
- Push locally owned tasks to a selected online desktop.
- Pull a selected remote-owned task onto the current desktop.
- Preserve the existing transfer payload, repo acquisition, session recovery,
  source finalization, import acknowledgment, and source-close behavior.
- Keep the source authoritative until the destination commits the import.
- Prefer a direct LAN route and fall back to the cloud relay when both routes
  identify the same desktop.
- Remove cloud-derived trust and routes immediately when authentication ends or
  credentials are revoked.

## Non-Goals

- Copying tasks while leaving two active owners.
- Offline or queued transfers.
- Cloud-hosted agent execution.
- Storing complete transfer packages, worktrees, or session archives in
  Firestore.
- Replacing manual LAN pairing for desktops that are not authenticated to the
  same account.
- Changing ordinary remote task browsing or terminal control semantics.

## Product Behavior

### Automatic machine inclusion

The signed-in desktop registry is the source of cloud transfer candidates.
Kanna already subscribes to the current user's desktop documents and nested
task indexes. The transfer workspace uses that same subscription; it does not
introduce an Add Machine workflow.

Each online desktop other than the current desktop is an eligible transfer
destination when it advertises a compatible task-transfer capability and is
reachable through the relay. Offline desktops may remain visible as task
owners, but transfer actions targeting them are disabled with an offline
explanation.

`Pair Machine` remains available only for untrusted LAN peers. Cloud peers from
the authenticated account never appear in the manual pairing flow.

### Push to Machine

`Push to Machine` is available only for a locally owned, open task.

1. Kanna opens a destination picker containing compatible online desktops from
   the signed-in account and trusted LAN-only peers.
2. If the same desktop has LAN and cloud routes, it appears once.
3. Kanna uses the LAN route first and retries through the relay if the direct
   connection cannot establish before source finalization begins.
4. The source runs the existing preflight and sends the provisional payload.
5. The destination auto-claims the incoming transfer.
6. Destination approval requests source finalization. The source stops the
   agent best-effort, refreshes recovery metadata and artifacts, and returns the
   final payload.
7. The destination imports the repo, task, recovery state, and session
   artifacts into new local identities.
8. The destination acknowledges the committed import.
9. Only after acknowledgment does the source mark the transfer complete and
   close its task.

### Pull to This Machine

`Pull to This Machine` is available only for a remote-owned, open task whose
owner desktop and the current desktop are both online.

The selected task already identifies its owner, so no source-machine picker is
shown.

1. The destination sends an authenticated pull request to the source transfer
   peer containing the source-local task id and requesting desktop identity.
2. The source validates that the requester is a current same-account cloud peer
   or an explicitly trusted LAN peer and that the task is still locally owned
   and open.
3. The source emits a pull-request event to its desktop application.
4. The source application starts the ordinary push flow back to the requester.
5. The remainder of the transaction is identical to Push to Machine.

Pull is therefore a remote initiation mechanism, not a separate import
implementation.

## Architecture

### Unified transfer peer model

The desktop application builds one transfer-machine list from:

- trusted peers returned by the LAN transfer sidecar;
- compatible desktops in the signed-in cloud desktop registry; and
- active desktop ids reported by the relay.

A transfer peer descriptor contains:

- stable desktop/peer id;
- display name;
- transfer protocol version and capabilities;
- task-transfer public key;
- LAN endpoint when available;
- relay desktop id when available;
- reachability;
- trust source (`paired-lan` or `same-account-cloud`); and
- preferred transport.

Descriptors with the same stable desktop identity are merged. LAN is preferred
for the first connection attempt, while relay remains an available fallback.

### Published cloud transfer identity

Each desktop publishes non-secret transfer metadata in its existing cloud
desktop presence:

- transfer peer id;
- transfer public key;
- task-transfer protocol version; and
- task-transfer accepting/capability state.

The private transfer key never leaves the desktop transfer root. Desktop
presence updates continue through the authenticated desktop publication path,
not arbitrary client writes, so another user cannot bind a public key to a
desktop they do not own.

### Session-scoped automatic trust

The task-transfer runtime gains an external cloud-peer registry in addition to
Bonjour/registry discovery. The desktop application populates it only from the
authenticated current user's desktop registry.

Cloud peers are trusted in memory for the authenticated session. They are not
written into the durable manually paired peer store. On logout, credential
revocation, desktop removal, or public-key rotation, the application removes or
replaces the external peer immediately.

The relay independently enforces that both ends of a tunnel belong to the same
authenticated user. The transfer protocol continues to authenticate and
encrypt payloads using the published peer public keys, giving defense in depth:
the relay routes opaque bytes and cannot read task metadata or artifacts.

### Task-transfer relay tunnels

The existing relay tunnel handshake gains a service discriminator:

- `ksp` is the default and preserves all current terminal/API behavior;
- `task-transfer` carries an opaque task-transfer TCP byte stream.

For a task-transfer tunnel:

1. The initiating desktop opens a user-authenticated relay connection and
   requests the destination desktop's `task-transfer` service.
2. The relay validates same-user ownership and asks the destination
   `kanna-server` to establish that service tunnel.
3. The destination server connects only to the configured loopback transfer
   sidecar port.
4. Both desktop endpoints bridge WebSocket binary frames to the local TCP
   streams with bounded buffering and backpressure.
5. The relay forwards opaque binary frames without interpreting the
   task-transfer protocol.

The initiating Tauri process exposes a loopback-only proxy endpoint to its
transfer sidecar for each cloud peer. The sidecar sees that endpoint as an
externally discovered peer and otherwise uses its existing request, encryption,
artifact, finalization, and acknowledgment logic unchanged.

### Pull request protocol

The task-transfer protocol adds one authenticated request and event:

- destination request: source-local task id plus requester peer id;
- source response: accepted/rejected with a stable request id;
- source runtime event: pull requested by peer for task.

The listener applies the same peer-id/public-key trust validation used by
transfer preflight before emitting the event. The desktop store validates that
the requested task exists, is local, is open, and is not already transferring,
then invokes the existing push operation with the requesting peer id.

Duplicate pull requests for the same source task and requester are idempotent
while a transfer is pending.

## State And Ownership

The local `task_transfer` rows remain the operational source of truth on both
desktops. Cloud task documents reflect transfer state but do not authorize or
execute the move.

Cloud task snapshots publish the real local transfer state instead of always
publishing `none`:

- source pending/finalizing: `outgoing`;
- destination pending/importing: `incoming`;
- imported but source acknowledgment incomplete: `finalization_pending`;
- completed: ownership changes to the destination and the source task closes.

The task's stable cloud identity survives the move. The destination receives a
new local task id, branch/worktree identity, and session identity, while the
cloud index updates `ownerDesktopId` and `ownerLocalTaskId` only after the
existing import acknowledgment succeeds.

The relay publication validator accepts the defined transfer states and checks
that the associated ids are present and internally consistent. It continues to
reject malformed state and cross-user ownership changes.

## Failure Handling

- If no compatible online destination exists, the action is disabled.
- If LAN connection establishment fails before finalization, push retries once
  through the relay when a cloud route exists.
- Once source finalization begins, transport does not silently switch routes;
  the transaction fails retryably to avoid concurrent reservations.
- If a cloud tunnel disconnects before import acknowledgment, the source task
  remains open. Pending transfer state can be retried or expired.
- If destination import fails, it records the failure and does not acknowledge
  the source.
- If destination import succeeds but acknowledgment is interrupted, the
  transfer is `finalization_pending`; retrying acknowledgment is idempotent and
  must not import a duplicate destination task.
- Duplicate push, pull, finalization, and acknowledgment actions are
  single-flight and idempotent by transfer/request id.
- Logging out closes cloud transfer proxies, removes external cloud peers, and
  cancels requests that have not reached source finalization. It does not close
  source tasks.
- Relay authorization failure is surfaced as an authentication/reachability
  error and never falls back to treating a cloud peer as manually trusted.
- Public-key changes replace session trust only when delivered by a fresh,
  authenticated desktop registry update. In-flight transfers keep their
  original key binding and fail safely if it no longer validates.

## Security

- Same-account relay authorization replaces manual human pairing only for the
  cloud route.
- Relay tunnel requests cannot address desktops belonging to another user.
- The destination server exposes only a fixed `task-transfer` service mapping
  to its configured loopback sidecar port; clients cannot request arbitrary
  host/port forwarding.
- Task metadata and artifacts retain the existing end-to-end encryption between
  transfer peer keys.
- Transfer private keys, auth tokens, local paths, prompts, and artifact content
  are never published in desktop presence documents.
- Cloud trust is session-scoped and removed on logout or revocation.
- Pull requests validate both authenticated peer identity and local task
  ownership before initiating transfer.

## User Interface

- The existing machine picker shows one row per eligible destination.
- Rows may describe reachability as `Nearby`, `Cloud`, or `Nearby · Cloud`.
- No paired/unpaired badge is shown for same-account cloud desktops.
- `Pair Machine` lists only untrusted LAN peers.
- `Push to Machine` is driven by the selected workspace task's
  `canPushToMachine` capability.
- `Pull to This Machine` is driven by `canPullFromMachine`, requires a reachable
  owner route, and acts directly on that owner.
- Both actions show a single pending state and ignore repeated activation.
- Errors leave the task selected and show a concise retryable toast.

## Testing

### Unit tests

- Merge LAN and cloud descriptors by stable desktop identity.
- Prefer LAN and preserve relay fallback for a dual-route desktop.
- Automatically trust compatible same-account cloud peers without durable
  pairing.
- Remove external peers on logout, desktop removal, or key replacement.
- Exclude the current desktop, offline desktops, and incompatible protocol
  versions from eligible destinations.
- Expose Push only for locally owned tasks and Pull only for reachable
  remote-owned tasks.
- Publish valid outgoing, incoming, and finalization-pending cloud states.
- Reject duplicate UI actions while a transfer is in flight.

### Task-transfer runtime tests

- Register and remove external cloud peers.
- Accept encrypted protocol requests through an injected proxy endpoint.
- Accept a pull request from a trusted external peer.
- Reject untrusted, mismatched-key, malformed-task-id, and duplicate pull
  requests.
- Preserve existing transfer finalization, artifact fetch, import
  acknowledgment, and source-commit behavior over the proxy transport.

### Relay integration tests

- Open a `task-transfer` tunnel between two desktops owned by the same user.
- Reject task-transfer tunnels across users.
- Reject unknown service names and arbitrary destination ports.
- Preserve existing KSP tunnel behavior when the service field is absent.
- Forward binary frames bidirectionally with backpressure and bounded queues.
- Close both halves when either tunnel endpoint disconnects.

### Desktop end-to-end tests

Run two signed-in desktop instances against Firebase emulators and the local
relay:

1. Both desktops and their remote tasks appear automatically without pairing.
2. Push a local task to the other desktop and verify destination import,
   provenance, cloud owner update, source completion, and source closure.
3. Select the resulting remote-owned task from the other instance, pull it
   back, and verify the same ownership invariants in reverse.
4. Verify a shared repo, remote clone, and bundle-backed repo acquisition path.
5. Interrupt destination import and verify the source task remains open.
6. Interrupt acknowledgment after import and verify retry does not duplicate
   the destination task.
7. Log out and verify cloud machines disappear from transfer actions while
   manually paired LAN peers remain governed by their existing trust.

The existing LAN transfer E2E suite remains green to prove the transport
extension did not regress direct transfers.

## Success Criteria

- Signed-in desktops automatically become eligible transfer machines without
  Add Machine or manual pairing.
- A local task can be pushed to another online same-account desktop.
- A remote-owned task can be pulled to the current desktop.
- Both operations move ownership and leave only the destination task active
  after acknowledgment.
- Source tasks remain open on pre-acknowledgment failure.
- LAN is preferred when available and cloud relay works when desktops are not
  on the same network.
- Cross-user transfer tunnels and untrusted pull requests are rejected.
- Transfer payloads remain end-to-end encrypted over the relay.
