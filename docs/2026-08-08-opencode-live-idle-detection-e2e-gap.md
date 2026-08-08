# Live OpenCode sessions never reported `Idle`, so the busy-agent transfer E2E could not assert the quit

Date: 2026-08-08
Status: **closed.** Both defects below are fixed. The status matcher is pinned
against real frames, the PTY spawn opens a real TUI again, and the busy-agent
transfer E2E is green on a clean (non-degraded) finalization. The withdrawn
idle assertion is back, with a discriminating A/B. What is still uncovered is
narrower than it was; see "What is still not covered".
Related: `docs/2026-08-06-task-transfer-rearchitecture-plan.md` (Decision 3 /
Phase 4), `crates/kanna-server/src/transfer_engine/finalize.rs`,
`crates/kanna-server/src/task_creator/commands.rs`,
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

## Defect 2: Kanna's OpenCode spawn no longer opened a TUI — fixed

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

### The fix

The spawn moved to the CLI's default command — the one that draws the TUI —
with the opening prompt delivered by `--prompt`
(`crates/kanna-server/src/task_creator/commands.rs`, mirrored in
`apps/desktop/src/stores/agentCommand.ts`). Measured on 1.18.15, that shape
draws the composer, turns `--prompt` into a real turn, stays alive when the turn
ends, and takes injected input as a second turn.

Three things had to move with it, each because the *TUI entrypoint takes a
different argument surface than `run`*:

| what | why |
|---|---|
| `--variant` left the argv | The default command has no variant flag and one `[project]` positional, so `opencode --variant high` reads `high` as the project path and exits 1 with usage — before drawing anything. Effort now travels in `OPENCODE_CONFIG_CONTENT` as `agent.build.{model,variant}`, composed together with the MCP registration that already used that variable (`opencode_config_content`). |
| the prompt is *not* passed on a resume | The TUI accepts `--prompt` and then silently discards it whenever it is also resuming a session — measured with `--session` in both flag orders, and with `--continue`. `--fork` does deliver it, but mints a new session id, which is exactly what transfer continuity and revision resume must not do. So a resumed spawn seeds the turn with a headless `opencode run --session <id> '<prompt>'` first and then attaches the TUI to that same session: verified to extend the conversation rather than fork it. |
| `--dangerously-skip-permissions` became `--auto` | Both work — the old spelling is tolerated rather than removed, verified live on both entrypoints — but it is undocumented on both, and an undocumented flag is the one that disappears without notice. Pinned in `tests/cli-contract/tests/live/opencode-flags.test.ts`, which now covers the TUI entrypoint and `run` separately because they are separate surfaces. |

A bypass flag also changes what is *rendered*, not only what is permitted: the
composer's mode carries a badge, so Kanna's spawn draws
`┃  Build auto · Big Pickle` where a bare spawn draws `┃  Build · Big Pickle`.
The daemon's matcher keys on the spaced middle dot and was unaffected, but the
live contract test's regex required a single word before it and failed on
Kanna's own argv while the daemon was perfectly happy — a test stricter than the
code it guards. The fixtures under `crates/daemon/tests/fixtures/opencode/` are
now captured from the flags Kanna actually spawns, so the frames the matcher is
pinned against are the frames it will be handed.

## What the E2E asserts now

`local-transfer-busy-agent-wrapup.test.ts` is green, and **tightened** rather
than relaxed. It previously tolerated `cleanly_finalized: false` when the reason
named this defect; that tolerance is gone. It now requires a clean finalization
and the whole phase sequence — `["wrap-up-sent", "idle", "quit-sent",
"exited"]` — where before it could only assert the first step, plus the
already-existing assertion that an assistant turn *follows* the wrap-up in the
shipped conversation.

The withdrawn idle assertion is back in
`apps/desktop/tests/e2e/real/free-model-agent-writes-file.test.ts`:
`pipeline_item.runtime_status` must reach `idle` after a real OpenCode task's
turn.

The A/B that made it worth having is worth writing down, because the obvious
control is the wrong one. Three were run:

| control | result | why |
|---|---|---|
| the old `›` idle rule | **passes** — no discrimination | That glyph prefixes OpenCode's *echoed user message*, so the broken rule reports Idle for the wrong reason. This is the same false positive Defect 1 describes. |
| `opencode_line_is_composer_status` disabled | **passes** — no discrimination | `detect_headless_terminal_status_if_due` (`crates/daemon/src/session.rs`) falls back to Idle once any status has been observed and the matcher stops matching. So Busy detection alone carries the transition when the working footer disappears. |
| `opencode_status_from_lines` returning `None` for every frame — the true pre-fix state | **fails**: `expected 'busy' to be 'idle'` | Nothing is ever observed, `status_observed` stays false, the fallback never arms, and the session sits at its initial `Busy` — exactly what this document opened with. |

So the assertion pins that the daemon positively recognised OpenCode's chrome on
a live TUI *at all*. It cannot isolate the composer rule from the working-footer
rule, and a future change to one of them should be A/B'd against the whole
matcher rather than the individual rule.

The spawn shape itself is pinned live, which is what the earlier version of this
document asked for: `tests/cli-contract/tests/live/opencode-tui-status-markers.test.ts`
drives Kanna's own argv and asserts that `--prompt` becomes a turn, that the
process is **still alive** with a composer when that turn ends, and that input
injected the way `try_submit_task_input` injects it becomes a second turn the
agent answers. That last assertion is the direct negative of Defect 2.

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

Two more, both left open deliberately:

- **The resumed-spawn shape has no live E2E of its own.** Its two halves are
  pinned separately — that a resumed OpenCode conversation crosses a transfer
  intact by `local-transfer-opencode-continuity.test.ts`, and the argv itself by
  unit tests in `crates/kanna-server/src/task_creator/tests/core.rs` — and the
  seeding-turn behaviour was measured by hand against the live CLI (the turn
  lands in the same session id; the TUI attaches to the conversation it
  extended). What is not automated is a live run that asserts a *resumed* task
  both replays its history and answers a newly delivered prompt. It needs a
  fixture session to resume from, which the live contract harness has no way to
  set up cheaply; the natural home is a revision-resume E2E that does not exist
  yet for any provider.
- **Reasoning effort is unverified end to end for OpenCode.** The config route
  is pinned to the extent that a spawn carrying it comes up and the JSON is
  shaped as `AgentConfig` documents, but no authenticated model on this machine
  exposes a variant — OpenCode Zen's free models have none — so nothing here
  proves the variant is *honoured* rather than merely accepted. Re-check when a
  variant-capable model is authenticated. The load-bearing half is covered: that
  `--variant` on the TUI argv kills the spawn is pinned live in
  `opencode-flags.test.ts`, so the reason for the indirection cannot silently
  stop being true.
