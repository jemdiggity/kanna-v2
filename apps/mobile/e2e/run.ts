import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser } from "webdriverio";
import {
  createPhysicalDeviceCapabilities,
  createSimulatorCapabilities
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
import { seedTrustedDesktopThroughDeepLink } from "./helpers/trust-seed";
import {
  assertSimulatorAppInstalled,
  bootSimulator,
  resolveSimulatorDevice
} from "./helpers/simulator";
import { runListDetailBackSmoke } from "./specs/smoke/list-detail-back.e2e";
import {
  runProfileConnectionSmoke,
  runProfileDisconnectedConnectionSmoke
} from "./specs/smoke/profile-connection.e2e";
import { runCloudTaskFlow } from "./specs/cloud/cloud-task-flow.e2e";

export const smokeSpecPaths = [
  "specs/cloud/cloud-task-flow.e2e.ts",
  "specs/smoke/list-detail-back.e2e.ts",
  "specs/smoke/profile-connection.e2e.ts"
];
export const supportedSmokeTargets = ["simulator", "device"] as const;
export const supportedSmokeModes = ["smoke", "profile-disconnected", "cloud"] as const;

interface StoppedDesktopServerHandle {
  baseUrl: string;
  close(): Promise<void>;
}

async function startStoppedDesktopStatusServer(): Promise<StoppedDesktopServerHandle> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/status") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          state: "stopped",
          desktopId: "offline",
          desktopName: "Offline Desktop",
          lanHost: "0.0.0.0",
          lanPort: 0,
          pairingCode: null
        })
      );
      return;
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise<void>((resolveReady, rejectReady) => {
    server.once("error", rejectReady);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", rejectReady);
      resolveReady();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Could not resolve stopped desktop status server port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClosed, rejectClosed) => {
    server.close((error) => {
      if (error) {
        rejectClosed(error);
        return;
      }

      resolveClosed();
    });
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "smoke";
  if (!supportedSmokeModes.includes(mode as (typeof supportedSmokeModes)[number])) {
    throw new Error(`Unsupported mobile E2E mode: ${mode}`);
  }

  const env = resolveRequiredMobileE2eEnv(
    process.env as Record<string, string | undefined>
  );
  const desktopServerUrl = resolveDesktopServerUrlForTarget(
    env.desktopServerUrl,
    env.target
  );
  await assertXcuitestDriverInstalled(process.env as Record<string, string | undefined>);
  const appiumServer = startLocalAppiumServer(
    env.appiumPort,
    process.env as Record<string, string | undefined>
  );
  let driver: Browser | null = null;
  let expoServer: Awaited<ReturnType<typeof ensureExpoServer>> | null = null;
  let stoppedDesktopServer: StoppedDesktopServerHandle | null = null;

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
      await bootSimulator(device);
      await assertSimulatorAppInstalled(device, env.bundleId);
      capabilities = createSimulatorCapabilities({
        appiumPort: env.appiumPort,
        bundleId: env.bundleId,
        deviceName: device.name,
        reservedPorts: env.reservedPorts
      });
    }

    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    let resolvedDesktopServerUrl = desktopServerUrl;
    if (mode === "profile-disconnected") {
      stoppedDesktopServer = await startStoppedDesktopStatusServer();
      resolvedDesktopServerUrl = resolveDesktopServerUrlForTarget(
        stoppedDesktopServer.baseUrl,
        env.target
      );
    }

    if (mode === "smoke") {
      await assertDesktopServerReachable(resolvedDesktopServerUrl);
    }

    expoServer = await ensureExpoServer({
      env:
        mode === "cloud"
          ? {
              EXPO_PUBLIC_KANNA_FORCE_CLOUD: "1",
              KANNA_APP_ENV: env.appEnv
            }
          : { KANNA_APP_ENV: env.appEnv },
      metroPort: env.metroPort,
      projectRoot
    });

    driver = await createMobileSession({
      port: env.appiumPort,
      capabilities
    });

    if (mode === "profile-disconnected") {
      await runProfileDisconnectedConnectionSmoke(driver);
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
      await runListDetailBackSmoke(driver);
      await runProfileConnectionSmoke(driver);
    }
  } finally {
    if (driver) {
      await driver.deleteSession();
    }
    appiumServer.kill("SIGTERM");
    await expoServer?.stop();
    await stoppedDesktopServer?.close();
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
