# pr Contract

The `pr` role publishes a completed task branch.

Required behavior:

- It must verify that task-related changes are committed before publishing.
- It must verify, before creating a PR, that the base ref is still a live path to the default branch — the default branch itself, or a branch carried by an open PR of its own. For a dead-end base it must either retarget to the default branch without absorbing the base's commits, or publish nothing and finish with `failure` so a human picks the target.
- It must not open a second pull request when an open PR already covers this work, including on a branch name the rename step has since replaced. It must update that PR instead and report its URL.
- If it creates a pull request, it must finish with `kanna_complete_stage` status `success` and include `metadata.pr_url` with the full PR URL. The summary must also include the URL.
- If the selected flavor publishes only a branch and no PR exists, it must finish with `kanna_complete_stage` status `success` and must not report `metadata.pr_url`.
- If publishing fails, it must finish with `kanna_complete_stage` status `failure` and a concise reason.

Runtime variables:

- `$SOURCE_WORKTREE` points at the previous stage worktree for cleanliness checks.
- `$BASE_REF` is the target base ref and remains a runtime prompt variable.

Flavor notes:

- `pr@draft-pr` creates a draft GitHub PR. A draft lands through the same target once readied, so it owes the same base-ref and existing-PR checks as the default flavor; when it reuses a PR it must leave that PR's draft state alone.
- `pr@push-only` pushes the branch and intentionally creates no PR.
