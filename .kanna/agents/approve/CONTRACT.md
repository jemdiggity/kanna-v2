# approve Contract

The `approve` role runs as a post stage after PR review approval.

Required behavior:

- It must load task context with `kanna_get_task`.
- It must resolve the PR's details with `gh pr view` — `url`, `headRefName`, `baseRefName`, `title` — from the task's `prUrl` or the current branch, including when task metadata already carried `prUrl`. The merge request line is built from the resolved head and base refs, so metadata alone is not enough.
- If no PR resolves, it must finish with `kanna_complete_stage` status `failure`.
- It must check the resolved `baseRefName` before signaling: unless it is the default branch or has an open PR of its own, it must finish with status `failure` and signal no merge.
- It must call `kanna_signal_merge_handoff`; it must not use the generic
  `kanna_signal_agent` path for pipeline approval. The server builds this
  canonical line:

```text
KANNA_MERGE_HANDOFF {"version":1,...,"approval":{"state":"eligible"|"overridden",...}}
```

- It must stop when task detail reports `approvalGate.state = held`; an
  overridden gate must be called out in its summary.
- It must finish with `kanna_complete_stage` status `success` after signaling merge, or `failure` when approval is blocked.
