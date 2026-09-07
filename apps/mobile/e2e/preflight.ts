import {
  assertPhysicalDeviceAppInstalled,
  resolvePhysicalDevice
} from "./helpers/device";
import {
  assertXcuitestDriverInstalled,
  listXcuitestConnectedDeviceUdids,
  listInstalledAppiumDrivers
} from "./helpers/appium";
import {
  assertDesktopServerReachable,
  resolveDesktopServerUrlForTarget
} from "./helpers/desktop";
import { resolveRequiredMobileE2eEnv } from "./helpers/env";
import { localProcessFetch } from "@kanna/local-process-fetch";
import {
  assertSimulatorAppInstalled,
  bootSimulator,
  resolveSimulatorDevice
} from "./helpers/simulator";

async function main(): Promise<void> {
  const processEnv = process.env as Record<string, string | undefined>;
  const env = resolveRequiredMobileE2eEnv(processEnv);
  const desktopServerUrl = resolveDesktopServerUrlForTarget(
    env.desktopServerUrl,
    env.target
  );
  await assertXcuitestDriverInstalled(processEnv);

  const driverSummary = await listInstalledAppiumDrivers(processEnv);
  await assertDesktopServerReachable(desktopServerUrl);
  const serverStatus = (await (
    await localProcessFetch(`${desktopServerUrl}/v1/status`)
  ).json()) as Record<string, unknown>;
  if (env.target === "device") {
    const appiumVisibleUdids = await listXcuitestConnectedDeviceUdids(processEnv);
    const device = await resolvePhysicalDevice(
      env.deviceUdid,
      appiumVisibleUdids,
      env.physicalDeviceName
    );
    await assertPhysicalDeviceAppInstalled(device, env.bundleId, env.metroPort);

    process.stdout.write(
      `${JSON.stringify(
        {
          target: env.target,
          appiumPort: env.appiumPort,
          metroPort: env.metroPort,
          bundleId: env.bundleId,
          desktopServerUrl,
          deviceName: device.name,
          deviceUdid: device.udid,
          platformVersion: device.platformVersion,
          driverVersion: driverSummary.xcuitest?.version ?? null,
          serverState: serverStatus.state ?? null
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const device = await resolveSimulatorDevice(env.deviceName);
  await bootSimulator(device);
  await assertSimulatorAppInstalled(device, env.bundleId);

  process.stdout.write(
    `${JSON.stringify(
      {
        target: env.target,
        appiumPort: env.appiumPort,
        metroPort: env.metroPort,
        bundleId: env.bundleId,
        desktopServerUrl,
        deviceName: device.name,
        driverVersion: driverSummary.xcuitest?.version ?? null,
        serverState: serverStatus.state ?? null
      },
      null,
      2
    )}\n`
  );
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
