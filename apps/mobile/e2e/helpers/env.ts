import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type MobileE2eTarget = "simulator" | "device";

interface MobileAppConfig {
  expo?: {
    ios?: {
      appleTeamId?: string;
      bundleIdentifier?: string;
    };
  };
}

export interface MobileE2eEnv {
  appiumPort: number;
  bundleId: string;
  desktopServerUrl: string;
  metroPort: number;
  target: MobileE2eTarget;
  deviceName?: string;
  deviceUdid?: string;
  physicalDeviceName?: string;
  xcodeOrgId?: string;
  xcodeSigningId?: string;
  updatedWdaBundleId?: string;
  /**
   * Other kd-assigned ports the WDA forwarding port must avoid (transfer,
   * webdriver, relay, firebase, etc.). The dev stack holds these while the
   * mobile run depends on it.
   */
  reservedPorts: number[];
}

/**
 * Collect every numeric `KANNA_*_PORT` env value except the Appium port, so
 * the WDA port can route around them.
 */
function collectReservedKannaPorts(
  env: Record<string, string | undefined>,
  appiumPort: number
): number[] {
  const ports = new Set<number>();
  for (const [key, value] of Object.entries(env)) {
    if (!/^KANNA_.*PORT$/.test(key)) continue;
    const port = Number.parseInt(value?.trim() ?? "", 10);
    if (Number.isNaN(port) || port === appiumPort) continue;
    ports.add(port);
  }
  return [...ports];
}

function readMobileAppConfig(): MobileAppConfig {
  const appConfigUrl = new URL("../../app.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(appConfigUrl.href), "utf8")) as MobileAppConfig;
}

export function resolveRequiredMobileE2eEnv(
  env: Record<string, string | undefined>
): MobileE2eEnv {
  const rawAppiumPort = env.KANNA_APPIUM_PORT?.trim();
  if (!rawAppiumPort) {
    throw new Error(
      "KANNA_APPIUM_PORT is required. Start Kanna with ./kd dev up --mobile."
    );
  }

  const appiumPort = Number.parseInt(rawAppiumPort, 10);
  if (Number.isNaN(appiumPort)) {
    throw new Error(`KANNA_APPIUM_PORT must be an integer, got: ${rawAppiumPort}`);
  }

  const rawMetroPort = env.KANNA_MOBILE_PORT?.trim();
  const metroPort = rawMetroPort ? Number.parseInt(rawMetroPort, 10) : 8081;
  if (Number.isNaN(metroPort)) {
    throw new Error(`KANNA_MOBILE_PORT must be an integer, got: ${rawMetroPort}`);
  }

  const desktopServerUrl = env.KANNA_E2E_DESKTOP_SERVER_URL?.trim();
  if (!desktopServerUrl) {
    throw new Error(
      "KANNA_E2E_DESKTOP_SERVER_URL is required. Start Kanna with ./kd dev up --mobile."
    );
  }

  const target = env.KANNA_IOS_E2E_TARGET?.trim() === "device" ? "device" : "simulator";
  const appConfig = readMobileAppConfig();
  const defaultBundleId =
    appConfig.expo?.ios?.bundleIdentifier?.trim() || "build.kanna.app";
  const bundleId = env.KANNA_IOS_BUNDLE_ID?.trim() || defaultBundleId;
  const xcodeOrgId =
    env.KANNA_IOS_XCODE_ORG_ID?.trim() || appConfig.expo?.ios?.appleTeamId?.trim() || undefined;
  const xcodeSigningId = env.KANNA_IOS_XCODE_SIGNING_ID?.trim() || "Apple Development";
  const updatedWdaBundleId =
    env.KANNA_IOS_WDA_BUNDLE_ID?.trim() || `${bundleId}.webdriveragentrunner`;

  return {
    appiumPort,
    bundleId,
    desktopServerUrl,
    metroPort,
    target,
    deviceName: env.KANNA_IOS_SIMULATOR_NAME?.trim() || undefined,
    deviceUdid: env.KANNA_IOS_DEVICE_UDID?.trim() || undefined,
    physicalDeviceName: env.KANNA_IOS_PHYSICAL_DEVICE_NAME?.trim() || undefined,
    xcodeOrgId,
    xcodeSigningId,
    updatedWdaBundleId,
    reservedPorts: collectReservedKannaPorts(env, appiumPort)
  };
}
