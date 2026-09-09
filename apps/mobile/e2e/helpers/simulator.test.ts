import { describe, expect, it } from "vitest";
import {
  buildDisableExpoDevMenuFabArgs,
  buildExpoDevelopmentClientUrl,
  buildSimulatorDevelopmentClientLaunchArgs,
  selectSimulatorDevice,
  type AvailableSimulatorDevice
} from "./simulator";

function device(name: string): AvailableSimulatorDevice {
  return {
    name,
    runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-2",
    state: "Shutdown",
    udid: `${name}-udid`
  };
}

describe("selectSimulatorDevice", () => {
  it("returns the explicitly requested simulator when present", () => {
    expect(
      selectSimulatorDevice([device("iPhone 15"), device("iPhone 17 Pro")], "iPhone 17 Pro")
    ).toMatchObject({
      name: "iPhone 17 Pro"
    });
  });

  it("prefers iPhone 15 when available and nothing is requested", () => {
    expect(
      selectSimulatorDevice([device("iPhone 17 Pro"), device("iPhone 15")])
    ).toMatchObject({
      name: "iPhone 15"
    });
  });

  it("falls back to the first available simulator when iPhone 15 is unavailable", () => {
    expect(selectSimulatorDevice([device("iPhone 17 Pro")])).toMatchObject({
      name: "iPhone 17 Pro"
    });
  });

  it("throws a clear error when the requested simulator is missing", () => {
    expect(() =>
      selectSimulatorDevice([device("iPhone 17 Pro")], "iPhone 15")
    ).toThrow("Available simulators: iPhone 17 Pro");
  });

  it("builds the Expo development client URL for a Metro server", () => {
    expect(
      buildExpoDevelopmentClientUrl("exp+kanna-mobile", "http://127.0.0.1:8679")
    ).toBe(
      "exp+kanna-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8679&disableOnboarding=1"
    );
  });

  it("launches the development client with Expo's initial-url argument", () => {
    expect(buildSimulatorDevelopmentClientLaunchArgs({
      appScheme: "exp+kanna-mobile",
      bundleId: "build.kanna.app.dev",
      deviceUdid: "simulator-udid",
      metroPort: 8679
    })).toEqual([
      "simctl",
      "launch",
      "simulator-udid",
      "build.kanna.app.dev",
      "--args",
      "--initialUrl",
      "exp+kanna-mobile://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8679&disableOnboarding=1"
    ]);
  });

  it("builds the simulator command that disables Expo's overlapping dev-menu FAB", () => {
    expect(buildDisableExpoDevMenuFabArgs("simulator-udid", "build.kanna.app.dev"))
      .toEqual([
        "simctl",
        "spawn",
        "simulator-udid",
        "defaults",
        "write",
        "build.kanna.app.dev",
        "EXDevMenuShowFloatingActionButton",
        "-bool",
        "false"
      ]);
  });
});
