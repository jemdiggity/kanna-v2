# Kanache Runtime Eligibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the opt-in Kanache Rust cache run only on macOS outside CI while keeping its unit tests portable across platforms.

**Architecture:** Add one pure eligibility resolver beside the existing cache-mode parser, then have every runtime entry point call it with injected environment and platform data. Production defaults the optional platform input to `process.platform`; tests explicitly select macOS or Linux so host operating systems cannot change test meaning.

**Tech Stack:** TypeScript, Node.js, Vitest, pnpm

---

### Task 1: Specify the eligibility matrix

**Files:**
- Modify: `tools/kd/tests/rust-cache-policy.test.ts`
- Modify: `tools/kd/src/runtime/rust-cache-policy.ts`

- [ ] **Step 1: Write the failing policy tests**

Import `resolveRustCacheEligibility` and add a table-driven test covering enabled macOS shells, blank CI, nonblank CI, non-macOS hosts, disabled mode, and invalid-mode precedence:

```ts
it.each([
  [{ mode: "on", platform: "darwin", ci: undefined }, { enabled: true }],
  [{ mode: "kanache", platform: "darwin", ci: "  " }, { enabled: true }],
  [
    { mode: "on", platform: "darwin", ci: "false" },
    { enabled: false, category: "disabled-in-ci" }
  ],
  [
    { mode: "on", platform: "linux", ci: undefined },
    { enabled: false, category: "unsupported-platform" }
  ],
  [
    { mode: "off", platform: "linux", ci: "true" },
    { enabled: false, category: "disabled" }
  ]
])("resolves runtime eligibility for %o", (input, expected) => {
  expect(resolveRustCacheEligibility(input)).toEqual(expected);
});

expect(
  resolveRustCacheEligibility({ mode: "mystery", platform: "linux", ci: "true" })
).toEqual({
  enabled: false,
  category: "invalid-mode",
  warning: "Unknown KANNA_RUST_CACHE value \"mystery\"; cache disabled."
});
```

- [ ] **Step 2: Run the policy test to verify it fails**

Run: `pnpm --dir tools/kd exec vitest run tests/rust-cache-policy.test.ts --maxWorkers=2`

Expected: FAIL because `resolveRustCacheEligibility` is not exported.

- [ ] **Step 3: Implement the pure resolver**

Add the discriminated union and resolver after `parseRustCacheMode`:

```ts
export type RustCacheEligibility =
  | { enabled: true }
  | {
      enabled: false;
      category: "disabled" | "invalid-mode" | "unsupported-platform" | "disabled-in-ci";
      warning?: string;
    };

export function resolveRustCacheEligibility(input: {
  mode: string | undefined;
  platform: NodeJS.Platform;
  ci: string | undefined;
}): RustCacheEligibility {
  const mode = parseRustCacheMode(input.mode);
  if (!mode.enabled) {
    return mode.warning
      ? { enabled: false, category: "invalid-mode", warning: mode.warning }
      : { enabled: false, category: "disabled" };
  }
  if (input.platform !== "darwin") {
    return { enabled: false, category: "unsupported-platform" };
  }
  if (input.ci?.trim()) {
    return { enabled: false, category: "disabled-in-ci" };
  }
  return { enabled: true };
}
```

- [ ] **Step 4: Run the policy test to verify it passes**

Run: `pnpm --dir tools/kd exec vitest run tests/rust-cache-policy.test.ts --maxWorkers=2`

Expected: PASS.

- [ ] **Step 5: Commit the policy**

```bash
git add tools/kd/src/runtime/rust-cache-policy.ts tools/kd/tests/rust-cache-policy.test.ts
git commit -m "fix(kd): centralize Kanache runtime eligibility"
```

### Task 2: Apply eligibility to the runtime boundary

**Files:**
- Modify: `tools/kd/tests/rust-cache.test.ts`
- Modify: `tools/kd/tests/rust-cache.integration.test.ts`
- Modify: `tools/kd/src/runtime/rust-cache.ts`

- [ ] **Step 1: Write the failing runtime tests**

Extend `fakeRuntimeInput` with an explicit macOS platform and add assertions that CI disables warm, build-start, record, and status without invoking external tools, while build-start still revokes the local success marker:

Insert the explicit platform between the existing `env` and `commit` fields:

```ts
env: { KANNA_RUST_CACHE: "on" },
platform: "darwin",
commit: "abc",
```

Also make the macOS integration fixture explicit about the non-CI path so a parent CI process cannot change the behavior under test:

```ts
const env = {
  ...process.env,
  CI: "",
  KANNA_RUST_CACHE: "on",
  FAKE_KANACHE_LOG: log
};
```

```ts
it("disables every Kanache entry point in CI without running tools", async () => {
  const calls: string[] = [];
  const cache = fakeRuntimeInput({ calls });
  cache.env.CI = "false";
  const marker = join(cache.repoRoot, ".build", "cargo-build", ".kanache-success");
  mkdirSync(join(marker, ".."), { recursive: true });
  writeFileSync(marker, "old-success");

  expect(await warmRustCache(cache)).toMatchObject({ category: "disabled-in-ci" });
  expect(await beginRustCacheBuild(cache)).toMatchObject({ category: "disabled-in-ci" });
  expect(existsSync(marker)).toBe(false);
  expect(await recordRustCache(cache, "all")).toMatchObject({
    category: "disabled-in-ci"
  });
  expect(await getRustCacheStatus(cache)).toMatchObject({ enabled: false });
  expect(calls).toEqual([]);
});
```

- [ ] **Step 2: Run the runtime test to verify it fails**

Run: `pnpm --dir tools/kd exec vitest run tests/rust-cache.test.ts --maxWorkers=2`

Expected: FAIL because `RustCacheRuntimeInput` has no injected platform and CI is not checked.

- [ ] **Step 3: Implement the shared runtime gate**

Add `platform?: NodeJS.Platform` to `RustCacheRuntimeInput`, import the resolver, and centralize production defaults:

```ts
function rustCacheEligibility(input: RustCacheRuntimeInput) {
  return resolveRustCacheEligibility({
    mode: input.env.KANNA_RUST_CACHE,
    platform: input.platform ?? process.platform,
    ci: input.env.CI
  });
}
```

At the start of `warmRustCache`, `beginRustCacheBuild`, and `recordRustCache`, replace separate mode/platform branches with:

```ts
const eligibility = rustCacheEligibility(input);
if (!eligibility.enabled) {
  if (eligibility.warning) console.warn(`[kd] ${eligibility.warning}`);
  return warmMiss(input, eligibility.category, eligibility.warning);
}
```

Use `recordFailure` instead of `warmMiss` in the record paths. Keep `clearRustCacheSuccessMarker(input.repoRoot)` before the build-start eligibility check. In `getRustCacheStatus`, return `enabled: eligibility.enabled` and preserve invalid-mode warnings.

- [ ] **Step 4: Run the runtime tests to verify they pass**

Run: `pnpm --dir tools/kd exec vitest run tests/rust-cache-policy.test.ts tests/rust-cache.test.ts --maxWorkers=2`

Expected: PASS on macOS and Linux because runtime fixtures inject their intended platform.

- [ ] **Step 5: Commit the runtime integration**

```bash
git add tools/kd/src/runtime/rust-cache.ts tools/kd/tests/rust-cache.test.ts
git commit -m "fix(kd): disable Kanache in CI"
```

### Task 3: Verify the branch and merge readiness

**Files:**
- Verify: `tools/kd/src/runtime/rust-cache-policy.ts`
- Verify: `tools/kd/src/runtime/rust-cache.ts`
- Verify: `tools/kd/tests/rust-cache-policy.test.ts`
- Verify: `tools/kd/tests/rust-cache.test.ts`

- [ ] **Step 1: Run the focused Kanache suite**

Run:

```bash
pnpm --dir tools/kd exec vitest run tests/rust-cache-policy.test.ts tests/rust-cache.test.ts tests/rust-cache.integration.test.ts tests/rust-test.test.ts tests/kanna-config.test.ts --maxWorkers=2
```

Expected: all focused tests pass; the live integration suite may be explicitly skipped outside its configured environment.

- [ ] **Step 2: Run kd type checking**

Run: `pnpm --dir tools/kd typecheck`

Expected: PASS with no TypeScript diagnostics.

- [ ] **Step 3: Run canonical JavaScript verification**

Run: `pnpm test`

Expected: PASS, including the four lifecycle tests that previously returned `unsupported-platform` on Linux CI.

- [ ] **Step 4: Run canonical Rust verification**

Run: `./kd test rust`

Expected: PASS, or reproduce only a documented origin/main baseline failure without a changed Rust code path.

- [ ] **Step 5: Inspect the final patch**

Run:

```bash
git diff origin/main...HEAD --check
git status --short --branch
```

Expected: no whitespace errors and only the intended #870 history plus the eligibility changes.
