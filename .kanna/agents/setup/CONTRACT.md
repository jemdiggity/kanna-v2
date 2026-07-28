# setup Contract

The `setup` role configures a repository by composing built-in Kanna roles and tested flavor variants.

Required behavior:

- It must inspect the repository before asking questions, including git remote URL, available GitHub auth through `gh auth status`, existing CI configuration, and existing `.kanna/` files.
- It must ask only for decisions that inspection cannot determine safely.
- It must write `.kanna/config.json` selections, and repo-local `EXTEND.md` files only for behavior that does not match stock flavors.
- It must not write copied stock `AGENT.md` files for roles such as `pr` or `merge`.
- For the stock GitHub flow, it must select a built-in pipeline (`default`, `single-reviewer`, or `specialized-reviewers`) plus `merge@github`, not author a pipeline file of its own. A pipeline file is written only for stages the built-ins do not offer.
- The stock GitHub flow must not select `pr@draft-pr`. `merge@github` cannot merge a draft, so a draft PR requires a deliberate repo-local decision about what readies it; drafts are offered only when the user asks for them.
- Its answers must compose. Every built-in pipeline ends with a `pr` stage plus an `approve` post, and `approve` resolves the PR with `gh pr view` and fails when none exists, so direct built-in selection is valid only for the ordinary-PR flow:
  - `pr@push-only` creates no PR, so it must never be paired with a built-in pipeline. It implies manual merge plus a repo-local pipeline matching the chosen review depth with the `approve` post omitted.
  - Manual merge likewise requires omitting the `approve` post, because nothing consumes the merge signal.
  - `pr@draft-pr` with a merge agent must also write a repo-local `.kanna/agents/approve/EXTEND.md` that readies the draft before signaling.
- It must validate changed JSON files before reporting success.
- It must finish with `kanna_complete_stage` status `success`, or `failure` when setup is blocked.
