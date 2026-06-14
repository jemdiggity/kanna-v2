import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { selectPreferredLanAddress } from "./desktop";

const execFileAsync = promisify(execFile);

export interface AvailablePhysicalDevice {
  name: string;
  udid: string;
  platformVersion: string;
}

interface XctraceDeviceRecord {
  available?: boolean;
  ignored?: boolean;
  identifier?: string;
  name?: string;
  operatingSystemVersion?: string;
  platform?: string;
  simulator?: boolean;
}

function normalizePlatformVersion(rawVersion: string | undefined): string {
  return rawVersion?.split(" ")[0] ?? "unknown";
}

function formatDeviceList(devices: readonly AvailablePhysicalDevice[]): string {
  return devices.map((device) => `${device.name} (${device.udid})`).join(", ");
}

export function parseXcdeviceList(stdout: string): AvailablePhysicalDevice[] {
  const parsed = JSON.parse(stdout) as XctraceDeviceRecord[];

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

export function filterAppiumVisibleDevices(
  devices: readonly AvailablePhysicalDevice[],
  appiumVisibleUdids: readonly string[]
): AvailablePhysicalDevice[] {
  const visibleSet = new Set(appiumVisibleUdids);
  return devices.filter((device) => visibleSet.has(device.udid));
}

export function selectPhysicalDevice(
  devices: readonly AvailablePhysicalDevice[],
  requestedUdid?: string,
  appiumVisibleUdids?: readonly string[],
  requestedName?: string
): AvailablePhysicalDevice {
  if (!devices.length) {
    throw new Error(
      "No attached iPhone devices were found. Attach one over USB and trust this computer first."
    );
  }

  const selectableDevices = appiumVisibleUdids
    ? filterAppiumVisibleDevices(devices, appiumVisibleUdids)
    : [...devices];

  if (requestedUdid) {
    const requestedDevice = devices.find((device) => device.udid === requestedUdid);
    if (requestedDevice && !appiumVisibleUdids) {
      return requestedDevice;
    }

    const requestedSelectableDevice = selectableDevices.find(
      (device) => device.udid === requestedUdid
    );
    if (requestedSelectableDevice) {
      return requestedSelectableDevice;
    }

    if (requestedDevice) {
      throw new Error(
        `Requested iPhone UDID ${requestedUdid} is attached as ${requestedDevice.name}, but Appium/XCUITest cannot access it right now. Appium-visible devices: ${selectableDevices.length ? formatDeviceList(selectableDevices) : "none"}. Reconnect the device, unlock it, confirm trust and Developer Mode, or choose another device.`
      );
    }

    throw new Error(
      `Requested iPhone UDID ${requestedUdid} was not found. Attached devices: ${formatDeviceList(devices)}`
    );
  }

  if (requestedName) {
    const matchingDevices = selectableDevices.filter((device) => device.name === requestedName);
    if (matchingDevices.length === 1) {
      return matchingDevices[0];
    }

    if (matchingDevices.length > 1) {
      throw new Error(
        `Multiple attached iPhone devices matched ${requestedName}. Set KANNA_IOS_DEVICE_UDID to choose one device explicitly.`
      );
    }

    throw new Error(
      `Requested iPhone name ${requestedName} was not found. Appium-visible devices: ${selectableDevices.length ? formatDeviceList(selectableDevices) : "none"}.`
    );
  }

  if (!selectableDevices.length) {
    throw new Error(
      `No attached iPhone devices are available to Appium/XCUITest right now. Attached devices: ${formatDeviceList(devices)}. Unlock the phone, confirm trust and Developer Mode, or reconnect it over USB.`
    );
  }

  if (selectableDevices.length > 1) {
    throw new Error(
      `Multiple attached iPhone devices were found: ${formatDeviceList(selectableDevices)}. Set KANNA_IOS_DEVICE_UDID to choose one device.`
    );
  }

  return selectableDevices[0];
}

export async function listAttachedPhysicalDevices(): Promise<AvailablePhysicalDevice[]> {
  const { stdout } = await execFileAsync("xcrun", ["xcdevice", "list"]);
  return parseXcdeviceList(stdout);
}

export async function resolvePhysicalDevice(
  requestedUdid?: string,
  appiumVisibleUdids?: readonly string[],
  requestedName?: string
): Promise<AvailablePhysicalDevice> {
  const devices = await listAttachedPhysicalDevices();
  return selectPhysicalDevice(devices, requestedUdid, appiumVisibleUdids, requestedName);
}

export function buildPhysicalDeviceInstallCommand(
  deviceUdid: string,
  metroPort: number,
  resolvePackagerHostname: () => string | undefined = selectPreferredLanAddress
): string {
  // Pin REACT_NATIVE_PACKAGER_HOSTNAME to the Mac's LAN IP so the dev build
  // bakes a reachable Metro host. Without it RN defaults to 127.0.0.1, which
  // on the phone is the phone itself — producing "No script URL provided" and
  // a blank app that never mounts the shell.
  //
  // Pass --port (the worktree's Kanna-allocated KANNA_MOBILE_PORT, near the
  // .kanna/config.json base) so `expo run:ios` launches the dev build connected
  // to THIS worktree's Metro. expo run:ios otherwise targets its default 8081,
  // which is not where kd runs Metro — the app then launches against an empty
  // port and shows "No script URL provided". `expo run:ios` auto-skips its own
  // bundler when it detects the dev server already running on that port.
  const packagerHostname = resolvePackagerHostname();
  const hostPrefix = packagerHostname
    ? `REACT_NATIVE_PACKAGER_HOSTNAME=${packagerHostname} `
    : "";
  return `${hostPrefix}RCT_METRO_PORT=${metroPort} pnpm --dir apps/mobile ios --device ${deviceUdid} --port ${metroPort}`;
}

export async function assertPhysicalDeviceAppInstalled(
  device: AvailablePhysicalDevice,
  bundleId: string,
  metroPort = 8081
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
      `Failed to inspect installed apps on ${device.name}. Confirm Xcode device support is working, the device is unlocked, and Developer Mode is enabled.`
    );
  }

  if (!stdout.includes(bundleId)) {
    throw new Error(
      `Bundle ${bundleId} is not installed on ${device.name}. Install it with: ${buildPhysicalDeviceInstallCommand(device.udid, metroPort)}`
    );
  }
}
