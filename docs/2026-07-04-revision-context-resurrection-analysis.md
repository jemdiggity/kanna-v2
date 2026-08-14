# Resurrecting the implement agent on review feedback — analysis

**Date:** 2026-07-04 (revised 2026-07-05)
**Status:** Implemented 2026-07-05 — revisions resume by default with a
recorded fresh-fork fallback; see `prepare_revision_resume` in
`crates/kanna-server/src/task_creator/stages.rs` and
`docs/2026-07-05-revision-resume-e2e-note.md`. The sections below are the
analysis that motivated the design.

## Question

In the typical `implement → review → pr` workflow, the implement and review
stages often iterate several times. Today, when a review agent sends the task
back with `kanna_request_revision`, the implement stage gets a **completely
fresh agent** with cleared context. Would resurrecting the previous implement
agent's session (conversation context intact) improve agentic performance?

## Current behavior (verified against the code)

- A revision is prepared by `prepare_revision_task_for_api`
  (`crates/kanna-server/src/task_creator/stages.rs:336`) with
  `run_kind = "main"` and the reviewer's prompt as `prompt_override`.
- Because `run_kind == "main"`, the run **forks a brand-new branch + worktree**
  from the task's committed tip (`stages.rs:282-286`) — it reuses neither the
  review worktree nor the original implement worktree.
- Execution (`spawn_prepared_stage_run_for_api`,
  `crates/kanna-server/src/task_creator/lifecycle.rs:106`) kills the live
  agent session and spawns a **fresh `claude` process** via
  `initial_spawn` — never `--resume`.
- The new agent's entire knowledge of history is: the stage/agent prompt with
  `$TASK_PROMPT` substituted to the **reviewer's revision prompt** (the
  original task prompt is clobbered by `prompt_override` —
  `stages.rs:274-276`), `$PREV_RESULT` (the last finished run's summary
  string), and the committed git tree.
- The machinery for resurrection already half-exists: the Claude CLI's own
  resumable session id (`provider_session_id`) is captured from stream-json
  and persisted in the daemon's per-session journal
  (`crates/daemon/src/agent_runtime/readers.rs:158-160`), and
  `resume_spawn` builds `--resume <id>`
  (`crates/kanna-agent-protocol/src/claude.rs:344`). But that path is wired
  only for crash-recovery and per-turn providers (Codex/OpenCode)
  (`crates/daemon/src/agent_runtime/commands.rs:232-256`). Every stage
  transition, rerun, and revision deliberately fresh-spawns. The
  `provider_session_id` is never stored in SQLite — only in the daemon
  journal.

## What revision feedback actually looks like

The abstract worry with resuming an agent after critical feedback is
anchoring: an agent invested in its approach patches minimally instead of
rethinking. That worry assumes the feedback is *approach-level* ("this design
is wrong"). In this workflow it structurally is not:

- The review agent (`.kanna/agents/review/AGENT.md`) is a **QA/coverage
  agent**. Its entire prompt is about whether test coverage matches the risk
  of the change; it is explicitly forbidden from making code changes and told
  to request a revision when coverage is missing or weak.
- In practice its revision requests are therefore mechanical and additive —
  overwhelmingly "add E2E/integration coverage for X" — matching observed
  reviewer behavior on this repo.
- Reviewer and implementer are peer frontier models (Claude, Codex, …)
  working from the same codebase and the same CLAUDE.md conventions.
  Approach-level rejections between them are rare to nonexistent; design
  disagreements that do matter surface at the human PR review, after this
  loop.

For that kind of feedback, the implement agent's context is a **pure asset**,
not a liability. Its memory of what it built, why, and where the seams are is
exactly the right context for writing tests for it. There is no prior
reasoning being rejected, so there is nothing to be anchored *to*.

## What the fresh spawn costs

1. **The exploration investment.** The implement agent spent a large fraction
   of its run building a mental model — which files matter, how the layers
   wire together, what the tests cover. A fresh agent re-pays that ramp-up
   (tokens + wall clock) on every iteration of the loop.
2. **Decision rationale.** Approaches tried and rejected, gotchas discovered
   (a flaky test, a load-bearing hack, a constraint that forced design B over
   design A) live only in the conversation. A fresh agent can re-walk into
   the exact dead end the previous agent already escaped.
3. **The original intent.** Verified gap: the revision prompt *replaces*
   `$TASK_PROMPT`, so the fresh agent doesn't even see the original task
   prompt unless the reviewer restates it. Scope drift and churn (rewriting
   things the review already approved) follow directly from this.

Against this, the costs of resuming are minor: a resumed session re-reads its
transcript at cache-write prices (the prompt cache will have expired during
review), but that is comparable to what a fresh agent spends re-exploring,
and resume wins on latency. Long-context degradation is handled by the agent
itself — modern CLIs compact their own context — and revision loops here are
a handful of iterations, not dozens.

## Verdict: resume by default

Resurrection is the right default for this workflow. The revision loop is an
interactive steer-the-same-session pattern — the best-performing agent loop
we know of — artificially broken today by a fresh spawn that discards the
context most useful for acting on the feedback. Fresh spawn should remain
only as a **mechanical fallback** when resumption isn't technically possible,
not as a judgment call exposed to the reviewer.

## Technical constraints on resurrection in Kanna

1. **Sessions are cwd-scoped.** Claude CLI transcripts live under
   `~/.claude/projects/<cwd-slug>/` — verified locally, one slug per worktree
   path. `--resume <id>` in a *freshly forked* worktree won't find the old
   worktree's transcript. So a resumed revision should **reuse the previous
   implement worktree** instead of forking. This is safe when that worktree's
   branch tip still equals the task's committed tip — which is the normal
   case: the implement post commits before the transition, and the review
   agent is forbidden from committing. If the tips have diverged (edge case),
   fall back to fresh + fork. Copying the transcript `.jsonl` into the new
   slug directory would work mechanically but couples Kanna to CLI
   internals; not recommended.
2. **`provider_session_id` isn't in the DB.** It lives only in the daemon
   journal keyed by daemon session id — and revisions *reuse* the daemon
   session id, so the journal metadata is overwritten on respawn. Persisting
   `provider_session_id` per `stage_run` row (captured at run finish) is the
   cheap prerequisite. Also independently useful for debugging/forensics.
3. **Keep-alive steering is the other route.** The context-preserving path
   that already exists in production is live-session stdin
   (`try_submit_task_input` → daemon `Plan::StdinLine`). Keeping the
   implement session *alive* through review would avoid `--resume` entirely —
   but it conflicts with the "kill the previous stage's session" invariant
   (`lifecycle.rs:100-105`), holds a PTY + child process per in-review task,
   and review latency can exceed the Kill After timer (default 30 min).
   Resume-respawn from the journaled session id is the better fit: zero
   standing cost, and it's the exact mechanism the daemon already uses for
   crash recovery.
4. **Provider asymmetry is small.** Codex/OpenCode are per-turn providers
   that already resume by session id on every message, so a resume-based
   revision generalizes across providers; only the spawn-site wiring differs.

## Prompting design for the resume path

The flow stays the one that exists today up to the last hop: the review agent
calls `kanna_request_revision` (MCP, or `kanna-cli task request-revision`)
→ `POST /v1/tasks/{task_id}/actions/request-revision` → kanna-server
(`http_api/task_actions.rs`) prepares the transition → daemon. Only the
daemon-facing step changes: instead of kill + `initial_spawn` with a full
stage prompt, kanna-server resumes the implement session and delivers a
**revision message** as the next user message (the daemon's resume-respawn
path, `agent_runtime/commands.rs:232-256`, already does exactly this given a
`provider_session_id`).

**kanna-server composes the revision message; the reviewer does not.** The
reviewer's `prompt` param stays free-form feedback, and the server wraps it.
The message restates the original task prompt alongside the feedback — even
though the resumed session saw the original prompt at spawn time, it may
since have been compacted away, and restating it re-anchors the turn and
makes the message self-contained:

```
Review feedback requires changes before this task can proceed to PR.

Original task:
<pipeline_item.prompt>

Reviewer feedback:
<reviewer's revision prompt>

Address the feedback in this worktree, then record stage completion
(kanna_complete_stage / kanna-cli stage-complete) as before.
```

Deliberately **not** resent: the implement agent definition (AGENT.md body)
and stage scaffold — those are already the session's standing instructions,
and re-injecting the full stage prompt mid-conversation reads as a new task
rather than a continuation. The one-line completion reminder is cheap
insurance against the standing instructions having been compacted.

The same composition fixes the fresh fallback path for free: when the
fallback fires, use `original task prompt + reviewer feedback` as the
`$TASK_PROMPT` substitution instead of letting `prompt_override` clobber the
original — one server-side composition function
(e.g. `build_revision_message` next to `build_stage_prompt` in
`task_creator/prompt.rs`) feeding both paths. The `stage_run.feedback`
column keeps storing the reviewer's raw feedback, not the composed message.

## Recommended direction

In order of value-per-effort:

1. **Persist `provider_session_id` on `stage_run`.** Cheap, provider-neutral,
   prerequisite for the rest.
2. **Make revision resume by default.** `request_revision` targets the
   previous implement worktree and resumes via `resume_spawn` with the stored
   session id, delivering the composed revision message (above) as the next
   user message. On any mechanical impossibility (missing session id, missing
   worktree, divergent branch tip, provider without resume support) fall back
   to today's fresh + fork behavior — as an explicit, recorded fallback (log
   it and store which mode ran on the `stage_run` row), not silent behavior.
3. **Use the same composed message on the fresh fallback path** so the
   original task prompt is never lost, fixing the `prompt_override`
   clobbering gap uniformly.

## E2E note

This is an analysis document only — no behavior changed, so no tests
accompany it. If the recommendation is implemented, the revision-resume
boundary crosses server/daemon/CLI and needs coverage in the same style as
the existing server-boundary notify tests: a fake-daemon test asserting the
resume spawn command (`--resume <stored-id>`, previous worktree cwd) for the
default path, and the fresh + fork fallback when the stored session id is
absent or the branch tip has diverged.
