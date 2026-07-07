# Native Review

Status: proposed (design spec, no implementation yet)
Related: [merge-master.md](./merge-master.md),
[task-graph-stages.md](./task-graph-stages.md),
[../kanna-server-boundary.md](../kanna-server-boundary.md)

How Kanna makes reviewing a task's changes a first-class, in-app experience —
and in doing so removes the last reason `gh` is load-bearing. Merge-master
established **git ≠ gh** and deliberately deferred "line-anchored diff
feedback" pending an @pierre/diffs annotation spike. This spec is that
follow-up, plus the review data model and UX around it.

## Why the GitHub PR is the wrong surface

A forge PR bundles five things. For Kanna's workflow, four of them are
already better served in-app, and the fifth is optional:

| Forge PR provides | Kanna equivalent |
|---|---|
| A diff to read | ⌘D branch diff (`DiffModal.vue`, @pierre/diffs) — already better: live, scoped, searchable, no page loads |
| A place to comment | **Missing — this spec** |
| A verdict (approve / request changes) | Stage actions: `complete-stage` / `request-revision` — exist, but only agents call them today |
| A merge button + audit record | Merge master (git-first, [merge-master.md](./merge-master.md)) + a merge record — partially specced |
| Team distribution / branch protection / external CI | Genuinely forge territory — stays optional, user-space |

The deeper problem is structural, not cosmetic. A GitHub review comment is a
message **to a human author** who will read it, interpret it, and edit code.
In Kanna the author is an agent with a live (or resumable) session. Routing
feedback through a forge means: human reads agent's diff in Kanna → switches
to github.com → writes comments → copies them back into a revision prompt →
agent gets flattened free text with no file/line anchors. Every hop loses
structure the agent could have used. The forge is a fax machine between two
parties who share a database.

## Where SWE work is going (the forcing function)

**Now → 1 year: review is the job.** Agents author the overwhelming
majority of diffs; the human's scarce resource is judgment per minute.
Review stops being an occasional social ritual between peers and becomes
the operator's primary activity — a continuous inbox, not an event. The
tooling consequences:

- Latency of the feedback loop dominates. A comment that round-trips
  through a forge and a copy-paste costs minutes; a comment that resumes
  the authoring session with anchored context costs seconds. At tens of
  reviews a day this is the whole ballgame.
- The first reviewer is another agent. The review stage already runs a QA
  agent; its findings should land in the same anchored-comment medium the
  human uses, so the human triages findings instead of re-deriving them
  from terminal scrollback.
- Keyboard-first, modal, zero-navigation. The operator lives in Kanna;
  review must be a mode of the app, not a browser tab.

**5 years: review shifts from diffs to intent and evidence.** Humans state
invariants and acceptance criteria; agents author, cross-review, and gather
evidence (tests run, behaviors exercised, properties checked). The human
verdict increasingly attaches to *outcomes* ("the checks the repo declared
all pass, the risk annotations are green, the agent-reviewer signed off")
rather than to every hunk. Low-risk changes merge under policy without a
human reading the diff at all; the durable artifact is not a PR page but the
**task record**: prompt, runs, review threads, verdicts, checks, merge
commit. Kanna already owns every piece of that record except review
threads and verdicts — which is exactly what this spec adds. The PR as a
social artifact disappears; the audit trail doesn't.

Designing for that trajectory means: structured review data owned by
kanna-server (so policy can act on it later), comments that are
machine-actionable prompts (so agents are first-class participants), and
verdicts that are engine actions (so "approve" can later be issued by
policy as easily as by a keypress).

## Principles

- **The task is the change request.** One task = one branch = one review.
  No parallel "PR" object; review state hangs off `pipeline_item` and
  `stage_run`, which already carry the prompt, runs, branch, and verdicts.
- **A comment is a prompt fragment.** Every review comment is structured
  (file, line range, anchored hunk snapshot, body, author) precisely so it
  can be composed into a revision prompt or answered by an agent tool call.
  Human-to-agent and agent-to-human comments are the same row.
- **Verdicts are stage actions.** Approve = advance (⌘S path); request
  changes = `request-revision` with the open threads attached. The engine
  already has both actions; this spec gives humans a surface for them.
- **Forge-blind engine, forge in user-space.** Same rule as merge-master:
  the engine ships neutral primitives (threads, verdicts, merge records).
  A repo that needs GitHub keeps a `pr` agent that pushes/mirrors; a repo
  that doesn't declares a pipeline without one and merges git-first.
- **kanna-server owns review state.** Comments and verdicts go through
  `/v1`, not `tauri-plugin-sql` — consistent with the desktop → server
  migration direction ([kanna-server-boundary.md](../kanna-server-boundary.md)).
  Mobile and future clients get review for free.

## The review workspace (UX)

⌘D grows from "diff viewer" into the review workspace. No new modal; review
is a capability of the branch-scope diff, present whenever the task has
review threads or is parked at a reviewable stage.

- **File rail + viewed tracking.** File list with per-file viewed
  checkmarks (`v` toggles, auto-advance to next unviewed). Viewed state
  persists per (task, head commit) so a revision resets only the files
  that changed.
- **Line-anchored threads.** Click a line number or press `c` on the
  focused line (range via selection or `V` line-select mode) → inline
  comment composer. Threads render in the gutter/margin of the diff,
  collapsed to a chip when not focused. `]` / `[` jump next/prev thread,
  `r` reply, `⌥⏎` resolve.
- **Agent findings arrive as threads.** The review-stage agent files its
  findings through the same API (see MCP tools below). The human opens ⌘D
  and sees the QA agent's anchored findings alongside their own — triage,
  not re-derivation.
- **Verdict bar.** When the task is parked at a stage whose policy is
  manual and reviewable, the workspace shows a verdict bar:
  - **Request changes** (`⇧⌘R`): composes every open thread plus an
    optional summary into a `request-revision` payload. Threads transition
    to `pending-rework`.
  - **Approve** (`⇧⌘A` in review context): fires the existing advance
    path (⌘S semantics) — which at the `pr` stage dispatches the approve
    post → merge master, per merge-master.md.
  - Open threads gate approve by default (override with confirm) — the
    same nudge a forge gives, without the forge.
- **Revision round-trip.** When the implement agent finishes a revision,
  each thread it addressed shows the agent's reply and a "re-anchored ✓ /
  outdated" badge; the diff refreshes to the new tip. The operator's loop
  is: read reply → glance at new hunk → resolve or push back — without
  leaving the modal.
- **Review inbox.** The sidebar already bolds unread tasks; tasks parked
  awaiting a human verdict additionally surface a thread/verdict badge.
  ⌘⌥↑/↓ between them makes the queue workable at fleet scale.

Terminal stays one keystroke away: threads are the durable, anchored
channel; the live session (type-in-terminal, `send-input`) remains the
ephemeral one. Both already share a task.

## Comments are prompts (the round trip)

1. Human files threads in ⌘D. Each stores the anchor (below) and body.
2. **Request changes** → `POST /v1/tasks/{id}/actions/request-revision`
   with `threads: [thread_id, ...]`. The engine composes the revision
   message from the existing template
   (`task_creator/prompt.rs::build_revision_resume_message`) plus a
   structured block per thread:

   ```
   [thread kn-42] apps/desktop/src/stores/pipeline.ts:118-124 (new side)
   > (anchored hunk excerpt)
   Comment: this retry loop hides the real error — surface it and drop the loop.
   Reply with kanna_reply_review_thread when addressed.
   ```

3. The revision resumes the implement session in its worktree (existing
   `prepare_revision_resume` path — session already has full context; the
   threads are deltas, which is exactly what resume is good at).
4. The agent addresses each thread and calls
   `kanna_reply_review_thread` (reply + optional `resolves: true`;
   resolution by the author-agent marks `resolved-by-author`, human
   confirmation closes it — mirrors how good human teams use "resolved").
5. On run completion the server re-anchors every open thread against the
   new tip (below) and emits SSE so the open ⌘D refreshes in place.

The same tools make the **review agent** a first-class reviewer: its
AGENT.md gains "file each finding with `kanna_add_review_thread`, then
either `kanna_request_revision` (blocking findings) or
`kanna_complete_stage` (clean / advisory-only)". Advisory threads persist
into the human's review instead of dying in the run summary.

## Anchoring and re-anchoring

Forge comments rot on force-push; ours must survive revision cycles, which
are the common case, under a workflow that rebases and forks branches.

Each thread stores at creation:

- `anchor_commit` — head SHA when filed
- `file_path`, `side` (`old`/`new`), `line_start`/`line_end`
- `anchor_excerpt` — the anchored lines plus N context lines (text)

Re-anchor on new head: locate `anchor_excerpt` in the new blob (exact →
whitespace-insensitive → fuzzy window). Found → update lines, badge
`re-anchored`; not found → mark `outdated`, keep rendering the stored
excerpt so the conversation stays legible (a thing GitHub still gets wrong).
Same algorithm family as `utils/fuzzyMatch.ts` in spirit: cheap, local,
no git-blame dependency. Outdated-but-open threads still block approve.

## Data model (kanna-server owns it)

```
review_thread
  id, pipeline_item_id, stage_run_id,            -- run that was under review
  author_type ('human'|'agent'), author,          -- agent name or operator
  file_path, side, line_start, line_end,
  anchor_commit, anchor_excerpt,
  status ('open'|'pending-rework'|'resolved-by-author'|'resolved'|'outdated'),
  created_at, resolved_at

review_comment
  id, thread_id, author_type, author, body, created_at

merge_record                                       -- from merge-master, made durable
  id, pipeline_item_id, target_branch, merge_commit,
  strategy, merged_by, merged_at
```

Verdicts need **no new table**: approve/request-changes are already
`stage_run` outcomes (`result`, `feedback`, `status`). A human verdict is a
stage action with `author: operator` in metadata — one history for agent
and human judgments, which is what a 5-year audit trail wants.

## API and tool surface

`/v1` (kanna-server; desktop uses these, not tauri-plugin-sql):

- `GET  /v1/tasks/{id}/review` — threads + comments + anchors for the task
- `POST /v1/tasks/{id}/review/threads` — create thread (anchor payload)
- `POST /v1/tasks/{id}/review/threads/{tid}/comments` — reply
- `POST /v1/tasks/{id}/review/threads/{tid}/resolve` | `/reopen`
- `request-revision` gains optional `threads: [...]`
- `POST /v1/tasks/{id}/actions/merge` — merge-master trigger already
  specced; writes `merge_record`
- SSE `/v1/stream`: `review_thread_changed` events (thread id + status)
  so open clients refresh in place

MCP tools (via `kanna-tool-catalog`, so kanna-cli gets them for free):
`kanna_list_review_threads`, `kanna_add_review_thread`,
`kanna_reply_review_thread`, `kanna_resolve_review_thread`. Review and
implement AGENT.md reference them.

Diff data for anchors comes from the same source the modal renders
(`git_diff_branch_range` et al.); the composer captures the excerpt
client-side at comment time, so the server never needs to re-run a diff to
store an anchor.

## What happens to `gh`

- **Default pipelines stop requiring it.** The `pr` agent's essential job
  shrinks to: rebase onto `$BASE_REF`, rename the branch, `git push`.
  Review happens in Kanna; approve signals the merge master; the merge
  master merges git-first and records `merge_record`. No forge round-trip
  anywhere on the golden path. (For a single-remote solo repo, even the
  push is optional — merge can be a local fast-forward plus push of the
  default branch.)
- **Forge mode stays user-space.** A team on GitHub with branch protection
  keeps a `pr` AGENT.md that creates a draft PR and an approve post that
  runs `gh pr ready`; the merge master already prefers `gh pr merge` when
  a `pr_url` exists. Optionally, a `mirror` post can push thread summaries
  to the PR as a single comment for non-Kanna teammates — an agent
  behavior, never an engine dependency.
- `pr_number`/`pr_url` on `pipeline_item` remain what merge-master already
  declared them: optional metadata, never load-bearing.

## Checks (evidence, not vibes)

`.kanna/config.json` already declares `test` commands. The review stage
runs them in the review worktree today, but the evidence dies in terminal
scrollback. Small, high-leverage addition: the review agent reports check
outcomes in its `complete_stage` / `request_revision` **metadata**
(`checks: [{name, status, detail}]`), and the verdict bar renders them as
chips. No new runner, no CI system — just surfacing evidence the pipeline
already produces next to the verdict it should inform. This is the seam
where policy auto-merge attaches later (phase 3), and where external CI
results could be reported by a user-space agent without engine changes.

## Phasing

**Phase 1 — threads and the round trip** (removes the forge from *review*):
@pierre/diffs annotation spike (gutter widgets inside its shadow DOM is the
one real rendering risk — de-risk first); `review_thread`/`review_comment`
tables + `/v1` endpoints + SSE; thread UI in ⌘D branch scope; verdict bar
firing existing `advance` / `request-revision`; `request-revision` thread
composition; MCP reply/resolve tools; review AGENT.md files findings as
threads. GitHub still merges.

**Phase 2 — merge without the forge** (removes `gh` from the golden path):
merge-master engine primitive (`signal` find-or-create singleton, already
specced) + `merge_record`; git-first default `pr`/`approve`/`merge` agent
definitions; re-anchoring on revision completion; viewed-file tracking.

**Phase 3 — review at fleet scale**: review inbox surfacing awaiting-verdict
tasks with thread/check badges; agent risk annotations (review agent tags
threads `blocking`/`advisory`/`nit`); policy hooks — repo-declared rules
(e.g. "docs-only diffs with green checks auto-approve") issuing the same
verdict actions a human does. This is deliberately last: policy is only
trustworthy once verdicts, threads, and checks have been structured data
for a while.

## Testing expectations

Per the repo's E2E bar, each phase lands with wiring-level coverage:

- server: thread CRUD + revision composition + re-anchoring against real
  git fixtures (`http_api/tests/`, `task_creator/tests/`)
- desktop E2E (mock): open ⌘D → file a thread → request changes →
  assert the `request-revision` payload carries the anchored thread
- desktop E2E (real, later): full round trip with a live agent replying
  via MCP — gated on the harness driving agent completion deterministically
  (same gap already documented for notify)

## Open questions

- Multi-operator: `author` is a free string today (single-operator app).
  When Kanna grows accounts/relay identity, threads inherit it — schema
  reserves the column, nothing else assumes identity.
- Stacked tasks: threads anchor to the task's own branch scope
  (merge-base with `base_ref`), so stacks work naturally, but a thread on
  code a *parent* task authored should arguably route to the parent —
  punt until stacks are common.
- Thread on unchanged context lines (forge supports commenting outside the
  diff): defer; anchor model permits it, UI can add "comment on file" later.
