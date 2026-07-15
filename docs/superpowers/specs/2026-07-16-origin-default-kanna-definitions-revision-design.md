# Origin-default Kanna definitions revision design

## Goal

Preserve the origin-default definition source introduced by the feature while restoring the established environment, repo-config, and desktop failure-isolation contracts identified during review.

## Server environment layering

All task and session spawn paths will use one environment builder with this precedence:

1. base terminal/session environment
2. `workspace.env`
3. `workspace.path`-derived `PATH`
4. claimed task ports
5. Kanna runtime metadata

The builder will apply claimed ports and runtime metadata only after workspace configuration, making task identity, socket/control-plane paths, server URL, CLI/MCP paths, and claimed ports authoritative. MCP config rendering will receive the authoritative server URL directly rather than recovering it from a mutable environment map. Task creation, rerun, stage-run, teardown, dormant-start, and new-task preparation paths will all use the same builder.

## Repo-config normalization

Rust will parse `.kanna/config.json` as `serde_json::Value`, reject only invalid JSON syntax, and normalize semantic values field by field to match `packages/core/src/config/repo-config.ts`.

- Scalar strings are retained only when they are strings.
- `setup`, `teardown`, `test`, and `stage_order` are retained only when every entry is a string.
- `ports`, `flavors`, `vars`, and `workspace.env` filter invalid map entries while preserving valid siblings.
- Reserved-port arrays filter invalid or out-of-range entries.
- `workspace.path.prepend` and `append` filter invalid entries independently.
- Empty normalized maps and workspace objects are omitted.

The normalized `RepoConfig` remains serializable in the existing snake_case HTTP wire format.

## Desktop failure isolation

Snapshot fetching remains authoritative for task/sidebar state. The fetched snapshot will be published without waiting for definition manifests. Per-repo manifest requests will enrich only the stage-order cache; each failure will be logged and isolated without rejecting the snapshot refresh or replacing good task state.

Opening New Task will treat the definitions manifest as one fallible input. A failure will clear definition-derived pipeline choices, emit a visible error toast, continue loading branches and provider availability, and open the modal. Existing App and keyboard callers can continue invoking the action without owning error presentation.

## Verification

Regression tests will cover:

- real-Git task creation with hostile remote workspace overrides for ports, runtime metadata, control-plane values, and PATH;
- Rust/TypeScript repo-config normalization parity and normalized HTTP manifest output;
- snapshot publication when one repo definition endpoint fails;
- New Task remaining open and showing a toast on a definition failure;
- mounted-app integration for sidebar preservation and visible New Task failure handling;
- the requested focused and full repository test commands.

A full packaged-app E2E is not included because the current desktop E2E harness
targets a live worktree server and has no deterministic fault-injection point for
an origin-definition Git/HTTP failure. That coverage becomes feasible with a
server fixture or proxy that can fail one repo's definition routes while serving a
seeded snapshot, plus an app-launch fixture wired to that server. The narrower
coverage here exercises the desktop server-client abstraction seam through the query
store and mounts `App.vue` to verify both rendered sidebar preservation and the
visible New Task error state.
