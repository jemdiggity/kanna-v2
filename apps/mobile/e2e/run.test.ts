import { describe, expect, it } from "vitest";
import type { Browser } from "webdriverio";
import {
  requiresExactExpoEnvironment,
  resolveSimulatorAlertHandling,
  resolveSmokeModeAppEnv,
  smokeSpecPaths,
  supportedSmokeModes,
  supportedSmokeTargets,
  waitForExpoAppReady
} from "./run";

describe("mobile smoke runner", () => {
  it("leaves relay and profile alerts manual while preserving other lane policies", () => {
    expect(resolveSimulatorAlertHandling("relay")).toBe("manual");
    expect(resolveSimulatorAlertHandling("profile-disconnected")).toBe("manual");
    expect(resolveSimulatorAlertHandling("hybrid")).toBe("accept");
    expect(resolveSimulatorAlertHandling("smoke")).toBe("dismiss");
  });

  it("registers the list-detail-back smoke spec", () => {
    expect(smokeSpecPaths).toContain("specs/smoke/list-detail-back.e2e.ts");
  });

  it("registers the profile and Machines smoke spec", () => {
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
    expect(requiresExactExpoEnvironment("profile-disconnected")).toBe(true);
  });

  it("supports a simulator shell visual mode without the PTY fixture", () => {
    expect(supportedSmokeModes).toContain("shell-visual");
    expect(smokeSpecPaths).toContain("specs/smoke/shell-visual.e2e.ts");
  });

  it("dismisses a dev menu that appears after the initial startup poll", async () => {
    let poll = 0;
    let devMenuDismissed = false;
    let devMenuCloseClicks = 0;

    const driver = {
      $: async (selector: string) => ({
        click: async () => {
          if (selector === "~xmark") {
            devMenuCloseClicks += 1;
            devMenuDismissed = true;
          }
        },
        isDisplayed: async () => {
          if (selector === "~xmark") {
            return poll >= 2 && !devMenuDismissed;
          }
          if (selector === "~mobile.app-shell") {
            return devMenuDismissed;
          }
          return false;
        },
        isExisting: async () => false
      }),
      acceptAlert: async () => undefined,
      execute: async () => undefined,
      getAlertText: async () => {
        throw new Error("no alert open");
      },
      getWindowSize: async () => ({ width: 393, height: 852 }),
      waitUntil: async (condition: () => Promise<boolean>) => {
        while (poll < 4) {
          poll += 1;
          if (await condition()) return true;
        }
        throw new Error("condition did not become ready");
      }
    } as unknown as Browser;

    await waitForExpoAppReady(driver);

    expect(poll).toBe(2);
    expect(devMenuCloseClicks).toBe(1);
    expect(devMenuDismissed).toBe(true);
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
