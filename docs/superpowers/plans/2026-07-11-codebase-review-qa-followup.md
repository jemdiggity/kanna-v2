# Codebase Review QA Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four remaining QA gaps around durable provider ordering, Turbo cache inputs, crash-residual SQLite relocation, and OpenCode headless process coverage.

**Architecture:** Workflow stage and post provider candidates remain ordered collections from repository JSON through the durable `pipeline_def` snapshot and are resolved only at spawn time; legacy scalar and comma-delimited snapshots remain readable. Integration tests exercise real `kanna-server` processes, HTTP routes, daemon protocol commands, SQLite recovery, and the desktop WebDriver flow at the process boundaries where the regressions occurred.

**Tech Stack:** Rust, Serde, Axum, rusqlite/SQLite WAL, Tokio, Turbo 2, pnpm, Vitest, Tauri WebDriver E2E, OpenCode JSONL.

---

### Task 1: Preserve Ordered Workflow Provider Candidates Durably

**Files:**
- Modify: `crates/kanna-server/src/task_creator/definitions.rs`
- Modify: `crates/kanna-server/src/task_creator/provider.rs`
- Modify: `crates/kanna-server/src/task_creator/tests/core.rs`
- Modify: `crates/kanna-server/tests/provider_resolution_http.rs`

- [x] **Step 1: Add failing structural snapshot coverage**

Extend the stored-workflow unit coverage so a stage and post defined as `agent_provider: ["codex", "claude"]` serialize back as arrays in the same order, and add a legacy stored snapshot case for `"agent_provider":"codex,claude"` that normalizes to the same ordered candidates.

- [x] **Step 2: Add failing real HTTP transition coverage**

Create one repository workflow with an initial scalar-Claude stage and a second manual stage whose stage and post providers are both `["codex", "claude"]`. Give the second stage and post named agents with no provider frontmatter so an agent definition cannot mask a lost workflow field. Expose only a fake `claude` executable through `workspace.path.prepend`, create the task through `POST /v1/tasks`, assert the persisted `pipeline_def` contains both JSON arrays, then remove the live workflow file.

Advance through `POST /v1/tasks/{id}/actions/advance-stage` and assert the reloaded second-stage `SpawnAgent` uses `DaemonAgentProvider::Claude` and the repo-scoped fake executable. Advance again, have the fake daemon answer the post's `Input` with `SessionNotFound`, forcing the post fallback spawn, and assert that spawn also uses Claude. The fake daemon must remain available across connections and handle `Subscribe`, `Kill`, `Input`, and all three `SpawnAgent` commands.

- [x] **Step 3: Run the provider integration test and verify RED**

Run:

```bash
cargo test -p kanna-server --test provider_resolution_http -- --nocapture
```

Expected: the new transition/post cases fail while reloading `"codex,claude"` as an unsupported single provider, or the structural-array assertion fails.

- [x] **Step 4: Replace scalar normalized stage/post providers with ordered collections**

Change normalized and raw stage/post provider fields to `Option<Vec<String>>`. Keep the external JSON key `agent_provider`. The custom deserializer must:

```rust
match value {
    Value::Null => Ok(None),
    Value::String(value) => parse and validate one or comma-delimited legacy candidates,
    Value::Array(values) => validate a non-empty ordered string list,
    _ => reject,
}
```

Derived serialization then writes a JSON array. Update `post_as_stage`, legacy continue-stage folding, synthetic workflow constructors, and merge task construction to carry the collection without flattening it.

- [x] **Step 5: Resolve stage collections without reparsing**

Change the stage-provider argument of `resolve_agent_provider` and `resolve_agent_provider_with` to `Option<&[String]>`. Preserve scalar parsing only for explicit request/default fallback strings; use `stage_provider.to_vec()` for normalized stage candidates and keep agent-definition candidates as their existing vector.

- [x] **Step 6: Run focused and package tests GREEN**

Run:

```bash
cargo test -p kanna-server --test provider_resolution_http -- --nocapture
cargo test -p kanna-server
```

Expected: all provider snapshot, transition, post fallback, and existing server tests pass.

### Task 2: Make `@kanna/kd#test` Turbo Inputs Cache-Sound

**Files:**
- Modify: `turbo.json`
- Modify: `tools/kd/tests/test-orchestration.test.ts`

- [x] **Step 1: Add a failing resolved-Turbo regression**

From the test, execute this non-running dry plan at the repository root:

```bash
pnpm exec turbo run test --dry=json --filter=@kanna/kd
```

Parse the `@kanna/kd#test` task and assert its resolved task definition disables caching. The current dry run must fail because the task is cacheable.

- [x] **Step 2: Disable caching for the repository-inspecting kd suite**

Add a package-qualified task override that retains the normal dependency ordering and always executes the suite:

```json
"@kanna/kd#test": {
  "dependsOn": ["^build"],
  "cache": false
}
```

An explicit input inventory was rejected during review because the suite also inspects the root `kd` symlink target and copies the whole lockfile; disabling caching is the robust contract for these repository-wide orchestration checks.

- [x] **Step 3: Verify focused tests and the uncached dry plan GREEN**

Run:

```bash
pnpm --dir tools/kd test
pnpm exec turbo run test --dry=json
```

Expected: the regression passes and the dry plan reports `cache: false` for `@kanna/kd#test`.

### Task 3: Exercise Crash-Residual WAL Relocation and Restart

**Files:**
- Modify: `crates/kanna-server/tests/legacy_database_relocation.rs`
- Modify only if exposed by the test: `crates/kanna-server/src/db/mod.rs`

- [x] **Step 1: Replace the clean seed with a crash-writer helper**

Bootstrap the `settings` table in the main legacy DB, then launch the current integration-test executable with an ignored exact helper test. The helper reads the DB and ready-marker paths from environment variables, sets WAL mode and `wal_autocheckpoint=0`, commits `legacySeed=from-legacy`, writes the ready marker, and remains alive while holding its `Connection`:

```rust
#[test]
#[ignore]
fn crash_residual_wal_writer() {
    let db_path = env::var_os(CRASH_DB_ENV).expect("child DB path");
    let ready = env::var_os(CRASH_READY_ENV).expect("child ready path");
    let connection = Connection::open(db_path).expect("legacy DB should open");
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN; INSERT INTO settings (key, value) VALUES ('legacySeed', 'from-legacy'); COMMIT;").unwrap();
    std::fs::write(ready, b"ready").unwrap();
    loop { std::thread::park(); }
}
```

The parent waits for the marker, SIGKILLs and reaps the helper, then asserts non-empty legacy `-wal` and `-shm` files.

- [x] **Step 2: Prove the committed row is WAL-only before startup**

Copy only the legacy main database to a different basename and query the copy. Assert the `settings` schema exists but `legacySeed` does not, without opening the original legacy DB.

- [x] **Step 3: Keep all persistence checks on the real HTTP/server path**

Start the real server, assert relocation removed the legacy main/WAL/SHM paths and `GET /v1/settings/legacySeed` returns the committed WAL value. Write `relocationProbe` through HTTP, stop the process, restart immediately without opening the canonical DB directly, and verify both settings through HTTP.

- [x] **Step 4: Run the executable integration test GREEN**

Run:

```bash
cargo test -p kanna-server --test legacy_database_relocation -- --nocapture
```

Expected: the real startup recovers the crash WAL before rename, and the second real startup sees both values.

### Task 4: Prove the OpenCode Headless Process and Stream Boundary

**Files:**
- Modify: `apps/desktop/tests/e2e/mock/new-task-modal.test.ts`

- [x] **Step 1: Add failing process/stream assertions before changing the fake**

Keep the row assertion, but save the created task id and condition-wait for `[data-testid="agent-message-view"]` to contain the unique fake completion text and `Turn success`. Poll `list_sessions` and assert the task session is an active idle agent. Reload the WebView, wait for app readiness, and reassert the same task id/provider/type from the server-backed snapshot plus the replayed completion marker.

- [x] **Step 2: Run the focused E2E and verify RED**

Run:

```bash
./kd dev up
pnpm --dir apps/desktop test:e2e -- mock/new-task-modal.test.ts
./kd dev down
```

Expected: the OpenCode case times out because the current plain-text fake becomes a hidden raw event and cannot render the assistant/turn completion boundary.

- [x] **Step 3: Emit valid OpenCode JSONL from the fake executable**

Replace the plain-text line with newline-delimited `step_start`, `text`, and `step_finish` objects using the real adapter shape. The text event must contain the unique completion marker, and the finish event must use `reason: "stop"` plus zero cost/tokens so the adapter produces `AssistantText` and `TurnCompleted(Success)`.

- [x] **Step 4: Re-run the focused E2E GREEN and stop dev services**

Run the same `kd dev up` / focused E2E / `kd dev down` sequence and confirm the rendered stream, daemon session state, reload replay, and provider/type persistence assertions pass.

### Task 5: Complete Required Verification and Review

- [x] Run every minimum command from the reviewer feedback:

```bash
cargo test -p kanna-server --test provider_resolution_http -- --nocapture
cargo test -p kanna-server --test legacy_database_relocation -- --nocapture
cargo test -p kanna-server
pnpm --dir tools/kd test
pnpm exec turbo run test --dry=json
./kd dev up
pnpm --dir apps/desktop test:e2e -- mock/new-task-modal.test.ts
./kd dev down
pnpm test
(cd crates/daemon && cargo test -- --test-threads=1)
git diff --check
```

- [x] Inspect the complete diff for accidental scope, legacy compatibility, daemon fixture races, and cleanup on failure.
- [x] Request independent spec-compliance and code-quality review, fix all critical/important findings, and rerun affected verification.

The implementation stage intentionally left these changes uncommitted; Kanna's commit stage owns the commit before QA review.
