import { describe, expect, it } from "vitest";

import {
  nudgeTerminalTrustPrompt,
  pressShiftEnterInActiveTerminal,
  sendKeysToActiveTerminal,
  typeTextToFocusedTerminalWindow,
} from "./terminalInput";

interface FakeClient {
  executeCalls: string[];
  waitCalls: Array<{ css: string; timeoutMs: number }>;
  sendKeyCalls: Array<{ elementId: string; text: string }>;
  pressKeyCalls: string[];
  executeSync<T = unknown>(script: string, args?: unknown[]): Promise<T>;
  waitForElement(css: string, timeoutMs?: number): Promise<string>;
  sendKeys(elementId: string, text: string): Promise<void>;
  pressKey(value: string): Promise<void>;
}

function createFakeClient(options: {
  terminalInputId?: string;
  focusedTerminalInputId?: string;
} = {}): FakeClient {
  return {
    executeCalls: [],
    waitCalls: [],
    sendKeyCalls: [],
    pressKeyCalls: [],
    async executeSync<T = unknown>(script: string): Promise<T> {
      this.executeCalls.push(script);
      if (script.includes("document.activeElement")) {
        return true as T;
      }
      return undefined as T;
    },
    async waitForElement(css: string, timeoutMs = 10_000): Promise<string> {
      this.waitCalls.push({ css, timeoutMs });
      if (css === ".terminal-container") return "terminal";
      if (css === ".main-panel .xterm-helper-textarea") {
        return options.terminalInputId ?? "terminal-input";
      }
      if (css === ".main-panel .xterm-helper-textarea:focus") {
        return options.focusedTerminalInputId ?? "focused-terminal-input";
      }
      throw new Error(`unexpected selector ${css}`);
    },
    async sendKeys(elementId: string, text: string): Promise<void> {
      this.sendKeyCalls.push({ elementId, text });
    },
    async pressKey(value: string): Promise<void> {
      this.pressKeyCalls.push(value);
    },
  };
}

describe("sendKeysToActiveTerminal", () => {
  it("focuses the active terminal input and sends the requested keys", async () => {
    const client = createFakeClient();

    await sendKeysToActiveTerminal(client, "hello");

    expect(client.waitCalls).toContainEqual({ css: ".terminal-container", timeoutMs: 15_000 });
    expect(client.executeCalls[0]).toContain('document.querySelector(".main-panel .xterm-helper-textarea")');
    expect(client.waitCalls).toContainEqual({ css: ".main-panel .xterm-helper-textarea", timeoutMs: 5_000 });
    expect(client.sendKeyCalls).toEqual([{ elementId: "terminal-input", text: "hello" }]);
  });
});

describe("nudgeTerminalTrustPrompt", () => {
  it("sends a real WebDriver Enter key action to the active terminal multiple times", async () => {
    const client = createFakeClient();

    await nudgeTerminalTrustPrompt(client, { attempts: 3 });

    expect(client.pressKeyCalls).toEqual(["\uE007", "\uE007", "\uE007"]);
    expect(client.sendKeyCalls).toEqual([]);
  });
});

describe("typeTextToFocusedTerminalWindow", () => {
  it("sends text to the focused xterm when a hidden terminal appears first in the DOM", async () => {
    const client = createFakeClient({
      terminalInputId: "hidden-first-terminal-input",
      focusedTerminalInputId: "focused-second-terminal-input",
    });

    await typeTextToFocusedTerminalWindow(client, "ab\n");

    expect(client.waitCalls).toContainEqual({ css: ".terminal-container", timeoutMs: 15_000 });
    expect(client.executeCalls[0]).toContain("document.activeElement");
    expect(client.executeCalls[0]).toContain('el.matches(".main-panel .xterm-helper-textarea")');
    expect(client.waitCalls).toContainEqual({
      css: ".main-panel .xterm-helper-textarea:focus",
      timeoutMs: 5_000,
    });
    expect(client.waitCalls).not.toContainEqual({
      css: ".main-panel .xterm-helper-textarea",
      timeoutMs: 5_000,
    });
    expect(client.pressKeyCalls).toEqual([]);
    expect(client.sendKeyCalls).toEqual([{ elementId: "focused-second-terminal-input", text: "ab\n" }]);
  });
});

describe("pressShiftEnterInActiveTerminal", () => {
  it("focuses the active terminal input and dispatches Shift+Enter to xterm", async () => {
    const client = createFakeClient();

    await pressShiftEnterInActiveTerminal(client);

    expect(client.waitCalls).toContainEqual({ css: ".terminal-container", timeoutMs: 15_000 });
    expect(client.executeCalls[0]).toContain('document.querySelector(".main-panel .xterm-helper-textarea")');
    expect(client.waitCalls).toContainEqual({ css: ".main-panel .xterm-helper-textarea", timeoutMs: 5_000 });
    expect(client.executeCalls.some((script) => script.includes('key: "Enter"'))).toBe(true);
    expect(client.executeCalls.some((script) => script.includes("shiftKey: true"))).toBe(true);
  });
});
