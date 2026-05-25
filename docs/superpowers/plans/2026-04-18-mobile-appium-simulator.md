# Mobile Appium Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only Appium/XCUITest/WDA E2E harness for the iOS simulator, wired into Kanna's worktree-aware port model and shaped so physical-device testing can be added later.

**Architecture:** Extend the existing mobile dev flow instead of inventing a new one. The repo config and `scripts/dev.sh` stay the source of truth for port assignment, the mobile E2E harness lives under `apps/mobile`, and tests drive the React Native app through Appium against the real desktop-side `kanna-server`.

**Tech Stack:** Expo React Native, Appium 2, XCUITest driver, WebDriverAgent, WebdriverIO remote client, `tsx`, Vitest, shell scripts

---

## File Structure

- Modify: `.kanna/config.json`
  Add `KANNA_APPIUM_PORT` to the repo-configured worktree-aware ports.
- Modify: `scripts/dev.sh`
  Read and export `KANNA_APPIUM_PORT` the same way the existing dev/mobile ports are handled.
- Modify: `scripts/dev.sh.test.sh`
  Lock the new port plumbing down in the shell test harness.
- Modify: `apps/mobile/package.json`
  Add Appium-related scripts and dev dependencies.
- Modify: `apps/mobile/tsconfig.json`
  Include the new E2E TypeScript files.
- Create: `apps/mobile/e2e/appium.config.ts`
  Typed capability builder and local port/capability helpers.
- Create: `apps/mobile/e2e/helpers/env.ts`
  Resolve required env values and surface actionable failures.
- Create: `apps/mobile/e2e/helpers/simulator.ts`
  Boot/select the target simulator and expose device lookup helpers.
- Create: `apps/mobile/e2e/helpers/appium.ts`
  Start/stop Appium and preflight the XCUITest driver.
- Create: `apps/mobile/e2e/helpers/session.ts`
  Create and destroy a WebdriverIO/Appium session.
- Create: `apps/mobile/e2e/helpers/selectors.ts`
  Centralize test IDs and selector helpers.
- Create: `apps/mobile/e2e/helpers/wait.ts`
  Wait helpers for presence, visibility, and shell readiness.
- Create: `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`
  First smoke scenario.
- Create: `apps/mobile/e2e/run.ts`
  Local smoke test runner.
- Create: `apps/mobile/e2e/preflight.ts`
  Explicit setup validation command.
- Modify: `apps/mobile/src/App.tsx`
  Add a root `testID`.
- Modify: `apps/mobile/src/screens/TasksScreen.tsx`
  Add screen-level `testID`s.
- Modify: `apps/mobile/src/components/TaskCard.tsx`
  Add row-level `testID`s.
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`
  Add task detail, back button, plus button, input, send button, and overlay `testID`s.
- Create: `apps/mobile/src/e2eTestIds.ts`
  Stable typed test ID constants shared by UI and Appium helpers.
- Create: `apps/mobile/src/e2eTestIds.test.ts`
  Guardrail for ID names and shapes.
- Create: `apps/mobile/e2e/appium.config.test.ts`
  Unit coverage for capability and port derivation.
- Create: `apps/mobile/e2e/helpers/env.test.ts`
  Unit coverage for env validation and failure messaging.

### Task 1: Add Worktree-Aware Appium Port Plumbing

**Files:**
- Modify: `.kanna/config.json`
- Modify: `scripts/dev.sh`
- Modify: `scripts/dev.sh.test.sh`

- [ ] **Step 1: Write the failing shell expectations for `KANNA_APPIUM_PORT`**

Add assertions to `scripts/dev.sh.test.sh` that prove the new env var is read and forwarded in worktree mode.

```sh
RESULT="$(run_dev_sh env KANNA_APPIUM_PORT=4723)"
OUTPUT="${RESULT%===STATUS:*===}"
STATUS="${RESULT##*===STATUS:}"
STATUS="${STATUS%===}"

if [ "$STATUS" -ne 0 ]; then
  printf 'dev.sh with KANNA_APPIUM_PORT exited with status %s\n' "$STATUS" >&2
  printf '%s\n' "$OUTPUT" >&2
  exit 1
fi

if ! grep -Fq "KANNA_APPIUM_PORT=4723" "$TMUX_LOG"; then
  printf 'expected KANNA_APPIUM_PORT to be propagated into tmux, got:\n' >&2
  cat "$TMUX_LOG" >&2
  exit 1
fi
```

- [ ] **Step 2: Run the shell test to verify it fails**

Run: `bash scripts/dev.sh.test.sh`
Expected: FAIL because `scripts/dev.sh` does not yet export `KANNA_APPIUM_PORT`

- [ ] **Step 3: Add the Appium port to repo config**

Update `.kanna/config.json`:

```json
"ports": {
  "KANNA_DEV_PORT": 1420,
  "KANNA_RELAY_PORT": 9080,
  "KANNA_MOBILE_PORT": 8081,
  "KANNA_APPIUM_PORT": 4723
}
```

- [ ] **Step 4: Export `KANNA_APPIUM_PORT` from `scripts/dev.sh`**

Add it in the tmux env pass-through list and read it the same way other configured ports are read:

```sh
for key in \
  KANNA_WORKTREE \
  KANNA_BUILD_BRANCH \
  KANNA_BUILD_COMMIT \
  KANNA_BUILD_WORKTREE \
  KANNA_DB_NAME \
  KANNA_DB_PATH \
  KANNA_DAEMON_DIR \
  KANNA_DEV_PORT \
  KANNA_MOBILE_PORT \
  KANNA_APPIUM_PORT \
  TAURI_WEBDRIVER_PORT; do
```

And resolve it once near the existing mobile port setup:

```sh
KANNA_APPIUM_PORT="$(read_port KANNA_APPIUM_PORT 4723)"
export KANNA_APPIUM_PORT
```

- [ ] **Step 5: Run the shell test to verify it passes**

Run: `bash scripts/dev.sh.test.sh`
Expected: `ok`

- [ ] **Step 6: Commit**

```bash
git add .kanna/config.json scripts/dev.sh scripts/dev.sh.test.sh
git commit -m "test: add worktree-aware appium port"
```

### Task 2: Add Mobile E2E Package Scripts and Typed Config

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/tsconfig.json`
- Create: `apps/mobile/e2e/appium.config.ts`
- Create: `apps/mobile/e2e/appium.config.test.ts`

- [ ] **Step 1: Write the failing config test**

Create `apps/mobile/e2e/appium.config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createSimulatorCapabilities, deriveWdaLocalPort } from "./appium.config";

describe("mobile Appium config", () => {
  it("derives WDA from the assigned Appium port", () => {
    expect(deriveWdaLocalPort(4723)).toBe(4724);
  });

  it("builds simulator capabilities with the configured bundle id", () => {
    expect(
      createSimulatorCapabilities({
        appiumPort: 4723,
        deviceName: "iPhone 15",
        bundleId: "build.kanna.app"
      })
    ).toMatchObject({
      platformName: "iOS",
      "appium:automationName": "XCUITest",
      "appium:deviceName": "iPhone 15",
      "appium:bundleId": "build.kanna.app",
      "appium:wdaLocalPort": 4724
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/mobile test -- --runInBand appium.config`
Expected: FAIL because `apps/mobile/e2e/appium.config.ts` does not exist yet

- [ ] **Step 3: Add the mobile E2E dependencies and scripts**

Update `apps/mobile/package.json`:

```json
"scripts": {
  "dev": "expo start",
  "ios": "expo run:ios",
  "test:e2e": "pnpm exec tsx ./e2e/run.ts",
  "test:e2e:smoke": "pnpm exec tsx ./e2e/run.ts smoke",
  "test:e2e:preflight": "pnpm exec tsx ./e2e/preflight.ts",
  "test:e2e:appium:start": "pnpm exec tsx ./e2e/helpers/appium.ts start"
},
"devDependencies": {
  "@types/react": "^19.0.0",
  "@types/node": "^24.0.0",
  "appium": "^2.19.0",
  "tsx": "^4.21.0",
  "webdriverio": "^9.20.0"
}
```

- [ ] **Step 4: Include E2E files in TypeScript checking**

Update `apps/mobile/tsconfig.json`:

```json
"include": [
  "App.tsx",
  "src/**/*.ts",
  "src/**/*.tsx",
  "e2e/**/*.ts"
]
```

- [ ] **Step 5: Add the typed capability builder**

Create `apps/mobile/e2e/appium.config.ts`:

```ts
export interface SimulatorCapabilityInput {
  appiumPort: number;
  bundleId: string;
  deviceName: string;
  platformVersion?: string;
}

export function deriveWdaLocalPort(appiumPort: number): number {
  return appiumPort + 1;
}

export function createSimulatorCapabilities(input: SimulatorCapabilityInput) {
  return {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:deviceName": input.deviceName,
    "appium:platformVersion": input.platformVersion,
    "appium:bundleId": input.bundleId,
    "appium:wdaLocalPort": deriveWdaLocalPort(input.appiumPort),
    "appium:noReset": true,
    "appium:newCommandTimeout": 120
  };
}
```

- [ ] **Step 6: Run the targeted tests**

Run: `pnpm --dir apps/mobile test -- --runInBand appium.config`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/package.json apps/mobile/tsconfig.json apps/mobile/e2e/appium.config.ts apps/mobile/e2e/appium.config.test.ts pnpm-lock.yaml
git commit -m "test: add mobile appium config scaffolding"
```

### Task 3: Build Preflight and Local Appium/Simulator Helpers

**Files:**
- Create: `apps/mobile/e2e/helpers/env.ts`
- Create: `apps/mobile/e2e/helpers/env.test.ts`
- Create: `apps/mobile/e2e/helpers/simulator.ts`
- Create: `apps/mobile/e2e/helpers/appium.ts`
- Create: `apps/mobile/e2e/preflight.ts`

- [ ] **Step 1: Write the failing env validation test**

Create `apps/mobile/e2e/helpers/env.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveRequiredMobileE2eEnv } from "./env";

describe("resolveRequiredMobileE2eEnv", () => {
  it("throws a clear error when KANNA_APPIUM_PORT is missing", () => {
    expect(() =>
      resolveRequiredMobileE2eEnv({
        EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120"
      })
    ).toThrow("KANNA_APPIUM_PORT");
  });

  it("parses the appium port and server URL", () => {
    expect(
      resolveRequiredMobileE2eEnv({
        KANNA_APPIUM_PORT: "4723",
        EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120"
      })
    ).toMatchObject({
      appiumPort: 4723,
      desktopServerUrl: "http://127.0.0.1:48120"
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/mobile test -- --runInBand env`
Expected: FAIL because helper files do not exist yet

- [ ] **Step 3: Add the env resolver**

Create `apps/mobile/e2e/helpers/env.ts`:

```ts
export interface MobileE2eEnv {
  appiumPort: number;
  desktopServerUrl: string;
  deviceName: string;
}

export function resolveRequiredMobileE2eEnv(env: Record<string, string | undefined>): MobileE2eEnv {
  const rawPort = env.KANNA_APPIUM_PORT?.trim();
  if (!rawPort) {
    throw new Error("KANNA_APPIUM_PORT is required. Start from ./scripts/dev.sh --mobile.");
  }

  const desktopServerUrl = env.EXPO_PUBLIC_KANNA_SERVER_URL?.trim();
  if (!desktopServerUrl) {
    throw new Error("EXPO_PUBLIC_KANNA_SERVER_URL is required. Start from ./scripts/dev.sh --mobile.");
  }

  return {
    appiumPort: Number.parseInt(rawPort, 10),
    desktopServerUrl,
    deviceName: env.KANNA_IOS_SIMULATOR_NAME?.trim() || "iPhone 15"
  };
}
```

- [ ] **Step 4: Add simulator and Appium helpers**

Create `apps/mobile/e2e/helpers/simulator.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function bootSimulator(deviceName: string): Promise<void> {
  await execFileAsync("xcrun", ["simctl", "bootstatus", deviceName, "-b"]).catch(async () => {
    await execFileAsync("xcrun", ["simctl", "boot", deviceName]);
    await execFileAsync("xcrun", ["simctl", "bootstatus", deviceName, "-b"]);
  });
}
```

Create `apps/mobile/e2e/helpers/appium.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";

export function startLocalAppiumServer(port: number): ChildProcess {
  return spawn("appium", ["server", "--port", String(port)], {
    stdio: "inherit"
  });
}
```

Create `apps/mobile/e2e/preflight.ts`:

```ts
import { resolveRequiredMobileE2eEnv } from "./helpers/env";

const env = resolveRequiredMobileE2eEnv(process.env);
console.log(JSON.stringify(env));
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --dir apps/mobile test -- --runInBand env appium.config`
Expected: PASS

Run: `pnpm --dir apps/mobile run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/e2e/helpers/env.ts apps/mobile/e2e/helpers/env.test.ts apps/mobile/e2e/helpers/simulator.ts apps/mobile/e2e/helpers/appium.ts apps/mobile/e2e/preflight.ts
git commit -m "test: add mobile appium preflight helpers"
```

### Task 4: Add Stable Mobile E2E Selectors

**Files:**
- Create: `apps/mobile/src/e2eTestIds.ts`
- Create: `apps/mobile/src/e2eTestIds.test.ts`
- Modify: `apps/mobile/src/App.tsx`
- Modify: `apps/mobile/src/screens/TasksScreen.tsx`
- Modify: `apps/mobile/src/components/TaskCard.tsx`
- Modify: `apps/mobile/src/screens/TaskScreen.tsx`

- [ ] **Step 1: Write the failing selector contract test**

Create `apps/mobile/src/e2eTestIds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MOBILE_E2E_IDS } from "./e2eTestIds";

describe("MOBILE_E2E_IDS", () => {
  it("keeps the smoke-test selectors stable", () => {
    expect(MOBILE_E2E_IDS.appShell).toBe("mobile.app-shell");
    expect(MOBILE_E2E_IDS.tasksScreen).toBe("mobile.tasks-screen");
    expect(MOBILE_E2E_IDS.taskDetailScreen).toBe("mobile.task-detail-screen");
    expect(MOBILE_E2E_IDS.taskBackButton).toBe("mobile.task-back-button");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/mobile test -- --runInBand e2eTestIds`
Expected: FAIL because the file does not exist yet

- [ ] **Step 3: Add the shared selector constants**

Create `apps/mobile/src/e2eTestIds.ts`:

```ts
export const MOBILE_E2E_IDS = {
  appShell: "mobile.app-shell",
  tasksScreen: "mobile.tasks-screen",
  taskDetailScreen: "mobile.task-detail-screen",
  taskBackButton: "mobile.task-back-button",
  taskListItem: (taskId: string) => `mobile.task-row.${taskId}`,
  taskMoreButton: "mobile.task-more-button",
  taskInput: "mobile.task-input",
  taskSendButton: "mobile.task-send-button",
  terminalOverlay: "mobile.terminal-overlay"
} as const;
```

- [ ] **Step 4: Thread the IDs through the UI**

Example updates:

```tsx
<SafeAreaView style={styles.safeArea} testID={MOBILE_E2E_IDS.appShell}>
```

```tsx
<View style={styles.screen} testID={MOBILE_E2E_IDS.taskDetailScreen}>
```

```tsx
<Pressable testID={MOBILE_E2E_IDS.taskBackButton} style={styles.backButton} onPress={onBack}>
```

```tsx
<Pressable testID={MOBILE_E2E_IDS.taskListItem(task.id)} onPress={() => onOpenTask(task.id)}>
```

- [ ] **Step 5: Run the selector tests and the affected mobile suite**

Run: `pnpm --dir apps/mobile test -- --runInBand e2eTestIds App appShell mobileController`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/e2eTestIds.ts apps/mobile/src/e2eTestIds.test.ts apps/mobile/src/App.tsx apps/mobile/src/screens/TasksScreen.tsx apps/mobile/src/components/TaskCard.tsx apps/mobile/src/screens/TaskScreen.tsx
git commit -m "test: add mobile appium selectors"
```

### Task 5: Add the First Smoke Runner and List/Detail/Back Scenario

**Files:**
- Create: `apps/mobile/e2e/helpers/selectors.ts`
- Create: `apps/mobile/e2e/helpers/wait.ts`
- Create: `apps/mobile/e2e/helpers/session.ts`
- Create: `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`
- Create: `apps/mobile/e2e/run.ts`

- [ ] **Step 1: Write the failing smoke-runner shape test**

Create a minimal contract test in `apps/mobile/e2e/appium.config.test.ts` or a new `apps/mobile/e2e/run.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { smokeSpecPaths } from "./run";

describe("mobile smoke runner", () => {
  it("registers the list-detail-back smoke spec", () => {
    expect(smokeSpecPaths).toContain("specs/smoke/list-detail-back.e2e.ts");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/mobile test -- --runInBand run appium.config`
Expected: FAIL because the runner is not implemented yet

- [ ] **Step 3: Add session and selector helpers**

Create `apps/mobile/e2e/helpers/session.ts`:

```ts
import { remote } from "webdriverio";

export async function createMobileSession(options: {
  hostname?: string;
  port: number;
  capabilities: Record<string, unknown>;
}) {
  return remote({
    hostname: options.hostname || "127.0.0.1",
    port: options.port,
    path: "/",
    capabilities: options.capabilities
  });
}
```

Create `apps/mobile/e2e/helpers/selectors.ts`:

```ts
import { MOBILE_E2E_IDS } from "../../src/e2eTestIds";

export const selectors = {
  appShell: `~${MOBILE_E2E_IDS.appShell}`,
  tasksScreen: `~${MOBILE_E2E_IDS.tasksScreen}`,
  taskDetailScreen: `~${MOBILE_E2E_IDS.taskDetailScreen}`,
  taskBackButton: `~${MOBILE_E2E_IDS.taskBackButton}`,
  taskRow(taskId: string) {
    return `~${MOBILE_E2E_IDS.taskListItem(taskId)}`;
  }
};
```

- [ ] **Step 4: Add the first smoke spec**

Create `apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts`:

```ts
import { selectors } from "../../helpers/selectors";

export async function runListDetailBackSmoke(driver: WebdriverIO.Browser) {
  await $(selectors.appShell).waitForDisplayed({ timeout: 30000 });
  await $(selectors.tasksScreen).waitForDisplayed({ timeout: 30000 });

  const taskRows = await $$('//XCUIElementTypeOther[starts-with(@name, "mobile.task-row.")]');
  if (!taskRows.length) {
    throw new Error("Expected at least one task row in the mobile task list");
  }

  await taskRows[0].click();
  await $(selectors.taskDetailScreen).waitForDisplayed({ timeout: 30000 });
  await $(selectors.taskBackButton).click();
  await $(selectors.tasksScreen).waitForDisplayed({ timeout: 30000 });
}
```

- [ ] **Step 5: Add the local runner**

Create `apps/mobile/e2e/run.ts`:

```ts
export const smokeSpecPaths = ["specs/smoke/list-detail-back.e2e.ts"];
```

Then expand it to:

```ts
import { createSimulatorCapabilities } from "./appium.config";
import { startLocalAppiumServer } from "./helpers/appium";
import { resolveRequiredMobileE2eEnv } from "./helpers/env";
import { createMobileSession } from "./helpers/session";
import { bootSimulator } from "./helpers/simulator";
import { runListDetailBackSmoke } from "./specs/smoke/list-detail-back.e2e";

const env = resolveRequiredMobileE2eEnv(process.env);
await bootSimulator(env.deviceName);
const appium = startLocalAppiumServer(env.appiumPort);
const driver = await createMobileSession({
  port: env.appiumPort,
  capabilities: createSimulatorCapabilities({
    appiumPort: env.appiumPort,
    bundleId: "build.kanna.app",
    deviceName: env.deviceName
  })
});

try {
  await runListDetailBackSmoke(driver);
} finally {
  await driver.deleteSession();
  appium.kill("SIGTERM");
}
```

- [ ] **Step 6: Run the unit coverage and then the local smoke harness**

Run: `pnpm --dir apps/mobile test -- --runInBand run appium.config env e2eTestIds`
Expected: PASS

Run: `./scripts/dev.sh --mobile`
Expected: desktop app + Metro start with `EXPO_PUBLIC_KANNA_SERVER_URL` set

Run: `pnpm --dir apps/mobile run test:e2e:preflight`
Expected: prints parsed env values including `KANNA_APPIUM_PORT`

Run: `pnpm --dir apps/mobile run test:e2e:smoke`
Expected: PASS on the default iPhone 15 simulator

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/e2e/helpers/selectors.ts apps/mobile/e2e/helpers/wait.ts apps/mobile/e2e/helpers/session.ts apps/mobile/e2e/specs/smoke/list-detail-back.e2e.ts apps/mobile/e2e/run.ts
git commit -m "test: add mobile appium smoke runner"
```

### Task 6: Final Verification and Developer Workflow Notes

**Files:**
- Modify: `AGENTS.md` (only if the Appium workflow needs explicit documentation beyond the existing mobile notes)
- Modify: `apps/mobile/package.json`

- [ ] **Step 1: Add any missing usage notes**

If Appium needs explicit local setup guidance, add a short note near the mobile dev workflow:

```md
- Local mobile E2E requires Appium 2 with the XCUITest driver installed.
- Run `./scripts/dev.sh --mobile` before `pnpm --dir apps/mobile run test:e2e:smoke`.
```

- [ ] **Step 2: Run the complete verification set**

Run: `bash scripts/dev.sh.test.sh`
Expected: `ok`

Run: `pnpm --dir apps/mobile test -- --runInBand App appShell entrypoint buildTerminalDocument terminalMutation taskPresentation moreCommands mobileController client appium.config env e2eTestIds run`
Expected: PASS

Run: `pnpm --dir apps/mobile run typecheck`
Expected: PASS

Run: `pnpm --dir apps/mobile run test:e2e:preflight`
Expected: PASS

Run: `pnpm --dir apps/mobile run test:e2e:smoke`
Expected: PASS locally with the simulator booted

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md apps/mobile/package.json
git commit -m "docs: document mobile appium e2e workflow"
```
