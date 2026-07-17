import { describe, expect, it } from "vitest";
import {
  requiresExactExpoEnvironment,
  resolveSimulatorAlertHandling,
  resolveSmokeModeAppEnv,
  smokeSpecPaths,
  supportedSmokeModes,
  supportedSmokeTargets
} from "./run";

describe("mobile smoke runner", () => {
  it("leaves relay alerts manual while preserving other lane policies", () => {
    expect(resolveSimulatorAlertHandling("relay")).toBe("manual");
    expect(resolveSimulatorAlertHandling("hybrid")).toBe("accept");
    expect(resolveSimulatorAlertHandling("smoke")).toBe("dismiss");
  });

  it("registers the list-detail-back smoke spec", () => {
    expect(smokeSpecPaths).toContain("specs/smoke/list-detail-back.e2e.ts");
  });

  it("registers the profile connection smoke spec", () => {
    expect(smokeSpecPaths).toContain("specs/smoke/profile-connection.e2e.ts");
  });

  it("registers the Search focus smoke spec", () => {
    expect(smokeSpecPaths).toContain("specs/smoke/search-focus.e2e.ts");
    expect(supportedSmokeModes).toContain("search-focus");
  });

  it("supports both simulator and physical-device targets", () => {
    expect(supportedSmokeTargets).toEqual(["simulator", "device"]);
  });

  it("supports a disconnected profile smoke mode", () => {
    expect(supportedSmokeModes).toContain("profile-disconnected");
  });

  it("supports a simulator shell visual mode without the PTY fixture", () => {
    expect(supportedSmokeModes).toContain("shell-visual");
    expect(smokeSpecPaths).toContain("specs/smoke/shell-visual.e2e.ts");
  });

  it("supports a force-cloud smoke mode", () => {
    expect(supportedSmokeModes).toContain("cloud");
    expect(smokeSpecPaths).toContain("specs/cloud/cloud-task-flow.e2e.ts");
  });

  it("supports a relay-backed Appium mode", () => {
    expect(supportedSmokeModes).toContain("relay");
    expect(smokeSpecPaths).toContain("specs/relay/relay-task-flow.e2e.ts");
    expect(requiresExactExpoEnvironment("relay")).toBe(true);
  });

  it("supports a signed-in cloud plus trusted-LAN hybrid Appium mode", () => {
    expect(supportedSmokeModes).toContain("hybrid");
    expect(smokeSpecPaths).toContain("specs/hybrid/hybrid-task-flow.e2e.ts");
    expect(resolveSmokeModeAppEnv("hybrid", undefined)).toBe("dev");
    expect(resolveSmokeModeAppEnv("relay", "staging")).toBe("staging");
    expect(requiresExactExpoEnvironment("hybrid")).toBe(true);
    expect(requiresExactExpoEnvironment("smoke")).toBe(false);
  });
});
