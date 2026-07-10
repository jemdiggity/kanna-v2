# Codebase Review Remediation Design

## Goal

Resolve the four concrete issues found during the codebase review without broadening the work into unrelated rewrites:

- restore exact parity between the declarative Kanna tool catalog and the typed `kanna-cli` surface
- finish the desktop-to-server database migration ownership handoff
- make the canonical JavaScript and Rust test workflows reliable under bounded host resources
- establish one cross-language source of truth for agent provider identity and shared metadata

The resulting checkout must have explicit, repeatable verification commands. Public HTTP and MCP contracts must remain compatible.

## Non-Goals

This work will not generate the entire CLI from the tool catalog, remove the frontend `DbHandle` abstraction, redesign provider adapters, or combine unit tests with remote E2E and browser fidelity suites. It will not add a database migration or change persisted data. Provider-specific command construction, permission flags, output parsing, and localized presentation remain owned by their existing subsystems.

## 1. Typed CLI and Tool Catalog Parity

The tool catalog already exposes `kanna_is_dependent_tasks_exist` as `GET /v1/tasks/{task_id}/dependent-tasks-exist`, and the server implements and tests that route. The typed CLI omitted the corresponding command when the tool was added.

Add this public CLI command:

```text
kanna-cli task dependent-tasks-exist --task-id <TASK_ID> [--server-url <URL>]
```

The command will follow the existing typed `task get` and `task logs` patterns:

- percent-encode the task id when constructing the request path
- issue a `GET` to the existing endpoint
- decode the existing `{ exists, dependentTasks }` response into typed models
- print the response as JSON without changing the HTTP, catalog, or MCP contract

The catalog-to-typed-surface mapping will associate `kanna_is_dependent_tasks_exist` with `task dependent-tasks-exist`. Merge-agent fallback instructions will use this typed command instead of raw `curl`; generic `kanna-cli tool call` remains available.

Errors retain normal CLI behavior: transport failures, non-success HTTP statuses, and invalid response bodies return a non-zero exit with the existing API error format.

## 2. Server-Only Database Migration Ownership

Kanna v0.0.68 shipped server-owned SQLite migrations together with a one-release TypeScript fallback. Production desktop startup now always receives a disabled/E2E database facade, so the TypeScript schema migration sequence cannot execute in installed builds. Server startup opens the database through `Db::open_migrated`, runs migrations transactionally, performs `quick_check`, and only then serves requests. Rust tests retain direct-upgrade coverage for databases created before server ownership.

Delete the expired frontend schema fallback:

- remove the duplicated TypeScript migration constants, migration runner, marker checks, and unused health-check helper from `apps/desktop/src/stores/db.ts`
- remove the `runMigrations` import and startup call from `apps/desktop/src/main.ts`
- remove tests whose only purpose is exercising the retired frontend migration sequence

Retain:

- `resolveDbName` and `loadDatabase`
- the disabled production handle and DEV-plus-E2E SQL facade
- legacy app-data-directory file copying
- all Rust schema, migration, corruption, and legacy-upgrade tests
- the server-boundary prohibition on shipping `tauri-plugin-sql`

No migration 027 or other schema change will be coupled to this cleanup. A server migration failure continues to prevent the local API from becoming ready rather than falling back to a second schema owner.

## 3. Resource-Bounded Test Orchestration

The canonical `pnpm test` currently launches up to twelve Turbo package tasks, several of which each start their own multi-worker Vitest pool. It also includes remote E2E, Chromium/Cargo fidelity, and other process-heavy suites under ordinary package `test` scripts. On the reviewed ten-core host this nested fan-out made the desktop suite more than seven times slower and caused unrelated five- and fifteen-second tests to time out. The same desktop suite passed all 1,020 tests in isolation.

Separate test tiers and apply one host-level resource budget:

- root `pnpm test` runs deterministic unit and contract suites only
- remote E2E and TUI fidelity move behind `test:remote-e2e` and `test:tui-fidelity` scripts and remain independently runnable
- root Turbo test concurrency defaults to two package tasks, and Vitest-based package scripts default to at most two workers, bounding ordinary nested test fan-out to four workers
- mobile tests stop downloading an ad hoc Vitest through `pnpm dlx` and use the workspace-pinned test runner

Rust verification will distinguish ordinary workspace tests from daemon process integration tests. The canonical workflow runs non-daemon workspace tests normally, then runs the daemon crate with `--test-threads=1`, matching the harness contract documented in both `AGENTS.md` and `agent_sessions.rs`. This avoids treating a deliberately serialized process test as safe for default libtest concurrency.

CI will run the same canonical JavaScript and Rust commands used locally. Integration and fidelity suites remain separate jobs or explicit commands so a unit-test result has a single meaning.

Timeouts will not be increased as the primary fix. A timeout may change only when a test's documented external operation legitimately requires a different budget after orchestration is bounded.

## 4. Agent Provider Source of Truth

`crates/kanna-agent-protocol` becomes authoritative for provider identity and stable cross-language metadata. This follows the existing architecture in which Rust protocol types generate committed TypeScript mirrors through `ts-rs`.

The shared Rust definition will cover:

- provider id
- executable name
- default session type (`pty` or `agent`)
- whether the provider supports a headless agent adapter

The daemon and server will consume the shared `AgentProvider` rather than defining independent enums or string parsers. The existing protocol generation workflow will emit the TypeScript `AgentProvider` union and a runtime provider registry into `@kanna/agent-protocol`. Generated files remain committed and are checked for freshness, so Cargo and Bazel release builds consume static source files and gain no runtime or build-machine dependency.

TypeScript core, database, desktop, and mobile code will import the generated type or registry instead of declaring provider unions and option arrays. UI labels remain localized and provider-specific behavior remains in adapters. Exhaustive `Record<AgentProvider, ...>` mappings will make missing UI or behavior entries a type error.

The pipeline JSON schema will consolidate its repeated provider enums into one local `$defs.agentProvider` definition. A contract test will assert that this schema enum exactly matches the generated registry; the schema stays readable while drift becomes a deterministic test failure.

Provider selection will use one documented policy:

1. explicit request
2. pipeline stage
3. agent definition
4. stored or user-default provider

The highest-precedence non-empty source supplies an ordered candidate list. The first installed candidate wins. If none of those candidates are installed, resolution returns an immediate error listing them; it never selects a known-unavailable provider and defers failure to process spawn. Rust and TypeScript compatibility paths will run the same resolution fixtures until the frontend no longer resolves providers independently.

## Data and Compatibility

No persisted record or public wire value changes. Provider ids remain lowercase snake-case strings, existing task rows remain valid, and the daemon wire representation remains compatible. The new CLI command is additive. The existing dependent-task HTTP route and MCP tool name do not change. Removing unreachable frontend migrations does not alter upgrades because Rust migrations remain authoritative for both fresh and legacy databases.

## Testing Strategy

Implementation follows test-first changes at each boundary:

- reproduce the CLI catalog parity failure, then add parser, encoded-path, HTTP method/response, and surface-mapping coverage
- retain Rust legacy-database upgrade tests while deleting only retired frontend migration tests
- add test-tier assertions so unit scripts cannot silently invoke remote E2E or browser/Cargo fidelity runners
- verify bounded test commands under the root orchestration rather than relying only on isolated package passes
- add Rust serialization and metadata tests for every provider
- regenerate TypeScript protocol output and verify freshness
- add TypeScript exhaustiveness and pipeline-schema parity tests
- add shared provider-resolution fixtures covering precedence, ordered fallback, unknown values, and no-installed-provider errors

Final verification will run the canonical root JavaScript tests, focused CLI and provider tests, the split Rust workflow including serialized daemon tests, generated-file checks, formatting and type checks for changed packages, and the relevant desktop build check.

## Rollout and Failure Handling

The changes are source-compatible and ship together. If generated provider output is stale, verification fails before packaging. If the pipeline schema diverges, its parity test identifies the missing or extra provider. If no configured provider is installed, task creation fails before a worktree agent spawn with an actionable candidate list. If server database migration fails, startup remains blocked with the server's migration error; there is no hidden frontend fallback.

The test split preserves explicit entry points for remote E2E and fidelity coverage, so reducing `pnpm test` to unit and contract semantics does not remove those suites.
