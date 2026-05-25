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
      "appium:wdaLocalPort": 4724
    });
  });

  it("builds real-device capabilities with the selected UDID", () => {
    expect(
      createPhysicalDeviceCapabilities({
        appiumPort: 4723,
        bundleId: "build.kanna.app",
        deviceName: "Jeremy's iPhone",
        deviceUdid: "00008110-001234560E10801E",
        xcodeOrgId: "GY3LFAA59P",
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
      "appium:xcodeOrgId": "GY3LFAA59P",
      "appium:xcodeSigningId": "Apple Development",
      "appium:updatedWDABundleId": "build.kanna.app.webdriveragentrunner"
    });
  });
});
