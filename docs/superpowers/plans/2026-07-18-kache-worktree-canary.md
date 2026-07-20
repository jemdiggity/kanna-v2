# Kache Worktree Canary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test whether a dependency-only kache wrapper safely and materially reduces duplicated Rust compilation and physical storage across active Kanna worktrees without slowing Kanna source edits or sharing final binaries.

**Architecture:** A disposable zsh `RUSTC_WRAPPER` classifies rustc's primary source path. Kanna checkout sources execute the real rustc directly; registry/git dependencies execute the pinned, checksum-verified kache binary. Two byte-identical disposable Kanna checkouts use private Cargo target/build directories and one local-only kache store.

**Tech Stack:** zsh, Cargo 1.93.1, rustc 1.93.1, kache 0.10.0, APFS, macOS `time`/`df`/`du`/`shasum`/`file`/`codesign`.

---

### Task 1: Build and test the experimental dispatcher

**Files:**
- Create: `scripts/experiments/kache-rustc-wrapper.zsh`
- Create: `scripts/experiments/test-kache-rustc-wrapper.zsh`

- [ ] **Step 1: Write a failing shell contract test**

The test creates fake rustc and kache executables, invokes the wrapper with a
workspace source, an external source, and an unclassifiable query, then asserts
the selected executable and preserved argument vector. It also covers spaces
in checkout paths and a symlinked workspace root.

- [ ] **Step 2: Run the contract test and verify it fails because the wrapper is absent**

Run: `zsh scripts/experiments/test-kache-rustc-wrapper.zsh`

Expected: nonzero status identifying the missing wrapper.

- [ ] **Step 3: Implement the minimal fail-closed dispatcher**

The wrapper must:

1. Treat argument 1 as the real rustc executable and preserve every remaining
   argument byte-for-byte.
2. Resolve `KANNA_KACHE_WORKSPACE_ROOT` canonically.
3. Identify a positional `.rs` primary source, resolve it relative to the
   compiler working directory, and compare path components rather than string
   prefixes.
4. Execute real rustc for sources under the Kanna root and for any ambiguous,
   missing, or malformed input.
5. Execute the exact `KANNA_KACHE_BIN` path only for a source proven outside
   the Kanna root.
6. Append one tab-separated classification record when
   `KANNA_KACHE_CLASSIFICATION_LOG` is set.

- [ ] **Step 4: Run the contract test and syntax check**

Run:

```bash
zsh -n scripts/experiments/kache-rustc-wrapper.zsh
zsh scripts/experiments/test-kache-rustc-wrapper.zsh
```

Expected: both exit zero and the contract test reports all cases passed.

### Task 2: Verify tool provenance and establish baselines

**Files:**
- Modify: `docs/specs/safe-rust-build-caching.md`

- [ ] **Step 1: Reverify the pinned experiment binary**

Run SHA-256, `codesign -dv`, `otool -L`, and `kache --version` against the
disposable 0.10.0 binary. Abort if the checksum differs from the documented
arm64 value or a non-system dynamic library appears.

- [ ] **Step 2: Record filesystem capacity and exact temporary paths**

Create one `mktemp -d /tmp/kanna-kache-full.XXXXXX` experiment root. Record
`df -k` before every build. Stop before a build if available space falls below
25 GiB.

- [ ] **Step 3: Verify source inputs are byte-identical**

Compare `git archive HEAD`-derived source trees by hashing tracked files and
assert no differences. Do not use or modify another registered Kanna worktree.

### Task 3: Run the full desktop cross-worktree benchmark

**Files:**
- Modify: `docs/specs/safe-rust-build-caching.md`

- [ ] **Step 1: Build root A cold**

Run `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml` from source
root A with private target/build directories, the dispatcher, local-only kache,
executable caching off, and restore verification always. Capture time, Cargo
output, classification log, cache report, allocated/apparent sizes, and volume
free space.

- [ ] **Step 2: Build root B as an identical cold sibling**

Repeat from root B with new private target/build directories and the same kache
store. Capture the same measurements and verify root B never reads a final
artifact from root A.

- [ ] **Step 3: Verify classification and output privacy**

Assert every source under each Kanna archive was direct-rustc, every kache
classification was outside that root, root A and B final binaries have distinct
paths/inodes, and no final path is inside the shared cache.

- [ ] **Step 4: Measure physical and apparent storage**

Report private target/build apparent size, kache physical/logical size, APFS
free-space delta, cache restored bytes, and reflink/copy restore percentages.
Do not infer unique physical bytes by summing `du` over reflinked files.

### Task 4: Test warm edits and key separation

**Files:**
- Modify: `docs/specs/safe-rust-build-caching.md`

- [ ] **Step 1: Measure a warm no-op build in root B**

Expected: Cargo reports a no-op or near-no-op; no incorrect cache activity.

- [ ] **Step 2: Make one reversible Kanna Rust source edit in disposable root B**

Append `// kache canary edit` to
`crates/runtime-defaults/src/lib.rs`, build the affected desktop graph, then
restore the original file from root A and verify the two files are identical.
Assert the workspace unit used direct rustc and retained an incremental
directory.

- [ ] **Step 3: Test key separation**

Build a small affected package with a changed `RUSTFLAGS` value and with the
explicit `aarch64-apple-darwin` target. Assert incompatible prior entries are
not reported as hits and all commands succeed.

### Task 5: Evaluate and document the result

**Files:**
- Modify: `docs/specs/safe-rust-build-caching.md`

- [ ] **Step 1: Compare against acceptance gates**

Evaluate correctness, at least 30% sibling wall-time improvement, physical
storage reduction, no more than 10% workspace edit regression, private finals,
and direct-rustc fallback. Mark unmeasured gates explicitly rather than
inferring success.

- [ ] **Step 2: Update the recommendation**

Choose one outcome: proceed to an opt-in production canary, revise and retest,
or reject kache. Include exact measurements and limitations.

- [ ] **Step 3: Verify repository state and documentation**

Run:

```bash
zsh scripts/experiments/test-kache-rustc-wrapper.zsh
git diff --check
git status --short
```

Expected: wrapper tests pass, documentation has no whitespace errors, and only
the experimental wrapper/test plus investigation documents are changed.

- [ ] **Step 4: Remove disposable build data**

After results are captured, delete only the exact `mktemp` experiment root and
confirm volume free space is reclaimed. Preserve the small wrapper and test as
the reproducible proof of concept. Do not commit, push, or advance the Kanna
stage.
