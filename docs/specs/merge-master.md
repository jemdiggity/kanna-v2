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
   reported `pr_url` metadata if one exists.
2. Human reviews **in Kanna**: ⌘D branch diff. Verdicts are stage actions:
   - request changes → `request-revision` with feedback (exists);
   - approve → ⌘S, which first checks the server-owned approval-lineage gate
     and dispatches the pr stage's **approve post** only when the lineage is
     eligible or has a recorded human override. The post signals through the
     gated merge-handoff route; the server emits canonical
     `KANNA_MERGE_HANDOFF` JSON with the approval state. Post success at the
     final stage closes the task.
3. The merge master folds the request into its picture, merges when safe
   (git-first; `gh` only when a PR URL was provided), and reports risks.

## Engine primitives

- **Find-or-create-and-signal a singleton agent task**: e.g.
  `POST /v1/repos/{id}/agents/{agent}/signal` — deliver input to the open
  task running `{agent}` in the repo, creating it (pinned, message as
  first prompt) when absent. The approve post addresses "the merge master"
  without knowing a task id; the engine owns singleton existence.
- **Durable approval lineage**: failed/needs-human/not-merge-candidate results
  create holds. Only a later explicit successful main result in the same stage
  resolves them; posts and unrelated later stages do not. Task detail exposes
  the projection as `approvalGate`.
- **Explicit human override**:
  `POST /v1/tasks/{task_id}/actions/override-approval` requires an authenticated
  native desktop process channel, paired device, or authenticated relay user
  and a reason, and records the available actor, channel, and time. The native
  channel pins and rechecks process identity over a private Unix socket;
  loopback/KSP traffic and reusable desktop secrets are not authority. Ordinary
  advance requests and agent tools cannot claim it.
- **Gated merge handoff**:
  `POST /v1/tasks/{task_id}/actions/signal-merge-handoff` rechecks the gate and
  requires an active authorized approve post, binds the handoff to that task's
  repo/branch/target/PR, and creates the machine-readable singleton message.
  It refuses unresolved holds and includes the complete override record when
  one exists. Surviving pre-upgrade approve and merge sessions use a
  server-validated eligible-only legacy envelope; overrides require a
  protocol-v1 merge session. Capability, reservation, acknowledgement, and
  durable delivery all bind to the same task/session; pre-acknowledgement
  failures remain retryable and post-acknowledgement uncertainty is held.
- Later: a verdict UI on tasks parked at `pr` (request-changes composer →
  request-revision; approve button → advance). Forge-blind — it fires
  stage actions. Line-anchored diff feedback is a follow-up (needs an
  @pierre/diffs annotation spike) — now specced in
  [native-review.md](./native-review.md).

## User-space work (reference implementations, all `.kanna/` files)

- pr AGENT.md: create the PR (draft only via the opt-in `pr@draft-pr`
  flavor); report `pr_url` metadata.
- pr stage `post: approve` in the built-in pipelines (all three ship it):
  signal the merge master.
- merge AGENT.md rewritten git-first: resolve target from runtime
  context/`base_ref`/`origin/HEAD`; detect stacks from branch topology
  (merge-bases), not PR descriptions; treat `gh` as enrichment when a PR
  URL is present; keep the semantic-conflict analysis and safe ordering.

## Resolved contract choices

- Signal payload shape is a server-built typed line over the existing session
  input boundary: `KANNA_MERGE_HANDOFF {json}`. The JSON is canonical and
  contains server-owned approval state, while delivery retains the mature
  singleton/session lifecycle.
- Generic task input, MCP input, and KSP stream steering are never canonical
  merge authority. Only the server handoff above or an independently
  provenance-authenticated native operator terminal action may release a hold.
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
