# Remote Companion Review Round 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining state-directory identity, zero-receiver watch,
and event-journal generation findings with deterministic regressions.

**Architecture:** Fence event append with descriptor-relative reopens of the
authoritative session and state directories before and after the write. Keep
the newest owner companion frame in the cached watch channel even when no
receiver exists. Bind idempotency markers to the `state/events` file identity,
and reconcile pre-generation journals before recovery so the deployed
unlink-on-new-screen lifecycle cannot replay or retain old markers.

**Tech Stack:** Rust, Tokio watch channels, descriptor-relative Unix filesystem
operations, Cargo.

---

### Task 1: Authoritative session/state identity fences

**Files:**
- Modify: `crates/visual-companion/src/event.rs`
- Modify: `crates/visual-companion/src/tests.rs`

- [x] Add a deterministic regression that swaps `state` for an identical
  directory before and after the event write and expects `StaleRevision`.
- [x] Run the focused regression and confirm content-derived revision plus
  workspace identity currently acknowledges the post-write swap.
- [x] Reopen the current session and state through the authoritative workspace
  before and after append, then compare both device/inode identities with the
  retained descriptors.
- [x] Reopen `state/events` immediately before the write and after the
  authoritative post-write state fence, then reject a missing or replaced
  descriptor as `StaleRevision`.
- [x] Re-run the focused state-swap regressions.

### Task 2: Persist zero-receiver watch updates

**Files:**
- Modify: `crates/task-transfer/src/runtime/companion.rs`

- [x] Replace the existing reconnect regression with one that drops every
  receiver, publishes a distinct revision once, reconnects, and immediately
  reads that exact revision.
- [x] Run the regression and confirm `watch::Sender::send` leaves the prior
  cached value behind when there are no receivers.
- [x] Publish with `send_replace` so the channel value advances independently
  of receiver count.
- [x] Re-run the focused task-transfer regression.

### Task 3: Event-log generation and legacy journal migration

**Files:**
- Modify: `crates/visual-companion/src/discovery.rs`
- Modify: `crates/visual-companion/src/event.rs`
- Modify: `crates/visual-companion/src/tests.rs`

- [x] Add upgrade regressions for an existing replacement `events` file with a
  legacy committed marker and with a legacy pending marker.
- [x] Run both regressions and confirm the previous implementation leaves the
  committed marker authoritative and replays the pending marker into the
  replacement log.
- [x] Return whether descriptor-relative event open created a new file, bind
  current journals to an event-file device/inode generation marker, and clear
  journals when the generation changes.
- [x] Reconcile journals without a generation marker against the replacement
  log and current document before pending recovery, preserving valid
  interrupted appends.
- [x] Count only event identity markers toward the 2,048-entry bound and update
  marker-storage assertions for the generation entry.
- [x] Re-run all visual-companion tests.

### Task 4: Verification and completion

**Files:**
- Verify every file above.

- [x] Run focused red/green regressions for each reviewer finding.
- [x] Run `cargo fmt --all -- --check`, affected crate test suites, and
  `git diff --check`.
- [x] Inspect the complete diff against all three findings and record Kanna
  stage success with the exact verification evidence.
