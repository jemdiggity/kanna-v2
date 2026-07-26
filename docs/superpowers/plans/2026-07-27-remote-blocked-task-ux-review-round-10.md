# Remote Blocked Task UX Review Round 10 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`
> based on task coupling, subagent availability, and whether execution should
> stay in the current session. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Close the tenth set of reviewer findings with safe artifact
materialization, bounded cloud setup, single-owner reliable lifecycle
delivery, and deployed-mobile stream compatibility.

**Architecture:** Validate peer payloads before persistence, move session
artifact mutation behind a provider-aware no-follow Rust boundary, bound both
ends of cloud tunnel setup, claim one ready renderer and queue failed
deliveries, and preserve v1 while enforcing auth on v2.

**Tech Stack:** Vue 3, TypeScript, Vitest, Rust, Tokio, Tauri v2, Axum, Node
WebSocket relay.

---

### Task 1: Validate and securely materialize session artifacts

**Files:**
- Modify: `apps/desktop/src/utils/taskTransfer.ts`
- Test: `apps/desktop/src/utils/taskTransfer.test.ts`
- Modify: `apps/desktop/src/stores/transfer.ts`
- Test: `apps/desktop/src/stores/kannaTransfer.test.ts`
- Create: `apps/desktop/src-tauri/src/transfer_artifact.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/Cargo.toml`

- [ ] Add parser tests for `../`, absolute, wrong-provider, wrong-session, and
  wrong-materialization artifact payloads; run them and confirm the current
  cast-based parser accepts them.
- [ ] Add Rust tests whose provider root or intermediate destination is a
  symlink and whose archives contain `..`, absolute paths, links, special
  entries, or a wrong top-level session; run them and confirm the secure
  materializer is absent.
- [ ] Parse every task/repo/artifact field, require the provider artifact
  contract, and compare legacy `home_rel_path` with the derived canonical
  relative path.
- [ ] Implement
  `materialize_transfer_artifact(source_path, provider, resume_session_id,
  filename, kind, materialization) -> Result<bool, String>` with descriptor
  relative no-follow traversal, bounded in-process archive validation, private
  extraction, and no-replace publication.
- [ ] Replace renderer `HOME` concatenation plus `ensure_directory`,
  `copy_file`, and shell tar/mv calls with the dedicated command.
- [ ] Rerun focused TypeScript and Rust tests and confirm valid Codex, Claude,
  and Copilot imports still resume.

### Task 2: Bound cloud proxy and relay tunnel setup

**Files:**
- Modify: `apps/desktop/src-tauri/src/cloud_transfer_proxy.rs`
- Test: `apps/desktop/src-tauri/src/cloud_transfer_proxy.rs`
- Modify: `services/relay/src/router.ts`
- Test: `services/relay/test/routerBackpressure.test.ts`

- [ ] Add failing proxy tests for a saturated permit, stalled auth, stalled
  `tunnel_ready`, and local EOF during each stall.
- [ ] Add failing relay fake-timer tests for pending expiry and requester close.
- [ ] Add proxy limits containing a connection semaphore and shared setup
  deadline; race every setup phase with cancellation and local EOF.
- [ ] Store a timer in each pending relay tunnel; clear it on attach and every
  close path, and expire by deleting the record and closing the requester.
- [ ] Rerun focused proxy and relay tests.

### Task 3: Make lifecycle mutation single-owner and delivery-ready

**Files:**
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`
- Modify: `apps/desktop/src-tauri/src/commands/transfer.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src/composables/useAppLifecycle.ts`
- Test: `apps/desktop/src/App.test.ts`

- [ ] Add failing backend tests showing transfer/pull requests are
  state-mutating, no-ready-window events queue, only one ready label claims,
  failed emits retain queue order, and stale claims can be replaced.
- [ ] Add failing app tests asserting all four listeners precede the readiness
  invocation and sidecar/LAN startup.
- [ ] Add managed `TransferEventConsumerState`, claim/release commands, and
  queue-aware authoritative dispatch for transfer request, pull request,
  commit, and finalization events.
- [ ] Claim after listener registration; only then initialize auth/LAN sync and
  warm the sidecar. Release the claim during teardown.
- [ ] Rerun backend and frontend multi-window/readiness tests.

### Task 4: Restore deployed v1 mobile compatibility

**Files:**
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Test: `crates/kanna-server/src/ksp.rs`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`

- [ ] Change the existing non-loopback v1 regression to expect empty-auth
  compatibility and retain/add the corresponding v2 unauthorized regression.
- [ ] Run the focused KSP tests and confirm current shared auth selection breaks
  the compatibility assertion.
- [ ] Make legacy v1 use `AuthMode::AllowEmpty`; keep v2 peer-aware and require
  paired auth off-loopback.
- [ ] Rerun KSP and mobile stream negotiation tests.

### Task 5: Integrated verification and completion

- [ ] Run focused frontend transfer/workspace/lifecycle tests, relay tests,
  desktop Rust transfer/proxy tests, task-transfer runtime tests, and KSP
  compatibility tests.
- [ ] Run the desktop production build/typecheck.
- [ ] Run `pnpm test` and the canonical practical JavaScript verification
  exposed by `./kd`.
- [ ] Run Rust formatting, TypeScript formatting/lint surfaces where declared,
  `git diff --check`, and inspect the complete diff against `origin/main`.
- [ ] Confirm remote blocker metadata/projection/advance prevention, remote
  action failures, and current local/terminal/read-dwell/file-link behavior
  remain covered.
- [ ] Commit the revision and record Kanna stage success with a supersedes-#921
  summary and exact verification evidence.
