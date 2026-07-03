# Mobile Command Submodules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `apps/desktop/src-tauri/src/commands/mobile.rs` into focused Rust submodules without changing runtime behavior.

**Architecture:** Convert `mobile.rs` into `mobile/mod.rs` so the public Tauri command surface and `MobileServerManager` remain at `commands::mobile::*`. Move server config generation, cloud environment helpers, and sidecar/process helpers into sibling private submodules that expose only `pub(super)` functions and keep tests near the moved code.

**Tech Stack:** Rust 2024, Tauri v2 command modules, Tokio, cargo fmt/check/test.

---

### Task 1: Convert Mobile Module Layout

**Files:**
- Move: `apps/desktop/src-tauri/src/commands/mobile.rs` to `apps/desktop/src-tauri/src/commands/mobile/mod.rs`
- Create: `apps/desktop/src-tauri/src/commands/mobile/config.rs`
- Create: `apps/desktop/src-tauri/src/commands/mobile/cloud_env.rs`
- Create: `apps/desktop/src-tauri/src/commands/mobile/process.rs`

- [ ] **Step 1: Move the module file**

Run:

```bash
mkdir -p apps/desktop/src-tauri/src/commands/mobile
mv apps/desktop/src-tauri/src/commands/mobile.rs apps/desktop/src-tauri/src/commands/mobile/mod.rs
```

Expected: `pub mod mobile;` in `commands/mod.rs` continues resolving through `mobile/mod.rs`.

- [ ] **Step 2: Add submodule declarations and imports**

In `mobile/mod.rs`, add:

```rust
mod cloud_env;
mod config;
mod process;

use cloud_env::{
    effective_cloud_env, firebase_auth_emulator_url, firebase_firestore_emulator_host,
    firebase_project_id, relay_url_for_bundled_cloud_env,
};
use config::{
    build_server_config, server_config_matches_runtime, server_config_path_for_app_data_dir,
    server_lock_path_for_config, try_claim_server_lock, write_server_config,
};
use process::{find_sidecar, stop_server_on_port};
```

Expected: the manager and Tauri command APIs stay in `mobile/mod.rs`.

### Task 2: Move Server Config Helpers

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mobile/mod.rs`
- Create: `apps/desktop/src-tauri/src/commands/mobile/config.rs`

- [ ] **Step 1: Move config helper functions**

Move these functions unchanged into `config.rs`, changing only required visibility to `pub(super)`:

```rust
write_server_config
server_config_path_for_app_data_dir
server_config_scope
sanitize_server_scope
path_hash
server_lock_path_for_config
try_claim_server_lock
build_server_config
server_config_matches_runtime
sidecar_sha256_config_line
```

Expected: logic, strings, environment variable names, and config line ordering remain unchanged.

- [ ] **Step 2: Move config-specific tests**

Move tests that assert config paths, locks, server config contents, cloud-default config contents, runtime config matching, and related helper behavior into `config.rs` under `#[cfg(test)]`.

Expected: tests use `super::*` plus `crate::commands::mobile::*` helpers only where needed.

### Task 3: Move Cloud Environment Helpers

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mobile/mod.rs`
- Create: `apps/desktop/src-tauri/src/commands/mobile/cloud_env.rs`

- [ ] **Step 1: Move cloud helper functions**

Move these functions unchanged into `cloud_env.rs`, changing only required visibility to `pub(super)`:

```rust
relay_url
relay_url_for_mode
relay_url_for_bundled_cloud_env
firebase_project_id
effective_cloud_env
firebase_auth_emulator_url
firebase_firestore_emulator_host
```

Expected: `relay_url` and `relay_url_for_mode` remain `#[cfg(test)]`.

- [ ] **Step 2: Move cloud-specific tests**

Move tests for explicit relay URL precedence and release relay defaults into `cloud_env.rs`.

Expected: environment-variable behavior is unchanged.

### Task 4: Move Process Helpers

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mobile/mod.rs`
- Create: `apps/desktop/src-tauri/src/commands/mobile/process.rs`

- [ ] **Step 1: Move process helper functions**

Move these functions unchanged into `process.rs`, changing only required visibility to `pub(super)`:

```rust
find_sidecar
stop_server_on_port
server_pids_on_port
parse_lsof_pids
signal_process
wait_for_server_port_to_close
```

Expected: `find_sidecar` stays a thin wrapper over `crate::commands::fs::sidecar_candidates(name)` with the existing test-directory branch.

- [ ] **Step 2: Move process-specific tests**

Move tests for `parse_lsof_pids` and SIGKILL escalation into `process.rs`.

Expected: process cleanup helpers remain private to the mobile module tree.

### Task 5: Verify and Commit

**Files:**
- Modify: all created/moved Rust module files

- [ ] **Step 1: Format**

Run:

```bash
cargo fmt --all
```

Expected: exit code 0.

- [ ] **Step 2: Check desktop crate**

Run:

```bash
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: exit code 0.

- [ ] **Step 3: Test desktop crate**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Expected: exit code 0.

- [ ] **Step 4: Commit**

Run:

```bash
git status --short
git add apps/desktop/src-tauri/src/commands/mobile docs/superpowers/plans/2026-07-03-mobile-command-submodules.md
git commit -m "refactor: split mobile command helpers"
```

Expected: commit succeeds and includes only the mobile module split plus this plan.
