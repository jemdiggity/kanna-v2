# Remote Task Read Dwell Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind LAN task snapshots to trusted peers, give every LAN task a collision-free presentation ID, and make activity-revision migration 029 safe and upgrade-tested.

**Architecture:** Treat the queried paired endpoint as the authoritative LAN owner and reject responses that claim another peer. Derive LAN presentation IDs from a structured tuple of trusted peer, stable local repository, and owner-local task identity. Make column addition explicitly idempotent and fallible so migration transactions roll back on unexpected SQLite errors, then exercise the exact origin/main-to-029 upgrade path.

**Tech Stack:** Rust, Tokio, rusqlite/SQLite, Vue 3 TypeScript services, Vitest, pnpm

---

### Task 1: Bind task snapshots to the queried trusted peer

**Files:**
- Modify: `crates/task-transfer/tests/runtime.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`

- [ ] **Step 1: Write the failing spoofed-peer regression**

Add a Tokio integration test using the existing fake-listener, registry-entry,
and `PeerStore` patterns. Register and trust `peer-target`, then have that
endpoint respond to `GetTaskSnapshot` with the matching request ID but a
different claimed peer:

```rust
let response = json!({
    "type": "task_snapshot",
    "request_id": request_id,
    "peer_id": "peer-victim",
    "display_name": "Victim",
    "snapshot": {
        "tasks": [{
            "localRepoId": "repo-1",
            "ownerLocalTaskId": "task-victim",
            "activityRevision": 7
        }]
    }
});

let snapshots = primary.list_peer_task_snapshots().await.unwrap();
assert!(
    snapshots.is_empty(),
    "a paired endpoint must not publish snapshots under another peer identity"
);
```

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
cargo test -p kanna-task-transfer --test runtime list_peer_task_snapshots_rejects_spoofed_response_peer_id -- --nocapture
```

Expected: FAIL because the returned snapshot currently carries
`peer-victim`.

- [ ] **Step 3: Reject a mismatched response identity**

In `list_peer_task_snapshots`, keep the trusted discovered `peer` in scope,
rename the response field, and exclude a mismatched response while allowing the
loop to query other peers:

```rust
PeerResponse::TaskSnapshot {
    request_id: response_request_id,
    peer_id: response_peer_id,
    display_name,
    snapshot,
} => {
    if response_request_id != request_id {
        continue;
    }
    if response_peer_id != peer.peer_id {
        eprintln!(
            "[task-transfer] peer {} returned task snapshot for mismatched peer {}",
            peer.peer_id, response_peer_id
        );
        continue;
    }
    snapshots.push(PeerTaskSnapshot {
        peer_id: peer.peer_id,
        display_name,
        snapshot,
    });
}
```

- [ ] **Step 4: Run the focused runtime regression and suite**

Run:

```bash
cargo test -p kanna-task-transfer --test runtime list_peer_task_snapshots_rejects_spoofed_response_peer_id -- --nocapture
cargo test -p kanna-task-transfer --test runtime
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/task-transfer/src/runtime/lifecycle.rs crates/task-transfer/tests/runtime.rs
git commit -m "fix(task-transfer): bind snapshots to queried peers"
```

### Task 2: Give every LAN task a collision-free presentation ID

**Files:**
- Modify: `apps/desktop/src/services/desktopLanTaskIndex.ts`
- Modify: `apps/desktop/src/services/desktopLanTaskIndex.test.ts`

- [ ] **Step 1: Write the failing multi-task mapping regression**

Import `listDesktopLanTasks`. Mock `list_transfer_task_snapshots` to return two
tasks from one trusted peer, both without `cloudTaskId`, with different
owner-local task IDs and activity revisions:

```typescript
mocks.invoke.mockImplementation(async (command: string) => {
  if (command === "list_transfer_task_snapshots") {
    return [{
      peer_id: "peer-owner",
      snapshot: {
        tasks: [
          remoteTask("task-a", 4),
          remoteTask("task-b", 9),
        ],
      },
    }];
  }
  return null;
});

const snapshot = await listDesktopLanTasks({ currentDesktopId: "peer-local" });
expect(snapshot.items).toHaveLength(2);
expect(new Set(snapshot.items.map((item) => item.id)).size).toBe(2);

for (const item of snapshot.items) {
  const ref = snapshot.terminalRefs[item.id];
  expect(ref.transport).toBe("lan");
  expect(ref.ownerDesktopId).toBe("peer-owner");
  expect(item.activity_revision).toBe(
    ref.ownerLocalTaskId === "task-a" ? 4 : 9,
  );
}
```

The `remoteTask` fixture supplies the complete `DesktopCloudTaskSnapshot`
shape, including `localRepoId: "repo-1"`, `ownerDesktopId: "spoofed"`,
`ownerLocalTaskId`, repository metadata, timestamps, and the requested
`activityRevision`.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
pnpm --dir apps/desktop test -- src/services/desktopLanTaskIndex.test.ts
```

Expected: FAIL because both items currently map from
`lan:peer-owner:undefined`.

- [ ] **Step 3: Derive identity from the bound peer and local tuple**

Add a focused helper that uses a structured tuple encoding, including the
backward-compatible repository fallback:

```typescript
function lanTaskPresentationId(
  peerId: string,
  task: DesktopCloudTaskSnapshot,
): string {
  const localRepoId = task.localRepoId ?? task.repo.cloudRepoId;
  return `lan:${JSON.stringify([
    peerId,
    localRepoId,
    task.ownerLocalTaskId,
  ])}`;
}
```

Use the trusted envelope peer and overwrite both owner and presentation ID:

```typescript
tasks.push({
  ...task,
  cloudTaskId: lanTaskPresentationId(peerId, task),
  ownerDesktopId: peerId,
});
```

- [ ] **Step 4: Run the focused LAN and shared cloud-index suites**

Run:

```bash
pnpm --dir apps/desktop test -- src/services/desktopLanTaskIndex.test.ts src/services/desktopCloudTaskIndex.test.ts
```

Expected: PASS with distinct item IDs and correctly paired terminal refs and
activity revisions.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/services/desktopLanTaskIndex.ts apps/desktop/src/services/desktopLanTaskIndex.test.ts
git commit -m "fix(desktop): derive stable LAN task identities"
```

### Task 3: Make migration 029 fail safely and prove the real upgrade path

**Files:**
- Create: `crates/kanna-server/src/db/fixtures/origin_main_028.sql`
- Modify: `crates/kanna-server/src/db/mod.rs`
- Modify: `crates/kanna-server/src/db/tests.rs`
- Modify: `packages/db/src/migrations.test.ts`

- [ ] **Step 1: Add the origin/main-era database fixture**

Copy the `repo`, `pipeline_item`, and `settings` definitions from
`origin/main:packages/db/src/migrations/001_initial.sql`, preserving the
absence of `activity_revision`. Add `schema_migrations` plus one visible
repository and task:

```sql
CREATE TABLE schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO repo (id, path, name)
VALUES ('repo-upgrade', '/tmp/repo-upgrade', 'Upgrade Repo');

INSERT INTO pipeline_item (
  id, repo_id, prompt, stage, activity, branch, agent_type
) VALUES (
  'task-upgrade', 'repo-upgrade', 'upgrade prompt', 'in progress',
  'idle', 'task-upgrade', 'pty'
);
```

Use Rust to insert `CURRENT_SCHEMA_MIGRATIONS[..len - 1]` after loading the SQL
fixture, avoiding a duplicated hard-coded migration list.

- [ ] **Step 2: Write failing migration safety and upgrade regressions**

Add a focused helper test proving an unexpected `ALTER TABLE` error is returned
and not mistaken for an existing column:

```rust
let conn = Connection::open_in_memory().expect("open db");
conn.execute_batch("CREATE TABLE probe (id TEXT PRIMARY KEY);")
    .expect("create probe");
let error = super::add_column(&conn, "probe", "broken", "TEXT DEFAULT (")
    .expect_err("invalid ALTER TABLE must propagate");
assert!(error.to_string().contains("syntax error"));
```

Add an upgrade-path test that loads the fixture, records migrations through
028, and opens it through `Db::open_migrated`. Assert:

```rust
let column: (String, i64, Option<String>) = db.conn.query_row(
    "SELECT type, \"notnull\", dflt_value
       FROM pragma_table_info('pipeline_item')
      WHERE name = 'activity_revision'",
    [],
    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
).expect("activity revision column");
assert_eq!(column, ("INTEGER".into(), 1, Some("0".into())));

let item = db.get_pipeline_item("task-upgrade").unwrap().unwrap();
assert_eq!(item.activity_revision, 0);

let snapshot = db.ui_snapshot().expect("ui snapshot");
let snapshot_item = snapshot.entries.iter()
    .flat_map(|entry| &entry.items)
    .find(|item| item.id == "task-upgrade")
    .expect("upgraded task in snapshot");
assert_eq!(snapshot_item.activity_revision, 0);
```

Drop and reopen the database, assert exactly one
`029_pipeline_item_activity_revision` record, call
`update_pipeline_item_activity("task-upgrade", "working")`, and assert the
loaded revision is `1`.

Strengthen the package initial-schema test so it expects
`activity`, `activity_revision INTEGER NOT NULL DEFAULT 0`, and
`activity_changed_at` in that order.

- [ ] **Step 3: Run the regressions and verify RED**

Run:

```bash
cargo test -p kanna-server db::tests::add_column_propagates_unexpected_alter_errors -- --nocapture
cargo test -p kanna-server db::tests::open_migrates_origin_main_028_activity_revision -- --nocapture
pnpm --dir packages/db test -- src/migrations.test.ts
```

Expected: the Rust tests fail because `add_column` returns `()` and migration
029 is not yet safely implemented. The package schema assertion already passes
against the fresh-install schema.

- [ ] **Step 4: Make add-column idempotence explicit and fallible**

Change `add_column` to return `Result<(), rusqlite::Error>`. Query
`pragma_table_info` for the exact column before altering:

```rust
fn add_column(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), rusqlite::Error> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2",
            [table, column],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        return Ok(());
    }

    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    conn.execute_batch(&sql)
}
```

Update every migration call site to use `?`. Keep `drop_column` unchanged.
`run_migration` will then roll back and omit the migration record for any
unexpected add-column failure.

- [ ] **Step 5: Run focused database and package tests**

Run:

```bash
cargo test -p kanna-server db::tests::add_column_propagates_unexpected_alter_errors -- --nocapture
cargo test -p kanna-server db::tests::open_migrates_origin_main_028_activity_revision -- --nocapture
cargo test -p kanna-server db::tests
pnpm --dir packages/db test -- src/migrations.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/kanna-server/src/db/mod.rs crates/kanna-server/src/db/tests.rs crates/kanna-server/src/db/fixtures/origin_main_028.sql packages/db/src/migrations.test.ts
git commit -m "fix(server): harden activity revision migration"
```

### Task 4: Integrated verification

**Files:**
- Verify all files changed in Tasks 1-3.

- [ ] **Step 1: Run formatting**

```bash
cargo fmt --all -- --check
pnpm exec prettier --check apps/desktop/src/services/desktopLanTaskIndex.ts apps/desktop/src/services/desktopLanTaskIndex.test.ts packages/db/src/migrations.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run all focused suites together**

```bash
cargo test -p kanna-task-transfer --test runtime
cargo test -p kanna-server db::tests
pnpm --dir apps/desktop test -- src/services/desktopLanTaskIndex.test.ts src/services/desktopCloudTaskIndex.test.ts
pnpm --dir packages/db test -- src/migrations.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run repository-level practical checks**

```bash
pnpm test
./kd test rust
```

Expected: PASS, or report any unrelated pre-existing failure with its exact
command and output.

- [ ] **Step 4: Inspect the final diff**

```bash
git status --short
git diff --check HEAD~3
git log --oneline -4
```

Expected: only the approved spec, plan, implementation, and regression changes
are present; there are no whitespace errors.

### Task 5: Complete App-level dwell and route interactions

**Files:**
- Modify: `apps/desktop/src/App.test.ts`

**Interfaces:**
- Consumes: `useRemoteTaskReadDwell`'s selected slot, owner tuple, activity
  revision, and deadline behavior.
- Produces: App-level regressions for selection replacement, revision changes,
  and current cloud/LAN routing.

- [ ] **Step 1: Extend replacement selection through its full deadline**

After selecting the second task at 600 ms, assert no call at the first task's
1,000 ms deadline, then advance another 600 ms and assert exactly one relay
call for the second owner-local task and revision 7.

- [ ] **Step 2: Add the revision 7-to-8 interaction**

Select an unread revision-7 task, advance 600 ms, publish the same selected
owner as unread revision 8, and assert the old deadline does not fire. Advance
the remaining 600 ms and assert the only mark-read carries revision 8.

- [ ] **Step 3: Add preferred-route addition and removal interactions**

Arm dwell halfway between LAN polling ticks. Add the coherent LAN
advertisement during one dwell and remove it during another. In both cases
assert the presentation slot is unchanged, no fresh dwell is required, and
the action at the original deadline uses the route current at that deadline.

- [ ] **Step 4: Run the App regressions**

```bash
pnpm --dir apps/desktop test -- src/App.test.ts
```

Expected: replacement and revision cases pass against the observation tuple;
route cases fail only if the workspace route change incorrectly resets dwell
or the action captures a stale transport.

### Task 6: Expire never-settling mark-read actions

**Files:**
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`

**Interfaces:**
- Consumes: `DesktopRelayTerminalClient.close()`, which closes all owned
  `StreamClient` instances and rejects their pending requests.
- Produces: a ten-second action deadline and exact-once client cleanup.

- [ ] **Step 1: Write the never-settling action regression**

Make `markTaskRead` return a promise that never settles. After dwell fires,
advance beyond the action deadline and assert the client closes once. Unmount
the app and assert it is still closed only once.

- [ ] **Step 2: Run the regression and verify RED**

```bash
pnpm --dir apps/desktop test -- src/App.test.ts
```

Expected: FAIL because the active client remains retained until app teardown.

- [ ] **Step 3: Race the action with a bounded expiry**

Add a ten-second timer around the mark-read promise. Reject with a focused
timeout error, clear the timer in all paths, and retain the existing `finally`
cleanup so success, failure, timeout, and disposal close exactly once.

- [ ] **Step 4: Re-run the App suite**

```bash
pnpm --dir apps/desktop test -- src/App.test.ts
```

Expected: PASS.

### Task 7: Guard cloud one-shot commits by auth and subscription state

**Files:**
- Modify: `apps/desktop/src/App.test.ts`
- Modify: `apps/desktop/src/composables/useAppCloudWorkspace.ts`

**Interfaces:**
- Produces: `cloudSubscriptionGeneration` and `cloudSnapshotRevision`
  invalidation counters owned by the cloud workspace composable.

- [ ] **Step 1: Add deferred one-shot regressions**

Start with a deferred `listDesktopCloudTasks`. Publish a newer subscription
snapshot before resolving the one-shot and assert the newer task remains.
Repeat with sign-out before resolution and assert the task list stays empty.
Finally switch from UID A to UID B, commit UID B's subscription snapshot, and
prove UID A's deferred one-shot cannot replace it.

- [ ] **Step 2: Run the regressions and verify RED**

```bash
pnpm --dir apps/desktop test -- src/App.test.ts
```

Expected: FAIL because the older one-shot currently commits unconditionally.

- [ ] **Step 3: Version subscription and snapshot commits**

Start the live subscription before the one-shot. Capture UID, subscription
generation, and snapshot revision before awaiting the one-shot; commit only if
the auth state, subscribed UID, generation, and revision still match. Increment
the generation when subscriptions stop/start and the revision whenever live or
signed-out state commits.

- [ ] **Step 4: Re-run the App suite**

```bash
pnpm --dir apps/desktop test -- src/App.test.ts
```

Expected: PASS.

### Task 8: Reject stale cross-connection publications

**Files:**
- Modify: `crates/kanna-server/src/cloud_task_publisher.rs`
- Modify: `crates/kanna-server/src/relay.rs`
- Modify: `services/relay/src/index.ts`
- Modify: `services/relay/src/cloudTaskPublication.ts`
- Modify: `services/relay/test/cloudTaskPublication.test.ts`

**Interfaces:**
- Produces: `CloudTaskPublicationStore.beginSession({ userId, desktopId })`
  returning a positive safe-integer generation.
- Consumes: that generation in every `reconcile` call and guarded Firestore
  transaction.

- [ ] **Step 1: Add publisher and relay fault regressions**

In Rust, time out an unacknowledged publish, disconnect, authenticate again,
and prove the same publisher lifecycle emits the latest snapshot. Drive the
production reconnect loop against a fake WebSocket relay so moving publisher
state back inside that loop breaks the regression. In an emulator-backed relay
test, use the production Firestore store to delay an old generation after its
metadata claim, let a new session and publication complete, then assert the
delayed task transaction is rejected and the newer activity remains.

- [ ] **Step 2: Run the regressions and verify RED**

```bash
cargo test -p kanna-server cloud_task_publisher::tests -- --nocapture
pnpm --dir services/relay test -- test/cloudTaskPublication.test.ts
```

Expected: the delayed publication regression fails because reconciliation has
no generation contract.

- [ ] **Step 3: Retain publisher state across reconnects**

Move `PublisherState::new()` outside the relay reconnection loop. Keep
`on_disconnected()` at connection teardown so in-flight requests and retry
timers reset while the latest observed snapshot and publisher lifecycle remain.

- [ ] **Step 4: Lease a generation during server authentication**

Before registering a non-tunnel desktop-credential connection, revalidate its
desktop-scoped proof and transactionally increment the canonical desktop
document's `publicationGeneration`. Store the returned generation on the
WebSocket handler and pass it with every publication. Authentication fails
closed if revalidation or the lease fails. Legacy account-scoped device-token
connections retain their command compatibility but receive no publication
generation and cannot mutate desktop publication state.

- [ ] **Step 5: Guard every reconciliation transaction**

Claim desktop metadata only when the supplied generation is still current.
Read the current generation in the same Firestore transaction as every task
set/delete chunk and duplicate cleanup delete. Throw a stale-publication error
when a newer connection has superseded the caller.

- [ ] **Step 6: Run focused server and relay suites**

```bash
cargo test -p kanna-server cloud_task_publisher::tests -- --nocapture
pnpm --dir services/relay test -- test/cloudTaskPublication.test.ts
pnpm --dir services/relay build
```

Expected: PASS.

### Task 9: Follow-up integrated verification

**Files:**
- Verify all files changed in Tasks 5-8.

- [ ] **Step 1: Run formatting and focused suites**

```bash
cargo fmt --all -- --check
pnpm exec prettier --check apps/desktop/src/App.test.ts apps/desktop/src/composables/useAppCloudWorkspace.ts services/relay/src/index.ts services/relay/src/cloudTaskPublication.ts services/relay/test/cloudTaskPublication.test.ts
pnpm --dir apps/desktop test -- src/App.test.ts src/composables/useRemoteTaskReadDwell.test.ts src/workspace/buildWorkspace.test.ts
cargo test -p kanna-server cloud_task_publisher::tests -- --nocapture
pnpm --dir services/relay test -- test/cloudTaskPublication.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository checks**

```bash
pnpm test
./kd test rust
```

Expected: PASS, or report exact unrelated failures.

- [ ] **Step 3: Inspect the final diff**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: only the approved follow-up docs, implementation, and regressions are
present, with no whitespace errors.
