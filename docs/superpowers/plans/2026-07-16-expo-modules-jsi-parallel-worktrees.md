# ExpoModulesJSI Parallel Worktree Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make overlapping iOS builds from separate Kanna worktrees incapable of mutating the same ExpoModulesJSI build state.

**Architecture:** Return pnpm to its default project-local virtual store so each checkout resolves a distinct physical ExpoModulesJSI package directory while retaining content-addressable dependency deduplication. Remove Kanna's sequential shared-root cleanup patch and prove both concurrent isolation and sequential stale-root safety with the real Expo prebuild, CocoaPods, SwiftPM, and Xcode toolchain.

**Tech Stack:** pnpm 11, Expo SDK 57, CocoaPods, SwiftPM, Xcode, TypeScript, Vitest

---

### Task 1: Specify overlapping build isolation

**Files:**
- Modify: `apps/mobile/e2e/expoModulesJsiWorktreeCache.integration.test.ts`
- Modify: `apps/mobile/package.json`

- [ ] Change the integration scenario to install and prebuild two archived checkouts, resolve both ExpoModulesJSI package roots, and assert the roots are distinct.
- [ ] Start both `xcodebuild` processes before awaiting either result so the native builds overlap.
- [ ] Inspect `apple/.DerivedData/**/common-args.resp` beneath both package roots and assert each response set contains its own checkout root and excludes the other checkout root.
- [ ] Keep the package script as the canonical one-shot integration command with a single Vitest worker.
- [ ] Run `pnpm --dir apps/mobile test:integration:expo-modules-jsi-worktrees` and confirm it fails while `enableGlobalVirtualStore` still resolves one shared package directory.

### Task 2: Eliminate the shared physical package directory

**Files:**
- Modify: `pnpm-workspace.yaml`
- Modify: `patches/expo-modules-jsi@57.0.3.patch`
- Modify: `pnpm-lock.yaml`

- [ ] Set `enableGlobalVirtualStore: false` so each repository checkout uses its own `node_modules/.pnpm` virtual store.
- [ ] Remove the `build-xcframework.sh` build-context cleanup diff from `patches/expo-modules-jsi@57.0.3.patch`, leaving only the `Swift.abs` SDK compatibility change.
- [ ] Run `pnpm install --lockfile-only` to update the patched dependency hash without rebuilding unrelated packages.
- [ ] Run `pnpm --dir apps/mobile test:integration:expo-modules-jsi-worktrees` and confirm both overlapping builds pass and use distinct package roots.

### Task 3: Verify the SDK revision

**Files:**
- Review: all modified files

- [ ] Run `pnpm --dir apps/mobile exec expo install --check`.
- [ ] Run `pnpm --dir apps/mobile typecheck`.
- [ ] Run Expo Doctor with `pnpm --dir apps/mobile exec expo-doctor` and record only the pre-existing root lockfile/Bun lockfile warning if present.
- [ ] Run `pnpm test`.
- [ ] Run `cd crates/daemon && cargo test -- --test-threads=1`.
- [ ] Re-run `pnpm --dir apps/mobile test:integration:expo-modules-jsi-worktrees` as fresh final evidence.
- [ ] Review `git diff`, confirm no generated native directories or timeout/payload-recovery workaround entered the change, and report the human-only physical-device launch check from the parent SDK upgrade.
