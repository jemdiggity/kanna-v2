import { describe, expect, it } from "vitest";
import { dismissStartupShortcutsModal } from "./startupOverlays";

interface FakeClient {
  executeCalls: string[];
  waitCalls: Array<{ css: string; timeoutMs: number }>;
  settledChecks: boolean[];
  visibilityChecks: boolean[];
  executeSync<T = unknown>(script: string): Promise<T>;
  waitForNoElement(css: string, timeoutMs?: number): Promise<void>;
}

function createFakeClient(
  settledChecks: boolean[],
  visibilityChecks: boolean[],
): FakeClient {
  return {
    executeCalls: [],
    waitCalls: [],
    settledChecks,
    visibilityChecks,
    async executeSync<T = unknown>(script: string): Promise<T> {
      this.executeCalls.push(script);
      if (script.includes("startupOverlaysSettled")) {
        return (this.settledChecks.shift() ?? true) as T;
      }
      if (script.includes("showShortcutsModal")) {
        return (this.visibilityChecks.shift() ?? false) as T;
      }
      return undefined as T;
    },
    async waitForNoElement(css: string, timeoutMs = 5000): Promise<void> {
      this.waitCalls.push({ css, timeoutMs });
    },
  };
}

describe("dismissStartupShortcutsModal", () => {
  it("waits for the startup decision before reading the modal, then dismisses it", async () => {
    const client = createFakeClient([false, false, true], [true]);

    await dismissStartupShortcutsModal(client);

    // The modal is only sampled once the app says the decision is made, so a
    // modal that paints after app-ready is still caught.
    expect(client.executeCalls.filter((call) => call.includes("startupOverlaysSettled"))).toHaveLength(3);
    expect(client.executeCalls.at(-2)).toContain("showShortcutsModal");
    expect(client.executeCalls.at(-1)).toContain("window.dispatchEvent");
    expect(client.executeCalls.at(-1)).toContain('key: "Escape"');
    expect(client.waitCalls).toEqual([{ css: ".shortcuts-modal", timeoutMs: 5000 }]);
  });

  it("does nothing when the startup decision left the modal hidden", async () => {
    const client = createFakeClient([true], [false]);

    await dismissStartupShortcutsModal(client);

    expect(client.executeCalls.every((call) => !call.includes('key: "Escape"'))).toBe(true);
    expect(client.waitCalls).toEqual([]);
  });
});
