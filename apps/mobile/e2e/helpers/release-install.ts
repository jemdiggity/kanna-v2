import { execFile } from "node:child_process";
import { promisify } from "node:util";
import environments from "../../src/mobileEnvironments.json";
import type { AvailablePhysicalDevice } from "./device";

const execFileAsync = promisify(execFile);

type ReleaseAppEnv = "dev" | "staging" | "prod";

export interface ReleaseInstallTarget {
  appEnv: ReleaseAppEnv;
  bundleId: string;
  displayName: string;
  runtimeVersion: string;
}

export function resolveReleaseInstallTarget(
  env: Record<string, string | undefined>
): ReleaseInstallTarget {
  const rawAppEnv = env.KANNA_APP_ENV?.trim();
  const appEnv = rawAppEnv === "production" ? "prod" : rawAppEnv;
  if (appEnv !== "dev" && appEnv !== "staging" && appEnv !== "prod") {
    throw new Error(
      "Set KANNA_APP_ENV to dev, staging, or prod so the release install check targets one native identity."
    );
  }

  const environment = environments[appEnv];
  return {
    appEnv,
    bundleId: env.KANNA_IOS_BUNDLE_ID?.trim() || environment.iosBundleId,
    displayName: environment.displayName,
    runtimeVersion: environment.runtimeVersion
  };
}

export function buildReleaseLaunchArgs(deviceUdid: string, bundleId: string): string[] {
  return [
    "devicectl",
    "device",
    "process",
    "launch",
    "--terminate-existing",
    "--device",
    deviceUdid,
    bundleId
  ];
}

export function formatMissingReleaseInstallMessage(
  target: ReleaseInstallTarget,
  deviceName: string
): string {
  const flag =
    target.appEnv === "staging" ? " --staging" : target.appEnv === "prod" ? " --production" : "";
  return (
    `${target.bundleId} (${target.displayName}) is not installed on ${deviceName}. ` +
    `Install it with: ./kd mobile run --device${flag} --install`
  );
}

export async function assertReleaseAppInstalled(
  device: AvailablePhysicalDevice,
  target: ReleaseInstallTarget
): Promise<void> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("xcrun", [
      "devicectl",
      "device",
      "info",
      "apps",
      "--device",
      device.udid
    ]));
  } catch {
    throw new Error(
      `Failed to inspect installed apps on ${device.name}. Confirm the device is unlocked, trusted, and has Developer Mode enabled.`
    );
  }

  if (!stdout.includes(target.bundleId)) {
    throw new Error(formatMissingReleaseInstallMessage(target, device.name));
  }
}

export async function launchReleaseApp(
  device: AvailablePhysicalDevice,
  target: ReleaseInstallTarget
): Promise<void> {
  try {
    await execFileAsync("xcrun", buildReleaseLaunchArgs(device.udid, target.bundleId));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to launch ${target.bundleId} on ${device.name}. Confirm the device is unlocked. Cause: ${detail}`
    );
  }
}
