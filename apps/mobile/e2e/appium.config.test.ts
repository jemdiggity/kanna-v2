import { describe, expect, it } from "vitest";
import {
  createPhysicalDeviceCapabilities,
  createSimulatorCapabilities,
  deriveWdaLocalPort
} from "./appium.config";

describe("mobile Appium config", () => {
  it("derives WDA from the assigned Appium port", () => {
    expect(deriveWdaLocalPort(4723)).toBe(4724);
  });

  it("skips reserved kd ports so WDA does not collide with the transfer port", () => {
    // kd assigns appium 4915 / transfer 4916 adjacently; +1 would collide
    // with KANNA_TRANSFER_PORT held by the running desktop server.
    expect(deriveWdaLocalPort(4915, [4916])).toBe(4917);
    // Skips a run of reserved ports.
    expect(deriveWdaLocalPort(4915, [4916, 4917, 4918])).toBe(4919);
  });

  it("passes reserved ports through to physical-device capabilities", () => {
    expect(
      createPhysicalDeviceCapabilities({
        appiumPort: 4915,
        bundleId: "build.kanna.app",
        deviceName: "Jerome's iPhone 15",
        deviceUdid: "00008130-001015CA1091401C",
        reservedPorts: [4916]
      })
    ).toMatchObject({
      "appium:wdaLocalPort": 4917
    });
  });

  it("builds simulator capabilities with the configured bundle id", () => {
    expect(
      createSimulatorCapabilities({
        appiumPort: 4723,
        deviceName: "iPhone 15",
        bundleId: "build.kanna.app"
      })
    ).toMatchObject({
      platformName: "iOS",
      "appium:automationName": "XCUITest",
      "appium:deviceName": "iPhone 15",
      "appium:bundleId": "build.kanna.app",
      "appium:autoLaunch": false,
      "appium:wdaLocalPort": 4724,
      "appium:wdaLaunchTimeout": 180_000,
      "appium:noReset": false,
      "appium:autoDismissAlerts": true,
      "appium:includeSafariInWebviews": true,
      "appium:webviewConnectTimeout": 15_000
    });
  });

  it("accepts simulator permission alerts for the Bonjour-backed hybrid lane", () => {
    expect(
      createSimulatorCapabilities({
        appiumPort: 4723,
        deviceName: "iPhone 17 Pro",
        bundleId: "build.kanna.app.dev",
        alertHandling: "accept"
      })
    ).toMatchObject({
      "appium:autoAcceptAlerts": true
    });
    expect(
      createSimulatorCapabilities({
        appiumPort: 4723,
        deviceName: "iPhone 17 Pro",
        bundleId: "build.kanna.app.dev",
        alertHandling: "accept"
      })
    ).not.toHaveProperty("appium:autoDismissAlerts");
  });

  it("leaves native alerts under test control for native-modal journeys", () => {
    const capabilities = createSimulatorCapabilities({
      alertHandling: "manual",
      appiumPort: 4723,
      deviceName: "iPhone 17 Pro",
      bundleId: "build.kanna.app.dev"
    });

    expect(capabilities).not.toHaveProperty("appium:autoAcceptAlerts");
    expect(capabilities).not.toHaveProperty("appium:autoDismissAlerts");
  });
  it("builds real-device capabilities with the selected UDID", () => {
    expect(
      createPhysicalDeviceCapabilities({
        appiumPort: 4723,
        bundleId: "build.kanna.app",
        deviceName: "Jeremy's iPhone",
        deviceUdid: "00008110-001234560E10801E",
        xcodeOrgId: "EA4J68749Z",
        updatedWdaBundleId: "build.kanna.app.webdriveragentrunner"
      })
    ).toMatchObject({
      platformName: "iOS",
      "appium:automationName": "XCUITest",
      "appium:udid": "00008110-001234560E10801E",
      "appium:deviceName": "Jeremy's iPhone",
      "appium:bundleId": "build.kanna.app",
      "appium:wdaLocalPort": 4724,
      "appium:forceAppLaunch": true,
      "appium:shouldTerminateApp": true,
      "appium:xcodeOrgId": "EA4J68749Z",
      "appium:xcodeSigningId": "Apple Development",
      "appium:updatedWDABundleId": "build.kanna.app.webdriveragentrunner"
    });
  });
});
