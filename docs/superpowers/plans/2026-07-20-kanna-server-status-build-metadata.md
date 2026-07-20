# Kanna Server Status Build Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/v1/status` report the active desktop build's required canonical `version` and `environment`, including the complete staging prerelease, while preserving `serverVersion` as a deprecated compatibility alias.

**Architecture:** The desktop app remains the installed-build identity owner. Its build-time version and bundle-derived environment are written into the instance-specific `server.toml`; `kanna-server` requires and returns those values without inference and copies the canonical version into the deprecated `serverVersion` response alias. Production and staging keep sharing the reusable sidecar binary while reporting distinct runtime identities.

**Tech Stack:** Rust, Axum/Serde/TOML, Tauri v2, TypeScript/Vitest, Bazel release orchestration.

---

## File Map

- `crates/kanna-server/src/config.rs` — require `version` and `environment` in server runtime configuration.
- `crates/kanna-server/src/mobile_api.rs` — define and build the canonical status response.
- `crates/kanna-server/src/http_api/tests/revision_status.rs` — assert the HTTP payload contract.
- `crates/kanna-server/tests/status_build_identity_http.rs` — launch real production and staging server processes and assert exact HTTP responses.
- `crates/kanna-server/src/http_api/test_support.rs` and Rust server fixtures — migrate test `Config` literals to canonical metadata.
- `apps/desktop/src-tauri/src/commands/mobile/mod.rs` — decode status, construct stopped snapshots, and compare version plus environment.
- `apps/desktop/src-tauri/src/commands/mobile/config.rs` — write and validate canonical runtime metadata.
- `apps/desktop/src/tauri-mock.ts` — update the browser mock response.
- `tests/remote-e2e/src/harness.ts` and `tests/remote-e2e/src/staging.ts` — update real server TOML fixtures.
- `tools/kd/tests/release.test.ts` — prove resolved production and complete staging versions are present during Bazel builds.
- `docs/superpowers/specs/2026-07-20-kanna-server-status-build-metadata-design.md` — document compatibility and installed-app E2E limitations.

### Task 1: Require canonical build metadata in `kanna-server`

**Files:**
- Modify: `crates/kanna-server/src/config.rs`
- Modify: `crates/kanna-server/src/mobile_api.rs`
- Modify: `crates/kanna-server/src/http_api/tests/revision_status.rs`

- [ ] **Step 1: Write failing configuration and status tests**

Add a `config.rs` test that writes an otherwise-valid TOML file without build metadata and asserts `load_from_path` returns an error containing `missing field`. Extend the existing successful load test with:

```rust
version = "0.0.69-staging.1"
environment = "staging"
```

and assert:

```rust
assert_eq!(config.version, "0.0.69-staging.1");
assert_eq!(config.environment, "staging");
```

Replace the single mobile API status test with explicit production and staging cases using a small local `status_config(version, environment, port)` helper. The staging assertion must be:

```rust
let status = build_mobile_server_status(
    &status_config("0.0.69-staging.1", "staging", 48_121),
    None,
);
assert_eq!(status.version, "0.0.69-staging.1");
assert_eq!(status.environment, "staging");
```

Extend `status_route_does_not_expose_pairing_secret` to assert the routed test response contains `version == "test-version"` and `environment == "development"`.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml status_reflects -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml load_from_path_requires_build_metadata -- --nocapture
```

Expected: FAIL because `Config` and `MobileServerStatus` do not yet have canonical required `version` and `environment` fields.

- [ ] **Step 3: Implement the canonical server contract**

Change both `Config` and `RawConfig` to contain:

```rust
pub version: String,
pub environment: String,
```

with the `RawConfig` fields private but still non-optional. Assign them directly in `load_from_path`:

```rust
version: raw.version,
environment: raw.environment,
```

Change `MobileServerStatus` to add the canonical fields while retaining the compatibility field:

```rust
pub version: String,
pub environment: String,
pub server_version: Option<String>,
```

and build them from configuration:

```rust
version: config.version.clone(),
environment: config.environment.clone(),
server_version: Some(config.version.clone()),
```

Do not accept `server_version` as configuration and do not infer either canonical field. The alias is response-only and must always equal the canonical version in current responses.

- [ ] **Step 4: Migrate all server fixtures mechanically**

Across these files:

```text
crates/kanna-server/src/commands.rs
crates/kanna-server/src/http_api/test_support.rs
crates/kanna-server/src/http_api/tests/actions.rs
crates/kanna-server/src/http_api/tests/core_routes.rs
crates/kanna-server/src/http_api/tests/create_task.rs
crates/kanna-server/src/http_api/tests/input.rs
crates/kanna-server/src/http_api/tests/revision_status.rs
crates/kanna-server/src/ksp.rs
crates/kanna-server/src/mobile_api.rs
crates/kanna-server/src/pairing.rs
crates/kanna-server/src/relay_client.rs
crates/kanna-server/src/runtime.rs
crates/kanna-server/src/task_creator/tests/core.rs
crates/kanna-server/src/task_creator/tests/mod.rs
crates/kanna-server/src/terminal_watcher.rs
crates/kanna-server/tests/legacy_database_relocation.rs
crates/kanna-server/tests/provider_resolution_http.rs
```

replace each server `Config` fixture field:

```rust
server_version: Some("test-version".to_string()),
```

with:

```rust
version: "test-version".to_string(),
environment: "development".to_string(),
```

Use the production/staging values only in the dedicated status regression tests. Replace TOML fixture lines such as:

```toml
server_version = "test-version"
```

with:

```toml
version = "test-version"
environment = "development"
```

Update JSON expectations to include the two canonical camel-case keys and retain `serverVersion` with the same value as `version`.

- [ ] **Step 5: Format and verify GREEN**

Run:

```bash
cargo fmt --all
cargo test --manifest-path crates/kanna-server/Cargo.toml status -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml config::tests -- --nocapture
rg -n 'server_version|serverVersion' crates/kanna-server
```

Expected: focused tests PASS and matches are limited to the deprecated response field and its tests; `Config` and TOML fixtures do not contain the legacy key.

- [ ] **Step 6: Commit the server contract**

```bash
git add crates/kanna-server
git commit -m "feat(server): expose canonical build metadata"
```

### Task 2: Propagate desktop build identity into server configuration

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mobile/mod.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mobile/config.rs`

- [ ] **Step 1: Write failing desktop metadata tests**

Rename `current_server_status_requires_matching_version` to `current_server_status_requires_matching_build_metadata`. Construct a current response with:

```rust
version: current_server_version().to_string(),
environment: "production".to_string(),
```

and assert `is_current_server_status` accepts it only when desktop id, version, and environment all match. Add separate stale cases for `version = "__stale__"` and `environment = "staging"`.

In `config.rs`, add a table-style test over:

```rust
[
    (None, "development", 48_120),
    (Some(DesktopCloudEnvironment::Production), "production", 48_120),
    (Some(DesktopCloudEnvironment::Staging), "staging", 48_121),
]
```

For each state, assert generated TOML contains:

```rust
format!("version = \"{}\"", current_server_version())
format!("environment = \"{expected_environment}\"")
```

- [ ] **Step 2: Run the desktop tests and confirm RED**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml current_server_status_requires_matching_build_metadata -- --nocapture
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml build_server_config_includes_build_metadata -- --nocapture
```

Expected: FAIL because the desktop does not yet model the canonical build identity.

- [ ] **Step 3: Implement desktop metadata derivation and propagation**

Add canonical fields to desktop `MobileServerStatus` while retaining the optional compatibility field:

```rust
pub version: String,
pub environment: String,
pub server_version: Option<String>,
```

Add one helper beside `current_server_version`:

```rust
fn server_environment(cloud_env: Option<DesktopCloudEnvironment>) -> &'static str {
    cloud_env.map(DesktopCloudEnvironment::as_str).unwrap_or("development")
}
```

Use it in `stopped_snapshot`, `build_server_config`, `server_config_matches_runtime`, and current-process matching. Change matching to:

```rust
status.desktop_id == expected_desktop_id
    && status.version == expected_version
    && status.environment == expected_environment
```

Write TOML as:

```toml
version = "<crate::KANNA_VERSION>"
environment = "<bundle-derived environment>"
```

and require both exact lines in `server_config_matches_runtime`.

- [ ] **Step 4: Update desktop test helpers and mocks**

Change `write_test_server_config` to accept `version: &str` and `environment: &str` and always emit both required keys. Update fake Python/JSON responders and `apps/desktop/src/tauri-mock.ts` from:

```ts
serverVersion: "0.0.0"
```

to:

```ts
version: "0.0.0",
environment: "development",
serverVersion: "0.0.0"
```

Production fake responses use `environment: "production"`; staging responses use `environment: "staging"` and the full prerelease where the test is about installed staging.

- [ ] **Step 5: Format and verify GREEN**

Run:

```bash
cargo fmt --all
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml current_server_status -- --nocapture
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml build_server_config -- --nocapture
rg -n 'server_version|serverVersion' apps/desktop/src-tauri/src/commands/mobile apps/desktop/src/tauri-mock.ts
```

Expected: focused tests PASS and alias matches are limited to response models, response fixtures, and compatibility assertions; canonical version and environment remain authoritative.

- [ ] **Step 6: Commit desktop propagation**

```bash
git add apps/desktop/src-tauri/src/commands/mobile apps/desktop/src/tauri-mock.ts
git commit -m "feat(desktop): pass build identity to kanna-server"
```

### Task 3: Prove release-time versions reach the build

**Files:**
- Modify: `tools/kd/tests/release.test.ts`

- [ ] **Step 1: Strengthen production and staging build-boundary coverage**

In the staging shipping test's Bazel branch, assert the synchronized files contain the complete prerelease while the build is running:

```ts
expect(readVersionFiles(repoRoot)).toEqual([
  "1.2.4-staging.1\n",
  '{\n  "version": "1.2.4-staging.1"\n}\n',
  '[package]\nname = "kanna"\nversion = "1.2.4-staging.1"\n'
]);
```

After `shipRelease`, assert the staging source files were restored to `1.2.3`. Add the equivalent in-build assertion to an existing successful production shipping test, expecting `1.2.4`, and assert production files remain at the released value after success.

These are characterization guards for the existing release synchronization behavior; no `release.ts` change is expected unless the assertions reveal a gap.

- [ ] **Step 2: Run the release regression tests**

Run:

```bash
pnpm --dir tools/kd test -- release.test.ts
```

Expected: PASS, proving the full staging prerelease and production release versions exist in the Bazel build inputs.

- [ ] **Step 3: Commit release coverage**

```bash
git add tools/kd/tests/release.test.ts
git commit -m "test(release): preserve full status build versions"
```

### Task 4: Update real server harnesses and validate direct/tunneled responses

**Files:**
- Modify: `tests/remote-e2e/src/harness.ts`
- Modify: `tests/remote-e2e/src/staging.ts`
- Modify: `crates/kanna-server/src/relay_client.rs`
- Modify: `crates/kanna-server/src/http_api/tests/e2e_sql_routes.rs` if its exact JSON assertions require canonical fields

- [ ] **Step 1: Update harness configuration fixtures**

Replace remote E2E TOML lines with:

```ts
`version = "remote-e2e"`,
`environment = "development"`,
```

and staging harness lines with:

```ts
`version = "0.0.69-staging.1"`,
`environment = "staging"`,
```

Update relay client status JSON assertions to require:

```rust
assert_eq!(status_body["version"], "test-version");
assert_eq!(status_body["environment"], "development");
assert_eq!(status_body["serverVersion"], "test-version");
```

- [ ] **Step 2: Run direct and tunneled status coverage**

Run:

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml status_route_does_not_expose_pairing_secret -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml relay_client -- --nocapture
cargo test --manifest-path crates/kanna-server/Cargo.toml e2e_sql_routes -- --nocapture
```

Expected: PASS with identical canonical metadata on direct and tunneled status paths.

- [ ] **Step 3: Verify the compatibility alias is populated from the canonical version**

Run:

```bash
rg -n 'server_version|serverVersion' crates/kanna-server apps/desktop tests/remote-e2e
```

Expected: matches are limited to the deprecated response field, fixtures, and assertions; no server configuration source or freshness check treats the alias as authoritative.

- [ ] **Step 4: Commit harness migration**

```bash
git add tests/remote-e2e crates/kanna-server/src/relay_client.rs crates/kanna-server/src/http_api/tests/e2e_sql_routes.rs
git commit -m "test(server): cover build identity across status transports"
```

### Task 4A: Add process-boundary production and staging coverage

**Files:**
- Create: `crates/kanna-server/tests/status_build_identity_http.rs`
- Modify: `crates/kanna-server/src/http_api/tests/e2e_sql_routes.rs`
- Modify: `docs/superpowers/specs/2026-07-20-kanna-server-status-build-metadata-design.md`

- [ ] **Step 1: Write the failing child-process HTTP test**

Launch `env!("CARGO_BIN_EXE_kanna-server")` twice with separate temporary `server.toml`, database, daemon, pairing-store, and loopback-port values. Poll each real listener and compare the complete decoded JSON values. Production must report `version` and `serverVersion` as `0.0.69` with `environment: "production"`; staging must report both version fields as `0.0.69-staging.1` with `environment: "staging"`.

- [ ] **Step 2: Confirm RED**

```bash
cargo test -p kanna-server --test status_build_identity_http -- --nocapture
```

Expected: FAIL because the current server omits `serverVersion`.

- [ ] **Step 3: Populate the alias and update desktop response models**

Add `server_version: Option<String>` to the server and desktop `MobileServerStatus` models. Populate it with `Some(canonical_version.clone())` in running and stopped responses, update browser/process fixtures, and keep stale-process matching based only on `version` and `environment`.

- [ ] **Step 4: Assert the tunneled body**

Extend `e2e_mobile_controls_gate_direct_lan_but_preserve_tunneled_transport` to compare the full tunneled JSON body, including `version`, `environment`, and `serverVersion`, after direct LAN HTTP has been disabled.

- [ ] **Step 5: Confirm GREEN and document the installed-app gap**

```bash
cargo test -p kanna-server --test status_build_identity_http -- --nocapture
cargo test -p kanna-server e2e_mobile_controls_gate_direct_lan_but_preserve_tunneled_transport -- --nocapture
```

Document that release-installed-app E2E requires signed production and staging bundles, an isolated macOS runner, controlled fixed ports/app-data roots, and GUI process launch. Record the real child-process/config/TCP/HTTP test as the narrower substitute.

### Task 5: Full verification

**Files:**
- Verify only

- [ ] **Step 1: Run server tests**

```bash
cargo test --manifest-path crates/kanna-server/Cargo.toml
```

Expected: all `kanna-server` tests PASS.

- [ ] **Step 2: Run desktop Rust tests**

```bash
./kd build sidecars
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml commands::mobile -- --nocapture
```

Expected: sidecars build successfully and all mobile command tests PASS.

- [ ] **Step 3: Run kd tests and typecheck**

```bash
pnpm --dir tools/kd test
pnpm --dir tools/kd typecheck
```

Expected: all kd tests PASS and TypeScript reports no errors.

- [ ] **Step 4: Run repository checks proportionate to the change**

```bash
pnpm test
./kd test rust
git diff --check origin/main...HEAD
git status --short
```

Expected: repository test suites PASS, the diff has no whitespace errors, and only intentional work remains.

- [ ] **Step 5: Review the requirement checklist**

Confirm from source and fresh test output:

- production reports `environment: "production"` and its complete release version;
- staging reports `environment: "staging"` and a complete prerelease such as `0.0.69-staging.1`;
- development reports `environment: "development"`;
- `/v1/status` contains `serverVersion` as a deprecated alias exactly equal to `version`;
- version and environment originate in desktop build/runtime metadata and are not inferred by `kanna-server`;
- direct and tunneled status paths return the same contract.
