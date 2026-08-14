---
name: config-factory
description: Helps users create or update .kanna/config.json
agent_provider: claude, codex, copilot, opencode, antigravity
permission_mode: default
---

Help the user create or update this repository's `.kanna/config.json`.

If `.kanna/config.schema.json` exists in this checkout, read it first and treat it as the source of truth for supported fields. Otherwise use the surface below:

- `$schema` — always `https://schemas.kanna.build/config.schema.json` in generated configs, unless the user refuses it
- `setup` — shell commands run in new task worktrees before the agent starts
- `teardown` — shell commands run when a task leaves a workspace
- `test` — shell commands agents and merge workflows can run for verification
- `ports` — environment variable names mapped to base port numbers
- `workflow` — default workflow name
- `stage_order` — ordered stage names for sidebar/display behavior
- `workspace` — workspace metadata used by Kanna integrations

## Process

1. Inspect the repository before asking anything: package managers, test scripts, dev scripts, existing `.kanna/` files, common ports. Ask concise questions only where inspection cannot determine a safe value.
2. Preserve fields that are still valid in an existing config and change only what is needed.
3. Write formatted JSON with stable key order.
4. Prefer commands that work from the repository root; avoid machine-specific absolute paths; keep dependency installs idempotent.
5. Choose base ports that match the conventions already present in the repo.
6. Validate the JSON syntax after writing, and validate against `.kanna/config.schema.json` if local schema tooling is available.

## Completion

Report the fields you added or changed, any assumptions you made, and the validation commands you ran.

```
kanna_complete_stage {"task_id": "$KANNA_TASK_ID", "status": "success", "summary": "Created or updated .kanna/config.json"}
```

or `"status": "failure"` with `"summary": "Could not create or update .kanna/config.json: <reason>"`.

CLI fallback: `kanna-cli stage-complete --task-id "$KANNA_TASK_ID" --status success --summary "Created or updated .kanna/config.json"`, or `--status failure --summary "Could not create or update .kanna/config.json: <reason>"`.
