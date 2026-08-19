# QA Dispatch Review

Dispatched specialty reviews for the review stage: a QA dispatcher agent
decides at review time which specialty reviews a branch needs (UI, security,
network/runtime performance, plus repo-defined specialties), fans each one out
as a child review task over a fork of the same branch, and aggregates the
verdicts into the single review decision the workflow already understands.

This is the "review manager" workflow anticipated by
[task-graph-stages](task-graph-stages.md): the engine executes structure known
in advance (the linear stage rail); agents create structure discovered at
runtime. The dispatcher is an agent composing existing primitives — no new
stage-engine semantics were added.

## Design

### No engine changes

Workflows stay linear. Parallelism lives in child-task fan-out
(`kanna_create_task` with `base_ref` = the dispatcher's branch,
`parent_task_id`/`notify_task_id` = the dispatcher's task), and join is the
dispatcher's job (`kanna_wait_task`, then reading the child's recorded
verdict). This follows the task-graph spec's fan-out/join section: join
semantics are deliberately not engine-enforced.

### Child naming

A child task with no `display_name` is titled by its prompt, and every child's
prompt opens with the same dispatch line — so an unnamed fan-out renders as a
column of identical sidebar rows. The dispatcher therefore passes an explicit
`display_name` of `<Specialty> review: <subject> (round <n>)` on every child
and leads the child's prompt with the same specialty and round, since the
prompt snippet is surfaced on its own in the sidebar and on mobile. The
convention and its per-agent labels are stated as a rule in
`.kanna/agents/qa-dispatcher/AGENT.md` (step 3, "Naming rule"). Nothing
server-side infers it: `display_name` is the only title input the fan-out has.

### Built-in definitions

- **`specialized-reviewers` workflow** — the standard
  `in progress` (post: `commit`) → `review` → `pr` (post: `approve`) rail,
  with the review stage bound to the `qa-dispatcher` agent
  (`transition: auto`).
- **`specialty-review` workflow** — a single manual `review` stage with **no
  agent binding**; the dispatcher binds the specialty agent through the
  create request's `agent` override. Its definition declares
  `"visibility": "internal"` (`.kanna/workflows/specialty-review.json`): Kanna
  binds it itself, so the name resolves on create but is never listed as a
  workflow a human or an agent chooses — one character from
  `specialized-reviewers` is too close to offer both in the same picker. A
  repo that ships its own file under the name customizes the definition, and
  must re-declare the visibility to keep it unlisted. Manual is the uniform
  choice: the
  engine only auto-advances on `success`, so an auto stage would close PASS
  children while FAIL children parked — two lifecycles for one kind of
  child, and dispatcher logic that branches on outcome. With manual, both
  verdicts leave the child parked at its stage for the dispatcher, which owns
  the whole child lifecycle: it created every child, and it closes every child
  after collecting its verdict. What resolves the dispatcher's
  `kanna_wait_task` `until: "finished"` is the **terminal `stage_run` the
  reviewer's own `kanna_complete_stage` writes** — `succeeded` for PASS,
  `failed` for FAIL — not the child's read state. A reviewer that stops without
  calling `kanna_complete_stage` records no termination at all and never
  resolves the join, which is why step 4 of the dispatcher bounds its retry
  loop and falls through to the no-verdict path.
- **`qa-dispatcher` agent** — characterizes the diff, selects specialties,
  creates the children, joins, and records the aggregate verdict:
  all PASS → `kanna_complete_stage success` (auto-advances to `pr`); any
  FAIL → `kanna_request_revision` to `in progress` with the merged findings.
  If no specialty applies it reviews the branch itself against the ordinary
  coverage expectations.
- **Specialty reviewer agents** — read-only reviewers with a shared verdict
  contract: `kanna_complete_stage` `success`/`failure` with a
  `PASS:`/`FAIL:` summary. They never call `kanna_request_revision`; the
  dispatcher owns the aggregate decision. Built-in roster (universal
  dimensions only, with deliberately disjoint scopes so findings do not
  duplicate):
  - `review-ui` — user-visible behavior and its E2E/interaction coverage
    (includes i18n and accessibility; not separate agents, since they would
    overlap `review-ui` on nearly every dispatch)
  - `review-security` — untrusted input, secrets, privilege and boundary
    changes
  - `review-perf` — network and runtime performance of changed paths
  - `review-concurrency` — races, async coordination, lifecycle/cancellation,
    retry/reconnect (the "concurrency review" the task-graph spec named)
  - `review-migration` — data at rest written by older versions: schema
    migrations, stored formats, snapshots
  - `review-compat` — cross-process contracts: wire protocols, APIs,
    serialized messages, version negotiation (migration owns at-rest data;
    compat owns between-process data)

  Repos add their own specialties by creating
  `.kanna/agents/review-*/AGENT.md`; the dispatcher discovers them from the
  worktree. The Kanna repo itself carries `review-release` this way — a
  repo-local reviewer for its packaging invariants (vendoring, compiled
  builtin registration, build-private sidecar paths, OTA runtimeVersion,
  versioning through kd) — which is deliberately absent from
  `compiled_builtin_resource` so it never ships as a built-in.

Specialty reviewers are top-level agent roles rather than `review@<flavor>`
flavors: a repo override of `.kanna/agents/review/AGENT.md` shadows every
`review@…` selector (flavor resolution only consults builtin resources), so
flavors would silently disable specialty dispatch in any repo that customizes
the generic review agent — including this one.

### Server surface changes

Four gaps stood between the dispatcher and the existing primitives:

1. **`agent` override on `kanna_create_task`.** The HTTP API already accepted
   `CreateTaskRequest.agent` (it overrides the pinned workflow stage's agent
   binding); the shared tool catalog now exposes it to MCP/CLI callers, and
   `kanna-cli task create` grew a matching `--agent` flag. The `stage`
   override remains deliberately unexposed.
2. **Durable direct-child history.** `GET /v1/tasks/{task_id}/children`, exposed
   MCP-first as `kanna_list_task_children {"task_id": "..."}` and through the
   typed fallback `kanna-cli task children --task-id "..."`, returns all direct
   children, including closed children, in chronological oldest-first order.
   Each item carries `id`, optional `workflowName`, `agent`, `createdAt`,
   `closedAt`, and `latestRun`, so the dispatcher can reconstruct actual prior
   panel outcomes instead of inferring that an untouched surface passed.
   `workflowName` is the discriminator that keeps unrelated direct subtasks out
   of the panel ledger. This reuses the durable task and stage-run records:
   there is no schema migration and no duplicate aggregate verdict table or
   snapshot to keep consistent.
3. **`latestRun` on `TaskDetail`.** The task-graph spec promises a child's
   terminal `stage_run.result` is queryable via `kanna_get_task` /
   `kanna_wait_task`; the detail payload now carries
   `latestRun {stage, kind, status, summary, finishedAt}` populated from the
   task's most recent stage run. Verdict summaries are parsed out of the run's
   result JSON; non-verdict results (e.g. orphaned-workspace markers) pass
   through as-is.
4. **A wait window the caller survives.** `kanna_wait_task` is the dispatcher's
   join primitive, and MCP clients abort a `tools/call` on their own timer
   (Codex and Claude Code both at 300s), destroying the result. The wait window
   is therefore capped at `MAX_WAIT_TIMEOUT_SECS` = 240s — in
   `kanna-tool-catalog` code, not only in `catalog.json`, so a `.kanna/`
   catalog override cannot reintroduce a wait the client is guaranteed to kill
   — and running the window out is a normal result, not an error: the caller
   gets the task's latest detail plus `waitOutcome: "timeout"` and calls again.
   A resolved wait carries `waitOutcome: "resolved"`. `kanna-cli task wait`
   renders the same shape for MCP-less agents.

## Bounding the loop

Dispatched review made the review→revise cycle cheap enough to run away with:
each round re-reviews a larger diff with several specialists, every one of
which can find something new, so a scoped task can accumulate dozens of rounds
and grow into a project nobody asked for. Two mechanisms bound it — one the
engine enforces, one the prompts ask for. The engine's is the load-bearing
one; prompts alone cannot hold a limit.

### Revision-round budget (engine)

A workflow declares `revision_limit` (top level, default
`DEFAULT_REVISION_LIMIT` = 3; `0` opts out). A negative value is a definition
error in every parser — the Rust source of truth
(`normalize_workflow_definition`, covering both repo workflow files and pinned
`pipeline_def` snapshots), the JSON schema, and the TypeScript loader — rather
than being clamped to `0`, since silently reading a typo as "unlimited" would
disable the bound the field exists to set. `pipeline_item.revision_rounds`
counts agent-requested revisions on the task, and `kanna_request_revision`
resolves the pair before doing anything:

- **Under budget** — the revision runs as before, the round is counted only
  after preparation succeeds (a failed prepare ran no agent, so it costs
  nothing), and the response carries
  `revisionBudget {rounds, limit, exhausted: false, message}`.
- **Budget spent** — nothing is forked. The review run is closed as `failed`
  with a summary that says the task was parked and keeps the reviewer's
  requested changes as the run's `feedback`, the task is marked `unread` at its
  current stage, and the response reports `exhausted: true`. The task's human
  decides what happens next; the loop cannot restart itself.

Admission is atomic and single-flight, because a cap that request timing can
step over is not a cap. `try_claim_agent_revision_round` reads the count and
increments it inside one `BEGIN IMMEDIATE` transaction, so two requests cannot
both be admitted on the last free slot; if preparation then fails, the round is
released, preserving the rule that a revision which never ran costs nothing.
On top of that, one revision action runs per task at a time (the same per-task
operation flight that guards task creation and abort): a second concurrent
request gets `409 Conflict` rather than waiting through a workspace fork, and a
request arriving after the winner finishes sees the spent budget and parks.

That flight is owned by the **detached transition**, not by the handler. The
response must be sent before the transition runs — it kills and respawns the
caller's own session — so for the whole window between the 200 and the
transition landing, the task's stage, branch, and session are still the
pre-revision ones. A guard released at the response would reopen that window: a
second request admitted there claims another round and forks another workspace
from state the in-flight transition is about to replace. Moving ownership into
the worker closes it, and the guard drops on every worker exit path, including
a daemon that never answers.
Without both, two admitted requests also raced on the *same* forked branch name
— the regression test in `http_api::tests::revision_status` reproduces exactly
that when either guard is removed.

Origin is what separates a bounded agent loop from human judgment.
`RequestRevisionRequest.origin` (`agent`, the default, or `human`) is
deliberately **not** exposed in the tool catalog — an agent cannot claim human
origin. The desktop's revision action (⇧⌘S in the diff modal) sends
`origin: "human"`: it is never refused, and it resets `revision_rounds` to 0,
handing the agents a fresh budget to satisfy what the human asked for.

Every revision run also tells the revising agent where it stands: the composed
revision prompt (and the resume message, since a resumed session never re-reads
the prompt) opens with `Revision round N of M`, the instruction to stay inside
the original task's scope, and — on the last round — that the next failure
parks the task.

Tasks in flight are covered too: pinned `pipeline_def` snapshots written before
`revision_limit` existed omit the field and inherit the default.

A parked task surfaces the way any failed review does: unread, at its current
stage, with the dispatcher's findings in its terminal and the verdict on the
stage run. The desktop does not render stage-run summaries anywhere today, so
there is deliberately no new UI badge for "parked because the budget is spent";
adding one means first giving the UI a place to show run results, which is its
own change.

The bar does not move with the budget. A shrinking budget never makes a
blocking finding acceptable: on the last available round, a finding that
clears the bar still fails the review and still goes back as a revision, and
if that spends the budget the task parks. Parking a branch whose findings are
unresolved is the designed ending — a human reads them and decides — so a
deciding agent must never approve to avoid it. What the budget changes is what
happens when the rounds run out, not what counts as blocking; the shipped
agent assets are held to that by `qa-assets.test.ts`.

The budget bounds revising, not verdicts. A review agent that records
`kanna_complete_stage success` instead of requesting a revision still advances
the task — unchanged, and the same trust the workflow has always placed in a
review stage's verdict. What the budget removes is the ability to keep sending
work back forever without a human looking.

### Scope contract (prompts)

The budget caps how long a runaway can run; the scope contract keeps rounds
from being spent on work nobody asked for. The dispatcher, the generic `review`
agent, and every specialty reviewer share one bar: a finding may block the
branch only if it is **caused by this diff** and **blocking** (wrong behavior,
regression, security or data-integrity defect, broken contract, or missing
coverage for behavior the diff introduces). Pre-existing issues, preferred
refactors, hardening beyond the task, and coverage for untouched behavior are
never blocking — they belong in the pass summary under
`Follow-ups (non-blocking):`, and no reviewer creates follow-up tasks for them.

Two further limits keep a round from widening. The dispatcher filters its
children's findings against the same bar before merging them (a specialty sees
one slice and can mistake "could be better" for "must change"), and carries at
most five blocking findings into a revision as a **closed list** — each item
with file and line, no "also consider", no open-ended "harden this area". The
`implement` agent's half of the contract: on a revision run, fix exactly what
the feedback names, and report anything out of scope instead of building it.

What "the task" means for that bar is the branch's committed spec,
`docs/task-specs/<task-id>.md` — not the stage prompt, and not a reviewer's
reconstruction of intent from the prompt plus the delivered-input ledger. The
dispatcher reads it before selecting specialties and names it in every child
prompt, so the panel judges the change on one statement of the terms instead of
inheriting a fresh reading each round. `kanna_task_inputs` remains the audit
trail behind it: a spec that misstates a delivered directive is a finding
against the spec, never grounds for a reviewer to substitute its own reading.
A missing or stale spec is itself a blocking finding. See
[task-spec-artifact](task-spec-artifact.md).

### Incremental rounds

A later review round reviews **what changed since the previous round**, not the
whole branch again. Re-reviewing settled code is how a round that failed on one
specialty drags every other specialty through the same diff a second time.

The round markers already exist: workspace branches. Each stage fork keeps its
branch (`task-{id}`, `task-{id}-2`, `-3`, …, never deleted while the task
lives), and a review workspace never commits — so a previous review branch
still points at exactly the commit that round reviewed. This is the
load-bearing reason to keep the `task-{id}-{n}` workspace-branch naming: it is
the task's change-range history, readable from git alone with no new engine
state. Git does not carry verdicts; those come from the durable direct-child
query below.

Note which stage the markers come from. A Claude revision *resumes* the
implementing agent in its original workspace instead of forking, so implement
rounds add no branch and the unnumbered branch tracks the tip; every review
entry is a forward stage transition, which always forks
(`stages.rs`, `run_kind == "main"` → `RunWorkspaceSpec::Fork`). The numbered
branches are therefore the review rounds — which is exactly what makes them
usable as round markers.

Finding the round's change takes three paths, first clear answer wins:

1. **Ancestor** — the nearest strict ancestor of `HEAD` among
   `refs/heads/task-{id}*` (smallest non-zero `rev-list --count <sha>..HEAD`)
   is the previous review point, and `<sha>..HEAD` is the round's change.
2. **Rebased** — if no marker is an ancestor, the branch's history was
   rewritten since the last review and ancestry is gone. `git range-diff`
   between the two rounds' patch series recovers the answer: `=` patches were
   already reviewed, `!`/`>` are this round's change (a `<` patch was dropped;
   its replacement shows up as `>`).
3. **Full branch** — anything less than clear-cut reviews `$BASE_REF..HEAD`.

Both of the first two paths were checked against real multi-round tasks before
being written down. On a six-round task every previous review branch was still
an ancestor and the nearest was one commit behind `HEAD` — the ideal case. On a
seven-round task whose branch had been rebased mid-task, *no* marker survived
as an ancestor (path 1 degrades to path 3, safe but inert), while `range-diff`
across the two rounds separated 152 unchanged patches from 30 new ones — the
narrowing that round actually needed. Path 2 is what keeps the mechanism from
quietly no-opping on any repo that rebases.

Dispatch is then gated on the round's change: a specialty whose surface this
round did not touch is not normally re-dispatched, because the code it judged
has not moved since the round that judged it. Children receive both ranges —
the review range they judge, and the full branch they read for context, since a
defect can live in how the round's change meets what earlier rounds built.

Before selecting that panel, the dispatcher queries all direct children of its
task with `kanna_list_task_children` (typed CLI fallback only when MCP is
unavailable). Closed children are deliberately included: closing a specialty
child is lifecycle cleanup, not verdict deletion. The response is oldest first,
so reduction is deterministic:

- First select only children whose `workflowName` is `specialty-review`.
  Children from every other workflow are unrelated subtasks and are ignored,
  even when runless or when their `agent` happens to start with `review-`.
- Within that selected history, every syntactically valid stored `review-*`
  `agent` is a historical specialty key. It remains valid if the repo-defined
  reviewer is later removed or renamed. For a child with that attribution,
  `latestRun.status` `succeeded` records PASS while `failed` records FAIL.
  Walking oldest to newest leaves the latest terminal verdict for each
  specialty. Current discovery controls only new dispatch; it does not rewrite
  history.
- A FAIL remains unresolved until a later child for that same specialty records
  PASS. Skipping its untouched surface is not evidence that the finding was
  fixed. A new round's terminal child verdict joins this same chronology and
  becomes the specialty's latest verdict.
- For a `specialty-review` child, missing `agent` or an agent that does not
  syntactically match `review-*` is malformed attribution and prevents
  aggregate success. A closed malformed child cannot be re-dispatched to an
  unknown intended specialty: the dispatcher records broken dispatch once with
  its child id, then stops without retrying or guessing from the title/prompt.
- With a valid historical specialty key, missing or malformed `latestRun` and
  nonterminal statuses never imply PASS. A running child may be joined; when
  appropriate, a currently dispatchable specialty may be re-dispatched once.
  A later terminal child for the same historical key supersedes that unresolved
  evidence. If that finite repair path fails—or a retired specialty cannot be
  dispatched—the dispatcher records broken dispatch once instead of looping.
- An older endpoint payload may omit `workflowName`. Every such record is
  version-incomplete history and prevents aggregate success because it cannot
  be classified as panel or unrelated. The dispatcher may retry the supported
  MCP/typed CLI query once only when that surface can return the current shape.
  If `workflowName` remains absent, it records broken dispatch with the child id
  and an explicit incompatible-server/upgrade-required reason. It never infers
  PASS, overwrites an actual prior terminal verdict, or enters a retry loop.
- A specialty that has never been reviewed and is untouched this round has no
  verdict. The dispatcher neither runs it without a relevant surface nor
  invents a PASS.

The aggregate summary cites each new or carried verdict with child-id and
available `createdAt`/`latestRun.finishedAt` timestamp provenance and explicitly
names untouched specialties whose actual verdict was carried. It keeps the
current aggregate round and reviewed range, but does not invent the exact round
of a historical child because that field is not in this endpoint. This is a
reduction over normalized task/run records, not a migrated or duplicated
aggregate: no backfill is required, and closed historical children remain
queryable.

A carried FAIL is detected, not blindly made blocking. Its underlying finding
is re-evaluated against the current full branch, original task, and common scope
bar. If the finding no longer clears that bar, the dispatcher explains the
non-blocking disposition without falsifying the recorded FAIL as a PASS. If it
still clears the bar, it survives in the revision's closed list even though the
specialty was untouched this round.

Three fallbacks keep the narrowing honest:

- **Ambiguous history** — review the whole branch, and say so in the summary so
  a human can tell a narrow round from a full one. Reviewing too much costs a
  round; reviewing the wrong range misses defects.
- **Empty round** — dispatch nothing and request a revision: if the revision
  committed nothing, the previous round's findings cannot have been addressed.
- **Declined findings** — the review stage prompt carries `$PREV_MAIN_RESULT`,
  the implementing agent's own summary of what it changed and what it declined.
  A finding the previous round demanded and the implementer declined is still
  blocking, whether or not any specialty re-runs this round.

  This needs its own binding. `$PREV_RESULT` is the latest finished run of any
  kind, and the `in progress` stage declares a `commit` post, so at review time
  it holds the *commit* agent's result — what was committed, not what the
  implementer decided. Routing the declined-findings check through it would
  have dropped exactly the report the check exists to read.
  `$PREV_MAIN_RESULT` (`latest_finished_main_stage_run_result`, posts excluded)
  resolves the previous stage agent's own run, leaving `$PREV_RESULT` untouched
  for the workflows that want the post result — the `approve` post still reads
  it. The chain is covered end to end in
  `http_api::tests::revision_status`: an implementation main run reporting a
  declined finding, its commit post reporting a different summary, and the
  review stage prompt that follows, asserting each binding carries its own
  result.

Deliberately *not* a limit: how many specialties one dispatch may fan out.
The built-in specialties have disjoint scopes, and migration, security, and
concurrency each apply to a large share of real changes — capping the panel
would drop a reviewer that had something in scope to say, which is a coverage
loss, not a scope win. Dispatch is gated on relevance instead: a specialty is
dispatched when the diff changes its surface, and skipped when it does not,
since a reviewer pointed at an unmodified surface can only report out-of-scope
findings.

## Verdict flow

```
parent review stage (qa-dispatcher, auto)
  ├─ kanna_list_task_children(parent) → closed + open children, oldest first
  │    └─ select workflowName=specialty-review, then reduce latest terminal latestRun per review-* agent
  ├─ kanna_create_task {workflow_name: specialty-review, agent: review-ui,   base_ref: $BRANCH, parent/notify: self,
  │                     display_name: "UI review: <subject> (round n)"}
  ├─ kanna_create_task {workflow_name: specialty-review, agent: review-sec…, base_ref: $BRANCH, parent/notify: self,
  │                     display_name: "Security review: <subject> (round n)"}
  ├─ kanna_wait_task until finished (per child; waitOutcome timeout → call again; notify "TASK <id> DONE" doubles as a wake-up)
  ├─ kanna_get_task → latestRun.status/summary   (succeeded=PASS / failed=FAIL)
  ├─ kanna_close_task (every child, after collecting its verdict)
  ├─ filter new and carried findings against the scope bar (caused by this diff AND blocking)
  └─ nothing blocking → kanna_complete_stage success → auto-advance to pr
     blocking findings → kanna_request_revision "in progress" with the closed list
       ├─ under budget  → revision round N of M starts
       └─ budget spent  → nothing starts; task parks unread for its human
```

## Test coverage

- `crates/kanna-tool-catalog/tests/catalog.rs` — the `agent` param is exposed
  and maps into the create body; `stage` remains rejected; the direct-child
  list tool maps `task_id` to the task-children endpoint.
- `crates/kanna-cli` — typed `task create --agent` and `task children
  --task-id` surfaces match the catalog/API contracts.
- `crates/kanna-server` `task_creator::tests::core` — the builtin
  `specialized-reviewers`/`specialty-review` workflows and all four dispatch agents
  resolve from compiled resources; a dispatcher-style create request
  (`specialty-review` + `agent: review-security` + parent/notify) prepares a
  spawn bound to the specialty agent with a manual completion transition.
- `crates/kanna-server` `mobile_api` — `get_task` surfaces the latest stage
  run verdict (and omits `latestRun` for tasks without runs).
- `crates/kanna-server` `task_creator::tests::revision` — `revision_limit`
  parses (default when omitted, explicit value, `0` = unlimited),
  `RevisionBudget::exhausted` only bites at a positive limit, and the composed
  revision prompt and resume message announce the round, the scope rules, and
  the final round.
- `crates/kanna-server` `http_api::tests::revision_status` — against the real
  router and DB: an agent revision under budget starts a round, counts it, and
  spawns with `Revision round 1 of 3` in the prompt; an agent revision with the
  budget spent starts nothing (no daemon is even listening), leaves the task at
  `review`, marks it `unread`, records the parked verdict with the findings as
  feedback, and reports `exhausted: true`; a `human`-origin revision at the same
  spent budget proceeds and resets the count to 0.
- `apps/desktop` `workflow.requestRevision.test.ts` and the diff-modal E2E
  (`tests/e2e/mock/diff-view.test.ts`) — the desktop revision action posts
  `origin: "human"`, which is what exempts a user-requested revision from the
  agent budget.
- `packages/core` `qa-assets.test.ts` — the new agents satisfy the built-in
  agent completion-protocol contract, and the dispatcher asset is pinned to
  MCP-first durable child-history reduction with fail-closed carry-forward.

### E2E gap

The full multi-session, multi-round carry-forward workflow is not covered end
to end. The canonical statement of why it is not deterministic in current CI,
what would make it testable, and which narrower tests cover the pieces is
[QA specialty verdict history: end-to-end coverage gap](../2026-08-06-qa-specialty-verdict-history-e2e-gap.md).
