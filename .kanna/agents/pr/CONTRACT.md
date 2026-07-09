# pr Contract

The `pr` role publishes a completed task branch.

Required behavior:

- It must verify that task-related changes are committed before publishing.
- If it creates a pull request, it must finish with `kanna_complete_stage` status `success` and include `metadata.pr_url` with the full PR URL. The summary must also include the URL.
- If the selected flavor publishes only a branch and no PR exists, it must finish with `kanna_complete_stage` status `success` and must not report `metadata.pr_url`.
- If publishing fails, it must finish with `kanna_complete_stage` status `failure` and a concise reason.

Runtime variables:

- `$SOURCE_WORKTREE` points at the previous stage worktree for cleanliness checks.
- `$BASE_REF` is the target base ref and remains a runtime prompt variable.

Flavor notes:

- `pr@draft-pr` creates a draft GitHub PR.
- `pr@push-only` pushes the branch and intentionally creates no PR.
