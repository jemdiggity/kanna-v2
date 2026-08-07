# Live OpenCode sessions never report `Idle`, so the busy-agent transfer E2E cannot assert the quit

Date: 2026-08-08
Related: `docs/2026-08-06-task-transfer-rearchitecture-plan.md` (Decision 3 /
Phase 4), `crates/kanna-server/src/transfer_engine/finalize.rs`,
`apps/desktop/tests/e2e/real/local-transfer-busy-agent-wrapup.test.ts`,
`crates/daemon/src/headless_terminal.rs`

## What this blocks

Transfer finalization sequences notify → **idle** → quit → exit → stage. Step 2
waits for the daemon to publish `StatusChanged(Idle)` for the source session,
and every later step is gated on it: the quit command is only typed at an idle
agent, precisely so it cannot preempt the wrap-up mid-turn.

Against a **live OpenCode PTY session** that event never arrives, so the live
E2E cannot assert the second half of the sequence.

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

The turn was demonstrably over minutes before the timeout. The agent was idle;
the daemon could not see that it was.

## Why

Measured: `Busy` is detected and `Idle` never is. `opencode_status_from_lines`
(`crates/daemon/src/headless_terminal.rs`) reports `Busy` from the
`esc to interrupt` footer — which fires correctly here — and reports `Idle` only
when the last non-empty rendered line starts with `›` (U+203A,
`CODEX_IDLE_PROMPT`). Returning `None` leaves the previous status in place, so a
composer that does not satisfy that shape pins the session at `Busy` forever,
which is exactly the observed behaviour.

Its unit tests pin the `›` shape against a hand-written fixture; nothing pins it
against the TUI the installed CLI actually draws, and the CLI has moved (the
live-contract helper keys OpenCode's ready state on `Ask anything` / `Build ·`,
not on `›`). Confirming *which* line the current composer renders is the first
step of the fix rather than something this note asserts.

Nothing in the repo covers this: `apps/desktop/tests/e2e/real/pty-runtime-status.test.ts`
exercises runtime status against a *scripted* agent binary, not a live provider
TUI, so the fixture and the product can drift apart silently. This is the same
class of failure as the 2026-08-06 transcript loss — a provider-owned surface
believed rather than pinned.

## Why it is not fixed here

It is not a transfer bug and the fix does not belong in the transfer engine.
`runtime_status` drives task activity, the sidebar's working/idle indicator and
the `task.awaiting_input` feed, so every OpenCode PTY task is affected, not just
one being transferred. Correcting it means establishing what the current
OpenCode composer actually renders and re-pinning the matcher against it — with
the standing constraint that status must stay a *positive* match on rendered
chrome and never be inferred from a session going quiet, because mislabelling a
long build as finished is worse than not labelling it.

That is its own change, with its own risk and its own tests.

## What the E2E asserts meanwhile

Everything the transfer engine itself controls, live:

- the wrap-up is injected into a real agent that is mid-turn, and the agent
  **answers** it — the claim no unit test can make, since it needs a real model
  reading a real message off a real PTY;
- that answer crosses the machine boundary: the destination's conversation
  carries both the wrap-up and the reply, in that order;
- the finalization state reaches the payload rather than being silently unset,
  and any degradation *other* than this idle-detection timeout fails the test.

What it cannot assert until the matcher is fixed: the `idle`, `quit-sent` and
`exited` phases, `cleanlyFinalized: true`, and the source session being gone.

Those are covered deterministically at the unit layer instead, where the status
stream is scripted rather than observed —
`transfer_engine/finalize.rs`'s `the_quit_command_is_never_typed_while_the_agent_is_busy`
walks the whole sequence against a daemon over a real Unix socket — and at the
daemon layer by
`crates/daemon/tests/handoff.rs::test_adopted_session_refuses_signals_but_quits_on_injected_input`,
which proves an adopted session really does quit on injected input.

## What would close it

Fix `opencode_status_from_lines` against the composer the installed CLI draws,
and add a live PTY contract test beside `tests/cli-contract/tests/live/opencode-injected-input.test.ts`
that renders the idle screen and asserts the daemon's matcher calls it `Idle`.
With that in place the assertions above move back into the E2E unchanged.
