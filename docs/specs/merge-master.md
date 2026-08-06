# Merge Master

Design notes for reviewing and merging in Kanna without leaving it — and
without coupling the engine to any forge. Builds on the post-stage
transition model in [task-graph-stages.md](./task-graph-stages.md).

## Principles

- **git ≠ gh.** Pull requests are forge artifacts; git is the substrate.
  Workspace lifecycle continues to use `pipeline_item.branch`, while a
  successful PR stage records `pr_url` for the next stage. The engine remains
  forge-neutral: the user-space agents resolve the live PR details when needed.
- **Forge behavior lives in user-space.** Agents and pipelines are
  `.kanna/` files the user owns. The stock flow opens an ordinary PR; a repo
  that opts into `pr@draft-pr` also owns what readies the draft before the
  merge master sees it — `gh pr ready` on approval belongs in
  `.kanna/agents/approve/EXTEND.md`. Another forge means editing agent
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
   reported the final `pr_url` after any reuse or retargeting.
2. Human reviews **in Kanna**: ⌘D branch diff. Verdicts are stage actions:
   - request changes → `request-revision` with feedback (exists);
   - approve → ⌘S, which dispatches the pr stage's **approve post**. The post
     resolves the live PR and signals the merge master through the dedicated
     handoff route. Post success at the final stage closes the task.
3. The merge master folds the request into its picture, merges when safe
   (git-first; `gh` only when a PR URL was provided), and reports risks.

## Engine primitives

- **Find-or-create-and-signal a singleton agent task**: e.g.
  `POST /v1/repos/{id}/agents/{agent}/signal` — deliver input to the open
  task running `{agent}` in the repo, creating it (pinned, message as
  first prompt) when absent. The approve post addresses "the merge master"
  without knowing a task id; the engine owns singleton existence.
- **Explicit merge handoff**:
  `POST /v1/tasks/{task_id}/actions/signal-merge-handoff` resolves the task's
  repository and uses the ordinary singleton signal path to send the supplied
  task, PR, head, base, and summary. It does not interpret stage results,
  compare branch names with saved metadata, or attest approval eligibility.
- Later: a verdict UI on tasks parked at `pr` (request-changes composer →
  request-revision; approve button → advance). Forge-blind — it fires
  stage actions. Line-anchored diff feedback is a follow-up (needs an
  @pierre/diffs annotation spike) — now specced in
  [native-review.md](./native-review.md).

## User-space work (reference implementations, all `.kanna/` files)

- pr AGENT.md: create or reuse the PR (draft only via the opt-in `pr@draft-pr`
  flavor); report the final `pr_url` metadata.
- pr stage `post: approve` in the built-in pipelines (all three ship it):
  signal the merge master.
- merge AGENT.md rewritten git-first: resolve target from runtime
  context/`base_ref`/`origin/HEAD`; detect stacks from branch topology
  (merge-bases), not PR descriptions; treat `gh` as enrichment when a PR
  URL is present; keep the semantic-conflict analysis and safe ordering.

## Resolved contract choices

- Approval posts send the ordinary compact line
  `MERGE <head> -> <base> [TASK <task-id>] [PR <url>]: <summary>` over the same
  singleton/session input boundary as other requests. There is no server
  approval marker or privileged merge transport.
- Generic task input, MCP input, KSP/relay steering, and approval posts all
  deliver policy requests for the resolved repo merge agent to accept or
  decline.
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
