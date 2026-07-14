# Merge Master

Design notes for reviewing and merging in Kanna without leaving it — and
without coupling the engine to any forge. Builds on the post-stage
transition model in [task-graph-stages.md](./task-graph-stages.md).

## Principles

- **git ≠ gh.** Pull requests are forge artifacts; git is the substrate.
  Everything a merge needs exists forge-free in Kanna's model: the head
  branch (`pipeline_item.branch`, rename-aware via worktree HEAD), the
  target (`base_ref` when stacked, else the repo default branch), and the
  diff (⌘D branch scope). `pr_url` is optional metadata a verdict may
  carry — never load-bearing.
- **Forge behavior lives in user-space.** Agents and pipelines are
  `.kanna/` files the user owns. A gh user's pr agent creates draft PRs and
  their approve post runs `gh pr ready`; another forge means editing agent
  files, not the engine. The engine ships neutral primitives only.
- **The merge master is a long-living singleton, per repo.** One resident
  agent session that receives merge requests over the task-input boundary,
  accumulates context across branches/PRs, watches for semantic conflicts
  between them (the analysis the merge AGENT.md already describes, made
  continuous instead of one-shot), and merges in a safe order — later in a
  batch, or immediately when asked. The suspend/kill preferences are
  currently vestigial (nothing consumes them), so residency is safe;
  durable notes (e.g. a merge journal in the repo) are optional hardening
  for machine restarts, not a requirement.

## Flow

1. Task walks the pipeline to `pr` (manual). The pr agent published the
   branch per the user's forge convention (draft PR, or plain push) and
   reported `pr_url` metadata if one exists.
2. Human reviews **in Kanna**: ⌘D branch diff. Verdicts are stage actions:
   - request changes → `request-revision` with feedback (exists);
   - approve → ⌘S, which dispatches the pr stage's **approve post** into
     the live session: flip the PR ready if the user's convention says so,
     then signal the merge master with a structured request
     (`MERGE <branch> → <target> [PR <url>]: <summary>`). Post success at
     the final stage closes the task (already works in the engine).
3. The merge master folds the request into its picture, merges when safe
   (git-first; `gh` only when a PR URL was provided), and reports risks.

## Engine work (the only new primitives)

- **Find-or-create-and-signal a singleton agent task**: e.g.
  `POST /v1/repos/{id}/agents/{agent}/signal` — deliver input to the open
  task running `{agent}` in the repo, creating it (pinned, message as
  first prompt) when absent. The approve post addresses "the merge master"
  without knowing a task id; the engine owns singleton existence.
- Later: a verdict UI on tasks parked at `pr` (request-changes composer →
  request-revision; approve button → advance). Forge-blind — it fires
  stage actions. Line-anchored diff feedback is a follow-up (needs an
  @pierre/diffs annotation spike) — now specced in
  [native-review.md](./native-review.md).

## User-space work (reference implementations, all `.kanna/` files)

- pr AGENT.md: create draft PRs (gh flavor); report `pr_url` metadata.
- pr stage `post: approve` in the default/qa pipelines: ready-the-PR +
  signal the merge master.
- merge AGENT.md rewritten git-first: resolve target from runtime
  context/`base_ref`/`origin/HEAD`; detect stacks from branch topology
  (merge-bases), not PR descriptions; treat `gh` as enrichment when a PR
  URL is present; keep the semantic-conflict analysis and safe ordering.

## Open questions

- Signal payload shape: free text typed into the session (matches the
  notify boundary) vs a structured queue the master polls. Start with
  typed text — it is the existing boundary and survives agent swaps.
- ~~Whether the default pipeline ships the approve post or it stays an
  opt-in example. Default-off until the singleton endpoint exists.~~
  Resolved: the singleton signal endpoint
  (`POST /v1/repos/{repo_id}/agents/{agent}/signal`) exists, and both the
  default and qa pipelines ship the approve post on their pr stage.
  Approval UI derives merge behavior from the task's pinned
  `pipeline_def`, so pre-change snapshots and custom pipelines without
  the post keep a plain approve that only advances.
- Merge master crash recovery: resume via the persisted resume-session id
  vs re-reading a durable journal. Journal preferred if residency ever
  becomes flaky.
