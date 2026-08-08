# Remote Companion Demand and Event Epochs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make companion asset materialization follow aggregate observer demand and fence selection results to the attachment that submitted them.

**Architecture:** Keep one scan source per task and drive its scanner with a zero/nonzero asset-demand watch value, discarding scans completed under obsolete demand. Carry the existing attachment epoch through selection requests and results, then require the stream client to correlate a result with a pending request from the current generation.

**Tech Stack:** Rust, Tokio watch channels, Serde/ts-rs, TypeScript, Vitest, pnpm.

---

### Task 1: Demand-aware visual companion scanner

**Files:**
- Modify: `crates/visual-companion/src/discovery.rs`
- Modify: `crates/visual-companion/src/lib.rs`
- Test: `crates/visual-companion/src/tests.rs`

- [ ] **Step 1: Write the failing assetless scanner test**

Add a Unix regression that injects an asset read failure, scans without assets,
and proves the scan remains cacheable:

```rust
#[cfg(unix)]
#[test]
fn assetless_scanner_skips_asset_payload_materialization_and_caches_the_tree() {
    let fixture = Fixture::new();
    fixture.active_session("active", "screen.html", "<h1>Screen</h1>");
    fixture.content(
        "active",
        "maximum.bin",
        vec![b'x'; MAX_COMPANION_ASSET_BYTES as usize],
    );
    let _failure = crate::discovery::inject_optional_materialization_failure_for_test(
        "maximum.bin",
        crate::discovery::OptionalFailureStage::Read,
    );
    let mut scanner = CompanionScanner::new();

    let CompanionScan::Changed(Some(bundle)) = scanner
        .scan_with_assets(fixture.worktree(), false)
        .unwrap()
    else {
        panic!("expected assetless bundle");
    };
    assert!(bundle.assets.is_empty());
    assert_eq!(scanner.materialization_count(), 1);
    assert_eq!(
        scanner
            .scan_with_assets(fixture.worktree(), false)
            .unwrap(),
        CompanionScan::Unchanged
    );
    assert_eq!(scanner.materialization_count(), 1);
}
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cargo test -p kanna-visual-companion assetless_scanner_skips_asset_payload_materialization_and_caches_the_tree
```

Expected: compilation fails because `scan_with_assets` does not exist.

- [ ] **Step 3: Implement scanner materialization choice**

Add the assetless budget and make the cache identity include demand:

```rust
pub const MAX_COMPANION_ASSETLESS_MATERIALIZED_BYTES: usize =
    MAX_COMPANION_HTML_BYTES as usize + 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CompanionFingerprint {
    metadata: [u8; 32],
    include_assets: bool,
}

pub struct CompanionScanner {
    fingerprint: Option<CompanionFingerprint>,
    materialization_budget: Option<Arc<CompanionMaterializationBudget>>,
    #[cfg(test)]
    materialization_count: usize,
}
```

Keep `scan` as the full-bundle compatibility API:

```rust
pub fn scan(&mut self, workspace: &Path) -> Result<CompanionScan, CompanionError> {
    self.scan_with_assets(workspace, true)
}
```

Move the current Unix scan body into this method, build `fingerprint` immediately
after `prepare_scan`, compare it with `self.fingerprint`, reserve
`reserved_bytes`, call `materialize_scan(prepared, include_assets)`, and assign
`Some(fingerprint)` only when the result is cacheable:

```rust
pub fn scan_with_assets(
    &mut self,
    workspace: &Path,
    include_assets: bool,
) -> Result<CompanionScan, CompanionError> {
    #[cfg(unix)]
    {
        let result = (|| {
            let root = open_workspace(workspace)?;
            let prepared = prepare_scan(&root)?;
            let fingerprint = CompanionFingerprint {
                metadata: prepared.fingerprint,
                include_assets,
            };
            if self.fingerprint == Some(fingerprint) {
                return Ok(CompanionScan::Unchanged);
            }
            #[cfg(test)]
            {
                self.materialization_count += 1;
            }
            let reserved_bytes = if include_assets {
                MAX_COMPANION_MATERIALIZED_BYTES
            } else {
                MAX_COMPANION_ASSETLESS_MATERIALIZED_BYTES
            };
            let _admission = match (&prepared.selected, &self.materialization_budget) {
                (Some(_), Some(budget)) => Some(
                    budget.try_reserve(reserved_bytes).ok_or_else(|| {
                        CompanionError::Internal(
                            "visual companion materialization budget is busy".into(),
                        )
                    })?,
                ),
                _ => None,
            };
            let materialized = materialize_scan(prepared, include_assets)?;
            if materialized.cacheable {
                self.fingerprint = Some(fingerprint);
            } else {
                self.invalidate();
            }
            Ok(CompanionScan::Changed(materialized.bundle))
        })();
        if result.is_err() {
            self.invalidate();
        }
        result
    }
    #[cfg(not(unix))]
    {
        let _ = (workspace, include_assets);
        self.invalidate();
        Err(CompanionError::Internal(
            "secure visual companion traversal is unsupported on this platform".into(),
        ))
    }
}
```

Change materialization to skip `discover_assets` entirely:

```rust
fn materialize_scan(
    prepared: PreparedScan,
    include_assets: bool,
) -> Result<MaterializedScan, CompanionError> {
    let assets = if include_assets {
        discover_assets(&selected.content, &selected.content_names)?
    } else {
        OptionalMaterialization::omitted()
    };
}
```

Place this conditional where `discover_assets` currently runs, leaving the
surrounding HTML, origin, revision fence, and bundle construction unchanged.
Call `materialize_scan(..., true)` from `current_bundle`, and export
`MAX_COMPANION_ASSETLESS_MATERIALIZED_BYTES` from `lib.rs`.

- [ ] **Step 4: Run scanner tests and verify GREEN**

Run:

```bash
cargo test -p kanna-visual-companion
```

Expected: all visual-companion tests pass.

- [ ] **Step 5: Commit scanner behavior**

```bash
git add crates/visual-companion/src/discovery.rs crates/visual-companion/src/lib.rs crates/visual-companion/src/tests.rs
git commit -m "fix: skip unrequested companion assets"
```

### Task 2: Aggregate server-side asset demand and retention

**Files:**
- Modify: `crates/kanna-server/src/visual_companion.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Test: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Write failing maximum-bundle and mixed-demand tests**

Add a maximum-bundle regression that subscribes at least three tasks with
`include_assets=false`, waits for every initial frame, and asserts every frame
is a snapshot with empty assets, no resource-limit result occurs, and
`resources.retained_bytes` stays below
`MAX_RELAY_COMPANION_RETAINED_BYTES`.

Add a mixed-demand regression using one task. Subscribe assetless, wait for a
snapshot, and assert its assets are empty. Subscribe assetful and assert
`Arc::ptr_eq(&assetless._source, &full._source)`, then wait for the shared
retained snapshot to contain the four maximum assets. Drop the assetful
subscription, wait for an empty-assets replacement, and assert retained bytes
fall below the assetless-only bound.

- [ ] **Step 2: Run the focused server tests and verify RED**

Run:

```bash
cargo test -p kanna-server assetless_maximum
cargo test -p kanna-server mixed_companion_asset_demand
```

Expected: compilation fails because `CompanionResources::subscribe` does not
accept demand, or the existing source retains full asset bundles.

- [ ] **Step 3: Pass demand through the database scanner wrapper**

Add:

```rust
pub fn scan_with_assets(
    &mut self,
    db_path: &str,
    task_id: &str,
    include_assets: bool,
) -> Result<kanna_visual_companion::CompanionScan, CompanionError> {
    let workspace = match current_workspace(db_path, task_id) {
        Ok(workspace) => workspace,
        Err(error) => {
            self.scanner.invalidate();
            return Err(error);
        }
    };
    self.scanner.scan_with_assets(&workspace, include_assets)
}
```

Keep the existing `scan` method delegating with `include_assets=true`.

- [ ] **Step 4: Implement source demand registration**

Extend `CompanionScanSource` with `asset_demand: watch::Sender<usize>`.
`subscribe(db_path, task_id, include_assets)` increments demand only for
assetful subscriptions. On the zero-to-one transition it clears the source's
current frame before waking the scanner. `CompanionScanSubscription::drop`
decrements demand and wakes the scanner only on the one-to-zero transition.

Use threshold-aware updates:

```rust
fn add_asset_observer(&self) {
    let transitioned = std::cell::Cell::new(false);
    self.asset_demand.send_if_modified(|count| {
        transitioned.set(*count == 0);
        *count = count.saturating_add(1);
        transitioned.get()
    });
    if transitioned.get() {
        self.frames.send_replace(None);
    }
}

fn remove_asset_observer(&self) {
    self.asset_demand.send_if_modified(|count| {
        debug_assert!(*count > 0);
        *count = count.saturating_sub(1);
        *count == 0
    });
}
```

- [ ] **Step 5: Fence scans against demand changes**

Pass a `watch::Receiver<usize>` into `spawn_companion_scan_source`. Before each
blocking scan capture `include_assets = *asset_demand.borrow() > 0` and call
`scanner.scan_with_assets(..., include_assets)`. After the worker returns,
compare against current demand:

```rust
if (*asset_demand.borrow() > 0) != include_assets {
    scanner.invalidate();
    continue;
}
```

Include `asset_demand.changed()` in both poll-delay selects. Extend
`PublishedCompanionState::Snapshot` with `include_assets` and pass that value
through `companion_frame_for_scan`, ensuring a demand-only rematerialization
replaces the retained frame even when revision and source origin are unchanged.

Pass the attachment's `include_assets` value from `StreamConn::attach` into
`CompanionResources::subscribe`.

- [ ] **Step 6: Run server resource tests and verify GREEN**

Run:

```bash
cargo test -p kanna-server companion
```

Expected: all companion-focused server tests pass, including the new maximum
assetless and mixed-demand regressions.

- [ ] **Step 7: Commit server demand handling**

```bash
git add crates/kanna-server/src/visual_companion.rs crates/kanna-server/src/ksp.rs
git commit -m "fix: aggregate companion asset demand"
```

### Task 3: Bind protocol and server event results to attachment epochs

**Files:**
- Modify: `crates/kanna-agent-protocol/src/frames.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Test: `crates/kanna-agent-protocol/src/frames.rs`
- Test: `crates/kanna-server/src/ksp.rs`

- [ ] **Step 1: Write failing protocol round-trip assertions**

Extend the companion event and event-result protocol tests to include:

```rust
attachment_epoch: Some(7),
```

Assert JSON contains `"attachment_epoch": 7`, and retain explicit legacy JSON
deserialization assertions where the field is absent and becomes `None`.

- [ ] **Step 2: Write the failing blocked append/reattach server regression**

Attach task `task-1` with epoch 1 and consume its initial companion frame.
Install the append gate, send a companion event with epoch 1, and wait for the
append worker to block. Detach epoch 1, reattach epoch 2, and consume the epoch
2 snapshot. Release the append gate and assert the delayed
`CompanionEventResult` is stamped with `attachment_epoch: Some(1)`, never 2.
Repeat the assertion with the ACK gate so both pre-append and post-append
delays preserve the submitting epoch.

- [ ] **Step 3: Run protocol and server regressions and verify RED**

Run:

```bash
cargo test -p kanna-agent-protocol companion
cargo test -p kanna-server companion_event_result_keeps_submitting_attachment_epoch
```

Expected: compilation fails because companion event frames do not carry
`attachment_epoch`.

- [ ] **Step 4: Add optional event epoch fields**

Add to `ClientFrame::CompanionEvent` and
`ServerFrame::CompanionEventResult`:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
#[cfg_attr(feature = "typescript", ts(type = "number"))]
attachment_epoch: Option<u64>,
```

- [ ] **Step 5: Validate and propagate epochs through the server**

Add `attachment_epoch` to `CompanionEventRequest`. Accept an event only when
the task's current companion `StreamAttachment` exists and its
`attachment_epoch` equals the submitted epoch. Emit
`companion_stale_attachment` on mismatch, stamped with the submitted epoch.

Pass the epoch through `enqueue_companion_event`,
`run_companion_event_worker`, `send_companion_event_result`, and every direct
busy, closed, rate-limited, invalid-identity, success, and failure result:

```rust
ServerFrame::CompanionEventResult {
    task_id,
    session_id: Some(session_id),
    revision: Some(revision),
    event_id,
    accepted,
    code,
    message,
    attachment_epoch,
}
```

Update all existing Rust constructors with `attachment_epoch: None` where the
test intentionally exercises the legacy form.

- [ ] **Step 6: Run Rust protocol/server tests and verify GREEN**

Run:

```bash
cargo test -p kanna-agent-protocol
cargo test -p kanna-server companion_event
```

Expected: all protocol and event-focused server tests pass.

- [ ] **Step 7: Commit protocol/server event fencing**

```bash
git add crates/kanna-agent-protocol/src/frames.rs crates/kanna-server/src/ksp.rs
git commit -m "fix: bind companion events to attachments"
```

### Task 4: Correlate stream-client results with pending generations

**Files:**
- Regenerate: `packages/agent-protocol/src/generated/ClientFrame.ts`
- Regenerate: `packages/agent-protocol/src/generated/ServerFrame.ts`
- Modify: `packages/stream-client/src/index.ts`
- Test: `packages/stream-client/src/stream-client.test.ts`

- [ ] **Step 1: Write the failing replacement event-result regression**

Add a focused replacement test that:

1. attaches at epoch 1 and sends `event-reused`;
2. detaches, reattaches at epoch 2, and sends the same event id;
3. receives an accepted result stamped epoch 1 and observes no callback;
4. receives the accepted epoch 2 result and observes exactly one callback.

Also assert the epoch 1 result did not delete epoch 2's pending request by
making the epoch 2 result deliver successfully.

- [ ] **Step 2: Run the focused client test and verify RED**

Run:

```bash
pnpm --dir packages/stream-client test -- --run stream-client.test.ts -t "event result"
```

Expected: the old result reaches the replacement handler or consumes the new
pending request.

- [ ] **Step 3: Generate protocol mirrors**

Run:

```bash
scripts/generate-agent-protocol-types.sh
```

Expected: generated client and server frame unions contain optional
`attachment_epoch` on companion events and results.

- [ ] **Step 4: Store and send the attachment generation**

Extend `PendingCompanionEvent`:

```ts
interface PendingCompanionEvent {
  taskId: string;
  sessionId: string;
  revision: string;
  attachmentGeneration: number;
}
```

In `sendCompanionEvent`, require a current companion attachment, send
`attachment_epoch: attachment.generation`, and store that generation with the
pending request.

- [ ] **Step 5: Validate before deleting pending results**

In the `companion_event_result` dispatch:

```ts
const attachment = this.companionAttachment(frame.task_id);
const key = companionEventKey(frame.task_id, frame.event_id);
const pending = this.pendingCompanionEvents.get(key);
if (!pending || !attachment) return;
if (
  pending.attachmentGeneration !== attachment.generation ||
  !this.companionFrameMatchesAttachment(frame.attachment_epoch, attachment)
) {
  return;
}
this.pendingCompanionEvents.delete(key);
```

Only after these checks derive session/revision and invoke `onEventResult`.
This ordering preserves a newer same-ID pending request when an old result
arrives.

- [ ] **Step 6: Run stream-client tests and type generation checks**

Run:

```bash
pnpm --dir packages/stream-client test
scripts/check-agent-protocol-types.sh
```

Expected: all stream-client tests pass and generated types are current.

- [ ] **Step 7: Commit client event fencing**

```bash
git add packages/agent-protocol/src/generated/ClientFrame.ts packages/agent-protocol/src/generated/ServerFrame.ts packages/stream-client/src/index.ts packages/stream-client/src/stream-client.test.ts
git commit -m "fix: discard superseded companion results"
```

### Task 5: Cross-package verification

**Files:**
- Verify all files changed by Tasks 1–4

- [ ] **Step 1: Check formatting and generated sources**

```bash
cargo fmt --all -- --check
scripts/check-agent-protocol-types.sh
```

Expected: both commands exit 0.

- [ ] **Step 2: Run complete focused Rust suites**

```bash
cargo test -p kanna-visual-companion
cargo test -p kanna-agent-protocol
cargo test -p kanna-server
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run complete stream-client suite**

```bash
pnpm --dir packages/stream-client test
```

Expected: all tests pass with zero failures.

- [ ] **Step 4: Inspect final patch**

```bash
git status --short
git diff --check HEAD^
git diff --stat HEAD^
```

Expected: only the approved companion scanner, protocol, server, generated
types, tests, and design/plan documents are changed; diff check reports no
whitespace errors.
