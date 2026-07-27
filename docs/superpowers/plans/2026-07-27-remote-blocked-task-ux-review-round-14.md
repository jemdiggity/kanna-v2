# Remote Blocked Task UX Review Round 14 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all seven round-14 review findings while preserving the
replacement PR's remote blocked-task and terminal behavior.

**Architecture:** Explicit desktop, importer, and renderer authority gates fence
privileged mutations. Artifact transfer moves from whole-value JSON encryption
to bounded authenticated chunks with durable owned-file cleanup. Legacy v1 KSP
is retained only as a read-only upgrade bridge.

**Tech Stack:** Vue 3, TypeScript/Vitest, Rust, Tokio, Axum, Tauri v2,
SQLite/rusqlite, XChaCha20-Poly1305.

---

### Task 1: Secure LAN-exposed privileged routes

**Files:**
- Modify: `crates/kanna-server/src/http_api/lan_trust.rs`
- Modify: `crates/kanna-server/src/http_api/router.rs`
- Modify: `crates/kanna-server/src/http_api/settings.rs`
- Modify: `crates/kanna-server/src/http_api/cloud_relay.rs`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs`

- [ ] Add failing real non-loopback identity/reconnect denial tests and generic
  reserved-setting bypass tests.
- [ ] Add direct desktop-local and authenticated privileged extractors.
- [ ] Reject generic mutation/deletion of `cloud_transfer_identity_v1`.
- [ ] Run focused HTTP route tests.

### Task 2: Preserve a secure previous-mobile upgrade path

**Files:**
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Test: `crates/kanna-server/src/ksp.rs`

- [ ] Add a failing previous-mobile-to-current-desktop non-loopback websocket
  test covering read attachment and mutation denial.
- [ ] Add an explicit legacy read-only auth mode for empty v1 auth.
- [ ] Keep paired v1 and authenticated v2 clients fully capable.
- [ ] Run focused KSP tests.

### Task 3: Stream artifacts with bounded memory and authenticated chunks

**Files:**
- Modify: `crates/task-transfer/src/crypto.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/peer.rs`
- Modify: `crates/task-transfer/src/runtime/transfers.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [ ] Add failing oversize-before-read, multi-chunk, truncation, and tamper
  regressions.
- [ ] Add sequence/final-bound incremental XChaCha20-Poly1305 helpers.
- [ ] Stream fixed-size chunks with Tokio file I/O and enforce 128 MiB metadata
  before opening the source.
- [ ] Remove whole-artifact base64/JSON buffering.
- [ ] Run focused artifact and crypto tests.

### Task 4: Delete owned artifacts on every terminal path

**Files:**
- Modify: `apps/desktop/src/stores/transfer.ts`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/utils.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/transfers.rs`
- Test: `apps/desktop/src/stores/kannaTransfer.test.ts`
- Test: `crates/task-transfer/tests/runtime.rs`

- [ ] Add failing success, failure, TTL, shutdown, startup, and borrowed-file
  preservation tests.
- [ ] Pass an owned flag for generated archives/bundles and persist owned
  artifact records.
- [ ] Centralize async removal and invoke it from every terminal/prune path.
- [ ] Reconcile persisted orphan records during runtime startup.
- [ ] Run focused desktop and task-transfer cleanup tests.

### Task 5: Fence incoming failure and cleanup by claim owner

**Files:**
- Modify: `crates/kanna-server/src/db/transfers.rs`
- Modify: `crates/kanna-server/src/http_api/transfers.rs`
- Modify: `apps/desktop/src/services/desktopServerClient.ts`
- Modify: `apps/desktop/src/composables/useAppTaskTransfer.ts`
- Test: `crates/kanna-server/src/db/tests.rs`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Test: `apps/desktop/src/composables/useAppTaskTransfer.test.ts`

- [ ] Add a failing old-owner takeover/failure/cleanup regression.
- [ ] Require a matching token for claimed-row failure while retaining
  tokenless malformed-pending failure.
- [ ] Carry the original importer token into terminal failure and clean only
  after the fenced update succeeds.
- [ ] Run focused database, HTTP, and composable tests.

### Task 6: Fence mutating renderer lifecycle handlers

**Files:**
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`
- Modify: `apps/desktop/src/stores/transfer.ts`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Test: `apps/desktop/src/App.test.ts`
- Test: `apps/desktop/src/stores/kannaTransfer.test.ts`
- Test: `apps/desktop/src-tauri/src/transfer_sidecar.rs`

- [ ] Add failing owner-loss-during-commit and
  owner-loss-during-finalization tests.
- [ ] Revalidate delivery ownership before every irreversible store phase.
- [ ] Gate delivery-sensitive sidecar commands with the current lease owner.
- [ ] Abort stale handlers and allow retained-event redelivery.
- [ ] Run focused lifecycle/store/Tauri tests.

### Task 7: Stabilize reconnect and verify the branch

**Files:**
- Modify: `crates/daemon/tests/reconnect.rs`
- Review: complete branch diff against `origin/main`

- [ ] Change the READY assertion to accept initial Snapshot or later Output
  while retaining respawn survival.
- [ ] Run the focused reconnect test repeatedly.
- [ ] Run all focused suites, desktop build/typecheck, `pnpm test`, and
  `./kd test rust`.
- [ ] Review the complete diff for original blocker UX plus current terminal,
  read-dwell, file-link, lifecycle-response, and workspace-projection behavior.
- [ ] Commit and record successful Kanna stage completion with a replacement-PR
  summary that explicitly supersedes #921.

