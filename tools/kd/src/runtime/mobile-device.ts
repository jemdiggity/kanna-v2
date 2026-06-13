import type { CommandRunner } from "./process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export interface WrittenMobileNativeIdentity extends MobileNativeIdentity {
  path: string;
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
            KANNA_APP_ENV: nativeIdentity.appEnv,
            KANNA_BUNDLE_ID: nativeIdentity.bundleId,
            KANNA_DISPLAY_NAME: nativeIdentity.displayName
          }
        : {}),
      REACT_NATIVE_PACKAGER_HOSTNAME: input.lanHost,
      RCT_METRO_PORT: String(input.metroPort)
    }
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

export function renderMobileNativeIdentityXcconfig(
  identity: MobileNativeIdentity
): string {
  return [
    "// Generated by kd. Do not edit.",
    `KANNA_BUNDLE_ID = ${identity.bundleId}`,
    `KANNA_DISPLAY_NAME = ${identity.displayName}`,
    ""
  ].join("\n");
}

export function patchPbxprojNativeIdentity(pbxproj: string): string {
  const appListMatch = pbxproj.match(
    /([A-Z0-9_]+) \/\* Build configuration list for PBXNativeTarget "KannaMobile" \*\//
  );
  if (!appListMatch) {
    return pbxproj;
  }

  const listId = appListMatch[1];
  const listStart = pbxproj.indexOf(`${listId} /* Build configuration list`);
  const listEnd = pbxproj.indexOf("\n\t\t};", listStart);
  if (listStart === -1 || listEnd === -1) {
    return pbxproj;
  }

  const listBlock = pbxproj.slice(listStart, listEnd);
  const configIds = [...listBlock.matchAll(/\b([A-Z0-9_]+) \/\* (?:Debug|Release) \*\//g)].map(
    (match) => match[1]
  );
  let output = pbxproj;

  for (const configId of configIds) {
    const configStart = output.indexOf(`\t\t${configId} /* `);
    const configEnd = output.indexOf("\n\t\t};", configStart);
    if (configStart === -1 || configEnd === -1) {
      continue;
    }
    const before = output.slice(0, configStart);
    let block = output.slice(configStart, configEnd);
    const after = output.slice(configEnd);

    block = block.replace(
      /PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/,
      "PRODUCT_BUNDLE_IDENTIFIER = $(KANNA_BUNDLE_ID);"
    );
    block = block.replace(
      /INFOPLIST_KEY_CFBundleDisplayName = [^;]+;/,
      "INFOPLIST_KEY_CFBundleDisplayName = $(KANNA_DISPLAY_NAME);"
    );
    output = `${before}${block}${after}`;
  }

  return output;
}

export async function writeMobileNativeIdentityConfig(
  repoRoot: string,
  env: NodeJS.ProcessEnv
): Promise<WrittenMobileNativeIdentity> {
  const identity = resolveMobileNativeIdentity(env);
  const iosDir = join(repoRoot, "apps", "mobile", "ios");
  const path = join(repoRoot, "apps", "mobile", "ios", "KannaNativeIdentity.xcconfig");
  if (!existsSync(iosDir)) {
    return { ...identity, path };
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderMobileNativeIdentityXcconfig(identity));

  const pbxprojPath = join(
    repoRoot,
    "apps",
    "mobile",
    "ios",
    "KannaMobile.xcodeproj",
    "project.pbxproj"
  );
  if (existsSync(pbxprojPath)) {
    const original = await readFile(pbxprojPath, "utf8");
    const patched = patchPbxprojNativeIdentity(original);
    if (patched !== original) {
      await writeFile(pbxprojPath, patched);
    }
  }

  return { ...identity, path };
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
