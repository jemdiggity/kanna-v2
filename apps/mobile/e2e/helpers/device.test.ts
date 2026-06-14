import { describe, expect, it } from "vitest";
import {
  buildPhysicalDeviceInstallCommand,
  filterAppiumVisibleDevices,
  parseXcdeviceList,
  selectPhysicalDevice,
  type AvailablePhysicalDevice
} from "./device";

function device(name: string, udid: string): AvailablePhysicalDevice {
  return {
    name,
    udid,
    platformVersion: "18.4"
  };
}

describe("selectPhysicalDevice", () => {
  it("bakes the LAN host and points run:ios at the worktree Metro port", () => {
    expect(
      buildPhysicalDeviceInstallCommand("00008130-001015CA1091401C", 1430, () => "172.16.0.193")
    ).toBe(
      "REACT_NATIVE_PACKAGER_HOSTNAME=172.16.0.193 pnpm --dir apps/mobile ios --device 00008130-001015CA1091401C --port 1430"
    );
  });

  it("omits the packager host prefix when no LAN address is available", () => {
    expect(
      buildPhysicalDeviceInstallCommand("00008130-001015CA1091401C", 1430, () => undefined)
    ).toBe(
      "pnpm --dir apps/mobile ios --device 00008130-001015CA1091401C --port 1430"
    );
  });

  it("parses attached physical devices from xcdevice output", () => {
    expect(
      parseXcdeviceList(`[
  {
    "ignored" : false,
    "simulator" : false,
    "operatingSystemVersion" : "18.7.7 (22H340)",
    "identifier" : "00008020-000869440228003A",
    "platform" : "com.apple.platform.iphoneos",
    "available" : true,
    "name" : "Jeremy Hale’s iPhone"
  },
  {
    "ignored" : false,
    "simulator" : true,
    "operatingSystemVersion" : "26.2 (23C54)",
    "identifier" : "390F2D5A-D8FE-40BC-9D42-DBA11DD35BF2",
    "platform" : "com.apple.platform.iphonesimulator",
    "available" : true,
    "name" : "iPhone 17 Pro"
  }
]`)
    ).toEqual([
      {
        name: "Jeremy Hale’s iPhone",
        udid: "00008020-000869440228003A",
        platformVersion: "18.7.7"
      }
    ]);
  });

  it("selects the only attached device by default", () => {
    expect(selectPhysicalDevice([device("Jeremy's iPhone", "udid-1")])).toMatchObject({
      udid: "udid-1"
    });
  });

  it("selects the requested device when the UDID is present", () => {
    expect(
      selectPhysicalDevice(
        [device("Jeremy's iPhone", "udid-1"), device("Test Phone", "udid-2")],
        "udid-2"
      )
    ).toMatchObject({
      udid: "udid-2"
    });
  });

  it("selects the requested device by name when provided", () => {
    expect(
      selectPhysicalDevice(
        [device("Jeremy's iPhone", "udid-1"), device("Jerome's iPhone 15", "udid-2")],
        undefined,
        undefined,
        "Jerome's iPhone 15"
      )
    ).toMatchObject({
      udid: "udid-2"
    });
  });

  it("fails clearly when no devices are attached", () => {
    expect(() => selectPhysicalDevice([])).toThrow("No attached iPhone devices were found");
  });

  it("filters attached devices to the ones Appium can automate", () => {
    expect(
      filterAppiumVisibleDevices(
        [device("Jeremy's iPhone", "udid-1"), device("Test Phone", "udid-2")],
        ["udid-2"]
      )
    ).toEqual([device("Test Phone", "udid-2")]);
  });

  it("fails clearly when the requested device is attached but not Appium-visible", () => {
    expect(() =>
      selectPhysicalDevice(
        [device("Jeremy's iPhone", "udid-1"), device("Test Phone", "udid-2")],
        "udid-1",
        ["udid-2"]
      )
    ).toThrow("Appium/XCUITest cannot access it right now");
  });

  it("defaults to the only Appium-visible device when multiple phones are attached", () => {
    expect(
      selectPhysicalDevice(
        [device("Jeremy's iPhone", "udid-1"), device("Test Phone", "udid-2")],
        undefined,
        ["udid-2"]
      )
    ).toMatchObject({
      udid: "udid-2"
    });
  });

  it("fails clearly when multiple devices are attached without an override", () => {
    expect(() =>
      selectPhysicalDevice([
        device("Jeremy's iPhone", "udid-1"),
        device("Test Phone", "udid-2")
      ])
    ).toThrow("KANNA_IOS_DEVICE_UDID");
  });
});
