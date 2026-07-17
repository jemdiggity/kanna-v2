# Mobile Visual Companion Reconnect and UTF-8 Revision Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent companion selections from crossing a KSP disconnect and make every WebView bridge field obey the server's UTF-8 byte limits.

**Architecture:** `StreamClient` will treat companion events as non-bufferable writes and notify companion handlers whenever the authenticated socket is lost or restored. Mobile transports map that signal into the existing companion stream, the store invalidates stale snapshots until a new authoritative snapshot arrives, and the controller accepts selection only for that current snapshot. The WebView bridge will truncate strings by UTF-8 code-point byte length before posting them to React Native.

**Tech Stack:** TypeScript, Vitest, React Native WebView, Kanna Stream Protocol, Appium relay harness.

---

### Task 1: Make companion KSP sends non-buffering and observable

**Files:**
- Modify: `packages/stream-client/src/stream-client.test.ts`
- Modify: `packages/stream-client/src/index.ts`

- [ ] Add a failing stream-client test that drops an authenticated socket, verifies `onConnectionChange(false)`, calls `sendCompanionEvent`, reconnects, and asserts the stale event is absent while the companion attachment is restored.
- [ ] Run `pnpm --dir packages/stream-client test -- stream-client.test.ts` and confirm the new assertion fails because `companion_event` is currently queued.
- [ ] Change `CompanionStreamHandlers` to accept `onConnectionChange?(connected: boolean)`, notify companion attachments on disconnect/authentication, and make `sendCompanionEvent(...)` return `false` without using `sendQueue` unless the current socket is authenticated and writable.
- [ ] Re-run the focused stream-client test and confirm it passes.

### Task 2: Propagate reconnect state through every mobile route

**Files:**
- Modify: `apps/mobile/src/lib/api/client.ts`
- Modify: `apps/mobile/src/lib/transports/relayClient.ts`
- Modify: `apps/mobile/src/lib/transports/lanTransport.ts`
- Modify: `apps/mobile/src/lib/transports/remoteTransport.ts`
- Modify: `apps/mobile/src/lib/sources/cloudLanClient.ts`
- Modify: adjacent transport tests listed by the reviewer

- [ ] Add failing tests for `{ type: "connection", connected: false|true }` mapping and boolean `sendEvent` results through LAN, relay, remote, and hybrid routes.
- [ ] Add a failing remote-transport test proving a companion event is rejected rather than queued while a cloud route is unresolved.
- [ ] Extend `TaskCompanionStreamEvent` with the connection event and change `TaskCompanionSubscription.sendEvent` to return `boolean`.
- [ ] Map `StreamClient` connection callbacks in LAN and relay clients, preserve the event through remote/hybrid translations, return `false` from unavailable routes, and remove the remote companion pending-event queue.
- [ ] Run the focused transport tests and confirm they pass.

### Task 3: Invalidate stale mobile content until a fresh snapshot

**Files:**
- Modify: `apps/mobile/src/state/sessionStore.test.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`
- Modify: `apps/mobile/src/state/mobileController.test.ts`
- Modify: `apps/mobile/src/state/mobileController.ts`
- Modify: `apps/mobile/src/screens/VisualCompanionModal.test.tsx`
- Modify: `apps/mobile/src/screens/VisualCompanionModal.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx` if its status union assertions require it

- [ ] Add failing store tests proving disconnect changes the status to `reconnecting`, clears the snapshot and pending selection, reconnect alone does not restore interaction, and a new snapshot does.
- [ ] Add failing controller tests proving an offline/stale selection is not sent, a failed transport send becomes visible immediately, and an explicit retry after a new snapshot is sent once.
- [ ] Add `reconnecting` to `TaskCompanionStatus`; handle connection loss by clearing authoritative content and showing a retry message for an in-flight event; leave reconnect state unchanged on `connected: true` until a snapshot arrives.
- [ ] Guard controller sends by current `available` status plus exact session/revision, and surface `sendEvent() === false` as reconnecting instead of leaving `sending` stuck.
- [ ] Render `Reconnecting to visual companion…` with no WebView while reconnecting, then run the focused store/controller/component tests.

### Task 4: Enforce UTF-8 byte limits inside the WebView bridge

**Files:**
- Modify: `apps/mobile/src/screens/buildVisualCompanionDocument.test.ts`
- Modify: `apps/mobile/src/screens/buildVisualCompanionDocument.ts`
- Modify: `apps/mobile/src/screens/VisualCompanionModal.test.tsx`

- [ ] Add a failing happy-dom bridge test using non-ASCII `choice`, text, and element id values at and above 256/4096 UTF-8 bytes; assert the posted JSON stays within each byte limit and never ends with a split surrogate/code point.
- [ ] Run the document-builder test and confirm `.slice()` exceeds the UTF-8 byte limits.
- [ ] Add a constant bridge helper that iterates Unicode code points, counts their UTF-8 width, and returns the longest prefix within the byte budget; use it for `choice`, visible text, and id.
- [ ] Re-run builder and modal bridge-validation tests.

### Task 5: Strengthen the relay companion journey contract

**Files:**
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts`
- Modify: `apps/mobile/e2e/helpers/relay-harness.test.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`

- [ ] Extend the pure journey test first so it requires: disconnect, reconnecting UI, no offline delivery, fresh snapshot, explicit retry, and one delivered event.
- [ ] Split harness server stop/start into disconnect/reconnect actions, add event absence/count helpers, and expose a reconnecting-status UI probe.
- [ ] Keep the relay transparent: no relay-specific companion protocol or preview route.
- [ ] Run `relay-harness.test.ts` and `relay-task-flow.test.ts`.

### Task 6: Verify the revision

- [ ] Run the exact focused stream-client and mobile commands from the review.
- [ ] Run `pnpm test`.
- [ ] Run `cargo test -p kanna-server`.
- [ ] Run `(cd crates/daemon && cargo test -- --test-threads=1)`.
- [ ] Inspect `git diff --check` and the final worktree diff; do not push or create a PR.
