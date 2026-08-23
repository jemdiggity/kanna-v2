# E2E gap: stage-transition terminal carryover and the alt-screen history view

**Date:** 2026-08-22
**Task:** `docs/task-specs/01a0265bcc9300000004157763249361.md`

## The behaviors

1. A stage transition now snapshots the outgoing PTY session's terminal before
   killing it, flattens it to primary-screen history
   (`crates/kanna-server/src/terminal_window.rs::carryover_seed_snapshot`), and
   seeds it under the replacement session (`Command::SeedSnapshot`), so the
   user can scroll back past the stage boundary.
2. While a full-screen TUI holds xterm's alternate screen, the desktop
   terminal shows an "Earlier output" chip that opens a read-only view of the
   hidden normal buffer (setup output, carried-over history)
   (`apps/desktop/src/composables/terminalAltScreenHistory.ts`,
   `TerminalView.vue`).

## What is not yet E2E-tested, and why

The full path — real stage advance in a running kanna-server against a live
daemon, then the desktop UI rendering the carried history — needs a harness
that drives a real workflow transition (DB, worktree fork, agent spawn) and a
webdriver-driven desktop build. Neither exists as a ready-made fixture for
stage transitions today; building one is a task of its own.

What would make it testable: a server-level integration fixture that can
advance a seeded task one stage against a real daemon (the pieces exist
separately in `crates/daemon/tests/support` and the kanna-server HTTP tests),
plus a `tauri-plugin-webdriver` scenario that asserts on the xterm buffer via
`e2eTerminalBuffers`.

## Narrower tests added instead

- `crates/kanna-server` `terminal_window::tests` — flattening rules (alt
  segment dropped, mode-suffix sanitized, contentless snapshots skipped), and
  `carried_history_survives_a_replacement_terminal_round_trip`, which replays
  the seed through the daemon's real Ghostty emulator
  (`HeadlessTerminal::from_snapshot`) and asserts history order and mode
  hygiene in the replacement's serialized snapshot.
- `crates/kanna-server` `task_creator::lifecycle` —
  `stage_carryover_flattens_the_outgoing_terminal_into_the_replacement_seed`,
  a scripted daemon socket asserting the Snapshot → Kill → SeedSnapshot
  ordering and the seeded payload.
- The daemon side of seeding was already covered end-to-end against a real
  daemon: `crates/daemon/tests/recovery_service.rs::daemon_seed_snapshot_survives_next_spawn_and_appends_live_output`.
- `apps/desktop/src/composables/terminalAltScreenHistory.test.ts` — buffer
  collapse (wrapped rows, trailing blanks), hidden-history detection on
  alt-screen switches, and terminal-swap re-subscription.
