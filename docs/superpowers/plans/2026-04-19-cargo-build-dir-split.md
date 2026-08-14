# Cargo Build Dir Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Kanna's Rust build layout so Cargo intermediates are shared under `~/Library/Caches/kanna/rust-build` while final artifacts remain checkout-local in `.build`.

**Architecture:** Move shared compile reuse from the current worktree-only `CARGO_TARGET_DIR` experiment to Cargo's stable `build.build-dir` support. Keep `build.target-dir = ".build"` for private final outputs, remove shared-final-artifact assumptions from dev and sidecar scripts, and update tests plus cleanup behavior to reflect the new steady state.

**Tech Stack:** Cargo config, Bash scripts, pnpm/Vitest, Tauri desktop build workflow

---

### Task 1: Switch Cargo to Shared `build-dir` and Local `target-dir`

**Files:**
- Modify: `.cargo/config.toml`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write the failing config assertions in docs-facing guidance**

Update `AGENTS.md` so the steady-state rule says Cargo should use shared intermediates and local final outputs, not shared final artifact paths:

```md
- Rust final build artifacts stay in checkout-local `.build/`.
- Cargo intermediates should be shared through `build.build-dir` under `~/Library/Caches/kanna/rust-build`.
- Do not reintroduce shared `CARGO_TARGET_DIR` as the source of final binaries.
```

- [ ] **Step 2: Update Cargo config to use the split**

Replace `.cargo/config.toml` contents with:

```toml
[build]
target-dir = ".build"
build-dir = "/Users/${USER}/Library/Caches/kanna/rust-build"
```

If Cargo does not expand `${USER}` in config, use the home-relative syntax Cargo supports for config paths instead of hardcoding a username.

- [ ] **Step 3: Verify the config resolves**

Run: `cargo config get build.target-dir && cargo config get build.build-dir`
Expected: `build.target-dir` resolves to `.build` and `build.build-dir` resolves to a shared path under `~/Library/Caches/kanna/rust-build`

- [ ] **Step 4: Commit**

```bash
git add .cargo/config.toml AGENTS.md
git commit -m "build: split cargo build and target dirs"
```

### Task 2: Remove Shared `CARGO_TARGET_DIR` From Dev Workflow

**Files:**
- Modify: `scripts/dev.sh`
- Modify: `scripts/dev.sh.test.sh`

- [ ] **Step 1: Write the failing shell test for worktree env export**

Update `scripts/dev.sh.test.sh` so worktree sessions assert:

```bash
assert_tmux_log_contains "CARGO_BUILD_BUILD_DIR=$HOME/Library/Caches/kanna/rust-build"
if grep -Fq "CARGO_TARGET_DIR=" "$TMUX_LOG"; then
  printf 'expected worktree start not to export shared CARGO_TARGET_DIR\n' >&2
  exit 1
fi
```

Also keep the non-worktree case asserting that no unwanted Cargo env is exported unless explicitly intended.

- [ ] **Step 2: Run the dev script test to verify it fails**

Run: `bash scripts/dev.sh.test.sh`
Expected: FAIL because `scripts/dev.sh` still exports `CARGO_TARGET_DIR`

- [ ] **Step 3: Update the script to export shared `CARGO_BUILD_BUILD_DIR` instead**

In `scripts/dev.sh`:

```bash
tmux_env_args() {
  local key
  for key in \
    KANNA_WORKTREE \
    KANNA_BUILD_BRANCH \
    KANNA_BUILD_COMMIT \
    KANNA_BUILD_WORKTREE \
    KANNA_DB_NAME \
    KANNA_DB_PATH \
    KANNA_DAEMON_DIR \
    KANNA_DEV_PORT \
    KANNA_APPIUM_PORT \
    TAURI_WEBDRIVER_PORT \
    CARGO_BUILD_BUILD_DIR; do
    if [ -n "${!key:-}" ]; then
      printf '%s\0%s\0' "-e" "${key}=${!key}"
    fi
  done
}
```

and replace the worktree export block with:

```bash
if [ -n "${KANNA_WORKTREE:-}" ]; then
  export CARGO_BUILD_BUILD_DIR="$HOME/Library/Caches/kanna/rust-build"
fi
```

- [ ] **Step 4: Run the dev script test to verify it passes**

Run: `bash scripts/dev.sh.test.sh`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dev.sh scripts/dev.sh.test.sh
git commit -m "build: share cargo intermediates in dev sessions"
```

### Task 3: Simplify Sidecar Builds Back To Local `.build`

**Files:**
- Modify: `scripts/build-sidecars.sh`
- Modify: `scripts/build-sidecars.sh.test.sh`
- Modify: `scripts/stage-sidecars.sh`
- Modify: `scripts/stage-sidecars.sh.test.sh`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src/sidecars.test.ts`

- [ ] **Step 1: Write the failing sidecar script tests**

Update `scripts/build-sidecars.sh.test.sh` so it expects builds to use the shared intermediate env but local final outputs:

```bash
EXPECTED_BUILD_DIR="$FIXTURE_REPO/.build"
if grep -Fq "target_dir=$TMPDIR_ROOT/shared-target" "$CARGO_LOG"; then
  printf 'expected sidecar build not to inherit shared CARGO_TARGET_DIR\n' >&2
  exit 1
fi
if ! grep -Fq "target_dir=$EXPECTED_BUILD_DIR" "$CARGO_LOG"; then
  printf 'expected sidecar build outputs in %s\n' "$EXPECTED_BUILD_DIR" >&2
  exit 1
fi
```

Update `scripts/stage-sidecars.sh.test.sh` so staging succeeds from local `.build` without an explicit sidecar-only target dir override.

- [ ] **Step 2: Run the sidecar tests to verify they fail**

Run: `bash scripts/build-sidecars.sh.test.sh && bash scripts/stage-sidecars.sh.test.sh`
Expected: FAIL because sidecar scripts still use `.build/sidecar-target`

- [ ] **Step 3: Remove the sidecar-only target-dir override**

Update `scripts/build-sidecars.sh` so it runs plain Cargo builds against the repo default config and then stages from local `.build`:

```bash
cargo build --manifest-path "$ROOT/crates/daemon/Cargo.toml" "${build_args[@]}"
cargo build --manifest-path "$ROOT/crates/kanna-cli/Cargo.toml" "${build_args[@]}"
cargo build --manifest-path "$ROOT/crates/kanna-server/Cargo.toml" "${build_args[@]}"
cargo build --manifest-path "$ROOT/packages/terminal-recovery/Cargo.toml" "${build_args[@]}"

stage_args=(--target "$TARGET")
if [[ "$PROFILE" = "release" ]]; then
  stage_args+=(--release)
fi

"$ROOT/scripts/stage-sidecars.sh" "${stage_args[@]}"
```

Update `scripts/stage-sidecars.sh` so the default source stays `.build`, `--build-dir` remains optional for tests or special callers, and host-target fallback behavior still works for older layouts if needed.

- [ ] **Step 4: Update the packaging contract test**

Keep `apps/desktop/src/sidecars.test.ts` asserting:

```ts
expect(desktopPkg.scripts?.["build:sidecars"]).toBe("../../scripts/build-sidecars.sh");
expect(buildSidecarsScript).not.toContain(".build/sidecar-target");
expect(stageSidecarsScript).toContain("BUILD_DIR=\"$ROOT/.build\"");
```

- [ ] **Step 5: Run sidecar tests and packaging checks**

Run: `bash scripts/build-sidecars.sh.test.sh && bash scripts/stage-sidecars.sh.test.sh && pnpm --dir apps/desktop test -- src/sidecars.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/build-sidecars.sh scripts/build-sidecars.sh.test.sh scripts/stage-sidecars.sh scripts/stage-sidecars.sh.test.sh apps/desktop/package.json apps/desktop/src/sidecars.test.ts
git commit -m "build: use local sidecar outputs with shared cargo cache"
```

### Task 4: Keep Cleanup and Verification Aligned With Shared Cache

**Files:**
- Modify: `scripts/clean.sh`
- Modify: `scripts/clean.sh.test.sh`

- [ ] **Step 1: Write the failing cleanup test**

Extend `scripts/clean.sh.test.sh` with a shared-cache fixture and assert normal cleanup does not remove it:

```bash
SHARED_CACHE="$TMPDIR_ROOT/home/Library/Caches/kanna/rust-build"
mkdir -p "$SHARED_CACHE"
printf 'shared cache\n' > "$SHARED_CACHE/artifact"

bash "$SCRIPT"

if [ ! -e "$SHARED_CACHE/artifact" ]; then
  printf 'expected clean.sh to keep shared rust build cache by default\n' >&2
  exit 1
fi
```

- [ ] **Step 2: Run the cleanup test to verify it fails only if cleanup is too aggressive**

Run: `bash scripts/clean.sh.test.sh`
Expected: PASS if current behavior already preserves the shared cache; otherwise FAIL and identify the regression

- [ ] **Step 3: Update cleanup messaging if needed**

If the test reveals ambiguity, update `scripts/clean.sh` comments/help text to clarify:

```bash
# Clean checkout-local build outputs. Shared Cargo intermediates under
# ~/Library/Caches/kanna/rust-build are intentionally preserved.
```

- [ ] **Step 4: Re-run the cleanup test**

Run: `bash scripts/clean.sh.test.sh`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/clean.sh scripts/clean.sh.test.sh
git commit -m "docs: preserve shared cargo cache during cleanup"
```

### Task 5: End-to-End Verification

**Files:**
- Verify only: `.cargo/config.toml`, `scripts/dev.sh`, `scripts/build-sidecars.sh`, `scripts/stage-sidecars.sh`, `apps/desktop/package.json`

- [ ] **Step 1: Run TypeScript verification**

Run: `pnpm --dir apps/desktop exec tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Verify Cargo config resolution**

Run: `cargo config get build.target-dir && cargo config get build.build-dir`
Expected: `.build` target dir and shared `~/Library/Caches/kanna/rust-build` build dir

- [ ] **Step 3: Start a worktree dev session**

Run: `./scripts/dev.sh restart`
Expected: tmux session starts successfully and desktop startup proceeds without shared final-binary assumptions

- [ ] **Step 4: Inspect the startup log**

Run: `./scripts/dev.sh log`
Expected: sidecars build and the app starts without missing binary errors

- [ ] **Step 5: Commit**

```bash
git add .cargo/config.toml scripts/dev.sh scripts/dev.sh.test.sh scripts/build-sidecars.sh scripts/build-sidecars.sh.test.sh scripts/stage-sidecars.sh scripts/stage-sidecars.sh.test.sh scripts/clean.sh scripts/clean.sh.test.sh apps/desktop/package.json apps/desktop/src/sidecars.test.ts AGENTS.md
git commit -m "build: adopt cargo build-dir split for kanna"
```
