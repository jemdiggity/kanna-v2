import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser } from "webdriverio";
import { processIdentity, processInventoryPath, recordInventoryResource, removeInventoryResource, terminateInventoryProcess } from "../../../tools/kd/src/runtime/process-inventory";
import {
  createPhysicalDeviceCapabilities,
  createSimulatorCapabilities,
  type SimulatorAlertHandling
} from "./appium.config";
import {
  assertXcuitestDriverInstalled,
  listXcuitestConnectedDeviceUdids,
  startLocalAppiumServer,
  waitForLocalAppiumServer
} from "./helpers/appium";
import {
  assertDesktopServerReachable,
  readDesktopIdentity,
  resolveDesktopServerUrlForTarget
} from "./helpers/desktop";
import { ensureExpoServer } from "./helpers/metro";
import {
  assertPhysicalDeviceAppInstalled,
  resolvePhysicalDevice
} from "./helpers/device";
import { resolveRequiredMobileE2eEnv } from "./helpers/env";
import { createMobileSession } from "./helpers/session";
import { selectors } from "./helpers/selectors";
import {
  seedPairedTrustedDesktopThroughDeepLink,
  seedTrustedDesktopThroughDeepLink
} from "./helpers/trust-seed";
import {
  assertSimulatorAppInstalled,
  bootSimulator,
  disableSimulatorExpoDevMenuFab,
  openSimulatorDevelopmentClient,
  resolveSimulatorDevice,
  type AvailableSimulatorDevice
} from "./helpers/simulator";
import { runListDetailBackSmoke } from "./specs/smoke/list-detail-back.e2e";
import {
  runProfileConnectionSmoke,
  runProfileDisconnectedConnectionSmoke
} from "./specs/smoke/profile-connection.e2e";
import { runSearchFocusSmoke } from "./specs/smoke/search-focus.e2e";
import { runShellVisualSmoke } from "./specs/smoke/shell-visual.e2e";
import { runTabReselectionSmoke } from "./specs/smoke/tab-reselection.e2e";
import { runCloudTaskFlow } from "./specs/cloud/cloud-task-flow.e2e";
import { runHybridTaskFlow } from "./specs/hybrid/hybrid-task-flow.e2e";
import { runRelayTaskFlow } from "./specs/relay/relay-task-flow.e2e";
import { startMobileRelayHarness } from "./helpers/relay-harness";

export const smokeSpecPaths = [
  "specs/cloud/cloud-task-flow.e2e.ts",
  "specs/hybrid/hybrid-task-flow.e2e.ts",
  "specs/relay/relay-task-flow.e2e.ts",
  "specs/smoke/list-detail-back.e2e.ts",
  "specs/smoke/profile-connection.e2e.ts",
  "specs/smoke/search-focus.e2e.ts",
  "specs/smoke/shell-visual.e2e.ts",
  "specs/smoke/tab-reselection.e2e.ts"
];
export const supportedSmokeTargets = ["simulator", "device"] as const;
export const supportedSmokeModes = [
  "smoke",
  "search-focus",
  "tab-reselection",
  "shell-visual",
  "profile-disconnected",
  "cloud",
  "relay",
  "hybrid"
] as const;

export function resolveSmokeModeAppEnv(
  mode: string,
  configuredAppEnv: string | undefined
): string | undefined {
  return mode === "hybrid" ? "dev" : configuredAppEnv;
}

export function requiresExactExpoEnvironment(mode: string): boolean {
  return mode === "relay" || mode === "hybrid" || mode === "profile-disconnected";
}

export function resolveSimulatorAlertHandling(
  mode: string
): SimulatorAlertHandling {
  if (mode === "hybrid") {
    return "accept";
  }
  if (mode === "relay" || mode === "profile-disconnected") {
    return "manual";
  }
  return "dismiss";
}

async function isDisplayed(driver: Browser, selector: string): Promise<boolean> {
  const element = await driver.$(selector);
  return element.isDisplayed().catch(() => false);
}

async function dismissExpoStartupOverlay(driver: Browser): Promise<void> {
  const alertText = await driver.getAlertText().catch(() => null);
  if (alertText && isBonjourPermissionAlert(alertText)) {
    await driver.acceptAlert();
  }

  const continueButton = await driver.$("~Continue");
  if (await continueButton.isDisplayed().catch(() => false)) {
    await continueButton.click();
  }
  const devMenuCloseButton = await driver.$("~xmark");
  if (await devMenuCloseButton.isDisplayed().catch(() => false)) {
    await devMenuCloseButton.click();
  } else {
    const devMenuMarker = await driver.$("~Toggle performance monitor");
    if (await devMenuMarker.isExisting()) {
      const closePoint = resolveExpoDevMenuClosePoint(await driver.getWindowSize());
      await driver.execute("mobile: tap", closePoint);
    }
  }
}

export async function waitForExpoAppReady(
  driver: Browser,
  readySelector: string = selectors.appShell
): Promise<void> {
  let consecutiveReadyPolls = 0;
  await driver.waitUntil(
    async () => {
      await dismissExpoStartupOverlay(driver);
      if (await isDisplayed(driver, readySelector)) {
        consecutiveReadyPolls += 1;
      } else {
        consecutiveReadyPolls = 0;
      }
      return consecutiveReadyPolls >= 3;
    },
    {
      interval: 250,
      timeout: 90_000,
      timeoutMsg:
        "Kanna's mobile app shell did not become visible after Expo startup overlays were handled."
    }
  );
}

export function isBonjourPermissionAlert(text: string): boolean {
  return /local network|find and connect|devices on your local network/i.test(text);
}

export function resolveExpoDevMenuClosePoint(viewport: {
  width: number;
  height: number;
}): { x: number; y: number } {
  return {
    x: viewport.width - 40,
    y: Math.round(viewport.height * 0.48)
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "smoke";
  if (!supportedSmokeModes.includes(mode as (typeof supportedSmokeModes)[number])) {
    throw new Error(`Unsupported mobile E2E mode: ${mode}`);
  }
  if (
    (mode === "relay" || mode === "hybrid" || mode === "profile-disconnected") &&
    !process.env.KANNA_E2E_DESKTOP_SERVER_URL
  ) {
    process.env.KANNA_E2E_DESKTOP_SERVER_URL = "http://127.0.0.1:1";
  }
  const modeAppEnv = resolveSmokeModeAppEnv(mode, process.env.KANNA_APP_ENV);
  if (modeAppEnv) {
    process.env.KANNA_APP_ENV = modeAppEnv;
  }

  const env = resolveRequiredMobileE2eEnv(
    process.env as Record<string, string | undefined>
  );
  const desktopServerUrl = resolveDesktopServerUrlForTarget(
    env.desktopServerUrl,
    env.target
  );
  if ((mode === "hybrid" || mode === "profile-disconnected") && env.target !== "simulator") {
    throw new Error(
      `The mobile ${mode} E2E mode is simulator-only; it must not install or launch a physical device.`
    );
  }
  if (mode === "shell-visual" && env.target !== "simulator") {
    throw new Error(
      "The mobile shell visual E2E mode is simulator-only so screenshot geometry and colors remain pinned."
    );
  }
  await assertXcuitestDriverInstalled(process.env as Record<string, string | undefined>);
  const appiumServer = startLocalAppiumServer(
    env.appiumPort,
    process.env as Record<string, string | undefined>
  );
  const mobileRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const mobileInventoryPath = processInventoryPath(mobileRepoRoot);
  const appiumResource = appiumServer.pid
    ? recordInventoryResource(mobileInventoryPath, { kind: "process" as const, pid: appiumServer.pid, label: "mobile-e2e-appium", identity: processIdentity(appiumServer.pid) })
    : undefined;
  let driver: Browser | null = null;
  let expoServer: Awaited<ReturnType<typeof ensureExpoServer>> | null = null;
  let relayHarness: Awaited<ReturnType<typeof startMobileRelayHarness>> | null = null;
  let simulatorDevice: AvailableSimulatorDevice | null = null;

  try {
    await waitForLocalAppiumServer(env.appiumPort);

    let capabilities: Record<string, unknown>;

    if (env.target === "device") {
      const appiumVisibleUdids = await listXcuitestConnectedDeviceUdids(
        process.env as Record<string, string | undefined>
      );
      const device = await resolvePhysicalDevice(
        env.deviceUdid,
        appiumVisibleUdids,
        env.physicalDeviceName
      );
      await assertPhysicalDeviceAppInstalled(device, env.bundleId, env.metroPort);
      capabilities = createPhysicalDeviceCapabilities({
        appiumPort: env.appiumPort,
        bundleId: env.bundleId,
        deviceName: device.name,
        deviceUdid: device.udid,
        platformVersion: device.platformVersion,
        xcodeOrgId: env.xcodeOrgId,
        xcodeSigningId: env.xcodeSigningId,
        updatedWdaBundleId: env.updatedWdaBundleId,
        reservedPorts: env.reservedPorts
      });
    } else {
      const device = await resolveSimulatorDevice(env.deviceName);
      simulatorDevice = device;
      await bootSimulator(device);
      await assertSimulatorAppInstalled(device, env.bundleId);
      await disableSimulatorExpoDevMenuFab(device, env.bundleId);
      capabilities = createSimulatorCapabilities({
        appiumPort: env.appiumPort,
        alertHandling: resolveSimulatorAlertHandling(mode),
        bundleId: env.bundleId,
        deviceName: device.name,
        reservedPorts: env.reservedPorts
      });
    }

    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const resolvedDesktopServerUrl = desktopServerUrl;

    if (
      mode === "smoke" ||
      mode === "search-focus" ||
      mode === "tab-reselection" ||
      mode === "shell-visual"
    ) {
      await assertDesktopServerReachable(resolvedDesktopServerUrl);
    }
    if (mode === "relay" || mode === "hybrid" || mode === "profile-disconnected") {
      relayHarness = await startMobileRelayHarness({
        mode: mode === "relay" ? "relay" : "hybrid"
      });
    }

    expoServer = await ensureExpoServer({
      env:
        (mode === "hybrid" || mode === "profile-disconnected") && relayHarness
          ? relayHarness.hybridEnv
          : mode === "relay" && relayHarness
          ? relayHarness.env
          :
        mode === "cloud"
          ? {
              EXPO_PUBLIC_KANNA_FORCE_CLOUD: "1",
              KANNA_APP_ENV: env.appEnv
            }
          : { KANNA_APP_ENV: env.appEnv },
      metroPort: env.metroPort,
      projectRoot,
      requireExactEnvironment: requiresExactExpoEnvironment(mode)
    });

    driver = await createMobileSession({
      port: env.appiumPort,
      capabilities
    });
    if (simulatorDevice) {
      await openSimulatorDevelopmentClient({
        appScheme: env.appScheme,
        device: simulatorDevice,
        metroPort: env.metroPort
      });
      await waitForExpoAppReady(driver);
    }

    if (mode === "shell-visual") {
      const desktopIdentity = await readDesktopIdentity(resolvedDesktopServerUrl);
      await seedTrustedDesktopThroughDeepLink({
        bundleId: env.bundleId,
        driver,
        desktop: {
          desktopId: desktopIdentity.desktopId,
          displayName: desktopIdentity.desktopName
        }
      });
      await runShellVisualSmoke(driver);
    } else if (mode === "profile-disconnected" && relayHarness) {
      await runProfileDisconnectedConnectionSmoke(driver, {
        bundleId: env.bundleId,
        createPairingSession: relayHarness.createPairingSession,
        credentials: relayHarness.credentials,
        desktopId: relayHarness.hybridFixture.desktop.desktopId,
        expirePairingSession: relayHarness.expirePairingSession,
        hybridFixture: relayHarness.hybridFixture,
        reopenDevelopmentClient: async () => {
          if (!simulatorDevice) {
            throw new Error("Profile machine E2E requires a simulator");
          }
          await openSimulatorDevelopmentClient({
            appScheme: env.appScheme,
            device: simulatorDevice,
            metroPort: env.metroPort
          });
        },
        setLanHttpEnabled: relayHarness.setLanHttpEnabled,
        waitForAppReady: (readySelector) =>
          waitForExpoAppReady(driver!, readySelector)
      });
    } else if (mode === "relay" && relayHarness) {
      await runRelayTaskFlow(driver, {
        bundleId: env.bundleId,
        companion: relayHarness.companion,
        credentials: relayHarness.credentials,
        emitFilePreviewLinks: relayHarness.emitFilePreviewLinks,
        filePreview: relayHarness.filePreview,
        draft: relayHarness.quickReply.draft,
        customizedReply: relayHarness.quickReply.text,
        fixture: relayHarness.fixture,
        prepareTaskUnreadForMarkRead: relayHarness.prepareTaskUnreadForMarkRead,
        setTaskActivity: relayHarness.setTaskActivity,
        taskRow: relayHarness.taskRow,
        taskOrdering: relayHarness.taskOrdering,
        waitForLocalTaskActivity: relayHarness.waitForLocalTaskActivity,
        waitForMobileTerminalGeometry:
          relayHarness.waitForMobileTerminalGeometry,
        async waitForQuickReplyInput() {
          await relayHarness!.waitForQuickReplyInput(
            relayHarness!.quickReply.expectedInput
          );
        }
      });
    } else if (mode === "hybrid" && relayHarness) {
      await seedPairedTrustedDesktopThroughDeepLink({
        bundleId: env.bundleId,
        createPairingSession: relayHarness.createPairingSession,
        driver,
        desktop: {
          desktopId: relayHarness.hybridFixture.desktop.desktopId,
          displayName: relayHarness.hybridFixture.desktop.displayName,
          lanBaseUrl: relayHarness.hybridFixture.desktop.lanBaseUrl
        },
        selectedTaskId: relayHarness.hybridFixture.unresolvedTaskId
      });
      await runHybridTaskFlow(driver, {
        bundleId: env.bundleId,
        companion: relayHarness.companion,
        credentials: relayHarness.credentials,
        fixture: relayHarness.hybridFixture,
        publishCloudRefresh: () => relayHarness!.publishHybridCloudRefresh(),
        stopRelay: () => relayHarness!.harness.stopRelay()
      });
    } else if (mode === "cloud") {
      await runCloudTaskFlow(driver, {
        email: env.cloudEmail,
        password: env.cloudPassword
      });
    } else {
      const desktopIdentity = await readDesktopIdentity(resolvedDesktopServerUrl);
      await seedTrustedDesktopThroughDeepLink({
        bundleId: env.bundleId,
        driver,
        desktop: {
          desktopId: desktopIdentity.desktopId,
          displayName: desktopIdentity.desktopName
        }
      });
      if (mode === "search-focus") {
        await runSearchFocusSmoke(driver);
      } else if (mode === "tab-reselection") {
        await runTabReselectionSmoke(driver);
      } else {
        await runListDetailBackSmoke(driver, {
          desktopServerUrl: resolvedDesktopServerUrl
        });
        await runSearchFocusSmoke(driver);
        await runTabReselectionSmoke(driver);
        if (env.target === "simulator") {
          await runShellVisualSmoke(driver);
        }
        await runProfileConnectionSmoke(driver);
      }
    }
  } finally {
    if (driver) {
      await driver.deleteSession();
    }
    if (appiumResource?.kind === "process") {
      const outcome = await terminateInventoryProcess(appiumResource);
      if (outcome !== "failed") removeInventoryResource(mobileInventoryPath, appiumResource);
    }
    await expoServer?.stop();
    await relayHarness?.stop();
  }
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
