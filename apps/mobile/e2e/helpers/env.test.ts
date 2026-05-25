import { describe, expect, it } from "vitest";
import { resolveRequiredMobileE2eEnv } from "./env";

describe("resolveRequiredMobileE2eEnv", () => {
  it("defaults to simulator mode", () => {
    expect(
      resolveRequiredMobileE2eEnv({
        KANNA_APPIUM_PORT: "4723",
        EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120"
      })
    ).toMatchObject({
      target: "simulator"
    });
  });

  it("throws a clear error when KANNA_APPIUM_PORT is missing", () => {
    expect(() =>
      resolveRequiredMobileE2eEnv({
        EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120"
      })
    ).toThrow("KANNA_APPIUM_PORT");
  });

  it("parses the appium port and server URL", () => {
    expect(
      resolveRequiredMobileE2eEnv({
        KANNA_APPIUM_PORT: "4723",
        KANNA_MOBILE_PORT: "1430",
        EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120"
      })
    ).toMatchObject({
      appiumPort: 4723,
      metroPort: 1430,
      bundleId: "build.kanna.app",
      desktopServerUrl: "http://127.0.0.1:48120"
    });
  });

  it("defaults the Metro port to 8081 when unset", () => {
    expect(
      resolveRequiredMobileE2eEnv({
        KANNA_APPIUM_PORT: "4723",
        EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120"
      })
    ).toMatchObject({
      metroPort: 8081
    });
  });

  it("parses physical-device mode and UDID override", () => {
    expect(
      resolveRequiredMobileE2eEnv({
        KANNA_APPIUM_PORT: "4723",
        EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120",
        KANNA_IOS_E2E_TARGET: "device",
        KANNA_IOS_DEVICE_UDID: "00008110-001234560E10801E",
        KANNA_IOS_PHYSICAL_DEVICE_NAME: "Jerome's iPhone 15",
        KANNA_IOS_XCODE_ORG_ID: "TEAM123456",
        KANNA_IOS_XCODE_SIGNING_ID: "Apple Development",
        KANNA_IOS_WDA_BUNDLE_ID: "dev.kanna.webdriveragentrunner"
      })
    ).toMatchObject({
      target: "device",
      deviceUdid: "00008110-001234560E10801E",
      physicalDeviceName: "Jerome's iPhone 15",
      xcodeOrgId: "TEAM123456",
      xcodeSigningId: "Apple Development",
      updatedWdaBundleId: "dev.kanna.webdriveragentrunner"
    });
  });

  it("defaults physical-device signing settings from the mobile app config", () => {
    expect(
      resolveRequiredMobileE2eEnv({
        KANNA_APPIUM_PORT: "4723",
        EXPO_PUBLIC_KANNA_SERVER_URL: "http://127.0.0.1:48120",
        KANNA_IOS_E2E_TARGET: "device"
      })
    ).toMatchObject({
      xcodeOrgId: "GY3LFAA59P",
      xcodeSigningId: "Apple Development",
      updatedWdaBundleId: "build.kanna.app.webdriveragentrunner"
    });
  });
});
