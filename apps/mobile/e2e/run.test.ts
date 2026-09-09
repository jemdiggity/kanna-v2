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

  it("registers a targeted active-tab reselection smoke mode", () => {
    expect(smokeSpecPaths).toContain("specs/smoke/tab-reselection.e2e.ts");
    expect(supportedSmokeModes).toContain("tab-reselection");
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

    expect(poll).toBe(4);
    expect(devMenuCloseClicks).toBe(1);
    expect(devMenuDismissed).toBe(true);
  });

  it("does not return before a dev menu that appears over an already-visible app shell", async () => {
    let poll = 0;
    let devMenuDismissed = false;

    const driver = {
      $: async (selector: string) => ({
        click: async () => {
          if (selector === "~xmark") devMenuDismissed = true;
        },
        isDisplayed: async () => {
          if (selector === "~xmark") {
            return poll === 2 && !devMenuDismissed;
          }
          if (selector === "~mobile.app-shell") return true;
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
        while (poll < 6) {
          poll += 1;
          if (await condition()) return true;
        }
        throw new Error("condition did not become ready");
      }
    } as unknown as Browser;

    await waitForExpoAppReady(driver);

    expect(poll).toBeGreaterThan(2);
    expect(devMenuDismissed).toBe(true);
  });

  it("fails immediately with the unexpected startup alert text", async () => {
    const driver = {
      $: async () => ({
        click: async () => undefined,
        isDisplayed: async () => false,
        isExisting: async () => false
      }),
      getAlertText: async () => "Open in Kanna?",
      waitUntil: async (condition: () => Promise<boolean>) => {
        await condition();
        throw new Error("condition did not become ready");
      }
    } as unknown as Browser;

    await expect(waitForExpoAppReady(driver)).rejects.toThrow(
      'Mobile startup is blocked by a system alert: "Open in Kanna?"'
    );
  });

  it("accepts a dynamic relaunch selector while handling Expo overlays", async () => {
    let poll = 0;
    const readySelector: string = "~mobile.toolbar.tab.recent";
    const driver = {
      $: async (selector: string) => ({
        click: async () => undefined,
        isDisplayed: async () => {
          if (selector === "~mobile.app-shell") return true;
          if (selector === "~mobile.toolbar.tab.recent") return poll >= 4;
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
        while (poll < 8) {
          poll += 1;
          if (await condition()) return true;
        }
        throw new Error("condition did not become ready");
      }
    } as unknown as Browser;

    await waitForExpoAppReady(driver, readySelector);

    expect(poll).toBeGreaterThanOrEqual(4);
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
