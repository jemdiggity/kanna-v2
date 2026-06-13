import type { CommandRunner } from "./process";

export interface AvailablePhysicalDevice {
  name: string;
  udid: string;
  platformVersion: string;
}

interface XcdeviceRecord {
  available?: boolean;
  ignored?: boolean;
  identifier?: string;
  name?: string;
  operatingSystemVersion?: string;
  platform?: string;
  simulator?: boolean;
}

interface SelectPhysicalDeviceOptions {
  requestedName?: string;
  requestedUdid?: string;
}

export interface MobileDeviceRunCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface BuildMobileDeviceRunCommandInput {
  deviceUdid: string;
  lanHost: string;
  metroPort: number;
  repoRoot: string;
}

interface PhysicalDeviceRunPreflightInput {
  bundleId: string;
  device: AvailablePhysicalDevice;
  lanHost: string;
  metroPort: number;
}

export interface PhysicalDeviceRunPreflightCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface PhysicalDeviceRunPreflightResult {
  ok: boolean;
  metroUrl: string;
  checks: PhysicalDeviceRunPreflightCheck[];
}

const mobileBundleIds = {
  dev: "build.kanna.app.dev",
  staging: "build.kanna.app.staging",
  prod: "build.kanna.app"
};

function normalizePlatformVersion(rawVersion: string | undefined): string {
  return rawVersion?.split(" ")[0] ?? "unknown";
}

function formatDeviceList(devices: readonly AvailablePhysicalDevice[]): string {
  return devices.map((device) => `${device.name} (${device.udid})`).join(", ");
}

export function parseXcdeviceList(stdout: string): AvailablePhysicalDevice[] {
  const parsed = JSON.parse(stdout) as XcdeviceRecord[];
  return parsed
    .filter(
      (device) =>
        device.available !== false &&
        device.ignored !== true &&
        device.simulator !== true &&
        device.platform === "com.apple.platform.iphoneos"
    )
    .map((device) => ({
      name: device.name ?? "Unknown iPhone",
      udid: device.identifier ?? "",
      platformVersion: normalizePlatformVersion(device.operatingSystemVersion)
    }))
    .filter((device) => device.udid.length > 0);
}

export function selectPhysicalDevice(
  devices: readonly AvailablePhysicalDevice[],
  options: SelectPhysicalDeviceOptions = {}
): AvailablePhysicalDevice {
  if (!devices.length) {
    throw new Error(
      "No attached iPhone devices were found. Attach one over USB and trust this computer first."
    );
  }

  if (options.requestedUdid) {
    const selected = devices.find((device) => device.udid === options.requestedUdid);
    if (!selected) {
      throw new Error(
        `Requested iPhone UDID ${options.requestedUdid} was not found. Attached devices: ${formatDeviceList(devices)}`
      );
    }
    return selected;
  }

  if (options.requestedName) {
    const matches = devices.filter((device) => device.name === options.requestedName);
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple attached iPhone devices matched ${options.requestedName}. Set KANNA_IOS_DEVICE_UDID to choose one device explicitly.`
      );
    }
    throw new Error(
      `Requested iPhone name ${options.requestedName} was not found. Attached devices: ${formatDeviceList(devices)}`
    );
  }

  if (devices.length > 1) {
    throw new Error(
      `Multiple attached iPhone devices were found: ${formatDeviceList(devices)}. Set KANNA_IOS_DEVICE_UDID to choose one device.`
    );
  }

  return devices[0];
}

export async function listAttachedPhysicalDevices(
  runner: CommandRunner
): Promise<AvailablePhysicalDevice[]> {
  const result = await runner.run("xcrun", ["xcdevice", "list"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Failed to list attached iPhone devices with xcrun xcdevice list.");
  }
  return parseXcdeviceList(result.stdout);
}

export async function resolvePhysicalDevice(
  runner: CommandRunner,
  options: SelectPhysicalDeviceOptions = {}
): Promise<AvailablePhysicalDevice> {
  return selectPhysicalDevice(await listAttachedPhysicalDevices(runner), options);
}

export function buildMobileDeviceRunCommand(
  input: BuildMobileDeviceRunCommandInput
): MobileDeviceRunCommand {
  return {
    command: "pnpm",
    args: [
      "--dir",
      `${input.repoRoot}/apps/mobile`,
      "ios",
      "--device",
      input.deviceUdid,
      "--port",
      String(input.metroPort)
    ],
    cwd: input.repoRoot,
    env: {
      REACT_NATIVE_PACKAGER_HOSTNAME: input.lanHost,
      RCT_METRO_PORT: String(input.metroPort)
    }
  };
}

export function resolveMobileBundleId(env: NodeJS.ProcessEnv): string {
  const explicit = env.KANNA_IOS_BUNDLE_ID?.trim();
  if (explicit) {
    return explicit;
  }

  const appEnv = env.KANNA_APP_ENV?.trim() || "dev";
  if (appEnv === "production") {
    return mobileBundleIds.prod;
  }
  return mobileBundleIds[appEnv as keyof typeof mobileBundleIds] ?? mobileBundleIds.dev;
}

export async function checkPhysicalDeviceRunPreflight(
  runner: CommandRunner,
  input: PhysicalDeviceRunPreflightInput
): Promise<PhysicalDeviceRunPreflightResult> {
  const metroUrl = `http://${input.lanHost}:${input.metroPort}`;
  const checks: PhysicalDeviceRunPreflightCheck[] = [];

  const metro = await runner.run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    `${metroUrl}/status`
  ]);
  checks.push(
    metro.exitCode === 0 && metro.stdout.includes("packager-status:running")
      ? { name: "metro-lan", ok: true, message: `Metro is reachable at ${metroUrl}/status.` }
      : {
          name: "metro-lan",
          ok: false,
          message:
            `Metro is not reachable at ${metroUrl}/status. ` +
            `"No script URL provided" usually means Metro is down or the app was launched against the wrong port.`
        }
  );

  const apps = await runner.run("xcrun", [
    "devicectl",
    "device",
    "info",
    "apps",
    "--device",
    input.device.udid
  ]);
  checks.push(
    apps.exitCode === 0 && apps.stdout.includes(input.bundleId)
      ? {
          name: "app-installed",
          ok: true,
          message: `${input.bundleId} is installed on ${input.device.name}.`
        }
      : {
          name: "app-installed",
          ok: false,
          message:
            `${input.bundleId} is not installed on ${input.device.name} yet. ` +
            "The run command will build, install, and launch it."
        }
  );

  checks.push({
    name: "local-network-permission",
    ok: true,
    message:
      "On the iPhone, allow Local Network for Kanna in Settings -> Privacy & Security -> Local Network."
  });

  return {
    ok: checks.every((check) => check.ok),
    metroUrl,
    checks
  };
}
