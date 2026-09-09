import { execFile, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { waitFor } from "./wait";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const APPIUM_ENTRYPOINT = require.resolve("appium/index.js");
const XCUI_TEST_DRIVER_NAME = "xcuitest";
const XCUI_TEST_DRIVER_SPEC = "xcuitest@9.9.1";

export interface InstalledAppiumDriver {
  appiumVersion?: string;
  version?: string;
}

interface AppiumIosDeviceUtilitiesModule {
  getConnectedDevices?: () => Promise<string[]>;
}

export function getDefaultAppiumHome(homePath = homedir()): string {
  return `${homePath}/.appium`;
}

export function getXcuitestDeviceUtilitiesPath(appiumHome: string): string {
  return join(
    appiumHome,
    "node_modules",
    "appium-xcuitest-driver",
    "node_modules",
    "appium-ios-device",
    "build",
    "lib",
    "utilities.js"
  );
}

export function resolveAppiumEnv(
  env: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    APPIUM_HOME: env.APPIUM_HOME?.trim() || getDefaultAppiumHome()
  };
}

export function isXcuitestDriverCompatible(
  driver: InstalledAppiumDriver | undefined
): boolean {
  return /\b2\./.test(driver?.appiumVersion ?? "");
}

async function execAppium(args: string[], env: Record<string, string | undefined>) {
  return execFileAsync(process.execPath, [APPIUM_ENTRYPOINT, ...args], {
    env: resolveAppiumEnv(env)
  });
}

export async function listInstalledAppiumDrivers(
  env: Record<string, string | undefined>
): Promise<Record<string, InstalledAppiumDriver>> {
  const { stdout } = await execAppium(["driver", "list", "--installed", "--json"], env);
  return JSON.parse(stdout) as Record<string, InstalledAppiumDriver>;
}

export async function ensureXcuitestDriverInstalled(
  env: Record<string, string | undefined>
): Promise<void> {
  const installedDrivers = await listInstalledAppiumDrivers(env);
  const installedDriver = installedDrivers[XCUI_TEST_DRIVER_NAME];

  if (isXcuitestDriverCompatible(installedDriver)) {
    return;
  }

  if (installedDriver) {
    await execAppium(["driver", "uninstall", XCUI_TEST_DRIVER_NAME], env);
  }

  await execAppium(["driver", "install", XCUI_TEST_DRIVER_SPEC], env);
}

export async function assertXcuitestDriverInstalled(
  env: Record<string, string | undefined>
): Promise<void> {
  const installedDrivers = await listInstalledAppiumDrivers(env);
  if (isXcuitestDriverCompatible(installedDrivers[XCUI_TEST_DRIVER_NAME])) {
    return;
  }

  const appiumHome = resolveAppiumEnv(env).APPIUM_HOME;
  throw new Error(
    `A compatible Appium XCUITest driver was not found in ${appiumHome}. Install it with: pnpm --dir apps/mobile run test:e2e:appium:install-xcuitest`
  );
}

export async function listXcuitestConnectedDeviceUdids(
  env: Record<string, string | undefined>
): Promise<string[]> {
  const appiumHome = resolveAppiumEnv(env).APPIUM_HOME ?? getDefaultAppiumHome();
  const utilitiesPath = getXcuitestDeviceUtilitiesPath(appiumHome);

  let utilitiesModule: AppiumIosDeviceUtilitiesModule;
  try {
    utilitiesModule = require(utilitiesPath) as AppiumIosDeviceUtilitiesModule;
  } catch (error) {
    throw new Error(
      `Failed to load Appium iOS device utilities from ${utilitiesPath}. Reinstall the Appium XCUITest driver if its files are missing.`
    );
  }

  if (typeof utilitiesModule.getConnectedDevices !== "function") {
    throw new Error(
      `Appium iOS device utilities at ${utilitiesPath} did not expose getConnectedDevices().`
    );
  }

  return await utilitiesModule.getConnectedDevices();
}

export function startLocalAppiumServer(
  port: number,
  env: Record<string, string | undefined> = process.env
): ChildProcess {
  return spawn(process.execPath, [APPIUM_ENTRYPOINT, "server", "--port", String(port)], {
    env: resolveAppiumEnv(env),
    stdio: "inherit"
  });
}

export async function waitForLocalAppiumServer(port: number): Promise<void> {
  await waitFor(
    `Appium server on port ${port}`,
    async (recordReason) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`);
        if (response.ok) return true;
        recordReason(`GET /status answered ${response.status} ${response.statusText}`);
        return null;
      } catch (error) {
        recordReason(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
    {
      intervalMs: 500,
      timeoutMs: 15_000
    }
  );
}

const WDA_RUNNER_BUNDLE_ID = "com.facebook.WebDriverAgentRunner.xctrunner";

export async function stopSimulatorWebDriverAgent(deviceUdid: string): Promise<void> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,command="]);
  const builds = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.includes("WebDriverAgent.xcodeproj") &&
      line.includes(`-destination id=${deviceUdid}`)
    )
    .map((line) => Number.parseInt(line, 10))
    .filter(Number.isInteger);

  for (const pid of builds) {
    // Appium starts each WDA build as its own process group. Target that exact
    // group so a cancelled relay lane cannot strand its build or helpers.
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  }
  await execFileAsync("xcrun", [
    "simctl", "terminate", deviceUdid, WDA_RUNNER_BUNDLE_ID
  ]).catch(() => undefined);
}

async function main() {
  const command = process.argv[2];
  if (command === "install-xcuitest") {
    await ensureXcuitestDriverInstalled(process.env as Record<string, string | undefined>);
    return;
  }

  const rawPort = process.env.KANNA_APPIUM_PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : 4723;
  if (command === "start") {
    startLocalAppiumServer(port, process.env as Record<string, string | undefined>);
    await waitForLocalAppiumServer(port);
    return;
  }

  throw new Error(`Unsupported appium helper command: ${command ?? "<missing>"}`);
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  void main();
}
