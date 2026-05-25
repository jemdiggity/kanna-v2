# Mobile Appium Physical Device Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Auto-select `superpowers:subagent-driven-development` or `superpowers:executing-plans` based on task coupling, subagent availability, and whether execution should stay in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing mobile Appium harness so one attached iPhone can run the shared smoke test through a local developer workflow.

**Architecture:** Keep one shared `apps/mobile/e2e` harness and make it target-aware instead of simulator-only. Simulator and physical-device runs share selectors, smoke specs, Appium startup, and desktop-server checks; only target resolution, install assertions, and capability generation differ.

**Tech Stack:** Expo React Native, Appium 2, XCUITest driver, WebDriverAgent, WebdriverIO, `tsx`, Vitest, Xcode command-line tooling

---

## File Structure

- Modify: `apps/mobile/package.json`
  Add physical-device preflight and smoke scripts beside the existing simulator commands.
- Modify: `apps/mobile/e2e/appium.config.ts`
  Split capability generation into simulator and physical-device profiles.
- Modify: `apps/mobile/e2e/appium.config.test.ts`
  Add coverage for real-device capability generation.
- Modify: `apps/mobile/e2e/helpers/env.ts`
  Add target selection plus optional device UDID parsing.
- Modify: `apps/mobile/e2e/helpers/env.test.ts`
  Cover device-mode parsing and failure boundaries.
- Create: `apps/mobile/e2e/helpers/device.ts`
  Discover attached iPhones, select one device, and assert app installation/readiness on hardware.
- Create: `apps/mobile/e2e/helpers/device.test.ts`
  Lock down device selection rules and failure messaging.
- Modify: `apps/mobile/e2e/preflight.ts`
  Branch between simulator and physical-device preflight paths and emit useful JSON summaries.
- Modify: `apps/mobile/e2e/run.ts`
  Branch between simulator and physical-device setup while reusing one smoke spec.
- Modify: `apps/mobile/e2e/run.test.ts`
  Assert the new device mode is registered.
- Modify: `AGENTS.md`
  Add local physical-device E2E workflow notes near the existing mobile dev guidance.

### Task 1: Add Physical-Device Target and Capability Support

**Files:**
- Modify: `apps/mobile/package.json`
- Modify: `apps/mobile/e2e/appium.config.ts`
- Modify: `apps/mobile/e2e/appium.config.test.ts`
- Modify: `apps/mobile/e2e/helpers/env.ts`
- Modify: `apps/mobile/e2e/helpers/env.test.ts`

- [ ] **Step 1: Write the failing config and env tests**

Add these cases to `apps/mobile/e2e/appium.config.test.ts`:

```ts
it("builds real-device capabilities with the selected UDID", () => {
  expect(
    createPhysicalDeviceCapabilities({
      appiumPort: 4723,
      bundleId: "build.kanna.app",
      deviceName: "Jeremy's iPhone",
      deviceUdid: "00008110-001234560E10801E"
    })
  ).toMatchObject({
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:udid": "00008110-001234560E10801E",
    "appium:deviceName": "Jeremy's iPhone",
    "appium:bundleId": "build.kanna.app",
    "appium:wdaLocalPort": 4724
  });
});
```

Add these cases to `apps/mobile/e2e/helpers/env.test.ts`:

```ts
it("defaults to simulator mode", () => {
  expect(
    resolveRequiredMobileE2eEnv({
      KANNA_APPIUM_PORT: "4723",
      EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120"
    })
  ).toMatchObject({
    target: "simulator"
  });
});

it("parses physical-device mode and UDID override", () => {
  expect(
    resolveRequiredMobileE2eEnv({
      KANNA_APPIUM_PORT: "4723",
      EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120",
      KANNA_IOS_E2E_TARGET: "device",
      KANNA_IOS_DEVICE_UDID: "00008110-001234560E10801E"
    })
  ).toMatchObject({
    target: "device",
    deviceUdid: "00008110-001234560E10801E"
  });
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `pnpm --dir apps/mobile test -- --runInBand appium.config env`

Expected: FAIL because physical-device capability builders and env fields do not exist yet.

- [ ] **Step 3: Add physical-device scripts**

Update `apps/mobile/package.json`:

```json
"test:e2e:device:preflight": "KANNA_IOS_E2E_TARGET=device pnpm exec tsx ./e2e/preflight.ts",
"test:e2e:device:smoke": "KANNA_IOS_E2E_TARGET=device pnpm exec tsx ./e2e/run.ts smoke"
```

- [ ] **Step 4: Extend the env model with target-aware parsing**

Update `apps/mobile/e2e/helpers/env.ts` to use a typed target:

```ts
export type MobileE2eTarget = "simulator" | "device";

export interface MobileE2eEnv {
  appiumPort: number;
  bundleId: string;
  desktopServerUrl: string;
  target: MobileE2eTarget;
  deviceName?: string;
  deviceUdid?: string;
}
```

Resolve it like this:

```ts
const target = env.KANNA_IOS_E2E_TARGET?.trim() === "device" ? "device" : "simulator";

return {
  appiumPort,
  bundleId: env.KANNA_IOS_BUNDLE_ID?.trim() || "build.kanna.app",
  desktopServerUrl,
  target,
  deviceName: env.KANNA_IOS_SIMULATOR_NAME?.trim() || undefined,
  deviceUdid: env.KANNA_IOS_DEVICE_UDID?.trim() || undefined
};
```

- [ ] **Step 5: Add a physical-device capability builder**

Update `apps/mobile/e2e/appium.config.ts`:

```ts
export interface PhysicalDeviceCapabilityInput {
  appiumPort: number;
  bundleId: string;
  deviceName: string;
  deviceUdid: string;
  platformVersion?: string;
}

export function createPhysicalDeviceCapabilities(
  input: PhysicalDeviceCapabilityInput
) {
  return {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:udid": input.deviceUdid,
    "appium:deviceName": input.deviceName,
    "appium:bundleId": input.bundleId,
    "appium:wdaLocalPort": deriveWdaLocalPort(input.appiumPort),
    "appium:newCommandTimeout": 120,
    "appium:noReset": true,
    ...(input.platformVersion
      ? { "appium:platformVersion": input.platformVersion }
      : {})
  };
}
```

- [ ] **Step 6: Run the targeted tests to verify they pass**

Run: `pnpm --dir apps/mobile test -- --runInBand appium.config env`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add \
  apps/mobile/package.json \
  apps/mobile/e2e/appium.config.ts \
  apps/mobile/e2e/appium.config.test.ts \
  apps/mobile/e2e/helpers/env.ts \
  apps/mobile/e2e/helpers/env.test.ts
git commit -m "test: add physical device mobile e2e target"
```

### Task 2: Add Attached-Device Discovery and Installation Checks

**Files:**
- Create: `apps/mobile/e2e/helpers/device.ts`
- Create: `apps/mobile/e2e/helpers/device.test.ts`

- [ ] **Step 1: Write the failing device-selection tests**

Create `apps/mobile/e2e/helpers/device.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  selectPhysicalDevice,
  type AvailablePhysicalDevice
} from "./device";

function device(
  name: string,
  udid: string
): AvailablePhysicalDevice {
  return {
    name,
    udid,
    platformVersion: "18.4"
  };
}

describe("selectPhysicalDevice", () => {
  it("selects the only attached device by default", () => {
    expect(
      selectPhysicalDevice([device("Jeremy's iPhone", "udid-1")])
    ).toMatchObject({ udid: "udid-1" });
  });

  it("selects the requested device when the UDID is present", () => {
    expect(
      selectPhysicalDevice(
        [device("Jeremy's iPhone", "udid-1"), device("Test Phone", "udid-2")],
        "udid-2"
      )
    ).toMatchObject({ udid: "udid-2" });
  });

  it("fails clearly when no devices are attached", () => {
    expect(() => selectPhysicalDevice([])).toThrow("No attached iPhone devices were found");
  });

  it("fails clearly when multiple devices are attached without an override", () => {
    expect(() =>
      selectPhysicalDevice([device("Jeremy's iPhone", "udid-1"), device("Test Phone", "udid-2")])
    ).toThrow("KANNA_IOS_DEVICE_UDID");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --dir apps/mobile test -- --runInBand device`

Expected: FAIL because `helpers/device.ts` does not exist yet.

- [ ] **Step 3: Add attached-device discovery and selection**

Create `apps/mobile/e2e/helpers/device.ts` with:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AvailablePhysicalDevice {
  name: string;
  udid: string;
  platformVersion: string;
}

export function selectPhysicalDevice(
  devices: readonly AvailablePhysicalDevice[],
  requestedUdid?: string
): AvailablePhysicalDevice {
  if (!devices.length) {
    throw new Error(
      "No attached iPhone devices were found. Attach one over USB and trust this computer first."
    );
  }

  if (requestedUdid) {
    const requested = devices.find((device) => device.udid === requestedUdid);
    if (requested) {
      return requested;
    }

    throw new Error(
      `Requested iPhone UDID ${requestedUdid} was not found. Attached devices: ${devices.map((device) => `${device.name} (${device.udid})`).join(", ")}`
    );
  }

  if (devices.length > 1) {
    throw new Error(
      `Multiple attached iPhone devices were found: ${devices.map((device) => `${device.name} (${device.udid})`).join(", ")}. Set KANNA_IOS_DEVICE_UDID to choose one device.`
    );
  }

  return devices[0];
}
```

- [ ] **Step 4: Add Xcode device enumeration and install checks**

Continue `apps/mobile/e2e/helpers/device.ts`:

```ts
interface XctraceListDevices {
  devices?: Array<{
    identifier?: string;
    model?: string;
    operatingSystemVersion?: string;
    platform?: string;
    available?: boolean;
  }>;
}

export async function listAttachedPhysicalDevices(): Promise<AvailablePhysicalDevice[]> {
  const { stdout } = await execFileAsync("xcrun", ["xctrace", "list", "devices", "--json"]);
  const parsed = JSON.parse(stdout) as XctraceListDevices;

  return (parsed.devices ?? [])
    .filter((device) => device.available !== false && device.platform === "iOS")
    .map((device) => ({
      name: device.model ?? "Unknown iPhone",
      udid: device.identifier ?? "",
      platformVersion: device.operatingSystemVersion ?? "unknown"
    }))
    .filter((device) => device.udid.length > 0);
}

export async function resolvePhysicalDevice(
  requestedUdid?: string
): Promise<AvailablePhysicalDevice> {
  const devices = await listAttachedPhysicalDevices();
  return selectPhysicalDevice(devices, requestedUdid);
}

export async function assertPhysicalDeviceAppInstalled(
  device: AvailablePhysicalDevice,
  bundleId: string
): Promise<void> {
  try {
    await execFileAsync("xcrun", ["devicectl", "device", "info", "apps", "--device", device.udid]);
  } catch (error) {
    throw new Error(
      `Failed to inspect installed apps on ${device.name}. Confirm Xcode device support is working and the device is unlocked.`
    );
  }

  try {
    const { stdout } = await execFileAsync("xcrun", [
      "devicectl",
      "device",
      "info",
      "apps",
      "--device",
      device.udid
    ]);

    if (!stdout.includes(bundleId)) {
      throw new Error("missing");
    }
  } catch {
    throw new Error(
      `Bundle ${bundleId} is not installed on ${device.name}. Install it with: pnpm --dir apps/mobile ios --device`
    );
  }
}
```

- [ ] **Step 5: Run the targeted tests to verify they pass**

Run: `pnpm --dir apps/mobile test -- --runInBand device`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/e2e/helpers/device.ts apps/mobile/e2e/helpers/device.test.ts
git commit -m "test: add physical device selection helpers"
```

### Task 3: Make Preflight and Smoke Target-Aware and Document the Workflow

**Files:**
- Modify: `apps/mobile/e2e/preflight.ts`
- Modify: `apps/mobile/e2e/run.ts`
- Modify: `apps/mobile/e2e/run.test.ts`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write the failing runner registration test**

Add this case to `apps/mobile/e2e/run.test.ts`:

```ts
it("supports the shared smoke spec for device mode", () => {
  expect(smokeSpecPaths).toContain("specs/smoke/list-detail-back.e2e.ts");
});
```

Add a second assertion in the same file:

```ts
it("accepts smoke as the only shared mode entrypoint", () => {
  expect(smokeSpecPaths).toHaveLength(1);
});
```

- [ ] **Step 2: Run the targeted test to verify the current runner shape is insufficient**

Run: `pnpm --dir apps/mobile test -- --runInBand run`

Expected: FAIL once the runner branches on target-specific setup without the new code paths.

- [ ] **Step 3: Make preflight branch by target**

Update `apps/mobile/e2e/preflight.ts` so it selects simulator or device setup based on `env.target`:

```ts
const env = resolveRequiredMobileE2eEnv(processEnv);
await assertXcuitestDriverInstalled(processEnv);

if (env.target === "device") {
  const device = await resolvePhysicalDevice(env.deviceUdid);
  await assertPhysicalDeviceAppInstalled(device, env.bundleId);
  // emit device summary JSON
} else {
  const device = await resolveSimulatorDevice(env.deviceName);
  await bootSimulator(device);
  await assertSimulatorAppInstalled(device, env.bundleId);
  // emit simulator summary JSON
}
```

- [ ] **Step 4: Make smoke execution branch by target**

Update `apps/mobile/e2e/run.ts`:

```ts
const env = resolveRequiredMobileE2eEnv(process.env as Record<string, string | undefined>);
await assertXcuitestDriverInstalled(process.env as Record<string, string | undefined>);
await assertDesktopServerReachable(env.desktopServerUrl);

let capabilities: Record<string, unknown>;

if (env.target === "device") {
  const device = await resolvePhysicalDevice(env.deviceUdid);
  await assertPhysicalDeviceAppInstalled(device, env.bundleId);
  capabilities = createPhysicalDeviceCapabilities({
    appiumPort: env.appiumPort,
    bundleId: env.bundleId,
    deviceName: device.name,
    deviceUdid: device.udid,
    platformVersion: device.platformVersion
  });
} else {
  const simulator = await resolveSimulatorDevice(env.deviceName);
  await bootSimulator(simulator);
  await assertSimulatorAppInstalled(simulator, env.bundleId);
  capabilities = createSimulatorCapabilities({
    appiumPort: env.appiumPort,
    bundleId: env.bundleId,
    deviceName: simulator.name
  });
}
```

Then reuse the shared smoke call:

```ts
const driver = await createMobileSession({
  port: env.appiumPort,
  capabilities
});

try {
  await runListDetailBackSmoke(driver);
} finally {
  await driver.deleteSession();
  appiumServer.kill("SIGTERM");
}
```

- [ ] **Step 5: Add workflow notes to `AGENTS.md`**

Add a short note near the existing mobile/Appium workflow section:

```md
- Local iOS simulator E2E uses `pnpm --dir apps/mobile run test:e2e:preflight` and `pnpm --dir apps/mobile run test:e2e:smoke`
- Local physical-device E2E uses `pnpm --dir apps/mobile run test:e2e:device:preflight` and `pnpm --dir apps/mobile run test:e2e:device:smoke`
- Physical-device runs assume local Xcode signing already works and the app is already installed on the attached iPhone
- Use `KANNA_IOS_DEVICE_UDID` when more than one iPhone is attached
```

- [ ] **Step 6: Run verification**

Run:

```bash
pnpm --dir apps/mobile run typecheck
pnpm --dir apps/mobile test -- --runInBand appium.config env device run
pnpm --dir apps/mobile run test:e2e:device:preflight
pnpm --dir apps/mobile run test:e2e:device:smoke
```

Expected:

- typecheck passes
- unit tests pass
- device preflight either succeeds on one attached iPhone or fails with the new explicit failure messages
- device smoke succeeds once the app is installed and the desktop mobile server is running

- [ ] **Step 7: Commit**

```bash
git add \
  apps/mobile/e2e/preflight.ts \
  apps/mobile/e2e/run.ts \
  apps/mobile/e2e/run.test.ts \
  AGENTS.md
git commit -m "test: add physical device mobile smoke path"
```

## Self-Review

- **Spec coverage:** This plan covers target-aware environment parsing, physical-device selection, shared smoke-path reuse, preflight failure boundaries, capability generation, and workflow documentation. It intentionally does not cover CI or multi-device orchestration.
- **Placeholder scan:** No `TBD`, `TODO`, or deferred implementation markers remain.
- **Type consistency:** The plan uses one `MobileE2eEnv.target` discriminator, one `deviceUdid` override, and a single `createPhysicalDeviceCapabilities()` entrypoint consistently across tasks.
