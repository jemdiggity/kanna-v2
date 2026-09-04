// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { useTerminalFocusWhenActive } from "./useTerminalFocusWhenActive";

const setWebviewFocusMock = vi.fn(async () => {});

vi.mock("../tauri-mock", () => ({
  isTauri: true,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    setFocus: setWebviewFocusMock,
  }),
}));

describe("useTerminalFocusWhenActive", () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    setWebviewFocusMock.mockClear();
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    globalThis.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it("restores native focus before focusing an active terminal", async () => {
    const focus = vi.fn();
    const { focusWhenActive } = useTerminalFocusWhenActive({
      isActive: () => true,
      getTerminal: () => ({ focus }),
    });

    await focusWhenActive();
    await nextTick();

    expect(setWebviewFocusMock).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(setWebviewFocusMock.mock.invocationCallOrder[0]).toBeLessThan(
      focus.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("preserves focus in sidebar search and rename inputs", async () => {
    const sidebar = document.createElement("aside");
    sidebar.className = "sidebar";
    const input = document.createElement("input");
    sidebar.appendChild(input);
    document.body.appendChild(sidebar);
    input.focus();
    const focus = vi.fn();
    const { focusWhenActive } = useTerminalFocusWhenActive({
      isActive: () => true,
      getTerminal: () => ({ focus }),
    });

    await focusWhenActive();

    expect(document.activeElement).toBe(input);
    expect(setWebviewFocusMock).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("focuses through the bounded fallback when animation frames are suspended", async () => {
    vi.useFakeTimers();
    globalThis.requestAnimationFrame = vi.fn(() => 7);
    const focus = vi.fn();
    const { focusWhenActive } = useTerminalFocusWhenActive({
      isActive: () => true,
      getTerminal: () => ({ focus }),
    });

    const pendingFocus = focusWhenActive();
    await nextTick();
    await vi.advanceTimersByTimeAsync(50);
    await pendingFocus;

    expect(focus).toHaveBeenCalledTimes(1);
  });
});
