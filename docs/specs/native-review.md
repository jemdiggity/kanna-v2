# Native Review

Status: phase 1 implemented; phases 2-3 proposed
Related: [merge-master.md](./merge-master.md),
[task-graph-stages.md](./task-graph-stages.md),
[forge-independence.md](./forge-independence.md) (parked horizon)

Review a task's diff in Kanna, comment on lines, and send the task back
down the workflow with those comments as the revision prompt — then let it
climb back up to PR. Merge-master established **git ≠ gh** for merging and
deferred line-anchored feedback; this spec is that follow-up, rescoped
after a deliberate rethink.

## The rethink: feedback is a message, not a record

An earlier draft of this spec added `review_thread`/`review_comment`
tables, `/v1` review endpoints, MCP thread tools, and a re-anchoring
algorithm — importing the *forge's* data model into Kanna. That was wrong
for what Kanna is: **scaffolding for agents**. In Kanna, review feedback
is a message to an agent, and messages need composition and delivery, not
storage. The durable record already exists twice over:

- `stage_run.feedback`/`result` hold what was said and what came back —
  the task's run history *is* the review history;
- for forge users, the forge remains the durable conversation store. A
  team that wants comments on the GitHub PR hands the composed feedback
  to a user-space agent that posts it via `gh`. The engine never learns
  what GitHub is.

So: **no new tables, no new endpoints, no persistent threads, no
re-anchoring.** Comments are ephemeral, per review pass, composed into a
prompt and delivered through the engine actions that already exist.

## The flow

1. A task parks at a reviewable stage (`review` awaiting a human, or
   `pr`). The operator opens ⌘D (branch scope).
2. **Comment on lines.** Click a line number (drag for a range); an
   inline composer opens. Comments accumulate client-side — a badge
   shows the count, and a drawer (`c`) lists them for jumping, editing,
   and deleting.
3. **Request changes** (`⇧⌘S`): the comments (file, line range, hunk
   excerpt, note) plus an optional summary are assembled into a prompt
   and sent as `POST /v1/tasks/{id}/actions/request-revision` with
   `target_stage: "in progress"`. The engine does the rest — it already
   resumes the implement session in its worktree with the composed
   message (or forks fresh when resume preconditions fail), and the task
   proceeds back up the ladder: in progress → review → pr.
4. **Approve** (`⌘S`): approval *is* the existing advance-stage action —
   no new chord, no new concept; the `advanceStage` binding's context
   just grows from `["main"]` to include `diff`. What approval *means*
   is whatever the workflow wired there — a `pr` stage approve post
   signaling a GitHub merge agent, a merge-queue signal, or nothing but
   a stage swap. User-space, per merge-master.md.

### Composed revision prompt

```
Revision requested from review of task-8f41c409 @ 83b57a05 (branch diff vs main).

apps/desktop/src/stores/workflow.ts:118-124
> (excerpt of the commented lines)
This retry loop hides the real error — surface it and drop the loop.

crates/kanna-server/src/http_api/task_actions.rs:41
> (excerpt)
Same guard as close_task; extract and share it.

Overall: good direction; fix the two issues above and re-run the daemon tests.
```

Plain text, file:line-anchored, self-contained — agent-native. It is
persisted exactly where revision feedback already lives (`stage_run` of
the revision run), and `build_revision_resume_message` /
`build_revision_task_prompt` (`task_creator/prompt.rs`) wrap it with task
context as they do today. The review-stage QA agent is encouraged (in its
AGENT.md) to use the same file:line format in its own
`kanna_request_revision` calls — one convention for human and agent
feedback, enforced by prompt, not schema.

### Comment lifetime

Comments are keyed to (task, head commit) in frontend state, alongside
the per-task view state ⌘D already keeps (`useAppModals.ts`
`diffViewStates`). If the branch tip changes under an unsent review pass,
the comments are stale by definition — surface them in the drawer as
"written against <old-sha>" for copy-out rather than silently dropping
them. Sent comments need no lifetime: they became a prompt.

## UI work

All frontend; the engine needs nothing new.

- **Comment gutter/overlay** in `DiffView.vue` — the @pierre/diffs spike,
  now smaller: map rendered line elements to (file, line) and position an
  overlay composer and comment chips; no persistent thread rendering, no
  cross-revision anchoring. If shadow-DOM internals make per-line overlay
  brittle, a margin rail aligned to rendered line positions is an
  acceptable fallback.
  - Implementation note: phase 1 uses @pierre/diffs public line
    interaction callbacks (`onLineNumberClick` / `onLineSelected`) and
    renderer-provided line metadata rather than querying shadow-DOM
    internals directly. The composer overlay is still owned by
    `DiffView.vue` and anchored to the rendered line when the renderer
    supplies its element.
- **Verdict bar** in `DiffModal.vue`, shown when the task is parked at a
  reviewable stage: comment count, Request changes, Approve. Wired
  through `stores/workflow.ts::postTaskAction` to the existing
  `request-revision` / `advance-stage` actions.
- **Keyboard.** The diff modal's keyscape is crowded and must be
  respected: `useLessScroll` owns `j/k/f/b/d/u/g/G/q` (and space/arrows)
  for scrolling, `/`+`⌘F` own search with `n/N` while searching, `s`
  cycles the working filter, `⇧⌘[`/`⇧⌘]` cycle scopes, and Escape
  closes. Chords already bound elsewhere are off the table even when the
  context system would technically allow reuse: `⇧⌘A` is Analytics,
  `⌘R`/`⇧⌘R` are read-navigation. New bindings, registered as
  supplementary shortcuts in the `diff` context (so `⌘/` lists them):
  - **`⌘S` approve** — the existing `advanceStage` action, context
    extended to `diff`. Advancing *is* approving; one meaning, one chord.
  - **`⇧⌘S` request changes** — the shifted counterpart to `⌘S`: send the
    task back down. Opens the summary composer with the pending comments
    listed; `⌘Enter` sends.
  - **`c` toggle comment drawer** — the only free single letter that
    reads as "comments"; drawer entries jump on click/Enter.
  - **Composer keys**: `⌘Enter` submits (the NewTaskModal convention),
    Escape closes the composer *keeping the draft*. Escape layers:
    composer → drawer → modal, one level per press. While any text
    input has focus, single-letter shortcuts are inert (the existing
    input-element guard in `useLessScroll`).
  - **Deliberately absent**: per-comment next/prev keys. Targeting a
    line for commenting is pointer-first in phase 1 — the modal has no
    keyboard line-cursor, and inventing one (with all of `j/k` already
    meaning scroll) is its own design problem. If review sessions turn
    out to want it, a line-cursor mode is future work with its own
    thinking; bracket keys are ruled out regardless (shadowed by the
    scope-cycle pair, and awkward on the JIS/Korean layouts the app
    ships locales for).
- Sidebar: no dedicated review badge — a badge was tried and cut
  (operator preference: tasks parked at `pr` either advance, close, or
  go back to `in progress`, and the stage sections already say which).
  Unread bold plus ⌘⌥↑/↓ make the review queue workable.

## Agent polymorphism (making "what approval means" frictionless)

Kanna's agent system is already duck-typed with late binding: workflows
dispatch by name (`agent: merge`), resolution is repo file → built-in
resource, `EXTEND.md` layers overrides. Three cheap additions make the
setup path frictionless and tested:

1. **Flavors.** Built-ins ship variants of a role:
   `pr@draft-pr`, `pr@push-only`, `merge@github`, `merge@git`. Selection
   is one line (`agent: merge@github` in a workflow stage, or a
   `flavors` map in `.kanna/config.json`) instead of copying AGENT.md
   files. Resolution order stays: repo override → built-in flavor →
   built-in default. Repo overrides and extensions are role-scoped:
   `.kanna/agents/pr/AGENT.md` or `.kanna/agents/pr/EXTEND.md` apply even
   when the stage selects `agent: pr@push-only`.
2. **Contracts.** A role is defined by the tool calls it must make —
   `pr` ends with `kanna_complete_stage` (+ resolved `metadata.pr_url` when a PR exists); `merge`
   consumes a server-owned candidate handoff;
   `review` ends with `kanna_complete_stage` or `kanna_request_revision`
   (file:line-formatted feedback). Contracts are documented per role and
   enforced by tests: prompt renders, referenced tools exist in the
   catalog (`crates/kanna-tool-catalog`), and an E2E smoke with a cheap
   live model makes the required calls (the `tests/cli-contract` pattern,
   extended).
3. **Config-var substitution.** Stage prompts already substitute
   `$BRANCH`/`$BASE_REF`/etc.; let AGENT.md bodies substitute variables
   declared in `.kanna/config.json` `vars`, so one agent body can
   parametrize on a repo-declared merge strategy instead of forking into a
   new file. Runtime variables (`$BASE_REF`, `$BRANCH`, `$KANNA_TASK_ID`,
   `$PREV_RESULT`, `$SOURCE_WORKTREE`, `$TASK_PROMPT`) stay runtime-bound
   and are not replaced by repo config.

A fourth kind is unique to agents — **inference-time dispatch**: an agent
told to inspect the environment (GitHub remote? `gh` authed? branch
protection?) and adapt. Least deterministic, so it belongs in setup, not
the hot path:

### The setup agent

A `setup` factory agent (composing the existing `agent-factory` /
`workflow-factory` / `config-factory`) runs at repo import or on demand:
inspects the repo to pre-answer what it can (remote URL, `gh auth
status`, CI config), asks only what it must ("how much review? ordinary
PRs, drafts, or push-only? merge yourself or a merge agent?"), then
writes the `.kanna/` files — flavor selections, an EXTEND.md where an
answer doesn't match a stock flavor, and a workflow JSON only when the
built-ins do not already cover the shape. It composes tested flavors; it
does not author agents from scratch. The stock preset is the GitHub
flow, which *selects* a built-in workflow (`no-review`, `single-reviewer`,
or `specialized-reviewers`) and attaches `merge@github`:
`pr` → review in ⌘D → approve post → `merge@github`.

The answers are not independent, and the setup agent enforces a closed
composition rule. Every built-in ends with a `pr` stage plus an `approve`
post, and `approve` resolves the PR with `gh pr view` and fails when none
exists — so direct built-in selection is valid only for the ordinary-PR
flow. `pr@push-only` publishes no PR and therefore implies manual merge
plus a repo-local workflow with the `approve` post dropped; manual merge
alone drops it too; `pr@draft-pr` with a merge agent additionally needs a
repo-local `approve` EXTEND.md that readies the draft, because
`merge@github` cannot merge a draft.

## Phasing

1. **The loop** — comment composer + drawer + verdict bar; request-changes
   composition into `request-revision`; approve → advance. Ships the full
   review-in-Kanna experience for a GitHub user with zero engine changes.
2. **Flavors and contracts** — stock `pr`/`merge`/`approve` variants,
   contract docs + tests, config-var substitution in agent bodies.
3. **Setup agent** — the interview/inspect/compose flow at repo import.

## Testing expectations

- Desktop E2E (mock): open ⌘D on a fixture branch → add two line
  comments → request changes → assert the composed `request-revision`
  payload (file:line anchors, excerpts, summary) and the stage action
  call; approve path asserts `advance-stage`.
- Unit: prompt composition (anchor formatting, stale-tip handling).
- Contract tests per flavor (phase 2); live-agent smoke uses the
  cheap-model convention already used for agent-flow tests.
- Full round trip (comment → revision → task re-parks at pr) needs the
  harness to drive agent completion deterministically — same documented
  gap as notify; add when that harness lands.

## Non-goals (cut deliberately)

- Persistent review threads, comment tables, `/v1` review endpoints, MCP
  thread tools, re-anchoring across revisions — the forge (for forge
  users) or the run history (for everyone) is the record. If a genuinely
  shared, forge-free review store is ever needed, that is
  [forge-independence.md](./forge-independence.md), which stays parked
  behind its decision gate: a second real contributor wanting shared
  review state, and the forge-API-backed variant evaluated and found
  wanting for concrete reasons.
- Blocking approve on open comments, review checklists, multi-reviewer
  coordination — single-operator app; revisit with real demand.
