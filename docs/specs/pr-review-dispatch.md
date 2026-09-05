# Dispatched PR Review

Status: **proposed — design assessment, awaiting owner decision. Nothing here is implemented.**
Related: [qa-dispatch-review.md](./qa-dispatch-review.md) (the pattern this follows),
[task-graph-stages.md](./task-graph-stages.md), [merge-master.md](./merge-master.md),
[native-review.md](./native-review.md) (the shipped in-task review loop, untouched here),
[architect-consultations.md](./architect-consultations.md) (the manager/child precedent).

## The directive

Owner, 2026-09-05, into task `f1c3ca89` (`kanna_task_inputs` id 148):

> "…our PR approval feature sucks so I would suggest that we remove it and
> launch another task to rethink it. The idea is to let the user actually
> review PRs so they don't actually have to go to GitHub to review them.
> That's the idea — to devalue GitHub."

Owner, 2026-09-05, into this task, redirecting the first design:

> "…what I wanna do for a PR review is basically use the building blocks we
> already have, which is structured workflows and agent definitions. Let's
> define a PR review manager agent that helps the user determine which PR they
> want to review and which order they should be reviewed in. Then that agent
> will create a bunch of child tasks of PR review agents, each one of those
> agents reviews one single PR, and their workspace worktree is based on the
> branch of the PR. The user can use the diff tool to look at what changed. It
> would be nice if the base branch were set so that the diff tool on first open
> shows the branch diff from the base branch to the tip. The PR review agent
> should also help the user identify risky areas of code change — maybe those
> parts of their system that are more critical than others — and more or less
> make the reviewing task easier for the human."

The first design in this file proposed a bespoke three-pane review surface with
its own attestation schema. That is withdrawn. This is its replacement.

## Thesis

**PR review is a task tree, not a screen.** Kanna already has every primitive
this needs: workflows with stages, agent definitions resolved by name, child
task fan-out with a per-child worktree, and a diff tool bound to the selected
task. Reviewing a PR is then the same shape as reviewing a branch — the
[QA dispatch](./qa-dispatch-review.md) pattern, pointed at open PRs instead of
at specialties, with the **human as the reviewer** and the agent as the thing
that makes the human's read cheap.

Consequences worth stating up front:

- No new review UI. The human reviews in the diff tool that exists, with the
  agent's session in the terminal beside it.
- No review data model, no forge mirror, no attestation schema. The record is
  the task tree and its run history, as it already is everywhere else.
- The existing in-task review loop (`native-review.md`) and the `pr` stage's
  `approve` post → merge-master handoff are **untouched**. This is a second,
  parallel activity: reviewing PRs as PRs, whoever opened them.

## The shape

```
Task: "Review open PRs"                    workflow pr-review        (public)
  agent pr-review-manager · parked, conversational
  │  triages open PRs, proposes an order, dispatches on the user's word,
  │  tracks the children, answers "what's left?"
  │
  ├── Child: "PR #412 · relay reconnect"   workflow pr-review-item  (internal)
  │     agent pr-reviewer
  │     worktree forked from the PR head · diff base = the PR base
  │     writes a risk-ranked brief, then parks for the human's questions
  │
  ├── Child: "PR #418 · mobile OTA bump"   …
  └── Child: "PR #421 · schema migration"  …
```

The user selects a child, presses ⌘D, and sees that PR's changes — base branch
to tip — because the child's workspace *is* the PR. They ask the agent in the
same task's terminal. That is the whole experience.

## Built-in definitions

Four files, all in `.kanna/`, all shipped as Tauri bundled resources like every
other built-in.

### `workflows/pr-review.json` — public

One manual stage, `triage`, bound to `pr-review-manager`. Public because the
user starts a review session by picking it in the new-task modal, which is the
app's only agent entry point (it picks a workflow and a provider, not an
agent). Manual so the session parks and stays conversational: the user keeps
talking to the manager between PRs.

### `workflows/pr-review-item.json` — internal

One manual stage, `review`, bound to `pr-reviewer`. `"visibility": "internal"`
for the same reason `specialty-review` is: Kanna binds it itself, so it must
resolve by name on create but never appear in the picker one character away
from `pr-review`. Manual for the reason the QA spec gives — one lifecycle for
every child, whatever the outcome, with the human deciding when it is done.

Unlike `specialty-review`, this workflow **does** bind its agent, because every
child runs the same one. The manager needs no `agent` override.

### `agents/pr-review-manager/AGENT.md`

Its job, in order:

1. **Enumerate.** Resolve the repo's open PRs. This is forge work, so it lives
   here in user-space, not in the engine: `gh pr list --json
   number,title,author,headRefName,baseRefName,headRefOid,isDraft,additions,deletions,changedFiles,createdAt,updatedAt,statusCheckRollup,mergeable`.
2. **Order.** Propose a review order and *say why*. The inputs are all cheap
   and all already available: checks red or green; draft or ready; size; age;
   whether the PR's base is another open PR (a stack — the same question
   `.kanna/agents/pr/AGENT.md` already answers, and stacks must be reviewed
   base-first); whether two PRs touch the same files (a cheap textual
   proxy for the merge master's semantic-conflict analysis); and whether
   anything is blocked on it.
3. **Confirm.** Present the order, take the user's edits ("skip 418", "do the
   migration one first"), and dispatch only on their word. The manager proposes;
   the human disposes.
4. **Dispatch.** For each PR the user accepts, in order:
   - materialize the head locally: `git fetch origin pull/<n>/head:pr/<n>`,
     which works for cross-fork PRs and, being a *local* ref, leaves the child
     branch with no upstream (this matters — see "The workspace question");
   - `kanna_create_task` with `parent_task_id` = the manager's task,
     `workflow_name: "pr-review-item"`, `base_ref: "pr/<n>"` (the fork point),
     `diff_base_ref: "origin/<base>"` (the diff base), an explicit
     `display_name` of `PR #<n> · <short title>`, and a prompt naming the PR,
     its author, its base, its head sha, and the user's stated concern if they
     gave one.
   - The `display_name` rule is not optional, for the reason the QA spec
     records: unnamed fan-out children render as a column of identical rows.
5. **Track.** `kanna_list_task_children` plus `kanna_get_task` answer "what's
   left?". The manager does **not** join, aggregate, or auto-close: the human
   is the reviewer, so children park for the human and close when the human (or
   the manager, when asked) says so.

The manager never reviews code itself and never approves or merges anything.

### `agents/pr-reviewer/AGENT.md`

One PR, one child task. Its contract is **make the human's read cheap**, not
render a verdict.

It produces a brief, in this order, and stops:

| Section | What it is | Where it comes from |
|---|---|---|
| What this PR claims | title, body, linked issue, author's own summary | `gh pr view` |
| What it actually changes | files grouped by subsystem, with the boundaries crossed (desktop / server / daemon / mobile / relay / cloud) | the diff |
| Risk ranking | the changed areas ordered by blast radius, each with **the specific question the human should answer** | below |
| Coverage | which boundary-crossing behavior did and did not get a test, against the repo's own stated expectation | the diff + the repo's conventions document |
| Read these first | a short ordered list of file:line ranges — the hunks that decide whether this PR is right | synthesis |
| What I could not resolve | the questions the agent could not answer from the code | honesty |

**Risk ranking** is the part the owner asked for, and it is inference, not a
score. The ordering heuristics, stated in the agent body so they are auditable:
cross-process contracts (wire protocols, HTTP payloads, serialized messages)
outrank persisted data (schema, migrations, stored formats), which outrank
engine semantics (stage transitions, lifecycle, ownership), which outrank
single-component UI. Within a tier: files with high historical churn, files the
repository's own conventions document calls out as invariants or pitfalls, and
changes with no accompanying test rank higher. A repo tunes this without
forking the agent by writing `.kanna/agents/pr-reviewer/EXTEND.md` — which is
exactly what the extension mechanism is for, and why this design needs no new
config key for "critical areas".

The brief goes to two places that already exist: the **terminal**, in full,
because the child's session is where the human will ask follow-ups; and the
child's `kanna_complete_stage` summary, compressed, because that is the durable
record and what task detail and the sidebar show. Manual transition means
completing does not end the session — the agent parks, and the human keeps
asking it questions while reading the diff.

What it does not do: approve, merge, request changes on the forge, or push
anything. If the human asks it to post the review to GitHub, it does that as an
explicit `gh` action on the human's word — user-space work, on request, never
as part of the brief.

## The workspace question

"Their workspace worktree is based on the branch of the PR" is the load-bearing
requirement, and the owner's follow-on — "it would be nice if the base branch
were set so that the diff tool on first open shows the branch diff from the base
branch to the tip" — names exactly the trap. It is worth being precise about
why, because the fix is small and non-obvious.

**One field is doing two jobs.** `kanna_create_task`'s `base_ref` is the git ref
the task's branch and worktree fork *from*, and it is also what gets persisted
as `pipeline_item.base_ref`, which is what the diff tool compares *against*. For
ordinary tasks those are the same ref and nothing is wrong. For a PR review
child they are different by construction: fork from the PR **head**, diff
against the PR **base**.

Fork from the head with today's API and the branch diff is empty — the task's
recorded base is the PR head, and HEAD is the PR head. Verified against real
git:

```
$ git worktree add -b task-abc <path> origin/feature-x
$ git rev-parse --abbrev-ref @{u}            → origin/feature-x
$ git diff --stat $(git merge-base @{u} HEAD)..HEAD   → (empty)
$ git diff --stat $(git merge-base origin/main HEAD)..HEAD
  f | 1 +                                    ← the PR's actual changes
```

**The engine already models the split — it just is not exposed.** The internal
`CreateTaskRequest` in `crates/kanna-server/src/task_creator/mod.rs` carries
`base_ref` (the worktree start point, passed to `create_worktree`) *and*
`stored_base_ref` (what is persisted and what `$BASE_REF` resolves to), with
`stored_base_ref` defaulting to `base_ref`. Stage forks already use it: a fork
starts from the previous stage's tip while keeping the task's original base for
diffs. Nothing new needs inventing; the field needs a public name.

A second trap sits behind it. `git worktree add -b <new> <path> origin/feature-x`
sets the new branch's upstream to `origin/feature-x`, and the desktop's
`useDiffBranchBaseRef` **prefers the branch upstream over the task's recorded
base**. So even with the base recorded correctly, a child forked from a
*remote-tracking* ref would still diff against the PR head. Forking from a
**local** ref avoids it entirely — verified: a branch created from local `pr/42`
has no upstream at all, so the recorded base is used. That is why the manager
fetches to `pr/<n>` rather than reading `origin/pr/<n>`, and it is why the
desktop fix below is hardening rather than a prerequisite.

## Engine changes required

Two, both small. Everything else in this design is `.kanna/` files.

**A. Expose the fork-point / diff-base split.** Add optional `diff_base_ref` to
`POST /v1/tasks` and to `kanna_create_task`, plumbed to the existing
`stored_base_ref`. Absent, behavior is identical to today (it already defaults
to `base_ref`). This is a rename of an internal field into the public surface,
not new machinery.

**B. First open shows the branch diff.** `DiffView.vue` defaults its scope to
`working` unless told otherwise, so ⌘D on a review child — whose worktree is
clean — opens on an empty view. Rule: **default to `branch` scope when the
task's worktree has no uncommitted changes, `working` when it does.** This
delivers the owner's ask without the diff tool needing to know what a review
task is, and it leaves implement tasks (which are dirty exactly when the
default matters) behaving as they do today. Remembered per-task scope still
wins on reopen.

Hardening, not a prerequisite:

**C. Recorded base should outrank branch upstream.** Reorder
`useDiffBranchBaseRef` to prefer the task's recorded `base_ref` when it
resolves, falling back to upstream, then to detection. The existing
own-remote-copy guard stays. This makes the design robust to a child forked
from a remote-tracking ref, and to anyone who creates a review task by hand.
It is a behavior change for existing tasks whose recorded base is stale — the
`pr` agent's dead-end retarget path is the real case — so it needs its own E2E
before it lands, and it can ship a release after A and B.

## What this does not change

- Workflow stage-advancement semantics, in any form.
- The `pr` stage's `approve` post, `kanna_signal_merge_handoff`, the merge
  master, and the close-time backstop. A PR review session is a separate
  activity that never touches a task's own workflow.
- The shipped in-task review loop from `native-review.md`: ⌘D's verdict bar,
  line comments, and `request-revision` composition, all of which continue to
  serve their own case (reviewing a task's branch inside its workflow). What
  `f1c3ca89` decides to remove is decided there, not here.

## Deferred (named, not fixed)

The human still reads the diff in the tool that exists, and the first design's
diagnosis of that tool remains true. This design deliberately does not fix:

- no file list, +/− counts, jump-to-file, or viewed-tracking — the single
  biggest cost of reviewing a large PR in the app today;
- the 1 MiB patch cap on the remote/mobile path, and the per-file render skip
  on desktop;
- mobile has no equivalent of this flow at all.

Each is independently useful and independently schedulable. None blocks this
design from shipping and being used. If the owner wants one of them, the file
list is the one that pays for itself first.

## Phasing

**Phase 1 — the loop, dispatched by hand.** Engine changes A and B; the two
workflow JSONs and the two AGENT.md files. Reviewed by using it: create a
`pr-review` task, let it triage the repo's own open PRs, dispatch two children,
review them in ⌘D.

Acceptance criteria:

- `kanna_create_task` with `base_ref: "pr/42"` and `diff_base_ref: "origin/main"`
  produces a worktree at the PR head whose `pipeline_item.base_ref` is
  `origin/main`; omitting `diff_base_ref` behaves exactly as today (existing
  create tests unchanged).
- Server test: `$BASE_REF` in the child's stage prompt resolves to the diff
  base, not the fork point.
- Desktop E2E: ⌘D on a task with a clean worktree opens in branch scope and
  renders the fork-point-to-tip diff; ⌘D on a task with uncommitted changes
  opens in working scope, as today; a remembered per-task scope still wins.
- Desktop E2E (the whole point): a fixture task forked from a feature branch
  with `diff_base_ref` set to the default branch renders that branch's changes
  on first open — the case that is empty today.
- Definition tests, per the existing pattern: both workflows resolve,
  `pr-review-item` is excluded from the listed lineup while still resolving by
  name, both agents' prompts render, and every tool they reference exists in
  `crates/kanna-tool-catalog`.

**Phase 2 — the manager earns its name.** Ordering heuristics with stated
reasons, stack detection, overlap detection between open PRs, and the "what's
left?" report. Split out because Phase 1 is useful with a manager that only
lists and dispatches, and because ordering quality is judged by using it.

Acceptance criteria:

- Agent-flow E2E on a fixture repo with a three-PR stack: the proposed order is
  base-first, and the stated reason names the stack.
- Two PRs touching the same file are reported as overlapping in the proposal.
- Nothing is dispatched without an explicit user instruction (asserted on the
  fixture: a triage run that is never answered creates zero children).

**Phase 3 — the brief.** The risk ranking, the coverage read, the "read these
first" list, and `EXTEND.md` tuning.

Acceptance criteria:

- Fixture PR crossing a wire-protocol boundary with no test: the brief ranks
  that hunk first and names the missing coverage.
- Fixture PR that is a pure single-component style change: the brief says so
  and stays short — a brief proportional to the change, not a fixed template.
- A repo `EXTEND.md` naming a critical path moves it up the ranking.
- The child's `kanna_complete_stage` summary is present and the session stays
  alive and answerable afterwards.

## Tradeoffs

| Decision | Alternative | Why this way | Cost accepted |
|---|---|---|---|
| Agents + workflows, no new UI | A bespoke review surface (the withdrawn first design) | Uses primitives that exist, tested, and already carry parallelism, worktrees, and the task tree; nothing new to maintain | The human's actual reading experience is only as good as today's diff tool — the deferred list stays deferred |
| One child task per PR | One agent reviewing all PRs in one session | Per-PR worktree is what makes ⌘D show the right diff; it is also the isolation that lets reviews run in parallel and be closed independently | N open PRs means N worktrees and N agent sessions — cheap on disk, not free on tokens |
| Fork from a local `pr/<n>` ref | Fork from `origin/pr/<n>` | Sidesteps the upstream-preference trap entirely, so Phase 1 needs no desktop fix | A local ref per reviewed PR accumulates in the repo; the manager should prune on close |
| Expose `diff_base_ref` | Overload `base_ref` and fix it in the client | The split already exists internally and is already load-bearing for stage forks; naming it is honest and testable | One more field on the most-used create surface |
| Clean-worktree scope default | Default `branch` for review workflows by name | The diff tool stays ignorant of what a review task is; the rule is general and helps every clean-worktree task | A clean implement task now opens in branch scope — arguably correct, but it is a visible change |
| Human reviews, agent briefs | Agent renders a PASS/FAIL verdict like the specialty reviewers | The owner's stated goal is to make *the human's* review possible in-app, not to replace it | No aggregate verdict to automate on; a PR review session ends when the human says it does |
| Manager proposes, never dispatches unasked | Manager fans out all open PRs immediately | An unasked fan-out over 20 open PRs is 20 sessions the user did not agree to | An extra round-trip before any work starts |

## Non-goals

Merging from Kanna (the merge master owns merging); posting review comments to
the forge as part of the brief (on the human's explicit word only); any shared
or forge-free review store — [forge-independence.md](./forge-independence.md)
stays parked and this design does not approach its gate; multi-reviewer
coordination; reviewing PRs on repositories Kanna has not imported.

## Open questions for the owner

1. **Scope of "which PRs".** Every open PR on the repo, or only the ones
   authored by this operator's Kanna tasks? The first is the honest reading of
   "devalue GitHub"; the second is a much smaller, sharper tool.
2. **Should the child be able to act?** The brief-only contract keeps the agent
   safe and the human in charge. If the owner wants "and then post my review to
   the PR" or "and then approve it", that is a second contract on the same
   agent and should be decided before the AGENT.md is written, not bolted on.
3. **Naming.** `pr-review` / `pr-review-item` / `pr-review-manager` /
   `pr-reviewer` are placeholders chosen to sit beside `specialized-reviewers` /
   `specialty-review` without colliding. Worth one minute of the owner's taste.
4. **The deferred diff-tool work.** Reviewing a 40-file PR in one scroll
   container is the experience this design hands the human. Is the file list
   part of this effort, or its own task?
