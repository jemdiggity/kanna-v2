export type SimulatorAlertHandling = "accept" | "dismiss" | "manual";

export interface SimulatorCapabilityInput {
  appiumPort: number;
  alertHandling?: SimulatorAlertHandling;
  bundleId: string;
  deviceName: string;
  platformVersion?: string;
  reservedPorts?: number[];
}

export interface PhysicalDeviceCapabilityInput {
  appiumPort: number;
  bundleId: string;
  deviceName: string;
  deviceUdid: string;
  platformVersion?: string;
  xcodeOrgId?: string;
  xcodeSigningId?: string;
  updatedWdaBundleId?: string;
  reservedPorts?: number[];
}

/**
 * Pick the WDA forwarding port, normally appiumPort + 1, but skipping any
 * reserved port. The kd dev stack assigns adjacent ports (e.g. appium 4915,
 * transfer 4916), so the naive +1 collides with KANNA_TRANSFER_PORT while the
 * desktop server — which the mobile run depends on — is holding it. Threading
 * the reserved kd ports through here keeps the device smoke runnable with the
 * dev stack up.
 */
export function deriveWdaLocalPort(
  appiumPort: number,
  reservedPorts: number[] = []
): number {
  const reserved = new Set([appiumPort, ...reservedPorts]);
  let candidate = appiumPort + 1;
  while (reserved.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

export function createSimulatorCapabilities(input: SimulatorCapabilityInput) {
  const alertHandling = input.alertHandling ?? "dismiss";

  return {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    // Expo reads --initialUrl only when its development client starts. The
    // relay runner owns that first launch after WebDriverAgent is attached.
    "appium:autoLaunch": false,
    "appium:deviceName": input.deviceName,
    "appium:bundleId": input.bundleId,
    "appium:wdaLocalPort": deriveWdaLocalPort(
      input.appiumPort,
      input.reservedPorts
    ),
    // A cold Xcode 26 simulator build can exceed Appium's 60s default. If
    // Appium retries while the first install is still finishing, that stale
    // install replaces the live WDA runner and drops the automation session.
    "appium:wdaLaunchTimeout": 180_000,
    "appium:newCommandTimeout": 120,
    "appium:noReset": false,
    ...(alertHandling === "accept"
      ? { "appium:autoAcceptAlerts": true }
      : alertHandling === "dismiss"
        ? { "appium:autoDismissAlerts": true }
        : {}),
    "appium:includeSafariInWebviews": true,
    "appium:webviewConnectTimeout": 15_000,
    ...(input.platformVersion
      ? { "appium:platformVersion": input.platformVersion }
      : {})
  };
}

export function createPhysicalDeviceCapabilities(
  input: PhysicalDeviceCapabilityInput
) {
  const xcodeSigningId = input.xcodeSigningId ?? "Apple Development";

  return {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:udid": input.deviceUdid,
    "appium:deviceName": input.deviceName,
    "appium:bundleId": input.bundleId,
    "appium:wdaLocalPort": deriveWdaLocalPort(
      input.appiumPort,
      input.reservedPorts
    ),
    "appium:newCommandTimeout": 120,
    "appium:noReset": true,
    "appium:forceAppLaunch": true,
    "appium:shouldTerminateApp": true,
    ...(input.xcodeOrgId ? { "appium:xcodeOrgId": input.xcodeOrgId } : {}),
    ...(xcodeSigningId ? { "appium:xcodeSigningId": xcodeSigningId } : {}),
    ...(input.updatedWdaBundleId
      ? { "appium:updatedWDABundleId": input.updatedWdaBundleId }
      : {}),
    ...(input.platformVersion
      ? { "appium:platformVersion": input.platformVersion }
      : {})
  };
}
