# Remote Blocked Task UX Review Round 15 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four round-15 task-transfer findings without changing the
replacement branch's blocked-task, terminal, workspace, or local-task behavior.

**Architecture:** Keep the deployed protocol-v2 128 MiB artifact contract while
making its whole-response implementation single-flight, bounded on the wire,
strictly shaped before allocation, and terminal on write timeout. Artifact
framing remains pinned against downgrades but accepts an authenticated explicit
legacy-to-streamed upgrade after a durable v2 preflight.

**Tech Stack:** Rust, Tokio, serde/serde_json, XChaCha20-Poly1305.

---

### Task 1: Release listener admission after stalled legacy writes

**Files:**
- Modify: `crates/task-transfer/src/runtime/config.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [ ] **Step 1: Add a failing repeated-stalled-reader regression**

Add a test-only incoming-connection limit builder and an integration test that
uses a two-slot listener, stalls two legacy artifact response writes through
successive timeouts, and then sends a normal request:

```rust
pub fn with_max_incoming_connections(mut self, maximum: usize) -> Self {
    self.max_incoming_connections = maximum.max(1);
    self
}
```

The final request must receive a response within a bounded timeout. On the
current implementation it times out because both connection permits remain in
the generic error-write path.

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
cargo test -p kanna-task-transfer --test runtime repeated_stalled_legacy_readers_do_not_exhaust_listener_admission -- --nocapture
```

Expected: FAIL because the probe request is not admitted.

- [ ] **Step 3: Terminate the connection once a legacy response write begins**

Build and seal validation errors before the response write, then return directly
from `handle_connection` around the timeout-bounded `write_json_line`:

```rust
return tokio::time::timeout(
    context.peer_request_timeout,
    write_json_line(&mut stream, &response),
)
.await
.map_err(|_| RuntimeError::PeerRequestTimeout {
    peer_id: requester_peer_id.clone(),
    timeout_ms: context.peer_request_timeout.as_millis(),
})?;
```

This prevents a timeout or partial write from falling through to the final
generic `PeerResponse::Error` write; dropping the connection releases the
enclosing listener permit.

- [ ] **Step 4: Run the focused stalled-reader tests**

Run:

```bash
cargo test -p kanna-task-transfer --test runtime stalled_legacy -- --nocapture
```

Expected: PASS.

### Task 2: Preserve downgrade rejection and monotonic upgrade

**Files:**
- Modify: `crates/task-transfer/src/runtime/utils.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Test: `crates/task-transfer/src/runtime/tests.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [ ] **Step 1: Restore a failing v2-to-v3 preflight/fetch success test**

Change
`destination_protocol_change_after_preflight_cannot_override_pinned_artifact_framing`
into a success regression: pin the destination as v2 during preflight, publish
it as v3 before commit/fetch, and assert the fetched bytes equal the staged
artifact.

- [ ] **Step 2: Run the upgrade and downgrade tests and verify the upgrade fails**

Run:

```bash
cargo test -p kanna-task-transfer --test runtime protocol_change_after_preflight -- --nocapture
cargo test -p kanna-task-transfer --test runtime downgrade -- --nocapture
```

Expected: upgrade FAIL with the current negotiated-legacy mismatch; downgrade
tests PASS.

- [ ] **Step 3: Add monotonic artifact framing negotiation**

Add an `ArtifactFraming` helper that accepts equal framing and the sole
`LegacySealedV1 -> StreamedV3` transition, while rejecting
`StreamedV3 -> LegacySealedV1`. Use it for authenticated artifact requests;
requests without the v3 field retain the pinned protocol-v2 framing.

- [ ] **Step 4: Run the focused negotiation tests**

Run:

```bash
cargo test -p kanna-task-transfer artifact_framing -- --nocapture
cargo test -p kanna-task-transfer --test runtime protocol_change_after_preflight -- --nocapture
cargo test -p kanna-task-transfer --test runtime downgrade -- --nocapture
```

Expected: PASS.

### Task 3: Restore the protocol-v2 128 MiB contract

**Files:**
- Modify: `crates/task-transfer/src/runtime/mod.rs`
- Modify: `crates/task-transfer/src/runtime/peer.rs`
- Test: `crates/task-transfer/src/runtime/tests.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [ ] **Step 1: Add failing sender and receiver limit regressions**

Assert that the legacy plaintext limit equals
`MAX_TRANSFER_ARTIFACT_BYTES`, that the source rejects a sparse
`128 MiB + 1` artifact requested by a protocol-v2 peer, and that the receiver's
numeric unpadded-base64 size check accepts the encoded length for exactly
128 MiB but rejects the first encoding above it.

- [ ] **Step 2: Run the boundary tests and verify they fail at the old 24 MiB cap**

Run:

```bash
cargo test -p kanna-task-transfer legacy_artifact_ -- --nocapture
cargo test -p kanna-task-transfer --test runtime source_rejects_artifacts_above_the_legacy -- --nocapture
```

Expected: at least the 128 MiB contract assertion FAILS.

- [ ] **Step 3: Restore the legacy plaintext limit and derive its wire bound**

Set `MAX_LEGACY_TRANSFER_ARTIFACT_BYTES` to the deployed 128 MiB constant and
derive the nested sealed-response line cap with checked integer arithmetic and
fixed metadata allowance. Keep the configurable artifact response limit
clamped to that hard cap.

- [ ] **Step 4: Run the mixed-version boundary regressions**

Run:

```bash
cargo test -p kanna-task-transfer legacy_artifact_ -- --nocapture
cargo test -p kanna-task-transfer --test runtime source_rejects_artifacts_above_the_legacy -- --nocapture
```

Expected: PASS.

### Task 4: Reject authenticated allocation amplification before `Value`

**Files:**
- Modify: `crates/task-transfer/src/crypto.rs`
- Modify: `crates/task-transfer/src/runtime/peer.rs`
- Test: `crates/task-transfer/tests/crypto.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [ ] **Step 1: Add a failing authenticated amplification regression**

Serve a correctly encrypted legacy response containing all valid fields plus a
nested object/array field. Assert artifact fetch rejects the unknown field and
does not create a destination artifact. The current broad
`serde_json::Value` path accepts and materializes it.

- [ ] **Step 2: Run the regression and verify it fails**

Run:

```bash
cargo test -p kanna-task-transfer --test runtime authenticated_legacy_artifact_response_rejects_allocation_amplification -- --nocapture
```

Expected: FAIL because the current `Value` parser accepts the extra structure.

- [ ] **Step 3: Parse bounded borrowed response shapes**

Split authenticated decryption into a byte-returning primitive and keep
`open_json` as its compatibility wrapper. For artifact fetches, deserialize the
outer line into an artifact-only borrowed enum and deserialize decrypted legacy
metadata into a `deny_unknown_fields` borrowed struct:

```rust
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyArtifactMetadata<'a> {
    request_id: Option<&'a str>,
    transfer_id: Option<&'a str>,
    artifact_id: &'a str,
    artifact_framing: Option<&'a str>,
    filename: &'a str,
    payload_b64: &'a str,
}
```

Validate identifiers, framing, filename length, and decoded payload length
before base64 allocation. Streamed metadata gets its own strict bounded shape.

- [ ] **Step 4: Run task-transfer verification**

Run:

```bash
cargo test -p kanna-task-transfer --tests -- --nocapture
cargo fmt --all -- --check
cargo clippy -p kanna-task-transfer --all-targets -- -D warnings
```

Expected: PASS.

### Task 5: Verify, review, commit, and complete the stage

**Files:**
- Review: complete diff against `origin/main`

- [ ] Run the task-transfer focused suite and canonical Rust verification.
- [ ] Run the focused frontend/workspace tests, desktop build/typecheck, and
  canonical practical JavaScript verification required by the original task.
- [ ] Review `git diff origin/main...HEAD` for the original blocker metadata,
  sidebar/panel placement, stage guard, action-error surfacing, and preserved
  local/remote terminal/read-dwell/file-link/workspace behavior.
- [ ] Commit the revision with a focused message.
- [ ] Record successful Kanna stage completion with a summary that says the
  replacement PR supersedes #921, lists the framing/compatibility/memory/admission
  decisions, and includes verification evidence.
