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

## Visual verification (2026-08-24, review revision round 1)

The chip and overlay were verified in the real running app: `./kd dev up` from
the revision worktree (debug desktop build, its own kanna-server, daemon, and
per-worktree DB), driven over `tauri-plugin-webdriver` on the worktree's
`KANNA_WEBDRIVER_PORT`. The scenario was a scratch repo registered with the dev
server whose committed `.kanna/config.json` (definitions are read from the
`origin` snapshot, so the fixture needed a real origin) declares echo-based
`setup` commands plus a `sleep`, and `claude` as the provider; tasks created
through `POST /v1/tasks` spawned real Claude Code 2.1.241 PTY sessions. States
were confirmed both visually (webdriver screenshots) and structurally (the
dev build's Vue `setupState` for `altScreenActive`/`hasHiddenHistory`, and the
`__KANNA_E2E__.terminalBuffers` xterm hook), because an occluded dev window
throttles xterm's canvas renderer — the DOM chrome (chip, overlay) still
renders and screenshots, but the canvas behind it can paint blank, so buffer
content was asserted through the hooks rather than pixels.

What was seen, and how each state was triggered:

- **Chip appears only with an active alt screen over hidden content.** While
  the setup commands ran on the normal screen, the chip was absent
  (`alt:false`, setup lines visible in the buffer). The moment Claude's TUI
  entered the alternate screen (~9s in, after the setup `sleep`), the chip
  appeared top-right (`alt:true`, `hasHiddenHistory:true`). On a session whose
  normal buffer was empty (a fixture without working setup), the chip
  correctly never appeared despite the active alt screen. After Claude exited
  (`/exit` → alt screen released), the chip disappeared again.
- **Clicking the chip opens the overlay on the hidden text.** The overlay
  showed the full setup transcript ("Running startup...", each dimmed `$ cmd`
  line and its output) as the header "Earlier output — setup & previous
  stages" with a Close button; the body was focused and at its bottom (the
  transcript fit without scrolling, so scrolled-to-bottom held trivially);
  the chip hides while the overlay is open.
- **All three close paths.** Esc on the overlay body closed it and returned
  focus to the terminal (xterm's helper textarea). The Close button closed it
  — and revealed the one defect of this pass: WebKit's post-click focus
  handling landed focus on `<body>`, defeating the synchronous
  `terminal.focus()`. Fixed in `TerminalView.vue` by deferring the refocus to
  `nextTick` after the overlay leaves the DOM; re-verified live (focus ends on
  the terminal). With the overlay open, telling Claude to exit made the TUI
  leave the alt screen, and the overlay auto-closed with focus returned to
  the terminal, no interaction required.
- **Legibility.** In the app's dark theme the chip (muted text on a raised
  panel pill) and the overlay (terminal background, standard muted/monospace
  text tokens) were clearly legible against the terminal background in the
  screenshots.

Incidental observation, not a defect: on a folder Claude does not yet trust,
its workspace-trust prompt is drawn on the *primary* screen (no alt screen
yet), so the chip correctly stays hidden until the prompt is accepted and the
TUI enters the alternate screen.
