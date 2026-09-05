# The PR Review Surface

Status: **proposed — design assessment, awaiting owner decision. Nothing here is implemented.**
Supersedes (on acceptance) the review half of [native-review.md](./native-review.md).
Related: [merge-master.md](./merge-master.md), [task-graph-stages.md](./task-graph-stages.md),
[task-spec-artifact.md](./task-spec-artifact.md),
[forge-independence.md](./forge-independence.md) (parked, not opened here).

## The directive

Owner, 2026-09-05, delivered into task `f1c3ca89` (`kanna_task_inputs` id 148):

> "…the problem is our PR approval feature sucks so I would suggest that we
> remove it and launch another task to rethink it. The idea is to let the user
> actually review PRs so they don't actually have to go to GitHub to review
> them. That's the idea — to devalue GitHub."

The same message confirmed that a PR-stage task advancing through a post action
into the merge master's queue "is OK". So the target is not the workflow. It is
the *reviewing*: today an operator cannot form a judgment inside Kanna, so they
open GitHub, and every time they do, GitHub — not Kanna — is where the work
gets decided.

What to remove is being clarified in `f1c3ca89`. This spec proposes what to
build; it deletes nothing.

## What exists today

Phase 1 of [native-review.md](./native-review.md) shipped, and it is a real
loop: ⌘D opens `DiffModal.vue`, which renders `DiffView.vue` (@pierre/diffs via
`useDiffRenderer.ts`) and, when the task's stage is `review` or `pr`, adds a
verdict bar. Clicking a line number opens a composer; comments accumulate in
`useAppModals.ts::diffViewStates` keyed by task; `c` toggles a drawer; `⇧⌘S`
composes them into a `request-revision` prompt targeting `in progress`; `⌘S`
fires `advance-stage`, which at the `pr` stage dispatches the `approve` post,
which resolves the PR and calls `kanna_signal_merge_handoff`. E2E coverage for
both verdicts exists in `apps/desktop/tests/e2e/mock/diff-view.test.ts`.

Mobile has `TaskDiffPreview.tsx` — a read-only unified patch in a WebView with
scope/mode toggles — and a bare `Advance Stage` row in `taskActionMenu.ts`.

That is the whole of it. The verdict bar is three controls and one number.

## Diagnosis

Seven gaps, ordered by how much each one alone forces a trip to GitHub.

1. **Nothing says what you are looking at.** No PR title or body, no head sha,
   no base, no commit list, no file list, no +/− counts, no CI or check status.
   The verdict bar's only fact is a pending-comment count. The single PR
   affordance in the app is `TaskHeader.vue`'s hyperlink — the app's one
   answer to "what is this PR?" is a link to GitHub.
2. **Nothing says what it was supposed to do.** The task spec
   (`docs/task-specs/<id>.md`, committed on the branch by the implement agent),
   the original prompt, the delivered-input ledger, and the review agent's own
   verdict and feedback are all invisible during review. The reviewer judges
   code against memory, which is exactly the failure the task-spec artifact
   exists to prevent — and the artifact is not on screen when it matters.
3. **The diff is not navigable at PR size.** One unified patch in one scroll
   container: `j/k`, search, scope cycling. No file tree, no jump-to-file, no
   per-file collapse, no viewed-tracking, no "what changed since my last
   pass". Above roughly fifteen files this stops being review and becomes
   skimming. `useDiffRenderer.ts` already computes a per-file list with
   addition and deletion lines (for search) — the data exists and no UI shows
   it. Files past `MAX_RENDERABLE_DIFF_FILE_CONTENT_LENGTH` render as a skip
   placeholder; on the remote/mobile path the whole patch is capped at
   `MAX_TASK_DIFF_BYTES` (1 MiB) with a "diff truncated" banner. Past those
   limits the app's own answer is: go to GitHub.
4. **Approve is blind and unattested.** ⌘S posts `advance-stage`. Nothing
   records which sha was approved, nothing checks that the sha you read is the
   head the merge master will merge, and there is no confirmation on an action
   whose next hop is a merge signal. The `pr` agent rebases and may
   force-push; `merge@github` merges whatever the PR head is at merge time.
   The gap between "what a human read" and "what gets merged" is currently
   unmeasured and unrecorded.
5. **Nothing reports the handoff.** The button says "Approve & Merge" and then
   the UI goes quiet. `merge_signaled_at` is written on the task by
   `signal_agent.rs` and surfaced in no client. The approve post's `stage_run`
   status is likewise invisible from the review surface. The operator learns
   the merge master heard them by opening the merge master's terminal.
6. **Request-changes is narrower than review is.** It requires at least one
   line comment, so "this is the wrong approach, start from the other end" is
   unsendable; it hard-codes `targetStage: "in progress"`; and once sent, the
   comments vanish from the client with no local trace of what each round
   said. The durable copy lives in `stage_run.feedback`, which no client
   renders.
7. **Pending review state is fragile, and mobile has none.** Comments live in
   an in-memory reactive record — an app restart loses an unsent pass, and
   staleness against a moved tip is a warning label, not a recovery. On
   mobile there is no commenting, no verdict, and `Advance Stage` is a menu
   row with no diff, no context, and no approval semantics at all.

**Root cause.** The diff modal is a repository tool that grew a verdict bar.
⌘D's subject is "the selected task or repo's changes"; review was added as a
conditional strip when `stage ∈ {review, pr}`. But review's subject is a
different thing: a **(task, base…head) pair judged against the task's stated
intent**. Everything above follows from asking a repo-diff viewer to be a
review tool.

## The rethink

**Make the reviewed change the subject, put the task's intent beside it, and
make approval say what it approved.**

Three principles are inherited and unchanged:

- The engine stays forge-neutral. No `review_thread`/`review_comment` tables,
  no forge data model in SQLite, no review-thread endpoints. Forge behavior is
  user-space `.kanna/` agents and config.
- Feedback is a composed message delivered through `request-revision`, not a
  stored thread.
- Approval *is* `advance-stage`. The `pr` stage's `approve` post and its
  `kanna_signal_merge_handoff` are untouched.

One principle is added:

- **What was reviewed is a fact.** Review's one durable output is an
  attestation — reviewed `base…head` at time T, verdict V. This is a judgment
  on the task's own run history, not a forge thread, and it is what makes
  approval mean something and the handoff trustworthy. It costs two nullable
  columns and one event type. This is the design's one schema addition and it
  is deliberately called out for the owner to accept or reject.

## The surface

A task-scoped review view. It keeps ⌘D's entry point, keyscape, tear-off, and
remote/relay transport — this is a reshaping of the diff modal into a review
surface, not a second modal.

```
┌ Review · task-231ad8fc · main…a9f3c21 ────────────────────────── ⌘D ┐
│ CHANGE MAP        │  DIFF                        │  CONTEXT        │
│ ───────────────── │  ──────────────────────────  │  ────────────── │
│ main…a9f3c21      │  ▾ stores/workflow.ts  +18-4 │ [Intent]        │
│ 3 commits         │   118  -  const r = retry(   │  History  PR    │
│ 14 files +302-88  │   119  +  if (!ok) throw     │  Comments       │
│ ───────────────── │        ┌──────────────────┐  │ ────────────────│
│ ✓ workflow.ts +18 │        │ this hides the   │  │ Goal            │
│ ✓ router.rs   +9  │        │ real error…   ⌘↵ │  │ Rethink the in- │
│ ● task_diff.rs+41 │        └──────────────────┘  │ app PR review…  │
│ ○ DiffView.vue+96 │                              │                 │
│   …               │  ▸ router.rs           +9-0  │ Scope: in / out │
│ ───────────────── │  ▸ task_diff.rs       +41-2  │ …               │
│ COMMITS           │                              │ ─── directives ─│
│ a9f3c21 fix retry │                              │ 2026-09-05 op:  │
│ 71bc004 add test  │                              │ "…"             │
├───────────────────┴──────────────────────────────┴─────────────────┤
│ Approving a9f3c21 · 14 files · 2 unviewed · 3 comments             │
│                            [Request changes ⇧⌘S]  [Approve ⌘S]     │
└────────────────────────────────────────────────────────────────────┘
```

**Change map (left).** Range header (`base…head`, short shas, commits ahead,
total +/−); the file list with status letter, +/− counts, a comment badge, and
a viewed state (`○` unviewed, `●` has comments, `✓` viewed); a collapsible
commit list. Clicking a file scrolls the diff to it; clicking a commit scopes
the diff to that commit alone. A range selector offers `base…head` (default),
`since my last pass` (from the recorded reviewed head), and single commits.

**Diff (center).** Today's renderer, with per-file sections that collapse and a
per-file header carrying the viewed toggle. Files load lazily per section, which
is what removes both size walls: the change map comes from a numstat pass over
the whole range (cheap and complete even for enormous diffs), and only the file
you look at is parsed and rendered.

**Context (right, collapsible).** Four tabs, all read-only except Comments:

| Tab | Source | Why it is there |
|---|---|---|
| Intent | `docs/task-specs/<id>.md` from the worktree, the task prompt, the delivered-input ledger (`/v1/tasks/{id}/inputs`) | Gap 2 — judge against the stated contract, and see the mid-task directives that changed it |
| History | `stage_run` rows: results, feedback, revision rounds, resume fallbacks | The review agent's verdict and every prior round, which is Kanna's durable review record already |
| PR | the repo's `reviewContext` command (below), when configured | Gap 1's forge half — title, body, state, checks, requested reviewers |
| Comments | the pending pass (today's drawer) plus the summary composer | Unchanged in substance; it moves into the pane it belongs to |

**Keys.** The existing keyscape is preserved exactly (`useLessScroll` keeps
`j/k/f/b/d/u/g/G/q`, search keeps `/`, `⌘F`, `n/N`, `s` and `a` keep their
meaning, `⇧⌘[`/`⇧⌘]` keep scope cycling, `c` keeps the comment drawer, `⌘S`
approve, `⇧⌘S` request changes). Three additions, all free letters:
`Tab`/`⇧Tab` next/previous file, `v` toggle viewed on the current file, `i`
toggle the context pane. No line-cursor mode — still deliberately absent, for
the reasons native-review gives.

## What approval means

Approve still posts `advance-stage`. Three things change around it.

**It carries what was reviewed.** The action body gains an optional `review`
object: `{reviewedHead, reviewedBase, fileCount, unviewedCount, commentCount}`.
The server stamps `pipeline_item.reviewed_head` and `reviewed_at`, appends a
`task.review_recorded` task event where that write already happens, and exposes
both on task detail. Callers that send nothing behave exactly as today — this
is additive and unauthenticated in the same way `trigger` and input `source`
are.

**It refuses to be blind.** Before sending, the surface re-resolves the head.
If it differs from the head the reviewer actually read, the footer says so and
approval requires a second, explicit confirmation naming both shas. Same for a
`base` that has moved under the review. Unviewed files are reported, never
blocking — a warning line, not a gate.

**It reports the handoff.** The footer becomes a live readout driven entirely
by state that already exists: `advance-stage` accepted → the `approve` post's
`stage_run` running → `merge_signaled_at` set → task closed. "Approve & Merge"
stops being a claim and becomes a progress line. This needs one field
(`mergeSignaledAt`) added to task detail and the snapshot, and no new plumbing.

Nothing here changes the workflow engine's transition semantics, the post
mechanism, the merge handoff route, or the close-time backstop.

## What request-changes becomes

- Sendable with a summary and zero line comments.
- The target stage comes from the workflow definition (the first stage before
  the current one that has an agent able to act — in practice `in progress`),
  with an override in the composer, instead of a hard-coded string.
- The composed prompt is unchanged in format (file:line anchors + excerpt +
  note + summary — one convention for human and agent feedback).
- After sending, the round is not lost from view: the History tab renders
  `stage_run.feedback`, so the previous round's requests are readable next to
  the new diff. This is display of existing durable data, not new storage.

## Forge enrichment without forge coupling

The PR tab is the only forge-touching part, and it must not put GitHub in the
engine. It uses the mechanism `.kanna/config.json` already has for repo-owned
commands: a new optional `reviewContext` entry, run read-only in the task
worktree, expected to print one JSON document:

```json
{
  "url": "https://github.com/o/r/pull/42", "state": "open", "isDraft": false,
  "title": "…", "body": "…", "headSha": "a9f3c21", "baseRef": "main",
  "checks": [{ "name": "ci/test", "status": "pass", "url": "…" }],
  "reviewers": ["…"], "comments": [{ "path": "…", "line": 12, "author": "…", "text": "…" }]
}
```

The stock GitHub value is a `gh pr view --json …` plus `gh pr checks`
invocation. The engine never learns what GitHub is; it runs a command the repo
declared, the way it runs `setup` and `test`. The server exposes the result at
`GET /v1/tasks/{id}/review-context` with a short in-memory TTL and **no
persistence**, so mobile and relay get the same pane for free. Unconfigured,
unavailable, or failing: the tab says so and offers the link. Review never
blocks on it.

This is the boring competitor `forge-independence.md` demands be tried first —
forge data read live and thrown away, versus a shared review store. It does not
open that spec's gate.

## Mobile

Same subject, less of it: a Review screen with the change map (files, +/−,
viewed), tap-through to a single file's diff, the Intent and PR tabs, line
comments, and the same two verdicts. The attestation, the head-mismatch guard,
and the handoff readout are server-side facts, so mobile approval stops being
blind at the same moment desktop's does — which is the review-side half of the
owner's "mobile advance stage should work the way desktop's does". The
advance-stage parity work itself belongs to `f1c3ca89`.

The per-file diff endpoints below also retire mobile's 1 MiB truncation banner.

## Phasing

Each phase is shippable and useful alone, and the order is by how much each
removes a reason to open GitHub.

### Phase 0 — Honest approval (server + desktop, small)

Attestation columns, `task.review_recorded` event, `mergeSignaledAt` on task
detail; footer shows what is being approved, warns and re-confirms on head
mismatch, and reports post/handoff progress; request-changes accepts a
summary-only pass and resolves its target stage from the workflow.

Acceptance criteria:

- `POST /v1/tasks/{id}/actions/advance-stage` with a `review` body stamps
  `reviewed_head`/`reviewed_at` and appends exactly one `task.review_recorded`
  event; without the body, behavior is byte-identical to today (existing tests
  unchanged).
- `kanna_get_task` reports `reviewedHead`, `reviewedAt`, `mergeSignaledAt`.
- Desktop E2E: open review on a fixture branch, commit a new head under the
  open modal, press ⌘S → approval is not sent; the footer names both shas; a
  second confirmation sends `advance-stage` carrying the *read* head.
- Desktop E2E: request changes with no line comments and a summary → a
  `request-revision` payload whose prompt contains the summary and no anchors.
- Desktop E2E: after approve at a `pr` stage with an `approve` post, the footer
  moves through approving → handed off (asserted against `merge_signaled_at`).

### Phase 1 — The change map (desktop + one git command)

`git_diff_numstat(repoPath, from, to, mode)` (git2, no shelling) returning
`{path, oldPath?, status, additions, deletions, binary}`; per-file lazy diff
loading; file list, commit list, viewed state, `Tab`/`⇧Tab`/`v`; "since my last
pass" range from `reviewed_head`.

Acceptance criteria:

- Unit: numstat command against a fixture repo returns renames with `oldPath`,
  binary files flagged, and correct counts for add/delete/modify.
- Desktop E2E: a 40-file fixture branch renders a complete file list before any
  file body is parsed; clicking file 37 scrolls to it and renders it.
- Desktop E2E: a file exceeding the render limit appears in the map with counts
  and opens as the existing skip placeholder — it is never silently missing.
- Desktop E2E: `v` marks viewed, the footer's unviewed count decrements, and the
  state survives closing and reopening the surface for the same head.
- Perf: first-content time for the 20×1500 perf fixture does not regress
  against the existing `KANNA_E2E_DIFF_FIRST_CONTENT_MS` budget.

### Phase 2 — The context pane (desktop)

Intent, History, Comments tabs; `i` toggles the pane. Intent reads the task
spec through the existing `GET /v1/tasks/{id}/files/content`; History reads
stage runs; Comments moves the drawer in.

Acceptance criteria:

- Desktop E2E: a fixture branch containing `docs/task-specs/<id>.md` renders it
  in Intent; a branch without one shows a "no task spec on this branch" state
  and does not error.
- Desktop E2E: a task with a prior revision round shows that round's
  `stage_run.feedback` in History.
- Desktop E2E: a task with delivered inputs lists them in Intent, oldest first,
  with their declared source.

### Phase 3 — The PR tab (config + server + desktop + mobile)

`reviewContext` in `.kanna/config.json` and its schema; `GET
/v1/tasks/{id}/review-context` with TTL cache and no persistence; the PR tab on
both clients; stock GitHub value documented in `docs/dev/`.

Acceptance criteria:

- Server unit: a repo declaring a command that prints the document returns it;
  a command that fails, times out, or prints invalid JSON returns a typed
  "unavailable" with the reason and never a 500.
- Server unit: the result is never written to SQLite (asserted by schema, not
  by inspection) and expires from cache within the TTL.
- Config schema test: `reviewContext` validates, and `config.local.json`
  continues to reject it (it changes what a task means, not how one machine
  runs it) — or accepts it, if the owner decides otherwise.
- Desktop + mobile E2E (mock): configured repo renders title/state/checks;
  unconfigured repo renders the empty state and the surface stays usable.

### Phase 4 — Mobile review (mobile)

Review screen, per-file diff endpoints (`GET /v1/tasks/{id}/diff/files` and
`?file=`), verdicts with attestation.

Acceptance criteria:

- Server unit: the file-scoped diff of a branch whose full patch exceeds
  `MAX_TASK_DIFF_BYTES` returns every file's entry untruncated.
- Mobile component test: change map renders, tapping a file loads its patch,
  approve sends `advance-stage` with the `review` body.
- Mobile E2E over LAN: approve from the phone stamps `reviewed_head` on the
  desktop's task.
- Simulator verification with screenshots, per the repo's UI rule, before the
  PR opens.

## Tradeoffs

| Decision | Alternative | Why this way | Cost accepted |
|---|---|---|---|
| Two attestation columns + one event | Record nothing (today); or a full review-record table | Smallest thing that makes approval mean something and lets the head-mismatch guard exist. A verdict on a run is not a forge thread | A real, if small, schema addition to a system that said "no new review storage" — hence the explicit owner decision |
| `reviewContext` repo command | Desktop shells `gh` directly; or a built-in GitHub client | Engine stays forge-neutral by construction, works over relay and on mobile, respects the vendoring rule (nothing new is bundled) | A JSON shape becomes a contract we must version; a mis-declared command yields a degraded pane |
| Per-file lazy diff | One patch, one render (today) | Removes both size walls; makes the change map cheap | Whole-patch search must fall back to fetching the full patch on first `/` — an extra pass on huge diffs |
| Reshape the diff modal | A separate review route or window | Keeps ⌘D muscle memory, tear-off, remote transport, and the whole existing keyscape; one surface for "look at changes" and "judge changes" | The modal gets busier; three panes in 90vw is tight on a laptop, so both side panes must collapse and remember it |
| Confirm only on mismatch | Always confirm; never confirm (today) | Friction lands exactly where the risk is | A reviewer who ignores the warning can still approve a sha they did not read — recorded, at least |
| Warn on unviewed files | Block approval until all viewed | Single-operator app; a gate here would be theater the owner would route around | The viewed state is advisory and can drift into decoration |

## Non-goals

Carried forward from native-review and re-affirmed: persistent review threads,
comment tables, `/v1` review endpoints, MCP thread tools, comment re-anchoring
across revisions, blocking approve on open comments, review checklists,
multi-reviewer coordination.

Added here: posting comments back to the forge from the app (that stays a
user-space agent's job), suggested-changes/inline editing, merging from Kanna
directly (the merge master owns merging), and any change to workflow stage
semantics, the post mechanism, or the merge handoff route.

## Open questions for the owner

1. **The attestation columns.** Accept the two-column addition and the
   `task.review_recorded` event, or keep approval unattested and drop the
   head-mismatch guard with it? Everything else in Phase 0 survives either way.
2. **How much of the PR tab is wanted.** "Devalue GitHub" reads two ways:
   *mirror* GitHub's PR data in Kanna (Phase 3), or *stop needing* it — review
   the branch against the task spec and let the PR be a publishing detail
   (Phases 0–2 alone). Phase 3 is the more expensive reading and the one that
   ties us to a forge shape.
3. **What "sucks" meant most.** This design ranks the gaps by reasoning, not by
   observation of the owner reviewing. If the real irritant is narrower — say,
   only that approve says nothing and the handoff is invisible — Phase 0 alone
   is the answer and Phases 1–4 should wait.
4. **Fate of the current UI.** `f1c3ca89` is deciding what gets removed. If the
   verdict bar and comment overlay are removed before this lands, Phase 0's
   footer work becomes Phase 0's *whole* verdict surface, which is a different
   (larger) first phase.
