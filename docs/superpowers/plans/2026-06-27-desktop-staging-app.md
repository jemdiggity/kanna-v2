# Desktop Staging App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a first-class signed and notarized `Kanna Staging.app` that can be installed beside production and points at staging cloud services and a separate updater channel.

**Architecture:** Reuse the existing Bazel/Tauri release workflow, but generate a staging Tauri config with a separate product name, bundle id, updater endpoint, and release targets. Keep runtime cloud selection at the app boundary by deriving `KANNA_CLOUD_ENV=staging` from the bundled identifier only in non-debug builds. Extend `kd release ship` with `--staging` while keeping production behavior unchanged.

**Tech Stack:** Bazel, Tauri v2, Rust, TypeScript, `kd`, GitHub Releases, macOS code signing/notarization.

---

### Task 1: Verify Staging Bundle Identity

**Files:**
- Modify: `apps/desktop/src-tauri/BUILD.bazel`
- Modify: `BUILD.bazel`
- Test: `apps/desktop/src/ship.test.ts`

- [ ] **Step 1: Confirm tests assert a separate staging identity**

Use `apps/desktop/src/ship.test.ts` to assert:

```ts
expect(rootBuild).toContain('bundle_id = "build.kanna.staging"');
expect(rootBuild).toContain('product_name = "Kanna Staging"');
expect(rootBuild).toContain('output_name = "release/staging/arm64/Kanna Staging.app"');
expect(rootBuild).toContain('output_name = "release/staging/x86_64/Kanna Staging.app"');
```

- [ ] **Step 2: Verify test behavior**

Run: `pnpm --dir apps/desktop test -- ship.test.ts`

Expected: the release bundle naming tests pass.

### Task 2: Verify Staging Release Command

**Files:**
- Modify: `tools/kd/src/runtime/release.ts`
- Modify: `tools/kd/src/tasks/registry.ts`
- Modify: `tools/kd/src/cli.ts`
- Test: `tools/kd/tests/release.test.ts`
- Test: `tools/kd/tests/cli.test.ts`

- [ ] **Step 1: Confirm command parsing and runtime tests cover staging**

Use `tools/kd/tests/release.test.ts` to assert staging targets, artifact names, updater manifest name, and mutable GitHub release upload:

```ts
expect(bazelTargetForLabel("arm64", true, "staging")).toBe("//:kanna_signed_dmg_staging_arm64");
expect(releaseAssetName("1.2.3", "arm64", "staging")).toBe("Kanna_Staging_1.2.3_arm64.dmg");
expect(updaterAssetName("1.2.3", "arm64", "staging")).toBe("Kanna_Staging_1.2.3_arm64.app.tar.gz");
```

- [ ] **Step 2: Verify test behavior**

Run: `pnpm --dir tools/kd test -- release.test.ts cli.test.ts`

Expected: staging and production release command tests pass.

### Task 3: Verify Runtime Cloud Selection

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/fs.rs`
- Modify: `apps/desktop/src/services/desktopRelayTerminal.ts`
- Test: `apps/desktop/src/services/desktopRelayTerminal.test.ts`

- [ ] **Step 1: Confirm staging desktop resolves staging cloud services**

Use `desktopRelayTerminal.test.ts` to assert:

```ts
expect(resolveDesktopCloudTransportUrlFromEnv({ KANNA_CLOUD_ENV: "staging" }, { dev: false }))
  .toBe("wss://relay-staging.kanna.build");
```

Use `apps/desktop/src-tauri/src/commands/fs.rs` to return `staging` for bundled identifier `build.kanna.staging` in release builds.

- [ ] **Step 2: Verify test behavior**

Run: `pnpm --dir apps/desktop test -- desktopRelayTerminal.test.ts`

Expected: staging cloud transport and production fallback tests pass.

### Task 4: Full Validation

**Files:**
- No new files.

- [ ] **Step 1: Run focused validation**

Run:

```bash
pnpm --dir apps/desktop test -- ship.test.ts desktopRelayTerminal.test.ts
pnpm --dir tools/kd test -- release.test.ts cli.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Inspect final diff**

Run: `git diff --stat && git diff --check`

Expected: the diff is scoped to staging desktop release support and has no whitespace errors.
