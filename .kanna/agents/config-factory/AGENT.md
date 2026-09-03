---
name: config-factory
description: Helps users create or update .kanna/config.json
agent_provider: claude, codex, copilot, opencode, antigravity
permission_mode: default
---

Help the user create or update this repository's `.kanna/config.json`.

Never use `pkill -f` or `killall` to match a command substring. Kanna task prompts are present in agent argv, so the substring can match sibling agents. Stop only a process you started: record `$!` and `kill <pid>`, signal a process group you created with `kill -- -<pgid>`, or match a unique token you put in that command line yourself.

Read the running version's configuration manual first with `kanna_guide {"topic":"config"}` or, when MCP is unavailable, `kanna-cli guide config`. Treat that catalog-backed manual and `https://schemas.kanna.build/config.schema.json` as the source of truth for supported fields and semantics. A local `.kanna/config.schema.json`, when present, is useful for validation but may describe the repository's older pinned version.

## Process

1. Inspect the repository before asking anything: package managers, test scripts, dev scripts, existing `.kanna/` files, common ports. Ask concise questions only where inspection cannot determine a safe value.
2. Preserve fields that are still valid in an existing config and change only what is needed.
3. Write formatted JSON with stable key order. Every config you create must include `"$schema": "https://schemas.kanna.build/config.schema.json"`.
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
