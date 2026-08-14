# Desktop Agent Protocol Bazel Dependency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production and staging desktop Bazel libraries link the shared agent-provider protocol through the desktop crate universe.

**Architecture:** Add a desktop-specific build target for the existing `kanna-agent-protocol` sources, following the crate's established per-consumer targets. Link that target from every desktop Rust library so Cargo, production Bazel, and staging Bazel resolve the same shared provider registry.

**Tech Stack:** Bazel 9, rules_rust, Rust, Tauri v2

---

### Task 1: Preserve the failing release-build reproduction

**Files:**
- Test: `apps/desktop/src-tauri/BUILD.bazel:375`
- Test: `crates/kanna-agent-protocol/BUILD.bazel:1`

- [x] **Step 1: Run the focused staging library build before changing production files**

Run:

```bash
bazel build //apps/desktop/src-tauri:kanna_desktop_staging_lib_bazel --noshow_progress
```

Expected: FAIL in `commands/daemon/protocol.rs` with unresolved import
`kanna_agent_protocol`. This failure was also observed in the initial
`./kd release ship --staging --patch --dry-run` attempt.

- [x] **Step 2: Restore query/build-generated lockfile residue**

Run:

```bash
git restore --source=HEAD -- MODULE.bazel.lock Cargo.desktop.lock
git status --short
```

Expected: only the approved design and implementation-plan documents are
listed.

### Task 2: Add the desktop protocol target

**Files:**
- Modify: `crates/kanna-agent-protocol/BUILD.bazel:1-52`

- [x] **Step 1: Load the desktop crate resolver**

Add this load beside the existing consumer-specific resolvers:

```starlark
load("@desktop_crates//:defs.bzl", all_crate_deps_for_desktop = "all_crate_deps")
```

- [x] **Step 2: Define the desktop-universe protocol library**

Add this target before the daemon variant:

```starlark
rust_library(
    name = "kanna_agent_protocol",
    srcs = glob(["src/**/*.rs"]),
    compile_data = ["src/provider_resolution_cases.json"],
    crate_root = "src/lib.rs",
    crate_name = "kanna_agent_protocol",
    edition = "2021",
    deps = all_crate_deps_for_desktop(normal = True, package_name = "crates/kanna-agent-protocol") + [
        "//crates/claude-agent-sdk:claude_agent_sdk",
    ],
    proc_macro_deps = all_crate_deps_for_desktop(proc_macro = True, package_name = "crates/kanna-agent-protocol"),
)
```

### Task 3: Link every desktop library to the shared protocol

**Files:**
- Modify: `apps/desktop/src-tauri/BUILD.bazel:326-402`

- [x] **Step 1: Add the protocol dependency to the normal desktop library**

Add the following label to the explicit `deps` list for
`kanna_desktop_lib`:

```starlark
"//crates/kanna-agent-protocol:kanna_agent_protocol",
```

- [x] **Step 2: Add the same dependency to the production Bazel library**

Add the label to `kanna_desktop_lib_bazel`'s explicit `deps` list:

```starlark
"//crates/kanna-agent-protocol:kanna_agent_protocol",
```

- [x] **Step 3: Add the same dependency to the staging Bazel library**

Add the label to `kanna_desktop_staging_lib_bazel`'s explicit `deps` list:

```starlark
"//crates/kanna-agent-protocol:kanna_agent_protocol",
```

### Task 4: Verify the fixed release build graph

**Files:**
- Verify: `crates/kanna-agent-protocol/BUILD.bazel`
- Verify: `apps/desktop/src-tauri/BUILD.bazel`

- [x] **Step 1: Build both release library variants**

Run:

```bash
bazel build \
  //apps/desktop/src-tauri:kanna_desktop_lib_bazel \
  //apps/desktop/src-tauri:kanna_desktop_staging_lib_bazel \
  --noshow_progress
```

Expected: both targets build successfully with no unresolved protocol import.

- [x] **Step 2: Run the desktop protocol unit test through Cargo**

Run:

```bash
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  commands::daemon::protocol::tests::parse_agent_provider_uses_the_shared_protocol_registry
```

Expected: the focused provider-registry test passes.

- [x] **Step 3: Clean generated residue and inspect the final diff**

Run:

```bash
git restore --source=HEAD -- MODULE.bazel.lock Cargo.desktop.lock
git status --short
git diff --check
```

Expected: only the two Bazel files and the approved design/plan documents are
changed; `git diff --check` exits successfully.

- [x] **Step 4: Defer the complete ship command until the workflow commit exists**

The canonical release command rejects dirty worktrees. Do not create an
out-of-band commit in this stage. After the workflow commits this fix, rerun:

```bash
KANNA_UPDATER_PUBKEY="$(tr -d '\n' < "$HOME/.tauri/kanna-updater.key.pub")" \
TAURI_PRIVATE_KEY_PATH="$HOME/.tauri/kanna-updater.key" \
TAURI_PRIVATE_KEY_PASSWORD='' \
./kd release ship --staging --patch --dry-run
```

Expected: signed staging DMG and updater artifacts for `0.0.69-staging.1`.
