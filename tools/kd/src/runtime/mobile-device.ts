import type { CommandRunner } from "./process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AvailablePhysicalDevice {
  name: string;
  udid: string;
  platformVersion: string;
}

export interface AvailableSimulatorDevice {
  deviceTypeIdentifier: string;
  lastBootedAt?: string;
  name: string;
  runtime: string;
  state: string;
  udid: string;
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

interface SimctlDeviceRecord {
  deviceTypeIdentifier?: string;
  isAvailable?: boolean;
  lastBootedAt?: string;
  name?: string;
  state?: string;
  udid?: string;
}

interface SimctlDeviceList {
  devices?: Record<string, SimctlDeviceRecord[]>;
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

export interface MobileIosWorkspace {
  scheme: string;
  workspacePath: string;
}

interface BuildMobileDeviceReleaseBuildCommandInput {
  derivedDataPath: string;
  deviceUdid: string;
  nativeIdentity: MobileNativeIdentity;
  repoRoot: string;
  workspace: MobileIosWorkspace;
}

interface BuildMobileDevicePrebuildCommandInput {
  nativeIdentity: MobileNativeIdentity;
  repoRoot: string;
}

interface BuildMobileDeviceRelaunchCommandInput {
  bundleId: string;
  devClientScheme: string;
  deviceUdid: string;
  lanHost: string;
  metroPort: number;
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
  devClientScheme: string;
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

// Expo Dev Client derives this from the app config slug (`kanna-mobile`) and
// prefers it over the app's environment-specific deep-link schemes.
const mobileDevClientScheme = "exp+kanna-mobile";

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

function simulatorRuntimeParts(runtime: string): number[] {
  const version = runtime.match(/\.SimRuntime\.iOS-(.+)$/)?.[1] ?? "0";
  return version.split("-").map((part) => Number.parseInt(part, 10) || 0);
}

function compareSimulatorRuntime(left: string, right: string): number {
  const leftParts = simulatorRuntimeParts(left);
  const rightParts = simulatorRuntimeParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function simulatorPreference(
  left: AvailableSimulatorDevice,
  right: AvailableSimulatorDevice
): number {
  // Preserve the historical default of choosing an iPhone while allowing an
  // explicitly named iPad for tablet workspace development.
  const leftIsIPhone = left.deviceTypeIdentifier.includes(".SimDeviceType.iPhone-");
  const rightIsIPhone = right.deviceTypeIdentifier.includes(".SimDeviceType.iPhone-");
  const familyDifference = Number(rightIsIPhone) - Number(leftIsIPhone);
  if (familyDifference !== 0) return familyDifference;
  const bootDifference = Number(right.state === "Booted") - Number(left.state === "Booted");
  if (bootDifference !== 0) return bootDifference;
  const runtimeDifference = compareSimulatorRuntime(left.runtime, right.runtime);
  if (runtimeDifference !== 0) return runtimeDifference;
  const leftModel = Number.parseInt(left.name.match(/^iPhone (\d+)/)?.[1] ?? "0", 10);
  const rightModel = Number.parseInt(right.name.match(/^iPhone (\d+)/)?.[1] ?? "0", 10);
  return rightModel - leftModel;
}

function formatSimulatorList(devices: readonly AvailableSimulatorDevice[]): string {
  return devices
    .map((device) => `${device.name} (${device.udid}, ${device.runtime.split(".").at(-1) ?? device.runtime})`)
    .join(", ");
}

export function parseSimctlDeviceList(stdout: string): AvailableSimulatorDevice[] {
  const parsed = JSON.parse(stdout) as SimctlDeviceList;
  const devices: AvailableSimulatorDevice[] = [];
  for (const [runtime, runtimeDevices] of Object.entries(parsed.devices ?? {})) {
    for (const device of runtimeDevices) {
      if (
        device.isAvailable !== true ||
        !device.deviceTypeIdentifier ||
        (!device.deviceTypeIdentifier.includes(".SimDeviceType.iPhone-") &&
          !device.deviceTypeIdentifier.includes(".SimDeviceType.iPad-")) ||
        !device.name ||
        !device.state ||
        !device.udid
      ) {
        continue;
      }
      devices.push({
        deviceTypeIdentifier: device.deviceTypeIdentifier,
        ...(device.lastBootedAt ? { lastBootedAt: device.lastBootedAt } : {}),
        name: device.name,
        runtime,
        state: device.state,
        udid: device.udid
      });
    }
  }
  return devices.sort(simulatorPreference);
}

export function selectSimulatorDevice(
  devices: readonly AvailableSimulatorDevice[],
  requested?: string
): AvailableSimulatorDevice {
  if (!devices.length) {
    throw new Error(
      "No available iPhone or iPad simulators were found. Install an iOS Simulator runtime in Xcode Settings > Components."
    );
  }
  const ordered = [...devices].sort(simulatorPreference);
  if (!requested) return ordered[0];
  const matches = ordered.filter(
    (device) => device.udid === requested || device.name === requested
  );
  if (matches.length > 0) return matches[0];
  throw new Error(
    `Requested iOS simulator "${requested}" was not found. Available simulators: ${formatSimulatorList(ordered)}`
  );
}

export async function listAvailableSimulatorDevices(
  runner: CommandRunner
): Promise<AvailableSimulatorDevice[]> {
  const result = await runner.run("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || "Failed to list available iOS simulators with xcrun simctl.");
  }
  return parseSimctlDeviceList(result.stdout);
}

export async function resolveSimulatorDevice(
  runner: CommandRunner,
  requested?: string
): Promise<AvailableSimulatorDevice> {
  return selectSimulatorDevice(await listAvailableSimulatorDevices(runner), requested);
}

export function buildMobileSimulatorBootCommandPlan(
  device: AvailableSimulatorDevice
): Array<Omit<MobileDeviceRunCommand, "cwd" | "env">> {
  return [
    ...(device.state === "Booted"
      ? []
      : [{ command: "xcrun", args: ["simctl", "boot", device.udid] }]),
    { command: "xcrun", args: ["simctl", "bootstatus", device.udid, "-b"] },
    { command: "open", args: ["-a", "Simulator", "--args", "-CurrentDeviceUDID", device.udid] }
  ];
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

export function resolveMobileIosWorkspace(repoRoot: string): MobileIosWorkspace {
  const iosDir = join(repoRoot, "apps", "mobile", "ios");
  const workspaces = existsSync(iosDir)
    ? readdirSync(iosDir).filter((entry) => entry.endsWith(".xcworkspace"))
    : [];
  if (workspaces.length !== 1) {
    throw new Error(
      `Expected exactly one .xcworkspace in ${iosDir} after prebuild and pod install, found: ` +
        `${workspaces.join(", ") || "<none>"}. A missing workspace usually means pod install failed.`
    );
  }
  return {
    scheme: basename(workspaces[0], ".xcworkspace"),
    workspacePath: join(iosDir, workspaces[0])
  };
}

export function mobileDeviceDerivedDataPath(repoRoot: string, appEnv: MobileAppEnv): string {
  return join(repoRoot, ".build", "mobile", `ios-device-${appEnv}`);
}

// Build with xcodebuild directly instead of `expo run:ios`: Expo CLI only
// passes -allowProvisioningUpdates when the pbxproj has no DEVELOPMENT_TEAM,
// and prebuild always writes ours (ios.appleTeamId). Without that flag,
// automatic signing cannot regenerate the provisioning profile when the app's
// entitlements change (e.g. aps-environment for push), so the build fails
// against a stale profile. The archive flow already builds this way.
export function buildMobileDeviceReleaseBuildCommand(
  input: BuildMobileDeviceReleaseBuildCommandInput
): MobileDeviceRunCommand {
  return {
    command: "xcodebuild",
    args: [
      "-workspace",
      input.workspace.workspacePath,
      "-scheme",
      input.workspace.scheme,
      "-configuration",
      "Release",
      "-destination",
      `id=${input.deviceUdid}`,
      "-derivedDataPath",
      input.derivedDataPath,
      "-allowProvisioningUpdates",
      "-allowProvisioningDeviceRegistration",
      "build"
    ],
    cwd: input.repoRoot,
    env: {
      KANNA_APP_ENV: input.nativeIdentity.appEnv
    }
  };
}

export function resolveMobileReleaseAppPath(derivedDataPath: string): string {
  const productsDir = join(derivedDataPath, "Build", "Products", "Release-iphoneos");
  const apps = existsSync(productsDir)
    ? readdirSync(productsDir).filter((entry) => entry.endsWith(".app"))
    : [];
  if (apps.length !== 1) {
    throw new Error(
      `Expected exactly one .app in ${productsDir} after the Release build, found: ` +
        `${apps.join(", ") || "<none>"}.`
    );
  }
  return join(productsDir, apps[0]);
}

export function buildMobileDeviceInstallAppCommand(input: {
  appPath: string;
  deviceUdid: string;
}): Omit<MobileDeviceRunCommand, "cwd" | "env"> {
  return {
    command: "xcrun",
    args: ["devicectl", "device", "install", "app", "--device", input.deviceUdid, input.appPath]
  };
}

export function buildMobileDeviceListAppsCommand(input: {
  deviceUdid: string;
}): Omit<MobileDeviceRunCommand, "cwd" | "env"> {
  return {
    command: "xcrun",
    args: ["devicectl", "device", "info", "apps", "--device", input.deviceUdid]
  };
}

export function buildMobileDeviceUninstallAppCommand(input: {
  bundleId: string;
  deviceUdid: string;
}): Omit<MobileDeviceRunCommand, "cwd" | "env"> {
  return {
    command: "xcrun",
    args: [
      "devicectl",
      "device",
      "uninstall",
      "app",
      "--device",
      input.deviceUdid,
      input.bundleId
    ]
  };
}

export function isMobileDeviceAppInstalled(stdout: string, bundleId: string): boolean {
  const escapedBundleId = bundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9.-])${escapedBundleId}($|[^A-Za-z0-9.-])`, "m").test(stdout);
}

export function buildMobileDeviceLaunchAppCommand(input: {
  bundleId: string;
  deviceUdid: string;
}): Omit<MobileDeviceRunCommand, "cwd" | "env"> {
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
  const metroUrl = `http://${input.lanHost}:${input.metroPort}`;
  const payloadUrl = `${input.devClientScheme}://expo-development-client/?url=${encodeURIComponent(metroUrl)}`;
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
      "--payload-url",
      payloadUrl,
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
    devClientScheme: mobileDevClientScheme,
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

  const listAppsCommand = buildMobileDeviceListAppsCommand({ deviceUdid: input.device.udid });
  const apps = await runner.run(listAppsCommand.command, listAppsCommand.args);
  checks.push(
    apps.exitCode === 0 && isMobileDeviceAppInstalled(apps.stdout, input.bundleId)
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
