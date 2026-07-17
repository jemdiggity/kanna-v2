# Mobile Terminal Stream Compaction Implementation Plan

> **For agentic workers:** Keep execution in the current Kanna stage. This
> worktree is already isolated, and the stage pipeline owns commits.

**Goal:** Preserve authoritative terminal snapshots and keep live mobile xterm
updates append-only when the retained base64 history crosses its one-megabyte
cap.

**Architecture:** Carry KSP `term_snapshot` frames intact through the mobile
transports and controller. Store a baseline epoch and retained character start
offset beside the capped newline-delimited base64 buffer. Plan WebView updates
from absolute ranges instead of string-prefix identity. Extend the existing
daemon-to-mobile TUI fidelity path so it renders store publications through the
production planner and reproduces rapid Codex-style status redraws across
compaction and reconnect.

**Tech Stack:** TypeScript, React Native WebView, Vitest, Rust daemon
`HeadlessTerminal`, KSP frames, Playwright, xterm.js.

## File Map

- Modify `apps/mobile/src/state/sessionStore.ts` and `.test.ts`: terminal epoch,
  retained start, and atomic snapshot replacement.
- Modify `apps/mobile/src/screens/terminalMutation.ts` and `.test.ts`: absolute
  range mutation planning.
- Modify `apps/mobile/src/screens/TerminalWebView.tsx` and `.test.tsx`: retain
  and pass range metadata without changing generated HTML.
- Modify `apps/mobile/src/App.tsx`, `TaskScreen.tsx`, and their focused tests:
  propagate terminal range metadata.
- Modify `apps/mobile/src/lib/api/client.ts`, LAN/relay transports, controller,
  and tests: preserve snapshot event semantics end to end.
- Modify `crates/daemon/src/bin/tui_fidelity_emit.rs`: optional second real
  headless snapshot after a configured raw-byte offset.
- Modify `tests/tui-fidelity/src/{types,fixtures,emitter,render,run}.ts` and
  `README.md`: incrementally exercise the store/planner/document path and assert
  the compaction/reconnect behavior.

### Task 1: Specify retained-range behavior in fast tests

- [ ] Add failing `sessionStore` tests for snapshot replacement, epoch changes,
  retained-start advancement, and whole-frame cap behavior.
- [ ] Add failing `terminalMutation` tests for append across a trimmed prefix,
  coalesced updates, epoch replacement, and a genuine gap fallback.
- [ ] Run the two focused test files and confirm RED for missing APIs/metadata.
- [ ] Implement the minimal store metadata and absolute-range planner.
- [ ] Rerun the focused tests and confirm GREEN.

### Task 2: Preserve snapshots through the mobile stream boundary

- [ ] Change `TaskTerminalStreamEvent` from synthetic `ready` to authoritative
  `snapshot` with dimensions and data.
- [ ] Update LAN and relay tests first to expect one snapshot event, then update
  their adapters.
- [ ] Add controller tests proving a later snapshot replaces stale output in
  one store publication and a later output appends within its epoch.
- [ ] Implement controller use of the atomic snapshot store method.
- [ ] Run focused transport/controller tests.

### Task 3: Make WebView mutations compaction-aware

- [ ] Add component tests proving epoch/start reach the planner, a cap trim
  injects an append script, and an epoch change injects one replace script.
- [ ] Propagate epoch/start from `App` through `TaskScreen` to `TerminalWebView`.
- [ ] Retain prior epoch/start refs in `TerminalWebView` and use the new planner
  inputs while preserving stable `source.html`, resize, inset, and ready queues.
- [ ] Run focused component tests and the mobile typecheck.

### Task 4: Add the real fidelity regression

- [ ] Extend the daemon emitter test first for an optional second snapshot,
  generated from the same `HeadlessTerminal` after applying intervening bytes.
- [ ] Add a generated status-redraw fixture whose framed base64 history exceeds
  one megabyte and whose static `esc to interrupt` text survives timer updates.
- [ ] Change the session-store renderer to apply every frame via the real store,
  real planner, and real document append/replace hooks.
- [ ] Record mutation counts and store metadata, then assert compaction occurred,
  ordinary post-cap frames did not reset xterm, and reconnect caused exactly one
  additional authoritative replacement.
- [ ] Compare the resulting grid cell-by-cell with the existing fresh-xterm
  oracle and document the new coverage.
- [ ] Run the emitter test, fidelity package typecheck, and full fidelity suite.

### Task 5: Verification and handoff

- [ ] Run all focused mobile tests touched by the change.
- [ ] Run `pnpm --dir apps/mobile run typecheck`.
- [ ] Run `pnpm test:tui-fidelity`.
- [ ] Run `git diff --check` and inspect the final diff for unrelated changes.
- [ ] Summarize implementation, regression evidence, and any remaining human
  physical-device check without committing, pushing, or advancing the stage.
