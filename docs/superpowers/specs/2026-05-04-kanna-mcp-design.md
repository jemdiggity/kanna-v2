# Kanna MCP Design

Date: 2026-05-04
Status: Proposed
Scope: Add a standalone `kanna-mcp` sidecar that exposes Kanna task-control tools to local MCP clients through the running desktop-backed `kanna-server` API.

## Summary

Kanna should add a dedicated `kanna-mcp` binary for MCP clients.
The binary should be a short-lived, stdio MCP server launched by the MCP client, not another long-running Kanna daemon.

The product boundary should be:

`MCP client -> kanna-mcp stdio server -> local kanna-server HTTP API -> daemon / DB / task creator`

`kanna-mcp` should act like `kanna-cli`: it is a client of the running desktop-backed `kanna-server`.
It must not open Kanna's SQLite database directly, connect to the daemon socket, run arbitrary shell commands, or duplicate product behavior that belongs behind `kanna-server`.
If a tool needs a capability that the local HTTP API does not yet expose, the implementation should add the product-level route to `kanna-server` first and then call it from `kanna-mcp`.

## Goals

- Add a standalone `crates/kanna-mcp` Rust crate and `kanna-mcp` binary.
- Serve MCP over stdio using newline-delimited JSON-RPC.
- Resolve the Kanna server base URL from `--server-url`, then `KANNA_SERVER_BASE_URL`, then `http://127.0.0.1:48120`.
- Expose product-level Kanna task tools backed by `kanna-server` HTTP routes.
- Keep `kanna-server` as the long-running process that owns local state, daemon coordination, and task execution.
- Integrate `kanna-mcp` into local builds and release sidecar staging without making packaged binaries read from shared Rust target output directly.

## Non-Goals

- Running `kanna-mcp` as a background service.
- Replacing `kanna-server` or moving task-control ownership into MCP.
- Exposing raw SQL, raw daemon protocol commands, arbitrary shell execution, or filesystem access.
- Adding cloud or relay-backed MCP access in the first pass.
- Implementing terminal streaming over MCP resources in the first pass.
- Building a graphical configuration UI for MCP clients.

## Current Context

`kanna-server` already exposes a local product API on port `48120`.
Mobile and newer `kanna-cli` commands use this API for repo listing, task creation, task mutation, terminal input, and stage actions.

Before this design is implemented, `kanna-cli` contains a small MCP serve implementation.
That implementation proves the basic stdio MCP loop and some task-control mappings, but MCP should not remain a subcommand of the general CLI.
`kanna-cli` is primarily a command-line tool and stage-completion helper.
`kanna-mcp` should be the dedicated MCP server binary with clearer packaging, naming, and client configuration.

## Architecture

### Binary Boundary

Add a new crate:

`crates/kanna-mcp`

The binary should:

- parse `serve` options, including `--server-url`
- run a stdio JSON-RPC loop
- advertise MCP tool capabilities during `initialize`
- return the supported tools from `tools/list`
- call the corresponding `kanna-server` HTTP route from `tools/call`
- render tool results as MCP text content containing formatted JSON

The crate can reuse code from `kanna-cli` by extracting shared HTTP client and MCP helper modules if that keeps duplication low.
If extraction is more disruptive than useful, copy the small existing MCP implementation into `kanna-mcp` first and leave a follow-up to remove duplication.
The important boundary is behavior: `kanna-mcp` must call `kanna-server`, not Kanna internals.

### Server URL Resolution

Use the same precedence as `kanna-cli`:

1. explicit `--server-url`
2. `KANNA_SERVER_BASE_URL`
3. `http://127.0.0.1:48120`

The error path should make it clear when the local Kanna server is unreachable.
The MCP process should not try to launch `kanna-server`; the desktop app startup path owns that process.

### Tool Naming

Use `kanna_`-prefixed tool names to avoid collisions in MCP clients:

- `kanna_list_repos`
- `kanna_list_recent_tasks`
- `kanna_search_tasks`
- `kanna_list_repo_tasks`
- `kanna_create_task`
- `kanna_send_task_input`
- `kanna_close_task`
- `kanna_advance_stage`
- `kanna_complete_stage`
- `kanna_request_revision`

The old unprefixed CLI MCP tool names should not be the long-term public contract.
If compatibility is kept temporarily, it should be clearly treated as legacy.

## Tool Contract

### `kanna_list_repos`

Input: none.

Calls `GET /v1/repos`.

Returns repo summaries.

### `kanna_list_recent_tasks`

Input: none.

Calls `GET /v1/tasks/recent`.

Returns recent open task summaries.

### `kanna_search_tasks`

Input:

- `query` string

Calls `GET /v1/tasks/search?query=...`.

Returns matching task summaries.

### `kanna_list_repo_tasks`

Input:

- `repo_id` string

Calls `GET /v1/repos/{repo_id}/tasks`.

Returns task summaries for the repo.

### `kanna_create_task`

Input:

- `repo_id` string
- `prompt` string
- optional `workflow_name` string
- optional `base_ref` string
- optional `stage` string
- optional `agent_provider` string
- optional `model` string
- optional `permission_mode` string
- optional `allowed_tools` string array

Calls `POST /v1/tasks`.

Returns the created task response.

### `kanna_send_task_input`

Input:

- `task_id` string
- `input` string

Calls `POST /v1/tasks/{task_id}/input`.

Returns a simple success object.

### `kanna_close_task`

Input:

- `task_id` string

Calls `POST /v1/tasks/{task_id}/actions/close`.

Returns a simple success object.

### `kanna_advance_stage`

Input:

- `task_id` string

Calls `POST /v1/tasks/{task_id}/actions/advance-stage`.

Returns the resulting task action response.

### `kanna_complete_stage`

Input:

- `task_id` string
- `status` string, either `success` or `failure`
- `summary` string
- optional `metadata` object

Calls `POST /v1/tasks/{task_id}/actions/complete-stage`.

Returns the resulting task action response.

### `kanna_request_revision`

Input:

- `task_id` string
- `summary` string
- `prompt` string
- optional `target_stage` string, defaulting to `in progress`
- optional `metadata` object

Calls `POST /v1/tasks/{task_id}/actions/request-revision`.

Returns the resulting task action response.

## Error Handling

Argument validation errors should return JSON-RPC invalid-params errors.
Unknown tools should return JSON-RPC method/tool errors.
HTTP failures should return JSON-RPC internal errors with a concise message that includes the failed route and status when available.

Tool handlers should not panic on malformed `arguments`.
Missing required fields, wrong primitive types, and invalid enum values should produce structured MCP errors.

`kanna-mcp` should write protocol responses only to stdout.
Diagnostics should go to stderr so MCP clients can parse stdout reliably.

## Packaging

`kanna-mcp` should be staged as a sidecar alongside existing desktop sidecars.
The build workflow should preserve shared Rust intermediates where possible while keeping final sidecar binaries and staged Tauri `externalBin` inputs private to the current build.

Expected integration points:

- root `package.json` sidecar build script
- `scripts/stage-sidecars.sh`
- `apps/desktop/src/sidecars.test.ts`
- Bazel build/release targets if sidecar coverage is already maintained there
- relevant lockfiles generated by the repo's existing Rust workflow

## Testing

Add focused Rust tests for `crates/kanna-mcp`:

- server URL resolution precedence
- tool list schema includes every supported `kanna_` tool
- required and optional argument validation
- MCP `initialize`, `tools/list`, and `tools/call` response shape
- HTTP route mapping for each tool using a local mock router or lightweight test server
- stdout response behavior for notifications and normal requests

Add or update packaging tests that assert `kanna-mcp` is built and staged with the other sidecars.

Add a focused stdio/HTTP integration test harness that launches `kanna-mcp serve`, sends JSON-RPC over stdin, runs a local `kanna-server` HTTP fixture, and asserts complete MCP responses through stdout.
That harness should cover at least one GET tool, one POST tool, HTTP failure mapping, and local argument validation before HTTP dispatch.

## Migration

Remove the old `kanna-cli` MCP serve subcommand in the first implementation.
There is no compatibility requirement for the old command, and keeping it would create a second public MCP entry point before the dedicated binary has settled.

The preferred long-term client command is:

`kanna-mcp serve`

MCP client configuration should point at `kanna-mcp`, not `kanna-cli`.

## Documentation

Do not add broad MCP client configuration templates until the first implementation proves the final sidecar path in development and packaged builds.
The implementation can include a short developer note showing the local `kanna-mcp serve --server-url ...` command for manual testing.
