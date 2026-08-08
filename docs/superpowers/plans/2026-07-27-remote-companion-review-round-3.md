# Remote Companion Review Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the four reviewer-requested regressions and their
compatibility-safe fixes.

**Architecture:** Announce unread state on the native action, validate
companion revisions from descriptor metadata, bootstrap prior-mobile WebSocket
trust from an authenticated LAN cookie, and negotiate attachment epochs with a
fresh-socket fallback for legacy servers.

**Tech Stack:** React Native/TypeScript/Vitest, Rust/Serde/Axum/Tokio, pnpm,
Cargo.

---

### Task 1: Accessible unread companion action

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`

- [ ] Add assertions that the unread button has label
  `Visual companion ready, new update` and value `{ text: "unread" }`, while
  the dot has `accessible: false`.
- [ ] Press the action, rerender with `companionUnread: false`, and assert the
  button label is `Visual companion ready` with no unread value.
- [ ] Run
  `pnpm --dir apps/mobile test -- TaskScreen.test.tsx` and confirm the new
  assertions fail against the current nested accessibility node.
- [ ] Move the unread label/value to the `Pressable`, hide the dot from the
  accessibility tree, and rerun the focused test to green.

### Task 2: Metadata-only companion event validation

**Files:**
- Modify: `crates/visual-companion/src/tests.rs`
- Modify: `crates/visual-companion/src/discovery.rs`
- Modify: `crates/visual-companion/src/event.rs`

- [ ] Add a maximum-asset fixture that materializes the current bundle, enables
  a test-only delay for optional payload reads, appends an event, and asserts
  the append completes inside the delay that one asset payload read would
  require.
- [ ] Run
  `cargo test -p kanna-visual-companion maximum_asset_event_validation -- --nocapture`
  and confirm the existing three materialization passes exceed the bound.
- [ ] Compute a stable `descriptor-sha256` revision while `prepare_scan`
  traverses the selected active session and content entries.
- [ ] Add a descriptor-only helper returning the selected session and revision,
  and replace all three `discover_document` calls in `append_event` with it.
- [ ] Keep document/asset materialization unchanged except for taking the
  prepared descriptor revision as the bundle revision.
- [ ] Rerun the focused regression and the full
  `cargo test -p kanna-visual-companion` suite.

### Task 3: Previous-mobile authenticated LAN compatibility

**Files:**
- Modify: `crates/kanna-server/src/http_api/lan_trust.rs`
- Modify: `crates/kanna-server/src/http_api/ksp.rs`
- Test: `crates/kanna-server/src/http_api/tests/core_routes.rs`
- Test: `apps/mobile/src/lib/transports/lanTransport.test.ts`

- [ ] Add an HTTP regression that authenticates with the previous mobile's
  paired REST headers, captures the compatibility cookie, upgrades
  `/v1/stream` with only that cookie, and observes companion capability.
- [ ] Add rejection cases for missing, malformed, and wrong-secret cookies.
- [ ] Run the focused KSP HTTP tests and confirm the headerless upgrade lacks
  companion access.
- [ ] Encode the paired id and secret into one short-lived HttpOnly,
  SameSite-strict `/v1/stream` cookie on authenticated LAN responses and verify
  it through the pairing store on upgrade.
- [ ] Preserve explicit current-mobile WebSocket headers and the existing
  headerless unavailable behavior, then run KSP HTTP and LAN transport tests.

### Task 4: Epoch capability negotiation and legacy socket fencing

**Files:**
- Modify: `crates/kanna-agent-protocol/src/frames.rs`
- Regenerate: `packages/agent-protocol/src/generated/ServerFrame.ts`
- Modify: `crates/kanna-server/src/ksp.rs`
- Modify: `packages/stream-client/src/index.ts`
- Test: `packages/stream-client/src/stream-client.test.ts`

- [ ] Add a new-client/previous-server regression: receive `auth_ok` with
  companion but without the epoch capability, detach and reattach, deliver a
  late old snapshot, and assert it reaches neither handler; authenticate the
  fresh socket and assert its snapshot reaches the replacement handler.
- [ ] Run the focused stream-client test and confirm the late legacy snapshot
  currently reaches the replacement.
- [ ] Add the optional `capabilities` array to `auth_ok` with
  `companion_attachment_epoch`, advertise it from KSP, and regenerate the
  TypeScript protocol mirror.
- [ ] Track companion tasks attached on the current legacy socket. On
  replacement, retire that socket and let normal reconnect reattach all current
  streams before accepting replacement frames.
- [ ] Run protocol, stream-client, KSP, and protocol mirror freshness tests.

### Task 5: Final verification

**Files:**
- Verify every file above.

- [ ] Run `cargo fmt --all -- --check`.
- [ ] Run focused Rust and TypeScript suites plus affected type checks.
- [ ] Run `git diff --check` and inspect the complete diff against all four
  reviewer findings.
- [ ] Record Kanna stage success with the exact verified command summary.
