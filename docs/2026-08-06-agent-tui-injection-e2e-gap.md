# Agent-TUI injection: what the live contract suite cannot pin

Date: 2026-08-06
Related: `docs/2026-08-06-task-transfer-rearchitecture-plan.md` (Phase 0 / T4,
Decision 3), `tests/cli-contract/tests/live/`

## Why this note exists

Task transfer's finalization redesign (Decision 3) stops signalling the agent
with `SIGINT` and instead injects input into the live PTY: a wrap-up message,
then — once the session is `Idle` — the provider's quit command. That leans on
two provider-owned behaviors, and the whole point of Phase 0 was to stop
assuming them:

1. input written to the PTY master is accepted exactly like typing, slash
   commands included;
2. the quit command preempts an agent that is mid-turn (which is *why* the
   sequence waits for `Idle` first — quitting early truncates the wrap-up).

Both are now pinned by live tests **against OpenCode**; the quit command itself
is additionally pinned against **Codex** (execution, not preemption). Neither is
pinned against **Claude**.

## The gap

Claude's interactive TUI is not driven by any test in this repo. The repo's
standing position is that live tests for interactive/PTY-driven agent behavior
use OpenCode's free models; programmatically driving the Claude TUI is not
something we do in tests, so `/exit` behavior in Claude's TUI — its parity with
typing, and whether it preempts a busy turn — remains **manually verified only**
(product-owner observation, recorded in the plan's open-questions table as
"assumed yes").

What was pinned for Claude instead, headlessly, in
`tests/cli-contract/tests/live/`:

| File | Pins |
|---|---|
| `claude-transcript-location.test.ts` | transcripts live at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`; the slug rule (every non-alphanumeric character → `-`); `~/.claude/tasks/<session-id>` holds no conversation |
| `claude-transcript-append.test.ts` | the user turn is on disk **before** the process exits — the licence for finalization's degraded-mode snapshot |
| `claude-resume-rekey.test.ts` | a transcript copied into another cwd's project directory resumes there (exactly what transfer re-keying does); `--resume` with no transcript exits non-zero with `No conversation found with session ID: <id>` rather than silently starting fresh |

Those cover the data-loss half of the incident completely. They do not cover
the injection half for Claude.

## What would make it testable

- A supported non-interactive way to ask a running Claude session to wrap up and
  exit — anything that does not require synthesising keystrokes into the TUI.
  Kanna already drives Claude through a PTY in production; the constraint is on
  *test automation*, so an equivalent, sanctioned control surface (a signal, a
  control file, a documented headless quit) would close this immediately.
- Failing that, an E2E at the Kanna layer rather than the CLI layer: a task
  running under the daemon, finalized through the server-side sequence, asserting
  the daemon `Exit` event and a transcript containing the wrap-up. That exercises
  the same bytes without a test harness impersonating a user at a TUI, and it is
  the E2E Phase 4 already owes (`docs/…-plan.md`, Phase 4 E2E expectation).

Codex mid-turn preemption is unpinned for a smaller reason: proving a Codex turn
is in flight means letting it write a file, which means answering its approval
prompts, and the marginal evidence did not justify that machinery. OpenCode
covers the behavior; Codex covers that the quit command works at all.

Until one of those exists, treat Claude `/exit` preemption as unverified by CI.
Decision 3's sequence is safe either way: it waits for `Idle` before quitting, so
it does not *depend* on preemption — preemption only decides whether the
degradation ladder's forced quit truncates work or blocks.

## What the tests settled about the quit command

`kanna-server`'s submission policy is "write the whole message, wait 150 ms, send
CR" (`crates/kanna-server/src/http_api/task_input.rs`, `SUBMIT_ENTER_DELAY_MS`).
Codex's composer opens a command popup on `/`, so it was not obvious that a
burst-written slash command would survive it. It does: `codex-tui-quit.test.ts`
pins that a burst `/quit` raises `/quit  exit Codex` in the popup and the discrete
CR exits the process, with paced keystrokes covered as a second case. Decision 3
step 3 can therefore use the ordinary input helper for Codex — no
provider-specific keystroke pacer.

One trap for anyone driving these TUIs in a test: codex asks "Do you trust the
contents of this directory?" before the composer exists, and input written while
that modal is up is consumed by it. An early probe that skipped the prompt
concluded — wrongly — that codex drops burst-written slash commands. The tests
answer the trust prompt explicitly and run against an isolated `CODEX_HOME` so
the answer does not accumulate in the developer's real `~/.codex/config.toml`.

## Narrower coverage added meanwhile

- `opencode-injected-input.test.ts` — a message written to the PTY master and
  submitted with a discrete CR is acted on by a real agent; `/exit` injected the
  same way ends the session; and a quit injected while the agent is demonstrably
  mid-turn (first step's file written, last step's not) exits within 30 s without
  finishing the turn.
- `codex-rollout-timing.test.ts` — the rollout under
  `~/.codex/sessions/<y>/<m>/<d>/` is nameable *before* exit but still growing at
  that point, so the current mid-session scan
  (`findCodexRolloutArtifact`, `apps/desktop/src/stores/transfer.ts:244`) stages a
  truncated conversation. This is the direct evidence for staging after the daemon
  `Exit` event.
- `tests/cli-contract/tests/offline/claude-project-slug.test.ts` — the slug
  derivation shared by the transfer source and receiver
  (`packages/core/src/claude-transcript.ts`), runnable without any CLI installed.
