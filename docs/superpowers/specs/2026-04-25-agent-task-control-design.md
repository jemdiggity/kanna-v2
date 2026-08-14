# Agent Task Control Design

## Summary

Kanna should expose one task-control boundary for agents, scripts, mobile, and future integrations. The boundary lives in `kanna-server`; `kanna-cli` and MCP are clients of that boundary rather than separate implementations.

## Goals

- Let agents complete stages and request revisions without mutating SQLite directly.
- Keep task lifecycle orchestration in Kanna, where worktree, daemon, workflow, and DB rules already live.
- Provide both a CLI surface for shell-based automation and an MCP stdio surface for structured agent tools.
- Add a QA workflow with `in progress -> review -> pr`.

## Architecture

The shape is:

```text
agent
  -> kanna-cli command or MCP tool
    -> kanna-server task-control route
      -> DB / daemon / worktree orchestration
```

`kanna-server` owns product semantics such as advancing stages, closing source tasks, and creating revision tasks. `kanna-cli` is a thin HTTP client. MCP is exposed as `kanna-cli mcp serve` and calls the same HTTP client functions.

## Task-Control Actions

### Complete Stage

`complete_stage` records a stage result and optionally advances the task when the current stage is configured as automatic and the result is successful.

Inputs:

- `task_id`
- `status`: `success` or `failure`
- `summary`
- `metadata`

### Request Revision

`request_revision` closes the current task and creates a new task in an earlier workflow stage, usually `in progress`, based on the reviewed branch.

Inputs:

- `task_id`
- `target_stage`
- `summary`
- `prompt`
- `metadata`

The created task starts from the current task branch, preserving the audit trail instead of mutating the review task in place.

## QA Workflow

Add `.kanna/workflows/qa.json`:

- `in progress`: implementation agent, manual transition
- `review`: QA agent, automatic transition
- `pr`: PR agent, manual transition, does not follow the task

Add `.kanna/agents/review/AGENT.md`. The review agent inspects diffs and tests. It requires sufficient test coverage, including E2E tests when behavior crosses UI, backend, daemon, filesystem, git, persistence, reconnect, or async wiring boundaries. On pass it completes the stage successfully. On fail it requests a revision with concrete findings.

## Non-Goals

- Replacing all desktop Pinia stage orchestration in this slice.
- Building remote authenticated MCP over HTTP.
- Allowing agents to set arbitrary DB fields.

