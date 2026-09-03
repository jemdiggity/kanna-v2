# Task 4f6abb9d: idle Claude session reported busy

## Goal

Fix the daemon-to-server runtime-state path so Claude Code's idle composer is reported `idle` within the debounce window, including after daemon restart and session re-attachment, instead of remaining or flipping to `busy`.

## Scope

- Trace the Claude terminal-frame classifier and the server debounce/settled-event path to identify the source of the false `busy` verdict reported for task `34ab8c46` on Kanna Staging.
- Capture a representative idle Claude Code frame from the affected/current CLI version and preserve it as a classifier regression fixture.
- Correct positive idle detection without broadly weakening conservative busy detection.
- Add cross-boundary coverage for busy-to-idle convergence across daemon restart/re-attachment, or document a dated E2E gap if the restart boundary cannot yet be exercised.
- Do not change unrelated provider classification or UI behavior.

## Constraints and completion

The fix must retain the rule that uncertain or genuinely working frames are not called idle. Focused daemon/server tests, formatting, clippy, and `./kd test all` must pass. Work is done when the captured idle frame classifies idle, restart/re-attachment re-derives live runtime state, and the server publishes the resulting settled/activity state after debounce.

## Diagnosis and delivered coverage

The 2026-09-03 staging logs show the failure at both boundaries. Claude 2.1.259's handoff snapshot for task `34ab8c46` ended with its `done` line, empty `❯` composer, divider, and permission-mode bar, while the adjacent handoff field still said `busy`. The classifier only accepted `❯` when it was the last non-empty footer row, so this real idle frame matched no state; adoption then copied the stale `busy` field instead of preferring the restored snapshot's positive verdict. The server correctly stored the daemon's verdict and armed its activity/runtime debounce, but it never received an idle verdict to settle.

The raw incident snapshot and inherited status are preserved under `crates/daemon/tests/fixtures/claude/`. Unit coverage replays it through the classifier and the daemon adopter. A remote E2E uses a scripted Claude PTY to exercise busy → idle, performs a transactional successor-daemon handoff, drives busy → idle again through the adopted PTY, and verifies `runtimeState`, `task.runtime_settled`, and `task.activity_changed` through the real server event feed.

## Verification

- The captured-frame classifier test, adopted-status test, remote-E2E helper tests, and the real daemon → server → event-feed handoff E2E pass.
- `cargo fmt --all -- --check`, `cargo clippy -p kanna-daemon --all-targets`, and `./kd test all` pass. Clippy retains two pre-existing warnings in untouched `agent_runtime/readers.rs` and `fanout.rs`.
- A direct concurrent `cargo test -p kanna-daemon` run passes 228 of 229 tests; the untouched recovery timing test `failed_replay_is_single_flight_and_backed_off_for_all_waiters` exceeds its wall-clock threshold under suite load but passes alone. The canonical `./kd test all` serialized daemon suite passes completely.
- The remote-E2E package's standalone `tsc --noEmit` remains blocked by three pre-existing errors in untouched `cloud-pairing-auth-discovery.e2e.test.ts` and `staging.test.ts`; the canonical TypeScript tests, desktop typecheck, and production build in `./kd test all` pass.
