# Legacy Database Relocation Test Isolation Design

## Problem

`crates/kanna-server/tests/legacy_database_relocation.rs` creates test roots from the test process ID and `SystemTime::now().as_nanos()`. Parallel tests share a process ID, and macOS can return the same effective timestamp to tests that start in the same clock tick. Two tests can therefore share a database directory.

The collision produces two related failures: one test creates the `settings` table before the other, and cleanup from the failed test removes the directory while the other test's crash-writer child is opening its database. The normal parallel integration suite fails, while the same suite passes with `--test-threads=1`.

## Design

Replace the hand-built temporary path with `tempfile::TempDir` and add `tempfile` as a `kanna-server` development dependency. `TestRoot` will own the `TempDir` handle, expose its path to existing fixture helpers, and retain explicit cleanup through `TempDir::close`.

This keeps every test root atomically unique without changing production database relocation behavior or serializing the test suite. Cleanup remains deterministic when a test calls `cleanup`, while `TempDir` provides best-effort cleanup during unwinding.

## Alternatives Considered

- Add a process-local atomic counter to the PID and timestamp. This reduces collisions but preserves a custom naming and cleanup scheme and does not atomically reserve the directory.
- Serialize the integration tests. This avoids concurrent collisions but hides broken isolation and makes the suite slower.

## Error Handling

Test setup will continue to fail immediately if a temporary directory cannot be created. Explicit cleanup will continue returning an I/O error to the calling test. Automatic cleanup during unwinding remains best effort, matching the current `Drop` behavior.

## Testing

The existing integration suite is the regression test. Its normal parallel execution failed twice before the fix and passed only when forced to one test thread. After the change:

1. Run `cargo test -p kanna-server --test legacy_database_relocation -- --nocapture` with default parallelism.
2. Run `pnpm test`.
3. Run `./kd test rust`.

After all checks pass, commit the implementation, rename and push the branch, create the pull request against `main`, and record successful Kanna stage completion with the PR URL.
