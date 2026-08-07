# Live OpenCode sessions never reported `Idle`, so the busy-agent transfer E2E could not assert the quit

Date: 2026-08-08
Status: the status matcher is fixed and pinned against real frames. The
busy-agent transfer E2E is **still red**, for a second and larger defect this
investigation uncovered — see "Defect 2" below.
Related: `docs/2026-08-06-task-transfer-rearchitecture-plan.md` (Decision 3 /
Phase 4), `crates/kanna-server/src/transfer_engine/finalize.rs`,
`apps/desktop/tests/e2e/real/local-transfer-busy-agent-wrapup.test.ts`,
`crates/daemon/src/headless_terminal.rs`

## What this blocked

Transfer finalization sequences notify → **idle** → quit → exit → stage. Step 2
waits for the daemon to publish `StatusChanged(Idle)` for the source session,
and every later step is gated on it: the quit command is only typed at an idle
agent, precisely so it cannot preempt the wrap-up mid-turn.

Against a **live OpenCode PTY session** that event never arrived, so the live
E2E could not assert the second half of the sequence.

## What was measured

`local-transfer-busy-agent-wrapup.test.ts`, run 2026-08-07 against the real
two-instance runner (OpenCode is what `apps/desktop/tests/e2e/runEnv.ts` forces
for real suites):

| time | fact |
|---|---|
| 17:23:48 | source task spawned, live OpenCode PTY agent |
| 17:23:57 | `task.transfer_finalizing` `wrap-up-sent` — the injection landed |
| ~17:26 | the agent had **answered** the wrap-up: `opencode export` shows the user turn and the assistant's "Both steps are complete… nothing was left in progress" reply |
| 17:28:57 | `task.transfer_finalizing` `degraded` — "the source agent did not finish its turn within 300s: it was still working" |

`pipeline_item.runtime_status` was `busy` for the whole window. That column is
written by `terminal_watcher` off the same daemon broadcast the finalization
observer reads, from a *separate* subscription — so it is independent
corroboration that the daemon never published `Idle`, rather than the transfer's
observer missing an event.

## Defect 1: the matcher matched nothing — fixed

`opencode_status_from_lines` matched **none** of the chrome the installed CLI
draws, so it returned `None` on every frame and left every session pinned at its
initial `Busy` forever.

The original diagnosis was that `Busy` was detected and only `Idle` was missing.
Capturing real frames showed the damage was wider — all three states were wrong:

| state | what the matcher looked for | what OpenCode draws |
|---|---|---|
| Busy | `esc to interrupt` | `⬝⬝⬝⬝⬝⬝⬝⬝ esc interrupt` (1.18.15); `escape interrupt` on 1.16.2 |
| Idle | a line starting `›` (`CODEX_IDLE_PROMPT`) | `┃ Build · Big Pickle OpenCode Zen`, with `▣ Build · Big Pickle · 3.0s` where the working footer was |
| Waiting | `do you want to allow` | `┃ Allow once  Allow always  Reject  ctrl+f fullscreen  ⇆ select  enter confirm` |

The `›` glyph is not gone from the TUI — it prefixed the *user's* echoed message
on 1.16.2. So the old idle rule was not merely stale: an echoed instruction was
being read as a composer.

Its unit tests pinned all three against hand-written fixtures. Nothing pinned
them against the TUI the installed CLI actually draws, and
`apps/desktop/tests/e2e/real/pty-runtime-status.test.ts` exercises runtime
status against a *scripted* agent binary, not a live provider TUI — so fixture
and product drifted apart silently. Same class of failure as the 2026-08-06
transcript loss: a provider-owned surface believed rather than pinned.

How fast that surface moves is itself a finding: OpenCode auto-updated from
1.16.2 to 1.18.15 *during* this investigation, and the working footer's wording
changed with it. Every spelling seen is now pinned side by side.

The fix keys OpenCode's three states on markers read off captured frames, and
commits the frames:

- `crates/daemon/tests/fixtures/opencode/*.ansi` — raw PTY streams from a real
  `opencode` 1.18.15 process, from launch to each state, at **two geometries**.
  Both widths are pinned because OpenCode's chrome is width-dependent: the
  `ctrl+p commands` hint bar is drawn at 120 columns and dropped or wrapped at
  80, so a marker chosen from a wide terminal alone would have failed silently
  on a narrow one. The composer's status line and the working footer survive
  every width measured (80, 100, 120, 160).
- `capture-tui-fixtures.py` beside them re-captures the set from the installed
  CLI, so the next TUI move is a re-run rather than a rewrite.
- `tests/cli-contract/tests/live/opencode-tui-status-markers.test.ts` is the
  canary the previous fixtures lacked: it drives a live TUI and asserts the CLI
  still draws each marker, naming the constant to update when one moves.

Status stays a *positive* match on rendered chrome and is never inferred from a
session going quiet: a session that has not drawn its composer, or has replaced
it with the permission dialog, matches nothing and leaves the previous status in
place. Mislabelling a long build as finished is still worse than not labelling
it.

## Defect 2: Kanna's OpenCode spawn no longer opens a TUI — not fixed

Measured on 1.18.15, on a real PTY, outside Kanna:

| launch | result |
|---|---|
| `opencode [project]` (the CLI's default command) | full TUI: composer, working footer, permission dialog |
| `opencode run --interactive [flags] '<prompt>'` | **no TUI at all** — plain streamed text, and the process exits at the end of its first turn |

The second row is exactly what Kanna spawns for an OpenCode PTY task
(`apps/desktop/src/stores/agentCommand.ts`,
`crates/kanna-server/src/task_creator/commands.rs`). So on the installed CLI an
OpenCode task is a one-shot run: no composer to type into, no chrome to read a
status from, and the session gone the moment the first turn ends.

That is a second, larger defect, and it is why the busy-agent transfer E2E is
still red. Re-run 2026-08-08 with the matcher fixed:

| time (UTC, from `task_event`) | fact |
|---|---|
| 21:02:37 | source task spawned |
| 21:02:48 | `wrap-up-sent` — the bytes were written to the PTY |
| 21:02:49 | the OpenCode process **exited (code 0)**, having only echoed the wrap-up; `finalization.cleanly_finalized: true`, via the "the agent ended its own session" path |
| — | the shipped conversation carries the original prompt and no wrap-up turn, so the test's `assistantAnsweredTheWrapUp` assertion fails |

Reproduced outside Kanna: spawn `opencode run --interactive '<prompt>'`, wait
for the turn, inject a message the way `try_submit_task_input` does — the text
is echoed by the tty, never becomes a turn, and the process exits.

Fixing it belongs with the spawn, not the matcher: Kanna needs a launch shape
that keeps a TUI open (the default command with the prompt delivered as input,
or whatever `run` grows back), and the change has to carry a live contract test
that the spawned process still *has* a composer after its first turn. Until
then, `send-input`, stage posts, revision resume and transfer wrap-up all have
nothing to type into on an OpenCode task.

## What the E2E asserts now

`local-transfer-busy-agent-wrapup.test.ts` is unchanged and still asserts what
it always did; it fails on the conversation assertion for the reason above,
which is the correct outcome — the wrap-up genuinely does not reach the agent.
Do not relax it to make the suite green.

**No E2E covers defect 1, and none can until defect 2 is fixed.** A Kanna
OpenCode task has no TUI, so the matcher never runs against one: an assertion
that `pipeline_item.runtime_status` reaches `idle` after a real OpenCode task's
turn was written against
`apps/desktop/tests/e2e/real/free-model-agent-writes-file.test.ts` and then
withdrawn, because A/B runs showed it passes identically with the matcher fixed
and with it reverted to the broken version. Whatever writes `idle` on that path
is the one-shot process ending, not the status matcher, and a test that cannot
tell the two apart is worse than none. When the spawn draws a TUI again, that
assertion is the right one to add — with the A/B repeated to prove it fails
without the fix.

The deterministic pins remain where they were:
`transfer_engine/finalize.rs`'s
`the_quit_command_is_never_typed_while_the_agent_is_busy` walks the whole
sequence against a daemon over a real Unix socket, and
`crates/daemon/tests/handoff.rs::test_adopted_session_refuses_signals_but_quits_on_injected_input`
proves an adopted session really does quit on injected input.

## What is still not covered

The live contract suite accumulates bytes rather than rendering them, and
OpenCode repaints by addressing individual cells, so the buffer holds every
frame it ever drew with no line structure left. The suite can therefore assert
that the CLI still *draws* each marker, but not what the rendered screen says at
a given moment. That question is answered at the unit layer instead, against the
captured post-turn frame. Closing it properly would mean giving the contract
harness a terminal emulator, which is a larger change than this pin needed.
