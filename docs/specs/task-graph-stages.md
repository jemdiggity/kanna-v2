# Task Graph Stages

A ground-up redesign of how stages work in Kanna. Tasks become durable nodes in
a dependency graph; stages become mutable lifecycle state on a task; workflows
become per-task stage policy (which agent runs each phase, and where the human
sits); parallelism moves out of the stage engine and into cheap child-task
forks. One orchestrator — `kanna-server` — owns all of it.

> **Amended (2026-07-02):** see [Amendment: post-stage transitions](#amendment-post-stage-transitions-2026-07-02).
> Stages swap agent sessions; posts continue them. `execution: "continue"` is
> retired; `commit` is a post of `in progress`, not a stage.

## Motivation

Kanna's purpose is to give agents the same structure humans have had for
software engineering — implement, review, QA, ship — and to optimize where the
human sits in that loop. Two workflows must both be first-class:

- **Human-driven:** the human manually walks a simple task from `in progress`
  to `review`, then lets agents decide whether it is PR-ready or gets kicked
  back down to `in progress` for more work.
- **Manager-driven:** a capable model (e.g. Fable) plans and specs a larger
  feature, creates child tasks carried out by cheaper agents (Sonnet, Codex),
  and reviews the results at the end — balancing cost against required
  capability per phase. A review manager fans out parallel child tasks (e2e,
  security, networking, concurrency) over forks of the same branch.

Kanna is a **meta task creator**: humans are good at the broad strokes, so the
product optimizes for stamping out tasks quickly and giving them structure via
subtasking and dependencies. The engine's job is to execute that structure.

The current stage implementation fights both workflows:

1. **Two orchestrators.** The stage state machine exists twice: Rust
   (`crates/kanna-server/src/task_creator/stages.rs`, serving CLI/MCP/mobile/
   remote) and TypeScript (`apps/desktop/src/stores/workflow.ts` plus the
   auto-advance reaction in `stores/init.ts`, serving the native desktop).
   Every semantic change lands twice, and both react to the same
   `stage_result` column — the desktop's atomic-claim `UPDATE` is patching a
   real race.
2. **Stage hops destroy task identity.** Advancing a `new_task` stage closes
   the `pipeline_item` and creates a new one — new id, new branch, new
   worktree. Continuity is faked with `$BRANCH`/`$PREV_RESULT` prompt
   substitution and a regex that re-parses prompts to inherit titles
   (`stages.rs` `extract_reviewed_branch_from_prompt`). "Kick it back to
   in progress" — the most natural review verdict — cannot be expressed as
   what it is; `request_revision` spawns yet another task.
3. **No execution history.** `stage` is a free-form string; `previous_stage`
   remembers one hop; `stage_result` holds one result and is consumed as a
   mailbox. Reruns, revisions, and failures overwrite the record.
4. **`post_action` is a second kind of stage** with its own column
   (`active_post_action`) and its own transition branches in both
   orchestrators, capped at one per stage. Its actual purpose was automation:
   commit the work and advance without a human round-trip.
5. **Vestigial and dueling state.** `tags` survives only to mark `blocked`;
   `stage = 'done'` and `closed_at` are dueling sources of truth for
   visibility; the triple-maintained schema is already drifting.

Meanwhile the codebase has been growing the correct model organically:
`parent_task_id`, `task_blocker` (with DFS cycle detection),
`kanna_wait_task`, sidebar subtree nesting. That is a task
graph. The redesign promotes it to the core model and re-expresses stages on
top of it.

## Goals

- One orchestrator: `kanna-server` owns stage transitions; the desktop is a
  client of the same endpoints CLI/MCP/mobile/remote already use.
- Durable tasks: one task = one goal = one branch = one worktree for the
  task's whole life. Stage is mutable state, not task identity.
- Full execution history via `stage_run` rows, including kick-back cycles and
  per-run agent/model attribution.
- Parallelism through cheap child-task forks, not through the stage engine.
- Dependency-driven execution: tasks are armed at creation, dormant while
  blocked, and auto-start when their last blocker resolves (at blocker PR
  time, producing stacked branches).
- Workflows as per-task stage policy: which agent/model binds to each stage,
  and which transitions are automatic versus human-gated.
- Pin the workflow definition at task creation so editing
  `.kanna/workflows/*.json` cannot change in-flight semantics.

## Non-Goals

- No workflow-authoring UI. Workflows and agents remain files under `.kanna/`
  (plus the factory agents that generate them).
- No engine-enforced join semantics for parallel children. Integration is the
  parent agent's (or the human's) choice — see Fan-Out and Join.
- No change to the daemon protocol, PTY handling, or the headless-terminal
  authority model.
- No visual redesign of the sidebar. Fonts keep carrying activity (bold
  unread, italic working, normal read); structure stays minimal.

## Core Model

### Task

A task is a durable node in the repo's task graph:

- One goal (the prompt), one branch (`task-{id}`), one worktree
  (`{repo}/.kanna-worktrees/task-{id}`), for its whole life. *(Amended:
  the goal and the task row are for life; the branch and worktree are
  per-stage-run — see the amendment's "Workspaces fork per transition".)*
- `stage` is honest mutable state (`in progress ⇄ review → pr → done`). A
  stage transition swaps the agent session *inside* the task — possibly a
  different agent, model, or provider per stage — and never recreates the
  task.
- Graph edges: `parent_task_id` (subtask structure) and `task_blocker`
  (dependencies). Both are set by humans or agents through the same API.

**Agents are decoupled from worktrees.** An agent session is an execution
inside a task, not the task itself. Sequential phases of the same work share
the task's worktree; concurrent work forks a new one as a child task:

> Sequential phases of the same work share a worktree.
> Concurrent work forks one.

This aligns worktree topology with actual concurrency rather than with
lifecycle phases. It also respects a git constraint: one branch cannot be
checked out in two worktrees, so "same branch, new worktree per stage" was
never available — the old model forked a new branch per stage and rebuilt
continuity with string glue. Persisting the worktree is the honest option, and
it carries uncommitted/untracked state across kick-back loops for free.

### Stage run

A new `stage_run` table records every execution:

```
stage_run (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES pipeline_item(id),
  stage         TEXT NOT NULL,          -- stage name at time of run
  agent         TEXT,                   -- AGENT.md name
  agent_provider TEXT,
  model         TEXT,
  status        TEXT NOT NULL,          -- pending | running | succeeded | failed | cancelled
  result        TEXT,                   -- JSON { status, summary, metadata }
  feedback      TEXT,                   -- revision feedback that started this run
  session_id    TEXT,                   -- daemon session for this run
  started_at    TEXT,
  finished_at   TEXT
)
```

- The task's current stage is denormalized on `pipeline_item.stage`; the
  authoritative history is the run sequence.
- `$PREV_RESULT` is fed from the previous run's structured `result`, not from
  a consumable mailbox column.
- Kick-back (`request_revision`) is a new run of an earlier stage on the same
  task with `feedback` attached — history preserved, no task churn, no title
  archaeology.
- Cost/capability tiering becomes legible: the run history shows Fable spec'd
  it, Sonnet ran it twice, Fable reviewed it.

Retired by `stage_run`: `stage_result`, `active_post_action`,
`previous_stage`, and the `tags` column (blocked state derives from
`task_blocker`; visibility derives from `closed_at` alone).

### Workflows as stage policy

A workflow stops being a task-spawning engine and becomes per-task policy: the
ordered stage list, the agent/model binding per stage, and the HITL markers.

```json
{
  "name": "default",
  "stages": [
    { "name": "in progress", "agent": "implement", "transition": "manual",
      "post": { "name": "commit", "agent": "commit", "prompt": "Commit the relevant work." } },
    { "name": "review",      "agent": "review",    "transition": "auto" },
    { "name": "pr",          "agent": "pr",        "transition": "manual" }
  ]
}
```

- `transition: auto` — when the stage's run completes with `success`, the
  engine starts the next stage's run immediately. *(Amended: `post_action`
  does not dissolve into an auto stage; it becomes the stage's `post` — tail
  work injected into the stage's running session before the swap. See the
  amendment below.)*
- `transition: manual` — the run's success parks the task (activity `unread`)
  until a human advances it (⌘S) or an agent issues an explicit verdict.
- `mode: new_task` / `follow_task` are deleted: no stage transition creates a
  task anymore. `mode: continue` is simply how every transition works.
- Agent verdicts are the existing surface: `kanna_complete_stage`
  (success → auto-advance if the stage allows), and `kanna_request_revision`
  (kick back to a named earlier stage with feedback).
- The resolved workflow definition is snapshotted onto the task at creation
  (`pipeline_def` JSON column). Editing `.kanna/workflows/*.json` affects new
  tasks only.

### Dependency-driven execution

Kanna is opinionated: **creating a task arms it.**

- A task with no unresolved blockers starts its first stage run immediately
  (today's behavior).
- A task with unresolved blockers is **dormant**: worktree and DB row exist,
  no agent session is spawned.
- When a task's last blocker resolves, the engine auto-starts its first run.
  The human stamps out the DAG in thirty seconds; Kanna executes it in
  topological order, pausing only at `manual` markers.

**A blocker resolves when it reaches the `pr` stage** (not merge — PR review
is slow and waiting is unnecessary). Consequences the engine owns:

- The dependent's `base_ref` is set to the blocker's branch at unblock time —
  a stacked-branch workflow. The plumbing (`base_ref`) already exists.
- With multiple blockers, the engine merges the blockers' branches into the
  dependent's starting point.
- When a blocker's PR merges, dependents are retargeted/rebased onto the
  default branch — either programmatically or by instructing the dependent's
  agent. The merge agent should be extended to handle stacked PRs (merge in
  dependency order, retarget children).

### Fan-out and join

Parallel work is child tasks, created by agents (`kanna_create_task` with
`base_ref` = the parent's branch and `parent_task_id`) or by
humans. Each child is a full task: own branch forked from the parent's, own
worktree, own stage lifecycle — a child can run all the way to its own PR.

Join is deliberately not engine-enforced. Two sanctioned patterns:

1. **Parent integrates:** children report results back (review findings, or
   branches to merge); the parent agent octopus-merges child branches into the
   parent's branch and continues.
2. **Human integrates:** children proceed to PR; the human merges the PRs and
   informs the parent (via task input or by advancing it).

The engine's contribution is structured results and events: a child's terminal
`stage_run.result` is durable and queryable (`kanna_wait_task`,
`kanna_get_task`), while `kanna_wait_events` is the fan-out wake-up surface.
Completion is not typed into another task's session.

**Who drives:** the engine executes structure known in advance (the linear
stage rail, declared transitions); agents create structure discovered at
runtime (a review manager deciding this change needs a concurrency review).
Both go through the same primitives, so an engine-driven transition and an
agent-created child are not different kinds of things.

## Single Orchestrator

`kanna-server` is the only stage engine. The endpoints keep their shapes:

- `POST /v1/tasks/{id}/actions/advance-stage` — start the next stage's run in
  place (kill/finish the current agent session, spawn the next stage's agent
  in the task's worktree, update `stage`, insert a `stage_run`).
- `POST /v1/tasks/{id}/actions/complete-stage` — record the run result for the
  spawn-bound `runId` (stale/replaced run ids are rejected, while an exact
  already-committed retry is idempotent; omission is accepted only for a
  durable pre-upgrade unbound run); on
  `success` with `transition: auto`, advance. On `failure`, mark the run
  failed and park the task.
- `POST /v1/tasks/{id}/actions/request-revision` — insert a run for the
  target earlier stage with feedback; move `stage` back; respawn.

The native desktop deletes its parallel implementation: `advanceStage`/
`rerunStage` orchestration in `stores/workflow.ts` and the `stage_result`
auto-advance reaction in `stores/init.ts` are replaced by calls to the server
endpoints — the exact path the remote/cloud desktop
(`useAppCloudWorkspace.ts`, `desktopRelayTerminal.ts`) already uses. The TS
workflow module in `packages/core` shrinks to parsing/validation for display.

New engine responsibilities:

- **Unblock watcher:** when a task enters `pr`, resolve dependents; for each
  fully-unblocked dormant task, set `base_ref` and start its first run.
- **Session-per-run:** daemon session ids become per-run
  (`{task_id}` → `{task_id}-r{n}` or equivalent) so the terminal tab can show
  the current run and history remains attributable.
- **Merge retargeting:** on blocker PR merge, retarget/rebase dependents onto
  the default branch (directly or by instructing the dependent's agent).

## UI

Minimal and font-driven, as today:

- Activity: bold = unread, italic = working, normal = read. No badges.
- Structure: tree indentation for parent/child (extends `sidebarSubtreeRows`).
- Dormant (blocked) tasks: the existing dimmed treatment — now meaning
  something, since dependencies drive execution.
- Sidebar stage grouping keeps working and becomes truthful: stage is real
  mutable state, and tasks no longer vanish/reappear across stage hops, which
  also removes the selection-chasing logic (`restoreStageAdvanceSelection`).
- The task header's stage badge now reflects a task's whole journey; the
  terminal tab hosts successive stage runs.

## Schema Changes

- `pipeline_item`: add `pipeline_def` (JSON snapshot). Stop writing `tags`,
  `stage_result`, `active_post_action`, `previous_stage` (drop after
  migration). `stage = 'done'` sentinel is retired; `closed_at` alone governs
  visibility.
- New `stage_run` table (above), with an index on `(task_id, started_at)`.
- `task_blocker` unchanged; `blocked` display state derives from it.
- Migration: in-flight tasks get a synthetic `stage_run` from their current
  `stage`/`stage_result`; legacy `post_action` workflows compile to
  interleaved auto stages on load.

## Migration Phases

Each phase ships independently and leaves the system working:

1. **Single orchestrator.** Desktop store calls the server action endpoints;
   delete the TS orchestration and the `stage_result` reaction. No schema
   change. (Kills the dual implementation and the auto-advance race.)
2. **`stage_run` + workflow snapshot.** Introduce the table and
   `pipeline_def`; the engine writes runs alongside existing columns; feed
   `$PREV_RESULT` from runs.
3. **Durable tasks.** Stage transitions and revisions become in-place;
   `mode`/`follow_task`/`post_action` compile away; notify and title
   inheritance drop their prompt-parsing hacks.
4. **Dependency-driven execution.** Armed-on-create, dormant-while-blocked,
   auto-start at blocker PR with stacked `base_ref`, merge-agent stacking.
5. **Cleanup.** Drop retired columns; remove `tags` plumbing and the
   `'done'`-stage sentinel.

## E2E Coverage

Stage semantics cross client/server/daemon/git boundaries, so each phase adds
E2E coverage per the repo's expectation:

- Phase 1: desktop-driven advance/revision through the server endpoint against
  a real daemon (extends the existing server-boundary notify tests).
- Phase 3: in-place transition — one task, sequential agent sessions, same
  worktree; kick-back preserves uncommitted state.
- Phase 4: two-task DAG — blocker reaches `pr`, dependent auto-starts with
  stacked `base_ref`; blocker merge retargets the dependent.

## Amendment: post-stage transitions (2026-07-02)

The first implementation of this spec dissolved `post_action` into ordinary
stages with `policy.execution: "continue"` — and then never implemented
`continue`. Every stage transition killed the running agent session and
spawned the next stage's agent fresh in the same worktree. For the default
workflow's `commit` stage this was a strict regression over the old
post-action: the implement agent knew which changes were the task and which
were scratch, and could write the commit from memory; the fresh commit agent
had to reconstruct all of that from `git status`, paying a full CLI spawn for
a thirty-second action.

The dissolve was also the wrong unification. There are two genuinely
different kinds of transition, and the model should say so:

- **A stage swaps the session.** Fresh context is the point: review wants an
  agent that did not write the code; each stage can bind a different
  agent/model/provider. This is the cost/capability tiering the redesign
  exists for.
- **A post continues the session.** Existing context is the asset: "commit
  your work" is tail work of the stage that produced the work. It is not a
  lifecycle phase; the task never leaves its stage while a post runs.

> Stages swap sessions. Posts continue them.

### Post declaration

A stage may declare one `post` — work injected into the stage's running agent
session when the stage transitions forward:

```json
{
  "name": "in progress",
  "agent": "implement",
  "prompt": "$TASK_PROMPT",
  "policy": { "transition": "manual" },
  "post": {
    "name": "commit",
    "agent": "commit",
    "prompt": "Commit the relevant work for this task. Original task: $TASK_PROMPT"
  }
}
```

- `post.name` labels the run in history. `post.prompt` (with the usual
  `$VAR` substitution) is submitted as input to the live session, along with
  a reminder to record stage completion.
- `post.agent` is the **fallback**: when the session is dead (suspend/kill
  timeout, user quit), the post is spawned as a fresh session with this
  agent, and the agent's prompt body also feeds the injected message. When
  the session is alive, whatever agent is already running executes the post —
  the binding is honestly a fallback, not a guarantee.
- `policy.execution` is retired. Legacy `post_action` and legacy interleaved
  `execution: "continue"` stages (including pinned `pipeline_def` snapshots
  written by the first implementation) compile into a `post` on the preceding
  stage at load time. A task parked *at* a folded stage name (e.g. `commit`)
  is treated as sitting in that post's owner stage.

### Transition semantics

- **Manual stage with a post** (⌘S): the advance dispatches the post into the
  running session; `stage` does not change. When the post's run completes
  with `success` (agent verdict), the engine performs the swap to the next
  stage. A second ⌘S while the post is still running is a human override:
  swap immediately.
- **Auto stage with a post**: main run success dispatches the post; post
  success performs the swap.
- **Post failure** parks the task (activity `unread`); a later advance
  re-dispatches the post.
- Post executions are `stage_run` rows with `kind = 'post'` (main runs are
  `kind = 'main'`), recording the post name as the run's stage label and the
  actually-executing agent/session. Kick-back to an earlier stage resets the
  post: the next advance runs it again.

The default workflow becomes `in progress` (post: `commit`) → `review` →
`pr`. The sidebar never shows `commit`: committing is the tail of
`in progress`, which is what it always was in practice.

### Workspaces fork per transition

Task *identity* is durable — the row, the run history, the blockers, the
notify wiring. The *workspace* is not: it is an ephemeral manifestation of
the task, and its name says so — `task-<id>-<n>`, the durable task id plus
a workspace counter (the creation workspace is plain `task-<id>`). Meaning
is assigned at the end, when the PR agent renames the final branch into
something worth publishing.

- **N worktrees, N branches, one PR.** Each stage transition (advance, auto
  completion after a post, revision) forks a fresh branch and
  worktree named `task-<id>-<n>` from the current branch's committed tip
  and moves `pipeline_item.branch` with it. The previous worktree stays on disk until
  cleanup; only committed work crosses a stage boundary — the stage's post
  (commit) is what establishes that invariant, so posts and reruns keep the
  stage's live workspace while transitions fork.
- **Fresh state is the point.** The next stage's agent inherits no running
  dev servers, no half-mutated env, no untracked scratch — it sets up its
  workspace through the repo's declared setup commands, the same path task
  creation uses. "Review passed because of leftover state" is not a bug
  class agents notice.
- The fork starts from the branch actually checked out in the previous
  worktree (`resolve_current_source_worktree_branch`), so agent-performed
  branch renames — the PR agent's job — are honored.
- A human override (⌘S while a post is still running) forks from the
  committed tip like any transition: uncommitted work stays behind in the
  abandoned worktree, by design. The post exists so that doesn't happen in
  the normal flow.

### Session lifecycle across transitions

Transitions keep the daemon session id equal to the task id and respawn it
(in the forked worktree). The stale worktree's shell session
(`shell-wt-{task}`) is killed on fork so ⌘J opens in the new workspace. Two
consequences the first implementation missed are now owned explicitly:

- **The desktop terminal rebinds on respawn.** The daemon already broadcasts
  session creation through the event bridge (`session_created`); the terminal
  lifecycle treats it as the signal to clear its exited state and re-attach
  to the new session. Previously the terminal saw `session_exit`, latched
  `sessionExited`, and went permanently dead while the next stage's agent ran
  invisibly — the ⌘S "nothing happened" bug.
- **Orchestrated kills are not completions.** The engine finishes the current
  `stage_run` row *before* killing the session it replaces, and the server's
  Exit watcher only treats a daemon `Exit` as agent completion when the task
  still has a running `stage_run` for that session; an in-process
  replacement guard covers the kill→spawn window. Previously an advance's
  kill could be misread as the agent finishing and prematurely finalizing its
  runtime/run state.

Per-run daemon session ids (`{task_id}-r{n}`) remain the eventual model if
TerminalTabs grows per-run history (the `stage_run.session_id` column and
`resolve_task_terminal_session_id` already accommodate it), but they are not
required for correctness under the rebind + finish-before-kill invariants,
and they would ripple through the cloud terminal protocol, mobile attach,
and every session→task lookup today.

## Open Questions

- Stacked-PR retargeting mechanics: pure `git rebase --onto` by the engine
  versus instructing the dependent's agent. Start with the agent instruction
  (safer with in-flight work) and graduate to programmatic rebase.
- Whether a dormant task's worktree is created at creation time or first run.
  Deferring to first run keeps `base_ref` assignment (blocker branch) natural;
  creating early lets humans open a shell in it. Default: defer.
- Per-run daemon session naming and how TerminalTabs presents run history.
