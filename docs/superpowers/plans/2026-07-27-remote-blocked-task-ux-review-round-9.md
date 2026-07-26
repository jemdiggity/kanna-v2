# Remote Blocked Task UX Review Round 9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` because the protocol, compatibility, and
> lifecycle changes share runtime state. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Resolve the ninth review round's six findings with authenticated,
bounded, compatible, and idempotent remote task behavior.

**Architecture:** Require paired auth for every non-loopback KSP endpoint,
bound task-transfer listener admission, keep cloud routes out of LAN polling,
negotiate mobile stream epochs through status, route lifecycle work to one
renderer, and coalesce finalization by transfer id.

**Tech Stack:** Rust, Tokio, Axum, Tauri v2, Vue 3, TypeScript, Vitest.

---

### Task 1: KSP endpoint auth and mobile negotiation

**Files:**
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/http_api/tests/revision_status.rs`
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `apps/mobile/src/lib/api/types.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`

- [x] Add a real non-loopback `/v1/stream` regression that sends empty auth and
  expects `unauthorized`.
- [x] Add status serialization and current-mobile/previous-server tests that
  expect v2 only when `kspStreamVersion: 2` is advertised.
- [x] Run the KSP/status and mobile LAN transport tests and confirm they fail
  for the missing boundary/capability.
- [x] Apply the shared peer-address auth selector to v1 and v2, advertise v2,
  and cache the negotiated stream path in the LAN transport.
- [x] Rerun the focused tests and confirm they pass.

### Task 2: Bounded task-transfer listener

**Files:**
- Modify: `crates/task-transfer/src/runtime/config.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [x] Add slowloris, oversized-frame, and one-permit admission regressions with
  short test-only limits.
- [x] Run the focused runtime tests and confirm the unbounded listener fails
  them.
- [x] Add config-backed connection permits, pre-auth read timeout, and bounded
  newline framing before JSON parsing.
- [x] Rerun the focused tests and confirm they pass.

### Task 3: Keep cloud routes out of LAN polling

**Files:**
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [x] Add a regression that registers a durable peer plus cloud-only external
  proxy, calls snapshot listing repeatedly, and observes zero proxy accepts.
- [x] Run it and confirm the merged peer listing contacts the proxy.
- [x] Source snapshot candidates from LAN discovery while preserving merged
  `list_peers()` behavior for transfer routing.
- [x] Rerun the regression and neighboring snapshot tests.

### Task 4: Route lifecycle events to one webview

**Files:**
- Modify: `apps/desktop/src-tauri/src/transfer_sidecar.rs`

- [x] Add a multi-window target-selection regression covering `main`
  preference, deterministic fallback, and no-window behavior.
- [x] Run it and confirm no single-consumer selector exists.
- [x] Emit receipt/finalization events only to the selected webview while
  retaining informational event broadcast behavior.
- [x] Rerun transfer-sidecar tests.

### Task 5: Coalesce finalization retries

**Files:**
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/transfers.rs`
- Test: `crates/task-transfer/tests/runtime.rs`

- [x] Add a slow-finalization retry regression where the first requester times
  out, a duplicate joins, one desktop event completes both, and a later retry
  receives the cache.
- [x] Run it and confirm duplicate insertion emits twice or loses a waiter.
- [x] Replace the sender map with pending waiters/cached result state, make
  completion idempotent, and clear state on commit/expiry.
- [x] Rerun finalization and full task-transfer runtime tests.

### Task 6: Verification and completion

- [x] Run Rust formatting, both TypeScript typechecks, and the repository's
  declared lint surface.
- [x] Run focused frontend/workspace/mobile/Rust tests.
- [x] Run the desktop production build/typecheck.
- [x] Run `pnpm test` and the canonical practical JavaScript verification
  exposed by `./kd`.
- [x] Run `git diff --check`, inspect the complete diff against `origin/main`,
  and verify every original remote blocked-task requirement remains covered.
- [x] Commit the revision and record Kanna stage success with a summary that
  states the branch supersedes #921 and lists decisions and evidence.

### Verification evidence

- Focused desktop/workspace tests: 5 files, 192 tests passed.
- Mobile LAN compatibility tests: 17 tests passed.
- Full `task-transfer` Rust suite: 132 tests passed across unit and integration
  targets.
- Focused Kanna server status/auth tests and the desktop multi-window routing
  test passed.
- Desktop `vue-tsc --noEmit && vite build` passed.
- Mobile `tsc --noEmit` passed. The declared root lint surface reported that
  no package lint tasks are configured.
- Root `pnpm test`: 14/14 package tasks passed, including 1,406 desktop and
  1,292 mobile tests.
- `./kd test rust` was attempted twice. After reclaiming this worktree's
  generated Cargo tree, the retry passed its prerequisite desktop build and
  compiled through the changed crates, but the host volume exhausted 7.8 GB
  while linking the repository-wide desktop/server test binaries. All Rust
  targets changed in this round were covered by the focused and full crate
  runs above.
