# Mobile E2E Dev Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local mobile E2E and preflight commands target `build.kanna.app.dev` by default and route the selected client to the current workspace's Metro port.

**Architecture:** Keep native identity resolution centralized in `resolveRequiredMobileE2eEnv`. Default its unset environment to dev and expose the configured environment-specific scheme. The simulator launcher uses that scheme to deliver the dynamic workspace Metro URL to the same native client Appium launched.

**Tech Stack:** TypeScript, Expo configuration, Vitest, Appium/XCUITest

---

### Task 1: Default Mobile E2E to the Development Identity

**Files:**
- Modify: `apps/mobile/e2e/helpers/env.test.ts`
- Modify: `apps/mobile/e2e/helpers/env.ts`

- [x] **Step 1: Write the failing default-identity regression test**

Replace the existing generic parsing assertion with a test that specifies the complete unset-environment behavior:

```ts
it("defaults local E2E to the development native identity", () => {
  expect(
    resolveRequiredMobileE2eEnv({
      KANNA_APPIUM_PORT: "4723",
      KANNA_MOBILE_PORT: "1430",
      KANNA_E2E_DESKTOP_SERVER_URL: "http://127.0.0.1:48120"
    })
  ).toMatchObject({
    appEnv: "dev",
    appiumPort: 4723,
    metroPort: 1430,
    bundleId: "build.kanna.app.dev",
    updatedWdaBundleId: "build.kanna.app.dev.webdriveragentrunner",
    desktopServerUrl: "http://127.0.0.1:48120"
  });
});
```

Also update the physical-device default-signing test to expect the same development WDA identity:

```ts
expect(result).toMatchObject({
  xcodeOrgId: "GY3LFAA59P",
  xcodeSigningId: "Apple Development",
  updatedWdaBundleId: "build.kanna.app.dev.webdriveragentrunner"
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/helpers/env.test.ts
```

Expected: FAIL because the resolver returns `appEnv: "prod"`, `bundleId: "build.kanna.app"`, and the production WDA bundle ID when `KANNA_APP_ENV` is unset.

- [x] **Step 3: Implement the minimal resolver fix**

In `apps/mobile/e2e/helpers/env.ts`, change the fallback only:

```ts
const appEnv = env.KANNA_APP_ENV?.trim() || "dev";
```

Do not change the explicit `KANNA_IOS_BUNDLE_ID` precedence or the staging environment test.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/helpers/env.test.ts e2e/run.test.ts src/mobileAppConfig.test.ts
```

Expected: all tests pass, including the explicit staging identity and hybrid-mode assertions.

- [x] **Step 5: Run mobile verification**

Run:

```bash
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile test
```

Expected: both commands exit successfully.

- [x] **Step 6: Run the native relay path when the simulator environment is available**

Run:

```bash
pnpm --dir apps/mobile run test:e2e:relay
```

Expected: the installed-app check targets `build.kanna.app.dev`, then the relay flow exercises the task activity sequence. If another external prerequisite blocks execution, capture the exact error after confirming it is no longer searching for `build.kanna.app`.

- [x] **Step 7: Inspect the final diff without committing**

Run:

```bash
git diff --check
git diff -- apps/mobile/e2e/helpers/env.ts apps/mobile/e2e/helpers/env.test.ts
```

Expected: only the development fallback and its regression expectations change. Do not commit in this manual Kanna stage; the workflow handles committing after user review.

### Task 2: Route the Selected Development Client to Workspace Metro

**Files:**
- Modify: `apps/mobile/e2e/helpers/env.test.ts`
- Modify: `apps/mobile/e2e/helpers/env.ts`
- Modify: `apps/mobile/e2e/helpers/simulator.test.ts`
- Modify: `apps/mobile/e2e/helpers/simulator.ts`
- Modify: `apps/mobile/e2e/run.ts`

- [x] **Step 1: Write failing scheme-routing tests**

Require the default and staging environment tests to expose `appScheme: "kanna-dev"` and `appScheme: "kanna-staging"`, respectively. Change the simulator URL assertion to:

```ts
expect(
  buildExpoDevelopmentClientUrl("kanna-dev", "http://127.0.0.1:8679")
).toBe(
  "kanna-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8679&disableOnboarding=1"
);
```

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/helpers/env.test.ts e2e/helpers/simulator.test.ts
```

Expected: FAIL because the environment has no `appScheme` and the URL helper still hardcodes `exp+kanna-mobile`.

- [x] **Step 3: Expose the configured scheme from the E2E environment**

Add `appScheme: string` to `MobileE2eEnv`. Resolve it from `appConfig.scheme`, selecting the first entry when Expo supplies an array and falling back to the selected bundle ID:

```ts
const configuredAppScheme = Array.isArray(appConfig.scheme)
  ? appConfig.scheme[0]
  : appConfig.scheme;
const appScheme = configuredAppScheme?.trim() || bundleId;
```

Return `appScheme` with the remaining resolved environment.

- [x] **Step 4: Make the simulator URL environment-specific**

Change the URL helper and launcher inputs to accept the resolved scheme:

```ts
export function buildExpoDevelopmentClientUrl(
  appScheme: string,
  metroUrl: string
): string {
  return `${appScheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}&disableOnboarding=1`;
}
```

Pass `env.appScheme` from `run.ts` through `openSimulatorDevelopmentClient`.

- [x] **Step 5: Run focused and full verification**

Run:

```bash
pnpm --dir apps/mobile test -- e2e/helpers/env.test.ts e2e/helpers/simulator.test.ts e2e/run.test.ts
pnpm --dir apps/mobile typecheck
pnpm --dir apps/mobile test
pnpm --dir apps/mobile run test:e2e:relay
```

Expected: unit tests and typecheck pass; Appium launches `build.kanna.app.dev`, opens `kanna-dev` with the assigned workspace Metro port, and completes the relay activity flow.
