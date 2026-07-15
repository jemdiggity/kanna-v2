import type { CommandRunner } from "./process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  nativeIdentity?: MobileNativeIdentity;
  repoRoot: string;
}

interface BuildMobileDeviceReleaseInstallCommandInput {
  deviceUdid: string;
  nativeIdentity: MobileNativeIdentity;
  repoRoot: string;
}

interface BuildMobileDevicePrebuildCommandInput {
  nativeIdentity: MobileNativeIdentity;
  repoRoot: string;
}

interface BuildMobileDeviceRelaunchCommandInput {
  bundleId: string;
  deviceUdid: string;
}

interface PhysicalDeviceRunPreflightInput {
  bundleId: string;
  device: AvailablePhysicalDevice;
  lanHost: string;
  metroPort: number;
}

export interface PhysicalDeviceMetroReadinessInput {
  lanHost: string;
  metroPort: number;
  attempts?: number;
  delayMs?: number;
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

export interface PhysicalDeviceMetroReadinessResult {
  ok: boolean;
  metroUrl: string;
  attempts: number;
  message: string;
}

const mobileBundleIds = {
  dev: "build.kanna.app.dev",
  staging: "build.kanna.app.staging",
  prod: "build.kanna.app"
};

type MobileAppEnv = "dev" | "staging" | "prod";

interface MobileEnvironmentRecord {
  name: MobileAppEnv;
  displayName: string;
  iosBundleId: string;
}

const fallbackMobileEnvironmentRegistry = {
  dev: {
    name: "dev",
    displayName: "Kanna Dev",
    iosBundleId: mobileBundleIds.dev
  },
  staging: {
    name: "staging",
    displayName: "Kanna Staging",
    iosBundleId: mobileBundleIds.staging
  },
  prod: {
    name: "prod",
    displayName: "Kanna",
    iosBundleId: mobileBundleIds.prod
  }
} satisfies Record<MobileAppEnv, MobileEnvironmentRecord>;

export interface MobileNativeIdentity {
  appEnv: MobileAppEnv;
  bundleId: string;
  displayName: string;
}

const repoRootFromThisFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  ".."
);
const mobileEnvironmentsPath = join(
  repoRootFromThisFile,
  "apps",
  "mobile",
  "src",
  "mobileEnvironments.json"
);
let mobileEnvironmentRegistry: Record<MobileAppEnv, MobileEnvironmentRecord> | undefined;

function readMobileEnvironmentRegistry(): Record<MobileAppEnv, MobileEnvironmentRecord> {
  if (mobileEnvironmentRegistry) {
    return mobileEnvironmentRegistry;
  }
  if (!existsSync(mobileEnvironmentsPath)) {
    mobileEnvironmentRegistry = fallbackMobileEnvironmentRegistry;
    return mobileEnvironmentRegistry;
  }
  mobileEnvironmentRegistry = JSON.parse(readFileSync(mobileEnvironmentsPath, "utf8")) as Record<
    MobileAppEnv,
    MobileEnvironmentRecord
  >;
  return mobileEnvironmentRegistry;
}

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
  const nativeIdentity = input.nativeIdentity;
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
      ...(nativeIdentity
        ? {
            KANNA_APP_ENV: nativeIdentity.appEnv
          }
        : {}),
      REACT_NATIVE_PACKAGER_HOSTNAME: input.lanHost,
      RCT_METRO_PORT: String(input.metroPort)
    }
  };
}

export function buildMobileDeviceReleaseInstallCommand(
  input: BuildMobileDeviceReleaseInstallCommandInput
): MobileDeviceRunCommand {
  return {
    command: "pnpm",
    args: [
      "--dir",
      `${input.repoRoot}/apps/mobile`,
      "exec",
      "expo",
      "run:ios",
      "--configuration",
      "Release",
      "--no-bundler",
      "--device",
      input.deviceUdid
    ],
    cwd: input.repoRoot,
    env: {
      KANNA_APP_ENV: input.nativeIdentity.appEnv
    }
  };
}

export function buildMobileDevicePrebuildCommand(
  input: BuildMobileDevicePrebuildCommandInput
): MobileDeviceRunCommand {
  return {
    command: "pnpm",
    args: [
      "--dir",
      `${input.repoRoot}/apps/mobile`,
      "exec",
      "expo",
      "prebuild",
      "--platform",
      "ios"
    ],
    cwd: input.repoRoot,
    env: {
      KANNA_APP_ENV: input.nativeIdentity.appEnv
    }
  };
}

export function buildMobileDeviceRelaunchCommand(
  input: BuildMobileDeviceRelaunchCommandInput
): Omit<MobileDeviceRunCommand, "cwd" | "env"> {
  return {
    command: "xcrun",
    args: [
      "devicectl",
      "device",
      "process",
      "launch",
      "--terminate-existing",
      "--device",
      input.deviceUdid,
      input.bundleId
    ]
  };
}

export function resolveMobileBundleId(env: NodeJS.ProcessEnv): string {
  return resolveMobileNativeIdentity(env).bundleId;
}

function resolveMobileAppEnv(env: NodeJS.ProcessEnv): MobileAppEnv {
  const appEnv = env.KANNA_APP_ENV?.trim() || "dev";
  if (appEnv === "production") {
    return "prod";
  }
  if (appEnv === "dev" || appEnv === "staging" || appEnv === "prod") {
    return appEnv;
  }
  return "dev";
}

export function resolveMobileNativeIdentity(env: NodeJS.ProcessEnv): MobileNativeIdentity {
  const appEnv = resolveMobileAppEnv(env);
  const environment = readMobileEnvironmentRegistry()[appEnv];
  const explicitBundleId = env.KANNA_IOS_BUNDLE_ID?.trim();
  return {
    appEnv,
    bundleId: explicitBundleId || environment.iosBundleId || mobileBundleIds[appEnv],
    displayName: environment.displayName
  };
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

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForPhysicalDeviceMetroReadiness(
  runner: CommandRunner,
  input: PhysicalDeviceMetroReadinessInput
): Promise<PhysicalDeviceMetroReadinessResult> {
  const metroUrl = `http://${input.lanHost}:${input.metroPort}`;
  const attempts = Math.max(1, input.attempts ?? 30);
  const delayMs = Math.max(0, input.delayMs ?? 1000);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await runner.run("curl", [
      "--fail",
      "--silent",
      "--show-error",
      `${metroUrl}/status`
    ]);
    if (result.exitCode === 0 && result.stdout.includes("packager-status:running")) {
      return {
        ok: true,
        metroUrl,
        attempts: attempt,
        message: `Metro is reachable at ${metroUrl}/status.`
      };
    }
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  return {
    ok: false,
    metroUrl,
    attempts,
    message:
      `Metro is not reachable at ${metroUrl}/status after ${attempts} attempts. ` +
      `"No script URL provided" usually means Metro is down, the iPhone cannot reach the printed LAN URL, or Local Network permission is off.`
  };
}
