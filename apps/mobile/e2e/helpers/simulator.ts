import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export interface AvailableSimulatorDevice {
  name: string;
  runtime: string;
  state: string;
  udid: string;
}

interface SimctlDeviceRecord {
  isAvailable?: boolean;
  name?: string;
  state?: string;
  udid?: string;
}

interface SimctlDeviceList {
  devices?: Record<string, SimctlDeviceRecord[]>;
}

export function selectSimulatorDevice(
  devices: readonly AvailableSimulatorDevice[],
  requestedName?: string
): AvailableSimulatorDevice {
  if (!devices.length) {
    throw new Error("No available iOS simulators were found.");
  }

  if (requestedName) {
    const requestedDevice = devices.find((device) => device.name === requestedName);
    if (requestedDevice) {
      return requestedDevice;
    }

    throw new Error(
      `Requested iOS simulator "${requestedName}" was not found. Available simulators: ${devices.map((device) => device.name).join(", ")}`
    );
  }

  const iphone15 = devices.find((device) => device.name === "iPhone 15");
  if (iphone15) {
    return iphone15;
  }

  return devices[0];
}

export async function listAvailableSimulatorDevices(): Promise<AvailableSimulatorDevice[]> {
  const { stdout } = await execFileAsync("xcrun", [
    "simctl",
    "list",
    "devices",
    "available",
    "--json"
  ]);
  const parsed = JSON.parse(stdout) as SimctlDeviceList;
  const devicesByRuntime = parsed.devices ?? {};
  const devices: AvailableSimulatorDevice[] = [];

  for (const [runtime, runtimeDevices] of Object.entries(devicesByRuntime)) {
    for (const device of runtimeDevices) {
      if (!device.isAvailable || !device.name || !device.state || !device.udid) {
        continue;
      }

      devices.push({
        name: device.name,
        runtime,
        state: device.state,
        udid: device.udid
      });
    }
  }

  return devices.sort((left, right) => left.name.localeCompare(right.name));
}

export async function resolveSimulatorDevice(
  requestedName?: string
): Promise<AvailableSimulatorDevice> {
  const devices = await listAvailableSimulatorDevices();
  return selectSimulatorDevice(devices, requestedName);
}

export async function bootSimulator(
  device: AvailableSimulatorDevice | string
): Promise<void> {
  const target = typeof device === "string" ? device : device.udid;
  await execFileAsync("xcrun", ["simctl", "bootstatus", target, "-b"]).catch(
    async () => {
      await execFileAsync("xcrun", ["simctl", "boot", target]);
      await execFileAsync("xcrun", ["simctl", "bootstatus", target, "-b"]);
    }
  );
}

export async function assertSimulatorAppInstalled(
  device: AvailableSimulatorDevice,
  bundleId: string
): Promise<void> {
  try {
    await execFileAsync("xcrun", ["simctl", "get_app_container", device.udid, bundleId]);
  } catch {
    throw new Error(
      `Bundle ${bundleId} is not installed on simulator ${device.name}. Install it with: pnpm --dir apps/mobile ios -d "${device.name}" --no-bundler`
    );
  }
}

export function buildExpoDevelopmentClientUrl(
  appScheme: string,
  metroUrl: string
): string {
  return `${appScheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}&disableOnboarding=1`;
}

export function buildSimulatorDevelopmentClientLaunchArgs(input: {
  appScheme: string;
  bundleId: string;
  deviceUdid: string;
  metroPort: number;
}): string[] {
  return [
    "simctl",
    "launch",
    input.deviceUdid,
    input.bundleId,
    "--args",
    "--initialUrl",
    buildExpoDevelopmentClientUrl(
      input.appScheme,
      `http://127.0.0.1:${input.metroPort}`
    )
  ];
}

export async function openSimulatorDevelopmentClient(input: {
  appScheme: string;
  bundleId: string;
  device: AvailableSimulatorDevice;
  metroPort: number;
}): Promise<void> {
  await execFileAsync("xcrun", buildSimulatorDevelopmentClientLaunchArgs({
    appScheme: input.appScheme,
    bundleId: input.bundleId,
    deviceUdid: input.device.udid,
    metroPort: input.metroPort
  }));
}

export function buildDisableExpoDevMenuFabArgs(
  deviceUdid: string,
  bundleId: string
): string[] {
  return [
    "simctl",
    "spawn",
    deviceUdid,
    "defaults",
    "write",
    bundleId,
    "EXDevMenuShowFloatingActionButton",
    "-bool",
    "false"
  ];
}

export async function disableSimulatorExpoDevMenuFab(
  device: AvailableSimulatorDevice,
  bundleId: string
): Promise<void> {
  await execFileAsync("xcrun", buildDisableExpoDevMenuFabArgs(device.udid, bundleId));
}
