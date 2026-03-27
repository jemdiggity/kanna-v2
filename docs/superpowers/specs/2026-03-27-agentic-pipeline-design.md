# Agentic Pipeline Design

## Overview

Replace Kanna's hardcoded tag-based workflow with a generic, user-definable agentic pipeline system. Agents become first-class file-based definitions, pipelines become JSON configuration, and a pipeline engine orchestrates task progression through stages.

## Terminology

| Term | Definition |
|------|-----------|
| **Agentic Pipeline** | A JSON file defining an ordered sequence of stages with transition rules. The overall process that orchestrates agent work. |
| **Stage** | A step in an agentic pipeline with an agent, an environment, and a transition type (manual/auto). |
| **Agent** | A markdown file defining a role: name, description, allowed tools, instructions. |
| **Environment** | A reusable definition of setup/teardown scripts referenced by stages. |
| **Task** | A unit of work (`pipeline_item`) that flows through an agentic pipeline. |
| **Stage-complete signal** | A CLI call made by an agent to signal it has finished its stage work. |

Key separation from the current model: **stage != tag**. Stages represent where a task is in the pipeline. Tags (deferred to future work) are user-defined metadata labels for categorization.

## Pipeline Model

A pipeline is an ordered list of stages that a task goes through. Each stage has an agent and an environment. Every task runs in its own worktree. Pipelines are independent — they do not chain into each other.

Cross-pipeline coordination (e.g., a merge agent that processes PRs from multiple tasks) is handled by the agent itself, not by pipeline orchestration. The merge agent's AGENT.md instructs it to scan for PRs; it discovers its own work rather than receiving tasks from another pipeline.

## File Structure

Built-in (ships with Kanna source) and user-defined (per-repo) share the same layout:

```
.kanna/
  agents/
    implement/
      AGENT.md
    pr/
      AGENT.md
    merge/
      AGENT.md
    agent-factory/
      AGENT.md
    pipeline-factory/
      AGENT.md
  pipelines/
    default.json
  config.json
  tasks/
```

Built-in definitions ship with the app. User-defined definitions live in the repo's `.kanna/` directory and are git-trackable and team-shareable.

Resolution order: user-defined overrides built-in if the same name.

## Agent Definition Format (AGENT.md)

Each agent is a directory with an `AGENT.md` entry point. The directory can contain additional files the agent needs (skills, scripts, data, templates).

```markdown
---
name: implement
description: Coding agent that implements tasks from a prompt
agent_provider: claude, copilot
model: sonnet
permission_mode: default
allowed_tools: []
---

You are a coding agent working in a git worktree. Your job is to implement
the task described in the prompt.

## Rules
- Work in the current directory (it's already the worktree)
- Commit your work with clear commit messages
- Run tests if a test command is configured

## Completion
When you are done, run:
kanna-cli stage-complete --task-id $KANNA_TASK_ID --status success --summary "what you did"

If you cannot complete the task:
kanna-cli stage-complete --task-id $KANNA_TASK_ID --status failure --summary "what went wrong"
```

### AGENT.md Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Agent identifier |
| `description` | string | yes | What this agent does |
| `agent_provider` | string or list | no | Compatible providers (`claude`, `copilot`, or both). Falls back to user default. Maps to the existing `agent_provider` field in `PtySpawnOptions` and the DB. |
| `model` | string | no | Model override. Falls back to provider default. |
| `permission_mode` | string | no | `default`, `acceptEdits`, `dontAsk`. Falls back to `default`. |
| `allowed_tools` | list | no | Tool allowlist (provider-specific). Empty = provider defaults. |

## Pipeline JSON Schema

```json
{
  "name": "default",
  "description": "Standard in progress -> PR flow",
  "environments": {
    "worktree": {
      "setup": ["bun install"],
      "teardown": ["bun test"]
    }
  },
  "stages": [
    {
      "name": "in progress",
      "description": "Agent implements the task",
      "agent": "implement",
      "environment": "worktree",
      "transition": "manual"
    },
    {
      "name": "pr",
      "description": "Agent creates a GitHub PR",
      "agent": "pr",
      "environment": "worktree",
      "transition": "manual"
    }
  ]
}
```

### Stage Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Stage identifier, unique within pipeline |
| `description` | string | no | Human-readable description |
| `agent` | string | no | Agent directory name (resolves to `.kanna/agents/{name}/AGENT.md`). Null for gate stages (no agent spawns, just waits). |
| `agent_provider` | string | no | Override agent provider for this stage (`claude`, `copilot`) |
| `environment` | string | no | Environment name for setup/teardown. Null = no setup/teardown. |
| `transition` | `"manual"` or `"auto"` | yes | How the task advances to the next stage |

### Pipeline-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Pipeline identifier |
| `description` | string | no | Human-readable description |
| `environments` | object | no | Named environment definitions with `setup` and `teardown` script arrays |
| `stages` | array | yes | Ordered list of stages |

## Signal CLI: kanna-cli

New sidecar binary that ships alongside the daemon. Available in the agent's PATH when spawned.

`kanna-cli` is not a replacement for the removed `kanna-hook`. `kanna-hook` reported lifecycle events (Stop, PostToolUse) to the daemon. `kanna-cli` is for explicit stage completion signaling from agents to the Tauri app — a different purpose and a different transport.

### Usage

```bash
kanna-cli stage-complete --task-id <id> --status success --summary "Created PR" --metadata '{"pr_url": "..."}'
kanna-cli stage-complete --task-id <id> --status failure --summary "Tests failed"
```

### Behavior

1. Writes stage result to SQLite DB (`stage_result` column on `pipeline_item`)
2. Reads `KANNA_SOCKET_PATH` env var to find the app socket
3. Connects to the Unix socket
4. Sends `{"type": "stage_complete", "task_id": "<id>"}`
5. Disconnects

### Stage-Complete Data Schema

```json
{
  "status": "success | failure",
  "summary": "Human-readable description",
  "metadata": {}
}
```

`metadata` is free-form. Agents can pass data to the next stage (e.g., `pr_url`, `test_results`). The pipeline engine makes this available to the next stage's agent via environment variables or prompt injection.

### Environment Variables Passed to Agents

| Variable | Description |
|----------|-------------|
| `KANNA_TASK_ID` | Task ID for the `kanna-cli` call |
| `KANNA_SOCKET_PATH` | Path to the app's Unix socket (respects worktree isolation) |
| `KANNA_DB_PATH` | Path to the SQLite DB file |

These are set when the agent is spawned. The socket and DB paths vary depending on whether the app is running as the main instance or in a worktree, ensuring worktree isolation.

## App Socket: kanna.sock

Tauri backend listens on a Unix socket. The path follows the existing worktree isolation convention:
- Main instance: `~/Library/Application Support/Kanna/kanna.sock`
- Worktree instance: `{worktree}/.kanna-daemon/kanna.sock`

The `KANNA_SOCKET_PATH` env var is passed to agents so `kanna-cli` can find the correct socket.

Responsibilities:
- Receives stage-complete pings from `kanna-cli`
- Reads stage result from DB
- Runs pipeline engine logic (teardown, blocker check, advance)
- Emits Tauri event to frontend for UI update

This listener lives in `lib.rs` alongside the existing daemon event bridge.

## Database Changes

### Modified table: pipeline_item

| Change | Column | Type | Description |
|--------|--------|------|-------------|
| Add | `pipeline` | TEXT NOT NULL DEFAULT 'default' | Pipeline name |
| Repurpose | `stage` | TEXT NOT NULL DEFAULT 'in progress' | Current stage name (was legacy/unused) |
| Add | `stage_result` | TEXT | JSON from last stage-complete signal |
| Deprecate | `tags` | TEXT | No longer used for stages. Keep column, drop later. |

### Migration

1. Add `pipeline` column with default `'default'`
2. Map existing tag-based state to stage names:
   - `in progress` tag -> stage `in progress`
   - `pr` tag -> stage `pr`
   - `merge` tag -> stage `merge`
   - `done` tag -> `closed_at` already set, no stage needed
   - `blocked` -> stays as blocker system, not a stage
   - `teardown` tag -> treat as `done` (teardown was a transient in-flight state during task close, not a real stage)
3. Add `stage_result` column
4. `tags` column left in place, ignored. Clean up in future migration.

No new tables. Pipelines and agents are files, not DB rows. The DB only tracks task state.

### Teardown clarification

Two distinct teardown concepts exist:
- **Task-close teardown:** repo-level `.kanna/config.json` `teardown` scripts that run when a task is closed (Cmd+Delete). This stays as-is — it's about cleaning up the worktree, not about pipeline stages.
- **Stage environment teardown:** scripts defined in a pipeline environment that run when a task exits a stage. This is new.

These are independent. Task-close teardown runs regardless of pipeline state. Stage environment teardown runs on stage transitions.

## Pipeline Engine

The pipeline engine is a function in the Kanna store. It runs when:
- A `stage_complete` ping arrives via `kanna.sock`
- User manually advances a stage
- A blocker resolves (existing `checkUnblocked` logic)

### Core function: advanceStage(taskId)

1. Read task's current pipeline and stage from DB
2. Load pipeline JSON definition from disk. If file is missing: freeze task in current stage, toast "Pipeline definition not found", abort.
3. Find current stage, get its environment
4. Run environment teardown scripts (if any) in the task's worktree directory, using the system shell, with all `KANNA_*` env vars forwarded
5. If teardown fails: stay in current stage, notify user. User can force-advance via a "Skip Teardown" action.
6. Find next stage in the pipeline
7. If no next stage: task stays in final stage until user closes it
8. Check blockers: if blocked, stop and wait
9. Update DB: set task's `stage` to next stage, clear `stage_result`
10. Get next stage's environment
11. Run environment setup scripts (if any) in the task's worktree directory, using the system shell, with all `KANNA_*` env vars forwarded
12. If setup fails: stay in new stage but don't spawn agent, notify user
13. Spawn next stage's agent in the worktree
14. Emit event to frontend to update sidebar/header

### Manual advance

Same flow starting at step 2. User is saying "I'm done with this stage, move on."

### Re-run current stage

User action: "Re-run Stage." Runs environment setup again and re-spawns the current stage's agent. Does not advance. Used after a failure to retry.

### Auto advance

Same flow, triggered by stage-complete signal. Only proceeds if `transition: "auto"` on the current stage.

### Blocker handling

Auto-transitions always check blockers before advancing. If blocked, the task waits. When blockers resolve, if the current stage has `transition: "auto"`, the engine auto-advances.

### Error handling

- Pipeline definition missing: task freezes in current stage, toast notification
- Setup/teardown script failures: task stays put, toast notification. User can "Skip" or "Re-run".
- Agent spawn failures: task stays in stage, toast notification
- Stage-complete with `status: "failure"`: task stays in current stage. User can "Re-run Stage" or "Force Advance".

## Sidebar Changes

### Grouping

Currently: pinned -> merge -> pr -> active -> blocked

New: pinned -> grouped by stage in pipeline order -> blocked

Stage sections are dynamic, derived from each task's pipeline definition. If a repo has tasks in multiple pipelines, stages from all active pipelines are shown, ordered by pipeline then stage order. Empty stages are hidden.

### Stage Advancement

Single generic shortcut replaces Cmd+S and Cmd+Shift+M. Label is contextual: shows "Advance to PR" or "Advance to Merge" based on current stage.

## Task Creation Changes

Cmd+Shift+N opens `NewTaskModal` with:
- **Prompt** (existing)
- **Pipeline** selector (dropdown, defaults to repo's default pipeline from `.kanna/config.json`)

The first stage's agent is used automatically. The pipeline defines the agent, not the user. The selected pipeline name is stored in the `pipeline` column of the new `pipeline_item` row on insert.

### Repo config addition

```json
{
  "pipeline": "default",
  "setup": [...],
  "ports": {...}
}
```

## Factory Agents

Two built-in agents for creating new agents and pipelines:

- **agent-factory**: user describes a role, agent writes `.kanna/agents/{name}/AGENT.md`
- **pipeline-factory**: user describes a flow, agent writes `.kanna/pipelines/{name}.json`

Factory agents are regular task agents. They go through the full pipeline (worktree, PR, merge) because their output is code changes to the repo. They use the repo's configured default pipeline like any other task.

Accessible via command palette as shortcuts: "Create Agent" and "Create Pipeline" pre-configure a task with the factory agent selected.

## What Gets Removed

- `TagBadges.vue` component
- Hardcoded `tagColors` and `tagLabels` maps
- `SYSTEM_TAGS` constant in `packages/core/src/pipeline/types.ts`
- `startPrAgent` and `startMergeAgent` hardcoded functions in `kanna.ts`
- `hasTag`/`parseTags` utilities (no longer needed for stage logic)

## What Stays Unchanged

- Blocker system (`task_blocker` table, `BlockerSelectModal`)
- Activity states (`working`, `unread`, `idle`)
- Pinning
- Daemon (PTY management, fd handoff)
- Terminal UI (xterm.js)
- Diff viewer
- All existing keyboard shortcuts except Cmd+S and Cmd+Shift+M which become generic "advance stage"

## Default Pipeline (Matches Current Behavior)

The built-in default pipeline replicates today's hardcoded flow with all manual transitions:

```json
{
  "name": "default",
  "description": "Standard in progress -> PR flow",
  "stages": [
    {
      "name": "in progress",
      "agent": "implement",
      "transition": "manual"
    },
    {
      "name": "pr",
      "agent": "pr",
      "transition": "manual"
    }
  ]
}
```

The merge/shipping agent is a separate task the user creates independently. Its AGENT.md instructs it to scan for PRs and merge them. It is not part of this pipeline — it runs its own pipeline (which could be a single-stage pipeline with just an "in progress" stage).

Users can copy and modify the default pipeline to create their own with custom stages, agents, environments, and auto transitions.
