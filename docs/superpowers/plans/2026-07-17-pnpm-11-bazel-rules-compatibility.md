# pnpm 11 Bazel Rules Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Kanna's Bazel release graph accept the pnpm 11 patched-dependency lockfile and complete a signed staging patch dry-run.

**Architecture:** Keep pnpm 11's `pnpm-lock.yaml` and `pnpm-workspace.yaml` as the dependency source of truth. Upgrade the Bazel lock translator at its direct module boundary, regenerate Bazel's module lock, and prove compatibility with the original failing repository evaluation before running the full release build.

**Tech Stack:** Bazel 9/Bzlmod, `aspect_rules_js`, pnpm 11, `kd release ship`, Tauri updater signing

---

### Task 1: Preserve the failing compatibility reproduction

**Files:**
- Test: `pnpm-lock.yaml`
- Test: `pnpm-workspace.yaml`
- Test: `MODULE.bazel`

- [ ] **Step 1: Confirm the worktree starts from the documented state**

Run:

```bash
git status --short
rg -n 'aspect_rules_js|packageManager|patchedDependencies' MODULE.bazel package.json pnpm-lock.yaml pnpm-workspace.yaml
```

Expected: only the implementation-plan document is uncommitted; `aspect_rules_js` is `3.0.3`, `packageManager` is `pnpm@11.0.8`, and both pnpm files declare the ExpoModulesJSI patch metadata.

- [ ] **Step 2: Run the focused Bazel evaluation and verify the regression is red**

Run:

```bash
bazel query '@kanna_npm//...'
```

Expected: exit nonzero in `npm_translate_lock_helpers.bzl`, with `'string' value has no field or method 'get'` while reading `pnpm_patch.get("path")`.

### Task 2: Upgrade the lock translator and regenerate Bzlmod state

**Files:**
- Modify: `MODULE.bazel:14`
- Modify: `MODULE.bazel.lock`

- [ ] **Step 1: Upgrade the direct JavaScript rules dependency**

Change this line in `MODULE.bazel`:

```starlark
bazel_dep(name = "aspect_rules_js", version = "3.0.3")
```

to:

```starlark
bazel_dep(name = "aspect_rules_js", version = "3.2.3")
```

- [ ] **Step 2: Regenerate the Bazel module lock through repository evaluation**

Run:

```bash
bazel query '@kanna_npm//...'
```

Expected: Bazel resolves `aspect_rules_js 3.2.3`, updates `MODULE.bazel.lock`, successfully translates the pnpm 11 patch metadata, and prints targets from `@kanna_npm`.

- [ ] **Step 3: Verify the generated change stays within scope**

Run:

```bash
git status --short
git diff --check
git diff --stat
git diff -- MODULE.bazel MODULE.bazel.lock
```

Expected: implementation changes are limited to the direct version in `MODULE.bazel` and Bazel-generated module resolution changes in `MODULE.bazel.lock`; pnpm and application files are unchanged.

- [ ] **Step 4: Verify the focused regression remains green from a fresh Bazel evaluation**

Run:

```bash
bazel query '@kanna_npm//...'
```

Expected: exit zero with no `patchedDependencies` type error.

### Task 3: Validate and commit the release-build compatibility fix

**Files:**
- Verify: `MODULE.bazel`
- Verify: `MODULE.bazel.lock`
- Verify: `docs/superpowers/specs/2026-07-17-pnpm-11-bazel-rules-compatibility-design.md`
- Verify: `docs/superpowers/plans/2026-07-17-pnpm-11-bazel-rules-compatibility.md`

- [ ] **Step 1: Run Bazel analysis for both release graphs**

Run:

```bash
bazel build --nobuild \
  //:kanna_dmg_release_arm64 \
  //:kanna_dmg_release_x86_64
```

Expected: exit zero, demonstrating that `aspect_rules_js 3.2.3` does not introduce an analysis-time incompatibility in either macOS release graph. A repository-wide `bazel query '//...'` is intentionally not used because the existing `.bazelignore` omits some installed workspace `node_modules` directories, allowing Bazel to traverse pnpm workspace symlinks under synthetic package paths that are not valid lockfile importers.

- [ ] **Step 2: Review the complete hotfix diff**

Run:

```bash
git diff --check
git status --short
git diff -- MODULE.bazel MODULE.bazel.lock
```

Expected: no whitespace errors or unrelated changes.

- [ ] **Step 3: Commit the compatibility fix**

Run:

```bash
git add MODULE.bazel MODULE.bazel.lock docs/superpowers/plans/2026-07-17-pnpm-11-bazel-rules-compatibility.md
git commit -m "build: support pnpm 11 patched dependencies"
```

Expected: commit succeeds and `git status --short` is empty, satisfying the ship script's clean-worktree prerequisite.

### Task 4: Re-run the signed staging patch dry-run

**Files:**
- Generated artifact directory: `.build/release/staging/`

- [ ] **Step 1: Reconfirm release prerequisites after the fix**

Run:

```bash
git fetch origin --tags
git status --short
git rev-list --left-right --count HEAD...origin/main
security find-identity -v -p codesigning
rustup target list --installed
```

Expected: clean worktree; the branch is allowed to be ahead of `origin/main` only by the local design and compatibility commits; a Developer ID Application identity exists; both `aarch64-apple-darwin` and `x86_64-apple-darwin` are installed.

- [ ] **Step 2: Run the requested staging patch dry-run with the standard signing key**

Run:

```bash
env \
  KANNA_UPDATER_PUBKEY="$(tr -d '\n' < "$HOME/.tauri/kanna-updater.key.pub")" \
  TAURI_PRIVATE_KEY_PATH="$HOME/.tauri/kanna-updater.key" \
  TAURI_PRIVATE_KEY_PASSWORD='' \
  ./kd release ship --staging --patch --dry-run
```

Expected: exit zero after building and signing staging version `0.0.69-staging.1`; notarization, GitHub publishing, branch renaming, and pushing are skipped.

- [ ] **Step 3: Verify and report release artifacts**

Run:

```bash
find .build/release/staging -type f -maxdepth 4 -print | sort
git status --short
```

Expected: the command lists the generated universal or architecture-specific DMGs, updater bundles, signatures, and `latest-staging.json` produced by the dry-run; the tracked worktree remains clean.
