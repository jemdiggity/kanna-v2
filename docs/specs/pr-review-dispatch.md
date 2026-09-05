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
  agent pr-triage · parked, conversational
  │  triages open PRs, proposes an order, dispatches on the user's word,
  │  tracks the children, answers "what's left?"
  │
  ├── Child: "PR #412 · relay reconnect"   workflow pr-review-single  (internal)
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

One manual stage, `triage`, bound to `pr-triage`. Public because the
user starts a review session by picking it in the new-task modal, which is the
app's only agent entry point (it picks a workflow and a provider, not an
agent). Manual so the session parks and stays conversational: the user keeps
talking to the manager between PRs.

### `workflows/pr-review-single.json` — internal

One manual stage, `review`, bound to `pr-reviewer`. `"visibility": "internal"`
for the same reason `specialty-review` is: Kanna binds it itself, so it must
resolve by name on create but never appear in the picker one character away
from `pr-review`. Manual for the reason the QA spec gives — one lifecycle for
every child, whatever the outcome, with the human deciding when it is done.

Unlike `specialty-review`, this workflow **does** bind its agent, because every
child runs the same one. The manager needs no `agent` override.

### `agents/pr-triage/AGENT.md`

Its job, in order:

0. **Resolve scope.** *Which* PRs is this operator responsible for — only the
   ones they authored, or every open PR on the repo? The built-in **leaves
   this undefined and asks**, because both answers are correct for real users
   and the built-in cannot know which one is looking at it (see "Defaults,
   extension, and setup"). A repo that has answered it in
   `.kanna/agents/pr-triage/EXTEND.md` is not asked again; when nobody
   has answered, the manager asks once, proceeds on the answer, and offers to
   write the extension so it never asks again.
1. **Enumerate.** Resolve the open PRs in scope. This is forge work, so it
   lives here in user-space, not in the engine: `gh pr list --json
   number,title,author,headRefName,baseRefName,headRefOid,isDraft,additions,deletions,changedFiles,createdAt,updatedAt,statusCheckRollup,mergeable`
   (plus `--author @me` when the scope is the operator's own PRs).
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
     `workflow_name: "pr-review-single"`, `base_ref: "pr/<n>"` (the fork point),
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

### Defaults, extension, and setup

Owner directive, 2026-09-05: *"Kanna should ship with sensible default agent
definitions, but allow extension or replacement, and the initial setup agent
should help the user make these agent modifications for each of their repos
when they're initially imported or created. The user may want either option:
their own PRs or if they're senior level maybe they're responsible for the
whole repo."*

That is a rule about how these definitions are written, not just about this
one question. It resolves into three obligations:

1. **The built-in ships the behavior every repo wants, and leaves genuinely
   per-repo choices undefined.** Review scope is the worked example: "my own
   PRs" is right for a contributor, "every open PR" is right for someone who
   owns the repo, and the built-in has no way to tell which it is talking to.
   So it defines the *procedure* and declares the scope question open, rather
   than picking a default that is wrong for half its users and silently
   applied. A built-in that must guess should ask instead.
2. **The repo answers it by extension, not by replacement.** One
   `.kanna/agents/pr-triage/EXTEND.md` layers the answer onto the
   resolved agent, so the repo keeps receiving improvements to the built-in it
   did not fork. Full replacement (`AGENT.md`) stays available for a repo whose
   review procedure is genuinely its own.
3. **The `setup` agent asks at import.** `.kanna/agents/setup/AGENT.md`
   already has this exact shape — inspect first, ask only what inspection
   cannot answer, compose stock definitions, write `EXTEND.md` only where an
   answer does not match stock behavior. This design adds one question to its
   list:

   > **PR review scope** — when you review pull requests in Kanna, are you
   > responsible for your own PRs, or for every open PR on this repository?

   Inspection can pre-answer it in the common case: if `gh` reports the
   operator has push/admin permission on the repo, "every open PR" is the
   likely answer and the question becomes a confirmation. The answer is
   written as `.kanna/agents/pr-triage/EXTEND.md`; no answer is also a
   valid outcome, and the manager asks the first time it runs.

**Exercised now.** `.kanna/agents/pr-triage/EXTEND.md` exists in this
repository and says Kanna reviews every open PR, with the two repo-specific
ranking rules that follow from Kanna being a distributed system that ships as
one signed app. It is committed ahead of the agent it extends and is inert
until phase 1: an `EXTEND.md` whose base agent does not resolve is skipped by
`agent_optional`, and a directory holding only an `EXTEND.md` for a
non-built-in name never enters the `agents()` listing, so it is not an error
and not a listing.

It did surface one latent assumption, now fixed:
`packages/core/src/workflow/qa-assets.test.ts` treated every directory under
`.kanna/agents` as a built-in and read an `AGENT.md` from each, which any
repo-local extension of a not-yet-built-in agent would have broken. It now
filters to directories that define an agent.

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

### What the reviewer may do to the forge

The brief-only contract has one seam: if the human forms a verdict in Kanna and
then has to open GitHub to type it, GitHub is still where the decision gets
recorded, and the directive's whole point leaks away. So the child can carry the
human's words back — under a line drawn between two different things:

- **Transcription.** Posting a review comment, or a request for changes, in the
  human's name, with the human's words. The agent is a typist. **In the
  built-in**, on the human's explicit instruction in the session, never as part
  of the brief and never inferred from the human reacting to it. Before posting,
  it restates verbatim what it is about to post and to which PR.
- **Authority.** Approving the PR, dismissing another reviewer's changes,
  merging. Here the agent is not transcribing a judgment, it is *exercising* the
  human's standing as a reviewer of record. **Not in the built-in.** A repo that
  wants it writes `.kanna/agents/pr-reviewer/EXTEND.md` — the same path this
  design already uses for review scope, and the right place for a per-repo
  decision about how much authority an agent holds.

Merging stays out of both: the merge master owns merging
([merge-master.md](./merge-master.md)), and a PR review session never merges,
extension or not.

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

## The diff tool

The human reads the diff in the tool that exists, and the first design's
diagnosis of that tool remains true. One of those gaps is load-bearing for this
design and is therefore in it, as **phase 4**: without a file list and
viewed-tracking, a forty-file PR is a scroll, and organizing *which* PR to read
does not help once you are inside it.

The rest stays out — see "Still deferred".

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
  `pr-review-single` is excluded from the listed lineup while still resolving by
  name, both agents' prompts render, and every tool they reference exists in
  `crates/kanna-tool-catalog`.
- Definition test for the extension path: with
  `.kanna/agents/pr-triage/EXTEND.md` present, the resolved agent's
  prompt contains the repo's scope answer; with it absent, the resolved prompt
  still declares the scope question open. (Kanna's own repo is the fixture for
  the first half — the file is already committed.)

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
- Agent-flow E2E on a repo with no scope extension: the manager asks the scope
  question before enumerating, and enumerates nothing until it is answered.
- The `setup` agent's new question writes a well-formed
  `.kanna/agents/pr-triage/EXTEND.md`, and re-running setup on a repo
  that already has one does not overwrite it without approval (the existing
  rule in `.kanna/agents/setup/AGENT.md`).

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
- Transcription: on an explicit instruction the child posts the human's words
  to the PR and restates them first; with no instruction, a fixture run posts
  nothing. Approving is refused by the built-in and named as an `EXTEND.md`
  decision.

**Phase 4 — the change map.** Independent of phases 2-3 and schedulable
alongside or ahead of them: it is desktop work, they are agent-prompt work.

This design organizes the review — which PR, in what order, which hunks matter
— without improving the *read*. Pressing ⌘D still gives one long scrolling
patch, and on a forty-file PR you lose your place. That is the honest cost of
building no UI, and it is worth paying down to the minimum that fixes it:

- `git_diff_numstat` (git2, no shelling) returning
  `{path, oldPath?, status, additions, deletions, binary}` for the range;
- a file list beside the diff: path, +/−, status, click to jump;
- a per-file viewed toggle (`v`) and an unviewed count.

Not the withdrawn design's three panes, not lazy per-file loading, not
commit-scoped ranges — those are separate arguments. This is the part that
turns scrolling into navigation.

Acceptance criteria:

- Unit: numstat against a fixture repo reports renames with `oldPath`, flags
  binary files, and counts add/delete/modify correctly.
- Desktop E2E: a 40-file fixture branch renders a complete file list; clicking
  file 37 scrolls to it.
- Desktop E2E: `v` marks a file viewed, the unviewed count decrements, and the
  state survives closing and reopening the diff for the same head.
- Perf: first-content time for the existing 20×1500 perf fixture does not
  regress against the `KANNA_E2E_DIFF_FIRST_CONTENT_MS` budget.

## Tradeoffs

| Decision | Alternative | Why this way | Cost accepted |
|---|---|---|---|
| Agents + workflows, no new UI | A bespoke review surface (the withdrawn first design) | Uses primitives that exist, tested, and already carry parallelism, worktrees, and the task tree; nothing new to maintain | The human's actual reading experience is only as good as today's diff tool — the deferred list stays deferred |
| One child task per PR | One agent reviewing all PRs in one session | Per-PR worktree is what makes ⌘D show the right diff; it is also the isolation that lets reviews run in parallel and be closed independently | N open PRs means N worktrees and N agent sessions — cheap on disk, not free on tokens |
| Fork from a local `pr/<n>` ref | Fork from `origin/pr/<n>` | Sidesteps the upstream-preference trap entirely, so Phase 1 needs no desktop fix | A local ref per reviewed PR accumulates in the repo; the manager should prune on close |
| Expose `diff_base_ref` | Overload `base_ref` and fix it in the client | The split already exists internally and is already load-bearing for stage forks; naming it is honest and testable | One more field on the most-used create surface |
| Clean-worktree scope default | Default `branch` for review workflows by name | The diff tool stays ignorant of what a review task is; the rule is general and helps every clean-worktree task | A clean implement task now opens in branch scope — arguably correct, but it is a visible change |
| Human reviews, agent briefs | Agent renders a PASS/FAIL verdict like the specialty reviewers | The owner's stated goal is to make *the human's* review possible in-app, not to replace it | No aggregate verdict to automate on; a PR review session ends when the human says it does |
| Built-in leaves review scope undefined and asks | Ship a default ("your own PRs") that a repo overrides | Both answers are correct for real users and the built-in cannot tell which one it is talking to; a wrong silent default is worse than one question | The very first run of the very first repo asks a question before doing anything |
| Manager proposes, never dispatches unasked | Manager fans out all open PRs immediately | An unasked fan-out over 20 open PRs is 20 sessions the user did not agree to | An extra round-trip before any work starts |
| Transcription built in, authority by extension | Brief-only; or both built in | A verdict the human must retype on GitHub leaks the whole point; approving on their behalf is a different risk class and belongs to the repo, not to Kanna's default | Two similar-looking capabilities separated by a rule the agent has to hold correctly — the restate-before-posting step is what makes it auditable |

## Non-goals

Merging from Kanna (the merge master owns merging); posting review comments to
the forge as part of the brief (on the human's explicit word only); any shared
or forge-free review store — [forge-independence.md](./forge-independence.md)
stays parked and this design does not approach its gate; multi-reviewer
coordination; reviewing PRs on repositories Kanna has not imported.

## Resolved

- **Scope of "which PRs" (owner, 2026-09-05).** Both answers are real, so the
  built-in leaves it undefined and asks; the repo answers by `EXTEND.md`; the
  `setup` agent asks it at import. Kanna's own repo answers "every open PR" and
  that extension is written. See "Defaults, extension, and setup".
- **Whether the child may act on the forge** (owner delegated the call).
  Transcription in the built-in, authority by extension, merging never. See
  "What the reviewer may do to the forge".
- **Naming** (owner delegated the call). Workflows `pr-review` (public) and
  `pr-review-single` (internal); agents `pr-triage` and `pr-reviewer`.
  `pr-review-single` says what distinguishes it from the session workflow
  rather than sharing a near-identical name with it, which is the mistake
  `specialized-reviewers` / `specialty-review` had to be defended against.
  The manager is `pr-triage`, not `pr-review-manager`: the owner's word was
  "manager", but in this repository `-manager` means `task-manager`'s shape —
  a long-running orchestrator with an event loop — and this agent is a
  conversational triage session that parks. Naming it for what it does keeps
  that distinction legible. One word from the owner reverses this.
- **Whether the diff-tool work is part of this effort** (owner delegated the
  call). Yes — as phase 4 below, scoped to the minimum, and parallel to phases
  2-3 rather than behind them.

## Still deferred

Named, not scheduled, not blocking anything above, and each independently
useful on its own:

- the 1 MiB patch cap on the remote/mobile path, and the per-file render skip
  on desktop — both are "go to GitHub" answers for a large enough PR;
- a mobile equivalent of this flow. Mobile can read a task's diff today but has
  no review session, and this design does not give it one.

## Open questions

None outstanding. Every question this design raised has been answered — by the
owner for scope and the extension rule, and by the author's judgment, at the
owner's direction, for forge authority, naming, and whether the diff-tool work
belongs to this effort. What remains is the owner's accept/reject on the design
as a whole, and `f1c3ca89`'s independent decision about the existing PR
approval UI, which this design neither uses nor removes.
