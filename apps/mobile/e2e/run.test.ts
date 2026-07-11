import { describe, expect, it } from "vitest";
import {
  resolveSmokeModeAppEnv,
  smokeSpecPaths,
  supportedSmokeModes,
  supportedSmokeTargets
} from "./run";

describe("mobile smoke runner", () => {
  it("registers the list-detail-back smoke spec", () => {
    expect(smokeSpecPaths).toContain("specs/smoke/list-detail-back.e2e.ts");
  });

  it("registers the profile connection smoke spec", () => {
    expect(smokeSpecPaths).toContain("specs/smoke/profile-connection.e2e.ts");
  });

  it("supports both simulator and physical-device targets", () => {
    expect(supportedSmokeTargets).toEqual(["simulator", "device"]);
  });

  it("supports a disconnected profile smoke mode", () => {
    expect(supportedSmokeModes).toContain("profile-disconnected");
  });

  it("supports a force-cloud smoke mode", () => {
    expect(supportedSmokeModes).toContain("cloud");
    expect(smokeSpecPaths).toContain("specs/cloud/cloud-task-flow.e2e.ts");
  });

  it("supports a relay-backed Appium mode", () => {
    expect(supportedSmokeModes).toContain("relay");
    expect(smokeSpecPaths).toContain("specs/relay/relay-task-flow.e2e.ts");
  });

  it("supports a signed-in cloud plus trusted-LAN hybrid Appium mode", () => {
    expect(supportedSmokeModes).toContain("hybrid");
    expect(smokeSpecPaths).toContain("specs/hybrid/hybrid-task-flow.e2e.ts");
    expect(resolveSmokeModeAppEnv("hybrid", undefined)).toBe("dev");
    expect(resolveSmokeModeAppEnv("relay", "staging")).toBe("staging");
  });
});
