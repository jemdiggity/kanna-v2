# Task 9fbdaa96 — repo-scoped task watch must not wake its own caller

Lineage: continues task `aba94572`; work carried over via its WIP snapshot.

## Goal

`kanna-cli task watch --repo-id <repo>` run from inside a task session (as the
task-manager agent definition instructs) wakes that session with its own
`task.runtime_settled` / `task.activity_changed` events forever: each re-arm
turn ends busy → idle, which emits the next wake ~20 s later. The repo scope on
`GET /v1/task-events` includes the caller; only the `parentTaskId` scope
structurally excludes the parent. Fix this as a system change so the CLI watch,
`kanna_wait_events`, and the tool catalog share one explicit, overridable
contract.

## Design decisions

- **Exclusion is a server-side filter, not a scope.** `GET /v1/task-events`
  gains `excludeTaskIds` (comma-separated task ids or branch names). It applies
  to every scope, durable events and synthetic `includeCurrentActivity` rows
  alike, and is forwarded to sibling machines by the aggregate wait. It is not
  part of any cursor, so adding or removing an exclusion never trips the
  "cursor belongs to a different task-event scope" rule.
- **Self-exclusion is client policy, applied once in the shared catalog.**
  `kanna_wait_events` gains `exclude_task_ids` and a client-only `include_self`.
  When `KANNA_TASK_ID` is set and the effective scope is a repository (explicit
  `repo_id`/`repo_remote_url_hash`, or the task-session default), the caller's
  id is added to `exclude_task_ids` unless `include_self: true`. Explicit
  `task_ids` and `parent_task_id` scopes are taken literally (the parent scope
  already excludes the parent). `kanna-mcp` and `kanna-cli tool call` both apply
  this policy through the catalog; the typed `kanna-cli task watch` and
  `task wait-events` commands apply the same rule via `--exclude-task-id` /
  `--include-self`.
- **Repo scope stays the recommended manager watch.** The reporter's
  `--task-id <all-but-self> --budget-secs` workaround is no longer needed; the
  scope-switch cursor rule is documented in the guide for anyone who does move
  scopes.

## Scope

In: server filter + tests; catalog params/policy + tests; typed CLI flags and
default + tests; MCP adapter; `kanna-cli guide`; `docs/kanna-server-boundary.md`;
`.kanna/agents/task-manager/AGENT.md`; dated E2E-gap note.

Out: any change to the debounce timers, to event types, or to the `parentTaskId`
scope semantics; a client-side event filter duplicating the server's.

## Changes to the terms during the work

- The aggregate (account-wide) wait had a latent bug that the new exclusion
  test exposed: a resumed session whose filter changed aborted its inherited
  machine legs and then joined them, surfacing the cancellation as an HTTP 500.
  Fixing it (replace the JoinSet instead of joining aborted legs) was required
  for a changed `excludeTaskIds` on a live cursor to work, so it is in scope
  and covered by the aggregate test. Nothing else outside the listed scope was
  touched.

## Verification

- `cargo test -p kanna-server -p kanna-cli -p kanna-mcp
  -p kanna-tool-catalog`: all green, including the full 1,197-test server suite
  and its integration tests.
- After making the legacy unfiltered event-query wrapper test-only to remove
  the task-created dead-code warning, a second full server run passed every
  task-event test but hit the unrelated load-sensitive
  `advance_stage_route_records_stage_run_for_spawned_next_task` timeout; that
  test passed immediately when rerun in isolation.
- `cargo clippy --tests` on the four crates: no new warnings (pre-existing
  warnings in untouched files remain).
- `cargo fmt --all -- --check`: clean.
- Not E2E-tested; see `docs/2026-09-03-task-watch-self-exclusion-e2e-gap.md`.

## Done when

- A repo-scoped watch from a task session never returns a batch consisting only
  of the caller's own events, unless `--include-self` / `include_self` is set.
- Server, catalog, CLI, and MCP tests pin the contract.
- Guide, boundary doc, and task-manager definition describe the final recipe.
