# Mobile Visual Companion Source Error Revision Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve safe, actionable companion source failures across KSP and relay transport, invalidate stale mobile interaction state, expose first-load failures, and correctly close modal-open lifecycle state across task identity changes.

**Architecture:** `visual_companion::CompanionError` remains the filesystem boundary, while KSP maps source variants into sanitized task-scoped protocol codes and messages. The mobile store treats `error` as an authoritative invalidation event but keeps `event_result` as a retryable selection failure over the current document. TaskScreen renders a non-interactive error entry state and owns balanced open/close notifications; the relay E2E fixture mutates the real source file to prove failure and recovery through every layer.

**Tech Stack:** Rust/Tokio/KSP, TypeScript, React Native, Vitest, Appium relay harness.

---

### Task 1: Map companion source failures at the KSP boundary

**Files:**
- Modify: `crates/kanna-server/src/ksp.rs`

- [ ] Add focused KSP tests that attach to invalid UTF-8 and oversized companion files and expect `companion_invalid_document` / `companion_too_large` with sanitized task-scoped messages; add a unit assertion for unsafe/internal mapping without exposing internal details.
- [ ] Run `cargo test -p kanna-server ksp::tests::companion -- --nocapture` and confirm the new expectations fail against `companion_source_failed`.
- [ ] Add one mapping function from `CompanionError` (and `JoinError`) to `(code, message)`: actionable `TooLarge` and `UnsupportedContent` get stable design codes, while unsafe, internal, and task lookup failures keep a generic sanitized fallback.
- [ ] Re-run the focused KSP tests and confirm they pass.

### Task 2: Make source errors authoritative in mobile state

**Files:**
- Modify: `apps/mobile/src/state/sessionStore.test.ts`
- Modify: `apps/mobile/src/state/sessionStore.ts`

- [ ] Add a failing store test starting from an available unread snapshot with a pending event, then apply a source `error` and assert snapshot, unread, event id, and event status are cleared while the source message remains.
- [ ] Add/retain a separate failing assertion that a rejected `event_result` leaves the current snapshot visible with retry state.
- [ ] Change only the source `error` branch to clear stale content and pending state; do not alter `event_result` snapshot behavior.
- [ ] Run the focused store test and confirm it passes.

### Task 3: Expose source failures and balance modal lifecycle

**Files:**
- Modify: `apps/mobile/src/screens/TaskScreen.test.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
- Modify: `apps/mobile/src/screens/VisualCompanionModal.test.tsx`
- Modify: `apps/mobile/src/screens/VisualCompanionModal.tsx`

- [ ] Add failing TaskScreen tests for a first-load source error action, no stale companion button/WebView after an available-to-error transition, and rerender from one task id to another while the modal is open producing exactly one `onCompanionOpenChange(false)`.
- [ ] Add a failing VisualCompanionModal test that an error with a stale snapshot never renders a WebView and that its task-scoped message is visible; preserve the existing event-result failure test where the WebView remains.
- [ ] Render the TaskScreen companion action for either a snapshot or task-scoped source error, label the error action without implying readiness, and allow it to open the modal's error state.
- [ ] Derive WebView eligibility from `status === "available" && snapshot`, so source errors cannot render stale content even if a caller violates the store invariant.
- [ ] Centralize modal closure so task-id changes and unmount notify `false` exactly once when open; remove the duplicate `true` notification.
- [ ] Run the focused screen tests and confirm they pass.

### Task 4: Extend relay source-error and recovery E2E coverage

**Files:**
- Modify: `apps/mobile/e2e/helpers/relay-harness.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.test.ts`
- Modify: `apps/mobile/e2e/specs/relay/relay-task-flow.e2e.ts`

- [ ] Extend the journey contract test first with `invalidateSource`, visible safe error, blocked WebView interaction, `restoreSource`, and recovery to the updated valid marker.
- [ ] Add harness actions that overwrite the previously valid real HTML fixture with a file larger than 1 MiB and then restore a valid updated document.
- [ ] Add native UI probes for the safe source error and absence of the companion WebView; keep relay transparent.
- [ ] Run `pnpm --dir apps/mobile test -- e2e/specs/relay/relay-task-flow.test.ts` and confirm the contract passes.

### Task 5: Verify the revision

- [ ] Run `cargo test -p kanna-server ksp::tests::companion -- --nocapture`.
- [ ] Run `pnpm --dir apps/mobile test -- src/state/sessionStore.test.ts src/screens/TaskScreen.test.tsx src/screens/VisualCompanionModal.test.tsx e2e/specs/relay/relay-task-flow.test.ts`.
- [ ] Run `pnpm test`.
- [ ] Run `cargo test -p kanna-server`.
- [ ] Run `(cd crates/daemon && cargo test -- --test-threads=1)`.
- [ ] Run `git diff --check` and inspect the final diff without pushing or creating a PR.
