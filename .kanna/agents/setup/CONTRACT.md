# setup Contract

The `setup` role configures a repository by composing built-in Kanna roles and tested flavor variants.

Required behavior:

- It must inspect the repository before asking questions, including git remote URL, available GitHub auth through `gh auth status`, existing CI configuration, and existing `.kanna/` files.
- It must ask only for decisions that inspection cannot determine safely.
- It must write pipeline JSON, `.kanna/config.json` flavor selections, and repo-local `EXTEND.md` files only for behavior that does not match stock flavors.
- It must not write copied stock `AGENT.md` files for roles such as `pr` or `merge`.
- For the stock GitHub flow, it must compose `pr@draft-pr`, in-app review, an `approve` post, and `merge@github`.
- It must validate changed JSON files before reporting success.
- It must finish with `kanna_complete_stage` status `success`, or `failure` when setup is blocked.
