import { describe, expect, it } from "vitest";
import {
  buildExpoDevelopmentClientUrl,
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
});
