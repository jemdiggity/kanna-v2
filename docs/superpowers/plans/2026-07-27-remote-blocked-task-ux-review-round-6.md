# Remote Blocked Task UX Review Round 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticate every privileged LAN action and forbid plaintext cloud relay credentials outside explicit local emulator routes.

**Architecture:** Reuse task-transfer's paired-key sealed JSON primitive at one listener boundary, with action/request/argument/freshness/replay validation before local adapters run. Validate relay URI scheme and host before binding the proxy or connecting with an ID token.

**Tech Stack:** Rust, Tokio, serde_json, X25519/XChaCha20-Poly1305 sealed JSON, tokio-tungstenite.

## Global Constraints

- Preserve current local task, remote terminal, read-dwell, file-link, blocker, and workspace behavior.
- Do not add build-machine dependencies; release inputs remain vendored or statically linked.
- Use `pnpm` for JavaScript verification.

---

### Task 1: Privileged LAN action authentication

**Files:**
- Modify: `crates/task-transfer/src/protocol.rs`
- Modify: `crates/task-transfer/src/runtime/lifecycle.rs`
- Modify: `crates/task-transfer/src/runtime/listener.rs`
- Modify: `crates/task-transfer/src/runtime/daemon.rs`
- Modify: `crates/task-transfer/src/runtime/state.rs`
- Modify: `crates/task-transfer/src/runtime/utils.rs`
- Modify: `crates/task-transfer/tests/protocol.rs`
- Modify: `crates/task-transfer/tests/runtime.rs`

**Interfaces:**
- Consumes: paired `TransferIdentity`, discovered peer public key, and `ListenerContext`.
- Produces: sealed privileged payloads with `action`, `request_id`, `issued_at_unix_ms`, and action arguments; authenticated arguments passed to owner adapters.

- [x] **Step 1: Add direct-socket failing regressions**

Send raw observe/input/resize/close/read requests that claim a paired
`requester_peer_id` but omit a sealed payload and assert each response reports
missing authentication. Send one authentic sealed file-read request twice and
assert only the first reaches the local Kanna HTTP listener. Send an authentic
file-read payload with `issued_at_unix_ms: 0` and assert it is rejected before
the HTTP listener.

- [x] **Step 2: Run the regressions and verify red**

Run:
`cargo test --manifest-path crates/task-transfer/Cargo.toml --test runtime privileged_lan -- --nocapture`

Expected: unauthenticated routes reach adapter configuration errors, replay
reaches the HTTP listener twice, or stale payload reaches it once.

- [x] **Step 3: Add sealed payloads to privileged wire requests**

Add optional `sealed_payload` fields to observe, input, resize, close, and file
read requests. Generate each payload after capability validation using the
paired target key, current UNIX milliseconds, the exact request id/action, and
literal copies of all outer arguments. Add the same metadata to snapshot,
advance, and mark-read payloads.

- [x] **Step 4: Centralize verification in the listener**

Open the envelope against the paired key, require matching action/request id,
require a timestamp within `pending_transfer_ttl`, reject repeated
peer/action/request tuples, decode typed arguments, and reject any outer/sealed
argument mismatch. Authenticate before calling terminal, database, or local
HTTP adapters. Remove peer-id trust checks from those adapters.

- [x] **Step 5: Run focused protocol/runtime tests and verify green**

Run:
`cargo test --manifest-path crates/task-transfer/Cargo.toml --test protocol --test runtime`

Expected: all protocol and runtime tests pass, including spoof/replay/staleness
regressions.

### Task 2: Secure relay URL admission

**Files:**
- Modify: `apps/desktop/src-tauri/src/cloud_transfer_proxy.rs`

**Interfaces:**
- Consumes: relay URL string passed to `ensure_cloud_transfer_proxy_in_state`.
- Produces: acceptance for all `wss://` authorities and explicit local
  `ws://` authorities only.

- [x] **Step 1: Add failing scheme/host table tests**

Call `validate_relay_url` with `ws://relay.example.com`,
`ws://192.168.1.20`, and `ws://10.0.2.2`; assert rejection. Assert acceptance
for `wss://relay.example.com`, `ws://localhost`, `ws://dev.localhost`,
`ws://127.0.0.1`, and `ws://[::1]`.

- [x] **Step 2: Run the proxy test and verify red**

Run:
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml cloud_transfer_proxy::tests::relay_url`

Expected: current validation incorrectly accepts non-loopback plaintext URLs.

- [x] **Step 3: Implement host-aware validation**

Parse the URI once. Accept `wss` with an authority. For `ws`, normalize the URI
host and accept only `localhost`, `.localhost`, or a parsed `IpAddr` whose
`is_loopback()` is true. Return a non-loopback `wss://` requirement otherwise.

- [x] **Step 4: Re-run the focused proxy tests and verify green**

Run the focused desktop Rust test command and expect all relay URL cases to
pass.

### Task 3: Verification and completion

**Files:**
- Review: all changes against `origin/main`

- [x] **Step 1: Format and run touched Rust tests**

Run `cargo fmt --all -- --check`, task-transfer protocol/runtime tests, and the
focused desktop proxy tests.

- [x] **Step 2: Run repository verification**

Run the practical desktop typecheck/build command used by the repository,
`pnpm test`, and `./kd test rust` when practical for the touched Rust surface.

- [x] **Step 3: Review and commit**

Run `git diff --check`, inspect `git diff --stat origin/main...HEAD`, confirm the
complete diff preserves the original remote blocker requirements, and commit
the finished revision.

- [x] **Step 4: Record Kanna completion**

Record success stating the replacement supersedes #921, summarizing the sealed
LAN boundary and relay URL decision, and listing verification evidence. Record
failure instead if either security boundary remains unresolved.
